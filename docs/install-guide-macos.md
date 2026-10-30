# 安装引导 · macOS（本地翻译引擎）

> 适用：macOS 13+ · **Apple Silicon**（darwin-arm64）· miao-dock ver2.2 · 更新 2026-10-14
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

> ⚠️ **macOS 当前有一处与 Windows 不同的边界**：`pydensecrf` 的预编译 wheel 目前**只随包提供了
> Windows 版**（`engine/wheels.manifest.json` 里只有 `win32-x64` 一条 —— 造 darwin 条目需要一台
> 装了 Xcode 命令行工具的 Mac）。所以 macOS 上走产品内一键装配时，`pydensecrf` 会回退到
> **源码编译**，这需要本机已装 Xcode 命令行工具（`xcode-select --install`）。
> 装配到那一步若失败，报错会**如实点名需要编译器**；装好 CLT 后重跑即可（已就绪的阶段不会重做）。
> 把 darwin wheel 补进清单后这条边界自动消失（判据已由 `check:pydensecrf-wheel` 备好）。

下载进行时，顶部工具条会显示「引擎下载中」和一圈细进度，点一下能回到下载页看百分比、
速度、剩余时间、当前文件。下载**不阻塞**任何操作：你可以随时切去漫画库、设置、音乐页继续用。
断网 / 盘满 / 超时导致中断时，工具条会变成「下载中断」并给一颗继续按钮，点一下从已下的位置
接着下，**不会从头重来**。

下面 §1–§7 的全部命令行步骤，只服务于**从仓库自建自装**或**排障** —— 普通用户一般用不到。

---

## 0. 第一步：先定落点，然后不要再改

引擎运行时的落点是：

```
~/Library/Application Support/MiaoDock/manga/runtimes/manga-translator
```

完整路径是 `/Users/<你>/Library/Application Support/MiaoDock/manga/runtimes/manga-translator`。
（`~/Library` 在 Finder 里默认隐藏：按住 `⌥` 点「前往」菜单即可看到「资源库」。）

**先把这件事定下来再动手** —— 因为它决定了后三步往哪儿写、产品往哪儿读。
查产品实际用的落点（**权威答案，不要靠猜**）：

```bash
mangasvc --print-paths           # 打包版在 .app 的资源目录里；从仓库自建时用 ./src-tauri/target/debug/mangasvc
```

输出的 `runtimeRoot` 就是落点的父目录（产品落点 = `<runtimeRoot>/manga-translator`）。
它与本文这一行**逐字节一致** —— 改这一行或者改产品，`npm run task -- check:install-guide` 会变红。

**三条纪律（每条都对应一类真实故障）：**

1. **落点定了别挪。** 装配脚本与产品读的是同一个落点（B1 起同源），但**装配完成后**把
   `runtimes` 搬走，产品会报「运行时未装配」——因为没有任何机制会跟着搬。
   真要挪就设 `MIAO_MANGA_RUNTIME_ROOT` 指向新的运行时根（产品与装配脚本都认这个变量），
   然后**重跑 §3 的四条命令**。整个 `runtimes` 目录是一个整体，不要只搬其中一半。
2. **别放同步盘 / 云备份目录。** iCloud Drive 的「优化 Mac 储存空间」会把文件换成
   占位符：路径存在、`stat` 成功、**内容为空**。引擎读到的是 0 字节权重，报错离根因极远。
   落点默认在 `~/Library/Application Support`，**不**受 iCloud 管辖 —— 别改成
   `~/Documents`、`~/Desktop` 或任何被 iCloud 桌面与文稿同步的目录。
3. **别放会被清理的临时目录。** `/tmp`、`~/Downloads`、以及任何被"清理工具"瞄上的位置
   都会在某次重启后少掉几个 GB，而症状只是"昨天还好好的"。

> 想把 6.3 GiB 放到**外置盘**（内置盘紧张）是合法的 —— 但要用①的 `MIAO_MANGA_RUNTIME_ROOT`
> 一次性定好，或者把 `runtimes` 做成**符号链接**指向外置盘：
> ```bash
> ln -s /Volumes/ExtSSD/runtimes "$HOME/Library/Application Support/MiaoDock/manga/runtimes"
> ```
> 产品与检测都**跟随**链接（不是把链接本身当目录，见 B2/D-177），所以这条路是支持的。
> ⚠️ 外置盘拔掉后产品会报「运行时未装配」——这是正确行为，不是 bug。

---

## 1. 前置条件

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 芯片 | Apple Silicon（M 系列） | 清单里的 llama.cpp 条目是 `darwin-arm64`；Intel Mac 需自行换对应二进制 |
| 系统 | macOS 13 Ventura 或更高 | MPS 后端要求 13+ |
| 磁盘 | **≥ 13 GB 可用**，建议 20 GB | 见 §2 的构成 |
| Xcode CLT | `xcode-select --install` | 编译 `pydensecrf` 需要 clang 与头文件（与 Windows 的 MSVC 是同一件事） |
| Node | ≥ 22 | 本文的四条命令是 `npm run …`（来自仓库，见文末「适用对象」） |

```bash
xcode-select --install            # 已装过会提示 already installed，属正常
xcode-select -p                   # 应输出 /Library/Developer/CommandLineTools
```

---

## 2. 体积：装之前先说清楚（可复算）

<!-- install-guide:size platform=darwin-arm64 bytes=6802015203 -->

macOS 上模型与外部二进制的**合计 6,802,015,203 字节（≈ 6.33 GiB，16 个条目）**。
每一项都取自 `engine/models.manifest.json` 的 `sizeBytes`，按当前平台过滤
（不带 `platform` 字段的条目不区分平台，`darwin-arm64` 的只有 macOS 才下）：

```bash
node -e "const m=require('./engine/models.manifest.json');const f=m.files.filter(x=>!x.platform||x.platform==='darwin-arm64');console.log(f.length+' 个条目  '+f.reduce((a,x)=>a+x.sizeBytes,0).toLocaleString('en-US')+' 字节')"
```

除了这 6.33 GiB，落点下还会有：

| 组成 | 大致体量 | 出处 |
| --- | --- | --- |
| 模型权重 + llama.cpp | 6.33 GiB | `models.manifest.json` 求和（上面那条命令） |
| Python 3.11 运行时（python-build-standalone） | ~60 MB | `setup:engine` ① |
| 引擎源码（上游 commit 归档，已解包） | ~60 MB | `setup:engine` ③ |
| venv 依赖（torch + torchvision + onnxruntime + …） | **约 4–6 GB** | §3 ② 手动 pip |

⇒ 按 **13 GB 以上**预留。装完可以自己量：

```bash
du -sh "$HOME/Library/Application Support/MiaoDock/manga/runtimes/manga-translator"
```

> 下载总量与落盘量**不是一回事**：`fetch:models` 会在 `<落点>/.download-cache/` 留下一份
> 归档，解包后可以删（`--extract` 成功即不再需要）。

---

## 3. 安装：四步，按序，幂等

> 🔴 这一段只给**从仓库自建自装**或**排障**用。打包版用户走应用内「开始下载」即可（见 §0），
> 不用自己敲下面任何一条命令。

```bash
npm run task -- setup:engine     # ① Python 3.11 运行时 + venv + 引擎源码（+ 打上游源码补丁）
# ② 依赖：⚠️ 见下，macOS 这一步不能用 npm run task -- deps:engine
npm run task -- fetch:models     # ③ 按清单下模型权重 + llama.cpp 归档
npm run task -- extract:models   # ④ 解包归档 → bin/llama/llama-b11417/llama-server
```

### ② 依赖：手动 pip（这一步与 Windows 不同）

`engine/scripts/install-engine-deps.mjs` 是 **Windows 专用**脚本（它要拼 MSVC/SDK 的
`INCLUDE`/`LIB`/`PATH`，还要绕开 `vcvars64.bat`）。macOS 上直接手动装：

```bash
RT="$HOME/Library/Application Support/MiaoDock/manga/runtimes/manga-translator"
"$RT/venv/bin/pip" install -r "$RT/src/requirements.txt"
```

> **没有 Xcode 命令行工具（CLT）也能装**：`pydensecrf` 在 PyPI 上没有 macOS wheel，
> 默认要走源码编译（需要 CLT）。若 `engine/wheels.manifest.json` 里登记了
> **本平台 / 本 Python 版本**的预编译 wheel（通道与校验值都在那份清单里；
> 标了 `bundled: true` 的那条**直接随安装包分发**，无需另找），
> 就把它单独装上，省掉整套编译工具链：
>
> ```bash
> node engine/scripts/install-engine-deps.mjs --print-plan   # 先看它会不会走 wheel（不需要编译器、不联网）
> "$RT/venv/bin/pip" install --no-deps <清单里那条 wheel>
> ```
>
> 清单里若**没有** macOS 条目（很可能：本仓只在 Windows 上真构建过），就照上面的手动路径走，
> 不会因此装不上。清单怎么加一条见该文件的 `fillHowTo`。
>
> **想让别人也免装 Xcode CLT**（在已装 CLT 的 macOS 机器上做一次）：
>
> ```bash
> "$RT/venv/bin/pip" wheel pydensecrf --no-deps -w /tmp/whl
> node engine/scripts/install-engine-deps.mjs --wheel-entry /tmp/whl/pydensecrf-*.whl
> ```
>
> 第二条命令**只需要读文件 + 算哈希**（在 macOS 上也能跑：它是脚本里的"只读模式"之一），
> 会把 sha256 算好并打印成可粘贴的清单条目 —— 那个哈希**不允许凭记忆写**。
> 之后把 wheel 放进仓库 `engine/wheels/` 并标 `bundled: true` + `path`（**随安装包分发**，
> 这是 G3 起 macOS 该走的路线，与 win32-x64 那条一致），或传到镜像通道补 `url` ——
> 三态 `bundled` / `local` / `url` **恰取其一**，别混写。两条路选一条，别人就也不必装 CLT 了。

**然后必须补一个兼容补丁**（否则掩码细化一步会炸，见 §5.1）：

```bash
SITE="$RT/venv/lib/python3.11/site-packages/pydensecrf/__init__.py"
cat >> "$SITE" <<'PY'

# >>> miao-dock: pydensecrf 旧常量兼容补丁
from . import densecrf as _dcrf
for _n in ("CONST_KERNEL", "DIAG_KERNEL", "FULL_KERNEL"):
    if not hasattr(_dcrf, _n) and hasattr(_dcrf.KernelType, _n):
        setattr(_dcrf, _n, getattr(_dcrf.KernelType, _n))
for _n in ("NO_NORMALIZATION", "NORMALIZE_BEFORE", "NORMALIZE_AFTER", "NORMALIZE_SYMMETRIC"):
    if not hasattr(_dcrf, _n) and hasattr(_dcrf.NormalizationType, _n):
        setattr(_dcrf, _n, getattr(_dcrf.NormalizationType, _n))
# <<< miao-dock: pydensecrf 旧常量兼容补丁
PY
```

验证（这一条**同时**验 `pydensecrf` 常量、torch、以及引擎源码能 import）：

```bash
cd "$RT/src" && "$RT/venv/bin/python" -c "import pydensecrf.densecrf as d; assert hasattr(d,'DIAG_KERNEL') and hasattr(d,'NO_NORMALIZATION'); import torch; from manga_translator.mask_refinement import dispatch; print('torch', torch.__version__, 'mps', torch.backends.mps.is_available())"
```

**幂等**：四条都可以重复跑 —— 目标已存在且非空则跳过，不重复下载。中断了直接重跑。
想强制重来加 `--force`（如 `node engine/scripts/setup-engine.mjs --force`）。

每一步做完**落点里应该出现什么**（这也是 §4 自检的判据）：

| 步骤 | 产物 | 就绪项 |
| --- | --- | --- |
| ① | `python-3.11/bin/python3` · `venv/bin/python` · `src/server/main.py` · `src/` 里带 `# miao-dock 补丁 D-xxx` 标记 | `venvRoot` `python` `source` `patches` |
| ② | `venv/lib/python3.11/site-packages/` 下有 `torch/` `onnxruntime/` `transformers/` `pydensecrf/` … | `deps` |
| ③ | `models-store/`（权威副本）· `models/sakura/*.gguf` · `bin/*.tar.gz` | `weights` |
| ④ | `bin/llama/llama-b11417/llama-server` · `src/models/` 里出现硬链接（不是拷贝） | `llm` |

> ③④ 之后引擎源码树里的模型是**硬链接**（`linkTo`），权威副本在 `models-store/`。
> 换引擎版本（`src/` 被重装）后跑 `npm run task -- fetch:models --link` 可**零网络**重建链接，
> 不必重下 6.3 GiB。

**只装其中一部分**（排障/省流量）：

```bash
node engine/scripts/setup-engine.mjs --check     # 只报告现状，不下载
node engine/scripts/fetch-models.mjs --check     # 只校验已下的东西（含 HF 缓存可解析性）
node engine/scripts/fetch-models.mjs --set visual     # 只下默认流水线必需项（≈ 0.7 GB）
node engine/scripts/fetch-models.mjs --set translation # 只下英译中 nllb（≈ 2.3 GiB）
node engine/scripts/fetch-models.mjs --link           # 只重建引擎树里的链接（零网络）
```

---

## 4. 装完自检：七个就绪项，逐项点名

产品把「引擎运行时是否装配好」拆成**七项**，每项独立判定、独立报路径
（`GET /api/v1/engine/runtime`，B2）。命令行侧同一个函数：

```bash
mangasvc --check-runtime-gate real
```

输出里 `ready` 为 `true` 才算装齐；不是 `true` 时它会**逐项点名**缺哪一项、缺在哪个绝对路径、
以及怎么补（`fix`）。七项与 §3 的对应关系：

| 就绪项 | 判据 | 没就绪时补哪一步 |
| --- | --- | --- |
| `venvRoot` | 落点下的 `venv/` 是目录 | ① `setup:engine --venv` |
| `python` | `venv/bin/python` 在盘上 | ① `setup:engine --python` |
| `source` | `src/server/main.py` 在盘上 | ① `setup:engine --source` |
| `deps` | venv 的 `site-packages` 里有引擎依赖（含 torch / pydensecrf） | ② 手动 pip（见 §3） |
| `patches` | 上游源码补丁**逐条**都在（缺哪条报哪个 patch id） | ① 重跑 `setup:engine --source` |
| `llm` | `bin/llama/llama-b11417/llama-server` 在盘上 | ④ 解包 llama 归档 |
| `weights` | 清单里当前平台可见的权重条目**齐且大小一致**（缺哪条报哪个 id 与绝对路径） | ③ 拉权重 + ④ 解包 |

> 最后两项与前五项**不是同一条链**：前五项来自 `setup:engine`，后两项来自模型清单
> （拉权重 / 解包）。只跑完 ① ② 的机器，`ready` 仍然是 `false` —— 这是刻意的（D-231③）：
> 真机上曾出现"引导页显示装好了，启动却报 `os error 3`"，根因就是这里只查了前五项。

> 解释器路径的两个平台写法（`venv/bin/python` 与 Windows 的 `venv/Scripts/python.exe`）
> 在**检测侧与启动侧是同一个推导**（B3）：手拼路径会踩到分叉，用上面两条命令拿结果即可。

服务起起来之后，同一个事实也可以从 HTTP 看：

```
GET http://127.0.0.1:8000/api/v1/engine/runtime
```

> **为什么值得先跑这一步**：real 档启动时如果运行时没装齐，喵坞会在**起任何子进程之前**
> 拦下来、秒级告诉你缺什么（D6/L0）。不先自检也不会"卡住 4 分钟然后报一句服务启动失败"。

---

## 4.1 新电脑（干净机器）验收清单 —— 逐项对照，不靠"我觉得好了"

> ⚠️ **验证状态：`unverified`（macOS 侧整条都在等一台 Mac）**。本节没有在任何真机验证过。
> 能自动化的那一半（装配函数本身：两批依赖、兼容补丁、按 `dest` 解包、阶段顺序、长路径体检）
> 已经在 Windows 上对着**产品代码**真跑过（`npm run task -- check:engine-bootstrap-real`，见 D-215/D-216）；
> 但 macOS 特有的三件事 —— **Gatekeeper、`pydensecrf` 无预编译 wheel、MPS 档** ——
> 只能在 Mac 上确认 ⇒ 归 D7 真机验收。

**前置**：从 dmg 装好喵坞。**刻意不装** Node / Python / Homebrew（Xcode CLT 见下面第 0 步）。

| # | 做什么 | 期望看到什么（对不上就是缺陷，不是"环境问题"） |
| --- | --- | --- |
| 0 | 从 dmg 双击安装 | Gatekeeper 拦一次。**这是人工步骤**：到「访达 → 应用程序」**右键 → 打开**（§5.5.1）。签名/公证到位之前，这一步绕不过去 |
| 1 | 打开喵坞 | 停在一张引导页（本机没有引擎时），主按钮只有一颗「开始下载」；**整页没有命令行、没有路径、没有专业名词** |
| 2 | 点「开始下载」 | 工具条「引擎下载中」+ 细进度；下载页有百分比 / 速度 / 剩余 / 当前文件；**取不到总量时显示「准备中」而不是 0%** |
| 3 | 看第 1 段的阶段名 | Python 运行时 → 虚拟环境 → 引擎源码 → 源码补丁 → **依赖** → 视觉模型。🔴 **`pydensecrf` 这一段**：darwin 目前**没有**预编译 wheel，装配会**如实**说"将走源码编译（需要 Xcode CLT）"，不会静默、也不会假装走 wheel |
| 4 | 若第 3 步报需要编译器 | 装 `xcode-select --install`（**这是 macOS 上唯一一处仍需人工准备的**，因为 darwin wheel 还没有）。装完回喵坞点 ▶ 继续即可，不必重来 |
| 5 | 第 1 段跑完，切去「设置 → 翻译服务」 | 引擎状态从「需下载」变成**就绪**；此时在线翻译可用，本地翻译等第 2 段（翻译权重约 6 GB） |
| 6 | 等第 2 段结束，翻译一张漫画 | 出译文。盘上核对：`<落点>/venv/lib/python3.x/site-packages` 里有 `torch` 与 `pydensecrf`；`<落点>/.runtime.ready.json` 存在 |
| 7 | 可选：命令行侧核对 | `<安装目录>/mangasvc --check-runtime-gate real` 输出 `ready: true`，七项全齐 |

**三件最容易误判的事**：

1. **第 1 段跑完还不能翻译** —— 设计如此：翻译权重（Sakura / nllb）在第 2 段。
2. **"需要 Xcode CLT"不是零配置失败** —— 这是 darwin 侧**已知缺口**（没有预编译 wheel）。
   窗口里那句话就是如实报告，不是 bug；补上 darwin wheel 之后这句话会消失（清单加一条即可）。
3. **`pydensecrf` 旧常量补丁**（§5.1）是产品装配自己做的 —— 装完不需要你手动打，
   venv 里 `site-packages/pydensecrf/__init__.py` 应当含有 `miao-dock: pydensecrf 旧常量兼容补丁` 这段 marker。

---

## 5. macOS 上最容易踩的坑

### 5.1 掩码细化阶段 `AttributeError: module 'pydensecrf.densecrf' has no attribute 'DIAG_KERNEL'`

`requirements.txt` 里那行 `pydensecrf@…/master.zip` 是**移动靶**：上游把旧的模块级常量
迁进了枚举，而引擎源码仍用旧写法。症状很坏 —— **检测 / OCR / 翻译都跑完了**，到掩码细化
才炸，容易误判成"翻译坏了"。修法就是 §3 ② 那个兼容补丁。

### 5.2 该走 MPS 却走了 CPU / 首图特别慢

```bash
RT="$HOME/Library/Application Support/MiaoDock/manga/runtimes/manga-translator"
"$RT/venv/bin/python" -c "import torch; print(torch.__version__, torch.backends.mps.is_available(), torch.backends.mps.is_built())"
```

两个都该是 `True`。`is_built()=False` ⇒ 装的是 CPU 构建的 torch。
**没有独显不是故障**：档位会自动降级，界面上会说明走的是哪一档。

### 5.3 编译 `pydensecrf` 报找不到头文件

先确认 `xcode-select -p` 指向 CommandLineTools，必要时
`sudo xcode-select --reset` 后重跑 §3 ②。

### 5.4 下载被代理劫持（本机 8080 推理链路不通）

引擎与 ③（llama-server）之间走 `127.0.0.1`。若终端或系统设了 HTTP 代理，
本机流量也可能被代理劫持 ⇒ 症状是"引擎起来了但翻译请求一直等"。产品的启动配方里
已经注入 `NO_PROXY=127.0.0.1,localhost,::1`（并保留你原有的代理项），
手工起引擎时请照做：

```bash
export NO_PROXY="127.0.0.1,localhost,::1"
```

### 5.5 Gatekeeper 杀掉引擎子进程

引擎本体是**独立进程**（只经 HTTP 说话）。如果它来自"下载的"压缩包，
首次运行会被 Gatekeeper 拦住（`llama-server` 是外部二进制，最常中招）。
从"下载"来的文件带隔离属性，去掉它：

```bash
xattr -dr com.apple.quarantine "$HOME/Library/Application Support/MiaoDock/manga/runtimes/manga-translator"
```

> 正式分发走签名 + 公证（E1）；自建自用走上面这一条。

#### 5.5.1 从 dmg 装**喵坞本身**时也会被拦一次

安装包**没有代码签名**（自用档不买签名），第一次双击 dmg / 拖拽出来的 app 会被
「已阻止使用"喵坞"，因为无法验证开发者」拦住。这是 macOS 的正常行为，做法是：

**系统设置 → 隐私与安全性** → 拉到最下「仍要打开」；或在 Finder 里 **右键 → 打开** → 再确认一次。

> 🔴 **这一条是 macOS 上唯一无法用产品代码消除的人工步骤**（除非买签名 + 公证，即 E1）。
>    它只发生在**第一次启动 app**，与引擎装配无关；引擎装配本身仍是应用内一键完成。
>    本机（Windows）无法验证这一步的真实表现 ⇒ 标 `unverified`，归 D7 真机验收。

---

## 6. 重装 / 迁移 / 卸载

- **重装**：删掉 `<落点>` 后重跑 §3 四步。只坏了 venv 就
  `setup:engine --venv` + §3 ②；只换引擎源码就 `setup:engine --source`
  + `fetch:models --link`（**零网络**恢复模型链接）。
- **迁移到新机器**：`runtimes` 整目录拷过去**不能用**（venv 与 python 运行时里有绝对路径），
  正确做法是在新机器上重跑 §3。模型那份 6.3 GiB 可以从旧机器**拷 `models-store/`** 到
  同一相对位置，省一次下载 —— 拷完跑 `fetch:models --check` 验校验和。
- **卸载喵坞**：`~/Library/Application Support/MiaoDock/manga/runtimes/` 里这 13 GB **不会**被自动删除
  （卸载程序只提示位置与体积）。自己确认不再需要时手动删整个 `runtimes` 目录即可。

---

## 7. 许可（先说清楚，再决定要不要装）

- 引擎本体是 **GPL-3.0-only**；依赖里还有若干传染面更大的第三方。
- Sakura LLM 权重是 **CC BY-NC-SA 4.0：禁止任何形式的商用**。
- 英译中的 `nllb-200-distilled-600M` 是 **CC-BY-NC-4.0：同样禁止商用**
  （商用要先换成 MIT 档 `m2m100`）。

⇒ **本机自用可以；对外分发 / 商用之前必须先有法务结论**（`engine/VERSIONS.lock` §6）。

---

## 适用对象与验证状态（一句话）

本文的四条 `npm run …` 命令**来自仓库**（需要 Node ≥ 22 与仓库工作区）—— 也就是说，
本引导面向**从仓库自建自装**的用户。打包版把这些装配动作收进包内（并接到同一套落点与
同一份清单）是 C2/D8 的收尾工作；**落点、体积、七项就绪判据三件事已经同源**，
包内引导接入时不会另起一套。

> ⚠️ **验证状态**：§0 的落点、§2 的体积、§3 的步骤与 §4 的判据都已与产品**对拍成钉子**
> （`npm run task -- check:install-guide`），但**本引导的 macOS 侧尚未在真机上跑过完整一遍**
> —— 落点的 macOS 分支在本机（Windows）只能对**同源镜像表**，跑不到 macOS 的二进制。
> 真机验收归 D7，在它完成前本文标 `unverified`，不计入「已验」。
> **§4.1 是给"新电脑"准备的逐项验收清单**（含 Gatekeeper 的人工步骤、以及 darwin 暂无
> 预编译 wheel 的如实说明）—— 换机验收照它逐行对照即可，别凭印象判断"装好了"。

> 附录：命令速查（都可在落点已定后任意重跑）

```bash
mangasvc --print-paths                    # 产品实际用的全部路径（落点的权威答案）
mangasvc --check-runtime-gate real        # 七项就绪自检（缺哪项逐项点名）
npm run task -- setup:engine                    # ① Python + venv + 源码 + 补丁
# ② 手动：$RT/venv/bin/pip install -r "$RT/src/requirements.txt"（+ pydensecrf 兼容补丁）
npm run task -- fetch:models                    # ③ 模型 + llama.cpp（按清单、按平台）
npm run task -- extract:models                  # ④ 解包
npm run task -- fetch:models --check         # 只校验，不联网
npm run task -- fetch:models --link          # 只重建链接，零网络
npm run task -- check:install-guide             # 这份文档本身与产品的对拍（开发者）
```
