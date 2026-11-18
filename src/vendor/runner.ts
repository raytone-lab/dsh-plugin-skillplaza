/**
 * 流程执行器 —— 消费 @iruidong/plaza-flow 编译出的 IR，adjacency 驱动的**动态走图**执行。
 * 定位：既是 plaza 自己的运行时（Model A），也是**给任意 agent 抄的参考实现**（EXECUTOR.md + vectors.json 黄金基准）。
 *
 * 语义严格对齐 SPEC.md：
 *  - 从 entry 出发按 adjacency 走；同时就绪的多节点并发（受 max_concurrency）——即 fan-out。
 *  - router 求值 config.expression，命中出边 branch 才走，未命中分支**剪枝**（下游 join 不空等）。
 *  - 条件边按布尔取舍；join 等所有「实到 + 剪枝」的上游都结算后再跑（fan-in），按 state reducer 合并。
 *  - loop 按 max_iterations / until 决定回跳；回跳时重置环体节点使其重跑。
 *  - expert 节点通过注入的 runExpert 真调 LLM；config.retries 失败重试；error_policy 停/继续；timeout 墙钟上限。
 *  - 节点间靠 state + 每节点输出寻址（{{id.output}} 模板）传递；并发写入按 ir.order 数组序折叠（确定性铁律）。
 */
import { reduceMany, evalExpr, asBool, type CompiledFlow, type FlowNode } from './plaza-flow/index.js';

export interface RunTraceItem {
  nodeId: string;
  label: string;
  type: string;
  status: 'done' | 'error' | 'skipped' | 'human' | 'control';
  input?: string;
  output?: string;
  ms: number;
  note?: string;
}

export interface RunResult {
  ok: boolean;
  trace: RunTraceItem[];
  finalOutput: string;
  /** 执行结束后的共享 state 快照（声明了 state 字段时有意义；供消费方/断言用）。 */
  finalState: Record<string, unknown>;
  error?: string;
  retryAfter?: number;
  summary?: string;
  /** 命中 human 节点、等待人工输入时返回；带可序列化快照供 resume 续跑。 */
  paused?: RunPause;
}

/** 可序列化的执行态快照（human 暂停时落库，resume 时 rehydrate 续跑）。 */
export interface RunSnapshot {
  state: Record<string, unknown>;
  outputs: Record<string, string>;
  lastOutput: string;
  expertCalls: number;
  done: string[];
  skipped: string[];
  gotReal: string[];
  awaiting: Record<string, string[]>;
  loopIter: Record<string, number>;
  ready: string[];
  trace: RunTraceItem[];
  humanInputs: Record<string, string>;
  humanDecisions?: Record<string, string>;   // 审批结论(approved/rejected),多级审批链续跑时随快照携带
  humanComments?: Record<string, string[]>;  // 仅意见留痕(comment=hold profile,SPEC 附录A):不解除阻塞、不耗轮次
  rework?: Record<string, number>;           // 各人工节点已自动重做轮数(驳回回炉)
  reworkNodes?: string[];                    // 本轮重做中的节点(输入前注入驳回意见)
  reworkNote?: string | null;                // 驳回意见原文(重做专家的"思考材料")
}

export interface RunPause {
  node: string;
  label: string;
  prompt?: string;
  snapshot: RunSnapshot;
}

/** 流式事件（SSE playground 用；不传 onEvent 则无副作用）。 */
export type RunEvent =
  | { kind: 'node_start'; nodeId: string; label: string; type: string }
  | { kind: 'node_done'; nodeId: string; label: string; type: string; status: RunTraceItem['status']; output?: string; note?: string; ms: number }
  | { kind: 'tool_call'; nodeId: string; tool: string; args: string }
  | { kind: 'tool_result'; nodeId: string; tool: string; ok: boolean; preview: string; ms: number }
  /** pi harness 专属:专家正文的流式增量(打字机)。旧消费者按 kind 分派,天然忽略。 */
  | { kind: 'node_delta'; nodeId: string; delta: string };

export interface RunOpts {
  input: string;
  runExpert: (node: FlowNode, inputText: string, emit?: (ev: RunEvent) => void) => Promise<string>;
  maxExperts?: number;
  onEvent?: (ev: RunEvent) => void;
  timeoutSeconds?: number;
  now?: () => number;
  /** 续跑：从 human 暂停快照恢复，并注入该节点的人工输入。decision=审批结论(approved/rejected),驱动出边分流。 */
  resume?: { node: string; input: string; snapshot: RunSnapshot; decision?: string };
  /** subworkflow 节点解析器（按 flow_id 返回其编译 IR）；注入以保持 runner 不碰 db。 */
  resolveSubflow?: (flowId: string) => CompiledFlow | null;
  /** subworkflow 递归深度上限（默认 3）与当前深度（内部用）。 */
  maxDepth?: number;
  _depth?: number;
}

const labelOf = (n: FlowNode): string => n.label || (n.config as any)?.pack_slug || n.id;
const is429 = (e: any): boolean => e?.status === 429 || typeof e?.retryAfter === 'number';

const TPL = /\{\{\s*([\w.-]+)\s*\}\}/g;
const resolveTemplate = (tpl: string, outs: Record<string, string>, flowInput: string): string =>
  tpl.replace(TPL, (_m, ref: string) => {
    const key = ref.trim();
    if (key === 'input' || key === 'start.output' || key === 'start') return flowInput;
    const id = key.endsWith('.output') ? key.slice(0, -'.output'.length) : key;
    return outs[id] ?? '';
  });

// router / 条件边表达式可读 state 与 {{id.output}}：把每节点输出暴露成 { output } 供 path 访问。
const outputsAsCtx = (outs: Record<string, string>): Record<string, unknown> => {
  const ctx: Record<string, unknown> = {};
  for (const [id, output] of Object.entries(outs)) ctx[id] = { output };
  return ctx;
};

export async function runFlow(ir: CompiledFlow, opts: RunOpts): Promise<RunResult> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const timeoutMs = (opts.timeoutSeconds ?? ir.timeout_seconds ?? 600) * 1000;
  const maxExperts = opts.maxExperts ?? 12;
  const cap = Math.max(1, ir.max_concurrency || 8);

  const R = opts.resume?.snapshot;   // 续跑：从快照恢复各执行态
  const trace: RunTraceItem[] = R ? [...R.trace] : [];
  const state: Record<string, unknown> = R ? R.state : {};
  const outputs: Record<string, string> = R ? R.outputs : { start: opts.input };
  let lastOutput = R ? R.lastOutput : opts.input;
  let expertCalls = R ? R.expertCalls : 0;
  // 人工输入表：resume 时把该 human 节点的人工输入注入，使其从"待命"变"可跑"。
  // 例外：decision='comment'（profile: comment=hold，SPEC 附录A）——只留意见，不解除阻塞、
  // 不进 humanDecisions（不分流）、不耗回炉轮次；run 将在同一节点再次暂停，候选不变。
  const humanInputs: Record<string, string> = R ? { ...R.humanInputs } : {};
  const humanComments: Record<string, string[]> = R ? { ...(R.humanComments ?? {}) } : {};
  if (opts.resume) {
    if (opts.resume.decision === 'comment') (humanComments[opts.resume.node] ||= []).push(opts.resume.input);
    else humanInputs[opts.resume.node] = opts.resume.input;
  }
  // 审批结论表:human 节点带 approved/rejected 结论完成时,propagate 按出边 branch 分流(审批闸门语义)。
  const humanDecisions: Record<string, string> = R ? { ...(R.humanDecisions ?? {}) } : {};
  if (opts.resume?.decision && opts.resume.decision !== 'comment') humanDecisions[opts.resume.node] = opts.resume.decision;
  // 驳回自动回炉:重做轮数/重做中的节点/驳回意见(喂给重做方"思考")
  const rework: Record<string, number> = R ? { ...(R.rework ?? {}) } : {};
  const reworkNodes = new Set<string>(R?.reworkNodes ?? []);
  let reworkNote: string | null = R?.reworkNote ?? null;
  let aborted: { retryAfter?: number } | null = null;
  let timedOut = false;
  let halted: RunTraceItem | null = null;
  // 人工驳回且无「驳回」出边时:审批闸门无路可走 → 全剪枝并终止为「已驳回」(绝不能给成功输出)
  let rejectedBy: { node: string; label: string; opinion: string } | null = null;

  const emit = (ev: RunEvent) => { try { opts.onEvent?.(ev); } catch { /* 回调异常不影响执行 */ } };
  const ctxNow = () => ({ ...state, ...outputsAsCtx(outputs) });

  // ir.order 扁平序：并发就绪时按此排序处理/合并，保证结果确定（== 编译计划顺序，不随 Promise 完成先后变）。
  const orderIndex: Record<string, number> = {};
  { let i = 0; for (const s of ir.order) for (const id of s.nodes) orderIndex[id] = i++; }
  const byOrder = (a: string, b: string) => (orderIndex[a] ?? 1e9) - (orderIndex[b] ?? 1e9);

  // 前驱（忽略回边）：join 据此判"到齐"，无模板节点据此拼上游输入。
  const preds: Record<string, Set<string>> = {};
  for (const [src, edges] of Object.entries(ir.adjacency)) {
    for (const e of edges) {
      if (e.loopBack || e.target === 'END') continue;
      (preds[e.target] ||= new Set()).add(src);
    }
  }
  // 每节点尚待结算的前驱信号（实到或剪枝都算结算）；续跑时从快照恢复。
  const awaiting: Record<string, Set<string>> = {};
  for (const id of Object.keys(ir.nodes)) awaiting[id] = new Set(R ? (R.awaiting[id] ?? []) : (preds[id] ?? []));
  const gotReal = new Set<string>(R ? R.gotReal : []);   // 收到过 ≥1 个"实到"信号 → 该跑；全被剪枝 → 跳过
  const done = new Set<string>(R ? R.done : []);
  const skipped = new Set<string>(R ? R.skipped : []);
  const loopIter: Record<string, number> = R ? R.loopIter : {};

  const inputFor = (node: FlowNode): string => {
    const tpl = (node.config as any)?.inputTemplate;
    let base: string;
    if (typeof tpl === 'string' && tpl.includes('{{')) base = resolveTemplate(tpl, outputs, opts.input);
    else {
      const ups = [...(preds[node.id] ?? [])].filter((u) => u !== 'start').sort(byOrder);
      const parts = ups.map((u) => outputs[u]).filter((s): s is string => !!s);
      if (!parts.length) base = lastOutput;
      else if (parts.length === 1) base = parts[0];
      else base = ups.map((u) => (outputs[u] ? `【${labelOf(ir.nodes[u]) || u}】${outputs[u]}` : '')).filter(Boolean).join('\n\n');
    }
    // 重做中的节点:驳回意见前置注入,让产出方"带着意见重新思考"
    if (reworkNodes.has(node.id) && reworkNote) return `【前次产出被人工驳回,审核意见如下,请针对该意见修正/回应后重新产出】\n${reworkNote}\n\n—— 原始输入 ——\n${base}`;
    return base;
  };
  const commitState = (node: FlowNode, output: string) => {
    const key = (node.config as any)?.state_key as string | undefined;
    if (key && ir.state[key]) state[key] = reduceMany(ir.state[key].reducer, state[key], [output]);
  };

  // 执行单个节点（不含边决策；边决策在 propagate 里）。
  const execNode = async (node: FlowNode, inputText: string): Promise<RunTraceItem> => {
    const t0 = now();
    const base = { nodeId: node.id, label: labelOf(node), type: node.type };
    switch (node.type) {
      case 'start':
      case 'parallel':
      case 'end':
        return { ...base, status: 'control', ms: 0 };
      case 'join': {
        // fan-in：把实到上游输出按 order 序标注拼接，作为本节点输出（团长汇总的天然入参）。
        const ps = [...(preds[node.id] ?? [])].filter((p) => outputs[p] != null).sort(byOrder);
        const out = ps.map((p) => `【${labelOf(ir.nodes[p])}】${outputs[p]}`).join('\n\n');
        return { ...base, status: 'control', output: out || undefined, ms: 0 };
      }
      case 'router':
        try { const v = evalExpr(String((node.config as any)?.expression ?? ''), ctxNow()); return { ...base, status: 'control', ms: 0, note: `router→${JSON.stringify(v)}` }; }
        catch (e: any) { return { ...base, status: 'control', ms: 0, note: `router 表达式失败:${String(e?.message ?? e).slice(0, 80)}` }; }
      case 'loop':
        return { ...base, status: 'control', ms: 0, note: `loop#${loopIter[node.id] ?? 0}` };
      case 'human': {
        // 审批闸门的产出语义(2026-10-23 修正:此前一律输出人工意见,导致"通过"后意见顶掉被审内容):
        //   通过/无结论 = 放行被审内容(下游加工、回写、最终输出都应是内容本身,意见只进 trace 批注);
        //   驳回       = 输出驳回意见(驳回分支的重做方拿它当修正依据;终止时它就是终态说明)。
        const provided = humanInputs[node.id];
        const dec = humanDecisions[node.id];
        const out = dec === 'rejected' ? (provided ?? inputText) : inputText;
        const decNote = dec ? ` · ${dec === 'approved' ? '通过' : '驳回'}` : '';
        return { ...base, status: 'human', input: inputText, output: out, ms: now() - t0, note: provided !== undefined ? `人工输入已注入${decNote}` : '人工介入' };
      }
      case 'subworkflow': {
        const fid = (node.config as any)?.flow_id;
        const depth = opts._depth ?? 0;
        if (!opts.resolveSubflow || !fid) return { ...base, status: 'skipped', ms: 0, note: '子流程未配置 flow_id 或无解析器' };
        if (depth >= (opts.maxDepth ?? 3)) return { ...base, status: 'error', ms: 0, note: `子流程嵌套超过 ${opts.maxDepth ?? 3} 层` };
        const subIr = opts.resolveSubflow(String(fid));
        if (!subIr) return { ...base, status: 'error', ms: 0, note: `子流程 ${fid} 不可解析` };
        const sub = await runFlow(subIr, {
          input: inputText, runExpert: opts.runExpert, resolveSubflow: opts.resolveSubflow,
          onEvent: opts.onEvent, now: opts.now, maxExperts, maxDepth: opts.maxDepth, _depth: depth + 1,
        });
        if (sub.paused) return { ...base, status: 'error', ms: now() - t0, note: '子流程含人工节点，暂不支持在子流程内暂停' };
        return { ...base, status: sub.ok ? 'done' : 'error', input: inputText, output: sub.finalOutput, ms: now() - t0, note: sub.ok ? '子流程完成' : sub.summary };
      }
      case 'expert': {
        if (expertCalls >= maxExperts) return { ...base, status: 'skipped', ms: 0, note: `超过执行上限 ${maxExperts} 个专家调用` };
        expertCalls++;
        const retries = Math.max(0, Number((node.config as any)?.retries) || 0);
        let lastErr: any;
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const output = await opts.runExpert(node, inputText, emit);
            outputs[node.id] = output;
            return { ...base, status: 'done', input: inputText, output, ms: now() - t0, note: attempt ? `第 ${attempt + 1} 次尝试成功` : undefined };
          } catch (e: any) {
            lastErr = e;
            if (is429(e)) { aborted = { retryAfter: e.retryAfter }; return { ...base, status: 'error', ms: now() - t0, note: '网关限流(429)' }; }
            // 非 429 且还有重试额度 → 再试
          }
        }
        return { ...base, status: 'error', input: inputText, ms: now() - t0, note: `${retries ? `重试 ${retries} 次仍失败：` : ''}${String(lastErr?.message ?? lastErr).slice(0, 260)}` };
      }
      default:
        return { ...base, status: 'control', ms: 0 };
    }
  };

  const execTraced = async (node: FlowNode): Promise<RunTraceItem> => {
    emit({ kind: 'node_start', nodeId: node.id, label: labelOf(node), type: node.type });
    const item = await execNode(node, inputFor(node));
    emit({ kind: 'node_done', nodeId: item.nodeId, label: item.label, type: item.type, status: item.status, output: item.output, note: item.note, ms: item.ms });
    return item;
  };

  const ready: string[] = R ? [...R.ready] : [];
  const enqueueIfReady = (id: string) => {
    if (done.has(id) || skipped.has(id)) return;
    if ((awaiting[id]?.size ?? 0) === 0 && !ready.includes(id)) ready.push(id);
  };
  // 剪枝：某条边未被选中 → 目标少等一个信号；若目标所有前驱都被剪、从没实到过 → 跳过并把剪枝继续传下去。
  const prune = (id: string, from: string) => {
    if (id === 'END' || done.has(id) || skipped.has(id)) return;
    awaiting[id]?.delete(from);
    if ((awaiting[id]?.size ?? 0) === 0 && !gotReal.has(id)) {
      skipped.add(id);
      const n = ir.nodes[id];
      if (n) trace.push({ nodeId: id, label: labelOf(n), type: n.type, status: 'skipped', ms: 0, note: '分支未命中，跳过' });
      for (const e of ir.adjacency[id] ?? []) { if (!e.loopBack) prune(e.target, id); }
    }
  };
  const activate = (id: string, from: string) => {
    if (id === 'END') return;
    gotReal.add(id);
    awaiting[id]?.delete(from);
    enqueueIfReady(id);
  };

  // 前向可达（忽略回边），用于 loop 回跳时重置环体，使其重跑。
  const forwardReach = (from: string, stopAt: string): string[] => {
    const seen = new Set<string>(); const stack = [from]; const out: string[] = [];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === 'END' || seen.has(cur)) continue;
      seen.add(cur); out.push(cur);
      if (cur === stopAt) continue;
      for (const e of ir.adjacency[cur] ?? []) { if (!e.loopBack) stack.push(e.target); }
    }
    return out;
  };

  // 处理一个节点完成后的出边（决定走哪些、剪哪些、是否回跳）。
  const propagate = (nodeId: string) => {
    const node = ir.nodes[nodeId];
    const edges = ir.adjacency[nodeId] ?? [];
    // 人工节点带审批结论完成 → 审批闸门:按结论匹配出边 branch(通过/驳回分流),无结论则全部放行(旧行为)
    if (node.type === 'human') {
      const dec = humanDecisions[nodeId];
      if (dec) {
        const hasRejectedExit = edges.some((e) => !e.loopBack && String(e.branch ?? '') === 'rejected');
          if (dec === 'rejected' && !hasRejectedExit) {
            const opinion = String(humanInputs[nodeId] ?? '');
            const maxRework = Math.max(0, Number((node.config as any)?.max_rework ?? 2));
            const round = (rework[nodeId] ?? 0) + 1;
            // 可重做的上游 = 直接前驱中已完成的非 start 节点(产出被审的就是它们)。
            // profile: config.rework_node_id(SPEC 附录A) → 只重做指定的那一个直接上游;
            // 指定值非「已完成直接前驱」时 redoPreds 为空 → 按无可重做处理(轮尽终止),不静默扩围。
            const reworkTarget = typeof (node.config as any)?.rework_node_id === 'string' ? (node.config as any).rework_node_id : undefined;
            const redoPreds = [...(preds[nodeId] ?? [])].filter((p) => p !== 'start' && done.has(p) && (reworkTarget === undefined || p === reworkTarget));
          if (round <= maxRework && redoPreds.length) {
            // 驳回自动回炉:重置上游产出方(输入注入驳回意见)→ 重做 → 本节点复位,等新产出后再审
            rework[nodeId] = round;
            reworkNote = opinion;
            done.delete(nodeId); skipped.delete(nodeId); gotReal.delete(nodeId);
            delete humanInputs[nodeId]; delete humanDecisions[nodeId];
            awaiting[nodeId] = new Set(redoPreds);
            // H 以 rejected 完成时其意见输出会顶掉 lastOutput,导致重做方 fallback 入参的"原始输入"
            // 变成意见本身;回拨到被重做上游的原始产出(按 order 取最后一个),保证重做方看到「意见+原始产出」。
            const sortedRedo = [...redoPreds].sort(byOrder);
            const lastRedo = sortedRedo[sortedRedo.length - 1];
            if (lastRedo != null && outputs[lastRedo] != null) lastOutput = outputs[lastRedo];
            for (const p of redoPreds) {
              const body = forwardReach(p, nodeId);
              const bodySet = new Set(body);
              for (const b of body) {
                if (b === nodeId) continue;           // 人工节点自身已在上面单独复位
                done.delete(b); skipped.delete(b); gotReal.delete(b);
                reworkNodes.add(b);
                awaiting[b] = new Set([...(preds[b] ?? [])].filter((x) => bodySet.has(x)));
              }
              activate(p, nodeId);
            }
            trace.push({ nodeId, label: labelOf(node), type: 'human', status: 'control', ms: 0, note: `驳回回炉:第 ${round} 轮重做(上游 ${redoPreds.map((p) => labelOf(ir.nodes[p])).join('、')})` });
            return;
          }
          // 重做次数用尽或没有可重做的上游 → 全剪枝并终止为「已驳回」(绝不给成功输出)
          for (const e of edges) { if (!e.loopBack) prune(e.target, nodeId); }
          rejectedBy = {
            node: nodeId, label: labelOf(node),
            opinion: round > 1 ? `${opinion}(已自动重做 ${round - 1} 轮仍被驳回)` : opinion,
          };
          return;
        }
        for (const e of edges) {
          if (e.loopBack) continue;
          if (e.branch != null) (String(e.branch) === dec ? activate : prune)(e.target, nodeId);
          else activate(e.target, nodeId); // 无分支边 = 默认边
        }
        return;
      }
    }
    if (node.type === 'router') {
      let val: unknown; try { val = evalExpr(String((node.config as any)?.expression ?? ''), ctxNow()); } catch { val = undefined; }
      const sval = String(val ?? '');
      for (const e of edges) {
        if (e.loopBack) continue;
        if (e.branch != null) (String(e.branch) === sval ? activate : prune)(e.target, nodeId);
        else activate(e.target, nodeId); // router 上的无分支边 = 默认边
      }
      return;
    }
    if (node.type === 'loop') {
      const c = (node.config as any) ?? {};
      const it = (loopIter[nodeId] = (loopIter[nodeId] ?? 0) + 1);
      const maxIt = Math.max(1, Number(c.max_iterations) || 3);
      let cont = it < maxIt;
      if (cont && c.until) { try { if (asBool(evalExpr(String(c.until), ctxNow()))) cont = false; } catch { /* 求值失败按继续 */ } }
      for (const e of edges) {
        if (e.loopBack) {
          if (cont) {
            // 重置环体：从回跳目标前向可达到本 loop 节点的节点，清 done/skip 使其重跑。
            // awaiting 只复位为「环体内部」前驱——环外前驱(如 start)已触发过、不会再发信号，
            // 若把它算进 awaiting 会导致目标永不就绪。回跳目标的入口信号由下面 activate 提供。
            const body = forwardReach(e.target, nodeId);
            const bodySet = new Set(body);
            for (const b of body) {
              done.delete(b); skipped.delete(b); gotReal.delete(b);
              awaiting[b] = new Set([...(preds[b] ?? [])].filter((p) => bodySet.has(p)));
            }
            activate(e.target, nodeId);
          }
        } else if (!cont) {
          // 仅在停止循环时才走出口；继续循环时保持出口"待命"——绝不能剪枝，否则出口被永久标 skipped，
          // enqueueIfReady 会因 skipped.has(id) 拒绝它，循环结束也永远走不到出口。
          activate(e.target, nodeId);
        }
      }
      return;
    }
    // 普通/条件边
    for (const e of edges) {
      if (e.loopBack) continue;
      if (e.condition != null) {
        let t = false; try { t = asBool(evalExpr(String(e.condition), ctxNow())); } catch { t = false; }
        (t ? activate : prune)(e.target, nodeId);
      } else activate(e.target, nodeId);
    }
  };

  // 入口：entry（通常 start，无前驱）就绪。续跑时 ready 已从快照恢复，不再重置入口。
  if (!R) { enqueueIfReady(ir.entry); if (!ready.length) enqueueIfReady('start'); }

  const buildSnapshot = (): RunSnapshot => ({
    state, outputs, lastOutput, expertCalls,
    done: [...done], skipped: [...skipped], gotReal: [...gotReal],
    awaiting: Object.fromEntries(Object.entries(awaiting).map(([k, v]) => [k, [...v]])),
    loopIter, ready: [...ready], trace, humanInputs, humanDecisions, humanComments,
    rework, reworkNodes: [...reworkNodes], reworkNote,
  });

  while (ready.length) {
    if (now() - startedAt > timeoutMs) { timedOut = true; break; }
    const all = ready.splice(0, ready.length).filter((id) => !done.has(id) && !skipped.has(id)).sort(byOrder);
    // human 节点若还没拿到人工输入 → "待命"，本轮不跑。
    const blocked = all.filter((id) => ir.nodes[id]?.type === 'human' && humanInputs[id] === undefined);
    const batch = all.filter((id) => !(ir.nodes[id]?.type === 'human' && humanInputs[id] === undefined));
    if (batch.length === 0) {
      // 只剩待人工的节点、无其它可推进 → 在第一个（按 order）暂停，落快照供 resume 续跑。
      ready.push(...blocked);
      const pauseId = blocked[0];
      const n = ir.nodes[pauseId];
      // comment=hold 留痕：意见已记录但节点仍待命，本轮再次暂停时补一条审计批注（候选不变）。
      const commentCount = (humanComments[pauseId] ?? []).length;
      if (commentCount > 0) {
        trace.push({ nodeId: pauseId, label: labelOf(n), type: 'human', status: 'human', ms: 0, note: `仅意见已留痕(${commentCount} 条)，保持暂停不耗轮次` });
      }
      return {
        ok: false, trace, finalOutput: lastOutput, finalState: state, error: 'paused',
        summary: `流程在人工节点「${labelOf(n)}」暂停，注入人工输入后 resume 续跑。`,
        paused: { node: pauseId, label: labelOf(n), prompt: (n.config as any)?.prompt, snapshot: buildSnapshot() },
      };
    }
    ready.push(...blocked);   // 待人工节点留到 ready，等其它推进后再判定/暂停
    const items: RunTraceItem[] = [];
    for (let i = 0; i < batch.length; i += cap) {
      const chunk = batch.slice(i, i + cap).map((id) => ir.nodes[id]).filter(Boolean) as FlowNode[];
      const res = await Promise.all(chunk.map((n) => execTraced(n)));
      items.push(...res);
    }
    // 按 batch 顺序（已按 orderIndex 排序）结算：commit state / 记 trace / 传播出边（确定性）。
    for (const item of items) {
      done.add(item.nodeId);
      reworkNodes.delete(item.nodeId);   // 该节点已完成本轮重做(或本非重做节点)
      trace.push(item);
      if (item.output != null) { outputs[item.nodeId] = item.output; lastOutput = item.output; commitState(ir.nodes[item.nodeId], item.output); }
      if (aborted) break;
      if (item.status === 'error' && ir.error_policy === 'halt') { halted = item; break; }
      propagate(item.nodeId);
    }
    if (aborted || halted) break;
  }

  if (aborted) { const ra = (aborted as { retryAfter?: number }).retryAfter; return { ok: false, trace, finalOutput: lastOutput, finalState: state, error: 'rate_limited', retryAfter: ra, summary: `网关繁忙(429)，${ra ?? 30}s 后再试；已跑部分节点。` }; }
  if (halted) return { ok: false, trace, finalOutput: lastOutput, finalState: state, error: 'node_error', summary: ir.on_error?.message || `节点「${halted.label}」出错且 error_policy=halt，已停止：${halted.note ?? ''}` };
  if (timedOut) return { ok: false, trace, finalOutput: lastOutput, finalState: state, error: 'timeout', summary: `超过 ${Math.round(timeoutMs / 1000)}s 上限，已按 halt 停止；已跑部分节点。` };
  if (rejectedBy) return { ok: false, trace, finalOutput: lastOutput, finalState: state, error: 'rejected', summary: `流程在人工节点「${rejectedBy.label}」被驳回：${rejectedBy.opinion}（未配置驳回分支,流程已终止,不产出正式结果）` };
  return { ok: true, trace, finalOutput: lastOutput, finalState: state };
}
