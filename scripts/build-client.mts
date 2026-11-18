/**
 * 客户端构建:src/client/index.tsx → dist/client/index.js(自包含 ModuleLoader 壳)。
 *
 * 三步:
 *  1. tailwind 重新生成 src/client/tw-panel.css(扫描 src/client/*.tsx 的 utility 类)
 *  2. esbuild 打包为 CJS(react/@deepseek-ai/* 由宿主 provide,标 external);
 *     CSS import(@xyflow/react/dist/style.css + tw-panel.css)被抽到 dist/client/index.css
 *  3. 把 index.css **内联**进 JS:DSH 的 ModuleLoader 只加载 index.js,不会加载
 *     任何 .css 文件 —— 不内联就是整个面板零样式(黑盒 minimap/芝麻节点,2026-11-17 实测)
 * 最后套 window.__ModuleLoader__.load({ id, factory }) 壳(官方 client.js 同款格式)。
 */
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// 1. Tailwind 先行(类名集随源码变化)
execFileSync('npx', ['tailwindcss', '-c', 'tailwind.config.js', '-i', 'scripts/tw-input.css', '-o', 'src/client/tw-panel.css', '--minify'], { stdio: 'inherit' });

// 2. esbuild 打 JS(CSS 抽成 dist/client/index.css)
const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  outdir: 'dist/client', outExtension: { '.js': '.cjs' },
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
  logLevel: 'warning',
});
void result;

// 3. CSS 内联注入(面板样式自包含,不依赖宿主加载 .css)
const CSS_STYLE_ID = 'dsh-plugin-skillplaza-css';
const css = existsSync('dist/client/index.css') ? readFileSync('dist/client/index.css', 'utf8') : '';
const injectCss = `
// injected by scripts/build-client.mts —— ModuleLoader 只加载 JS,CSS 必须随包注入
(function () {
	if (typeof document === 'undefined' || document.getElementById("${CSS_STYLE_ID}")) return;
	var s = document.createElement('style');
	s.id = "${CSS_STYLE_ID}";
	s.textContent = ${JSON.stringify(css)};
	document.head.appendChild(s);
})();
`;

const wrap = (bundled, id, entry) => `window.__ModuleLoader__.load({
	id: "${id}",
	entry: "${entry}",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${injectCss}
${bundled}
		return module.exports;
	}
});
`;
const main = readFileSync('dist/client/index.cjs', 'utf8');
writeFileSync('dist/client/index.js', wrap(main, 'dsh-plugin-skillplaza', './index.js'));
console.log('client bundle:', Math.round(main.length / 1024), 'KB + css', Math.round(css.length / 1024), 'KB(inlined)');
