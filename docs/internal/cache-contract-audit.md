# 《09》§5.7 实施底账 · 只读核实报告

> 核实时间：2026-10-05　范围：`music-cache` 落地前必须知道的 6 组实施事实
> 方法：逐文件回读当前工作区代码，所有结论均带 `文件:行号`。**未修改任何文件**（只跑了 `check:settings` 正向轮，它只读源文件）。
> 判「有没有」一律用专用搜索工具（`Grep`/`Glob`），未用 shell `grep` 判存在性 —— 本机 zsh + BSD grep 在 `\|` / `--include` 上会静默失配（AGENTS.md §5 已记录该陷阱）。

---

## ① 前端 invoke 歌词命令的传参方式

### 实际代码行（逐平台）

四个封装**全部是对象传参**，键名与 Rust 侧形参逐字对齐（snake_case）：

`src/music/ipc.ts:66`（网易云）
```ts
export const musicLyric = (id: string) => invoke<Lyrics>('music_lyric', { id });
```

`src/music/ipc.ts:139-140`（酷狗）
```ts
export const kugouLyric = (hash: string, albumAudioId?: string, duration?: number) =>
  invoke<Lyrics>('kugou_lyric', { hash, album_audio_id: albumAudioId ?? null, duration: duration ?? null });
```

`src/music/ipc.ts:176-177`（QQ）
```ts
export const qqLyric = (mid: string, id?: string) =>
  invoke<Lyrics>('qq_lyric', { mid, id: id ?? null });
```

`src/music/ipc.ts:229-230`（咪咕）
```ts
export const miguLyric = (contentId: string, copyrightId: string) =>
  invoke<Lyrics>('migu_lyric', { content_id: contentId, copyright_id: copyrightId });
```

**关键取证**：QQ 与咪咕的 Rust 签名**已经带 `app: AppHandle`**（`music/mod.rs:405`、`music/mod.rs:549`），而上面两处前端封装**一个字都没传 `app`** —— 这两个命令在真机上正常工作。所以「前端不传 app 也能工作」不是推测，是**已在运行的既成事实**。

### Tauri v2 对多余/缺失参数的实际行为（读源码确认，不靠经验）

- `AppHandle` 走的是**专用 `CommandArg` 实现**，完全不看 payload：
  `tauri-2.12.1/src/app.rs:487-492`
  ```rust
  impl<'de, R: Runtime> CommandArg<'de, R> for AppHandle<R> {
      fn from_command(command: CommandItem<'de, R>) -> std::result::Result<Self, InvokeError> {
          Ok(command.message.webview().app_handle)
      }
  }
  ```
- 该 trait 的文档注释写得很直白（`tauri-2.12.1/src/ipc/command.rs:64-65`）：
  > *Note that the types above are resolved from the command message and not from the command arguments sent by the frontend, so they **do not need to be provided on the JavaScript side**.*

- 反向（前端多传键）同样无害：宏只为 Rust 声明过的形参生成 `payload.get(key)`（`tauri-codegen-2.7.1/src/command/wrapper.rs:515-523`），未声明的键**根本不会被读取**，也就不会报错。

### 结论

- **加 `app: AppHandle` 参数是安全的**，对 `music_lyric`（`mod.rs:155`）与 `kugou_lyric`（`mod.rs:299`）都一样。
- **前端不需要同步改动**，`ipc.ts` 的 4 个歌词封装与 `platform.ts` 的 `lyric()` 派发（`platform.ts:411-423`）一个字都不用改。
- 顺带一条：`music-platform-check.mjs` 的 `IPC.<platform>` 组（`:447-454`）判据是「冻结清单里的命令名必须出现在 `ipc.ts`」，新增缓存命令**不会**让它变红；但也意味着**新命令天然零覆盖**，要主动补断言（见末节）。

---

## ② Song 各平台的稳定 id 字段

### `Song` 接口（`src/music/types.ts:9-38`）

```ts
export interface Song {
  provider: string;
  id: string;
  mid?: string;
  media_mid?: string;
  ...
  // === 酷狗扩展字段 ===
  hash?: string;
  album_id?: string;
  album_audio_id?: string;
  hq_hash?: string;  sq_hash?: string;  res_hash?: string;
  // === QQ 音乐扩展字段 ===
  qq_song_id?: number;
  // === 咪咕扩展字段（id 存 copyrightId，播放用 contentId）===
  content_id?: string;
  ...
}
```

### 四平台稳定 id 逐个查清（含 Rust 侧赋值点）

| 平台 | 缓存 key 应用哪个 | 依据 | 备注 |
|---|---|---|---|
| **网易云** | `song.id` | Rust 赋值 `mod.rs:24` 直接收前端 id；`Song.id` 无扩展 | 唯一标识 |
| **酷狗** | `song.hash ?? song.id` | `platform.ts:415`；`kugou.rs:995` `id: if !hash.is_empty() { hash }else if !mix_song_id…{ album_audio_id }` | ⚠️ 见下方陷阱 |
| **QQ** | `song.mid ?? song.id`（`mid` 优先） | `platform.ts:417` `ipc.qqLyric(song.mid ?? song.id, song.id)` | `song.id` 是**数字 songid 的字符串**（`qqmusic.rs:465-473`：`songid` → `as_i64().map(to_string)`）；`mid` 是 `songMID` 字符串 |
| **咪咕** | `song.id`（= copyrightId） | `migu.rs:274` `id: copyright_id`；`platform.ts:419` `ipc.miguLyric(song.content_id ?? song.id, song.id)` | `content_id` 是**另一个**参数，不是主键 |

### `loadLyrics` 的分派 —— 实际代码

`src/music/store.ts:2505-2531`（**注意：store 不直接分派**）
```ts
loadLyrics: async (song) => {
  try {
    let lines: ParsedLyricLine[] = [];
    if (song._localPath) {
      const raw = await ipc.getLocalLyric(song._localPath);
      lines = parseLrc(raw);
    } else {
      const l = await platform.lyric(song.provider as MusicProvider, song);
      lines = l.yrc ? parseYrc(l.yrc) : parseLrc(l.lyric || '');
      if (l.yrc && lines.length === 0) lines = parseLrc(l.lyric || '');
    }
    if (get().currentSong && songKey(get().currentSong as Song) !== songKey(song)) return;
    set({ parsedLyrics: lines });
  } catch { … }
  await get().pushLyricsState();
},
```

真正的分派在 `src/music/platform.ts:411-423`：
```ts
export function lyric(provider: MusicProvider, song: Song): Promise<Lyrics> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouLyric(song.hash ?? song.id, song.album_audio_id, Math.round(song.duration / 1000));
    case 'qqmusic':
      return ipc.qqLyric(song.mid ?? song.id, song.id);
    case 'migu':
      return ipc.miguLyric(song.content_id ?? song.id, song.id);
    default:
      return ipc.musicLyric(song.id);
  }
}
```

`songKey` 用的正是 `provider:id`（`store.ts:334-336`）：
```ts
export function songKey(s: Song): string { return `${s.provider}:${s.id}`; }
```

### 咪咕为什么有 content_id 和 copyright_id

不是「主键 + 备胎」，而是**同一个接口的必填两个查询参数**。`migu.rs:824-829`：
```rust
"https://app.c.nf.migu.cn/strategy/pc/listen/v2.0?contentId={content_id}&copyrightId={copyright_id}&scene=&netType=01&resourceType=2&toneFlag={tone_flag}"
```
`listen_url(cookie, uid, content_id, copyright_id, flag)` 两个都要（`migu.rs:872-889`）。映射来源 `migu.rs:177-180`：`copyrightId` 与 `contentId`（缺失时回落 `songId`）分别取。

**哪个是主键**：`Song.id` 存的是 **copyrightId**（`migu.rs:274`，types.ts:32 的注释也这么写）。所以缓存 key 用 `song.id`，`content_id` 只是请求参数。

> ⚠️ **文档与实际有一处需要澄清**：《09》§5.7③ 写「用稳定 id 而非 URL」，但没点明咪咕的「既有区分」是哪个。实测结论：**主键是 `Song.id`（= copyrightId）**，`content_id` 是附属参数。沿用现有区分不动 = key 用 `song.id`。这与 `platform.ts:419` 的实参顺序一致（第一个位置是 `content_id`，第二个是 `copyright_id`，别写反）。

### ⚠️ 酷狗的一个既有隐患（写 key 时会踩）

`kugou.rs:1005` 是 `hash: Some(hash.clone())` —— **空 hash 也会序列化成 `Some("")`**。而 `platform.ts:415` 用的是 `??`（只对 `null`/`undefined` 回落），所以 `song.hash` 为空串时**不会回落到 `song.id`**，会传空 hash 下去。缓存 key 若照抄 `song.hash ?? song.id` 这个写法，酷狗空 hash 的歌会全部撞到同一个 key（`kugou:`）。**建议 key 用 `song.hash || song.id`（逻辑或）而不是 `??`**，或先在 Rust 侧统一 `if hash.is_empty() { song.id }`。

---

## ③ 缓存 key 需要的 quality 值从哪来

### 档位枚举（全部 5 档）

`src/music/types.ts:165`
```ts
export type PlaybackQuality = 'jymaster' | 'hires' | 'lossless' | 'exhigh' | 'standard';
```

设置页选项表 `src/music/player-options.ts:57-63`
```ts
export const QUALITY_OPTIONS: { value: PlaybackQuality; label: string; desc: string }[] = [
  { value: 'standard', label: '标准', desc: '128k' },
  { value: 'exhigh',   label: '极高', desc: '999k' },
  { value: 'lossless', label: '无损', desc: '1411k' },
  { value: 'hires',    label: '高清臻音', desc: '1999k' },
  { value: 'jymaster', label: '超清母带', desc: 'SVIP 专属' },
];
```
**`value` 与枚举逐字同名**。默认 `'hires'`（`store.ts:1089`、水合处 `store.ts:1190`）。

### 请求侧 vs 返回侧 —— 这是缓存 key 的关键分界

`store.ts:980-1000` `resolveOnlineUrl` 的实际顺序：
```ts
const r = await platform.songUrl(provider, song, state.playbackQuality);   // :984
if (!r?.url) return '';
…
useMusicStore.setState({ currentQuality: r.quality || r.level || '' });     // :997
```

**结论：缓存 key 只能用「请求侧」的 `state.playbackQuality`（5 档枚举值），不能用返回值。**
理由：查缓存这个动作必须发生在 `platform.songUrl()` **之前**（命中就不回源），而那一步只有 `playbackQuality` 已知。

### 返回侧的 `quality`/`level` 各平台实际取值（为什么不能拿来当 key）

| 平台 | `level` | `quality` | 依据 |
|---|---|---|---|
| 网易云 | 英文档位 `hires`/`lossless`/… | **中文** label `高清臻音` | `netease.rs:403-404` `level: q.level.clone(), quality: q.label.clone()` |
| 酷狗 | 英文档位 | 英文档位（`level.clone()`，部分路径） | `kugou.rs:1613-1614`、`kugou.rs:1963-1964` |
| QQ | 英文档位 | **英文 label** `Hi-Res FLAC` | `qqmusic.rs:1188-1189`，label 来自 `models.rs:235-241` `QQ_QUALITY_TEMPLATES` |
| 咪咕 | **toneFlag** `PQ`/`HQ`/`SQ`/`ZQ` | 中文 `标准`/`高品质`/`无损`/`臻品` | `migu.rs:895-896` + `migu.rs:106-113` |

即：四平台的 `level`/`quality` **既不同名也不同值域**（咪咕的 `level` 甚至不是档位名而是 `PQ/SQ/ZQ`），只有 `state.playbackQuality` 是跨平台统一的 5 值枚举。

**降级时返回值会变，请求值不会** —— 网易云逐档降级（`netease.rs:373` `for q in &candidates`）、QQ 从模板位降级（`qqmusic.rs:1069-1072`）、咪咕换 toneFlag 重试（`migu.rs:880-885`，`message: "已降级为 {} 音质"`）。所以「用户选了 hires、实际拿到 exhigh」这种情形下，key 记的是 `hires` —— 这是**正确**的（下次仍是同一请求），代价是降级回来的那一档会各占一份文件。可接受，写在台账里即可。

> ⚠️ **文档需修正**：§5.7③ 只写「key 取 `{provider}:{id}:{quality}`」，未说明 `quality` 取**请求档位**而非 `SongUrlResult.quality/level`。若照字面理解去用返回值，咪咕会拿到 `PQ`/`ZQ` 这种非枚举值，四平台 key 值域不一致，断言与统计都会失真。

---

## ④ audio_proxy 如何拿到 AppHandle

### 现状签名与调用链

`src-tauri/src/music/audio_proxy.rs:88`
```rust
async fn audio_proxy(Query(query): Query<ProxyQuery>, headers: HeaderMap) -> Response {
```
`ProxyQuery` 只有一个字段（`:21-24`）：
```rust
#[derive(Deserialize)]
struct ProxyQuery { url: String, }
```
启动函数无参（`:195`）：`pub async fn start_audio_proxy() -> Result<u16, String>`，Router 构建在 `:202-204`。

**`start_audio_proxy` 的全部调用点（`Grep` 全仓，仅 2 处）**：
- `src-tauri/src/main.rs:221` —— 在 `tauri::async_runtime::spawn` 内，**同一个闭包里 `music_handle` 就是 AppHandle**（`main.rs:218-224`）：
  ```rust
  let music_handle = app.handle().clone();
  tauri::async_runtime::spawn(async move {
      music::init_cookie_cache(&music_handle).await;
      if let Err(e) = music::audio_proxy::start_audio_proxy().await { … }
  });
  ```
  → **AppHandle 在启动处可得，改签名传进去零成本。**
- `src-tauri/src/music/audio_proxy.rs:240` —— 在 `#[tauri::command] cmd_get_proxy_port` 内。该命令当前签名无 app（`:235`），**可以照 ① 的结论直接加 `app: AppHandle`**。

### axum 版本与 `with_state` 可用性

- `src-tauri/Cargo.toml:29`：`axum = "0.7"`；`Cargo.lock` 锁定 **0.7.9**。
- `Router::with_state` 在该版本**存在**：`axum-0.7.9/src/routing/mod.rs:370`
  ```rust
  pub fn with_state<S2>(self, state: S) -> Router<S2> {
  ```
- **项目里没有任何 `.with_state(` 既有用法**（`Grep` 确认，`Router::new` 只出现在 `audio_proxy.rs:202`）。所以「有没有先例可参考」的答案是：**没有，这是首例**。

### 三个可行方案（代价对比）

| 方案 | 做法 | 代价 |
|---|---|---|
| **A `OnceLock<AppHandle>` 全局**（与本文件既有风格一致：`HTTP_CLIENT`/`STREAM_CLIENT` 就是 `OnceLock`，`:16-17`） | 加 `static APP: OnceLock<AppHandle>`，`start_audio_proxy(app: &AppHandle)` 里 `set` | 最省事（3 行），但引入进程级全局可变状态；handler 里要处理 `get()` 拿不到的情况（静默降级为不缓存）。**测试时无法注入替身** |
| **B `Router::with_state(app)`**（推荐） | `start_audio_proxy(app: &AppHandle)` → `Router::new().route(...).with_state(app.clone())`，handler 签名加 `State(app): State<AppHandle>` | 状态有类型、可测、无全局；代价是 `audio_proxy.rs` 里 `use axum::extract::State`，且 `start_audio_proxy` 的两个调用点都要改传参（都拿得到 AppHandle，见上）。**项目首例，无先例可抄** |
| **C 只改启动签名，缓存逻辑放命令侧** | 音频缓存不做在代理里，而是新增 `music_audio_cached` 命令返回本地路径，命中则前端直接播本地文件 | 代理零改动，Range/206 逻辑完全不动（这是本文件最脆弱的部分，`tls-check` 还盯着）；代价是「边下边写」这条 P1 路线暂时做不了（`§5.7⑤` 方案 B/C 都要求代理参与） |

**推荐 B**（有类型、无全局、改动点只有 2 处调用 + handler 签名）。若只想尽快落 P0 歌词缓存，音频侧先走 C 也完全可行 —— 两者不冲突。

### ⚠️ 一个必须写进施工单的细节

`store.ts:1000` 构造的代理 URL 只有 `url` 一个 query：
```ts
return `http://127.0.0.1:${port}/audio?url=${encodeURIComponent(r.url)}`;
```
代理层要算缓存 key 必须**由前端把 key 一起传进去**（`&key=…` 或 `&provider=…&id=…&quality=…`）。好消息：`ProxyQuery` 只 `derive(Deserialize)` 而**没有** `deny_unknown_fields`，所以**加 query 参数不会破坏现有调用**（多出来的键被 serde 忽略）。前端只需在 `store.ts:1000` 一处补。

---

## ⑤ 设置页 ③ 组结构与条数常量

### `catalog.ts` 的 ③ 组结构

字段定义：`id` / `label` / `state` / `why?` / `def?`（`catalog.ts:40-60`），**没有 `kind` 字段**：
```ts
export interface SettingItem {
  id: string; label: string; state: ItemState; why?: string; def?: string;
}
```
分组：`id` / `title`（`null` = 无小节）/ `items`（`catalog.ts:62-72`）。

③ `MEDIA` 共 **3 小节 / 10 项**（`catalog.ts:215-320`）：

| 小节 id | title | 项 |
|---|---|---|
| `playback` | 播放 | `quality` / `skin` / `dynamic-bg` / `disc-mode` |
| `lyrics` | 歌词 | `lyrics-size` / `lyrics-color` / `lyrics-window` / `lyrics-locked` |
| `vinyl` | 透明彩胶 | `vinyl-color-mode` / `vinyl-color` |

### `sections.tsx` 与 catalog 的对应关系

- `MediaSection`（`sections.tsx:229`）读 store（`:240-257`），`render` 按 `item.id` 做 `switch`（`:270`），**三小节全遍历**（`:409-411`）：
  ```tsx
  {MEDIA.groups.map((g) => (<Group key={g.id} group={g} render={render} />))}
  ```
- `Group`（`sections.tsx:30-48`）对每个 `live` 项**强制包一层 `Row`**：
  ```tsx
  if (item.state === 'pending' || !render) return <PendingRow key={item.id} item={item} />;
  return <Row key={item.id} item={item}>{render(item)}</Row>;
  ```
  `Row`（`parts.tsx:51-61`）是「标题在左 / 控件在右」的两栏骨架。

### 那个 `throw` 的**确切条件**

`sections.tsx:400-402`
```ts
default:
  throw new Error(`[settings] ③ 播放·媒体 有未接线的项：${item.id} —— catalog 与本组件不同步`);
```

触发条件（三个同时满足）：
1. 该项 `state === 'live'`（`pending` 项在 `Group` 里就走了 `PendingRow`，**不会进 `render`**）；
2. `MEDIA.groups` 被遍历到（即它确实在某个小节的 `items` 里）；
3. 它的 `id` 不在 `render` 的任何 `case` 里（现有 10 个 case：`quality` / `skin` / `dynamic-bg` / `disc-mode` / `lyrics-size` / `lyrics-color` / `lyrics-window` / `lyrics-locked` / `vinyl-color-mode` / `vinyl-color`，见 `:271,281,290,294,296,308,325,335,375,387`）。

另有第二道 fail-loud：`itemOf()`（`sections.tsx:23-27`）在 id 写错时抛 —— 但 `MediaSection` 走的是 `switch` 不走 `itemOf`，所以对本项只有上面那个 `default` 生效。

### 条数常量 31 的确切位置与算法

| 位置 | 内容 |
|---|---|
| `src/screens/settings/catalog.ts:429` | `export const SPEC_ITEM_TOTAL = 31;`（手写自校常量；`:437-442` 与算出来的 `SECTION_ITEM_TOTAL` 不一致时 `console.error`） |
| `e2e/settings-media-check.mjs:86` | `const SPEC_TOTAL = 31;`（注释在 `:85` 记着演进 26 → 29 → 31） |
| `settings-media-check.mjs:363-376` | `COUNT.total`：**真导入** `catalog.ts`（`:141-149` 的 `loadCatalog()` 用 `import(...?v=N)` 绕 ESM 缓存）后逐分组逐小节 `.reduce` 求和，与 `SPEC_TOTAL` 比 |
| `settings-media-check.mjs:377-390` | `COUNT.specMatches`：拿 `catalog.mod.SPEC_ITEM_TOTAL` 与实际合计互校（抓自校常量漂移） |

**加一项要同步的地方（缺任一即红）**：

1. `catalog.ts` 加 item → `COUNT.total` 变红（`SPEC_TOTAL` 仍是 31）
2. `catalog.ts:429` `SPEC_ITEM_TOTAL` 31 → 32
3. `settings-media-check.mjs:86` `SPEC_TOTAL` 31 → 32
4. **若新增了 live 项，还要往 `settings-media-check.mjs:68-79` 的 `ADDED` 数组加一条**（`{ id, label }`）——
   这一步会**连带自动多出 2 条断言**：`ADDED.<id>`（`:322-335`，查 `state==='live'` + label 一致）与 `WIRING.item.<id>`（`:404-432`，查 `sections.tsx` 里有产出控件的 `case`/取值点）。
   ⇒ **`check:settings` 条数会从 72 变 74**，`check:docs`（`docs-consistency-check.mjs:99-115`）会比对 `AGENTS.md:62` 与 `README.md:73` 里声明的「72 条」→ **必须同步改成 74**，否则报红。
5. `settings-media-check.mjs:625-626` 的反证锚点 `find: 'export const SPEC_ITEM_TOTAL = 31;'` **也要改**，否则那条反证会退化成「锚点未找到 / 跳过」（脚本 `:750-752` 会打印 `⚠`，且 `:793` 把 `skipped` 计入失败）。
6. 若新项需要 store setter，还要加进 `MEDIA_SETTERS`（`:89-98`）与 `STORE_FIELDS`（`:101-108`）。

### ⚠️ 文档与实际不符：「不复用普通设置项模板」在现有结构里做不到

《09》§5.7⑦ 写「落点：`catalog.ts` 的 ③ 组 + `sections.tsx` 专用渲染（**不复用普通设置项模板**）」，并要求「四格（左右各两行）」。

但实测：`Group`（`sections.tsx:44`）对每个 live 项**无条件**包 `<Row>`，而 `Row`（`parts.tsx:53-58`）是固定的两栏（`.set-row-label` 左 / `.set-row-ctl` 右），`.set-row-ctl` 是**窄列**。四格布局塞不进右列。

三条出路（施工单要明确选一条）：
- **甲**：给 `SettingItem` 加一个形态字段（如 `layout: 'block'`），`Group` 见到它就不包 `Row`、直接渲染 children。**代价**：`SettingItem` 是全 5 组共用的类型，加字段要过 `units-structure-check` 的 `CALLERS.partsNoControls`（只禁控件，不禁字段，风险低）。
- **乙**：把「音乐缓存」做成**独立小节**（`groups` 里新增一项，1 个 item，`title: '缓存'`），`render` 里返回完整四格 div。**代价**：`SPEC_TOTAL` +1、`ADDED` 也要加、`ADDED.groups` 断言（`:336-346`）锁死了 `MEDIA.groups` 必须恰为 `['playback','lyrics','vinyl']` ⇒ **必须同步改 `MEDIA_GROUPS`（`settings-media-check.mjs:82`）**，否则 `ADDED.groups` 变红。
- **丙**：不 catalog 化，在 `MediaSection` 里手写四格块。**代价**：`COUNT.total` 仍红（合计对不上），且违反「项数单一事实源」这条本项目明写的纪律（`catalog.ts:6-8`）。**不推荐**。

### 有没有现成的「下拉 + 二次确认」可复用

**结论：都没有现成的，两个都要新写。**

| 需要的东西 | 现有最接近的 | 为什么不能直接复用 |
|---|---|---|
| 下拉 | `Select`（`components/units/Select.tsx`） | 它是**受控值选择器**（`value` + `options` + `onChange`，`Select.tsx:20-38`），语义是「在给定值里选一个」；缓存清除是**触发动作**（每项带各自的大小文案、点了就删），没有可回显的 `value`，且 `label` 是 `aria-label` 不是可见标题 |
| 二次确认 | `QuitConfirm`（`components/QuitConfirm.tsx:19`） | 文案与语义**硬编码为退出**：`QUIT_CONFIRM_COPY`（`:17`）是契约冻结字面量，标题写死「退出喵坞？」，且住在 `components/`（应用级）。改造成通用确认框会**触碰 `spec-check.ts:315-318` 的 B3 组字面量断言** |
| 弹层样式 | 有，可直接用 | `components.scss:435-470` 的 `.modal-mask` / `.modal` / `.modal-title` / `.modal-body` / `.modal-actions` 是**通用**的（`DesktopLyricsSettingsModal` 用的是自己那套 `music-dlset*`）。Esc 关闭用 `useEsc`（`hooks/useEsc.ts`） |

**新组件放哪（`check:units` 的硬约束）**：
- ❌ **不能放 `components/units/`** —— `units-structure-check.mjs:79-91` 的 `MANIFEST` 把 units 目录**锁死为 11 个文件**（`LAYOUT.files` 多一个即红，`:412-428`），且 `BARREL_EXPORTS`（`:93-104`）也锁死出口。
- ✅ **放 `screens/settings/`**（如 `CacheBlock.tsx`）—— 与屏内件 `parts.tsx` 同级，符合「只在设置页成立 → 留在该屏目录」的判据（`parts.tsx:17-22` 的原话）。
- ⚠️ 样式：`.set-` 前缀在 units 里被禁（`NAMING.noSet`，`:506-516`），但你写在 `settings.scss` 里是允许的；反之 `settings.scss` **禁** `.music-`/`.di-`/`.qt-`/`.lib-`/`.viewtab` 前缀（`:991`），别把类名起成 `music-cache-*`。

---

## ⑥ `ipc.ts` 现有封装风格

### 命名风格

- 一律 `export const <平台前缀><动作> = (...) => invoke<T>('rust_command_name', {...})`，**箭头函数 + 单表达式**（`music/ipc.ts:28-423` 全篇如此）。平台前缀：`musicXxx` / `kugouXxx` / `qqXxx` / `miguXxx`；无平台归属的用裸动词（`getProxyPort`、`openLyricsWindow`）。
- Rust 命令名是**字符串字面量逐字对齐**（snake_case），这一点被 `music-platform-check.mjs:447-454` 机器断言。
- 参数名与 Rust 形参逐字对齐（`platform.ts:12-13` 的文件头注释明确写了这条纪律）。

### 错误处理惯例

- **`ipc.ts` 里没有一层 try/catch** —— 全是裸 `invoke` 抛给调用方。这是明确的分层决定（`music/ipc.ts:5-6`：「这里只做类型化封装，不塞业务逻辑」）。
- 错误文案在**消费侧**拼：`store.ts:2545` `get().toast(\`桌面歌词窗口${…}失败：${String(e)}\`)`、`store.ts:1740` `get().toast('切换音质失败，已保持原音质')`。
- 静默忽略的写法：`store.ts:2577-2579`、`store.ts:2589-2591`（空 `catch {}` + 注释说明为什么可以吞）。
- 根 `ipc.ts` 另有 `isApiError` / `errorText`（`src/ipc.ts:34-42`）**只服务于 manga-service 的结构化错误信封**，音乐模块不用它。

### 类型声明位置

- **业务类型统一在 `src/music/types.ts`**，`ipc.ts` 用 `import type { … } from '@music/types'`（`music/ipc.ts:9-23`）。新增缓存相关类型（`CacheStats` 等）应放这里。
- **跨窗口协议类型就地定义在 `ipc.ts`**：`LyricsPushLine`（`:292`）、`DesktopLyricsPrefs`（`:308`）、`LyricsPushPayload`（`:319`）、`LyricsPrefsPayload`（`:363`）、`LyricsControlPayload`（`:383`）—— 带大段「为什么这么定」的注释，是本文件的既有风格。

### `openPath` 的确切签名

`src/ipc.ts:78`
```ts
/** 在系统文件管理器里定位路径（契约 §5.8：reveal 由 Box 执行） */
export const openPath = (path: string) => invoke<void>('open_path', { path });
```
Rust 侧 `src-tauri/src/commands.rs:262-263`：
```rust
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() { return Err(format!("路径不存在：{path}")); }
    …
```

⚠️ **实施注意**：`open_path` **会先判存在**，不存在直接返回 `Err("路径不存在：…")`。清空全部缓存后若目录被整个删掉，「打开目录」会报错。缓存模块要么保证目录常在（清空只删文件不删目录），要么前端先 `music_cache_stats` 拿到路径再决定 —— 这是《09》§5.7⑦「打开目录」按钮的实际边界，文档没写。

现有调用点（`Grep` 确认 4 处）可作为用法范式：`App.tsx:108`、`App.tsx:148`、`LibraryScreen.tsx:324`
```ts
openPath(current.outputDir).catch((e: unknown) => onToast(errorText(e), 'bad'))
```

---

## 对 §5.7 施工单的影响

| # | 文档原施工项 | 需改成 | 依据 |
|---|---|---|---|
| 1 | 给 `music_lyric` / `kugou_lyric` 加 `app: AppHandle`，**并同步改前端** | **删除「同步改前端」这一步**。前端零改动。`AppHandle` 由框架从 invoke 消息解析（`tauri/src/app.rs:487-492`），不读 payload；QQ/咪咕已是这一形态且在真机工作（`mod.rs:405,549` vs `ipc.ts:176,229`） | ① |
| 2 | 缓存 key = `{provider}:{id}:{quality}` | 明确写成 **`{provider}:{stable_id}:{request_quality}`**，其中 `quality` = **`state.playbackQuality`（请求档位 5 值枚举）**，⛔ 不用 `SongUrlResult.quality` / `.level`（四平台值域不同：网易云 quality 是中文、QQ 是英文 label、咪咕 level 是 `PQ/SQ/ZQ`） | ③ |
| 3 | 「沿用现有 id 的既有区分不动」 | 写明：**咪咕主键 = `Song.id`（= copyrightId，`migu.rs:274`）**，`content_id` 只是 `listen_url` 的另一个必填参数（`migu.rs:829`），**别把 `platform.ts:419` 的两个实参顺序写反**。酷狗用 `song.hash \|\| song.id`（**逻辑或**，不是 `??` —— `kugou.rs:1005` 会把空 hash 序列化成 `Some("")`） | ② |
| 4 | 音频缓存：代理边下边写 | 新增前置步骤：**缓存 key 必须由前端随 query 传进代理**（`store.ts:1000` 拼 URL 处补 `&key=…`）。`ProxyQuery` 未加 `deny_unknown_fields`，加参数**不破坏**现有调用。同时确定 AppHandle 方案：**推荐 `Router::with_state`（`axum 0.7.9` 有该 API，`routing/mod.rs:370`；项目首例无先例）**，次选 `OnceLock<AppHandle>`（合本文件既有风格）。`start_audio_proxy` 的两个调用点都拿得到 AppHandle（`main.rs:218-221`、`audio_proxy.rs:235-240`，后者可直接加 `app: AppHandle`） | ④ |
| 5 | 设置页「音乐缓存」项：③ 组 + 专用渲染，**不复用普通设置项模板** | **这一条当前结构下做不到**：`Group` 对每个 live 项强制包 `Row`，`Row` 是固定两栏、右列窄（`sections.tsx:44` + `parts.tsx:53-58`）。须在三方案中拍板：甲（给 `SettingItem` 加形态字段）/ 乙（做成独立小节，**须同步改 `MEDIA_GROUPS`，`settings-media-check.mjs:82`**）/ 丙（不 catalog 化，违反项数单一事实源，不推荐） | ⑤ |
| 6 | 加项后须同步「该常量 + AGENTS.md + README.md」 | 补全为**6 处**：`catalog.ts:429`（31→32）、`settings-media-check.mjs:86`、`:625`（反证锚点，同步漏改会退化成「跳过」而非变红）、`settings-media-check.mjs:68-79` 的 `ADDED` 加一条、**`AGENTS.md:62` 与 `README.md:73` 的「72 条」→ 74**（`check:docs` 比对的是**断言条数**，不是 31） | ⑤ |
| 7 | 「打开目录」复用 `openPath` | 成立（`src/ipc.ts:78`），但**补一条边界**：`open_path` 先判 `p.exists()`，不存在返回 `Err`（`commands.rs:265-267`）。清空全部缓存若删了目录，这个按钮会报错 —— 要么只删文件不删目录，要么先查 stats | ⑥ |
| 8 | （文档未提）新命令零断言覆盖 | `music-platform-check.mjs:447-454` 只判「冻结清单里的命令必须存在」，**新增 `music_audio_cached` / `music_cache_stats` / `music_cache_clear` 不会让它变红，也就天然零覆盖**。按项目纪律须主动补断言（含反证） | ① |
| 9 | （文档未提）下拉与二次确认都要新写 | `Select` 是受控值选择器、`QuitConfirm` 文案是契约冻结字面量（`QuitConfirm.tsx:17`，`spec-check.ts:315-318` 的 B3 组盯着），**都不能复用**。新组件**放 `screens/settings/`**（不能放 `units/` —— `units-structure-check.mjs:79-91` 的 `MANIFEST` 锁死 11 个文件，多一个即红）；弹层样式可直接用 `.modal-*`（`components.scss:435-470`），Esc 用 `useEsc`。类名别带 `music-`（`settings.scss` 禁该前缀，`:991`） | ⑤ |
| 10 | （文档未提）「打开目录」按钮的可用性 | 拍板「某平台无缓存时怎么显示」的同时要定：全部缓存为 0 时「打开目录」是否置灰（无缓存就没有目录）—— 与 §5.7 那个「尚未拍板」项是同一个决策 | ⑥ |

### 建议新增的 Rust 模块落点

`music-cache` 相关代码建议新建 `src-tauri/src/music/cache.rs`（与 `local.rs` 同级），在 `music/mod.rs:1-9` 加 `pub mod cache;`，命令在 `main.rs:184` 附近（`audio_proxy::cmd_get_proxy_port` 之后）注册。**不要**塞进 `mod.rs` —— 那里已有 1500+ 行且混着四平台命令。

---

## 我没能核实的项

1. **QQ 音乐 `song.id` 与 `song.mid` 在真实接口下的稳定性差异** —— 我只能确认赋值逻辑（`qqmusic.rs:465-473`、`483`）和消费点（`platform.ts:417,438`），**没有真机数据**证明 `mid` 在所有列表接口（搜索 / 歌单 / 榜单 / 心动模式）下都非空。缓存 key 若只用 `mid`，理论上存在回落到 `song.id`（数字 songid）的情况 —— 两者混用会导致同一首歌偶发两种 key。**建议真机验证或改用 `song.id`（数字 songid 唯一性更高）**。
2. **酷狗空 hash 的实际发生率** —— 我确认了 `kugou.rs:1005` 会把空 hash 写成 `Some("")`、且 `platform.ts:415` 的 `??` 不会回落，但**没有真机样本**证明这条路径在四个酷狗接口上真的被走到。若实际不发生，`||` 与 `??` 等价。
3. **axum 0.7 `with_state` 在本项目 tokio 运行时下的实际行为** —— API 存在已由源码确认（`routing/mod.rs:370`），但**没有编译/运行验证**（本次只读，未跑 `cargo build`）。`AppHandle` 满足 `Clone + Send + Sync + 'static`，理论上可行，仍建议实施时先编译一次。
4. **法务结论（§5.7⑩ / 待确认项 9：音频落盘是否允许）** —— 不在代码里，无法核实。这是 P1 的前置闸，文档已标「待法务确认」，本报告不改变该状态。
5. **`§5.7⑤` 三方案的取舍（听完整才命中 / 前缀命中 / 后台下载）** —— 属产品决策，且文档已建议先按 A 实施。本报告只补一条实施事实：A 方案下 `Range` 请求会让代理侧文件不完整（`audio_proxy.rs:104-108` 直接透传 `Range` 头，无内部状态），因此「完整性判定」需要代理自己维护已写长度，**不能靠 `Content-Length` 单次判断** —— 这一点文档的三方案表里没写透。
6. **`.trae/rules/project_rules.md` 里是否也声明了 `check:settings` 条数** —— `docs-consistency-check.mjs:43` 的 `DOCS` 包含该文件，我按 `Grep` 未在其中命中「check:settings … N 条」（`AGENTS.md:62`、`README.md:73` 命中）。若该文件由外部同步维护，加项后需一并核对 —— 我无法确认它是否总与本仓同步。
