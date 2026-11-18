/**
 * @iruidong/plaza-flow —— Plaza Flow Spec 编译 SDK。
 *
 * 契约是编译产物(CompiledFlow IR，纯 JSON)，本包是产出/校验它的工具。
 * 语义即代码：上层运行时 import 本包 compile() 即可获得与广场一致的编译结果，
 * 无需照文档重新实现语义（避免各自解读导致的分叉）。
 *
 *   import { parseFlow, validateFlow, compileFlow } from '@iruidong/plaza-flow';
 *   const spec = parseFlow(yamlOrJsonOrObject);
 *   const res = compileFlow(spec);
 *   if (res.ok) run(res.ir); else showErrors(res.errors);
 */
export * from './constants.js';
export * from './types.js';
export { validateFlow } from './validate.js';
export { compileFlow } from './compile.js';
export { reduceOne, reduceMany, type StateValue } from './reducers.js';
export { evalExpr, asBool, type ExprValue } from './expr.js';

import { compileFlow } from './compile.js';
import type { CompileResult, Diagnostic, FlowSpec } from './types.js';

/**
 * 解析输入成 FlowSpec。
 * - 传对象：原样返回（已是解析好的 spec）。
 * - 传 JSON 字符串：JSON.parse。
 * - YAML：本包核心零依赖、不内置 YAML 解析；请在调用方用任意 YAML 库转成对象后传入
 *   （契约与校验以 JSON/对象为准，YAML 只是编写皮）。
 */
export function parseFlow(input: string | object): FlowSpec {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      throw new Error(
        'parseFlow 只吃对象或 JSON 字符串；YAML 请先用 YAML 库转成对象再传入（见 SPEC.md）。',
      );
    }
    return JSON.parse(trimmed) as FlowSpec;
  }
  return input as FlowSpec;
}

/**
 * 发布闸门：published 的 flow 必须能编译 + 至少一个已绑定真专家（非占位 expert）。
 * 对应计划书 §8.9——不满足则拒绝“启用”，避免空动作 publish。
 */
export function checkPublishable(spec: FlowSpec): { ok: boolean; errors: Diagnostic[]; warnings: Diagnostic[] } {
  const res: CompileResult = compileFlow(spec);
  if (!res.ok) return { ok: false, errors: res.errors, warnings: res.warnings };
  const boundExperts = spec.nodes.filter(
    (n) => n.type === 'expert' && !!(n.config as any)?.pack_slug,
  );
  if (boundExperts.length === 0) {
    return {
      ok: false,
      warnings: res.warnings,
      errors: [
        {
          code: 'NO_BOUND_EXPERT',
          message: '至少要有一个绑定了 pack_slug 的 expert 节点才能发布（占位角色不算）。',
        },
      ],
    };
  }
  return { ok: true, errors: [], warnings: res.warnings };
}
