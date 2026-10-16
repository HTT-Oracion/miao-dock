# 音乐模块键盘快捷键 —— 实现报告

- **实现**：`src/hooks/useMusicHotkeys.ts`（新增） + `src/components/MusicKernel.tsx`（挂载调用）
- **门禁同步**：`e2e/units-structure-check.mjs` 的 `HOOKS_MANIFEST` 补了一个文件名（原因见 §6）
- **基线**：`8337a4b`，工作区干净，未 commit（按纪律交给负责人）

---

## 1. 最终键位表

| 键 | 动作 | 直接调用的 store action | 去抖 | `preventDefault` |
|---|---|---|---|---|
| `Space` | 播放 / 暂停 | `togglePlay()` | 无 | ✅ |
| `⌘/Ctrl + ←` | 上一首 | `prev()` | 250ms | ✅ |
| `⌘/Ctrl + →` | 下一首 | `next()` | 250ms | ✅ |
| `↑` | 音量 + | `stepVolume(+0.05)` | **无**（连续生效） | ✅ |
| `↓` | 音量 − | `stepVolume(-0.05)` | **无**（连续生效） | ✅ |

**明确不做**：

- ❌ 裸 `←/→` **不调进度**（用户已砍）。裸方向键归漫画对照视图翻页所有，本 hook 一律不碰。
- ❌ **不做全局快捷键**：未引入 `tauri-plugin-global-shortcut`，作用域仅应用内部（仅主窗 WebView 收得到事件）。
- ❌ **不改 store 任何逻辑**。快捷键层是纯键盘入口，**零业务分支**。

### 关于修饰键的额外收窄（比规格更严的一点点，说明一下）

规格只写了键位，我额外挡掉了**带修饰键的组合**，理由是它们多半属于系统/窗口管理器：

- `⌘/Ctrl/Alt + Space` —— macOS 聚焦搜索、部分输入法切换码
- `⌘/Ctrl/Alt + ↑/↓` —— 窗口管理器与系统快捷键
- `⌘/Ctrl + ←/→` **带 Alt** —— 例如 macOS 的 `⌥←` 词首跳转

也就是说 `⌘/Ctrl + ←/→` 只在**恰好是 ⌘/Ctrl（且无 Alt）**时才触发。这是"不劫持系统键"的延续，代价是用户若用 `Ctrl+Alt+←` 切歌不会响应 —— 在本项目里没有这个用法。

---

## 2. 挂载点：为什么是 `MusicKernel` 而不是 `MusicScreen`

`MusicKernel` 挂在 `App.tsx:232`（shell 层），**常驻，跨所有屏**；`MusicScreen` 是**条件渲染**，切屏即卸载。

- 需求是"**打开过音乐模块后一直生效（跨屏也有效）**" ⇒ 必须住在生命周期长于任何一屏的地方。
- 挂 `MusicScreen` ⇒ 用户一切到设置页，音乐快捷键立刻失效，直接违背需求。

### 与 `MusicScreen.tsx:55-66` 那条 Esc 监听的对比（已在代码注释里写明）

两者**判据是同一条**，但**理由不同**，容易混：

| | Esc（`MusicScreen`） | 快捷键（`MusicKernel`） |
|---|---|---|
| 语义是否只在音乐屏成立 | **是** —— 收起展开播放器 / 关队列抽屉，在漫画页按 Esc 无意义 | **否** —— 音乐在别的屏也在放，暂停/切歌随时该能用 |
| 该住哪 | 音乐屏（条件渲染即可） | 常驻层 |
| 卸载后果 | 无影响 | **快捷键失效** |

统一表述：**「离开音乐屏之后还该继续生效的，就不能住在音乐屏里」**。

> 注意：`<audio>` 挂 `MusicKernel` 的理由是"元素随宿主卸载即销毁"（物理约束），
> 快捷键的理由是"需求本身要求跨屏常驻"（产品约束）。代码注释里明确写了"理由不同，别混为一谈"。

### 为什么不塞进 MusicKernel 内部而要独立文件

- D-41 硬规矩：`use*` 一律住 `src/hooks/`（`check:units` 的 `HOOKS.noMisplacedUse` **按文件名**守着，写成 `export function useXxx` 塞进组件文件虽能过，但会破坏"hooks 唯一收口"的口径）。
- 本 hook 只依赖 store、不渲染任何东西，与 `useEsc` 同属「键盘/DOM 行为」类，**单放同目录**、经 `@hooks/useMusicHotkeys` 引入（同 `useEsc` / `useCoverColor` 的先例）。
- 顺带：`MusicKernel.tsx` 已因"整体搬家"扛了很重的说明性注释，再塞与播放无关的键盘逻辑会糊掉职责边界。

---

## 3. 焦点让位：完整判据清单

判据落在 `INTERACTIVE_SELECTOR`（hook 内），用 `e.target` + `closest()` 一起判。
命中任一 ⇒ **本次按键原样交给浏览器，且不 `preventDefault`**。

| # | 判据 | 对应的原生行为 | 为什么要让位 |
|---|---|---|---|
| ① | `input` | 打字；`input[type=range]` 的 `↑/↓` 按 `step` 微调 | 音量滑块**本身就是** `input[type=range]`（`PlayerBar` 里 `step={0.01}`），抢过来会让同一控件有两套步长/口径 |
| ① | `textarea` | 打字 | 同上 |
| ① | `select` | 下拉选择 | 原生下拉有完整键盘操作 |
| ② | `[contenteditable]:not([contenteditable="false"])` | 就地编辑 | 覆盖 `""` / `"true"` / `"plaintext-only"`；**排除显式 `"false"`**（那恰恰是"不可编辑"的声明） |
| ③ | `button` | **空格 = 点击该按钮** | ⚠️ 播放条上排着一排 `IconButton`（真 `<button>`）。不判断的话"按空格暂停"会变成"按空格点了静音/切歌" |
| ③ | `a[href]` | 空格/回车激活链接 | 键盘用户的主路径 |
| ④ | `[role="button"]` `[role="slider"]` `[role="spinbutton"]` `[role="option"]` `[role="listbox"]` `[role="menuitem"]` `[role="menu"]` `[role="tab"]` `[role="tablist"]` `[role="switch"]` `[role="checkbox"]` `[role="radio"]` `[role="textbox"]` `[role="combobox"]` `[role="scrollbar"]` | ARIA 控件的键盘交互 | 不是原生标签，判 `tagName` **抓不到**。最要紧的是 `units/Select.tsx`（**Radix Select**）：弹层打开后 `↑/↓` 是**在选项间移动焦点**（该组件注释明写"键盘 ↑↓ 是 Radix 的职责"），抢过来会"选音质时顺手把音量也调了" |

### ⚠️ 为什么必须用 `closest`（最容易漏的一点）

**焦点极可能落在控件内部的子元素上**，`e.target` 未必是控件本身。
本项目的 `IconButton` 把 lucide 的 `<svg>`（乃至 `<path>`）包在按钮里，事件 target 就是那个 `svg`/`path` —— 只比 `tagName` 会判成"不在按钮上"而**误劫持**，用户按空格想暂停，结果触发了按钮。

所以两者一起判：`tagName` 兜住裸标签，`closest` 兜住嵌套与 ARIA 角色。
`closest` 走**祖先链**，因此 Radix 弹层那种 `Portal` 渲染到 `body` 下的结构同样能被抓到，不依赖组件实现细节。

### 两条被特别强调的让位

1. **空格必须让位**（见 ③）：否则出现"想暂停却点了别的按钮"。
2. **`⌘/Ctrl + ←/→` 也必须让位**：在输入框里这是"**按词跳转**"，是**有用**的原生行为，不该抢。

---

## 4. 去抖策略与理由

- **只对 `prev` / `next` 去抖**，窗口 **250ms**，首次**立即执行**，窗口内重复**丢弃**。
- **音量完全不去抖**，`↑` 快速连按应当连续增加。

### 为什么只对切歌去抖

拍板口径是"快捷键 = 与播放条按钮完全一致"，而 `next()` 在**心动模式**下会发网络请求（`platform.similarSongs`，store 里 `next` 的 heartbeat 分支）。连按 `⌘+→` 就是**连发请求** —— 用户以为在快速跳歌，实际在刷接口。兜一个 250ms 窗口压住它，且**不改变 `next()` 的语义**（只是不重复调用）。

### 为什么音量不去抖

去抖的目的是压住"一次意图触发多次副作用"，而音量恰恰相反：`↑` 是**连续动作**（20% → 60% 就是按 8 次）。去抖会让"快速连按 ↑"只生效一次，音量爬不上去。
`stepVolume` 本身幂等、无网络开销（只 `set` + `savePrefs`），连续执行不产生放大效应，所以按键重复（`e.repeat`）必须**放行**。

### 为什么按键独立计时（不做"不同键互相取消"）

`lastAt` 是 `Record<string, number>`，每个键各记各的。
若共用一个时间戳，"`⌘+→` 连按两下再立刻 `⌘+←`"会让第二次 `⌘+←` 被上一串 `⌘+→` 的窗口吃掉 —— 变成"上一首按不动"，**比原来的连发问题更糟**。

### ⚠️ 一处实现细节：`preventDefault` 在去抖**之前**

被去抖丢弃的那次按键，键位**仍然属于本快捷键**（不是"让位给原生"），所以照样要拦默认行为。
否则连按 `⌘+←` 时，浏览器原生的"**后退**"会跟着一起触发。
**拦的是默认行为，丢的只是重复执行**，两者不是一回事。

---

## 5. 音量步长来源

**沿用既有实现，没有自己发明**：

- 步长常量 `0.05`，取自 `PlayerBar.tsx:144` 与 `ExpandedPlayer.tsx:606` 的滚轮调音量
  （`onWheel={(e) => stepVolume(e.deltaY < 0 ? 0.05 : -0.05)}`）。
- clamp 口径由 store 的 `stepVolume` 统一负责：`Math.min(1, Math.max(0, volume + delta))`（`store.ts:1811-1814`），**不重复实现**。
- 快捷键直接调 **`stepVolume(±0.05)`**，与滚轮、滑块三条路径共用同一个 action ⇒
  "调到 >0 即解除静音"（`setVolume` 内）也自动一致。

> 仓库里**没有**可复用的步长常量（`0.05` 是两处字面量），所以按要求取 `0.05` 并在此说明来源。

---

## 6. 门禁同步：`HOOKS_MANIFEST` 必须改（不是绕过断言）

`check:units` 的 `HOOKS.layout` 是一条 **exact-list** 断言（`e2e/units-structure-check.mjs:651`），
判 `src/hooks/` 下的文件**恰好**是清单里的那几个（多一个也判红）。
新增 `useMusicHotkeys.ts` 会让它变红，因此**同步加了文件名**：

```diff
-const HOOKS_MANIFEST = ["index.ts", "useEsc.ts", "useCoverColor.ts"];
+const HOOKS_MANIFEST = ["index.ts", "useEsc.ts", "useCoverColor.ts", "useMusicHotkeys.ts"];
```

这正是 AGENTS.md §3 那条纪律要求的（"改了断言覆盖的东西，就要同时更新断言"）——
**留红不如同步清单**。改的是清单本身，不是判定逻辑。
按要求**未动** `e2e/music-platform-check.mjs`（断言由另一位同事写）。

---

## 7. 验收结果

| 门禁 | 基线 | 改后 | 结论 |
|---|---|---|---|
| `tsc --noEmit` | 0 错误 | **0 错误** | ✅ |
| `check:units` | 37 / 0 | **37 / 0** | ✅ 无回归 |
| `check:units:refute` | 44/44 | **44/44** | ✅ |
| `check:music` | 193 / 1 | **193 / 1** | ✅ 仅既有红条 `ISLANDV.toggleBothWays`（基线 `eb3fd1f` 改图标所致，**未动**） |
| `check:settings` | 83 / 0 | **83 / 0** | ✅ |
| `check:ia` | 24 / 0 | **24 / 0** | ✅ |
| `check:tls` | 14 / 0 | **14 / 0** | ✅ |
| `check:docs` | 14 / 0 | **14 / 0** | ✅ |

`git status --short` 只有 3 个文件：本 hook、`MusicKernel.tsx`、`units-structure-check.mjs`。
**未碰**约定的 4 个文件（`atoms.tsx` / `SettingsScreen.tsx` / `settings/icons.tsx` / `DynamicIsland.tsx`），**未 commit / stash / checkout**。

### 行为验证（26 条，脚本在 `/tmp/miao-hotkeys-verify/`，未入库）

直接用 esbuild 编译**线上那一份** hook 并注入桩件运行，验证 26 条行为断言全绿，重点覆盖：
裸空格播放暂停、**空格落在按钮内 `<svg>`/`<path>` 上必须让位**、`contenteditable="false"` 不让位、
**裸 `←/→` 不劫持且不拦默认**、`⌘/Ctrl + ←/→` 生效、音量连按 5 次全部生效、
`⌘→` 连按 6 次只执行 1 次、**`⌘→` 连按后 `⌘←` 仍生效（按键独立计时）**、超 250ms 恢复、带 Alt/⌘ 的组合不抢。

**反证（每条都真的变红过才算数）**：

| 破坏什么 | 变红的断言 |
|---|---|
| 去掉 `closest()`（只判 `tagName`） | **6 条**变红：按钮内 svg / contenteditable / `a[href]` / `role=slider` / `role=option` 全部失去让位 |
| 去掉 `⌘/Ctrl` 判据（裸方向键也劫持） | **5 条**变红：`裸← 不劫持`、`裸→ 不劫持`、`⌘← 上一首`、`⌘→ 下一首`、`裸← 不拦` |
| 给音量也加去抖 | **1 条**变红：`↑ 连按5次全部生效` |

> 过程中这 26 条里有 9 条一度变红，**原因是我自己的验证器写错了**（`press()` 忘了把 `metaKey` 传进事件对象），
> 而非实现有问题。这类"假阳性"正是 AGENTS.md §2.1 要防的，故在报告里留痕。

---

## 8. ⚠️ 发现的既有代码问题（**只报告，未改**）

1. **`PlayerBar.tsx:158-159` 有一行重复注释**：
   `// 播放/暂停同步（playUrl 变化时也要重试 play —— 新音频需重新触发播放）` **连续出现两次**。
   纯注释重复，不影响行为。属他人文件，**未改**。

2. **音量步长 `0.05` 是两个字面量、没有共享常量**：
   `PlayerBar.tsx:144` 与 `ExpandedPlayer.tsx:606` 各写一份。本次沿用该值（见 §5），
   但严格说是"复制两处的口径"。若将来有人只改其中一处，两处滚轮 + 快捷键就会不一致。
   建议（**未实施**）：把 `0.05` 提到 store 或 `music/player-options.ts` 导出，三处共用。

3. **裸方向键的归属没有全局仲裁**：
   `LibraryScreen.tsx:160-161` 的 `Compare` 监听裸 `←/→` 翻页，是**全局 `window` 监听**，
   不判焦点所在控件。若将来音乐屏也想要裸方向键，**两处会静默互相抢键**。
   本次已通过"只认 ⌘/Ctrl"规避，**未改 `LibraryScreen`**。

4. **`Space` 在漫画对照视图里会与浏览器"翻页"默认行为共存**：
   对照视图按空格既可能触发页面滚动（`preventDefault` 已在快捷键侧拦掉），
   也可能被将来某个屏的按钮拿到。**当前无实际冲突**，记录以备后续。

5. **无 `tauri-plugin-global-shortcut`**（符合预期，未引入）：
   因此这些快捷键**只在主窗聚焦时生效**；桌面歌词窗（独立 WebView）里按空格无反应，
   那里只有 `lyrics://control` 那条 IPC 通道能控制播放（`MusicKernel.tsx` 已有转发）。
   这是规格拍板的取舍，非缺陷。

---

## 9. 真机未验证项（如实标注）

- **全部键盘行为均未在真机 GUI 上手按验证**（本机 TCC 挡 GUI 自动化，见 AGENTS.md §5）。
  上述 26 条是**逻辑层**验证（跑的是线上文件本身，但事件与 DOM 是替身）。
- 真实 WebView 下 `e.key` 在中文输入法组合期的取值、`performance.now()` 的时钟行为，需真机确认。
- 建议负责人手测一遍：焦点在播放条按钮上按空格（应"点按钮"而非暂停）、
  焦点在音量滑块上按 `↑`（应按 `step=0.01` 微调）、
  打开音质下拉后按 `↑/↓`（应在选项间移动焦点，且音量不动）。
