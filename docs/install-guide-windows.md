# 安装引导 · Windows（本地翻译引擎）

> 适用：Windows 10 / 11 x64（含 arm64 解释器回退，见 §6）· miao-dock ver2.2 · 更新 2026-10-14
>
> 本文只讲**装配引擎运行时**（Python / 依赖 / 模型权重 / llama.cpp）。装完它，喵坞的
> 真引擎档（默认档）才能起来；不装也能用，但只能跑 mock 替身（`MIAO_ENGINE_PROTOCOL=mock`）。
>
> 落点与体积的事实源是**产品自己**：路径来自 `mangasvc --print-paths`，体积来自
> `engine/models.manifest.json`。**本文的每个数字都可以复算**（§2 / §3 各给了命令）。

---

## 0. 普通用户：点一次就装好（默认路径）

如果你装的是**喵坞安装包**（不是从仓库自己编译），**完全不需要看下面的命令行**。

打开喵坞后，如果它发现本机还没有翻译引擎，会自动停在一张引导页上，给你两条路：

- **主路径 · 下载本地引擎**：点「开始下载」这一颗按钮即可。喵坞会在后台把 Python 运行时、
  引擎源码、翻译权重一次性下载并自动装配好 —— **全程不出现任何命令行、路径或专业名词**。
  下载分两段：第 1 段准备运行环境（Python 运行时 + 引擎源码 + 依赖 + 视觉模型 + llama-server），
  第 2 段下载翻译权重（约 6 GB）并在后台继续。两段都可中断、可续传，断了点「继续」接着下。
- **备路径 · 使用在线翻译**：在引导页里直接选平台、填一次密钥，保存即用，不用下载引擎。

下载进行时，顶部工具条会显示「引擎下载中」和一圈细进度，点一下能回到下载页看百分比、
速度、剩余时间、当前文件。下载**不阻塞**任何操作：你可以随时切去漫画库、设置、音乐页继续用。
断网 / 盘满 / 超时导致中断时，工具条会变成「下载中断」并给一颗继续按钮，点一下从已下的位置
接着下，**不会从头重来**。

下面 §1–§7 的全部命令行步骤，只服务于**从仓库自建自装**或**排障** —— 普通用户一般用不到。

---

## 0. 第一步：先定落点，然后不要再改

引擎运行时的落点是：

```
%LOCALAPPDATA%\runtimes\manga-translator
```

典型展开：`C:\Users\<你>\AppData\Local\runtimes\manga-translator`。

**先把这件事定下来再动手** —— 因为它决定了后三步往哪儿写、产品往哪儿读。
查产品实际用的落点（**权威答案，不要靠猜**）：

```powershell
mangasvc --print-paths           # 打包版在安装目录里；从仓库自建时用 .\app\src-tauri\target\debug\mangasvc.exe
```

输出的 `runtimeRoot` 就是落点的父目录（产品落点 = `<runtimeRoot>\manga-translator`）。
它与本文这一行**逐字节一致** —— 改这一行或者改产品，`npm run task -- check:install-guide` 会变红。

**三条纪律（每条都对应一类真实故障）：**

1. **落点定了别挪。** 装配脚本与产品读的是同一个落点（B1 起同源），但**装配完成后**把
   `runtimes` 搬走，产品会报「运行时未装配」——因为没有任何机制会跟着搬。
   真要挪就设 `MIAO_RUNTIME_ROOT` 指向新的运行时根（产品与装配脚本都认这个变量），
   然后**重跑 §3 的四条命令**。整个 `runtimes` 目录是一个整体，不要只搬其中一半。
2. **别放同步盘 / 云备份目录。** OneDrive / 坚果云这类工具的「按需下载」会把
   占位符文件留在盘上：路径存在、`stat` 成功、**内容为空**。引擎读到的是 0 字节权重，
   报错离根因极远（典型症状是加载到一半崩、或首图直接 failed）。
   落点默认在 `%LOCALAPPDATA%`，**不**在 OneDrive 管辖范围内 —— 别把它改成同步目录。
3. **别放会被清理的临时目录。** `%TEMP%`、下载目录、以及任何被"空间清理"工具瞄上的
   位置都会在某次开机后少掉几个 GB，而症状只是"昨天还好好的"。

> 想把 6.9 GB 放到**别的盘**（C 盘紧张）是合法的 —— 但要用①的 `MIAO_RUNTIME_ROOT`
> 一次性定好，或把 `runtimes` 目录做成**目录联接（junction）**指向别的盘：
> ```powershell
> mklink /J "%LOCALAPPDATA%\runtimes" "D:\runtimes"
> ```
> 产品与检测都**跟随**链接（不是把链接本身当目录，见 B2/D-177），所以这条路是支持的。

---

## 1. 前置条件

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 系统 | Windows 10 21H2+ / Windows 11 x64 | 需要系统自带 `tar`（bsdtar，Win10 起自带）解包归档 |
| 磁盘 | **≥ 13 GB 可用**，建议 20 GB | 见 §2 的构成 |
| MSVC | Visual Studio 2022 **生成工具**（MSVC v143 + Windows SDK） | **默认路径不需要**：`pydensecrf` 走随包预编译 wheel。只有 wheel 通道不成立才回退现场编译，那时才用它（§5.1） |
| 显卡 | NVIDIA（CUDA 12.x 驱动） | 无独显也能装，只是走 CPU 档、慢很多 |
| 长路径 | `LongPathsEnabled = 1`（**可选**） | 引擎源码树深 + venv 路径长，开了最省事。产品侧的做法是**先量再说**：装配期实测落点最长路径与 260 的余量，写进 `.runtime.ready.json` 的 `longPath` 并在余量紧张时报告（D-213：只提示，**不替你改注册表**，见 D-189） |
| Node | ≥ 22 | 本文的四条命令是 `npm run …`（来自仓库，见文末「适用对象」） |

开启长路径（管理员 PowerShell，**一次性**，之后要重开终端）：

```powershell
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
  -Name LongPathsEnabled -Value 1 -PropertyType DWord -Force
```

> 安装程序会在装完后**自己读一遍**这个开关（`HKLM\SYSTEM\CurrentControlSet\Control\FileSystem`）；
> 没开就弹一段说明把上面这条命令原样给出来。它**不会**替你改（那是系统级设置、要提权），
> 所以看到提示就照做 —— 否则首次装配会在中途报「文件名或扩展名太长」。
>
> 另外，装配结束时喵坞会**量一遍**落点下最长路径，把字符数与 260 的余量写进
> `<落点>\.runtime.ready.json` 的 `longPath` 段。这条一直是预防性推测
> （`engine/VERSIONS.lock` §6.2 记的三个 Windows 必踩坑里并没有它），量过之后
> 「要不要开这个开关」才是可复算的事实：余量充足就不用管它。装配日志里也会打同一行。

### 1.1 安装包首次运行会被 SmartScreen 拦一下（正常现象）

安装包**没有代码签名**，所以 Windows 会弹「Windows 已保护你的电脑」。
做法：点「**更多信息**」→「**仍要运行**」。

- 这不代表安装包有问题，只代表它没有向微软买签名（对外正式分发前会补签名与公证）；
- 与本项目在 macOS 上的 Gatekeeper 提示是同一件事（见 `docs/install-guide-macos.md`）；
- 安装**之后**的功能不受影响。

---

## 2. 体积：装之前先说清楚（可复算）

<!-- install-guide:size platform=win32-x64 bytes=7445962918 -->

Windows 上模型与外部二进制的**合计 7,445,962,918 字节（≈ 6.93 GiB，17 个条目）**。
每一项都取自 `engine/models.manifest.json` 的 `sizeBytes`，按当前平台过滤
（不带 `platform` 字段的条目不区分平台，`win32-x64` 的只有 Windows 才下）：

```powershell
node -e "const m=require('./engine/models.manifest.json');const f=m.files.filter(x=>!x.platform||x.platform==='win32-x64');console.log(f.length+' 个条目  '+f.reduce((a,x)=>a+x.sizeBytes,0).toLocaleString('en-US')+' 字节')"
```

除了这 6.93 GiB，落点下还会有：

| 组成 | 大致体量 | 出处 |
| --- | --- | --- |
| 模型权重 + llama.cpp + CUDA 运行库 | 6.93 GiB | `models.manifest.json` 求和（上面那条命令） |
| Python 3.11 运行时（python-build-standalone） | ~60 MB | `setup:engine` ① |
| 引擎源码（上游 commit 归档，已解包） | ~60 MB | `setup:engine` ③ |
| venv 依赖（torch + torchvision + onnxruntime + …） | **约 4–6 GB** | `deps:engine` ② |

⇒ 按 **13 GB 以上**预留；`torch` 那几 GB 是最大的一块，且**按平台/后端不同**
（cu126 构建比 CPU 构建大得多）。装完可以自己量：

```powershell
Get-ChildItem -Recurse "$env:LOCALAPPDATA\runtimes\manga-translator" | Measure-Object -Property Length -Sum
```

> 下载总量与落盘量**不是一回事**：`fetch:models` 会在 `<落点>\.download-cache\` 留下一份
> 归档，解包后可以删（`--extract` 成功即不再需要）。

---

## 3. 安装：四条命令，按序，幂等

> 🔴 这一段只给**从仓库自建自装**或**排障**用。打包版用户走应用内「开始下载」即可（见 §0），
> 不用自己敲下面任何一条命令。

```powershell
npm run task -- setup:engine     # ① Python 3.11 运行时 + venv + 引擎源码（+ 打上游源码补丁）
npm run task -- deps:engine      # ② 往 venv 里装引擎依赖（Windows 专用脚本，见 §5.1）
npm run task -- fetch:models     # ③ 按清单下模型权重 + llama.cpp / CUDA 运行库归档
npm run task -- extract:models   # ④ 解包归档 → bin\llama\llama-b11417\llama-server.exe
```

**幂等**：四条都可以重复跑 —— 目标已存在且非空则跳过，不重复下载。中断了直接重跑。
想强制重来加 `--force`（如 `node engine/scripts/setup-engine.mjs --force`）。

每一步做完**落点里应该出现什么**（这也是 §4 自检的判据）：

| 步骤 | 产物 | 就绪项 |
| --- | --- | --- |
| ① | `python-3.11\python.exe` · `venv\Scripts\python.exe` · `src\server\main.py` · `src\` 里带 `# miao-dock 补丁 D-xxx` 标记 | `venvRoot` `python` `source` `patches` |
| ② | `venv\Lib\site-packages\` 下有 `torch/` `onnxruntime/` `transformers/` `pydensecrf/` … | `deps` |
| ③ | `models-store\`（权威副本）· `models\sakura\*.gguf` · `bin\*.zip` | — |
| ④ | `bin\llama\llama-b11417\llama-server.exe` · `src\models\` 里出现硬链接（不是拷贝） | — |

> ③④ 之后引擎源码树里的模型是**硬链接**（`linkTo`），权威副本在 `models-store\`。
> 换引擎版本（`src\` 被重装）后跑 `npm run task -- fetch:models --link` 可**零网络**重建链接，
> 不必重下 6.9 GB。

**只装其中一部分**（排障/省流量）：

```powershell
node engine/scripts/setup-engine.mjs --check     # 只报告现状，不下载
node engine/scripts/fetch-models.mjs --check     # 只校验已下的东西（含 HF 缓存可解析性）
node engine/scripts/fetch-models.mjs --set visual     # 只下默认流水线必需项（≈ 0.7 GB）
node engine/scripts/fetch-models.mjs --set translation # 只下英译中 nllb（≈ 2.3 GiB）
node engine/scripts/fetch-models.mjs --link           # 只重建引擎树里的链接（零网络）
```

---

## 4. 装完自检：五个就绪项，逐项点名

产品把「引擎运行时是否装配好」拆成**五项**，每项独立判定、独立报路径
（`GET /api/v1/engine/runtime`，B2）。命令行侧同一个函数：

```powershell
mangasvc --check-runtime-gate real
```

输出里 `ready` 为 `true` 才算装齐；不是 `true` 时它会**逐项点名**缺哪一项、缺在哪个绝对路径、
以及怎么补（`fix`）。五项与 §3 的对应关系：

| 就绪项 | 判据 | 没就绪时补哪一步 |
| --- | --- | --- |
| `venvRoot` | 落点下的 `venv\` 是目录 | ① `setup:engine --venv` |
| `python` | `venv\Scripts\python.exe` 在盘上 | ① `setup:engine --python` |
| `source` | `src\server\main.py` 在盘上 | ① `setup:engine --source` |
| `deps` | venv 的 `site-packages` 里有引擎依赖（含 torch / pydensecrf） | ② `deps:engine` |
| `patches` | 上游源码补丁**逐条**都在（缺哪条报哪个 patch id） | ① 重跑 `setup:engine --source` |

服务起起来之后，同一个事实也可以从 HTTP 看：

```
GET http://127.0.0.1:8000/api/v1/engine/runtime
```

> **为什么值得先跑这一步**：real 档启动时如果运行时没装齐，喵坞会在**起任何子进程之前**
> 拦下来、秒级告诉你缺什么（D6/L0）。不先自检也不会"卡住 4 分钟然后报一句服务启动失败"。

---

## 4.1 新电脑（干净机器）验收清单 —— 逐项对照，不靠"我觉得好了"

> ⚠️ **验证状态：`unverified`**。本节**没有**在本机验证过 —— 本机是一台已经装好引擎的
> 开发机，不是干净机器。能自动化的那一半已经**真跑**了（`npm run task -- check:engine-bootstrap-real`
> 在产品自己的装配函数上真下、真装、真 import，见 D-215/D-216），但"这台机器上真的没有
> Node / Python / MSVC、也没有任何 `MIAO_*` 变量"只能在新机器上确认 ⇒ 归 D7 真机验收。

**前置**：用安装包装好喵坞。**刻意不装** Node / Python / MSVC / Visual Studio 生成工具，
也**不要**设任何 `MIAO_*` 环境变量 —— 设了就不再是"零配置"这条路，本节也就不成立了。

| # | 做什么 | 期望看到什么（对不上就是缺陷，不是"环境问题"） |
| --- | --- | --- |
| 1 | 打开喵坞 | 停在一张引导页（本机没有引擎时），主按钮只有一颗「开始下载」；**整页没有命令行、没有路径、没有 node/pip/MSVC 字样** |
| 2 | 点「开始下载」 | 顶部工具条出现「引擎下载中」+ 细进度条；点进下载页有百分比 / 速度 / 剩余 / 当前文件；**取不到总量时显示「准备中」而不是 0%** |
| 3 | 看第 1 段的阶段名 | 依次出现：Python 运行时 → 虚拟环境 → 引擎源码 → 源码补丁 → 依赖安装 → 模型权重。**第 1 段结束时不该出现"可以开始翻译"**（第 1 段不含翻译权重） |
| 4 | 第 1 段跑完，切去「设置 → 翻译服务」 | 引擎状态从「需下载」变成**就绪**；此时在线翻译可用，本地翻译等第 2 段 |
| 5 | 等第 2 段（翻译权重，约 6 GB） | 两段之间**不出现**假的"已完成"（工具条一直显示下载中）。中途拔网线 ⇒ 变「下载中断」+ ▶；插回网线点 ▶ ⇒ 从已下位置续，**不从头重下** |
| 6 | 全装完后翻译一张漫画 | 出译文。盘上核对：`<落点>\venv\Lib\site-packages` 里有 `torch` 与 `pydensecrf`；`<落点>\.runtime.ready.json` 存在 |
| 7 | 长路径体检（可复算，不必命令行） | `.runtime.ready.json` 里有 `longPath.maxChars / limit=260 / margin`。若装配日志里出现「距 260 上限仅剩 N 字符」或「已超过上限」，说明该落点偏深 —— 报告它，不要自己去改注册表（D-189：产品只提示不代改） |
| 8 | 可选：命令行侧核对 | 安装目录里的 `mangasvc.exe --check-runtime-gate real` 输出 `ready: true`，五项（`venvRoot` / `python` / `source` / `deps` / `patches`）全齐 |

**三件最容易误判的事**（先记在这里，免得当成缺陷来报）：

1. **第 1 段跑完还不能翻译** —— 这是设计：翻译权重（Sakura / nllb）在第 2 段。
2. **SmartScreen 会拦一次**（§1.1）—— 未签名安装包的正常行为，与本条链无关。
3. **`pydensecrf` 不会去编译** —— 目标机没有 MSVC 时它走的是随包 wheel（G3/D-208）。
   如果日志里出现「pydensecrf 源码编译失败…需要编译器」，那不是"零配置失败"，
   而是**随包 wheel 没被选上**（清单条目 / 包内文件 / sha256 三选一出了岔），
   请把这一行原文贴出来 —— 它有 `engine/wheels.manifest.json` 这条线索可查。

---

## 5. Windows 上最容易踩的坑

### 5.1 `pydensecrf` 编译失败 / `deps:engine` 报错

`pydensecrf` 在 PyPI **没有任何 Windows wheel**（上游只发 sdist）。本仓库的默认路径是
**随安装包分发的预编译 wheel**（见本节末尾，装喵坞的用户**不需要** MSVC）；只有 wheel
通道不成立（无本平台条目 / 包内文件缺失 / sha256 不符）时才回退到**现场用 MSVC 编译**。
`deps:engine` 与产品装配都把依赖**拆两批**装（其余依赖一把装完、`pydensecrf` 单独处理）——
因为 pip 是事务性的：混在一批里，`pydensecrf` 失败会让**整批 100+ 依赖一起回滚**。

排障：`node engine/scripts/install-engine-deps.mjs --print-env` 会打印它探测到的
MSVC / Windows SDK 路径 —— 多半是这里空着。

**不想装 MSVC？先看有没有预编译 wheel 通道**（B4）：

```powershell
node engine/scripts/install-engine-deps.mjs --print-plan
```

它只回答一件事：pydensecrf 这一项会走**预编译 wheel**（无需编译器）还是**源码编译**。
判定顺序是「清单里有本平台 + 本 Python 版本的条目 → **包内那一份优先**（其次才是本机通道目录）
→ 文件在位 → sha256 与清单一致」，任一条不成立就回退到源码编译
（**回退是设计的一部分，不是降级**）。清单在 `engine/wheels.manifest.json`。

**已经装了编译器、想给别人留一条免编译的路**（一条命令产出 wheel + 算好 sha256）：

```powershell
node engine/scripts/install-engine-deps.mjs --build-wheel
```

它复用 `deps:engine` 同一份 MSVC 环境探测与 sdist 缓存，把 wheel 产出到通道目录
（`<落点>\.download-cache\wheels\`）并**打印可直接粘进清单的条目**（含真 sha256）——
清单里那个哈希**不允许凭记忆写**，这也是为什么它由脚本算。
🔴 产出后本机就**立刻**走 wheel 不编译（同一台机器上重装更快）；
要让**别人**也用得上，得把 wheel 传到镜像通道并在清单里补 `url`。

**普通用户不需要做上面任何一步**：`win32-x64 / cp311` 那颗 wheel 自 G3 起**随安装包分发**
（清单条目标 `bundled: true` + `path`，实测 sha256 与体积都在清单里），
装完喵坞后它就在包内，`planCrf()` 会优先取它 —— 目标机**既不需要 MSVC、也不需要联网下载它**。
（`--build-wheel` 与 `local` 那套现在只用于**补新平台**：例如给 macOS 或另一个 Python ABI 造条目。）

- 缺 MSVC/SDK：装「Visual Studio 2022 生成工具」，勾 **MSVC v143 生成工具** +
  **Windows 11 SDK**（或 Windows 10 SDK 10.0.22621）。
- 报 `LNK1158: 无法运行"rc.exe"`：`rc.exe` 不在 MSVC 目录里，在
  `Windows Kits\10\bin\<ver>\x64`。脚本已把它补进 `PATH`；自定义环境时注意这一条 ——
  报错发生在**链接**阶段，离"PATH 少了一项"很远。

### 5.2 掩码细化阶段 `AttributeError: module 'pydensecrf.densecrf' has no attribute 'DIAG_KERNEL'`

`requirements.txt` 里那行 `pydensecrf@…/master.zip` 是**移动靶**：上游把旧的模块级常量
迁进了枚举，而引擎源码仍用旧写法。症状很坏 —— **检测 / OCR / 翻译都跑完了**，到掩码细化
才炸，容易误判成"翻译坏了"。

`deps:engine` 会**自动**写入幂等兼容补丁（新旧 API 都能用）。手工装的（或自己重建过 venv 的）
按同一原理回填即可。检查是否已生效：

```powershell
& "$env:LOCALAPPDATA\runtimes\manga-translator\venv\Scripts\python.exe" -c "import pydensecrf.densecrf as d; print(d.DIAG_KERNEL, d.NO_NORMALIZATION)"
```

### 5.3 装了 CUDA 却走了 CPU / 首图特别慢

引擎按 `--use-gpu` + 档位决定后端。先确认 torch 看得见卡：

```powershell
& "$env:LOCALAPPDATA\runtimes\manga-translator\venv\Scripts\python.exe" -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '-')"
```

`False` ⇒ 装的是 CPU 构建的 torch，或驱动太旧。venv 里那份 torch 是
`2.14.1+cu126`，需要 CUDA 12.x 驱动。**没有独显不是故障** —— 档位会自动降级，
界面上会说明走的是哪一档。

### 5.4 下载被代理劫持（本机 8080 推理链路不通）

引擎与 ③（llama-server）之间走 `127.0.0.1`。若系统或终端设了 HTTP 代理，
本机流量也可能被代理劫持 ⇒ 症状是"引擎起来了但翻译请求一直等"。产品的启动配方里
已经注入 `NO_PROXY=127.0.0.1,localhost,::1`（并保留你原有的代理项），
手工起引擎时请照做：

```powershell
$env:NO_PROXY = "127.0.0.1,localhost,::1"
```

### 5.5 中文 Windows 下的日志乱码 / 引擎写 stderr 报 `[Errno 22]`

引擎 stdio 必须是 UTF-8。启动配方里强制了 `PYTHONIOENCODING=utf-8`；手工起引擎时：

```powershell
$env:PYTHONIOENCODING = "utf-8"
```

---

## 6. 重装 / 迁移 / 卸载

- **重装**：删掉 `<落点>` 后重跑 §3 四条命令。只坏了 venv 就
  `setup:engine --venv` + `deps:engine`；只换引擎源码就 `setup:engine --source`
  + `fetch:models --link`（**零网络**恢复模型链接）。
- **迁移到新机器**：`runtimes` 整目录拷过去**不能用**（venv 与 python 运行时里有绝对路径），
  正确做法是在新机器上重跑 §3。模型那份 6.9 GB 可以从旧机器**拷 `models-store\`** 到
  同一相对位置，省一次下载 —— 拷完跑 `fetch:models --check` 验校验和。
- **卸载喵坞**：卸载时会**问你一句**「要不要一并删除翻译引擎运行时」，并列出它的完整路径与
  「常见 10 GB 以上、重装一次要几十分钟」。**默认是保留**（回车 / 误触都落在保留那一支），
  只有明确点「是」才会删 `<appData>\runtimes\manga-translator\`。
  ⇒ 选保留之后想清理，手动删掉该目录即可；你的作品目录（`%USERPROFILE%\Pictures\Box 漫画`）
  卸载程序**永不**触碰。

---

## 7. 许可（先说清楚，再决定要不要装）

- 引擎本体是 **GPL-3.0-only**；依赖里还有若干传染面更大的第三方。
- Sakura LLM 权重是 **CC BY-NC-SA 4.0：禁止任何形式的商用**。
- 英译中的 `nllb-200-distilled-600M` 是 **CC-BY-NC-4.0：同样禁止商用**
  （商用要先换成 MIT 档 `m2m100`）。

⇒ **本机自用可以；对外分发 / 商用之前必须先有法务结论**（`engine/VERSIONS.lock` §6）。

---

## 适用对象（一句话）

本文的四条 `npm run …` 命令**来自仓库**（需要 Node ≥ 22 与仓库工作区）—— 也就是说，
本引导面向**从仓库自建自装**的用户。打包版把这些装配动作收进包内（并接到同一套落点与
同一份清单）是 C2/D8 的收尾工作；**落点、体积、五项就绪判据三件事已经同源**，
包内引导接入时不会另起一套。

> ⚠️ **验证状态**：§0 的落点、§2 的体积、§3 的步骤与 §4 的判据都已与产品**对拍成钉子**
> （`npm run task -- check:install-guide`）；**装配链本身**（两批依赖 / 随包 wheel / 兼容补丁 /
> 按 `dest` 解包 / 阶段顺序 / 长路径体检）已在开发机上**真跑过产品自己的代码**
> （`npm run task -- check:engine-bootstrap-real`，见 D-215/D-216）。但**"这台机器没有 Node /
> Python / MSVC"** 这件事本机复现不了 ⇒ **§4.1 的新电脑验收清单标 `unverified`**，
> 归 D7 真机验收，在它完成前不计入「已验」。

> 附录：命令速查（都可在落点已定后任意重跑）

```powershell
mangasvc --print-paths                    # 产品实际用的全部路径（落点的权威答案）
mangasvc --check-runtime-gate real        # 五项就绪自检（缺哪项逐项点名）
npm run task -- setup:engine                    # ① Python + venv + 源码 + 补丁
npm run task -- deps:engine                     # ② venv 依赖（Windows 专用）
npm run task -- fetch:models                    # ③ 模型 + llama.cpp（按清单、按平台）
npm run task -- extract:models                  # ④ 解包
npm run task -- fetch:models --check         # 只校验，不联网
npm run task -- fetch:models --link          # 只重建链接，零网络
npm run task -- check:install-guide             # 这份文档本身与产品的对拍（开发者）
```
