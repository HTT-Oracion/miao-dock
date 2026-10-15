# 分发许可结论（E5）

> 版本 1.0 · 2026-10-14 · 对应开发计划 `docs/packaging-local-engine-dev-plan.md` 的 **E5**
>
> 🔴 **这不是法律意见。** 本文是**工程侧**从仓库里可复算的事实出发得到的结论与边界划分，
> 用途是「让分发这件事有一份可被复核、可被机器对账的书面依据」，而不是替代法务复核。
> 涉及商用/对外分发时，§4「待法务复核项」必须先有结论。

---

## 1. 结论（三档，按分发形态）

| 档 | 分发形态 | 结论 | 依据 |
| - | - | - | - |
| **A** | **自用 / 内测**（产品不离开本团队） | ✅ **可以**，无需先出法务结论 | 自用不触发分发义务；§2.2 的四条边界在技术上已经成立并有机器判据 |
| **B** | **对外分发，但不随包、不代为分发任何模型权重** | ⚠️ **待法务复核**（§4 三项） | 引擎 GPL-3.0-only 的传播边界、以及「引导用户下载 NC 权重」的定性，两者都要法务结论 |
| **C** | **对外分发且含任一 CC-BY-NC 权重**（随包 / 内置下载 / 引导下载），**或任何形式的商用** | ❌ **禁止** | Sakura 为 CC BY-NC-SA 4.0、nllb 为 CC-BY-NC-4.0，均明确禁止商用；SA 另有传染性 |

**一句话**：**B 档的法务复核未完成 ⇒ 不得对外分发** —— 这一条同时写进 §5 发布 checklist 的第 1 项。

### 1.1 A 档的「本地打包测试」通道（单独说明，因为它最常被问）

本机 `npm run app:build` 产出的安装包，若**只用于本机验证 / 本团队内排障**（装完即卸、
不转发、不挂到任何下载页、不进任何群或网盘），属 **A 档**：**不需要**先出 §4 的法务结论，
也**不必走** §5 那份发布 checklist。判据仍然只有一条 —— **包有没有离开本团队**。

⚠️ 三条常见误区（都是"以为自己还在 A 档、其实已经进了 B 档"）：

- 把安装包发给团队外的人"帮忙试试"—— 哪怕免费、哪怕只给一个人，也是 **B 档**；
- 把包传到公开 / 半公开位置（网盘、群文件、public 仓库的 Release）—— **B 档**；
- 打包时随了任一 CC-BY-NC 权重 —— 那是 **C 档**，判据更严（§1 第 C 行）。

⇒ 所以本地打包测试的正确姿势是**先做减法再报障**：装 → 复现 → 卸载；
  别把"我本机装上了"当成"可以发了"。B / C 两行的结论**不因本地测试而放宽** ——
  它们约束的是"离开团队"那一刻，与你在本机装过多少次无关。

---

## 2. 事实：仓库里到底有哪些许可（可复算）

```bash
npm run task -- gen:licenses     # 产出 src/generated/licenses.json
```

产出分三段，第三段（`engine`）是 E5 的**权威输入**：它逐条读 `engine/models.manifest.json`
的 `license` 字段，并从 `engine/VERSIONS.lock` §6 读上游 / 模型的**总**许可。
（`npm run task -- check:settings` 的 `FEATURES.licenses.engine` 与 `FEATURES.gen.script` 会验证
「这两处来源真的被读进来了」，而不是把许可表手写在脚本里。）

### 2.1 关键许可一览（2026-10-14 实测产出）

| 资产 | 许可 | 影响 |
| - | - | - |
| 引擎上游 `zyddnys/manga-image-translator`（commit 见 `engine/VERSIONS.lock` §1） | **GPL-3.0-only** | 分发引擎本体 ⇒ 触发 GPL 义务；本项目**不随包分发引擎** |
| 视觉模型 3 条（detector / inpainter / ocr，随引擎发布） | **GPL-3.0-only** | 同上（随引擎源码树） |
| inpainter `lama_large` 上游 `dreMaz/AnimeMangaInpainting` | 未标准化声明（"见上游仓库"） | **待法务复核**（§4-3） |
| Sakura LLM 权重 `SakuraLLM/Sakura-1.5B-Qwen2.5-v1.0-GGUF` | **CC BY-NC-SA 4.0** | 🔴 禁止商用 **+ SA 传染** ⇒ C 档禁止 |
| `facebook/nllb-200-distilled-600M`（8 条） | **CC-BY-NC-4.0** | 🔴 禁止商用 ⇒ C 档禁止；内含 `pytorch_model.bin`（≈2.46 GB） |
| `llama.cpp` b11417（macOS / Windows 各一条） | **MIT** | 可自由分发 |
| NVIDIA CUDA Runtime（`llama.cpp` 官方 release 提供的 `cudart` 包） | NVIDIA 自有条款 | 再分发受 NVIDIA 许可约束 ⇒ **待法务复核**（§4-2） |
| 字体 `LXGW WenKai GB` / `Zen Maru Gothic` | **OFL 1.1** | 可自由分发（含随包） |
| 本项目自身代码 | `private: true`（未开源） | 无对外开源义务 |

### 2.2 技术边界（四条，均有机器判据）

1. **权重一个字节都不随包** —— `src-tauri/tauri.conf.json` 的 `bundle.resources`
   只有 `engine/models.manifest.json` 一条。判据：`npm run task -- check:bundle` 的 **W7 / W7b**
   （权重后缀黑名单 + 与清单逐条交叉），以及 `npm run task -- gen:licenses` 的
   `engine.bundledCount` 必须为 `0`（由 `check:settings` 的 `FEATURES.licenses.engine` 钉住）。
2. **引擎本体不随包** —— 引擎由用户按 `docs/install-guide-windows.md` /
   `docs/install-guide-macos.md` 自装；包内没有引擎源码、没有 Python、没有 node。
3. **`nllb` / `sakura` 不随包、不代为分发** —— 下载发生在**用户机器上、用用户自己的网络**，
   我们只提供引导清单与校验建链（开发计划的 C 组）。
4. **许可结论本身是生成物** —— 界面上「第三方许可」直接渲染 §2 的产出
   （`src/screens/settings/LicensesBlock.tsx`），NC 类许可会单独告警。

---

## 3. 为什么「不随包」是这套设计的关键（而不是把问题藏起来）

`R13` 把这条风险标成「许可」。真正危险的做法是**看起来解决了**：把权重打进包、
本地一切正常、无人报错 —— 直到对外分发那一刻才爆。所以 §2.2 的每一条边界都配了
**会变红的判据**，而不是靠"我们记得不要打进去"。

同理，「引导用户下载 NC 权重」这件事**不能**用"我们没分发"一句带过：它是否构成
"商业使用"的一部分，取决于分发形态与是否收费 —— 这正是 §4 待复核的内容。

---

## 4. 待法务复核项（B 档放行的前置）

> 复核结论请补在本节下方（含日期与复核人），不要在别处另开一份 —— 单一事实源。

- [ ] **4-1｜GPL-3.0-only 的传播边界**：引擎以**独立进程**运行、只经 loopback HTTP 与
      本项目通信，本项目不链接、不修改、不随包分发引擎源码。请确认这足以避免本项目被
      认定为引擎的衍生作品；以及「在文档里指引用户从上游拉取引擎源码」是否被视为分发。
- [ ] **4-2｜NVIDIA CUDA Runtime 再分发条款**：该包由 `llama.cpp` 官方 release 提供，
      我们只把它列进引导清单（Windows `runtime` 档）。请确认"指引用户下载"不构成再分发，
      以及若未来改为随包需要满足哪些条件。
- [ ] **4-3｜`lama_large` 的许可**：`engine/models.manifest.json` 里该条目的 `license`
      写的是"见上游仓库 `dreMaz/AnimeMangaInpainting`"，没有一个可判定的标识。
      请确认该上游的实际条款，并把可判定的标识回写到清单（`bySpdx` 会立刻跟着变）。

---

## 5. 发布 checklist（每次对外分发前逐项过）

> 「对外分发」= 把安装包/产物交给本团队之外的人，**包括**免费内测发放。
> 纯自用（只在自己机器上跑）不必走这份清单，但 §2.2 的判据仍要在 CI 上常绿。
> ⚠️ **本机 `npm run app:build` 的本地打包测试也不必走这份清单** —— 那是 §1.1 的 A 档，
> 前提是产物不离开本团队（装完即卸、不转发）。这份清单只在"包要交出去"时才逐项过。

- [ ] 1. **§4 三项全部有复核结论** —— 未出 ⇒ **不得**对外分发（§1 的 B 档）
- [ ] 2. 分发形态已记录：自用 / 内测 / 对外 · 是否收费 · 是否随包引擎
- [ ] 3. `npm run task -- check:bundle` 绿（W7 / W7b：随包 0 个模型权重）
- [ ] 4. `npm run task -- gen:licenses` 已重跑，产出的 `engine.bundledCount === 0`
- [ ] 5. `npm run task -- check:settings` 绿（界面许可段可见，禁商用有告警）
- [ ] 6. 若为**商用**：`nllb` 与 `sakura` 已换成可商用档位，且
      `engine/models.manifest.json` 的 `license` 字段已同步（换档后 `bySpdx` 会自己变）
- [ ] 7. 包内无引擎源码 / 无 Python 运行时 / 无 node（`npm run task -- check:resources` 与
      `npm run task -- check:packaged` 覆盖）
- [ ] 8. 分发物里带上了本文件的一处引用（安装引导或关于页），
      让领取人能看到"这是自用/内测"这件事

---

## 6. 判据索引（出问题时从哪一条看起）

| 担心的事 | 看哪条判据 |
| - | - |
| 有人把权重塞进了随包清单 | `npm run task -- check:bundle`（W7 后缀 / W7b 与清单交叉） |
| 生成物谎报"没有随包权重" | `npm run task -- check:settings`（`FEATURES.licenses.engine` 的 `bundledCount`） |
| 许可清单里漏了引擎/模型那一段 | `npm run task -- check:settings`（`FEATURES.licenses.engine` / `FEATURES.gen.script`） |
| 许可清单过期（清单改了没重跑生成脚本） | `npm run task -- check:settings`（`FEATURES.licenses.fresh` 的 `engineAssets` 对账） |
| 引擎本该由用户自装，却被塞进了包 | `npm run task -- check:resources` · `npm run task -- check:packaged` |
