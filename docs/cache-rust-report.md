# 《09》§5.7 缓存内核层 · Rust 侧实施报告

> 实施时间：2026-10-05　基线：`eb3fd1f`
> 验收：`cargo check` **0 错误 0 警告**；`#[tauri::command]` 属性已逐个回读确认未被注释吞掉；
> `git status --short` 仅含下表文件，无 sed 临时快照。
> 未执行任何 `git commit` / `stash` / `checkout`。

---

## 一、新增 / 修改文件清单

| 文件 | 性质 | 行数 |
|---|---|---|
| `app/src-tauri/src/music/cache_store.rs` | **新增** · 缓存内核（歌词/音频共用） | ~600 |
| `app/src-tauri/src/music/lyric_cache.rs` | **新增** · 歌词缓存层 | ~150 |
| `app/src-tauri/src/music/audio_cache.rs` | **新增** · 音频缓存层（**未改 `audio_proxy.rs`**） | ~310 |
| `app/src-tauri/src/music/models.rs` | 修改 · 新增 `CacheStats` / `CacheProviderStat` | +33 |
| `app/src-tauri/src/music/mod.rs` | 修改 · 3 个 `pub mod` + 四个聚合歌词命令接入 | +69 −5 |
| `app/src-tauri/src/main.rs` | 修改 · `invoke_handler` 注册 4 个新命令 | +6 |

**零改动确认**：`audio_proxy.rs` 未被触碰（Range/206 透传完全未动）；`atoms.tsx` /
`SettingsScreen.tsx` / `settings/icons.tsx` 未被触碰（另一会话的 stash 涉及这三个文件）；
前端**任何文件**均未改动 —— 歌词侧前端零改动这条硬要求已满足。

---

## 二、关键设计决策与理由

### 1. 为什么内核单独一层（`cache_store.rs`）

歌词与音频的**寻址、过期判定、淘汰策略、容错要求完全一致**，只有「扩展名」和两个常量不同。
合成一层后，改缓存策略不会漏改某一平台 —— 分叉的两份 LRU/TTL/`.part` 处理正是本仓反复出现缺陷的位置。
对外暴露的函数**都不返回 `Result`**（`clear` 除外，它只是尽力而为）：磁盘满 / 权限不足 /
只读文件系统 一律静默降级为「无缓存」，只写 `log::warn!` 不改控制流。

### 2. `stable_hash`（FNV-1a）照抄 `local.rs:53`，并说明为何不能用 `DefaultHasher`

`DefaultHasher` 带随机种子，同一输入在不同进程得到不同哈希 ⇒ 重启后缓存路径全部失效，
表现为「缓存目录越用越大、但每次播放都重新下载」，**且无任何报错**。
两处（封面 / 本缓存）必须用同一算法，否则同一首歌会落到两组不同文件。

### 3. ⚠️ 自查发现并修掉的两个真实缺陷（**底账未覆盖**）

**(a) 扩展名「写入猜、查询不知道」—— 会导致缓存永不命中**

写入时扩展名从下载 URL 猜（`guess_ext`），而查询时手里只有 `provider + id + quality`，
**没有 URL**。若查询固定按 `.mp3` 找，那么「写入用了 flac、查询找 mp3」永远查不到。

-否决方案 (a)：固定扩展名（一律 `.mp3`）→会把 flac 命名成 mp3，浏览器按扩展名挑解码器，直接播不出来。
- 采用方案 (b)：`cache_store::lookup_entry` 按候选列表 `AUDIO_EXTS` 逐个探测，代价 ≤7 次 `metadata` 系统调用。

**且判据必须是「存在 _且_ 未过期」**：同一 key 可能同时留下多个扩展名的文件
（先下载到无扩展名 URL 存成 `.mp3`，后来下载到真 flac 存成 `.flac`）。
若只看「存在」，排在前面那个**已过期**的文件会挡住后面那个仍然新鲜的 ⇒ 缓存明明还在却一直回源。

`AUDIO_EXTS` 是写入与查询之间的**唯一契约**，加格式时必须两处同步（已在注释中标注）。

**(b) 空 id 进单飞会把无关请求串行化**

初版对空 `stable_id` 也取了单飞锁，key恒为 `provider:lyric:`。单飞表以 key 为键，
于是「所有空 id 的请求」挤在同一把锁上，本可并行的多个请求被串行化。
修正：空 id 时**既不缓存也不进单飞**（`lyric_cache.rs`）。

### 4. 原子写：`.part` → `rename`

`.part` 是「半截文件绝不视为命中」的物理载体。同目录 `rename` 在 POSIX 与 Windows 上都是原子的，
读者要么看到完整文件、要么看不到。
Windows 上 `rename` 不覆盖已存在目标，故先 `remove_file` 再 `rename`（删失败即放弃本次缓存，不外抛）。

### 5. TTL 与 LRU 合成一套（都用 mtime）

- TTL：歌词 30 天 / 音频 7 天，按 `metadata.modified()`。
- LRU：容量超限时按 mtime 升序删到限额内（歌词 100MB / 音频 1GB，**全局兜底不分平台**）。

**不做「每次命中都 touch」**：读一次歌词就刷一次 mtime，在机械硬盘上是每秒上千次无意义写入。
折中：只有 mtime 已「老到会被误淘汰」（阈值 `TTL / 8`）时才刷新 —— 既保证热听的歌不被删，
又把写放大压到极低。

**清理只挂在写路径**，不挂读路径：清理要遍历目录读每个文件的 mtime，挂读路径会让每次播放付一次全盘 stat。
代价是「长期不写缓存时不会清理」，但那时数据也还在 TTL 内，无害。

### 6. 僵尸 `.part` 用 1 小时门槛，不用「立刻删」

单飞锁保证同 key 不会有两个下载者，但挡不住「不同 key 的两个下载同时在跑」。
立刻删 `.part` 会把别人正在进行的下载打断，故只删超过 1 小时的。

### 7. `provider` / 扩展名走白名单（安全）

`provider` 与扩展名都来自前端 invoke 的字符串参数，是**不可信输入**。
只过滤 `/` 与 `..` 不够（`\0`、`:` 在 Windows 上有保留语义），故用白名单：
`[a-z0-9_-]{1,24}` / `[a-z0-9]{1,8}`。
非法 `provider` 的处理是**什么都不删**（`clear` 里直接 `return`）——
绝不因为一个脏字符串把整个缓存清空。

### 8. 单飞用 `Weak` 而非 `Arc` + 手动 remove

`Arc` 需要显式 remove 才不泄漏条目，而 remove 要在守卫 `Drop` 里做异步加锁（`Drop` 不能 await），
得再 spawn 一个任务。`Weak` 让条目**随最后一个持有者自动失效**，下一次取锁顺手 `retain` 掉死条目，零泄漏。

### 9. `clear` 保留目录（底账⑥ 那个边界）

底账指出 `open_path` 先判 `p.exists()`，目录被删会导致设置页「打开缓存目录」按钮报错 ——
「刚做完的操作让自己的按钮坏了」。故 `clear` 只删**目录内容**，根目录与平台目录都保留。
`CacheStats.root` 直接给出绝对路径（前端自己拼在 macOS/Windows 上大概率对不上），为空串时禁用该按钮。

### 10. 空歌词**不写缓存**

源站对无歌词歌曲返回 200 + 空内容，而「空」也可能是这一次的网络/解析故障。
缓存 30 天 ⇒ 用户刚修好的网络也换不回歌词，且**没有任何补救入口**。
不缓存的代价只是每首歌多回源一次 —— 相比「永久空歌词」小得多。
（`translation` 非空时视为有内容，因为前端会显示翻译。）

### 11. 歌词缓存坏文件**读时删除**

解析失败时删掉坏文件。否则每次播放都走「读文件 → 解析失败 → 回源」这条永远失败的路径，
且永远命中同一个坏文件。

### 12. 音频 key 含 quality，且只用请求档位

key = `{provider}:{stable_id}:{quality}`。漏掉 quality 是**功能性 bug 级**：
用户切档位后会命中上次文件，界面显示新档位、实际播旧码率，用户完全无法察觉。
`quality` 只能用 `state.playbackQuality`（5 值枚举），**绝不能用** `SongUrlResult.quality`/`.level`
（底账③ 已核实四平台值域互不相同：网易云 quality 是中文、QQ 是英文 label、咪咕 level 是 `PQ/SQ/ZQ`）。
空 `quality` **不默认成 `standard`** —— 那会让「参数传漏」静默命中标准音质，用户以为听到了高音质。

---

## 三、与底账不符 / 需澄清之处

> ⚠️ **1. 底账建议的落点是单文件 `cache.rs`，实际拆成了三个文件。**
> 底账「建议新增的 Rust 模块落点」写的是 `app/src-tauri/src/music/cache.rs`。
> 本次按交付要求拆为 `cache_store.rs`（内核）+ `lyric_cache.rs` + `audio_cache.rs` 三层。
> 理由：音频层要含 4 个 `#[tauri::command]`、歌词层要含泛型回源闭包，
> 塞进一个文件会让「内核」与「命令」耦合，且歌词/音频的缓存 key 语义差异大到需要各自的模块级注释。
> 底账「不要塞进 `mod.rs`」的判断是对的，已遵守。

> ⚠️ **2. 底账「我没能核实的项」第 3 条（axum `with_state`）本轮不适用。**
> 本轮采用方案 C（命令侧查缓存），`start_audio_proxy` 签名与 `audio_proxy.rs` 完全未变，
> 不需要 `with_state`，该未核实项仍然挂着。

> ⚠️ **3. 底账未预见「扩展名写入/查询不对称」这个坑（见上文 3(a)）。**
> 底账给的接入方案里，查询侧没有这一步。这是本轮实施中发现的、
> 会让音频缓存**静默永不命中**的缺陷，必须在后续音频接线时知晓。

> ⚠️ **4. 底账未提及 `CacheStats` 的字段设计。**
> 底账只写 `{ total, providers: {...} }`。本次额外给了 `root`（解决 ⑥ 的「打开目录」边界）、
> `lyric_bytes` / `audio_bytes`（设置页要分别显示两类占用）、`limit_lyric` / `limit_audio`
> （让前端不写死容量常量，与 `QUALITY_OPTIONS` 同样的纪律）。
> `providers` 的四个键**恒定存在**，无缓存时值为 0 而非缺键 —— 前端可省掉判空。

> ⚠️ **5. 底账第 8 条「新命令零断言覆盖」依然成立，本轮未补断言。**
> `music-platform-check.mjs` 只判「冻结清单里的命令必须存在」，新增 4 个命令不会让它变红。
> 补断言属于脚本侧工作，不在本轮交付范围（且改动 `scripts/` 会与另一会话的检查结果混淆）。**建议后续单独排。**

> ⚠️ **6. `check:music` 有 1 条**既有**红、`check:docs` 有 2 条红，均非本轮引入。**
> `ISLANDV.toggleBothWays` 要求切换图标是 `<Play>`，而基线 commit `eb3fd1f`
> （另一个会话的图标改造）已把它改成 `<AudioLines`，于是该断言失败；
> 连带 `check:docs` 的「AGENTS/README 声明 184 条 vs 脚本实际 183 条」不一致。
> 已用 `git show HEAD` 核实是基线自带，**不是缓存改动造成的**。
> 按纪律未为了转绿去放宽断言，也未碰 `DynamicIsland.tsx`。

---

## 四、前端 / 设置页需要注意的契约

### 1. 歌词侧：前端零改动

四个命令返回值与语义都没变（仍是 `Result<Lyrics, String>`），
`loadLyrics` / `platform.lyric()` / `ipc.ts` 的 4 个封装**一个字都不用改**。

唯一变化：Rust 侧 `music_lyric` 与 `kugou_lyric` 的签名多了 `app: AppHandle`。
前端**不传 app** —— Tauri 为 `AppHandle` 实现专用 `CommandArg`，从 invoke 消息解析、不读 payload
（底账① 已取证，且 `qq_lyric` / `migu_lyric` 本来就带 app 而前端没传却正常工作）。
反向也无害：宏只为 Rust 声明过的形参生成 `payload.get(key)`，前端多传的键根本不会被读取。

### 2. 音频侧新增 4 个命令（前端尚未接线）

```ts
// 1) 查本地整首缓存
music_audio_cached({ provider, id, quality }) → Promise<string | null>
//    命中返回**绝对路径**，未命中返回 null（Option::None 序列化为 null）

// 2) 整首下载落盘（可选，用于预热）
music_cache_download({ provider, id, quality, url }) → Promise<string | null>
//    成功返回绝对路径；任何失败返回 null

// 3) 统计
music_cache_stats() → Promise<CacheStats>

// 4) 清理，provider 为 null/undefined ⇒ 全清
music_cache_clear({ provider: string | null }) → Promise<void>
```

`CacheStats` 形状：

```ts
{
  total: number;              // 全部平台合计字节
  lyric_bytes: number;
  audio_bytes: number;
  root: string;               // 缓存根目录绝对路径；为空串时禁用「打开目录」
  limit_lyric: number;        // 100MB
  limit_audio: number;        // 1GB
  providers: {                // 四个键恒存在，无缓存为 0
    netease:  { lyric_bytes: number; audio_bytes: number };
    qqmusic:  { ... };
    kugou:    { ... };
    migu:     { ... };
  };
}
```

### 3. ⚠️ 音频接线的三个硬要求（**功能性 bug 级别**）

**(a) `quality` 必须传 `state.playbackQuality`，不能传 `r.quality` / `r.level`。**
查缓存发生在 `songUrl()` 之前，那一刻只有请求档位已知；四平台的返回值字段值域互不相同，
拿它们当 key 会导致同一首歌每次 key 都不同、**缓存永不命中**（且不报错）。

**(b) `quality` 不能为空。** 空值会被判为「无法寻址」→ 永远不命中（这是刻意的：
宁可不下缓存，也不能猜错音质）。

**(c) 建议的调用位置**：`store.ts` 的 `resolveOnlineUrl` 里，
在 `platform.songUrl()` **之前**查 `music_audio_cached`；命中则直接用本地路径，
不再请求 `songUrl`，自然也不会降级 —— 降级回来的那一档会在磁盘上各占一份文件，这是可接受代价。

### 4. ⚠️ 本地文件播放的前提

命中返回的是**绝对路径**，交给 `<audio>` 需要经 Tauri 的 `convertFileSrc`
（`protocol-asset` feature 已在 `Cargo.toml` 启用）。若走 `file://` 直连会被跨源策略挡住。

### 5. 设置页接线时注意

- **「打开目录」用 `openPath(stats.root)`**：目录在清空后仍然存在（`clear` 只删内容），
  所以按钮不会因为「刚清完」而报错。`root` 为空串时应禁用该按钮。
- **新命令当前零断言覆盖**（底账第 8 条），`check:music` 不会因漏接线而变红 —— 需主动补断言与反证。
- **若要 catalog 化**（③ 组新增「音乐缓存」项），底账⑤ 已论证当前结构下
  「不复用普通设置项模板」做不到，需在甲/乙/丙三方案中拍板，
  且加项要同步 6 处（含 `AGENTS.md` / `README.md` 的「72 条」→「74 条」）。
- **缓存清理无二次确认组件可复用**（底账⑤）：`QuitConfirm` 文案是契约冻结字面量，
  新组件放 `screens/settings/`，**不能**放 `components/units/`（MANIFEST 锁死 11 个文件）。
- 样式类名**别带 `music-` 前缀**（`settings.scss` 禁该前缀）。

### 6. 歌词缓存 key 的逐平台对照（供后续核对）

| 平台 | 缓存 key 用 | 备注 |
|---|---|---|
| 网易云 | `song.id` | |
| 酷狗 | `hash`（= 前端 `song.hash \|\| song.id`） | ⚠️ 空 hash 会导致**不缓存**（见下） |
| QQ | `mid` 优先，空则回落 `song.id` | Rust 侧用 `is_empty` 判断，与前端 `??` 语义对齐 |
| 咪咕 | `copyright_id`（= `Song.id`） | ⚠️ **不是** `content_id` |

**⚠️ 酷狗空 hash 隐患（已在代码注释里写清）**：`kugou.rs` 会把空 hash 序列化成 `Some("")`，
而前端 `platform.ts` 用 `??`（只对 `null`/`undefined` 回落）⇒ 空串原样传下来。
若照抄那个写法做 key，所有空 hash 的酷狗歌会共用一个 `kugou:` key，
表现为「A 歌的歌词出现在 B 歌上」且**用户几乎不可能察觉**。
本层的兜底是「空 id ⇒ 既不读也不写缓存」（Rust 侧拿不到 `song.id`，命令签名只收 `hash`，
唯一正确做法就是不缓存）。建议后续把前端 `platform.ts:415` 的 `??` 改成 `||`，
但 Rust 侧的兜底必须留着 —— 前端那一改只解决「参数」，不解决「别的调用方也可能传空串」。

---

## 五、验收结果

| 门 | 结果 |
|---|---|
| `cargo check` | ✅ 0 错误 0 警告 |
| `#[tauri::command]` 属性完好（逐文件回读） | ✅ 4 个新命令 + 4 个歌词命令均正常 |
| 禁词（被禁历史品牌标识，任何大小写） | ✅ 0 命中（已用 Grep 工具全 `src` 扫描） |
| Rust 侧双引号 | ✅ 全程 `"` |
| `git status --short` 干净 | ✅ 仅 6 个应改文件 + 底账 `docs/cache-contract-audit.md`（原有） |
| 歌词侧前端零改动 | ✅ |
| `audio_proxy.rs` 零改动 | ✅ |
| 未触碰 `atoms.tsx` / `SettingsScreen.tsx` / `settings/icons.tsx` | ✅ |
| 未执行 commit / stash / checkout | ✅ |

项目自带检查：`check:settings` **72/72 全绿**；`check:music` 183 通过 1 失败、
`check:docs` 12 通过 2 失败 —— 三条红**均为基线 `eb3fd1f` 图标改造自带**，已用 `git show` 取证，
非本轮引入，未为转绿放宽任何断言。