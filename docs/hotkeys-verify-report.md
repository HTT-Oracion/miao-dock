# 音乐快捷键 —— 测试验收报告（独立复核）

- **被测对象**：`src/hooks/useMusicHotkeys.ts`（新增，245 行）+ `src/components/MusicKernel.tsx`（挂载调用）
- **基线**：`8337a4b`，工作区未 commit（按纪律交给负责人）
- **本轮改动**：只加断言（`e2e/music-platform-check.mjs` 新增 `KEYS` 组 9 条 + 9 条反证）+ 同步 `AGENTS.md` / `README.md` 条数。**未改任何实现**
- **独立复核结论**：**实现正确**，9 条规格全部落地且行为符合预期。发现 **3 个⚠️ 问题**（1 个真实缺陷 + 2 个体验/一致性风险），均**只报告未改**，见 §3

---

## 1. 断言清单（9 条，每条附反证方式）

新增分组 `KEYS`，位于 `e2e/music-platform-check.mjs:2836-3030`。
**所有判据一律先 `stripComments`** —— hook 的注释里主动写出了被判的写法
（`preventDefault` 在去抖之前的说明、`Record<string, number>`、`contenteditable="false"`），
不剥注释会恒绿。

| # | 断言 id | 判据要点（钉在哪） | 反证（破坏什么 → 变红） |
|---|---|---|---|
| 1 | `KEYS.mountedInKernel` | `MusicKernel.tsx` 里`^\s*useMusicHotkeys\(\);\s*$` **且出现恰 1 次**（重复调用 = 监听器重复注册）；`MusicScreen.tsx` 里**不得**出现 | 删掉 `useMusicHotkeys();` 那一行 |
| 2 | `KEYS.fiveKeyMapping` | 逐 **case 块**判：`togglePlay` 在 `' '` 块、`prev` 在 `ArrowLeft` 块、`next` 在 `ArrowRight` 块；`stepVolume` 按**实参**判（`0.05` / `-0.05`），且全文 `s.stepVolume(` **恰 2 次** | 把 `0.05` 改成 `0.5` |
| 3 | `KEYS.yieldSelectors` | 限定在 `INTERACTIVE_SELECTOR` 数组体内，逐条要**带引号的精确条目**（`'input'` / `'textarea'` / `'select'` / `'button'`），contenteditable 必须含 `:not([contenteditable="false"])` | 删掉 `'textarea',` |
| 4 | `KEYS.usesClosest` | `shouldYieldToNative` 体内必须有 `.closest(` **且**结果与 `null` 比较（判了不用于判断 = 等于没判） | 把 `closest(...)!==null` 换成 `['INPUT',...].includes(target.tagName)` |
| 5 | `KEYS.preventDefaultBeforeDebounce` | 逐 case 块比**下标**：`preventDefault` 位置必须早于 `trackSwitchBlocked(`；另判` 空格/↑/↓ 各自块内也有；全文 `e.preventDefault()` **恰 5 次** | 把 `⌘+←` 的两行**对调**顺序 |
| 6 | `KEYS.metaCtrlEquivalent` | 必须有 `const mod = e.metaKey \|\| e.ctrlKey;`；反向禁`navigator.platform` / `userAgent` / `isMac` / `isWindows`；`mod` 必须真被两个方向键用上 | 改成 `const mod = e.metaKey;` |
| 7 | `KEYS.bareArrowsIgnored` | 逐 case 块：守卫须是 `if (!mod …` 且**以 `return` 收尾**（只判不退出 = 裸键仍被处理），且位置早于 `prev()`/`next()` | 删掉 `ArrowLeft` 的 `if (!mod \|\| e.altKey) return;` |
| 8 | `KEYS.debounceTrackSwitchOnly` | 音量两个 case 块内**不得**出现 `trackSwitchBlocked(`，且**必须**真调 `stepVolume`（否则"不去抖"会退化成"不处理"）；切歌两个 case 必须**确实**在去抖；全文调用点**恰 2 次** | 给 `s.stepVolume(0.05);` 前插入 `if (trackSwitchBlocked('vol')) return;` |
| 9 | `KEYS.debouncePerKey` | 必须 `useRef<Record<string, number>>`；`trackSwitchBlocked` 体内 `lastAt.current[` **带下标**读写；两个切歌键传入的 key 名**互不相同**且**恰 2 个**调用点 | 把 ref 改成 `useRef<number>(0)` |

### 写断言时踩到并修掉的两个自身缺陷（留痕）

1. **第一版 `KEYS.debounceTrackSwitchOnly` 把调用点期望值写成 3**（以为要算上函数定义）。
   实际定义处写的是 `trackSwitchBlocked =`（不带左括号），`trackSwitchBlocked(` 只数到调用点。
   已改为 2，并把这条口径写进注释 —— 否则锚点口径漂移会变成"静默降级"。
2. **`KEYS.debouncePerKey` 第一版有两行一模一样的 `if (!/lastAt\.current\[/)`**（复制粘贴），
   第二行是死代码。已合并为一条。
   另一个更隐蔽的坑：最初用 `fnBodyAny` 取 `trackSwitchBlocked` 的函数体**恒返空**
   （`fnBodyAny` 只认 `function name(`，而它是 `const x = (…) => {…}` 箭头 const），
   判据会退化成"什么都没找到"而恒红。新增了 `arrowConstBody()` 专门按箭头 const 取体。

### 反证结果

`npm run task -- check:music:refute` → **REFUTE: 162/162 按预期变红**（应执行162，**0 跳过、0 假阳性**），
`useMusicHotkeys.ts` 与 `MusicKernel.tsx` 等 31 个文件**字节全部恢复一致**。
9 条新反证逐条单独确认变红（不是靠"总数对了"蒙混）。

> ⚠️ 过程中我自己第一版行为验证器有 9 条一度变红，**原因全在验证器**：
> ① 桩件的选择器解析没处理 `:not()` ⇒ `contenteditable="false"` 误判为让位；
> ② 相邻用例之间没推进时钟 ⇒ 上一条留下的 `lastAt` 让下一条落在去抖窗口内；
> ③ 事件标签拼接漏了空参括号。**没有一条是实现的错**，这类假阳性正是要防的，故留痕。

---

## 2. 独立复核：不止读代码，跑了真实 hook

断言全绿只说明"我判的东西绿了"。故用 esbuild 编译**线上那一份** `useMusicHotkeys.ts`
（注入 store / React / DOM 桩件）跑真实事件，**33 条行为断言全绿**，逐条对应你关心的点：

| 自查项（你点名的） | 推演/实测结论 |
|---|---|
| **空格在 `IconButton` 上是否真的让位** | ✅ 让位。构造 `<button><svg><path>` 三层嵌套，`e.target = path` 时：既**不调** `togglePlay`，也**不 `preventDefault`** ⇒ 浏览器原生"空格点按钮"完整保留。`target = button` 本身同样让位。 |
| **`contenteditable="false"` 是否真的被排除** | ✅ 排除。且**子元素也排除**（`<div contenteditable=false><span>`，target 为 span 时不判让位）—— 这是 `closest` 走祖先链带来的正确行为。`""` / `"true"` / `"plaintext-only"` 三种都让位。 |
| **裸`←/→` 是否被响应** | ✅ 完全不响应，且**不 `preventDefault`**（原生翻页与滚动不受影响）。`⌘/Ctrl` 都生效；`⌘`+`Alt`+`←` 不响应。 |
| **被去抖丢弃时是否仍拦默认** | ✅拦。首击→+200ms 丢弃→+60ms 再按：累计切歌 2 次，且**第二次按键的 `preventDefault` 仍被调用**（窗口从"实际执行"起算，不是从"上次按键"起算）。 |
| **按键独立计时** | ✅ 干净起点实测：同一毫秒内 `⌘→` 与 `⌘←` **都执行**。若 `lastAt` 是单一时间戳，第二个键必然被吃掉 —— 实测未发生。 |
| **音量不去抖** | ✅ `↑` 连按 5 次全部生效（5 次 `stepVolume`）。 |
| **`⌘/Ctrl + ←` 在输入框内** | ✅ 让位给浏览器原生"按词跳转"，不抢。 |

顺带确认了两个规格里"明确不做"的边界：`e.key` 为 `'a'` / `'Escape'` / `'Tab'` 时一概不碰；
`e.target` 不是 `Element` 时不崩（`instanceof` 守卫）。

---

## 3. ⚠️ 独立复核发现的问题（**只报告，未改实现**）

### 3.1 【真实缺陷·中】按住 `⌘→` 不放时，切歌速率被去抖压到 ~4 首/秒，且**第一次也丢**

**现象**：`e.repeat`（键盘自动重复）**完全没有被处理**。`useMusicHotkeys.ts:223` 的
`if (trackSwitchBlocked('next')) return;` 对 `repeat` 事件一视同仁地丢进250ms 窗口。

实测（模拟系统 key repeat 约 16ms/次）：**按住 `⌘→` 约 1 秒（62 次 repeat）只切了 4 首**
（`1 + 1000/250 = 5`）。听起来像"恰好被去抖限流"，但真实语义有个更明显的偏差：

- 用户**按住不放**的意图是"连续快速跳歌"，期望是"越快越好"；
- 而用户**快速点按**（150ms/次，3 次）的意图是"跳 3 首"，实测**只跳了 2 首** ← 少了一首。

也就是说，250ms 窗口把"**连按意图**"和"**长按意图**"混为一谈：
前者被误伤（该跳 3 首只跳 2 首），后者被意外限流（本可以更快）。
注释里写"用户以为在快速跳歌，实际在刷接口"—— 这个顾虑对**心动模式**成立
（`store.ts:1691` 的 `platform.similarSongs` 确实会发网络请求），
但代价是**所有播放模式**下都付出了误伤快速点按的代价。

**建议修法（未实施，请负责人拍板）**：把去抖改成**只对 `repeat` 生效**——
即首次按下立即执行，之后**只丢弃 `e.repeat === true` 的自动重复事件**，手动每次点按都放行：

```ts
const trackSwitchBlocked = (key: string, e: KeyboardEvent): boolean => {
  // 只拦键盘自动重复，不拦用户手动快按
  if (!e.repeat) return false;
  const now = performance.now();
  const prevAt = lastAt.current[key] ?? -Infinity;
  if (now - prevAt < TRACK_SWITCH_DEBOUNCE_MS) return true;
  lastAt.current[key] = now;
  return false;
};
```

这样"连点 3 下一首"跳 3 首（无滑动窗口误伤），"按住不放"仍被 250ms 限流（不刷接口），
两种意图各得其所。若认为"心动模式刷接口"必须无条件压住，退一步的做法是
把窗口缩到 120ms 左右（低于人类最快点按间隔 ~150ms），但那是拿手速换接口，不理想。

⚠️ 注意：这条改动会**让 `KEYS.debounceTrackSwitchOnly` 的语义需要复核**——
该条断言只判"切歌在去抖、音量不在去抖"，不判去抖是否区分 `repeat`，故**仍然会绿**，
但注释里"250ms 窗口压住连发"的说明需要同步更新。

### 3.2 【体验风险·低】`Shift + ↑/↓` 与 `Shift + Space` 会被本hook 响应

**现象**：`useMusicHotkeys.ts:189/196/208` 的收窄条件是
`if (e.metaKey || e.ctrlKey || e.altKey) return;` —— **不含 `shiftKey`**。
实测 `Shift+↑` 会调 `stepVolume(0.05)`。

**影响很小**：`Shift+↑` 在多数平台没有系统级绑定；`Shift+Space` 在 macOS 上是
"向前翻页"（Mission Control 的替身之一），本 hook 会拦掉它并改成播放/暂停。
但这与注释里"带修饰键的组合多半属于系统/窗口管理器，一律不抢"的**意图不一致**——
漏了 `shift` 这一档，属于收窄不彻底。

**建议修法（未实施）**：三处收窄条件统一补上 `|| e.shiftKey`。
（`⌘/Ctrl + ←/→` 那两处的 `e.altKey` 同理，也是逐个手列的，容易再漏。）
更彻底的做法是抽一个`const hasCmdishMod = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;` 复用。

### 3.3 【一致性·低】`0.05` 仍是两个字面量，无共享常量

`PlayerBar.tsx:144`、`ExpandedPlayer.tsx:606`、以及本 hook 的两处各写一份 `0.05`。
store 的 `stepVolume` 只做 clamp，不提供步长常量。**三处口径现已一致**，
但将来只改其中一处就会分叉。这与实施报告 §8.2 是同一条，**仍未解决**。

**建议修法（未实施）**：把 `0.05` 提到 store 或 `music/player-options.ts` 导出，三处共用。

### 3.4 复核过、**确认不是问题**的几点（避免后人重复怀疑）

- **裸方向键与漫画对照视图无冲突**：`LibraryScreen.tsx:160-161` 的 `Compare`
  监听裸 `ArrowLeft/ArrowRight` 且**不判焦点**，但本 hook 对裸键**直接 return 且不 preventDefault**，
  两者互不干扰（一个不响应、一个照常翻页）。⚠️ 反过来若将来有人给裸键加进度调节，
  就会**静默抢键** —— `KEYS.bareArrowsIgnored` 就是守这条线的。
- **常驻性成立**：`App.tsx:232` 的 `<MusicKernel />` 在 `.content` **之外**，
  不受 `screen === 'music' ? <MusicScreen/> : ...` 的条件渲染影响（`App.tsx:198`）。
- **无全局快捷键**：未引入 `tauri-plugin-global-shortcut`，作用域限主窗 WebView。
  桌面歌词窗里按空格无反应，那里只有 `lyrics://control` IPC 通道 —— 与规格取舍一致，非缺陷。
- **`PlayerBar.tsx:158-159` 的重复注释**（`// 播放/暂停同步…` 连写两遍）仍���在，
  纯注释、属他人文件，未动。

### 3.5 实现里有、但本组断言**没有**覆盖的分支（如实标注）

| 分支 | 未覆盖原因 | 是否需要补断言 |
|---|---|---|
| `target instanceof Element` 守卫（非 Element 不崩） | 纯防御，无业务后果 | 不必 |
| `default: return`（其余按键一概不碰） | 隐含在"只处理5 个 case"里 | 不必 |
| `window.addEventListener` / 移除监听（`useEffect` cleanup） | 卸载后不泄漏，属通用 React 纪律 | 建议由 `check:units` 层面管，不属本组 |
| `⌘/Ctrl + Alt + ←/→` 不响应 | 实施报告 §1 已说明是**有意收窄** | 可选（若认定该口径需长期守住） |
| **去抖是否区分 `e.repeat`** | 见§3.1 | **建议补** —— 但要等负责人定修法后再补，否则会把"当前行为"钉成"正确行为" |

---

## 4. 验收门结果

| 门禁 | 结果 | 结论 |
|---|---|---|
| `npm run task -- check:music` | **202 通过 / 1 失败** | ✅ 新增 9 条全绿；唯一红条是既有 `ISLANDV.toggleBothWays`（基线 `eb3fd1f` 改图标所致，**未动**） |
| `npm run task -- check:music:refute` | **162/162 按预期变红**（应执行 162） | ✅ 0 跳过、0 假阳性，31 个文件**字节全部恢复一致** |
| `npm run task -- check:docs` | **14 / 0** | ✅ 条数已对账（见下） |
| `npm run task -- check:units` | 37 / 0 | ✅ 无回归 |
| `npm run task -- check:settings` | 83 / 0 | ✅ 无回归 |
| `npm run task -- check:ia` | 24 / 0 | ✅ 无回归 |
| `npm run task -- check:tls` | 14 / 0 | ✅ 无回归 |
| `cd app && tsc --noEmit` | **0 错误** | ✅ |

### 条数对账（`check:docs` 比对的是脚本**自报的通过数**）

`check:music` 断言总数 **203**，因既有红条 1 条，**自报通过数 = 202**。
`AGENTS.md` / `README.md` 原写 193（= 193 通过）→ 已同步为 **202**，反证 **153 → 162**。

> 连带效应（与 `cache-settings-report.md` 记的历史规律一致）：
> 若日后 `ISLANDV` 那条红被修好，`check:docs` 会再次报红，文档数字要**降到 203**。

`git status --short` 现有 5 项：本报告（新增）、`music-platform-check.mjs`、
`MusicKernel.tsx`、`units-structure-check.mjs`、`AGENTS.md`、`README.md`，
加上未跟踪的 `useMusicHotkeys.ts`。
**未碰**约定的 4 个文件（`atoms.tsx` / `SettingsScreen.tsx` / `settings/icons.tsx` / `DynamicIsland.tsx`），
**未 commit / stash / checkout**，**未改任何实现**。
反证跑完已核对`git status --short`，无源文件污染，`atoms.tsx` / `hooks.ts` 无历史残留。

---

## 5. 真机需要手测的清单（本机 TCC 挡 GUI 自动化，以下**均未在真机验证**）

上述 33 条是**逻辑层**验证（跑的是线上文件本身，但事件与 DOM 是替身）。请负责人手测：

### 必测（对应本组最细的三条判据）

1. **焦点在播放条任意 `IconButton` 上按空格** → 应"**点那个按钮**"（切歌/静音），
   **不是**暂停。这条验的是 `closest` 走祖先链抓到 `<svg>`/`<path>` 里的焦点。
2. **焦点在音量滑块上按 `↑`/`↓`** → 应按 `step={0.01}` 微调（不是 ±0.05），
   且音量不会一下跳 5%。这条验 `input` 让位。
3. **打开音质下拉（Radix Select）后按 `↑`/`↓`** → 应在选项间移动焦点，
   **且音量不动**。这条验 `[role="option"]` 让位 + `Portal` 到 body 下仍被抓到。

### 建议测（本次复核发现的边界）

4. **按住 `⌘→` 不放 2 秒** → 观察切歌速率与是否刷接口（对应 §3.1）。
5. **快速点按 `⌘→` 三下（自测算手速 150ms/次只跳 2 首）** → 确认是否可接受（对应 §3.1）。
6. **`⌘+←` 连按三次** → 确认**没有**浏览器"后退"历史被推入（验 `preventDefault` 在去抖之前）。
7. **输入框内按 `⌘+←`** → 应是光标"按词跳转"，音乐不换歌。
8. **切到设置页 / 漫画页后按空格** → 仍能暂停（验常驻性）。
9. **漫画对照视图里按裸 `←/→`** → 仍能翻页（验不劫持）。
10. **`Shift+↑`** → 会调音量（本报告认为这是收窄不彻底，见 §3.2，请确认是否要改）。
11. **中文输入法组合期按空格** → 真实 WebView 下 `e.key` 的取值需确认（`' '` 之外的输入法
    可能给 `Process`/空串；本hook 的 `default: return` 会静默不响应，属安全侧）。

### 顺带可验的既有缺陷

12. `PlayerBar.tsx:158-159` 那行**重复注释**（纯注释，不影响行为，可顺手清）。