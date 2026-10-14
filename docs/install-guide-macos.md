# 安装引导 · macOS（本地翻译引擎）

> 适用：macOS 13+ · **Apple Silicon**（darwin-arm64）· miao-dock ver2.2 · 更新 2026-10-14
>
> 本文只讲**装配引擎运行时**（Python / 依赖 / 模型权重 / llama.cpp）。装完它，喵坞的
> 真引擎档（默认档）才能起来；不装也能用，但只能跑 mock 替身（`MIAO_ENGINE_PROTOCOL=mock`）。
>
> 落点与体积的事实源是**产品自己**：路径来自 `boxsvc --print-paths`，体积来自
> `engine/models.manifest.json`。**本文的每个数字都可以复算**（§2 / §3 各给了命令）。

---

## 0. 第一步：先定落点，然后不要再改

引擎运行时的落点是：

```
~/Library/Application Support/runtimes/manga-translator
```

完整路径是 `/Users/<你>/Library/Application Support/runtimes/manga-translator`。
（`~/Library` 在 Finder 里默认隐藏：按住 `⌥` 点「前往」菜单即可看到「资源库」。）

**先把这件事定下来再动手** —— 因为它决定了后三步往哪儿写、产品往哪儿读。
查产品实际用的落点（**权威答案，不要靠猜**）：

```bash
boxsvc --print-paths           # 打包版在 .app 的资源目录里；从仓库自建时用 ./app/src-tauri/target/debug/boxsvc
```

输出的 `runtimeRoot` 就是落点的父目录（产品落点 = `<runtimeRoot>/manga-translator`）。
它与本文这一行**逐字节一致** —— 改这一行或者改产品，`npm run check:install-guide` 会变红。

**三条纪律（每条都对应一类真实故障）：**

1. **落点定了别挪。** 装配脚本与产品读的是同一个落点（B1 起同源），但**装配完成后**把
   `runtimes` 搬走，产品会报「运行时未装配」——因为没有任何机制会跟着搬。
   真要挪就设 `MIAO_RUNTIME_ROOT` 指向新的运行时根（产品与装配脚本都认这个变量），
   然后**重跑 §3 的四条命令**。整个 `runtimes` 目录是一个整体，不要只搬其中一半。
2. **别放同步盘 / 云备份目录。** iCloud Drive 的「优化 Mac 储存空间」会把文件换成
   占位符：路径存在、`stat` 成功、**内容为空**。引擎读到的是 0 字节权重，报错离根因极远。
   落点默认在 `~/Library/Application Support`，**不**受 iCloud 管辖 —— 别改成
   `~/Documents`、`~/Desktop` 或任何被 iCloud 桌面与文稿同步的目录。
3. **别放会被清理的临时目录。** `/tmp`、`~/Downloads`、以及任何被"清理工具"瞄上的位置
   都会在某次重启后少掉几个 GB，而症状只是"昨天还好好的"。

> 想把 6.3 GiB 放到**外置盘**（内置盘紧张）是合法的 —— 但要用①的 `MIAO_RUNTIME_ROOT`
> 一次性定好，或者把 `runtimes` 做成**符号链接**指向外置盘：
> ```bash
> ln -s /Volumes/ExtSSD/runtimes "$HOME/Library/Application Support/runtimes"
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
du -sh "$HOME/Library/Application Support/runtimes/manga-translator"
```

> 下载总量与落盘量**不是一回事**：`fetch:models` 会在 `<落点>/.download-cache/` 留下一份
> 归档，解包后可以删（`--extract` 成功即不再需要）。

---

## 3. 安装：四步，按序，幂等

```bash
npm run setup:engine     # ① Python 3.11 运行时 + venv + 引擎源码（+ 打上游源码补丁）
# ② 依赖：⚠️ 见下，macOS 这一步不能用 npm run deps:engine
npm run fetch:models     # ③ 按清单下模型权重 + llama.cpp 归档
npm run extract:models   # ④ 解包归档 → bin/llama/llama-b11417/llama-server
```

### ② 依赖：手动 pip（这一步与 Windows 不同）

`engine/scripts/install-engine-deps.mjs` 是 **Windows 专用**脚本（它要拼 MSVC/SDK 的
`INCLUDE`/`LIB`/`PATH`，还要绕开 `vcvars64.bat`）。macOS 上直接手动装：

```bash
RT="$HOME/Library/Application Support/runtimes/manga-translator"
"$RT/venv/bin/pip" install -r "$RT/src/requirements.txt"
```

> **没有 Xcode 命令行工具（CLT）也能装**：`pydensecrf` 在 PyPI 上没有 macOS wheel，
> 默认要走源码编译（需要 CLT）。若 `engine/wheels.manifest.json` 里登记了
> **本平台 / 本 Python 版本**的预编译 wheel（通道与校验值都在那份清单里），
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
> 把 wheel 传到镜像通道、补 `url` 并去掉 `local`，别人就也不必装 CLT 了。

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
| ③ | `models-store/`（权威副本）· `models/sakura/*.gguf` · `bin/*.tar.gz` | — |
| ④ | `bin/llama/llama-b11417/llama-server` · `src/models/` 里出现硬链接（不是拷贝） | — |

> ③④ 之后引擎源码树里的模型是**硬链接**（`linkTo`），权威副本在 `models-store/`。
> 换引擎版本（`src/` 被重装）后跑 `npm run fetch:models -- --link` 可**零网络**重建链接，
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

## 4. 装完自检：五个就绪项，逐项点名

产品把「引擎运行时是否装配好」拆成**五项**，每项独立判定、独立报路径
（`GET /api/v1/engine/runtime`，B2）。命令行侧同一个函数：

```bash
boxsvc --check-runtime-gate real
```

输出里 `ready` 为 `true` 才算装齐；不是 `true` 时它会**逐项点名**缺哪一项、缺在哪个绝对路径、
以及怎么补（`fix`）。五项与 §3 的对应关系：

| 就绪项 | 判据 | 没就绪时补哪一步 |
| --- | --- | --- |
| `venvRoot` | 落点下的 `venv/` 是目录 | ① `setup:engine --venv` |
| `python` | `venv/bin/python` 在盘上 | ① `setup:engine --python` |
| `source` | `src/server/main.py` 在盘上 | ① `setup:engine --source` |
| `deps` | venv 的 `site-packages` 里有引擎依赖（含 torch / pydensecrf） | ② 手动 pip（见 §3） |
| `patches` | 上游源码补丁**逐条**都在（缺哪条报哪个 patch id） | ① 重跑 `setup:engine --source` |

> 解释器路径的两个平台写法（`venv/bin/python` 与 Windows 的 `venv/Scripts/python.exe`）
> 在**检测侧与启动侧是同一个推导**（B3）：手拼路径会踩到分叉，用上面两条命令拿结果即可。

服务起起来之后，同一个事实也可以从 HTTP 看：

```
GET http://127.0.0.1:8000/api/v1/engine/runtime
```

> **为什么值得先跑这一步**：real 档启动时如果运行时没装齐，喵坞会在**起任何子进程之前**
> 拦下来、秒级告诉你缺什么（D6/L0）。不先自检也不会"卡住 4 分钟然后报一句服务启动失败"。

---

## 5. macOS 上最容易踩的坑

### 5.1 掩码细化阶段 `AttributeError: module 'pydensecrf.densecrf' has no attribute 'DIAG_KERNEL'`

`requirements.txt` 里那行 `pydensecrf@…/master.zip` 是**移动靶**：上游把旧的模块级常量
迁进了枚举，而引擎源码仍用旧写法。症状很坏 —— **检测 / OCR / 翻译都跑完了**，到掩码细化
才炸，容易误判成"翻译坏了"。修法就是 §3 ② 那个兼容补丁。

### 5.2 该走 MPS 却走了 CPU / 首图特别慢

```bash
RT="$HOME/Library/Application Support/runtimes/manga-translator"
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
xattr -dr com.apple.quarantine "$HOME/Library/Application Support/runtimes/manga-translator"
```

> 正式分发走签名 + 公证（E1）；自建自用走上面这一条。

---

## 6. 重装 / 迁移 / 卸载

- **重装**：删掉 `<落点>` 后重跑 §3 四步。只坏了 venv 就
  `setup:engine --venv` + §3 ②；只换引擎源码就 `setup:engine --source`
  + `fetch:models --link`（**零网络**恢复模型链接）。
- **迁移到新机器**：`runtimes` 整目录拷过去**不能用**（venv 与 python 运行时里有绝对路径），
  正确做法是在新机器上重跑 §3。模型那份 6.3 GiB 可以从旧机器**拷 `models-store/`** 到
  同一相对位置，省一次下载 —— 拷完跑 `fetch:models --check` 验校验和。
- **卸载喵坞**：`~/Library/Application Support/runtimes/` 里这 13 GB **不会**被自动删除
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
同一份清单）是 C2/D8 的收尾工作；**落点、体积、五项就绪判据三件事已经同源**，
包内引导接入时不会另起一套。

> ⚠️ **验证状态**：§0 的落点、§2 的体积、§3 的步骤与 §4 的判据都已与产品**对拍成钉子**
> （`npm run check:install-guide`），但**本引导的 macOS 侧尚未在真机上跑过完整一遍**
> —— 落点的 macOS 分支在本机（Windows）只能对**同源镜像表**，跑不到 macOS 的二进制。
> 真机验收归 D7，在它完成前本文标 `unverified`，不计入「已验」。

> 附录：命令速查（都可在落点已定后任意重跑）

```bash
boxsvc --print-paths                    # 产品实际用的全部路径（落点的权威答案）
boxsvc --check-runtime-gate real        # 五项就绪自检（缺哪项逐项点名）
npm run setup:engine                    # ① Python + venv + 源码 + 补丁
# ② 手动：$RT/venv/bin/pip install -r "$RT/src/requirements.txt"（+ pydensecrf 兼容补丁）
npm run fetch:models                    # ③ 模型 + llama.cpp（按清单、按平台）
npm run extract:models                  # ④ 解包
npm run fetch:models -- --check         # 只校验，不联网
npm run fetch:models -- --link          # 只重建链接，零网络
npm run check:install-guide             # 这份文档本身与产品的对拍（开发者）
```
