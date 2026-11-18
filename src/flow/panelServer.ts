/**
 * 面板数据服务 —— 插件自带的 loopback HTTP 服务(不依赖 DSH webServer 服务)。
 *
 * 为什么自带(2026-11-14):DSH 桌面 profile 不给插件提供 webServer(装配日志实测 off),
 * 面板取数改为插件进程内直接起 node:http,面板(webview)跨源拉取,CORS 放开。
 * 端口 18799 被占时递增重试;服务随插件 teardown 关闭。
 */
import { createServer, type Server } from 'node:http';
import { runsSnapshot } from './runRegistry.js';
import type { FlowCatalog } from './flowCatalog.js';

const BASE_PORT = 18799;

export const startPanelServer = async (catalog: FlowCatalog, logger?: { info: (m: string) => void; error?: (m: string) => void }): Promise<{ port: number; close: () => Promise<void> }> => {
  let attempt = 0;
  let lastErr: unknown;
  while (attempt < 5) {
    const port = BASE_PORT + attempt;
    attempt++;
    try {
      const server = await new Promise<Server>((resolve, reject) => {
        const s = createServer((req, res) => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'content-type');
          if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
          const url = new URL(req.url ?? '/', 'http://localhost');
          if (url.pathname === '/api/runs') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ runs: runsSnapshot() }));
            return;
          }
          if (url.pathname === '/api/flows') {
            void (async () => {
              const slug = url.searchParams.get('slug');
              if (slug) {
                const graph = await catalog.graphOf(slug).catch(() => undefined);
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ graph }));
                return;
              }
              try {
                const flows = await catalog.listFlows(url.searchParams.get('refresh') === '1');
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ flows }));
              } catch (e) {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ flows: [], error: String((e as Error).message ?? e) }));
              }
            })();
            return;
          }
          if (url.pathname === '/api/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.writeHead(404); res.end();
        });
        s.once('error', reject);
        s.listen(port, '127.0.0.1', () => resolve(s));
      });
      logger?.info(`dsh-plugin-skillplaza 面板数据服务已启动: http://127.0.0.1:${port}/api/runs`);
      return { port, close: () => new Promise((r) => server.close(() => r())) };
    } catch (e) { lastErr = e; }
  }
  logger?.error?.(`dsh-plugin-skillplaza 面板数据服务启动失败(端口 ${BASE_PORT}-${BASE_PORT + 4} 均被占): ${String(lastErr)}`);
  return { port: 0, close: async () => {} };
};
