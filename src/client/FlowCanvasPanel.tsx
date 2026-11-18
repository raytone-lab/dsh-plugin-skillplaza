/**
 * 「流程运行」面板 —— skillplaza 设计器同款画布的运行视图(唯一面板)。
 *
 * 视觉与交互全面移植 apps/web/src/directory/WorkflowDesignPage.tsx:
 * 同一套 Forge 卡片(左色条+图标+标题+chip)、22px 命中区端口、贝塞尔边 +
 * ArrowClosed 箭头(跑中深金放大/已流过金色/未走灰色)、运行光环与流动虚线、
 * 未轮到节点压暗、视口跟随当前节点(用户手动拖画布后停跟)。
 * 差异只在语义:这里是**运行视图**——节点来自 runRegistry(带原设计坐标),
 * 可拖动/缩放/平移/选中,但不连线、不删除、不回写。
 *
 * 数据:插件自带服务 http://127.0.0.1:18799/api/runs(2s 轮询)。
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap,
  BaseEdge, EdgeLabelRenderer, getBezierPath, MarkerType,
  Handle, Position, useNodesState,
  type Node, type Edge, type NodeProps, type EdgeProps, type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './tw-panel.css';
import { Bot, UserCheck, GitBranch, Split, Repeat, Play, Square, Check, X, ChevronDown, ChevronUp, Copy, ListTree, RefreshCw } from 'lucide-react';

/* ── 数据结构(对齐 runRegistry.runsSnapshot) ── */
type RunNodeStatus = 'pending' | 'running' | 'done' | 'error' | 'waiting';
interface RunNodeDatum {
  label: string; kind: string; status?: RunNodeStatus; sub?: string; runDim?: boolean;
  [k: string]: unknown;
}
interface FlowRun {
  runId: string; flow: string; slug: string; startedAt: number;
  status: 'running' | 'done' | 'error'; error?: string;
  nodes: { nodeId: string; label: string; sub?: string; kind: string; status: RunNodeStatus; x?: number; y?: number }[];
  edges: { source: string; target: string }[];
}

/* ── 与 WorkflowDesignPage 同源的视觉常量 ── */
const TYPE_META: Record<string, { color: string; chip: string; icon: any }> = {
  expert: { color: '#C99A3E', chip: '专家', icon: Bot },
  router: { color: '#d97706', chip: '路由', icon: GitBranch },
  parallel: { color: '#2563eb', chip: '并行', icon: Split },
  loop: { color: '#7c3aed', chip: '循环', icon: Repeat },
  human: { color: '#0d9488', chip: '人工', icon: UserCheck },
};
const NODE_W = 240;
const GOLD = '#F8BD61';
const GOLD_DARK = '#C6871F';
const RUN_RING: Record<string, string> = {
  running: 'flow-run-breathe',
  done: 'shadow-[0_0_0_2px_#34d399]',
  error: 'shadow-[0_0_0_2px_#f87171]',
  waiting: 'flow-wait-breathe',
};
// 边运行态 → 描边 class(语义 token,对齐 plaza 的 EDGE_RUN_CLS)
const EDGE_RUN_CLS: Record<string, string | undefined> = {
  active: 'stroke-gold-dark',
  done: 'stroke-gold',
  blocked: 'stroke-ink/20',
  idle: undefined,
};
const EDGE_MARKER = { type: MarkerType.ArrowClosed, width: 20, height: 20, color: '#94a3b8' } as const;
const EDGE_MARKER_ACTIVE = { type: MarkerType.ArrowClosed, width: 26, height: 26, color: GOLD_DARK } as const;
const EDGE_MARKER_DONE = { type: MarkerType.ArrowClosed, width: 20, height: 20, color: GOLD } as const;

/* ── Forge 风格端口:22px 透明命中区 + 11px 可见圆点(白边上色,悬停放大) ── */
const PORT_HIT = '!h-[22px] !w-[22px] !min-h-0 !min-w-0 !rounded-full !border-0 !bg-transparent';
const PORT_DOT = 'pointer-events-none absolute left-1/2 top-1/2 h-[11px] w-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-sm transition-transform duration-150';
const SourcePort = ({ pos = Position.Right, color = '#C99A3E' }: { pos?: Position; color?: string }) => (
  <Handle type="source" position={pos} isConnectable={false} className={`group/pt ${PORT_HIT}`}>
    <span className={`${PORT_DOT} group-hover/pt:scale-[1.35]`} style={{ background: color }} />
  </Handle>
);
const TargetPort = ({ pos = Position.Left, color = '#94a3b8' }: { pos?: Position; color?: string }) => (
  <Handle type="target" position={pos} isConnectable={false} className={`group/pt ${PORT_HIT}`}>
    <span className={`${PORT_DOT} group-hover/pt:scale-[1.35]`} style={{ background: color }} />
  </Handle>
);

/** 专家/人工/控制节点卡片:结构对齐 WorkflowDesignPage 的 Card(运行态徽章替换删除钮)。 */
function PlazaNode({ data, selected }: NodeProps) {
  const d = data as RunNodeDatum;
  const meta = TYPE_META[d.kind] ?? TYPE_META.expert;
  const Ic = meta.icon;
  const color = meta.color;
  const ring = (d.status && RUN_RING[d.status]) ?? (selected ? 'shadow-[0_0_0_2px_#C99A3E]' : '');
  // 专家节点不重复挂「专家」chip(金条+机器人图标已说明身份),控制节点保留 —— 对齐广场
  const showChip = d.kind !== 'expert';
  return (
    <div style={{ width: NODE_W }} className={`group/node relative rounded-2xl border border-ink/12 bg-white shadow-card transition-all ${ring} ${d.runDim ? 'opacity-50' : ''}`}>
      <span className="absolute inset-y-0 left-0 z-10 w-1 rounded-l-2xl" style={{ background: color }} />
      <TargetPort color={color} />
      <div className={`flex items-center gap-1.5 rounded-t-2xl bg-ink/[0.025] py-2 pl-3.5 pr-1.5 ${d.sub ? 'border-b border-ink/8' : 'rounded-b-2xl'}`}>
        <Ic size={15} style={{ color }} className="shrink-0" />
        <span title={d.label} className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{d.label}</span>
        {showChip && <span className="shrink-0 rounded bg-ink/[0.06] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-ink/40">{meta.chip}</span>}
        {d.status === 'done' && <span title="已完成" className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-emerald-500 text-white"><Check size={11} strokeWidth={3.2} /></span>}
        {d.status === 'error' && <span title="出错" className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-red-500 text-white"><X size={11} strokeWidth={3.2} /></span>}
        {d.status === 'waiting' && <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold text-amber-700">待审批</span>}
      </div>
      {d.sub && <div className="truncate rounded-b-2xl px-3.5 py-2 font-mono text-[11px] leading-tight text-ink/55">{d.sub}</div>}
      <SourcePort color={color} />
    </div>
  );
}
function StartCap(_props: NodeProps) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/50 bg-emerald-500/10 px-5 py-2.5 text-sm font-semibold text-emerald-700">
      <Play size={13} className="fill-emerald-600 text-emerald-600" />开始
      <SourcePort color="#10b981" />
    </div>
  );
}
function EndCap(_props: NodeProps) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-ink/20 bg-ink/[0.04] px-5 py-2.5 text-sm font-semibold text-ink/70">
      <TargetPort color="#64748b" />
      <Square size={12} className="fill-ink/50 text-ink/50" />结束
    </div>
  );
}
const nodeTypes = { plaza: PlazaNode, start: StartCap, end: EndCap };

type EdgeRunState = 'idle' | 'active' | 'done' | 'blocked';

/** 边:贝塞尔 + 箭头(markerEnd 由 flowEdges 按运行态注入)+ 条件/交接标签。对齐 CondEdge。 */
function RunEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, label, data, selected }: EdgeProps) {
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const run = (data as any)?.runState as EdgeRunState | undefined;
  const runCls = run ? EDGE_RUN_CLS[run] : undefined;
  const active = run === 'active';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={`${runCls ?? ''} ${active ? 'flow-edge-march' : ''}`.trim() || undefined}
        style={{
          strokeWidth: active ? 3 : 2,
          ...(runCls ? {} : { stroke: selected ? '#C99A3E' : '#94a3b8' }),
          ...(run === 'blocked' ? { strokeDasharray: '5 4' } : {}),
        }}
      />
      <EdgeLabelRenderer>
        <div style={{ transform: `translate(-50%,-50%) translate(${lx}px,${ly}px)` }} className="nodrag nopan absolute flex items-center gap-1">
          {label != null && String(label) !== '' && <span className="rounded bg-[#FCDCA0] px-1.5 py-0.5 text-[10px] font-medium text-ink/80 shadow-sm">{String(label)}</span>}
          {active && <span className="rounded bg-[#FCDCA0] px-1.5 py-0.5 text-[10px] font-medium text-ink/80 shadow-sm">{(data as any)?.waiting ? '等你拍板' : '交接中'}</span>}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
const edgeTypes = { run: RunEdge };

/* ── 「我的流程」清单(/api/flows)── */
interface FlowCatalogItem {
  id: string; slug: string; name: string;
  description?: string; official?: boolean; flowType?: string; ownerName?: string;
  graph?: { nodes: { id: string; label: string; kind: string; x?: number; y?: number }[]; edges: { source: string; target: string }[] };
}

/** 单条流程卡:名称 + slug + 「复制跑法」;点开懒拉 graph 画只读缩略图。 */
function FlowCatalogCard({ flow, onCopied }: { flow: FlowCatalogItem; onCopied: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const [graph, setGraph] = useState<FlowCatalogItem['graph'] | undefined>(flow.graph);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !graph && !loading) {
      setLoading(true);
      try {
        const r = await fetch(`http://127.0.0.1:18799/api/flows?slug=${encodeURIComponent(flow.slug)}`);
        const j = await r.json();
        if (j.graph) setGraph(j.graph);
      } catch { /* 缩略图拉不到就保持文字态,不阻塞 */ } finally { setLoading(false); }
    }
  };
  const copyRun = async () => {
    const text = `跑「${flow.name}」流程,输入如下:\n<在这里写你的需求/材料>`;
    try {
      await navigator.clipboard.writeText(`跑「${flow.name}」流程`);
      onCopied(`已复制:去对话区粘贴发送即跑(${flow.slug})`);
    } catch {
      onCopied(`在对话区说「跑 ${flow.name}」即可(slug:${flow.slug})`);
    }
  };

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-ink/10 bg-white shadow-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" onClick={toggle} className="grid h-5 w-5 shrink-0 place-items-center rounded text-ink/40 hover:bg-ink/5">
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink" title={flow.name}>{flow.name}</span>
        {flow.official && <span className="shrink-0 rounded bg-gold/15 px-1.5 py-0.5 text-[9px] font-bold text-gold-dark">官方</span>}
        {flow.flowType && <span className="shrink-0 font-mono text-[10px] text-ink/35">{flow.flowType}</span>}
        <button type="button" onClick={copyRun} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-ink/12 px-2 py-1 text-[11px] text-ink/65 hover:border-gold hover:bg-gold/5">
          <Copy size={11} />复制跑法
        </button>
      </div>
      <div className="border-t border-ink/6 px-3 py-1.5 font-mono text-[10px] text-ink/40">{flow.slug}{flow.description ? ` · ${flow.description.slice(0, 60)}` : ''}</div>
      {open && (
        <div className="border-t border-ink/6 bg-[#FDFAF2]">
          {graph ? (
            <FlowMiniCanvas graph={graph} />
          ) : (
            <div className="px-3 py-4 text-center text-[11px] text-ink/40">{loading ? '正在拉取流程图…' : '流程图拉取失败(令牌或网络问题)'}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** 只读缩略画布:复用同一套节点/边组件,status 全空(静止的设计态视图)。 */
function FlowMiniCanvas({ graph }: { graph: NonNullable<FlowCatalogItem['graph']> }) {
  const nodes: Node[] = useMemo(() => graph.nodes
    .filter((n) => typeof n.x === 'number' && typeof n.y === 'number')
    .map((n) => ({
      id: n.id,
      type: n.kind === 'start' || n.kind === 'end' ? n.kind : 'plaza',
      position: { x: n.x as number, y: n.y as number },
      data: { label: n.label, kind: n.kind, status: undefined } as RunNodeDatum,
      connectable: false, draggable: false, selectable: false,
    })), [graph]);
  const edges: Edge[] = useMemo(() => graph.edges.map((e, i) => ({
    id: `c${i}`, source: e.source, target: e.target, type: 'run', data: { runState: undefined },
  })), [graph]);
  return (
    <div style={{ height: 220 }}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
        fitView fitViewOptions={{ padding: 0.15, minZoom: 0.3, maxZoom: 1 }} proOptions={{ hideAttribution: true }}
        minZoom={0.2} maxZoom={1.2}
      >
        <Background gap={18} size={1} color="#e2ddd0" />
      </ReactFlow>
    </div>
  );
}

/** 「我的流程」抽屉:顶部工具行 + 流程卡列表。 */
function FlowCatalogDrawer() {
  const [flows, setFlows] = useState<FlowCatalogItem[] | null>(null);
  const [err, setErr] = useState('');
  const [kw, setKw] = useState('');
  const [toast, setToast] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force = false) => {
    setRefreshing(true);
    try {
      const r = await fetch(`http://127.0.0.1:18799/api/flows${force ? '?refresh=1' : ''}`);
      const j = await r.json();
      setFlows(j.flows ?? []);
      setErr(j.error ?? '');
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setRefreshing(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2500); return () => clearTimeout(t); }, [toast]);

  const shown = useMemo(() => {
    if (!flows) return [];
    const k = kw.trim().toLowerCase();
    if (!k) return flows;
    return flows.filter((f) => [f.name, f.slug, f.description].filter(Boolean).some((x) => String(x).toLowerCase().includes(k)));
  }, [flows, kw]);

  return (
    <div className="mb-4 rounded-2xl border border-ink/10 bg-cream shadow-card">
      <div className="flex items-center gap-2 border-b border-ink/8 bg-white px-3.5 py-2.5">
        <ListTree size={15} className="shrink-0 text-gold-dark" />
        <span className="text-sm font-bold text-ink">我的流程</span>
        <span className="text-[11px] text-ink/40">{flows ? `${shown.length}/${flows.length} 可跑` : '加载中…'}</span>
        <div className="flex-1" />
        <input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜索流程…" className="w-28 rounded-md border border-ink/15 bg-white px-2 py-1 text-[11px] outline-none focus:border-gold" />
        <button type="button" onClick={() => void load(true)} disabled={refreshing} title="从广场重新拉取清单" className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink/45 hover:bg-ink/5 disabled:opacity-40">
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
        </button>
        {toast && <span className="shrink-0 rounded bg-gold/15 px-2 py-0.5 text-[10px] text-gold-dark">{toast}</span>}
      </div>
      <div className="max-h-[46vh] overflow-y-auto p-2.5">
        {err && <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">流程清单拉取失败({err})。检查广场令牌配置(/plaza-login)。</div>}
        {!err && flows === null && <div className="py-6 text-center text-[13px] text-ink/35">正在拉取流程清单…</div>}
        {flows !== null && !shown.length && !err && <div className="py-6 text-center text-[13px] text-ink/35">没有可跑的流程——去广场「工作流」页新建或发布一个,然后点右上刷新。</div>}
        {shown.map((f) => <FlowCatalogCard key={f.slug} flow={f} onCopied={setToast} />)}
      </div>
    </div>
  );
}

/** 单次运行卡片:标题栏 + React Flow 画布(拖动/缩放/平移全开,不连线不编辑)。 */
function RunFlow({ run, now }: { run: FlowRun; now: number }) {
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const fittedRef = useRef<string>('');          // 已为哪个 run 做过首次 fitView
  const followRef = useRef(true);                // 视口跟随当前节点;用户手动拖画布后停跟

  const statusOf = useCallback((nid: string) => run.nodes.find((n) => n.nodeId === nid)?.status, [run]);
  const kindOf = useCallback((nid: string) => run.nodes.find((n) => n.nodeId === nid)?.kind, [run]);

  // start 是骨架没有后端事件:一旦开跑视为 done,否则第一条边永远不亮(对齐 flowRunState.effective)
  const effective = useCallback((nid: string): RunNodeStatus | undefined =>
    kindOf(nid) === 'start' ? 'done' : statusOf(nid), [kindOf, statusOf]);

  const runActive = run.status === 'running';
  // 受控节点状态:必须用 useNodesState + onNodesChange,否则节点拖拽的 position 变更
  // 没人应用 = 拖不动(2026-11-17 实测坑)。runDataNodes 只是"数据驱动的目标形态"。
  const runDataNodes: Node[] = useMemo(() => run.nodes
    .filter((n) => typeof n.x === 'number' && typeof n.y === 'number')
    .map((n) => ({
      id: n.nodeId,
      type: n.kind === 'start' || n.kind === 'end' ? n.kind : 'plaza',
      position: { x: n.x as number, y: n.y as number },
      // 跑中把还没轮到的节点压暗(start/end 是骨架不压)——对齐广场 runDim
      data: { label: n.label, kind: n.kind, status: n.status, sub: n.sub, runDim: runActive && n.status === 'pending' && n.kind !== 'start' && n.kind !== 'end' } as RunNodeDatum,
      connectable: false,
    })), [run, runActive]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  // 数据同步进来时:状态/文案用新的,位置保留用户拖过的(不回弹)
  useEffect(() => {
    setNodes((cur) => {
      const posById = new Map(cur.map((n) => [n.id, n.position]));
      return runDataNodes.map((n) => posById.has(n.id) ? { ...n, position: posById.get(n.id)! } : n);
    });
  }, [runDataNodes, setNodes]);

  const edges: Edge[] = useMemo(() => run.edges.map((e, i) => {
    const s = effective(e.source);
    const t = effective(e.target);
    let runState: EdgeRunState;
    if (kindOf(e.target) === 'end') {
      // 指向 End:无法区分"跑完到达"与"中途中止",一律以源节点为准(对齐 flowRunState 的教训)
      runState = s === 'done' ? 'done' : s === 'error' ? 'blocked' : 'idle';
    } else if (t === 'running' || t === 'waiting') runState = 'active'; // waiting=流程活着停在闸门,入边保持流动
    else if (t === 'done' || t === 'error') runState = 'done';
    else if (s === 'error') runState = 'blocked';
    else runState = 'idle';
    return {
      id: `e${i}`, source: e.source, target: e.target, type: 'run',
      markerEnd: runState === 'active' ? EDGE_MARKER_ACTIVE : runState === 'done' ? EDGE_MARKER_DONE : EDGE_MARKER,
      data: { runState, waiting: t === 'waiting' },
    };
  }), [run, effective, kindOf]);

  // 节点晚于画布挂载到达 → fitView prop 只在初始化跑,必须补一次(否则图在视口外/缩成芝麻)。
  // minZoom 地板:串行长图 fit 全宽会被压成细带,宁可放大看不清全图 + 跟随当前节点。
  useEffect(() => {
    if (!nodes.length || fittedRef.current === run.runId) return;
    fittedRef.current = run.runId;
    const t = setTimeout(() => rfRef.current?.fitView({ padding: 0.15, minZoom: 0.55, maxZoom: 1, duration: 300 }), 60);
    return () => clearTimeout(t);
  }, [run.runId, nodes.length]);

  // 视口跟随正在跑的节点(手动拖过画布就停跟;新一次运行恢复)
  useEffect(() => { if (run.status === 'running') followRef.current = true; }, [run.runId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 视口跟随:只在**当前节点换人**时触发一次(deps 只有 activeId)——
  // 别挂 nodes:轮询每 2s 换新数组会让 setCenter 不停地跑,画布永远在滑动,用户拖不动也对不齐。
  const nodesRef = useRef(nodes);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  const activeId = run.nodes.find((n) => n.status === 'running' || n.status === 'waiting')?.nodeId ?? null;
  useEffect(() => {
    if (!activeId || !followRef.current) return;
    const inst = rfRef.current;
    const n = nodesRef.current.find((x) => x.id === activeId);
    if (!inst || !n) return;
    // 跟随当前节点时保证可读倍率(刚 fitView 完可能只有 0.55)
    inst.setCenter(n.position.x + NODE_W / 2, n.position.y + 48, { duration: 400, zoom: Math.max(inst.getZoom(), 0.75) });
  }, [activeId]);

  const sec = Math.max(1, Math.round((now - run.startedAt) / 1000));
  const mm = Math.floor(sec / 60), ss = sec % 60;
  const elapsed = mm ? `${mm}分${ss}秒` : `${ss}s`;
  const waitingApproval = run.status === 'running' && run.nodes.some((n) => n.status === 'waiting');

  return (
    <div className="mb-4 overflow-hidden rounded-2xl border border-ink/10 bg-cream shadow-card">
      <div className="flex items-center gap-2 border-b border-ink/8 bg-white px-3.5 py-2.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${waitingApproval ? 'animate-pulse bg-amber-500' : run.status === 'running' ? 'animate-pulse bg-gold-dark' : run.status === 'done' ? 'bg-emerald-500' : 'bg-red-500'}`} />
        <span className="min-w-0 flex-1 truncate text-sm font-bold text-ink">{run.flow}</span>
        <span className={`shrink-0 text-[11px] ${run.status === 'error' ? 'text-red-600' : run.status === 'done' ? 'text-emerald-600' : waitingApproval ? 'font-semibold text-amber-600' : 'text-ink/50'}`}>
          {waitingApproval ? `等待审批 · ${elapsed}` : run.status === 'running' ? `运行中 · ${elapsed}` : run.status === 'done' ? '已完成' : `失败:${run.error ?? ''}`}
        </span>
      </div>
      <div style={{ height: '62vh', minHeight: 380 }} className="rounded-b-2xl bg-white/40">
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onInit={(inst) => { rfRef.current = inst; }}
          onMoveStart={(e) => { if (e) followRef.current = false; }}
          nodesConnectable={false}
          deleteKeyCode={null}
          fitView fitViewOptions={{ padding: 0.15, minZoom: 0.55, maxZoom: 1 }} proOptions={{ hideAttribution: true }}
          minZoom={0.2} maxZoom={1.6}
        >
          <Background gap={18} size={1} color="#e2ddd0" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => TYPE_META[(n.data as any)?.kind]?.color || '#cbd5e1'} maskColor="rgba(15,23,42,0.06)" className="!rounded-lg !border !border-ink/10 !bg-white/85" />
        </ReactFlow>
      </div>
    </div>
  );
}

export function FlowCanvasPanel() {
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [err, setErr] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch('http://127.0.0.1:18799/api/runs');
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (!stop) { setRuns(j.runs ?? []); setErr(''); }
      } catch (e: any) { if (!stop) setErr(String(e?.message ?? e)); }
    };
    void tick();
    const id = setInterval(tick, 2000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { stop = true; clearInterval(id); clearInterval(clock); };
  }, []);
  // 同一流程反复跑只留最新一张卡(runs 已按开始时间倒序;不同流程各留一张)
  const latestRuns = useMemo(() => {
    const seen = new Set<string>();
    return runs.filter((r) => (seen.has(r.slug) ? false : (seen.add(r.slug), true)));
  }, [runs]);
  const [openCatalog, setOpenCatalog] = useState(false);
  return (
    <div className="h-full overflow-y-auto bg-cream p-4" style={{ fontFamily: 'system-ui' }}>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-base font-bold text-ink">Skill 广场 · 流程运行</h2>
        <div className="flex-1" />
        <button type="button" onClick={() => setOpenCatalog((o) => !o)} className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${openCatalog ? 'border-gold bg-gold/10 text-gold-dark' : 'border-ink/12 bg-white text-ink/70 hover:border-gold hover:bg-gold/5'}`}>
          <ListTree size={13} />我的流程
        </button>
      </div>
      {openCatalog && <FlowCatalogDrawer />}
      <p className="mb-3 text-xs text-ink/50">节点随执行点亮;深金流动=交接中;绿环=完成;琥珀呼吸=等你拍板。画布可拖动节点、拖空白平移、滚轮缩放。</p>
      {err && <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">面板取数失败({err})。插件数据服务可能未启动——重启 DSH 或先跑一次流程。</div>}
      {latestRuns.length === 0 && !err && <div className="py-10 text-center text-[13px] text-ink/35">还没有运行记录。在对话里说「跑 XX 流程」即可在这里看到实时进度。</div>}
      {latestRuns.map((r) => <RunFlow key={r.runId} run={r} now={now} />)}
    </div>
  );
}
