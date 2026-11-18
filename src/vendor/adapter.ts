/**
 * 适配层：把现有 scenarios 的 graph_json（React Flow 形态）桥接到 @iruidong/plaza-flow 编译 SDK。
 * 用途：dryrun 用 SDK 的拓扑排序（替换旧 planOrder 的 BFS bug）；publish 用 SDK 的发布闸门。
 * SDK 走相对路径 import 源码（server 是 tsx 直跑，无需 build/link；部署时 packages/plaza-flow 一并 rsync）。
 */
import {
  compileFlow,
  checkPublishable,
  type CompileResult,
  type FlowSpec,
  type FlowNode,
  type FlowEdge,
  type Diagnostic,
} from './plaza-flow/index.js';

type Graph = { nodes?: any[]; edges?: any[]; settings?: any };
type Meta = { id: string; name: string; version?: number };

/** 回边识别：multi_round 的 end→n1（源节点是 end）或标了「循环/loop」的边。 */
function isLoopBack(e: any, nodeType: Map<string, string>): boolean {
  if (/循环|loop|回边|back/i.test(String(e?.label ?? ''))) return true;
  if (nodeType.get(e?.source) === 'end') return true;
  return false;
}

/** 审批出边标签 → 规范结论值(runner 的 human 分流按它匹配;中英同义词都认)。 */
const APPROVAL_BRANCH: Record<string, string> = {
  '通过': 'approved', '同意': 'approved', '批准': 'approved', 'approve': 'approved', 'approved': 'approved',
  '驳回': 'rejected', '拒绝': 'rejected', '打回': 'rejected', 'reject': 'rejected', 'rejected': 'rejected',
};
const approvalBranchOf = (label: unknown): string | null =>
  APPROVAL_BRANCH[String(label ?? '').trim().toLowerCase()] ?? null;

/** graph_json → Plaza Flow Spec。节点 type 与现有一致；packSlug → config.pack_slug。 */
export function graphToFlowSpec(graph: Graph, meta: Meta): FlowSpec {
  const rawNodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const rawEdges: any[] = Array.isArray(graph?.edges) ? graph.edges : [];
  const nodeType = new Map<string, string>(rawNodes.map((n) => [n.id, n.type]));

  const nodes: FlowNode[] = rawNodes.map((n) => ({
    id: n.id,
    type: n.type,
    config: { ...(n.config ?? {}), ...(n.packSlug ? { pack_slug: n.packSlug } : {}) },
    label: n.label,
    position: n.position,
  }));

  const edges: FlowEdge[] = rawEdges.map((e) => {
    const edge: FlowEdge = { source: e.source, target: e.target };
    // 显式属性优先（种子/高级作者直接声明）：branches / condition / loopBack。
    if (e.branches && typeof e.branches === 'object') edge.branches = e.branches;
    if (e.condition != null && e.condition !== '') edge.condition = String(e.condition);
    if (e.loopBack === true || isLoopBack(e, nodeType)) edge.loopBack = true;
    // 未显式声明时按 label 启发式：**router 出边的 label = 分支值**（映射成 branch，
    // 否则 runner 的 router 靠 e.branch 判分支会失效、把所有分支都激活）；
    // **human 出边的审批标签(通过/驳回) = 审批分支**(runner 按 resume 的 decision 分流)；其余 label = 布尔条件边。
    if (!edge.branches && edge.condition == null && e.label) {
      const srcType = nodeType.get(e.source);
      const approval = srcType === 'human' ? approvalBranchOf(e.label) : null;
      if (srcType === 'router') edge.branches = { [String(e.label)]: e.target };
      else if (approval) edge.branches = { [approval]: e.target };
      else edge.condition = String(e.label);
    }
    return edge;
  });

  const entry = rawNodes.find((n) => n.type === 'start')?.id ?? rawNodes[0]?.id ?? 'start';
  const s = graph?.settings ?? {};
  const timeoutMs = Number(s.timeoutMs);
  const state =
    s.state && typeof s.state === 'object' && !Array.isArray(s.state)
      ? (s.state as FlowSpec['state'])
      : undefined;
  return {
    spec_version: '1.0',
    id: meta.id,
    version: meta.version ?? 1,
    name: meta.name,
    entry,
    state,
    nodes,
    edges,
    error_policy: s.onError === 'continue' ? 'continue' : 'halt',
    timeout_seconds:
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs / 1000) : undefined,
  };
}

/** graph_json → 编译结果（给 playground 试跑用）。 */
export function compileGraph(graph: Graph, meta: Meta): CompileResult {
  return compileFlow(graphToFlowSpec(graph, meta));
}

/** 群集(swarm/A2A) 本质动态成环，DAG 编译器不适用 —— 单独给人读的 summary（沿用旧 planOrder 语义）。 */
function swarmSummary(graph: Graph) {
  const rawNodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const rawEdges: any[] = Array.isArray(graph?.edges) ? graph.edges : [];
  const experts = rawNodes.filter((n) => n.type === 'expert');
  const names = experts.map((n) => n.label || n.packSlug || n.id);
  const entryId = rawEdges.find((e) => e.source === 'start')?.target;
  const entry = experts.find((n) => n.id === entryId)?.label || names[0] || '(未设)';
  return {
    ok: true,
    summary: `群集协作(A2A 移交)：入口=${entry}；可在 [${names.join('、')}] 间按条件动态移交，任一专家可结束（移交/结束由运行时智能体决定）。`,
    order: [{ step: 1, mode: 'swarm', nodes: names }],
    warnings: [] as Diagnostic[],
  };
}

/** dryrun：编译 + 生成人类可读 summary（保持前端 {summary, order} 契约）。 */
export function dryrunGraph(graph: Graph, meta: Meta, flowType?: string) {
  if (flowType === 'swarm') return swarmSummary(graph);

  const rawNodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const labelOf = new Map<string, string>(
    rawNodes.map((n) => [n.id, n.label || n.packSlug || n.type || n.id]),
  );
  const typeOf = new Map<string, string>(rawNodes.map((n) => [n.id, n.type]));

  const res = compileFlow(graphToFlowSpec(graph, meta));
  if (!res.ok) {
    const msg = res.errors
      .map((e) => `${e.code}${e.node ? `(${e.node})` : ''}: ${e.message}`)
      .join('；');
    return { ok: false, summary: `无法编译：${msg}`, order: [], errors: res.errors, warnings: res.warnings };
  }

  const parts = res.ir.order
    .map((step) => {
      const names = step.nodes
        .filter((id) => typeOf.get(id) !== 'start' && typeOf.get(id) !== 'end')
        .map((id) => labelOf.get(id) ?? id);
      if (!names.length) return null;
      return step.mode === 'parallel' ? `并行[${names.join('、')}]` : names[0];
    })
    .filter(Boolean);
  const warnTail = res.warnings.length ? ` · ⚠${res.warnings.length} 条提示` : '';
  const summary = `开始 → ${parts.join(' → ') || '(空)'} → 结束${warnTail}`;
  return { ok: true, summary, order: res.ir.order, warnings: res.warnings };
}

/** publish 闸门：swarm 只查「至少一个绑定真专家」；其余走 SDK 的编译+闸门。 */
export function publishCheck(graph: Graph, meta: Meta, flowType?: string) {
  if (flowType === 'swarm') {
    const bound = (graph?.nodes ?? []).filter((n: any) => n.type === 'expert' && n.packSlug);
    return bound.length
      ? { ok: true as const, errors: [] as Diagnostic[], warnings: [] as Diagnostic[] }
      : {
          ok: false as const,
          warnings: [] as Diagnostic[],
          errors: [{ code: 'NO_BOUND_EXPERT', message: '至少要有一个绑定专家的节点才能发布。' }],
        };
  }
  return checkPublishable(graphToFlowSpec(graph, meta));
}
