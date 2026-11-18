/**
 * router / 条件边的**白名单迷你表达式**求值 —— Plaza Flow Spec 1.0 跨实现契约。
 *
 * 为什么手写而不是 eval：expression 来自用户编排，绝不能执行任意代码；且语义必须能被任何语言
 * （TS / Python / Go）逐字节复刻。所以这里定义一套**故意很小**的文法，语义在本文件即真相。
 *
 * 文法（EBNF，优先级从低到高）：
 *   expr    := or
 *   or      := and ( "||" and )*
 *   and     := cmp ( "&&" cmp )*
 *   cmp     := unary ( ("=="|"!="|">="|"<="|">"|"<") unary )?
 *   unary   := "!" unary | primary
 *   primary := number | string | "true" | "false" | "null" | path | "(" expr ")"
 *   path    := ident ( "." ident | "[" (string|number) "]" )*
 *   string  := '...' | "..."      number := 整数/小数（可负）      ident := [A-Za-z_][A-Za-z0-9_]*
 *
 * 求值语义（跨语言须一致）：
 *   - path 从 ctx（state 快照）逐层取值；任一层缺失 → undefined。
 *   - == / != ：两边都是 number 按数值比较；否则按「字符串化后」相等比较（undefined/null 视作空串前先判 null 相等）。
 *   - > >= < <= ：两边都能解析成 number 按数值比较；否则按字符串字典序比较。
 *   - ! 与 && / ||：truthy 判定 = 值不属于 {undefined, null, false, 0, "", NaN}。
 *   - router 用 evalExpr 的**原始返回值**去匹配出边 branches 的 key（会 String() 化后比较）；
 *     条件边用 asBool(evalExpr(...)) 取布尔。
 */

export type ExprValue = string | number | boolean | null | undefined;

// ── 词法 ──
type Tok = { t: 'num' | 'str' | 'ident' | 'op' | 'paren'; v: string };

const OPS = ['==', '!=', '>=', '<=', '&&', '||', '>', '<', '!', '.', '[', ']'];

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '(' || c === ')') { toks.push({ t: 'paren', v: c }); i++; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1; let s = '';
      while (j < n && src[j] !== c) { s += src[j]; j++; }
      if (j >= n) throw new Error('未闭合的字符串');
      toks.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    // 数字（含负号：仅当处于表达式起始或前一个是运算符/括号时才当负号，否则当减法——本文法不支持减法，简单处理为负号）
    if (/[0-9]/.test(c) || (c === '-' && /[0-9.]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      toks.push({ t: 'num', v: src.slice(i, j) }); i = j; continue;
    }
    // 多字符运算符优先
    const two = src.slice(i, i + 2);
    if (OPS.includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if (OPS.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'ident', v: src.slice(i, j) }); i = j; continue;
    }
    throw new Error(`非法字符: ${c}`);
  }
  return toks;
}

// ── truthy / 比较（跨语言语义单一真相）──
export const asBool = (v: ExprValue): boolean =>
  !(v === undefined || v === null || v === false || v === 0 || v === '' || (typeof v === 'number' && Number.isNaN(v)));

const numify = (v: ExprValue): number | null => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
};

const eq = (a: ExprValue, b: ExprValue): boolean => {
  const na = numify(a); const nb = numify(b);
  if (na !== null && nb !== null) return na === nb;
  return String(a ?? '') === String(b ?? '');
};

const cmp = (op: string, a: ExprValue, b: ExprValue): boolean => {
  const na = numify(a); const nb = numify(b);
  const useNum = na !== null && nb !== null;
  const x: number | string = useNum ? na! : String(a ?? '');
  const y: number | string = useNum ? nb! : String(b ?? '');
  switch (op) {
    case '>': return x > y;
    case '>=': return x >= y;
    case '<': return x < y;
    case '<=': return x <= y;
    default: return false;
  }
};

// ── 递归下降解析 + 即时求值 ──
class Parser {
  private p = 0;
  constructor(private toks: Tok[], private ctx: Record<string, unknown>) {}
  private peek(): Tok | undefined { return this.toks[this.p]; }
  private next(): Tok | undefined { return this.toks[this.p++]; }
  private eatOp(v: string): boolean { const t = this.peek(); if (t && t.t === 'op' && t.v === v) { this.p++; return true; } return false; }

  parse(): ExprValue {
    const v = this.or();
    if (this.p < this.toks.length) throw new Error('表达式有多余的记号');
    return v;
  }
  private or(): ExprValue {
    let left = this.and();
    while (this.eatOp('||')) { const right = this.and(); left = asBool(left) || asBool(right); }
    return left;
  }
  private and(): ExprValue {
    let left = this.cmp();
    while (this.eatOp('&&')) { const right = this.cmp(); left = asBool(left) && asBool(right); }
    return left;
  }
  private cmp(): ExprValue {
    const left = this.unary();
    const t = this.peek();
    if (t && t.t === 'op' && ['==', '!=', '>=', '<=', '>', '<'].includes(t.v)) {
      this.p++;
      const right = this.unary();
      if (t.v === '==') return eq(left, right);
      if (t.v === '!=') return !eq(left, right);
      return cmp(t.v, left, right);
    }
    return left;
  }
  private unary(): ExprValue {
    if (this.eatOp('!')) return !asBool(this.unary());
    return this.primary();
  }
  private primary(): ExprValue {
    const t = this.next();
    if (!t) throw new Error('表达式意外结束');
    if (t.t === 'paren' && t.v === '(') { const v = this.or(); const close = this.next(); if (!close || close.v !== ')') throw new Error('缺少 )'); return v; }
    if (t.t === 'num') return Number(t.v);
    if (t.t === 'str') return t.v;
    if (t.t === 'ident') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      return this.path(t.v);
    }
    throw new Error(`非法记号: ${t.v}`);
  }
  // 从 ctx 逐层取值：a.b、a["c"]、a[0]
  private path(first: string): ExprValue {
    let cur: unknown = this.ctx[first];
    for (;;) {
      if (this.eatOp('.')) {
        const id = this.next();
        if (!id || id.t !== 'ident') throw new Error('. 后需要字段名');
        cur = cur == null ? undefined : (cur as Record<string, unknown>)[id.v];
      } else if (this.eatOp('[')) {
        const key = this.next();
        if (!key || (key.t !== 'str' && key.t !== 'num')) throw new Error('[] 里需要字符串或数字');
        if (!this.eatOp(']')) throw new Error('缺少 ]');
        cur = cur == null ? undefined : (cur as Record<string, unknown>)[key.v];
      } else break;
    }
    return cur as ExprValue;
  }
}

/**
 * 对 state 快照求值一个表达式。空表达式返回 undefined。解析/求值出错抛 Error（调用方决定按 halt/continue 处理）。
 */
export function evalExpr(expression: string, ctx: Record<string, unknown>): ExprValue {
  const src = String(expression ?? '').trim();
  if (!src) return undefined;
  return new Parser(lex(src), ctx || {}).parse();
}
