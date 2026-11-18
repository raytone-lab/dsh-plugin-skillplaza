/**
 * Skill 广场 API 客户端 —— 插件内唯一的广场通信点。
 *
 * 鉴权:Bearer 个人访问令牌(plaza_pt_*);未配令牌时 plaza 端返回 401,客户端抛 PlazaAuthError
 * 引导用户去设置页生成。只读端点为主:目录/详情/下载链接;写操作(跑试跑)在后续版本。
 *
 * 端点(与 apps/server 现状对齐):
 *  GET /api/skills/list?industry=    → 目录(含 visibility 过滤,服务端按令牌身份判定)
 *  GET /api/skills/detail?slug=      → 详情(名称/描述/是否加密 locked)
 *  GET /api/skills/download?slug=    → { download_url, filename }(locked 未解锁 → 403)
 *  下载文件本体:GET <base>/<download_url>(相对路径拼接)
 */

export interface PlazaConfig {
  /** 如 https://test.iruidong.com/plaza(不带尾斜杠)。 */
  base: string;
  /** plaza_pt_* 个人访问令牌。 */
  token: string;
}

export class PlazaAuthError extends Error {
  constructor() {
    super('未配置访问令牌或令牌无效。请到广场「我的 → 访问令牌」生成一枚并粘贴到本插件设置。');
    this.name = 'PlazaAuthError';
  }
}

export interface SkillSummary {
  slug: string; name: string; nameEn?: string | null; description?: string; descriptionEn?: string | null;
  industry?: string; kind?: string; locked?: boolean; updatedAt?: string;
}
export interface SkillDetail extends SkillSummary { bodyMd?: string; }
export interface DownloadRef { download_url: string; filename: string; }
export interface FlowRef { id: string; slug: string; name: string; }
export interface FlowListItem extends FlowRef { description?: string; official?: boolean; flowType?: string; ownerName?: string; }
export interface FlowDetail extends FlowRef { graph: { nodes: any[]; edges: any[] }; }
export interface PackDetail { personaMd: string; personaMdEn?: string | null; members: { slug: string; name?: string; kind?: string }[]; }
export interface KbHit { title?: string; snippet?: string; source?: string; score?: number }

export class PlazaClient {
  constructor(private cfg: PlazaConfig) {}

  private get authed() { return !!this.cfg.token; }

  private async req<T>(path: string): Promise<T> {
    if (!this.authed) throw new PlazaAuthError();
    const url = `${this.cfg.base.replace(/\/$/, '')}${path}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${this.cfg.token}` } });
    if (r.status === 401) throw new PlazaAuthError();
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as any;
      throw new Error(j.message || j.error || `广场 ${path} → HTTP ${r.status}`);
    }
    return r.json() as Promise<T>;
  }

  /** 目录(可选行业过滤)。 */
  listSkills(industry?: string): Promise<SkillSummary[]> {
    const q = industry ? `?industry=${encodeURIComponent(industry)}` : '';
    return this.req<SkillSummary[]>(`/api/skills/list${q}`);
  }

  /** 关键词过滤(客户端侧;目录是全量,本地 filter 足够快)。 */
  async search(keyword: string): Promise<SkillSummary[]> {
    const all = await this.listSkills();
    if (!keyword.trim()) return all;
    const kw = keyword.trim().toLowerCase();
    return all.filter((s) =>
      [s.name, s.nameEn, s.description, s.descriptionEn, s.slug]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(kw)),
    );
  }

  detail(slug: string): Promise<SkillDetail> {
    return this.req<SkillDetail>(`/api/skills/detail?slug=${encodeURIComponent(slug)}`);
  }

  /** 拿下载链接;locked 未解锁抛错(广场 403)。 */
  async downloadRef(slug: string): Promise<DownloadRef> {
    return this.req<DownloadRef>(`/api/skills/download?slug=${encodeURIComponent(slug)}`);
  }

  /** 流程(场景)列表:你账号可见的(自己的 + 广场公开发布的)。 */
  async listFlows(): Promise<FlowListItem[]> {
    const list = await this.req<any>('/api/me/scenarios/plaza');
    const items = Array.isArray(list) ? list : (list as any)?.items ?? [];
    return items.map((x: any) => ({
      id: String(x.id), slug: String(x.slug ?? x.id), name: String(x.name ?? x.slug ?? x.id),
      description: x.description ?? x.triggerKeywords ?? undefined,
      official: !!x.official, flowType: x.flowType, ownerName: x.ownerName ?? undefined,
    }));
  }

  /** 流程(场景)按 slug 查:内部 /api/scenarios 系(个人令牌),先 plaza 列表定位 id,再取详情 graph。 */
  async getFlowBySlug(slug: string): Promise<FlowDetail> {
    const list = await this.req<any>('/api/me/scenarios/plaza');
    const hit = (Array.isArray(list) ? list : (list as any)?.items ?? []).find((x: any) => x.slug === slug || x.id === slug);
    if (!hit) throw new Error(`流程「${slug}」不存在或你无权访问(去广场「工作流」页确认 slug)。`);
    const d = await this.req<any>(`/api/me/scenarios/${hit.id}`);
    const detail = { id: d.id, slug: d.slug ?? slug, name: d.name ?? slug, graph: d.graph ?? { nodes: [], edges: [] } };
    this.flowGraphCache.set(String(detail.slug), { nodes: detail.graph.nodes ?? [], edges: detail.graph.edges ?? [] });
    return detail;
  }

  /** 流程图缓存(面板画缩略图用):getFlowBySlug 拉详情时顺手存;未跑过的流程按需懒拉。 */
  private flowGraphCache = new Map<string, { nodes: any[]; edges: any[] }>();
  async getFlowGraph(slug: string): Promise<{ nodes: any[]; edges: any[] }> {
    const hit = this.flowGraphCache.get(slug);
    if (hit) return hit;
    const d = await this.getFlowBySlug(slug);
    return { nodes: d.graph.nodes ?? [], edges: d.graph.edges ?? [] };
  }

  /** 专家(pack)详情:人设 + 成员(判断挂没挂知识库)。 */
  getPackDetail(slug: string): Promise<PackDetail> {
    return this.req<PackDetail>(`/api/packs/detail?slug=${encodeURIComponent(slug)}`);
  }

  /** 知识库检索(内部 /api/knowledge/test,viewer 权限;密钥不出网)。 */
  async kbSearch(kbSlug: string, query: string, limit = 6): Promise<KbHit[]> {
    const r = await this.req<any>(`/api/me/knowledge/test?slug=${encodeURIComponent(kbSlug)}&q=${encodeURIComponent(query)}&limit=${limit}`);
    const hits = r?.hits ?? r?.results ?? r?.items ?? [];
    return (Array.isArray(hits) ? hits : []).map((h: any) => ({ title: h.title, snippet: h.snippet ?? h.context, source: h.source, score: h.score }));
  }

  /** 拉技能包字节(zip)。统一走 commercial-zip 端点:它对免费包直出、加密包判授权、UGC 存储 key 内部解析
   *  (UGC 的 download_url 存的是存储 key 不是 HTTP 路径,裸拼会 404——2026-11-08 服务端已统一,见 skills.ts)。
   *  知识库/数据源等非技能包类型不支持(没有可装包)。 */
  async fetchZip(slug: string): Promise<{ buf: ArrayBuffer; filename: string }> {
    const detail = await this.detail(slug);
    const kind = String(detail.kind ?? 'Skill');
    if (kind !== 'Skill') throw new Error(`「${detail.name || slug}」是${kind === 'Knowledge' ? '知识库' : kind},不是可安装的技能包。技能包才有 zip。`);
    if (!this.authed) throw new PlazaAuthError();
    const url = `${this.cfg.base.replace(/\/$/, '')}/api/skills/commercial-zip?slug=${encodeURIComponent(slug)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${this.cfg.token}` } });
    if (r.status === 401) throw new PlazaAuthError();
    if (r.status === 403) throw new Error('locked: 该技能未解锁,请到广场详情页解锁后再安装。');
    if (r.status === 404) throw new Error('该技能没有文件包(纯正文型技能,内容在详情正文里,无需安装包)。');
    if (!r.ok) throw new Error(`下载技能包 → HTTP ${r.status}`);
    return { buf: await r.arrayBuffer(), filename: `${slug}.zip` };
  }
}
