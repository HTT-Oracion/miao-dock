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
│   ├── router/  屏级路由：`routes.ts` 路径表 · 读写口 `useNav`（`src/hooks/`） · `panes/` 屏装配件（**hash 路由**：URL 是「屏 + 应用内视图」的唯一事实源）
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

> 🔴 **命令全表只在一处**：[`docs/internal/commands.md`](docs/internal/commands.md)
> —— 每条命令 + 一句话用途 + 断言条数。本节不复制那张表。

```bash
npm run check          # static 快闸门（每次提交）
npm run check:changed  # 只跑与 git 变更相关的（日常）
npm run check:full     # static + service 全量（push / PR 前）
npm run check:nightly  # 含真引擎 / 模型与全部反证轮（定期）
```

跑单条：`npm run task -- <id>`（如 `check:units`）· 列清单：`npm run task`。

**自测怎么写、什么时候该写**见 [`docs/internal/test-policy.md`](docs/internal/test-policy.md)。
核心：逻辑改动必须有自动化验证；纯文案 / 样式改动以实际界面检查为主，
**不为凑覆盖率新增低价值脚本**。


## 项目状态

当前进度、里程碑、已知缺口与**未验证项**（含"类型检查 + 断言通过 ≠ 功能可用"的口径）
见决策台账与计划文档：

- `docs/internal/spec-notes.md`（D-01~D-136）+ `docs/internal/spec-notes-1.md`（D-137 起）
- `docs/internal/dev-plan.md` · `docs/internal/engine-integration-plan.md`
- `docs/internal/engine-e2e-acceptance-report.md`（真机取证逐项总表）

> 本 README 不再维护一份"截至某日期"的状态快照 —— 它必然过期，
> 而过期的快照比没有快照更糟（读者会以为那就是现状）。

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
