# spec-notes-3（D-412 起）

> **本文件从 2026-10-30 起是新落案的唯一去处。** `spec-notes.md`（D-01~D-136）与
> `spec-notes-1.md`（D-137~D-411）**冻结不动**。
>
> ## 落案纪律（2026-10-30 新约束）
>
> 1. **只写最关键的信息。** 一条落案回答三件事：**做了什么 / 为什么 / 怎么验证的**。
>    不写需求背景复述、不写推导过程、不贴大段代码、不写"我考虑过的几种方案"。
> 2. **必须标状态。** 每条标题后带状态标记：
>    - `✅ 已完成` —— 已实现且验证过
>    - `🚧 开发中` —— 已动手、未验证
>    - `⏸ 挂起` —— 有意暂缓，写清等什么
>    - `❌ 已废弃` —— 作废，写清被什么取代
> 3. **控制在 10 行内**（表格/清单可放宽到 20 行）。超了说明该拆条目。
>
> 历史条目（D-01~D-411）保持原样，不回头精简。

---

## D-412 · 落案与注释两条新纪律 ✅ 已完成

- **落案**：新条目一律写本文件，只留「做了什么 / 为什么 / 怎么验证」，并标状态（见文件头）。
- **注释**：此后新增/修改的注释只写核心信息（跨文件契约、易踩坑、反直觉处），不写流水账。
- 已同步 `AGENTS.md` §4 的两条纪律。
- 验证：`npm run check` 20/20。
## D-413 队列失败行带出引擎原始原因 ✅ 已完成

- `ItemBrief` / `ListView` 新增 `errorMessage` / `failedItems`：此前 `error_message` 只在内存里设，
  `#[serde(skip_serializing)]` 不落盘、view 也不投影 ⇒ 失败原因对前端是黑箱。
- 队列行 `.qt-pct` 的 `title` 现在显示「第 N 页：<引擎原话>」。
- 验证：`/tasks` 返回 `failedItems`；队列行 title 实测 `第 2 页：engine_engine_error`。

### 第 5 项：哥布林21 第 2 张失败

- 现场：第 1 张 success 84.8s，第 2 张 **470ms** 失败 `engine_engine_error`，retry=1 仍失败。
- 470ms 远小于正常推理（9–85s）⇒ 不是算不动，是引擎在两次调用之间状态变了。
- 同类任务另有 `service_restarted`（`store.rs:359`：服务重启把非终态 item 判失败），本条不同因。
- 清进程后用完整桌面端重跑同一页 **9.2s 成功**；原日志已滚动，detail 丢失。
- **2026-10-30 用户实测通过，确认已解决。**
## D-414 翻译权重换 GalTransl-7B、OCR 换 mocr ✅ 已完成

- **③ 权重**：`sakura-1.5b-qwen2.5-v1.0-fp16.gguf` → `Sakura-Galtransl-7B-v3.7-IQ4_XS.gguf`。
  上游无 Q4_K_M，只有 IQ4_XS（3.96 GB）与未量化（5.82 GB）→ 取 IQ4_XS。
- **OCR**：`48px` → `mocr`（manga-ocr-base，423 MB，落用户级 HF 缓存，两份 runtime 共用）。
- **检测器 / 修复器**：保持 `default` / `lama_large`。实测 `ctd` 反而少检（改动面积 3.23% vs 3.94%），不采纳。
- **manifest**：删 `sakura_1_5b_fp16` / `detect_ctd` / `ocr_48px_ctc` 三条，18 条资产全走 `hf-mirror.com`。
- 验证：`npm run check` 20/20 · `cargo test --lib` 318/318 · 真机 `config = {detector:default, ocr:mocr, inpainter:lama_large}`、`llm.model = Sakura-Galtransl-7B-v3.7-IQ4_XS`。

### ‼️ `use_mocr_merge` 刻意关闭（用户实测否决）

机器指标曾显示它把改动面积从 3.95% 拉到 14.27%，但**用户实测文本质量明显变差** ——
指标高只说明「改了更多像素」，不等于「改得对」：merge 会把本不该合并的相邻文本框并成一段，
译文顺序与断句随之错乱。

⇒ **不启用**。这是"机器指标好看但人眼不可接受"的典型，记在此以免后来者只看数字就打开它。

## D-415 暂时隐藏番剧入口 ✅ 已完成

- `Sidebar.tsx` 加 `SHOW_ANIME_ENTRY: boolean = false` 包住番剧入口与 popover；`Screen`/路由/设置第 6 组不动。
- 🔴 **不能用 JSX 注释**隐藏：注释后 `Clapperboard`/`Search`/`Star`/`Clock`/`Sparkles` 与 `animeView`/`onAnimeView` 变未使用，`tsc --noEmit` 报 7 个 TS6133；`npm run build` 会红，而日常 `npm run check` 抓不到（它不跑 tsc）。
- 断言同步：`spec-check.ts` C8a 与 `e2e/ia-structure-check.mjs`（`BASE.apps` + `judgeC8`）从 3 项改 **2 项**，条数仍 37。
- 验证：`tsc` 0 · `check` 20/20 · `check:ia` 37/37（含反证轮）· 真机侧栏实测 2 项 `[漫画翻译 58×52, 音乐 58×52]`、无 `nav-wrap`。

### ‼️ 同轮修掉一处假绿（`check:ia` 基线从未真正判定）

`e2e/ia-structure-check.mjs` 基线循环写的是 `ok(v === true, …)`，`v` 取自 `want`（恒真）⇒
**基线永远不会失败**，只在文案里打印"红 ← 误报"。改成实测值 `j[id]` 后立刻暴露
`TRANS` 夹具漏了第 6 组「番剧设置」（已补）。反证验证：塞回番剧入口 ⇒ 35 通过 / 2 失败、exit 1。
