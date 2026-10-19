---
description: 喵坞 MiaoDock 项目常驻规则：工作语言、工程纪律、目录分层、验收命令与提交规范。任何时候都适用。
alwaysApply: true
---

# 喵坞 MiaoDock · 项目常驻规则

**开工第一件事：读仓库根的 `AGENTS.md`**（它是本项目的完整协作上下文入口），
再按它的索引读 `docs/internal/spec-notes.md`（决策与偏离留痕，`D-xx`/`G-xx` 编号）。
本文件只列**必须常驻遵守**的条款；与 `AGENTS.md` / `docs/internal/spec-notes.md` 冲突时，以它们为准。

## 1. 语言

- 全中文：回答、代码注释（解释"为什么"而不只是"做了什么"）、提交信息、文档。
- **不得出现历史上那批被禁的品牌标识**（需要提及时一律写「参考实现」）。
  连规则条文本身也不写出它 —— 否则"全仓扫描无命中"会被规则文件自己污染。

## 2. 工程纪律（硬约束）

1. **断言必须可反证**：只跑正向等于没验证 —— 反证轮必须真的变红。条数写死并断言，**跳过必须非零退出**（跳过 ≠ 通过）。
2. **记忆不能当证据**：结论必须来自当前工作区的实际代码/文档；台账与实际不符时以实际为准，并回写台账。
3. **假阳性比没测试更危险**：长期全绿却从未抓到 bug 的断言，先怀疑它测错了东西。
4. **断言要覆盖所有层**：写完自问「如果这一层坏了，它会红吗？」
5. **不引入未经确认的新依赖**；引入时在提交信息与台账里写清代价（体积 / 包数 / 平台耦合）。
6. **关键节点独立 commit**，提交信息说明该节点内容与**为什么**；跨里程碑修正另起 `fix(...)`。
7. **非平凡决策与踩过的坑写进台账**（编号接续，勿重复占用编号）——
   这是跨工具、跨会话唯一能共享的记忆。
   ⚠️ **D-137 起新条目写 `docs/internal/spec-notes-1.md`**（`docs/internal/spec-notes.md` 已封卷于 D-136）；
   编号全局接续，动手前先 `grep "^## D-" docs/internal/spec-notes*.md | tail -3` 确认最新编号。
8. **禁止内联长链三元**：`title={a ? 'x' : b ? 'y' : c ? 'z' : w}` 这类多级三元必须抽成**具名变量 / 早返回函数**
   （范式见 `screens/manga/meta.ts` 的 `retranslateMeta` / `resumeMeta`），让每个分支可读、可单测。
9. **注释只描述功能**：说明"做了什么"即可；仅**核心改动**才追加"为什么"，且保持精简 —— 禁止大段复述代码。
10. **通用 UI 一律走 `components/units/`**：下拉命令菜单用 `MenuButton` + `MenuItem`、盒式提示用 `Notice`、
    按钮用 `Btn`；不在各屏自造同类 DOM / 样式（各屏业务样式件如列表项 / Tab / 卡片仍留屏内）。

## 3. 目录分层（《09》§2.2）

- `src/components/units/` = 通用 UI 单元，**判据：不 import 业务层**（store / ipc / types / platform / 根 hooks）。类名一律 `ui-` 前缀。
- `src/components/` = 应用级（Sidebar / Toolbar / ViewTabs / QuitConfirm）。
- `src/screens/<应用>/` = 屏层（屏入口 + 屏内件同目录，如 `manga/` 三屏 + `index.ts` 唯一出口）；域逻辑住 `src/modules/<应用>/`，两层同名是分层事实。
- `src/tools/` = 共享纯函数（经 `@tools` 引入，与 `components/` 同级）：跨屏复用、**不 import 业务层**。
- `src/router/` = 屏级路由（**URL 是「屏 + 应用内视图」的唯一事实源**）：`routes.ts` 是「路径 ↔ 屏」的事实源，`use-nav.ts` 是读写口，`index.tsx` 是装配，`panes/` 是屏装配件（经 `<Outlet context>` 取壳层数据，**不自己持状态**；翻译屏兼管让位守卫）。**新增屏要同时进路由表与 `src/stores/nav.ts` 的 IA 模型**。
- `src/stores/` = **跨组件共享状态的收口（非域）**：`nav` / `toastBus` / `shell-prefs`。**域内状态留域里** —— `src/modules/music/store.ts`（zustand）与 `src/modules/anime/store.ts` 不往这里搬。
- `src/ipc/` = 与后端通信（`ipc.ts` 命令 + `engine-download.ts`）；`src/types/` = 跨域类型与环境声明；`src/themes/` = 设计令牌与主题应用（🔴 令牌数值是**断言对象**，改它要同时看断言）。
- `public/assets/` = **公共资源（不经过构建，用绝对 URL 引）**：`fonts/`（三份清单由入口 HTML 的 `<link>` 加载）· `icons/`；`installer/` / `uninstaller/` = **安装器 / 卸载器程序**，各自**自成一体的独立工程**（自带 `package.json`（dev 端口 1444 / 1555）/ `vite.config.ts` / `tsconfig.json` / `src-tauri` 宿主 / `dist`，不并进主构建）：`index.html` 入口 · `src/`（安装引导三步 / 卸载页三态）· `public/assets/` 品牌图。判据是「**要不要过构建**」。
- 🔴 两个程序**彼此不许互相引用**，也**不 import 主工程源码**：令牌与共享纯函数在各自目录内持镜像副本（漂移代价写在文件头）；界面与外壳之间只有 `installer/src/host.ts` / `uninstaller/src/host.ts` 一个接缝，实时数据（两套默认目录 / 体积 / 长路径开关）由宿主探测注入，界面不写死数字。构建：`npm run task -- installer:build` / `uninstaller:build`。
- 🔴 **分发只有一个 exe**：`MiaoDock-Setup.exe`（安装器）。载荷（主程序 + 资源 + 卸载器）由 `npm run task -- install:pack` 打成 `installer/src-tauri/payload/payload.zip`，编译期 `include_bytes!` 嵌进安装器 ⇒ **构建顺序是硬约束**：卸载器宿主 → 打包载荷 → 安装器宿主（`npm run app:build` 一次串完主程序与套件，产物落仓库根 `release/`，已 gitignore）。安装范围决定 hive（全机 ⇒ `Program Files` + HKLM；仅为我 ⇒ `%LOCALAPPDATA%` + HKCU），卸载器住在安装目录里、删完自删。NSIS 钩子（`hooks.nsh` / `installerHooks`）已于 2026-10-18 退役。
- `src-tauri/src/` 根只留 `main.rs`（装配与启动）/ `lib.rs`，其余六域：`commands/`（IPC 命令层，**`handler()` 是唯一的命令注册点**）· `service/`（子进程生命周期）· `selftest/`（自检 + 截图取证）· `platform/`（跨平台底座）· `music/` · `mangasvc/`。
- **按「依赖什么」定归属，不按「被用几次」**。新组件先看它 import 什么，再决定放哪。
- 不要为了"复用"把绑定单屏几何/业务类型的件抽走（反面清单见 `docs/internal/spec-notes.md` D-34）。

**目录约定（硬规则，全文见 `README.md` §目录 · `docs/internal/spec-notes.md` D-79）**：

- **产品 / 验收分家**：验收脚本一律在 `e2e/`（按来源分子目录：`e2e/service/` · `e2e/engine/`）。
  判据不是"像不像测试"，而是**产品代码运行期会不会 fork 它** —— 会 fork 的留在原处。
  ⚠️ 产品主路径改走 Rust 后，那个脚本**降级为对照端**而非删除：
  启动配方打印器已于 A3b 退役，`child-watch.mjs` 于 A3c 降级（仍被 `llm-supervisor.mjs` 引用），
  `fetch-models.mjs` / `model-store.mjs` 于 **A3d** 降级（是 `check:models` 双靶的 Node 那一靶）。
  降级前必须 `grep` 确认还有谁引用，**以及它是不是某个双靶对拍的一半**。
- **临时产物一律写进 `.tmp/<用途>/`**，**不得**在仓库根另起 `.tmp-xxx/` 或 `tmp-xxx/`。
- **新增 / 搬迁目录后必须同步**：`README.md` 目录节（唯一入口）· 本文件 · `AGENTS.md` §1 · `package.json` 命令 ·
  **断言里写死的路径**（不同步的后果是**静默跳过**，不是变红）· 脚本自己的用法注释。

**服务端模块目录（硬规则，F5 起随实现搬进 Rust）**：原 Node 实现（`service/`）**已整目录删除**（D-209）——
产品运行时不再启动任何 node 服务进程，① 是 `mangasvc`（Rust 可执行）；② ③ 里的 node 只是**测试替身**。
服务端现住在 **`src-tauri/src/mangasvc/`**：外壳 `mangasvc.rs` · 路由表 `routes.rs` · 端点 `handlers.rs` ·
域模块 `store/`（队列落盘）· `library.rs`（库原语）· `translate/`（在线翻译）· `engine/`（引擎耦合点）。
🔴 **新增服务端点一律落在 `mangasvc/handlers.rs` + `routes.rs`**，由 `npm run task -- check:routes` 盯着
（`forwardedCount` 必须为 0 —— 只要还有转发分支，就说明还有第二条实现路径存在）。

## 4. 动手前后

- 动手前：`git status` + `git log -1` 确认基线；本仓库出现过**同仓库并发写入**，改别人未提交的文件要用 `git stash`，不要 `git checkout --`（不可恢复）。
- 收工前：跑受影响的验收命令（清单见 `AGENTS.md` §3），并在回复里如实区分「已验证」与「未做真机验证」。
- **搬迁/重命名文件时，同步更新断言里写死的路径** —— 不同步的后果不是变红，而是**静默跳过**。

## 5. 提交信息规范（对外开源改造轮起）

- 格式：`类型(模块): 一句话` —— **单行**；不列开发细节、不写文件清单、不写「通过了 N 条断言」、不加句号、不用 emoji / 列表。
  - **类型**：`refactor`（结构 / 命名 / 抽离）· `chore`（工具链引入、开源配套等非代码结构调整）· `style`（纯格式化，无逻辑变化）· `docs`（文档 / 台账 / 命令说明）· `fix`（跨里程碑修正，见 §2 第 6 条）。
  - **模块**（小集合，便于 `git log --grep` 按层筛）：`repo` · `scripts` · `naming` · `rust` · `app` · `router` · `oss` · `docs`。
- 正文默认为空；**唯一例外**：引入新依赖的提交补**一行**代价说明（包数 / 体积 / 运行时还是仅开发期）。
- 全文与正反例见 `CONTRIBUTING.md` §二；⚠️ 更早的历史提交用的是旧格式（`功能简述 + 关键点简述`，类型含 `feat` / `test`）—— **不改历史**。
- 不要把多个不相关节点塞进同一个 commit；**每个提交自身可跑**（不留坏基线）；**目录搬家必须原子**；**纯格式化单独一个提交**。
