# 《09》§5.7 缓存接入 · 前端播放链路实施报告

> 实施时间：2026-10-05　基线：`eb3fd1f`（Rust 缓存内核在其后已交付，处于未提交状态）
> 上游底账：`docs/cache-contract-audit.md`（只读核实）、`docs/cache-rust-report.md`（Rust 侧报告，命令签名以其为准）
> 交付范围：**前端播放链路**。设置页**未做**（见 §6 契约说明）。
> 未执行任何 `git commit` / `stash` / `checkout`；未触碰 `atoms.tsx` / `SettingsScreen.tsx` /
> `settings/icons.tsx` / `DynamicIsland.tsx`。

---

## 一、改动清单

| 文件 | 性质 | 说明 |
|---|---|---|
| `src/music/ipc.ts` | 修改 | 4 个缓存命令封装（+`CacheStats` 类型导入、头部命令数 94→98） |
| `src/music/store.ts` | 修改 | 播放链路接入缓存查命中 + 后台预热（新增 3 个模块级私有函数） |
| `src/music/types.ts` | 修改 | 新增 `CacheStats` / `CacheProviderStat`（Rust `models.rs` 的逐字镜像） |
| `e2e/music-platform-check.mjs` | 修改 | 新增 `CACHE` 组 **10 条断言** + **13 条反证** + 3 个判据辅助函数 |
| `AGENTS.md` / `README.md` | 修改 | `check:music` 条数 184→193（对账用） |
| `docs/cache-rust-report.md` | 修改 | **仅一行**：删掉报告自身写出的禁词字面量（见 §5.3） |

`openPath` **未重复封装** —— 它在 `src/ipc.ts:78`，不在 `music/ipc.ts`。设置页要用时
直接从 `@/ipc` 导入即可（见 §6.3）。

### 新增的 3 个模块级私有函数（store.ts）

| 函数 | 职责 | 为什么独立成函数而不是内联进 `resolveOnlineUrl` |
|---|---|---|
| `audioCacheId` | 逐平台取缓存稳定主键 | 四平台的 id 口径各不相同，**必须只有一处**。内联的话一旦某平台漏改分支，key 会静默错位 |
| `lookupAudioCache` | 查缓存 → 返回**可播放的 asset URL** | 把「本地歌曲排除」「异常吞掉」「`convertFileSrc` 转换」三件事收在**缓存链入口**，将来多一个调用方也不会漏 |
| `prefetchAudioCache` | 后台整首落盘 | 把「`void` 不阻塞」「`.catch` 不上抛」「本地歌曲排除」钉在一处 |

---

## 二、两条路径的实际流程

### 2.1 命中路径（缓存有该档位的整首）

```
playSong → resolvePlayUrl(song)
  ├─ song._localPath 存在？ ── 是 → convertFileSrc(本地文件) → 结束（本地歌曲永不入缓存链）
  └─ 否 → resolveOnlineUrl(song)
        ├─ quality = state.playbackQuality          ← 5 值枚举，非空
        ├─ audioCacheId(provider, song)              ← 逐平台稳定主键
        ├─ ipc.musicAudioCached(provider, id, quality)
        │     └─ 命中 → convertFileSrc(绝对路径) → asset:// URL
        ├─ setState({ currentQuality: quality, currentBitrate: 0 })
        └─ return 该 URL
              → **platform.songUrl 完全不被调用**（省掉一次取流地址的网络往返，
                也顺带避免了源站的降级重试）
```

`currentBitrate` 置 0 而非沿用旧值：命中时拿不到真实码率，UI 侧只在 `> 0` 时显示
（`PlayerBar.tsx:208`），置 0 等于「不谎报」；若沿用上一首的值，播放条会显示**上一首**的码率。

### 2.2 未命中路径

```
        ├─ ipc.musicAudioCached(...) → null
        ├─ ipc.platform.songUrl(provider, song, quality)     ← 原路径，未改动
        ├─ setState({ currentQuality: r.quality || r.level || '', currentBitrate: r.br || 0 })
        ├─ prefetchAudioCache(song, provider, quality, r.url)
        │     └─ void ipc.musicCacheDownload(...).catch(() => {})
        │           ← fire-and-forget：**不 await**，失败静默放弃缓存
        └─ return `http://127.0.0.1:{port}/audio?url=...`    ← 代理路径，未改动
              → playSong 立刻拿到 URL 开始播放，下载在后台跑
```

**下载为什么不阻塞**：调用点放在**播放地址已就绪之后**（它需要 `r.url`），
`void` 发出且不 `await`。若 `await`，慢网下点歌要等整首下载完才响；
若失败被 `throw` 到播放链路，`playSong` 会弹「播放失败」并**自动跳下一首** ——
症状是「网络不好时歌放不出来」，而根因只是个可有可无的缓存。

`audio_proxy.rs` **零改动**（Rust 侧采用的方案 C，代理的 Range/206 透传一点没碰）。

### 2.3 三条硬要求的落点

| 要求 | 落点 | 为什么这样落 |
|---|---|---|
| ① quality 传 `state.playbackQuality`，不传 `r.quality`/`r.level` | `resolveOnlineUrl` 里 `const quality = state.playbackQuality`，两处调用都传这个变量 | 查缓存发生在 `songUrl()` **之前**，那一刻只有请求档位已知。四平台 `r.quality`/`r.level` 值域互不相同（网易云中文 label / QQ 英文 label / 咪咕 `PQ`/`SQ`/`ZQ`），拿来当 key 会让同一首歌每次 key 都不同 ⇒ **永不命中且不报错** |
| ① quality 不能为空、不默认成 `standard` | TS 侧 `PlaybackQuality` 是不含空串的联合类型，天然非空；水合处有 `?? 'hires'` 兜底。Rust 侧对空档位判为「无法寻址」直接不下缓存，**刻意没有**默认成 `standard` | 默认成 `standard` 会让「参数传漏」静默命中标准音质文件 —— 用户以为听到了自己选的高音质。宁可无缓存，也不能猜错音质 |
| ② 本地歌曲不入缓存链 | `lookupAudioCache` 与 `prefetchAudioCache` **各自入口**都有 `if (song._localPath) return` | ① 它走 `asset://` 直接播，文件本就在本地，再问一遍缓存是多余的系统调用；② 计入「音乐缓存」统计会让设置页占用数字失真。放在**缓存链入口**而非调用点，将来多一个调用方也不会漏 |
| ③ 下载不阻塞播放 | `void ... .catch(() => {})`，调用点在播放地址就绪之后 | 见 2.2 |

**额外一处判断（任务里点名要我判断的）**：本地缓存文件是绝对路径，
**必须走 `convertFileSrc`** —— 与既有本地歌曲（`resolvePlayUrl` 对 `song._localPath`）
完全同一条路。Tauri 下直接喂 `file://` 会被跨源策略挡住，症状是
「命中缓存反而播不出声」，且报错发生在 `<audio>` 上，看不出跟缓存有关。
转换放在 `lookupAudioCache` 内部，让它的契约是「返回能播的 URL」而非「返回路径」。

---

## 三、断言清单与每条的反证

### 3.1 新增 `CACHE` 组 10 条

| 断言 | 守护什么 | 判据钉在哪 |
|---|---|---|
| `CACHE.ipcWrapped` | 4 个命令在 `ipc.ts` 有封装**且**在 `main.rs` 注册 | `invoke<...>('cmd'` 的字符串字面量实参 + `music::audio_cache::cmd`。注册这一环同样零覆盖（冻结清单不含新命令），必须单独判 |
| `CACHE.keyHasQuality` ⭐ | **缓存 key 含 quality** | `callArgs` 括号配对取**单次调用**的实参，要求恰好 3 个且第 3 个含 `quality` |
| `CACHE.qualityFromState` | quality 来自 `state.playbackQuality`，不是 `r.quality`/`r.level` | ① 取档位那行 `const quality = state.playbackQuality`；② `platform.songUrl` 第 3 实参 === `quality`；③ **反向**：两个缓存调用里不得出现 `r.quality`/`r.level` |
| `CACHE.noQualityFallback` | quality 不被默认成 `standard` | 取 `const quality = <...>;` 的**声明语句**实参，判其中无 `standard`；`audioCacheId` 同判 |
| `CACHE.localSongExcluded` | 本地歌曲不入缓存链 | `lookupAudioCache` **与** `prefetchAudioCache` 各自入口的 `if (song._localPath) return`（两处都要，漏一处就有一条路径没排掉） |
| `CACHE.hitSkipsSongUrl` | 命中时不调 `songUrl` | `indexOf` 比顺序：查缓存 < `platform.songUrl` < `return cached`（三者位置关系） |
| `CACHE.hitUsesConvertFileSrc` | 命中路径走 `convertFileSrc` | `convertFileSrc(hit)` 这一句 |
| `CACHE.downloadNonBlocking` | 下载不阻塞 | `void ipc.musicCacheDownload(` 且**无** `await`；调用点存在且未被 `await` |
| `CACHE.downloadFailureSilent` | 下载失败不打断播放 | 恰好 4 个实参；`afterCall` 括号配对取**闭合括号之后**的文本，要求紧跟 `.catch(`；函数内无 `throw` |
| `CACHE.statsShapeForSettings` | `CacheStats` 字段名与 Rust 逐字一致 | `braceBlock` 取 **CacheStats 接口体内部**，逐字段查（不扫全文，原因见 3.3） |

### 3.2 反证（13 条，`check:music:refute` 153/153 全红）

| 破坏 | 后果（写在反证注释里，便于日后定位） |
|---|---|
| 查缓存删掉 `quality` 实参 | 切档位后命中上次文件，界面显示新档位实际播旧码率 |
| 查缓存档位换成 `r.quality` | 四平台值域不同 ⇒ 每次 key 都不同 ⇒ 永不命中 |
| 档位默认成 `standard` | 参数传漏时静默命中标准音质 ⇒ 用户以为在听高音质 |
| `lookupAudioCache` 不排除本地歌曲 | 用户导入的文件被计入「音乐缓存」统计 ⇒ 占用数字失真 |
| `prefetchAudioCache` 不排除本地歌曲 | 同上（另一条路径没排掉） |
| 查缓存挪到取流地址之后 | 先回源再查 ⇒ 命中也省不掉网络往返，白接缓存 |
| 命中后不 `return cached` | 命中了还会继续调 `songUrl` ⇒ 缓存等于没接 |
| `CacheStats.limit_audio` 改名 | 与 Rust 不一致 ⇒ 设置页读到 `undefined` 显示 0 |
| `ipc.ts` 命令名写错一个字 | tsc 全绿，运行时才发现命令不存在 |
| `main.rs` 摘掉 `music_cache_stats` 注册 | 定义存在但运行时找不到命令 |
| 命中路径不走 `convertFileSrc` | 绝对路径直喂 `<audio>` 被跨源挡住 ⇒ **命中反而播不出声** |
| 预热 `await` 住 | 慢网下点歌要等整首下载完才响；失败还会被当成"播放失败"跳歌 |
| 下载失败不上抛 | 未处理的 Promise 拒绝中断播放链路 ⇒ 缓存失败变成歌放不出来 |

### 3.3 反证轮抓到的**我自己的两条假阳性**（已修）

这一节值得单独记，因为两次都是"判据不精确导致恒绿"这个本项目反复踩的坑：

1. **`CACHE.statsShapeForSettings` 恒绿。** 第一版判据扫全文找字段名，
   而 `CacheProviderStat` 里**也有** `audio_bytes`（且同样以 `audio_bytes: number;\n}` 结尾）
   ⇒ 把 `CacheStats.audio_bytes` 改错后，全文搜 `audio_bytes` 仍能命中另一个接口的同名字段。
   修法：**用 `braceBlock` 把判据限定在 CacheStats 接口体内部**。
   同一条反证的**锚点**也是错的：原本的 `find: '  audio_bytes: number;\n}'` 唯一命中的是
   `CacheProviderStat`（它在前），改到的是另一个接口，`CacheStats` 纹丝不动。
   改用全文件唯一的 `limit_audio` 做锚点。**断言与锚点两处都要"唯一"，缺一即恒绿。**

2. **`PLAYER.resolveWrites`（既有断言）因我的改动而恒绿。** 接入缓存后
   `resolveOnlineUrl` 里有**两处**写 `currentBitrate`（命中写 0、未命中写 `r.br`），
   而该断言只判「字段名出现过」⇒ 删掉 `r.br` 那次仍绿 —— 而那正是它声称守护的东西。
   修法：判据**收紧**为「必须存在 `currentQuality: r.quality` 与 `currentBitrate: r.br`
   这两次按平台返回值的回写」。这是把断言跟上实现，不是为转绿而放宽。

### 3.4 新增的 3 个判据辅助函数

都写进了脚本，因为本项目已因"判据不精确"栽过 9 次，这三个是通用解法：

- `callArgs(src, callee)` —— 括号配对取**单次调用**的实参表（跳过嵌套括号与字符串）。
  这是"参数有没有传"唯一可靠的判法：`fn(...quality)` 换行就假红，
  `fn\([\s\S]*?quality\)` 会把**后面另一个调用**里的 `quality` 算作本次实参（该红没红）。
- `afterCall(src, callee)` —— 取**闭合括号之后**的文本。`.catch()` 跟在整个实参表之后，
  而实参表里必然含嵌套调用（`audioCacheId(provider, song)`），
  按 `indexOf` 取子串会落在实参表**内部**，判据错位（实测踩过：`.catch` 判据恒红）。
- `braceBlock(src, anchor)` —— 取某个类型/接口**体内部**，避免同名字段互相顶替。
- 配套 `nthIndex` / `matchBracket`（后者会**跳过字符串字面量**，
  否则 `')'` 之类字面量里的括号会提前截断配对）。

---

## 四、验收结果

| 门 | 结果 |
|---|---|
| `cd app && tsc --noEmit` | ✅ **0 错误** |
| `npm run task -- check:music` | ✅ **193 通过 / 1 失败**（失败为既有红，见 §5.1） |
| `npm run task -- check:music:refute` | ✅ **153/153 按预期变红**（应执行 153，0 跳过，0 假阳性，全部文件字节恢复一致） |
| `npm run task -- check:docs` | ✅ **14 通过 / 0 失败**（条数已对账） |
| `npm run task -- check:units` | ✅ 37/37（无回归） |
| `npm run task -- check:settings` | ✅ 72/72（无回归） |
| `npm run task -- check:ia` | ✅ 24/24（无回归） |
| `npm run task -- check:tls` | ✅ 14/14（无回归） |
| 禁词（任何大小写） | ✅ 0 命中（Grep 工具全仓扫描） |
| TS 引号风格 | ✅ 全单引号 |
| `git status --short` | ✅ 仅上表文件 + Rust 侧的 6 个既有未提交文件 |
| 未执行 commit / stash / checkout | ✅ |
| 未触碰 `atoms.tsx` / `SettingsScreen.tsx` / `settings/icons.tsx` / `DynamicIsland.tsx` | ✅ |

**条数变化**：`check:music` 183 → **193**（+10）；反证 139 → **153**（+14 条断言 id，
其中 1 条同时挂 2 个断言 id）。`AGENTS.md` / `README.md` 已同步。

---

## 五、既有红条现状（**非本轮引入，未为转绿放宽任何断言**）

### 5.1 `check:music` 的 1 条红：`ISLANDV.toggleBothWays`

要求灵动岛切换键的图标是双向的（歌词态→播放、播放态→歌词），而基线 commit `eb3fd1f`
（另一并发会话 `lvjinbin` 的图标改造）已把切换图标从 `<Play>` 改成 `<AudioLines>`。

**按纪律未动**：既没改这条断言，也没碰 `DynamicIsland.tsx`（别人的文件，有未完成 stash）。
它是**基线自带**，与缓存改动无关 —— 已用 `git show HEAD` 取证。

⚠️ 连带效应：`check:docs` 的条数对账取的是脚本自报的**通过数**，
所以这条红会让文档声明的条数比断言**总数**少 1（断言总数 194，通过 193）。
文档已按 193 对账（`check:docs` 绿）。若日后修好这条红，**文档需再改回 194**。

### 5.2 Rust 侧报告的自述已过时

`docs/cache-rust-report.md` 第三节第 6 条写「`check:docs` 有 2 条红」。
实测基线是 **3 条**：除两条条数对账外，还有 1 条 BANNED 命中（见下）。
本轮改动后 `check:docs` 已全绿。

### 5.3 我改了别人的报告一行（唯一一次越界，已最小化）

`docs/cache-rust-report.md:268` 那行表格里，为了说明"检查了禁词"，
**把禁词字面量本身写了进去**（而同一行还写着"✅ 0 命中"）——
`check:docs` 的 BANNED 组因此报红，且该文件在扫描范围内（`docs/`）。

我只把那半句改成「禁词（被禁历史品牌标识，任何大小写）」，**未改动该报告的任何结论或结构**。
这既让 `check:docs` 绿，也去掉了一处自相矛盾。若认为该行应由原作者自行修改，可回退这一行。

---

## 六、给设置页任务的契约说明

### 6.1 三个命令的签名与返回（封装已就绪，直接用）

```ts
import { musicCacheStats, musicCacheClear } from '@/music/ipc';

// ① 统计：Promise<CacheStats>
const stats = await musicCacheStats();

// ② 清理：Promise<void>。provider 省略/null ⇒ 全平台清
await musicCacheClear();          // 全清
await musicCacheClear('kugou');   // 只清酷狗

// ③ 打开缓存目录：**复用 src/ipc.ts:78 的 openPath，不要重复封装**
import { openPath } from '@/ipc';
await openPath(stats.root);
```

`CacheStats`（`src/music/types.ts`，字段名是 **snake_case 跨语言契约**，勿改）：

```ts
{
  total: number;          // 全部平台合计字节
  lyric_bytes: number;
  audio_bytes: number;
  root: string;           // 缓存根目录绝对路径
  limit_lyric: number;    // 100MB —— 别在前端写死
  limit_audio: number;    // 1GB  —— 别在前端写死
  providers: {            // 四个键恒存在，无缓存为 0（可省判空）
    netease:  { lyric_bytes: number; audio_bytes: number };
    qqmusic:  { ... };
    kugou:    { ... };
    migu:     { ... };
  };
}
```

### 6.2 三个必须知道的边界

1. **`root` 为空串时必须禁用「打开目录」按钮。** `open_path` 会先判 `p.exists()`，
   不存在直接返回 `Err`（`commands.rs` 的 `open_path`）⇒ 点了就是一次报错弹窗。
   正常流程下 `clear` 只删**目录内容**、保留目录，所以清空后 `root` 仍可用 ——
   Rust 侧是刻意这么设计的（避免"刚做完的操作把自己的按钮弄坏"）。

2. **清完要重新拉一次 stats。** `clear` 返回 `()`（不是 `Result`）：
   清缓存失败对用户没有可执行的下一步，Rust 侧刻意不抛 —— 所以**前端不能靠 catch 判断成败**，
   只能在清完后重新 `musicCacheStats()` 拉一次，用数字变化反映结果。

3. **字段名写错是静默的。** `stats.providers.netease.audio_bytes` 读出 `undefined`，
   在累加里不报错 ⇒ 显示 0，症状像"功能没做"而不像"字段名拼错"。
   这就是 `CACHE.statsShapeForSettings` 存在的原因，改字段名会把它变红。

### 6.3 设置页落地时的连带项（来自实施底账，仍然有效）

- **能否 catalog 化**：底账⑤ 已论证当前结构下「不复用普通设置项模板」**做不到** ——
  `Group`（`sections.tsx:44`）对每个 live 项强制包 `Row`，而 `Row` 是固定两栏、右列窄。
  须在甲/乙/丙三方案中拍板。
- **若走 catalog 化，加项要同步 6 处**：`catalog.ts:429` 的 `SPEC_ITEM_TOTAL`、
  `settings-media-check.mjs:86`、`:625`（**反证锚点，同步漏改会退化成"跳过"而非变红**）、
  `:68-79` 的 `ADDED` 加一条、**`AGENTS.md:62` 与 `README.md:72` 的条数**。
  ⇒ `check:settings` 会从 72 变 74 条。
- **组件放 `screens/settings/`**，**不能**放 `components/units/`（`MANIFEST` 锁死 11 个文件）。
- **样式类名别带 `music-` 前缀**（`settings.scss` 禁该前缀）。
- 二次确认组件**无可复用**：`QuitConfirm` 的文案是契约冻结字面量。

### 6.4 与播放链路的耦合（设置页要知道的）

- **本地歌曲不计入「音乐缓存」统计**（§2 的要求②）。所以设置页显示的占用
  **只包含在线歌曲的缓存**，不含用户自己导入的本地文件 —— 这是刻意口径，文案上别写错。
- 设置页读写的 `providers` 四个键，与播放链路写缓存时用的 `provider` 是**同一套标识**
  （`netease` / `kugou` / `qqmusic` / `migu`，即 `MusicProvider`）。
  `musicCacheClear(provider)` 传的必须是这个值。
- 播放链路的缓存**只由播放行为产生**（查命中 + 后台预热），
  设置页**不需要**（也不应该）自己触发下载。

---

## 七、我没能核实的项

1. **真机行为未验证。** 本轮只跑了 `tsc` 与断言，**没有编译/运行 Tauri 应用**：
   缓存命中能否真的播出声、后台下载是否真的不打断播放、`asset://` 转换在真机上的表现，
   都还需要一次真机验证。建议按 §2.1 / §2.2 两条路径各手测一次
   （先断网播一遍冷启动的歌 → 联网播同一首 → 确认命中且是本地文件）。
2. **`quality` 降级的那一份文件。** 源站降级时（用户选 hires、实际拿到 exhigh），
   key 记的仍是 `hires` —— 这是**正确**的（下次仍是同一请求），
   代价是「降级回来的那一档」会在磁盘上各占一份文件。
   设置页的占用数字会把这些**内容相同、key 不同**的文件分别计入，
   展示上不需要特殊处理，但知道这一点比较好。
3. **酷狗空 hash 的实际发生率。** 沿用底账的未核实项：`kugou.rs:1005` 会把空 hash
   序列化成 `Some("")`。我的 `audioCacheId` 用 `||`（而非 `platform.ts:415` 的 `??`）
   做了兜底，空 hash 会回落到 `song.id` —— **与 `platform.songUrl` 传下去的参数不一致**
   （那边仍会传空串）。这个不一致是**故意的**：缓存 key 用空 id 会让所有空 hash 的歌
   撞同一个 key（"A 歌的音频出现在 B 歌上"），而 `songUrl` 传空串只会让请求失败（当场可察觉）。
   若日后把 `platform.ts:415` 也改成 `||`，两边就一致了。
4. **QQ 的 `mid` 空值率。** 沿用底账未核实项 1：`mid` 是否在所有列表接口下都非空。
   我同样用 `||` 做了兜底，语义与上面一致。
5. **法务结论（音频落盘是否允许）** 不在代码里，无法核实，仍是 P1 的前置闸。
