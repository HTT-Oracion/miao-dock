# ver2.1 开发任务清单 · 英译中支持 + OCR 文本修复

> 版本 v1.0（已定基线） · 2026-10-10 · 仓库 `miao-dock`（服务 + 引擎 + 模型）· 关联仓 `miao-trans`（插件）
> 本文是**开发任务清单**（目标 / 范围 / 优先级 / 验收标准），不是方案散文；决策与踩坑落 `docs/internal/spec-notes.md`（D-xx）。
> 上一版（v0.1「开发计划」）的模型选型已被 `test-manga/en` 实测推翻 —— 实测证据见 §1。

---

## 0. 基线（用户已拍板，不再讨论）

| 项 | 结论 | 依据 |
|---|---|---|
| 翻译模型 | **`nllb-200-distilled-600M`**（引擎**已注册**的 `nllb` 档） | 用户自用、**非商用** ⇒ 接受其 **CC-BY-NC-4.0** |
| 语言方向 | **用户显式选**，不做自动检测兜底 | nllb 自带 `langid` 自动检测在本项目英文短句上**判错**（实测） |
| 按需加载 ③ | **本版不做**，列 ver2.2 | 与「双模型互斥」叠加会让冷启动来源翻倍 |
| 不进分发物 | `nllb` 与 `sakura` **都不得进随包默认**（双 NC） | 许可硬约束 |

### 推翻 v0.1 的三条实测结论

1. **不需要新增 GGUF 权重、不需要动 ③ 的生命周期** —— 选 `nllb` 后英译中**完全不经过 llama-server**（它在 Python 引擎进程内跑）。v0.1 的 L3 里 M3/M5（档位二维表、③ 按语言重载）**整段作废**。
2. **`sakura` 不能做英译中**：prompt 硬编码「将下面的**日文**文本翻译成中文」+ `_LANGUAGE_CODE_MAP` 只有 `{CHS, JPN}` ⇒ 实测 8/8 行原文照抄，被「identical to original」滤掉。
3. **质量瓶颈在 OCR，不在翻译模型**：`UNBE-LIEVABLE` / `IN- CREDIBLE` 被检测器切成两个 region 再拼回时插了空格，译文必崩。**这是本版 OCR 任务的由来。**

---

## 1. 任务总表（目标 / 范围 / 优先级 / 验收标准）

图例：`P0` = 本版必做（不打完不算交付）· `P1` = 本版应做 · `P2` = 可延后 · 状态 `☐ 待办 / ◐ 进行中 / ☑ 完成`

### A 组 · 引擎层（P0 —— 所有下游都压在它上面）

> 交付形态：`engine/scripts/setup-engine.mjs::patchEngineSource` 的**幂等补丁**（上游源码不入库，靠锚点重放）。
> 每个补丁一个 **marker**（`# miao-dock 补丁 D-xx…`）+ 一个**唯一锚点**；锚点找不到 ⇒ **抛错**，不静默跳过（沿用 D-86 的纪律）。

| ID | 任务 | 目标 | 范围（落点） | 优先级 | 验收标准 | 状态 |
|---|---|---|---|---|---|---|
| **A1** | OCR 行尾断字符合并 | 消除 `ARE IN- CREDIBLE.` 类断词导致的整句译文崩坏 | `manga_translator/utils/textblock.py` 的 `TextBlock` 拼接点 | **P0** | ① 真实页 `#0/#3` 译文由「不可爱 / 可信」变为「令人难以置信 / 难以置信」；② 同页其余 6 行**逐字节不变**；③ 反证：注释掉补丁 → 回到旧译文 | ☑ |
| **A2** | 源语言显式透传 | 让「显式方向」能真的传到翻译器 | `config.py::TranslatorConfig` 增 `from_lang` + `translators/__init__.py::dispatch` 用配置值替代硬编码 `'auto'` | **P0** | ① 不下发 `from_lang` ⇒ 行为与上游**完全一致**（仍走 auto）；② 下发 `from_lang='ENG'` ⇒ 译文为中文；③ 反证：还原硬编码 ⇒ 源语言落 `auto` | ☑ |
| **A3** | nllb `cache_dir` 一致 | 消除「下载落 A、加载读 B」 | `nllb.py::_load` 的 `from_pretrained(..., cache_dir=…)` | **P0** | ① 默认 HF 缓存为空时仍能加载；② 反证：去掉 `cache_dir` ⇒ 报「连不上 huggingface.co」 | ☑ |
| **A4** | nllb tokenizer API 兼容 | 消除 transformers≥5 的**静默空串** | `nllb.py::_translate_batch` 的 `lang_code_to_id` | **P0** | ① 有译文输出；② 反证：还原 `lang_code_to_id` 写法 ⇒ 全行空串 | ☑ |
| **A5** | 补丁基建可验收 | 5 个补丁有 SSOT + 可反证断言 | `setup-engine.mjs` 改为**补丁表**；新增 `e2e/engine/engine-patches-check.mjs` | **P0** | ① 断言脚本全绿且条数写死；② 破坏任一 marker ⇒ 该条**变红**；③ `--check` 逐个报告补丁状态 | ☑ |

### B 组 · 模型层（P0/P1）

| ID | 任务 | 目标 | 范围 | 优先级 | 验收标准 | 状态 |
|---|---|---|---|---|---|---|
| **B1** | nllb 权重入仓 | manifest 是模型唯一清单，nllb 也要进去 | `engine/models.manifest.json` 新增条目（含 sha256/sizeBytes/许可/来源） | **P0** | `fetch:models --check` 通过；`--link` 在**零网络**下重建引擎树 | ☑ |
| **B2** | HF 缓存布局支持 | 让下载器认得 HF 的 `blobs/ + snapshots/` 结构 | `engine/model-store.mjs` | **P0** | 落位后 `huggingface_hub.try_to_load_from_cache` 对全部文件返回 OK | ☑ |
| **B3** | 引擎启动 env 兜底 | 固化「模型已预置 ⇒ 不联网」 | `service/src/engine-client.mjs::resolveEngineLaunch` | P1 | 断网（或 HF 不可达）下引擎仍能加载 nllb | ☑ |

### C 组 · 服务层（P1）

| ID | 任务 | 目标 | 范围 | 优先级 | 验收标准 | 状态 |
|---|---|---|---|---|---|---|
| **C1** | 按任务合成引擎配置 | 常量下沉为默认基线，新增纯函数 | `service/src/config.mjs` 新增 `buildEngineConfig({lang})` | **P1** | `config.engineConfig` 保持不可变；纯函数可断言 | ☑ |
| **C2** | `translateImage` 传语言 | 请求体带上 `from_lang` | `engine-client.mjs::realTranslateImage` | **P1** | 下发体含 `config.translator.from_lang` | ☑ |
| **C3** | 任务语言白名单 | 非法方向 400 | `service/src/server.mjs` + `errors.mjs` | P1 | 非法 `lang` → 400 | ☑ |
| **C4** | 重试/续做继承方向 | 对齐 D-87（复用 taskId） | `store.mjs::retryTask` | P1 | 重试后方向不变 | ☑ |
| **C5** | 设置页「翻译方向」项 | ②翻译服务 11 → 12 项 | `src/screens/settings/catalog.ts` 等 | P1 | 项数断言 + `GROUPS` 登记同步 | ☑ |
| **C6** | 计数门连锁同步 | 防「全绿但少一节」的假绿 | `AGENTS.md` / `README.md` / `check:docs` / `GROUPS` | P1 | 四处一次同步 | ☑ |
| **C7** | 诊断视图展示 `from → to` | 界面与事实对齐 | `EngineDiag.tsx` + `engine-state.ts` | P2 | 快照含 `fromLang` | ☑ |

### D 组 · 前端 / 插件（P1-P2）

| ID | 任务 | 目标 | 范围 | 优先级 | 验收标准 | 状态 |
|---|---|---|---|---|---|---|
| **D1** | 面板「翻译方向」选择 + 持久化 | 插件端可选英译中 | `miao-trans/extension/src/panel/*` | P1 | 创建任务带 `lang:{from:'en',to:'zh'}` | ☑ |
| **D2** | 契约文档 + `contract.ts` 先改 | 两端同版本（先契约后实现） | `miao-trans/docs/` + `types/contract.ts` | P1 | verify 断言通过 | ☑ |

### E 组 · OCR 专项（P0/P2）

> A1 解决的是**断词**。**识别错误**（如 `BUT YOU'RE` 被 OCR 认成 `BLIT IOURE`）是另一类，A1 无效。

| ID | 任务 | 目标 | 范围 | 优先级 | 验收标准 | 状态 |
|---|---|---|---|---|---|---|
| **E1** | （= A1）断词合并 | 见 A1 | — | **P0** | 见 A1 | ☑ |
| **E2** | 识别错误的轻量纠错 | 降低高频 OCR 错字对译文的影响 | 译前词典（`pre_dict` 正则）或拼写纠正 | **P2** | 先做**实验**判定收益，再决定是否立项 | ☑ **已实验 · 不立项**（置信度可完美检出，但自动矫正会改错；见 D-100，「低置信度提示」列 ver2.2） |

### F 组 · 文档与台账（P0）

| ID | 任务 | 范围 | 优先级 | 验收标准 | 状态 |
|---|---|---|---|---|---|
| **F1** | 决策与踩坑入台账 | `docs/internal/spec-notes.md` D-97 / D-98 / **D-99（HF 缓存布局）· D-100（E2 实验）** | **P0** | 有依据、有反证、有回写 | ☑ |
| **F2** | 本清单状态回写 | 本文档 | **P0** | 状态列与实物一致 | ☑ |

---

## 2. 本版任务拓扑（为什么先做 A 组）

```
A1 OCR 断词 ┐
A2 源语言   ├─→ 引擎能真的产出中文（唯一「技术可行性」的答案）
A3 cache_dir│
A4 tokenizer┘
   │
   └─→ A5 把上面四条固化成可重放的补丁（上游源码不入库，不固化等于没做）
        │
        ├─→ B 模型层：权重可下载 / 可校验 / 可离线重建
        │
        └─→ C 服务层 → D 前端/插件：把「能跑」变成「可配」
```

**先做 A 组的理由**：A 组做完，「技术上能不能做」就有确定答案（含 OCR 质量、模型可用性两个原未知数）；B/C/D 都是「把它变成产品」，不存在被推翻的风险。

---

## 3. 验收纪律（本版必须守的四条）

1. **自测用例只留核心**：新增断言集中在一个文件 `e2e/engine/engine-patches-check.mjs`，**条数写死并断言**；不新建冗余夹具，不加「为了完整」的重复用例。
2. **断言与反证成对**：每条补丁断言必须配一条「破坏什么 → 哪条变红」。
3. **锚点缺失必须抛错**：上游源码钉在 `ENGINE_COMMIT`，锚点找不着 = 「装出来的引擎已不是我们验过的那份」。
4. **模型 sha256 对盘上真实字节重算**，不抄上游页面；`linkTo` 用**硬链接**（Windows 符号链接不可靠）。

---

## 4. 风险登记册

| 编号 | 风险 | 类别 | 概率 | 影响 | 等级 | 应对 |
|---|---|---|---|---|---|---|
| RK-01 | `nllb`/`sakura` 均 NC ⇒ 不得进分发物 | 合规 | 3 | 5 | **15 高** | 随包默认保持 `sakura`（现状）+ 显式记录「分发前须换 MIT 档」 |
| RK-02 | 上游换 commit ⇒ 全部补丁锚点失效 | 技术 | 3 | 4 | 12 中 | 锚点缺失**抛错**（不静默）；`VERSIONS.lock` + `setup-engine.mjs` 的 commit 同步改 |
| RK-03 | transformes 大版本再移除 tokenizer API | 技术 | 3 | 3 | 9 中 | A4 写成「有旧 API 用旧、否则用新」的双通道，不写死单边 |
| RK-04 | HF 缓存布局与 `huggingface_hub` 版本耦合 | 技术 | 3 | 3 | 9 中 | 落位后**用 `try_to_load_from_cache` 复验**，不以「文件在」为准 |
| RK-05 | OCR 识别错误（E2）收益不明 | 需求 | 3 | 3 | 9 中 | 先实验、后立项，不预先承诺 |
| RK-06 | 设置项 11→12 牵动多处计数门 | 进度 | 4 | 2 | 8 中 | C6 一次性同步四处，新分组登记进 `GROUPS` |

---

## 5. 附录 · 关键锚点速查

| 用途 | 位置 |
|---|---|
| 补丁基建（唯一入口） | `engine/scripts/setup-engine.mjs::patchEngineSource` |
| 引擎源码 commit（锁定） | `engine/scripts/setup-engine.mjs::ENGINE_COMMIT` = `engine/models.manifest.json::engineCommit` |
| 拼接断词处 | `runtimes/manga-translator/src/manga_translator/utils/textblock.py`（`TextBlock.__init__`） |
| 源语言硬编码处 | `runtimes/manga-translator/src/manga_translator/translators/__init__.py::dispatch`（6 处 `'auto'`） |
| 翻译器配置模型 | `runtimes/manga-translator/src/manga_translator/config.py::TranslatorConfig` |
| nllb 插件 | `runtimes/manga-translator/src/manga_translator/translators/nllb.py` |
| 服务下发请求体 | `service/src/engine-client.mjs::realTranslateImage`（`config: config.engineConfig`） |
| 引擎配置常量 | `service/src/config.mjs::engineConfig` |

---

> 本方案为产品/技术设计参考，具体实施请结合引擎上游改动与字体/模型授权核实后确认。
