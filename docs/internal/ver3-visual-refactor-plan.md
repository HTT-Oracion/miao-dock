# ver3.0 视觉与交互升级 · 变更影响面分析

> 本文件是 ver3.0 改造的**执行清单与边界说明**。
> 设计输入：`miao-dock-design/refactor_ver3.0/`（`design.html` 的 Design Tokens 与
> `styles.css` / `theme.css` / `theme-music.css` 的页面样式）。
> 兜底依据：`miao-dock` 现有实现（状态机、路由、IPC、设置目录）。
> **番剧模块零改动**：不改 `src/screens/anime/**`、`src/modules/anime/**`、
> `src-tauri/src/anime/**`、`src-tauri/src/animesvc/**`、`src/styles/anime.scss`
> 及番剧设置数据；只有全局外壳与公共单元会换上新的视觉令牌。

## 1. 视觉基线

### 1.1 色彩

| 语义 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| Background | `#F6F8F9` | `#111820` | 应用底色 |
| Surface | `#FFFFFF` | `#18222C` | 内容卡、侧栏底板 |
| Surface 2 | `#F1F5F7` | `#1E2A34` | 次级底、输入框、轨道 |
| Ink | `#2D3B46` | `#EDF3F7` | 标题与主文字 |
| Text | `#55646F` | `#B9C7D1` | 正文 |
| Muted | `#7E8D98` | `#8798A5` | 辅助信息 |
| Line | `#E5EBEF` | `#25333E` | 分隔与描边 |
| Primary · 雾蓝 | `#6E97B9` | `#85ADCE` | 漫画模块、主推进 |
| Accent · 杏奶 | `#DFA47D` | `#E3B08A` | 音乐模块、强调标记 |
| Sage · 鼠尾草 | `#8CA88C` | `#9BB89A` | 设置模块 |
| Danger | `#C97D73` | `#D9968C` | 错误与破坏性动作 |
| Warning | `#BE8A57` | `#D2A36E` | 部分失败、限流提示 |
| Success | `#6F9A83` | `#8FB69F` | 完成、健康 |

规则：紫 / 薄荷 / 粉 / 高饱和黄**不得**作为 UI 主色或状态色；渐变只用于 Hero、
空态与进度，不铺满页面；玻璃只用于浮层（侧栏、弹窗遮罩、灵动岛、桌面歌词）。

### 1.2 形状、阴影与动效

- 圆角阶梯：`9 / 12 / 16 / 20 / 26 / 32 / 999`。
- 阴影：`shadow-1` 静态卡片，`shadow-2` 浮层；不使用发光边框。
- 动效令牌：`--miao-ease-spring: cubic-bezier(.22,1.3,.36,1)`；
  `--miao-ease-out: cubic-bezier(.16,1,.3,1)`；
  `fast 140ms` / `base 240ms` / `slow 380ms`。
- 令牌命名约定：`--md-*` 是既有底层调色板（被规格自检与既有分片引用，保持兼容）；
  `--miao-*` 是 ver3 语义层（背景 / 表面 / 文字 / 模块强调色 / 圆角 / 动效 / 阴影）。
  新组件只消费 `--miao-*`，不再直接拿 `--md-*` 拼视觉；深色模式只换 `apply.ts` 写入的值。
- Hover 抬升 1–2px，Press 缩到 `.96`，页面切换 280–380ms，列表错峰 24ms。
- `prefers-reduced-motion` 下统一降级为静态。

### 1.3 字体

- 标题 / 数字：`Swei Gothic CJK SC`（随包 woff2，Regular + Bold）。
- 正文：`Yozai`（随包 TTF，400 / 600）。
- 等宽：`Cascadia Code / Consolas`。
- 字体由 `templates/index.html` 的 `<link>` 引入，本轮只换样式令牌，不动资源路径。

## 2. 改造清单（按交付顺序）

### 2.1 全局框架（本轮）

| 文件 | 改动 |
|---|---|
| `src/themes/tokens.ts` | 颜色令牌切到新调色板；新增 `MIAO_RADIUS` / `MIAO_MOTION` / `MODULE_ACCENT`，并由 `cssVars()` 注入 `--miao-*` 语义层；新增响应式档（侧栏 66 / 60、内容内边距、设置左栏 156） |
| `src/styles/base.scss` | 直接替换基础层：排版基座、焦点环、滚动条、减少动态与番剧旧色隔离作用域 |
| `src/styles/app.scss` | 直接替换外壳与原子件：`app + shell` 外框、玻璃侧栏、透明工具条、胶囊视图 Tab、按钮 / 药丸 / 状态徽标 |
| `src/styles/components.scss` | 直接替换公共控件与浮层：表单、菜单、弹窗、通知、骨架 / 空态 / 错误，以及统一响应式断点 |
| `src/styles/settings.scss` | 直接替换设置页视觉：卡片化两栏壳、分组导航、设置行与诊断 / 存储 / 缓存 / 许可块 |
| `src/styles/index.scss` | 分片顺序保持 `base → app → manga → settings → components → music → anime`，不新增版本号命名文件 |
| `src/App.tsx` | 壳层结构改为 `app + shell`，并给 `ViewTabs` 透传真实的队列数与库根目录；保持全部 Outlet context 与常驻层不变 |
| `src/components/Sidebar.tsx` | 品牌区、图标包装、标签、下载入口、番剧浮层全部换成新结构（`.nav-ico` 用 `<i>`，保持 C8d 判据） |
| `src/components/Toolbar.tsx` | 标题组 / 副标题 / 动作区的新结构，并预留标题徽标槽 |
| `src/components/ViewTabs.tsx` | 胶囊分段 Tab，保留 `.viewtabs .viewtab` 断言锚点与 Tab 顺序；右侧只展示真实的每批上限、串行策略、库根目录与队列数 |
| `src/screens/SettingsScreen.tsx` | 两栏壳、分组导航、卡片化右栏的新视觉；不改分组数据与能力接线 |
| `src/components/units/Skeleton.tsx` | 新增通用 `LoadingState`（骨架 / 转圈），与 `Empty` / `ErrorState` 组成三态出口 |
| `src/tools/spec-check.ts` | 几何自检改为响应式期望：按视口选择侧栏 / 内边距 / 设置左栏；主推进色改判模块主色；字体分工改判狮尾 + 悠哉 |
| `e2e/settings-media-check.mjs` | `FEATURES.shell.sidebarBranch` 允许标签 span 带 `.nav-label` 类名，判断条件仍是同一个 `labels` |

### 2.2 响应式（设计稿已含，必须同步还原）

| 断点 | 形态 | 与现有窗口的关系 |
|---|---|---|
| `> 1180px` | 完整桌面：侧栏 78、内容内边距 26·26·22·24、设置左栏 180 sticky | 开发预览与大屏 |
| `≤ 1180px` | 桌面应用默认宽度：内容内边距收到 20·18·18·18，设置左栏收 156，其余保持两栏 | `tauri.conf.json` 默认 `width: 1180` |
| `≤ 1040px` | 侧栏收成 66px 纯图标轨（文字 `display:none`），工具条副标题让位，设置页转上下布局、分组导航横排 | 仍高于窗口最小宽度 |
| `≤ 760px` | 侧栏 60px 窄轨、内容内边距 14、设置行改单列、Tab 行可横滚、说明条让位 | 未来窗口 / 分屏留档；当前最小宽度 980 不触发 |

规则：响应式只改布局与密度，**不新增业务判断**；几何期望值同时写进
`SHELL` / `SETTINGS` 令牌与 `src/tools/spec-check.ts`，由应用内自检当场量、当场报红。

### 2.3 漫画模块（下一轮）

| 页面 / 组件 | 现状与需保留的逻辑 | ver3 改造 |
|---|---|---|
| `DropScreen` | 本机拖放、目录选择、20 张分批、重名拦截、服务端规范化路径预览 | 投放 Hero + 文件清单 + 落盘预览 + 队列入口；补齐 loading / empty / error |
| `QueueScreen` | 串行队列、分页、批量删除、取消 / 重试 / 查看 / 打开目录 | 队列摘要卡 + 表头 + 行悬停 + 状态徽标；空态 / 失败态重绘 |
| `LibraryScreen` | 书目录、章节、页网格、隐藏书、归并、返工、对比 / 灯箱缩放 | 书架 + 详情面板 + 章节卡 + 页网格；不改数据模型 |
| `NotReadyScreen` | 服务五态、运行时装配时间线、下载入口 | 引导卡 + 五段时间线 + 状态徽标 |
| 弹窗 / 右键菜单 / Toast | 新建、编辑、归并、隐藏、删除确认 | 统一 ver3 弹窗、菜单、通知；禁止旧样式残留 |

### 2.4 音乐模块（后续轮次）

| 页面 / 组件 | 现状与需保留的逻辑 | ver3 改造 |
|---|---|---|
| `MusicScreen` | 四平台登录、首页、搜索、歌单、本地、历史 | 三栏工作区 + 顶部搜索 + 卡片化列表 |
| `PlayerBar` | 播放 / 暂停 / 上下曲 / 进度 / 音量 / 队列 / 播放模式 | 底部 dock + 胶囊控件 + 弹簧反馈 |
| `ExpandedPlayer` | 歌词 / 评论 / 六皮肤 / 碟片模式 | 全屏浮层按 ver3 重绘 |
| `QueueDrawer` | 队列增删、清空、跳播 | 右侧抽屉 + 行对齐 |
| `LoginModal` | 扫码 / Cookie / 多平台 | 统一登录弹窗 |
| `DynamicIsland` | 播放态、歌词卡、展开 / 收起 | ver3 胶囊与歌词卡 |
| `DesktopLyrics` | 独立歌词窗、锁定、字号 / 颜色 | 只换令牌与控件，不改窗口通信 |

### 2.4 番剧模块

**不动。** 全局令牌变化通过 `.an-root` 的旧值作用域隔离，避免番剧界面被新主题染色。

## 3. 设计稿未覆盖、必须按现有项目补齐的功能

| 功能 | 现有位置 | 补齐方式 |
|---|---|---|
| 服务五态与启停 / 重启 | `App.tsx`、设置页 | 工具条服务胶囊 + `/engine-download` 入口；不改成静态徽标 |
| 引擎下载三态入口 | `Sidebar`、`App.tsx` | ver3 图标入口 + 进度角标 + 暂停 / 完成态 |
| 侧栏标签开关 | `shell-prefs.ts` | 标签 / 纯图标两套几何继续由令牌驱动 |
| 番剧子导航浮层 | `Sidebar` | 保留 hover 浮层与五状态入口，视觉换 ver3 |
| 退出确认 | `QuitConfirm` | ver3 弹窗，不改成浏览器 confirm |
| 通知堆叠 | `NotificationStack` | ver3 Toast 卡，支持多条并存与逐条关闭 |
| 设置 34 项目录 | `catalog.ts` | 分组、项数、pending 规则全部保留 |
| 引擎诊断 / 模型下载 / 缓存 / 许可 | `EngineDiag`、`CacheBlock`、`LicensesBlock` | 卡片化但不删任何只读信息与动作 |
| 规格自检 | `SpecCheck` | 保留离屏样张与 14 项几何判据 |
| 音乐六皮肤 / 逐字歌词 / 桌面歌词 | `music/*` | 不删能力，只换视觉 |
| 漫画对比 / 灯箱 / 页网格缩放 | `manga/*` | 不删交互，只换视觉 |

## 4. 状态兜底矩阵

所有 API 请求必须同时有 `Loading`、`Empty`、`Error` 三种表现，且使用 ver3 视觉：

| 数据面 | Loading | Empty | Error |
|---|---|---|---|
| 漫画库 `/library` | 书架骨架 + 详情骨架 | 「还没有漫画」+ 去投放 | 错误卡 + 重试 |
| 任务队列 `/tasks` | 表格骨架行 | 「队列为空」+ 去投放 | 错误卡 + 重试 / 查看服务 |
| 引擎状态 `/engine/status` | 状态胶囊脉冲 + 诊断骨架 | 「未装配」引导 | 错误码 + 重启服务 |
| 模型清单 / 下载 | 进度条 + 百分比 | 「无待下载项」 | 中断原因 + 继续下载 |
| 音乐搜索 | 结果骨架 | 「没有找到歌曲」+ 换关键词 | 平台错误 + 切换源 |
| 音乐歌单 / 详情 | 列表骨架 | 「歌单为空」 | 登录失效 / 版权限制提示 |
| 音频流 | 加载圈 + 缓冲态 | 纯音乐 | 版权 / VIP / 区域限制的弹窗提示，不抛控制台错误 |
| 设置各块 | 行骨架 | 「当前平台无此项」 | 行内错误 + 重试 |

新增通用单元：`LoadingState`（骨架 / 转圈两种形态），与 `Empty`、`ErrorState` 组成
统一的三态出口。

## 5. 收尾清理（硬要求）

当前已完成外壳 / 公共单元 / 设置页的**正式分片替换**：
`base.scss` / `app.scss` / `components.scss` / `settings.scss` 直接承载新样式，
`index.scss` 的分片顺序保持 `base → app → manga → settings → components → music → anime`，
仓库里**没有**以版本号命名的临时样式文件。

剩余收尾项（漫画 / 音乐迁移时同步完成）：

1. `manga.scss` 与 `music.scss` 的旧视觉规则在各自模块迁移时被新规则替换，不叠加保留；
2. 全仓不再出现以版本号命名的样式文件或类名；
3. 每轮迁移后跑 `check:units` 的 `STYLE.*` 组，确保分片归属与层叠顺序不变。

## 6. 进度台账

| 提交 | 范围 | 验证 |
|---|---|---|
| `218870a` | 全局框架（外框 / 侧栏 / 工具条 / 视图 Tab / 公共单元 / 浮层）+ 设置页卡片化 + 响应式自检 | static 19/19；`check:units` 46/46；自检 31/31 于 1440·1180·1024·980 |
| `12279ad` | 漫画模块：投放页、队列页（汇总条 / 真数据翻页器 / 行内状态条 / 多选条 / 空态）；`LoadingState` 并入 units；选择器与分批提交的失败降级 | static 19/19；`check:units:refute` 61/61；`check:settings:refute` 145/145；`check:music:refute` 231/231；自检 31/31 |
| `731a148` | 服务未就绪页：引导卡 / 摘要行 / 五段时间线 / 状态 chip / 日志框接新版式；删掉页面上已不存在的四组失效规则 | 同上；`NOTREADY.*` 与 `check:settings:refute` 全绿 |
| `51cf18c` | 漫画库：左栏面板、书目录项（悬停位移 + 选中条 + 主色描边）、搜索框、右栏标题、网格卡（抬升 + 双层阴影）、通用 `.card` | 自检 C5 仍实测 260 / 110×165 r12；static 19/19 |
| `8b8e2d1` | 漫画库列表与对照看图：分组折叠、封面件、话卡角标与悬浮菜单（弹簧浮现）、对照视图双栏、灯箱遮罩与缩放按钮 | static 19/19；`check:units:refute` 61/61（含 ZOOM.* CSS 锚点）；harness 实测菜单 hover 浮现 |
| `2f9cda0` | 错误态收进各自屏：队列错误卡在 `TranslatePane`、漫画库错误卡在 `LibraryScreen`，均带「重试」接 `refreshAll`；壳层不再串屏弹两条错误 | harness 实测三屏错误卡各自独立、音乐屏零错误卡 |
| `907210f` | 音乐屏外壳：顶行 / 卡片面板 / 胶囊 Tab / 搜索框 / 搜索源胶囊 / 歌曲行 / 榜单卡；榜单名缺失时兜底不白屏 | static 19/19；`check:music:refute` 231/231；harness 实测 26px 面板、999px 胶囊、零溢出 |
| `6e8efd4` | 音乐播放条 dock（26px 圆角 + 弥散阴影、封面 10px、音质胶囊、进度/音量滑块换杏奶色）、灵动岛胶囊、队列抽屉（348px）、平台切换与账号菜单配色 | static 19/19；`check:music:refute` 231/231（渐变形态、320ms 形变、z-index 71/72 全部原样）；harness 实测播放条 89px、岛 200×30、抽屉 z=72 |
| `a0fee68` | 展开播放器：歌词 Tab 选中态、皮肤选择器、音量滑块填充色、NEW 角标；六皮肤配色仍由运行时注入的 `--skin-*` 驱动 | `check:music:refute` 231/231（`music-exp-up` / `music-exp-flow` 双动画、`is-closing` 退场、沉浸歌词规则原样）；harness 实测 z=70、封面 200×200 r22、歌词 5 行、皮肤卡 6 张 |
| `794386f` | 音乐登录弹窗、桌面歌词设置弹窗、轻提示：遮罩/阴影从旧紫色硬编码换成 `--miao-ink` 混色与 `--miao-shadow-2`；轻提示改为表面色卡 + 语义色左缘 | static 19/19；`check:music:refute` 231/231；build 通过 |
| 待做 | 桌面歌词独立窗（`templates/lyrics.html` 自带内联样式，不在主窗样式体系内）；漫画库弹窗族收尾核对 | — |

队列汇总条与翻页器上的每个数字都算自 `GET /tasks` 的当前 rows；投放页的批次、根目录、
落盘回执分别来自 `splitBatches`、服务状态与建单响应 —— 屏内没有一处演示数据。

## 7. 验收

1. `npm run lint`、`npm run build` 通过。
2. `npm run check`（static 层）通过；`check:units` 的 `STYLE.*` 组确认分片顺序与归属未被版本号文件破坏。
3. 应用内「规格自检」在 `1440 / 1180 / 1024 / 980` 四档均为 31 / 31 通过，无死链、无几何漂移。
4. 页面流转：翻译三视图、音乐、设置、下载覆盖层、番剧入口全部可达。
5. 所有请求失败都有可见降级，不出现只写 `console.error` 的路径。
6. 番剧代码零 diff。
