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
| 翻译引擎 | Node sidecar（默认 5003，**模拟实现**，真实模型未接） | `engine/` |
| 验收脚本 | 纯 Node 零依赖 | `scripts/` |
| 参考实现切片 | 只读参考，**保持原样不改** | `vendor/music-reference/`（不入库） |

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
npm run selftest:app[:refute] # B 组应用生命周期 12 条（含反证）
npm run e2e                   # D 组端到端
npm run check:ia              # IA 结构 24 条
npm run check:tls             # TLS 依赖链 14 条（三层）
npm run check:music[:refute]  # 音乐平台 / 心动模式 / 桌面歌词 / 逐字歌词 / 音频图 / 六皮肤 141 条 / 反证 96 条
npm run check:settings[:refute] # 设置页「播放·媒体」72 条 / 反证 15 条
npm run check:units[:refute]  # 前端分层 / hooks / 别名 / 状态 / 灵动岛 32 条 / 反证 38 条
cd app && npx tsc --noEmit && npx vite build   # 前端类型与构建
cd app/src-tauri && cargo build                # Rust（见 §5 环境陷阱）
```

> **改了断言覆盖的东西，就要同时更新断言**；搬迁文件尤其注意：
> **断言里写死的路径不同步，后果不是变红，而是静默跳过。**

## 4. 当前状态与已知缺口

- ver1.0（漫画翻译）**已完成**；ver2.0（设置页重构 + IA + 音乐模块）进行中，音乐模块四平台已接通。
- **未做**：打包分发（`bundle.resources` 为空，装出来的 `.app` 起不了服务，G-13）· 真实 `mangatranslator` 接入
  （现为模拟引擎，D-09）· 歌手详情 4 标签 / 评论翻页 / 卡拉OK YRC / 桌面歌词（PD-1 延后）。
- **未做真机验证**的项在台账里逐条标注（如 Radix 弹层观感、音频代理播放、皮肤观感）—— 别把
  "类型检查 + 断言通过"当成"功能可用"。
- 本仓库曾出现**同仓库并发写入**（另一个会话/窗口在改同一批文件，甚至把编辑器格式化后的引号风格一起提交）。
  动手前先 `git status` + `git log -1` 确认基线是谁的；改别人未提交的文件要 `git stash` 而不是 `git checkout --`（后者不可恢复）。

## 5. 环境陷阱（本机特有，踩过多次）

- **Rust 不在 PATH**：`PATH="$HOME/.cargo/bin:$PATH" cargo build`。
- **cargo 在沙箱里删不掉构建产物**：报 `failed to remove file ... build-script-build`。
  做法：先 `rm -f app/src-tauri/target/debug/build/*/build-script-build`，再前台构建。
- **`vite build` 需 `--no-emptyOutDir`**：本机沙箱拦截批量删 `dist/`（与代码无关）。
- **跑 e2e 要把临时目录挪到系统临时区**（安全删除守卫会拦仓库内 `.tmp-e2e/`）：
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
