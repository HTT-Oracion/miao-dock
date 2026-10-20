# 喵坞 · MiaoDock

**Box 桌面端 ver2.0** —— 本地漫画翻译服务的宿主与可视窗口，外加一个音乐应用。

- **两个应用**：**漫画翻译**（投放 / 队列 / 漫画库）· **音乐**（网易云 / 酷狗 / QQ / 咪咕 四平台）
- 依据：《00-决策纪要》《02-Box-技术方案》《03-翻译服务接口契约》《09-技术方案-ver2.0-最终版》
- 开发方案与验收标准：`docs/internal/dev-plan.md` · 引擎接入里程碑与现状：`docs/internal/engine-integration-plan.md`
- 偏离与裁定留痕：`docs/internal/spec-notes.md`（D-01~D-136）· `docs/internal/spec-notes-1.md`（**D-137 起新增写这里**）
- **AI 协作上下文入口：`AGENTS.md`**（任何 AI 工具进入本仓库先读它；Trae 另见 `.trae/rules/project_rules.md`）
- **许可**：[MIT](LICENSE) —— 见下方 §许可。**贡献**：先读 [`CONTRIBUTING.md`](CONTRIBUTING.md)（提交规范 / 验收命令 / 目录纪律）

## 与插件端的关系

| 产品 | 仓库 | 角色 |
|---|---|---|
| 喵译 MiaoTrans | `../miao-trans` | 浏览器插件（Chrome MV3），提交翻译任务的**入口面之一** |
| **喵坞 MiaoDock** | 本仓库 | 桌面端，**服务的宿主与可视窗口**（队列 / 漫画库 / 本机投放） |

两者**共用同一份接口契约**（《03》）：同一条串行队列、同一套落盘规则、同一条 20 张/批上限。
`miao-trans/mock-service` 是插件端 e2e 的**测试替身**，与本仓库互不影响 —— 本仓库的服务端实现
已**整体 Rust 化**（`src-tauri/src/mangasvc/`），仓库里不再有 Node 服务实现（D-209）。

## 目录

```
miao-dock/
├── src/          Vite/React 前端源码（根目录只留 `main.tsx` / `App.tsx`，其余按职责分目录）
│   ├── screens/  屏层：`manga/`（漫画翻译的投放 / 队列 / 漫画库三屏 + 屏内件，`index.ts` 是唯一出口）· `music/`·`lyrics/`·`settings/`（音乐 / 设置两屏的屏内件）· `anime/`（番剧十屏 + 屏内件，屏入口 `AnimeScreen.tsx` 在屏根）· 未就绪屏 `manga/NotReadyScreen.tsx` 是投放屏的一种形态
│   ├── router/  屏级路由：`routes.ts` 路径表 · `use-nav.ts` 读写口 · `panes/` 屏装配件（**hash 路由**：URL 是「屏 + 应用内视图」的唯一事实源）
│   ├── modules/  域模块（与 `screens/` 分层的另一层：住域逻辑，不住屏）：`music/`（音乐领域态：zustand store · ipc · platform · 播放器选项）· `anime/`（番剧领域态：zustand store · 切片 · ipc · 偏好 · 设置目录；数据来自独立进程 `animesvc`）
│   ├── stores/   跨组件共享状态与壳层偏好（导航态机 / 轻提示通道 / 外观偏好）
│   ├── ipc/      与后端通信（`ipc.ts` 翻译服务命令 + `engine-download.ts` 引擎下载）
│   ├── types/    跨域类型声明（`types.ts` + `vite-env.d.ts`）
│   ├── themes/   设计令牌与主题应用（`tokens.ts` / `apply.ts`）
│   ├── components/units/  通用 UI 单元（判据：**不 import 业务层**）
│   └── tools/    共享纯函数（`@tools`：格式化 / 分页 / 模糊匹配 / UUID / MIME 嗅探），**不 import 业务层**
├── src-tauri/    Tauri v2 桌面壳（Rust）—— `src/` 根只留 `main.rs` / `lib.rs`，其余按域分层
│   ├── src/commands/  IPC 命令层（`mod.rs` = 唯一命令注册点；`lyrics_window.rs` = 桌面歌词**独立置顶窗**的命令）
│   ├── src/service/   本地服务子进程的生命周期（`ServiceManager`）
│   ├── src/selftest/  自检通道（`mod.rs` 生命周期自检 + `capture.rs` 截图取证）
│   ├── src/platform/  跨平台底座（`paths.rs` 落点 / `root_guard.rs` 落盘根安全闸 / `child_watch.rs` 父死看守）
│   ├── src/music/     音乐模块 Rust 侧：四平台（`netease`/`kugou`/`qqmusic`/`migu`）+ 音频代理 + 加密 + 歌词 + 缓存（汽水延后）
│   ├── src/mangasvc/  **服务端实现**（唯一翻译入口，127.0.0.1:5180–5190）：`mangasvc.rs` 外壳 · `routes.rs` 路由表（44 条）· `handlers.rs` 端点 · `store/` 队列落盘 · `library.rs` 库原语 · `translate/` 在线翻译 · `engine/` 引擎耦合点
│   └── src/animesvc.rs  **动漫服务**（独立 exe `animesvc`，同端口段探测）：自己的 state / 令牌 / 库根（`<数据根>/anime/*`），与漫画服务**可同时运行**且互不读取对方的库；`src/animesvc/kernel/` 是内核轨（随包 mpv + JSON IPC：`ipc.rs` 协议 / `mpv.rs` 进程与客户端）
├── public/       不经构建处理的静态资源（原样复制到 dist/，**没有指纹、没有 url() 改写**）
│   ├── assets/fonts/   随仓字体：三份 `<dir>/font.css` 清单 + 字体文件（由入口 HTML 的 `<link>` 加载）
│   ├── assets/icons/   品牌图（logo-48 / logo-512 / logo，用绝对 URL 引）
│   └── style-previews/ 歌词样式预览图
├── templates/    两个 HTML 入口：`index.html`（主窗）/ `lyrics.html`（桌面歌词**独立窗**），登记在 `vite.config.ts` 的 `rollupOptions.input`
├── installer/    **单文件安装器**（独立工程：前端 + Tauri 宿主，不并进主构建）：`index.html` 入口 · `src/` 安装引导三步（安装范围与目录 / 长路径 / 完成；两套默认目录、载荷体积、可用空间、长路径开关、日志路径**全部由宿主实时探测**）· `src-tauri/` 宿主 = 安装引擎（解包内嵌载荷 + 写卸载项 + 建入口 + 自检提权）+ `payload.rs` / `manifest.rs` / `registry.rs` / `shortcuts.rs` / `elevate.rs` · `package.json`（`npm run dev` = 1444 端口预览）· `public/assets/` 品牌图
├── uninstaller/  **卸载器**（同上，独立工程，随安装落进安装目录）：`index.html` 入口 · `src/` 卸载页三态（告别确认 / 卸载进行中 / 完成；三类数据的目录、体积、存在性**全部由宿主实时探测**）· `src-tauri/` 宿主（实时探测 / 清入口与注册表项 / 安全删数据 / 安排自删）+ `registry.rs` / `shortcuts.rs` / `selfdelete.rs` · `package.json`（`npm run dev` = 1555 端口预览）· `public/assets/` 品牌图
├── scripts/      仓库级脚本：`gen-licenses.mjs`（许可清单生成）· `mac-signing-preflight.mjs`（macOS 打包前自检）· `build-install-ui.mjs`（两个程序的前端构建）· `pack-install-payload.mjs`（打安装器载荷）· `package-install-ui.mjs`（组装单文件安装器）
├── engine/       翻译引擎的**接缝层**（真引擎装在 `<appData>/MiaoDock/manga/runtimes/manga-translator/`，不在库）
│   ├── VERSIONS.lock         引擎 / 权重 / 外部二进制的**版本锁**（换版本照它来）
│   ├── models.manifest.json  模型清单：来源 URL + sha256 + 字节数（权威副本在 `…/models-store/`）
│   ├── model-store.mjs       下载内核（**Node 对照端**，A3d；产品主路径是 Rust `mangasvc::engine::model_store`）
│   ├── src/                  **测试替身**：模拟引擎 + 模拟 LLM（产品默认走真引擎 `MIAO_ENGINE_PROTOCOL=real`）
│   └── scripts/              `setup-engine.mjs` / `install-engine-deps.mjs`（本机环境引导）｜`fetch-models.mjs` 与 `child-watch.mjs` 均为 **Node 对照端**（产品主路径分别是 Rust `mangasvc --fetch-models`(A3d) / `mangasvc --child-watch`(A3c)；`child-watch.mjs` 现在只被 `check:child-watch` 行为对照与 `check:child-watch-kill` 的源码钉子使唤）｜`runtime-root.mjs` = 装配脚本共用的**运行时落点**单一事实源（B1）
├── e2e/          **全部验收与取证脚本**（纯 Node 零依赖；一条命令一组断言，正向与反证成对）
│   ├── *.mjs                  生命周期 / 端到端 / 截图取证 / 文档与结构对账
│   ├── service/               manga-service 侧（`selftest.mjs` = A 组契约自测 · `stall-guard-check.mjs` = U10② 取证）
│   └── engine/                引擎侧（引擎自测 / 真引擎全链路 / 真机 sha256 与断点续传）
├── docs/         **对外 / 贡献者**文档：`install-guide-{windows,macos}.md`（安装引导）· `dev-setup.md`（开发环境）· `distribution-license-conclusion.md`（第三方许可结论）· `refs/`（入库的取证图与报告）
│   └── internal/ **内部工作文档**（不对外）：`spec-notes.md`（**台账：裁定与偏离留痕**，D-01~D-136，**已封卷**）· `spec-notes-1.md`（**台账续篇，D-137 起新条目写这里**）· `dev-plan.md`（方案与判据）· 各轮计划与验收报告
├── test-manga/   本机验收素材：真实漫画（**不入库**）
├── test-music/   本机验收素材：音乐（**不入库**）
├── runtimes/     **开发机遗留的引擎资产目录**（**不入库**）：B1 起产品的默认落点已搬到 `<appData>/MiaoDock/manga/runtimes/manga-translator/`；这里只在用 `MIAO_MANGA_RUNTIME_ROOT=<repo>/runtimes` 显式覆盖时才被读到
├── .tmp/         **全仓唯一的临时落盘目录**（**不入库**）：`e2e/` · `selftest/` · `models/` · `engine-test/`
├── release/      **交付物落点**（**不入库**）：`npm run app:build` 产出的 `MiaoDock_<版本>_<架构>-setup.exe`（单文件安装器，约 145 MB；版本取自 `tauri.conf.json`，如 `MiaoDock_2.2.1_x64-setup.exe`）—— 与 `.tmp/` 分家，因为它是要交给人的成品，不是跑完就删的中间件
├── snapshots/    对外展示截图（与 `docs/refs/` 的**取证图**分家，两者不互为副本）
├── AGENTS.md     AI 协作上下文入口（任何工具进仓库先读它）
├── CONTRIBUTING.md  贡献指南（提交规范 / 验收命令 / 目录与改名纪律）
├── LICENSE       MIT
├── .env.example  环境变量的**参考清单**（🔴 不自动加载，见该文件抬头）
└── README.md     本文件
```

> **目录约定（动目录之前先读这几条）**
>
> 1. **产品 / 验收分家**：`src-tauri/src/`（含服务端 `mangasvc/`）、`engine/src`、`src` 是**产品**；`e2e/` 是**验收**。
>    判据不是"像不像测试"，而是**产品代码在运行期会不会 fork 它** —— 会 fork 的
>    留在各自模块的 `scripts/` 下，**不搬进 `e2e/`**。
>    ⚠️ 反向也成立：**产品主路径一旦改走 Rust**（`print-launch-plan.mjs` A3b 退役、
>    `child-watch.mjs` A3c 降为对照端、`fetch-models.mjs` A3d 降为对照端），留在 `scripts/` 里就不再是"产品"，
>    但**不许顺手删** —— 先查还有谁 import 它（`child-watch.mjs` 仍被 `check:child-watch` / `check:child-watch-kill` 用着）；
>    🔴 更常见的是它**还是双靶对拍的另一边**（`fetch-models.mjs` / `model-store.mjs` 是 `check:models` 的 Node 靶），
>    删掉等于让对拍退化成"只有一边的自证"。
> 2. **临时产物一律写进 `.tmp/<用途>/`**，不要在仓库根另起 `.tmp-xxx/` 或 `tmp-xxx/`
>    （**例外**：`release/` = 交付物 —— "跑完就删的"进 `.tmp/`，"要交给人的"进 `release/`，两者都不入库）
>    （历史上散着 `.tmp-e2e` / `.tmp-models` / `.tmp-selftest` / `tmp-engine-test` 四个，已合并 —— 见 `docs/internal/spec-notes.md` D-79）。
> 3. **新增 / 搬迁目录必须同步更新本节**。同时检查：`AGENTS.md` §1 的分层表 · `.trae/rules/project_rules.md` ·
>    以及**断言里写死的路径** —— 路径不同步的后果不是变红，而是**静默跳过**。
> 4. **服务端按域分子目录**（ver2.2 起，F5 起随实现搬进 Rust）：`mangasvc/store/`（队列落盘）· `mangasvc/library.rs`（库原语）·
>    `mangasvc/translate/`（在线翻译）· `mangasvc/engine/`（引擎耦合点）。产品运行时**不再有 Node 服务进程**：
>    ① 是 `mangasvc`；②③ 里的 node 只是**测试替身**（真机走 `python main.py` / `llama-server`）。
> 5. **安装器与卸载器是两个各自独立的程序**（`installer/` · `uninstaller/`）：自带 `package.json` / vite 配置 / tsconfig /
>    `src-tauri` 宿主与产物目录，**不并进主构建**，彼此不许互相引用，也不 import 主工程源码（令牌与纯函数是各自目录内的镜像副本，理由写在文件头）。
>    日常：进各自目录跑 `npm run dev`（安装器 1444 / 卸载器 1555）看界面，`npm run tauri -- dev` 起真实小窗；
>    构建：仓库根 `npm run task -- installer:build` / `uninstaller:build`（注入字体 → tsc → vite build）。
>    🔴 **必须走 Tauri CLI**：`cargo build` 出来的 exe 不内嵌前端、只会去连 dev 服务（实测 7.5 MB，启动一片空白）；
>    CLI 产物才把 `dist/` 打进 exe。
>    **分发形态：对外只有 1 个 exe**（`MiaoDock_<版本>_<架构>-setup.exe`，如 `MiaoDock_2.2.1_x64-setup.exe`）。主程序 exe + 资源 + 卸载器 exe 打成 `payload.zip`，
>    编译期嵌进安装器（`install:pack`），运行时解包落盘、写卸载项、按完成页勾选建桌面/开始菜单入口。
>    构建顺序是硬约束：卸载器宿主 → `install:pack` → 安装器宿主；一条命令串起来：`npm run task -- install:kit`
>    （产物 `release/MiaoDock_<版本>_<架构>-setup.exe`，约 145 MB，大头是两个程序的字体；版本号跟着 `tauri.conf.json` 走，脚本里不写死）。
>    🔴 **发布就一条命令**：`npm run app:build` = 主应用 `tauri build` + `install:kit`（先有 `miao-dock.exe` 才有载荷）。
>    它顺手产出的 NSIS 包（`src-tauri/target/release/bundle/nsis/*-setup.exe`）是旧界面，**不是**分发物。
>    安装范围：默认全机（`C:\Program Files\MiaoDock` + HKLM 卸载项，启动弹一次 UAC）；「仅为我安装」⇒
>    `%LOCALAPPDATA%\Programs\MiaoDock` + HKCU。卸载器住在安装目录里，删完靠 detached `cmd` 自删。
>    静默档：安装器 `--silent [--dir <目录>] [--per-user] [--no-shortcuts]`，卸载器 `--silent`（不碰用户数据）。
>    界面与"干活的外壳"之间只有 `installer/src/host.ts` / `uninstaller/src/host.ts` 一个接缝：两套默认目录、体积、可用空间、
>    长路径开关、日志路径、三类数据的目录与体积**全部由宿主实时探测后注入**，界面不写死任何一个数；纯浏览器里跑时用文件内的预览替身（取样值即设计稿演示值）。

## 快速开始（装环境 → 装配引擎 → 启动）

> **产品默认走真引擎**（`MIAO_ENGINE_PROTOCOL=real`）：`npm run app` 起的链路需要**引擎运行时**（按平台、**不入库**，见 `engine/VERSIONS.lock`）。
> 落点固定在**平台应用数据目录**下的 `MiaoDock/manga/runtimes/manga-translator/`（macOS `~/Library/Application Support/`、Windows `%LOCALAPPDATA%\`、Linux `~/.local/share/`）—— 与**装到哪个盘**无关，打包后才能找到（B1）。
> 只想跑前端 / 服务、不碰引擎：用下面 §开发 里的 `MIAO_ENGINE_PROTOCOL=mock` 快回路。

### 依赖总览

| 用途 | 依赖 | 说明 |
|---|---|---|
| 跑服务 / 脚本 | **Node ≥ 20**（见 `package.json` 的 `engines`） | 服务、引擎脚本、全部验收脚本都是纯 Node |
| 构建桌面端 | **Rust 工具链**（rustup / cargo）+ 平台 C 工具链 | Tauri v2 需要 cargo + 系统链接器 |
| 运行桌面端 | macOS 自带 WebKit · Windows **WebView2** | Win11 自带；Win10 常见随 Edge 已装，缺则装 Evergreen Runtime |
| **真翻译引擎** | ① Python 3.11 运行时 ② venv + 依赖 ③ 模型权重 ④ llama.cpp 二进制 | 全落在 `<appData>/MiaoDock/manga/runtimes/manga-translator/`（**不入库**），由本节脚本装配 |

### 一、装核心依赖

**macOS**

```bash
xcode-select --install                                           # clang + SDK（编译 pydensecrf 也要它）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # 装完确保 ~/.cargo/bin 在 PATH
```

**Windows 10**

1. **Rust**：装 `rustup-init.exe`，工具链选 **MSVC**。
2. **Visual Studio 2022 生成工具**（Build Tools，不必装完整 IDE）：在安装器里勾「**使用 C++ 的桌面开发**」—— 它同时带来 MSVC 编译器与 **Windows SDK**（引擎依赖里的 `pydensecrf` 要现场编译，Tauri 链接也要）。装到默认路径即可；装在别处就用环境变量 `MIAO_VC_ROOT` / `MIAO_SDK_ROOT` 指过去。
3. **WebView2**：Win11 自带；Win10 若缺，装 Evergreen Runtime。

> 自检：`node -v`（≥ 20）· `cargo --version` 能打出版本号。
> 🔴 `cargo` 不在 PATH ⇒ `npm run app` 报 `failed to run 'cargo metadata' ... (os error 2)`。
> 🔴 **Windows 上编译桌面端必须在带 MSVC 环境的终端里跑**（`npm run app` / `npm run app:build` 都一样）：
> Cargo 依赖里 `ring` 要**现场编译 C 代码**，而 `cl.exe` 靠环境变量 `INCLUDE` / `LIB` 找头文件与库。
> 在**普通 cmd / PowerShell**（或任何没跑过 `vcvars64.bat` 的 shell）里跑，会停在
> `error: failed to run custom build command for ring ... (exit code: 2)`，而且 cargo 打印的
> `--- stderr` 段是**空的** —— 真正的诊断走的是 **stdout**：`fatal error C1034: stddef.h: 不包括路径集`。
> 只看 stderr 会误判成 ring 自身坏了。做法：用 **「x64 Native Tools Command Prompt for VS 2022」**
> 开终端，或先 `...\VC\Auxiliary\Build\vcvars64.bat` 再跑命令。
> macOS：把 `export PATH="$HOME/.cargo/bin:$PATH"` 加进 `~/.zshrc` 再 `source`；
> Windows：重开终端，或在「系统属性 → 环境变量」里把 `%USERPROFILE%\.cargo\bin` 补进 `Path`。

### 二、装配翻译引擎（`<appData>/MiaoDock/manga/runtimes/manga-translator/`，四条命令按序、幂等）

```bash
npm run task -- setup:engine     # ① Python 3.11 运行时 + venv（+ 引擎源码）→ <appData>/MiaoDock/manga/runtimes/manga-translator/
npm run task -- deps:engine      # ② 往 venv 里装引擎依赖（平台差异见下）
npm run task -- fetch:models     # ③ 下模型权重 + llama.cpp 运行时归档
npm run task -- extract:models   # ④ 解包归档 → bin/llama/llama-b11417/llama-server[.exe]
```

> **落点**：默认 `<appData>/MiaoDock/manga/runtimes/manga-translator/`（B1 起与产品同源，装配与读取不可能再分叉）。
> 要挪地方用 `MIAO_MANGA_RUNTIME_ROOT`（改运行时根本身）或 `MIAO_MODEL_ROOT`（只改模型根，语义 = `…/manga-translator`）。
> 换机重装 = 重跑本节四条命令 —— 这套资产**不入库**，也不随安装包分发。
>
> 📖 **分平台逐步引导**（落点写成第一步、体积按清单可复算、装完怎么自检、平台专属坑）：
> [`docs/install-guide-windows.md`](docs/install-guide-windows.md) · [`docs/install-guide-macos.md`](docs/install-guide-macos.md)
> （两文档与产品对拍成钉子：`npm run task -- check:install-guide`）。

**② 的平台差异 —— 唯一不能"一条命令通吃"的一步：**

- **Windows**：`npm run task -- deps:engine` 一把梭。它把依赖**拆两批**装 —— `pydensecrf` 在 PyPI **没有任何 Windows wheel**，只能现场用 MSVC 编译；而 pip 是事务性的，混在一批里会因它失败而**整批回滚**。脚本还会自动写入 `pydensecrf` 的**旧常量兼容补丁**。
  换机排障：`node engine/scripts/install-engine-deps.mjs --print-env` 会打印探测到的 MSVC / SDK 路径。
- **macOS**：该脚本是 Windows 专用，手动装：
  ```bash
  RT="$HOME/Library/Application Support/MiaoDock/manga/runtimes/manga-translator"
  "$RT/venv/bin/pip" install -r "$RT/src/requirements.txt"
  ```
  ⚠️ `pydensecrf`（requirements 里那行 GitHub 直链）是**移动靶**：上游已把模块级常量迁进了枚举，而引擎源码仍用旧写法 ⇒ 会在**掩码细化**一步报 `AttributeError: ... has no attribute 'DIAG_KERNEL'`（检测 / OCR / 翻译都已跑完才炸，易误判成"翻译坏了"）。命中时按 `engine/scripts/install-engine-deps.mjs` 的 `patchPydensecrfCompat()` 同一原理，把枚举成员回填成模块级同名常量（Windows 脚本自动做，macOS 需手动）。

> **版本与落点以 `engine/VERSIONS.lock` 为准**：§3 = macOS，§6 = Windows（含真机实测与三个必踩坑）。
> `<appData>/MiaoDock/manga/runtimes/` 按平台且**不入库** —— 换机重装 = 重跑本节四条命令。

### 三、启动

```bash
npm install
npm run app                             # 真引擎（默认）：python main.py(8000) + 执行器(8001) + llama-server(8080)
MIAO_ENGINE_PROTOCOL=mock npm run app   # 替身快回路：不需要引擎运行时
```

## 开发

```bash
# 服务层（可独立启动，不依赖桌面端）：Rust 可执行，读 MIAO_* 环境变量
cd src-tauri && cargo build --bin mangasvc && ./target/debug/mangasvc

# 测试替身（模拟引擎 + 模拟 LLM）—— 只有测试用，产品走真引擎
node engine/src/server.mjs

# 桌面端整条链路（需 Rust 工具链 + 真引擎）见上一节 §快速开始；它会自己拉起**三个**子进程：
#   服务 + 引擎 + LLM。默认 real ⇒ python main.py(8000) + 执行器(8001) + llama-server(8080)。
```

> 环境变量 `MIAO_MANGA_ROOT_DIR` 可覆盖落盘根目录（验收用临时目录），默认 `~/Pictures/MiaoDock Mangas`。
> 运行期状态在平台应用数据目录下的 `MiaoDock/manga/state/`（`MIAO_MANGA_STATE_DIR` 可覆盖）：
> `tasks/` 任务清单、`pending/` **上传字节暂存区**、`token`、`idempotency.json`。
> 暂存区是「服务崩溃后未落盘的原图还能救回」的依据（见 `docs/internal/spec-notes.md` G-12）——
> 它在漫画目录**之外**，所以取消任务不会在漫画目录留下残缺文件。

## 验收

```bash
npm run selftest              # A 组服务契约 + 引擎自测
npm run task -- selftest:app          # B 组应用生命周期 16 条（程序化，不依赖人点；含 S2 五态轨迹/参数快照/崩溃分级）
npm run task -- selftest:app:refute   # 上一项的反证——它必须**变红**，绿的那轮才作数
npm run task -- selftest:app:e11      # E11 三进程树回收（mock）：SIGKILL 主进程 → 13 端口全释放
npm run task -- selftest:app:e11:real # 同上但真进程（python+执行器+llama-server）；分钟级，按需手动跑
npm run task -- selftest:app:guide    # D-229 未装配时 ① 必须可用：服务起得来 + 下载端点能落地 + ②/③ 一个不起（要 release 构建）
npm run task -- check:launch-plan     # S2 启动配方契约 24 条（含 ③ 归属移交后的 P-llm-* 断言）
npm run task -- check:child-watch     # 外部二进制父死看守**双靶**取证（Node 原版 + A3c Rust 移植，Rust 靶用产品同源 Rust 父 `mangasvc --child-watch-parent`；含接线错误防护 W2；反证轮只判 Rust 靶，Node 靶按结构跳过并标注原因）
npm run task -- check:child-watch-kill # child-watch Windows killTree 无条件 /F **双靶源码钉**（Node `child-watch.mjs` + Rust `child_watch.rs`，源码级不起进程；反证 2 条）
npm run task -- fetch:models          # S3 模型下载器 **Node 对照端**（--check 只校验不联网 / --link 只重建引擎树里的链接；反证：check:models:refute）。⚠️ 产品运行期跑的是 `mangasvc --fetch-models`
npm run task -- e2e                   # D1–D5 端到端（真实 engine + 真实 service，真落盘）
npm run task -- capture               # 截图取证（需屏幕解锁；不满足条件会拒绝出图而非交假证据）

# 结构断言（每条都带反证轮，见 docs/internal/spec-notes.md 与 AGENTS.md §3）
npm run task -- check:ia              # IA 结构 37 条（侧栏两级 / 视图 Tab / 设置两栏壳 / 小节分层 / 侧栏两套几何 C8d / 侧栏不渲染服务状态点 C8e / 下载入口 C8f）
npm run task -- check:tls             # 依赖链 TLS 14 条（配置层 / 锁文件层 / 源码层）
npm run task -- check:quit            # 「退出喵坞」根因钉子 5 条 / 反证 5 条（源码级：quit_app 必须 async / reap 有界 / CREATE_NO_WINDOW / 前端不静默 / Windows signal_tree 无条件 /F）
npm run task -- check:autostart       # 翻译服务「自动启动 / 手动启停」根因钉子 21 条 / 反证 23 条（源码级：start_once 幂等 / service_stop 必须 async 且补发 emit / main.rs 启动收进测试通道 / effect 依赖不含 status / stopped 给「启动」/ 服务实现默认档 = Rust / default-run 指向真实 bin；不起进程）
npm run task -- check:engine-parity   # 引擎耦合点纯函数 24 条（Rust `--engine-selftest` ⟷ 冻结 golden；real/mock 两档）
npm run task -- check:engine-http     # 引擎 HTTP 运行期 18 条（真发 HTTP 打伪引擎：请求体 / 错误归一 / 三重就绪 / 超时带走证据）
# ⚠️ `engine-client 那组钉子` 已退役（D-203）：它测的是 Node 侧 `engine-client.mjs` 的 60 条断言，
#    契约面由上面两组 golden 等价覆盖；Node 产品源码随 F5 删除后它也没有对象了。
npm run task -- check:models          # S3 模型下载器 **双靶** 38×2 = 76 条 / 反证 7×2 = 14 条（本地 Range 夹具源：中断续传 / 服务端不支持 Range / 篡改一字节 / 换版本重链 / HF 缓存布局 / **清单原 `url` 不许被 `sources` 挤掉**（H2 · D-217），秒级）。A3d 两靶同跑：Node 对照端 + Rust `mangasvc --fetch-models`（产品主路径）；反证开关走子进程 env
npm run task -- check:profile         # S4 档位映射 / 加速后端 / 降档 / 空闲卸载（判定层）43 条 / 反证 14 条（起真进程，约 10s）
npm run task -- check:e5e6            # S4 端到端 E5/E6：真服务 + 真引擎 + 真 ③，16 条 / 逃生开关反证 3 条（约 60s）
npm run task -- check:contract        # S5 契约增量：9 键 sidecar / 未就绪 vs 不可用 / 模型缺失 / /engine/status 77 条（反证：check:contract:refute）
npm run task -- check:music           # 音乐平台 / 播放模式五档 / 心动模式 / 播放列表入口与抽屉 / 桌面歌词 / 逐字歌词 / 逐字整行模式 / 翻译歌词 / 演唱行 / 高亮同步 / 滑块填充 / 音频图 / 音乐缓存 / 六皮肤 / 队列 / 歌曲右键菜单 / 灵动岛歌词卡 / 启动恢复 / 音乐快捷键 / 窗口 WebView2 参数 237 条（反证：check:music:refute，231 条）
npm run task -- check:anime-module    # 番剧模块接线：@anime 别名双同步 / /anime 路由与 IA / 屏装配件 / 十屏分派 / IPC 命令名与 handler 注册 / animesvc manifest 端点 / 播放契约 PlaybackCore 与 selftest / 播放器接线（anime_play_source → ArtPlayer + hls.js / 内核轨说明 / 续看回写）/ Bangumi 元数据（UA 四段 / 镜像列表与图片镜像 / 检索 / 落 manifest / 详情页入口）/ 扁平落盘目录合成剧集 / 设置接线（库根 / 代理真正生效）/ M3 源契约、本机导入与 RSS 适配器 / 媒体服务器适配器（Jellyfin / Emby，api_key 只走请求头）/ 远程播放中继（anime_play_remote → 带票中继 → 播放器远程态）/ 内核轨（animesvc/kernel：mpv JSON IPC、独立窗口、轨道 / 音量 / 统计）/ 进度条悬停帧预览 / 字幕语言优先级接线 / 探索页在线数据（Bangumi 时间表 / 热度 / 条目建库）/ 番剧设置分组 / 样式注册 / 运行期零 Node / 文档同步 52 条（反证：check:anime-module:refute，47 条）
npm run task -- check:settings        # 设置页「播放·媒体」+「翻译服务」+ ② 分组简洁化 + 运行状态卡（日志零点击可见）+ X-C3 裁定结果 + ④ 功能梳理（侧栏标签 / 存储占用 / 第三方许可 / def）+ 盒式提示内边距 + 正文首选字体（源柔ゴシックP）+ 组说明/blurb 缺省不渲染 + **C5 许可清单的引擎/模型段** + **D4 运行时实况行** 186 条（反证：check:settings:refute，145 条）
npm run task -- check:units           # 前端分层 / hooks / 别名 / 状态 / 屏装配件分派 / 灵动岛 / 看图缩放 / 样式分层 46 条（反证：check:units:refute）
npm run task -- check:stall           # U10② 引擎卡死：「静默有上界 + 每次尝试留痕 + 进行中落盘」7 条 / 反证 3 条（mock 引擎对指定 seq「永不回包」）
npm run task -- check:retry           # 队列「重试」任务身份：复用**同一** taskId / 不冒历史行 + 翻译方向贯通 10 条 / 反证 7 条（mock 引擎 + 真服务子进程）
npm run task -- check:lib-manage      # 队列多选删除 + 漫画库隐藏/删除/新建/归并/封面/改号：仅终端态可删 / deleteFiles 勾选 / 越界名 403 / 前端接线 23 条 / 反证 12 条（反证锚点在 **Rust** 源码：check:lib-manage:refute）
npm run task -- check:retranslate     # 单张漫画返工重译 + 全屏缩放：覆盖译文 / 不碰原图 / 与 resume 分工 / 缩放不抢音量键 12 条 / 反证 5 条（反证：check:retranslate:refute）
npm run task -- check:engine-settings # S6 引擎设置面：档位 / 后端 / 空闲 / 模型目录 + 模型下载状态 61 条（反证：check:engine-settings:refute）
npm run task -- check:translate      # ver2.2 在线翻译服务（有道智云）：签名 v3 / 四层超时 / 限流 / 三层设置 / 密钥隔离 / 契约适配器 / 5 路由端到端 54 条（反证：check:translate:refute，8 开关；假上游默认发真 SSE 帧，零网络秒级）
npm run task -- check:docs            # 文档 ↔ 实现一致性 21 条：条数对账 / 两种形态的命令存在（`npm run <入口>` 对 package.json、`npm run task -- <id>` 对命令清单）/ 禁词 0 命中 / 分组覆盖
npm run task -- check:bundle          # 打包配置钉子 13 条 / 反证 18 条（平台分叉：Windows 走 nsis、基座仍 macOS 专有；W5 判据取**配置**：`bundle.resources` 不得含 `service/` 与 `node.zip`；**W6** 必需资产条目在且 src 真实存在；**W7/W7b（C5）** 随包 **0 个模型权重**（后缀黑名单 + 与 `engine/models.manifest.json` 逐条交叉）；**W8–W11（E2/E3）** NSIS 安装器钩子：长路径**只读提示**（不替用户改 `HKLM`）+ 卸载**默认保留**引擎运行时且不碰作品目录 + 引导写明 SmartScreen + **每个弹窗都有 `IfSilent` 守卫**（否则静默安装/卸载会被弹窗挂死，不是变红是不返回）；源码级，不起进程）
npm run task -- check:resources       # 随包资源寻址 **A1/A2** 三环境取证 8 条 / 反证 4 条（dev 态不误报 · 打包齐备取资源目录 · 打包缺失报 `RESOURCE_MISSING` · 优先级 · 必需资产交叉验证 · 源码钉）
npm run task -- check:packaged        # **A4 打包后冒烟**：真实安装包三层取证 12 条（nightly 层；NSIS 静默安装 → `--check-assets` + `--engine-crf-plan` 命中包内 wheel → 起服务打 `/health` + mock 替身 + 启动配方）
npm run task -- check:runtime-probe   # **B2/B5 引擎运行时七项只读检测** 78 条 / 反证 5 条（`GET /api/v1/engine/runtime`；`venvRoot`/`python`/`source`/`deps`/`patches`/`llm`/`weights` 逐项独立翻转 + `detail` 必带绝对路径 + 缺补丁点名到 patch id + mock 档不 warn + junction 场景三项 env 判定穿过链接。末两项属**模型链**（D-231③），前五项全绿但缺它们时 `ready` 仍为 false）
npm run task -- check:path-single-source # **B3 检测与启动同源** 5 条 / 反证 1 条（`/engine/runtime` 的 `python.path` vs `--print-launch-plan` 的 `engine.cmd[0]` 逐字节比对）
npm run task -- check:launch-gate    # **D6 real 档启动前预检闸门** 10 条 / 反证 4 条（real+未就绪 ⇒ **②/③ 一个不起、① 照常起**（D-229）并逐项点名七项；mock 档不过闸；含三条源码钉：「`gate_message(` 早于 `spawn_spec(&plan.engine`」+「闸门不得连 ① 一起挡」+「`wait_probe` 先查子进程存活再谈超时（D-231②）」）
npm run task -- check:install-guide  # **D5 安装引导与产品对拍** 18 条 / 反证 6 条（两份引导的落点模板代入本机后 == `mangasvc --print-paths` 推出的落点、体积标记 == 清单按平台求和、七项就绪项 · 三条落点纪律 · 平台形态互不串 · 两种命令形态都存在）
npm run task -- check:notready-state # **D1「运行时未装配」独立成态** 21 条 / 反证 10 条（两条链路都带 `runtime` 块 · 七项判据含模型链的 `llm`/`weights`（D-231③）· **装配五段取代 L1–L4**（D-233，承 D-231⑥）：五句文案逐字冻结 + 旧阶段表真的删干净 + 段号只来自 `download.step`、第五段「就绪」由 `runtime.ready` 收尾而不是第五个事件 + 引导页与时间线共用同一个 `AssemblyTimeline` · 新分支不混进服务失败 · 「约 X GB」来自服务端 `requiredBytes`）
npm run task -- check:models-guide   # **D8 模型引导清单（渲染而非编写）** 14 条 / 反证 4 条（逐条目标绝对路径 ⟷ Node 独立算 · 就绪 = 在位且大小一致 · 改清单副本 ⇒ 输出跟着变）
npm run task -- check:size-guide     # **C1 体积与落点如实告知** 16 条 / 反证 3 条（`guidance.totalBytes` == 本平台清单 `sizeBytes` 求和且与 D1 同数 · 分档之和恒等于总量 · 与安装引导文档三方闭环 · 界面无写死 GB）
npm run task -- check:model-runner   # **C2 执行体随包定位** 12 条 / 反证 3 条（默认执行体 == 当前可执行文件的**绝对路径** · verify 跑得起来、不是 INTERNAL · 不在盘上时报路径 · 跨卷单独记账）
npm run task -- check:platform-guide # **C3 `llama-server` 按平台分化** 12 条 / 反证 3 条（`MIAO_PLATFORM` 接缝下两个方向都真跑：Windows 只出 `win32-x64` 的 runtime 条目、macOS 只出 mac 条目；引导侧与下载器**给同一个答案**）
npm run task -- check:offline-fallback # **C4 离线兜底** 9 条 / 反证 3 条（权重在盘才注入 `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE`；`--link` 在**不可达地址**下零网络重建引擎真要打开的那条路径（含 HF 的 `snapshots`+`refs/main`）；清掉链接 ⇒ 引擎树那一路立刻红，而 **store 那一路始终全绿** —— 两层判据真的分层）
npm run task -- check:progress-truth # **D2 进度只来自真实来源** 10 条 / 反证 3 条（数据源只推**读到的行** · `lastLogLine` 没有就不显示 · 没有行时整块不渲染，代码里不存在占位数字）
npm run task -- check:extract-atomic # **D3 原子解包** 6 条 / 反证 3 条（真 `tar` + 夹具：解包失败时 `destDir` **一个字节都不动**、不留 `.part`；旧的「先删后解」一旦还原回去就变红）
npm run task -- check:pydensecrf-wheel # **B4 预编译 wheel 通道** 11 条 / 反证 6 条（`--print-plan` 四态判定：命中且 sha256 对得上 ⇒ 走 wheel；哈希不符 ⇒ **拒绝并回退**；文件不在盘上 / 只有别的平台条目 ⇒ 回退。🔴 回退是**前提**：清单为空仍能装。清单条目 `local` 与 `url` **二选一互斥**；`--print-plan` 与 `--wheel-entry` 是只读模式，非 Windows 下也能用）
npm run task -- check:pydensecrf-wheel-install # **B4 真装一次**（nightly）：`pip install --no-index --no-deps` 成功（**自足、不联网、不编译**）+ 真二进制 + 构造 `DenseCRF(10,10)`。硬前置是有 `--build-wheel` 产出的 wheel
npm run task -- check:offline-real   # **C4 真引擎离线加载**（nightly，分钟级，要真权重）：离线旗标生效下 ②③ 都到 running + 真跑一张英译中（走 nllb 的 HF 缓存）并落盘
npm run task -- check:uninstall-keep # **E3 真卸载一次**（nightly，要安装包 + 本机有引擎运行时）：静默卸载不挂住 · 卸载真生效 · 引擎运行时与作品目录**原封不动**
npm run task -- check:macos-compat   # **D7 macOS 兼容** 11 条 / 反证 4 条（解释器两个平台形态都在 + 实跑不串 + 检测与启动逐字节同源；**Windows 专用脚本在非 Windows 下 exit 2 并指向 macOS 引导**（不是 `ENOENT python.exe`）；文档分平台；`unverified` 记账）
npm run task -- check:macos-signing  # **E1 macOS 签名 + 公证** 8 条 / 反证 4 条（entitlements 四项为 true 且无 app-sandbox · `hardenedRuntime` + entitlements 接线 · 打包前自检：缺变量非零退出并点名 / `MIAO_NOTARIZE=0` 放行但告警 / 变量齐放行 · `app:build:mac` 串上自检）
```

**F 组「服务 Rust 化」的契约钉子**（F0–F5 已全部完成，见 `docs/internal/packaging-local-engine-dev-plan.md`）——
D-209 起**靶子只剩一个**（`target/debug/mangasvc`）：对照端逐块改成**冻结 golden**
（`e2e/service/golden/*.json`）或 Rust 自证出口（`mangasvc --*-selftest` / `--print-paths`），
`MIAO_SERVICE_IMPL=node` 现在**抛错**（退役门，静默落回 = 假绿）：

```bash
npm run task -- check:paths          # F2 路径解析与 config.mjs 逐字节对拍 5 条 / 反证 5 条（13 键快照 + B1 的 appData 落点 + B1 收尾的装配脚本同源）
npm run task -- check:store# F3  任务库内核对拍 24 条 / 反证 24 条（serde 字段声明序须逐字复刻 Node 键序）
npm run task -- check:store-exec     # F3-b 执行/队列对拍 74 条 / 反证（7 场景连定义都单源）
npm run task -- check:engine-parity  # F4 引擎协议/配方层对拍 24 条 / 反证
npm run task -- check:engine-http    # F4-b1 引擎 HTTP 运行期对拍 18 条 / 反证（伪引擎喂帧）
npm run task -- check:llm-supervisor # F4-b2 ③ supervisor 对拍 4 条 / 反证（起真 mock-llm 子进程）
npm run task -- check:harness        # F0 双靶子 harness 7 条 / 反证（未知 IMPL 取值必须吵一声）
npm run task -- check:routes         # F5 路由表/转发计数 9 条（--final 10 条 = 完成门）/ 反证 4 条（转发数必须 0）
```

> ⚠️ **仓库里那份 Node 服务实现（`service/`）已整目录删除**（D-209）：它先被摘出
> **产品运行时与随包**（F5.8），随后逐块失去对照对象 —— 同源对拍改**冻结 golden**、
> 取证改读 Rust 自证出口、反证锚点搬进 Rust 源码 —— 于是整目录退场。
> 留在仓库里的 Node 只有**测试替身**（`engine/src/*`）与**开发/装配脚本**（`engine/scripts/*`），
> 两者都不进包、不在产品运行时里。

**S7 真机端到端 E1–E11**（逐项取证总表：`docs/internal/engine-e2e-acceptance-report.md`）—— 这几条**不进常规门**，按需手动跑：

```bash
npm run task -- check:e3:real            # E3  真引擎全链路 31 张              （真权重，分钟级）
npm run task -- check:e4[:refute]        # E4  档位：引擎真在用的那一档        6 条 / 反证 4 条
npm run task -- check:e7:real[:refute]   # E7  3.6 GB 真权重 sha256 + 篡改必检出 6 条 / 反证 3 条
npm run task -- check:e8[:refute]        # E8  加速后端 3 轮真服务             6 条 / 反证 4 条
npm run task -- check:e10[:refute]       # E10 安全：回环 / 非图片字节 / 403    7 条 / 反证 4 条
npm run task -- selftest:app:e11:real    # E11 三进程树回收 + E1 生效参数快照 （真进程，分钟级）
```

> **E9（与插件联调）不在本仓**：在 `miao-trans` 仓跑 `node e2e/e9-real-engine.mjs`（先构建扩展）——
> 真实漫画站 31 张 + 真引擎，19 条断言，约 10 分钟；产物落该仓 `.temp-translate-test/`（已 gitignore）。
> 脚本自己拉起并收尾 manga-service / 引擎 / ③ / `:8001` 执行器（**孙进程**，漏杀会让下一轮全 `engine_engine_error`）。

各组判据与「为什么这么测」见 `docs/internal/dev-plan.md` §4；一路踩过的环境陷阱见 `docs/internal/spec-notes.md`。

> **在代理（沙箱）里跑 e2e 时，请把临时目录挪到系统临时区**：
> ```bash
> MIAO_E2E_TMP="$(node -e 'console.log(require("os").tmpdir())')/miao-e2e" npm run task -- e2e
> ```
> 运行时的「安全删除守卫」会拦截仓库内 `.tmp/e2e/` 的批量删除（连开头那次清理都起不来），
> 而它对系统临时目录下的路径整条绕过。一件事两样症状、排查全过程见 `docs/internal/spec-notes.md` D-19。

## 状态总览（截至 2026-10-16）

> 逐条留痕见 `docs/internal/spec-notes.md`（D-01~D-136）与 `docs/internal/spec-notes-1.md`（最新 **D-221**）·
> 里程碑逐项见 `docs/internal/engine-integration-plan.md`。
> **类型检查 + 断言通过 ≠ 功能可用** —— 下列「未验证」项即按此口径如实标注。

**✅ 已完成**

- **ver1.0 · 漫画翻译**：本机投放 · 串行队列（多选删除 / 重试**复用同一 taskId** / 继续翻译 / 单张返工重译）· 漫画库（搜索 + 分页 + 隐藏删除）· 设置页 + **引擎诊断视图** · 全屏看图（`Ctrl/⌘ + 滚轮`锚点缩放 + 拖拽，含**非手势兜底按钮**）。
- **翻译引擎接入 S0–S8 全部完成**：S1 适配层（D-62）· S2 三进程生命周期（D-64…D-70，`ServiceManager` 管 `Children{service, engine}`，就绪为**三重判定**：进程存活 + 端口 + HTTP）· S3 模型管理（D-72，断点续传 + store 硬链接）· S4 档位 / 加速后端 / 降档重试 / 两级空闲卸载（D-73，**③ 的归属权从 Rust 移交服务端** 的 `mangasvc::engine::supervisor`）· S5 契约增量 9 键 sidecar + 三个 503 分流 + 需鉴权的 `GET /engine/status`（D-74）· **S6 Box UI 诊断视图 + X-C3「准备中」时间线**（D-75）· **S7 真机端到端 E1–E11**（D-76，逐项总表 `docs/internal/engine-e2e-acceptance-report.md`）· **S8 插件串联 P-1…P-4**（D-77）。
- **ver2.0 · 音乐模块**：网易云 / 酷狗 / QQ / 咪咕**四平台**（登录 / 搜索分页 / 歌单 / 播放 / 评论 · 歌手详情——后两者**仅网易云**）+ 音频代理 + 加密 + 歌词；心动模式 · **桌面歌词（独立置顶窗）** · 逐字歌词（卡拉OK）· 翻译歌词 · 演唱行 · 六皮肤 · 歌曲右键菜单 · 灵动岛歌词卡 · 音乐缓存 · 搜索虚拟滚动 · 音乐快捷键。
- **ver2.0 · 设置页与 IA**：两级侧栏 · 两栏设置壳 · 「播放·媒体」/「翻译服务」分组 · 侧栏标签开关 / 存储占用 / 第三方许可（D-26…D-38、D-81…D-84）。
- **Windows 10**：真引擎装配已平台化 + S1 真机已出真译文（D-85）；`[Errno 22]` 日志风暴（D-88）与重启后孤儿执行器占 8001（D-89）已修。

**🚧 未做 / 未验证（如实登记）**

- 🟡 **打包分发（G-13）：服务栈已能随包，A4 起**第一次在真实安装产物上冒烟过**。
  **Windows 侧已能产出 NSIS 安装包**（`tauri.windows.conf.json` 平台分叉，`npm run task -- check:bundle` 钉住；macOS 包型仍是 `app` + `dmg`，未动）。
  服务栈侧：F 组已把服务全部搬进 Rust（`bundle.resources` **不需要** `service/` —— W5 明确禁止），
  A1 让 Rust 按资源目录寻址（`paths::resource_dir()`，release 构建生效）、A2 把必需的引擎资产
  （`models.manifest.json`）打进包 —— 两者由 `npm run task -- check:resources` 三环境取证、`check:bundle` W6 钉住。
  **A4 冒烟**（`npm run task -- check:packaged`，nightly 层）：对 `npm run app:build` 产出的**真实安装包**做
  NSIS 静默安装 → `mangasvc --check-assets` → 起服务打 `/health` + mock 替身 + 启动配方，三层取证 9 条。
  ⚠️ **仍未验证**：macOS 真机安装（本机只有 Windows）；引擎运行时本身**不随包**（用户自装，B1/B2）。
- **Windows 进程树回收三项仍 `unverified`**：Job Object / 无孤儿 `llama-server.exe` / `taskkill /T`（Rust 侧，D-85 只跑了引擎侧 S1）。
- **汽水音乐平台延后**（PD-1 / D-23）：Windows-only 平台耦合 + 依赖仓外二进制签名器；代码保留、不排首批。
- **音乐模块真机未验证项**：Radix 弹层观感 · 音频代理播放 · 皮肤观感（断言只覆盖结构与接线）。
- **G-18 遗留**：Windows 无 macOS `Transparent` 标题栏等价物（本机走 `backgroundColor`），**未装机验证**。
- **引擎 `pydensecrf` 的 GitHub 直链未钉到具体 commit**（移动靶，见上「快速开始」②）。

> 🔴 **引擎栈模式默认 `real`**：`npm run app` 起的**已经是真引擎**（`python main.py` + `llama-server`，需要 `<appData>/MiaoDock/manga/runtimes/manga-translator/`，见 `engine/VERSIONS.lock`）。模拟引擎只在测试里被显式注入（`selftest.mjs` / `e2e.mjs` / `lifespan-selftest.mjs` / `capture.mjs` / `check:e5e6` / `check:contract`）。**本机没拉引擎（运行时目录不在）时产品链路起不起来** —— 缺哪一项由 `GET /api/v1/engine/runtime` 逐项报出（B2）。

## 许可

[MIT](LICENSE)。

⚠️ 这只覆盖**本仓库自己的代码**。翻译引擎与模型权重是**用户自装、不随包**的第三方资产，
它们各自的许可是另一回事（引擎侧有 GPL-3.0-only 与 CC-BY-NC 系条目）：
逐条结论与「能不能随包」的判定见 `docs/distribution-license-conclusion.md`；
仓库内会随应用分发的那些依赖（npm / Cargo / 字体）由 `npm run task -- gen:licenses`
生成 `src/generated/licenses.json`，并在设置页「关于」组里呈现。

## 贡献

先读 [`CONTRIBUTING.md`](CONTRIBUTING.md)：提交信息格式（单行 `类型(模块): 一句话`）、
验收命令清单、目录分层与改名纪律、以及本仓库最要紧的那条 —— **每条源码断言都要配一条反证轮**。

## 截图

对外展示图放 [`snapshots/`](snapshots/README.md)；`docs/refs/` 里的是**验收取证图**（只增不改）。
两者不互为副本，界与现有素材清单见 `snapshots/README.md`。
