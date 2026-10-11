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
