# 喵坞 · MiaoDock

**Box 桌面端 · 漫画翻译模块 ver1.0** —— 本地翻译服务的宿主与可视窗口。

- 依据：《00-决策纪要》《02-Box-技术方案-ver1.0》《03-翻译服务接口契约-ver1.0》
- 开发方案与验收标准：`docs/dev-plan.md`
- 偏离与裁定留痕：`docs/spec-notes.md`

## 与插件端的关系

| 产品 | 仓库 | 角色 |
|---|---|---|
| 喵译 MiaoTrans | `../miao-trans` | 浏览器插件（Chrome MV3），提交翻译任务的**入口面之一** |
| **喵坞 MiaoDock** | 本仓库 | 桌面端，**服务的宿主与可视窗口**（队列 / 漫画库 / 本机投放） |

两者**共用同一份接口契约**（《03》）：同一条串行队列、同一套落盘规则、同一条 20 张/批上限。
`miao-trans/mock-service` 是插件端 e2e 的**测试替身**，与本仓库 `service/` 是同源的两份实现，互不影响。

## 目录

```
miao-dock/
├── docs/         开发方案、验收标准、裁定留痕
├── service/      box-service（Node，127.0.0.1:5180–5190）—— 唯一翻译入口、队列、编号、落盘
├── engine/       mangatranslator 模拟引擎 sidecar（127.0.0.1:5003）—— 真实模型就绪前顶替
├── app/          Tauri v2 桌面端（Rust 壳 + Vite/React 前端）
└── scripts/      验收脚本（契约自测 / 生命周期 / 端到端 / 截图取证）
```

## 开发

```bash
# 服务层（可独立启动，不依赖桌面端）
node service/src/server.mjs

# 模拟引擎
node engine/src/server.mjs

# 桌面端（需 Rust 工具链）；它会自己拉起上面两个子进程
cd app && npm install
cd .. && npm run app
```

> 环境变量 `MIAO_ROOT` 可覆盖落盘根目录（验收用临时目录），默认 `~/Pictures/Box 漫画`。

## 验收

```bash
npm run selftest              # A 组服务契约 + 引擎自测
npm run selftest:app          # B1–B5 应用生命周期（程序化，不依赖人点）
npm run selftest:app:refute   # 上一项的反证——它必须**变红**，绿的那轮才作数
npm run e2e                   # D1–D5 端到端（真实 engine + 真实 service，真落盘）
npm run capture               # 截图取证（需屏幕解锁；不满足条件会拒绝出图而非交假证据）
```

各组判据与「为什么这么测」见 `docs/dev-plan.md` §4；一路踩过的环境陷阱见 `docs/spec-notes.md`。

> **当前只有开发态**：`npm run app:build` 产出的 `.app` 里**不含** `service/` 与 `engine/`
> （`tauri.conf.json` 的 `bundle.resources` 为空，`resolve_entry` 也从可执行文件向上找不到它们），
> 所以装出来的应用起不了服务。打包分发本轮**未做**（见 `docs/spec-notes.md` G-13）。
