/** Plaza Flow Spec 的 TS 类型（authoring 形态 + 编译产物 IR + 诊断）。 */
import type {
  ErrorPolicy,
  IoType,
  NodeType,
  Reducer,
  StateType,
} from './constants.js';

// ─────────────────────────── Authoring: Plaza Flow Spec ───────────────────────────

export interface IoPort {
  name: string;
  type: IoType;
  required?: boolean;
}

/** 节点。config 的形状随 type 而定（见 SPEC.md §节点）。 */
export interface FlowNode {
  id: string;
  type: NodeType;
  /** expert 节点：{ pack_slug }；router：{ expression }；loop：{ until?, max_iterations? }；
   *  human：{ prompt? }；subworkflow：{ flow_id, flow_version? }。其余节点通常无 config。 */
  config?: Record<string, unknown>;
  /** 该节点声明的输入/输出端口（软校验用；不填按 any 处理）。 */
  io?: { inputs?: IoPort[]; outputs?: IoPort[] };
  /** 画布坐标（不影响执行，仅透传）。 */
  position?: { x: number; y: number };
  label?: string;
}

export interface FlowEdge {
  source: string;
  /** 目标节点 id，或字面量 'END'。 */
  target: string;
  /** router 分支：命中 branches 的 key 时走对应 target；与 condition 二选一。 */
  branches?: Record<string, string>;
  /** 布尔条件边（真才走）。 */
  condition?: string;
  /** 循环回边标记（compile 时据此允许成环，不报环错误）。 */
  loopBack?: boolean;
  label?: string;
}

export interface StateFieldSpec {
  type: StateType;
  reducer: Reducer;
}

export interface FlowSpec {
  spec_version: string;
  /** 稳定标识，如 flow.kyc_onboarding。 */
  id: string;
  /** 内容版本，整数，改动即 +1。 */
  version: number;
  name: string;
  description?: string;
  /** 入口节点 id（通常指向 type=start 的节点）。 */
  entry: string;
  /** 共享状态：字段名 -> {type, reducer}。并行/多写时靠 reducer 合并。 */
  state?: Record<string, StateFieldSpec>;
  nodes: FlowNode[];
  edges: FlowEdge[];
  error_policy?: ErrorPolicy;
  on_error?: { message?: string; escalate?: boolean };
  timeout_seconds?: number;
  max_concurrency?: number;
  /** 整条 flow 对外 io（作为 subworkflow 被引用时的签名）。 */
  io_schema?: { inputs?: IoPort[]; outputs?: IoPort[] };
  /** plaza 私有命名空间：市场元数据，运行时忽略。 */
  x_plaza?: Record<string, unknown>;
}

// ─────────────────────────── 诊断（结构化，喂 LLM 修复回环）───────────────────────────

export interface Diagnostic {
  /** 机器码，如 UNKNOWN_NODE_TYPE / EDGE_DANGLING / CYCLE / ORPHAN / IO_MISMATCH / SECRET_INLINE。 */
  code: string;
  message: string;
  /** 定位：出问题的节点 id / 边 / 字段路径。 */
  node?: string;
  edge?: { source: string; target: string };
  path?: string;
  expected?: string;
  got?: string;
}

// ─────────────────────────── 编译产物 IR（上层运行时真正跑的东西）───────────────────────────

export interface IrEdge {
  target: string;
  condition?: string;
  branch?: string;
  loopBack?: boolean;
}

/** 执行计划的一层：同层多节点即可并行。 */
export interface IrStep {
  step: number;
  mode: 'serial' | 'parallel';
  nodes: string[];
}

export interface CompiledFlow {
  spec_version: string;
  id: string;
  version: number;
  name: string;
  entry: string;
  state: Record<string, StateFieldSpec>;
  /** id -> 规整后的节点（含解析后的 io / config，默认已填）。 */
  nodes: Record<string, FlowNode>;
  /** 邻接表：源 id -> 出边。 */
  adjacency: Record<string, IrEdge[]>;
  /** 拓扑执行计划（Kahn + 最长路径分层；忽略 loopBack 回边）。 */
  order: IrStep[];
  error_policy: ErrorPolicy;
  on_error: { message?: string; escalate?: boolean };
  timeout_seconds: number;
  max_concurrency: number;
  compiled_by: string;
}

export type ValidateResult =
  | { ok: true; warnings: Diagnostic[] }
  | { ok: false; errors: Diagnostic[]; warnings: Diagnostic[] };

export type CompileResult =
  | { ok: true; ir: CompiledFlow; warnings: Diagnostic[] }
  | { ok: false; errors: Diagnostic[]; warnings: Diagnostic[] };
