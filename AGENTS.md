# AGENTS.md — 喵坞 MiaoDock 协作规范

> 本文件是 AI 编程工具进入仓库后的唯一入口，只保留项目概况、不可违反的规则和常用工作流。
> 详细设计与历史决策以仓库文档和当前代码为准；不要把本文件扩写成第二份设计文档。

## 1. 信息源与语言

- **工作语言：中文**；代码标识符除外。
- 事实源：`README.md`、`docs/internal/dev-plan.md`、`docs/internal/spec-notes*.md` 与当前代码。
- 决策记录发生冲突时，优先参考 `docs/internal/spec-notes*.md`，核对实际代码后再更新文档。
- 决策台账：`docs/internal/spec-notes.md` 与 `docs/internal/spec-notes-1.md` 同权。新增条目先确认全局最新编号；D-137 起写入 `spec-notes-1.md`，编号不得重复。

## 2. 项目概况

喵坞 MiaoDock 是基于 Tauri v2 的桌面应用，包含漫画翻译、番剧和音乐功能。

| 层 | 技术 / 职责 | 主要位置 |
|---|---|---|
| 桌面宿主 | Tauri v2、Rust | `src-tauri/` |
| 前端 | Vite、React 18、TypeScript、原生 CSS | `src/` |
| 漫画服务 | Rust 可执行文件 `mangasvc` | `src-tauri/src/mangasvc/` |
| 番剧服务 | 独立 Rust 可执行文件 `animesvc` | `src-tauri/src/animesvc.rs`、`src-tauri/src/animesvc/` |
| 翻译引擎接缝 | 版本锁、模型下载、子进程管理；真实引擎安装在用户数据目录 | `engine/`、`src-tauri/src/mangasvc/engine/` |
| 音乐 / 番剧前端域 | 域状态、动作、IPC、纯函数 | `src/modules/music/`、`src/modules/anime/` |
| 验收脚本 | Node 自测与端到端检查 | `e2e/` |
| 安装 / 卸载器 | 独立工程，不依赖主工程源码 | `installer/`、`uninstaller/` |

`engine/src/` 是测试替身，不是真实翻译引擎。产品运行期不启动 Node 服务；漫画服务与番剧服务是独立进程。

## 3. 架构约束

### 前端

- `src/components/units/` 放通用 UI 单元，不得依赖业务层；通用组件使用 `ui-` 类名前缀。
- `src/components/` 放应用级组件；`src/screens/<应用>/` 放屏入口和屏内组件；`src/modules/<应用>/` 放域逻辑。
- 所有 `use*` Hook 统一放在 `src/hooks/`；共享纯函数放 `src/tools/`。
- `src/stores/` 只放跨域共享状态；域内状态留在对应模块。
- 跨组件共享状态使用 Zustand；不引入 React Context。局部状态仍使用 `useState`。
- `src/router/routes.ts` 是屏级路由事实源。新增屏时同步更新路由表和 `stores/nav.ts` 的 IA 模型。
- `src/` 内引用使用路径别名；新增或修改别名时同步更新 `vite.config.ts` 与 `tsconfig.json`，并同时配置 `@x`、`@x/*`。
- 设计令牌位于 `src/themes/`；修改令牌前检查相关断言。
- 通用 UI 优先复用 `components/units/`；仅服务单屏的业务样式和逻辑留在屏内。

### Rust 与服务

- `src-tauri/src/` 根部只保留启动装配与库根等必要入口；业务实现按域归档。
- 新增 Tauri 命令必须登记在 `src-tauri/src/commands/mod.rs` 的 `handler()` 中；保持单处 `generate_handler!` 展开，并使用项目现有的 `tauri::Wry` 运行时签名。
- 新增漫画服务端点时，同时更新 `mangasvc/handlers.rs` 与 `mangasvc/routes.rs`。
- 产品代码改为 Rust 后，Node 脚本可能只承担对照测试职责；**不得因其看起来过时就直接删除**。先检查引用与断言覆盖。
- 安装器和卸载器是独立工程：彼此不引用，也不导入主工程源码。两者与主程序之间只通过各自的 `installer/src/host.ts`、`uninstaller/src/host.ts` 接缝交换宿主探测结果。

### 目录与产物

- 产品代码与验收代码分开：产品运行期会启动的脚本留在产品目录，其余验收脚本放 `e2e/`。
- 临时产物统一写入 `.tmp/<用途>/`，不要在仓库根创建其他临时目录。
- 新增或搬迁目录后，检查并同步 `README.md` 目录说明、本文、`.trae/rules/project_rules.md`、命令清单及断言中写死的路径。
- 安装包对外交付物是 `release/MiaoDock_<版本>_<架构>-setup.exe`。版本从 `src-tauri/tauri.conf.json` 读取，不得在脚本中写死。
- 发布构建使用 `npm run app:build`；安装器打包前必须先构建主程序，构建顺序见 `docs/internal/` 中的安装与打包说明。

## 4. 必须遵守的工程纪律

1. **以当前代码为准。** 记忆和旧文档不能代替检查；发现台账与实现不一致时，核实后更新台账。
2. **断言必须可反证。** 修改或新增断言时，说明“破坏什么会导致哪条断言失败”，并实际运行反证轮。反证锚点未命中不能算通过。
3. **禁止假绿与静默跳过。** 断言数量应有明确基准；跳过项必须显式报告，必要时以非零退出码结束。
4. **覆盖实际依赖层。** 用户可见行为依赖多个层时，不能只验证最上层；逐层确认故障能否触发失败。
5. **关键节点独立提交。** 提交信息使用单行格式 `类型(模块): 一句话`，不加 emoji、句号或文件清单。常用类型：`refactor`、`chore`、`style`、`docs`、`fix`。
6. **记录非平凡决策。** 将设计选择、兼容约束和真实踩坑写入 `docs/internal/spec-notes-*.md`，新增条目按全局编号续写。
7. **未经确认不引入依赖。** 确需引入时，在提交信息和决策台账中说明包数、体积及是否属于运行时依赖。
8. **注释保持精简。** 描述功能即可；仅对跨文件契约、易踩坑或反直觉实现补充原因。不要复述代码或记录操作流水账。
9. **避免长链内联三元。** 多层条件表达式改为具名变量或早返回函数。
10. **不重复造轮子。** 写新组件、新工具、新命令前先确认同类实现是否已存在；能扩展既有实现的，不另起一套。项目已有通用按钮、下拉菜单、模态、提示、进度环、日志块等单元，已有共享纯函数与检查入口；确有新需求且无法复用时，说明理由并遵循既有目录与命名规范。
11. **遵循既有命名与分层。** 不恢复已退役实现，不绕过现有模块边界或检查入口。

## 5. 常用检查命令

```bash
# 前端与代码格式
npm run lint
npm run format:check

# 日常静态检查
npm run check

# 按当前 Git 变更选择检查
npm run check:changed

# 完整检查；提交 / PR 前运行
npm run check:full

# 全量检查，包含 nightly 与反证轮
npm run check:nightly

# 查看可派发的检查任务
npm run task

# 执行单个检查任务
npm run task -- <id>

# 修改 Rust bin 路径下的 anime / commands 等代码后
cargo check --bin miao-dock

# 发布构建
npm run app:build
```

检查任务清单与详细说明以根目录 `e2eScripts.json`、`e2e/_check-registry.mjs` 及脚本自身为准。不要在本文件复制每个检查的断言数量、反证细节或历史原因；这些内容应留在对应脚本、验收报告或决策台账中。

- 命令清单与断言条数：[`docs/internal/commands.md`](docs/internal/commands.md)
- 自测怎么写、什么改动该不该写测试：[`docs/internal/test-policy.md`](docs/internal/test-policy.md)
- 本机环境陷阱与历史决策：`docs/internal/spec-notes*.md`

## 6. 开工与交付清单

开始前：
- [ ] 检查 `git status`、`git log -1`，确认当前分支、工作区和并发改动。
- [ ] 确认改动所属层，复用现有组件、Hook、状态和 IPC 边界。
- [ ] 阅读相关实现、测试和决策记录，不只依赖本文件摘要。

完成前：
- [ ] 更新受影响的代码、断言、命令注册和文档路径。
- [ ] 对新增或修改的断言执行正向与反证验证。
- [ ] 运行与改动范围匹配的检查；未执行的真机验证必须明确标注。
- [ ] 将非平凡决策写入台账，并按约定拆分提交。

## 7. 外部方案文档

部分历史方案文档位于仓库外，可能无法在其他机器访问。若无法访问，优先以仓库内 `docs/` 和当前代码为准，并在决策台账中记录缺失情况。修改外部方案文档时，不要随意调整既有章节编号，因为代码注释可能引用这些编号。
