/** 浏览器侧插件入口:注册侧栏图标 + 主面板(流程画布)。
 *  模式对齐官方 dsh-superagent 的 src/client/index.tsx(slots 注入 main + sidebar.panellist)。 */
import React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import { FlowCanvasPanel } from './FlowCanvasPanel.js';

const PANEL_ID = 'plaza-flows';

function PlazaIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
      <rect x="3" y="8" width="5" height="8" rx="1.5" />
      <rect x="16" y="8" width="5" height="8" rx="1.5" />
      <path d="M8 12h8" />
      <path d="M13.5 9.5 16.5 12l-3 2.5" />
    </svg>
  );
}

export const inject = ['slots'];

export function apply(ctx: Context): void {
  const c = ctx as any;
  c.slots?.inject?.('main', () => c.slots.register({ name: 'main', key: PANEL_ID }, () => <FlowCanvasPanel />));
  c.slots?.inject?.('sidebar.panellist', () => c.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => '流程运行' }, PlazaIcon));
}

export default { name: 'dsh-plugin-skillplaza/client', inject, apply };
