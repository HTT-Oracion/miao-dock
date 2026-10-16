# 贡献指南

本文件写给**要改这个仓库的人**。产品怎么装、引擎怎么装配见 [`README.md`](README.md)；
目录分层的硬规则见 [`AGENTS.md`](AGENTS.md) §1（动目录之前先读它）。

## 一、动手之前

```bash
npm ci                  # 前端依赖（含 husky 钩子）
npm run app             # 起桌面端（真引擎；只跑前端用 MIAO_ENGINE_PROTOCOL=mock）
```

- **Node ≥ 20**、**Rust 工具链**（Windows 还要 MSVC 生成工具 + Windows SDK）。
- ⚠️ Windows 上编译必须在**带 MSVC 环境的终端**里跑（`vcvars64.bat`）。Cargo 依赖里
  `ring` 要现场编译 C 代码，普通 cmd/PowerShell 里会停在 `custom build command for ring`，
  而真正的错误（`fatal error C1034: stddef.h: 不包括路径集`）**印在 stdout 上**。
- 提交会过 `husky` 的 pre-commit：只对**暂存的**文件跑 `eslint --fix` + `prettier --write`。

## 二、提交规范

**格式**：`类型(模块): 一句话` —— **单行**。不列开发细节、不写文件清单、
不写「通过了 N 条断言」、不加句号、不用 emoji / `【】` / 列表。

**类型只用四个**：

| 类型 | 什么时候用 |
| --- | --- |
| `refactor` | 结构 / 命名 / 抽离（行为不变） |
| `chore` | 工具链引入、开源配套等非代码结构调整 |
| `style` | 纯格式化，无逻辑变化 |
| `docs` | 文档 / 台账 / 命令说明 |

**模块名**是一个小集合，便于 `git log --grep` 按层筛：
`repo`（仓库级配置与目录搬家）· `scripts`（命令收束）· `naming`（命名统一）·
`rust`（Rust 侧结构）· `app`（前端结构）· `router`（路由）· `oss`（许可与对外文档）·
`docs`（文档同步）。

**正文默认为空。** 唯一的例外：**引入新依赖的提交**必须补**一行**代价说明
（包数 / 体积 / 是运行时还是仅开发期）—— 这是本仓库「引入依赖必须写清代价」这条纪律的下限。

示例（都是真实的提交）：

```
refactor(rust): 命令注册下沉到子模块，main.rs 只留启动装配
refactor(naming): boxsvc 统一更名为 mangasvc
chore(oss): 补 MIT 许可与对外 README，内部文档归置到 docs/internal
docs: 同步文档、台账与命令说明

refactor(router): 引入 react-router，统一管理页面

代价：+react-router-dom@7，主 chunk 425.9→464.5 KB(minified)，运行时依赖（非开发期）
```

**两条硬要求**：

1. **每个提交自身可跑** —— 不留坏基线；目录搬家必须原子（一次提交搬完 + 同步全部写死路径）。
2. **纯格式化单独一个提交** —— 便于 `git blame` 跳过。

## 三、改完怎么验

```bash
npm run lint            # eslint（暂存钩子只查暂存文件，这里是全量）
npm run format:check    # prettier
npm run check           # 静态层：秒级、零依赖、不起进程
npm run check:full      # 再加服务层（真服务 + 假引擎）
npm run build           # tsc --noEmit && vite build
```

命令清单（120+ 条 check / selftest / 装配 / 反证轮）在根 `e2eScripts.json`；
`npm run task` 会列出全部条目，`npm run task -- <id>` 执行其中一条。
**细粒度命令不进 `package.json`** —— 那里只留三类入口（代码校验 / 启停打包 / 测试入口），
这条由 `check:registry` 的 `PKG.kept` 钉住。

### 关于断言与反证（本仓库最重要的一条纪律）

这个仓库的价值有一大半在「**断言是能被证伪的**」：每条源码级断言都配一条 `:refute` 反证轮
（把被测代码改坏 ⇒ 断言必须变红 ⇒ 按字节还原）。因此：

- **改断言锚点时，必须回改它的反证锚点**：反证锚点是「逐字复制源码」，
  源码一改锚点就找不到，此时脚本报的是**「跳过 ≠ 通过」**（非零退出），不是静默通过。
- **反证锚点优先用「删掉」而不是「注释掉」**：注释掉在 Rust 文本上会被 `stripComments`
  的边界情况吃掉，变成假阳性（该红没红）。
- **不许为了让某个脚本变绿而改断言或删条目** —— 先判断是「文档该更新」还是「实现漏了」。

## 四、目录与改名

- **按「依赖什么」定归属**：通用 UI 放 `src/components/units/`（判据：**不 import 业务层**）；
  跨组件共享状态放 `src/stores/`；与后端通信放 `src/ipc/`；音乐域整体留在 `src/music/`。
- **`src/` 内不写相对 import**，一律走别名（`@/…` / `@components` / `@screens` / `@music` /
  `@hooks` / `@tools`）。**加别名必须 `vite.config.ts` 与 `tsconfig.json` 双处同步**，
  且 `@x` 与 `@x/*` 成对。
- **新增 / 搬迁目录必须同步三处**：本文件上方的分层说明、`README.md` 的目录节、
  `.trae/rules/project_rules.md`；**外加断言里写死的路径**。
  🔴 路径不同步的后果不是变红，而是**静默跳过** —— 这是本仓库最容易踩的坑。

## 五、语言

代码注释、文档、提交信息、断言描述**一律中文**。注释写「为什么」而不是「做了什么」：
读得懂代码的人不需要第二遍叙述，需要的是当初为什么这么选、以及哪条路已经试过不行。
