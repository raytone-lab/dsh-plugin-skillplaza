/**
 * 试运行可视化的「状态推导」—— 纯函数,不依赖任何画布库。
 *
 * 为什么单独一个文件:后端 SSE 只发**节点级**事件(node_start / node_done),
 * 没有边事件。所以「哪条边正在交接」只能在前端从节点状态推出来。
 * 这段推导(尤其并行/路由/循环的处理)是真正有价值的部分,渲染层则是会换的 ——
 * 画布若从 React Flow 换到 matra-canvas-x,本文件可原样复用:
 * React Flow 侧喂给自定义 edge 组件,matra 侧喂给 viewer.setEdgeTemplate()。
 * 因此这里刻意不 import 任何 UI/画布类型。
 */

/** 节点运行态。取值与 PlaygroundChat 的 canvasStatus() 输出一致。 */
export type NodeRunStatus = 'running' | 'done' | 'error';

/** 边运行态。active = 正在交接(上游产出正被下游消费),这一态才上动效。 */
export type EdgeRunState = 'idle' | 'active' | 'done' | 'blocked';

/** 整次试运行的阶段。用来给没有后端事件的 start / end 合成状态。 */
export type RunPhase = 'idle' | 'running' | 'finished';

interface NodeLite { id: string; type?: string }
interface EdgeLite { id: string; source: string; target: string }

/**
 * 从节点状态集合推出整次运行处于哪个阶段。
 * 这样就不必让 PlaygroundChat 额外回调一次「跑完了」—— 少一处跨组件管线。
 */
export const derivePhase = (statuses: (NodeRunStatus | undefined)[]): RunPhase => {
  const on = statuses.filter(Boolean);
  if (!on.length) return 'idle';
  return on.includes('running') ? 'running' : 'finished';
};

/**
 * 推导每条边的运行态。
 *
 * 核心决策:把「交接中」绑到**目标节点的 running 期**,而不是严格的
 * node_done(A) → node_start(B) 间隙。因为那个间隙真实只有几十毫秒,
 * 动画会闪一下就没,等于白做;而目标节点跑一轮 LLM 通常数秒,窗口够长够显眼,
 * 语义也成立 —— 读作「A 的产出正在被 B 消费」。
 *
 * 判断顺序以**目标节点**为先 —— 目标跑过,就证明这条边确实被走过了:
 *   tgt 跑中              → active   ← 上动效
 *   tgt 已有结果          → done
 *   tgt 从未开始 + src 出错 → blocked(这条路不会走了)
 *   tgt 从未开始 + 其他     → idle
 *
 * ⚠️ 顺序不能反。流程 Settings 里 `onError: continue` 时,上游节点出错**下游照跑**;
 * 若先判 src 出错就 blocked,会把一条明明走过的边画成"不会走"(实测踩过)。
 *
 * 「tgt 从未开始 → idle」也是刻意的:路由只会走中一个分支,未被选中那条边的目标
 * 永远不会开始。这里若乐观地标成 active,就会**给一条根本没走的分支画流动动画** ——
 * 宁可少显示,不可显示错的(n8n 的画布可视化恰恰在并行/分支上不可靠)。
 *
 * 并行:一个 src 连多个正在跑的 tgt → 多条边同时 active,规则天然支持。
 * 循环:环体节点重新 running 时,回边自然再次变 active,不需要特殊处理。
 */
export const deriveEdgeStates = (
  nodes: NodeLite[],
  edges: EdgeLite[],
  status: Record<string, NodeRunStatus | undefined>,
  phase: RunPhase,
): Record<string, EdgeRunState> => {
  const typeOf = new Map(nodes.map((n) => [n.id, n.type]));
  // start 是控制节点,后端不发它的事件 → 一旦开跑就视为已完成,
  // 否则第一条边永远不会亮。
  const effective = (id: string): NodeRunStatus | undefined => {
    if (typeOf.get(id) === 'start') return phase === 'idle' ? undefined : 'done';
    return status[id];
  };

  const out: Record<string, EdgeRunState> = {};
  for (const e of edges) {
    const s = effective(e.source);
    // 指向 End 的边:End 同样没有后端事件,而且**无法区分"跑完到达"与"中途中止"**
    // → 一律以源节点为准。只有源确实完成才标 done,绝不宣称一条没走过的边走过了。
    // (早期版本按"整次 phase=finished 就算 End 完成",流程中途失败时会把末条边
    //  错标成 done —— 实测踩过。)
    if (typeOf.get(e.target) === 'end') {
      out[e.id] = s === 'done' ? 'done' : s === 'error' ? 'blocked' : 'idle';
      continue;
    }
    const t = effective(e.target);
    if (t === 'running') out[e.id] = 'active';
    else if (t === 'done' || t === 'error') out[e.id] = 'done';
    else if (s === 'error') out[e.id] = 'blocked';
    else out[e.id] = 'idle';
  }
  return out;
};

/** 视口该对准哪个节点(第一个 running)。没有则 null。 */
export const activeNodeId = (
  nodes: NodeLite[],
  status: Record<string, NodeRunStatus | undefined>,
): string | null => nodes.find((n) => status[n.id] === 'running')?.id ?? null;
