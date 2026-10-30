# 展示截图（snapshots/）

这个目录放**给外面看**的截图：README 首图、Release 说明、GitHub 社交预览。

## 与 `docs/refs/` 的界

| 目录 | 是什么 | 判据 |
| --- | --- | --- |
| `snapshots/`（这里） | **展示图**：挑出来给人看产品长什么样 | 可以重截、可以裁、可以换 |
| `docs/refs/` | **取证证据**：某一次验收**当时**才产出的真实产物（真引擎译文、OCR 对比） | 有台账条目指向它，**只增不改**（改了就不是证据） |

🔴 **两者不互为副本**：展示图请**自己截**再放这里，不要从 `docs/refs/` copy 一份 ——
那样两份图会各自漂移，而"哪份是真的"没人说得清。

## 界面截图：跑 `npm run task -- capture` 生成，**不入库**

界面类截图（队列 / 漫画库 / 对照 / 设置 / 音乐 / 桌面歌词）是 `capture` 通道的**产物**，
落在 **`.tmp/capture/`**（仓库外，已 gitignore），不再提交进版本库：

| 素材 | 内容 |
| --- | --- |
| `01-queue.png` | 队列屏（列表 / 状态点） |
| `02-library.png` | 漫画库（搜索 + 分页） |
| `03-compare.png` | 全屏看图对照（原图 / 译文） |
| `04-settings-dark.png` | 设置页 · 深色 |
| `05-settings-engine.png` | 设置页 · 引擎组 |
| `06-settings-diag.png` | 引擎诊断视图 |
| `07-music.png` | 音乐应用（未播放 / 未登录时的空态） |
| `08-lyrics-window.png` | 桌面歌词独立置顶窗（未播放时的空态，该窗口不自证主题） |

为什么不入库：它们跑一次就重新生成，提交进去等于把构建产物塞进版本库
（每轮 diff 都是几 MB 二进制）。**取证记录**以文字与判据形式留在
`docs/internal/engine-e2e-acceptance-report.md`，需要看图时跑一次就有。

## 仍在库里的证据图

| 素材 | 内容 | 出处 |
| --- | --- | --- |
| `docs/refs/engine/01-real-translation.png` | **真引擎**出的真译文 | E3 真引擎全链路 |
| `docs/refs/engine/02-e9-page-translated.png` | 插件联调：页面已翻译 | E9（在插件仓跑） |
| `docs/refs/engine/02-e9-panel-18.png` | 插件联调：面板第 18 页 | E9 |
| `docs/refs/manga-ocr/01-full-page-ab.png` | OCR 全页 A/B 对比 | `docs/internal/manga-ocr-ocr-backend-assessment.md` |
| `docs/refs/manga-ocr/02-typeset-regression.png` | 排版回归 | 同上 |

这些是**真机一次性跑出来的结果**（要真权重 / 真模型），删了无法复现 ⇒ 留在库里。

## 采集通道的两个前提（`04/05/06` 与 `07/08`）

- **真出图必须在那台能跑的 macOS 机器上执行** `npm run task -- capture`
  （通道走 `screencapture -R` + `caffeinate`，Windows 上没有这些）。
- 守卫在 `check:music` 的 `CAPTURE.*` 三条：序列里必须有音乐与歌词窗两步、
  歌词窗那步必须截**它自己**、且 `capture.rs` 的 steps 与 `e2e/capture.mjs` 的 `SHOTS` **逐名对齐**。

🔴 `07` / `08` 抓的都是**空态**（mock 引擎 + 端到端落盘数据里没有音乐库与登录态），
标签也如实这么写 —— 要看满态请自己登录后手工截图，别拿空态冒充。

## 还缺什么（如实登记）

- 展示图**不入自动门**：没有任何 check 读本目录。加图时只要不上传用户数据即可。
- 本目录目前**没有实际图片**：界面图改由 `.tmp/capture/` 生成后手工挑。
