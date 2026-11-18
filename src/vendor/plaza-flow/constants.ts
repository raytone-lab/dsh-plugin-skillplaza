/**
 * Plaza Flow Spec —— 词汇表（单一真相）。
 * 语义精确性对齐 Forge（packages/schemas/forge/*）已验证过的模型，但 $id / 版本归 plaza 自持。
 * 改这里 = 改契约：任何新增都要同步 SPEC.md 的执行语义 + 一致性测试。
 */

export const SPEC_VERSION = '1.0';
export const COMPILER_ID = '@iruidong/plaza-flow@1.0.0';

/** 节点类型。plaza 自有命名；上层运行时按 SPEC.md 的语义适配执行。 */
export const NODE_TYPES = [
  'start', // 唯一入口锚点（out: control）
  'end', // 终止锚点（in: control）
  'expert', // 引用广场里的一个 pack（专家/团）——真正干活的节点
  'router', // 条件路由：按 config.expression 的值走 branches 里的分支
  'parallel', // 并行分发：把上游同时分给多个下游（fan-out）
  'join', // 并行汇聚：等多个上游到齐，按 state reducer 合并（fan-in）
  'loop', // 循环：回到某节点直到条件满足
  'human', // 人工介入：暂停等输入/审批（上层运行时负责持久化+恢复）
  'subworkflow', // 子流程：把另一条已发布 flow 当一个节点复用
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** io 端口类型（软校验用）。对齐 Forge 节点 $comment 里的端口词汇 + plaza 扩展。 */
export const IO_TYPES = [
  'text',
  'json',
  'list[json]',
  'list[str]',
  'messages',
  'control', // 纯控制流信号，不携带数据
  'any', // 通配
  'binary', // plaza 扩展
  'image', // plaza 扩展
] as const;
export type IoType = (typeof IO_TYPES)[number];

/** 共享 state 字段类型。直接采用 Forge StateFieldSpec 的集合。 */
export const STATE_TYPES = [
  'str',
  'int',
  'float',
  'bool',
  'json',
  'list[json]',
  'list[str]',
  'list[message]',
] as const;
export type StateType = (typeof STATE_TYPES)[number];

/** reducer：并行/多写时如何合并同一 state 字段。语义见 SPEC.md §并行与状态。 */
export const REDUCERS = [
  'add_messages', // 追加消息（对话累积）
  'add', // 列表累加（并行结果收集）
  'last', // 后写覆盖
  'merge', // 对象浅合并
] as const;
export type Reducer = (typeof REDUCERS)[number];

export const ERROR_POLICIES = ['halt', 'continue'] as const;
export type ErrorPolicy = (typeof ERROR_POLICIES)[number];

export const DEFAULTS = {
  errorPolicy: 'halt' as ErrorPolicy,
  timeoutSeconds: 600,
  maxConcurrency: 8,
} as const;

/**
 * io 端口兼容判定 —— 软校验（对齐 Forge：端口类型是 advisory 注释，不是硬门槛）。
 * 'ok'    完全兼容；'warn' 可疑但放行（画布黄标）；'block' 硬冲突（仅 control 与非 control 互斥）。
 */
export function ioCompat(out: IoType, into: IoType): 'ok' | 'warn' | 'block' {
  if (out === 'control' || into === 'control') {
    return out === into ? 'ok' : 'block'; // control 只接 control
  }
  if (out === 'any' || into === 'any') return 'ok';
  if (out === into) return 'ok';
  return 'warn'; // 其余不匹配只警告，不拦截（text→json 之类合理连接不判死）
}
