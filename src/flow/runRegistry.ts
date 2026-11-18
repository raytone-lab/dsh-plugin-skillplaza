/**
 * 流程运行状态注册表 —— 画布面板的数据源(host 侧)。
 *
 * 数据流:plaza_flow_run 工具启动运行时登记 trace(全 pending)→ 订阅 cordis 的
 * workflow/agent-start|agent-end 事件(载荷带 phase 标题)→ phase 与我们生成的节点一一对应
 * (codegen 时 phase 标题 = 节点 label)→ 更新状态 → 面板经 /plaza-flows/api/runs 轮询渲染。
 */

export interface RunNodeState { nodeId: string; label: string; kind: string; status: 'pending' | 'running' | 'done' | 'error' | 'waiting'; x?: number; y?: number; sub?: string }
export interface FlowRunState {
  runId: string;
  flow: string;
  slug: string;
  startedAt: number;
  status: 'running' | 'done' | 'error';
  error?: string;
  nodes: RunNodeState[];
  edges: RunEdge[];
}

const runs = new Map<string, FlowRunState>();
const byFlow = new Map<string, string>();   // meta.name → runId(同一流程并发跑取最新)

export interface RunEdge { source: string; target: string }

export const registerRun = (runId: string, slug: string, flow: string, metaName: string, nodes: RunNodeState[], edges: RunEdge[] = []): void => {
  runs.set(runId, { runId, flow, slug, startedAt: Date.now(), status: 'running', nodes, edges });
  byFlow.set(metaName, runId);
};

export const markNode = (metaName: string, phaseTitle: string, status: RunNodeState['status']): void => {
  const runId = byFlow.get(metaName);
  const run = runId ? runs.get(runId) : undefined;
  if (!run) return;
  const node = run.nodes.find((n) => n.label === phaseTitle);
  if (node) node.status = status;
};

export const settleRun = (metaName: string, status: 'done' | 'error', error?: string): void => {
  const runId = byFlow.get(metaName);
  const run = runId ? runs.get(runId) : undefined;
  if (!run) return;
  run.status = status;
  if (error) run.error = error;
  // 收尾:还挂 running 的节点按终态补齐(done 全绿,error 当前停住)
  for (const n of run.nodes) if (n.status === 'running') n.status = status === 'done' ? 'done' : 'error';
};

export const listRuns = (): FlowRunState[] =>
  [...runs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 10);

/** 面板轮询接口的响应(JSON 安全拷贝)。 */
export const runsSnapshot = () => listRuns().map((r) => ({ ...r, nodes: r.nodes.map((n) => ({ ...n })), edges: r.edges.map((e) => ({ ...e })) }));

// 进程内保留最近 50 次运行,防内存膨胀
setInterval(() => { if (runs.size > 50) { const oldest = [...runs.values()].sort((a, b) => a.startedAt - b.startedAt)[0]; if (oldest) { byFlow.forEach((v, k) => { if (v === oldest.runId) byFlow.delete(k); }); runs.delete(oldest.runId); } } }, 60_000).unref?.();
