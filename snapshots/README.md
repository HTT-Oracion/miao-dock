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

## 还缺什么（如实登记）

- **音乐应用**（播放器 / 歌词卡 / 六皮肤）与**桌面歌词置顶窗**：目前**没有**展示图 ——
  它们只在 `check:music`（结构断言）里被覆盖，真机观感属 `unverified`，
  没有可入库的真机截屏。要补图请先跑一次 `npm run task -- capture`（需屏幕解锁）。
- 展示图**不入自动门**：没有任何 check 读本目录。加图时只要不上传用户数据即可。
