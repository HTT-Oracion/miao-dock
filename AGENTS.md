# AGENTS.md —— 本仓库的 AI 协作上下文（唯一入口）

> 本文件是**任何 AI 编程工具**（WorkBuddy / Trae / Cursor / CodeBuddy…）进入本仓库时的**第一份必读**。
> 它是入口与硬约束，不是完整事实源：**完整事实源 = `README.md` + `docs/dev-plan.md` + `docs/spec-notes*.md`**。
> 冲突时，以 `docs/spec-notes*.md`（裁定与偏离留痕）为准，并把结论回写到本文件所在仓库。
>
> 📌 **台账已分流**：`docs/spec-notes.md`（D-01~D-136）+ `docs/spec-notes-1.md`（**D-137 起新增写这里**）。
> 两者同权；新增前先 `grep "^## D-" docs/spec-notes*.md | tail -3` 确认最新编号（规则详见续篇文件头）。

**工作语言：中文**（注释、提交信息、文档一律中文；代码标识符除外）。

---

## 1. 项目是什么

**喵坞 MiaoDock · Box 桌面端** —— 本地漫画翻译服务的宿主与可视窗口，外加一个音乐应用（ver2.0）。

| 层 | 技术 | 位置 |
|---|---|---|
| 桌面壳 | Tauri v2（Rust） | `app/src-tauri/` |
| 前端 | Vite + React 18 + TS，**原生 CSS + CSS 变量**（无 Tailwind；UI 库仅 `@radix-ui/react-select`） | `app/src/` |
| 翻译服务 | Node（127.0.0.1:5180–5190） | `service/` |
| 翻译引擎 | **接缝层**：真引擎装在 `<appData>/runtimes/manga-translator/`（不在库，B1 起与安装位置无关），本目录放版本锁 `VERSIONS.lock` / 模型清单与下载器 / 子进程看守；`engine/src/` 是**测试替身**（mock 引擎 + mock LLM） | `engine/` |
| 验收与取证脚本 | 纯 Node 零依赖（`e2e/service/`、`e2e/engine/` 按来源分） | `e2e/` |
| 参考实现切片 | 只读参考，**保持原样不改** | `vendor/music-reference/`（不入库） |

**目录约定（硬规则，全文与理由见 `README.md` §目录 · `docs/spec-notes.md` D-79）**：

- **产品 / 验收分家**：判据不是"像不像测试"，而是**产品代码运行期会不会 fork 它**。会 fork 的留在原处
  （`engine/scripts/fetch-models.mjs` 等），其余全部在 `e2e/`。搬迁脚本时**按来源分子目录**以保住相对深度（`service/scripts/x` → `e2e/service/x`）。
  ⚠️ **反向也成立**：产品主路径一旦改走 Rust，那个脚本就**降级为对照端**——
  `print-launch-plan.mjs` **已退役**（配方收进 `boxsvc::engine::build_launch_plan`，A3b）；
  `child-watch.mjs` A3c 起降为**对照端**（产品主路径换 `boxsvc --child-watch`，但 `service/src/settings/llm-supervisor.mjs` 仍 import 它 ⇒ **不许删**）；
  `fetch-models.mjs` 与 `model-store.mjs` A3d 起**同样降为对照端**（产品主路径换 `boxsvc --fetch-models`，但它们是 `check:models` / `check:engine-settings` 的**双靶另一边** ⇒ **不许删**）。
  🔴 **降级 ≠ 删**：删之前先 `grep` 还有谁引用。A3b/A3c/A3d 处置不同就是这条的三种结果。
  🔴 **降级后仍必须同步改**：对照端是"同一契约的另一实现"，产品侧改了字段/参数而对照端没跟上 ⇒ 双靶对拍会**红**，红才是对的。
- **临时产物一律写进 `.tmp/<用途>/`**（`e2e/` · `selftest/` · `models/` · `engine-test/`），**不得**在仓库根另起 `.tmp-xxx/` / `tmp-xxx/`。
- **新增或搬迁目录后必须同步**：`README.md` 目录节（唯一入口）· 本节分层表 · `.trae/rules/project_rules.md` ·
  `package.json` 命令 · **断言里写死的路径**（不同步的后果是**静默跳过**，不是变红）· 脚本自己的用法注释。

**目录分层（硬规则，见《09》§2.2）**：

- `app/src/components/units/` —— 通用 UI 单元。**判据：不 import 业务层**（store / ipc / types / platform / `@hooks` 整个目录 / nav）。类名一律 `ui-` 前缀。
- `app/src/components/` —— 应用级组件（Sidebar / Toolbar / ViewTabs / QuitConfirm）。
- `app/src/screens/<屏>/` —— 屏内件（`library/blob.ts`·`library/chapters.tsx`·`library/modals.tsx`、`settings/parts.tsx`、`music/shared.tsx`）。
- `app/src/hooks/` —— **hooks 唯一收口**：`use*` 命名的 hook 一律住这里（业务 hook 进桶文件 `index.ts`，经 `@hooks` 引入；纯行为 hook 如 `useEsc`、`useCoverColor` 单放同目录）。旧的 `src/hooks.ts` 单文件**不得**与目录并存 —— 模块解析会**静默二选一**（`HOOKS.layout` 盯死）。
- `app/src/tools/` —— **共享纯函数收口**（与 `components/` 同级，经 `@tools` 引入）：跨屏复用、与业务类型解耦的小工具（格式化 / 分页 / 模糊匹配 / UUID / MIME 嗅探 / 重名规范化 …）。只服务单个屏的逻辑仍留屏内。
- **按「依赖什么」定归属，不按「被用几次」定归属。** 抽离规则与反面纪律（什么**不**该抽）见 `docs/spec-notes.md` D-34 与《09》§2.2。

**服务端模块目录（硬规则，ver2.2 起，见 `docs/spec-notes.md` D-101）**：

- `service/src/` 根**只留跨模块底座**：装配入口 `server.mjs` · `config.mjs` · `errors.mjs` · `engine-client.mjs`（引擎适配，唯一耦合点）· `multipart.mjs` · `parent-watch.mjs` · `atomic-file.mjs`（原子写 JSON，跨 manga/settings 复用；D-139）· `image.mjs`（图片字节嗅探，D-141 从 `manga/` 上移）。
  方向由 `npm run check:layering` 机器核查：**除装配入口 `server.mjs` 外**，底座层不得 import `manga/**`；对 `settings/**` 的导入仅限 `engine-settings.mjs`（`config` 作为组合根读用户设置的唯一入口）。
- **按业务域分子目录**：`service/src/manga/`（漫画翻译：`store` 队列落盘 · `library` 本→话→页落盘原语 · 库扫描/视图 · 寻址（`resolveComicDir`/`resolveBookDir`/`resolveChapterDir`/`mustChapterDir`，`root` 由宿主注入）（D-115/D-145/D-147）· `names` · `sse` · `translate` 在线翻译：契约 / 注册 / 门面 / http / sse-parse / limiter / 设置 / 密钥 / `platforms/youdao`）· `service/src/settings/`（设置 / 引擎档位 / 诊断：`engine-settings` · `engine-profile` · `model-status` · `idle-policy` · `tier-downgrade` · `llm-supervisor`）· `service/src/music/`（音乐：逻辑主要在 Rust 侧 `app/src-tauri/src/music/`，服务端此目录为**占位**）。
- 🔴 **新增服务模块必须归入对应域目录**，不得再平铺回 `service/src/` 根；**只有跨域共用**才允许上提到根。
- 搬迁 / 新增后必须同步：**断言里写死的路径**（`e2e/` 下大量 `path.join(ROOT,'service','src',…)`，不同步的后果是**静默跳过**）· 模块内相对导入 · 本节分层 · `README.md` 目录节 · `.trae/rules/project_rules.md`。

**引用一律走路径别名（2026-10-04 起）**：`@`（src 根）· `@tauri`（src-tauri，预留）· `@components` · `@screens` · `@music` · `@hooks`；**`app/src` 内不写相对 import**（含 CSS/SVG 副作用导入；同目录 `./` 仍可用）。规则全文见《09》§2.3 与 `docs/spec-notes.md` D-40。增改别名**必须 `vite.config.ts` 与 `tsconfig.json` 双处同步**，且 TS 侧每个别名要**同时**有 `@x` 与 `@x/*` 两条。

**状态管理统一 zustand**：跨组件共享状态一律 zustand（`@music/store` 是先例），**不引入 React Context**（全仓 `createContext` 为零，维持此状 —— `STATE.noReactContext`）。注意它管的是**跨组件共享**，不是"所有状态都塞进全局"：只需一处持有或仅父子一层传递的照旧 `useState`。理由见《09》§2.3.3 与 `docs/spec-notes.md` D-42。

**前端 `app/src/music/` 按层分文件（D-156，与 §1 服务端域目录同思路）**：`store.ts`（zustand 装配：`MusicState` 接口 + 初始 state + 切片 spread，647 行）· `actions/*.ts`（12 个 action 段切片，工厂签名 `Pick<MusicState, ...keys>` 显式列名）· `convert.ts`（纯转换：`songKey`/`fmtTime`/`coverProxyUrl`/`localToSong`/`qualityLabel`）· `prefs.ts`（偏好层：`Prefs` + `savePrefs`）· `persist.ts`（localStorage 读写 + 启动恢复快照，D-153）· `slice.ts`（切片公共件：`StoreSet`/`StoreGet` + 跨段常量）· `tools/lyrics.ts`（歌词解析，D-149）。
🔴 **切片文件与 `store.ts` 不得互相 import 值**（`MusicState` 等类型可 type-only）—— 被多段共用的东西一律先下沉到上面某个分层文件，否则成环。判据源已改成「`store.ts` + `music/actions/*.ts`」动态拼接，新增切片不必改断言。

## 2. 工程纪律（本项目硬性要求，不得绕过）

1. **交付物必须自证，断言必须可反证。** 只跑正向等于没验证 —— 反证轮必须真的变红才算数。
   新增/修改断言时，同时给出「破坏什么 → 哪一条变红」。
2. **记忆不能当证据，要回读代码/文档。** 结论必须来自当前工作区的实际内容；台账与实际不符时以实际为准，并回写台账。
3. **假阳性比没测试更危险。** 一条断言长期全绿却从未抓到过 bug，先怀疑它测错了东西。
   比率型指标会吞掉分母变化：**断言条数要写死并断言，跳过必须非零退出**（跳过 ≠ 通过）。
4. **断言要覆盖"所有层"，不能只测最上面那层。** 写完先自问：**「如果这一层坏了，它会红吗？」**
   用户能感知的行为常横跨 JS 判定层与原生前提层，只测上层时下层坏掉照样全绿。
5. **关键节点独立 commit**，提交信息说明该节点内容；跨里程碑修正另起 `fix(...)`，不混入。
6. **所有设计/实现决策与踩过的坑，记入 `docs/spec-notes*.md`**（`D-xx` = 决策/陷阱，`G-xx` = 待裁定缺口）。
   ⚠️ **D-137 起新条目写 `docs/spec-notes-1.md`**（原文件已 5700+ 行）；编号全局接续，勿重复占用。
   **在本仓库做的任何非平凡决定，都要落在这里** —— 这是跨工具、跨会话唯一能共享的记忆。
7. **不引入未经确认的新依赖。** 确需引入时，在提交信息与台账里写清代价（体积/包数/平台耦合）。
8. **不得出现历史上那批被禁的品牌标识**（本项目已彻底清除，需要提及时一律写「参考实现」）。
   ⚠️ 连**规则条文本身**也不写出它 —— 否则"全仓扫描无命中"这条纪律会被规则文件自己污染
   （本项目已有先例：断言脚本里就是用「被禁的历史品牌标识」指代的）。
9. **提交信息格式（ver2.2 起）**：`类型(模块): 功能简述 + 关键点简述`。
   - **类型**取 `feat` / `chore` / `fix` / `style` / `test`，或其他（如 `docs` / `refactor` / `perf`）。
   - **模块** = 改动主要落在的域：产品模块（`music` / `settings` / `manga`）· 层（`app` / `service` / `engine` / `e2e`）· `docs` 等。
   - `功能简述` 说"做了什么"；`+` 后的 `关键点简述` 列本次要点 / 坑（多项用 `+` 或 `·` 分隔）。
   - 例：`feat(manga): 在线翻译来源并入②翻译服务 + 来源分段控件与密钥落盘` · `refactor(service): 拆分 manga/settings 模块目录（music 占位）` · `chore(app): 版本号升到 2.1.0 + 五处版本文件同步`。
10. **禁止内联长链三元。** 形如 `title={a ? 'x' : b ? 'y' : c ? 'z' : w}` 的多级内联三元必须抽成
    **具名变量或早返回函数**（范式：`screens/library/meta.ts` 的 `retranslateMeta` / `resumeMeta` 返回
    `{ title, sub, blocked }`），让每个分支可读、可单测。
11. **注释只描述功能。** 注释写"做了什么"即可；**只有核心改动**（跨文件契约 / 易踩坑 / 反直觉处）
    才追加"为什么"，且保持精简。禁止大段复述代码或写流水账。
12. **通用 UI 一律复用 `components/units/` 单元。** 下拉命令菜单用 `MenuButton` + `MenuItem`、
    盒式提示用 `Notice`、按钮用 `Btn` —— 不在各屏自造同类 DOM / 样式。
    各屏**业务样式**件（列表项 / Tab / 卡片 / 看板单元等）仍留屏内，不强套通用件（归属判据同 §3）。
13. **自测统一走 `e2e/run-checks.mjs` 聚合入口；新检查必须登记进 `e2e/_check-registry.mjs`。**
    日常 `npm run check`（static 快闸门）/ `check:changed`（按 git 变更过滤，跳过项显式列出）；
    push 前 `check:full`；定期 `check:nightly`（含全部反证轮）。
    🔴 **service 层恒串行**：各脚本从**固定且互相重叠的端口区间**（5300–5800）「先探测再绑定」
    抢端口，并行会交叉污染出假结果——这是正确性问题，不是性能问题，宁慢不串。
    漏登记的后果是「静默消失在分层之外」（该红没红），由 `check:registry` 双向覆盖断言把守。

## 3. 验收命令（改完必须跑，绿色才算交付）

```bash
# —— 自测聚合入口（分层 + 并行 + git 变更过滤；注册表在 e2e/_check-registry.mjs）——
npm run check                # static 快闸门 16 项（8 路并行，约 10s）——每次提交
npm run check:changed        # 只跑与 git 变更相关的（static+service；跳过项显式列出）——日常开发主力
npm run check:full           # static + service 全量（service 串行，约 4 分钟）——push / PR 前
npm run check:nightly        # 全量：含 nightly（真引擎/模型）与全部反证轮——定期 / 合并前
npm run check:registry[:refute] # 注册表完整性 **5** 条 / 反证 **5** 变异（npm 检查脚本 ↔ 注册表双向覆盖 + 文件存在 + tier 合法 + id 唯一 + **各层条数 == 写死的常量**）。🔴 最后那条是 E4 的计数门：删一条钉子、或把它的 tier 写错，输出依旧全绿而**没有任何一行会变红** —— 分子变绿、分母变小；把分母钉住，减一条就得先改常量（反证 M5 正是"删一条注册项"）
npm run selftest              # A 组服务契约 159 条 + 引擎自测 23 条
npm run selftest:app[:refute] # B 组应用生命周期 16 条（含 S2a–S2d：五态轨迹 / E1 参数快照 / 三子进程 / 崩溃分级；含反证）
npm run selftest:app:e11[:refute]     # E11 三进程树回收（mock，秒级）：SIGKILL 主进程 → 13 端口全释放
npm run selftest:app:e11:real         # 同上但**真进程**（python+执行器+llama-server，14 端口）· 分钟级
npm run check:launch-plan[:refute] # S2/A3b 启动配方契约 25 条 / 反证 6 条（**被测对象已从 node 打印器换成 Rust `--print-launch-plan`**；含与 probeEngine 同源断言 + ③ 归属移交的 P-llm-*；反证含形参传反/env 不压差量/watch 消失/归属退回 manager 四类静默失效，末尾**重编译**以免留下坏产物）
npm run check:child-watch[:refute]   # 外部二进制父死看守**双靶**取证 3 条（秒级；真模式 E11 的唯一依赖）。A3c 起双靶：Node 原版 + Rust `boxsvc --child-watch`；Rust 靶用**产品同源 Rust 父** `boxsvc --child-watch-parent`（用 node 当父测的是产品里不存在的场景 ⇒ 会得出「E11 失效」的错误结论）。含 W2 接线错误防护（父没攥住 stdin 管道时不得自杀）。反证轮**只判 Rust 靶**，Node 靶按结构跳过并标注原因
npm run check:child-watch-kill[:refute] # child-watch Windows killTree 无条件 /F **双靶源码钉** 2 条 / 反证 2 条（不起进程；D-89 崩溃路径孤儿执行器）。判据**先 stripComments** —— 注释里主动写出了被禁写法
npm run e2e                   # D 组端到端
npm run check:ia              # IA 结构 32 条（含 C8d：侧栏两套几何 58×52 / 44×44 随标签形态成对切换）
npm run check:tls             # TLS 依赖链 14 条（三层）
npm run check:quit[:refute]   # 「退出喵坞」根因钉子 5 条 / 反证 5 条（源码级：quit_app 必须 async / reap 有界 / CREATE_NO_WINDOW / 前端不静默 / Windows signal_tree 无条件 /F；不起进程）
npm run check:autostart[:refute] # 翻译服务「自动启动 / 手动启停」根因钉子 18 条 / 反证 19 条（源码级：start_once 幂等 / service_stop 必须 async 且补发 emit / main.rs 启动收进测试通道 / 自动启动 effect 依赖不含 status / 未就绪屏 stopped 给「启动」/ 设置页启停行 / 服务实现默认档 = Rust（E1–E5）/ Cargo.toml `default-run` 指向真实 bin（F1）；不起进程；D-94 · D-168 · D-169）
npm run check:engine-client[:refute] # 翻译引擎适配层 50 条 / 反证 12 条（真协议用 openapi 快照「假引擎」，秒级）。⚠️ L4 要引擎**真装在默认落点**（`<appData>/runtimes/manga-translator/`）—— 两种对齐方式：① 把仓库 `runtimes/manga-translator` 用 **junction** 链到默认落点（零拷贝、`rmdir` 即可摘，别复制 15 GB）；② 一次性覆盖 `MIAO_RUNTIME_ROOT=<repo>/runtimes`（B1）
npm run check:retry[:refute]  # 队列「重试」任务身份：复用**同一** taskId（不冒历史行）+ 翻译方向（白名单/落库/送到引擎/重试继承） 10 条 / 反证 7 条（mock 引擎 + 真服务子进程，秒级）
npm run check:lib-manage[:refute] # 漫画库管理取证：队列删除（仅终端态可删）/ 隐藏与恢复 / 越界名 403 / 前端接线 / 新建（manifest 同步落盘 + 同名 409）/ 归并（在跑拒绝 + NN_第N话 物理移动 + episodes 回写）/ 封面（嗅探命名 + json 同步）/ 话号一位小数（14.1 落位与寻址 + 两位小数/.0 拒绝）16 条 / 反证 8 条（mock 引擎 + 真服务子进程，秒级）
npm run check:retranslate[:refute] # 单张漫画返工重译 + 全屏缩放快捷键：返工**覆盖**译文（塞假译文验真被顶掉）/ 不碰原图 / 与 resume 分工 / 裸 ↑↓ 不缩放（不抢音量键）12 条 / 反证 5 条（mock 引擎 + 真服务子进程，秒级）
npm run check:models[:refute] # S3 模型下载器 E7 **双靶**：37 条 × 2 靶 = 正向 **74** / 反证 6 × 2 = **12**（本地 Range 夹具源，秒级，不碰真权重；含 HF 缓存布局 blobs+snapshots+refs）。A3d 起两靶同跑：Node 对照端 `fetch-models.mjs` + Rust `boxsvc --fetch-models`（**产品主路径**）。🔴 反证开关走**子进程 env** —— 进程内 `process.env` 只管得住 Node 靶 ⇒ Rust 靶永远绿，是最坏的假绿
npm run check:engine-patches[:refute] # 上游源码补丁表（ENGINE_PATCHES）↔ 实物一致性 **+ 产品侧只读镜像双靶交叉钉** 7 条 / 反证 6 条（零网络零 GPU：条数写死 / 结构 / marker 命名 / 目标存在 / 已应用 / 补丁体自含 marker / **A7 Rust 镜像与 SSOT 的 id/mark/rel/desc 同序同值**）。🔴 A4/A5 看的是**产品落点** `<appData>/runtimes/manga-translator/src`（B1）；本机引擎装在别处时用 `MIAO_MODEL_ROOT=<...>/manga-translator` 重跑
npm run check:extract-atomic[:refute] # **D3 原子解包**（修 D-95 待修项）6 条 / 反证 3 条（真 `tar` + 夹具归档：**失败时 `destDir` 一个字节都不动**、失败后**不留 `.part`**、成功才换（旧内容 rename 走）、上次中断的 `.part` 不干扰本次）。🔴 判据必须**跑失败路径**：旧写法（`fs.rmSync(destDir)` 在前、`tar` 在后）在源码里长得几乎一样，只有跑出来才看得见"旧目录已被删掉"。反证 M1 就是**改回旧写法** ⇒ W3 红）
npm run check:pydensecrf-wheel[:refute] # **B4 预编译 wheel 通道** **11** 条 / 反证 **6** 条（`engine/wheels.manifest.json` 结构合法（64 位 sha256 形态 + **`local` 与 `url` 二选一互斥**："尚未托管"必须说出来）· 走产品自己的出口 `install-engine-deps.mjs --print-plan` 判定四态：**命中且哈希对得上 ⇒ 走 wheel** / 哈希不符 ⇒ **拒绝并回退** / 文件不在盘上 ⇒ 回退 / 只有别的平台条目 ⇒ 回退 · **只读模式（`--print-plan` / `--wheel-entry`）不受平台闸门限制**（macOS 用户也要能问与算哈希；默认调用与 `--build-wheel` 仍被拒） · 两份安装引导都写了这条通道）。🔴 **回退是前提不是降级**：清单为空必须仍能装。反证：去掉哈希比对 / 去掉平台过滤 / 命中也返回 source / 去掉只读旁路 / 给未托管条目补 url / 摘掉 local 又不给 url ⇒ 各自红）
npm run check:pydensecrf-wheel-install # **B4 真装一次**（nightly 层）5 条：硬前置是有 `--build-wheel` 产出的 wheel（没有 ⇒ **失败并点名该命令**，"跳过 ≠ 通过"）；`pip install --no-index --no-deps` 成功 ⇒ **自足、不联网、不触发编译**（这比"换一台没有编译器的机器"更强）· 装出来的是**真二进制**（PE/ELF/Mach-O 魔术头，不是 `.py` 冒充）· `import` + 构造 `DenseCRF(10,10)` + 枚举成员在（产品的兼容补丁在 wheel 产物上同样成立）· wheel 文件名 tag 与产品自报的 `platform`/`pythonTag` 一致
npm run check:offline-fallback[:refute] # **C4 离线兜底** 9 条 / 反证 3 条（夹具夹具清单 + `url` 指向**不可达地址**：权重未预置 ⇒ 配方**不**注入 HF 离线键（否则堵死首次下载）；已预置 ⇒ 注入 `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE`；`--link` 零网络重建**引擎真要打开的那条路径**（`<root>/src/<linkTo>` + HF 的 `snapshots/<rev>/<file>` + `refs/main`）；清掉链接 ⇒ 立刻未就绪，而 **store 那一路始终全绿**（两层判据真的分层，R6 的陷阱正是它））。🔴 **取证边界**：真引擎在断网下真加载那一步要真权重，归 nightly；本脚本证明的是它的上游条件。反证：恒不注入 / 忽略逃生开关 / 不写 `refs/main` ⇒ 各自红）
npm run fetch:models          # S3 模型下载器 CLI **Node 对照端**（开发机用）：--check 只校验 / --link 只重建引擎树里的链接（零网络）。⚠️ **产品运行期跑的是 `boxsvc --fetch-models`**
npm run check:profile[:refute] # S4 档位映射 / 加速后端 / 降档 / 空闲卸载（判定层）43 条 / 反证 14 条（起真进程，约 10s）
npm run check:e5e6[:refute]    # S4 端到端 E5/E6：真服务 + 真引擎 + 真 ③，16 条 / 逃生开关反证 3 条（约 60s）
npm run check:contract[:refute] # S5 契约增量：9 键 sidecar / 未就绪 vs 不可用 / 模型缺失 / /engine/status，77 条（8 个实例场景 A–H）/ 逃生开关反证 4 条（各约 3s / 2s）
npm run check:translate[:refute] # ver2.2 在线翻译服务（有道智云）：签名 v3 / 四层超时 / 限流 / 三层设置 / 密钥隔离 / 契约适配器 / 5 路由端到端 54 条 / 反证 8 开关（假上游冒你有道——默认发真 SSE 帧，零网络秒级；D-129/D-130）
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
npm run check:music[:refute]  # 音乐平台 / 播放模式五档 / 心动模式 / 播放列表入口与抽屉 / 桌面歌词 / 逐字歌词 / 逐字整行模式 / 翻译歌词 / 演唱行 / 高亮同步 / 滑块填充 / 音频图 / 音乐缓存 / 六皮肤 / 队列 / 歌曲右键菜单 / 灵动岛歌词卡 / 启动恢复 / 音乐快捷键 / 窗口 WebView2 参数 228 条 / 反证 212 条
npm run check:settings[:refute] # 设置页「播放·媒体」+「翻译服务」+ ② 分组简洁化 + 运行状态卡（日志零点击可见）+ X-C3「准备中」时间线 + ④ 功能梳理（侧栏标签开关 / 存储占用拆三行 / 第三方许可清单 / 行内 def）+ 盒式提示内边距 + 正文首选字体（源柔ゴシックP）+ 组说明/blurb 缺省不渲染（自守）+ **C5 许可清单的引擎/模型段** + **D4 运行时实况行** **183** 条 / 反证 **138** 条。⚠️ 本轮顺手修掉三条**基线就红的陈断言**（A3d 把 `scriptExists` 改名 `runnerExists`、`ExpandedPlayer` 从 `MusicScreen` 搬到 `App.tsx` 后没同步；以及 `NOTREADY.wiring.modeDegraded` 判的是"文件里出现过 `status?.mode`"，而它出现两处 ⇒ 摘掉 chip 也不红）—— 一条**永远绿不了**的断言比没有更坏：它占着"这条已覆盖"的位置，反证轮还会把"仍然红"当成"按预期变红"
npm run check:units[:refute]  # 前端分层 / hooks / 别名 / 状态 / 灵动岛 / 看图缩放 / 样式分层 45 条 / 反证 59 条
npm run check:bundle[:refute] # 打包配置钉子 **13** 条 / 反证 **18** 条（平台分叉：Windows 走 nsis、基座仍 macOS 专有；W5 判据取**配置**：`bundle.resources` 不得含 `service/` 与 `node.zip` ——「文件不在」是永远绿的空断言，因 `vendor/node.zip` 从未存在；**W6** 必需资产条目在**且** src 文件真实存在；**W7/W7b（C5）随包 0 个模型权重** —— 后缀黑名单 + 与 `models.manifest.json` **逐条交叉**，且显式断言"清单读到了、资产名非空"（否则交叉判据是空断言）；**W8–W11（E2/E3）NSIS 安装器钩子** —— 接线指向真实 `.nsh`、长路径只读检查（`SetRegView` + `ReadRegDWORD` + 给命令，**不许 `WriteRegDWORD` 替用户改 HKLM**）、卸载提示**默认保留**（`MB_DEFBUTTON2` 且 `RMDir` 出现在 `IDYES` 之后）且不碰作品目录、Windows 引导写明 SmartScreen 与长路径；**W12** 每个 `MessageBox` 之前必须有 `IfSilent` 守卫 —— NSIS 的弹窗在 `/S` 静默模式下**照样弹并阻塞**，后果不是变红而是 `check:packaged` 的静默安装/卸载**永远不返回**。源码级，不起进程）
npm run check:macos-compat[:refute] # **D7 macOS 兼容** 11 条 / 反证 4 条（解释器推导**函数体内**两个平台形态都在（⚠️ 判据限定在函数体：单测里也有同样的字面量，全文件搜会被它骗）+ 实跑 `--print-paths` 的形态与当前平台一致且不串 + 检测侧与 `--print-launch-plan` 的 `cmd[0]` 逐字节相同；**Windows 专用脚本在非 Windows 下真的拒绝**（`MIAO_PLATFORM=darwin-arm64` 接缝 ⇒ exit 2 + `PLATFORM_UNSUPPORTED` + 指向 macOS 引导 + **不含 `ENOENT`**），且守卫必须早于任何 `fs`/`spawn`；文档分平台（macOS 引导里每次 `deps:engine` 都在"不能用"的语境里）；`unverified` 记账在位）。🔴 真机验收归 macOS 机器）
npm run check:macos-signing[:refute] # **E1 macOS 签名 + 公证** 8 条 / 反证 4 条（`entitlements.plist` 四项必备且**都为 true**、**不含 app-sandbox 键**（判据只看键：注释里正讨论着"刻意不加它"）· `tauri.conf` 接线（`hardenedRuntime` + `entitlements` 指向真实文件）· 打包前自检三种形态：**缺变量 ⇒ 非零退出并逐个点名**（缺公证三件套时 tauri 会**跳过**公证而不是报错 ⇒ 包装得上、跑不起来）/ `MIAO_NOTARIZE=0` ⇒ 放行但**告警"不得对外分发"** / 变量齐 ⇒ 放行 · `sign:preflight` 注册且 `app:build:mac` 串上了它 · `unverified` 记账）。🔴 **落点已变**：F5 + B1 之后引擎运行时在 `~/Library/Application Support/runtimes/…`，**包内几乎无可执行对象**；"对 `Contents/` 内所有可执行逐个签名"没有对象了，多出来的是"带 hardened runtime 的父进程能否拉起用户自装的未签名 python/llama" —— 只能真机答，标 `unverified`）
npm run check:resources[:refute] # 随包资源寻址 **A1/A2** 三环境取证 8 条 / 反证 4 条（dev 态不误报且来源=repo · 打包齐备来源=resource · 打包缺失报 `RESOURCE_MISSING` 且退出码≠0 · 两边都有时资源目录优先 · 必需资产三处事实源交叉验证 · S1/S2/S3 源码钉）。🔴 dev 态与打包态**必须都跑**：只跑 dev 态**永远绿**（资产就在仓库里，打包态的错测不出来），只跑打包态会把 dev 态误判成缺失
npm run check:packaged[:refute] # **A4 打包后冒烟**（mock 档，nightly 层）9 条 / 反证 2 条按预期红。三层取证：**安装层**（NSIS `/S /D=` 静默安装；exe 与 `engine/models.manifest.json` 在、`service/` 与 `node.zip` 不在）→ **资产层**（`boxsvc --check-assets` ok=true）→ **服务层**（`/health` 200 + mock 替身 + 清单路径落在安装目录内 + `--print-launch-plan mock` 的 `mode=mock`）。🔴 **不起 GUI 而起 release `boxsvc`**：无头环境 GUI 必失败 ⇒ 时红时绿比没有更坏。🔴 反证轮必须**同时切断 `MIAO_REPO_ROOT` 回退**，否则删了包内资产也会从旁边仓库读到 ⇒ 假绿
npm run check:runtime-probe[:refute] # **B2/B5 引擎运行时就绪检测** 44 条 / 反证 4 条（`GET /api/v1/engine/runtime`；五项 `venvRoot`/`python`/`source`/`deps`/`patches` 逐项独立翻转 + `detail` 必带绝对路径 + 缺补丁点名到 patch id + mock 档不 warn + **运行时根是 junction 时三项 env 判定全穿过链接**）。🔴 **只 warn 不 fail**：mock 档不该有真引擎（30+ 个 e2e 靠它）；real 档的硬门归 `check:launch-gate`（D6）
npm run check:path-single-source[:refute] # **B3 检测与启动同源** 5 条 / 反证 1 条（`/engine/runtime` 的 `python.path` vs `boxsvc --print-launch-plan` 的 `engine.cmd[0]` **逐字节**比对；天然覆盖 Windows `venv\Scripts\python.exe` 分叉）。反证：检测侧手拼 `venv/bin/python` ⇒ 红
npm run check:launch-gate[:refute] # **D6 real 档启动前预检闸门** 8 条 / 反证 3 条（`service.rs::start_blocking` 在 spawn 之前调 `runtime_probe::gate_message(mode)`：real+未就绪 ⇒ **一个子进程都不起**、秒级返回 `L0` 失败并逐项点名（含缺哪个补丁的 patch id 与绝对路径）；mock 档不过闸；real+就绪放行）。**G5 源码钉**：`gate_message(` 调用位置必须早于 `spawn_spec(&plan.engine`（CLI 全绿 ≠ 产品接了线）。反证：恒放行 / 删 mock 旁路 / 删闸门调用 ⇒ G5 红；收尾双文件字节还原
npm run check:install-guide[:refute] # **D5 分平台安装引导**与产品对拍 16 条 / 反证 5 条（`docs/install-guide-{windows,macos}.md`：落点**模板代入本机后逐字节** == `boxsvc --print-paths` 推出的落点、且写在第一条安装命令之前 · 体积标记 `<!-- install-guide:size platform=… bytes=… -->` == 清单按平台求和且正文数字一致（清单路径取自 `--print-paths` 的 `modelManifest`）· 五项就绪项全覆盖 · 三条落点纪律（别挪/别放同步盘/别放临时目录）· 平台解释器形态互不串 · 文档里的 `npm run X` 都存在）。🔴 **诚实的取证边界**：另一平台的 appData 分支本机只能对**同源镜像表**（镜像表自身由当前平台对真二进制钉住）⇒ macOS 侧真机验收归 **D7**。反证：改落点/改体积/改清单副本/串平台形态/删就绪项 ⇒ 各自红在**指定的那条断言**上（红在别的断言上是假反证）
npm run check:notready-state[:refute] # **D1「运行时未装配」独立成态** 13 条 / 反证 5 条（`GET /engine/status` 与 Tauri 命令 `service_status` **两条链路**都带 `runtime` 块 —— HTTP 那条在"服务起来了但引擎没装"时能用，进程内那条在"一个子进程都没起"（D6 闸门）时仍能答 · **四句 L1–L4 文案逐字冻结**（取自《02》§3）· 新分支**不混进 L1 失败**（`summaryOf` 里不许出现它的措辞）且在时间线之前 `return` · 「约 X GB」来自服务端 `requiredBytes`，界面里没有写死的 GB 数字）。反证：改 L1 文案 / 条件改 `if (false)` / 标题塞进 `summaryOf` / GB 写死 / 删 `service.rs` 的赋值 ⇒ 各自红在指定的那条断言上
npm run check:models-guide[:refute] # **D8 模型引导清单**（渲染而非编写）14 条 / 反证 4 条（`boxsvc --engine-model-files` 的逐条清单 ⟷ **Node 侧独立算**的期望：id/顺序/目标**绝对路径**（有 `linkTo` 的落在 `<root>/src/<linkTo>`，不是 `<root>/<dest>`）/平台适用性（与**下载器**同判据）/`sizeBytes` 原样转发 · 就绪 = 在位**且大小一致** · 三个聚合布尔与逐条**算自同一份判据** · **自证变异**：改夹具清单一条 `dest` ⇒ 输出跟着变（D-178 的"不能两边写死同一常量"）· 前端 `EngineDiag` 真的渲染了这份清单）。反证：`dest` 分支写死 / 就绪判据退化成"在就算好" / `linkTo` 分支丢掉 `<root>/src` 那一层 / 删前端渲染 ⇒ 各自红在指定的那条断言上
npm run check:size-guide[:refute] # **C1 体积与落点如实告知** 16 条 / 反证 3 条（`GET /engine/status` 的 `guidance` 块：`totalBytes` == 清单里**本平台可见条目**的 `sizeBytes` 求和（逐字节，且与 D1 的 `requiredBytes` 是**同一个数**）· 分档位（`visual`/`translation`/`llm`/`runtime`）之和**恒等于**总量 —— 表外档位追加在末尾、不属于任何 `set` 的条目归 `unassigned`，都不许从表里消失（丢一条 = 用户少下一块）· 与安装引导文档的体积标记**三方闭环**（文档 ⟷ 服务端 ⟷ 清单）· 界面只做单位换算，代码里没有写死的 GB 数字）。**自证变异**：改夹具一条 `sizeBytes` ⇒ 总量与对应档位跟着变（D-178 纪律）。反证：总量写死 / 分档只留第一档 / 删前端引导区块 ⇒ 各自红在**指定的那条断言**上
npm run check:platform-guide[:refute] # **C3 `llama-server` 按平台分化** 12 条 / 反证 3 条（`MIAO_PLATFORM` 取证接缝下**两个方向都真跑**：win32-x64 下引导清单只出现 `win32-x64` 的 runtime 条目、darwin-arm64 下（镜像）只出现 mac 条目、两边 runtime 档都非空；**引导侧与下载器给同一个答案**（同一条 `platform_matches`）· `guidance.platform` 跟随接缝 ⇒ 报告说得出"这次是假装成谁跑出来的"。反证：平台判据恒 true / 引导侧另写一份判据 / 下载器 set 分支丢掉过滤 ⇒ 各自红）
npm run check:progress-truth[:refute] # **D2 进度只来自真实来源** 10 条 / 反证 3 条（跨三层：① 数据源 —— `state.rs` 的 tail 只推**读到的行**、`\\r` 覆盖式进度也算分隔符；② 取值 —— `lastLogLine()` 取末个非空行原样返回、**没有就不显示**；③ 渲染 —— 没有行时整块不渲染，且代码里**不存在**占位数字）。反证三层各一：推送编造的行 / `lastLogLine` 加占位兜底 / 去掉"没有就不渲染"的守卫 ⇒ 各自红）
npm run check:model-runner[:refute] # **C2 校验/建链执行体随包定位** 12 条 / 反证 3 条（真起服务读 `/engine/status.modelDownload.runner`：默认值 == **当前可执行文件自己**且**是绝对路径** —— 相对路径在本机能跑、装完就没，判据必须含 `path.isAbsolute`，否则"cwd 恰好是仓库根"会把差异掩盖成**假绿** · `POST /engine/models/verify` 用它真的跑得起来（200 + 结构化结果，**不是 INTERNAL**）· 执行体不在盘上 ⇒ INTERNAL **且消息里带路径** · `--link` 收尾零网络跑通 · **跨卷**降级为复制并**单独记账**在 `cross_device`，跨卷且复制也失败时错误消息出现「跨卷」）。🔴 **台账 C2 的落点已过期**：它写在 A3d 之前（执行体还是 `node fetch-models.mjs`），A3d 之后"随包"的最优形态是 `current_exe()`。反证：默认执行体改成仓库相对路径 / 跨卷判定恒 false / 删 CLI 打印跨卷 ⇒ 各自红在**指定的那条断言**上
npm run check:resilience[:refute] # box-service 健壮性钉子 9 条 / 反证 14 条（源码级：R1–R7 顶层未捕获异常兜底（走同一 shutdown / 收 ③ / 重入闸 / 非零退出）· A1–A2 任务状态原子写（store 走 atomicWriteJson · tmp→fsync→rename）；不起进程；内存变异反证；D-138/D-139）
npm run check:layering[:refute] # service 依赖方向钉子 3 条 / 反证 3 条（源码级：L0 底座文件集 == 白名单 · L1 底座不得 import manga/** · L2 底座对 settings/ 仅限 engine-settings.mjs；装配入口 server.mjs 豁免；不起进程；内存变异反证；D-141）
npm run check:docs            # 文档 ↔ 实现一致性 17 条（条数对账 / 命令存在 / 禁词 0 命中 / GROUPS 覆盖）
# —— F 组「服务 Rust 化」的同源对拍钉子（F0–F5 已全部 ☑，见 docs/packaging-local-engine-dev-plan.md）——
#    每组都**双靶子**跑同一份断言：`MIAO_SERVICE_IMPL=node` 吃 `service/src/server.mjs`，
#    `=rust` 吃 `target/debug/boxsvc`。⇒ `service/src/*.mjs` 虽已从**产品运行时**摘除，
#    但作为这七组的**对照端**必须保留；删它 = 连带作废全部对拍（不是"顺手清理"）。
npm run check:paths[:refute]    # F2 路径解析与 `config.mjs` **逐字节**对拍 5 条 / 反证 5 条（`boxsvc --print-paths` 对拍；含 `normalize_lexical` 与 `assert_inside_root` 两处真缺陷的回归钉；**PATH.appData** B1 落点 + **PATH.tooling** 装配脚本同源）
npm run check:store[:refute]   # F3 任务库内核同源对拍 24 条 / 反证 24 条（🔴 serde 字段**声明序**必须逐字复刻 Node `serialize()` 键序；`Option` 保留 `undefined`→省略键；`Vec` 保插入序）
npm run check:store-exec[:refute] # F3-b 执行/队列同源对拍 74 条 / 反证（7 场景**连定义都单源**；🔴 `itemErrors` 必须比 —— 「总预算耗尽」与「单请求超时」`reason` 同为 `engine_engine_timeout`，只有 `errorMessage` 能分开）
npm run check:engine-parity[:refute] # F4 引擎纯协议/配方层同源对拍 24 条 / 反证（`resolve_engine_launch` 走 `python main.py` 非 `-m server.main`；三条少一个键真机必挂的启动 env 都在 Rust 复刻）
npm run check:engine-http[:refute]  # F4-b1 引擎 HTTP 运行期同源对拍 18 条 / 反证（伪引擎服务器喂帧；三条：`.no_proxy()` · **空闲**超时非总时长 · 超时携带部分字节）
npm run check:llm-supervisor[:refute] # F4-b2 ③ supervisor 同源对拍 4 条 / 反证（起**真** `mock-llm` 子进程；两条：两层锁否则诊断排在 180s `start()` 后 · 探针同步不走 reqwest）
npm run check:harness[:refute] # F0 双靶子 harness 7 条 / 反证（`MIAO_SERVICE_IMPL=node|rust` 同断言；未知取值必须**吵一声**否则「两边都绿」其实是 node 跑了两遍）
npm run check:routes[:refute]  # F5 路由表 / 转发计数 9 条（`--final` 10 条 = 完成门）/ 反证 4 条（44 条全 `Tier::Migrated`、**转发数 = 0**；反证 M1 真跑 `--list-routes` + `MIAO_ROUTE_REFUTE` 注入假转发 ⇒ 完成门报「仍有 N 条转发」变红）
npm run check:docpaths[:refute] # 现行文档引用的仓库路径必须真实存在 5 条 / 反证 2 条（查 AGENTS/README/spec-notes-1/dev-setup/project_rules；spec-notes.md 已封卷于 D-136，历史路径明确不查；源码级，内存变异反证；D-158）
npm run sign:preflight         # **E1 macOS 打包前自检**（`app/scripts/mac-signing-preflight.mjs`）：entitlements 四项就位 + 签名/公证变量齐。🔴 缺变量就**非零退出**：缺 `APPLE_SIGNING_IDENTITY` 会产出 ad-hoc 签名的包（本机不报错、别人机器上被拦）；缺公证三件套时 tauri 会**跳过**公证而不是报错 ⇒ 包装得上、跑不起来。本机自用打包请显式设 `MIAO_NOTARIZE=0`
npm run app:build:mac          # macOS 打包 = **自检 + tauri build**（"写进构建脚本"= 打包路径上真的会跑；`app:build` 仍是不带自检的通用入口）
docs/dev-setup.md              # 新人上手：环境 / 装依赖 / 跑检查 / 五个最容易踩的坑 / 代码地图（D-158）
docs/distribution-license-conclusion.md # **E5 分发许可结论**（工程侧事实清单 + 三档结论（自用可 / 对外待法务 / 含 NC 权重禁止）+ 待法务复核三项 + 发布 checklist + 判据索引）。🔴 **对外分发的前置门**：结论未出不得对外分发；它不是法律意见
cd app && npx tsc --noEmit && npx vite build   # 前端类型与构建
cd app/src-tauri && cargo build                # Rust（见 §5 环境陷阱）
```

> **改了断言覆盖的东西，就要同时更新断言**；搬迁文件尤其注意：
> **断言里写死的路径不同步，后果不是变红，而是静默跳过。**

## 4. 当前状态与已知缺口

- **ver1.0（漫画翻译）已完成**；**ver2.0（设置页重构 + IA + 音乐模块）已完成** —— 音乐模块四平台已接通，
  桌面歌词 / 逐字歌词 / 评论等已落地。真正剩下的只有**打包分发**（G-13）与若干**真机未验证项**。
- **翻译引擎接入 S0–S8 全部完成**：S0 环境闸门（G1 ✅）· S1 适配层（D-62）· S2 三进程生命周期（D-64…D-70）·
  S3 模型管理（D-72）· S4 档位/加速/降档/空闲卸载（D-73）· S5 契约增量（D-74）·
  **S6 Box UI 引擎诊断视图（D-75）· S7 真机端到端 E1–E11（D-76）· S8 插件串联（D-77）**。
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
  Rust 只从配方里取命令文本用于**打印**（E1 参数快照），拉起/停止由 `service/src/settings/llm-supervisor.mjs` 负责。
  E11（不留孤儿）靠 `child-watch` 包一层保住 —— **改这段前先读 D-73 决策 1**，漏改一处就是"两个 llama-server 抢 8080"。
  🔴 A3c 起该层是 `boxsvc --child-watch`（Rust）；`service/src/settings/llm-supervisor.mjs` 仍走 `child-watch.mjs`（Node 对照端）—— **两处都要改，否则一半的 ③ 不受 E11 保护**。
  🔴 父死判定是**双通道**（stdin 管道 + ppid/进程身份）且**"判不出来" ≠ "父死"**，改任何一条前先读 D-172。
  ⚠️ 父侧必须给 `Stdio::piped()` + `MIAO_CHILD_WATCH_PIPE=1` 并**攥住 `ChildStdin`**（`_watch_keepalive`）——
  少任一条，看守器拿不到权威判据，E11 静默失效。
- **模型资产管理（S3）**：`engine/models.manifest.json`（版本控制）是唯一清单 —— 来源 / sha256 / 大小；
  `boxsvc::engine::model_store` 负责下载（断点续传 / 逐文件 SHA256 / 失败单文件重下 / `.ready` 幂等 / 传输中断一次重下），
  CLI 是 `boxsvc --fetch-models`（**A3d 起为产品主路径**；`engine/model-store.mjs` + `engine/scripts/fetch-models.mjs` 保留为**双靶对照端**）。
  🔴 有意差异：Rust 版**不实现** `AbortSignal` —— 产品跑的是 CLI，「暂停」的真实形态就是杀进程，`.part` 留下即断点。
  🔴 **权威副本在 `<appData>/runtimes/manga-translator/models-store/`，引擎源码树 `src/models/` 里那几份只是硬链接** ——
  因为引擎把模型路径硬编码在自己源码树里（`utils/inference.py:94` + `utils/generic.py:24-25`，且
  `server/args.py` 没有 `--model-dir`）⇒ **换引擎版本后跑 `npm run fetch:models -- --link` 即可零网络恢复**，
  不必重下几个 GB。链接只占一份盘。
  🔴 B1 起这套资产的**落点与安装位置无关**（`<appData>/runtimes/manga-translator/`）；装配脚本
  （`setup-engine` / `install-engine-deps` / `fetch-models`）共用 `engine/scripts/runtime-root.mjs`，
  与产品 `paths::runtime_root()` 同源，由 `check:paths` 的 `PATH.tooling` 钉住。
- 🔴 **一条容易说错的现状**：引擎栈模式由 `MIAO_ENGINE_PROTOCOL` 决定，**默认 `real`** ——
  也就是说 `npm run app` 起的**已经是真引擎**（`python main.py` + `llama-server`），
  模拟引擎只在测试里被显式注入（`selftest.mjs` / `e2e.mjs` / `lifespan-selftest.mjs` / `capture.mjs`）。
  ⇒ **本机没拉引擎（运行时目录不在）时，产品链路起不来**；缺哪一项由 `GET /api/v1/engine/runtime` 逐项报出（B2），
  而不是一句 `Connection error`。
- **打包分发的"能做完的部分"已做完**（2026-10-14 一轮）：随包资源与寻址（A1/A2）· 打包后冒烟（A4）·
  装配脚本去 node（A3b–A3d）· 就绪检测五项（B2/B5）· 路径单源（B1/B3）· 体积与落点如实告知（C1/C2）·
  **`llama-server` 按平台分化（C3）** · **离线兜底（C4）** · **许可边界钉在分发物上（C5：随包 0 权重 + 许可清单含引擎/模型段）** ·
  首启成态（D1/D5/D6/D8）· **进度只来自真实来源（D2）** · **原子解包（D3）** · **设置页运行时实况（D4）** ·
  **Windows 侧长路径提示 + SmartScreen 说明（E2）** · **卸载时提示引擎资产、默认保留（E3）** · **计数门（E4）** ·
  **分发许可结论（E5）** · **pydensecrf 预编译 wheel 通道（B4）**。
  🔴 **只剩真机与法务两类**（都不能在本机完成）：**D7 macOS 真机**（含 `unverified`：带 hardened runtime
  的父进程能否拉起用户自装的未签名 python / `llama-server`）· **E1 macOS 真机签名 + 公证**
  （配置、entitlements 与打包前自检都已就位并有钉子，但"从 dmg 装完引擎能起"只能真机验）·
  **E5 的三项法务复核**（`docs/distribution-license-conclusion.md` §4）。⇒ **结论未出不得对外分发**。
- Windows 侧**已能产出 NSIS 安装包**（`app/src-tauri/tauri.windows.conf.json` 平台分叉，`npm run check:bundle` 钉住；macOS 包型仍 `app`+`dmg`，未动），
  A4 起**已能在真实安装产物上冒烟**（`npm run check:packaged`：静默安装 → `--check-assets` → 起服务打 `/health` + mock 替身 + 启动配方）；
  引擎运行时本身**不随包**（用户自装，B1/B2）· Windows **进程树回收三项**
  （仍 `unverified`：Job Object / 无孤儿 `llama-server.exe` / `taskkill /T`；注：Windows **真引擎装配 + S1 已真机跑通**，见 D-85）·
  **汽水音乐平台**（PD-1，延后；代码保留不排首批）· **评论翻页**（当前只拉第 1 页 20 条）·
  **歌手详情第 4 标签**（当前仅网易云，专辑/MV/简介 三标签）。
  ⚠️ 旧版此处写的「S6 诊断 UI / S7 / S8 未做」与「卡拉OK YRC / 桌面歌词延后」**均已过期** ——
  桌面歌词（`lyrics_window.rs` + `screens/lyrics/DesktopLyrics.tsx`）与卡拉OK 逐字歌词（`screens/music/KaraokeLyrics.tsx`）**均已实现**。
- **未做真机验证**的项在台账里逐条标注（如 Radix 弹层观感、音频代理播放、皮肤观感）—— 别把
  "类型检查 + 断言通过"当成"功能可用"。
- **CI 已接入**（`.github/workflows/ci.yml`，v2.2.1 起；D-140）：ubuntu + macos 双平台跑
  **源码级检查 + `npm run selftest` + 判定层（e8/e4/e10）+ 前端 tsc/build**。
  真机门（cargo release 打包 / 真权重 E3·E7 / E11 real）**不进常规门**。
  ⇒ 改断言/改模块目录后，本地跑绿**还不够**，必须让 CI 也绿才算交付。
- 本仓库曾出现**同仓库并发写入**（另一个会话/窗口在改同一批文件，甚至把编辑器格式化后的引号风格一起提交）。
  动手前先 `git status` + `git log -1` 确认基线是谁的；改别人未提交的文件要 `git stash` 而不是 `git checkout --`（后者不可恢复）。

## 5. 环境陷阱（本机特有，踩过多次）

- **Rust 不在 PATH**：`PATH="$HOME/.cargo/bin:$PATH" cargo build`。
- **（Windows）编译 Rust 侧必须在带 MSVC 环境的终端里**：依赖树里 `ring` 要现场编译 C，
  `cl.exe` 靠 `INCLUDE` / `LIB` 找头文件与库。在**没跑过 `vcvars64.bat` 的 shell**里构建，会停在这两行：
  `error: failed to run custom build command for ring ... (exit code: 2)`，而 cargo 打印的 `--- stderr` 段**是空的**
  （真正的诊断 `fatal error C1034: stddef.h: 不包括路径集` 走的是 **stdout**）⇒ 只看 stderr 会误判成 ring 坏了。
  做法：用「x64 Native Tools Command Prompt for VS 2022」，或手工导出 `INCLUDE` / `LIB` 后再跑。
  这与 `npm run app`（dev）还是 `npm run app:build`（release）无关 —— 两者都要编译 ring。
- **cargo 在沙箱里删不掉构建产物**：报 `failed to remove file ... build-script-build`。
  做法：先 `rm -f app/src-tauri/target/debug/build/*/build-script-build`，再前台构建。
- **`vite build` 需 `--no-emptyOutDir`**：本机沙箱拦截批量删 `dist/`（与代码无关）。
- **跑 e2e 要把临时目录挪到系统临时区**（安全删除守卫会拦仓库内 `.tmp/e2e/`）：
  `MIAO_E2E_TMP="$(node -e 'console.log(require("os").tmpdir())')/miao-e2e" npm run e2e`
- **同步 spawn（`execFileSync` / `spawnSync`）在本环境直接 EBUSY**（实测 2026-10-13）：
  异步 `spawn` 却完全正常。e2e / 工具脚本里要调子进程（含 git 查询）一律用异步 spawn ——
  别图省事写同步版：症状是一句莫名的 `EBUSY` 而非缺 PATH 的 ENOENT，极难排查。
  已被 `run-checks.mjs` 的 `capture()` 与全部子进程执行路径覆盖。
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
- [ ] 有新决策/新坑吗？→ `docs/spec-notes-1.md` 留痕（D-137 起；编号全局接续，不要重复编号）
- [ ] 断言改了吗？**反证能变红吗？**条数写死了吗？
      ⚠️ 判据若要"切出一段源码"来检查，**切点不能用被测特征本身**（会被反证带着跑掉 ⇒ 假阳性）——
      用结构上恒定、反证改不动的标记（如「第二个 `return (`」）。此类缺陷正向轮恒绿，只有反证轮抓得到。
- [ ] 跑过 §3 里受影响的验收命令吗？真机验证项是否已如实标注为"未验证"？
- [ ] 提交信息说清「为什么」而不只是「改了什么」？**格式是 `类型(模块): 功能简述 + 关键点简述` 吗**（§2 第 9 条）？关键节点是否独立成一个 commit？
