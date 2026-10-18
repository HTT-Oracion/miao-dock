# 展示截图（snapshots/）

这个目录放**给外面看**的截图：README 首图、Release 说明、GitHub 社交预览。

## 与 `docs/refs/` 的界

| 目录 | 是什么 | 判据 |
| --- | --- | --- |
| `snapshots/`（这里） | **展示图**：挑出来给人看产品长什么样 | 可以重截、可以裁、可以换 |
| `docs/refs/` | **取证图**：某一次验收**当时**的真实产物 | 有台账条目指向它，**只增不改**（改了就不是证据） |

🔴 **两者不互为副本**：取证图放进 `docs/refs/` 之后，展示图请**重新截**再放这里，
不要 copy 一份过来 —— 那样两份图会各自漂移，而"哪份是真的"没人说得清。

## 现有可用素材（在 `docs/refs/`，可直接挑）

挑选口径：**真实运行中的界面**（不是设计稿、不是线框），且不含用户隐私数据。

| 素材 | 内容 | 出处（验收项） |
| --- | --- | --- |
| `docs/refs/e2e/01-queue.png` | 队列屏（列表 / 状态点） | D1–D5 端到端 |
| `docs/refs/e2e/02-library.png` | 漫画库（搜索 + 分页） | D1–D5 端到端 |
| `docs/refs/e2e/03-compare.png` | 全屏看图对照（原图 / 译文） | D1–D5 端到端 |
| `docs/refs/e2e/04-settings-dark.png` | 设置页 · 深色 | D1–D5 端到端 |
| `docs/refs/e2e/05-settings-engine.png` | 设置页 · 引擎组 | D1–D5 端到端 |
| `docs/refs/e2e/06-settings-diag.png` | 引擎诊断视图 | D1–D5 端到端 |
| `docs/refs/engine/01-real-translation.png` | **真引擎**出的真译文 | E3 真引擎全链路 |
| `docs/refs/engine/02-e9-page-translated.png` | 插件联调：页面已翻译 | E9（在插件仓跑） |
| `docs/refs/design/s6-window-queue.png` | 窗口形态设计稿 | S6 前设计 |
| `docs/refs/design/s7-window-library.png` | 窗口形态设计稿 | S7 前设计 |

## 音乐屏与桌面歌词窗：通道已通，**图还没有**（2026-10-16 更新）

这两屏过去**根本没有取证路径** —— 采集通道写死了主窗，而桌面歌词是独立窗口
（label `desktop-lyrics`），在那种写法下没有表达方式。现在序列里有两步专门截它们：

| 步骤 | 内容 | 落到哪 |
| --- | --- | --- |
| `07-music.png` | 音乐应用（**未播放 / 未登录时的空态**） | `docs/refs/e2e/` |
| `08-lyrics-window.png` | 桌面歌词独立置顶窗（**未播放时的空态**，该窗口不自证主题） | `docs/refs/e2e/` |

⚠️ **但这只是在 Windows 上把代码与断言做通了**：真出图必须在那台能跑的 macOS 机器上执行
`npm run task -- capture`（通道走 `screencapture -R` + `caffeinate`，本机 Windows 没有这些）。
在那之前**本目录仍没有这两屏的图**，登记为待补。

🔴 两张图抓的都是**空态**，标签也如实这么写 —— 采集用的是 mock 引擎 + 端到端那套落盘数据，
里面没有音乐库、也没有登录态。要看满态请自己登录后手工截图，别拿空态冒充。

守卫在 `check:music` 的 `CAPTURE.*` 三条：序列里必须有这两步、歌词窗那步必须截**它自己**、
且 `capture.rs` 的 steps 与 `e2e/capture.mjs` 的 `SHOTS` **逐名对齐**。

## 还缺什么（如实登记）

- 音乐屏与歌词窗的**真图**（见上：通道已通，待 macOS 机器跑一次）。
- 展示图**不入自动门**：没有任何 check 读本目录。加图时只要不上传用户数据即可。
