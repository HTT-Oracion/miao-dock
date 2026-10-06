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
├── app/          Tauri v2 桌面端：Rust 壳（`app/src-tauri/`）+ Vite/React 前端（`app/src/`）
├── service/      box-service —— **唯一翻译入口**：鉴权 / 串行队列 / 编号分配 / 落盘（Node，127.0.0.1:5180–5190）
│   ├── src/        **产品代码**：`server.mjs` 路由 · `store.mjs` 队列与落盘 · `engine-client.mjs` 引擎适配（唯一耦合点）
│   └── scripts/    **运行期**脚本（只剩一个）：`print-launch-plan.mjs` —— Rust 启动时问它要「启动配方」
├── engine/       翻译引擎的**接缝层**（真引擎装在 `runtimes/`，不在库）
│   ├── VERSIONS.lock         引擎 / 权重 / 外部二进制的**版本锁**（换版本照它来）
│   ├── models.manifest.json  模型清单：来源 URL + sha256 + 字节数（权威副本在 `runtimes/…/models-store/`）
│   ├── model-store.mjs       下载内核：断点续传 / 逐文件哈希 / `.ready` 幂等 / 硬链接
│   ├── src/                  **测试替身**：模拟引擎 + 模拟 LLM（产品默认走真引擎 `MIAO_ENGINE_PROTOCOL=real`）
│   └── scripts/              **运行期**脚本：`child-watch.mjs`（父死带走整棵子树）· `fetch-models.mjs`（CLI）
├── e2e/          **全部验收与取证脚本**（纯 Node 零依赖；一条命令一组断言，正向与反证成对）
│   ├── *.mjs                  生命周期 / 端到端 / 截图取证 / 文档与结构对账
│   ├── service/               box-service 侧（`selftest.mjs` = A 组契约自测 · `stall-guard-check.mjs` = U10② 取证）
│   └── engine/                引擎侧（引擎自测 / 真引擎全链路 / 真机 sha256 与断点续传）
├── docs/         事实源与取证：`dev-plan.md`（方案与判据）· `spec-notes.md`（**台账：裁定与偏离留痕**）· `refs/`（入库的图与报告）
├── test-manga/   本机验收素材：真实漫画（**不入库**）
├── test-music/   本机验收素材：音乐（**不入库**）
├── runtimes/     **真引擎本机资产**：Python venv + 模型权重 + llama.cpp（**不入库**，清单见 `engine/VERSIONS.lock`）
├── vendor/       参考实现切片（只读，**不入库**）
├── .tmp/         **全仓唯一的临时落盘目录**（**不入库**）：`e2e/` · `selftest/` · `models/` · `engine-test/`
├── AGENTS.md     AI 协作上下文入口（任何工具进仓库先读它）
└── README.md     本文件
```

> **目录约定（动目录之前先读这三条）**
>
> 1. **产品 / 验收分家**：`service/src`、`engine/src`、`app/src` 是**产品**；`e2e/` 是**验收**。
>    判据不是"像不像测试"，而是**产品代码在运行期会不会 fork 它** —— 会 fork 的
>    （`print-launch-plan.mjs` / `child-watch.mjs` / `fetch-models.mjs`）留在各自模块的 `scripts/` 下，**不搬进 `e2e/`**。
> 2. **临时产物一律写进 `.tmp/<用途>/`**，不要在仓库根另起 `.tmp-xxx/` 或 `tmp-xxx/`
>    （历史上散着 `.tmp-e2e` / `.tmp-models` / `.tmp-selftest` / `tmp-engine-test` 四个，已合并 —— 见 `docs/spec-notes.md` D-79）。
> 3. **新增 / 搬迁目录必须同步更新本节**。同时检查：`AGENTS.md` §1 的分层表 · `.trae/rules/project_rules.md` ·
>    以及**断言里写死的路径** —— 路径不同步的后果不是变红，而是**静默跳过**。

## 开发

```bash
# 服务层（可独立启动，不依赖桌面端）
node service/src/server.mjs

# 测试替身（模拟引擎 + 模拟 LLM）—— 只有测试用，产品走真引擎
node engine/src/server.mjs

# 桌面端（需 Rust 工具链）；它会自己拉起**三个**子进程：服务 + 引擎 + LLM
#   默认 real ⇒ 引擎栈 = python main.py(8000) + 执行器(8001) + llama-server(8080)，需要 runtimes/
#   想跑替身快回路：MIAO_ENGINE_PROTOCOL=mock npm run app
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
npm run selftest:app          # B 组应用生命周期 16 条（程序化，不依赖人点；含 S2 五态轨迹/参数快照/崩溃分级）
npm run selftest:app:refute   # 上一项的反证——它必须**变红**，绿的那轮才作数
npm run selftest:app:e11      # E11 三进程树回收（mock）：SIGKILL 主进程 → 13 端口全释放
npm run selftest:app:e11:real # 同上但真进程（python+执行器+llama-server）；分钟级，按需手动跑
npm run check:launch-plan     # S2 启动配方契约 24 条（含 ③ 归属移交后的 P-llm-* 断言）
npm run check:child-watch     # 外部二进制父死看守的双向取证（反证：check:child-watch:refute）
npm run fetch:models          # S3 模型下载器（--check 只校验不联网 / --link 只重建引擎树里的链接；反证：check:models:refute）
npm run e2e                   # D1–D5 端到端（真实 engine + 真实 service，真落盘）
npm run capture               # 截图取证（需屏幕解锁；不满足条件会拒绝出图而非交假证据）

# 结构断言（每条都带反证轮，见 docs/spec-notes.md 与 AGENTS.md §3）
npm run check:ia              # IA 结构 32 条（侧栏两级 / 视图 Tab / 设置两栏壳 / 小节分层 / 侧栏两套几何 C8d）
npm run check:tls             # 依赖链 TLS 14 条（配置层 / 锁文件层 / 源码层）
npm run check:engine-client   # 翻译引擎适配层 42 条 / 反证 8 条（真协议用 openapi 快照「假引擎」，秒级可复跑）
npm run check:models          # S3 模型下载器 32 条 / 反证 5 条（本地 Range 夹具源：中断续传 / 篡改一字节 / 换版本重链，秒级）
npm run check:profile         # S4 档位映射 / 加速后端 / 降档 / 空闲卸载（判定层）43 条 / 反证 14 条（起真进程，约 10s）
npm run check:e5e6            # S4 端到端 E5/E6：真服务 + 真引擎 + 真 ③，16 条 / 逃生开关反证 3 条（约 60s）
npm run check:contract        # S5 契约增量：9 键 sidecar / 未就绪 vs 不可用 / 模型缺失 / /engine/status 77 条（反证：check:contract:refute）
npm run check:music           # 音乐平台 / 心动模式 / 桌面歌词 / 逐字歌词 / 逐字整行模式 / 翻译歌词 / 演唱行 / 高亮同步 / 滑块填充 / 音频图 / 音乐缓存 / 六皮肤 / 队列 / 歌曲右键菜单 / 灵动岛歌词卡 / 启动恢复 / 音乐快捷键 215 条（反证：check:music:refute）
npm run check:settings        # 设置页「播放·媒体」+「翻译服务」+ ② 分组简洁化 + X-C3 裁定结果 + ④ 功能梳理（侧栏标签 / 存储占用 / 第三方许可 / def）164 条（反证：check:settings:refute，103 条）
npm run check:units           # 前端分层 / hooks / 别名 / 状态 / 灵动岛 / 样式分层 37 条（反证：check:units:refute）
npm run check:stall           # U10② 引擎卡死：「静默有上界 + 每次尝试留痕 + 进行中落盘」7 条 / 反证 3 条（mock 引擎对指定 seq「永不回包」）
npm run check:engine-settings # S6 引擎设置面：档位 / 后端 / 空闲 / 模型目录 + 模型下载状态 61 条（反证：check:engine-settings:refute）
npm run check:docs            # 文档 ↔ 实现一致性：条数对账 / 引用的命令存在 / 禁词 0 命中 / 分组覆盖 14 条
```

**S7 真机端到端 E1–E11**（逐项取证总表：`docs/engine-e2e-acceptance-report.md`）—— 这几条**不进常规门**，按需手动跑：

```bash
npm run check:e3:real            # E3  真引擎全链路 31 张              （真权重，分钟级）
npm run check:e4[:refute]        # E4  档位：引擎真在用的那一档        6 条 / 反证 4 条
npm run check:e7:real[:refute]   # E7  3.6 GB 真权重 sha256 + 篡改必检出 6 条 / 反证 3 条
npm run check:e8[:refute]        # E8  加速后端 3 轮真服务             6 条 / 反证 4 条
npm run check:e10[:refute]       # E10 安全：回环 / 非图片字节 / 403    7 条 / 反证 4 条
npm run selftest:app:e11:real    # E11 三进程树回收 + E1 生效参数快照 （真进程，分钟级）
```

> **E9（与插件联调）不在本仓**：在 `miao-trans` 仓跑 `node e2e/e9-real-engine.mjs`（先构建扩展）——
> 真实漫画站 31 张 + 真引擎，19 条断言，约 10 分钟；产物落该仓 `.temp-translate-test/`（已 gitignore）。
> 脚本自己拉起并收尾 box-service / 引擎 / ③ / `:8001` 执行器（**孙进程**，漏杀会让下一轮全 `engine_engine_error`）。

各组判据与「为什么这么测」见 `docs/dev-plan.md` §4；一路踩过的环境陷阱见 `docs/spec-notes.md`。

> **在代理（沙箱）里跑 e2e 时，请把临时目录挪到系统临时区**：
> ```bash
> MIAO_E2E_TMP="$(node -e 'console.log(require("os").tmpdir())')/miao-e2e" npm run e2e
> ```
> 运行时的「安全删除守卫」会拦截仓库内 `.tmp/e2e/` 的批量删除（连开头那次清理都起不来），
> 而它对系统临时目录下的路径整条绕过。一件事两样症状、排查全过程见 `docs/spec-notes.md` D-19。

> **当前只有开发态**：`npm run app:build` 产出的 `.app` 里**不含** `service/` 与 `engine/`
> （`tauri.conf.json` 的 `bundle.resources` 为空，`resolve_entry` 也从可执行文件向上找不到它们），
> 所以装出来的应用起不了服务。打包分发本轮**未做**（见 `docs/spec-notes.md` G-13）。

> **翻译引擎接入进行中**：适配层（`service/src/engine-client.mjs`）已按真引擎协议重写并在真引擎上
> 出过真译文（S1 / D-62）；**S2 三进程生命周期已完成、macOS 侧过 G2**（D-64…D-70）——
> `ServiceManager` 管 `Children{service, engine}`，就绪是**三重判定**（进程存活 + 端口 + HTTP），
> 真模式 E11 已实测（SIGKILL 主进程 → 真引擎/执行器/llama-server 全自退、14 端口释放）。
> **S3 模型管理已完成**（D-72：清单固化 / 断点续传下载器 / store + 硬链接，换引擎版本不重下模型）。
> **S4 档位 / 加速后端 / 降档重试 / 两级空闲卸载已完成**（D-73）：③ 的归属权从 Rust 移交给
> box-service（`service/src/llm-supervisor.mjs`），真 ③ 冷启动实测 1.0–2.8s、Tier1 占用 2.09–2.77 GB。
> **S5 契约增量已完成**（D-74）：`/health.sidecar` 扩到 **9 键**（含 `engineVersion` = 引擎 commit 短 sha）、
> 三个 503 严格分开（`UNAVAILABLE` 进程不在 / `ENGINE_NOT_READY` 进程在但未就绪 / `MODEL_DOWNLOAD_FAILED` 模型没了）、
> 新增需鉴权的诊断视图 `GET /engine/status`。
>
> 🔴 **引擎栈模式默认 `real`**：`npm run app` 起的**已经是真引擎**（`python main.py` + `llama-server`，
> 需要 `runtimes/`，见 `engine/VERSIONS.lock`）。模拟引擎只在测试里被显式注入
> （`selftest.mjs` / `e2e.mjs` / `lifespan-selftest.mjs` / `capture.mjs` / `check:e5e6` / `check:contract`）。
> **未做**：诊断 UI / 插件串联（S6–S8）· Windows 侧（`unverified`）·
> 打包分发（G-13：装出来的 `.app` 里不含 `service/` 与 `engine/`，起不了服务）。
