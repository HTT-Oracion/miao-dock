# 喵坞 MiaoDock · 偏离与裁定留痕（续篇）

> 本文件是 `docs/spec-notes.md` 的**续篇**，承接其编号（D-137 起）。
> 原文件已 5700+ 行，单文件过大会让"新增一条要翻半天的历史"变成日常成本，故自 D-137 起分流。

## 规则（编号与归属）

- **编号接续**：新条目从 `D-137` 起顺延，**不重复占用** `spec-notes.md` 已用过的编号。
  查旧编号 `grep -n "^## D-" docs/spec-notes.md`。
- **两个文件同等有效**：`docs/spec-notes.md`（D-01~D-136）与本文件（D-137~）都是**裁定与偏离的事实源**。
  与 `AGENTS.md` / `README.md` / `docs/dev-plan.md` 冲突时，**以台账为准**（两份台账同权）。
- **不得整体搬移**：既有条目留在原文件不动（历史痕迹本身有价值，见 `e2e/docs-consistency-check.mjs`
  关于"台账记录历史、不参与条数比对"的裁定）。本文件只承接**新增**内容。
- **新增前的必查**：① `grep "^## D-" docs/spec-notes*.md | tail -3` 确认最新编号；
  ② 确认该决策**没有**已存在的条目（同一问题换个措辞再记一条是最常见的台账污染）。

## 索引

| 编号 | 主题 | 涉及层 |
|------|------|--------|
| D-137 | 歌词整行高亮去掉推进动画（单层渲染 + 默认改整行） | app 前端 |
| D-138 | box-service 顶层未捕获异常兜底（统一 shutdown + 非零退出） | service |
| D-139 | 抽 `atomic-file.mjs` 底座 + store 任务状态改原子写 | service |
| D-140 | 接入 CI（双平台）+ 跨平台写死断言改平台忠实 | e2e / 基建 |
| D-141 | `image.mjs` 上移底座 + 新增 `check:layering` 依赖方向钉子 | service |
| D-142 | 删 `SongMenu` 并入 `units/ContextMenu`（+ 连带重写 MENU 判据组） | app 前端 |
| D-143 | 新增 `units/Modal` 收敛 5 处手写模态壳（+ 修 4 条失效反证锚） | app 前端 |
| D-144 | `server.mjs` 去重：任务创建工厂 + 兜底收敛 + multipart 四闸 | service |
| D-145 | 库扫描/视图下沉数据层（`server.mjs` → `manga/library.mjs`） | service |
| D-146 | 去掉 `onToast` 属性穿透，改用 `useToasts()` 单例总线 | app 前端 |
| D-147 | 路径寻址下沉数据层（`resolveComicDir` 等 4 个）+ `securityLog` 归位底座 | service |

---

## D-137 · 歌词「整行高亮」仍有逐渐移动的动画 —— 改成单层渲染，默认改为整行（2026-10-11）

用户报：设置里选「整行」后，播放到当前歌词时**整行高亮是对的，但还带着一个逐渐移动的动画**。
并要求把「歌词高亮方式」的默认值从「逐字」改为「整行」。

### 根因：不是"动画参数没关"，是整行模式**结构上仍留着推进的通路**

D-55 做「逐字 / 整行」开关时，整行模式的实现是：

```
const p = modeRef.current === 'line' ? 1 : getLineProgress(...);
el.style.width = `${p * 100}%`;
```

即整行 = **双层结构照旧，只把 width 写死 100%**。视觉上确实整行亮，但结构里**留着一条
"顶层 width 每帧可被改写"的通路**。只要任何一处退回了逐字计算，就会**静默**恢复成推进动画：

- 模式判断写错 / 读的不是最新值；
- `overlayRef` 指到**上一行**已卸载的节点（React 换行时 ref 更新与 RAF tick 的时序）；
- 从逐字切到整行的瞬间，宽度还带着旧值。

这些都不会报错、界面上也看不出"坏了" —— 只是"整行高亮怎么又在动了"。**静默劣化**比不实现更难查。

### 第二个来源：`transition: all` 与居中字号叠加

`.music-lyr-line { transition: all 0.2s }` 里的 `all` 把 `font-size`（当前行 +3px）与
`font-weight` 一并纳入过渡。歌词是 `text-align: center`，字号渐变时整行**以中心为锚点向两端
缓缓外扩** —— 视觉上就是"一行字在慢慢长大/移动"。**这一条与 width 裁切完全无关**，
只改渲染层治不了；必须由样式侧单独关掉。

### 裁定

1. **整行模式改单层渲染**（`KaraokeLyrics.tsx`）：当前行就是一个普通的
   `.music-lyr-line is-on`，不套 `.kara-dup`、不挂 `.kara-over`、不吃 mask。
   翻译同理单层（`.kara-trans` 本就是块级 + 次级色）。
   → "整行无推进"由**结构**保证：没有可写的 width，就没有可推进的东西。
2. **RAF 在整行模式直接跳过 width 写入**（`modeRef.current !== 'line'` 闸门）：
   单层渲染下 `overlayRef` 恒为 `null`，仍去写等于对着已卸载节点赋值。
3. **样式加 `.is-line-mode` 闸门**：`transition: none`（仅整行模式，逐字模式的行间过渡不动）。
4. **默认值改为 `'line'`**（`LYRICS_MODE_DEF`）；`hydratePrefs` 的白名单收口同步改为
   「显式 `'word'` 才逐字，其余回落 `LYRICS_MODE_DEF`」。

### 两处刻意的克制

- **不迁移老偏好**：`hydratePrefs` 只让「**从没选过**（键缺失）」的人拿到新默认。
  用户在设置页显式选过的值就是他的选择，替他改回去等于产品替他做决定。
  代价是老用户仍可能停在逐字 —— 那是他们的选择，不是缺陷。
- **不删滚动跟随**：`scrollIntoView({ behavior: 'smooth' })` 保留。
  那是**列表导航**（让当前句滚到视野中央），不是高亮动画；去掉会让长歌词跳出场外。

### 断言

- `LYRICS.modeLineRender` 判据**整体重写**：原判据锁在 `modeRef.current === 'line' ? 1 :`
  这个三元上（已随实现删除而失效，留在原地就是一条永远红的死断言）。新判据钉四条结构特征：
  ① 整行分支存在且当前行**单层**（分支边界按「下一个 `kara-dup` 出现处」切，不靠注释文字 ——
  `stripComments` 已剥注释，靠注释切会永远切在 -1 上、静默退化成全文搜 `kara-dup` 而恒红）；
  ② RAF 有 `!== 'line'` 闸门；③ 样式有 `.is-line-mode { transition: none }`；④ 根类名挂了 `is-line-mode`。
- `LYRICS.modeStoreChain` 的水合判据改为引用 `LYRICS_MODE_DEF`（**不写死 `'line'` 字面量** ——
  否则下次改默认值就会红，而红的原因并不是缺陷）。
- **反证 1 → 3**：原锚在旧三元上的那条已失效（锚点不存在 ⇒ **静默跳过**，跳过 ≠ 通过）。
  换成三条分别打「单层 / RAF 闸门 / 样式过渡」，缺任一条断言就该红。
- 🔴 **判据切分支边界时踩到一次自指假阳性**（反证轮当场抓出 `✗ 假阳性：LYRICS.modeLineRender`）：
  我最初用「从整行分支起、到**下一个 `kara-dup` 出现处**」切出整行分支的源码段，
  而反证"把整行改回双层"**恰恰就是往整行分支里插 `kara-dup`** —— 切点跟着反证一起跑掉，
  判据永远看不到那次插入。
  **教训：切"作用域型"判据的边界，不能用被测对象自身的特征当锚点**，要用结构上恒定、
  反证改不动的标记。已改为「**第二个** `return (`」（整行分支内无嵌套 return，分支结构特征）。
  同理也不能靠注释文字切 —— `stripComments` 已剥掉注释，靠它切会永远切在 -1 上、静默退化成
  全文搜索而恒红。**这类缺陷正向轮永远是绿的，只有反证轮能抓到。**
- 验收：`check:music` **216/3**（3 条为既有环境性红：ISLANDV / RESTORE / KEYS，与本轮无关）
  · `check:music:refute` **184/184**（无假阳性、无跳过）· `check:docs` 16/0
  · `tsc --noEmit` 0 · `vite build` 通过。

### 影响面

- 展开播放器与灵动岛**共用** `KaraokeLyrics`，两者同时生效（灵动岛传 `windowSize=2` + `scroll={false}`，
  整行单层在那张小卡里同样成立）。
- 桌面歌词窗（`DesktopLyrics.tsx`）是**另一套实现**（`.dl-line` + `dl-cur`），本来就是整行变色、
  无双层裁切，**不受本轮影响**。

### 回写落点

本文件 + `docs/spec-notes.md` D-55（原始开关的来龙去脉，标注其后继为 D-137）
+ `app/src/screens/music/KaraokeLyrics.tsx` 头部注释 + `player-options.ts` 常量注释。

---

## D-138 · box-service 顶层未捕获异常兜底 —— 崩溃也要先收子进程（2026-10-11）

v2.2.1 结构/健壮性审计（`code-audit-report.md` §13.2a）发现：**全仓 0 个未捕获异常处理器**
（`grep unhandledRejection|uncaughtException` 零命中）。

### 为什么是缺陷

box-service 是 **①②③ 三个子进程的宿主**。Node ≥15 起，未处理的 promise rejection 默认
**直接终止进程** —— 而进程一死，③（llama-server）就丢在那里成孤儿，8080 被占。
E11（「主进程 SIGKILL 后不留孤儿」）防的是**不可捕获**的死法，防不住这条**可捕获**的死法。

### 改法

1. 把原信号处理器（`SIGINT`/`SIGTERM`）的收尾体抽成 `shutdown(reason, exitCode)`：
   `clearInterval(heartbeat)` → `idleWatcher.stop()` → `llm.stop()` → `server.close` → `process.exit(exitCode)`，
   带两层有界兜底（500ms close 保底 / 6s LLM 收尾保底）。
2. 信号处理器改为 `=> shutdown(\`收到 ${sig}\`, 0)`（**单一收尾路径**）。
3. 新增顶层兜底：`process.on('unhandledRejection'|'uncaughtException')` → 记录 →
   `shutdown(…, 1)`。**以非零码退出**：接住异常 ≠ 吞掉故障。
4. `shutdown` 加重入闸 `shuttingDown`：信号与崩溃可能先后到达，只收尾一次。

### 断言（新增 `check:resilience`，源码级）

`e2e/service/resilience-check.mjs`，7 条 / 反证 11 条。判据是**纯函数** `evaluate(src)`：
接收源码文本 → 返回断言结果；反证轮把**内存变异**后的文本喂进去跑同一套判据，
**不碰工作区**（范式取自 `engine-patches-check.mjs`，见审计 §10「最高质量范式」）。

- R1/R2 两类处理器已注册 · R3 都走 `shutdown`（非直接 `process.exit`）· R4 信号也走同一 `shutdown`
  · R5 `shutdown` 内确实 `llm.stop` · R6 有重入闸 · R7 崩溃以非零码退出。
- 反证 M1–M6：改名注销 / 绕过 shutdown / 去 llm.stop / 去重入闸 → 对应条变红。
- 🔴 **写 R6 时抓到一次自指假阳性**：初版判据是 `shutdownBody.includes('shuttingDown')`，
  而 `shuttingDown = true;` 这个**赋值行**同样含该标识符 ⇒ 去掉守卫判据**照样绿**。
  改为正则 `/if\s*\(\s*shuttingDown\s*\)\s*return/` 才咬得住。
  **教训同 D-137：判「结构存在」要用结构本身当锚点，不能用被测对象里恰好也出现的标识符。**

### 规范变更

- 新增验收命令 `check:resilience[:refute]`，已登记 `AGENTS.md` §3 与 `package.json`。
- 断言脚本放 `e2e/service/`（与其余 service 级检查同域），**不进**生产 `src/`。

### 验收

`check:resilience` 7/0 · `check:resilience:refute` 11/11（无假阳性、无跳过）·
`selftest:service` **134/1**（1 条为既有 Windows 环境性红：无 `SIGSTOP`，与本轮无关）·
`node --check service/src/server.mjs` 通过。

### 边界

本脚本证明的是**「顶层兜底结构在」**，**不是**「真崩过且没留孤儿」。后者只能真造一次崩溃，
或靠 `selftest:app:e11`（SIGKILL）从外部补充取证。

---

## D-139 · 抽 `atomic-file.mjs` 底座 + store 任务状态改原子写（2026-10-11）

审计（`code-audit-report.md` §2.2）发现：**同一件事在本仓有两种做法** ——
设置类落盘（`translate/settings.mjs`·`translate/credentials.mjs`·`settings/engine-settings.mjs`）
都做了 `tmp → fsync → rename`，且注释里写明了为什么必须这样；
唯独 `manga/store.mjs::_persistNow` **裸 `writeFileSync`**。

### 为什么是缺陷

裸写崩在中间会留**半截 JSON**。`store.init()` 对读不动或字段缺失的任务文件是**静默跳过**
（`catch { /* 单个任务文件损坏则跳过 */ }`）—— 用户看到的是「跑过的任务历史少了几个」，
而这条路径在**正常退出下永远测不到**。

### 改法

1. 新增跨模块底座 `service/src/atomic-file.mjs`：`atomicWriteJson(file, value, {mode,indent})`
   与 `atomicWriteText(file, text, {mode})`，实现照抄仓内已验证的 `tmp-${pid}-${Date.now} → fsync → rename`
   （tmp 名带 pid+时间戳，与 `translate-check.mjs` 的 `.tmp-` 残留扫描口径一致）。
2. `store.mjs::_persistNow` 改调 `atomicWriteJson`（保留原有「写失败不影响主路径」的吞错语义）。
3. **规范变更**：`AGENTS.md` §1「`service/src/` 根只留跨模块底座」的清单新增 `atomic-file.mjs`。

### 未做（明确留待后续）

`library.mjs::writeManifestAtomic`（无 fsync、固定 `.tmp` 名）与三处设置类落盘**暂未迁移**
到新底座 —— 它们**本身已是原子写**，迁移属纯 DRY，且那三处被 `check:translate` /
`check:engine-settings` 的反证锚点覆盖，迁移须同步改锚。**先修缺陷（store）、后收口重复**，
避免一次改动同时承担「修 bug」与「改结构」两种风险。收口列入后续批次。

### 断言

`check:resilience` 扩为**两组**：R 组（顶层兜底，D-138）+ A 组（原子写）。
A1 = store 走 `atomicWriteJson` 且无裸 `fs.writeFileSync`；A2 = 底座确实 `fsync` + `rename`。
反证 M7（store 退回裸写）/ M8（去 fsync）/ M9（去 rename）→ 各自变红。

### 验收

`check:resilience` 9/0 · `check:resilience:refute` **14/14** ·
`selftest:service` **134/1**（1 条既有 Windows 环境性红）· `check:retry` 10/0 · `check:lib-manage` 24/0 ·
`check:docs` 17/0。

---

## D-140 · 接入 CI + 跨平台写死断言改「平台忠实」（2026-10-11）

审计（`code-audit-report.md` §2.1 / §5）两条并列的 P0：**零 CI** + **跨平台写死断言**。
后者是前者的前置 —— 断言在非 macOS 上恒红，CI 加了也是红的。

### 一、跨平台写死断言（真缺陷）

| 位置 | 原写法 | 问题 |
|---|---|---|
| `e2e/service/e8-accel-check.mjs` E8.1 | `platform==='darwin' && arch==='arm64' && accel==='mps'` | 非 macOS 恒红 |
| 同上 E8.2 | `accel === 'mps'` | 同上（本机是 cuda/cpu 时红） |
| 同上 E8.6 | 恒要求 `mps` 存在、`cuda` 不存在 | 同上（与"反映本机"的原意相反） |
| `e2e/service/engine-profile-check.mjs` R1 | `platform==='darwin' ? … : true` | 非 macOS **零校验假绿** |

改法：一律改**平台忠实** —— darwin 断 metal/mps；非 darwin 断「**不**出现 mps」。
E8.2 的 accel 改为「等于本机推荐后端」（`hw.accel`）；E8.6 改为「含 auto/cpu 与本机后端，
**不含**本机没有的 mps/cuda」。断言条数不变（E8 仍 6 条 / 反证 4 条）。

🔴 **反证锚点也要平台无关**：E8.1 原反证打的是 `metal → mps` 映射那行，而**非 macOS 根本不执行它**
⇒ 反证轮「该红没红」（假阴性），CI 照样挂。改用 `recommendedTier: mapTier(...)` 这行
（**每个平台都经过**）当锚点，变异置 `null` ⇒ E8.1 全平台变红。

### 二、CI（`.github/workflows/ci.yml`）

ubuntu + macos 双平台，Node 22。必过门：
**源码级检查**（`check:docs` / `resilience` / `bundle` / `quit` / `autostart` / `ia` / `units` / `music` / `settings`）
→ **契约自测** `npm run selftest` → **判定层**（`check:e8` / `e4` / `e10`）→ **前端** `tsc --noEmit && vite build`。
真机门（cargo release 打包 / 真权重 E3·E7 / E11 real）**不进常规门**，避免 CI 变"永远红的摆设"。

### 三、环境限制（本机，非缺陷）

`check:profile:refute` 在本开发机**无法验证**：它用 `spawnSync` 起子进程，而本沙箱下
`spawnSync` 报 `EBUSY`（用 `git stash` 跑原始版本对照，**同样失败** ⇒ 与本次改动无关，
是环境限制）。CI 上是正常 runner，不受此影响。已把该现象记此备查：
**本机"跑不了"与"代码坏"要分清 —— 用原始版本对照一次即可定性。**

### 验收

`check:e8` **6/0**（win32/cuda 真机，改造前此处恒红）· `check:e8:refute` **4/4** ·
`check:profile` **44/0**（R1 真判通过）· `check:docs` 17/0 · `selftest:engine` 23/0。
⚠️ CI 尚未在 GitHub 上实跑（本地无法验证 Actions）—— 首次运行可能暴露其余平台相关红条，届时逐条修。

---

## D-141 · `image.mjs` 上移底座 + 新增 `check:layering` 依赖方向钉子（2026-10-11）

审计（`code-audit-report.md` §13.1）指出「缺 service 分层方向的机器约束」，并猜测
`config.mjs → settings/engine-settings.mjs` 是「分层倒置」。

### 先纠正一处定性错误

回读代码发现：`config.mjs` 确实是**组合根** —— 它 import `engine-settings.mjs` 是为了把
「用户可调引擎设置」并进 `config`（`engineTier` / `engineAccel` / `engineUseGpu`），
且 `engineSettings` / `engineSettingSources` / `engineSettingsFile` **有真实消费者**
（config 内部 + `server.mjs:724`）。**不是倒置，也不是死代码。** 同 `server.mjs` 一样，
它们是「装配/组合」职责，本就该读各域 —— 审计把组合根当成了纯底座。

### 真问题：一处真越界

`engine-client.mjs`（底座）为 `sniffImageType` import 了 `manga/image.mjs`（业务域）。
而 `image.mjs` 是**零依赖的图片字节嗅探**，与"漫画"这个业务概念无关 ——
它落在 `manga/` 只是历史位置。

**改法**：`git mv service/src/manga/image.mjs service/src/image.mjs`，更新 3 处 import
（`engine-client` / `server` / `manga/store`）。零断言锚点受影响（e2e 无引用该路径）。

### 断言：`check:layering`（新增，3 条 / 反证 3 条）

把「底座层边界」从散文变成机器判据（此前只写在 `AGENTS.md` §1，无人核查）：

- **L0** `service/src/*.mjs` 文件集 == 白名单 ⇒ 新增底座必须显式登记（同 units `MANIFEST` 的做法），
  防止"随手在根建模块"让底座层无声膨胀。
- **L1** 底座层不得 import `./manga/**`。
- **L2** 底座层对 `./settings/**` 的导入仅限 `engine-settings.mjs`。
- **装配入口 `server.mjs` 豁免 L1/L2** —— 把各域拼起来正是它的职责（初版忘了豁免，
  正向直接红；这说明判据确实咬得住真实结构）。

判据写成纯函数 `evaluate(files)`（接收文件表），反证轮喂**内存变异**（改 import / 增删文件条目），
不碰工作区。

### 规范变更

新增验收命令 `check:layering[:refute]`，登记 `AGENTS.md` §3 与 `package.json`；
`AGENTS.md` §1 底座清单新增 `image.mjs`；§1 增补「方向由 check:layering 机器核查」一句。

### 验收

`check:layering` 3/0 · `check:layering:refute` 3/3 · `selftest:service` 134/1（1 条既有 Windows 环境性红）· `check:docs` 见下。

---

## D-142 · 删 `SongMenu` 并入 `units/ContextMenu`（+ 连带重写 MENU 判据组）（2026-10-11）

审计（`code-audit-report.md` §2.5a）指出：`screens/music/SongMenu.tsx`（140 行）
**完整复刻**了 `components/units/ContextMenu.tsx`（75 行）的四监听器机制
（`mousedown` 捕获 / `keydown` 捕获 / `scroll` 捕获 / `resize`），
连注释都在解释同一个「scroll 不冒泡」的理由。同一应用里菜单项长两副面孔。

### 为什么这次能做（上一次暂缓）

上一批**评估后暂缓**过：它牵动 `check:music` 的 **8 条 MENU 判据 + 9 条反证 + CSS 组**，
全部锚在 `SongMenu.tsx` 内部实现上。这次按其本来面目**连带重写**这些判据。

### 改法

1. **删** `screens/music/SongMenu.tsx`。
2. `shared.tsx::SongRow` 与 `QueueDrawer` 各自持 `menu` state（`{x,y,song,onPlay?}`），
   右键 `e.preventDefault()` + `setMenu(...)`，用 `<ContextMenu>` + `<MenuItem>` 渲染。
   **`onPlay` 语义不变**：宿主给了用宿主的，没给退 `playSong(song)`（队列行不给 → 走兜底）。
3. 🔴 `ContextMenu` 根节点补 `onClick={e => e.stopPropagation()}` + `onContextMenu={e => e.preventDefault()}` ——
   portal 事件沿 **React 树** 冒泡回宿主行，不截断就是「点菜单项 = 顺带点了这一行」。
   这是原 `SongMenu` 里那段 `stopPropagation` 的**通用化**（菜单项自身不必各截一次）。
4. 🔴 **z-index 不能简单照搬**：原 `.music-menu` 是 **78**（必须高于队列抽屉 72 / 展开播放器 70），
   而 `.ui-menu` 是 **60** ⇒ 直接换会被抽屉压住。改法：给右键菜单单列一条
   `.ui-menu.ui-ctx { z-index: 78 }`（普通下拉 MenuButton 不带 `.ui-ctx`，仍 60）。
5. 删 `.music-menu` / `.music-menu-item`（已成死 CSS）。

### 判据搬迁（机制 → units，语义 → 宿主）

| 判据 | 原判 | 今判 |
|---|---|---|
| `MENU.portal` / `closeCapture` / `scrollCapture` / `esc` / `flip` / `noBubble` / `css` | `SongMenu.tsx` | **`units/ContextMenu.tsx`**（+ `components.scss`） |
| `MENU.playSemantics` / `nextItem` / `rowContextMenu` | `SongMenu.tsx` | `shared.tsx`（`SongRow`） |
| `MENU.queueRow` | `QueueDrawer.tsx`（判 `useSongMenu`） | 同文件（判 `useState` + `<ContextMenu>`） |
| `MENU.noDownload` | `SongMenu.tsx` | 三处菜单来源（`shared` / `queueDrawer` / `contextMenu`） |

判据**条数不变**（12 条），故 `check:music` 仍是 216 条。

### 断言

反证锚点同步重定向（9 条）：`document.body` 缩进由 8 空格改 4（ContextMenu 嵌套更浅）——
首轮 refute 因此报「锚点未找到」，修正后 **184/184 全中、零跳过**。

### 验收

`check:music` **216/3**（3 条为既有环境性红：ISLANDV / RESTORE / KEYS）·
`check:music:refute` **184/184** · `check:units` 45/0 · `check:settings` 180/0 ·
`tsc --noEmit` 0 · `vite build` 通过。

### 附：顺带修正一处陈旧计数

`AGENTS.md` 原写 `check:music … 反证 182 条`，实际已是 184（D-137 一带的改动所致）。
已改 184。（该数不被 `check:docs` 机器核对——它只核对**通过**条数 216——故此前无人发现。）

---

## D-143 · 新增 `units/Modal` 收敛 5 处手写模态壳（+ 修 4 条失效反证锚）（2026-10-11）

审计（`code-audit-report.md` §2.5c）指出：`units/` 有 15 个组件却**没有 `Modal`**，
于是同一段模态壳被手写 5 遍，每遍都是逐字相同的
`modal-mask` + `role="dialog"` + `aria-modal` + `stopPropagation`。

### 改法

1. 新增 `app/src/components/units/Modal.tsx`：蒙层 + 卡片 + 标题/正文/操作三段。
   `busy` 时蒙层点击失效（提交中误关）。**只做结构去重，行为一字不动。**
2. 替换 5 处：`components/QuitConfirm.tsx` · `screens/library/modals.tsx`（原 `Sheet` 外壳，
   4 个调用点一并改 `<Modal>`）· `screens/LibraryScreen.tsx`（删除确认 / 已隐藏管理）·
   `screens/settings/CacheBlock.tsx`。
3. `units/index.ts` barrel + `units-structure-check.mjs` 的 `MANIFEST`（16→17）/`BARREL_EXPORTS` 同步登记。

### 🔴 为什么不把 Esc / 焦点陷阱也收进来

现状是"谁需要谁自己挂"（只有 `CacheBlock` 调 `useEsc(onCancel)`），
一次性塞进通用件会**改变现有行为**（退出确认原本不响应 Esc）。收口行为属独立决策，
本件只做结构去重，已在文件头注明。

### 判据同步

`settings-media-check.mjs` 的 `CACHE.confirmBeforeClear` 原判「本文件内联 `modal-mask` + `role=dialog`」，
现改判「用 `<Modal>` 渲染确认层」（那段 DOM 已在单元里）。**未放宽**：仍要求
确认是清除的前置（`pending ?` 门控 + 已调 `musicCacheClear`）。

### 顺带修复：4 条失效反证锚（既有缺陷）

`check:settings:refute` 原为 **123/127**（4 条「破坏锚点未找到」）—— 与本次改动**无关**，
是 D-136 把「通用」组的 `note` / `noteSummary` 删掉后，三条变异仍锚在已不存在的文本上
（用 `git stash` 跑原始版本对照确认）。按本项目「跳过 ≠ 通过」纪律一并修好：

| 变异 | 原锚（已不存在） | 今锚 |
|---|---|---|
| 删 `lyrics-mode` 项 | 含 `why:` 字段的旧条目 | 现条目（`why` 已移除） |
| 删「一行摘要」 | `GENERAL.noteSummary` | **`TRANSLATE.noteSummary`** |
| 写回需求条目号 | `GENERAL.note` 旧文案 | **`TRANSLATE.note`** |

（前两条的语义是"有组说明却没有摘要"「全组文案不许混进设计过程」——改成判「翻译服务」组，
该组是当前**唯一**同时有 `note` + `noteSummary` 的组。）

### 验收

`check:units` 45/0 · `check:units:refute` 59/59 · `check:settings` **180/0** ·
`check:settings:refute` **127/127**（由 123/127 修复）· `check:ia` 32/0 · `check:quit` 5/0 ·
`check:autostart` 12/0 · `check:docs` 17/0 · `tsc --noEmit` 0 · `vite build` 通过。

---

## D-144 · `server.mjs` 去重：任务创建工厂 + 兜底收敛 + multipart 四闸（2026-10-11）

审计（`code-audit-report.md` §2.3）指出 `server.mjs` 三处重复。本节只做**去重**（低风险半边），
**未做**「数据层下沉」（那才是 §2.3 的主项，见下「未做」）。

### 1. 任务创建工厂 `taskLauncher`

`handleChapterResume` / `handleChapterRetranslate` / `handleResume` / `handleRetranslate`
四个 handler 骨架逐字相同（8 行 × 4），只差**目录怎么来**与**建哪类任务**。
抽成 `taskLauncher({ dirOf, build })` + 两个视图构造器（`resumeView` / `retranslateView`）。

🔴 **骨架顺序是契约的一部分**：`sidecar 就绪 → 解析目录（可能抛 404/400）→ 读选项 →
落盘可用性 → 建任务 → 201`。换顺序会**改错误优先级**（例如非法漫画名 + 非法 body 会先报哪个）。
已在工厂上写明"不要重排"。

### 2. 兜底收敛 12 → 1

路由层 `throw new ApiError('TASK_NOT_FOUND', \`未知端点：…\`)` 逐字重复 12 次。
改为 `const miss = () => …` 一个具名动作。（`ApiError` 的其它 13 处 `TASK_NOT_FOUND`
文案各不相同，不属重复，未动。）

### 3. multipart 四闸 `groupMultipart`

上传入口两处（`parseUploadRequest` 的图片批量 / `handleLibraryCover` 的封面）
各自抄了同一段：Content-Type → Content-Length 一致 → boundary 存在 → 以结束分隔符收尾。
抽成 `groupMultipart(req, body)` 返回 `{fields, files}`。

**理由不是「短」而是「同口径」**：少一道闸就意味着某条上传路径会**静默少收几张图**
（截断的请求体照样能解析出前半段）。

### 未做（§2.3 主项，仍待专门一轮）

**数据层下沉**：`scanLibrary` / `resolveComicDir` / `buildBookEntry` / `findFile` 仍住在
HTTP 入口，`store` 仍反向依赖 server 注入的 `ensureLlm` / `tierDowngrade`。
这一步会把 server 与 store 的边界整个翻一遍，须与 `check:contract` + `selftest` 逐条回归，
不属「去重」，故本轮不混做。

### 验收

`selftest:service` **134/1**（1 条既有 Windows 环境性红）· `check:contract` 77/0 ·
`check:retry` 10/0 · `check:lib-manage` 24/0 · `check:retranslate` 12/0 · `check:e10` 7/0 ·
`node --check` 通过。

> 代码行数几乎不变（2871 → 2891）：**去重的价值在「骨架只有一份」，不在行数** ——
> 工厂与两个视图构造器自身的注释占掉了省下的行。

---

## D-145 · 库扫描/视图下沉数据层 —— `server.mjs` → `manga/library.mjs`（2026-10-11）

**背景**：审计 §2.3 主项。`scanLibrary` / `buildBookEntry` / `bookMetaView` / `findFile`
住在 `server.mjs`（HTTP 入口）里，导致「库长什么样」这件事**不起一个服务就验不了**；
而 `library.mjs` 本已是「本→话→页」的数据原语模块，扫描/视图天然属于同一层。

**改动**：四个函数 `git mv` 到 `service/src/manga/library.mjs`（标 `export`）。

### `scanLibrary` 的签名变化（唯一的非纯搬运）

原实现 `scanLibrary()` 直接读 `store.root` / `store.hiddenComics` / `store.hiddenComicsView()`
—— 这正是它无法脱离服务的原因。改成：

```js
export function scanLibrary({ root, hidden, hiddenList }) { … }
```

宿主（`server.mjs`）加一层薄包装注入服务状态，路由调用点从 `scanLibrary()` 改为 `libraryView()`：

```js
function libraryView() {
  return scanLibrary({ root: store.root, hidden: store.hiddenComics, hiddenList: store.hiddenComicsView() });
}
```

`buildBookEntry` / `bookMetaView` / `findFile` 本就是纯函数，**签名一字未改**。
`findFile` 依赖的 `ORIGINAL_SCAN_RE` / `TRANSLATED_SCAN_RE` 一并从 `config.mjs` 在
`library.mjs` 侧 import（`server.mjs` 侧移除，避免未用导入）。

**依赖方向**：`library.mjs` → `../config.mjs`（域→底座，正确）；无反向边，无环。

### 未做（§2.3 剩余）

`resolveComicDir` / `resolveChapterDir` / `mustChapterDir`（**路径解析**，抛 `ApiError` 的
HTTP 语义耦合）仍留在 `server.mjs`；`store` 仍反向依赖 server 注入的 `ensureLlm` / `tierDowngrade`。
这些是**边界重构**（非搬运），须专门一轮 + 全量回归。

### 验收

`selftest:service` **134/1**（1 条既有 Windows 环境性红）· `check:lib-manage` **24/0** +
**refute 13/13** · `check:contract` 77/0 · `check:retry` 10/0 · `check:retranslate` 12/0 ·
`check:layering` 3/0 · `node --check` 通过。`server.mjs` 2891 → **2779** 行。

> 🔴 **踩坑记录（重要）**：本轮 `check:lib-manage --refute` 首次运行被**中断**（耗时约 11 分钟，
> 13 组变异 × 每组重启服务+引擎），而该反证轮是**原地改写真实源文件**、靠 `finally` 还原 ⇒
> 中断后 **M10/M12 两处变异残留在工作区**，导致后续正向跑出 `20/4`（N8/N10b/c/d），
> 一度被误判为「搬迁引入的回归」。用 `git worktree add … HEAD` 跑**基线对照**（24/0）才定性。
> **教训**：本仓「原地变异」型反证轮**必须整轮跑完**（后台 + 足时），跑完**必查 `git status`**；
> 中断后先 `grep -rn "refute：" service/src app/src` 清残留，再下任何结论。

---

## D-146 · 去掉 `onToast` 属性穿透，改用 `useToasts()` 单例总线（2026-10-11）

**背景**：审计 §2.5。吐司函数 `onToast` 由 `App.tsx` 逐层透传到 8 个文件、80 处。
但 `hooks/index.ts::useToasts` 的注释已写明：吐司走的是 **`toastBus` 模块级单例队列**
（当初正为消除"两份互不相通的队列"而改的）⇒ 任何组件直接 `useToasts().push` 推的是**同一条队列**，
透传并无必要。

**改动**：6 个**使用点**各就地取用，宿主不再传：

```ts
const { push: onToast } = useToasts();   // 名字保留 onToast，其余调用点零改动
```

- 使用点：`NotReadyScreen` · `DropScreen` · `LibraryScreen` · `SettingsScreen`→`sections` ·
  `EngineDiag` · `engine-state`（`useEngineState` 由 `(onToast)` 改为无参，内部自取）。
- 宿主：`App.tsx` 去掉 4 处 `onToast={push}`（`push` 在 App 内另有大量使用，保留）；
  `SettingsScreen` 去掉对 `TranslateSection` 的转发；`sections` 去掉对 `EngineDiag` 的转发。
- `LibraryScreen` 的 6 个 `onToast` 使用点**都在主组件内**（948 行起），故一次 `useToasts()` 覆盖全屏。

**风险控制**：无任何断言锚在 `onToast`/`useToasts`（已 grep 核实）；`useToasts().push` 是
`useCallback` 稳定引用，进入 `useCallback`/`useEffect` 依赖数组不引起额外渲染。

### 验收

`tsc --noEmit` 0 · `vite build` 通过 · `check:units` 45/0 · `check:ia` 32/0 ·
`check:settings` 180/0 · `check:music` 216/3（3 条既有环境红）· `check:docs` 17/0。

---

## D-147 · 路径寻址下沉数据层 + `securityLog` 归位底座（2026-10-11）

**背景**：审计 §2.3 剩余。`resolveComicDir` / `resolveBookDir` / `resolveChapterDir` /
`mustChapterDir` 住在 `server.mjs`，靠闭包读 `store.root` ⇒ 脱不开服务。
（审计同段还称「`store` 反向依赖 server 注入的 `ensureLlm`/`tierDowngrade`」—— **经核实不成立**，
见下。）

### 改动一：四个寻址函数下沉 `manga/library.mjs`

`root` 由宿主显式传入（首参），四个函数变**纯函数**：
`resolveComicDir(root, raw)` · `resolveBookDir(root, raw)` ·
`resolveChapterDir(root, book, no)` · `mustChapterDir(root, book, no)`。
依赖：`isSafeDirName`/`normalizeComicName`（`names.mjs`）· `MAX_CHAPTER_NO`/`isValidChapterNo`/
`assertInsideRoot`（`config.mjs`）· `ApiError`/`permissionDenied`/`securityLog`（`../errors.mjs`）·
`hasManifest`/`chapterDirName`（本模块）。**依赖方向 keep 域→底座，无环。**

`server.mjs` 侧改成**注入 `store.root` 的薄包装**（同 `libraryView()` 范式）：

```js
const resolveComicDir = (rawName) => resolveComicDirAt(store.root, rawName);
// …另外三个同形
```

⇒ 调用点（~23 处）**零改动**。`server.mjs` 本轮（D-144/D-145/D-147）累计 2891 → **2680** 行。

### 改动二：`securityLog` 从 `server.mjs` 归位 `errors.mjs`（底座）

寻址函数在拒绝时要「记一笔 + 回 403」，而 `securityLog` 原只在 `server.mjs`。
下沉到 `errors.mjs` —— 它与 `permissionDenied()` 本就是**同一个安全响应的两半**。
`errors.mjs` 是既有底座（L0 白名单无需变更）；`server` 与 `library` 各 import 之。

### 🔴 安全语义逐条保留（**先 403 后 404**）

`resolveComicDir` 与 `resolveChapterDir` 都**先判越界**（`isSafeDirName` fail ⇒ 403），
**再判格式/存在**（404）。顺序反了，`../../etc` 会被回 404 ⇒ 把「有人试图越界」掩盖成
「名字/话号拼错」。搬迁只在 `SERVER_SRC → LIBRARY_SRC` 挪了位置，判据与顺序一字未改；
`check:e10`（7/0）与 `check:lib-manage` 的越界守卫（L 组）在真 HTTP 上复验通过。

### 核实：所谓「store 反向依赖」实为**刻意的依赖注入**（审计误判）

`store.mjs` **不 import `server.mjs`**；是 `server` 在装配阶段注入
`store.ensureLlm = () => llm.start(...)` / `store.tierDowngrade = tierCtl`。
两者在 `store` 里都**声明为可空缺省**（`= null`），注释明写「缺省 `null` ⇒ 纯 Store 场景
（单测/自检）行为完全不变」，使用处也都有 `typeof === 'function'` / 真值守卫。
⇒ 这不是「反向依赖」，恰是**让 Store 可独立测试**的 DI。**故本项不改**（改了反而破坏可测性）。

### 验收

`selftest:service` **134/1**（1 条既有 Windows 环境性红）· `check:lib-manage` **24/0 +
refute 13/13（字节还原校验全过）** · `check:contract` 77/0 · `check:e10` 7/0 · `check:retry` 10/0 ·
`check:retranslate` 12/0 · `check:layering` 3/0 · `node --check` 通过。

---

## D-148 · 拆 `LibraryScreen.tsx`：「看图/对照」簇 + 8 个子组件全部外移（2026-10-11）

**背景**：审计 §3.3。`LibraryScreen.tsx` 2,122 行，单文件里塞了 8 个子组件 + 2 个弹窗
（而 `screens/library/modals.tsx` 已存在）。`screens/library/` 目录已有 `blob.ts` / `chapters.tsx`
/ `modals.tsx` 的拆分范式，本轮沿用。

### 移出的内容

| 新去处 | 内容 | 理由 |
|---|---|---|
| `screens/library/viewer.tsx`（新，536 行） | `Pane` + ZOOM 常量/`clampZoom` + `Lightbox` + `Compare` | 「看图 / 对照」是一个独立关切（含 200+ 行缩放/平移交互说明），与「列表 / 搜索 / 分页」无关 |
| `screens/library/cards.tsx`（新，112 行） | `CoverThumb` · `Highlight` · `Thumb` · `GridState`/`GRID_LABEL` | 纯展示小件，无状态机依赖 |
| `screens/library/modals.tsx`（+105 行） | `DeleteComicModal` · `HiddenComicsModal` | 与既有的新建/编辑/归并弹窗同类，收在一处 |
| `screens/library/meta.ts`（新，35 行） | `retranslateMeta` · `resumeMeta` | 见下「为什么要单开」 |
| `screens/library/blob.ts`（+25 行） | `PageView` 接口 | `Viewer` 与屏本体都要它；留在屏内会成环 |

`LibraryScreen.tsx` **2,122 → 1,344 行**（-37%）。**8 个子组件 + 2 个弹窗已全部移出**；
屏本体只留编排、列表与状态机。

### 🔴 为什么要单开 `meta.ts`（而不是留在屏内）

`retranslateMeta` 同时被**屏本体**与 `Compare`（已搬到 `viewer.tsx`）使用。
留在 `LibraryScreen.tsx` 会形成 `viewer.tsx → LibraryScreen.tsx`（值导入 `Compare`）
与 `LibraryScreen.tsx → viewer.tsx` 的**循环 import**。故下沉到零依赖的 `meta.ts`。
连带同步 3 处把它当「范式」引用的规范文档：`AGENTS.md` §2.10 · `.trae/rules/project_rules.md` §2.8 ·
`docs/spec-notes.md`（范式指针从 `LibraryScreen.tsx` 改为 `screens/library/meta.ts`）。

### 🔴 最坑的一处：`stripComments` **跨文件失同步**（实测假阳性）

`check:units` 的 ZOOM 组读的是屏源码。拆文件后我把 `s.library` 改成「屏本体 + `screens/library/*.tsx`」
**拼接**。第一版直接拼**原文**再让判据 `stripComments` ⇒ `ZOOM.wheelNonPassive` **该红没红**（假阳性）。

根因：`stripComments` 是**带状态机**的（反引号/引号/正则字面量都可能让它跑偏，D-110 同类）。
前一个文件跑偏后的状态会**污染**后一个文件 —— 具体是 `viewer.tsx` 里含 `addEventListener('wheel'`
的**块注释**没被剥掉（其前面的某个文件把状态带偏了），于是"移除注册行"的变异仍能匹配到注释里的字样。

**修法：逐文件单独 `stripComments` 再拼接**（每个文件都从 `code` 态起步，互不牵连）。
已写进 `loadSources()` 的注释。

### 反证锚的搬迁

- `units-structure-check.mjs`：新增 `F.libraryViewer`；`s.library` 改为拼接；**9 条 ZOOM 变异**的
  `file:` 从 `F.library` 改 `F.libraryViewer`。
- `retranslate-check.mjs`：新增 `VIEWER_SRC`；R6 判据改读 viewer；M5/M6 两条变异的 `file:` 改 `VIEWER_SRC`。

### 验收

`tsc --noEmit` 0 · `vite build` 通过 · `check:units` **45/0 + refute 59/59** ·
`check:settings` 180/0 · `check:ia` 32/0 · `check:autostart` 12/0 · `check:music` 216/3（3 条既有环境红）·
`check:lib-manage` 24/0 · `check:retranslate` 12/0 + **refute 9/9（viewer.tsx 字节还原）** · `check:docs` 17/0。

> ⚠️ **仍未做**：屏本体 `LibraryScreen()` 自身仍是 **1,174 行**（25 个 `useState`）——
> 它的内部拆分（左栏 / 网格 / 详情各自成件）需按 props 重新划边界，风险高于本轮，留作独立一轮。

> 📌 **环境坑**：`vite build` 会先清空 `app/dist/`（661 个文件），被本机沙箱的
> safe-delete 守卫拦下（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，阈值 50）。**不是代码问题**：
> 把 `dist/` 移走再 build 即可。

---

## D-149 · 拆 `music/store.ts` 第一刀：歌词纯函数 → `tools/lyrics.ts`（2026-10-11）

**背景**：审计 §3.3。`music/store.ts` 2,822 行，混了四层职责（纯函数 / 持久化 / 网络 / 播放状态机）。
本轮先把**最干净的一簇**拿出去：歌词解析纯函数。

### 移出的内容

`screens` 无关的**零依赖纯函数** → 新建 `app/src/tools/lyrics.ts`（228 行）：
`LyricWord` / `ParsedLyricLine` 类型 · `parseLrc` · `finalizeLineDurations` · `parseYrc` ·
`mergeTranslation` · `lyricIndexAt`。

理由：这些的进出都是字符串 / 数组，**不碰 store 的任何状态**，却被 store 独占 —— 而
`tools/index.ts` 头注释明写「纯函数便于在规格自检里单独验证」，这个约定在歌词解析上原先没遵守。

`store.ts` **2,822 → 2,604 行**。引用方随之改指：`KaraokeLyrics.tsx`（`lyricIndexAt`/`ParsedLyricLine`）·
`DynamicIsland.tsx`（`ParsedLyricLine`）。`store.ts` 只留 `mergeTranslation`/`parseLrc`/`parseYrc`
（`loadLyrics` 要用）。

> ⚠️ 仍**未做**：store 的持久化簇（`readLS`/`writeLS`/快照/`savePrefs`）与四层职责分离。
> 那要牵动 `prefs.islandView` 那条反证锚，留下一刀。

### 断言锚的搬迁（与 D-148 同一套做法）

- `music-platform-check.mjs`：新增 `F.lyrics`；新增 `s.storeLyrics` = **逐文件单独 `stripComments` 再拼接**
  （不能直接拼原文 —— 状态机跨文件失同步，见 D-148）；`LYRICS.parseYrcUsed` / `LYRICS.lineInterpolation` /
  `LYRICS.translationMerge` 三条判据改读 `s.storeLyrics`；3 条变异（`parseYrc` 改名 /
  `finalizeLineDurations` 夹紧 / `parseLrc` 补 duration）的 `file:` 从 `F.store` 改 `F.lyrics`。
- 正向 `216/3`（3 条既有环境红不变）· **反证 184/184、零跳过**。

### 🔴🔴 本轮的真正地雷：`sed -i` / `Write` 会**把文件写成 LF**，而本仓工作区是 CRLF

这是本轮踩到的、**比代码本身更值得记**的坑，务必按下面的做法排查。

**现象**：`check:docs` 从 17/0 变 15/2 —— 报「AGENTS.md 声明的 check:music 条数与脚本一致
〔文档写 216，脚本实际 217〕」。`check:docs` 是**实跑脚本取「通过 N」**，所以是 `check:music`
的通过数变了：`RESTORE.restoringClosed` 由红转绿。

**根因**：该判据里有两条**多行**锚点用 `occurrences(src, 'get().clearQueue();\n            set(…)')`
—— 字面量是 **LF**。工作区若是 CRLF，这两条**本来就该红**（本仓已知的 EOL 假红）。
而本会话用 `sed -i` 删行、用 `Write` 建新文件，**两者都会把整文件写成 LF** ⇒ 那两条锚点
突然命中 ⇒ 判据变绿 ⇒ 通过数 216→217 ⇒ `check:docs` 报错。
（同一根因也会**反向**影响其它按 CRLF 写的锚点。）

**纪律**：
1. **改完必须把文件转回 CRLF**（本仓 `core.autocrlf=true`，工作区 CRLF）。检测**不要用
   `grep -c $'\r'`** —— 该转义在 Git Bash 里可能不展开成空模式，于是 `grep -c ''` **匹配每一行**，
   看着"C R 数 = 行数"像是没问题，实际早已是纯 LF（本轮就是这么被误导的）。用 Node 数
   `text.split('\n').filter(l => l.endsWith('\r')).length`，或直接判 `\r` 是否出现。
2. **判据若出现 flaky 的红/绿翻转，先查该文件的 EOL**，再怀疑代码。
3. `Write` 工具与 `sed -i` 都会写 LF；`Edit` 保留原行尾。**批量搬家优先用 `sed -n`（只读）+ 追加**，
   若用了 `sed -i`，末尾统一转 CRLF。

### 验收

`tsc --noEmit` 0 · `vite build` 通过 · `check:music` 216/3 + **refute 184/184** ·
`check:units` 45/0 + refute 59/59 · `check:settings` 180/0 · `check:ia` 32/0 · `check:autostart` 12/0 ·
`check:lib-manage` 24/0 · `check:retranslate` 12/0 · `check:docs` 17/0。

---

## D-150 · 拆 `sections.tsx`：5 个 Section 各自成件（2026-10-11）

**背景**：审计 §3.3 的最后一个大文件。`screens/settings/sections.tsx` **1,225 行**，
5 个 Section 挤一文件（`TranslateSection` 单组件 758 行），且共享件（`itemOf`/`Group`）
夹在各 Section 之间。它是三个大文件里**断言耦合最高**的一个：**78 处读判据 + 26 条变异锚**
都锚在它一个文件上。

### 新的目录结构

```
app/src/screens/settings/sections/
  index.tsx             桶文件（5 行）—— 外部引用 `@screens/settings/sections` 路径**不变**
  shared.tsx            共享件：itemOf · Group
  GeneralSection.tsx    ① 通用
  TranslateSection.tsx  ② 翻译（+ RestartHint / pendingRestart / TIER_LABEL / IDLE_MIN_MAX / SRC_OPTIONS / STATUS_TEXT）
  MediaSection.tsx      ③ 播放·媒体（+ LS_LYRICS_LOCKED / readLyricsLocked / writeLyricsLocked）
  ResourceSection.tsx   ④ 资源与投放
  AboutSection.tsx      ⑤ 关于
```

`SettingsScreen.tsx` 是**唯一**引用者，且走目录 index ⇒ **零改动**。旧 `sections.tsx` 删除。
共享件的归属按**实际使用者**定：`itemOf`/`Group` 被 ≥3 个 Section 用 ⇒ `shared.tsx`；
`TIER_LABEL`/`IDLE_MIN_MAX`/`RestartHint`/`pendingRestart`/`SRC_OPTIONS`/`STATUS_TEXT` 只 TranslateSection 用
⇒ 随它走（不进 shared，避免"共享"变成垃圾桶）。

### 断言锚的搬迁

- `settings-media-check.mjs`：`F.sections`（单文件路径）→ `F.sectionsDir` + `s.sections` =
  **逐文件单独 `stripComments` 后拼接**（与 D-148/D-149 同一范式）；新增 4 个锚落点
  `secGeneral`/`secTranslate`/`secMedia`/`secAbout`；**26 条变异锚**逐条改指
  （Translate 16 · Media 6 · General 2 · About 2；`shared.tsx` 0 条）。正向 180/0 + **refute 127/127**。
- `service-autostart-check.mjs`：`SECTIONS`（路径）→ `readSections()`（每次重读的拼接）；
  D2 的变异锚改指 `SECTION_TRANSLATE`。
- `units-structure-check.mjs`：`CALLER_IMPORT_FILES` 里 `sections.tsx` 一项改指
  `sections/TranslateSection.tsx`（引 units 最多者作代表 —— `ResourceSection`/`AboutSection`
  用 parts + 专用块，本就不引 units）。

### 🔴 两个坑（都是"搬迁语义变了但调用点没跟上"）

1. **模块级常量只算一次 ⇒ 反证轮读到旧内容**（D2 **假阳性**）。`SECTIONS` 原先是个**路径**常量，
   我把它换成"读全部 Section 拼接"后仍是模块级 `const` —— 反证轮改的是磁盘文件、再调 `runAll()`，
   而常量早在模块加载时就求值完了 ⇒ 读到旧内容 ⇒ D2 该红没红。
   **修法：改成函数 `readSections()`，在 `runAll()` 里每次调用**（与既有的 `read(SERVICE_RS)` 同一范式）。
   —— 教训：**把"路径常量"改成"内容常量"时，要同时检查它的求值时机**。
2. **改语义后忘了改调用点**：`const sec = read(SECTIONS)` 里的 `read()` 期待**路径**，而 `SECTIONS`
   已变成**内容** ⇒ `read('<一整份源码>')` ⇒ `ENAMETOOLONG: name too long`。

### 验收

`tsc --noEmit` 0 · `vite build` 通过 · `check:settings` **180/0 + refute 127/127（零跳过）** ·
`check:autostart` **12/0 + refute 12/12** · `check:units` **45/0 + refute 59/59** · `check:ia` 32/0 ·
`check:music` 216/3（3 条既有环境红）· `check:lib-manage` 24/0 · `check:retranslate` 12/0 ·
`check:contract` 77/0 · `check:docs` 17/0。

---

## D-151 · 拆 `LibraryScreen` 屏本体：左栏 → `LeftRail.tsx`（2026-10-11）

**背景**：D-148 把 8 个子组件与 2 个弹窗移出后，屏本体 `LibraryScreen()` 自身**仍是 1,174 行**
（25 个 `useState`）—— 这是审计 §3.3 对 LibraryScreen 的**第一条**抱怨，D-148 没解决。

### 移出的内容

`<aside>`（**204 行** JSX）→ 新建 `screens/library/LeftRail.tsx`（253 行）：

```
app/src/screens/library/
  LeftRail.tsx    左栏：搜索框 + 列表（浏览态 / 搜索分组态 / 无分层平铺态）+ 容量脚 + 分页器
  libModel.ts     共享小件：LIB_PAGE_SIZE · AUTHOR_FALLBACK · PageCounts · progressLabel · LibItem
```

`LibraryScreen.tsx` **1,344 → 1,126 行**（屏本体约 955 行）。

**为什么单开 `libModel.ts`**（与 D-148 的 `meta.ts` 同因）：`LIB_PAGE_SIZE` / `AUTHOR_FALLBACK` /
`PageCounts` / `progressLabel` / `LibItem` **屏本体与 `LeftRail` 都要** —— 留在 `LibraryScreen.tsx`
会形成 `LibraryScreen ↔ LeftRail` 的循环 import。

### 关于「20 个 props」

左栏是**受控视图**（搜索词、选中键、折叠集、页码都由屏本体持有），故 props 多。
这比留在屏内更好：抽出来后左栏只依赖 props，可单独理解；而"20 个 props"正是**受控组件**的
应有形状（本仓守「零 Context」，不引入 Context 来回避 props）。
`onCtxMenu` / `onMerge` / `onShowHidden` 三个是**动作**而非状态，屏本体各自只回传一个值。

### 断言锚

**零变异锚受影响** —— `check:units` 的 ZOOM 组读的是「`LibraryScreen.tsx` + `screens/library/*.tsx`」
的拼接（D-148 建的机制），而左栏里没有任何缩放代码。故本轮只跑检查、没改断言。

### 验收

`tsc --noEmit` 0 · `vite build` 通过 · `check:units` **45/0 + refute 59/59** · `check:music` 216/3 ·
`check:settings` 180/0 · `check:ia` 32/0 · `check:autostart` 12/0 · `check:lib-manage` 24/0 ·
`check:retranslate` 12/0 · `check:docs` 17/0。

> ⚠️ 屏本体仍约 **955 行**（25 个 `useState`）。右栏（头行 + 网格 / 话列表，约 290 行 JSX）
> 是下一刀的自然落点；但**它引用的状态更多**（`gridView`/`gridSeqs`/`chapterRows`/上下文菜单…），
> 抽出的 props 会比左栏更多 —— 建议与「把派生值收成 `useLibraryModel()`」一并做。

---

## D-152 · 拆 `LibraryScreen` 右栏 → `LibraryRight.tsx`（2026-10-11）

**背景**：D-151 抽走左栏后，屏本体仍 ~955 行 —— 因为 return 里还剩**右栏**（头行 + 屏 B 话列表 /
屏 A·C 页网格，**201 行** JSX）。

### 移出的内容

`<section className="lib-right">`（201 行）→ 新建 `screens/library/LibraryRight.tsx`（283 行）。

`LibraryScreen.tsx` **1,126 → 950 行**；屏本体 **1,174 → 约 830 行**（-29%）。

至此 `screens/library/` 目录：

| 文件 | 内容 |
|---|---|
| `blob.ts` / `chapters.tsx` / `modals.tsx` / `cards.tsx` / `viewer.tsx` / `meta.ts` | D-119 / D-148 已建 |
| `libModel.ts` | D-151 建的共享小件 |
| `LeftRail.tsx` | D-151 左栏 |
| `LibraryRight.tsx` | 本轮 · 右栏 |

### 27 个 props —— 与左栏同理

右栏比左栏引用更多状态（`gridView`/`gridSeqs`/`missingSeqs`/`translatedSeqs`/`seqMax`/`chapterRows`/
`reworkingComics`/`chPage`/`gridPage`/…），但有两点让它没变成"传整个 store"：

1. **动作与状态分开**：`onOpenChapter` / `onExitChapter` / `onOpenDir` / `onResume` /
   `onRetranslate` / `onEditNoChapter` / `onCompare` 是**动作**，父层各回传一个值。
   特别地 `onExitChapter`（出话）与 `onOpenChapter`（进话）**必须分开** —— 一开始想把"返回"
   也表达成 `onOpenChapter(-1)`，那是把哨兵值塞进业务语义里，改掉了。
2. **`onOpenDir` 收编了 `openPath` + 失败 Toast**：原先这段（`openPath(...).catch(e => onToast(errorText(e), 'bad'))`）
   写在右栏 JSX 里，等于把"打开目录失败怎么提示"这个产品决定漏给视图层。现在右栏只喊"打开它"。

### 断言锚

**零变异锚受影响**（与 D-151 同）：`check:units` 的 ZOOM 组读「`LibraryScreen.tsx` +
`screens/library/*.tsx`」拼接，而右栏没有缩放代码。

### 验收

`tsc --noEmit` 0 · `vite build` 通过 · `check:units` **45/0 + refute 59/59** · `check:music` 216/3 ·
`check:settings` 180/0 · `check:ia` 32/0 · `check:autostart` 12/0 · `check:lib-manage` 24/0 ·
`check:retranslate` 12/0 · `check:contract` 77/0 · `check:docs` 17/0。

> 📌 `LibraryScreen.tsx` 累计 **2,122 → 950 行**（D-148/D-151/D-152 三刀）。
> 屏本体 830 行里绝大部分是**状态与副作用**（25 个 `useState` + 12 个 `useEffect`/`useMemo`）——
> 再往下拆就得把这些派生值收成一个 `useLibraryModel()` 自定义 hook（按职责分组），
> 那是"拆状态"而非"拆视图"，属另一类改造。

---

## D-153 · 拆 `music/store.ts` 第二刀：持久化 → `music/persist.ts`（2026-10-11）

**背景**：审计 §3.3 说 `store.ts` 混了四层职责（纯函数 / 持久化 / 网络 / 播放状态机）。
D-149 已把**纯函数**下沉 `tools/lyrics.ts`；本轮下沉**持久化**层。

### 移出的内容 → `app/src/music/persist.ts`（135 行）

`readLS` · `writeLS` · `LS_SNAPSHOT` · `SNAPSHOT_VERSION` · `SNAPSHOT_MAX_QUEUE` ·
`SNAPSHOT_PERSIST_INTERVAL_MS` · `ResumeSnapshot` · `truncateQueueForSnapshot` ·
`readResumeSnapshot` · `writeResumeSnapshot` · `clearResumeSnapshot` · `sanitizeForStorage`。

`store.ts` **2,604 → 2,485 行**。

**刻意留在 store 的三样**（避免把"持久化"变成垃圾桶）：
- `LS_HISTORY` / `LS_LOCAL` / `LS_PREFS`：这三个键是**业务**（历史 / 本地曲库 / 偏好），
  store 各处直接按语义用，不适合搬走；
- `savePrefs` 与 `Prefs`：`Prefs` 是 **`MusicState` 的公开形状**（`prefs: Prefs` 是 state 字段），
  搬走会让 `persist ↔ store` 成环；`savePrefs` 与它同生共死，故一起留；
- `clampInRange` / `dlPrefsOf`：`dlPrefsOf` 是**从 state 派生下载偏好**，根本不是持久化。

### 引用方改指

`MusicKernel.tsx`：`SNAPSHOT_PERSIST_INTERVAL_MS` 从 `@music/store` 改从 `@music/persist` 导入
（它是"快照兜底定时器"的间隔，语义上就属于持久化）。

### 断言锚的搬迁

- `music-platform-check.mjs`：新增 `F.persist` 与 `s.storePersist`（`store.ts` + `persist.ts`，
  逐文件 strip 后拼接）；`RESTORE.snapshotVersioned`（`readResumeSnapshot` 体）与
  `RESTORE.truncateKeepsCurrent`（`truncateQueueForSnapshot` 体）改读 `s.storePersist`；
  2 条变异锚（快照版本校验、截断重算 index）的 `file:` 从 `F.store` 改 `F.persist`。
- 正向 216/3（3 条既有环境红不变）· **反证 184/184、零跳过**。

### 验收

`tsc --noEmit` 0 · `vite build` 通过 · `check:music` 216/3 + **refute 184/184** ·
`check:units` 45/0 · `check:settings` 180/0 · `check:ia` 32/0 · `check:autostart` 12/0 ·
`check:lib-manage` 24/0 · `check:retranslate` 12/0 · `check:docs` 17/0。

> 📌 **§3.3 至此收口**：`LibraryScreen.tsx` **2,122 → 950**（D-148/D-151/D-152）·
> `music/store.ts` **2,822 → 2,485**（D-149/D-153）· `sections.tsx` **1,225 → 5 件 + 桶**（D-150）。
> 仍**未做**且已知风险：① `store.ts` 的**播放状态机**那层（`MusicState` 416 行 / `create()` 千余行）
> —— 真正的解法是按 zustand **slice** 拆，属高风险重构；② `LibraryScreen` 屏本体余下 ~830 行的
> 派生值收口（`useLibraryModel()`）；③ 三平台共享的 `engine-profile-check` 等历史遗留。

---

## D-154 · 拆 `LibraryScreen` 屏本体第二刀：状态与派生 → `useLibraryModel`（2026-10-11）

**背景**：D-152 之后屏本体仍 ~830 行 —— 里面的绝大多数是**状态（25 个 `useState`）+ 派生
（`useMemo`：`items`/`searchGroups`/`gridView`/`chapterRows`/…）+ 它们的重置副作用**，
与"渲染什么、点了做什么"是两件事。

### 移出的内容 → `app/src/hooks/useLibraryModel.ts`（472 行）

一整段连续块（原 149–479 行，330 行）：25 个 `useState` · 全部 `useMemo` 派生 · 随之而来的
`useEffect`（页码夹回、换词复位、`focus` 定位、预取返工计划…）· `flatViewOf`/`chapterViewOf`
两个投影构造器。**返回 72 个名字**（状态值 + setter + 派生值）。

`LibraryScreen.tsx` **950 → 649 行**；屏本体 **1,174 → 约 582 行**（累计 -50%）。

**留在屏本体的是什么**：`retranslate`/`resume`/`confirmDelete`/`createBook`/`saveMeta`/`mergeInto`/
`renumberChapter`/`renderComicMenu` 这些**动作** —— 它们要发请求、要弹 toast，属于"用户做了什么"，
不是"数据长什么样"。这条界线是本刀的分界依据。

`GRID_PAGE_SIZE` / `CHAPTER_PAGE_SIZE` 随之下沉 `screens/library/libModel.ts`（与 `LIB_PAGE_SIZE` 团聚）。

### 🔴 踩到 D-41 的硬约束：`use*` 文件必须住 `src/hooks/`

第一版把钩子放在 `screens/library/useLibraryModel.ts`，`check:units` 的
`HOOKS.noMisplacedUse` **立刻变红**：「文件名以 use + 大写字母开头的文件必须住在 `src/hooks/` 内」。
这条**没有豁免机制** —— 于是钩子落到 `app/src/hooks/useLibraryModel.ts`，并**登记进
`HOOKS_MANIFEST`**（显式白名单，与 units 的 `MANIFEST` 同一套做法）。
⚠️ 不登记的话，`HOOKS` 组会报"hooks 目录多了一个没登记的件" —— 同样是红。

**代价与取舍**：钩子住在共享的 `hooks/`，却 import `@screens/library/{libModel,blob}`（屏内小件）。
这是"use* 一律住 hooks"与"屏内逻辑留屏内"两条约定的**交叠处**：本仓的 D-41 是硬约束，
故按它办；若将来出现第二个屏级钩子，值得为"屏级 hooks"单开一条豁免规则（而不是继续往
共享 `hooks/` 里堆屏内概念）。

### 断言锚

**零变异锚新增/改指** —— `check:units` 的 ZOOM 组读「`LibraryScreen.tsx` + `screens/library/*.tsx`」
拼接，本刀只动状态/派生（`.ts` 钩子不在 `.tsx` glob 里，且里面没有缩放代码）。唯一改的是
`HOOKS_MANIFEST` 加一项。

### 验收

`tsc --noEmit` 0 · `vite build` 通过 · `check:units` **45/0 + refute 59/59** · `check:music` 216/3 ·
`check:settings` 180/0 · `check:ia` 32/0 · `check:autostart` 12/0 · `check:lib-manage` 24/0 ·
`check:retranslate` 12/0 · `check:contract` 77/0 · `check:docs` 17/0。

---

## D-155 · `music/store.ts` 的 slice 拆分：**已勘查、未执行**（2026-10-11）

**§3.3 的最后一项**。D-149/D-153 已把纯函数与持久化两层切走；剩下的是 `create()` **体本身 1,576 行**
（`store.ts:909-2485`）。实测勘查结论：**这不是"再切一刀"，而是一轮独立重构**。

### 实测数据（决定了它为什么不能顺手做）

| 项 | 数值 |
|---|---|
| `create()` 体内的 action 段 | **13 段**（`init` / 本地 / 播放 / 队列 / 播放历史 / 平台 / 搜索 / 左栏 / 右栏 / 红心 / 歌词·评论 / 桌面歌词 / UI），合计约 1,300 行 |
| 读 `s.store` 的判据 | **52 处** |
| 指向 `store.ts` 的变异锚 | **44 条** —— 其中 **19 条是多行 / 带转义**的锚，**无法用脚本自动定位归属段**，只能逐条人工判断 |

### 三个必须先解的障碍（否则切到一半就是"断言红着"）

1. **循环 import**：`MusicState` 接口**未导出**（`interface MusicState`）；action 段还依赖
   `localToSong` / `LS_LOCAL` / `fmtTime` / `songKey` / `coverProxyUrl` 等**住在 store.ts 的值**。
   直接把段切到 `music/actions/*.ts` ⇒ 新文件 import `@music/store`，而 store 又 import 新文件 ⇒ **成环**。
   **每一步切片都要连带搬迁这些共享件**（`LS_*` 宜进 `persist.ts`；`localToSong`/`fmtTime`/`songKey`/
   `coverProxyUrl`/`qualityLabel` 宜进新的 `music/convert.ts`，并更新 `DynamicIsland` 等引用方）。
2. **类型**：slice 工厂的签名要用 `StoreApi<MusicState>['setState'|'getState']`（`zustand@4.5.7` 可导入
   `StoreApi`），且 `store.ts` 的 `create` 回调要补第三参 `api`；`MusicState` 需 `export`。
3. **锚迁移**：`s.store` 改成「`store.ts` + `music/actions/*.ts`」的**逐文件 strip 拼接**（一次改动即可覆盖
   52 处判据）；但 **44 条变异锚**要逐条改指 —— 19 条多行锚必须人工读。

### 建议的执行顺序（下一轮）

批量搬迁共享件（障碍 1）→ `export MusicState` + `s.store` 改拼接 → **按段推进**，每段：
切文件 → tsc → `check:music` 正向 + refute → 全绿再提交。**不要一次切 13 段**。
