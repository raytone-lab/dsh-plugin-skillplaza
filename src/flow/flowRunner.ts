/**
 * 流程运行器 —— vendored plaza runner 驱动 + 运行状态注册 + 暂停/恢复。
 *
 * runFlow(vendor/runner.ts)按 IR 走图;runExpert 用 llmExpert(直连 ctx.llm,不依赖
 * workflowEngine)。事件(node_start/node_done/tool_call/tool_result/node_delta)直接
 * 更新运行注册表 —— 节点点亮不再需要猜 DSH 引擎事件字段(2026-11-14 架构转向)。
 *
 * 人工闸门:runner 命中 human 节点返回 paused(含可序列化快照)→ 本模块把它登记为
 * waiting 状态挂起,等待 plaza_flow_resume 工具携审批结论恢复续跑。
 */
import { runFlow, type RunEvent, type RunOpts } from '../vendor/runner.js';
import type { CompiledFlow } from '../vendor/plaza-flow/index.js';
import { runExpertViaLlm, type LlmStreamFn } from './llmExpert.js';
import type { PlazaClient } from '../plaza-client.js';
import { registerRun, markNode, settleRun, type RunNodeState } from './runRegistry.js';
import type { RunEdge } from './runRegistry.js';

export interface FlowRunHandle {
  runId: string;
  /** 终态(done/error)或 paused(等审批)。 */
  settle: Promise<{ ok: boolean; final?: string; error?: string }>;
  resume: (decision: 'approved' | 'rejected', comment: string) => Promise<{ ok: boolean; final?: string; error?: string }>;
}

let seq = 0;
const pending = new Map<string, { snapshot: unknown; node: string; label: string }>();

export const startFlowRun = (opts: {
  client: PlazaClient;
  llm: LlmStreamFn;
  route: { provider: string; model: string };
  ir: CompiledFlow;
  slug: string;
  flowName: string;
  nodes: RunNodeState[];
  edges?: RunEdge[];
  input: string;
}): FlowRunHandle => {
  const runId = `run-${Date.now()}-${++seq}`;
  const { client, llm, route, ir, slug, flowName, nodes, input } = opts;
  const edges = opts.edges ?? [];
  registerRun(runId, slug, flowName, flowName, nodes, edges ?? []);

  const emit = (ev: RunEvent) => {
    const labelOf = (nid: string) => nodes.find((n) => n.nodeId === nid)?.label ?? nid;
    if (ev.kind === 'node_start') markNode(flowName, labelOf(ev.nodeId), 'running');
    else if (ev.kind === 'node_done') markNode(flowName, labelOf(ev.nodeId), ev.status === 'error' ? 'error' : 'done');
  };

  const runExpert: RunOpts['runExpert'] = async (node, inputText, nodeEmit) => {
    const kbSlugs: string[] = (node as any).kbSlugs ?? [];
    const tools = kbSlugs.length
      ? [{
          name: 'knowledge-search',
          description: '检索本专家挂载的知识库,返回相关片段(标题/正文/来源)。凡涉及本专家领域的问题,优先调用。',
          parameters: { type: 'object', properties: { query: { type: 'string', description: '检索问题' } }, required: ['query'] },
          execute: async (args: Record<string, string>) => {
            try {
              const hits = await client.kbSearch(kbSlugs[0], String(args.query ?? ''));
              return { ok: hits.length > 0, text: hits.length ? JSON.stringify(hits.slice(0, 6)) : '(未检索到相关片段)' };
            } catch (e) { return { ok: false, text: `检索失败:${(e as Error).message}` }; }
          },
        }]
      : [];
    return runExpertViaLlm(llm, route, {
      persona: (node as any).persona ?? '你是业务专家。',
      name: (node as any).label ?? node.id,
      input: inputText,
      tools,
      nodeId: node.id,
      emit: (ev) => nodeEmit?.(ev as RunEvent),
    });
  };

  const drive = async (resume?: { node: string; input: string; snapshot: any; decision?: string }): Promise<{ ok: boolean; final?: string; error?: string }> => {
    try {
      const result = await runFlow(ir, {
        input: resume ? '' : input,
        runExpert,
        onEvent: emit,
        maxExperts: 24,
        ...(resume ? { resume } : {}),
      });
      if (result.paused) {
        const key = `${runId}:${result.paused.node}`;
        pending.set(key, { snapshot: result.paused.snapshot, node: result.paused.node, label: result.paused.label ?? result.paused.node });
        const n = nodes.find((x) => x.nodeId === result.paused!.node || x.label === result.paused!.label);
        if (n) n.status = 'waiting';
        return { ok: false, error: `流程已在人工节点「${result.paused.label ?? result.paused.node}」暂停,等待审批。请审批:批准则继续;驳回(附意见)则回炉重做(≤2轮)。` };
      }
      settleRun(flowName, result.ok ? 'done' : 'error', result.error);
      return { ok: result.ok, final: result.finalOutput, error: result.error };
    } catch (e) {
      settleRun(flowName, 'error', (e as Error).message);
      return { ok: false, error: (e as Error).message };
    }
  };

  return {
    runId,
    settle: drive(),
    resume: async (decision, comment) => {
      const keys = [...pending.keys()].filter((k) => k.startsWith(`${runId}:`));
      const key = keys[keys.length - 1];
      const p = key ? pending.get(key) : undefined;
      if (!p) return { ok: false, error: '没有等待审批的人工节点(流程可能已结束或已恢复)。' };
      pending.delete(key!);
      const n = nodes.find((x) => x.nodeId === p.node || x.label === p.label);
      if (n) n.status = decision === 'approved' ? 'done' : 'error';
      return drive({ node: p.node, input: comment || (decision === 'approved' ? '通过' : '驳回'), snapshot: p.snapshot, decision });
    },
  };
};
