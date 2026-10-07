# AGENTS.md —— 本仓库的 AI 协作上下文（唯一入口）

> 本文件是**任何 AI 编程工具**（WorkBuddy / Trae / Cursor / CodeBuddy…）进入本仓库时的**第一份必读**。
> 它是入口与硬约束，不是完整事实源：**完整事实源 = `README.md` + `docs/dev-plan.md` + `docs/spec-notes.md`**。
> 三者冲突时，以 `docs/spec-notes.md`（裁定与偏离留痕）为准，并把结论回写到本文件所在仓库。

**工作语言：中文**（注释、提交信息、文档一律中文；代码标识符除外）。

---

## 1. 项目是什么

**喵坞 MiaoDock · Box 桌面端** —— 本地漫画翻译服务的宿主与可视窗口，外加一个音乐应用（ver2.0）。

| 层 | 技术 | 位置 |
|---|---|---|
| 桌面壳 | Tauri v2（Rust） | `app/src-tauri/` |
| 前端 | Vite + React 18 + TS，**原生 CSS + CSS 变量**（无 Tailwind；UI 库仅 `@radix-ui/react-select`） | `app/src/` |
| 翻译服务 | Node（127.0.0.1:5180–5190） | `service/` |
| 翻译引擎 | **接缝层**：真引擎装在 `runtimes/`（不在库），本目录放版本锁 `VERSIONS.lock` / 模型清单与下载器 / 子进程看守；`engine/src/` 是**测试替身**（mock 引擎 + mock LLM） | `engine/` |
| 验收与取证脚本 | 纯 Node 零依赖（`e2e/service/`、`e2e/engine/` 按来源分） | `e2e/` |
| 参考实现切片 | 只读参考，**保持原样不改** | `vendor/music-reference/`（不入库） |

**目录约定（硬规则，全文与理由见 `README.md` §目录 · `docs/spec-notes.md` D-79）**：

- **产品 / 验收分家**：判据不是"像不像测试"，而是**产品代码运行期会不会 fork 它**。会 fork 的三个
  （`service/scripts/print-launch-plan.mjs` · `engine/scripts/child-watch.mjs` · `engine/scripts/fetch-models.mjs`）
  留在原处，其余全部在 `e2e/`。搬迁脚本时**按来源分子目录**以保住相对深度（`service/scripts/x` → `e2e/service/x`）。
- **临时产物一律写进 `.tmp/<用途>/`**（`e2e/` · `selftest/` · `models/` · `engine-test/`），**不得**在仓库根另起 `.tmp-xxx/` / `tmp-xxx/`。
- **新增或搬迁目录后必须同步**：`README.md` 目录节（唯一入口）· 本节分层表 · `.trae/rules/project_rules.md` ·
  `package.json` 命令 · **断言里写死的路径**（不同步的后果是**静默跳过**，不是变红）· 脚本自己的用法注释。

**目录分层（硬规则，见《09》§2.2）**：

- `app/src/components/units/` —— 通用 UI 单元。**判据：不 import 业务层**（store / ipc / types / platform / `@hooks` 整个目录 / nav）。类名一律 `ui-` 前缀。
- `app/src/components/` —— 应用级组件（Sidebar / Toolbar / ViewTabs / QuitConfirm）。
- `app/src/screens/<屏>/` —— 屏内件（`settings/parts.tsx`、`music/shared.tsx`）。
- `app/src/hooks/` —— **hooks 唯一收口**：`use*` 命名的 hook 一律住这里（业务 hook 进桶文件 `index.ts`，经 `@hooks` 引入；纯行为 hook 如 `useEsc`、`useCoverColor` 单放同目录）。旧的 `src/hooks.ts` 单文件**不得**与目录并存 —— 模块解析会**静默二选一**（`HOOKS.layout` 盯死）。
- **按「依赖什么」定归属，不按「被用几次」定归属。** 抽离规则与反面纪律（什么**不**该抽）见 `docs/spec-notes.md` D-34 与《09》§2.2。

**引用一律走路径别名（2026-10-04 起）**：`@`（src 根）· `@tauri`（src-tauri，预留）· `@components` · `@screens` · `@music` · `@hooks`；**`app/src` 内不写相对 import**（含 CSS/SVG 副作用导入；同目录 `./` 仍可用）。规则全文见《09》§2.3 与 `docs/spec-notes.md` D-40。增改别名**必须 `vite.config.ts` 与 `tsconfig.json` 双处同步**，且 TS 侧每个别名要**同时**有 `@x` 与 `@x/*` 两条。

**状态管理统一 zustand**：跨组件共享状态一律 zustand（`@music/store` 是先例），**不引入 React Context**（全仓 `createContext` 为零，维持此状 —— `STATE.noReactContext`）。注意它管的是**跨组件共享**，不是"所有状态都塞进全局"：只需一处持有或仅父子一层传递的照旧 `useState`。理由见《09》§2.3.3 与 `docs/spec-notes.md` D-42。

## 2. 工程纪律（本项目硬性要求，不得绕过）

1. **交付物必须自证，断言必须可反证。** 只跑正向等于没验证 —— 反证轮必须真的变红才算数。
   新增/修改断言时，同时给出「破坏什么 → 哪一条变红」。
2. **记忆不能当证据，要回读代码/文档。** 结论必须来自当前工作区的实际内容；台账与实际不符时以实际为准，并回写台账。
3. **假阳性比没测试更危险。** 一条断言长期全绿却从未抓到过 bug，先怀疑它测错了东西。
   比率型指标会吞掉分母变化：**断言条数要写死并断言，跳过必须非零退出**（跳过 ≠ 通过）。
4. **断言要覆盖"所有层"，不能只测最上面那层。** 写完先自问：**「如果这一层坏了，它会红吗？」**
   用户能感知的行为常横跨 JS 判定层与原生前提层，只测上层时下层坏掉照样全绿。
5. **关键节点独立 commit**，提交信息说明该节点内容；跨里程碑修正另起 `fix(...)`，不混入。
6. **所有设计/实现决策与踩过的坑，记入 `docs/spec-notes.md`**（`D-xx` = 决策/陷阱，`G-xx` = 待裁定缺口）。
   **在本仓库做的任何非平凡决定，都要落在这里** —— 这是跨工具、跨会话唯一能共享的记忆。
7. **不引入未经确认的新依赖。** 确需引入时，在提交信息与台账里写清代价（体积/包数/平台耦合）。
8. **不得出现历史上那批被禁的品牌标识**（本项目已彻底清除，需要提及时一律写「参考实现」）。
   ⚠️ 连**规则条文本身**也不写出它 —— 否则"全仓扫描无命中"这条纪律会被规则文件自己污染
   （本项目已有先例：断言脚本里就是用「被禁的历史品牌标识」指代的）。

## 3. 验收命令（改完必须跑，绿色才算交付）

```bash
npm run selftest              # A 组服务契约 159 条 + 引擎自测 23 条
npm run selftest:app[:refute] # B 组应用生命周期 16 条（含 S2a–S2d：五态轨迹 / E1 参数快照 / 三子进程 / 崩溃分级；含反证）
npm run selftest:app:e11[:refute]     # E11 三进程树回收（mock，秒级）：SIGKILL 主进程 → 13 端口全释放
npm run selftest:app:e11:real         # 同上但**真进程**（python+执行器+llama-server，14 端口）· 分钟级
npm run check:launch-plan     # S2 启动配方契约 24 条（print-launch-plan.mjs → Rust，含与 probeEngine 同源断言 + ③ 归属移交的 P-llm-* ）
npm run check:child-watch[:refute]   # 外部二进制父死看守的双向取证（秒级；真模式 E11 的唯一依赖）
npm run check:child-watch-kill[:refute] # child-watch Windows killTree 无条件 /F 源码钉子（不起进程；D-89 崩溃路径孤儿执行器）
npm run e2e                   # D 组端到端
npm run check:ia              # IA 结构 32 条（含 C8d：侧栏两套几何 58×52 / 44×44 随标签形态成对切换）
npm run check:tls             # TLS 依赖链 14 条（三层）
npm run check:quit[:refute]   # 「退出喵坞」根因钉子 5 条 / 反证 5 条（源码级：quit_app 必须 async / reap 有界 / CREATE_NO_WINDOW / 前端不静默 / Windows signal_tree 无条件 /F；不起进程）
npm run check:engine-client[:refute] # 翻译引擎适配层 46 条 / 反证 10 条（真协议用 openapi 快照「假引擎」，秒级）
npm run check:retry[:refute]  # 队列「重试」任务身份：复用**同一** taskId（不冒历史行）6 条 / 反证 5 条（mock 引擎 + 真服务子进程，秒级）
npm run check:lib-manage[:refute] # 队列多选删除 + 漫画库隐藏/删除：仅终端态可删 / 删除带 deleteFiles 勾选 / 越界名 403 / 前端接线 8 条 / 反证 4 条（mock 引擎 + 真服务子进程，秒级）
npm run check:retranslate[:refute] # 单张漫画返工重译 + 全屏缩放快捷键：返工**覆盖**译文（塞假译文验真被顶掉）/ 不碰原图 / 与 resume 分工 / 裸 ↑↓ 不缩放（不抢音量键）12 条 / 反证 5 条（mock 引擎 + 真服务子进程，秒级）
npm run check:models[:refute] # S3 模型下载器 E7：32 条 / 反证 5 条（本地 Range 夹具源，秒级，不碰真权重）
npm run fetch:models          # S3 模型下载器 CLI：--check 只校验 / --link 只重建引擎树里的链接（零网络）
npm run check:profile[:refute] # S4 档位映射 / 加速后端 / 降档 / 空闲卸载（判定层）43 条 / 反证 14 条（起真进程，约 10s）
npm run check:e5e6[:refute]    # S4 端到端 E5/E6：真服务 + 真引擎 + 真 ③，16 条 / 逃生开关反证 3 条（约 60s）
npm run check:contract[:refute] # S5 契约增量：9 键 sidecar / 未就绪 vs 不可用 / 模型缺失 / /engine/status，77 条（8 个实例场景 A–H）/ 逃生开关反证 4 条（各约 3s / 2s）
# —— S7 真机端到端 E1–E11（逐项取证；总表见 docs/engine-e2e-acceptance-report.md）——
npm run check:e3:real         # E3 真引擎全链路 31 张（一个 Task 两个 Batch + 落盘 + SSE 一致）8 条 · **真权重，分钟级，不进常规门**
npm run check:e4[:refute]     # E4 档位切换：生效档位 vs 配置档位 / 未声明档位必须抛错（真服务 + 假引擎，秒级）6 条 / 反证 4 条
npm run check:e7:real[:refute] # E7 模型续传与校验 · **真机半边**：3.6 GB 真权重的 sha256 跑得完 + 篡改必检出（约 30s）6 条 / 反证 3 条
npm run check:e8[:refute]     # E8 加速后端：真机走 MPS / 真回退报 degraded / **用户自选 CPU 不算故障**（真服务 ×3 轮，秒级）6 条 / 反证 4 条
npm run check:e10[:refute]    # E10 安全：只监听回环 / 非图片字节不进引擎 / 无令牌 403（秒级）7 条 / 反证 4 条
# E9 与插件联调**不在本仓**：在 `miao-trans` 仓跑 `node e2e/e9-real-engine.mjs`（先构建扩展）——
#   真实漫画站 31 张 + 真引擎，19 条断言，约 10 分钟；产物落该仓 `.temp-translate-test/`（已 gitignore）。
#   脚本自己拉起并收尾 box-service / 引擎 / ③ / `:8001` 执行器。
node e2e/service/llm-real-timing.mjs  # 真 ③（llama-server）冷启动与内存实测（**真权重，分钟级，不进常规门**）
npm run check:music[:refute]  # 音乐平台 / 心动模式 / 桌面歌词 / 逐字歌词 / 逐字整行模式 / 翻译歌词 / 演唱行 / 高亮同步 / 滑块填充 / 音频图 / 音乐缓存 / 六皮肤 / 队列 / 歌曲右键菜单 / 灵动岛歌词卡 / 启动恢复 / 音乐快捷键 215 条 / 反证 180 条
npm run check:settings[:refute] # 设置页「播放·媒体」+「翻译服务」+「② 分组简洁化」+ X-C3「准备中」时间线 + ④ 功能梳理（侧栏标签开关 / 存储占用拆三行 / 第三方许可清单 / 行内 def） 164 条 / 反证 103 条
npm run check:units[:refute]  # 前端分层 / hooks / 别名 / 状态 / 灵动岛 / 样式分层 38 条 / 反证 45 条
cd app && npx tsc --noEmit && npx vite build   # 前端类型与构建
cd app/src-tauri && cargo build                # Rust（见 §5 环境陷阱）
```

> **改了断言覆盖的东西，就要同时更新断言**；搬迁文件尤其注意：
> **断言里写死的路径不同步，后果不是变红，而是静默跳过。**

## 4. 当前状态与已知缺口

- ver1.0（漫画翻译）**已完成**；ver2.0（设置页重构 + IA + 音乐模块）进行中，音乐模块四平台已接通。
- **翻译引擎接入进度**：S0 环境闸门（G1 ✅）· **S1 适配层对齐**（D-62）· **S2 三进程生命周期已完成，
  macOS 侧过 G2**（D-64…D-70）· **S3 模型管理已完成**（D-72）· **S4 档位/加速/降档/空闲卸载已完成**（D-73）·
  **S5 契约增量已完成**（D-74）。
  `ServiceManager` 现管 `Children{service, engine}`，
  就绪是**三重判定**（进程存活 + 端口 + HTTP），五态机 `stopped→starting(L1–L3)→running→stopping→stopped`。
- **契约面（S5，D-74）**：`/health.sidecar` 是 **9 键**（新增 `engineVersion`；`tier`/`model`/`accel`/`warmed`/`llm`），
  三个 503 严格分开 —— `UNAVAILABLE`=**进程不在** / `ENGINE_NOT_READY`=**进程在但未就绪** /
  `MODEL_DOWNLOAD_FAILED`=**模型没了**；诊断视图 `GET /engine/status` **要鉴权**（插件不用）。
  ⚠️ 引擎②的版本报的是 `models.manifest.json:engineCommit` 短 sha（上游 `pyproject.toml` 是占位 `0.1.0`，
  **报 0.1.0 才是失真**）；`engine.pid` **恒 null**（归属使然，由 Box 用自己的进程表填）。
  改这段前先读 D-74 决策 1–3。
- 🔴 **③（Sakura LLM）的归属权在 S4 从 Rust 移交给了 box-service**（《04》§9.1：Tier1 空闲卸载的实现方
  必须是持有任务队列的那一侧）。`print-launch-plan.mjs` 因此**不再输出 `llm` 条目**，
  Rust 只从配方里取命令文本用于**打印**（E1 参数快照），拉起/停止由 `service/src/llm-supervisor.mjs` 负责。
  E11（不留孤儿）靠 `child-watch.mjs` 包一层保住 —— **改这段前先读 D-73 决策 1**，漏改一处就是"两个 llama-server 抢 8080"。
- **模型资产管理（S3）**：`engine/models.manifest.json`（版本控制）是唯一清单 —— 来源 / sha256 / 大小；
  `engine/model-store.mjs` 负责下载（断点续传 / 逐文件 SHA256 / 失败单文件重下 / `.ready` 幂等 / 可暂停），
  `npm run fetch:models` 是 CLI。
  🔴 **权威副本在 `runtimes/manga-translator/models-store/`，引擎源码树 `src/models/` 里那几份只是硬链接** ——
  因为引擎把模型路径硬编码在自己源码树里（`utils/inference.py:94` + `utils/generic.py:24-25`，且
  `server/args.py` 没有 `--model-dir`）⇒ **换引擎版本后跑 `npm run fetch:models -- --link` 即可零网络恢复**，
  不必重下几个 GB。链接只占一份盘。
- 🔴 **一条容易说错的现状**：引擎栈模式由 `MIAO_ENGINE_PROTOCOL` 决定，**默认 `real`** ——
  也就是说 `npm run app` 起的**已经是真引擎**（`python main.py` + `llama-server`），
  模拟引擎只在测试里被显式注入（`selftest.mjs` / `e2e.mjs` / `lifespan-selftest.mjs` / `capture.mjs`）。
  ⇒ **本机没拉引擎（`runtimes/` 不在）时，产品链路起不来**，这是 G-13（打包分发）未做的一部分。
- **未做**：打包分发（`bundle.resources` 为空，装出来的 `.app` 起不了服务，G-13）· **S6 诊断 UI /
  S7 真机 E1–E11 全表 / S8 插件串联**（M7–M9）· Windows **进程树回收三项**（仍 `unverified`：
  Job Object / 无孤儿 `llama-server.exe` / `taskkill /T`；注：Windows **真引擎装配 + S1 已真机跑通**，见 D-85）·
  歌手详情 4 标签 / 评论翻页 / 卡拉OK YRC / 桌面歌词（PD-1 延后）。
- **未做真机验证**的项在台账里逐条标注（如 Radix 弹层观感、音频代理播放、皮肤观感）—— 别把
  "类型检查 + 断言通过"当成"功能可用"。
- 本仓库曾出现**同仓库并发写入**（另一个会话/窗口在改同一批文件，甚至把编辑器格式化后的引号风格一起提交）。
  动手前先 `git status` + `git log -1` 确认基线是谁的；改别人未提交的文件要 `git stash` 而不是 `git checkout --`（后者不可恢复）。

## 5. 环境陷阱（本机特有，踩过多次）

- **Rust 不在 PATH**：`PATH="$HOME/.cargo/bin:$PATH" cargo build`。
- **cargo 在沙箱里删不掉构建产物**：报 `failed to remove file ... build-script-build`。
  做法：先 `rm -f app/src-tauri/target/debug/build/*/build-script-build`，再前台构建。
- **`vite build` 需 `--no-emptyOutDir`**：本机沙箱拦截批量删 `dist/`（与代码无关）。
- **跑 e2e 要把临时目录挪到系统临时区**（安全删除守卫会拦仓库内 `.tmp/e2e/`）：
  `MIAO_E2E_TMP="$(node -e 'console.log(require("os").tmpdir())')/miao-e2e" npm run e2e`
- **批量 `sed -i` 之后看 `git status`**：本机会留下 `xxx<随机后缀>` 的临时快照文件（未跟踪）。
- **别用 shell `grep` 判"有没有"**：本机 zsh + BSD grep 在 `\|`、`--include=*.tsx` 这类写法上会**静默失配**
  （曾因此把"文件里确实有 D-42"判成 0 命中，白排查一轮）。用专用搜索工具，或改用能打印内容的命令。
- **真机 GUI 自动化被 TCC 挡**：`osascript`（-10004）、`CGWindowList` 取不到窗口（无辅助功能/屏幕录制授权）。
  「鼠标真的能不能拖」这类**只能手动确认**，别反复尝试自动化。
- **截图取证的四个前提**（否则会产出"纯白/全黑/壁纸"的假证据）：窗口不被遮挡、屏幕不锁屏、
  rAF 不被节流、主题不串轮次 —— 细节见 `docs/spec-notes.md` D-15~D-18。

## 6. 外部方案文档（可能不在本机）

方案与设计稿在 `/Users/doro/WorkBuddy/Claw/插件与box ver2.0/`（**不在本仓库、不受版本控制**）：

| 文件 | 内容 |
|---|---|
| `09-技术方案-ver2.0-最终版.md` | **效力最高**。§2.2 前端分层、§2.3 引用规范与状态管理、§3 IA、§4 设置页、§5 音乐模块、§7 验收 |
| `08-产品决策记录-ver2.0.md` | PD 系列产品决策 |
| `06-音乐模块-技术方案-ver2.0.md`、`02-Box-技术方案-ver2.0.md` | 模块级方案 |

> 若该目录不存在（换机器/换用户），**以本仓库 `docs/` 与代码为准**，并在台账里注明方案文档缺失。
> 在方案文档里做出改动时，**不要改动既有章节编号** —— 代码注释大量引用「《09》§4.4 / §3.1」这类编号。

## 7. 动手前的自检清单

- [ ] `git status` / `git log -1` 看过？基线是自己的吗？有没有并发写入者？
- [ ] 改动属于哪一层？新组件 import 业务层了吗（决定它放 units 还是屏内）？新 hook 住进 `src/hooks/` 了吗？
- [ ] 新引用用别名了吗？改别名是否 `vite.config.ts` + `tsconfig.json` 双处同步（含 `@x` 与 `@x/*`）？
- [ ] 有新决策/新坑吗？→ `docs/spec-notes.md` 留痕（编号接续，不要重复编号）
- [ ] 断言改了吗？**反证能变红吗？**条数写死了吗？
- [ ] 跑过 §3 里受影响的验收命令吗？真机验证项是否已如实标注为"未验证"？
- [ ] 提交信息说清「为什么」而不只是「改了什么」？关键节点是否独立成一个 commit？
