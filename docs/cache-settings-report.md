# 《09》§5.7 设置页「音乐缓存」实施报告

> 实施时间：2026-10-05　基线：`eb3fd1f`
> 上游底账：`docs/cache-contract-audit.md`（只读核实）、`docs/cache-frontend-report.md`（前端契约说明）
> 交付范围：**设置页「音乐缓存」项**（③ 播放·媒体 组第 11 项，通栏四格）
> 未执行任何 `git commit` / `stash` / `checkout`；未触碰 `atoms.tsx` / `SettingsScreen.tsx` /
> `settings/icons.tsx` / `DynamicIsland.tsx`（并发写入者的文件）。

---

## 一、改动清单

| 文件 | 性质 | 说明 |
|---|---|---|
| `app/src/screens/settings/CacheBlock.tsx` | **新增** | 四格块 + 下拉 + 二次确认 + 打开目录边界（共 3 个组件：`CacheBlock` / `ClearMenu` / `ClearConfirm`） |
| `app/src/screens/settings/catalog.ts` | 修改 | `SettingItem` 加 `layout?: 'block'` 形态字段；`playback` 小节加 `music-cache` 项；`SPEC_ITEM_TOTAL` 31→32；`MEDIA.note` 补本项与「音频缓存目录」剔除口径的关系 |
| `app/src/screens/settings/sections.tsx` | 修改 | `Group` 加 `layout==='block'` 分支（不包 `Row`）；`render` 加 `case 'music-cache'`；引入 `CacheBlock` |
| `app/src/styles/settings.scss` | 修改 | 新增 `set-cache-*` 样式段（四格 / 下拉 / 菜单项） |
| `scripts/settings-media-check.mjs` | 修改 | `SPEC_TOTAL` 31→32；反证锚点 31→32；`ADDED` 加 1 条；**新增 `CACHE` 组 9 条断言 + 3 条反证**；修 `fnBody`（见 §7.1） |
| `AGENTS.md` / `README.md` | 修改 | `check:settings` 条数 72→**83**、反证 15→**19** |

**未新增任何依赖**，未改 `package.json`。

### 为什么组件放 `screens/settings/` 而不是 `components/units/`

`units-structure-check.mjs:79-91` 的 `MANIFEST` 把 units 目录**锁死为 11 个文件**
（`LAYOUT.files` 多一个即红），`BARREL_EXPORTS`（`:93-104`）也锁死出口。
这一项只在设置页成立，按 `parts.tsx:17-22` 的原话（「只在设置页成立 → 留在该屏目录」）
应与 `parts.tsx` 同级 —— 已放 `screens/settings/CacheBlock.tsx`。

---

## 二、四格布局的实现方式（甲方案怎么落的）

### 2.1 为什么不选乙方案（独立小节）

`ADDED.groups`（`settings-media-check.mjs:336-346`）锁死 `MEDIA.groups` 必须**恰为**
`['playback', 'lyrics', 'vinyl']`。新增小节要连带改 `MEDIA_GROUPS`（`:82`），
改的正是「三小节」这条冻结契约；而四格只是**一项**的布局，代价与收益不成比例。
丙方案（不 catalog 化）会让项数合计对不上，违反本项目「项数单一事实源」这条明写纪律。

### 2.2 甲方案的两处改动

**① `catalog.ts` 的 `SettingItem` 加形态字段**（不是特例分支）：

```ts
/**
 * 形态：**默认（不写）= 标准两栏行**，由 `Group` 包一层 `Row`（标题左 / 窄控件列右）。
 * `block` = 通栏块，`Group` **不包 `Row`**，直接把渲染结果铺满整行。
 * ……
 */
layout?: 'block';
```

**② `sections.tsx` 的 `Group` 见到它就跳过 `Row`**：

```tsx
if (item.state === 'pending' || !render) return <PendingRow key={item.id} item={item} />;
if (item.layout === 'block') return <div key={item.id}>{render(item)}</div>;
return <Row key={item.id} item={item}>{render(item)}</Row>;
```

**为什么形态是「数据的一部分」而不是组件里的一次特例判断**：项数仍由 catalog 求和
（`SECTION_ITEM_TOTAL`）、渲染仍由 `Group` 统一负责。若改成「`id === 'music-cache'` 就走
另一条路」，形态这件事就从数据里消失了 —— 那正是 `catalog.ts:6-8` 那段注释在防的事。

### 2.3 四格的实际结构

用 **grid** 而不是嵌套两行 flex（`settings.scss` 的 `.set-cache-grid`）：
grid 的两行共用行轨道，四格的**行高天然对齐**；嵌套 flex 各算各的，
左列路径长一行就会把右列的按钮顶歪。
列宽 `1fr auto`：左列吃掉剩余宽度（长路径靠 `text-overflow: ellipsis` 截断），
右列按内容宽度，于是「总量 / 按钮」永远贴右，不会因路径长短而漂移。

| | 上 | 下 |
|---|---|---|
| **左列** | 「音乐缓存」（`.set-cache-name`，`--md-ink`） | 目录绝对路径（`.set-cache-path`，**`--md-muted`**） |
| **右列** | 当前总大小（`.set-cache-total`，`--md-font-numeric`） | 打开目录 / 清除缓存（`.set-cache-acts`） |

⚠️ **左列两格颜色刻意不同**（规格要求）：标题用 `--md-ink`（与其它设置项标题一致），
路径用 `--md-muted`。同色会被读成「两行并列的标题」，而不是「这项叫什么」+「它的值」。
路径那格字号也小一档（10.5px，与 `.set-row-why` 同档）。

---

## 三、下拉的实现方式

### 3.1 为什么不能复用 `Select`

`Select`（`components/units/Select.tsx:20-38`）是**受控值选择器**
（`value` + `options` + `onChange`），语义是「在给定值里选一个」。
清缓存是**触发动作**：每项带各自的大小文案、点了就删，**没有可回显的 `value`**。
套 `Select` 会造出一个假的「当前选中项」，且 `label` 在 `Select` 里是 `aria-label`
而非可见标题 —— 与这一项「每项要显示自己的占用」直接冲突。

### 3.2 实际做法

`ClearMenu`（同文件，模块私有）用 `absolute` 定位而非原生 `details`：
- 形态是**动作列表**（`role="menu"` / `role="menuitem"`），没有「当前选中项」；
- 项自上而下：`全部清除` → `清除网易云/ QQ音乐/ 酷狗/ 咪咕`，每项右侧带自己的大小；
- **点外部收起**用 `mousedown` 而非 `click`。用 `click` 时菜单会在
  mousedown→mouseup 之间收起，于是这一次 click 的目标变成刚被移除的按钮，
  事件目标错位 ⇒ **第一次外点收不起来**（要点第二次）。这是菜单「点外面关不掉」的经典成因；
- **Esc 收起**用 `useEsc`（`hooks/useEsc.ts`），与二次确认共用同一个 hook；
  两者不会同时存在（下拉收起才开确认），所以不需要「只让最上层响应」的仲裁。

### 3.3 0 缓存置灰

```tsx
disabled={bytes <= 0}
title={bytes <= 0 ? `${PROVIDER_LABEL[p]}暂无缓存` : undefined}
```
没有可删的东西时给一个能点的项，用户点下去「什么都没发生」，只会以为功能坏了。
灰着 + 不可点才是如实的状态。样式上 `.set-cache-item:disabled` 同时去掉 hover 反馈。

### 3.4 平台名映射与单位

映射写在 `PROVIDER_LABEL`（`Record<MusicProvider, string>`）：
`netease`→网易云 ／ `kugou`→酷狗 ／ `qqmusic`→QQ音乐 ／ `migu`→咪咕。
**用 `Record<MusicProvider, string>` 而不是 `string[]`**：少一个键 tsc 就会报，
而数组写法漏了咪咕要到运行时才发现（顺序还是「照抄键的插入序」，重构即漂移）。

单位：`formatBytes` **1024 进制 + 2 位小数**（`1.50 M`），单位阶梯 K/M/G。
1024 与系统容量口径一致；1000 会让「缓存 1.5 M」和系统显示的量对不上。
小于 1024 字节直接显示 `xxx B`（不进位成 `0.00 K` —— 那读起来像"有但极小"）。

---

## 四、6 处条数同步清单（逐处）

| # | 位置 | 原值 | 新值 | 说明 |
|---|---|---|---|---|
| 1 | `app/src/screens/settings/catalog.ts`（`SPEC_ITEM_TOTAL`） | `31` | **`32`** | 加 1 项后由 31 变 32；不与 `SECTION_ITEM_TOTAL` 一致会触发启动自校 `console.error` |
| 2 | `scripts/settings-media-check.mjs:86`（`SPEC_TOTAL`） | `31` | **`32`** | 与 ① 是**两份独立手写**的同一数字（脚本读不到 catalog 的常量，只能自己抄）；不一致时 `COUNT.total` 红 |
| 3 | `scripts/settings-media-check.mjs` 反证锚点（原 `:625`） | `'export const SPEC_ITEM_TOTAL = 31;'` | **`'export const SPEC_ITEM_TOTAL = 32;'`** | ⚠️ **漏改不会变红、只会「跳过」**，而脚本把 `skipped` 计入失败（`:793`）—— 看起来是"守住了一条"，实际那条已失效 |
| 4 | `scripts/settings-media-check.mjs`（`ADDED`） | 10 条 | **11 条**（加 `{ id: 'music-cache', label: '音乐缓存' }`） | 这一步**连带自动多出 2 条断言**：`ADDED.music-cache` + `WIRING.item.music-cache` |
| 5 | `AGENTS.md:62` | `72 条 / 反证 15 条` | **`83 条 / 反证 19 条`** | `check:docs` 比对的是**脚本自报的通过数**（断言条数），不是 `SPEC_ITEM_TOTAL` 的 32 |
| 6 | `README.md:73` | `72 条` | **`83 条`** | 同上；两处文档都要改，脚本逐个文件比对 |

另核实：`.trae/rules/project_rules.md` **不含** `check:settings` 的条数声明
（沿用底账未核实项 6 的结论，本轮用 Grep 复核，仍然没有），故不在此列。

**条数变化**：正向断言 72 → **83**（+11：`ADDED.music-cache`、`WIRING.item.music-cache`，
以及本轮新增的 `CACHE` 组 9 条）；反证 15 → **19**（+4 条断言 id，其中 1 条挂 2 个 id）。

---

## 五、二次确认的实现

### 5.1 为什么不能复用 `QuitConfirm`

`QuitConfirm.tsx:17` 的 `QUIT_CONFIRM_COPY` 是**契约冻结字面量**
（`spec-check.ts:315-318` 的 B3 组把这段真实渲染出来读 DOM 文本），
标题也写死「退出喵坞？」。改造成通用确认框会**改动退出流程的契约** ——
这是别人的语义，不该由一个清缓存的需求来改。

### 5.2 实际做法

`ClearConfirm`（同文件私有组件）**只复用样式，不复用组件**：
弹层结构与 `components.scss:435-470` 的 `.modal-mask` / `.modal` / `.modal-title` /
`.modal-body` / `.modal-actions` 一致 —— 那是**通用样式层**（`DesktopLyricsSettingsModal`
用的是自己那套 `music-dlset*`），复用它不触碰任何冻结字面量。
Esc 用 `useEsc(onCancel)`，点遮罩取消、`e.stopPropagation()` 防点内容也取消。

**确认必须门控清除**：清缓存不可撤销（删掉的文件没有回收站可捞）。
实现上 `pending` 状态非空才渲染弹层，点「清除…」才调 `musicCacheClear` ——
`CACHE.confirmBeforeClear` 断言把这条门控钉住（要求 `pending` 三态与
`setPending(` 同时存在，以及清除调用确实在文件里）。

### 5.3 确认后必须重拉统计

`music_cache_clear` 返回 `()`（Rust 侧**刻意不抛**：清缓存失败对用户没有可执行的下一步，
弹错误框只会让人困惑）⇒ 前端**不能靠 catch 判断成败**，只能在清完后重新
`musicCacheStats()` 拉一次，用数字变化反映结果。所以 `clear()` 里是
`await musicCacheClear(...)` **紧接** `await reload()`。
漏了这一步的症状：清除确实发生了，但界面数字纹丝不动 ⇒ 用户以为没生效。
`CACHE.reloadAfterClear` 断言要求清除调用**之后**出现 `reload()`。

---

## 六、「打开目录」的边界怎么处理

### 6.1 边界的真实成因

`open_path` 会先判 `p.exists()`，目录不存在直接返回 `Err`（`commands.rs`）
⇒ 若清空把目录整个删掉，「打开目录」就会报错。

### 6.2 实际取证：Rust 侧已经刻意规避了

读 `app/src-tauri/src/music/cache_store.rs:373-420`（Rust 内核，本轮未改）：

```rust
/// 清掉**整个缓存根**下的内容，但保留根目录本身。
/// ⚠️ 为什么保留目录：`open_path` 命令会先判 `p.exists()`，
/// 不存在直接返回 `Err`。若连目录一起删，设置页的「打开缓存目录」按钮
/// 会在清空之后立刻报错 —— 一个「刚做完的操作导致自己的按钮坏了」的经典缺陷。
pub fn clear(app: &AppHandle, provider: Option<&str>) {
```

全清走 `None` 分支（`:397-411`）：逐个平台目录**的内容**，根目录与平台目录都保留。
另 `cache_root()`（`:146-152`）每次都 `create_dir_all(&root)` 兜底建目录。
⇒ **正常流程下清空后目录仍在，「打开目录」不会坏**。

### 6.3 前端为什么**不依赖**上面那条保证

内核的保证是「跨语言契约」，而 `open_path` 的存在性判定是**另一条命令**的判据。
一旦目录被手工删掉、系统清理工具扫过、或将来有人改动 `clear` 的实现，
前端不能跟着一起坏。所以做了**两道**前端处置（都写进了组件头注释）：

1. **`root` 为空串时禁用按钮**（`disabled={!root || failed}`），并用 `title`
   说清原因（「未拿到缓存目录，无法打开」）。
   —— 一个灰按钮 + 一句「为什么灰」才是可用状态；让用户点一下换一条报错不是。
2. **`openPath(...).catch(...)` 兜底**：目录真不存在时（如被手工删除），
   置 `failed` 并重拉一次统计，让界面**如实变成"读取失败"**，
   而不是一次静默失败的点击 —— 用户至少知道发生了什么。

`CACHE.openDirGuarded` 断言要求**两者同时存在**（缺任一条即红）。

### 6.4 无缓存时的显示

- 总大小：`total > 0 ? formatBytes(total) : '无'`。显示「无」而不是「0 K」——
  后者像「精确测得是 0」，而这里真正的含义是「这个平台/这一栏根本没有缓存」。
- 读失败与「读到但缓存是 0」是**两件事**：前者显示「读取失败」，
  **不退回 0** ——「0」会被读成「缓存是空的」，而真相是「没读到」，
  两者的用户下一步完全不同。

---

## 七、断言与反证清单

### 7.1 新增 `CACHE` 组 9 条

| 断言 | 守护什么 | 判据钉在哪 |
|---|---|---|
| `CACHE.layoutFlag` ⭐ | 这一项仍是**通栏形态** | 真导入 catalog 取该 item 的 `layout === 'block'`。删掉字段 → 红（否则被包进 `Row`，四格压扁） |
| `CACHE.groupSkipsRow` ⭐ | `Group` 的新分支**存在且排在 `<Row>` 之前** | 取 `Group` 函数体，正则锚 `item.layout === 'block'`，并比对该分支位置 < `<Row` 位置。只查"出现 block 字样"会被注释骗过；分支排在 `Row` 之后则包 `Row` 的那行先执行 |
| `CACHE.blockRendersFourCells` | 四个格子都在 | 数 `CacheBlock.tsx` 源码里 4 个关键类名（`set-cache-name/path/total/acts`）。取**组件源码**而不是 `sections.tsx`：组件搬文件时引用关系会变，类名不会 |
| `CACHE.openDirGuarded` | 打开目录**有守卫** | 同时要求 `disabled={…root…}` 与 `openPath(…)` 后接 `.catch(`。**只查"有 disabled"会假绿**（整体禁用/按钮禁用都能骗过） |
| `CACHE.confirmBeforeClear` | 有二次确认且**门控**清除 | 弹层（`modal-mask` + `role="dialog"`）+ `pending` 三态 + `setPending(` + 清除调用存在 |
| `CACHE.reloadAfterClear` | 清完**重拉统计** | 取 `CacheBlock` 函数体，要求 `reload()` 出现在 `musicCacheClear` **之后**（位置关系判据） |
| `CACHE.unitsBase1024` | **1024 进制 + 2 位小数** | 基数出现 `1024`、**不出现** `1000`、有 `toFixed(2)`、单位阶梯含 `'G'` |
| `CACHE.providerLabelMap` | 四个平台中文名都在 | 逐个查 `netease`/`kugou`/`qqmusic`/`migu` 的 `键: '名'` 形式 |
| `CACHE.zeroDisabled` | 0 缓存**置灰** | 精确匹配 `disabled={bytes <= 0}` —— 要求 disabled 的判据表达式里出现该项字节数变量，才不会「整体禁用也通过」 |

⭐ 两条是**形态契约**的守卫。为什么要单独成组而不并进 `WIRING`：
`WIRING.item.<id>` 判的是「sections.tsx 里有产出控件的 `case`」，它**不关心**这一项
最终被不被 `Row` 包住。而「音乐缓存」存在的全部理由就是「塞不进 `Row` 的窄右列」：
哪天有人删掉 `layout:'block'` 或删掉 `Group` 的新分支，
WIRING 全绿、项数全对，而页面上那一项被压成一条读不了的细缝 —— **四格没了，
断言却说什么都没发生**。

### 7.2 新增反证 3 条（`check:settings:refute` 19/19 全红）

| 破坏 | 后果 |
|---|---|
| 把「音乐缓存」项整条从 catalog 删掉 | `ADDED.music-cache` + `COUNT.total` 双红（项数对不上、自校常量漂移） |
| 删掉该项的 `layout: 'block'` 字段 | `CACHE.layoutFlag` 红（四格被 `Row` 压成两栏窄列） |
| 把 `case 'music-cache'` 改错 | `WIRING.item.music-cache` 红（四格块不会被渲染） |

### 7.3 反证轮抓到的**我自己的一条假阳性**（已修）

**「把 music-cache 项删掉」这条反证，我第一版写错了锚点。**
我把 id 改名（`id: 'music-cache'` → `id: "__removed-music-cache"`）而不是删掉整条，
于是**项还在**，`COUNT.total` 当然仍然等于 32 —— 脚本判它是假阳性。

这条假阳性其实是**判据正确的证明**（`COUNT.total` 真导入 catalog 求和，
项没真少就不该红），错的是我的破坏动作。已改成**整条删除**（含 `id`/`label`/`state`/
`layout`/`why` 全字段，逐字节锚定）→ 两条断言如期变红。

教训与上一轮一致：**反证的价值在于破坏动作真的破坏了被测的东西**。
「改名」与「删除」在"这一项该出现在页面上"这件事上等价，但在"项数合计"上不等价 ——
而这正是两条断言分工的边界。

### 7.4 顺带修的一个既有判据缺陷（`fnBody`）

新增断言用到 `fnBody` 取**模块私有函数**（`Group` / `formatBytes`）时暴露了两个问题：

1. 原实现要求 `export function` ⇒ 私有函数**恒定找不到函数体**（假红）；
2. 更隐蔽的一个：即便放宽 `export`，`Group({ group, render }: { … })` 的第一个 `{`
   是**解构模式**而非函数体，从它开始数括号拿到的是「形参解构」那一段。

已改为：`export` 前缀可选 → 从函数名后第一个 `(` 做**括号配对**跳过形参表
（复用脚本已有的 `readBalanced`，它会跳过字符串与注释）→ 其后第一个 `{` 才是函数体。
**这不是放宽断言**：可选化后 `export function X` 仍先于 `function X` 匹配，
且跳过形参表后取到的才是真函数体，判据比原来更准。

**既有 6 条用 `fnBody` 的断言**（`WIRING.failLoud` 等）改后仍全绿，无回归。

---

## 八、与底账不符之处（⚠️ 标出）

### ⚠️ 1. `cache-frontend-report.md` §6.2 第 1 条说「`root` 为空串时**必须禁用**按钮」，但没提目录可能被删

底账 ⑥ 与前端报告都指出 `open_path` 会先判 `p.exists()`。我核实后发现**边界比底账描述的更宽**：
不只"`root` 为空串"这一种，**目录被手工删掉 / 迁移换机后 `root` 仍是有效字符串但路径不存在**，
`openPath` 一样会 reject。所以只做「空串禁用」不够，本轮额外加了 `.catch` 兜底（§6.3）。

### ⚠️ 2. 底账 ⑥ 说「`clear` 可能删掉 `music-cache/` 根目录」—— 实际 Rust 侧已刻意规避

底账（`cache-contract-audit.md:397`）写的是「清空全部缓存后若目录被整个删掉，
'打开目录' 会报错」，措辞是**假设风险存在**。实际 `cache_store.rs:373-420` 已明确
**只删目录内容、保留根目录**，且注释里点名了这个缺陷。
⇒ 任务里点名的这个边界，**在当前内核实现下正常流程不会发生**；
但本轮仍按"不依赖跨语言保证"的思路做了两道前端处置（§6.3），
理由写进了组件头注释 —— 依赖是跨命令的，不能只靠另一条命令的刻意设计。

### ⚠️ 3. 底账 ⑤ 说 `CacheStats` 类型应放 `app/src/music/types.ts` —— 已在上一轮落地

前端报告 §6.1 给的 `CacheStats` 结构（`providers: Record<MusicProvider, CacheProviderStat>`）
与 `types.ts:181-213` 现存定义逐字一致，本轮**未改**该文件，未重复实现。

### ⚠️ 4. `check:docs` 的条数取「脚本自报通过数」，不是断言总数 —— 与底账口径一致

`docs-consistency-check.mjs:48-65` 的 `selfReportedCount` 从脚本自己的汇总行
`通过 N / 失败 M` 里取 `N`。所以文档声明 83 = 断言总数 83（`check:settings` 本轮全绿，
两者数值相同）。若日后 `check:settings` 出现红条，**文档条数要跟着降**。
连带效应：`check:music` 因既有红条 `ISLANDV.toggleBothWays` 是
断言总数 194 / 通过 193，文档已按 **193** 对账（本轮未动，见 §9）。

---

## 九、验收结果

| 门 | 结果 |
|---|---|
| `cd app && tsc --noEmit` | ✅ **0 错误** |
| `npm run check:settings` | ✅ **83 通过 / 0 失败**（72 → 83） |
| `npm run check:settings:refute` | ✅ **19/19 按预期变红**（应执行 19，0 跳过，0 假阳性，**5 个文件字节全部恢复一致**） |
| `npm run check:units` | ✅ **37/37**（无回归；`LAYOUT.files` / `MANIFEST` / `BARREL_EXPORTS` / `NAMING` / `CALLERS` 均未受影响） |
| `npm run check:docs` | ✅ **14 通过 / 0 失败**（条数已对账） |
| `npm run check:ia` | ✅ 24/24（无回归） |
| `npm run check:tls` | ✅ 14/14（无回归） |
| `npm run check:music` | ⚠️ **193 通过 / 1 失败**（既有红条，见 §9.1；**无新增回归**） |
| 禁词（任何大小写） | ✅ **0 命中**（Grep 工具全仓扫描，含本轮所有新写文件与本报告） |
| TS 引号风格 | ✅ 全单引号（仅 JSX 属性用双引号，那是语法要求） |
| 未执行 commit / stash / checkout | ✅ |
| 未触碰 `atoms.tsx` / `SettingsScreen.tsx` / `settings/icons.tsx` / `DynamicIsland.tsx` | ✅ |

### 9.1 既有红条现状（**非本轮引入，未为转绿放宽任何断言**）

`check:music` 有 1 条红：`ISLANDV.toggleBothWays` —— 基线 commit `eb3fd1f`
（另一并发会话 `lvjinbin` 的图标改造）把切换图标从 `<Play>` 改成 `<AudioLines>`。
按纪律**未动**：既没改这条断言，也没碰 `DynamicIsland.tsx`（别人的文件）。
它是**基线自带**，与缓存改动无关。本轮**未对 `check:music` 做任何改动**
（`scripts/music-platform-check.mjs` 不在本次改动清单内）。

### 9.2 工作区改动范围

`git status --short` 里属于本轮的 7 项：
`catalog.ts`、`sections.tsx`、`CacheBlock.tsx`(新)、`settings.scss`、
`settings-media-check.mjs`、`AGENTS.md`、`README.md`。

其余为**并发写入者的既有未提交改动**（Rust 内核 3 个新文件 + `mod.rs`/`models.rs`/`main.rs`、
前端 `ipc.ts`/`types.ts`/`store.ts`、`music-platform-check.mjs`、3 份 docs）——
**未动、未还原**。

---

## 十、我没能核实的项

1. **真机行为未验证**：本轮只跑了 `tsc` 与断言，**没有编译/运行 Tauri 应用**。
   下列都还需要一次真机手测：
   - 「清除缓存」下拉的定位与层级（`z-index: 30` vs `.modal-mask: 40`）；
   - 二次确认点遮罩取消、Esc 取消两条路径；
   - 清完后总大小与下拉内各项数字**确实都变了**（尤其下拉**开着**时清另一项的刷新）；
   - 「打开目录」调起系统文件管理器后定位到 `music-cache/` 根目录。
2. **`limit_lyric` / `limit_audio` 未在 UI 呈现**：契约说明要求「别在前端写死」，
   本轮**没有引入这两个数字的任何展示**（规格未要求）。也就是说当前 UI 看不到
   「已用 / 上限」。若日后要加，必须直接用 `stats.limit_*`，不得硬编码 100MB / 1GB。
3. **弹层在窗口极窄时的表现**：`.modal` 有 `max-width: calc(100vw - 48px)`（通用样式），
   但四格在极窄宽度下 `1fr auto` 的右列会不会挤爆左列，未实测。
4. **`failed` 状态与「打开目录禁用」的重叠**：`failed` 为真时按钮一并禁用。
   这意味着「读取失败」之后用户**不能**再点打开目录（此时也确实没有有效路径），
   但只能靠切分组再回来才重试 —— 因为我没有放一个显式的「重试」按钮（规格未要求）。
   若真机验证认为需要，补一个「重新读取」比让用户切分组更合理。
