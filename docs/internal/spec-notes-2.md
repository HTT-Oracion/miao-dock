# spec-notes-2 · 决策与陷阱台账（续篇二）

> 本文件是 `docs/internal/spec-notes.md`（D-01~D-136）与 `docs/internal/spec-notes-1.md`（D-137~D-377）
> 的**续篇**，三份同权。
>
> ## 编号规则
> 编号**全局接续**，不重复占用：新增前先确认三份文件里的最大编号。
> 本文件从 **D-378** 起写。新增条目前先跑一遍：
>
> ```bash
> node -e "const fs=require('fs');const all=[];for(const f of ['docs/internal/spec-notes.md','docs/internal/spec-notes-1.md','docs/internal/spec-notes-2.md']){const t=fs.readFileSync(f,'utf8');for(const m of t.matchAll(/^## D-(\d+)/gm))all.push(+m[1]);}all.sort((a,b)=>a-b);console.log('max',all[all.length-1],'count',all.length);"
> ```
>
> ## 写什么
> - **D-xx**：决策 / 陷阱（做过什么、为什么这样做、代价是什么）
> - **G-xx**：待裁定缺口（发现了但本轮不做的）
>
> 只写**回读代码与真机取证后**的结论。记忆不是证据。

---

## D-378 · 引导页与下载页按设计稿推翻重写（2026-10-24）

### 背景：上一轮是"换皮"，不是还原

上一轮把 ver3 的**配色与圆角**套到了旧 DOM 上，布局与层级一点没动。取证（对设计稿
`miao-dock-design/refactor_ver3.0/` 的 `styles.css` + `js/manga.js` 逐块比对）：

| 屏 | 设计稿 | 重写前 | 结论 |
|---|---|---|---|
| 引导页容器 | `.notready`（页面内距 `26 28 40`）+ `.nr-wrap`（880）+ `.nr-card`（padding 24 / r26 / 装饰弧） | `.notready` **自己**是那张 460 宽的卡 | 结构错：页面与卡被合成一层，宽度只有设计稿一半 |
| 引导页内容 | 插画 104×92 → 状态胶囊 → `23px` 标题 → 说明 → 动作行 → 时间线 → 左右两栏 → 诊断 | 一行摘要 + 竖排时间线 + 一行 meta | 缺插画 / 胶囊 / 两栏面板 / 三格诊断 |
| 时间线 | `.timeline` 五列等分，节点 15px，线由 `::before` 画、首尾各收一半 | `.tl-*` **竖排**（24px 节点 + 左侧竖线 + 段内插槽） | 形态完全不同：横向"一条线串五颗节点"被做成纵向列表 |
| 下载页预检 | `.ed-preflight` 四格（总下载 / 保存位置 / 磁盘 / 模型源） | 整块不存在 | 首次装配的确认环节整块缺失 |
| 演示面板 | `.demo-fab` + `.demo-drawer` + 六态 | 不存在 | 六种状态无法复现 |

### 做法

**结构照设计稿重写，判定与数据一条不动**：

- `NotReadyScreen.tsx`：改成 `.notready > .nr-wrap > .nr-card` 三段式；新增 `.nr-illu`（`Mascot`）、
  `.nr-kicker`（状态胶囊）、`.nr-aside`（需要下载 / 下载位置两栏）、`.nr-diag`（三格）、
  `.nr-list`（逐行原因）、`.nr-log`、`.nr-foot-hint`。
- `AssemblyTimeline.tsx`：从竖排 `.tl-*` 改成 `.timeline` + `.timeline-step[data-state]`，
  节点形态只由 `data-state` 表达（done / active / failed / waiting）。
- `DownloadPanel.tsx`：补 `.ed-preflight` 整块（只在 `state === 'idle'` 时渲染）。

### 🔴 设计稿里有、服务端没有出口的两格

`.ed-preflight` 的四格里，**磁盘剩余**与**模型源延迟** `/engine/status` 与 `/engine/runtime`
都不报（Rust 侧没有任何 `statvfs` / 延迟探测）。设计稿那两格是演示数据。

处理：**换掉问题，不编答案** —— 改成两枚**真实存在**的判据（下载器在位 / 清单可读），
数据取自 `modelDownload.runner` / `.manifest`，预检态（还没有下载记录）退到
`status.runtime`。理由：宁可换一个能答的问题，也不摆两个永远显示 `—` 的假检查项。
Rust 侧补探针后可以换回来（已登记为 G-01）。

---

## D-379 · 五段段名取设计稿短名，判据跟着改字面值（2026-10-24）

`ASSEMBLY_PHASES` 原来的段名是产品自造的长名（`运行环境装配` / `视觉模型装配` /
`LLM 翻译模型装配`）。设计稿 `.timeline-step strong` 是短名
（`环境准备 / 运行环境 / 视觉模型 / 翻译模型 / 就绪`）。

**改字面值，不改结论**：五段仍然逐字冻结、仍然按序、`ready` 仍然不是事件。
受影响的判据与反证锚点：

| 位置 | 改前 | 改后 |
|---|---|---|
| `e2e/settings-media-check.mjs` 的 `NOTREADY_TEXTS` | 长名 | 短名 |
| `e2e/service/notready-state-check.mjs` 的 `PHASE_TEXT` | 长名 | 短名 |
| 反证 M1 的锚点 | `text: '运行环境装配'` | `text: '运行环境'` |

### 🔴 一条差点被当成"该红"的假红

`NOTREADY.retry.byPhase` 原来钉的是 `failed && status?.phase === 'L2'` 这个**内联**写法。
本轮按工程纪律第 8 条（禁内联长链三元）改成具名变量 `const l2Failed = …`，
旧正则当场报红 —— 但那是**假红**（结论没变，只是写法变了）。

修法不是放宽：判据改成钉**语义**（`phase === 'L2'` 存在 + 两个动作真的分叉到
「重新下载模型」与「重启本地服务」）。同一轮里 `NOTREADY.stages.phaseDriven` 的
`status?.phase ?` 也误伤了 `status?.phase ?? '—'`（空值合并不是三元）⇒ 正则补 `(?!\?)`。

**教训**：判据钉"某一种写法"时，一次合法重构就会把它打成假红；钉**语义**才经得住重构。

---

## D-380 · 演示面板：只换状态机的输入，不造界面（2026-10-24）

任务书要求六种状态"禁止写死数据，必须与真实业务状态机绑定"。

做法分两层：

1. `src/stores/demo-override.ts`（zustand）：只存一个 `active: DemoState | null`。
2. `src/screens/manga/demo.ts`：把 `active` 翻译成**状态机输入** ——
   `ServiceStatus`（state / runtime.ready / items / sets / children / log）与
   `ModelDownloadView`（state / step / percent / assemblyPercent / tail）。
3. `App.tsx` 在**派生层**套上：`status = demoStatus(realStatus, active)`、
   `download = demoDownload(realDownload, active)`。屏层读到的仍是同一个 `ServiceStatus`，
   走的仍是同一条渲染路径 —— **判定与渲染一行都没改**。

### 六态 → 状态机取值的映射

| 演示态 | `state` | `runtime.ready` | `download.state` |
|---|---|---|---|
| 服务运行中 | `running` | true | 真实值 |
| 启动中 | `starting` | true | 真实值 |
| 服务未启动 | `stopped` | true | 真实值 |
| 服务异常 | `error` | true | 真实值 |
| 引擎未装配 | `running` | **false** | `idle` |
| 五段装配中 | `running` | **false** | `running` + `step='visual'` |

后两项的 `state` 是 `running` 不是巧合：D6 闸门只挡 ②/③、① 照常起 ——
真机上装配页正是挂在 `running` 下的（D-229）。演示夹具按真机口径造，否则"演示对了、真机不对"。

### 🔴 为什么只在 `import.meta.env.DEV` 下渲染

覆盖一旦落到真机上就是"界面说服务在跑、实际没跑"。`DemoPanel` 组件里第一行就是
`if (!import.meta.env.DEV) return null;` —— 生产构建里连节点都不存在（样式留着，
是为了开发态与设计稿一致）。

---

## D-381 · 引导页 CTA 改成"先看预检、再开始"（2026-10-24）

设计稿的首次装配路径是：「CTA 打开下载页**预检态** → 确认目录 / 磁盘 / 模型源后才创建下载任务」。

重写前 `NotReadyScreen` 的 CTA 是**直接** `start(false)` —— 用户一点就开始下 3.6 GB，
`.ed-preflight` 那一屏在真机上永远画不出来（实测：`download` 恒为 `idle` 时
`DownloadPane` 走的是"没有进行中的下载"空态）。

改法：

- `NotReadyScreen.beginDownload`：还没开始 ⇒ **只** `onOpenDownload()`；已中断 / 失败 ⇒ 续传并进下载页
  （再让用户确认一遍等于把同一件事问两次）。
- `DownloadPane`：`!download` 且**运行时确实缺件**（或预检态）时，用一份 `idle` 视图渲染完整下载页
  —— 预检四格、五段、环都能画出来。真正的 `start()` 落在下载页的「开始下载」上。

⚠️ 已知取舍：`downloadEntry === 'hidden'` 不再让整页退化成空态。理由同上 ——
首次装配时它本来就是 `hidden`，用它当判据等于把预检态挡在门外。

---

## D-382 · 真机取证：六态逐个点过，控制台只有一条既有 404（2026-10-24）

**只在浏览器里验是不够的**（D-374 的教训）：dev 没有 Rust 后端，所有 `invoke` 失败，
界面会退化成空态，"结构对不对"根本看不到。本轮全部取证都在
`npm run app`（`tauri dev`）+ WebView2 CDP（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`）下做。

### 取证结果（真机，窗口内实测 computed）

| 项 | 实测值 | 设计稿 |
|---|---|---|
| `.nr-card` | `880` 宽 / `r 26px` / `padding 24px` | 880 / r-xl(26) / 24 ✓ |
| `.nr-title` | `21.85px`（= 23 × 0.95，窗口 <1180 档）/ `700` / Swei Gothic | 23 / 700 ✓ |
| `.timeline-node` | `15×15`，done 时 `rgb(143,182,159)` = success | 15 / success ✓ |
| `.timeline-step` | 五段，`data-step` 1–5，段名逐字 | 五段 ✓ |
| `.ed-hero` | `980×255` / `r 26px` / `padding 22 26` / `grid 210px 686px` | 同 ✓ |
| `.ed-ring-wrap` | `170×170` | 170 ✓ |
| `.ed-preflight` | 四格齐（总下载 3.99 GB / 保存位置 / 下载器 / 模型清单） | 四格 ✓ |
| `.demo-fab` | `32` 高 / `r 999` / `9.5px` / `700` / `opacity .72` | 同 ✓ |
| `.demo-panel` | `348` 宽 / 左侧 1px 描边 | min(348) ✓ |

六态逐个点过（点演示面板的按钮 → 读回引导页）：

1. **服务运行中** → 正常投放屏（无未就绪卡）✓
2. **启动中** → `正在启动本地服务` / 胶囊`本地服务` / 第 5 段 `active` / 动作 `正在启动…` ✓
3. **服务未启动** → `本地翻译服务没有运行` / 第 5 段 `waiting` / 动作 `启动本地服务·服务设置·查看日志` ✓
4. **服务异常** → `本地服务异常退出` / 胶囊`需要处理` / 第 5 段 `failed` / 三格诊断
   `:5180·无响应 / :5181·已停止 / 2/3 存活` / 动作含「重新下载模型」✓
5. **引擎未装配** → `需要先装配本地引擎` / 胶囊`首次装配` / 第 1 段 done、2–5 waiting /
   两栏面板 + 三格体积（2.80 GB / 922 MB / 300 MB）✓
6. **五段装配中** → 同上，但第 3 段 `active`、动作 `视觉模型下载中` ✓

### 控制台

`Runtime.consoleAPICalled` + `Runtime.exceptionThrown` + `Log.entryAdded` 全开跑一轮：
**零 error / 零 warning / 零 exception**。唯一一条 `Log.entryAdded` 是
`GET /favicon.ico → 404`（仓库本来就没有 favicon，与本次改造无关）。
`window.__TAURI_INTERNALS__` 存在 ⇒ Tauri API 正常，没有"脱离浏览器环境"的报错。

---

## D-383 · 样式替换脚本差点删掉三整段样式（2026-10-24）

`manga.scss` 是单文件分片（3400+ 行），本轮要换掉其中**两段**（X-C3 引导页、引擎下载页）。

第一版脚本按「X-C3 起点 → 引擎下载页起点」切，把中间**所有东西**当成待替换区 ——
而中间还住着 `X-D1 漫画库` / `灯箱` / `对照页` / `X-B1 投放` 四段。删完当场被
`check:units` 的 `ZOOM.buttonFallback` / `ZOOM.fitToWindow` 报红
（`.lightbox-zoom-btn` / `.lightbox-stage` / `.pane-body` 三条规则不见了）。

**修法**：按「块起点 → 下一个块的起点」逐段切，并在写回前**断言保留段里仍然含有**
那五处锚点（`.lightbox-zoom-btn` / `.lightbox-stage` / `.pane-body` / `.drop-zone` / `.chapter-card`）。
锚点缺失就抛错，不写盘。

**教训**：整段替换大文件时，"保留段里必须还在的东西"要写成断言，不能靠人眼确认
（3400 行里少 2000 行，diff 看起来只是"改了很多"）。

---

## D-384 · 引导页按形态拆开：573 行 → 分派 136 行 + 六个专职文件（2026-10-24）

### 问题：一个组件里住了三种屏

`NotReadyScreen.tsx` 重写后 573 行，里面是**三套完全不同的版式**共用一个函数体：

| 形态 | 内容 | 当时在文件里的位置 |
|---|---|---|
| ① 在线精简页 | 一句摘要 + 一枚按钮 | 第 222–256 行，`if (source === 'online')` 早返回 |
| ② 装配流程页 | 五段时间线 + 两栏面板 + 缺件单 | 第 265–411 行，`if (runtimeUnready && rt)` 早返回 |
| ③ 服务状态页 | 动作分派 + meta 行 + 三格诊断 | 第 413–563 行，主体 |

外带 6 个文件级辅助函数（`lastLogLine` / `descOf` / `summaryOf` / `downloadLabelOf` /
`DownloadPill` / `StateChip`）与 1 个 `TITLE` 表。改一处文案要翻 500 行，
且三种形态**共用前四块 DOM**（插画 / 胶囊 / 标题 / 说明）却各写了一遍 —— 那四块一旦
漂移就是"同一张卡在三种状态下边距不同"。

### 做法：按"变的是谁"切

```
src/screens/manga/
├─ NotReadyScreen.tsx        136 行 —— 只做分派：算共用派生量 → 选形态 → 传 props
└─ notready/
   ├─ NotReadyCard.tsx       卡片外壳（.notready > .nr-wrap > .nr-card + 插画/胶囊/标题/说明）
   ├─ OnlineForm.tsx         形态①（在线精简页）
   ├─ AssemblyForm.tsx       形态②（装配流程页：时间线 + 两栏 + 缺件单）
   ├─ ServiceForm.tsx        形态③（服务状态页：动作分派 + meta + 诊断）
   ├─ chips.tsx              StateChip / DownloadPill（两枚状态徽标，判据同源）
   ├─ copy.ts                全部界面文案（标题/说明/摘要/按钮/现状行）
   └─ derive.ts              纯派生量（isRuntimeUnready / hasStartedDownload / sizeCellsOf …）
```

切分判据是**"变的是谁"**，不是"代码多少行"：

- **`NotReadyCard`** —— 三种形态共用的那四块。改卡片几何只需动一处。
- **`copy.ts`** —— 界面文案的唯一事实源。文案洁癖（任务书红线）靠它落地：
  改一个词不必翻 JSX，也不会出现"服务未启动"与"本地服务没有运行"两种叫法并存。
- **`derive.ts`** —— 有容易写错口径的判断（`isRuntimeUnready` 的"不看服务状态"、
  `isL2Failure` 的"L2 才给重新下载"）。它们从 JSX 里搬出来后可以单独被判据盯住。
- **三个 Form** —— 一个形态一个文件。改形态①不会碰到形态②③。

### 🔴 拆分的**代价**：判据语料会静默失效

这是本轮最需要记住的一条。有 **5 个检查脚本**按路径读这个文件：

| 脚本 | 读什么 |
|---|---|
| `service/notready-state-check.mjs` | G4–G14：文案、分支、时间线、缺件单 |
| `settings-media-check.mjs` | `NOTREADY.*`：五段文案、进度事实源、重试分派、CSS 类 |
| `service/progress-truth-check.mjs` | W4–W7：`lastLogLine` 的**行为**与调用点 |
| `service-autostart-check.mjs` | D1：`stopped` 给启动、其余给重启 |
| `units-structure-check.mjs` | ZOOM 组按目录拼接（天然覆盖，不用改） |

**只改代码不改脚本的后果不是报红，是静默失效**：
`includes('需要先装配本地引擎')` 在拆走之后恒假 ⇒ 判据永远红（噪声，会被人改成恒绿）；
或者 `readMaybe` 读不到文件返回空串 ⇒ 一批 `!/.../.test('')` 全部恒真（**假绿**）。

处置：**语料扩到整棵子树**（分派文件 + `notready/` 下所有 `.ts/.tsx`，逐文件剥注释再拼），
并给 `_check-registry.mjs` 的三个 `watch` 补 `src/screens/manga/notready/**`
—— 否则只改子树时这些检查会被 `--changed` 跳过（跳过 ≠ 通过）。

### 🔴 第二个代价：判据钉"写法"就会被拆死

拆形态顺带把几处内联写法改成了具名函数 / `if` 分派，于是一批**结论没变**的判据假红：

| 判据 | 原来钉的 | 改成钉语义 |
|---|---|---|
| G5 | `const runtimeUnready = …;` 这一行 | `isRuntimeUnready()` 真的实现了那三个条件 + 分派处调它 |
| G7 | `if (runtimeUnready && rt)` 的字面量 | 装配分支早返回 + 分派文件自身不画时间线 |
| D1 | `{state === 'stopped' ? (…)}` 的三元 | `stopped` 支含 onStart 且**不含** onRestart |
| `NOTREADY.retry.byPhase` | `failed && status?.phase === 'L2'` | `phase === 'L2'` 存在 + 两个动作真的分叉 |

连同反证锚点一共改了 **13 处**（5 处 settings + 5 处 notready + 1 处 autostart + 2 处路径常量）。
每一处都是**改判据的字面值 / 落点，不改结论** —— 与 D-379 记的教训同源。

### 取证

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | 干净 |
| `npm run check`（static 20 项） | **20/20**（连跑两次稳定） |
| `check:settings` | **184/184** + 反证 **146/146** |
| `notready-state` | **21/21** + 反证 **32/32** |
| `service-autostart` | **21/21** + 反证 **23/23** |
| `progress-truth` 的 W4–W7 | 6/6 绿（该脚本另两条 W2/W3 因本机解包 tar 权限失败，与本次改动无关） |
| `check:registry` | 15/15 |
| 真机六态 | 拆前拆后**逐字一致**（标题 / 说明 / 动作 / 五段 state / 三格诊断 / 两栏面板） |
| 真机控制台 | 仍只有一条既有 `favicon.ico` 404 |

⚠️ 拆后 `.timeline-node` 的 success 色实测为 `rgb(111,154,131)`（拆前是 `rgb(143,182,159)`）——
两者都是 `--miao-success` 在不同主题下的值（窗口主题变了），不是回归。

---

## D-385 · 日志块抽成通用单元：复制按钮是"悬停浮现 + 只有图标"（2026-10-24）

### 问题：同一件东西写了三套

| 位置 | 类名 | 底色 | 圆角 | 行高 | 最大高度 | 复制能力 |
|---|---|---|---|---|---|---|
| 引导页装配形态 | `.nr-log` | `--miao-ink` | r-xs | 1.8 | **94** | **无** |
| 引导页服务形态 | `.nr-log` | 同上 | 同上 | 同上 | 94 | **无** |
| 下载页 | `.ed-log` | `#23252a`（写死） | 9px | 1.8 | **220** | **无** |
| 设置页日志抽屉 | `.set-log-console` | 另一套 | — | — | — | 有（复制全部按钮） |

四处"深底等宽日志块"、三种底色、两种最大高度，而**能复制的只有设置页那一处** ——
用户在引导页看到失败原因想发给别人，只能手动框选。

### 做法：`components/units/LogBlock.tsx`

一个单元，两个高度档：

```tsx
<LogBlock
  variant="compact"        // 引导页（94 高）
  text={...}
  emptyText="（暂无日志）"
  onCopied={() => toastBus.push('日志已复制', 'good', '已复制全部可见行')}
  onCopyError={(e) => toastBus.push('复制失败', 'bad', errorText(e))}
/>
```

- 复制按钮**只有图标**（日志块很窄，塞"复制"两个字会把正文挤窄），
  语义走 `aria-label` + `title`，两者都是 `复制全部日志`；
- 复制成功 ⇒ 图标变 ✓ 并保持 1.4s；失败 ⇒ **不换图标**，由调用方给吐司说明原因
  （`navigator.clipboard` 在 WebView 里可能被拒，"静默成功"与"静默失败"长得一模一样）；
- 卸载时清定时器（否则"复制完立刻关掉弹层"会对着已卸载组件 setState）。

### 🔴 三条判据（`DIALOG.logBlockCopy`）

| 判据 | 挡住的退化 |
|---|---|
| 必须走 `Btn` 单元、不许裸 `<button>` | 工程纪律第 12 条被绕开 |
| `aria-label` + `title` 都在 | 图标-only 时读屏/悬停说不出它是什么 |
| `.log-block:hover` **与** `.log-block:focus-within` 都要浮现 | 只写 `:hover` ⇒ 键盘用户拿不到复制 |
| 三个调用点都 `<LogBlock>` 且不再手写旧类名 | "单元在、页面还写着老样子" |

分母写死 `checked >= 11`（只判"文件存在"是最容易变成空断言的一种写法 —— 删了组件它照样绿）。

两条反证各打一个方向：复制按钮退回裸 `<button>` ⇒ 红；摘掉 `:hover` 浮现 ⇒ 红。

### 取证

| 项 | 结果 |
|---|---|
| 真机 · 引导页（服务异常态，日志默认展开） | `.log-block.is-compact`、按钮 `24×24`、默认 `opacity 0 / pointer-events none`、**真实鼠标移入后** `opacity 1 / auto` |
| 真机 · 复制内容 | 拦截 `clipboard.writeText` 抓到写入值，与 `.log-body` **逐字节相等**（202 字符 / 4 行） |
| 真机 · 下载页 | `.log-block.is-tall`、`max-height 220px`、复制 89 字符 == 正文、旧 `.ed-log` 节点 **0 个** |
| `check:units` | **58/58** + 反证 **83/83**（新增 2 条变异各自按预期变红） |
| 其余门 | `npm run check` 20/20 · `check:settings` 184/184 · `notready-state` 21/21 · `engine-bootstrap` 23/23 · `download-entry` 7/7 · `tsc` 干净 |

---

## D-386 · 复制走宿主插件 `clipboard-manager`，且接缝由屏层注入（2026-10-25）

### 为什么不用 `navigator.clipboard`

`navigator.clipboard.writeText` 在 Tauri 的 WebView 里要求**安全上下文 + 用户手势**，
被拒时只抛一个 `DOMException`。在打包后的 `tauri://` 协议下它与开发态行为并不一致 ——
表现是"点了复制没反应，也不报错"。这正是本仓反复记过的那类**静默失败**。

改走宿主自己的能力：`@tauri-apps/plugin-clipboard-manager` 的 `writeText`。
它由 Rust 侧执行，与页面上下文无关，失败时是**可捕获的 IPC 错误**。

### 接线（四处，缺一不可）

| 位置 | 改动 |
|---|---|
| `package.json` | `@tauri-apps/plugin-clipboard-manager@^2.5.0` |
| `src-tauri/Cargo.toml` | `tauri-plugin-clipboard-manager = "2"` |
| `src-tauri/src/main.rs` | `.plugin(tauri_plugin_clipboard_manager::init())` |
| `src-tauri/capabilities/default.json` | `clipboard-manager:allow-write-text` + `allow-read-text` |

🔴 **权限不写就是"命令不存在"**：插件注册了但 capabilities 没放行，`invoke` 会被拒，
错误形态与"插件没注册"一模一样。两个都要。

🔴 `cargo add` 默认拉到 `2.1.0-beta.7`（预发布版），手工改回 `"2"` —— 与其余
`tauri-plugin-*` 的版本口径一致。

### 接缝在 `src/tools/clipboard.ts`

```ts
export async function copyText(text: string): Promise<void> {
  if (inTauri()) { await tauriWriteText(text); return; }        // 桌面：宿主插件
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  throw new Error('当前环境没有可用的剪贴板');                    // 绝不静默成功
}
```

留浏览器回退是为了 `npm run dev`（纯 Vite，无 Rust 宿主）与自动化探针。

### 🔴 `LogBlock` **不 import 它** —— 依赖方向被机器判据挡了一次

第一版直接在 `units/LogBlock.tsx` 里 `import { copyText } from '@tools/clipboard'`，
`check:units` 的 `PURITY.noBusinessImports` 当场报红：**`units/` 不许 import 业务层或工具层**。

这个判据是对的 —— 通用单元一旦依赖工具层，它就不再"与业务解耦"。
修法不是放宽判据，而是**反转依赖**：单元只声明"我需要一个
`(text) => Promise<void>`"，由屏层注入：

```tsx
<LogBlock … copy={copyText} />
```

缺省仍退回 `navigator.clipboard`（单元不因此多一条依赖）。
三个调用点（`AssemblyForm` / `ServiceForm` / `DownloadPanel`）各自注入。

### 判据同步（结论不变，多钉两条新事实）

`DIALOG.logBlockCopy` 从 11 项加到 **13** 项，新增：

- 复制必须**走注入的接缝**，且"接缝优先、浏览器回退"两条路都在；
- **三个调用点都必须注入 `copy={copyText}`** —— 只判"用了 `LogBlock`"会漏掉这一层，
  而漏掉的表现正是"按钮在、点了走回浏览器 API、打包后静默失败"。

### 取证（真机 `npm run app` + CDP）

| 项 | 结果 |
|---|---|
| 插件直连 | `writeText('miao-probe-clipboard')` → `readText()` **原样读回** |
| 界面复制 | 点日志块复制按钮 → `readText()` 读回 **202 字符，与 `.log-body` 逐字节相等** |
| 新会话重载后 | IPC 仍可用（同样用剪贴板往返证明） |
| 控制台 | 无 error / 无 exception；只剩 Tauri 自身的 `IPC custom protocol failed, will use postMessage` 提示（**功能正常**，是宿主在 dev 模式下的既有回退提示）与 `favicon.ico` 404 |
| 门 | `npm run check` 20/20 · `check:units` 58/58 + 反证 83/83 · `check:settings` 183/183 + 反证 146/146 · `notready-state` 21/21 + 反证 32/32 · `registry` 15/15 · `cargo check --bin miao-dock` 通过 |

⚠️ 新增依赖后 `gen:licenses` 必须重跑（`FEATURES.licenses.fresh` 当场报出
"npm 生产依赖 64 → 65、Cargo.lock 623 → 651"）。已重跑，清单更新。

---

## D-387 · 两处"看起来对、量起来不对"的几何与动效（2026-10-25）

两处都是**同一类缺陷**：数值都写出来了、界面也照常渲染，只是那个数值不是设计稿的。

### ① 进度环外径大了 18px

设计稿 `.ed-ring` 的写法是**画布 170×170 装 viewBox 160×160**：

```html
<svg class="ed-ring" viewBox="0 0 160 160">
  <circle r="68" stroke-width="7"/>
```

所以 `r` 与 `stroke-width` 的单位是 **viewBox 单位**，渲染时被放大 `170/160 = 1.0625`：

| 量 | 设计稿（换算到 px） | 改前（产品） |
|---|---|---|
| 半径 | `68 × 1.0625 = 72.25` | `(170-7)/2 = 81.50` |
| 线宽 | `7 × 1.0625 = 7.44` | `7.00` |
| **外径** | `2 × (72.25 + 7.44/2) = 151.94` | `2 × (81.5 + 3.5) = 170.00` |
| 周长（`stroke-dasharray`） | `2π × 68 = 427.26` | `2π × 81.5 = 512.08` |

产品的 `ProgressRing` 缺省半径是 `(size - stroke) / 2` —— **环贴满外框**，那对工具条里
18px 的小环是对的，对下载页那枚 170 的大环就大了 18px、而且贴着 `.ed-ring-wrap` 的边。

**修法**：给单元加可选 `radius`（缺省行为不变），下载页显式给 `radius={72.25}` /
`stroke={7.44}`。真机实测外径 **151.94**，与设计稿逐位相同。

> 为什么不在 CSS 里改：环是 SVG 的 `r`，不是盒模型尺寸 —— CSS 只能改 svg 的外框，
> 改不动圆本身的半径。这也正是"读 CSS 文本"这类判据抓不到它的原因。

### ② 蒙层淡入用了带位移的关键帧

设计稿 `.demo-mask` 是 `animation: fade-in var(--dur-fast)` —— **纯淡入**。
产品写的是 `miao-view-in`，那个关键帧带 `translateY(8px)`。
蒙层铺满全屏时那 8px 位移看不出来，但它确实不是设计稿的那个动画（`view-in` 是**内容区**进场的动画，蒙层不该跟内容一起上浮）。

改成 `miao-fade-in`（`manga.scss` 里已有的纯 opacity 关键帧）。

### ③ 环的过渡曲线不是令牌

设计稿 `.ed-ring-fill` 是 `transition: stroke-dashoffset .4s var(--ease-out)`。
产品写的是 `stroke-dashoffset 0.4s ease` —— `ease` 是浏览器默认曲线，不是设计稿的
`cubic-bezier(.16,1,.3,1)`。改成 `var(--miao-ease-out)`，真机实测计算值
`stroke-dashoffset 0.4s cubic-bezier(0.16, 1, 0.3, 1)`。

### 取证

| 项 | 结果 |
|---|---|
| 真机 · 环 | `viewBox 0 0 170 170`、`r=72.25`、`stroke=7.44`、**外径 151.94**、`.ed-ring-wrap` 170×170 |
| 真机 · 过渡 | `stroke-dashoffset 0.4s cubic-bezier(0.16, 1, 0.3, 1)` |
| 真机 · 蒙层 | `animation: miao-fade-in`（无 `translateY`） |
| 六态回归 | 逐态 `overflow` / `wrapOverflow` 全空 |
| 门 | `npm run check` 20/20 · `check:units` 58/58 · `check:settings` 184/184 · `tsc` 干净 |

---

## D-388 · 演示面板的层级与窄窗形态（2026-10-25）

### ① 演示抽屉被模态层压住

设计稿的 z 阶梯里 **`--z-demo: 95` 高于 `--z-modal: 70`** —— 演示面板的用途正是
"在任何界面状态下切状态"，被弹窗压住就等于失效。

产品的模态层是 **95**（`components.scss` 的 z 阶梯：队列抽屉 71/72 · Select 75 ·
右键菜单 78 · 歌词设置/登录 80 · 轻提示 90 · 模态 95）。而演示抽屉写的是 **78** ——
比模态低 17 档。表现是：弹窗开着时点演示胶囊，面板在**下面**渲染，既看不见也点不到。

修法：演示抽屉取 **96**（比产品模态高一档）。真机实测 `drawerZ=96 / modalZ=95 /
drawerAboveModal=true`，`elementFromPoint` 命中 `HEADER.demo-head` ⇒ 面板真的在最上层。

> 为什么不照抄设计稿的 95：设计稿的模态是 70，95 在那里是"高于模态"。
> 产品的模态已经占用了 95，照抄会让两者**同层**（同 z 时后者胜，结果取决于 DOM 顺序 ——
> 那是最难查的一类"有时行有时不行"）。取 96 保住的是**关系**（高于模态），不是那个数字。

### ② 窄窗胶囊没有收成纯图标

设计稿 `@media (max-width: 680px)` 里 `.demo-fab` 收成 `32×32`、`padding: 0`、
`span { display: none }` —— 小窗里它不该再占"演示"两个字的宽度。产品此前只有固定尺寸。

已补该断点。真机（CDP 视口 660）实测：`width 32px / padding 0 / justify center /
span display none`。

### 取证

| 项 | 结果 |
|---|---|
| 层级 | `drawerZ 96 > modalZ 95`，`elementFromPoint` 命中抽屉内元素 |
| 蒙层动画 | `miao-fade-in`（上一轮 D-387 改的纯淡入） |
| 面板进场 | `ui-drawer-in`（设计稿 `drawer-in var(--dur-base) var(--ease-out)`） |
| 面板宽 | 348（设计稿 `min(348, 100vw)`） |
| 窄窗 | 660 视口下 `32×32` 纯图标 |
| 门 | `npm run check` 20/20 · `check:settings` 184/184 · `check:units` 58/58 · `notready-state` 21/21 |

---

## D-389 · 「重新检测」是假交互，且它背后藏着一个 94 秒的后端阻塞（2026-10-25）

### ① 按钮是假的

`DownloadPanel` 的「重新检测」原来是：

```ts
setTimeout(() => { /* 读的还是进页面时那份 view.runnerExists */ }, 600);
```

**一次网络都不发**。用户点完只得到一句吐司"刚检测过了"，页面上四个格子的值一动不动。

改成真打 `GET /engine/status`，把返回的 `runtime` 重算四格并**写回页面**（`setProbe`），
失败如实报错。

> 为什么要单独存一份 `probe` 而不是改 props：props 是壳层轮询给的快照，本页不能改它；
> 但"我刚探测到的结果"必须能显示出来，否则这个按钮等于没做。

### ② 一改就暴露出后端 94 秒的阻塞

接上真调用之后，按钮卡在「检测中」再也不回来。逐层量下来：

| 调用 | 耗时 |
|---|---|
| `invoke('api_get', { path: '/engine/runtime' })` ×3 | **94068 ms / 67 ms / 7 ms** |
| `invoke('api_get', { path: '/engine/status' })` | 首次 **180 s 超时**，修复后 **837 ms** |

首次 94 秒、之后 67 ms —— 典型的**冷缓存下走完一棵大树**。

根因在 `state.rs::can_resume_now()`：

```rust
fn can_resume_now(&self) -> bool {
    has_part_files(&self.model_root) || has_part_files(&paths::runtimes_dir())
}
```

`has_part_files` 是**全树递归**，而它被 `model_download_view()` 在**每一个**
`/engine/status` 响应里调用（`canResume` 字段）。那两个根是 **15 GB 级、上万文件**的
模型树与 venv —— 冷缓存下走一遍就是一分半。用户看到的是"页面卡死"。

### 修法：只扫 `.part` 可能在的那几层

`.part` 是下载器的中间产物，只会落在**归档落点**（`.download-cache/`）与**模型落点**
（清单 `dest` 形如 `visual/x.bin`，一层），不会散落在 venv 的上万个 `.py` 里。
所以把递归改成"限定深度"：

```rust
const MAX_PART_DEPTH: u32 = 2;   // 0 = 只扫 root 本身；留一层余量
fn has_part_files(root: &Path) -> bool { walk_parts(root, 0, MAX_PART_DEPTH, false) }
```

🔴 **这不是把判据改松**：仍然只看文件名后缀 `.part`，只是不再往模型文件内部、
`site-packages` 里钻。`clear_part_files`（「重新下载」清断点）走同一个深度限制，
两边口径一致。

实测：`94068 ms → 720 ms`（130 倍），`/engine/status` 180 s 超时 → **837 ms**，
「重新检测」**1.2 秒内回到「重新检测」**（此前永久卡在「检测中」）。

---

## D-390 · 下载页根本滚不动：滚动容器与居中盒被合成一个（2026-10-25）

`.content` 刻意 `overflow: hidden`，把滚动权交回每一屏（见 `app.scss` 的注释）。
其他屏都给了自己一个满高滚动区（`.notready` / `.drop-scroll` / `.settings-main` …），
唯独下载页写的是：

```css
.engine-download-page { max-width: 980px; margin: 0 auto; }
```

它既没有高度约束（撑不出滚动区），又会被 `.content` 裁掉溢出 ⇒ **内容超一屏就滚不动**。
而且 `max-width` + `margin: auto` 让"滚动条"与"内容盒"是同一个元素 ——
一旦补上 `overflow`，滚动条会出现在 980 的盒子里，而不是窗口右缘。

改法与 `.notready` 完全同构（项目既有逻辑）：

```css
.engine-download-page { height: 100%; overflow-y: auto; padding: 4px 0 28px; }  /* 滚动容器 */
.ed-wrap { max-width: 980px; margin: 0 auto; }                                  /* 居中盒 */
```

JSX 里补一层 `<div className="ed-wrap">` 包住页头与 `.ed-scroll`。

真机实测：`overflow-y: auto`、`scrollH 789 > clientH 678`、`maxScroll 111`，
滚到底后 `.ed-detail`（最后一块）**可见**（`detailTop 657 < pageBottom 762`）。

---

## D-391 · 引导页的「查看完整诊断」落错了分组（2026-10-25）

引导页三处入口（「查看完整诊断 / 服务设置」）都调 `setScreen('settings')` —— 那只改路径、
**不带 query**，设置页于是按 `parseSection(null)` 回落到「① 通用」。

而引擎诊断住在「② 翻译链路」组里。真机实测（CDP）：

```
点击前：引导页（引擎未装配态）
点击后：hash "#/settings?section=general"，左栏高亮「通用」，hasDiag: false
```

用户被丢在错误的页面上，还得自己再去左栏找一次 —— 而这正是"指引入口"要避免的事。

**修法**：`useNav` 加 `setScreenSection(screen, section)`，把分组写进 **hash**
（`#/settings?section=x`；HashRouter 下写到 search 会变成 `?section=x#/settings`，刷新后读不到）。
引导页入口改走它，落到 `translate`。

修后实测：`hash "#/settings?section=translate"`，左栏高亮「翻译服务」，
该组内确实有「运行状态 / 诊断详情」。

> 为什么不直接改 `setScreen` 的签名：它是侧栏 / 视图 Tab 共用的既有入口，
> 加参数会波及全仓；新增一个具名入口的代价小得多，且语义更清楚（"带分组去设置页"）。

---

## D-392 · 侧栏下载入口缺 `data-state`，三态在视觉上是同一个灰（2026-10-25）

设计稿的下载入口（`#downloadEntry`，在设置之上）是三态一体的：

```js
btn.dataset.state = state;                       // running / paused / done / hidden
btn.querySelector('.nav-dl-spin').style.display = state === 'running' ? 'block' : 'none';
```

```css
.nav-download[data-state="done"]   { color: var(--success); }
.nav-download[data-state="paused"] { color: var(--warning); }
```

产品把三态全塞进了 `DOWNLOAD_META`（**图标换了、颜色没换**），于是"下载中"与"下载断了"
在侧栏里是同一个灰 —— 而设计稿正是靠颜色区分的。

**修法**：

- 按钮补 `data-state={downloadEntry}`；
- CSS 补三态着色，并把转圈收成**只在 running** 出现
  （断了 / 好了还转圈，读起来像"它还在动"）。

真机实测（等过渡 140ms 走完再读）：

| `data-state` | color | 转圈 |
|---|---|---|
| `running` | `rgb(126,141,152)`（muted，默认） | `flex` |
| `paused` | `rgb(190,138,87)` = `--miao-warning` | `none` |
| `done` | `rgb(111,154,131)` = `--miao-success` | `none` |

位置与可见性沿用既有口径（在设置之上、`hidden` 时不渲染），`check:ia` 的 C8f 与
`check:engine-download-entry` 的 E2 都仍是绿的。

> ⚠️ 取证教训：`getComputedStyle` 读到的是**过渡中间值**。第一次在同一个 tick 里
> 改属性 + 读颜色，读到的是旧值（三态全是灰）—— 差点误判成"规则没生效"。
> 正确做法是等过渡时长（`.nav-item` 的 `color` 过渡是 140ms）之后再读。

---

## D-393 · `?section=` 会泄漏到别的屏的地址栏（2026-10-25）

真机复现（CDP）：

```
1 起始      #/translate/drop
2 进设置    #/settings?section=translate
3 回翻译    #/translate/drop?section=general   ← 缺陷
4 去音乐    #/music                            ← 又好了
```

`SettingsScreen` 里那个"切分组写回地址栏"的 effect 只依赖 `[section]` ——
它**不知道自己在不在设置页**。组件卸载前若 `section` 又变了一次
（深链同步 / 左栏点击的收尾），`replaceState` 就把 `section` 拼到**当时**的 hash 上，
而那可能已经是翻译屏。

**修法**：写回前先判路径。

```ts
const [hashPath, hashQuery = ''] = url.hash.replace(/^#/, '').split('?');
if (hashPath !== '/settings') return;   // ← 这一行
```

不引 react-router（本文件本来就没用它，`readSectionParam` 也是直接读 `location`）。

修后实测：回翻译屏是干净的 `#/translate/drop`；设置页内部切分组仍正常写回
（`#/settings?section=media`），**刷新后保持**，左栏高亮一致。

---

## D-394 · 引导页 8 个按钮逐个点过：全部有效（2026-10-25）

判据不是"按钮存在"，而是**点了以后系统状态或界面真的变了**。每个动作单独复位后逐一点击：

| 状态 | 按钮 | 可观测结果 |
|---|---|---|
| 服务未启动 | 启动本地服务 | 吐司「正在启动本地服务…」 |
| 服务未启动 | 服务设置 | 跳到 `#/settings?section=translate` |
| 服务未启动 | 查看日志 | 日志块出现 |
| 服务异常 | 重启本地服务 | 吐司「正在重启本地服务…」 |
| 服务异常 | 重新下载模型 | 吐司「已开始重新下载模型…」（**真打 `/engine/models/download`**） |
| 服务异常 | 服务设置 | 跳到 `#/settings?section=translate` |
| 引擎未装配 | 查看完整诊断 | 跳到 `#/settings?section=translate` |
| 引擎未装配 | 查看日志 | 日志块出现 |

侧栏下载入口也单独验过：点它 ⇒ `#/engine-download` + 下载页渲染 +
**侧栏仍高亮「漫画翻译」**（覆盖层不换屏，符合 IA 设计）。

> 这一轮之所以要逐个点，是因为前几轮只验了"结构对、六态能切"，**没验过按钮点下去有没有用**。
> 「重新检测」就是那样被查出是假交互的（D-389）。

---

## D-395 · 进度环的三个真缺陷：动画没接线、起点会被抢、overflow 被削（2026-10-25）

用户要求「根据进度把环的一部分高亮」。逐项量真机，发现**三处**与设计稿不符，
其中第一处让"高亮"这个概念本身有一半是假的。

### ① `.ui-ring-spin` 从未被应用 —— 旋转动画压根没跑过

组件注入的样式是：

```css
@keyframes ui-ring-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ui-ring-spin { animation: none !important; } }
```

只有 `@keyframes` 与"如何关掉它"，**从来没有 `animation` 属性**。
真机实测 `animationName: "none"` / `animationDuration: "0s"` ⇒ 关键帧是死代码。
于是"不确定态"只剩一圈静止的 25% 弧 —— 与设计稿"看得见在动"正好相反。

补 `.ui-ring-spin { animation: ui-ring-spin 1.2s linear infinite; }`（周期与侧栏
下载入口的 `.nav-dl-spin` 同值）。修后实测：`animationName: ui-ring-spin`、
`1.2s / linear / infinite`，150ms 转过 **44.2°**（理论 45°，1.2s 周期）。

> ⚠️ 写这条时踩了一个坑：说明文字用反引号包了 `@keyframes`，而它位于 **模板字符串内部**
> ⇒ 提前闭合，直接炸 TS1005 / TS1146。说明必须留在模板字符串外面。

### ② 起点 -90° 会被 CSS 动画覆盖（这正是①的连带风险）

原来 `-90°` 写在 circle 的 SVG `transform` **属性**上。而不确定态的旋转是 **CSS transform**
（`.ui-ring-spin` 的 `to { rotate(360deg) }`）—— CSS transform 会**覆盖** SVG 的 transform 属性，
起点从 12 点跳回 3 点。两处争同一个属性，属于"改对一处、坏另一处"的典型。

改法照设计稿：`-90°` 挪到 **svg 整体**（`.ed-ring { transform: rotate(-90deg) }`），
circle 上不再写 transform 属性。实测 `svgTransform: matrix(0,-1,1,0,0,0)`（= -90°）、
`circleHasTransformAttr: false`，旋转时 `svgStartKept: true`。

### ③ `overflow: hidden` 会把 `linecap: round` 的端点削平

设计稿 `.ed-ring` 是 `overflow: visible`；产品没写（SVG 的 UA 默认是 hidden）。
补上，与设计稿一致。

### 高亮弧本身是对的（这条是"已验证"，不是修复）

`stroke-dasharray = 2πr`、`stroke-dashoffset = 2πr × (1 - pct/100)`，
实测 0/25/50/75/100 → 弧长占比 **0/25/50/75/100%**，线性精确。
环几何也复核过：`r=72.25` / `stroke=7.44` / 外径 **151.94**（设计稿 170 画布装 160 viewBox 换算值），
svg 与环心 `dx=0 / dy=0` 同心。

静止态（`spinning: false`）动画不开、角度恒定 —— 这是对的，不是缺陷。

### 取证

| 项 | 结果 |
|---|---|
| 动画绑定 | `ui-ring-spin / 1.2s / linear / infinite` |
| 旋转实测 | 150ms → 44.2°（理论 45°） |
| 起点 | `svgTransform = matrix(0,-1,1,0,0,0)`，circle 无 transform 属性 |
| overflow | `visible`（同设计稿） |
| 弧长映射 | 0/25/50/75/100 → 0/25/50/75/100% |
| 几何 | r 72.25 · stroke 7.44 · 外径 151.94 · 同心 dx/dy = 0 |
| 六态回归 | 6/6，overflow/wrap 全 0，console 无 error |
| 门 | `npm run check` 20/20 · `check:notready-state` 21/21 + 反证 32/32 · `check:units` 58/58 · `check:settings` 184/184 |

### 连带修掉的陈断言

G10 钉的是 `onOpenGuide={() => setScreen('settings')}`，而 D-391 已把入口改成
`setScreenSection('settings', 'translate')` ⇒ 恒红。判据跟到新写法，并把
「落到 translate 分组」一并钉住（比改回旧写法更严）。

---

## D-396 · 下载页完全不认 `error` 态：失败被显示成「等待开始 + 暂停下载」（2026-10-25）

真机实测（CDP，真实触发一次失败）：

```
后端 { state: "error", exitCode: 1, canResume: false, tail: [✗ …解包失败（exit code: 1）…] }
界面 { chip: "等待开始", title: "正在装配本地引擎", buttons: ["暂停下载", "后台运行", "查看日志"] }
```

**后端说失败了，界面说在等着开始，还给人一个「暂停下载」。**

### 根因：类型联合漏了 `error`

`engine-api.ts` 的 `ModelDownloadView.state` 写的是
`'idle' | 'running' | 'interrupted' | 'done' | 'failed'` ——
而 Rust 侧 `state.rs:1116` **确实会写** `d.state = "error"`
（非零退出且盘上无 `.part` ⇒ 不可续传的失败，如解包失败 / 归档损坏）。

前端没有这个分支 ⇒ 落进"既不是 idle 也不是 done 也不是 interrupted"的兜底，
于是 `chip` / `title` / 按钮全都按 idle 渲染。

🔴 **为什么 TS 没报**：`interrupted` 那行是布尔拼接
（`view.state === 'interrupted' || view.state === 'failed'`），类型上完全合法。
只有 `EngineDiag` 的 `Record<ModelDownloadView['state'], string>` 是穷尽映射，
`tsc` 逼到那一处 —— 而**真正渲染错的那一处不报**。这正是"类型能挡的错很有限"的实例。

### 修法

1. 类型补 `'error'`；
2. `DownloadPanel` 把异常态拆成三个，因为**用户该做的事不同**：
   - `interrupted`（有 `.part`）⇒ 可续传 ⇒「继续下载」；
   - `failed` / `error`（无 `.part`）⇒ 只能从头下 ⇒「重新下载」（`fresh=true`）；
3. `EngineDiag` 的文案表补 `error: '失败（不可续传）'`，警示色一并覆盖；
4. `heroDescOf` 的回退加一级：`interruptedReason` → **tail 末行** → 通用文案。
   🔴 真机实测 Rust 写 `error` 时**不填 reason**，而末行日志写着
   `✗ [ENGINE_BOOTSTRAP_FAILED] [extract] 解包失败（exit code: 1）：…`。
   少了中间那一级，用户只看到"可以继续下载"，完全不知道卡在哪。

### 修后实测

```
chip: 下载中断 · title: 本地引擎装配中断 · 环色 rgb(201,125,115)（error 红）
heroTitle: 下载中断 · 已完成的部分会保留
heroDesc : ✗ [ENGINE_BOOTSTRAP_FAILED] [extract] 解包失败（exit code: 1）：C:\…\python-3.11.17-….tar.gz
按钮     : 重新下载 · 后台运行 · 查看日志
```

### 本机那个失败本身不是代码缺陷

顺着查了一层：归档能 `tar -tzf` 列出 3969 条、单文件也能解出（124544 bytes），
`tar -xf <arc> -C python-3.11 --strip-components=1` 手工跑成功，
且 `venv/` 与 `python-3.11/` **早已完整在位** ⇒ 那是历史一次解包撞上文件被占用
（本机安全垫 / 上一次 venv 创建的残留句柄），重跑即可续做。
产品侧的真实问题是**把这个失败显示成了"等待开始"**，已修。

---

## D-397 · 暂停后日志还在刷：`child.kill()` 刹不住已缓冲的管道（2026-10-25）

用户报：暂停下载后日志块还在滚 `Using cached …`，"刷着刷着就停止了"。

### 取证（先证明不是前端）

| 检查 | 结果 |
|---|---|
| `engine-download.json` mtime | 3s / 6s 复读**完全不变**（停在暂停那一刻） |
| `tail` 长度 | 恒定 **40** |
| `tail` 末行 | 恒为同一条 `Using cached …deepl…` |

盘上是静止的 ⇒ **后端没在写**。但界面内容在变 ⇒ 变的是**内存里的 tail**。

### 根因

`spawn_tail_reader` 是个只认 EOF 的循环：

```rust
loop {
    let n = match r.read(&mut buf) { Ok(0) => break, Ok(n) => n, Err(_) => break };
    … d.tail.push(t);            // ← 只 push，不检查 state、不落盘
}
```

`pause_download()` 调 `child.kill()` 只让**后续**输出消失，管道里**已缓冲**的数据
仍然可读。于是读取线程把缓冲全读完并继续 push 进内存 tail ——
而那些 push **不落盘**（`persist()` 只在状态跃迁时调）。

⇒ 界面（读内存）看到日志在长，盘上文件一动不动。"刷着刷着就停止"就是缓冲被读完的那一刻。

### 修法

给 `EngineState` 加 `download_stop: Arc<AtomicBool>`：

- `spawn_tail_reader` 每轮 `read()` **之前**先看闸，合闸即 `return`（剩余缓冲留给下一次下载重头写）；
- `pause_download()` 在 `kill()` + `wait()` **之后**合闸 ——
  早合会弄丢最后几行真实日志，晚合则缓冲已被读走；
- `spawn_download_round` 开新一轮时先把闸打开（否则上一轮合上的闸会让新下载一行日志都不出）；
- 第 2 轮由终态线程递归启动，故把同一个 `Arc` clone 进去（`stop_wait`）。

### 连带修掉的两条

- `pause_download()` 补 `d.current_id = None` —— 与 `speed_bps` / `eta_ms` 同等对待。
  不清它时壳层 1.5s 轮询反复拿到同一个旧值，界面上"当前文件"那行看起来还在动。
- `.ed-detail-current` 固定**两行截断**（`-webkit-line-clamp: 2`）。
  不补 `title` / Tooltip —— 全名去日志块看，那里本来就能全文复制
  （用户 2026-10-25：tooltip 内容一多很丑）。

### 🔴 同一个 bug 有第二处：进度读取线程

`spawn_progress_reader` 读的是 JSONL **文件**（每 200ms 轮询），子进程被杀后文件停止增长，
它会因 `len == offset` 自然空转 —— 看起来无害。但第 1514/1516 行对
`d.current_id` / `d.speed_bps` 是**无条件覆写**：

```rust
} else {
    d.current_id = Some(e.id.clone());     // ← 无条件
    d.speed_bps = speed;                    // ← 无条件
    d.eta_ms = eta;
}
```

所以"暂停后读到一条残留事件"就会把 `pause_download()` 刚清掉的字段**写回去**。
只给 tail reader 加闸、漏掉它，暂停态仍会被污染 —— 这类"修了一半"最难发现。

⇒ 两个 reader 共用同一个 `stop` 闸，`pause_download()` 一次合闸同时刹住。

### 门

`npm run check` **20/20** · `check:engine-bootstrap` **23/23** + 反证 **45/45** ·
`check:settings` **184/184** · `tsc` / `eslint` 干净 · `cargo build --bin mangasvc` 通过。

⚠️ **未做真机复验**：本机下载卡在 venv 失效（见 G-03），跑不到"暂停"那一步。
改的是 Rust 侧，下次真机跑通下载时需回归这一条。

---

## G-03 · 本机装配卡住：venv 是旧路径建的，已失效（2026-10-25）

用户日志：`No Python at 'C:\Users\Doro\AppData\Local\runtimes\manga-translator\python-3.11\python.exe'`
⇒ `✗ [ENGINE_BOOTSTRAP_FAILED] [deps] 批 A 安装失败（exit code: 103）`

### 根因

`venv/pyvenv.cfg` 里三行全指向**旧布局**：

```ini
home = C:\Users\Doro\AppData\Local\runtimes\manga-translator\python-3.11
executable = …\runtimes\manga-translator\python-3.11\python.exe
command = …\python-3.11\python.exe -m venv …\venv
```

而该目录**不存在**。产品当前默认落点（`mangasvc --print-paths` 实测）是
`<LOCALAPPDATA>\MiaoDock\manga\runtimes\manga-translator` —— D-241 改过布局，
且代码注释明确写了「**旧落点不做自动迁移**」。

于是：今天新解包的 `python-3.11/`（在新布局）+ 10/19 建的 `venv/`（记着旧路径）⇒ 对不上。

### 代码缺口

`runtime_setup.rs` 第 290 行只判 `if !venv_py.exists()` ——
**文件在**就跳过重建，判不出"venv 在但它的母解释器已失效"。

### 解决办法（不用改代码）

关掉应用后把失效的 venv 改名，让产品用新布局的 python 重建：

```powershell
$rt = "$env:LOCALAPPDATA\MiaoDock\manga\runtimes\manga-translator"
Rename-Item "$rt\venv" "venv.bak"
```

**只动 `venv`**，别删 `python-3.11/` 和 `src/`（删了要重下约 100 MB）。

---

## G-02 · 待查：「重新下载」清理解包目标**未在真机验证通过**（2026-10-25）

用户提出：点「重新下载」后仍然报同样的错，应该直接把原来目录清空再下载。

### 已改（未验证生效）

- `state.rs::start_model_download` 的 `fresh` 分支：除了既有的 `clear_part_files`，
  新增清空**清单里所有适用于当前平台且带 `extractTo` 的条目的解包目标**
  （`python-3.11/` / `src/` …）。只清解包目标，不清整个 runtime_root——
  那下面还有 `.download-cache`（48 MB 归档）与用户模型权重。
- `DownloadPanel` 二次确认弹窗文案同步：「会清掉已下载的续传断点与已解包的目录」+
  「已下好的归档缓存与模型权重会保留，不需要重新下载」。

### 为什么标记为待查而不是已修

真机取证**没能证明清理生效**，且过程里踩到两个会误导自己的坑：

1. **`cargo build` 假编译**：连续多次报 `Finished 0.35s` 而二进制时间戳不变。
   清掉 `target/debug/.fingerprint/miao-dock-*` 后才真编译（8s）。
   ⇒ 一段时间内验的都不是新代码。**下次改 Rust 侧，先用二进制时间戳确认真的编进去了。**
2. **`mangasvc` 的 `eprintln!` 不进 app 日志**：它的 stderr 被父进程 `Stdio::piped()` 收走，
   而 app 日志里只有转发过来的 `[manga-service]` 前缀行。
   后来改成**写文件探针**才拿到证据（`fresh=true` 确实到达 handler、也确实进了 `fresh` 分支）。

文件探针结论：`fresh=true` 到达 `models_download`，`if fresh` 分支也进了。
但文件系统上 `src/`（534 文件）与手工造的 `test.part` 仍在 ⇒ 清理未生效。
`python-3.11/` 不见是**人工 `Remove-Item` 删的**，不是产品干的（曾据此误判为"已修好"）。

### 下一步（最小步骤，别再猜）

打印 `self.model_root` 与 `paths::runtimes_dir()` 在**运行中的 mangasvc 进程**里解析出的
实际值，与 PowerShell 检查的路径对比。怀疑点是 `MIAO_MODEL_ROOT` 环境变量
让两者不是同一个目录 —— 但**没有证据**，先量再改。

---

## G-01 · 待裁定：下载前检查的「磁盘剩余」与「模型源延迟」

设计稿 `.ed-preflight` 的第三、四格是这两项，服务端**没有出口**
（`/engine/status` 与 `/engine/runtime` 都不报）。本轮换成「下载器在位 / 清单可读」两枚真实判据。

要换回设计稿那两格，需要 `mangasvc` 新增：

- 磁盘剩余：`runtime` 根目录所在卷的可用字节（Windows `GetDiskFreeSpaceExW`、Unix `statvfs`）；
- 模型源延迟：清单里第一条可下载 URL 的一次 HEAD 往返耗时（要缓存，不能每次进页面都打）。

两样都要注意"离线机器"的表现：探测失败时应显示「未检测」而不是 0。
