/**
 * 技能包装进本地 DSH 技能库 —— unzip → 剥壳 → 校验 → 落盘 <dshHome>/skills/<name>/。
 *
 * 落点:skills.zh.md 的本地发现表 rank=400「user-dsh: <dshHome>/skills」,即 ~/.dsh/skills,
 * 本地提供方 Chokidar 监听该根,写入即自动进入技能目录(无需显式 invalidate)。
 *
 * 防护与 plaza 上传闸(2026-11-09 上传链路)同款纪律:
 *  - 剥一层壳:zip 所有条目共享同一顶层目录时剥掉(GitHub 整仓包的常见形态)
 *  - 跳过 .git/ __MACOSX/ .DS_Store
 *  - zip-slip:解压目标必须留在安装目录内,越界条目丢弃
 *  - SKILL.md 大小写归一;name 必须是 kebab-case(DSH 技能命名铁律)
 */
import { unzipSync, strFromU8 } from 'fflate';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize } from 'node:path';

export const defaultSkillsRoot = (): string => join(homedir(), '.dsh', 'skills');

export interface InstallResult { name: string; dir: string; files: number }

export const installZipToSkills = (zipBytes: Uint8Array, root: string): InstallResult => {
  const entries = unzipSync(zipBytes);
  const paths = Object.keys(entries).filter((p) => !p.endsWith('/'));
  const clean = paths.filter((p) => !/(^|\/)(\.git|__MACOSX)(\/|$)/.test(p) && !p.endsWith('.DS_Store'));
  if (!clean.length) throw new Error('压缩包是空的(或只有 .git/__MACOSX)');

  // 剥壳:所有条目共享同一顶层目录则剥掉一层
  let strip = '';
  const first = clean[0].split('/')[0];
  if (clean.every((p) => p.startsWith(first + '/'))) strip = first + '/';

  const files: Record<string, Uint8Array> = {};
  for (const p of clean) files[p.slice(strip.length)] = entries[p];

  const skillMdPath = Object.keys(files).find((p) => /^skill\.md$/i.test(p));
  if (!skillMdPath) throw new Error('包内找不到 SKILL.md(不是标准技能包)');

  const body = strFromU8(files[skillMdPath]);
  const name = body.match(/^name:\s*([a-z0-9-]+)\s*$/m)?.[1] ?? '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`SKILL.md 的 name 缺失或不是 kebab-case(${name || '空'}),DSH 技能库不收`);
  }

  const rootN = normalize(root);
  const dir = normalize(join(rootN, name));
  if (!dir.startsWith(rootN)) throw new Error('非法安装路径');

  rmSync(dir, { recursive: true, force: true });   // 覆盖安装 = 更新到广场最新版
  mkdirSync(dir, { recursive: true });

  let count = 0;
  for (const [p, data] of Object.entries(files)) {
    const dest = normalize(join(dir, p));
    if (!dest.startsWith(dir)) continue;           // zip-slip 防护
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    count++;
  }
  return { name, dir, files: count };
};
