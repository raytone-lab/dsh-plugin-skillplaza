/**
 * Skill 广场(DSH 插件)入口 —— 按 cordis 真实插件模式装配。
 *
 * 模式依据(2026-11-12 核源,harness packages/core/tools + interaction/commands + 官方 dsh-superagent):
 *  - 具名导出 name / inject / Config / apply(ctx, config);inject 声明服务依赖,就绪才启动
 *  - 工具走 ctx.tools.register(defineTool({...})):defineTool 做参数校验,output.render 出模型可见内容,
 *    timeoutMs 是协作式超时(exec.signal 可中止)
 *  - 斜杠命令走 ctx.commands.register({name, description, input, handler}),handler 不经过模型,
 *    直接给 UI 返回 { kind: 'success'|'error', text }
 *  - 安装=解压到 ~/.dsh/skills/<name>/(skills.zh.md rank=400 user-dsh 根,Chokidar 自动发现)
 *
 * 令牌从 Config 读(设置页可改);未配令牌时工具/命令返回引导文案而非报错。
 */
import type { Context } from '@deepseek-ai/cordis';
import s from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-commands';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import { PlazaClient, PlazaAuthError, type SkillSummary } from './plaza-client.js';
import { chainOf, type ExpertData } from './flow/codegen.js';
import { compileGraph } from './vendor/adapter.js';
import { startFlowRun, type FlowRunHandle } from './flow/flowRunner.js';
import { startPanelServer } from './flow/panelServer.js';
import { FlowCatalog } from './flow/flowCatalog.js';
import { registerRun, markNode, settleRun, runsSnapshot } from './flow/runRegistry.js';
import { installZipToSkills, defaultSkillsRoot } from './installer.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件包内的 skills/ 目录(dist 编译产物在 dist/,skills 与之同级)。 */
const BUNDLED_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

/** 注册插件随包技能:读 skills/<name>/SKILL.md,剥 frontmatter 取 name/description,
 *  正文作 content 注册为运行时技能(ctx.skills.register,见 skills.zh.md SkillRegistration)。
 *  让用户打 /plaza-skills 时按技能载入并引导模型调用我们的工具(打字路径)。 */
const registerBundledSkills = (ctx: Context): void => {
  if (!existsSync(BUNDLED_SKILLS_DIR)) return;
  for (const dirName of readdirSync(BUNDLED_SKILLS_DIR)) {
    const mdPath = join(BUNDLED_SKILLS_DIR, dirName, 'SKILL.md');
    if (!existsSync(mdPath)) continue;
    const raw = readFileSync(mdPath, 'utf8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    const meta = fm?.[1] ?? '';
    const content = fm ? raw.slice(fm[0].length) : raw;
    const skillName = meta.match(/^name:\s*(\S+)\s*$/m)?.[1] ?? dirName;
    const description = meta.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
    (ctx as any).skills?.register?.({
      name: skillName,
      description,
      content,
      resourceBase: { kind: 'directory', path: join(BUNDLED_SKILLS_DIR, dirName) },
      provider: 'dsh-plugin-skillplaza',
    });
  }
};

export const name = 'dsh-plugin-skillplaza';
export const inject = ['tools', 'commands', 'skills', 'llm'];
// inject 是 cordis 的访问许可(未声明的服务 ctx.get() 会抛「cannot get property without inject」)。
// 2026-11-14 架构转向:DSH 桌面 profile 不向插件提供 workflowEngine/webServer(实测 off),
// 流程执行与面板取数全部自带引擎/自带服务,inject 只留硬依赖 + llm(直连模型)。

export const Config = s.object({
  plazaBase: s.string().default('https://iruidong.com/plaza')
    .description('Skill 广场地址(测试环境 https://test.iruidong.com/plaza;生产换成 https://iruidong.com/plaza)。'),
  plazaToken: s.string().default('').role('secret').volatile()
    .description('广场访问令牌(plaza_pt_*):广场「我的 → 访问令牌」生成,仅存本机。'),
  flowProvider: s.string().default('iruidong').volatile()
    .description('流程专家节点使用的模型提供方(ctx.llm 的 provider route)。与你 DSH 当前模型选择一致即可。'),
  flowModel: s.string().default('glm-5.3').volatile()
    .description('流程专家节点使用的模型 id。'),
});
export type PluginConfig = ReturnType<typeof Config>;

const GUIDE_NO_TOKEN = '还没绑定广场账号:广场「我的 → 访问令牌」生成一枚 plaza_pt_* 令牌,粘贴到本插件设置的 plazaToken 即可。';

/** 渲染技能清单(命令/工具共用的纯文本)。 */
export const renderSkillList = (items: SkillSummary[]): string => {
  if (!items.length) return '广场上没有匹配的技能。试试换个关键词。';
  const lines = items.slice(0, 15).map((x, i) => {
    const n = x.name || x.nameEn || x.slug;
    const d = (x.description || x.descriptionEn || '').split('\n')[0].slice(0, 60);
    return `${i + 1}. **${n}** (\`${x.slug}\`)${x.locked ? ' 🔒' : ''}\n   ${d}`;
  });
  return [`找到 ${items.length} 个技能(显示前 ${Math.min(15, items.length)} 个):`, '', ...lines, '', '安装:`/plaza-install <slug>`。🔒=需先在广场解锁。'].join('\n');
};

const text = (t: string) => [{ type: 'text' as const, text: t }];
/** 工具的 canonical value 走宽松 JSON 形状(defineTool 的类型要求 Record<string,JsonValue>,
 *  我们的领域接口没有 index signature——值本身就是纯 JSON,cast 安全)。 */
const jv = <T>(v: T): any => v as unknown as Record<string, unknown>;
const errText = (e: unknown): string => (e instanceof PlazaAuthError ? GUIDE_NO_TOKEN : (e as Error).message);

/** 两个工具(独立构造函数,可单测)。 */
export const buildSearchTool = (client: PlazaClient) => defineTool({
  name: 'plaza_skills_search',
  description: '在 Skill 广场搜索技能(名称/描述/行业)。返回技能清单含 slug,供 plaza_skill_install 安装。',
  parameters: {
    keyword: { type: 'string', description: '搜索关键词(中/英),空=列全部' },
    industry: { type: 'string', description: '行业代码过滤(可选)' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value: any) => text(value.ok ? renderSkillList(value.items) : `搜索失败:${value.error}`),
  },
  timeoutMs: 30_000,
  isConcurrencySafe: () => true,   // 纯读,无副作用
  execute: async (args) => {
    try {
      const items = args.industry
        ? await client.listSkills(String(args.industry))
        : await client.search(String(args.keyword ?? ''));
      return jv({ ok: true, items: items.slice(0, 15), count: items.length });
    } catch (e) { return jv({ ok: false, error: errText(e) }); }
  },
});

export const buildInstallTool = (client: PlazaClient, skillsRoot: string) => defineTool({
  name: 'plaza_skill_install',
  description: '把广场上指定 slug 的技能包下载并安装到本地技能库(覆盖同名旧版)。加密未解锁的会拒绝并提示去广场解锁;知识库类没有包,会提示不可安装。',
  parameters: {
    slug: { type: 'string', required: true, description: '技能 slug(plaza_skills_search 结果里的 slug)' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value: any) => text(
      value.ok
        ? `✅ 已安装 **${value.name}** 到本地技能库(${value.dir},${value.files} 个文件)。在对话里描述它的用途即可触发。`
        : value.error,
    ),
  },
  timeoutMs: 60_000,
  execute: async ({ slug }) => {
    try {
      const { buf } = await client.fetchZip(slug);
      const r = installZipToSkills(new Uint8Array(buf), skillsRoot);
      return jv({ ok: true, ...r });
    } catch (e) { return jv({ ok: false, error: errText(e) }); }
  },
});

/** 知识库检索工具:expert agent 在流程里用它查挂载的知识库(密钥不出 plaza)。 */
export const buildKbSearchTool = (client: PlazaClient) => defineTool({
  name: 'plaza_kb_search',
  description: '检索 Skill 广场知识库(指定库 slug)。返回最相关的片段(标题/正文/来源)。凡涉及某专家领域的问题,先调用本工具取得库内实据再作答。',
  parameters: {
    kb: { type: 'string', required: true, description: '知识库 slug,如 ev-charging-maintenance-kb' },
    query: { type: 'string', required: true, description: '检索问题(自然语言)' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value: any) => text(
      value.ok
        ? (value.hits.length ? value.hits.map((h: any, i: number) => `${i + 1}. ${h.title ?? '(无标题)'}\n${(h.snippet ?? '').slice(0, 500)}`).join('\n\n') : '(未检索到相关片段)')
        : `检索失败:${value.error}`,
    ),
  },
  timeoutMs: 30_000,
  isConcurrencySafe: () => true,
  execute: async ({ kb, query }) => {
    try { return jv({ ok: true, hits: await client.kbSearch(String(kb), String(query)) }); }
    catch (e) { return jv({ ok: false, error: errText(e) }); }
  },
});

/** 活跃流程运行句柄(暂停的闸门等 resume)。 */
const activeRuns = new Map<string, FlowRunHandle>();

/** IR 里按节点 id 查 label(vendored runner 的 nodes 带 label;原图 nodes 不带)。 */
const nodeLabelOf = (ir: any, id: string): string => {
  const n = ir?.nodes?.[id];
  return String(n?.label ?? n?.config?.label ?? '');
};

/** 流程运行工具:拉流程 → vendored plaza runner 直连执行(自带引擎,不依赖 workflowEngine)→ 返回最终产物;
 *  命中人工闸门返回 paused 提示,模型请用户审批后调 plaza_flow_resume 续跑。 */
export const buildFlowRunTool = (client: PlazaClient, llm: () => any, route: () => { provider: string; model: string }) => defineTool({
  name: 'plaza_flow_run',
  description: '运行 Skill 广场发布的流程场景(编排的多专家工作流)。拉取流程定义后在 DSH 原生工作流引擎里确定性执行:每个专家节点以该专家人设运行,挂载知识库的专家会先检索再作答;含人工闸门的流程会停下来请你审批。返回最终产物与逐节点轨迹。',
  parameters: {
    slug: { type: 'string', required: true, description: '流程 slug(广场「工作流」页的标识,如 flow-ev-charging-repair)' },
    input: { type: 'string', required: true, description: '流程的起始输入(用户需求/工单/材料文本)' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value: any) => text(
      value.ok
        ? `✅ 流程「${value.flow}」运行完成。\n\n===== 最终产物 =====\n${value.final}\n\n===== 节点轨迹 =====\n${(value.trace ?? []).map((t: any) => `- ${t.node}:${t.ok === false ? '失败' : '完成'}${t.verdict ? `(${t.verdict})` : ''}`).join('\n')}`
        : `流程运行失败:${value.error}${value.trace?.length ? '\n已完成节点:' + value.trace.map((t: any) => t.node).join('、') : ''}`,
    ),
  },
  timeoutMs: 1_800_000,   // 流程可达数十分钟(多专家+人工闸门);协作式,引擎取消可中止
  execute: async ({ slug, input }, exec) => {
    try {
      const flow = await client.getFlowBySlug(String(slug));
      const chain = chainOf(flow.graph);
      // 装配专家数据:人设 + 知识库成员
      const experts = new Map<string, ExpertData>();
      for (const n of chain) {
        if (n.type !== 'expert') continue;
        const packSlug = String((n.config as any)?.pack_slug ?? (n.config as any)?.packSlug ?? '');
        const e: ExpertData = { nodeId: n.id, label: n.label || n.id, packSlug: packSlug || undefined, persona: '', kbSlugs: [] };
        if (packSlug) {
          try {
            const p = await client.getPackDetail(packSlug);
            e.persona = p.personaMd || '';
            e.kbSlugs = (p.members ?? []).filter((m) => m.kind === 'Knowledge').map((m) => m.slug);
          } catch { /* pack 拉不到就用节点 label 兜底 */ }
        }
        if (!e.persona) e.persona = `你是「${e.label}」,一名业务专家。`;
        experts.set(n.id, e);
      }
      // 编译 IR 并把专家人设/知识库装饰到节点上(vendored runner 的 runExpert 消费)
      const compiled = compileGraph(flow.graph, { id: flow.id, name: flow.name });
      if (!compiled.ok || !compiled.ir) return jv({ ok: false, error: `流程编译失败:${'errors' in compiled && Array.isArray((compiled as any).errors) ? (compiled as any).errors.map((e: any) => e.message ?? e).join(';') : '未知'}` });
      const ir = compiled.ir as any;
      for (const n of Object.values(ir.nodes ?? {}) as any[]) {
        const e = experts.get(n.id);
        if (e) { (n as any).persona = e.persona; (n as any).kbSlugs = e.kbSlugs; }
      }
      // 画布形态:所有节点(start/end 也画,对齐广场设计器)+原坐标;边原样透传
      const nodes: import('./flow/runRegistry.js').RunNodeState[] = (flow.graph.nodes ?? [])
        .map((n: any) => ({ nodeId: n.id, label: n.label || nodeLabelOf(ir, n.id) || n.id, sub: experts.get(n.id)?.packSlug, kind: String(n.type ?? 'expert'), status: 'pending' as const, x: n.position?.x, y: n.position?.y }));
      const edges = (flow.graph.edges ?? []).map((e: any) => ({ source: e.source, target: e.target }));
      const handle = startFlowRun({ client, llm: llm(), route: route(), ir, slug: flow.slug, flowName: flow.name, nodes, edges, input: String(input) });
      activeRuns.set(handle.runId, handle);
      const out = await handle.settle;
      if (out.error && out.error.includes('暂停,等待审批')) {
        return jv({ ok: true, flow: flow.name, paused: true, runId: handle.runId,
          note: out.error + ' 请使用 ask_user_question 询问用户审批结论(通过/驳回+意见),然后调用 plaza_flow_resume(runId, decision, comment) 续跑。' });
      }
      if (!out.ok) return jv({ ok: false, error: out.error ?? '流程运行失败' });
      activeRuns.delete(handle.runId);
      return jv({ ok: true, flow: flow.name, final: out.final ?? '' });
    } catch (e) { return jv({ ok: false, error: errText(e) }); }
  },
});

/** 审批续跑工具:人工闸门暂停后,带审批结论恢复流程。 */
export const buildFlowResumeTool = (getRun: (runId: string) => FlowRunHandle | undefined) => defineTool({
  name: 'plaza_flow_resume',
  description: '恢复一个暂停在人工审批闸门的流程运行。先通过 ask_user_question 获得用户审批结论,再调用本工具:approved=继续执行后续节点;rejected=带意见回炉上游重做(≤2轮)。',
  parameters: {
    runId: { type: 'string', required: true, description: 'plaza_flow_run 返回的 runId' },
    decision: { type: 'string', required: true, description: 'approved 或 rejected' },
    comment: { type: 'string', description: '审批意见(驳回时必填,会注入重做节点)' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value: any) => text(value.ok ? `流程已${value.paused ? '再次暂停于人工闸门' : '完成'}。${value.final ? '\n\n===== 最终产物 =====\n' + value.final : ''}` : `续跑失败:${value.error}`),
  },
  timeoutMs: 1_800_000,
  execute: async ({ runId, decision, comment }) => {
    const handle = getRun(String(runId));
    if (!handle) return jv({ ok: false, error: `runId「${runId}」没有等待审批的运行(可能已结束或 id 错误)` });
    const dec = String(decision) === 'approved' ? 'approved' : 'rejected';
    const out = await handle.resume(dec as 'approved' | 'rejected', String(comment ?? ''));
    if (out.error && out.error.includes('暂停,等待审批')) return jv({ ok: true, paused: true, note: out.error });
    if (!out.ok) return jv({ ok: false, error: out.error ?? '续跑失败' });
    return jv({ ok: true, final: out.final ?? '' });
  },
});

/** 斜杠命令(不经过模型,直接给 UI 文本)。 */
export const buildCommands = (client: PlazaClient, skillsRoot: string): CommandDefinition[] => [
  {
    name: 'plaza-skills',
    description: '搜索广场技能',
    input: { hint: '关键词(可空,例:/plaza-skills 充电桩)' },
    handler: async ({ rawInput }) => {
      try {
        const items = await client.search(rawInput.trim());
        return { kind: 'success' as const, text: renderSkillList(items) };
      } catch (e) { return { kind: 'error' as const, text: errText(e) }; }
    },
  },
  {
    name: 'plaza-install',
    description: '安装广场技能到本地技能库',
    input: { hint: '<slug>,如 /plaza-install pdf-table-extract' },
    handler: async ({ rawInput }) => {
      const slug = rawInput.trim().split(/\s+/)[0] ?? '';
      if (!slug) return { kind: 'error' as const, text: '用法:/plaza-install <slug>(slug 从 /plaza-skills 结果复制)' };
      try {
        const detail = await client.detail(slug);
        const { buf } = await client.fetchZip(slug);
        const r = installZipToSkills(new Uint8Array(buf), skillsRoot);
        return { kind: 'success' as const, text: `✅ **${detail.name || r.name}** 已装进本地技能库(${r.dir})。` };
      } catch (e) { return { kind: 'error' as const, text: errText(e) }; }
    },
  },
  {
    name: 'plaza-login',
    description: '查看广场账号绑定状态与指引',
    handler: async () => ({ kind: 'success' as const, text: GUIDE_NO_TOKEN }),
  },
  {
    name: 'plaza-flows',
    description: '列出你账号可运行的广场流程',
    input: { hint: '关键词(可空,例:/plaza-flows 充电桩)' },
    handler: async ({ rawInput }) => {
      try {
        const flows = await client.listFlows();
        const kw = rawInput.trim().toLowerCase();
        const hit = kw ? flows.filter((f) => [f.name, f.slug, f.description].filter(Boolean).some((x) => String(x).toLowerCase().includes(kw))) : flows;
        if (!hit.length) return { kind: 'success' as const, text: kw ? `没有匹配「${rawInput.trim()}」的流程。` : '还没有可用的流程——去广场「工作流」页新建或发布一个。' };
        const lines = hit.map((f) => `- **${f.name}** \`${f.slug}\`${f.official ? '(官方)' : ''}${f.flowType ? ` · ${f.flowType}` : ''}`);
        return {
          kind: 'success' as const,
          text: [`你账号可运行的流程共 ${hit.length} 个:`, '', ...lines, '', '运行:直接说「跑 <流程名>」,或让助手调用 plaza_flow_run(slug, 输入)。'].join('\n'),
        };
      } catch (e) { return { kind: 'error' as const, text: errText(e) }; }
    },
  },
];

export function apply(ctx: Context, config: PluginConfig): void {
  // plazaToken 是 volatile(改配置不重启即生效)→ 值是 Volatile<string> 包装,读时 .get()。
  const token = typeof (config.plazaToken as any)?.get === 'function' ? (config.plazaToken as any).get() : (config.plazaToken as unknown as string);
  const client = new PlazaClient({ base: config.plazaBase, token: String(token ?? '') });
  const skillsRoot = defaultSkillsRoot();
  ctx.tools.register(buildSearchTool(client));
  ctx.tools.register(buildInstallTool(client, skillsRoot));
  ctx.tools.register(buildKbSearchTool(client));
  const llmOf = () => (ctx as any).llm?.stream?.bind((ctx as any).llm) ?? (ctx as any).llm;
  const routeOf = () => ({ provider: String(config.flowProvider ?? 'iruidong'), model: String(config.flowModel ?? 'glm-5.3') });
  ctx.tools.register(buildFlowRunTool(client, llmOf, routeOf));
  ctx.tools.register(buildFlowResumeTool((runId) => activeRuns.get(runId)));
  for (const c of buildCommands(client, skillsRoot)) ctx.commands.register(c);
  registerBundledSkills(ctx);
  ctx.logger.info(`dsh-plugin-skillplaza 装配完成:tools=4,commands=4,skills=2,webServer=${(ctx as any).get?.('webServer') ? 'on' : 'off'},workflowEngine=${(ctx as any).get?.('workflowEngine') ? 'on' : 'off'}`);

  // 面板数据服务(自带 loopback HTTP,不依赖 DSH webServer 服务——桌面 profile 不提供)
  const catalog = new FlowCatalog(client);
  void startPanelServer(catalog, ctx.logger).then((s) => { if (s.port) ctx.effect(() => async () => { await s.close(); }); });

  if (!token) ctx.logger.info('dsh-plugin-skillplaza: 未配置 plazaToken,首次使用将引导用户绑定广场账号');
}

export default { name, inject, Config, apply };
