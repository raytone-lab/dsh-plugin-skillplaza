/**
 * 编译：Plaza Flow Spec → CompiledFlow IR（上层运行时真正执行的东西）。
 * 顺序用 Kahn 拓扑 + 最长路径分层（替换旧 scenarios 里 BFS-距离分层的 bug：
 * 菱形/汇聚图上后者会把节点排到上游没跑完的层、并误报并行、把孤儿塞进末层）。
 */
import { COMPILER_ID, DEFAULTS } from './constants.js';
import { validateFlow } from './validate.js';
import type {
  CompileResult,
  CompiledFlow,
  Diagnostic,
  FlowEdge,
  FlowNode,
  FlowSpec,
  IrEdge,
  IrStep,
} from './types.js';

const END = 'END';

/** 把边展开成 (source -> IrEdge)，router 的每个 branch 拆成独立出边。 */
function buildAdjacency(edges: FlowEdge[]): Map<string, IrEdge[]> {
  const adj = new Map<string, IrEdge[]>();
  const push = (s: string, e: IrEdge) => {
    if (!adj.has(s)) adj.set(s, []);
    adj.get(s)!.push(e);
  };
  for (const e of edges) {
    if (e.branches && Object.keys(e.branches).length) {
      for (const [branch, target] of Object.entries(e.branches)) {
        push(e.source, { target, branch, loopBack: e.loopBack });
      }
    } else {
      push(e.source, { target: e.target, condition: e.condition, loopBack: e.loopBack });
    }
  }
  return adj;
}

export function compileFlow(spec: FlowSpec): CompileResult {
  const v = validateFlow(spec);
  if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings };
  const warnings: Diagnostic[] = [...v.warnings];
  const errors: Diagnostic[] = [];

  const nodes = spec.nodes;
  const byId = new Map<string, FlowNode>(nodes.map((n) => [n.id, n]));
  const adj = buildAdjacency(spec.edges);

  // —— 可达性（含 loopBack，因为循环体确实会跑）——
  const reachable = new Set<string>();
  const stack = [spec.entry];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === END || reachable.has(cur)) continue;
    reachable.add(cur);
    for (const e of adj.get(cur) ?? []) stack.push(e.target);
  }
  // 孤儿：不可达节点（旧实现会静默塞进末层伪并行——这里明确报错）
  for (const n of nodes) {
    if (!reachable.has(n.id)) {
      errors.push({ code: 'ORPHAN', node: n.id, message: `节点 ${n.id} 从 entry 不可达（孤儿），无法编译进执行计划。` });
    }
  }
  if (errors.length) return { ok: false, errors, warnings };

  // —— Kahn 拓扑（只在可达真实节点、非回边上算），最长路径分层 ——
  const realReach = [...reachable].filter((id) => id !== END && byId.has(id));
  const indeg = new Map<string, number>(realReach.map((id) => [id, 0]));
  const fwd = new Map<string, string[]>(realReach.map((id) => [id, []]));
  for (const src of realReach) {
    for (const e of adj.get(src) ?? []) {
      if (e.loopBack) continue; // 回边不参与排序
      if (e.target === END || !indeg.has(e.target)) continue;
      fwd.get(src)!.push(e.target);
      indeg.set(e.target, indeg.get(e.target)! + 1);
    }
  }
  const layer = new Map<string, number>(realReach.map((id) => [id, 0]));
  const queue = realReach.filter((id) => indeg.get(id) === 0);
  let processed = 0;
  while (queue.length) {
    const u = queue.shift()!;
    processed++;
    for (const w of fwd.get(u)!) {
      layer.set(w, Math.max(layer.get(w)!, layer.get(u)! + 1)); // 最长路径
      indeg.set(w, indeg.get(w)! - 1);
      if (indeg.get(w) === 0) queue.push(w);
    }
  }
  if (processed < realReach.length) {
    // 非回边上还成环 = 未标 loopBack 的意外循环
    errors.push({
      code: 'CYCLE',
      message: '检测到非法环（非回边成环）；若是有意循环，请在回边上标 loopBack:true。',
    });
    return { ok: false, errors, warnings };
  }

  // —— 分层 → 执行计划（同层多节点即并行）——
  const layers = new Map<number, string[]>();
  for (const id of realReach) {
    const L = layer.get(id)!;
    if (!layers.has(L)) layers.set(L, []);
    layers.get(L)!.push(id);
  }
  const order: IrStep[] = [...layers.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, group], i) => ({
      step: i + 1,
      mode: group.length > 1 ? 'parallel' : 'serial',
      nodes: group,
    }));

  // 并行层但没声明任何 state reducer → 提示（并行合并会乱序覆盖）
  const hasParallel = order.some((s) => s.mode === 'parallel');
  if (hasParallel && Object.keys(spec.state ?? {}).length === 0) {
    warnings.push({
      code: 'PARALLEL_NO_STATE',
      message: '存在并行层但未声明任何 state/reducer；并行结果如何合并未定义，运行时可能乱序覆盖。',
    });
  }

  // —— 规整节点（补 config 对象）+ 邻接表 ——
  const nodesOut: Record<string, FlowNode> = {};
  for (const n of nodes) nodesOut[n.id] = { ...n, config: n.config ?? {} };
  const adjacency: Record<string, IrEdge[]> = {};
  for (const [s, es] of adj.entries()) adjacency[s] = es;

  const ir: CompiledFlow = {
    spec_version: spec.spec_version,
    id: spec.id,
    version: spec.version,
    name: spec.name,
    entry: spec.entry,
    state: spec.state ?? {},
    nodes: nodesOut,
    adjacency,
    order,
    error_policy: spec.error_policy ?? DEFAULTS.errorPolicy,
    on_error: spec.on_error ?? {},
    timeout_seconds: spec.timeout_seconds ?? DEFAULTS.timeoutSeconds,
    max_concurrency: spec.max_concurrency ?? DEFAULTS.maxConcurrency,
    compiled_by: COMPILER_ID,
  };
  return { ok: true, ir, warnings };
}
