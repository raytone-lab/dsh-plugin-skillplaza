/**
 * 面板流程清单服务 —— 在 panelServer 的 /api/flows 端点背后,负责:
 *  - 拉取并缓存你账号可见的流程列表(plaza /api/me/scenarios/plaza)
 *  - 为面板缩略图提供每个流程的图摘要(节点 id/label/kind/坐标 + 边),按需懒拉详情
 *
 * 独立模块而非塞进 panelServer:列表刷新(60s)与图摘要懒拉(首次请求时)是两种
 * 生命周期,panelServer 只管 HTTP 壳。
 */
import type { PlazaClient, FlowListItem } from '../plaza-client.js';

export interface FlowGraphSummary {
  nodes: { id: string; label: string; kind: string; x?: number; y?: number }[];
  edges: { source: string; target: string }[];
}
export interface FlowCatalogItem extends FlowListItem {
  graph?: FlowGraphSummary;
}

const LIST_TTL_MS = 60_000;

export class FlowCatalog {
  private list: FlowCatalogItem[] | null = null;
  private listAt = 0;
  private graphLoading = new Map<string, Promise<FlowGraphSummary | undefined>>();

  constructor(private client: PlazaClient) {}

  /** 列表(带 TTL 缓存);force 绕过缓存立即刷新。 */
  async listFlows(force = false): Promise<FlowCatalogItem[]> {
    if (!force && this.list && Date.now() - this.listAt < LIST_TTL_MS) return this.list;
    try {
      this.list = await this.client.listFlows();
      this.listAt = Date.now();
    } catch (e) {
      // 拉取失败(如令牌未配):有旧缓存就返回旧的,否则把错误抛给端点层转给面板
      if (!this.list) throw e;
    }
    return this.list;
  }

  /** 图摘要:详情懒拉一次后缓存(slug → graph)。列表项上惰性补充。 */
  async graphOf(slug: string): Promise<FlowGraphSummary | undefined> {
    const item = this.list?.find((f) => f.slug === slug);
    if (item?.graph) return item.graph;
    let p = this.graphLoading.get(slug);
    if (!p) {
      p = (async () => {
        try {
          const g = await this.client.getFlowGraph(slug);
          const graph: FlowGraphSummary = {
            nodes: (g.nodes ?? []).map((n: any) => ({
              id: String(n.id), label: String(n.label ?? n.id), kind: String(n.type ?? 'expert'),
              x: n.position?.x, y: n.position?.y,
            })),
            edges: (g.edges ?? []).map((e: any) => ({ source: String(e.source), target: String(e.target) })),
          };
          if (item) item.graph = graph;
          return graph;
        } catch { return undefined; }
        finally { this.graphLoading.delete(slug); }
      })();
      this.graphLoading.set(slug, p);
    }
    return p;
  }
}
