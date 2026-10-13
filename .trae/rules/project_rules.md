---
description: 喵坞 MiaoDock 项目常驻规则：工作语言、工程纪律、目录分层、验收命令与提交规范。任何时候都适用。
alwaysApply: true
---

# 喵坞 MiaoDock · 项目常驻规则

**开工第一件事：读仓库根的 `AGENTS.md`**（它是本项目的完整协作上下文入口），
再按它的索引读 `docs/spec-notes.md`（决策与偏离留痕，`D-xx`/`G-xx` 编号）。
本文件只列**必须常驻遵守**的条款；与 `AGENTS.md` / `docs/spec-notes.md` 冲突时，以它们为准。

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
   ⚠️ **D-137 起新条目写 `docs/spec-notes-1.md`**（`docs/spec-notes.md` 已封卷于 D-136）；
   编号全局接续，动手前先 `grep "^## D-" docs/spec-notes*.md | tail -3` 确认最新编号。
8. **禁止内联长链三元**：`title={a ? 'x' : b ? 'y' : c ? 'z' : w}` 这类多级三元必须抽成**具名变量 / 早返回函数**
   （范式见 `screens/library/meta.ts` 的 `retranslateMeta` / `resumeMeta`），让每个分支可读、可单测。
9. **注释只描述功能**：说明"做了什么"即可；仅**核心改动**才追加"为什么"，且保持精简 —— 禁止大段复述代码。
10. **通用 UI 一律走 `components/units/`**：下拉命令菜单用 `MenuButton` + `MenuItem`、盒式提示用 `Notice`、
    按钮用 `Btn`；不在各屏自造同类 DOM / 样式（各屏业务样式件如列表项 / Tab / 卡片仍留屏内）。

## 3. 目录分层（《09》§2.2）

- `app/src/components/units/` = 通用 UI 单元，**判据：不 import 业务层**（store / ipc / types / platform / 根 hooks）。类名一律 `ui-` 前缀。
- `app/src/components/` = 应用级（Sidebar / Toolbar / ViewTabs / QuitConfirm）。
- `app/src/screens/<屏>/` = 屏内件。
- `app/src/tools/` = 共享纯函数（经 `@tools` 引入，与 `components/` 同级）：跨屏复用、**不 import 业务层**。
- **按「依赖什么」定归属，不按「被用几次」**。新组件先看它 import 什么，再决定放哪。
- 不要为了"复用"把绑定单屏几何/业务类型的件抽走（反面清单见 `docs/spec-notes.md` D-34）。

**目录约定（硬规则，全文见 `README.md` §目录 · `docs/spec-notes.md` D-79）**：

- **产品 / 验收分家**：验收脚本一律在 `e2e/`（按来源分子目录：`e2e/service/` · `e2e/engine/`）。
  判据不是"像不像测试"，而是**产品代码运行期会不会 fork 它** —— 会 fork 的
  （`engine/scripts/child-watch.mjs` · `engine/scripts/fetch-models.mjs`）留在原处。
  ⚠️ 启动配方打印器已于 A3b 退役（配方逻辑 Rust 化进 `boxsvc::engine`），故本清单只剩两项。
- **临时产物一律写进 `.tmp/<用途>/`**，**不得**在仓库根另起 `.tmp-xxx/` 或 `tmp-xxx/`。
- **新增 / 搬迁目录后必须同步**：`README.md` 目录节（唯一入口）· 本文件 · `AGENTS.md` §1 · `package.json` 命令 ·
  **断言里写死的路径**（不同步的后果是**静默跳过**，不是变红）· 脚本自己的用法注释。

**服务端模块目录（硬规则，ver2.2 起）**：`service/src/` 根**只留跨模块底座**
（`server.mjs` / `config.mjs` / `errors.mjs` / `engine-client.mjs` / `multipart.mjs` / `parent-watch.mjs`）；
业务域分子目录 `service/src/manga/`（漫画翻译：`store` / `image` / `names` / `sse` / `translate` 在线翻译）·
`service/src/settings/`（设置 / 档位 / 诊断：`engine-settings` / `engine-profile` / `model-status` / `idle-policy` / `tier-downgrade` / `llm-supervisor`）·
`service/src/music/`（音乐，服务端**占位**，逻辑在 Rust 侧 `app/src-tauri/src/music/`）。
🔴 **新增服务模块必须归入对应域目录**，不得平铺回 `service/src/` 根；只有**跨域共用**才上提到根。

## 4. 动手前后

- 动手前：`git status` + `git log -1` 确认基线；本仓库出现过**同仓库并发写入**，改别人未提交的文件要用 `git stash`，不要 `git checkout --`（不可恢复）。
- 收工前：跑受影响的验收命令（清单见 `AGENTS.md` §3），并在回复里如实区分「已验证」与「未做真机验证」。
- **搬迁/重命名文件时，同步更新断言里写死的路径** —— 不同步的后果不是变红，而是**静默跳过**。

## 5. 提交信息规范（ver2.2 起）

- 格式：`类型(模块): 功能简述 + 关键点简述`
  （例：`feat(manga): 在线翻译来源并入②翻译服务 + 来源分段控件与密钥落盘` · `refactor(service): 拆分 manga/settings 模块目录（music 占位）`）。
  - **类型**取 `feat` / `chore` / `fix` / `style` / `test`，或其他（如 `docs` / `refactor` / `perf`）。
  - **模块** = 改动主要落在的域：产品模块（`music` / `settings` / `manga`）· 层（`app` / `service` / `engine` / `e2e`）· `docs` 等。
  - `功能简述` 说"做了什么"；`+` 后的 `关键点简述` 列本次要点 / 坑（多项用 `+` 或 `·` 分隔）。
- 正文写清：**为什么要改**（问题/取证结论）、**改了什么**、**刻意没做什么与理由**、**验收结果**（哪几条断言、多少通过）。
- 不要把多个不相关节点塞进同一个 commit。
