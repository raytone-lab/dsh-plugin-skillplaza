/**
 * 本地渲染脚手架:不依赖 DSH,直接在浏览器里看 FlowCanvasPanel 的真实样子。
 * mock /api/runs 为一次「跑到第 3 个节点」的串行流程(坐标仿广场串行布局)。
 * 构建:scripts/build-harness.mts → test/harness/index.html,任意静态服务器打开。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FlowCanvasPanel } from '../src/client/FlowCanvasPanel.js';

const startedAt = Date.now() - 42_000;
const mk = (nodeId: string, label: string, kind: string, status: string, x: number, y: number, sub?: string) =>
  ({ nodeId, label, kind, status, x, y, ...(sub ? { sub } : {}) });
const RUN = {
  runId: 'harness-1', flow: '充电桩检修工作流（公交能源）', slug: 'ev-charging', startedAt,
  status: 'running',
  nodes: [
    mk('start', '开始', 'start', 'done', 60, 220),
    mk('n1', '充电桩故障定位官', 'expert', 'done', 250, 220, '反问+OCR认柜+查询'),
    mk('n2', '充电桩维修SOP官', 'expert', 'done', 570, 220, 'GB26960 安全前置'),
    mk('n3', '检修工单起草官', 'expert', 'done', 890, 220, '带字段带出处'),
    mk('n4', '人工审批闸门', 'human', 'waiting', 1210, 220, '安全与派单审核'),
    mk('n5', '检修派单通知官', 'expert', 'pending', 1530, 220, '行动导向·该修的人才收到'),
    mk('n6', '检修案例归档官', 'expert', 'pending', 1850, 220, '沉淀回知识库'),
    mk('end', '结束', 'end', 'pending', 2170, 220),
  ],
  edges: [
    { source: 'start', target: 'n1' }, { source: 'n1', target: 'n2' }, { source: 'n2', target: 'n3' },
    { source: 'n3', target: 'n4' }, { source: 'n4', target: 'n5' }, { source: 'n5', target: 'n6' },
    { source: 'n6', target: 'end' },
  ],
};

// 拦掉面板里的轮询 fetch,喂假数据
const origFetch = window.fetch.bind(window);
(window as any).fetch = (input: any, init?: any) => {
  const u = String(input);
  if (u.includes('/api/flows') && u.includes('slug=')) {
    return Promise.resolve(new Response(JSON.stringify({ graph: { nodes: RUN.nodes.map(({ nodeId: id, label, kind, x, y }) => ({ id, label, kind, x, y })), edges: RUN.edges } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  if (u.includes('/api/flows')) {
    const flows = [
      { id: '1', slug: 'flow-ev-charging-repair', name: '充电桩检修工作流(公交能源)', flowType: 'serial', official: false },
      { id: '2', slug: 'flow-loan-review', name: '信贷审查工作流', flowType: 'serial', official: true, description: '资质审核→抵押评估→人工复核' },
      { id: '3', slug: 'flow-invest-research', name: '投研报告流水线', flowType: 'pipeline', official: false },
    ];
    return Promise.resolve(new Response(JSON.stringify({ flows }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  if (u.includes('/api/runs')) {
    // 同一条流程跑过两次(验证面板去重:只显示最新一张卡)
    const older = { ...RUN, runId: 'harness-0', startedAt: startedAt - 15_000 };
    return Promise.resolve(new Response(JSON.stringify({ runs: [RUN, older] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  return origFetch(input, init);
};

createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh', width: '100vw' }}>
    <FlowCanvasPanel />
  </div>,
);
