# 喵坞 · MiaoDock

**Box 桌面端 · 漫画翻译模块 ver1.0** —— 本地翻译服务的宿主与可视窗口。

- 依据：《00-决策纪要》《02-Box-技术方案-ver1.0》《03-翻译服务接口契约-ver1.0》
- 开发方案与验收标准：`docs/dev-plan.md`
- 偏离与裁定留痕：`docs/spec-notes.md`
- **AI 协作上下文入口：`AGENTS.md`**（任何 AI 工具进入本仓库先读它；Trae 另见 `.trae/rules/project_rules.md`）

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

> **若 `npm run app` 报 `failed to run 'cargo metadata' ... No such file or directory (os error 2)`**，
> 说明 `cargo` 不在 PATH —— 工具链装在 `~/.cargo/bin` 但 shell 没加载它。修一次即可永久生效：
>
> ```bash
> echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
> ```
>
> 验证：`cargo --version` 能打出版本号即可。Rust 另需 Node ≥ 18（`node -v`）。

> 环境变量 `MIAO_ROOT` 可覆盖落盘根目录（验收用临时目录），默认 `~/Pictures/Box 漫画`。
> 运行期状态在平台应用数据目录下的 `Box/state/`（`MIAO_STATE_DIR` 可覆盖）：
> `tasks/` 任务清单、`pending/` **上传字节暂存区**、`token`、`idempotency.json`。
> 暂存区是「服务崩溃后未落盘的原图还能救回」的依据（见 `docs/spec-notes.md` G-12）——
> 它在漫画目录**之外**，所以取消任务不会在漫画目录留下残缺文件。

## 验收

```bash
npm run selftest              # A 组服务契约 + 引擎自测
npm run selftest:app          # B1–B5 应用生命周期（程序化，不依赖人点）
npm run selftest:app:refute   # 上一项的反证——它必须**变红**，绿的那轮才作数
npm run e2e                   # D1–D5 端到端（真实 engine + 真实 service，真落盘）
npm run capture               # 截图取证（需屏幕解锁；不满足条件会拒绝出图而非交假证据）

# 结构断言（每条都带反证轮，见 docs/spec-notes.md 与 AGENTS.md §3）
npm run check:ia              # IA 结构 24 条（侧栏两级 / 视图 Tab / 设置两栏壳 / 小节分层）
npm run check:tls             # 依赖链 TLS 14 条（配置层 / 锁文件层 / 源码层）
npm run check:music           # 音乐平台 / 心动模式 / 桌面歌词 / 逐字歌词 / 逐字整行模式 / 翻译歌词 / 演唱行 / 高亮同步 / 滑块填充 / 音频图 / 音乐缓存 / 六皮肤 / 队列 / 歌曲右键菜单 / 灵动岛歌词卡 / 启动恢复 / 音乐快捷键 215 条（反证：check:music:refute）
npm run check:settings        # 设置页「播放·媒体」裁定结果 90 条（反证：check:settings:refute）
npm run check:units           # 前端分层 / hooks / 别名 / 状态 / 灵动岛 / 样式分层 37 条（反证：check:units:refute）
```

各组判据与「为什么这么测」见 `docs/dev-plan.md` §4；一路踩过的环境陷阱见 `docs/spec-notes.md`。

> **在代理（沙箱）里跑 e2e 时，请把临时目录挪到系统临时区**：
> ```bash
> MIAO_E2E_TMP="$(node -e 'console.log(require("os").tmpdir())')/miao-e2e" npm run e2e
> ```
> 运行时的「安全删除守卫」会拦截仓库内 `.tmp-e2e/` 的批量删除（连开头那次清理都起不来），
> 而它对系统临时目录下的路径整条绕过。一件事两样症状、排查全过程见 `docs/spec-notes.md` D-19。

> **当前只有开发态**：`npm run app:build` 产出的 `.app` 里**不含** `service/` 与 `engine/`
> （`tauri.conf.json` 的 `bundle.resources` 为空，`resolve_entry` 也从可执行文件向上找不到它们），
> 所以装出来的应用起不了服务。打包分发本轮**未做**（见 `docs/spec-notes.md` G-13）。
