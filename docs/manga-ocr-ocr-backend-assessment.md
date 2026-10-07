# manga-ocr（kha-white/manga-ocr）作为 OCR 后端的评估

> **状态：调研完成，未拍板。** 现状默认值不动，`engine/VERSIONS.lock` 不加条目。
>
> **一句话结论**：**不需要"换引擎"——引擎本来就内置了这个后端**（`Ocr.mocr`，而且已经写在我们导出的
> `openapi.engine.json` 里，属公开契约）。真正的改动量 = **一个配置字段 + 一个环境变量**。
> **但"要不要开 `use_mocr_merge`"是另一件事**：开了译文明显更完整（已量化），
> **但当前渲染会把整句排成巨型字并截断**（已实测；`render.direction` 与 `render.font_size`
> 两个候选杠杆**都已反证无效**，成因未定位）。

调研日期：2026-10-05 · 环境：macOS arm64 / Python 3.11.17 / torch 2.14.1 / MPS 可用
素材：`test-manga/test_0.webp`（1125×1600）· 上游引擎 commit `441d07c5…`（见 `engine/VERSIONS.lock`）

---

## 0. 先厘清范围：manga-ocr 只做 OCR 一步

`kha-white/manga-ocr` 是一个**日文文字识别模型**（VisionEncoderDecoder：ViT 编码器 + BERT 解码器）。
输入是**一块已经切好的文字图**（PIL Image 或路径），输出是**纯字符串**。

它**没有**：文本框检测、坐标、置信度、字体颜色、擦除、翻译、上字。
它的卖点是：竖排/横排都行、带假名注音也行、叠字/多字体/低质图都行，**一个气泡的多行文字可以一次读出来**
（官方自述）；同类的整链路参考是 `mokuro` = manga-ocr + 面板/人脸检测 → 输出 HTML 覆盖层，**不含翻译**。

所以"改用 manga-ocr"只有两种解读：

| 解读 | 含义 | 本报告 |
|---|---|---|
| **(a) 只换 OCR 这一步** | 检测/翻译/擦除/上字全部沿用现有引擎 | **主线**（下面全部内容） |
| (b) 整条链路改为 manga-ocr 主导 | 等于把检测、擦除、上字、翻译全部重写，而 manga-ocr 不提供这些能力 | **不建议**，也不在本报告讨论范围内 |

> 换句话说：**（a）是"换一个可选项"，(b) 是"重做一个引擎"**。下面的成本估算都按 (a) 算。

---

## 1. 证据：引擎已经内置它，而且是公开契约

| 位置 | 内容 |
|---|---|
| `src/manga_translator/ocr/__init__.py:15` | `Ocr.mocr: ModelMangaOCR` —— 已注册为 OCR 后端之一 |
| `src/manga_translator/config.py:108` | 枚举成员 `mocr = "mocr"`；`:312` 默认值是 `48px`（所以现状不走它） |
| `src/manga_translator/ocr/model_manga_ocr.py:16` | `from manga_ocr import MangaOcr` |
| `src/requirements.txt:49` | `manga-ocr` **本来就在上游依赖清单里** |
| `runtimes/manga-translator/openapi.engine.json` | 我们导出的 API 快照里，`Ocr` 枚举 = `["32px","48px","48px_ctc","mocr"]`，`OcrConfig` 含 `use_mocr_merge` |

⇒ 它是**接口契约的一部分**，不是隐藏后门。而且我们那个 venv 里**早就装好了**：
`manga_ocr 0.1.16` · `fugashi 1.5.2` · `unidic_lite 1.0.8` · `jaconv 0.5.0`（随 `requirements.txt` 一起装的）。

### 1.1 关键机制：换 mocr ≠ 用 manga-ocr 替掉 48px

读 `model_manga_ocr.py:132-295`（`_infer`）的实际数据流，mocr 档是**两个模型并联**：

1. **48px AR 模型照跑**（batched），产出每个框的 **prob** 与 **前景/背景颜色**；
2. **文本**才由 `self.mocr(...)`（`:162`）逐块产出；
3. `if prob < 0.2: continue`（`:191`）—— **闸门用的是 48px 的置信度，不是 manga-ocr 的**。

⇒ 换掉的只是"读字"这一格；保留下来的是**取色与置信度**。所以我们已预置的
`src/models/ocr/ocr_ar_48px.ckpt`（`ModelMangaOCR._MODEL_MAPPING` 要的正是同一份，`:91-100`）
**仍然必需**，不会因为换 mocr 而省掉。

### 1.2 `use_mocr_merge`（默认 `false`）才是真正的开关

`:146` —— 为 `true` 时先用 `merge_bboxes` 把相邻文本行**并成一个气泡块**再喂 MangaOcr；
为 `false` 时**逐行**调用 MangaOcr。也就是说：

> **默认值下，manga-ocr"整气泡一次读"的卖点根本用不上。**
> 而且 `use_mocr_merge` **没有 CLI 参数**，只能经 config JSON 传。

---

## 2. 实测对照

**设计**：同一张图、同一个检测器/擦除器，**唯一变量 = `ocr` 段**。
`translator` 分两组跑：`none`（隔离出 OCR 阶段）与 `sakura`+`CHS`（看端到端译文）。

### 2.1 耗时与分块数

| 臂 | `translator=none` | `translator=sakura` | 识别块数 |
|---|---|---|---|
| `48px`（现状） | 58.4 s | 1.8 min | **21** |
| `mocr`，不合并 | 1.2 min | 1.7 min | **21** |
| `mocr`，`use_mocr_merge=true` | 1.1 min | **1.6 min** | **11** |

两点值得注意：

- 端到端下 **mocr+合并反而更快**（1.6 < 1.8 min）：识别块从 21 降到 11，**翻译调用少了一半**，
  省下的比 MangaOcr 多花的还多。档位越大的 LLM，这个方向越有利。
- `MangaOcr` 初始化 ≈ **2–3 s**（含一次预热推理，`__init__` 会跑包内置示例图并打印 `OCR ready`）。

### 2.2 OCR 文本：逐行碎片 vs 整句（本页实抄）

| 现状 `48px`（21 块） | `mocr` + 合并（11 块） |
|---|---|
| 毎日 / 新鮮な野ウサギを / ありがとうな | 毎日新鮮な野ウサギをありがとうな |
| これ全部を / きみ / ひとりが…？ | これ全部をきみひとりが．．．？ |
| 待ってたよ！ / 昨日のぶんは / すぐに売り切れてな | 待ってたよ！昨日のぶんはすぐに売り切れてな |
| すごいじゃ / ないか！ | すごいじゃないか！ |
| こっちは / 野ネズミに / なります | こっちは野ネズミになります |

⇒ 现状把**一句话切成 3 段分别送去翻译**（"每天" / "新鲜的野兔" / "谢谢"），
合并后是**完整句**。这是译文质量差异的直接原因。

### 2.3 但排版会坏（🔴 阻塞项）

证据图：`docs/refs/manga-ocr/02-typeset-regression.png`

`use_mocr_merge=true` 时，"毎日新鮮な野ウサギをありがとうな" 那个气泡被渲染成**巨型字号并截断**
（只剩"每天"两个大字冲出版面）。整页对照见 `docs/refs/manga-ocr/01-full-page-ab.png`
（48px 相对原图改动 4.93%，与 G1 记录的 4.94% 一致；mocr+合并 12.31%）。

**已做的两个反证（都被推翻）：**

| 假设 | 反证做法 | 结果 |
|---|---|---|
| 合并框被判成横排 ⇒ 字号按框高算爆 | `render.direction = "vertical"` | ❌ 无效，仍是巨型字 |
| 自动字号算错 | `render.font_size = 22`（固定） | ❌ 无效，仍是巨型字 |

⇒ 杠杆不在渲染参数里，而在**合并框的几何**（`merge_bboxes` 用
`minimum_rotated_rectangle` 把多个 pts 并成一个框，`:85`）。
**修它要改上游 vendored 源码**，超出"改配置"的范围，应作为独立项立项。

---

## 3. 「若改用 manga-ocr」要动什么

| # | 项目 | 要不要改 | 具体 |
|---|---|---|---|
| 1 | **引擎源码** | **不用改** | `mocr` 已是内置后端 |
| 2 | **发给引擎的 Config** | **改** | `{"ocr": {"ocr": "mocr", "use_mocr_merge": true}}`，加在 S1 的 `service/src/engine-client.mjs` 里 |
| 3 | **引擎进程环境变量** | 🔴 **必须加** | `HF_HOME=<预置缓存目录>`；`MangaOcr()` 把 repo id 硬编码为 `kha-white/manga-ocr-base`，不设就只认 HF 官方站（本机不通）⇒ 会失败或长时间挂起。可再加 `HF_HUB_OFFLINE=1` 让它快速失败 |
| 4 | **模型预置** | **新增一份下载** | `kha-white/manga-ocr-base`，revision `aa6573bd10b0d446cbf622e29c3e084914df9741`，单文件 `pytorch_model.bin` = **444,135,475 B（424 MiB）**，sha256 `c63e0bb5b3ff798c5991de18a8e0956c7ee6d1563aca6729029815eda6f5c2eb`。经 `hf-mirror.com` 下载耗时 **16 s**。落盘 `runtimes/manga-translator/hf-cache/`（仓库外，已被 `runtimes/` 忽略）。**仓库只有 `pytorch_model.bin`，没有 safetensors** |
| 5 | **Python 依赖** | 不用装 | 已经在 venv 里（`requirements.txt` 本来就有）。只是要在 `requirements.engine.txt` 与版本锁里**点名** |
| 6 | **版本锁** | 拍板后加 | `engine/VERSIONS.lock` 新增一节：repo / revision / sha256 / 落盘路径 / `HF_HOME` 约定，并记 `manga-ocr 0.1.16 · fugashi 1.5.2 · unidic_lite 1.0.8 · jaconv 0.5.0` |
| 7 | **磁盘预算** | +424 MiB | `unidic_lite` 的 248 MB 已含在现有依赖里，不算新增。"首次安装 5–8 GB"结论不变 |
| 8 | **启动耗时** | +2–3 s | MangaOcr 加载 + 预热推理 |
| 9 | **配置注入位置** | ⚠️ 认知纠正 | `shared`（web/生产）模式**没有 `--config-file`**。config 是**按请求**传的（`server/request_extraction.py:18-23` 的 `TranslateRequest.config`，或 form 端点的 `config` 字段）。⇒ 生产路径下 OCR 档位由**我们每次请求**给出，不是启动参数 |
| 10 | **跨端（Windows/Linux）** | 无障碍 | `manga-ocr` 与 `unidic-lite` 都是 `py3-none-any` 通用 wheel；`fugashi` 有 cp39–cp314 全平台 wheel。⚠️ 唯一注意：Windows 上 fugashi 需 python.org 版 Python（Microsoft Store 版会 DLL 加载失败，官方 README 已写） |

**离线可用性已实测**：`HF_HOME` 指向预置缓存 + `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1` 下，
`MangaOcr` 加载成功（2.9 s，`Using MPS`），4 张官方 README 示例图**逐字全中（4/4）**。

---

## 4. 风险与未决

| 级别 | 项 | 说明 |
|---|---|---|
| 🔴 | **排版回归（未解决）** | 见 §2.3。`direction` / `font_size` 两个杠杆已反证无效 ⇒ 需改上游源码，独立立项 |
| ⚠️ | **过度合并** | 合并按几何邻近判定，可能把相邻气泡/两个说话人的台词并成一句。本页 21→11 看着正常，但**需要在更多页上验证**，这是 `use_mocr_merge` 的主要功能风险 |
| ⚠️ | **幻觉** | 官方自述"总会识别出内容，即使没有文字"，且闸门 prob 来自 48px 而非 manga-ocr ⇒ 网点/噪声框上可能注入一段**通顺但不存在**的中文 |
| ⚠️ | **纯日文** | 模型卡 `language: ja`。将来要支持其它源语言时 `mocr` 不可用 |
| ⚠️ | **长文本会崩** | 官方自述"文本越长越容易出错"。实测：包内置那张长文本预热图输出的是汉字拼盘（4 张示例图则全中） |
| ⚠️ | **后处理改字形** | `post_process` 会 `jaconv.h2z`（半角→全角），`…` 先变 `...` 再变全角点。本页可见 `…あ` → `．．．あ`。对 LLM 影响很小，但"原文回显"类功能会显得不忠实 |
| ⚠️ | **设备不可控** | `MangaOcr()` 自行选 CUDA>MPS>CPU，**不看引擎的 `--use-gpu`**。macOS 上会永远走 MPS，可能与 llama-server 争 Metal 显存；`force_cpu` 未暴露 |
| ⚠️ | **许可** | 代码与权重均为 **Apache-2.0**（比 Sakura 权重的 CC BY-NC-SA 宽松）。但模型卡标 `datasets: manga109s` —— 训练数据来自 Manga109-s，数据集自身有使用限制。⇒ 换 OCR **不会让整体许可变差**（NC 那条来自 Sakura），但 OCR 这层的**数据来源**要一并进法务结论 |
| ℹ️ | 与本次无关 | G1 记录的 **404 重试路径**是翻译器侧的；本轮 `none` 与 `sakura` 各 3 臂**都没有复现** |

---

## 5. 建议

**推荐路线：`mocr` + `use_mocr_merge=true`，但先解决排版回归。**

理由：它带来的是**质的变化** —— 把"逐行碎片"变成"整句"。G1 里
`いらっしゃい → 真让人不爽` 确实是 Sakura 1.5B 的档位问题（**换 OCR 不会改善**），
但 `每天都要感 / 供新鲜的野兔` 这种**读不懂的碎片是 OCR 分块造成的**，正是 mocr+合并能修的那一类。

| 路线 | 译文完整度 | 排版 | 端到端耗时 | 判断 |
|---|---|---|---|---|
| A. `mocr` + 合并 | ✅ 整句 | ❌ 回归（待修） | 1.6 min（**更快**） | **推荐，但排版是前置阻塞项** |
| B. `mocr` 不合并 | ＝ 现状（仍逐行） | ✅ 与现状一致 | 1.7 min | **收益接近零，不建议** |
| C. 不动 | 现状 | 现状 | 1.8 min | 兜底 |

后续事项（按优先级）：

1. **排版回归定位**（阻塞项）：查 `merge_bboxes` 造出的框与渲染器对框方向的判定；
   若确认要改上游源码，按"vendored 补丁 + 记入 `VERSIONS.lock`"的方式做。
2. **过度合并抽检**：在 `test-manga/` 与后续真实素材上统计合并是否正确（建议抽样 ≥20 页）。
3. **翻译模型档位**：这是**独立于 OCR 的另一条线**——1.5B 只能验"通"，要"可用"得上 8B/14B。
4. 拍板后补 `docs/spec-notes.md` 的一条 D-xx，并把 §3 的第 4/6 项写进 `engine/VERSIONS.lock`。

---

## 附：复现方式

脚本在 `.tmp/engine-test/ab-ocr/`（被 `.gitignore` 的 `.tmp/` 忽略），均已跑通：

```bash
RT=runtimes/manga-translator

# 0. 一次性：经镜像预置模型到项目内 HF 缓存（16 s / 424 MiB）
HF_HOME=$PWD/$RT/hf-cache HF_ENDPOINT=https://hf-mirror.com \
  $RT/venv/bin/python -c "from huggingface_hub import snapshot_download as s; print(s('kha-white/manga-ocr-base'))"

# 1. 离线加载 + 官方示例图正确性核对（4/4）
cd $RT && HF_HOME=$PWD/hf-cache HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 venv/bin/python \
  ../../.tmp/engine-test/ab-ocr/mocr-smoke.py

# 2. 三臂对照（translator=none，隔离 OCR 阶段）
.tmp/engine-test/ab-ocr/run-ab.sh

# 3. 三臂对照（Sakura / CHS，端到端；脚本内部自己拉 llama-server）
.tmp/engine-test/ab-ocr/run-ab-sakura.sh
.tmp/engine-test/ab-ocr/run-sakura-nomerge.sh     # mocr 不合并
.tmp/engine-test/ab-ocr/run-sakura-merge-v.sh     # 反证1：render.direction=vertical
.tmp/engine-test/ab-ocr/run-sakura-merge-fs.sh    # 反证2：render.font_size=22
```

> ⚠️ 两个脚本陷阱（本轮踩过）：
> ① 必须 `cd src/` 再跑 `-m manga_translator`（包在 `src/`，且模型目录 `BASE_PATH = src/`），
> 否则报 `No module named manga_translator`；
> ② 输入图要**拷进实验目录**再跑 —— `--save-text` 会把 `_translations.txt` 写**在输入图旁边**，
> 直接指 `test-manga/` 会污染仓库。
