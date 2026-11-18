# Skill 广场 · DSH 插件

把 [Skill 广场](https://iruidong.com/plaza) 接到你的 DSH 桌面端:搜技能、装技能、跑多专家流程,并在侧栏面板里实时看流程跑到哪一步。

> 这是 Skill 广场的**客户端**,不是独立产品。你的权限就是你的广场账号权限——买了什么、被授权了什么,在 DSH 里就能用什么。

## 安装(三步)

1. **装 DSH 桌面端**(如果还没有):DSH 官方下载页。
2. **在 DSH 里装本插件**:`插件 → 添加 → 搜索 skillplaza`(或本仓库 `npm run build` 后用本地路径安装)。
3. **绑定广场账号**:在 DSH 对话里敲 `/plaza-login`,按提示到广场「我的 → 访问令牌」生成一枚 `plaza_pt_*` 令牌,粘贴进插件设置(`plazaToken`)。⌘Q 重启 DSH 生效。

绑定后建议先敲 `/plaza-flows`,确认你的流程清单已经能拉到。

## 能力

| 入口 | 干什么 |
|---|---|
| `/plaza-skills [关键词]` | 搜广场技能(名称/slug/描述),🔒=需先在广场解锁 |
| `/plaza-install <slug>` | 把技能包装进本地技能库(`~/.dsh/skills/`),之后描述用途即可触发 |
| `/plaza-flows [关键词]` | 列出你账号可运行的流程(slug + 名称 + 类型) |
| 对话「跑 XX 流程」 | 模型调 `plaza_flow_run` 执行:每个专家以真人设运行,挂知识库的会先检索再作答;含人工闸门的流程会停下来等你审批(通过/驳回+意见,驳回回炉 ≤2 轮) |
| 侧栏「流程运行」面板 | React Flow 画布实时点亮:节点随执行变色、交接边流动、人工闸门琥珀呼吸;可拖动节点、平移缩放;顶部「我的流程」抽屉可浏览全部流程并预览流程图 |

## 边界(如实告知)

- **流程结构**:当前支持串行 pipeline;含并行 / 路由 / 循环节点的流程会**明确报错**,不会静默降级跑错。
- **执行模型**:专家节点跑在 **DSH 侧配置的模型**上(`flowProvider` / `flowModel`),不是广场服务端那套;同一个流程两边跑,产出质量取决于各自模型。
- **权限**:可见范围完全跟随令牌账号。别人没发布给你的流程,给了 slug 也拉不到。
- **付费技能**:未解锁的加密技能不提供包下载(返回 locked);去广场详情页解锁后再装。
- **知识库**:知识库不是技能包,不能安装;在流程执行/问答里由专家挂载后检索。
- **令牌**:只存你本机 DSH 状态,不上传任何第三方;吊销在广场设置页一键生效。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `plazaBase` | `https://iruidong.com/plaza` | 广场地址(测试环境改 `https://test.iruidong.com/plaza`) |
| `plazaToken` | 空 | 个人访问令牌 `plaza_pt_*`(secret,volatile:改后免重启) |
| `flowProvider` | `iruidong` | 流程专家节点用的 LLM provider |
| `flowModel` | `glm-5.3` | 流程专家节点用的模型 |

> 桌面端配置在 `~/.dsh/profiles/desktop/cordis.patch.yml`;改后 ⌘Q 重启生效。

## 开发

```sh
npm install
npm run build     # tsc(host) → tailwind → esbuild(client,CSS 内联)→ dist/
npm run check     # tsc --noEmit
npx tsx test/simulate.test.ts   # 26 例(命令/安装/KB/注入)
```

面板本地预览(不依赖 DSH):按 `test/harness.tsx` 用 esbuild 打包成 `test/harness/bundle.js`,再起静态服务器打开 `test/harness/index.html`。

结构:`src/index.ts`(工具/命令注册) · `src/plaza-client.ts`(广场 API) · `src/installer.ts`(zip→技能库) · `src/flow/`(runner 驱动/状态注册/面板数据服务/流程清单) · `src/client/`(浏览器面板 React) · `src/vendor/`(plaza-flow SDK 原样 vendor,锁语义) · `skills/`(随包技能,教 agent 走工具)。

## 排障

- **面板空白 / 取数失败**:插件自带数据服务在 `127.0.0.1:18799`(端口占用会递增到 18803)。`curl http://127.0.0.1:18799/api/runs` 探活。
- **`/plaza-login` 后仍报未绑定**:确认 `plazaToken` 已填且 ⌘Q 重启过。
- **流程报「暂不支持的工作流节点类型」**:该流程含并行/路由/循环,当前只支持串行。
- **会话日志**:`~/.dsh/sessions/<ws>/<id>/session.v4.jsonl.zstd`(`zstd -dc` 看 tool/call、llm/retry)。
