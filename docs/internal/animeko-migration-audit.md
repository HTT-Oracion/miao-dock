# 番剧模块 · Animeko 迁移差距审计

> 审计对象：`F:\software\projects\animeko`（open-ani/animeko，100% Kotlin/Compose Multiplatform）
> 被审对象：本项目 `src/modules/anime/` + `src/screens/anime/` + `src-tauri/src/animesvc/`
> 目标口径：**播放、设置两项功能与 Animeko 完全保持一致**；其余域按「有没有」判。
> 本文件只做差距盘点，不改代码。以下每条都标了证据出处，便于逐项复核。

---

## 0. 结论速览

| 域 | Animeko | 我们 | 结论 |
|---|---|---|---|
| 设置页签 | **16 个**（4 大类） | 8 组 34 项（单页） | 差 8 个域、约 **60+ 项** |
| 播放页行为项 | **14 项**（`VideoScaffoldConfig`，本轮抄录） | 有 2 项 | 差 **12 项** |
| 弹幕 | 完整（引擎 + 2 源 + 发送 + 过滤 + 缓存） | **0** | 整块未做 |
| 播放内核 | mpv / ExoPlayer / VLC（mediamp 抽象） | ArtPlayer + mpv + 子窗口嵌入 | 各自 1–2 条，等价性有限 |
| 数据源 | BT / ani-subs / Jellyfin / Emby / 自定义 JSON API 源 | RSS / 网页选择器 / Jellyfin / Emby / BT / Anime1 | 缺 **ani-subs 聚合源**、**JSON API 源编辑器** |
| 缓存 | 全源可缓存 + 策略 5 项 | 有缓存，策略 2 项 | 差 3 项 |
| 账号 | Bangumi 同步 + GitHub | Bangumi 同步 | 缺 GitHub 账号体系 |
| 一起看 | 有（WatchTogether） | 无 | 未做 |
| 通知 / 更新 / 日志 / 调试 | 各 1 页签 | 无 | 未做 |

**「完全一致」的诚实估价：设置 ~16 页签、播放 12 项、弹幕整块，合计约 3–4 个里程碑。**
其中**弹幕**是最大的单块（Animeko 的弹幕引擎 + 双源 + 发送链路 + 9 项弹幕设置），
不是加个开关能对齐的。

---

## 1. 基准：Animeko 到底有什么（证据）

### 1.1 设置页签（`app/shared/ui-settings/src/commonMain/kotlin/ui/settings/SettingsScreen.kt`）

四组，共 16 项：

| 分组 | 页签 |
|---|---|
| 应用与界面 | `APPEARANCE`、`THEME` |
| 数据与播放 | `PLAYER`、`MEDIA_SOURCE`、`MEDIA_SELECTOR` |
| 网络与存储 | `SERVER`（弹幕服务器）、`PROXY`、`BT`、`STORAGE` |
| 其他 | `UPDATE`、`LOG`、`ABOUT`、`DEBUG` |
| 另有入口 | `PROFILE`（账号/个人资料）、`WATCH_TOGETHER`（一起看）、`BangumiSyncTab`、`GithubAccountTab` |

### 1.2 偏好模型（21 个，`app/shared/app-data/src/commonMain/kotlin/data/models/preference/`）

```
AnalyticsSettings  AnitorrentConfig  DanmakuSettings  DebugSettings
MediaCacheSettings MediaPreference   MediaSelectionSeetings MpvOptions
NotificationSettings OneshotActionConfig PikPakConfig  PlayerKernelConfig
ProfileSettings    ProxyConfig       ThemeSettings    TorrentPeerConfig
UISettings         UpdateSettings    VideoResolverSettings
VideoScaffoldConfig WatchTogetherSettings
```

### 1.3 播放页行为（`VideoScaffoldConfig`，14 项，逐条抄录；另有 6.3 新增项未抄）

| 项 | 默认 | 含义 |
|---|---|---|
| `fullscreenSwitchMode` | 浮动按钮常显 | 全屏切换方式 |
| `enableFramePreview` | 开 | 进度条**帧预览** |
| `videoEnhancementDefaultMode` | 关 | **超分/画质增强**档位 |
| `pauseVideoOnEditDanmaku` | 开 | 编辑弹幕时暂停 |
| `autoMarkDone` | 开 | **自动标记看完** |
| `hideSelectorOnSelect` | 关 | 选集后收起面板 |
| `autoFullscreenOnLandscapeMode` | 关 | 横屏自动全屏 |
| `enableFoldableHoverMode` | 开 | 折叠屏悬停 |
| `autoPlayNext` | 开 | 自动连播 |
| `autoSkipOpEd` | 开 | **自动跳过 OP/ED** |
| `opEdSkipDuration` | 85s | 跳过时长 |
| `autoSwitchMediaOnPlayerError` | 开 | **播放出错自动换源** |
| `enableHighQualityAudioTimeStretch` | 开 | 高音质时间伸缩 |
| `enableHlsAdFiltering` | 开 | **HLS 广告过滤** |

另（`PlayerKernelConfig`）：`mpvOptions`（用户自定义 mpv 选项，多行 `mpv.conf` 语法）、
`exoPlayerInitEffectGraphInAdvance`。

### 1.4 弹幕（`danmaku/` 模块）

- 引擎：`DanmakuCollection` / `DanmakuSession` / 时间轴算法（含 23KB 的单测）
- 双源：`AniDanmakuProvider`（`https://danmaku-cn.myani.org`、`GLOBAL`）+ `DandanplayDanmakuProvider`（`api.dandanplay.net/api/v2/*`，需 `X-AppId` / `X-Timestamp` / `X-Signature` 三个头）
- 匹配：`DanmakuMatcher` / `DanmakuSplitSeasonMatcher`（跨季拆分）
- 过滤：正则过滤（`DanmakuRegexFilterGroup`）
- 设置 9 项（`EpisodeVideoSettings.kt`）：字号、不透明度、描边宽度、字重、速度、密度（疏/中/密）、显示区域（关 ~ 全屏 6 档）、正则过滤开关、调试模式
- 发送：`DanmakuEditor` + 颜色 + 位置（`DanmakuSettings.sendColor` / `sendLocation`）
- 缓存策略（`MediaCacheSettings.danmakuCacheStrategy`）：不缓存 / 看完删除 / 随媒体缓存

---

## 2. 我们的现状

### 2.1 设置：8 组 34 项（`src/modules/anime/settings-catalog.ts`）

```
库根目录 标题显示 隐藏NSFW 列表动画 记忆播放 自动连播 跳过OP/ED 默认倍速
强制硬解 元数据来源 字幕字号 字幕优先级 允许BT BT边下边播 选源策略
优先分辨率 优先字幕组 确认选源 缓存目录 缓存上限 代理模式 代理地址
BT端口 BT下行 BT上行 BT做种比 peer过滤订阅 PikPak 自动同步 冲突策略
```

### 2.2 播放：已实现 6 项

| 已有 | 落点 |
|---|---|
| 自动连播 | `PlayerScreen.tsx:770`（`prefs.autoNext`） |
| 跳过 OP/ED | `useAnimePlayback.ts:322-343`（按 `episode.op/ed` 区间 seek） |
| 倍速 / 音量 / 字幕 | `PlayerScreen.tsx` |
| 记忆播放 | `prefs.resume` + `save()` |
| 内核轨 + 子窗口嵌入 | `src-tauri/src/anime/embed.rs`（Win32 子窗口，B4 方案） |

---

## 3. 差距总表

### A. 设置域（未迁移）

| # | Animeko | 我们 | 优先级 |
|---|---|---|---|
| A1 | `PLAYER` 页签（播放器内核 + mpv 自定义选项 + 12 项播放行为开关） | 只有 4 项散在「播放」组 | **P0** |
| A2 | `PROXY`：自动 / 自定义 / 关闭 + **按源/按解析器**代理 | 有 `proxy`/`proxyUrl`，但**默认 `off`**、无 `system` 自动探测、仅全局 | **P0** |
| A3 | `MEDIA_SELECTOR`：首选字幕组**正则**、回退字幕语言**多选排序**、回退分辨率**多选排序** | 只有 `preferRes` / `preferSub` 单值 | **P1** |
| A4 | `SERVER`：弹幕服务器选择 + 连通性测试 | 无 | P1（随弹幕） |
| A5 | `STORAGE`：缓存目录 + **每番上限** + **仅最近 N 集** + 弹幕缓存策略 | 只有 `cacheDir` / `cacheLimitGb` | P1 |
| A6 | `BT`：peer 过滤（含编辑器 UI）+ 做种 + 端口 | 有 5 项，**无编辑器 UI** | P1 |
| A7 | `THEME` / `APPEARANCE`：主题、字号、语言、动效 | 无（模块内） | P2 |
| A8 | `NOTIFICATION`：新集提醒 | 无 | P2 |
| A9 | `UPDATE`：自动更新 | 无 | P2 |
| A10 | `LOG` / `DEBUG`：日志页、调试开关 | 无 | P2 |
| A11 | `PROFILE` + `GithubAccountTab` | 只有 Bangumi 登录/同步 | P2 |
| A12 | `AnalyticsSettings`（遥测开关） | 无 | P3 |
| A13 | `OneshotActionConfig`（一次性动作记忆） | 无 | P3 |
| A14 | `PikPakConfig`（含 `refreshToken`/`password` 混淆存储） | 只有 `pikpak` 开关占位 | P3（口径：只留接口） |
| A15 | `WatchTogetherSettings` | 无 | P3 |

### B. 播放域（未迁移）

| # | Animeko | 我们 | 优先级 |
|---|---|---|---|
| B1 | 弹幕渲染引擎（滚动/顶部/底部、9 项样式设置、不遮挡字形） | **无** | **P0** |
| B2 | `autoSwitchMediaOnPlayerError` 播放出错自动换源 | 无（出错只提示） | **P0** |
| B3 | `autoMarkDone` 自动标记看完 | 手动 | **P0** |
| B4 | `mpvOptions` 自定义内核参数（多行 `mpv.conf` 语法 + 解析规则） | 无（只有硬解开关） | **P0** |
| B5 | `enableHlsAdFiltering` HLS 广告过滤 | 无 | P1 |
| B6 | `enableFramePreview` 进度条帧预览 | 无 | P1 |
| B7 | `videoEnhancementDefaultMode` 超分/画质增强 | 无 | P2（Windows 端需 shader 链） |
| B8 | `enableHighQualityAudioTimeStretch` | 无 | P2 |
| B9 | `pauseVideoOnEditDanmaku` / `hideSelectorOnSelect` / `autoFullscreenOnLandscapeMode` / `enableFoldableHoverMode` / 全屏切换方式 | 无 | P2 |
| B10 | 弹幕发送（颜色 + 位置 + 与 Bangumi 账号绑定） | 无 | P1 |
| B11 | 弹幕正则过滤 + 跨季拆分匹配 | 无 | P1 |
| B12 | 一起看（WatchTogether，多人同步播放） | 无 | P3 |
| B13 | mediamp 双内核（ExoPlayer/VLC）+ 画中画 | 无（Windows 只需 mpv，PiP 可评估） | P3 |

### C. 数据源域

| # | Animeko | 我们 | 优先级 |
|---|---|---|---|
| C1 | **ani-subs 聚合源**（`creamycake-anime/ani-subs`，全自动选源） | 无 | **P0**（"有真实片源"的关键） |
| C2 | **自定义 JSON API 源编辑器**（`JsonApiConfigPane` / `JsonApiPlayPane` / `JsonApiTestPane`） | 无（只有选择器源） | P1 |
| C3 | RSS 源编辑器 / 测试面板 | 有 test 端点，**无编辑 UI 的完整流程** | P1 |
| C4 | 数据源订阅（`MediaSourceSubscriptionGroup`） | 无 | P2 |
| C5 | 自动选源器（按偏好自动挑 + 记住选择） | 有 `selectStrategy` 字符串，**无完整评分器** | P1 |

### D. 账号 / 同步

| # | Animeko | 我们 | 优先级 |
|---|---|---|---|
| D1 | Bangumi 云同步（进度 / 收藏 / 冲突合并 UI） | 有同步 + `resolveConflict`，**无合并 UI** | P1 |
| D2 | GitHub 账号 | 无 | P3 |

---

## 4. 顺带查出的两个真问题（比迁移更急）

### 4.1 代理默认 `off` ⇒ Bangumi 全程不可达 ⇒「没真实数据」的根因

- 证据：`src/modules/anime/prefs.ts:103` `proxy: 'off'`；`AnimeSettingsSection.tsx:45` 挂载即 `applyProxy(prefs.proxy, …)`
- `src-tauri/src/anime/mod.rs:255` `ProxyChoice::Off` ⇒ 给子进程 `env_remove("HTTP_PROXY")`
- 结果：`animesvc` 里的 reqwest **完全不走代理**，而本机 `api.bgm.tv` 必须过代理
- **实测（本轮）**：经 `http://127.0.0.1:7897` 请求 `POST https://api.bgm.tv/v0/search/subjects` ⇒
  **200，17,836 字节**，返回 `400602 葬送のフリーレン / 28 话`、`515759 第2期`
- 修法：①`proxy` 默认改 `'system'`；②`system` 模式读注册表 WinINET 代理注入子进程；
  ③`proxy` 改动后**重启 animesvc**（env 只在 spawn 时生效，现在改了不重启不生效）
- 附带结论：`api.dandanplay.net` 经代理返回 **403**（缺 `X-AppId/X-Timestamp/X-Signature`），
  说明弹幕源要按 Animeko 那套签名协议实现，不能裸调

### 4.1b 已采纳的替代方案：不修代理，改换数据源（2026-10-21）

用户明确**不接受**引入代理。改用 Animeko 自己的聚合服务端，实测全部 200（本机直连、无代理、无鉴权）：

```
GET https://api.animeko.org/v1/trends                      200 /   3,308 B
GET https://api.animeko.org/v1/schedule/seasons/latest     200 /  54,529 B
GET https://api.animeko.org/v2/subjects/search?q=Frieren   200 /   3,949 B
GET https://api.animeko.org/v2/subjects/400602             200 /  20,798 B
GET https://api.animeko.org/v2/subjects/400602/characters  200 /  68,793 B
GET https://api.animeko.org/v2/subjects/400602/staff       200 / 227,364 B
```

🔴 **硬约束**：该服务**拒绝带 `Origin` 的请求**（裸 GET / 带 UA / 带 Referer 都是 200，带 Origin 即 403 空体）。
浏览器 `fetch` 强制带 Origin ⇒ **前端永远调不通**；本项目前端本就经 `invoke()` 走 Rust reqwest（不发 Origin），
**零架构改动**。四组对照实验见 `plan-anime-remaining.md` §8.3。

**额外收益**：详情接口的 `infobox` 带「放送星期」，补上了本审计里「AniList 无此字段 ⇒ 周历做不了」的缺口。

### 4.2 设置项存在 ≠ 生效

- `forceHwDecode` / `btStream` / `selectStrategy` / `pikpak` 这 4 项目前只是存了值，
  没有逐项核对到消费端；对齐 Animeko 前应先做一遍「设置项 → 消费端」的接线审计
- 已有先例：`metaProvider` 上一轮就出现过「存了但没接线」的 bug

---

## 5. 建议里程碑

| 里程碑 | 内容 | 判据 |
|---|---|---|
| **M1 换数据通路（已采纳 2026-10-21，未开工）** | 番剧数据整体改走 Animeko 自有聚合服务端 `https://api.animeko.org`（**不引入代理**）：`/v1/trends` 热度、`/v1/schedule/seasons/latest` 时间表、`/v2/subjects/search` 检索、`/v2/subjects/{id}` 详情（含**放送星期**）、`/v2/subjects/{id}/{characters,staff,related-subjects}` 详情补充；AniList 降为兜底 | 关代理、不登录也能出真实数据；`fallbackFrom` 如实回传。详见 `plan-anime-remaining.md` §八 |
| **M2 播放对齐（P0）** | 出错自动换源、自动标记看完、mpv 自定义选项、播放设置独立成页 | 与 `VideoScaffoldConfig` P0 项逐条对表 |
| **M3 弹幕整块** | 引擎 + Ani 源 + dandanplay 源（含签名）+ 9 项样式设置 + 发送 + 缓存策略 | 能显示、能发、过滤生效 |
| **M4 设置对齐** | `MEDIA_SELECTOR` 多选排序、`STORAGE` 策略 3 项、`BT` 编辑器、`SERVER` 测试 | 16 页签逐条对表 |
| **M5 源与账号** | ani-subs 聚合源、JSON API 源、Bangumi 冲突合并 UI | 真实片源可播 + 冲突可可视化解决 |

---

## 6. 口径提醒

- 「完全一致」若指**行为一致**（同样的开关、同样的默认值、同样的语义）→ 按 §5 走即可。
- 若指**逐像素 UI 一致**→ 不可达：Animeko 是 Compose Multiplatform，
  我们是 React + Tauri，控件体系不同，只能做到「同名、同默认值、同语义」。
- 弹幕与 ani-subs 都依赖第三方服务，**必须本机实测可达**才算迁移完成（本机 `api.bgm.tv` 就是反例）。
