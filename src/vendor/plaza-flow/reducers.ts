/**
 * State reducer 语义 —— Plaza Flow Spec §4 的**可执行真相**。
 *
 * 并行/多写时，同一个 state 字段可能被多个分支写入；如何合并由该字段声明的 reducer 决定。
 * 这是 plaza 与任意上层运行时（iruidong PI agent / codex / Claude Code / 自研）**必须逐字节一致**的
 * 跨实现契约：任何运行时都应 import 本函数（或按本文件语义精确复刻），而不是各自解读 SPEC 文字。
 *
 *   last          后写覆盖（单写字段）
 *   add           列表追加（并行结果收集：各分支各 push 一份）
 *   add_messages  消息追加（对话累积；语义同 add，但约定元素是 message 对象）
 *   merge         对象浅合并（多来源各写一部分）
 *
 * 确定性铁律：并行分支的写入顺序，一律按 CompiledFlow.order 里该并行层 `nodes[]` 的**数组顺序**折叠，
 * 不依赖 Promise 完成的时间先后——否则并行结果的合并会不可复现。
 */
import type { Reducer } from './constants.js';

export type StateValue = unknown;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asList = (v: StateValue): unknown[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/**
 * 把一次 incoming 写入折叠进 current，返回新值（纯函数，不改入参）。
 * current 为 undefined 表示该字段尚无值（首次写入）。
 */
export function reduceOne(reducer: Reducer, current: StateValue | undefined, incoming: StateValue): StateValue {
  switch (reducer) {
    case 'last':
      return incoming;
    case 'add':
    case 'add_messages':
      // 追加：current 与 incoming 都规整成列表再拼（add_messages 约定元素为 message 对象，合并规则同 add）。
      return [...asList(current), ...asList(incoming)];
    case 'merge': {
      // 浅合并：只在都是「普通对象」时合并；否则退化为后写覆盖（避免把数组/标量误并成对象）。
      if (!isPlainObject(incoming)) return incoming;
      return { ...(isPlainObject(current) ? current : {}), ...incoming };
    }
    default:
      // 未知 reducer（理论上被 validate 挡住）→ 保守后写覆盖。
      return incoming;
  }
}

/**
 * 把多次写入按数组顺序依次折叠成最终值（并行层 fan-in 用）。
 * writes 的顺序 = 该并行层 order.nodes[] 的顺序，保证可复现。
 */
export function reduceMany(reducer: Reducer, initial: StateValue | undefined, writes: StateValue[]): StateValue {
  return writes.reduce<StateValue>((acc, w) => reduceOne(reducer, acc, w), initial);
}
