/**
 * 专家执行器(桌面 fallback 引擎) —— 不依赖 ctx.workflowEngine 的直连 LLM 实现。
 *
 * 为什么存在(2026-11-14):DSH 桌面 profile 不给插件提供 workflowEngine/webServer
 * (装配日志实测 off),流程执行改为自带引擎:vendored plaza runner + 本执行器。
 *
 * 语义对齐 plaza 服务端 classic runExpert(scenarios.ts):
 *  - persona 作系统提示;有知识库的专家走 tool-calling 循环(≤6 轮/≤12 次调用)
 *  - knowledge-search → 插件 plaza client 的 kbSearch(HTTP 到 plaza,密钥不出网)
 *  - 工具结果截断回喂;预算尽收口不死循环
 *  - 事件与 runner 的 RunEvent 对齐(tool_call/tool_result/node_delta)——面板直接消费
 *
 * 模型路由:经 ctx.llm.stream(provider/model 来自插件 Config,默认 iruidong/glm-5.3,
 * 与用户桌面选择一致);网关网关行为差异(工具语法续吐)由 plaza 侧已有的干净上下文策略兜底。
 */

export interface LlmStreamFn {
  (options: {
    provider: string; model: string;
    messages: { role: string; content: string }[];
    tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
    maxTokens?: number; signal?: AbortSignal;
  }): AsyncIterable<{ type: string; text?: string; index?: number; id?: string; name?: string; argumentsDelta?: string }>;
}

export interface ExpertToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, string>) => Promise<{ ok: boolean; text: string }>;
}

export interface ExpertRunInput {
  persona: string;
  name: string;
  input: string;
  tools: ExpertToolDef[];
  emit?: (ev: { kind: string; nodeId?: string; tool?: string; args?: string; ok?: boolean; preview?: string; ms?: number; delta?: string }) => void;
  nodeId: string;
  maxToolCalls?: number;
  maxRounds?: number;
}

interface PendingCall { id: string; name: string; argsText: string }

const TOOL_LEAK = /DSML|tool_calls|<｜/u;

/** 收集一轮流式响应:正文 + 工具调用(tool-call-delta 按 index/id 聚合 arguments)。 */
const collectTurn = async (
  stream: AsyncIterable<any>,
  onText: (delta: string) => void,
): Promise<{ text: string; calls: PendingCall[]; finishReason: string }> => {
  let text = '';
  const calls = new Map<string, PendingCall>();
  let finishReason = 'stop';
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta' && chunk.text) { text += chunk.text; onText(chunk.text); }
    else if (chunk.type === 'tool-call-delta') {
      const key = String(chunk.id ?? chunk.index ?? 0);
      const cur = calls.get(key) ?? { id: String(chunk.id ?? `call_${calls.size}`), name: chunk.name ?? '', argsText: '' };
      if (chunk.name) cur.name = chunk.name;
      cur.argsText += chunk.argumentsDelta ?? '';
      calls.set(key, cur);
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'toolCall') {
      // 终块兜底:若 delta 没收到完整参数,以 block 为准
      const b = chunk.block as any;
      if (b.id && b.name && !calls.has(String(b.id))) calls.set(String(b.id), { id: String(b.id), name: String(b.name), argsText: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {}) });
    } else if (chunk.type === 'finish') finishReason = String(chunk.reason ?? finishReason);
    else if (chunk.type === 'error') throw new Error(`llm stream error: ${chunk.error?.message ?? chunk.error ?? 'unknown'}`);
  }
  return { text: text.trim(), calls: [...calls.values()], finishReason };
};

export const runExpertViaLlm = async (
  llm: LlmStreamFn,
  route: { provider: string; model: string },
  inp: ExpertRunInput,
): Promise<string> => {
  const budget = inp.maxToolCalls ?? 12;
  const maxRounds = inp.maxRounds ?? 6;
  let calls = 0;

  const toolSchemas = inp.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  const toolNames = inp.tools.map((t) => t.name).join('、');
  const sys = inp.tools.length
    ? `${inp.persona}\n\n（你在一条自动化业务流程中扮演「${inp.name}」这一步。你可调用工具：${toolNames}。请**先用工具检索/取得真实依据**，再基于结果作答；没有依据不要臆断。输出简洁清晰。）`
    : `${inp.persona}\n\n（你在一条自动化业务流程中扮演「${inp.name}」这一步。基于上游输入完成你的职责,输出简洁结论。）`;

  const messages: { role: string; content: string }[] = [
    { role: 'system', content: sys },
    { role: 'user', content: inp.input },
  ];

  const gathered: string[] = [];
  for (let round = 0; round < maxRounds; round++) {
    const budgetLeft = calls < budget;
    const turn = await collectTurn(
      llm({ ...route, messages, tools: budgetLeft ? toolSchemas : undefined, maxTokens: 1500 }),
      (delta) => inp.emit?.({ kind: 'node_delta', nodeId: inp.nodeId, delta }),
    );

    if (!turn.calls.length) {
      const clean = turn.text;
      if (clean && !TOOL_LEAK.test(clean)) return clean;
      break;   // 泄漏或空 → 跳出走显式成稿
    }
    if (!budgetLeft) break;

    messages.push({ role: 'assistant', content: turn.text || '' });
    for (const c of turn.calls) {
      if (calls >= budget) { messages.push({ role: 'tool', content: `（已达工具调用上限,请基于已有信息作答）` }); continue; }
      calls++;
      const def = inp.tools.find((t) => t.name === c.name);
      let args: Record<string, string> = {};
      try { const p = JSON.parse(c.argsText || '{}'); if (p && typeof p === 'object') for (const [k, v] of Object.entries(p)) args[k] = String(v ?? ''); } catch { /* 空参执行 */ }
      inp.emit?.({ kind: 'tool_call', nodeId: inp.nodeId, tool: c.name, args: c.argsText.slice(0, 300) });
      const t0 = Date.now();
      const res = def ? await def.execute(args) : { ok: false, text: `未知工具 ${c.name}` };
      const ms = Date.now() - t0;
      inp.emit?.({ kind: 'tool_result', nodeId: inp.nodeId, tool: c.name, ok: res.ok, preview: res.text.slice(0, 200), ms });
      messages.push({ role: 'tool', content: `【${c.name}】${res.text.slice(0, 4000)}` });
      gathered.push(`【${c.name}${Object.keys(args).length ? ' ' + JSON.stringify(args) : ''}】\n${res.text.slice(0, 1600)}`);
    }
  }

  // 显式成稿:干净上下文(不带工具调用历史),防模型续吐工具语法(plaza 网关同款对抗)。
  const compose = await collectTurn(
    llm({
      ...route,
      messages: [
        { role: 'system', content: `${inp.persona}\n\n（你正在为「${inp.name}」产出最终答复。下面「已收集数据」是刚通过工具取得的真实依据。请基于它成稿,该标注推断的标注推断。**只输出报告正文本身,不要任何工具调用、不要 JSON**。）` },
        { role: 'user', content: `${inp.input}\n\n===== 已收集数据 =====\n${gathered.join('\n\n').slice(0, 9000) || '(无)'}` },
      ],
      maxTokens: 2000,
    }),
    (delta) => inp.emit?.({ kind: 'node_delta', nodeId: inp.nodeId, delta }),
  );
  return compose.text.replace(/<｜DSML｜[\s\S]*$/u, '').trim() || '（无输出）';
};
