/** Plaza Flow Spec 校验：结构 + io 软校验 + 明文密钥扫描。诊断结构化，供 LLM 修复回环。 */
import {
  IO_TYPES,
  NODE_TYPES,
  REDUCERS,
  SPEC_VERSION,
  STATE_TYPES,
  ioCompat,
  type IoType,
} from './constants.js';
import type { Diagnostic, FlowNode, FlowSpec, ValidateResult } from './types.js';

const has = <T>(arr: readonly T[], v: unknown): v is T => arr.includes(v as T);

// 明显是明文密钥的形状（命中即 error）。
const KEY_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
];
const SECRET_KEYNAME = /(api[_-]?key|token|secret|password|passwd|credential)/i;

/** 递归扫 spec 里的字符串，抓明文密钥。密钥应写成 `$secret.<name>` 引用。 */
function scanSecrets(value: unknown, path: string, out: Diagnostic[]): void {
  if (typeof value === 'string') {
    if (value.startsWith('$secret.')) return; // 合法引用
    for (const re of KEY_PATTERNS) {
      if (re.test(value)) {
        out.push({
          code: 'SECRET_INLINE',
          path,
          message: `疑似明文密钥出现在 ${path}；请改用 $secret.<name> 引用（值存 user_secrets，运行时解析）。`,
        });
        return;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanSecrets(v, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (
        SECRET_KEYNAME.test(k) &&
        typeof v === 'string' &&
        v.length > 0 &&
        !v.startsWith('$secret.')
      ) {
        out.push({
          code: 'SECRET_SUSPICIOUS',
          path: `${path}.${k}`,
          message: `字段名 "${k}" 像密钥但值不是 $secret.<name> 引用；确认不是明文。`,
        });
      }
      scanSecrets(v, `${path}.${k}`, out);
    }
  }
}

function firstType(ports: { type: IoType }[] | undefined): IoType | null {
  return ports && ports.length ? ports[0].type : null;
}

/**
 * 校验一份 Plaza Flow Spec。errors 非空即不可编译；warnings 可编译但应提示（画布黄标）。
 */
export function validateFlow(spec: FlowSpec): ValidateResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];

  // —— 顶层字段 ——
  if (!spec || typeof spec !== 'object') {
    return { ok: false, errors: [{ code: 'NOT_OBJECT', message: 'spec 不是对象' }], warnings };
  }
  if (!spec.spec_version) {
    errors.push({ code: 'MISSING_SPEC_VERSION', path: 'spec_version', message: '缺 spec_version' });
  } else if (spec.spec_version !== SPEC_VERSION) {
    warnings.push({
      code: 'SPEC_VERSION_MISMATCH',
      path: 'spec_version',
      message: `spec_version=${spec.spec_version}，本 SDK 编译 ${SPEC_VERSION}`,
      expected: SPEC_VERSION,
      got: String(spec.spec_version),
    });
  }
  if (!spec.id) errors.push({ code: 'MISSING_ID', path: 'id', message: '缺 id' });
  if (!spec.name) errors.push({ code: 'MISSING_NAME', path: 'name', message: '缺 name' });
  if (!Number.isInteger(spec.version)) {
    errors.push({ code: 'BAD_VERSION', path: 'version', message: 'version 必须是整数' });
  }

  // —— 节点 ——
  const nodes: FlowNode[] = Array.isArray(spec.nodes) ? spec.nodes : [];
  if (!nodes.length) errors.push({ code: 'NO_NODES', path: 'nodes', message: 'nodes 为空' });
  const byId = new Map<string, FlowNode>();
  for (const n of nodes) {
    if (!n || !n.id) {
      errors.push({ code: 'NODE_NO_ID', message: '存在无 id 节点' });
      continue;
    }
    if (byId.has(n.id)) {
      errors.push({ code: 'NODE_DUP_ID', node: n.id, message: `节点 id 重复: ${n.id}` });
    }
    byId.set(n.id, n);
    if (!has(NODE_TYPES, n.type)) {
      errors.push({
        code: 'UNKNOWN_NODE_TYPE',
        node: n.id,
        message: `未知节点类型: ${String(n.type)}`,
        got: String(n.type),
      });
    }
    // 各类型的轻量 config 检查
    if (n.type === 'expert') {
      const slug = (n.config as any)?.pack_slug;
      if (!slug) {
        warnings.push({
          code: 'EXPERT_PLACEHOLDER',
          node: n.id,
          message: `expert 节点 ${n.id} 未绑定 pack_slug（占位角色，编译可过但 publish 会拦）。`,
        });
      }
    }
    if (n.type === 'subworkflow' && !(n.config as any)?.flow_id) {
      errors.push({ code: 'SUBFLOW_NO_REF', node: n.id, message: `subworkflow ${n.id} 缺 config.flow_id` });
    }
    // io 端口类型合法性
    for (const side of ['inputs', 'outputs'] as const) {
      for (const p of n.io?.[side] ?? []) {
        if (!has(IO_TYPES, p.type)) {
          errors.push({
            code: 'BAD_IO_TYPE',
            node: n.id,
            path: `${n.id}.io.${side}`,
            message: `非法 io 类型: ${String(p.type)}`,
            got: String(p.type),
          });
        }
      }
    }
  }

  // —— entry ——
  if (!spec.entry) {
    errors.push({ code: 'MISSING_ENTRY', path: 'entry', message: '缺 entry' });
  } else if (!byId.has(spec.entry)) {
    errors.push({ code: 'ENTRY_NOT_FOUND', path: 'entry', node: spec.entry, message: `entry 指向不存在的节点: ${spec.entry}` });
  }

  // —— state ——
  for (const [k, f] of Object.entries(spec.state ?? {})) {
    if (!has(STATE_TYPES, f?.type)) {
      errors.push({ code: 'BAD_STATE_TYPE', path: `state.${k}.type`, message: `非法 state 类型: ${String(f?.type)}` });
    }
    if (!has(REDUCERS, f?.reducer)) {
      errors.push({ code: 'BAD_REDUCER', path: `state.${k}.reducer`, message: `非法 reducer: ${String(f?.reducer)}（并行不声明 reducer 会乱序覆盖）` });
    }
  }

  // —— 边 ——
  const edges = Array.isArray(spec.edges) ? spec.edges : [];
  for (const e of edges) {
    if (!e || !e.source || !e.target) {
      errors.push({ code: 'EDGE_INCOMPLETE', message: '存在缺 source/target 的边' });
      continue;
    }
    if (!byId.has(e.source)) {
      errors.push({ code: 'EDGE_DANGLING', edge: { source: e.source, target: e.target }, message: `边的 source 不存在: ${e.source}` });
    }
    if (e.target !== 'END' && !byId.has(e.target)) {
      errors.push({ code: 'EDGE_DANGLING', edge: { source: e.source, target: e.target }, message: `边的 target 不存在: ${e.target}` });
    }
    // router 分支目标必须存在
    for (const [key, tgt] of Object.entries(e.branches ?? {})) {
      if (tgt !== 'END' && !byId.has(tgt)) {
        errors.push({ code: 'BRANCH_DANGLING', edge: { source: e.source, target: tgt }, message: `router 分支 "${key}" 指向不存在的节点: ${tgt}` });
      }
    }
    // io 软校验：两端都声明 io 才查
    const src = byId.get(e.source);
    const tgt = e.target === 'END' ? null : byId.get(e.target);
    const outT = firstType(src?.io?.outputs);
    const inT = firstType(tgt?.io?.inputs);
    if (outT && inT) {
      const verdict = ioCompat(outT, inT);
      if (verdict === 'block') {
        errors.push({ code: 'IO_INCOMPATIBLE', edge: { source: e.source, target: e.target }, message: `io 冲突: ${outT} → ${inT}（control 只接 control）`, expected: outT, got: inT });
      } else if (verdict === 'warn') {
        warnings.push({ code: 'IO_MISMATCH', edge: { source: e.source, target: e.target }, message: `io 类型不一致: ${outT} → ${inT}（允许，请确认）`, expected: outT, got: inT });
      }
    }
  }

  // —— 明文密钥 ——
  const secretFindings: Diagnostic[] = [];
  scanSecrets(spec, '$', secretFindings);
  for (const f of secretFindings) {
    if (f.code === 'SECRET_INLINE') errors.push(f);
    else warnings.push(f);
  }

  return errors.length ? { ok: false, errors, warnings } : { ok: true, warnings };
}
