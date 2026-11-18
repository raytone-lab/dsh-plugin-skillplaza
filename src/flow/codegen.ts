/**
 * plaza 流程图 → DSH 工作流脚本 代码生成器。
 *
 * 架构(2026-11-13 拍板):不内嵌自研 runner —— plaza 的流程图在插件里**编译为 DSH 原生
 * 工作流脚本**(agent()/phase()/顶层 await/return JSON),交给 ctx.workflowEngine 执行。
 * 收益:DSH 原生运行视图(phases/agents 进度)与取消/清理语义全部免费获得,编排语义由
 * 生成器确定性保证(模型只跑专家节点,不走图)。
 *
 * MVP 范围(如实收窄,超范围明确报错不静默降级):
 *  - 支持:start/end/expert/human 的**串行链**(pipeline 型,如充电桩检修流程)
 *  - 不支持:router/parallel/join/loop/subworkflow —— 报 unsupported_nodes 列出类型
 *
 * expert 节点:人设(pack personaMd)嵌入 prompt;挂载的知识库成员 → 指示 agent 调
 * plaza_kb_search 工具(库 slug 嵌入,密钥不出 plaza)。
 * human 节点:生成「受理人」agent 调 ask_user_question 呈现草稿+结论(通过/驳回),
 * 驳回带意见回炉上游专家重做,≤2 轮(对齐 plaza 人工闸门语义)。
 */

export interface FlowGraphNode { id: string; type?: string; label?: string; config?: any }
export interface FlowGraph { nodes: FlowGraphNode[]; edges: { source: string; target: string }[] }
export interface ExpertData {
  nodeId: string;
  label: string;
  packSlug?: string;
  persona: string;
  kbSlugs: string[];
}

const UNSUPPORTED = new Set(['router', 'parallel', 'join', 'loop', 'subworkflow', 'swarm']);

/** 串行链校验 + 排序:每个非 start 节点至多一个入边,每个非 end 节点至多一个出边。 */
export const chainOf = (graph: FlowGraph): FlowGraphNode[] => {
  const bad = graph.nodes.filter((n) => UNSUPPORTED.has(String(n.type ?? '')));
  if (bad.length) {
    throw new Error(`该流程含暂不支持的工作流节点类型(${[...new Set(bad.map((n) => n.type))].join('/')}),当前版本支持串行 pipeline(start→专家→人工→专家→end);并行/路由/循环在下一里程碑。`);
  }
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const start = graph.nodes.find((n) => n.type === 'start');
  if (!start) throw new Error('流程缺少 start 节点');
  const out = new Map<string, string>();
  const inDeg = new Map<string, number>();
  for (const e of graph.edges) {
    if (out.has(e.source)) throw new Error(`节点 ${e.source} 有多条出边,不是串行链(并行/分支将在下一里程碑支持)`);
    out.set(e.source, e.target);
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
  }
  const chain: FlowGraphNode[] = [];
  let cur: string | undefined = start.id;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) throw new Error('流程存在回环(loop 将在下一里程碑支持)');
    seen.add(cur);
    const n = nodes.get(cur);
    if (!n) break;
    chain.push(n);
    cur = out.get(cur);
  }
  return chain;
};

const jsStr = (s: string): string => JSON.stringify(s);

/** 生成单个专家节点的 agent() 调用片段。 */
const expertCall = (e: ExpertData, inputExpr: string, phase: string): string => {
  const kbRule = e.kbSlugs.length
    ? `\n\n【知识库】你可调用工具 plaza_kb_search 检索本专家挂载的知识库:${e.kbSlugs.map((k) => `"${k}"`).join('、')}。凡涉及你职责领域的问题,先调它检索(逐次 1-3 次,取够了再答),基于返回片段作答并点明来源;只要检索到片段,绝不能说"未检索到/无法确认"。`
    : '';
  const prompt = `${e.persona}${kbRule}

【你在一条自动化业务流程中扮演「${e.label}」这一步。基于上游输入完成你的职责,输出简洁结论。不要复述任务,直接给产出。】

===== 上游输入 =====
${'${'}${inputExpr}}`;
  return `await agent(${jsStr(prompt)}, { phase: ${jsStr(phase)} })`;
};

/** 生成完整工作流脚本(plain JS)。 */
export const buildFlowScript = (flowName: string, chain: FlowGraphNode[], experts: Map<string, ExpertData>, inputLabel: string): string => {
  const lines: string[] = [];
  lines.push(`// plaza 流程「${flowName}」→ DSH 工作流脚本(由 dsh-plugin-skillplaza 确定性生成,模型只执行专家节点)`);
  lines.push(`const input = args.input ?? '';`);
  lines.push(`const trace = [];`);
  lines.push(`const outputs = {};`);

  const executable = chain.filter((n) => n.type !== 'start' && n.type !== 'end');
  let prevExpr = 'input';
  let i = 0;
  for (const node of executable) {
    i++;
    const e = experts.get(node.id);
    if (node.type === 'human') {
      const gateLabel = node.label || '人工审批';
      lines.push(`phase(${jsStr(gateLabel)});`);
      lines.push(`let gateDecision = null;`);
      lines.push(`for (let round = 0; round < 3; round++) {`);
      lines.push(`  const reviewAgent = await agent(${jsStr(
        `你是「${gateLabel}」的受理人。把下面的流程产出呈现给用户,调用 ask_user_question 请用户拍板:通过 / 驳回(可附意见)。然后**只输出一行**:通过输出 "APPROVED";驳回输出 "REJECTED: <用户意见原文>"。除此之外不要输出任何内容。\n\n===== 待审产出 =====\n${'${'}draftForReview}`,
      )}, { phase: ${jsStr(gateLabel)} });`);
      lines.push(`  const verdict = String(reviewAgent ?? '').trim();`);
      lines.push(`  trace.push({ node: ${jsStr(node.id)}, kind: 'human', round, verdict: verdict.slice(0, 60) });`);
      lines.push(`  if (verdict.startsWith('APPROVED')) { gateDecision = 'approved'; break; }`);
      lines.push(`  if (verdict.startsWith('REJECTED')) {`);
      lines.push(`    if (round >= 2) return { ok: false, error: '人工闸门连续驳回超过 2 轮,流程终止', trace };`);
      lines.push(`    const comment = verdict.slice(8).trim() || '(无意见)';`);
      lines.push(`    trace.push({ node: ${jsStr(node.id)}, kind: 'rework', comment });`);
      // 驳回回炉:重跑该闸门前的最后一个专家节点(带驳回意见)
      const upstreamExpert = [...executable.slice(0, i - 1)].reverse().find((n) => experts.has(n.id));
      const ue = upstreamExpert ? experts.get(upstreamExpert.id)! : null;
      if (ue) {
        lines.push(`    outputs[${jsStr(ue.nodeId)}] = ${expertCall({ ...ue, persona: ue.persona + `\n\n【驳回重做】上一版被人工驳回,意见:${'${'}comment}。请针对性修正后重新产出。` }, `outputs[${jsStr(ue.nodeId)}]`, gateLabel)};`);
        lines.push(`    draftForReview = outputs[${jsStr(ue.nodeId)}];`);
        lines.push(`    if (draftForReview == null) return { ok: false, error: '驳回重做节点失败', trace };`);
      }
      lines.push(`    continue;`);
      lines.push(`  }`);
      lines.push(`  return { ok: false, error: '人工闸门未给出明确结论', trace };`);
      lines.push(`}`);
      continue;
    }
    if (!e) continue;   // 非专家/非人工的控制节点跳过
    const label = e.label || node.id;
    lines.push(`phase(${jsStr(label)});`);
    lines.push(`outputs[${jsStr(e.nodeId)}] = ${expertCall(e, prevExpr, label)};`);
    lines.push(`trace.push({ node: ${jsStr(e.nodeId)}, ok: outputs[${jsStr(e.nodeId)}] != null, chars: String(outputs[${jsStr(e.nodeId)}] ?? '').length });`);
    lines.push(`if (outputs[${jsStr(e.nodeId)}] == null) return { ok: false, error: '节点「${label.replace(/'/g, '')}」执行失败', trace };`);
    prevExpr = `outputs[${jsStr(e.nodeId)}]`;
    // 闸门后首个产出 = 待审草稿
    if (executable.some((n, idx) => idx > i - 1 && n.type === 'human')) {
      lines.push(`var draftForReview = ${prevExpr};`);
    }
  }

  lines.push(`return { ok: true, flow: ${jsStr(flowName)}, final: String(${prevExpr} ?? ''), trace };`);
  return lines.join('\n');
};

/** meta 块( phases 供 DSH 运行视图展示)。 */
export const buildFlowMeta = (slug: string, name: string, chain: FlowGraphNode[]) => ({
  name: `plaza-${slug}`.slice(0, 64).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
  description: `Skill 广场流程「${name}」的 DSH 工作流运行(由 dsh-plugin-skillplaza 生成)`,
  whenToUse: '用户在 DSH 里运行 Skill 广场发布的流程场景',
  phases: chain.filter((n) => n.type !== 'start' && n.type !== 'end').map((n, i) => ({ title: n.label || n.id, order: i + 1 })),
});
