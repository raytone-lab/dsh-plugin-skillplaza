// 模拟 host 测试(真实 DSH 类型版):验证 defineTool 工具与 commands 逻辑(mock fetch + 临时技能目录)。
// 用法: node --import tsx test/simulate.test.ts
import { strict as assert } from 'node:assert';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { buildSearchTool, buildInstallTool, buildCommands, renderSkillList, inject, name } from '../src/index.ts';
import { chainOf, buildFlowScript, buildFlowMeta } from '../src/flow/codegen.ts';
import { PlazaClient, PlazaAuthError } from '../src/plaza-client.ts';

let pass = 0; let fail = 0;
const check = (n: string, fn: () => void) => { try { fn(); pass++; console.log('  ✅', n); } catch (e: any) { fail++; console.log('  ❌', n, '-', e.message); } };

const mkFetch = (handlers: any[]) => async (url: any, _opts: any) => {
  const u = String(url);
  for (const h of handlers) if (u.includes(h.match)) return h.reply(u);
  return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
};
const skills = [
  { slug: 'pdf-extract', name: 'PDF 提取', description: '从 PDF 提取表格', locked: false, kind: 'Skill' },
  { slug: 'ev-sop', name: '检修 SOP', description: '充电桩检修标准流程', locked: false, kind: 'Skill' },
  { slug: 'paid-pro', name: '付费分析', description: '加密技能', locked: true, kind: 'Skill' },
  { slug: 'ev-kb', name: '检修知识库', description: '知识库不是包', locked: false, kind: 'Knowledge' },
];
const fakeZip = () => zipSync({
  'SKILL.md': strToU8('---\nname: pdf-extract\ndescription: 从 PDF 提取表格\n---\n# PDF 提取\n用法说明。'),
  'scripts/extract.sh': strToU8('#!/bin/sh\necho ok'),
  '../escape.txt': strToU8('should be dropped'),
});
(globalThis as any).fetch = mkFetch([
  { match: '/api/skills/list', reply: () => ({ ok: true, status: 200, json: async () => skills }) },
  { match: '/api/skills/detail', reply: (u: string) => {
      const slug = new URLSearchParams(u.split('?')[1]).get('slug');
      const s = skills.find((x) => x.slug === slug);
      return s ? { ok: true, status: 200, json: async () => ({ ...s, bodyMd: '# x' }) } : { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
    } },
  { match: '/api/skills/commercial-zip', reply: (u: string) => {
      const slug = new URLSearchParams(u.split('?')[1]).get('slug');
      if (slug === 'paid-pro') return { ok: false, status: 403, json: async () => ({ error: 'locked' }) };
      return { ok: true, status: 200, arrayBuffer: async () => fakeZip().buffer };
    } },
]);

const client = new PlazaClient({ base: 'https://test.iruidong.com/plaza', token: 'plaza_pt_test' });
const skillsRoot = mkdtempSync(join(tmpdir(), 'dsh-skills-'));
const execStub: any = { signal: new AbortController().signal };

const main = async () => {
  console.log('[dsh-plugin-skillplaza] 模拟 host 测试(真实类型版)');
  try {
    const noAuth = new PlazaClient({ base: 'https://x', token: '' });
    await check('未配令牌抛 PlazaAuthError', () => assert.rejects(() => noAuth.listSkills(), PlazaAuthError));

    const search = buildSearchTool(client);
    const r1 = await search.execute({ keyword: 'pdf' } as any, execStub) as any;
    check('搜索命中 pdf-extract', () => assert(r1.ok === true && r1.count === 1));
    const rendered = search.output.render({ keyword: 'pdf' } as any, r1);
    check('render 输出含 slug 反引号', () => assert((rendered[0] as any).text.includes('`pdf-extract`')));
    check('renderSkillList 标注加密', () => assert(renderSkillList(skills).includes('🔒')));

    const install = buildInstallTool(client, skillsRoot);
    const r2 = await install.execute({ slug: 'pdf-extract' } as any, execStub) as any;
    check('免费技能装进临时技能库', () => {
      assert(r2.ok === true && r2.name === 'pdf-extract');
      assert(existsSync(join(skillsRoot, 'pdf-extract', 'SKILL.md')));
    });
    check('zip-slip 条目被丢弃', () => assert(!existsSync(join(skillsRoot, 'escape.txt'))));
    check('剥壳后 scripts/ 保留', () => assert(existsSync(join(skillsRoot, 'pdf-extract', 'scripts', 'extract.sh'))));
    check('SKILL.md 内容完整', () => assert(readFileSync(join(skillsRoot, 'pdf-extract', 'SKILL.md'), 'utf8').includes('name: pdf-extract')));
    const r3 = await install.execute({ slug: 'paid-pro' } as any, execStub) as any;
    check('加密未解锁被拒并提示解锁', () => assert(r3.ok === false && /解锁/.test(r3.error)));
    const r4 = await install.execute({ slug: 'ev-kb' } as any, execStub) as any;
    check('知识库被拦并说明不是包', () => assert(r4.ok === false && /知识库/.test(r4.error)));
    const r5 = await install.execute({ slug: 'no-such' } as any, execStub) as any;
    check('不存在技能友好报错', () => assert(r5.ok === false));
    const r6 = await install.execute({ slug: 'pdf-extract' } as any, execStub) as any;
    check('覆盖安装(更新)幂等', () => assert(r6.ok === true && r6.name === 'pdf-extract'));

    const cmds = buildCommands(client, skillsRoot);
    const cInstall = cmds.find((c) => c.name === 'plaza-install')!;
    const rc = await cInstall.handler({ rawInput: '  ' } as any);
    check('空参给用法(error)', () => assert(rc.kind === 'error' && (rc as any).text.includes('用法')));
    const rc2 = await cmds.find((c) => c.name === 'plaza-skills')!.handler({ rawInput: '检修' } as any);
    check('命令搜检修命中 ev-sop', () => assert(rc2.kind === 'success' && (rc2 as any).text.includes('ev-sop')));
    const rc3 = await cInstall.handler({ rawInput: 'ev-sop' } as any);
    check('命令安装成功文本', () => assert(rc3.kind === 'success' && (rc3 as any).text.includes('已装进本地技能库')));

    // 流程 codegen
    const g = { nodes: [
      { id: 'start', type: 'start' }, { id: 'n1', type: 'expert', label: '定位官' },
      { id: 'h1', type: 'human', label: '人工闸门' }, { id: 'n2', type: 'expert', label: '派单官' }, { id: 'end', type: 'end' },
    ], edges: [ { source: 'start', target: 'n1' }, { source: 'n1', target: 'h1' }, { source: 'h1', target: 'n2' }, { source: 'n2', target: 'end' } ] };
    const chain = chainOf(g as any);
    check('串行链顺序正确(start→end 共5节点)', () => assert.deepEqual(chain.map((n: any) => n.id), ['start', 'n1', 'h1', 'n2', 'end']));
    const experts = new Map<string, any>([
      ['n1', { nodeId: 'n1', label: '定位官', persona: '你是故障定位官。', kbSlugs: ['ev-kb'] }],
      ['n2', { nodeId: 'n2', label: '派单官', persona: '你是派单官。', kbSlugs: [] }],
    ]);
    const script = buildFlowScript('充电桩检修', chain, experts as any, 'input');
    check('脚本含知识库工具指示(ev-kb)', () => assert(script.includes('ev-kb')));
    check('脚本含人工闸门 APPROVED 判定', () => assert(script.includes("startsWith('APPROVED')")));
    check('脚本含驳回重做(≤2轮语义)', () => assert(script.includes('驳回重做') && script.includes('round >= 2')));
    check('脚本两专家顺序执行(n1 在 n2 前)', () => assert(script.indexOf('定位官') < script.indexOf('派单官')));
    check('脚本 return 携带 final+trace', () => assert(script.includes('return { ok: true, flow:') && script.includes('trace }')));
    const meta = buildFlowMeta('flow-ev', '充电桩检修', chain);
    check('meta phases 与可执行节点对齐(3个)', () => assert((meta.phases as any[]).length === 3));
    // 不支持的图明确报错
    let threw = '';
    try { chainOf({ nodes: [{ id: 'r', type: 'router' }], edges: [] } as any); } catch (e: any) { threw = e.message; }
    check('router 节点明确报错不静默降级', () => assert(threw.includes('暂不支持')));
    let threw2 = '';
    try { chainOf({ nodes: [{ id: 'start', type: 'start' }, { id: 'a', type: 'expert' }], edges: [{ source: 'start', target: 'a' }, { source: 'start', target: 'a2' }] } as any); } catch (e: any) { threw2 = e.message; }
    check('多出边明确报非串行', () => assert(threw2.includes('多条出边')));

    check('inject 声明 tools/commands/skills/llm', () => assert.deepEqual(inject, ['tools', 'commands', 'skills', 'llm']));
    check('插件名 dsh-plugin-skillplaza', () => assert(name === 'dsh-plugin-skillplaza'));
  } finally {
    rmSync(skillsRoot, { recursive: true, force: true });
  }
  console.log(`\n[simulate] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

await main();
