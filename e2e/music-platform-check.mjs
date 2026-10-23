#!/usr/bin/env node
/**
 * 音乐模块「四平台完整接通」验收断言（除汽水外）—— 且必须**可反证**。
 *
 * 为什么需要它（D-20「每层都要断言」+ D-31「假阳性比没测试更危险」）：
 *
 *   一条「四平台接通」的改动横跨五层：
 *     RUST     src-tauri/src/music/mod.rs 定义 + commands/mod.rs 的 generate_handler! 注册
 *     IPC      src/modules/music/ipc.ts 的 invoke('<command>') 封装
 *     PLATFORM src/modules/music/platform.ts 的能力矩阵 + 派发分支
 *     STORE    src/modules/music/store.ts 的平台感知状态与 action
 *     UI       src/screens/MusicScreen.tsx + screens/music/* + styles/*.scss
 *
 *   这五层的静默失败各不相同、互不覆盖：
 *     · Rust 命令**定义了但漏注册** → 编译全绿，运行时才报 "command not found"。
 *     · IPC 封装的名字与 Rust 函数名**差一个字** → tsc 全绿（都是 string），运行时炸。
 *     · platform.ts 少了某平台的一个分支 → 只有那个平台悄悄失效，别的平台看不出来。
 *     · store 切换平台**忘了清空旧数据** → 界面残留上一个平台的榜单，像幽灵数据。
 *     · UI 的「滚轮纵向 → 横向」映射缺失 → 截图上「能看」，但鼠标滚不动。
 *
 *   只测最上面那层（比如"文件里有 PLATFORMS"）等于没测。本脚本逐层断言，
 *   并配一次可反证的破坏轮：破坏后对应断言**必须变红**，否则它测的不是它声称的东西。
 *
 * 用法：
 *   node e2e/music-platform-check.mjs            正向跑（期望 RUST/IPC/PLATFORM/STORE 全绿）
 *   node e2e/music-platform-check.mjs --refute   反证轮（破坏源文件 → 断言必须变红 → 恢复）
 *
 * 注意：UI 层由另一位同事并行重写，**尚未落地是已知真实缺口**。脚本对这一层
 * 不假绿 —— 缺片段就直接标 ✗ 并写明「UI 尚未落地/待负责人复核」，让负责人看得见。
 *
 * 禁止事项：本脚本刻意**不写出**某个历史品牌标识的字面量（见下方 BANNED 的拆分构造），
 * 因为该标识本身就在被 forbid 的清单里，脚本自身也不得命中它。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { readStyleSource } from './_styles-source.mjs';
import { cachedReadText, cachedReadBytes, overrideFile, clearOverrides } from './_file-cache.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = ROOT;

const F = {
  rustMod: path.join(APP, 'src-tauri', 'src', 'music', 'mod.rs'),
  rustModels: path.join(APP, 'src-tauri', 'src', 'music', 'models.rs'),
  rustRegistry: path.join(APP, 'src-tauri', 'src', 'commands', 'mod.rs'),
  ipc: path.join(APP, 'src', 'modules', 'music', 'ipc.ts'),
  platform: path.join(APP, 'src', 'modules', 'music', 'platform.ts'),
  store: path.join(APP, 'src', 'modules', 'music', 'store.ts'),
  // D-156：`store.ts` 的 action 段已按切片切到 `music/actions/*.ts`。
  // 变异锚按"这段实现现在住哪"落文件；`s.store` 则是「本体 + 全部切片」的拼接（见 loadSources）。
  actionsDir: path.join(APP, 'src', 'modules', 'music', 'actions'),
  // D-149：歌词解析纯函数已从 store.ts 抽到 tools/lyrics.ts；歌词判据读「store + lyrics」的拼接。
  lyrics: path.join(APP, 'src', 'tools', 'lyrics.ts'),
  // D-153：持久化（readLS/writeLS/快照/sanitize）已从 store.ts 抽到 music/persist.ts。
  persist: path.join(APP, 'src', 'modules', 'music', 'persist.ts'),
  types: path.join(APP, 'src', 'modules', 'music', 'types.ts'),
  // ── 桌面歌词（P3）──
  rustLyrics: path.join(APP, 'src-tauri', 'src', 'commands', 'lyrics_window.rs'),
  // ── M5 截图取证通道（2026-10-16：音乐屏与歌词窗纳入序列）──
  captureRs: path.join(APP, 'src-tauri', 'src', 'selftest', 'capture.rs'),
  captureMjs: path.join(APP, 'e2e', 'capture.mjs'),
  capabilities: path.join(APP, 'src-tauri', 'capabilities', 'default.json'),
  tauriConf: path.join(APP, 'src-tauri', 'tauri.conf.json'),
  cargoToml: path.join(APP, 'src-tauri', 'Cargo.toml'),
  viteConfig: path.join(APP, 'vite.config.ts'),
  lyricsHtml: path.join(APP, 'templates', 'lyrics.html'),
  desktopLyrics: path.join(APP, 'src', 'screens', 'lyrics', 'DesktopLyrics.tsx'),
  musicScreen: path.join(APP, 'src', 'screens', 'MusicScreen.tsx'),
  app: path.join(APP, 'src', 'App.tsx'),
  kernel: path.join(APP, 'src', 'components', 'MusicKernel.tsx'),
  island: path.join(APP, 'src', 'components', 'DynamicIsland.tsx'),
  audioGraph: path.join(APP, 'src', 'modules', 'music', 'audioGraph.ts'),
  playerBar: path.join(APP, 'src', 'screens', 'music', 'PlayerBar.tsx'),
  expanded: path.join(APP, 'src', 'screens', 'music', 'ExpandedPlayer.tsx'),
  // 逐字歌词渲染组件（逐字高亮任务新增）
  karaoke: path.join(APP, 'src', 'screens', 'music', 'KaraokeLyrics.tsx'),
  // 六皮肤专属模块（展开播放器换肤任务新增）
  coverColor: path.join(APP, 'src', 'hooks', 'useCoverColor.ts'),
  vinylDisc: path.join(APP, 'src', 'screens', 'music', 'VinylDisc.tsx'),
  spectrumScene: path.join(APP, 'src', 'screens', 'music', 'SpectrumScene.tsx'),
  // 音乐快捷键 hook（挂载点判据在 MusicKernel.tsx 上，本文件判键位与让位判据）
  hotkeys: path.join(APP, 'src', 'hooks', 'useMusicHotkeys.ts'),
  musicUiDir: path.join(APP, 'src', 'screens', 'music'),
  // ── 歌曲右键菜单（MENU 组）── 逐文件判定，避免"某个写法在别的文件里也有"造成假绿
  // 菜单机制已收口到通用单元 `ContextMenu`（D-142），故机制类判据判它、语义类判据判宿主。
  contextMenu: path.join(APP, 'src', 'components', 'units', 'ContextMenu.tsx'),
  songRowShared: path.join(APP, 'src', 'screens', 'music', 'shared.tsx'),
  queueDrawer: path.join(APP, 'src', 'screens', 'music', 'QueueDrawer.tsx'),
  // 播放模式循环按钮（"心动不可用时不显示该档"的 UI 落点，HEARTBEAT 组判它）
  playModeButton: path.join(APP, 'src', 'components', 'units', 'PlayModeButton.tsx'),
  leftPanel: path.join(APP, 'src', 'screens', 'music', 'LeftPanel.tsx'),
  rightPanel: path.join(APP, 'src', 'screens', 'music', 'RightPanel.tsx'),
  localView: path.join(APP, 'src', 'screens', 'music', 'LocalView.tsx'),
  historyView: path.join(APP, 'src', 'screens', 'music', 'HistoryView.tsx'),
  virtualList: path.join(APP, 'src', 'components', 'units', 'VirtualList.tsx'),
  // 断言读到的 `s.css` 是 `readStyleSource` 按 index.scss 顺序拼出的**全分片**文本。
  // 下面这个 musicScss **只给反证机制用** —— 它要按 file 路径临时改源文件。
  // 为什么反证全落在 music.scss：本组 9 条 css 反证的锚点（keyframes music-exp-* /
  // .music-exp 动画 / 队列抽屉 z-index / 右键菜单 z-index / 灵动岛退场时长 / 歌词
  // flex-shrink）经逐条核对**唯一**命中 music.scss，其余分片无同文本 —— 唯一性是
  // 反证能生效的前提，若同一文本在两个分片出现，改一个另一个仍在，断言就不会变红。
  musicScss: path.join(APP, 'src', 'styles', 'music.scss'),
  /** 播放动作切片：`togglePlay` 等入口，队列空态 toast 的判据落在这里 */
  musicActionsPlayback: path.join(APP, 'src', 'modules', 'music', 'actions', 'playback.ts'),
  // 右键菜单样式已收口到 components.scss 的 .ui-menu（D-142），反证要按 file 改它
  componentsScss: path.join(APP, 'src', 'styles', 'components.scss'),
  stylesDir: path.join(APP, 'src', 'styles'),
  srcDir: path.join(APP, 'src'),
  rustSrcDir: path.join(APP, 'src-tauri', 'src'),
};

/** 被 forbid 的历史品牌标识 —— 拆成字符数组再 join，确保本脚本源码里不出现该字面量 */
const BANNED = ['n', 'e', 'x', 'b', 'o', 'x'].join('');

// ── 冻结的契约：命令清单（负责人冻结，本脚本照抄，不改口径） ──────────────
const CONTRACT = {
  netease: [
    'music_search',
    'music_song_url',
    'music_login_status',
    'music_logout',
    'music_user_playlist',
    'music_playlist_tracks',
    'music_playlist_tracks_range',
    'music_playlist_detail',
    'music_likelist',
    'music_like',
    'music_playlist_subscribe',
    'music_lyric',
    'music_song_comments',
    'music_personalized',
    'music_recommend_songs',
    'music_recommend_resource',
    'music_artist_search',
    'music_playlist_search',
    'music_artist_songs',
    'music_intelligence_list',
  ],
  kugou: [
    'kugou_search',
    'kugou_song_url',
    'kugou_lyric',
    'kugou_login_status',
    'kugou_logout',
    'kugou_user_playlists',
    'kugou_playlist_tracks',
    'kugou_playlist_tracks_range',
    'kugou_rank_list',
    'kugou_rank_songs',
    'kugou_like_toggle',
    'kugou_liked_hashes',
    'kugou_artist_search',
    'kugou_playlist_search',
    'kugou_artist_songs',
    'kugou_guess_like',
  ],
  qqmusic: [
    'qq_search',
    'qq_song_url',
    'qq_lyric',
    'qq_login_status',
    'qq_logout',
    'qq_user_playlists',
    'qq_playlist_tracks',
    'qq_playlist_tracks_range',
    'qq_rank_list',
    'qq_rank_songs',
    'qq_like_toggle',
    'qq_liked_hashes',
    'qq_artist_search',
    'qq_playlist_search',
    'qq_artist_songs',
    'music_qq_recommend_playlists',
  ],
  migu: [
    'migu_search',
    'migu_song_url',
    'migu_lyric',
    'migu_login_status',
    'migu_logout',
    'migu_user_playlists',
    'migu_playlist_tracks',
    'migu_playlist_tracks_range',
    'migu_rank_list',
    'migu_rank_songs',
    'migu_recommend_playlists',
    'migu_playlist_search',
    'migu_artist_search',
    'migu_artist_songs',
  ],
  multi: ['music_get_login_statuses', 'music_switch_provider', 'music_get_playback_source', 'music_open_login_window'],
};
const PLATFORM_KEYS = ['netease', 'kugou', 'qqmusic', 'migu'];

/**
 * 音乐缓存的 4 条新命令（Rust `music/audio_cache.rs`，前端在 `ipc.ts` 封装）。
 *
 * ⚠️ 这份清单**独立于**上面的 `CONTRACT`：那份是负责人冻结的平台能力清单，
 * 它的判据是"命令名必须出现在 ipc.ts"，而缓存命令是后加的 —— 不进 `CONTRACT`
 * 就意味着漏接线不会让任何一条断言变红（这是本组存在的全部理由）。
 * 所以这里单独列出，并在 `CACHE.ipcWrapped` 里**同时**判 Rust 侧命令注册表的注册。
 */
const CACHE_CMDS = ['music_audio_cached', 'music_cache_download', 'music_cache_stats', 'music_cache_clear'];

/** 派发函数 → 其函数体里**必须出现**的平台分支标识（netease 走 default 的用 netease 显式标注） */
const DISPATCH = {
  search: ['kugou', 'qqmusic', 'migu'],
  searchArtists: ['kugou', 'qqmusic', 'migu'],
  searchPlaylists: ['kugou', 'qqmusic', 'migu'],
  playlistTracks: ['kugou', 'qqmusic', 'migu'],
  playlistTracksRange: ['kugou', 'qqmusic', 'migu'],
  rankList: ['kugou', 'qqmusic', 'migu'],
  rankSongs: ['kugou', 'qqmusic', 'migu'],
  recommendPlaylists: ['netease', 'migu'],
  dailySongs: ['netease'],
  userPlaylists: ['kugou', 'qqmusic', 'migu'],
  loginStatus: ['kugou', 'qqmusic', 'migu'],
  logout: ['kugou', 'qqmusic', 'migu'],
  likedIds: ['kugou', 'qqmusic', 'migu'],
  likeToggle: ['kugou', 'qqmusic'],
  lyric: ['kugou', 'qqmusic', 'migu'],
  songUrl: ['kugou', 'qqmusic', 'migu'],
  openLoginWindow: ['musicOpenLoginWindow'], // 四平台统一委派，判据是调用了该 IPC
};

// ── 读文件 ───────────────────────────────────────────────────────────────
// 读文本统一折算成 LF：工作区是 CRLF（core.autocrlf=true），而断言里的多行锚点按 LF 写。
// 不折算 ⇒ `includes` / `occurrences` 恒不命中 ⇒ 判据长期"假红"（D-148 记过这个坑）。
// 只折"给断言看的文本"；反证轮改盘/还原走 readBytes（原样字节），两者互不影响。
const readMaybe = (p) => cachedReadText(p).replace(/\r\n/g, '\n');
const readBytes = cachedReadBytes;

/** 递归拼接某目录下所有指定后缀文件（缺目录 → 空串，不抛） */
function walkText(dir, exts) {
  if (!existsSync(dir)) return '';
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (exts.some((x) => e.name.endsWith(x))) out.push(readMaybe(p));
    }
  }
  return out.join('\n');
}

function loadSources() {
  // D-156：`store.ts` 的 action 段已按切片切到 `music/actions/*.ts`。判据的源统一为
  // 「store.ts + 全部切片」的**逐文件 strip 后拼接** —— 「方法在不在」「这段逻辑在不在」
  // 这类判据才不会因切片而假红。目录**动态列举** ⇒ 以后每切一段自动覆盖，不必改这里。
  // （逐文件 strip 再拼，不能拼原文：`stripComments` 带状态机，跨文件会失同步，见 D-148。）
  const ACTIONS = readdirSync(path.join(APP, 'src', 'modules', 'music', 'actions'))
    .filter((n) => n.endsWith('.ts'))
    .map((n) => path.join(APP, 'src', 'modules', 'music', 'actions', n));
  const SF = [F.store, ...ACTIONS]; // store 本体 + 全部切片
  const s = {
    rustMod: readMaybe(F.rustMod),
    rustRegistry: readMaybe(F.rustRegistry),
    ipc: readMaybe(F.ipc),
    platform: readMaybe(F.platform),
    store: SF.map((p) => stripComments(readMaybe(p))).join('\n'),
    /** `store.ts` 单文件原文（需要"只看 store 本体"的判据用；如 scope 类断言） */
    storeRaw: readMaybe(F.store),
    // 歌词判据的源：store 全量 + `tools/lyrics.ts`。
    storeLyrics: [...SF, F.lyrics].map((p) => stripComments(readMaybe(p))).join('\n'),
    // D-153：持久化判据的源（store 全量 + `music/persist.ts`，同样逐文件 strip 后拼）。
    storePersist: [...SF, F.persist].map((p) => stripComments(readMaybe(p))).join('\n'),
    types: readMaybe(F.types),
    rustLyrics: readMaybe(F.rustLyrics),
    captureRs: readMaybe(F.captureRs),
    captureMjs: readMaybe(F.captureMjs),
    capabilities: readMaybe(F.capabilities),
    tauriConf: readMaybe(F.tauriConf),
    cargoToml: readMaybe(F.cargoToml),
    viteConfig: readMaybe(F.viteConfig),
    lyricsHtml: readMaybe(F.lyricsHtml),
    desktopLyrics: readMaybe(F.desktopLyrics),
    musicScreen: readMaybe(F.musicScreen),
    app: readMaybe(F.app),
    kernel: readMaybe(F.kernel),
    island: readMaybe(F.island),
    audioGraph: readMaybe(F.audioGraph),
    // 全前端源码拼接：用于「某个调用只允许存在一处」型断言（如 createMediaElementSource）
    srcAll: walkText(F.srcDir, ['.ts', '.tsx']),
    playerBar: readMaybe(F.playerBar),
    expanded: readMaybe(F.expanded),
    karaoke: readMaybe(F.karaoke),
    coverColor: readMaybe(F.coverColor),
    vinylDisc: readMaybe(F.vinylDisc),
    spectrumScene: readMaybe(F.spectrumScene),
    hotkeys: readMaybe(F.hotkeys),
    // 全分片拼接（顺序 = index.scss 的 @use 顺序 = 层叠顺序），不是读单个 app.css
    css: readStyleSource(F.stylesDir),
    contextMenu: readMaybe(F.contextMenu),
    songRowShared: readMaybe(F.songRowShared),
    queueDrawer: readMaybe(F.queueDrawer),
    playModeButton: readMaybe(F.playModeButton),
    leftPanel: readMaybe(F.leftPanel),
    rightPanel: readMaybe(F.rightPanel),
    localView: readMaybe(F.localView),
    historyView: readMaybe(F.historyView),
  };
  s.musicUi = walkText(F.musicUiDir, ['.tsx', '.ts', '.css']);
  s.uiSource = [s.musicScreen, s.musicUi, s.css].join('\n');
  s.frontendAll = walkText(F.srcDir, ['.ts', '.tsx', '.css']);
  s.rustAll = walkText(F.rustSrcDir, ['.rs']);
  s.uiDirMissing = !existsSync(F.musicUiDir);
  return s;
}

// ── 小工具 ───────────────────────────────────────────────────────────────
const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 取 `export function <name>(...) {...}` 的函数体（花括号计数） */
function fnBody(src, name) {
  const m = new RegExp(`export function ${esc(name)}\\b`).exec(src);
  if (!m) return null;
  const start = src.indexOf('{', m.index);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 取 zustand store 里 `name: (…) => { … }` 的实现体（花括号计数）。
 *
 * ⚠️ 不能复用 fnBody：store 的 action 是对象方法属性，且文件里**先有类型声明**
 * （`switchPlaybackSource: (p) => Promise<void>;`）。判据必须要求 `=> {`，
 * 且取**最后一个**匹配（实现排在类型声明之后），否则会读到类型声明那段。
 */
function methodBody(src, name) {
  const re = new RegExp(`\\n\\s*${esc(name)}:\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`, 'g');
  const all = [...src.matchAll(re)];
  if (!all.length) return null;
  const m = all[all.length - 1];
  const start = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 判断 store 里某个 action **实现了**（而非只有类型声明）。
 *
 * ⚠️ 不能用全文词边界匹配：store.ts 顶部有一整段 interface 类型声明
 * （`toggleLike: (songId: string) => Promise<void>;`），词边界一样命中 →
 * 断言恒绿、「漏实现」测不到（本脚本第一版正是如此，被反证轮抓出假阳性）。
 * 实现体的形态是 `name: (…) => {`，故判据必须要求 `=> {` —— 类型声明以 `;` 结尾，不匹配。
 */
function hasMethodImpl(src, name) {
  return new RegExp(`\\n\\s*${esc(name)}:\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`).test(src);
}

/**
 * 取模块级 `[export] [async] function <name>(...) {...}` 的函数体（含未 export 的，如 resolveOnlineUrl）。
 * 与 fnBody 的区别：fnBody 只认 `export function`，而 resolveOnlineUrl 是模块内私有 async 函数。
 */
function fnBodyAny(src, name) {
  const m = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${esc(name)}\\s*\\(`).exec(src);
  if (!m) return null;
  const start = src.indexOf('{', m.index);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 取 `anchor` 之后**紧邻的 `{...}` 块**（按花括号配对），用于把判据限定在
 * 某个类型/接口**体内部**。
 *
 * ## 为什么需要
 *
 * 只判「字段名在文件里出现过」是这一类断言最常见的假绿来源：
 * 字段名会**复用**。本脚本第一次栽在这里 —— `CacheStats` 与
 * `CacheProviderStat` 都有 `audio_bytes`，把 `CacheStats.audio_bytes` 改错后，
 * "全文搜 `audio_bytes`" 仍能命中另一个接口里的同名字段 ⇒ 断言恒绿。
 * 只有把判据钉在**这一个块的体内**，改名才会真的变红。
 */
function braceBlock(src, anchor) {
  const at = src.indexOf(anchor);
  if (at < 0) return null;
  const open = src.indexOf('{', at + anchor.length);
  if (open < 0) return null;
  const end = matchBracket(src, open);
  return end < 0 ? null : src.slice(open + 1, end);
}

/** 第 occurrence（0 起）次出现 needle 的下标；不足则 -1 */
function nthIndex(src, needle, occurrence) {
  let from = 0;
  let idx = -1;
  for (let n = 0; n <= occurrence; n++) {
    idx = src.indexOf(needle, from);
    if (idx < 0) return -1;
    from = idx + needle.length;
  }
  return idx;
}

/** 从 `openIdx` 处的左括号开始配对，返回闭合括号下标（跳过字符串字面量）；找不到返回 -1 */
function matchBracket(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    // 跳过字符串：否则字面量里的括号会提前截断
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 取某次**函数调用的实参表**（按顶层逗号切分，跳过嵌套括号与字符串）。
 *
 * ## 为什么必须有这个辅助函数（本项目栽过 9 次的坑的正解）
 *
 * 「参数有没有传」这类判据，用正则写只有两种写法，**都不可靠**：
 *   · `fn(...quality)` —— 一旦调用改成多行/换顺序就假红；
 *   · `fn\([\s\S]*?quality\)` —— 跨语句匹配，会把**后面另一个调用**里的
 *     `quality` 算作本次的实参。于是「删掉 quality」这个破坏**不会变红**，
 *     而断言看着是绿的 —— 即 D-31 说的"该红没红"的假阳性。
 *
 * 括号配对 + 顶层逗号切分是唯一能把判据**钉死在单次调用**上的做法：
 * 它只看这一次调用的实参个数与内容，别的调用怎么改都不影响。
 */
function callArgs(src, callee, occurrence = 0) {
  const idx = nthIndex(src, callee + '(', occurrence);
  if (idx < 0) return null;
  const open = idx + callee.length;
  const end = matchBracket(src, open);
  if (end < 0) return null;
  const args = [];
  let depth = 0;
  let cur = '';
  for (let i = open + 1; i < end; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      cur += c;
      i++;
      while (i < end && src[i] !== q) {
        if (src[i] === '\\') {
          cur += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        cur += src[i];
        i++;
      }
      cur += q;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      cur += c;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      cur += c;
      continue;
    }
    if (c === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

/**
 * 取某次调用**闭合右括号之后**的那一小段文本（用于判"链式调用了什么"）。
 *
 * 为什么需要：`.catch()` 跟在**整个实参表之后**，而实参表里必然含嵌套调用
 * （如 `audioCacheId(provider, song)`），所以"调用点之后紧跟什么"不能用
 * `indexOf(callee + '(')` 取子串来判 —— 那样拿到的还是实参表内部，判据错位
 * （实测踩过：`.catch` 判据因此恒红）。这里做括号配对，精确落在闭合括号之后。
 */
function afterCall(src, callee, occurrence = 0, len = 48) {
  const idx = nthIndex(src, callee + '(', occurrence);
  if (idx < 0) return null;
  const end = matchBracket(src, idx + callee.length);
  if (end < 0) return null;
  return src.slice(end + 1, end + 1 + len);
}

/**
 * 取 **Rust** 函数体（配对花括号）。
 *
 * 为什么必须单独有一个：`methodBody` / `fnBodyAny` 只认 JS 的写法
 * （`name: (…) => {` / `function name(`），而 Rust 是 `fn name(args) -> T {`。
 * 拿 JS 取体器去取 Rust 会**恒返 null** → 断言恒红 ——
 * 比恒绿更隐蔽：反证轮里任何破坏都"变红"，看着 100% 覆盖，其实是空转。
 * 实测踩过：`LYRICS.coordUnit` 第一版就是用它取 Rust 函数体，结果正向红、反证假通过。
 */
function rustFnBody(src, name) {
  const m = new RegExp(`(?:^|\\n)\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+${esc(name)}\\s*[(<]`).exec(src);
  if (!m) return null;
  const start = src.indexOf('{', m.index);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 去掉行注释与块注释（带字符串状态机）——**判据必须先剥注释再匹配**。
 *
 * 本轮多处**注释里主动写出了被禁的写法**，直接扫全文会被注释喂成假绿或假红：
 *   · PlayerBar 注释写「不调 e.preventDefault()」→ 不剥注释，"不得出现 preventDefault" 会**误报**；
 *   · MusicScreen 注释写 `<audio>`、store/ExpandedPlayer 注释写 `setExpanded(false)`
 *     → 不剥注释，"已搬走/未直接调用"这些判据会**恒绿**（该红没红）。
 * 本仓库历史上正是栽在"注释让断言误判"上（D-31），故此处一律先剥。
 */
// 关键字之后的正则字面量（`return /re/`），末尾不是标识符但 `/` 仍是正则起始
const REGEX_KEYWORDS = /(?:return|typeof|instanceof|in|of|new|delete|void|do|else|yield|await|case)$/;

/** 判断代码态遇到的 `/` 是正则起始还是除号（除号跟随「值」，正则跟随「运算符/左括号」） */
function regexAllowed(codeSoFar, prevSig) {
  if (prevSig === '') return true;
  if (/[)\]\w$]/.test(prevSig)) return REGEX_KEYWORDS.test(codeSoFar.replace(/\s+$/, ''));
  return true;
}

function stripComments(src) {
  let out = '';
  let state = 'code';
  let prevSig = ''; // 代码态最近一个显著字符，供判别 `/` 是正则还是除号
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '*') {
        state = 'block';
        out += '  ';
        i++;
        continue;
      }
      if (c === '/' && c2 === '/') {
        state = 'line';
        out += '  ';
        i++;
        continue;
      }
      // 正则字面量：内部的引号/斜杠不参与字符串与注释判定，整段原样保留
      if (c === '/' && regexAllowed(out, prevSig)) {
        out += c;
        i++;
        let inClass = false;
        for (; i < src.length; i++) {
          const rc = src[i];
          if (rc === '\\') {
            out += rc + (src[i + 1] ?? '');
            i++;
            continue;
          }
          out += rc;
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) break;
          else if (rc === '\n') break; // 未闭合：按除号处理，不影响后续
        }
        prevSig = '/';
        continue;
      }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out += c;
      if (!/\s/.test(c)) prevSig = c;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') {
        state = 'code';
        out += '  ';
        i++;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += '\n';
        continue;
      }
      out += ' ';
      continue;
    }
    // 字符串内：转义后整体保留
    if (c === '\\') {
      out += c + (c2 ?? '');
      i++;
      continue;
    }
    if (state === 'sq' && c === "'") {
      state = 'code';
      prevSig = 'x';
    } else if (state === 'dq' && c === '"') {
      state = 'code';
      prevSig = 'x';
    } else if (state === 'tpl' && c === '`') {
      state = 'code';
      prevSig = 'x';
    }
    out += c;
  }
  return out;
}

/** 解析 PLATFORM_CAPS 里每个平台的能力布尔值 */
function parseCaps(src) {
  const start = src.indexOf('export const PLATFORM_CAPS');
  if (start < 0) return {};
  const end = src.indexOf('\n};', start);
  const block = src.slice(start, end < 0 ? src.length : end);
  const out = {};
  for (const plat of PLATFORM_KEYS) {
    const m = new RegExp(`\\b${plat}:\\s*\\{([^}]*)\\}`).exec(block);
    if (!m) continue;
    const caps = {};
    for (const cm of m[1].matchAll(/(\w+):\s*(true|false)/g)) caps[cm[1]] = cm[2] === 'true';
    out[plat] = caps;
  }
  return out;
}

const CAP_KEYS = [
  'charts',
  'chartGrid',
  'chartByName',
  'recommendPlaylists',
  'dailySongs',
  'comments',
  'likeWrite',
  'artistExtra',
];

// ── 断言表：每条 { id, group, run(s) -> {ok, detail} } ─────────────────────
const A = [];
const add = (id, group, run) => A.push({ id, group, run });
const UI_GAP = 'UI 尚未落地（src/screens/music/ 缺失或缺关键片段）/待负责人复核';

// ============================ RUST ============================
for (const [plat, cmds] of Object.entries(CONTRACT)) {
  add(`RUST.defined.${plat}`, 'RUST', (s) => {
    const missing = cmds.filter((c) => !new RegExp(`\\bfn\\s+${esc(c)}\\s*\\(`).test(s.rustMod));
    return { ok: missing.length === 0, detail: missing.length ? `mod.rs 未定义：${missing.join(', ')}` : '' };
  });
}
for (const [plat, cmds] of Object.entries(CONTRACT)) {
  add(`RUST.registered.${plat}`, 'RUST', (s) => {
    const missing = cmds.filter((c) => !new RegExp(`music::${esc(c)}\\s*,`).test(s.rustRegistry));
    return {
      ok: missing.length === 0,
      detail: missing.length ? `commands/mod.rs 的 generate_handler! 未注册：${missing.join(', ')}` : '',
    };
  });
}
add('RUST.noqishui', 'RUST', (s) => {
  // 汽水延后后不应有任何汽水命令：generate_handler! 块与 music/mod.rs 里都不得出现该标识
  const block = (() => {
    const i = s.rustRegistry.indexOf('generate_handler!');
    return i < 0 ? '' : s.rustRegistry.slice(i, s.rustRegistry.indexOf('])', i));
  })();
  const inHandler = /qishui/i.test(block);
  const inMod = new RegExp(`fn\\s+\\w*qishui\\w*`, 'i').test(s.rustMod);
  return {
    ok: !inHandler && !inMod,
    detail: inHandler ? 'generate_handler! 里出现了汽水命令' : inMod ? 'music/mod.rs 里出现了汽水命令定义' : '',
  };
});

// ============================ IPC ============================
add('IPC.import', 'IPC', (s) => ({
  ok: /from '@tauri-apps\/api\/core'/.test(s.ipc) && /\binvoke\b/.test(s.ipc),
  detail: "ipc.ts 应 import { invoke } from '@tauri-apps/api/core'",
}));
for (const [plat, cmds] of Object.entries(CONTRACT)) {
  add(`IPC.${plat}`, 'IPC', (s) => {
    const missing = cmds.filter((c) => !new RegExp(`['"]${esc(c)}['"]`).test(s.ipc));
    return {
      ok: missing.length === 0,
      detail: missing.length ? `ipc.ts 缺 invoke('<name>') 封装（命令名字符串逐字一致）：${missing.join(', ')}` : '',
    };
  });
}

// ============================ PLATFORM ============================
add('PLATFORM.list', 'PLATFORM', (s) => {
  const i = s.platform.indexOf('export const PLATFORMS');
  const j = s.platform.indexOf('\n];', i);
  const arr = i < 0 ? '' : s.platform.slice(i, j < 0 ? i + 800 : j);
  const ids = [...arr.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
  const exact = ids.length === 4 && PLATFORM_KEYS.every((k) => ids.includes(k));
  const hasBanned = ids.some((x) => x.toLowerCase() === BANNED);
  return {
    ok: exact && !hasBanned,
    detail: `实际：${ids.join(', ') || '(未解析到)'}；应恰为 ${PLATFORM_KEYS.join(', ')}，且不含汽水`,
  };
});
for (const [fn, ids] of Object.entries(DISPATCH)) {
  add(`PLATFORM.dispatch.${fn}`, 'PLATFORM', (s) => {
    const body = fnBody(s.platform, fn);
    if (body == null) return { ok: false, detail: `platform.ts 未定义派发函数 ${fn}` };
    const missing = ids.filter((id) => !body.includes(id));
    return {
      ok: missing.length === 0,
      detail: missing.length ? `${fn} 缺少分支：${missing.join(', ')}` : '',
    };
  });
}
add('PLATFORM.caps.present', 'PLATFORM', (s) => {
  const caps = parseCaps(s.platform);
  const missingPlat = PLATFORM_KEYS.filter((p) => !caps[p]);
  const missingKey = [];
  for (const p of PLATFORM_KEYS)
    if (caps[p]) for (const k of CAP_KEYS) if (!(k in caps[p])) missingKey.push(`${p}.${k}`);
  return {
    ok: missingPlat.length === 0 && missingKey.length === 0,
    detail: `缺平台：${missingPlat.join(', ') || '无'}；缺字段：${missingKey.join(', ') || '无'}`,
  };
});
const capCheck = (id, want) =>
  add(`PLATFORM.caps.${id}`, 'PLATFORM', (s) => {
    const caps = parseCaps(s.platform);
    const bad = [];
    for (const [k, v] of Object.entries(want)) {
      const got = caps[k.split('.')[0]]?.[k.split('.')[1]];
      if (got !== v) bad.push(`${k} 期望 ${v} 实为 ${got}`);
    }
    return { ok: bad.length === 0, detail: bad.join('；') };
  });
capCheck('comments', {
  'netease.comments': true,
  'kugou.comments': false,
  'qqmusic.comments': false,
  'migu.comments': false,
});
capCheck('chartGrid', { 'kugou.chartGrid': true, 'qqmusic.chartGrid': true, 'netease.chartGrid': false });
capCheck('chartByName', { 'migu.chartByName': true });
capCheck('dailySongs', {
  'netease.dailySongs': true,
  'kugou.dailySongs': false,
  'qqmusic.dailySongs': false,
  'migu.dailySongs': false,
});
capCheck('likeWrite', { 'qqmusic.likeWrite': false, 'migu.likeWrite': false });
add('PLATFORM.nobrand', 'PLATFORM', (s) => {
  const re = new RegExp(BANNED, 'i');
  const hitFront = re.test(s.frontendAll);
  const hitRust = re.test(s.rustAll);
  return {
    ok: !hitFront && !hitRust,
    detail: hitFront ? '前端源码命中被禁品牌标识' : hitRust ? 'Rust 源码命中被禁品牌标识' : '',
  };
});

// ============================ STORE ============================
for (const field of ['playbackSource', 'searchProvider', 'loginInfos', 'likedSongIds']) {
  add(`STORE.field.${field}`, 'STORE', (s) => ({
    ok: new RegExp(`\\b${esc(field)}\\b`).test(s.store),
    detail: `store.ts 缺状态字段 ${field}`,
  }));
}
add('STORE.actions', 'STORE', (s) => {
  const need = [
    'switchPlaybackSource',
    'setSearchProvider',
    'loadAllLoginStatuses',
    'loadLoginStatus',
    'loadCharts',
    'loadRecommend',
    'openRightChart',
    'openRightPlaylist',
    'openLeftPlaylist',
    'loadMoreLeft',
    'loadMoreRight',
    'loadLikedList',
    'toggleLike',
    'openLogin',
    'logoutFor',
  ];
  const missing = need.filter((n) => !hasMethodImpl(s.store, n));
  return { ok: missing.length === 0, detail: missing.length ? `store.ts 缺 action 实现：${missing.join(', ')}` : '' };
});
add('STORE.switchClears', 'STORE', (s) => {
  const body = methodBody(s.store, 'switchPlaybackSource');
  if (body == null) return { ok: false, detail: 'store.ts 未定义 switchPlaybackSource' };
  const need = ['officialCharts', 'recommendPlaylists', 'dailySongs'];
  const missing = need.filter((n) => !new RegExp(`${esc(n)}\\s*:\\s*\\[\\s*\\]`).test(body));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `switchPlaybackSource 未重置旧平台数据：${missing.join(', ')}` : '',
  };
});

// ============================ UI ============================
const uiNote = (s, extra) => `${UI_GAP}${extra ? '；' + extra : ''}${s.uiDirMissing ? '（目录确实不存在）' : ''}`;
add('UI.drawerAboveExpanded', 'UI', (s) => {
  // 播放队列的入口同时存在于**展开播放器内部**（右下角），而展开播放器是
  // `fixed z-index:70` 的整屏覆盖层 —— 抽屉若低于 70 就被整个盖住，
  // 用户点了「播放队列」什么都不会出现，**且不报任何错**（曾如此）。
  // 判据直接比两者的 z-index：改任何一个都要重新确认这个不等式。
  const css = stripComments(s.css ?? '');
  const pickZ = (sel) => {
    const m = css.match(new RegExp(sel + '\\s*\\{([^}]*)\\}'));
    if (!m) return null;
    const z = m[1].match(/z-index:\s*(\d+)/);
    return z ? Number(z[1]) : null;
  };
  const exp = pickZ('\\.music-exp');
  // 抽屉换成通用 `SideDrawer` 单元后，层级落在 `.ui-drawer-layer` 上（`.queue-drawer` 只管宽度与圆角）
  const drawer = pickZ('\\.ui-drawer-layer');
  if (exp === null || drawer === null)
    return { ok: false, detail: '未解析到 .music-exp / .ui-drawer-layer 的 z-index（选择器或写法变了）' };
  return {
    ok: drawer > exp,
    detail: drawer > exp ? '' : `播放队列(z)=${drawer} 被展开播放器(z)=${exp} 盖住 —— 点「播放队列」会看不到任何东西`,
  };
});
add('UI.modalAboveExpanded', 'UI', (s) => {
  // 「退出喵坞」二次确认是 `.modal-mask`，而展开播放器是 `fixed z-index:70` 的整屏覆盖层。
  // 模态若 ≤ 70，铺满的播放器会把确认框整个盖住：用户点了退出"没有任何反应"且不报错
  // （2026-10-16 真机实测，D-230）。判据直接比两者的 z-index，改任何一个都要重新确认。
  const css = stripComments(s.css ?? '');
  const pickZ = (sel) => {
    const m = css.match(new RegExp(sel + '\\s*\\{([^}]*)\\}'));
    if (!m) return null;
    const z = m[1].match(/z-index:\s*(\d+)/);
    return z ? Number(z[1]) : null;
  };
  const exp = pickZ('\\.music-exp');
  /*
   * 层级现在挂在 `.modal-layer`（弹层骨架）上，`.modal-mask` 只是层内的遮罩 ——
   * 设计稿把弹窗拆成 layer / mask / card 三段。先找 layer，再回落到 mask（兼容旧写法）。
   */
  const modal = pickZ('\\.modal-layer') ?? pickZ('\\.modal-mask');
  if (exp === null || modal === null)
    return { ok: false, detail: '未解析到 .music-exp / .modal-layer 的 z-index（选择器或写法变了）' };
  return {
    ok: modal > exp,
    detail: modal > exp ? '' : `退出确认(z)=${modal} 被展开播放器(z)=${exp} 盖住 —— 点「退出喵坞」不会有任何反应`,
  };
});
add('UI.platformSwitch', 'UI', (s) => ({
  ok: /\bPLATFORMS\b/.test(s.uiSource),
  detail: uiNote(s, '未读到平台切换 UI（PLATFORMS）'),
}));
add('UI.searchCapsule', 'UI', (s) => ({
  ok: /\bsearchProvider\b/.test(s.uiSource) && /\bsetSearchProvider\b/.test(s.uiSource),
  detail: uiNote(s, '未读到搜索源胶囊（searchProvider/setSearchProvider）'),
}));
add('UI.chartGrid', 'UI', (s) => {
  /*
   * 榜单卡（设计稿 `.chart-grid` 四列 + `.chart-card` 卡头 + `.chart-row` 排行）。
   *
   * 产品旧形态是 `.music-charts` 的**横向滚动小圆卡**（64px，只有封面与榜名），点开才进详情；
   * 设计稿是**首页直接铺前 5 名排行**。这不是"换个样式"：首页要回答"各榜在流行什么"，
   * 小圆卡答不了，得再点一次。
   */
  const charts = readMaybe(path.join(F.musicUiDir, 'Charts.tsx')) ?? '';
  if (!charts) return { ok: false, detail: uiNote(s, '未读到 Charts.tsx') };
  const problems = [];
  if (!charts.includes('className="chart-grid"')) problems.push('榜单容器不是 .chart-grid');
  if (!charts.includes('className="chart-card"')) problems.push('榜单卡不是 .chart-card');
  if (!charts.includes('className="chart-row"')) problems.push('榜单卡里没有 .chart-row 排行');
  if (!/pl\.preview/.test(charts)) problems.push('排行没有接 preview（可能写死了假数据）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('UI.chartScroll', 'UI', (s) => {
  /*
   * 旧判据钉的是"滚轮纵向 → scrollLeft 横向滚动"，那是**横滚小卡**形态的补丁。
   * 设计稿改成四列网格后**没有横轴**，那条映射也就不该存在 —— 判据随之反转：
   * 网格形态下若还留着 `onWheel → scrollLeft`，说明旧横滚容器没删干净（两形态并存会互相干扰）。
   */
  const charts = stripComments(readMaybe(path.join(F.musicUiDir, 'Charts.tsx')) ?? '');
  const leftover = /scrollLeft\s*\+=/.test(charts) || /\bdeltaY\b/.test(charts);
  return {
    ok: !leftover,
    detail: leftover ? '四列网格形态下仍留着 onWheel → scrollLeft 的横滚残留' : '',
  };
});
add('UI.dailyEntry', 'UI', (s) => {
  /*
   * 每日推荐的入口（设计稿在 `.entry-grid` 的三枚入口卡里，文案「每日推荐」）。
   * 旧判据接受"榜单区最前面那张 .music-chart.is-daily 小卡"，但那个形态已按设计稿删除 ——
   * 现在只认入口卡这一条路径，且必须真的能打开（onClick 接到 setRightView('daily')）。
   */
  const src = stripComments(s.uiSource ?? '');
  const problems = [];
  if (!/setRightView\(\s*['"]daily['"]/.test(src)) problems.push("入口卡没有接 setRightView('daily')");
  if (!/每日推荐/.test(src)) problems.push('入口卡没有「每日推荐」文案');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('UI.sectionLinkBtn', 'UI', (s) => {
  /*
   * 节头右端的动作键必须是设计稿的 `.link-btn`（轻动作），不是 `.music-btn`（带底色的操作按钮）。
   * 语义层级不同：节头只该出现"刷新 / 换一批"这类轻动作，带底色的按钮会把节头压得比标题还重。
   * 三处：榜单「刷新」/ 推荐歌单「换一批」/ 今日精选「换一批」。
   */
  const charts = stripComments(readMaybe(path.join(F.musicUiDir, 'Charts.tsx')) ?? '');
  const right = stripComments(readMaybe(path.join(F.musicUiDir, 'RightPanel.tsx')) ?? '');
  const problems = [];
  const linkCount =
    (charts.match(/className="link-btn"/g) ?? []).length + (right.match(/className="link-btn"/g) ?? []).length;
  if (linkCount !== 3) problems.push(`节头动作键有 ${linkCount} 处 .link-btn，应为 3（榜单/推荐/精选各一）`);
  const css = stripComments(readMaybe(F.musicScss) ?? '');
  if (!/\.link-btn\s*\{/.test(css)) problems.push('缺少 .link-btn 样式');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('UI.chartCardPreview', 'UI', (s) => {
  /*
   * 首页榜单卡的排行必须来自**真实数据**（`loadCharts` 并发取的 `preview`），
   * 不是写死的假排行 —— 这是"设计稿是演示数据、产品必须接真数据"那条纪律的落点。
   * 判据：类型里有 preview 字段、loadCharts 里调用了 withPreview、withPreview 里真的取歌。
   */
  const types = stripComments(readMaybe(path.join(APP, 'src', 'modules', 'music', 'types.ts')) ?? '');
  const right = stripComments(readMaybe(path.join(APP, 'src', 'modules', 'music', 'actions', 'right.ts')) ?? '');
  const problems = [];
  if (!/preview\?:\s*\{\s*title/.test(types)) problems.push('Playlist 类型里没有 preview 字段');
  const calls = (right.match(/withPreview\(/g) ?? []).length;
  if (calls < 3) problems.push(`withPreview 调用点只有 ${calls} 个（声明 1 + 两个分支各 1，应为 3）`);
  if (!/platform\.rankSongs|platform\.playlistTracks/.test(right)) problems.push('withPreview 没有真的去取歌');
  if (!/CHART_PREVIEW_N\s*=\s*5/.test(right)) problems.push('预览条数不是 5（设计稿卡里就是 5 行）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('UI.playlistCards', 'UI', (s) => {
  /*
   * 推荐歌单必须是**封面卡网格**（设计稿 `.card-grid` + `.playlist-card`），不是列表行。
   * 列表行只能表达"名字 + 数字"，封面卡才能让"按最近的循环生成"这批歌单被**看**出来 ——
   * 推荐位的价值一半在图上。
   * 判据：容器 `.card-grid` / 卡 `.playlist-card` / 有封面位与播放钮 / 不再用 VirtualList 渲染它。
   */
  const src = stripComments(readMaybe(path.join(F.musicUiDir, 'RightPanel.tsx')) ?? '');
  const css = stripComments(readMaybe(F.musicScss) ?? '');
  const problems = [];
  if (!src.includes('className="card-grid"')) problems.push('推荐歌单容器不是 .card-grid');
  if (!src.includes('className="playlist-card"')) problems.push('推荐歌单卡不是 .playlist-card');
  if (!src.includes('pl-play')) problems.push('卡片缺 .pl-play 播放钮');
  if (!/\.card-grid\s*\{/.test(css)) problems.push('缺少 .card-grid 样式');
  if (!/\.playlist-card\s*\{/.test(css)) problems.push('缺少 .playlist-card 样式');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('UI.songTable', 'UI', (s) => {
  /*
   * 今日精选必须是**带表头的曲目表**（设计稿 `.song-table` + `.song-head`），不是裸列表。
   * 表头说明这五列各是什么（序号 / 歌曲 / 专辑 / 时长 / 操作）—— 没有表头时用户要自己猜
   * 第二列是专辑还是歌手。
   */
  const src = stripComments(readMaybe(path.join(F.musicUiDir, 'RightPanel.tsx')) ?? '');
  const css = stripComments(readMaybe(F.musicScss) ?? '');
  const problems = [];
  if (!src.includes('className="song-table"')) problems.push('今日精选没有 .song-table 外壳');
  if (!src.includes('className="song-head"')) problems.push('缺少 .song-head 表头');
  if (!/\.song-table\s*\{/.test(css)) problems.push('缺少 .song-table 样式');
  if (!/\.song-head,\s*\n?\.song-table \.music-row\s*\{/.test(css.replace(/\r/g, ''))) {
    problems.push('表头与行没有共用同一套列宽（会错列）');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('UI.playerBarGlass', 'UI', (s) => {
  /*
   * 播放条是设计稿的**浮起玻璃卡**（`.pb-card`）：22 圆角 + blur(20px) saturate(1.3) +
   * 92% 半透明 + 大而软的投影 + 左右 18 内距。
   * 三样一起才成立：半透明（能看见内容流过）、模糊（文字不干扰）、大投影（真的浮起来）。
   * 去掉任何一样都退回"又一张白卡"，与上面内容区没有主次。
   */
  const css = stripComments(readMaybe(F.musicScss) ?? '');
  const block = /\.music-player\s*\{[^}]*\}/.exec(css);
  if (!block) return { ok: false, detail: '找不到 .music-player 规则' };
  const t = block[0];
  const problems = [];
  if (!/border-radius:\s*22px/.test(t)) problems.push('圆角不是 22');
  if (!/blur\(20px\)/.test(t)) problems.push('缺 blur(20px)');
  if (!/saturate\(1\.3\)/.test(t)) problems.push('缺 saturate(1.3)');
  if (!/color-mix\(in srgb, var\(--miao-surface\) 92%/.test(t)) problems.push('底色不是 92% 半透明白');
  if (!/0 24px 60px -30px/.test(t)) problems.push('投影不是设计稿的 0 24px 60px -30px');
  if (!/padding:\s*0 18px/.test(t)) problems.push('左右内距不是 18');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('UI.playHistory', 'UI', (s) => ({
  ok: /\bplayHistoryList\b/.test(s.uiSource),
  detail: uiNote(s, '未读到播放历史视图（playHistoryList）'),
}));
add('UI.loadMore', 'UI', (s) => ({
  ok: /\bloadMoreLeft\b/.test(s.uiSource) || /\bloadMoreRight\b/.test(s.uiSource),
  detail: uiNote(s, '未读到歌单滚动加载（loadMoreLeft/loadMoreRight）'),
}));

/**
 * 需要走虚拟滚动的长列表（行数无上界：歌单曲目可上千首、队列上限 2000）。
 *
 * ⚠️ `LeftPanel.tsx` **不在**这份清单里：它现在是两个不同角色的文件 ——
 * 歌单列表（几十条，且设计稿的组头 32 与歌单行 46 **不等高**，定高虚拟列表套不上）
 * 与歌单曲目（上千条，必须虚拟滚动）。后者由 `UI.leftTracksVirtual` 单独钉住，
 * 前者由 `UI.sideGroups` 钉住结构。把整份文件列在这里会让"必须用 VirtualList"
 * 与"组头行高不同"两条要求互相矛盾，只能靠改断言解红 —— 那正是要避免的。
 */
const ROW_LISTS = {
  'RightPanel.tsx': '右栏「搜索结果 / 推荐歌单 / 曲目 / 每日推荐」',
  'HistoryView.tsx': '播放历史',
  'LocalView.tsx': '本地曲库',
  'QueueDrawer.tsx': '播放队列',
};

// 只断言「窗口化」的两条本质特征，不锁 rAF / ResizeObserver 这些优化手法 ——
// 后者被替换掉不影响「是否虚拟滚动」这个事实，锁死它们只会让断言在合法重构时误红。
add('UI.virtualList', 'UI', (s) => {
  const v = readMaybe(F.virtualList);
  if (!v) return { ok: false, detail: uiNote(s, '未读到 src/components/units/VirtualList.tsx') };
  const need = [
    [/items\.slice\(/, '按窗口切片渲染（items.slice）'],
    [/ui-vlist-inner/, '撑高元素（否则滚动条长度不反映真实内容）'],
  ];
  const missing = need.filter(([re]) => !re.test(v)).map(([, n]) => n);
  return { ok: missing.length === 0, detail: missing.length ? `虚拟列表缺：${missing.join('、')}` : '' };
});
add('SEARCH.inProgressCopy', 'SEARCH', (s) => {
  /*
   * 搜索中的那句必须是**"正在搜索 <平台>"**（设计稿 `正在搜索 ${已选搜索源}…`），
   * 而不是光秃秃的「搜索中…」—— 后者不说搜的是哪个平台，用户无法判断是不是选错了源。
   * 副文也按设计稿给「搜索结果会同时出现歌曲与专辑」。
   */
  const src = readMaybe(path.join(F.musicUiDir, 'RightPanel.tsx')) ?? '';
  const problems = [];
  if (!/正在搜索\s*\{providerLabel\(searchProvider\)\}…/.test(src)) {
    problems.push('搜索中没说清在搜哪个平台（缺「正在搜索 {平台}…」）');
  }
  if (!src.includes('搜索结果会同时出现歌曲与专辑')) {
    problems.push('搜索中缺设计稿的副文「搜索结果会同时出现歌曲与专辑」');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('QUEUE.emptyToastCopy', 'QUEUE', (s) => {
  /*
   * 队列为空时按播放键要有 **warning toast**（设计稿：`播放队列是空的` / `从首页或搜索里挑一首歌吧`）。
   * 静默不响应会被当成"按钮坏了"；而这条路径下确实没有"当前这首"可暂停。
   * 判据落在 store 的 `togglePlay` 上（不是某个按钮的 onClick）—— 播放条、展开播放器、
   * 快捷键都会汇到这里，只有这一处才算全覆盖。
   */
  /*
   * ⚠️ 先剥注释：本段注释里**正讨论着**这两句（"设计稿：播放队列是空的 / 从首页或搜索里挑一首歌吧"），
   * 不剥的话把 toast 整行删掉断言照样绿 —— 判据被注释撑着。
   */
  const src = stripComments(readMaybe(F.musicActionsPlayback) ?? '');
  if (!src) return { ok: false, detail: uiNote(s, '未读到 actions/playback.ts') };
  const problems = [];
  const body = src.slice(src.indexOf('togglePlay:'));
  if (!/queue\.length === 0/.test(body)) problems.push('togglePlay 没有判空队列');
  if (!src.includes('播放队列是空的')) problems.push('缺 toast 主文「播放队列是空的」');
  if (!src.includes('从首页或搜索里挑一首歌吧')) problems.push('缺 toast 副文「从首页或搜索里挑一首歌吧」');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('UI.sectionHeadClass', 'UI', (s) => {
  /*
   * 首页的"节"必须是设计稿那一套类名：容器 `.mc-section` + 节头 `.mc-section-head`。
   *
   * 产品的历史类名是 `.music-sec` / `.music-card-hd`（"卡片头"），语义上把"首页的一节"
   * 说成了"一张卡的头"——同一批样式两套叫法，改设计稿值时必然漏掉一边（本轮就是：
   * CSS 改成了 `.mc-section`，组件还写着 `.music-sec`，整块 20px 的节间距静默失效）。
   * 判据：music 屏里不许再出现旧类名（剥注释后判，注释里正讨论着它们）。
   */
  const dir = F.musicUiDir;
  const problems = [];
  const stale = { 'music-sec': 0, 'music-card-hd': 0 };
  for (const f of ['Charts.tsx', 'RightPanel.tsx', 'LeftPanel.tsx']) {
    const src = stripComments(readMaybe(path.join(dir, f)) ?? '');
    for (const k of Object.keys(stale)) {
      const hits = (src.match(new RegExp('"' + k + '"', 'g')) ?? []).length;
      stale[k] += hits;
    }
  }
  for (const [k, n] of Object.entries(stale)) {
    if (n > 0) problems.push(`${n} 处仍在用旧类名 ${k}`);
  }
  const charts = stripComments(readMaybe(path.join(dir, 'Charts.tsx')) ?? '');
  if (!charts.includes('className="mc-section"')) problems.push('Charts 的节容器不是 .mc-section');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('UI.searchSourcesInResults', 'UI', (s) => {
  /*
   * 搜索源胶囊（设计稿 `.search-sources`）的**位置**：它只在**搜索结果页**里渲染。
   *
   * 产品曾把它做成 `.cap-row` 常驻在 `.music-view` 顶部 —— 于是首页 / 榜单 / 歌单页
   * 都挂着一条"这次搜索该打哪些平台"的选择器，而那几个页面没有要回答这个问题。
   * 判据要的是"渲染点在 SearchResults 里、且不在视图壳里"，两条都断：
   *   ① 视图壳（RightPanel 的主 return）里**没有** `<SearchCaps`；
   *   ② `SearchResults` 里**有** `<SearchCaps`（含三条早返回分支 —— 搜索中/无结果时
   *      也要能换平台，否则用户只能等这次搜完才知道选错）。
   */
  const src = readMaybe(path.join(F.musicUiDir, 'RightPanel.tsx'));
  if (!src) return { ok: false, detail: uiNote(s, '未读到 RightPanel.tsx') };
  const problems = [];
  const viewAt = src.indexOf('className="music-view"');
  const resultsAt = src.indexOf('function SearchResults');
  if (viewAt < 0) problems.push('找不到 .music-view 视图壳');
  if (resultsAt < 0) problems.push('找不到 SearchResults');
  if (viewAt >= 0 && resultsAt > viewAt) {
    // 视图壳那段（到 SearchResults 定义之前）不许出现 <SearchCaps
    const shell = src.slice(viewAt, resultsAt);
    if (/<SearchCaps\s*\/>/.test(shell)) problems.push('视图壳里仍在渲染搜索源胶囊（首页/榜单页会一直挂着它）');
  }
  const resultsBody = resultsAt >= 0 ? src.slice(resultsAt) : '';
  /*
   * **精确 3 处**，不是 ≥2：三条分支（搜索中 / 无结果 / 有结果）各一处。
   * 阈值写成 ≥2 时"删掉其中一处"照样绿（实测踩过），那样的分母等于没有。
   */
  const capsUse = (resultsBody.match(/<SearchCaps\s*\/>/g) ?? []).length;
  if (capsUse !== 3) {
    problems.push(`搜索结果里的搜索源胶囊有 ${capsUse} 处，应为 3（搜索中/无结果/有结果三条分支各一）`);
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('UI.noCenterWrapper', 'UI', (s) => {
  /*
   * 设计稿 `.music-view` 直接承载各视图的节：中间不许再有 `.music-rightbody` 之类的包裹层。
   *
   * ⚠️ 必须先剥注释再判：本轮的改动说明里**正讨论着**这个类名（"多出两层 —— .cap-row 与
   * .music-rightbody"），不剥的话注释会把判据喂成"仍在用"（假红），反过来若有人只把
   * 实现删掉、把类名留在注释里，不剥又会遮住下一次"加回去"。
   */
  const src = stripComments(readMaybe(path.join(F.musicUiDir, 'RightPanel.tsx')) ?? '');
  const css = stripComments(readMaybe(F.musicScss) ?? '');
  if (!src) return { ok: false, detail: uiNote(s, '未读到 RightPanel.tsx') };
  const problems = [];
  if (/music-rightbody/.test(src)) problems.push('视图里仍有 .music-rightbody 包裹层');
  if (/\.music-rightbody\s*\{/.test(css)) problems.push('样式里仍留着 .music-rightbody 规则');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('UI.sideGroups', 'UI', (s) => {
  /*
   * 左栏歌单列表的**分组结构**（设计稿 `.ms-group` → `.ms-caption` + 若干 `.ms-row`）。
   *
   * 产品此前是"一个 `.music-body` 里塞一条扁平行表"，组头与歌单行混在同一个列表里；
   * 设计稿的分组是**嵌套结构**（每组一个容器，组头是该组的第一个孩子）。
   * 三处都断：① 有 `.ms-group`；② 组头是 `.ms-caption`；③ 组内空态用 `.ms-empty`
   * （不是通用 `Empty` —— 那是整块视图的空态，会占满高度）。
   */
  const src = readMaybe(path.join(F.musicUiDir, 'LeftPanel.tsx'));
  if (!src) return { ok: false, detail: uiNote(s, '未读到 LeftPanel.tsx') };
  const problems = [];
  if (!/className="ms-group"/.test(src)) problems.push('歌单列表没有 .ms-group 分组容器');
  if (!/className="ms-caption"/.test(src)) problems.push('组头不是 .ms-caption（设计稿的组头形态）');
  if (!/className="ms-empty"/.test(src)) problems.push('组内空态不是 .ms-empty（用通用 Empty 会占满高度）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('UI.leftTracksVirtual', 'UI', (s) => {
  /* 歌单曲目仍然必须虚拟滚动（上千首）：LeftPanel 里那一段不许跟着歌单列表一起退化 */
  const src = readMaybe(path.join(F.musicUiDir, 'LeftPanel.tsx'));
  if (!src) return { ok: false, detail: uiNote(s, '未读到 LeftPanel.tsx') };
  return {
    ok: /<VirtualList/.test(src),
    detail: /<VirtualList/.test(src) ? '' : '歌单曲目列表未接虚拟滚动（上千首会卡）',
  };
});
add('UI.virtualListUsed', 'UI', (s) => {
  const missing = [];
  for (const [file, label] of Object.entries(ROW_LISTS)) {
    const src = readMaybe(path.join(F.musicUiDir, file));
    if (!/<VirtualList/.test(src)) missing.push(`${file}（${label}）`);
  }
  return {
    ok: missing.length === 0,
    detail: missing.length ? `这些长列表未接虚拟滚动：${missing.join('、')}` : '',
  };
});

// ============================ 时长单位（DUR） ============================
/**
 * Song.duration 的单位契约是**毫秒**（四个平台在 Rust 侧各自归一：网易云 dt 本就是 ms、
 * 酷狗 Duration×1000、QQ interval×1000、咪咕本就是 ms）。
 * 前端曾把它当秒再乘一次 1000（4:29 显示成 4483:20），所以这里既断言契约被写明、
 * 也断言前端**没有再乘** —— 单测「文档写了」不够，得防住复发。
 */
add('DUR.msContract', 'DUR', (s) => {
  const models = readMaybe(F.rustModels);
  const documented = /单位.{0,4}毫秒/.test(models);
  const sources = { 'store.ts': s.store, 'platform.ts': s.platform, ui: `${s.musicUi}\n${s.musicScreen}` };
  const offenders = Object.entries(sources)
    .filter(([, src]) => /\.duration\s*\*\s*1000/.test(src))
    .map(([f]) => f);
  const detail = [
    documented ? '' : 'Rust models.rs 未写明 duration 的单位是毫秒',
    offenders.length ? `前端又把 duration 当秒乘了 1000：${offenders.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('；');
  return { ok: !detail, detail };
});

// ============================ 搜索分页（SEARCH） ============================
/**
 * 上游参考（含 Rust 与前端）**都没有**搜索分页：四个 search 函数的签名只有 limit，
 * 内部页码/offset 写死为 1 / 0，前端也没有任何分页状态。
 * 这里断言我们把它补齐了，且补在四层上（Rust 签名 → platform 透传 → store 状态机 → UI 触发）。
 */
const SEARCH_CMDS = ['music_search', 'kugou_search', 'qq_search', 'migu_search'];
add('SEARCH.rustOffset', 'SEARCH', (s) => {
  const missing = SEARCH_CMDS.filter((n) => !new RegExp(`pub async fn ${esc(n)}\\([^)]*offset`).test(s.rustMod));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `这些 Rust 搜索命令没有 offset 参数：${missing.join(', ')}` : '',
  };
});
add('SEARCH.platformOffset', 'SEARCH', (s) => {
  const missing = [];
  if (!/export function search\([\s\S]{0,160}offset/.test(s.platform)) missing.push('search 未接收 offset');
  if (!/searchPageSize/.test(s.platform)) missing.push('缺少 searchPageSize（各平台页大小不同）');
  if (!/offset\s*\)/.test(s.platform)) missing.push('未把 offset 透传给各平台 IPC');
  return { ok: missing.length === 0, detail: missing.length ? `platform 层：${missing.join('、')}` : '' };
});
add('SEARCH.storePaging', 'SEARCH', (s) => {
  const first = methodBody(s.store, 'search');
  const more = methodBody(s.store, 'loadMoreSearch');
  const missing = [];
  if (first == null) missing.push('search 实现');
  else if (!/searchHasMore/.test(first)) missing.push('首屏 search 未设置 searchHasMore');
  if (more == null) missing.push('loadMoreSearch 实现');
  else {
    if (!/searchResults\.length/.test(more)) missing.push('loadMoreSearch 未以已加载条数作为 offset');
    if (!/searchHasMore/.test(more)) missing.push('loadMoreSearch 未更新 searchHasMore');
  }
  return { ok: missing.length === 0, detail: missing.length ? `store 层缺：${missing.join('、')}` : '' };
});
add('SEARCH.uiWire', 'SEARCH', (s) => {
  const rp = readMaybe(path.join(F.musicUiDir, 'RightPanel.tsx'));
  const missing = [];
  if (!/loadMoreSearch/.test(rp)) missing.push('未接 loadMoreSearch');
  if (!/searchHasMore/.test(rp)) missing.push('未用 searchHasMore 判断是否还能加载');
  if (!/onNearEnd/.test(rp)) missing.push('未用 VirtualList 的 onNearEnd 触发');
  return { ok: missing.length === 0, detail: missing.length ? `搜索结果未接分页：${missing.join('、')}` : '' };
});

// 播放条显隐 + 一屏定高布局：两者是一件事的两半 —— 播放条要「恒贴底部」，
// 前提是外层的 .content 不再产生页面级滚动（那会把播放条推到视口之外）。
add('UI.playerBarRule', 'UI', (s) => {
  const pb = readMaybe(path.join(F.musicUiDir, 'PlayerBar.tsx'));
  const missing = [];
  if (!/if\s*\(hidden\)\s*return\s+null/.test(pb)) missing.push('PlayerBar 未实现 hidden 时早退（队列为空不渲染）');
  if (!/hidden=\{[^}]*queue[^}]*\}/.test(s.musicScreen)) missing.push('MusicScreen 未按队列长度决定播放条显隐');
  const block = (s.css.match(/\.music\s*\{([^}]*)\}/) || [, ''])[1];
  if (!/(^|\n)\s*height:\s*100%/.test(block))
    missing.push('样式的 .music 未改成定高（仍是 min-height:100%，会撑出页面级滚动）');
  // 三栏布局（设计稿 `music-layout`）：中间栏必须能收缩（`minmax(0, …)`），
  // 否则内容一长就把整行撑开、把播放条顶出视口 —— 与旧 `.music-cols` 那条是同一件事。
  const layout = (s.css.match(/\.music-layout\s*\{([^}]*)\}/) || [, ''])[1];
  if (!/grid-template-columns\s*:\s*[^;]*minmax\(\s*0\s*,/.test(layout)) {
    missing.push('.music-layout 中间栏未用 minmax(0, …)（内容会把整行撑开、播放条被顶出视口）');
  }
  if (!/overflow\s*:\s*hidden/.test(layout)) {
    missing.push('.music-layout 未禁外层滚动（三栏各自滚动，容器再滚会出双滚动条）');
  }
  return { ok: missing.length === 0, detail: missing.length ? `播放条/定高布局缺：${missing.join('、')}` : '' };
});

// ============================ 播放器还原（PLAYER） ============================
/**
 * 本轮「音乐播放器还原」的四类契约，逐条对应一次**用户能感知**的故障：
 *   A 播放内核常驻   —— 切到设置页就断播（<audio> 原在 MusicScreen 内，切屏即销毁）
 *   B 展开动画+点歌自动展开 —— 退场时长两处不一致 = 动画没播完就消失；自动切歌弹开播放器
 *   C 播放条补全     —— 静音/滚轮调音量/音质下拉/码率显示/关闭播放/进度条拖拽会话
 *   D 实际音质回写   —— resolveOnlineUrl 从不写 currentQuality/currentBitrate，音质标签是假 UI
 *
 * ⚠️ 判据一律先 stripComments 再匹配：本轮多处注释**主动写出了被禁的写法**（见 stripComments 注释）。
 */
add('PLAYER.kernelExists', 'PLAYER', (s) => {
  const k = stripComments(s.kernel);
  if (!k) return { ok: false, detail: '未读到 src/components/MusicKernel.tsx' };
  const missing = [];
  if (!/<audio\b/.test(k)) missing.push('未持有 <audio> 元素');
  if (!/\buseMusicStore\b/.test(k)) missing.push('未接 store（useMusicStore）');
  return { ok: missing.length === 0, detail: missing.length ? `播放内核缺：${missing.join('、')}` : '' };
});
add('PLAYER.kernelAtRoot', 'PLAYER', (s) => ({
  ok: /<MusicKernel\b/.test(stripComments(s.app)),
  detail: '<MusicKernel /> 未挂在 App.tsx 应用根（实现了但没人挂 = 切屏照样断播）',
}));
add('PLAYER.audioLeftScreen', 'PLAYER', (s) => {
  const ms = stripComments(s.musicScreen);
  const hit = [];
  if (/<audio\b/.test(ms)) hit.push('<audio>');
  if (/\baudioRef\b/.test(ms)) hit.push('audioRef');
  if (/\bonTimeUpdate\b/.test(ms)) hit.push('onTimeUpdate');
  return {
    ok: hit.length === 0,
    detail: hit.length
      ? `MusicScreen.tsx 仍持有播放内核残留：${hit.join('、')}（内核必须整体住在 MusicKernel —— 两边各留一半正是"切屏断播"的温床）`
      : '',
  };
});
add('PLAYER.registerApi', 'PLAYER', (s) => ({
  ok: /export function registerAudioElement\s*\(/.test(stripComments(s.store)),
  detail: 'store.ts 未导出 registerAudioElement（播放内核无处把 DOM 引用交给 store）',
}));
add('PLAYER.kernelRegisters', 'PLAYER', (s) => {
  const k = stripComments(s.kernel);
  const missing = [];
  // 「登记」= 传入一个非 null 的元素。负向先行断言把 `registerAudioElement(null)`（注销）排除掉，
  // 否则删掉挂载时那次调用、只留卸载时的 null，这条会**该红没红**（本脚本第一版正是如此）。
  if (!/\bregisterAudioElement\s*\(\s*(?!null\b)/.test(k))
    missing.push('挂载时未登记 audio 元素（未调用 registerAudioElement(元素)）');
  if (!/\bregisterAudioElement\s*\(\s*null\s*\)/.test(k)) missing.push('卸载时未传 null 注销');
  return { ok: missing.length === 0, detail: missing.length ? `播放内核登记/注销：${missing.join('、')}` : '' };
});
add('PLAYER.seekMovesAudio', 'PLAYER', (s) => {
  // 一律在**剥注释后**的源码上取实现体：本仓库的实现体里本就夹着注释，
  // 反证注入的说明注释又常写出被禁的写法（如 "expand:false 被移除"），不剥注释会喂成假绿。
  const body = methodBody(stripComments(s.store), 'seek');
  if (body == null) return { ok: false, detail: 'store.ts 未定义 seek' };
  const missing = [];
  if (!/progressMs/.test(body)) missing.push('未写 progressMs');
  if (!/\.currentTime\s*=/.test(body)) missing.push('未挪 audio.currentTime（退化成"只动进度条、不动声音"）');
  return { ok: missing.length === 0, detail: missing.length ? `seek 实现缺：${missing.join('、')}` : '' };
});
add('PLAYER.audioElNotInState', 'PLAYER', (s) => {
  const st = stripComments(s.store);
  const hasRef = /\blet\s+audioEl\b/.test(st);
  // 模块级 `let audioEl: HTMLAudioElement | null = null;` 自身带类型冒号，先把它剔除，
  // 再看是否还残留 `audioEl: ...`（那才是"被塞进 interface / create 初始 state"的形态）。
  const withoutDecl = st.replace(/let\s+audioEl\b[^;]*;/, '');
  const inState = /\baudioEl\s*:/.test(withoutDecl);
  return {
    ok: hasRef && !inState,
    detail: !hasRef
      ? 'store.ts 未以模块级 let 持有 audioEl'
      : inState
        ? 'audioEl 被塞进了 zustand state（DOM 引用不该进 state：每次登记会惊动所有订阅者）'
        : '',
  };
});
add('PLAYER.animKeyframes', 'PLAYER', (s) => {
  const missing = ['@keyframes music-exp-up', '@keyframes music-exp-down'].filter((k) => !s.css.includes(k));
  return { ok: missing.length === 0, detail: missing.length ? `样式缺进场/退场关键帧：${missing.join('、')}` : '' };
});
add('PLAYER.animEnter', 'PLAYER', (s) => {
  const rule = (s.css.match(/(?:^|\n)\.music-exp\s*\{([^}]*)\}/) || [, ''])[1];
  return { ok: /animation\s*:\s*music-exp-up/.test(rule), detail: '样式的 .music-exp 未自带进场动画 music-exp-up' };
});
add('PLAYER.animClosing', 'PLAYER', (s) => {
  const rule = (s.css.match(/\.music-exp\.is-closing\s*\{([^}]*)\}/) || [, ''])[1];
  return {
    ok: /animation\s*:\s*music-exp-down/.test(rule),
    detail: '样式的 .music-exp.is-closing 未播退场动画 music-exp-down',
  };
});
add('PLAYER.durationSync', 'PLAYER', (s) => {
  // 双向：CSS 的退场时长 ↔ store 的延时，两个数都取出来比对 —— 改一处忘另一处 = 动画没播完就消失
  const rule = (s.css.match(/\.music-exp\.is-closing\s*\{([^}]*)\}/) || [, ''])[1];
  const cssM = /animation\s*:\s*music-exp-down\s+([\d.]+)s/.exec(rule);
  const body = methodBody(stripComments(s.store), 'closeExpanded');
  const msM = body && /\}\s*,\s*(\d+)\s*\)\s*;/.exec(body);
  if (!cssM) return { ok: false, detail: '样式里取不到 .music-exp.is-closing 的退场时长（0.Ns）' };
  if (!msM) return { ok: false, detail: 'store.closeExpanded 未取到退场延时（setTimeout 的毫秒数）' };
  const cssSec = parseFloat(cssM[1]);
  const ms = Number(msM[1]);
  const ok = Math.abs(cssSec * 1000 - ms) < 0.5;
  return { ok, detail: ok ? '' : `退场时长两处不一致：CSS ${cssSec}s ↔ store ${ms}ms（改一处必须改另一处）` };
});
add('PLAYER.closePath', 'PLAYER', (s) => {
  const ep = stripComments(s.expanded);
  const missing = [];
  if (!/closeExpanded\s*\(\s*\)/.test(ep)) missing.push('收起按钮未走 closeExpanded()');
  if (/setExpanded\s*\(\s*false\s*\)/.test(ep)) missing.push('仍直接 setExpanded(false)（会跳过退场动画）');
  return { ok: missing.length === 0, detail: missing.length ? `ExpandedPlayer 收起入口：${missing.join('、')}` : '' };
});
add('PLAYER.escPath', 'PLAYER', (s) => {
  // Esc 收起的 owner 已从 MusicScreen 搬到 App 根（2026-10-12）：展开播放器挂应用根，
  // Esc 必须跟着走 —— 否则从设置页点开播放器后就 Esc 不掉了。
  // ⚠️ 两处都要查：App 根**必须有** closeExpanded，MusicScreen **不得再**有
  //   （两处都监听会在音乐屏里重复触发退场动画）。
  const app = stripComments(s.app);
  const ms = stripComments(s.musicScreen);
  const missing = [];
  // App 根必须**从 store 取到** closeExpanded（可能取别名，如 closeMusicExpanded）
  // 并在 Esc 分支里调用它 —— 只判"出现过 closeExpanded()"会被别处的引用骗过。
  const aliasM =
    /\bconst\s+(\w+)\s*=\s*useMusicStore\(\s*\(?s\)?\s*=>\s*s\.closeExpanded\s*\)/.exec(app) ??
    // 解构取法：const { closeExpanded } = useMusicStore(s)
    (() => {
      const d = /\bconst\s*\{([^}]*)\}\s*=\s*useMusicStore\(/.exec(app);
      if (!d) return null;
      const name = d[1]
        .split(',')
        .map((x) => (x.includes(':') ? x.split(':')[1] : x).trim())
        .find((x) => /^closeExpanded$/.test(x));
      return name ? [name] : null;
    })();
  const alias = aliasM ? aliasM[1] : null;
  if (!alias) missing.push('App 根没有从 store 取 closeExpanded');
  else if (!new RegExp(`\\b${alias}\\s*\\(\\s*\\)`).test(app)) missing.push(`App 根 Esc 分支未调用 ${alias}()`);
  if (/setExpanded\s*\(\s*false\s*\)/.test(app)) missing.push('App 根仍直接 setExpanded(false)');
  if (/closeExpanded\s*\(\s*\)/.test(ms)) missing.push('MusicScreen 仍在监听 closeExpanded（应只在 App 根）');
  return {
    ok: missing.length === 0,
    detail: missing.length ? `展开播放器 Esc 收起：${missing.join('、')}` : '',
  };
});
add('PLAYER.noAnimShorthandClash', 'PLAYER', (s) => {
  // 🔴 闪烁的根因（2026-10-12 修）：`animation` 是**简写属性**，一改就把它列出的所有动画
  // 整体重置并**从头重播**。`.is-dynamic` 原先单独写了 `animation: music-exp-flow …`，
  // 于是点「动态」开关时简写从 flow 变回 music-exp-up ⇒ 已播完的进场动画被重播 ⇒ 整屏闪一下。
  // 判据：任何**作用在 .music-exp 上的 animation 简写**都不得在基础规则之外出现
  //（.is-closing 的退场简写是合法的 —— 那是组件即将卸载的终态，不存在"重播进场"）。
  const missing = [];
  const clash = [...s.css.matchAll(/(^|[},])\s*(\.music-exp[^{]*?)\{([^}]*)\}/g)].filter((m) =>
    /(^|\s|;)animation\s*:/.test(m[3]),
  );
  for (const m of clash) {
    const sel = m[2].trim();
    if (sel === '.music-exp' || sel === '.music-exp.is-closing') continue;
    missing.push(`${sel} 又写了 animation 简写（会重播进场动画 ⇒ 整屏闪一下）`);
  }
  // 反向：动态开关必须只靠 animation-play-state 控制跑/停
  if (!/\.music-exp\.is-dynamic\s*\{[^}]*animation-play-state\s*:\s*running\s*,\s*running/.test(s.css))
    missing.push('.is-dynamic 未用 animation-play-state 开启动画（改简写会重播进场动画）');
  return {
    ok: missing.length === 0,
    detail: missing.length ? `展开播放器动画简写冲突：${missing.join('、')}` : '',
  };
});
add('PLAYER.expandedMountedAtRoot', 'PLAYER', (s) => {
  // 展开播放器必须挂在**应用根**：灵动岛常驻根上，它的「打开播放器」在任意屏都点得到，
  // 浮层若只活在 MusicScreen 内，从设置页点就是"按了没反应"（这正是本次修的 bug）。
  const app = stripComments(s.app);
  const ms = stripComments(s.musicScreen);
  const missing = [];
  if (!/<ExpandedPlayer\b/.test(app)) missing.push('App 根没有渲染 <ExpandedPlayer>');
  if (/<ExpandedPlayer\b/.test(ms)) missing.push('MusicScreen 仍渲染 <ExpandedPlayer>（会随屏卸载）');
  return {
    ok: missing.length === 0,
    detail: missing.length ? `展开播放器挂载点：${missing.join('、')}` : '',
  };
});
add('PLAYER.playSongExpandOpt', 'PLAYER', (s) => {
  const body = methodBody(stripComments(s.store), 'playSong');
  if (body == null) return { ok: false, detail: 'store.ts 未定义 playSong' };
  const missing = [];
  if (!/opts\?\.\s*expand\s*===\s*false/.test(body)) missing.push('未按 opts?.expand === false 判定');
  if (!/expanded\s*:\s*true/.test(body)) missing.push('未设置 expanded: true');
  return { ok: missing.length === 0, detail: missing.length ? `playSong 自动展开：${missing.join('、')}` : '' };
});
add('PLAYER.nextExpandFalse', 'PLAYER', (s) => {
  const body = methodBody(stripComments(s.store), 'next');
  if (body == null) return { ok: false, detail: 'store.ts 未定义 next' };
  // 必须**逐条路径**判，不能只判"有没有出现过 expand:false"：
  // 心动模式接入后 next 里有两条 playSong 调用（相似分支 + 普通分支），
  // 删掉其中一条时"是否出现过"仍为真 → 断言恒绿（反证轮实测抓到了这个假阳性）。
  // 判据改成：next 里 playSong 的调用次数 == 带 expand:false 的次数。
  const calls = (body.match(/playSong\s*\(/g) || []).length;
  const guarded = (body.match(/playSong\s*\([^;]*expand\s*:\s*false/g) || []).length;
  return {
    ok: calls > 0 && calls === guarded,
    detail:
      calls === guarded
        ? ''
        : `next 有 ${calls} 处 playSong，只有 ${guarded} 处传了 { expand: false }（漏掉的那条会把播放器弹开）`,
  };
});
add('PLAYER.prevExpandFalse', 'PLAYER', (s) => {
  const body = methodBody(stripComments(s.store), 'prev');
  return { ok: body != null && /expand\s*:\s*false/.test(body), detail: 'store.prev 未传 { expand: false }' };
});
add('PLAYER.bar.mute', 'PLAYER', (s) => {
  const pb = stripComments(s.playerBar);
  const missing = [];
  if (!/toggleMute\s*\(\s*\)/.test(pb)) missing.push('未接 toggleMute()');
  if (!/\bVolumeX\b/.test(pb) || !/\bVolume2\b/.test(pb)) missing.push('静音图标未随 muted 在 VolumeX/Volume2 间切换');
  return { ok: missing.length === 0, detail: missing.length ? `播放条静音：${missing.join('、')}` : '' };
});
add('PLAYER.bar.wheelVolume', 'PLAYER', (s) => {
  const pb = stripComments(s.playerBar);
  const missing = [];
  if (!/\bonWheel\b/.test(pb)) missing.push('缺 onWheel');
  if (!/\bstepVolume\s*\(/.test(pb)) missing.push('未调 stepVolume(');
  if (/\bpreventDefault\b/.test(pb)) missing.push('出现 preventDefault（React wheel 是被动监听，调用无效且刷警告）');
  return { ok: missing.length === 0, detail: missing.length ? `播放条滚轮调音量：${missing.join('、')}` : '' };
});
add('PLAYER.bar.qualitySelect', 'PLAYER', (s) => {
  const pb = stripComments(s.playerBar);
  const missing = [];
  if (!/\bSelect\b/.test(pb)) missing.push('未用 units 的 Select');
  // 必须看**接线**（options={QUALITY_OPTIONS}），不能只看名字：import 行里也有 QUALITY_OPTIONS，
  // 只按名字匹配时「把 options 清空」测不出来（本脚本第一版正是如此）。
  if (!/\boptions\s*=\s*\{\s*QUALITY_OPTIONS\s*\}/.test(pb)) missing.push('Select 未接 options={QUALITY_OPTIONS}');
  if (!/\bsetPlaybackQuality\b/.test(pb)) missing.push('未接 setPlaybackQuality');
  if (!/music-q-sel/.test(pb)) missing.push('缺容器类名 music-q-sel');
  return { ok: missing.length === 0, detail: missing.length ? `播放条音质下拉：${missing.join('、')}` : '' };
});
add('PLAYER.bar.bitrate', 'PLAYER', (s) => {
  const pb = stripComments(s.playerBar);
  const missing = [];
  if (!/\bcurrentQuality\b/.test(pb)) missing.push('未用 currentQuality');
  if (!/\bcurrentBitrate\b/.test(pb)) missing.push('未用 currentBitrate');
  if (!/\bqualityLabel\s*\(/.test(pb)) missing.push('未用 qualityLabel(');
  // 类名要求"到边界为止"：/music-br/ 会命中 music-br-removed，改类名测不出来
  if (!/music-br(?=["'\s])/.test(pb)) missing.push('缺类名 music-br');
  return { ok: missing.length === 0, detail: missing.length ? `播放条实际音质/码率显示：${missing.join('、')}` : '' };
});
add('PLAYER.bar.closePlayback', 'PLAYER', (s) => ({
  ok: /closePlayback\s*\(\s*\)/.test(stripComments(s.playerBar)),
  detail: '播放条未接 closePlayback()（关闭播放）',
}));
add('PLAYER.bar.dragSession', 'PLAYER', (s) => {
  // 进度条拖拽会话：拖动只改本地 dragMs，松手/抬键才提交一次。
  // 「onChange 里不得直接调 onSeek」是这条的本质 —— 否则退回"每动一格提交一次"（卡顿/爆音）。
  // 2026-10-19 用户要求再钉一层：提交必须**延 0.1s** —— 拖拽中不更新播放进度，
  // 拖拽结束后也不是立即更新。判据抓 setTimeout(…, SEEK_COMMIT_DELAY_MS)：
  // 退回"松手即 seek"（onSeek 直接调、没有定时器）必须红。
  const pb = stripComments(s.playerBar);
  const missing = [];
  if (!/\buseState\b/.test(pb)) missing.push('未用 useState 保存拖拽会话');
  if (!/\bdragMs\b/.test(pb) || !/\bsetDragMs\s*\(/.test(pb)) missing.push('缺本地拖拽状态 dragMs');
  if (!/onChange=\{[^}]*setDragMs\s*\(/.test(pb)) missing.push('onChange 未只做 setDragMs(');
  if (/onChange=\{[^}]*onSeek\s*\(/.test(pb)) missing.push('onChange 里直接调 onSeek(（退回逐帧提交）');
  if (!/\bonPointerUp\s*=/.test(pb)) missing.push('缺 onPointerUp 提交');
  if (!/\bonKeyUp\s*=/.test(pb)) missing.push('缺 onKeyUp 提交');
  // 松手后的 0.1s 静默期：定时器与延时常量两个部件都要在（缺任一即是"立即更新"）
  if (!/\bsetTimeout\s*\(/.test(pb)) missing.push('提交未走 setTimeout（拖拽一结束就 seek）');
  if (!/,\s*SEEK_COMMIT_DELAY_MS\s*\)/.test(pb)) missing.push('缺 0.1s 延时常量 SEEK_COMMIT_DELAY_MS');
  return { ok: missing.length === 0, detail: missing.length ? `播放条进度条拖拽会话：${missing.join('、')}` : '' };
});
add('PLAYER.exp.dragSession', 'PLAYER', (s) => {
  // 展开播放器的进度条与播放条是**同一套拖拽会话的两份实现**（含 2026-10-19 的 0.1s 延时提交）。
  // 为什么单独立一条而不是复用播放条那条：两条进度条各写一份，坏任何一条另一条全绿 ——
  // "同一个范式抄两遍"正是静默分化的起点（播放条加了延时、展开播放器忘了加，此前没有人会红）。
  const exp = stripComments(s.expanded ?? '');
  const missing = [];
  if (!/\buseState\b/.test(exp)) missing.push('未用 useState 保存拖拽会话');
  if (!/\bdragMs\b/.test(exp) || !/\bsetDragMs\s*\(/.test(exp)) missing.push('缺本地拖拽状态 dragMs');
  if (!/onChange=\{[^}]*setDragMs\s*\(/.test(exp)) missing.push('onChange 未只做 setDragMs(');
  if (/onChange=\{[^}]*onSeek\s*\(/.test(exp)) missing.push('onChange 里直接调 onSeek(（退回逐帧提交）');
  if (!/\bonPointerUp\s*=/.test(exp)) missing.push('缺 onPointerUp 提交');
  if (!/\bonKeyUp\s*=/.test(exp)) missing.push('缺 onKeyUp 提交');
  if (!/\bsetTimeout\s*\(/.test(exp)) missing.push('提交未走 setTimeout（拖拽一结束就 seek）');
  if (!/,\s*SEEK_COMMIT_DELAY_MS\s*\)/.test(exp)) missing.push('缺 0.1s 延时常量 SEEK_COMMIT_DELAY_MS');
  return {
    ok: missing.length === 0,
    detail: missing.length ? `展开播放器进度条拖拽会话：${missing.join('、')}` : '',
  };
});
add('PLAYER.resolveWrites', 'PLAYER', (s) => {
  // D 组防回归：resolveOnlineUrl 此前从不写 currentQuality/currentBitrate → 播放条音质标签是假 UI
  //
  // ⚠️ 判据必须钉在「**平台返回值的**那一次写入」上，不能只判字段名出现过。
  // 接入音频缓存后 resolveOnlineUrl 里有**两处**写 currentBitrate：
  // 缓存命中写 0（拿不到真实码率，不谎报），未命中写 `r.br`（真拿到的码率）。
  // 只判"出现过 currentBitrate"的话，删掉 `r.br` 那次断言仍绿 ——
  // 而那正是这条断言声称守护的东西（音质标签变假 UI）。
  const body = fnBodyAny(stripComments(s.store), 'resolveOnlineUrl');
  if (body == null) return { ok: false, detail: 'store.ts 未定义 resolveOnlineUrl' };
  const missing = [];
  // 取流地址成功后的回写：两个字段都必须来自 `r`（平台返回值），缺一就是假 UI
  if (!/currentQuality:\s*r\.quality/.test(body)) missing.push('currentQuality 未按 r.quality 回写');
  if (!/currentBitrate:\s*r\.br/.test(body)) missing.push('currentBitrate 未按 r.br 回写');
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `resolveOnlineUrl 缺回写：${missing.join('、')}（字段定义了却永远是空 —— 播放条音质标签是假 UI）`
      : '',
  };
});

// ── 心动模式（heartbeat · 五档改版）────────────────────────────────────
add('HEARTBEAT.modeInType', 'HEARTBEAT', (s) => {
  // 类型层：PlayMode 必须含 heartbeat 与新增的 order（顺序播放）
  if (!/\bheartbeat\b/.test(s.types)) return { ok: false, detail: 'types.ts 的 PlayMode 未含 heartbeat' };
  if (!/'order'/.test(s.types)) return { ok: false, detail: "types.ts 的 PlayMode 未含新增的 'order'（顺序播放）" };
  return { ok: true, detail: '' };
});
add('HEARTBEAT.cycleFive', 'HEARTBEAT', (s) => {
  // cycleMode 的档位循环顺序必须是需求给定的：列表 → 单曲 → 随机 → 顺序 → 心动。
  // ⚠️ 判"顺序"而不是"集合"：档位顺序是需求明文，写成集合相等就把
  // "点一下切到哪档"这件用户可感的事放走了（顺序错了会跳档）。
  const body = methodBody(stripComments(s.store), 'cycleMode');
  if (body == null) return { ok: false, detail: 'store.ts 未定义 cycleMode' };
  const m = body.match(/order:\s*PlayMode\[\]\s*=\s*\[([^\]]*)\]/);
  if (!m) return { ok: false, detail: 'cycleMode 里找不到 order 数组' };
  const items = m[1]
    .split(',')
    .map((x) => x.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
  const want = ['list', 'one', 'shuffle', 'order', 'heartbeat'];
  const ok = items.length === want.length && want.every((w, i) => items[i] === w);
  return {
    ok,
    detail: ok ? '' : `cycleMode 档位顺序应为 ${want.join(' → ')}，实为 ${items.join(' → ') || '(空)'}`,
  };
});
add('HEARTBEAT.defaultIsOrder', 'HEARTBEAT', (s) => {
  // 默认档位必须是顺序播放（需求明文）。两处都要对：初始 state 与缺省时的水合回落。
  const missing = [];
  if (!/^\s*playMode: 'order',$/m.test(s.store)) missing.push("store 初始 state 的 playMode 不是 'order'");
  const body = methodBody(stripComments(s.store), 'hydratePrefs');
  if (body == null || !/ALL_MODES/.test(body) || !/:\s*'order';/.test(body))
    missing.push('hydratePrefs 未把缺省/脏值回落到 order');
  return { ok: missing.length === 0, detail: missing.length ? `默认播放模式：${missing.join('、')}` : '' };
});
add('HEARTBEAT.gatedByLikedAndPlatform', 'HEARTBEAT', (s) => {
  // 心动模式是**有条件可用**的档位：仅网易云 + 仅「我喜欢的音乐」上下文。
  // 判据落在那唯一一个出口 canUseHeartbeat 上（两个条件都要在，且用平台能力函数而非硬编码）。
  //
  // ⚠️ 不能用 fnBodyAny 取本函数的函数体：它的入参是对象类型字面量 `state: {...}`，
  // 那是签名里的第一个 `{`，会被当成函数体的起点 —— 取出来的是**类型声明**，
  // 于是 `supportsSimilar` 永远找不到（断言假红，且红得毫无道理）。
  // 这里改为直接取 return 表达式：条件必须出现在**返回式**里才算真的判了。
  const src = stripComments(s.store);
  const ret = /function\s+canUseHeartbeat\s*\([\s\S]*?return\s+([^;]+);/.exec(src);
  const missing = [];
  if (!ret) missing.push('playback.ts 未定义 canUseHeartbeat');
  else {
    if (!/supportsSimilar/.test(ret[1])) missing.push('未走平台能力函数（硬编码平台名会在新增平台时漏改）');
    if (!/queueFromLiked/.test(ret[1])) missing.push('未判「我喜欢的音乐」上下文');
  }
  // 能力名单本身也要对：supportsSimilar 只对网易云为真（防"为了让它跑起来把门禁放开"）
  const cap = fnBodyAny(stripComments(s.platform ?? ''), 'supportsSimilar');
  if (cap == null) missing.push('platform.ts 未定义 supportsSimilar');
  else if (!/netease/.test(cap) || /kugou|qqmusic|migu/.test(cap))
    missing.push('supportsSimilar 应对非网易云一律 false');
  return { ok: missing.length === 0, detail: missing.length ? `心动可用性判据：${missing.join('、')}` : '' };
});
add('HEARTBEAT.noRandomDegrade', 'HEARTBEAT', (s) => {
  // 🔴 旧行为是"平台不支持就降级成随机"，本版明确禁止：
  // 随机听起来像心动、实则毫无相关性 —— 与假控件同级。
  // 判据：cycleMode 必须**跳过**不可用的心动档（不落档）。
  //
  // 🔴 v2.3 口径变更：不可用时**不弹 toast**。需求给定"不是我喜欢的音乐的歌单
  // 播放时，不显示心动模式的按钮就行"—— 提示只说明"你按的没用"，没有可操作价值，
  // 而每次按都甩一条会让人以为按钮坏了。所以这里**反向钉死**：不得再有 toast。
  const body = methodBody(stripComments(s.store), 'cycleMode');
  if (body == null) return { ok: false, detail: 'store.ts 未定义 cycleMode' };
  const missing = [];
  if (!/canUseHeartbeat/.test(body)) missing.push('cycleMode 未按 canUseHeartbeat 跳过不可用档位');
  if (!/continue;/.test(body)) missing.push('不可用时没有跳过（会落在一个用不了的档上）');
  if (/\.toast\(/.test(body)) missing.push('仍在弹"不可用"提示（需求：不显示按钮即可，不必提示）');
  // setPlayMode 里也要有同一道闸兜底
  const sp = methodBody(stripComments(s.store), 'setPlayMode');
  if (sp == null || !/canUseHeartbeat/.test(sp)) missing.push('setPlayMode 缺同一道闸（可绕过 cycleMode 直接落档）');
  if (sp && /\.toast\(/.test(sp)) missing.push('setPlayMode 仍在弹"不可用"提示');
  // UI 侧必须真的"不显示"：模式按钮要接 heartbeatAvailable，且不可用时回落显示前一档。
  // ⚠️ 判 props 的**使用**而不只是定义：定义在、没传值 = 恒为默认真 = 照常显示心动档。
  const pmb = readMaybe(F.playModeButton);
  if (pmb == null) return { ok: false, detail: 'components/units/PlayModeButton.tsx 不存在', ...{} };
  const pmbBody = stripComments(pmb);
  if (!/heartbeatAvailable/.test(pmbBody))
    missing.push('PlayModeButton 没有 heartbeatAvailable（不可用时仍显示心动档）');
  // ⚠️ 必须锚定**赋值号**：写成 `/mode === 'heartbeat' && !heartbeatAvailable/` 的话，
  // 把它改成 `false && mode === 'heartbeat' && !heartbeatAvailable` 后子串照样命中 ⇒ 断言假绿，
  // 而运行时那一档已经不再被隐藏（反证轮实测）。
  else if (!/=\s*mode\s*===\s*'heartbeat'\s*&&\s*!heartbeatAvailable/.test(pmbBody))
    missing.push('PlayModeButton 收了 heartbeatAvailable 却没在渲染时用它');
  // 两个调用点都要真的把它传下去（漏一处 = 播放条不显示、展开播放器照旧显示）
  for (const [id, key] of [
    ['playerBar', 'playerBar'],
    ['expanded', 'expanded'],
  ]) {
    const src = stripComments(s[key] ?? '');
    if (!/heartbeatAvailable=\{heartbeatAvailable\}/.test(src))
      missing.push(`${id} 未把 heartbeatAvailable 传给 PlayModeButton`);
    if (!/canUseHeartbeat/.test(src)) missing.push(`${id} 未走 canUseHeartbeat 判据`);
  }
  // 冷启动兜底：偏好里的 heartbeat 必须被挡（此刻 queueFromLiked 恒假 ⇒ 该档不可用）
  const init = stripComments(readMaybe(path.join(APP, 'src', 'modules', 'music', 'actions', 'init.ts')));
  if (!/prefs\.playMode\s*!==\s*'heartbeat'/.test(init))
    missing.push('hydratePrefs 未挡下偏好里的 heartbeat（冷启动会出现"显示心动却不可用"）');
  return { ok: missing.length === 0, detail: missing.length ? `心动不可用时的处理：${missing.join('、')}` : '' };
});
add('HEARTBEAT.enterRebuildsQueue', 'HEARTBEAT', (s) => {
  // 进入心动 = 拿当前歌换一批相似歌重排队列。两种情形必须可区分：
  //   ① 首次进入：队列 = 心动列表本身，**从它的第一首开始播**（种子歌不进队列 ——
  //      留在队首会让播放列表第一行永远显示一首没在播的歌）；
  //   ② 再次进入：保留当前歌继续播，种子歌放队首、其余换成新列表。
  const body = methodBody(stripComments(s.store), 'enterHeartbeat');
  if (body == null) return { ok: false, detail: 'store.ts 未定义 enterHeartbeat' };
  const missing = [];
  if (!/similarSongs\(/.test(body)) missing.push('未调 similarSongs');
  // 队列必须按"首次/再次"分两种形态。⚠️ 只判 `[seed, ...pick]` 出现过是不够的：
  // 改成 `const nextQueue = [seed, ...pick]`（无视 already）后那行照样在源码里，
  // 断言会假绿，而运行时首次进入会把种子歌摆在队首却不播它（反证轮可打红）。
  if (!/already\s*\?\s*\[\s*seed\s*,\s*\.\.\.pick\s*\]\s*:\s*pick/.test(body))
    missing.push('队列未按首次/再次进入分两种形态（首次进入的种子歌不该留在队首）');
  // 排除种子自身（接口可能把它自己算进相似里 → 队列里出现两遍）
  if (!/songKey/.test(body)) missing.push('未按 songKey 排除当前曲');
  // 首次/再次：由 heartbeatSeeded 区分，且**必须真的读它**。
  // ⚠️ 只判"源码里出现过 heartbeatSeeded"是不够的：把判定改成 `const already = false;`
  // 后，后面那句 `heartbeatSeeded: true` 仍在源码里 —— 断言照样绿，而"区分首次/再次"已经没了（反证轮实测）。
  if (!/already\s*=\s*get\(\)\.heartbeatSeeded/.test(body))
    missing.push('未真的读 heartbeatSeeded 来区分首次/再次进入');
  if (!/heartbeatSeeded:\s*true/.test(body)) missing.push('未把 heartbeatSeeded 置真');
  // 两条路径都要在：置真的那条是"再次进入"，有 playSong 的那条是"首次进入从头播"
  if (!/if\s*\(\s*already\s*\)/.test(body)) missing.push('缺"再次进入"分支');
  if (!/playSong\(/.test(body)) missing.push('首次进入没有"从头播放第一首"');
  // ⚠️ 首次进入必须从**新列表第一首**播，不能播种子歌：
  // 写死 playSong(seed, ...) 时源码里 playSong 照样在，判"有没有 playSong"会假绿。
  if (!/playSong\(nextQueue\[0\]/.test(body))
    missing.push('首次进入播的不是心动列表第一首（会先播进来前那首，需求要求直接播新列表第一首）');
  return { ok: missing.length === 0, detail: missing.length ? `enterHeartbeat：${missing.join('、')}` : '' };
});
add('HEARTBEAT.nextAdvances', 'HEARTBEAT', (s) => {
  // 🔴 心动模式下 `next()` **必须先尝试在队列里前进**，只有走到队尾才换一批。
  // 早先无条件调 enterHeartbeat()，而它的"再次进入"语义是**保留当前歌**，
  // 于是自然播完时原地重播、整个心动模式卡死在第一首（这是本轮修掉的真实缺陷）。
  const body = methodBody(stripComments(s.store), 'next');
  if (body == null) return { ok: false, detail: 'store.ts 未定义 next' };
  const missing = [];
  if (!/currentIndex\s*\+\s*1\s*<\s*queue\.length/.test(body))
    missing.push('未判"队列里还有下一首"（会直接换一批而不前进）');
  if (!/enterHeartbeat\(\s*\{\s*advance:\s*true\s*\}\s*\)/.test(body))
    missing.push('队尾续播未走 advance 路径（换一批后不会前进）');
  // advance 路径**必须真的前进**：播新列表的第一首，而不是停在原地
  const eh = methodBody(stripComments(s.store), 'enterHeartbeat');
  if (!/opts\?\.advance/.test(eh ?? '')) missing.push('enterHeartbeat 未支持 advance');
  // advance 路径**必须真的前进**：播新列表的第一首，而不是停在原地。
  // ⚠️ v2.3：首次进入的队列里**没有种子歌**（= pick），再次进入才有（= [seed, ...pick]），
  // 所以起点要按下标条件取，不能写死 nextQueue[1]（首次进入会跳过新列表真正的第一首）。
  if (!/startAt/.test(eh ?? '')) missing.push('advance 路径没有按"队列里有没有种子"取起点');
  if (!/already\s*\?\s*1\s*:\s*0/.test(eh ?? ''))
    missing.push('advance 起点未区分首次/再次进入（首次进入会跳过新列表第一首）');
  return { ok: missing.length === 0, detail: missing.length ? `心动模式的推进：${missing.join('、')}` : '' };
});
add('HEARTBEAT.restoresQueueOnLeave', 'HEARTBEAT', (s) => {
  // 切离心动模式要把队列**恢复成原来的播放列表**（需求第 5 点）——
  // 心动把队列换成了相似歌，不先存快照就永远拿不回来。
  const sp = methodBody(stripComments(s.store), 'setPlayMode');
  if (sp == null) return { ok: false, detail: 'store.ts 未定义 setPlayMode' };
  const eh = methodBody(stripComments(s.store), 'enterHeartbeat');
  const missing = [];
  if (!/heartbeatRestore/.test(eh ?? '')) missing.push('enterHeartbeat 未存原队列快照');
  if (!/heartbeatRestore/.test(sp)) missing.push('setPlayMode 未消费原队列快照（切走时恢复不出来）');
  // 🔴 必须判**门禁条件本身**，不能只判"恢复代码在不在"：
  // 把条件改成 `if (false)` 后，恢复那几行照样留在源码里，断言会假绿
  // ——而运行时永远走不到，用户切走时列表仍停在相似歌上（反证轮实测抓到）。
  if (!/playMode\s*===\s*'heartbeat'\s*&&\s*get\(\)\.heartbeatRestore/.test(sp))
    missing.push('恢复分支的门禁不成立（被短路后代码还在、但永远走不到）');
  if (!/queue:\s*snap\.queue/.test(sp) && !/snap\.queue/.test(sp)) missing.push('恢复时没有换回快照里的队列');
  // ⚠️ v2.3：正在播的歌若不在原列表里，必须**置顶**（插到队首）而不是跳回原下标。
  // 否则用户正听的那首会被悄悄换成另一首，界面毫无提示。
  if (!/found\s*<\s*0\s*\?\s*\[\s*cur\s*,\s*\.\.\.snap\.queue\s*\]/.test(sp))
    missing.push('正在播的歌不在原列表时没有置顶（会被换成另一首，界面无提示）');
  // 置顶那一支的下标必须指向 0（置顶 = 第一行）
  if (!/currentIndex:[^;]*?found\s*<\s*0\s*\?\s*0\s*:/.test(sp) && !/cur\s*&&\s*found\s*<\s*0\s*\?\s*0\s*:/.test(sp))
    missing.push('置顶了但 currentIndex 没指向 0（抽屉会高亮到别的行）');
  // ⚠️ 恢复时**不能**复位 heartbeatSeeded：复位了的话再切回心动会被当成首次进入、把当前歌从头重播
  if (/heartbeatSeeded:\s*false/.test(sp)) missing.push('恢复时复位了 heartbeatSeeded（再进心动会把当前歌从头重播）');
  return { ok: missing.length === 0, detail: missing.length ? `切离心动恢复队列：${missing.join('、')}` : '' };
});

// ── 播放列表入口（歌单 / 本地 / 历史 的统一语义）──────────────────────────
add('PLAYLIST.startIndexByMode', 'PLAYER', (s) => {
  // 需求第 2 条：点「播放全部」时，列表循环/单曲循环/顺序播放从**第一首**起，
  // 随机播放则**随机**挑一首。用户点了具体某一首（opts.index）则以它为准 ——
  // 精确意图不该被任何模式改写。
  const body = methodBody(stripComments(s.store), 'playPlaylist');
  if (body == null) return { ok: false, detail: 'store.ts 未定义 playPlaylist' };
  const missing = [];
  if (!/opts\?\.index\s*!=\s*null/.test(body)) missing.push('未区分"点某一首"与"播放全部"');
  if (!/playMode\s*===\s*'shuffle'/.test(body)) missing.push('未按随机档分流（顺序档与随机档会一个样）');
  if (!/Math\.random\(\)/.test(body)) missing.push('随机档没有随机（等于顺序播）');
  return { ok: missing.length === 0, detail: missing.length ? `播放全部的起始位：${missing.join('、')}` : '' };
});
add('PLAYLIST.rowsGoThroughPlaylist', 'PLAYER', (s) => {
  // 需求第 6 条：播放历史与本地曲库是**独立的播放列表** —— 点其中一行要把**整份列表**
  // 设为队列并从该行开始（这样「下一首」才沿着用户看到的列表走）。
  // 走 playPlaylist 而不是 playQueue，才能同时获得"切换列表"的联动（离开心动 → 顺序播放）。
  const missing = [];
  for (const [id, key] of [
    ['local', 'localView'],
    ['history', 'historyView'],
  ]) {
    const src = stripComments(s[key] ?? '');
    if (!/playPlaylist\(/.test(src)) missing.push(`${key} 未走 playPlaylist（不是独立播放列表）`);
    // 队列必须是"整份列表"，而不是只播点中的那一首
    if (!/Queue\b/.test(src)) missing.push(`${key} 未构造整份列表作为队列`);
  }
  return { ok: missing.length === 0, detail: missing.length ? `本地/历史播放入口：${missing.join('、')}` : '' };
});
add('PLAYLIST.leavesHeartbeatToOrder', 'HEARTBEAT', (s) => {
  // 需求第 4 条：切换歌单/换列表时，若当前是心动模式 → 先切成顺序播放。
  const body = methodBody(stripComments(s.store), 'playPlaylist');
  if (body == null) return { ok: false, detail: 'store.ts 未定义 playPlaylist' };
  const missing = [];
  if (!/playMode\s*===\s*'heartbeat'/.test(body)) missing.push('未判当前是否心动模式');
  if (!/playMode:\s*'order'/.test(body)) missing.push("未切到顺序播放（'order'）");
  // 必须**先改模式再定起始位**：否则"随机档 + 从心动切来"会走随机，与"切成顺序播放"相抵
  const iMode = body.indexOf("playMode: 'order'");
  const iIdx = body.indexOf('Math.random()');
  if (iMode >= 0 && iIdx >= 0 && iMode > iIdx) missing.push('先定起始位再改模式（随机档会绕过"切成顺序播放"）');
  return { ok: missing.length === 0, detail: missing.length ? `切歌单离开心动：${missing.join('、')}` : '' };
});
add('PLAYLIST.likedAutoHeartbeat', 'HEARTBEAT', (s) => {
  // 需求第 4 条后半：「我喜欢的音乐」**单独**记着有没有开启过心动模式 ——
  // 开启过就在切进该歌单时自动切到心动并开始播放；没开启过则沿用前一个歌单的模式。
  const body = methodBody(stripComments(s.store), 'playPlaylist');
  const missing = [];
  if (!/likedHeartbeatOn/.test(body ?? '')) missing.push('未读「我喜欢的音乐」的心动开关');
  if (!/isLiked/.test(body ?? '')) missing.push('未识别「我喜欢的音乐」（isLiked 标识）');
  if (!/setPlayMode\(\s*'heartbeat'\s*\)/.test(body ?? '')) missing.push('开启过却没自动切到心动');
  // 标识必须在拉歌单时打上，否则 isLiked 永远是假。
  // ⚠️ 判"按 subscribed 找"这个**判据本身**，而不是判"源码里有没有 isLiked: true"：
  // 后者在把 findIndex 结果打成 -1 后照样命中（标记代码还在、但永远走不到），
  // 反证轮实测过这种假绿。
  const left = stripComments(s.store);
  if (!/findIndex\(\s*\(pl\)\s*=>\s*pl\.subscribed\s*===\s*false\s*\)/.test(left))
    missing.push('未按 subscribed=false 找出「我喜欢的音乐」（判据失效 ⇒ 一条都认不出来）');
  if (!/isLiked:\s*true/.test(left)) missing.push('找到后没有打 isLiked 标识');
  // 改名也要钉住：那是需求第 1 条的另一半（各平台原名不一）
  if (!/name:\s*LIKED_PLAYLIST_NAME/.test(left)) missing.push('没有把该歌单名统一改成「我喜欢的音乐」');
  // 并且要持久化，跨会话保留（prefs.ts 不在 s.store 的拼接范围里，直接按路径读）
  // ⚠️ 用 \b 而不是裸子串：把声明改名成 `likedHeartbeatOnRemoved` 时裸子串仍会命中（反证轮实测假绿）。
  const prefsSrc = stripComments(readMaybe(path.join(APP, 'src', 'modules', 'music', 'prefs.ts')));
  if (!/\blikedHeartbeatOn\b/.test(prefsSrc)) missing.push('likedHeartbeatOn 未进偏好（重启就丢）');
  return { ok: missing.length === 0, detail: missing.length ? `我喜欢的音乐的心动记忆：${missing.join('、')}` : '' };
});

// ── 播放队列抽屉（当前曲常驻顶部 + 从右滑入）──────────────────────────────
add('QUEUE.scrollsToCurrent', 'QUEUE', (s) => {
  // 需求第 3 条：点开播放列表要"看得见正在播的那首"。
  //
  // 口径演进（ver3）：设计稿把抽屉改成**两段式** —— 上面「正在播放」单独一行固定不滚、
  // 下面「接下来 · N 首」才是滚动区。于是"定位到当前曲"从"滚过去"变成了**结构保证**：
  // 那一行永远在顶部，不存在被滚走的情况。所以判据从 `scrollToIndex={currentIndex}`
  // 改成"抽屉里真的渲染了正在播放段，且接下来段从 currentIndex+1 起切"。
  // 仍要求 VirtualList 支持 scrollToIndex（左栏/搜索结果还在用它）。
  const drawer = stripComments(s.queueDrawer ?? '');
  const vl = stripComments(readMaybe(F.virtualList));
  const missing = [];
  if (!/qd-caption">正在播放/.test(drawer)) missing.push('QueueDrawer 没有「正在播放」段（当前曲必须常驻顶部）');
  if (!/queue\.slice\(currentIndex \+ 1\)/.test(drawer)) missing.push('「接下来」段没有从当前曲之后切');
  if (!/qd-caption">接下来 · \{upcoming\.length\} 首/.test(drawer)) missing.push('「接下来」段没有带真实条数');
  if (!/scrollToIndex/.test(vl)) missing.push('VirtualList 未支持 scrollToIndex');
  return { ok: missing.length === 0, detail: missing.length ? `播放列表定位：${missing.join('、')}` : '' };
});
add('QUEUE.heartbeatTitle', 'QUEUE', (s) => {
  // 心动模式下队列来自 music_intelligence_list（相似歌），不是用户点开的那个歌单 ——
  // 标题必须跟着变，否则左栏停在歌单上、抽屉里却是一批陌生的歌，两处对不上且无提示。
  const drawer = stripComments(s.queueDrawer ?? '');
  const missing = [];
  // 设计稿不换标题，把模式放进副标题：`<N 首> · <模式>`，模式名取自单一事实源 `playModeLabel`
  if (!/playModeLabel\(playMode\)/.test(drawer)) missing.push('副标题没有带上播放模式（心动模式下拉不出 心动模式）');
  if (!/queue\.length\} 首/.test(drawer)) missing.push('副标题没有带队列条数');
  // 必须由 store 的 playMode 驱动，不能写死
  if (!/useMusicStore\(\s*\(s\)\s*=>\s*s\.playMode\s*\)/.test(drawer))
    missing.push('QueueDrawer 未从 store 取 playMode（标题会变成写死值）');
  return { ok: missing.length === 0, detail: missing.length ? `抽屉标题：${missing.join('、')}` : '' };
});
add('QUEUE.drawerSlidesIn', 'QUEUE', (s) => {
  // 需求第 5 条：播放列表以抽屉形式**从右往左展开**。
  const css = s.css;
  // 设计稿的进场是 `ui-drawer-in`：位移 24px + 从 .6 淡入（不是横穿一屏的 100% → 0）
  const rule = (css.match(/\.ui-drawer\s*\{([^}]*)\}/) || [, ''])[1];
  const missing = [];
  if (!/animation\s*:\s*ui-drawer-in/.test(rule)) missing.push('抽屉没有进场动画');
  const kf = (css.match(/@keyframes\s+ui-drawer-in\s*\{([\s\S]*?)\n\}/) || [, ''])[1];
  if (!/translateX\(24px\)/.test(kf)) missing.push('起点不是 translateX(24px)（设计稿只滑一小段）');
  if (!/opacity:\s*0\.6/.test(kf)) missing.push('起点没有从 .6 淡入');
  if (!/transform:\s*none|translateX\(0\)/.test(kf))
    missing.push('终点没有回到原位（translateX(0) / transform: none）');
  // 蒙层**不能**跟着平移（整屏遮罩横移会露出下面的界面），只能淡入
  const bd = (css.match(/\.ui-drawer-mask\s*\{([^}]*)\}/) || [, ''])[1];
  if (/translateX/.test(bd)) missing.push('蒙层也跟着平移了（遮罩横移会露出底下的界面）');
  if (!/animation\s*:\s*miao-fade-in/.test(bd)) missing.push('蒙层没有淡入动画');
  return { ok: missing.length === 0, detail: missing.length ? `队列抽屉展开：${missing.join('、')}` : '' };
});

// 这一组断言的全都是「**静默失效**」型陷阱：每一条不满足时都不会报错，
// 只是某个功能在真机上悄悄不工作。所以必须逐条锁死。
add('LYRICS.rustCommands', 'LYRICS', (s) => {
  // 只定义不注册 = 不可调用，两层都要独立测到（与 RUST 组的判据同源）
  if (!s.rustLyrics) return { ok: false, detail: 'src-tauri/src/commands/lyrics_window.rs 不存在' };
  const need = ['open_lyrics_window', 'close_lyrics_window', 'lyrics_push'];
  const missing = need.filter((n) => !new RegExp(`fn\\s+${n}\\s*\\(`).test(s.rustLyrics));
  const notRegd = need.filter((n) => !new RegExp(`lyrics_window::${n}`).test(s.rustRegistry));
  if (missing.length) return { ok: false, detail: `未定义：${missing.join('、')}` };
  if (notRegd.length)
    return {
      ok: false,
      detail: `已定义但未在 commands/mod.rs 注册（调用会抛 command not found）：${notRegd.join('、')}`,
    };
  return { ok: true, detail: '' };
});
add('LYRICS.sameOrigin', 'LYRICS', (s) => {
  // ⚠️ 本条是**整条 P3 最关键**的一条：用 External 加载歌词窗 → 跨 origin →
  // localStorage 隔离 → 歌词窗读不到主窗写的字号/高亮色/锁定态。
  // 与官方登录窗口（用 External）是**不同场景**，照抄就错。
  if (!s.rustLyrics) return { ok: false, detail: 'lyrics_window.rs 不存在' };
  const usesApp = /WebviewUrl::App\(\s*"templates\/lyrics\.html"/.test(s.rustLyrics);
  if (!usesApp) {
    const usesExternal = /WebviewUrl::External/.test(s.rustLyrics);
    return {
      ok: false,
      detail: usesExternal
        ? '歌词窗用了 WebviewUrl::External → 跨 origin → localStorage 隔离（读不到偏好）'
        : '未找到 WebviewUrl::App("templates/lyrics.html")（歌词窗必须加载应用自身页面才同 origin）',
    };
  }
  return { ok: true, detail: '' };
});
add('LYRICS.capabilityWindow', 'LYRICS', (s) => {
  // D-47 查出的坑：capabilities 的 windows 是白名单，不在里面 → 任何命令都被 ACL 拒，
  // 且报的是"权限不足"而不是"窗口不存在"，极易误判成代码写错。
  let cap;
  try {
    cap = JSON.parse(s.capabilities);
  } catch {
    return { ok: false, detail: 'capabilities/default.json 不是合法 JSON' };
  }
  const wins = cap.windows || [];
  if (!wins.includes('desktop-lyrics'))
    return {
      ok: false,
      detail: `capabilities.windows 缺 desktop-lyrics（现有 ${JSON.stringify(wins)}）→ 该窗口调任何 Tauri 命令都会被 ACL 拒绝`,
    };
  return { ok: true, detail: '' };
});
add('LYRICS.dragPermission', 'LYRICS', (s) => {
  // 同族的第二个坑：core:window:default 展开的 25 项里**不含** start-dragging，
  // 不显式加授权，拖动会被拒（子 agent 实测发现并回报的）
  let cap;
  try {
    cap = JSON.parse(s.capabilities);
  } catch {
    return { ok: false, detail: 'capabilities/default.json 不是合法 JSON' };
  }
  const perms = cap.permissions || [];
  const need = ['core:window:allow-start-dragging', 'core:window:allow-set-position'];
  const missing = need.filter((p) => !perms.includes(p));
  if (missing.length)
    return { ok: false, detail: `capabilities.permissions 缺 ${missing.join('、')}（core:window:default 不含它们）` };
  return { ok: true, detail: '' };
});
add('LYRICS.viteMultiEntry', 'LYRICS', (s) => {
  // 单入口时 dist 里没有 lyrics.html，Rust 的 WebviewUrl::App("templates/lyrics.html") 会加载失败
  if (!s.viteConfig) return { ok: false, detail: 'vite.config.ts 不存在' };
  if (!/lyrics:\s*new URL\(\s*['"]\.\/templates\/lyrics\.html['"]/.test(s.viteConfig))
    return { ok: false, detail: 'vite 未把 templates/lyrics.html 配成第二个入口（dist 里不会有它）' };
  if (!s.lyricsHtml) return { ok: false, detail: 'templates/lyrics.html 不存在' };
  return { ok: true, detail: '' };
});
add('LYRICS.progressNotPushed', 'LYRICS', (s) => {
  // ⚠️ 这条防的是"为了让它跟得更准，在 setProgress 里也推一次"这种看起来很自然的改动。
  // timeupdate 是每秒数次 → 每条都要跨进程序列化 + emit → 症状是**主窗整体发涩、
  // 歌词窗反而卡顿**（一个为省事加的推送同时毁掉两个窗口）。
  //
  // ⚠️ 取体方式要覆盖**两种形态**：`setProgress` 是单表达式箭头（无花括号体），
  // 而 `methodBody` 只认 `{` 开的块体 —— 直接用它会恒报"未定义"（假红）。
  // 这里改成：取该方法所在的一行（单表达式）或者它的花括号体。
  const src = stripComments(s.store);
  const oneLine = new RegExp(`\\n\\s*setProgress:\\s*([^\\n]*)`).exec(src);
  const block = methodBody(src, 'setProgress');
  const body = [oneLine ? oneLine[1] : '', block ?? ''].join('\n');
  if (!body.trim()) return { ok: false, detail: 'store.ts 未找到 setProgress 的实现' };
  if (/pushLyricsState|lyricsPush/.test(body))
    return { ok: false, detail: 'setProgress 里推了桌面歌词状态（每秒数次，会打满事件通道）' };
  return { ok: true, detail: '' };
});
add('LYRICS.rafAdvance', 'LYRICS', (s) => {
  // 歌词窗必须自己推进进度：主窗推一次 startedAtMs，之后靠本地单调钟走。
  // 判据锁两件事：用了 rAF（不是 setInterval —— 定时器在后台被节流到 1Hz 会导致歌词跳），
  // 以及真的以 startedAtMs 为基准。
  if (!s.desktopLyrics) return { ok: false, detail: 'DesktopLyrics.tsx 不存在' };
  const dl = stripComments(s.desktopLyrics);
  const missing = [];
  if (!/requestAnimationFrame/.test(dl)) missing.push('未用 requestAnimationFrame');
  // ⚠️ 关键：**反向**判据 —— 不能用定时器推进。setInterval 在后台/不可见窗口会被浏览器
  // 节流到 ~1Hz，歌词就会"一跳一跳"；rAF 与渲染同频、暂停即停。只判"用没用 rAF"不够：
  // 该文件有两处 rAF 调用，改掉一处仍为真（反证轮实测抓到的假阳性）。
  if (/setInterval\s*\(/.test(dl)) missing.push('用了 setInterval 推进进度（后台会被节流到 ~1Hz）');
  if (!/startedAtMs/.test(dl)) missing.push('未以 startedAtMs 为基准');
  if (!/lyrics:\/\/state/.test(dl)) missing.push('未监听 lyrics://state 事件');
  return {
    ok: missing.length === 0,
    detail: missing.length ? `桌面歌词进度推进：${missing.join('、')}` : '',
  };
});
add('LYRICS.degrade', 'LYRICS', (s) => {
  // 降级必须存在：没歌词 / 没歌曲时不能变成空白条或自行关窗
  // （自行关窗会让"开关状态"与实际不符 —— 那是主窗的职责）
  if (!s.desktopLyrics) return { ok: false, detail: 'DesktopLyrics.tsx 不存在' };
  const dl = stripComments(s.desktopLyrics);
  const missing = [];
  if (!/lines\.length\s*===\s*0|noLyrics/.test(dl)) missing.push('无歌词未降级');
  if (!/songId\s*===\s*null|!hasSong|hasSong\s*&&/.test(dl)) missing.push('无歌曲未降级');
  return {
    ok: missing.length === 0,
    detail: missing.length ? `桌面歌词降级：${missing.join('、')}` : '',
  };
});
add('LYRICS.stateFieldMatch', 'LYRICS', (s) => {
  // ⚠️ 本条防的是**跨语言契约漂移**：Rust 用 serde 反序列化前端传的结构体，
  // 字段名对不上就**整条命令失败** —— 而失败通常被 .catch() 静默吞掉，
  // 症状只是"拖动后位置不记忆"，没有任何报错指向真因（D-49 踩过：口径改了漏改前端）。
  // 这类缺陷 tsc / vite / cargo **全都测不到**（两端各自合法，只是对不上）。
  if (!s.rustLyrics) return { ok: false, detail: 'lyrics_window.rs 不存在' };
  const rust = stripComments(s.rustLyrics);
  const dl = stripComments(s.desktopLyrics ?? '');
  // 取 Rust 结构体里定义的字段名
  const st = rust.match(/pub struct LyricsWindowState\s*\{([\s\S]*?)\n\}/);
  if (!st) return { ok: false, detail: 'Rust 侧找不到 LyricsWindowState 定义' };
  const fields = [...st[1].matchAll(/pub\s+(\w+)\s*:/g)].map((m) => m[1]);
  if (fields.length === 0) return { ok: false, detail: 'LyricsWindowState 没解析出字段' };
  // 前端构造的对象字面量里必须带齐这些字段
  const obj = dl.match(/const state\s*:\s*WindowState\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!obj) return { ok: false, detail: 'DesktopLyrics 里找不到构造 WindowState 的对象字面量' };
  const missing = fields.filter((f) => !new RegExp('\\b' + f + '\\s*:').test(obj[1]));
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `前端 WindowState 缺 Rust 要求的字段：${missing.join('、')}（serde 会反序列化失败，命令静默失效）`
      : '',
  };
});
add('LYRICS.assetProtocol', 'LYRICS', (s) => {
  // ⚠️ 本地歌曲播放需要**两处同时配置**，缺任何一处都是「静默失败」——
  //   ① `Cargo.toml` 的 tauri feature `protocol-asset`
  //      → 已核 tauri 2.12.1 源码：`manager/webview.rs` 里 asset 协议的注册被
  //        `#[cfg(feature = "protocol-asset")]` 门禁，**不加则协议根本不注册**，
  //        此时 conf 里写 `enable: true` 会被完全忽略。
  //      → 该 feature 展开为 `["http-range"]`，顺带带来 Range 支持。
  //   ② `tauri.conf.json` 的 `app.security.assetProtocol`（enable + 非空 scope）
  //      → Tauri v2 默认 `enable: false`（已核官方文档）。
  //
  // 症状（真踩过）：**导入本地歌成功、播放必然失败** —— 一个"半可用"状态，
  // 最容易被误判成"播放器坏了"。而两处缺任意一处，编译/构建/断言当时**全绿**。
  const missing = [];

  // ① Cargo feature
  const cargo = s.cargoToml || '';
  // 只在 tauri 依赖那一行里找 feature，避免命中注释或其它 crate
  const tauriLine = cargo.split('\n').find((l) => /^\s*tauri\s*=/.test(l)) || '';
  if (!/protocol-asset/.test(tauriLine)) {
    missing.push('Cargo.toml 的 tauri 依赖缺 `protocol-asset` feature（asset 协议不注册）');
  }

  // ② conf 配置
  let conf;
  try {
    conf = JSON.parse(s.tauriConf);
  } catch {
    return { ok: false, detail: 'tauri.conf.json 不是合法 JSON 或不存在' };
  }
  const ap = conf?.app?.security?.assetProtocol;
  if (!ap) {
    missing.push('缺 app.security.assetProtocol（Tauri v2 默认 enable:false）');
  } else {
    if (ap.enable !== true) missing.push('assetProtocol.enable 不为 true');
    const scope = Array.isArray(ap.scope) ? ap.scope : [];
    if (scope.length === 0) missing.push('assetProtocol.scope 为空（enable 了但谁都不放行）');
  }

  return {
    ok: missing.length === 0,
    detail: missing.length ? missing.join('；') : 'Cargo feature + conf 两处齐全',
  };
});
add('LYRICS.coordUnit', 'LYRICS', (s) => {
  // ⚠️ 本条防的是 D-53 缺陷 ①：窗口坐标的**单位混用**。
  // `Monitor::size()` 报**物理像素**（Retina 2×），`position()` 收**逻辑像素** ——
  // 混用会让窗口落到可视区外：症状是"点了没反应"而**日志干净**（真踩过：
  // 1964−160−80=1724 交给逻辑坐标，而屏幕逻辑高只有 982）。
  // 判据锁三件事：有统一换算函数 / 里面有 scale_factor / 摆位处确实走它。
  if (!s.rustLyrics) return { ok: false, detail: 'lyrics_window.rs 不存在' };
  const rust = stripComments(s.rustLyrics);
  const missing = [];
  if (!/fn\s+monitor_logical_size/.test(rust))
    missing.push('缺统一换算入口 monitor_logical_size（换算散落多处迟早漏一处）');
  // ⚠️ 判据必须落在**换算函数体内部**，不能只扫全文 ——
  // `scale_factor()` 在文件里出现多次（新增的 resize_lyrics_window 里也有），
  // 只扫全文时"去掉换算函数里的那次调用"仍能匹配到别处 → 断言恒绿（反证轮实测抓到）。
  // 这是本项目第 5 次「只判存在、不判唯一」型假阳性。
  const conv = rustFnBody(rust, 'monitor_logical_size');
  if (conv == null) {
    missing.push('取不到 monitor_logical_size 的函数体');
  } else if (!/scale_factor\s*\(\s*\)/.test(conv)) {
    missing.push('换算函数内未调用 scale_factor()（物理→逻辑没换算）');
  }
  if (!/monitor_logical_size\s*\(/.test(rust)) missing.push('摆位处未使用换算函数');
  return {
    ok: missing.length === 0,
    detail: missing.length ? `窗口坐标单位：${missing.join('、')}` : '',
  };
});
add('LYRICS.windowAutoHeight', 'LYRICS', (s) => {
  // 窗口高度必须随「行数 × 字号」自适应。
  // 起因：窗口固定 160px 高，而设置里能把行数调到 5、字号调到 40 ——
  // 不调整高度就会**底部几行被静默裁掉**（`overflow:hidden` 下不是滚动，是消失）。
  //
  // 判据锁五件事（每一条都对应一个真实会出错的点）：
  //  · Rust 有命令且**已注册**（只定义不注册 = 调不到）
  //  · 有**单一**高度公式函数（几何散落多处必然漏改）
  //  · **限了上限**（无上限时 5 行 + 最大字号会变成一块大面板，与"一条浮在桌面上的文字"相悖）
  //  · **同时调整位置**（只改高度会让窗口往屏幕下方长出去 —— D-53 缺陷① 的同类后果）
  //  · 前端**真的调用**了它（设置改了也不生效等于没做）
  if (!s.rustLyrics) return { ok: false, detail: 'lyrics_window.rs 不存在' };
  const rust = stripComments(s.rustLyrics);
  const dl = stripComments(s.desktopLyrics ?? '');
  const missing = [];
  if (!/fn\s+resize_lyrics_window/.test(rust)) missing.push('Rust 缺 resize_lyrics_window');
  if (!/lyrics_window::resize_lyrics_window/.test(s.rustRegistry)) missing.push('commands/mod.rs 未注册');
  if (!/fn\s+window_height_for_lines/.test(rust)) missing.push('缺高度公式函数');
  if (!/MAX_H/.test(rust)) missing.push('高度未限上限');
  if (!/set_position/.test(rust)) missing.push('未同时调整位置（变高会往屏幕下方溢出）');
  if (!/resize_lyrics_window/.test(dl)) missing.push('桌面歌词窗未调用（改设置不生效）');
  return {
    ok: missing.length === 0,
    detail: missing.length ? `窗口自适应：${missing.join('、')}` : '',
  };
});
// ============================ AUDIO（音频图 / CORS）============================
// 这一组防的是「波形还在、声音没了」。三个环节任一错，症状都是**完全没声音**，
// 而且 Web Audio 的静音是**沉默的** —— 不抛错、不报错日志，最难定位。
// 用户报的第 4 条（网络歌曲播放没声音）就是其中之一。

add('AUDIO.corsMode', 'AUDIO', (s) => {
  // 音频图接管 <audio> 后，跨域资源在**非 CORS 模式**下输出恒为静音（Web Audio 安全规则）。
  // 本地歌曲走 asset://（带 CORS 头）不受影响 → 表现为"本地有声、网络无声"。
  const k = stripComments(s.kernel);
  const missing = [];
  if (!/crossOrigin=/.test(k)) missing.push('<audio> 未声明 crossOrigin');
  else if (!/crossOrigin=\{[^}]*'anonymous'/.test(k)) missing.push("crossOrigin 未取 'anonymous'");
  return { ok: missing.length === 0, detail: missing.length ? `CORS 模式：${missing.join('、')}` : '' };
});

add('AUDIO.fallback', 'AUDIO', (s) => {
  // 声明 CORS 模式后，不带 CORS 头的音源会**加载失败**（比静音更糟：歌直接播不了）。
  // 所以必须有回退：标记该元素不可接管 + 摘掉 crossOrigin 重载。
  // ⚠️ 顺序必须"先标记、后切模式"：反过来的话，两次操作之间存在一帧窗口，
  // 音频图可能在非 CORS 模式下接管 —— 那一帧就够让这首歌彻底没声。
  const k = stripComments(s.kernel);
  const missing = [];
  if (!/markNotWirable\(/.test(k)) missing.push('未标记不可接管（回退后会静音）');
  if (!/setCorsMode\(false\)/.test(k)) missing.push('未降级 CORS 模式（该音源将一直加载失败）');
  const iMark = k.indexOf('markNotWirable(');
  const iMode = k.indexOf('setCorsMode(false)');
  if (iMark >= 0 && iMode >= 0 && iMark > iMode) missing.push('顺序错：先切模式后标记（中间有一帧可被接管）');
  return { ok: missing.length === 0, detail: missing.length ? `CORS 回退：${missing.join('、')}` : '' };
});

add('AUDIO.trackEndedOne', 'AUDIO', (s) => {
  // 「单曲循环」曾经是坏的：onEnded 直接调 next()，而 next() 里 one 档落在
  // "顺序下一首"分支 → 播完就切歌，档位形同虚设（而且不报错，只是行为不对）。
  // 三条判据缺一不可：少任一条都可能出现"看着实现了、实际没接上"。
  const store = stripComments(s.store ?? '');
  const kernel = stripComments(s.kernel ?? '');
  const missing = [];
  if (!/handleTrackEnded\s*:\s*\(\)\s*=>/.test(store)) missing.push('store 缺 handleTrackEnded');
  // 单曲循环分支必须真的**重播当前曲**（把播放位置归零），而不是又走 next
  if (!/playMode === 'one'[\s\S]{0,400}?currentTime = 0/.test(store))
    missing.push('单曲循环分支未重播当前曲（播完仍会切歌）');
  // 组件侧必须调它 —— 改回 next() 就前功尽弃
  if (!/onEnded=\{\(\) => handleTrackEnded\(\)\}/.test(kernel))
    missing.push('MusicKernel 的 onEnded 未接 handleTrackEnded（单曲循环会失效）');
  return { ok: missing.length === 0, detail: missing.length ? `播完分流：${missing.join('、')}` : '' };
});
add('AUDIO.refuseNonCors', 'AUDIO', (s) => {
  // 模块层再兜一道：非 CORS 模式的元素**一律拒绝接管**。
  // 防的是"未来有人把 crossOrigin 去掉之后，波形还在、声音却没了"。
  const g = stripComments(s.audioGraph ?? '');
  if (!/crossOrigin === 'anonymous'/.test(g))
    return { ok: false, detail: 'audioGraph 未拒绝非 CORS 模式的元素（去掉 crossOrigin 后会静默丢声音）' };
  return { ok: true, detail: '' };
});

add('AUDIO.connectDestination', 'AUDIO', (s) => {
  // 建了图必须接回 destination（接管把输出改道进音频图，图没有出口＝静音）。
  // ⚠️ 判据**不能只认** `analyser.connect(destination)`：音量改由图上的 gain 管之后，
  // 链路是 `source → analyser → gain → destination`。只认旧写法会误红 ——
  // 这是"让断言跟上实现"，而不是"为了让断言变绿而放宽它"（下面那条是新加的更严判据）。
  const g = stripComments(s.audioGraph ?? '');
  const missing = [];
  if (!/\.connect\([^)]*destination\s*\)/.test(g)) missing.push('音频图未接回 destination（接管即静音）');
  // 而且链路必须经过 GainNode —— 没有它，「接管后元素 volume 在部分平台失效」
  // 就会表现为用户报的"拖音量滑块没反应"。
  if (!/createGain\(/.test(g)) missing.push('未建 GainNode（音量将依赖元素 volume，部分平台会失效）');
  if (!/gain\s*\.\s*connect\(/.test(g)) missing.push('GainNode 未接入链路');
  return { ok: missing.length === 0, detail: missing.length ? `音频图出口：${missing.join('、')}` : '' };
});

add('AUDIO.singleEntry', 'AUDIO', (s) => {
  // createMediaElementSource 对同一元素**只能调一次**，第二个调用方必然抛错，
  // 且错法是"波形不出来"这种不指向真因的现象 → 全前端只允许一处（audioGraph）。
  const all = stripComments(s.srcAll ?? '');
  const hits = (all.match(/createMediaElementSource/g) || []).length;
  const inGraph = (stripComments(s.audioGraph ?? '').match(/createMediaElementSource/g) || []).length;
  if (hits !== 1 || inGraph !== 1)
    return {
      ok: false,
      detail: `createMediaElementSource 应只在 audioGraph 出现 1 次，实际全文 ${hits} 次 / audioGraph ${inGraph} 次`,
    };
  return { ok: true, detail: '' };
});

add('AUDIO.regexLiteralTolerant', 'AUDIO', () => {
  // 正则字面量里的引号不能让剥注释器误入字符串态：否则该处之后的注释会被当成代码，
  // 「全文只允许 N 处」型计数（如 AUDIO.singleEntry）会因注释而虚高。
  const sample = 'const re = /["x]/g; // createMediaElementSource 只在注释\nconst keep = 1;\n';
  const stripped = stripComments(sample);
  const ok = !stripped.includes('createMediaElementSource') && stripped.includes('const keep');
  return {
    ok,
    detail: ok ? '' : '剥注释器未识别正则字面量里的引号 ⇒ 后续注释被当代码（计数型断言会虚高）',
  };
});

// ============================ CACHE（音乐缓存接线）============================
// 这一组防的是**「不报错但功能等于没接」**的一类失效。
//
// Rust 侧的命令早已实现，但 `check:music` 原先只判「冻结清单里的命令名必须
// 出现在 ipc.ts」—— 新增的 4 个缓存命令不在那份清单里，于是**漏接线不会变红**。
// 后果不是崩溃，而是下面这四条，每一条用户都察觉不到、只会觉得"这功能有点怪"：
//   ① 缓存 key 漏了 quality → 切档位后命中上次的文件，界面显示新档位、实际播旧码率；
//   ② quality 传了 `r.quality` → 四平台值域不同，同一首歌每次 key 都不同，缓存永不命中；
//   ③ 本地歌曲被算进缓存 → 设置页占用数字失真，且多一次无谓的系统调用；
//   ④ 下载 await 住播放 / 失败抛到播放链路 → 慢网时"缓存失败"变成"歌放不出来"。

add('CACHE.ipcWrapped', 'CACHE', (s) => {
  // 四个新命令必须在 ipc.ts 各自有封装。没封装 → 设置页与播放链路直接调不到。
  // ⚠️ 判据钉在「命令名作为 invoke 的**字符串字面量实参**」这一条语句上，
  // 不能只判"文件里出现过这个名字" —— 注释里写一遍就能骗过。
  const ipc = stripComments(s.ipc ?? '');
  const missing = CACHE_CMDS.filter((c) => !new RegExp(`invoke<[^>]*>\\(\\s*'${c}'`).test(ipc));
  if (missing.length) return { ok: false, detail: `ipc.ts 缺封装：${missing.join('、')}（Rust 已实现但前端调不到）` };
  // 反向：Rust 侧实现了却没在 commands/mod.rs 注册 → 运行时 "command not found"。
  // 注册这一环同样零覆盖（冻结清单不含新命令），必须单独判。
  const main = stripComments(s.rustRegistry ?? '');
  const notReg = CACHE_CMDS.filter((c) => !main.includes(`music::audio_cache::${c}`));
  if (notReg.length)
    return { ok: false, detail: `commands/mod.rs 未注册：${notReg.join('、')}（定义存在但运行时找不到命令）` };
  return { ok: true, detail: '' };
});

add('CACHE.keyHasQuality', 'CACHE', (s) => {
  // ⭐ 本组最关键的一条：缓存 key **必须含 quality**。
  //
  // 漏掉它是功能性 bug 级：用户从「极高」切到「无损」，会命中上次的文件 ——
  // 界面显示新档位、实际播旧码率，**用户完全无法察觉**（播放器不会校验码率）。
  // 这条是"音质设置形同虚设"的唯一守护。
  //
  // 判据用 callArgs 钉死**单次调用的实参个数**，不用 `[\s\S]*?`：
  // 后者会把后续调用里的 quality 也算进来，删掉实参后断言仍绿（假阳性）。
  const store = stripComments(s.store ?? '');
  const body = fnBodyAny(store, 'lookupAudioCache') || '';
  const args = callArgs(body, 'ipc.musicAudioCached');
  if (!args) return { ok: false, detail: 'lookupAudioCache 里取不到 ipc.musicAudioCached 的调用' };
  // 实参必须恰好三个：provider / id / quality。少一个就是漏传。
  if (args.length !== 3)
    return {
      ok: false,
      detail: `musicAudioCached 应传 3 个实参（provider/id/quality），实为 ${args.length} 个：${args.join('、')}`,
    };
  if (!/\bquality\b/.test(args[2]))
    return { ok: false, detail: `缓存 key 的第三段不是 quality（实参是「${args[2]}」）—— 漏掉音质即"切档位播旧码率"` };
  return { ok: true, detail: '' };
});

add('CACHE.qualityFromState', 'CACHE', (s) => {
  // quality 必须来自 `state.playbackQuality`（5 值枚举），
  // **绝不能**来自 `SongUrlResult.quality` / `.level`。
  //
  // 四个平台那两个字段既不同名也不同值域：网易云 quality 是中文 label（高清臻音）、
  // QQ 是英文 label（Hi-Res FLAC）、咪咕的 level 干脆是 PQ/SQ/ZQ 这种音质等级。
  // 拿它们当 key ⇒ 同一首歌每次算出的 key 都不同 ⇒ **缓存永不命中，且全程不报错**。
  const store = stripComments(s.store ?? '');
  const body = fnBodyAny(store, 'resolveOnlineUrl') || '';
  if (!body) return { ok: false, detail: 'store.ts 未定义 resolveOnlineUrl' };
  const missing = [];
  // 取档位的那一行必须读 state.playbackQuality
  if (!/const\s+quality\s*=\s*state\.playbackQuality/.test(body))
    missing.push('resolveOnlineUrl 没有从 state.playbackQuality 取档位');
  // 传给 songUrl 的也必须是同一个 quality 变量（而不是 r.quality）
  const songUrlArgs = callArgs(body, 'platform.songUrl');
  if (!songUrlArgs) missing.push('取不到 platform.songUrl 的调用');
  else if (songUrlArgs[2] !== 'quality') missing.push(`songUrl 的档位实参是「${songUrlArgs[2]}」而不是 quality`);
  // 反向判据：整个 resolveOnlineUrl 里不得出现"拿返回值当 key"的写法。
  // 只判"用了 state.playbackQuality"不够 —— 那是读档位，回写仍可能用 r.quality。
  if (
    /musicAudioCached\([^)]*r\.(quality|level)/.test(body) ||
    /musicCacheDownload\([^)]*r\.(quality|level)/.test(body)
  )
    missing.push('缓存调用把 r.quality / r.level 当成了 key（四平台值域不同 ⇒ 永不命中）');
  return { ok: missing.length === 0, detail: missing.length ? `档位来源：${missing.join('、')}` : '' };
});

add('CACHE.noQualityFallback', 'CACHE', (s) => {
  // quality **不能为空、也不能默认成 standard**。
  //
  // 默认成 standard 的后果：参数传漏时静默命中标准音质文件，
  // 用户以为听到了自己选的高音质 —— 比不缓存坏得多。
  // 判据钉在"quality 的取值语句"上：不允许出现 `|| 'standard'` 这类兜底。
  const store = stripComments(s.store ?? '');
  const body = fnBodyAny(store, 'resolveOnlineUrl') || '';
  const decl = /const\s+quality\s*=\s*([^;]+);/.exec(body);
  if (!decl) return { ok: false, detail: 'resolveOnlineUrl 里取不到 quality 的声明语句' };
  if (/standard/.test(decl[1]))
    return { ok: false, detail: `quality 被默认成 standard（实参「${decl[1].trim()}」）—— 会让用户以为在听高音质` };
  // audioCacheId 也不能把空 id 悄悄换成固定值（那会让不同歌撞同一个 key）
  const idBody = fnBodyAny(store, 'audioCacheId') || '';
  if (!idBody) return { ok: false, detail: 'store.ts 未定义 audioCacheId' };
  if (/standard/.test(idBody)) return { ok: false, detail: 'audioCacheId 里出现了 standard 兜底' };
  return { ok: true, detail: '' };
});

add('CACHE.localSongExcluded', 'CACHE', (s) => {
  // 本地歌曲（`song._localPath`）**不入缓存链**。
  //
  // 两个理由：① 它走 asset:// 直接播，文件本就在本地，再问一遍缓存是多余的系统调用；
  // ② 计入「音乐缓存」统计会让设置页占用数字失真。
  // 判据钉在两个函数各自的**入口那条 if** 上（两处都要有，漏一处就有一条路径没排掉）。
  const store = stripComments(s.store ?? '');
  const missing = [];
  for (const fn of ['lookupAudioCache', 'prefetchAudioCache']) {
    const body = fnBodyAny(store, fn);
    if (!body) {
      missing.push(`store.ts 未定义 ${fn}`);
      continue;
    }
    if (!/if\s*\(\s*song\._localPath\s*\)\s*return/.test(body)) missing.push(`${fn} 没有排除本地歌曲`);
  }
  return { ok: missing.length === 0, detail: missing.length ? `本地歌曲隔离：${missing.join('、')}` : '' };
});

add('CACHE.hitSkipsSongUrl', 'CACHE', (s) => {
  // 命中缓存时**不能**再调 `platform.songUrl` ——
  // 那次调用是网络往返（还可能触发一次降级重试），命中缓存的意义正是省掉它。
  //
  // 判据用 indexOf 比顺序：查缓存必须在取流地址**之前**，
  // 且命中分支必须在取流地址**之前** return。顺序反了就是"先回源再查缓存"，
  // 缓存命中与否根本不影响这次网络请求 —— 判据若只判"两个都存在"会假绿。
  const store = stripComments(s.store ?? '');
  const body = fnBodyAny(store, 'resolveOnlineUrl') || '';
  if (!body) return { ok: false, detail: 'store.ts 未定义 resolveOnlineUrl' };
  const iLookup = body.indexOf('lookupAudioCache(');
  const iSongUrl = body.indexOf('platform.songUrl(');
  if (iLookup < 0) return { ok: false, detail: 'resolveOnlineUrl 里没有查缓存（缓存接线漏了）' };
  if (iSongUrl < 0) return { ok: false, detail: 'resolveOnlineUrl 里没有 platform.songUrl 调用' };
  if (iLookup > iSongUrl)
    return { ok: false, detail: '查缓存排在取流地址之后（先回源再查缓存 ⇒ 命中也省不掉这次网络往返）' };
  // 命中分支必须真的 return 出去
  const iRet = body.indexOf('return cached;');
  if (iRet < 0) return { ok: false, detail: '缓存命中后没有 return（会继续往下走，等于没接）' };
  if (iRet > iSongUrl) return { ok: false, detail: '缓存命中的 return 排在 platform.songUrl 之后（命中了还会回源）' };
  return { ok: true, detail: '' };
});

add('CACHE.hitUsesConvertFileSrc', 'CACHE', (s) => {
  // 命中返回的是**绝对路径**，交给 <audio> 必须经 `convertFileSrc` 转 asset://。
  // 漏了它：Tauri 下 `file://` 直连会被跨源策略挡住 → **加载失败、播不出来**，
  // 而且报错发生在 audio 元素上，看不出跟缓存有关。
  // 判据钉在 lookupAudioCache 里"把命中结果 return 出去"那一句上。
  const store = stripComments(s.store ?? '');
  const body = fnBodyAny(store, 'lookupAudioCache') || '';
  if (!body) return { ok: false, detail: 'store.ts 未定义 lookupAudioCache' };
  // 命中路径的三种合理写法都接受：convertFileSrc(hit) / 直接 return convertFileSrc(...)
  if (!/convertFileSrc\(\s*hit\s*\)/.test(body))
    return { ok: false, detail: '缓存命中路径没有 convertFileSrc（绝对路径直喂 audio 会被跨源挡住 → 播不出声）' };
  return { ok: true, detail: '' };
});

add('CACHE.downloadNonBlocking', 'CACHE', (s) => {
  // 下载**不能阻塞播放**：必须 `void` 发出、不 await。
  //
  // 一旦 await，慢网下点歌要等整首下载完才响（无损大碟几十秒起步）；
  // 而下载失败若被 throw 到播放链路，用户会看到"播放失败"并被自动跳下一首 ——
  // 症状是"网络不好时歌放不出来"，根因却只是个可有可无的缓存。
  const store = stripComments(s.store ?? '');
  const body = fnBodyAny(store, 'prefetchAudioCache') || '';
  if (!body) return { ok: false, detail: 'store.ts 未定义 prefetchAudioCache' };
  const missing = [];
  const call = /void\s+ipc\.musicCacheDownload\(/.test(body);
  if (!call) missing.push('下载没有以 `void` 发出（会被当成需要等待的工作）');
  if (/\bawait\s+ipc\.musicCacheDownload\(/.test(body)) missing.push('下载被 await（阻塞播放）');
  // 调用点也必须不在播放关键路径上：它只能出现在 return 之前、且不带 await
  const main = fnBodyAny(store, 'resolveOnlineUrl') || '';
  const at = main.indexOf('prefetchAudioCache(');
  if (at < 0) missing.push('resolveOnlineUrl 没有触发预热（缓存永远只有查、没有写）');
  else if (/await\s+prefetchAudioCache\(/.test(main)) missing.push('预热被 await（播放要等下载完）');
  return { ok: missing.length === 0, detail: missing.length ? `后台预热：${missing.join('、')}` : '' };
});

add('CACHE.downloadFailureSilent', 'CACHE', (s) => {
  // 下载失败**绝不能打断播放**：必须挂 `.catch` 且不上抛。
  // 判据钉在"下载调用之后紧跟的链式调用"上 —— 只判"函数里有个 catch"会假绿
  // （那可能是别的 try/catch，与下载无关）。
  const store = stripComments(s.store ?? '');
  const body = fnBodyAny(store, 'prefetchAudioCache') || '';
  if (!body) return { ok: false, detail: 'store.ts 未定义 prefetchAudioCache' };
  const args = callArgs(body, 'ipc.musicCacheDownload');
  if (!args) return { ok: false, detail: 'prefetchAudioCache 里取不到 ipc.musicCacheDownload 的调用' };
  if (args.length !== 4)
    return { ok: false, detail: `musicCacheDownload 应传 4 个实参（provider/id/quality/url），实为 ${args.length} 个` };
  // 调用之后必须紧跟 .catch(...)。
  // ⚠️ 用 afterCall 做括号配对取"闭合括号之后"的文本，而不是 `indexOf` 取子串 ——
  // 实参表里有嵌套调用（audioCacheId(...)），按子串判会错位（实测恒红）。
  const after = afterCall(body, 'ipc.musicCacheDownload');
  if (after == null) return { ok: false, detail: 'prefetchAudioCache 里取不到 ipc.musicCacheDownload 的调用' };
  if (!/^\s*\.catch\(/.test(after))
    return {
      ok: false,
      detail: `下载调用之后没有 .catch（实参之后是「${after.trim().slice(0, 24)}」）—— 失败会变成未处理的 Promise，抛到播放链路就是"播放失败"`,
    };
  // 也不能在下载函数里 throw —— 静默放弃缓存，不静默放弃播放
  if (/\bthrow\b/.test(body)) return { ok: false, detail: '预热函数里有 throw（下载失败不该打断播放）' };
  return { ok: true, detail: '' };
});

add('CACHE.statsShapeForSettings', 'CACHE', (s) => {
  // 设置页要靠 CacheStats 渲染占用与限额，所以**字段名必须与 Rust 侧逐字一致**。
  // 改名/拼错在前端是**静默**的：`stats.providers.netease.audio_bytes` 读出 undefined，
  // 而 `undefined` 在累加里不报错 → 显示 0 —— 症状是"缓存统计永远是 0"，
  // 看起来像功能没做，而不是像字段名拼错了。
  //
  // ⚠️ 判据限定在 **CacheStats 接口体内部**（braceBlock），不扫全文：
  // `CacheProviderStat` 里也有 `audio_bytes`，全文匹配的话改错 CacheStats 的字段
  // 仍能命中另一个接口的同名字段 ⇒ 恒绿（实测踩过：这条第一版就是这么写的，
  // 反证轮报"该红没红"）。
  const types = stripComments(s.types ?? '');
  const block = braceBlock(types, 'interface CacheStats');
  if (!block) return { ok: false, detail: 'types.ts 里取不到 CacheStats 接口体' };
  const need = ['total', 'lyric_bytes', 'audio_bytes', 'root', 'limit_lyric', 'limit_audio', 'providers'];
  const missing = need.filter((k) => !new RegExp(`\\b${k}\\s*[?]?\\s*:`).test(block));
  if (missing.length)
    return {
      ok: false,
      detail: `CacheStats 缺字段：${missing.join('、')}（与 Rust models.rs 不一致 ⇒ 设置页读到 undefined 显示 0）`,
    };
  return { ok: true, detail: '' };
});

// ── 桌面歌词：状态补拉 / 控制桥 ─────────────────────────────────────────────
// 这一组防的都是**跨窗口且不报错**的失效：事件丢了、指令没人接、命令没注册 ——
// 症状统一是"点了没反应 / 一打开是空的"，而日志干干净净。

add('LYRICS.stateBackfill', 'LYRICS', (s) => {
  // 防「刚打开桌面歌词时歌词区是空的，暂停再播放才正常」回归。
  // 根因：主窗建窗后**立刻**推送，而那一刻歌词窗的 `listen` 尚未注册，
  // 那条事件必然丢失（Tauri 事件不缓存、不回放）。
  // 修法三环节缺任一，症状都会原样复现：
  //   Rust 缓存 → get_lyrics_state 命令 → **在 commands/mod.rs 注册** → 歌词窗挂载后补拉
  const rust = stripComments(s.rustLyrics ?? '');
  const dl = stripComments(s.desktopLyrics ?? '');
  const main = stripComments(s.rustRegistry ?? '');
  const missing = [];
  // ⚠️ 判据必须精确到"**写入**那一步"，不能只查标识符存在：
  // 把 `*g = Some(payload.clone())` 删掉（缓存永不写入＝机制等于没有）断言仍会绿；
  // 把变量改名成 `LAST_LYRICS_X` 也一样（子串仍匹配）。本项目已因此栽过 5 次。
  if (!/LAST_LYRICS\s*\.\s*lock\(\)[\s\S]{0,160}?payload\s*\.\s*clone\(\)/.test(rust))
    missing.push('Rust 未把载荷写入缓存');
  if (!/fn\s+get_lyrics_state/.test(rust)) missing.push('缺 get_lyrics_state 命令');
  // 定义了但没注册 → 调用时报"命令不存在"（且被 catch 吞掉），是经典的不报错失效
  if (!/get_lyrics_state/.test(main)) missing.push('get_lyrics_state 未在 commands/mod.rs 注册');
  if (!/get_lyrics_state/.test(dl)) missing.push('歌词窗未补拉（挂载后仍是空的）');
  // 顺序：**先 listen 再补拉**。反过来的话，注册与拉取之间的事件会漏掉。
  const iListen = dl.indexOf("listen<LyricsPayload | LyricsPrefsPayload>('lyrics://state'");
  const iPull = dl.indexOf('get_lyrics_state');
  if (iListen >= 0 && iPull >= 0 && iPull < iListen) missing.push('顺序错：先补拉后注册 listen（中间会漏事件）');
  return { ok: missing.length === 0, detail: missing.length ? `状态补拉：${missing.join('、')}` : '' };
});

add('LYRICS.controlBridge', 'LYRICS', (s) => {
  // 桌面歌词控制栏是**跨窗口**的：歌词窗点按钮 → Rust 转发 → 主窗执行。
  // 四环节任一缺失，症状都是「点了没反应」且**不报任何错**：
  //   ① 歌词窗没发指令 ② Rust 没定义命令 ③ 定义了没注册 ④ 主窗没监听
  const dl = stripComments(s.desktopLyrics ?? '');
  const rust = stripComments(s.rustLyrics ?? '');
  const main = stripComments(s.rustRegistry ?? '');
  const kernel = stripComments(s.kernel ?? '');
  const missing = [];
  if (!/lyrics_control/.test(dl)) missing.push('歌词窗未发控制指令');
  if (!/fn\s+lyrics_control/.test(rust)) missing.push('Rust 缺 lyrics_control 命令');
  if (!/lyrics_control/.test(main)) missing.push('lyrics_control 未在 commands/mod.rs 注册');
  if (!/lyrics:\/\/control/.test(rust)) missing.push('Rust 未 emit lyrics://control');
  if (!/listen<LyricsControlPayload>\(\s*'lyrics:\/\/control'/.test(kernel))
    missing.push('主窗未监听 lyrics://control');
  // 四个动作都要有分支：只实现一半 = 有一半按钮点了没反应。
  // ⚠️ 判据用 `case 'xxx'` 而不是裸字符串 —— 裸子串会命中注释、类型联合等无关处
  //（例如 `'unused-next'` 里含 `next`），属于同类的宽判据陷阱。
  for (const a of ['toggle-play', 'prev', 'next', 'cycle-mode']) {
    if (!kernel.includes(`case '${a}'`)) missing.push(`主窗未处理动作 ${a}`);
  }
  return { ok: missing.length === 0, detail: missing.length ? `控制桥：${missing.join('、')}` : '' };
});

add('LYRICS.modeIconSync', 'LYRICS', (s) => {
  // `cycleMode` 自身**不推送**（它原本只服务主窗 UI）→ 歌词窗的播放模式图标会停在旧值，
  // 用户看到的是"点了没反应"。所以主窗执行完必须补推一次。
  const kernel = stripComments(s.kernel ?? '');
  if (!/case 'cycle-mode':[\s\S]{0,500}?pushLyricsState\(\)/.test(kernel))
    return { ok: false, detail: 'cycle-mode 分支未补推状态（歌词窗模式图标会滞后，像点了没反应）' };
  return { ok: true, detail: '' };
});

add('LYRICS.playModeContract', 'LYRICS', (s) => {
  // playMode 三处必须对齐：ipc 载荷声明 → store 推送时带上 → 歌词窗类型能接。
  // 缺任一处都不报错，只是歌词窗永远显示默认模式（"切了没反应"）。
  // ⚠️ 三条判据都**限定到声明/构造处**，不能只查标识符存在：
  // `playMode` 在 store 里出现很多次（解构、savePrefs、order 数组……），
  // 只查"出现过"的话，把推送那一处的 `playMode,` 删掉断言仍是绿的 ——
  // 反证轮实测抓到过这个假阳性（本项目同类问题第 6 次）。
  const ipc = stripComments(s.ipc ?? '');
  const store = stripComments(s.store ?? '');
  const dl = stripComments(s.desktopLyrics ?? '');
  const missing = [];
  if (!/playMode\s*:\s*PlayMode\s*;/.test(ipc)) missing.push('ipc 的推送载荷缺 playMode 字段');
  // 限定在 payload 字面量内：以 `sentAtEpoch: Date.now()` 为起点向后找
  if (!/sentAtEpoch\s*:\s*Date\.now\(\)[\s\S]{0,240}?playMode/.test(store)) missing.push('store 推送时未带 playMode');
  if (!/playMode\?:/.test(dl)) missing.push('歌词窗载荷类型缺 playMode');
  return { ok: missing.length === 0, detail: missing.length ? `模式契约：${missing.join('、')}` : '' };
});

add('LYRICS.closeViaRust', 'LYRICS', (s) => {
  // 关闭必须走 Rust 命令，不能 window.close()：后者绕过主窗状态，
  // 开关会显示成"还开着"（子 agent 主动做了这个选择，锁住它）
  if (!s.desktopLyrics) return { ok: false, detail: 'DesktopLyrics.tsx 不存在' };
  const dl = stripComments(s.desktopLyrics);
  if (!/close_lyrics_window/.test(dl)) return { ok: false, detail: '未调 close_lyrics_window' };
  if (/\bwindow\.close\(\)/.test(dl))
    return { ok: false, detail: '用了 window.close()（绕过主窗状态，开关会与实际不符）' };
  return { ok: true, detail: '' };
});

// ── 逐字歌词（卡拉OK）──────────────────────────────────────────────────────
// 这一组防的都是「看着像做了、其实没做」的静默降级：逐字高亮的四个环节
//（yrc 接进来 / 无 yrc 时行级插值 / 双层渲染 / 平滑时间源）任一缺失，
// 页面都能正常显示歌词，只是**没有逐字推进** —— 不报错、不空白，最难被察觉。

add('LYRICS.parseYrcUsed', 'LYRICS', (s) => {
  // 防「只定义不用」：parseYrc 定义了但 loadLyrics 没调它 → 逐字高亮等于没接。
  // ⚠️ 判据必须**限定作用域 + 数出现次数**，不能只查标识符出现过：
  // 把 loadLyrics 里那次调用删掉（只留定义）、或复制出第二个同名函数，都曾让
  // 同类断言保持全绿（本项目已栽过多次，D-31）。
  const store = s.storeLyrics ?? '';
  const missing = [];
  // ① 定义唯一
  const defs = (store.match(/export function parseYrc\b/g) || []).length;
  if (defs !== 1) missing.push(`parseYrc 定义应恰好 1 处，实际 ${defs}`);
  // ② loadLyrics **实现体**里必须真的调用它，且保留 LRC 退化分支
  const body = methodBody(store, 'loadLyrics');
  if (body == null) missing.push('store.ts 未找到 loadLyrics 实现');
  else {
    if (!/parseYrc\s*\(/.test(body)) missing.push('loadLyrics 未调用 parseYrc（逐字歌词没接进来）');
    if (!/\.yrc\b/.test(body)) missing.push('loadLyrics 未读取 l.yrc');
    if (!/parseLrc\s*\(/.test(body)) missing.push('loadLyrics 缺 LRC 退化分支');
  }
  return { ok: missing.length === 0, detail: missing.length ? `逐字歌词接入：${missing.join('、')}` : '' };
});

add('LYRICS.lineInterpolation', 'LYRICS', (s) => {
  // ⚠️ 本任务**最重要**的一条：平台绝大多数歌只有行级 LRC、没有 yrc。
  // 若 duration 不被推断/夹紧，"无逐字数据"的歌在渲染层就没有可插值的跨度 →
  // 效果与"没做逐字高亮"一模一样，而 parseYrc / 双层结构那几条断言**依然全绿**。
  // 所以必须单独把这条退化路径锁死。
  const store = s.storeLyrics ?? '';
  const kara = stripComments(s.karaoke ?? '');
  const missing = [];
  // ① finalizeLineDurations 存在，且被 parseLrc / parseYrc **两条路径**都调用
  const fin = fnBodyAny(store, 'finalizeLineDurations');
  if (fin == null) missing.push('缺 finalizeLineDurations');
  const lrcBody = fnBody(store, 'parseLrc');
  const yrcBody = fnBody(store, 'parseYrc');
  if (lrcBody == null) missing.push('取不到 parseLrc 实现体');
  else if (!/finalizeLineDurations\s*\(/.test(lrcBody)) missing.push('parseLrc 未补 duration（LRC 退化路径断头）');
  if (yrcBody == null) missing.push('取不到 parseYrc 实现体');
  else if (!/finalizeLineDurations\s*\(/.test(yrcBody)) missing.push('parseYrc 未走同一收尾');
  // ② 推断规则：相邻行时间差 + [0.45, 12] 夹紧
  if (fin != null) {
    if (!/next\.time\s*-\s*lines\[i\]\.time/.test(fin)) missing.push('未用相邻行时间差推断 duration');
    if (!/Math\.max\(\s*0\.45\s*,/.test(fin)) missing.push('duration 未钳下限 0.45s');
    if (!/Math\.min\(\s*12\s*,/.test(fin)) missing.push('duration 未钳上限 12s');
  }
  // ③ 渲染层必须有**无逐字**的行级插值分支，否则退化路径到不了画面。
  //    ⚠️ 判据只看"存在插值分支"，**不绑定具体缓动函数**（见下方 D-56 备注）：
  //    这里曾经写死"必须出现 smoothstep"，而 smoothstep 恰恰是用户报的
  //    「高亮滞后」的成因（行首段进度 25% 只填 15.6%），本轮已按用户要求改成**线性**。
  //    写死缓动函数名 = 把"动画手感"当成契约，于是"修好滞后"反而让断言变红 ——
  //    判据必须钉住**行为**（有插值、能到画面），不是钉住某个函数名。
  if (!kara) missing.push('未读到 KaraokeLyrics.tsx');
  else {
    // 存在"用行起点 + 跨度算进度"的插值表达式（线性或缓动都算，只要真的按播放位置插值）
    if (!/\(now\s*-\s*line\.time\s*\)\s*\/\s*span/.test(kara) && !/\(now\s*-\s*line\.time\)/.test(kara))
      missing.push('渲染层缺无逐字的行级插值分支（没有按播放位置对行起点做插值）');
  }
  return { ok: missing.length === 0, detail: missing.length ? `行级插值退化路径：${missing.join('、')}` : '' };
});

add('LYRICS.karaRender', 'LYRICS', (s) => {
  // 渲染层三要素：双层叠加 + RAF 驱动 + mask 柔边 + width 裁切。
  // 任缺其一，卡拉OK效果不成立，但页面照常显示歌词（静默降级）。
  const kara = stripComments(s.karaoke ?? '');
  if (!kara) return { ok: false, detail: '未读到 KaraokeLyrics.tsx' };
  const missing = [];
  // ① 双层：同一行文本渲染两次，且两层 class 齐全。
  // ⚠️ 判据必须**限定在原文那一块**（`ref={overlayRef}` 附近），不能全文搜 `kara-over`：
  //   翻译行也是双层叠加（本轮 D-56 加的），全文搜会让"把原文顶层改坏"仍有翻译那份兜底 ⇒ 恒绿。
  //   这正是本项目反复栽的"只判存在、不判作用域"（第 8 次），由反证轮实测抓出。
  const ovAt = kara.search(/ref=\{overlayRef\}/);
  const orig = ovAt >= 0 ? kara.slice(Math.max(0, ovAt - 500), ovAt + 500) : '';
  if (ovAt < 0) {
    missing.push('原文顶层没有 ref={overlayRef}（无法定位双层结构）');
  } else {
    // 原文的 kara-under / kara-over 必须在同一块里成对出现
    if (!/(?<![\w-])kara-under(?![\w-])/.test(orig)) missing.push('原文缺底层（未唱）元素 kara-under');
    if (!/(?<![\w-])kara-over(?![\w-])/.test(orig)) missing.push('原文缺顶层（已唱）元素 kara-over');
    // mask 渐变（含 -webkit- 前缀）必须落在原文顶层上
    if (!/maskImage/.test(orig) || !/WebkitMaskImage/.test(orig))
      missing.push('原文顶层缺 mask 渐变 / -webkit- 前缀（裁切边会是硬线）');
  }
  const textRenders = (kara.match(/\{line\.text\}/g) || []).length;
  if (textRenders < 2) missing.push(`同一行文本只渲染了 ${textRenders} 次（双层需 ≥2 次）`);
  // ② RAF 推进，且**不得**用 setInterval（后台被节流到 ~1Hz → 推进一跳一跳）
  if (!/requestAnimationFrame\s*\(/.test(kara)) missing.push('未用 requestAnimationFrame');
  if (!/cancelAnimationFrame\s*\(/.test(kara)) missing.push('未清理 RAF（cancelAnimationFrame）');
  if (/setInterval\s*\(/.test(kara)) missing.push('用了 setInterval（后台节流 → 推进一跳一跳）');
  // ③ width 裁切驱动顶层
  if (!/style\.width\s*=/.test(kara)) missing.push('未用 width 裁切驱动顶层');
  return { ok: missing.length === 0, detail: missing.length ? `逐字渲染层：${missing.join('、')}` : '' };
});

add('LYRICS.karaTimeSource', 'LYRICS', (s) => {
  // 时间来源：优先 findAudioElement().currentTime（本项目唯一的 <audio> 入口），
  // 且必须有 store progressMs + performance.now 的**降级外推** ——
  // 拿不到元素时若直接用 4Hz 的 progressMs，推进会一跳一跳；完全不降级则歌词不动。
  const kara = stripComments(s.karaoke ?? '');
  if (!kara) return { ok: false, detail: '未读到 KaraokeLyrics.tsx' };
  const missing = [];
  if (!/findAudioElement\s*\(/.test(kara)) missing.push('未用 findAudioElement（应走唯一 audio 入口）');
  if (!/\.currentTime/.test(kara)) missing.push('未读音频真实 currentTime');
  if (!/progressMs/.test(kara)) missing.push('缺 progressMs 降级基准');
  if (!/performance\.now\s*\(/.test(kara)) missing.push('降级外推未用 performance.now（单调钟）');
  // 不得自行 querySelector('audio') 绕过唯一入口（audioGraph 的收口约束）
  if (/querySelector\(\s*['"]audio['"]\s*\)/.test(kara))
    missing.push("自行 querySelector('audio')（应经 audioGraph 入口）");
  return { ok: missing.length === 0, detail: missing.length ? `逐字时间来源：${missing.join('、')}` : '' };
});

// ============================ 歌词模式 / 翻译 / 演唱行（三项歌词优化）============================
// 逐字/整行开关、同步翻译、演唱行。纪律同前：限定作用域、数出现次数、排除子串 ——
// 本项目已因「只判存在、不判唯一」栽过多次，此处仍按此办理。

add('LYRICS.modeStoreChain', 'LYRICS', (s) => {
  // 歌词高亮方式全链路：类型 → store 默认值 → 水合白名单收口 → setter 持久化。
  // 防「类型声明有、实现漏接」与「脏值未收口」两类静默失效。
  const store = stripComments(s.store ?? '');
  const types = stripComments(s.types ?? '');
  const missing = [];
  if (!/export\s+type\s+LyricsMode\s*=/.test(types)) missing.push('types.ts 缺 LyricsMode 联合类型');
  // ① 默认值来自单一事实源常量（LYRICS_MODE_DEF），不是裸字面量 —— 裸字面量会让
  //    "默认逐字"与 player-options 里的 LYRICS_MODE_DEF 漂移成两份事实
  if (!/^\s+lyricsMode:\s*LYRICS_MODE_DEF,\s*$/m.test(store)) missing.push('store 默认值未引用 LYRICS_MODE_DEF');
  // ② setter 实现体 + savePrefs 持久化
  const setBody = methodBody(store, 'setLyricsMode');
  if (setBody == null) missing.push('store 缺 setLyricsMode 实现');
  else if (!/savePrefs\s*\(\s*\{\s*lyricsMode\s*:/.test(setBody)) missing.push('setLyricsMode 未持久化 lyricsMode');
  // ③ 水合白名单收口（脏值一律回落 LYRICS_MODE_DEF）
  //    D-137：默认值改为 'line' 后，收口判据随之改为「显式 'word' 才逐字，其余回落默认」。
  //    ⚠️ 刻意**不**写死 'line' 字面量 —— 那样默认值再改一次这里就会红，而红的原因
  //    并不是缺陷（是默认改了）。锁「引用 LYRICS_MODE_DEF」才能一直守住单一事实源。
  const hyd = methodBody(store, 'hydratePrefs');
  if (hyd == null) missing.push('store 缺 hydratePrefs 实现');
  else if (!/prefs\.lyricsMode\s*===\s*['"]word['"]\s*\?\s*['"]word['"]\s*:\s*LYRICS_MODE_DEF/.test(hyd))
    missing.push('hydratePrefs 未把 lyricsMode 白名单收口（脏值会原样进内存）');
  return { ok: missing.length === 0, detail: missing.length ? `歌词模式全链路：${missing.join('、')}` : '' };
});

add('LYRICS.modeLineRender', 'LYRICS', (s) => {
  /*
   * 整行模式：**单层渲染 + RAF 不写 width + 样式无过渡**（D-137）。
   *
   * 为什么不再锁 `modeRef.current === 'line' ? 1 : ...` 那个三元：D-137 之前整行是
   * 「双层 + width 写死 100%」，视觉对但结构里仍留着一条可被改写的 width 通路 ——
   * 模式判断一旦出错（ref 指到上一行、切模式时序错位）就**静默**退回推进动画，
   * 界面上完全看不出异常（这正是用户报的"整行高亮却还有逐渐移动的动画"）。
   * 现在整行走单层，"无推进"由结构保证，判据也随之换成三条结构特征。
   */
  const kara = stripComments(s.karaoke ?? '');
  const css = stripComments(s.css ?? '');
  if (!kara) return { ok: false, detail: '未读到 KaraokeLyrics.tsx' };
  const missing = [];
  if (!/useMusicStore\s*\(\s*\(?[^)]*\)?\s*=>\s*[A-Za-z_$][\w$]*\.lyricsMode\b/.test(kara))
    missing.push('未从 store 读取 lyricsMode');
  /*
   * ① 整行分支存在，且当前行走单层（不套 kara-dup、不挂 kara-over）。
   *
   * 🔴 分支边界必须用「**第二个** `return (`」切，**不能**用「下一个 kara-dup 出现处」：
   *   反证"把整行改回双层"恰恰是往整行分支里插 `kara-dup` —— 拿被测对象当切点，
   *   切点会跟着反证一起跑掉，判据就永远看不到那次插入 ⇒ **假阳性**（实测踩过：
   *   反证轮报 `✗ 假阳性：LYRICS.modeLineRender`）。
   *   `return (` 是分支结构的恒定特征（整行分支内无嵌套 return），反证改不动它。
   *   也不能靠注释文字切：stripComments 已把注释剥掉，靠注释切会永远切在 -1 上，
   *   静默退化成"全文搜 kara-dup"而恒红。
   */
  const lineAt = kara.search(/if\s*\(\s*isLineMode\s*\)\s*\{/);
  if (lineAt < 0) missing.push('缺整行模式渲染分支（未判 isLineMode）');
  else {
    const rest = kara.slice(lineAt);
    const re = /return\s*\(/g;
    re.exec(rest);
    const m2 = re.exec(rest);
    const seg = rest.slice(0, m2 ? m2.index : 700);
    if (/(?<![\w-])kara-dup(?![\w-])/.test(seg)) missing.push('整行分支仍套了 kara-dup 双层（应单层）');
    if (/(?<![\w-])kara-over(?![\w-])/.test(seg)) missing.push('整行分支仍挂了 kara-over 顶层（应单层）');
    if (!/(?<![\w-])is-on(?![\w-])/.test(seg)) missing.push('整行分支的当前行未挂 is-on');
  }
  // ② RAF 在整行模式下不写 width（否则会写到已卸载的遗留 ref 上）
  if (!/modeRef\.current\s*!==\s*['"]line['"]/.test(kara))
    missing.push("RAF 未在整行模式跳过 width 写入（缺 modeRef.current !== 'line' 闸门）");
  // ③ 样式侧：整行模式取消 transition（`transition: all` 会让字号渐变 ⇒ 整行缓缓位移）
  if (!/\.music-exp-lyr-box\.is-line-mode\s+\.music-lyr-line\s*\{[^}]*transition:\s*none/.test(css))
    missing.push('样式缺 .is-line-mode 的 transition:none（整行仍会渐变位移）');
  // ④ 根类名必须真的把 is-line-mode 挂上去（前面几条都靠这个类生效）
  if (!/is-line-mode/.test(kara)) missing.push('根类名未挂 is-line-mode');
  return { ok: missing.length === 0, detail: missing.length ? `整行模式渲染：${missing.join('、')}` : '' };
});

add('LYRICS.translationMerge', 'LYRICS', (s) => {
  // 翻译合并：ParsedLyricLine 有 translation 字段 + mergeTranslation 函数 + loadLyrics 真调用。
  // 防「字段/函数定义了但 loadLyrics 没接」—— 那会永远不显示翻译。
  //
  // 另钉三件算法上的事（2026-10-16 用户报"有的歌词有翻译、有的没有"后加的）：
  //  ① 容差必须**宽于** 0.5s：实测有平台译文时间戳整体偏移过半秒，卡 0.5s 会整段丢翻译；
  //  ② 译文**不重复用**：否则相邻行抢同一版译文，真正该用它的那行反而空着；
  //  ③ **同文本复用**：副歌在原文里重复出现而译文只有一版，第二处必须沿用它自己第一处的译文。
  const store = s.storeLyrics ?? '';
  const missing = [];
  if (!/translation\?:\s*string/.test(store)) missing.push('ParsedLyricLine 缺 translation? 字段');
  if (!/function\s+mergeTranslation\s*\(/.test(store)) missing.push('缺 mergeTranslation 函数');
  const body = methodBody(store, 'loadLyrics');
  if (body == null) missing.push('store 缺 loadLyrics 实现');
  else if (!/mergeTranslation\s*\(\s*lines\s*,\s*l\.translation\s*\|\|\s*['"]['"]/.test(body))
    missing.push("loadLyrics 未调用 mergeTranslation(lines, l.translation||'')");
  // ① 容差：从实现里读出那个常量，必须 > 0.5（读不出来按红算，不按绿算）
  const tol = /const TOL = (\d+(?:\.\d+)?)/.exec(store);
  if (!tol) missing.push('mergeTranslation 里读不到容差常量 TOL');
  else if (!(Number(tol[1]) > 0.5)) missing.push(`容差 ${tol[1]}s 仍卡在旧的 0.5s（平台整体偏移时会整段丢翻译）`);
  // ② 译文不重复用
  if (!/if \(used\[j\]\) continue;/.test(store)) missing.push('译文没有"已用掉"标记（相邻行会抢同一版译文）');
  // ③ 同文本复用（重复句/副歌）
  if (!/if \(reuse\) line\.translation = reuse;/.test(store))
    missing.push('没有同文本复用（副歌第二处等重复句永远拿不到译文）');
  return { ok: missing.length === 0, detail: missing.length ? `翻译合并：${missing.join('、')}` : '' };
});

add('LYRICS.translationRender', 'LYRICS', (s) => {
  // showTranslation prop 默认 false + 翻译行渲染（kara-trans）。
  // 默认 false 是"灵动岛不显示翻译"的关键：灵动岛不传该 prop，默认即不显示。
  const kara = stripComments(s.karaoke ?? '');
  if (!kara) return { ok: false, detail: '未读到 KaraokeLyrics.tsx' };
  const missing = [];
  if (!/showTranslation\?:\s*boolean/.test(kara)) missing.push('props 缺 showTranslation?: boolean');
  if (!/showTranslation\s*=\s*false/.test(kara)) missing.push('showTranslation 默认值不是 false');
  if (!/(?<![\w-])kara-trans(?![\w-])/.test(kara)) missing.push('缺翻译行 class kara-trans');
  if (!/showTranslation\s*&&\s*line\.translation/.test(kara))
    missing.push('翻译行未按 showTranslation && line.translation 条件渲染');
  return { ok: missing.length === 0, detail: missing.length ? `翻译渲染：${missing.join('、')}` : '' };
});

add('LYRICS.artistLine', 'LYRICS', (s) => {
  // 演唱行：作为歌词流的**第 0 帧**（首行之前、同一个滚动容器内、随歌词滚动）。
  //
  // ⚠️ 判据随实现演进过一次（D-56）：原先它是歌词滚动容器**之外**的固定 div
  // `music-exp-lyr-artist`，用户要求"作为歌词内容的一部分、纳入同一套高亮与滚动逻辑"
  // ⇒ 改为经 `headerLine` prop 传进 KaraokeLyrics，由组件渲染成 `.kara-header` 首行。
  // 断言跟着新契约走：ExpandedPlayer 传 headerLine、KaraokeLyrics 渲染 .kara-header 且
  // **排在 viewLines 之前**、且 headerLine **不进 lines 数组**（否则 lyricIndexAt 会
  // 把它当第一句，前奏期间整列歌词都不高亮）。
  const exp = stripComments(s.expanded ?? '');
  const kara = stripComments(s.karaoke ?? '');
  const css = s.css ?? '';
  const missing = [];
  if (!exp) missing.push('未读到 ExpandedPlayer.tsx');
  else {
    if (!/headerLine=/.test(exp)) missing.push('ExpandedPlayer 未传 headerLine 给 KaraokeLyrics');
    if (!/currentSong\?\.artist/.test(exp)) missing.push('演唱行未读 currentSong.artist');
  }
  if (!kara) missing.push('未读到 KaraokeLyrics.tsx');
  else {
    if (!/(?<![\w-])kara-header(?![\w-])/.test(kara)) missing.push('KaraokeLyrics 未渲染 .kara-header 演唱行');
    // 必须排在歌词行之前（第 0 帧）：headerLine 的 JSX 要在 viewLines.map 之前
    const headerAt = kara.search(/\{headerLine\s*\?/);
    const mapAt = kara.search(/viewLines\.map\(/);
    if (headerAt < 0) missing.push('headerLine 条件渲染缺失');
    else if (mapAt >= 0 && headerAt > mapAt) missing.push('headerLine 渲染在歌词行之后（应为第 0 帧）');
  }
  if (!/\.kara-header\s*\{/.test(css)) missing.push('样式缺 .kara-header');
  return { ok: missing.length === 0, detail: missing.length ? `演唱行（第 0 帧）：${missing.join('、')}` : '' };
});

add('LYRICS.showTranslationWired', 'LYRICS', (s) => {
  // showTranslation 接线：展开播放器**传 true**（翻译在详情页显示），灵动岛**不传**
  // （默认 false，卡片空间不够）。防"改了 prop 但两处消费点没接对"。
  const exp = stripComments(s.expanded ?? '');
  const island = stripComments(s.island ?? '');
  const missing = [];
  if (!exp) missing.push('未读到 ExpandedPlayer.tsx');
  // ver3：翻译显隐由「译」开关控制（设计稿 `.xp-tab-tools` 的 chip），
  // 所以接线判据是「传给 KaraokeLyrics 的是那个 state」+「真的有一个能翻转它的开关」。
  // 只写 `showTranslation` 一词不够：把它写死成 `{false}` 也照样命中，那是假绿。
  else if (!/showTranslation=\{showTranslation\}/.test(exp))
    missing.push('ExpandedPlayer 未把「译」开关的 state 传给 KaraokeLyrics');
  else if (!/setShowTranslation\(/.test(exp)) missing.push('ExpandedPlayer 没有能翻转译文显隐的开关');
  if (!island) missing.push('未读到 DynamicIsland.tsx');
  else {
    // 灵动岛的 KaraokeLyrics 调用片段不得出现 showTranslation
    const m = /<KaraokeLyrics[\s\S]*?\/>/.exec(island);
    const usage = m ? m[0] : '';
    if (!usage) missing.push('DynamicIsland 里找不到 KaraokeLyrics 调用');
    else if (/showTranslation/.test(usage)) missing.push('灵动岛不应传 showTranslation（翻译会撑爆 320×150 卡片）');
  }
  return { ok: missing.length === 0, detail: missing.length ? `showTranslation 接线：${missing.join('、')}` : '' };
});

// ============================ D-56：高亮同步 / 翻译高亮 / 第 0 帧 / 滑块填充 ============================
// 本组四条各自防一个**用户报的现象**，判据都锚在"机制"而不是"某个数值/某个名字"上。

add('LYRICS.noLagOffset', 'LYRICS', (s) => {
  // 🔴 「高亮明显滞后」的守护：getLineProgress 里**不得**再有人为时间偏移或缓动。
  // 曾经的病根：① smoothstep 缓动（行首段 25% 进度只填 15.6%，追不上播放）
  //            ② +0.02s 视觉补偿（把每行高亮起点整体推后）。
  // 两者都让"动画平滑"但与真实播放进度脱钩。修法：无逐字分支改**线性**、不加补偿。
  // 判据：函数体内既不出现 smoothstep，也不对 nowSec 做 +偏移，且存在按 (now - line.time) 的线性插值。
  const kara = stripComments(s.karaoke ?? '');
  if (!kara) return { ok: false, detail: '未读到 KaraokeLyrics.tsx' };
  const body = fnBodyAny(kara, 'getLineProgress');
  if (!body) return { ok: false, detail: '取不到 getLineProgress 实现体' };
  const missing = [];
  // ⚠️ 判据按**形状**判"有没有缓动"，不能只搜函数名 `smoothstep`：
  //   有人会把缓动内联成 `prog * prog * (3 - 2 * prog)`（不叫 smoothstep），
  //   只判名字 ⇒ 这种改法照样绿（反证轮实测抓到：内联缓动让本条假阳性）。
  if (/\bsmoothstep\b/.test(body)) missing.push('仍在用 smoothstep 缓动（行首段高亮追不上播放）');
  // 缓动的代数形状：x²(3−2x) / x³ 之类 —— 线性结果一旦被二次加工就说明套了缓动
  if (/prog\s*\*\s*prog|prog\s*\*\s*\(?\s*3\s*-\s*2\s*\*\s*prog|Math\.pow\s*\(\s*prog/.test(body))
    missing.push('行级插值被套上缓动代数（高亮与播放进度脱钩 ⇒ 滞后）');
  // nowSec + <数字> 形式的时间补偿（排除 nowSec 后接其它表达式的合法用法）
  if (/nowSec\s*\+\s*[\d.]+/.test(body)) missing.push('仍在给 nowSec 加视觉补偿秒数（高亮起点被推后）');
  if (/nowSec\s*-\s*[\d.]+/.test(body)) missing.push('nowSec 被减去固定秒数（高亮被人为提前）');
  // 必须真的按"播放位置 - 行起点"做线性插值（否则去掉缓动后就没有进度了）
  if (!/\(\s*now\s*-\s*line\.time\s*\)\s*\/\s*span/.test(body))
    missing.push('缺按 (now - line.time)/span 的线性插值（去掉缓动后高亮不会推进）');
  // 线性结果必须**原样返回**（return prog），不能被二次加工后才返回
  if (!/return\s+prog\s*;/.test(body)) missing.push('行级插值结果没有原样返回（return 的不是 prog 本身）');
  return { ok: missing.length === 0, detail: missing.length ? `高亮同步（无滞后）：${missing.join('、')}` : '' };
});

add('LYRICS.transHighlightSync', 'LYRICS', (s) => {
  // 翻译与原歌词**同步高亮**：两者共用同一个 RAF 写入的 width%（transOverlayRef），
  // 而不是给翻译另算一份进度或只换颜色。
  // 防"翻译只变色不填充"——那样整句翻译会在行首整行瞬间点亮，与原文逐字推进对不上。
  const kara = stripComments(s.karaoke ?? '');
  if (!kara) return { ok: false, detail: '未读到 KaraokeLyrics.tsx' };
  const missing = [];
  // ① RAF 里两个 overlay 写同一个 width 变量（transOverlayRef 存在且被写 width）
  if (!/transOverlayRef/.test(kara)) missing.push('缺 transOverlayRef（翻译没有独立的高亮层）');
  else if (!/tEl\.style\.width\s*=\s*w/.test(kara) && !/transOverlayRef\.current[^\n]*style\.width/.test(kara))
    missing.push('RAF 未给翻译顶层写 width（翻译不随原文推进）');
  // ② 翻译的当前行也用双层叠加（kara-under + kara-over），不是单层变色
  const transRender = /kara-trans-dup[\s\S]*?kara-under[\s\S]*?kara-over/.test(kara);
  if (!transRender) missing.push('翻译当前行未走双层叠加（只变色会与原文不同步）');
  return { ok: missing.length === 0, detail: missing.length ? `翻译同步高亮：${missing.join('、')}` : '' };
});

add('LYRICS.headerNotInLines', 'LYRICS', (s) => {
  // headerLine（演唱行）**不得**混进 lines 数组参与时间轴。
  // 若把它当 time=0 的普通歌词行，lyricIndexAt 会把它当第一句 ——
  // 前奏期间（还没唱到第一句）activeIndex 恒为 -1，整列歌词都不高亮。
  // 判据：渲染处只用 headerLine 条件单独渲染，不 push 进数组 / 不 map 进 viewLines 参与 active 判定。
  const kara = stripComments(s.karaoke ?? '');
  if (!kara) return { ok: false, detail: '未读到 KaraokeLyrics.tsx' };
  const missing = [];
  // ⚠️ 判据要覆盖**所有**"把 headerLine 塞进时间轴数组"的写法，不能只判某一种：
  //   `lines.push(...)` / `lines = [{...}]` / `[header, ...lines]` 展开 —— 任一种都会让
  //   lyricIndexAt 把它当第一句。写死一种判据 = 换个写法就恒绿（反证轮实测抓到）。
  if (/headerLine[^\n]*\.push\s*\(/.test(kara)) missing.push('headerLine 被 push 进数组（会污染时间轴）');
  // headerLine 与 time 出现在同一行 = 拼成了一条"歌词行"
  if (/headerLine[^\n]*\btime\s*:|[^\n]*\btime\s*:[^\n]*headerLine/.test(kara))
    missing.push('headerLine 被拼成带 time 的歌词行塞进时间轴（前奏期整列不高亮）');
  // headerLine 出现在数组字面量里（[ ... headerLine ... ]）
  if (/\[[^\]\n]*headerLine[^\]\n]*\]/.test(kara))
    missing.push('headerLine 出现在数组字面量中（会进入 viewLines / 时间轴）');
  // 正向：headerLine 必须走独立的条件渲染（证明它是"渲染出去"而不是"混进数组"）
  if (!/\{headerLine\s*\?/.test(kara)) missing.push('headerLine 没有独立的条件渲染');
  return { ok: missing.length === 0, detail: missing.length ? `第 0 帧不入时间轴：${missing.join('、')}` : '' };
});

add('LYRICS.sliderFill', 'LYRICS', (s) => {
  // 进度条 / 音量条「已调节段」用高亮色填充：CSS 轨道规则里有 --fill 分界的 linear-gradient，
  // 且组件**按值**给每个 range input 注入 --fill（否则渐变恒为 0% ⇒ 看不到填充）。
  // 防三类半成品：① 改了 CSS 但没人注入 --fill ② 注入 --fill 但 CSS 没渐变
  // ③ 只给一个 input 注入、另一个漏了（"进度条有填充、音量条没有"）。
  //
  // ⚠️ 判据必须**逐条轨道 / 逐个 input 限定作用域**（用 braceBlock 取各自规则体 / 各自标签）：
  //   全文搜 `linear-gradient` 会让"改坏进度条、但音量条那份还在"照样绿；
  //   全文搜 `'--fill'` 同理（PlayerBar 里有进度条与音量条两个 input，只注入一个也查不出来）。
  //   这正是本项目反复栽的"只判存在、不判唯一/作用域"（第 9 次），由反证轮实测抓出。
  const css = s.css ?? '';
  const exp = stripComments(s.expanded ?? '');
  const bar = stripComments(s.playerBar ?? '');
  const missing = [];
  // ① 逐条轨道：规则体**自身**必须有 linear-gradient + var(--fill)
  //    ⚠️ selector 后面**必须紧跟 `{`** 才算这条规则：用 `indexOf('.music-prog-bar')`
  //    会先命中 `.music-prog-bar-t`（时间标签，其规则体里没有渐变）⇒ 取错块。
  //    这里用正则 `selector\s*\{` 精确定位，再借 matchBracket 取配对的规则体。
  const cssRuleBody = (selector) => {
    // selector 已是**正则字面量**（String.raw`\.foo`），不能再过 esc()：那会把反斜杠
    // 再转义一层，匹配不到任何东西（实测三个轨道一度全部"找不到规则"）。
    const re = new RegExp(`${selector}\\s*\\{`);
    const m = re.exec(css);
    if (!m) return null;
    const open = css.indexOf('{', m.index);
    const end = matchBracket(css, open);
    return end < 0 ? null : css.slice(open + 1, end);
  };
  const tracks = [
    { name: '进度条', selector: String.raw`\.music-prog-bar` },
    { name: '播放条音量', selector: String.raw`\.music-vol input\[type='range'\]` },
    { name: '展开播放器音量', selector: String.raw`\.music-exp-vol-slider` },
  ];
  for (const t of tracks) {
    const blk = cssRuleBody(t.selector);
    if (blk == null) missing.push(`样式里找不到 ${t.name} 轨道规则`);
    else if (!/linear-gradient/.test(blk)) missing.push(`${t.name}轨道缺 linear-gradient 填充渐变`);
    else if (!/var\(--fill/.test(blk)) missing.push(`${t.name}轨道的渐变未用 --fill 定分界`);
  }
  // ② 逐个 range input：其开始标签内必须注入 --fill
  const needFill = (src, cls, label) => {
    if (!src) {
      missing.push(`未读到 ${label}`);
      return;
    }
    // 取该 class 的那个 <input ... /> 标签（到自闭合的 /> 为止）
    const at = src.indexOf(cls);
    if (at < 0) {
      missing.push(`${label} 找不到 ${cls}`);
      return;
    }
    const tag = src.slice(at, src.indexOf('/>', at));
    if (!/'--fill'/.test(tag)) missing.push(`${label} 的 ${cls} 未注入 --fill（填充永远为 0%）`);
  };
  needFill(bar, 'className="music-prog-bar"', 'PlayerBar 进度条');
  needFill(bar, 'value={volume}', 'PlayerBar 音量条');
  needFill(exp, 'className="music-prog-bar"', 'ExpandedPlayer 进度条');
  needFill(exp, 'className="music-exp-vol-slider"', 'ExpandedPlayer 音量条');
  return { ok: missing.length === 0, detail: missing.length ? `滑块填充色：${missing.join('、')}` : '' };
});

// ============================ SKIN（展开播放器六皮肤）============================
// 六皮肤必须各自是一整套视觉（背景/文字/专属组件/布局分支），而不是"只换一行 background"。
// 这一组的判据全部**限定作用域**（只看 ExpandedPlayer / 三个专属模块 / 拼接后的样式全文），
// 对"可能在多处出现的词"一律用计数或精确 token —— 本仓库已因"只判存在、不判唯一/子串匹配"栽过 7 次。

add('SKIN.colorHook', 'SKIN', (s) => {
  // 取色基础设施必须存在，且被展开播放器**真正引用**（只在别处定义、播放器没 import 也算失败）。
  const cc = stripComments(s.coverColor ?? '');
  if (!cc) return { ok: false, detail: '未读到 hooks/useCoverColor.ts（封面取色基础设施）' };
  const missing = [];
  if (!/export function useCoverColor\b/.test(cc)) missing.push('缺 useCoverColor');
  if (!/export function useCoverEdgeColor\b/.test(cc)) missing.push('缺 useCoverEdgeColor（封面渐染用右缘色）');
  if (!/export function makeVividColor\b/.test(cc)) missing.push('缺 makeVividColor（沉浸柔和色板）');
  // 限定在 ExpandedPlayer 的 import 语句里查三个名字
  // ⚠️ 取色基础设施必须住 `src/hooks/`（D-41 收口，`HOOKS.noMisplacedUse` 按文件名守着），
  // 且 ExpandedPlayer 必须**从该处**引入 —— 曾经在 screens/music/ 下被写过第二份实现，
  // 所以这里除了查三个导出，还要查 import 的来源路径。
  const imp = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/useCoverColor['"]/.exec(stripComments(s.expanded ?? ''));
  const names = imp ? imp[1] : '';
  for (const n of ['useCoverColor', 'useCoverEdgeColor', 'makeVividColor'])
    if (!new RegExp(`\\b${n}\\b`).test(names)) missing.push(`ExpandedPlayer 未从 @hooks/useCoverColor 引用 ${n}`);
  return { ok: missing.length === 0, detail: missing.length ? `取色基础设施：${missing.join('、')}` : '' };
});

add('SKIN.derivedNotHardcoded', 'SKIN', (s) => {
  // 背景/文字/毛玻璃必须由 JS 派生的 CSS 变量注入（依赖封面，写死 CSS 做不到），且 CSS 消费。
  const e = stripComments(s.expanded ?? '');
  // 变量在 style 对象里以带引号的键出现（'--skin-bg': …），故正则要容忍可选引号
  const missing = ['--skin-bg', '--skin-text', '--skin-sub', '--skin-hover', '--skin-blur'].filter(
    (v) => !new RegExp(`['"]?${esc(v)}['"]?\\s*:`).test(e),
  );
  const css = s.css ?? '';
  if (!/background:\s*var\(--skin-bg/.test(css)) missing.push('样式未消费 --skin-bg');
  if (!/backdrop-filter:\s*var\(--skin-blur/.test(css)) missing.push('样式未消费 --skin-blur');
  return { ok: missing.length === 0, detail: missing.length ? `变量注入/消费：${missing.join('、')}` : '' };
});

add('SKIN.bgGlass', 'SKIN', (s) => {
  const e = stripComments(s.expanded ?? '');
  const ok = /rgba\(255,\s*255,\s*255,\s*0\.25\)/.test(e);
  return { ok, detail: ok ? '' : '通透皮肤缺半透明白底（rgba(255,255,255,0.25)）' };
});

add('SKIN.bgModern', 'SKIN', (s) => {
  // 现代：封面主色 + 其 0.25 暗色拼的 135° 渐变；开「动态」时改 45° 三段渐变交给 CSS 平移
  const e = stripComments(s.expanded ?? '');
  const missing = [];
  if (!/135deg/.test(e)) missing.push('缺 135deg 渐变');
  if (!/\*\s*0\.25\b/.test(e)) missing.push('缺「封面色 × 0.25」暗色端点');
  if (!/linear-gradient\(\s*45deg/.test(e)) missing.push('缺「动态」用的 45deg 流动渐变');
  return { ok: missing.length === 0, detail: missing.length ? `现代皮肤：${missing.join('、')}` : '' };
});

add('SKIN.bgImmersive', 'SKIN', (s) => {
  // 沉浸：makeVividColor 派生的 deep/hex/light 三段 90° 渐变 + 波纹层
  const e = stripComments(s.expanded ?? '');
  const missing = [];
  if (!/makeVividColor\s*\(/.test(e)) missing.push('未用 makeVividColor 派生柔和色板');
  if (!/linear-gradient\(\s*90deg/.test(e)) missing.push('缺 90deg 三段背景');
  if (!/vivid\.deep/.test(e) || !/vivid\.light/.test(e)) missing.push('背景未用 deep/light 端点');
  // 词边界：`skin-ripple-layer-off` 含 `skin-ripple-layer` 子串，裸子串匹配会把"改坏类名"判成绿
  if (!/(?<![\w-])skin-ripple-layer(?![\w-])/.test(e)) missing.push('缺波纹层 skin-ripple-layer');
  return { ok: missing.length === 0, detail: missing.length ? `沉浸皮肤：${missing.join('、')}` : '' };
});

add('SKIN.bgSpectrum', 'SKIN', (s) => {
  const e = stripComments(s.expanded ?? '');
  const missing = [];
  if (!/'#05070c'/.test(e)) missing.push('缺近黑底 #05070c');
  if (!/<SpectrumScene\b/.test(e)) missing.push('未渲染 <SpectrumScene>');
  if (!/active=\{isSpectrum\}/.test(e)) missing.push('SpectrumScene 的 active 未接 isSpectrum（非该皮肤会白跑 RAF）');
  return { ok: missing.length === 0, detail: missing.length ? `音域回响皮肤：${missing.join('、')}` : '' };
});

add('SKIN.bgVinyl', 'SKIN', (s) => {
  const e = stripComments(s.expanded ?? '');
  const missing = [];
  if (!/#dfdfe2/.test(e) || !/#d1d1d6/.test(e)) missing.push('缺浅灰胶底渐变（#dfdfe2 → #d1d1d6）');
  if (!/<VinylDisc\b/.test(e)) missing.push('未渲染 <VinylDisc>');
  if (!/'#333338'/.test(e)) missing.push('缺固定深灰文字色 #333338');
  return { ok: missing.length === 0, detail: missing.length ? `透明彩胶皮肤：${missing.join('、')}` : '' };
});

add('SKIN.bgCover', 'SKIN', (s) => {
  // 封面渐染：背景 = 封面**右缘**主色 + 左侧满铺封面层
  const e = stripComments(s.expanded ?? '');
  const missing = [];
  if (!/edgeColor\.hex/.test(e)) missing.push('背景未用封面右缘色（edgeColor.hex）');
  if (!/useCoverEdgeColor\s*\(/.test(e)) missing.push('未调用 useCoverEdgeColor');
  if (!/skin-cover-bleed/.test(e)) missing.push('缺满铺封面层 skin-cover-bleed');
  return { ok: missing.length === 0, detail: missing.length ? `封面渐染皮肤：${missing.join('、')}` : '' };
});

add('SKIN.blurOnlyGlass', 'SKIN', (s) => {
  // 只有「通透」用毛玻璃：全文件 blur(20px) 恰好 1 次，且落在 glass 分支内。
  // 计数 + 分段限定 —— 破坏为 0 次（改成 none）或 2 次（给别的皮肤也加）都必须变红。
  const e = stripComments(s.expanded ?? '');
  const n = (e.match(/blur\(20px\)/g) || []).length;
  if (n !== 1) return { ok: false, detail: `blur(20px) 应恰好 1 次（仅通透），实际 ${n} 次` };
  const gStart = e.indexOf("case 'glass'");
  const gEnd = gStart >= 0 ? e.indexOf('break;', gStart) : -1;
  if (gStart < 0 || gEnd <= gStart || !e.slice(gStart, gEnd).includes('blur(20px)'))
    return { ok: false, detail: 'blur(20px) 不在 glass 分支内（被别的皮肤用了）' };
  return { ok: true, detail: '' };
});

add('SKIN.textColors', 'SKIN', (s) => {
  // 文字色系：现代/封面渐染按封面明暗二选一；两端色 #1a1a2e / #f0f0f0
  const e = stripComments(s.expanded ?? '');
  const missing = [];
  if (!/'#1a1a2e'/.test(e) || !/'#f0f0f0'/.test(e)) missing.push('缺明暗二选一的两端色（#1a1a2e / #f0f0f0）');
  if (!/coverColor\.isLight/.test(e)) missing.push('现代未按 coverColor.isLight 选文字色');
  if (!/edgeColor\.isLight/.test(e)) missing.push('封面渐染未按 edgeColor.isLight 选文字色');
  return { ok: missing.length === 0, detail: missing.length ? `文字色：${missing.join('、')}` : '' };
});

add('SKIN.vinylSpin', 'SKIN', (s) => {
  // 唱片旋转：样式里有 skin-vinyl-spin keyframes 且盘体引用了它，转满 360°
  const css = s.css ?? '';
  const missing = [];
  if (!/@keyframes\s+skin-vinyl-spin\b/.test(css)) missing.push('缺 skin-vinyl-spin keyframes');
  if (!/animation:\s*skin-vinyl-spin\b[^;]*linear[^;]*infinite/.test(css)) missing.push('盘体未引用旋转动画');
  if (!/rotate\(360deg\)/.test(css)) missing.push('旋转未到 360deg');
  return { ok: missing.length === 0, detail: missing.length ? `唱片旋转：${missing.join('、')}` : '' };
});

add('SKIN.vinylPause', 'SKIN', (s) => {
  // 暂停即停转：**每一处** animationPlayState 都必须跟随 isPlaying（任一处写成常量 ⇒ 该层暂停仍在转）。
  // 用「出现次数 == 条件式次数」而非「至少一处条件式」—— 后者在两层里只改一层时会假绿。
  const v = stripComments(s.vinylDisc ?? '');
  const all = (v.match(/animationPlayState/g) || []).length;
  const cond = (v.match(/animationPlayState:\s*isPlaying\s*\?\s*'running'\s*:\s*'paused'/g) || []).length;
  if (all === 0) return { ok: false, detail: '唱片未设 animationPlayState（暂停不会停转）' };
  if (cond === 0) return { ok: false, detail: 'animationPlayState 未按 isPlaying 取 running/paused' };
  if (all !== cond)
    return { ok: false, detail: `有 ${all - cond} 处 animationPlayState 未跟随 isPlaying（该层暂停仍在转）` };
  return { ok: true, detail: '' };
});

add('SKIN.spectrumNoLyrics', 'SKIN', (s) => {
  // 音域回响激活时**不渲染歌词**（参考实现如此）：歌词面板被 !isSpectrum 守卫
  const e = stripComments(s.expanded ?? '');
  if (!/<KaraokeLyrics\b/.test(e)) return { ok: false, detail: '未渲染 <KaraokeLyrics>' };
  if (!/\{!isSpectrum\s*\?/.test(e))
    return { ok: false, detail: '歌词面板未被 !isSpectrum 守卫（音域回响下仍会显示歌词）' };
  return { ok: true, detail: '' };
});

add('SKIN.spectrumAudio', 'SKIN', (s) => {
  // 音域回响必须走 audioGraph 的唯一入口，且**不得**自己 createMediaElementSource（二次建图必抛 + 静音）
  const sp = stripComments(s.spectrumScene ?? '');
  if (!sp) return { ok: false, detail: '未读到 SpectrumScene.tsx' };
  const missing = [];
  if (!/attachAnalyser\s*\(/.test(sp)) missing.push('未用 attachAnalyser（应走唯一音频图入口）');
  if (!/readLevels\s*\(/.test(sp)) missing.push('未用 readLevels 读频谱');
  if (!/findAudioElement\s*\(/.test(sp)) missing.push('未用 findAudioElement');
  if (/createMediaElementSource/.test(sp)) missing.push('自行 createMediaElementSource（违 AUDIO.singleEntry）');
  return { ok: missing.length === 0, detail: missing.length ? `音域回响音频接线：${missing.join('、')}` : '' };
});

add('SKIN.spectrumFallback', 'SKIN', (s) => {
  // 拿不到音频图必须降级为 CSS 动画（不能白屏/报错）
  const sp = stripComments(s.spectrumScene ?? '');
  const missing = [];
  if (!/setFallback\(/.test(sp)) missing.push('无降级状态');
  if (!/skin-spectrum-fallback/.test(sp)) missing.push('无 CSS 降级视图');
  if (!/@keyframes\s+skin-spectrum-pulse\b/.test(s.css ?? '')) missing.push('样式缺降级动画 keyframes');
  return { ok: missing.length === 0, detail: missing.length ? `音域回响降级：${missing.join('、')}` : '' };
});

add('SKIN.coverColorFallback', 'SKIN', (s) => {
  // 取色失败必须回落（跨域污染 getImageData 会抛 SecurityError）：try/catch + 默认色
  const cc = stripComments(s.coverColor ?? '');
  const missing = [];
  if (!/getImageData\s*\(/.test(cc)) missing.push('未读像素（getImageData）');
  // 本项目 catch 多为 `catch {`（无参），故不能只认 `catch (` —— 用 [{(] 兼容两种写法
  if (!/catch\s*[{(]/.test(cc)) missing.push('缺 try/catch 兜底（跨域污染会抛 SecurityError）');
  if (!/'#1a1a2e'/.test(cc)) missing.push('缺默认回落色 #1a1a2e');
  if (!/DEFAULT_COLOR/.test(cc)) missing.push('缺统一默认色常量');
  return { ok: missing.length === 0, detail: missing.length ? `取色失败回落：${missing.join('、')}` : '' };
});

add('SKIN.immersiveLayout', 'SKIN', (s) => {
  // 沉浸布局：左封面区不渲染（isPlainLayout 守卫）+ 歌词放大居中
  const e = stripComments(s.expanded ?? '');
  const css = s.css ?? '';
  const missing = [];
  if (!/isPlainLayout/.test(e)) missing.push('未按皮肤区分是否渲染左封面区');
  if (!/\.music-exp-body\.is-immersive\s+\.music-lyr-line\b/.test(css)) missing.push('样式缺沉浸放大歌词规则');
  if (!/\.music-exp-body\.is-immersive\s+\.music-exp-lyr-box\b/.test(css)) missing.push('样式缺沉浸居中规则');
  return { ok: missing.length === 0, detail: missing.length ? `沉浸布局：${missing.join('、')}` : '' };
});

add('SKIN.vinylLayoutLeftAlign', 'SKIN', (s) => {
  // 彩胶/封面渐染：歌词左对齐（KaraokeLyrics 新增 align prop 只切类名，不改动画/双层逻辑）
  const css = s.css ?? '';
  const kara = stripComments(s.karaoke ?? '');
  const missing = [];
  if (!/align/.test(kara)) missing.push('KaraokeLyrics 未新增 align prop');
  if (!/is-left/.test(kara)) missing.push('KaraokeLyrics 未按 align 切 is-left 类名');
  if (!/\.music-exp-lyr-box\.is-left\s+\.music-lyr-line\b/.test(css)) missing.push('样式缺左对齐歌词规则');
  return { ok: missing.length === 0, detail: missing.length ? `左对齐歌词：${missing.join('、')}` : '' };
});

add('SKIN.lyrNoFlexShrink', 'SKIN', (s) => {
  // 当前句整行消失的根因修复守护（不报错型故障，现象极具迷惑性）：
  // `.music-exp-lyr-box` 是 flex column + 固定高 + overflow:auto，整首歌词必然溢出，
  // 行作为 flex item 默认 flex-shrink:1 被分配收缩。普通行 overflow 为 visible，
  // `min-height:auto` 有 min-content 下限，只是行距被压紧；**当前句**带
  // `.kara-line-on { overflow:hidden }` —— overflow 非 visible 的 flex item 其
  // `min-height:auto` 解析为 0，被压扁到 0 高、内容再被自己的 overflow 裁光，
  // 症状正是「当前句完全不显示、换句后上一句突然出现」。规则被删即回归。
  // 判据用 stripComments：下方注释文本里就写着 flex-shrink 等字样，不剥会恒绿。
  const css = stripComments(s.css ?? '');
  const missing = [];
  if (!/\.music-exp-lyr-box\s+\.music-lyr-line\s*\{[^}]*flex-shrink:\s*0/.test(css)) {
    missing.push('样式缺歌词行 flex-shrink:0（当前句会被 flex 收缩压扁到整行消失）');
  }
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

// ============================ ISLANDV（灵动岛第 4 态 · 歌词卡）============================
// 这一组防的是「歌词卡看着能跑、实际是空壳」这类**不报错**的故障：
//   · 偏好没写 savePrefs            → 切到歌词卡后重开就回到播放卡（"切了没记住"）；
//   · 没开唱时 activeIndex=-1       → 窗口切成空区间 → 卡片一片空白，而其它断言全绿；
//   · 在灵动岛里又写一份逐字实现     → 两份推进逻辑迟早对不上（本项目明确禁止）；
//   · 顺手把桌面歌词删了            → 砍桌面歌词是**独立一步**，由负责人真机确认后再做。
//
// ⚠️ 判据一律先 `stripComments`：本任务的注释里主动写出了被禁/被替代的写法
// （如注释里提到 `lyricsFontSize`、桌面歌词提示文案），不剥注释会恒绿。
// 判据涉及"某写法可能多处出现"时，一律限定作用域（methodBody / 指定文件），不全文扫。

/** 灵动岛 / 逐字组件 / 主窗样式（本组多处要用，提到组级作用域） */
const islSrc = (s) => stripComments(s.island ?? '');
const karaSrc = (s) => stripComments(s.karaoke ?? '');

add('ISLANDV.pref.type', 'ISLANDV', (s) => {
  const store = stripComments(s.store ?? '');
  // 必须是两个字面量的联合 —— 写成 `type IslandView = string` 等于没约束，
  // localStorage 里的 'xxx' 会一路带进渲染层（枚举型偏好一律在类型层就收口）
  const ok = /export type IslandView\s*=\s*'play'\s*\|\s*'lyrics'\s*;/.test(store);
  return { ok, detail: ok ? '' : "store 没有 IslandView = 'play' | 'lyrics' 的联合类型" };
});

add('ISLANDV.pref.default', 'ISLANDV', (s) => {
  const store = stripComments(s.store ?? '');
  // 初值必须是 'play'（歌词卡是"用户自己切过去"的视图，不该是默认态）。
  // 判据取状态对象里的形态 `  islandView: 'play',`（interface 声明以 `;` 结尾、不会命中）
  const ok = /^ {2}islandView: 'play',$/m.test(store);
  return { ok, detail: ok ? '' : "store 初始状态里 islandView 的默认值不是 'play'" };
});

add('ISLANDV.pref.hydrate', 'ISLANDV', (s) => {
  const body = methodBody(stripComments(s.store ?? ''), 'hydratePrefs');
  if (!body) return { ok: false, detail: 'store 里取不到 hydratePrefs 的实现体' };
  const missing = [];
  // 脏值回落：localStorage 里是 'xxx' 也必须落到 'play' ——
  // 写成 `?? 'play'` 会把脏值原样读进内存，卡片按歌词态渲染却拿到空分支。
  if (!/prefs\.islandView === 'lyrics' \? 'lyrics' : 'play'/.test(body))
    missing.push('hydratePrefs 未把 islandView 收进白名单（脏值不回落）');
  // `prefs.islandView ?? 'play'` 会把 'xxx' 这类脏值原样读进内存 —— 它不抛错，
  // 只是卡片按歌词态渲染却拿到错误分支，是最难联想起因的一类故障
  if (/islandView\s*\?\?/.test(body)) missing.push('islandView 用了 ?? 兜底（脏值会进内存）');
  if (!/\bislandView,/.test(body)) missing.push('hydratePrefs 未把 islandView 写回 state');
  return { ok: missing.length === 0, detail: missing.length ? `偏好水合：${missing.join('、')}` : '' };
});

add('ISLANDV.pref.persist', 'ISLANDV', (s) => {
  const body = methodBody(stripComments(s.store ?? ''), 'setIslandView');
  if (!body) return { ok: false, detail: 'store 没有 setIslandView 的实现体（只有 interface 声明不算）' };
  // patch 键必须就是这个字段：既证明调了 savePrefs，也证明写对了键
  const ok = /savePrefs\(\s*\{\s*islandView\s*:/.test(body);
  return { ok, detail: ok ? '' : 'setIslandView 未调用 savePrefs({ islandView: … })（切了不记住）' };
});

add('ISLANDV.reuseKaraoke', 'ISLANDV', (s) => {
  const isl = islSrc(s);
  const missing = [];
  if (!/import \{ KaraokeLyrics \} from '@screens\/music\/KaraokeLyrics';/.test(isl))
    missing.push('灵动岛未 import KaraokeLyrics');
  if (!/<KaraokeLyrics\b/.test(isl)) missing.push('灵动岛未渲染 <KaraokeLyrics>');
  // 反向判据：灵动岛里**不得**出现逐字实现的内部件 —— 出现即说明又写了第二份
  for (const bad of ['getLineProgress', 'lyricIndexAt', 'kara-over']) {
    if (new RegExp(`\\b${esc(bad)}\\b`).test(isl))
      missing.push(`灵动岛里出现了逐字实现的内部件 ${bad}（= 第二份逐字实现）`);
  }
  return { ok: missing.length === 0, detail: missing.length ? `复用逐字实现：${missing.join('、')}` : '' };
});

add('ISLANDV.windowMode', 'ISLANDV', (s) => {
  const kara = karaSrc(s);
  const missing = [];
  // 两个参数都得是**可选**（默认 undefined / true = 展开播放器的既有行为不变）
  if (!/windowSize\?: number;/.test(kara)) missing.push('KaraokeLyrics 没有 windowSize 可选参数');
  if (!/scroll\?: boolean;/.test(kara)) missing.push('KaraokeLyrics 没有 scroll 开关');
  // 只断言"参数存在"不够：定义了却没用等于没有 —— 判据要落到使用点
  if (!/const winStart = windowSize && windowSize > 0 \?/.test(kara)) missing.push('windowSize 未参与渲染区间的计算');
  if (!/if \(!scroll\) return;/.test(kara)) missing.push('scroll 未作用于 scrollIntoView');
  return { ok: missing.length === 0, detail: missing.length ? `窗口模式：${missing.join('、')}` : '' };
});

add('LYRICS.seekDeferLocate', 'LYRICS', (s) => {
  /*
   * 诉求（2026-10-16 用户报）：拖进度条时歌词不要跟着跳 —— 拖拽中不定位，松手后等 2s 再定位。
   *
   * 三条判据分别钉"参数存在 / 真的作用于定位 / 松手有延时"，再加一条钉调用侧：
   * 只加 prop 不传等于没接（那种实现下所有静态断言仍全绿，而界面照旧跳）。
   */
  const kara = karaSrc(s);
  const missing = [];
  if (!/seeking\?: boolean;/.test(kara)) missing.push('KaraokeLyrics 没有 seeking 可选参数');
  if (!/if \(seeking\) \{/.test(kara)) missing.push('seeking 未作用于定位效果（拖拽中仍会定位）');
  if (!/setTimeout\([\s\S]{0,160}2000\)/.test(kara)) missing.push('松手后没有 2s 延时定位');
  const exp = s.expanded ?? '';
  if (!/seeking=\{/.test(exp)) missing.push('ExpandedPlayer 未把拖拽态传给 KaraokeLyrics（prop 加了没接）');
  return { ok: missing.length === 0, detail: missing.length ? `拖拽避让：${missing.join('、')}` : '' };
});

add('ISLANDV.windowIdleStart', 'ISLANDV', (s) => {
  // ★ 本组最关键的一条：还没唱到第一句（前奏 / 间奏 / 刚起播）时 `activeIndex === -1`，
  // 窗口起点若直接取它，切片拿到的是 `[-1, 1)` 这样的**空区间** —— 歌词卡一片空白，
  // 而「有 windowSize 参数」「引用了 KaraokeLyrics」这些断言**全部照样绿**。
  const kara = karaSrc(s);
  const m = /const winStart\s*=\s*([^;]+);/.exec(kara);
  if (!m) return { ok: false, detail: 'KaraokeLyrics 里取不到 winStart 的计算（窗口模式没实现）' };
  // 必须把负的 activeIndex 夹回 0（两种等价写法都接受，避免把判据绑死在某一种实现上）
  const expr = m[1];
  const clamped = /Math\.max\(0,\s*activeIndex\)/.test(expr) || /activeIndex\s*<\s*0\s*\?\s*0/.test(expr);
  if (!clamped) return { ok: false, detail: `winStart 未把 -1 夹回 0（未开唱时歌词卡会是空的）：${expr.trim()}` };
  // 终点也要夹住，否则最后一句之后会越界（同样是不报错、只是少一行）
  const mEnd = /const winEnd\s*=\s*([^;]+);/.exec(kara);
  if (!mEnd || !/Math\.min\(lines\.length/.test(mEnd[1]))
    return { ok: false, detail: 'winEnd 未夹到 lines.length（末尾会越界）' };
  return { ok: true, detail: '' };
});

add('ISLANDV.twoRows', 'ISLANDV', (s) => {
  const isl = islSrc(s);
  // 卡片只有 150 高，窗口行数写大就装不下
  if (!/const ISLAND_LYR_WINDOW = 2;/.test(isl))
    return { ok: false, detail: '灵动岛歌词窗口不是 2 行（150px 高的卡片装不下更多）' };
  // ⚠️ 作用域限定在 `<KaraokeLyrics … />` 这**一段**：只判"文件里出现过 windowSize"
  // 会被 KaraokeLyrics 自己的 props 声明喂成假绿（灵动岛其实根本没传）。
  const call = /<KaraokeLyrics[\s\S]*?\/>/.exec(isl);
  if (!call) return { ok: false, detail: '灵动岛里取不到 <KaraokeLyrics … /> 的调用段' };
  const tag = call[0];
  const missing = [];
  if (!/windowSize=\{/.test(tag)) missing.push('灵动岛未传 windowSize');
  // 关掉滚动：小盒子里 scrollIntoView 会把布局顶歪
  if (!/scroll=\{false\}/.test(tag)) missing.push('歌词卡未关闭 scrollIntoView');
  return { ok: missing.length === 0, detail: missing.length ? `歌词两行：${missing.join('、')}` : '' };
});

add('ISLANDV.pureMusic', 'ISLANDV', (s) => {
  const isl = islSrc(s);
  const css = s.css ?? '';
  const missing = [];
  if (!/♪ 纯音乐，请欣赏/.test(isl)) missing.push('歌词卡缺纯音乐降级文案');
  if (!/\.di-lyr-empty\s*\{/.test(css)) missing.push('样式缺 .di-lyr-empty 样式');
  // 文案必须挂在「无歌词」分支**里**：无条件渲染会与真歌词叠在一起（两行字糊在一块）
  if (!/lines\.length\s*>\s*0\s*\?[\s\S]*?♪ 纯音乐，请欣赏/.test(isl)) missing.push('降级文案不在「无歌词」分支里');
  return { ok: missing.length === 0, detail: missing.length ? `纯音乐降级：${missing.join('、')}` : '' };
});

add('ISLANDV.toggleBothWays', 'ISLANDV', (s) => {
  const isl = islSrc(s);
  const missing = [];
  // 双向：歌词态要能回播放卡，播放态要能进歌词卡 —— 只做一个方向 = 进去出不来
  if (!/title=\{view === 'lyrics' \? '播放' : '歌词'\}/.test(isl)) missing.push('切换键的 title 不是双向的');
  // 图标名允许随设计调整（当前歌词态用 `AudioLines`，见提交 eb3fd1f）；钉的是「两个方向各有一个图标」
  if (!/view === 'lyrics' \? <[A-Z]\w*[\s\S]{0,60}?:\s*<ListMusic/.test(isl))
    missing.push('切换键的图标不是双向的（歌词态→播放、播放态→歌词）');
  if (!/onToggleView=\{toggleIslandView\}/.test(isl)) missing.push('切换键未接回写偏好的 action');
  return { ok: missing.length === 0, detail: missing.length ? `视图切换：${missing.join('、')}` : '' };
});

add('ISLANDV.ctlStableAcrossViews', 'ISLANDV', (s) => {
  // 🔴 切 di-toggle 不许跳动（2026-10-12 修）：按钮栏是 justify-content:center 的整行，
  // 歌词卡原先把 .ui-cbtn 压到 26px ⇒ 整行总宽变 ⇒ 每个按钮的 x 全部平移，
  // 行高 30→26 又让整行上下跳；进度条还因 .di-prog 在流内被推着走。
  // 修法：按钮栏与进度行都**绝对定位 + 固定几何**，歌词卡不再碰 .di-ctl 的任何尺寸。
  const missing = [];
  const ctl = (s.css.match(/\.di-ctl\s*\{([^}]*)\}/) || [, ''])[1];
  if (!/position\s*:\s*absolute/.test(ctl)) missing.push('.di-ctl 未绝对定位（会随流内内容高度变化而移动）');
  if (!/height\s*:\s*30px/.test(ctl)) missing.push('.di-ctl 未固定高度 30px');
  if (!/justify-content\s*:\s*center/.test(ctl)) missing.push('.di-ctl 不再是居中整行（判据基准变了）');

  const prog = (s.css.match(/\.di-prog\s*\{([^}]*)\}/) || [, ''])[1];
  if (!/position\s*:\s*absolute/.test(prog)) missing.push('.di-prog 未绝对定位（切视图时位置会被流内内容带偏）');
  if (!/bottom\s*:/.test(prog)) missing.push('.di-prog 未固定 bottom（宽度/位置会随两态内容重算）');

  // 🔴 歌词卡**不得**再改 .di-ctl 的按钮尺寸 —— 这正是当初跳动的那一刀
  if (/\.di-card\.is-lyr[^{]*\.di-ctl\s+\.ui-cbtn\s*\{/.test(s.css))
    missing.push('.di-card.is-lyr 又改了 .di-ctl 内按钮尺寸（两态总宽不同 ⇒ 居中位移）');

  // 两态的下内边距必须同值（内容区底边对齐，各自的高度差由 padding-top 吸收）
  const pad = (sel) => {
    const m = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(s.css);
    const p = m && /padding\s*:\s*([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px/.exec(m[1]);
    return p ? p[3] : null;
  };
  const pbCard = pad('.di-card');
  const pbLyr = pad('.di-card.is-lyr');
  if (pbCard == null || pbLyr == null) missing.push('取不到 .di-card / .di-card.is-lyr 的 padding');
  else if (pbCard !== pbLyr) missing.push(`两态下内边距不同（${pbCard} vs ${pbLyr}）⇒ 内容区底边不对齐`);

  // di-toggle 外层必须与按钮同尺寸（它内层的 26px 按钮靠外层留白占住位置）
  const tg = (s.css.match(/\.di-toggle\s*\{([^}]*)\}/) || [, ''])[1];
  if (!/width\s*:\s*30px/.test(tg) || !/height\s*:\s*30px/.test(tg))
    missing.push('.di-toggle 外层未固定 30×30（外层随内容变小 ⇒ 整行总宽变 ⇒ 居中位移）');
  if (!/flex\s*:\s*0\s+0\s+auto/.test(tg)) missing.push('.di-toggle 未 flex:0 0 auto（会被 flex 压缩改宽度）');
  return {
    ok: missing.length === 0,
    detail: missing.length ? `按钮栏/进度条两态稳定性：${missing.join('、')}` : '',
  };
});

add('ISLANDV.cardSize', 'ISLANDV', (s) => {
  const isl = islSrc(s);
  const missing = [];
  // 歌词卡与大卡共用同一组常量（350×160，按设计稿 `.island[data-state="card"]`）：
  // 另立一套尺寸会让 hover 收展的形变对不上
  if (!/const EXPANDED_WIDTH = 350;/.test(isl)) missing.push('展开宽不是 350');
  if (!/const MUSIC_EXPANDED_HEIGHT = 160;/.test(isl)) missing.push('音乐卡展开高不是 160');
  // 高度分支必须仍取这个常量（常量改了而计算式没跟上、或反过来，都会给出第三个尺寸）
  if (!/\? MUSIC_EXPANDED_HEIGHT/.test(isl)) missing.push('音乐卡展开高度不再取 MUSIC_EXPANDED_HEIGHT');
  return { ok: missing.length === 0, detail: missing.length ? `歌词卡尺寸：${missing.join('、')}` : '' };
});

add('ISLANDV.hlVarInjected', 'ISLANDV', (s) => {
  // 高亮色/正文色/字号必须**在灵动岛自己注入一遍**：展开播放器把它们注入在 .music-exp
  // 根上靠继承下传，而灵动岛挂在主窗根上、不在那棵子树里 —— 不注入就全走回落值
  // （--lyr-text 的回落是 #fff，浅色主题下 = 白字白底看不见）。
  const isl = islSrc(s);
  const missing = [];
  // 高亮色要**真的取自 store**：用户选的颜色应当处处生效（含灵动岛）
  if (!/s\) => s\.lyricsHighlightColor/.test(isl))
    missing.push('灵动岛未读 lyricsHighlightColor（用户选的颜色不生效）');
  if (!/'--lyr-hl'/.test(isl)) missing.push('歌词卡未注入 --lyr-hl（用户选的高亮色不生效）');
  if (!/'--lyr-text'/.test(isl)) missing.push('歌词卡未注入 --lyr-text（浅色主题下是白字白底）');
  return { ok: missing.length === 0, detail: missing.length ? `歌词变量注入：${missing.join('、')}` : '' };
});

add('ISLANDV.fontSizeLocal', 'ISLANDV', (s) => {
  // 字号**故意**不跟随 lyricsFontSize（设置页那条 17–48 的量程是给铺满整屏的展开播放器的，
  // 320px 宽的卡片套 48px 一行放不下几个字）。所以这里既断言"用了卡片自己的值"，
  // 也**反向**断言"没接回 --lyr-size"。
  const isl = islSrc(s);
  const css = s.css ?? '';
  const missing = [];
  // 注入的值必须来自卡片自己的常量，不能是写死的魔法数字
  if (!/--di-lyr-size': `\$\{ISLAND_LYR_SIZE_NEXT\}px`/.test(isl)) missing.push('注入的字号不是卡片自己的常量');
  if (!/\.di-card \.di-lyr \.music-lyr-line \{[^}]*var\(--di-lyr-size/.test(css))
    missing.push('下一句字号未用 --di-lyr-size');
  if (!/\.di-card \.di-lyr \.music-lyr-line\.is-on \{[^}]*var\(--di-lyr-on-size/.test(css))
    missing.push('当前句字号未用 --di-lyr-on-size');
  const back = (css.match(/\.di-card \.di-lyr[^{]*\{[^}]*var\(--lyr-size/g) || []).length;
  if (back > 0) missing.push('歌词卡字号又接回 --lyr-size（会跟随用户 17–48 的量程）');
  return { ok: missing.length === 0, detail: missing.length ? `歌词卡字号：${missing.join('、')}` : '' };
});

add('ISLANDV.desktopLyricsKept', 'ISLANDV', (s) => {
  // 「只做加法、不删桌面歌词」的守卫。砍桌面歌词是**独立一步**，由负责人在真机
  // 确认新态观感之后执行 —— 在此之前任一层被提前删掉都判红。
  const missing = [];
  if (!existsSync(F.desktopLyrics) || !/export function DesktopLyrics\b/.test(stripComments(s.desktopLyrics ?? '')))
    missing.push('screens/lyrics/DesktopLyrics.tsx 不在或没了 DesktopLyrics');
  if (!existsSync(F.rustLyrics) || !/open_lyrics_window/.test(s.rustLyrics ?? ''))
    missing.push('src-tauri/src/commands/lyrics_window.rs 不在或没了 open_lyrics_window');
  if (!existsSync(F.lyricsHtml)) missing.push('templates/lyrics.html 不在');
  const store = stripComments(s.store ?? '');
  if (!hasMethodImpl(store, 'pushLyricsState')) missing.push('store 的 pushLyricsState 实现没了');
  if (!/\bdesktopLyricsFontSize\b/.test(store)) missing.push('desktopLyrics* 偏好没了');
  if (!/export const openLyricsWindow\b/.test(stripComments(s.ipc ?? ''))) missing.push('ipc 的 openLyricsWindow 没了');
  // 主窗侧唯一的窗口入口（设置页那一项与它共用同一个 store action）。
  // 判据锚点按设计稿改成固定 title「桌面歌词窗口」+ 真的接了 `setLyricsWindowOpen`：
  // 只要这个开关还在且能开合，本组要防的"提前删桌面歌词"就没发生。
  const playerBar = stripComments(s.playerBar ?? '');
  if (!/title="桌面歌词窗口"/.test(playerBar) || !/setLyricsWindowOpen\(/.test(playerBar))
    missing.push('PlayerBar 的桌面歌词开关没了');
  return { ok: missing.length === 0, detail: missing.length ? `桌面歌词仍在（未提前删）：${missing.join('、')}` : '' };
});

// ============================ RESTORE（启动恢复上次播放）============================
// 这一组防的是「恢复功能被改坏后**不报错、只是默默做错」**。恢复链路上每一步都
// 有静默失效的形态：快照没存 → 重开是空的（与"从没存过"无法区分）；版本没校验 →
// 拿着旧结构继续跑；三态判错 → 断网就丢队列；seek 时序错 → "定位没生效"；
// 闸漏不关 → 用户正常播放遇到一次抖动就把队列清空。
//
// ⚠️ 判据一律先 stripComments：本组代码的注释里**主动写出了被禁的写法**
// （如「不设 autoplay:false」「restoring 一直开着」），不剥注释会恒绿。

/** 数一个片段在文本里出现几次（用于"数次数"型判据，避免"只判存在"） */
const occurrences = (src, needle) => src.split(needle).length - 1;

add('RESTORE.snapshotPersisted', 'RESTORE', (s) => {
  // 写入时机三处：切歌后 · 暂停时 · MusicKernel 的低频定时器兜底。
  // 少一处就丢一类场景（"正听着直接退出"全靠定时器），故**数次数**而不只判存在。
  const store = stripComments(s.store ?? '');
  const kernel = stripComments(s.kernel ?? '');
  const missing = [];
  if (!hasMethodImpl(store, 'persistSnapshot')) missing.push('store 的 persistSnapshot 实现没了');
  const inStore = occurrences(store, 'get().persistSnapshot()');
  if (inStore < 2) missing.push(`store 里 persistSnapshot 只被调 ${inStore} 次（应 ≥2：切歌后 / 暂停时）`);
  if (!/s\.persistSnapshot\(\)/.test(kernel))
    missing.push('MusicKernel 没有兜底定时器存快照（正听着直接退出会丢进度）');
  if (!/SNAPSHOT_PERSIST_INTERVAL_MS/.test(kernel)) missing.push('MusicKernel 的定时器没���用导出的间隔常量');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('RESTORE.snapshotVersioned', 'RESTORE', (s) => {
  // 版本校验：localStorage 跨版本存活，不校验就会拿着旧结构继续跑
  // （症状"恢复了但队列是空的"，且不报错）。
  const body = fnBodyAny(s.storePersist ?? '', 'readResumeSnapshot') || '';
  const missing = [];
  if (!/SNAPSHOT_VERSION/.test(body)) missing.push('readResumeSnapshot 不认版本号');
  if (!/s\.v\s*!==\s*SNAPSHOT_VERSION/.test(body)) missing.push('readResumeSnapshot 没有「版本不符即当没有」的判据');
  if (!/index\s*>=\s*s\.queue\.length/.test(body)) missing.push('readResumeSnapshot 没有校验下标越界');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('RESTORE.truncateKeepsCurrent', 'RESTORE', (s) => {
  // 队列截断到 200（Q3）时**必须保证当前歌仍在窗口内**并返回新下标。
  // 直接取前 N 首会让恢复后停在一首完全不同的歌上，而播放条显示的正是那首。
  //
  // ⚠️ 这里**不用 fnBodyAny 取函数体**：该函数签名带内联对象返回类型
  // `): { queue: Song[]; index: number } {`，取体工具会把**类型注解里的 `{`**
  // 当成函数体起点（已实测取空 → 判据恒红）。改用两条实现细节上**唯一**的锚点。
  const store = s.storePersist ?? '';
  const missing = [];
  if (!/index:\s*index\s*-\s*start/.test(store)) missing.push('截断后没有重算 index（当前歌会被截出窗口）');
  if (!/queue\.slice\(start,\s*start\s*\+\s*max\)/.test(store)) missing.push('截断不是按 start 窗口切');
  if (!/SNAPSHOT_MAX_QUEUE\s*=\s*200/.test(store)) missing.push('队列上限不是 200（Q3 拍板）');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('RESTORE.playbackSourcePersisted', 'RESTORE', (s) => {
  // 播放平台此前**根本没持久化**（硬编码 'netease'）。没有它就不知道该按哪个平台
  // 校验登录态，恢复永远判成"不是上次那个平台"。
  const store = stripComments(s.store ?? '');
  const missing = [];
  if (!/savePrefs\(\{\s*playbackSource:\s*p\s*\}\)/.test(store)) missing.push('切平台时没存 playbackSource 偏好');
  if (!/ALL_PROVIDERS\.includes\(prefs\.playbackSource/.test(store))
    missing.push('hydratePrefs 没有对 playbackSource 做白名单收口');
  if (!/playbackSource:\s*'netease'/.test(store)) missing.push('playbackSource 初值不再是默认netease');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('RESTORE.verdictThreeStates', 'RESTORE', (s) => {
  // 三态映射：null → 探测失败（**不是**未登录！）／ logged_in → 有效 ／ 否则未登录。
  // 判错的后果不对称：把"探测失败"当"未登录"→ 用户一断网就丢播放进度。
  const body = fnBodyAny(stripComments(s.store ?? ''), 'loginVerdict') || '';
  const missing = [];
  if (!body) missing.push('loginVerdict 没了');
  else {
    if (!/===\s*null\s*\|\|\s*info\s*===\s*undefined/.test(body))
      missing.push('没把「null / undefined」判为 probe_failed');
    if (!/return\s+'probe_failed'/.test(body)) missing.push('缺 probe_failed 返回值');
    if (!/\.logged_in\s*\?\s*'valid'\s*:\s*'logged_out'/.test(body))
      missing.push('logged_in 没有二分映射到 valid / logged_out');
  }
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('RESTORE.restoredPaused', 'RESTORE', (s) => {
  // 恢复出来的歌必须**停在暂停态**（需求原话）且**不展开播放器**（恢复不是"用户点了它"）。
  const body = methodBody(stripComments(s.store ?? ''), 'restoreSession') || '';
  const missing = [];
  if (!body) missing.push('restoreSession 实现没了');
  else {
    if (!/autoplay:\s*false/.test(body)) missing.push('恢复时没传 autoplay:false（会直接自动播放）');
    if (!/expand:\s*false/.test(body)) missing.push('恢复时没传 expand:false（会弹出展开播放器）');
    if (!/resumeAtMs:\s*snap\.progressMs/.test(body)) missing.push('恢复时没有把快照进度传给 playSong');
  }
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('RESTORE.probeFailKeepsSnapshot', 'RESTORE', (s) => {
  // Q1 的核心：探针失败**保留快照**且把闸退回允许重试；明确未登录才清。
  // 两个动作都不可省：只保留不退回 → 断网时第一次进屏就把闸关死，网络好了也永不再试。
  const body = methodBody(stripComments(s.store ?? ''), 'restoreSession') || '';
  const missing = [];
  if (!body) missing.push('restoreSession 实现没了');
  else {
    const loggedOutBranch = body.split("'logged_out'")[1]?.split('}')[0] ?? '';
    if (!/clearResumeSnapshot\(\)/.test(loggedOutBranch)) missing.push('明确未登录时没有清快照');
    const probeBranch = body.split("'probe_failed'")[1]?.split('return')[0] ?? '';
    if (!/restoreAttempted:\s*false/.test(probeBranch)) missing.push('探针失败时没有把闸退回 false（之后永不再试）');
    if (/clearResumeSnapshot\(\)/.test(probeBranch)) missing.push('探针失败时错误地清了快照（断网会丢播放进度）');
  }
  if (!/if\s*\(!snap\)\s*return;/.test(body)) missing.push('没有快照时直接返回（不该做任何恢复动作）');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('RESTORE.restoringClosed', 'RESTORE', (s) => {
  // 恢复态的闸 `restoring` **必须每条路径都关**：
  //   ① 音频真的加载出来（loadedmetadata，在 kernel 里）
  //   ② URL 解析抛错（playUrl 永不设置 ⇒ 没有 loadedmetadata 来关）
  //   ③ 恢复中队列只剩一首歌且它也失败（没有"下一首"可跳）
  //   ④ 整条队列都试完（handleRestoreFailed）
  // 漏任一条的后果：用户之后正常播放遇到一次网络抖动，就会静默遍历整个队列并清空播放条。
  const store = stripComments(s.store ?? '');
  const kernel = stripComments(s.kernel ?? '');
  const missing = [];
  // 四条关闭路径各有**唯一**的实现锚点（数次数不够 —— 四处任意一处被删都要能抓到）
  if (!/if\s*\(get\(\)\.restoring\)\s*set\(\{\s*restoring:\s*false\s*\}\)/.test(store)) {
    missing.push('finishRestore 没有关闸（音频加载成功时闸会一直开着）');
  }
  if (!/set\(\{\s*isPlaying:\s*false,\s*restoring:\s*false\s*\}\)/.test(store)) {
    missing.push('playSong 的 URL 解析抛错路径没有关闸（该路径 playUrl 永不设置，没有 loadedmetadata 来关）');
  }
  if (occurrences(store, 'get().clearQueue(true);\n            set({ restoring: false });') < 1) {
    missing.push('恢复中队列只剩一首歌且它也失败时没有关闸（没有"下一首"可跳）');
  }
  if (occurrences(store, 'get().clearQueue(true);\n    set({ restoring: false });') < 1) {
    missing.push('整条队列都试完时没有关闸');
  }
  if (!/finishRestore/.test(kernel)) missing.push('kernel 没有在加载成功时调 finishRestore');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('RESTORE.seekAfterMetadata', 'RESTORE', (s) => {
  // 定位必须等 loadedmetadata：冷启动是全新加载（readyState=0），此刻设
  // currentTime 会被浏览器**静默忽略**，症状"定位没生效、从 0 开始"且不报错。
  const kernel = stripComments(s.kernel ?? '');
  const missing = [];
  const onMeta = kernel.split('onLoadedMetadata')[1]?.slice(0, 900) ?? '';
  if (!/currentTime\s*=\s*resumeAtMs\s*\/\s*1000/.test(onMeta))
    missing.push('onLoadedMetadata 里没有设 currentTime（定位会静默失效）');
  if (!/clearResumeAt\(\)/.test(onMeta)) missing.push('onLoadedMetadata 里没有清 resumeAtMs（会重复定位）');
  // 反向：playUrl 变化的 effect 里**不能**再设 currentTime（那是未加载完时就设）
  const playEffect = kernel.split('播放/暂停同步')[1]?.split('}, [')[0] ?? '';
  if (/currentTime\s*=/.test(playEffect))
    missing.push('播放同步 effect 里仍在设 currentTime（未加载完，浏览器会忽略）');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('RESTORE.localSkipsCorsFallback', 'RESTORE', (s) => {
  // 本地文件被移走时**不能**走 CORS 降级：那条路径会 markNotWirable(a)，
  // 把常驻 audio 元素永久标记为不可接管（音量失效 + 真实波形消失）。
  // 本地歌走 asset://（Tauri 的 asset 协议带 CORS 头），本就不需要降级。
  const kernel = stripComments(s.kernel ?? '');
  const missing = [];
  if (!/isLocalFile/.test(kernel)) missing.push('onError 没有区分本地文件');
  if (!/_localPath/.test(kernel))
    missing.push('本地判定没有用 currentSong._localPath（用 URL 前缀会误判网络歌走本地代理）');
  if (!/corsMode\s*&&\s*a\s*&&\s*!isLocalFile/.test(kernel)) missing.push('CORS 降级条件没有排除本地文件');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('RESTORE.skipLimitRestoring', 'RESTORE', (s) => {
  // Q4：恢复态的「无版权/加载失败跳下一首」上限必须是**队列长度**（遍历到有一首能播），
  // 平时仍是 10 首（不动既有体验）。写死 10 会让"全部失败"永远走不到清空那一步。
  const store = stripComments(s.store ?? '');
  const missing = [];
  if (!/restoring\s*\?\s*Math\.max\(1,\s*get\(\)\.queue\.length\)\s*:\s*10/.test(store)) {
    missing.push('跳歌上限没有「恢复态用队列长度、平时 10 首」的分流');
  }
  if (!/if\s*\(!restoring\)\s*get\(\)\.toast\(/.test(store))
    missing.push('恢复态仍在弹「无版权已跳过」提示（用户还没操作，是噪音）');
  if (!/restoring[\s\S]{0,400}clearQueue\(true\)/.test(store))
    missing.push('恢复态遍历完没有清空队列（播放条不会隐藏）');
  if (!hasMethodImpl(store, 'handleRestoreFailed')) missing.push('handleRestoreFailed 实现没了');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('RESTORE.onlyOnce', 'RESTORE', (s) => {
  // Q6：只跑一次。init 无防重入守卫、切屏会重跑 MusicScreen，所以闸必须独立存在。
  const store = stripComments(s.store ?? '');
  const screen = stripComments(s.musicScreen ?? '');
  const missing = [];
  if (!/restoreAttempted:\s*boolean/.test(store)) missing.push('store 没有 restoreAttempted 闸字段');
  const body = methodBody(store, 'restoreSession') || '';
  if (!/if\s*\(get\(\)\.restoreAttempted\)\s*return;/.test(body))
    missing.push('restoreSession 入口没有闸（切屏会重复恢复并覆盖用户操作）');
  if (!/restoreSession/.test(screen)) missing.push('MusicScreen 没有调用 restoreSession');
  // 必须挂在音乐屏（恢复要显示播放条），且不能放进 init（init 会重跑）
  if (/init:\s*[\s\S]{0,600}restoreSession\(\)/.test(store)) missing.push('恢复被塞进 init 里（切屏重跑会重复恢复）');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

// ── WEBVIEW（窗口 WebView2 参数一致性）──────────────────────────────────────
//
// 这一组防的是「音乐模块 → 点登录 → 选网易云 → **登录窗口打开失败**」的真因（台账 D-92）。
//
// 机制（不是猜测，是微软 Win32 文档的原话）：
//   · wry 在**每次建 webview** 时都调一次 `CreateCoreWebView2EnvironmentWithOptions`，
//     把 `additional_browser_args` 塞进 `AdditionalBrowserArguments`
//     （`wry-0.57.0/src/webview2/mod.rs:289-370`；不设时用 wry 默认值，同文件 :303）。
//   · 同一个 user data folder 只对应**一个共享的浏览器进程**。
//   · 微软文档：「WebView creation fails with HRESULT_FROM_WIN32(ERROR_INVALID_STATE)
//     if the specified options does not match the options of the WebViews that are
//     currently running in the shared browser process.」
//     `ERROR_INVALID_STATE` = **0x8007139F**。
//   ⇒ 「主窗走默认值、登录窗走自定义值」不是风格差异，是**必炸**：
//     第二个环境创建直接被拒 ⇒ `build()` 返 Err ⇒ 前端只看到「登录窗口打开失败」。
//     （歌词窗同样没设参数，所以它一直没事 —— 这正是"只有登录窗坏"的原因。）
//
// 所以判据不是"别设参数"，而是**「要么都不设，要么所有窗口设成逐字相同的一份」** ——
// 后者才是将来真要做参数定制时该走的路。
add('WEBVIEW.sameArgsEverywhere', 'WEBVIEW', (s) => {
  // ⚠️ 必须先剥注释：mod.rs 里正是用注释写明「不许设 additional_browser_args」的，
  //    直接扫原文会把解释文字当成"设了"⇒ 恒红（本项目栽过多次的"着力点撞上注释"）。
  const rust = [stripComments(s.rustMod ?? ''), stripComments(s.rustLyrics ?? '')].join('\n');
  // Rust 侧：每个 webview 都对应一次 WebviewWindowBuilder::new
  const runtimeWindows = (rust.match(/WebviewWindowBuilder::new\s*\(/g) || []).length;
  const declared = rust.match(/additional_browser_args\s*\(\s*"([^"]*)"/g) || [];
  const values = new Set(declared.map((d) => d.slice(d.indexOf('"') + 1, d.lastIndexOf('"'))));

  // tauri.conf.json 的 `app.windows` 里每个窗口同样是一个 webview
  let confWindows = 0;
  let confWithArgs = 0;
  try {
    const conf = JSON.parse(s.tauriConf ?? '{}');
    for (const w of conf?.app?.windows ?? []) {
      confWindows++;
      if (w && w.additionalBrowserArgs != null) {
        confWithArgs++;
        values.add(String(w.additionalBrowserArgs));
      }
    }
  } catch {
    return { ok: false, detail: 'tauri.conf.json 不是合法 JSON' };
  }

  const totalWindows = runtimeWindows + confWindows;
  const withArgs = declared.length + confWithArgs;
  if (withArgs === 0) return { ok: true, detail: '' }; // 当前策略：全体走 wry 默认值（天然一致）
  if (values.size > 1)
    return {
      ok: false,
      detail: `窗口之间的 WebView2 参数不一致（${values.size} 种取值）⇒ 共享浏览器进程会以 0x8007139F 拒绝建窗`,
    };
  if (withArgs !== totalWindows)
    return {
      ok: false,
      detail: `只有 ${withArgs}/${totalWindows} 个窗口设了参数 ⇒ 与其余窗口的 wry 默认值冲突，第 ${withArgs + 1} 个窗口起创建失败（登录窗口打不开）`,
    };
  return { ok: true, detail: '' };
});

add('WEBVIEW.loginExternal', 'WEBVIEW', (s) => {
  // 登录窗/弹窗必须加载**平台官方页面**（`WebviewUrl::External`）。
  // 若照抄桌面歌词窗那套 `WebviewUrl::App("lyrics.html")` 的写法，登录窗会去加载
  // 应用自身界面 ⇒ 用户面前弹出来的是我们自己的 UI，登录页根本不出现，
  // 而代码能编译、能跑、不报错（歌词窗必须 App、登录窗必须 External，两者**不可互抄**）。
  const rust = stripComments(s.rustMod ?? '');
  if (!rust) return { ok: false, detail: 'src-tauri/src/music/mod.rs 不存在' };
  if (/WebviewUrl::App\s*\(/.test(rust))
    return {
      ok: false,
      detail:
        'music/mod.rs 里出现了 WebviewUrl::App —— 登录窗/弹窗必须加载平台官方页面（External），不能加载应用自身页面',
    };
  const ext = (rust.match(/WebviewUrl::External\s*\(/g) || []).length;
  if (ext < 5) return { ok: false, detail: `只有 ${ext} 处 WebviewUrl::External（四平台登录窗 + OAuth 弹窗共 5 处）` };
  return { ok: true, detail: '' };
});

// ── 执行器 ────────────────────────────────────────────────────────────────
function runAll(s, ids) {
  const res = {};
  for (const a of A) {
    if (ids && !ids.includes(a.id)) continue;
    try {
      const r = a.run(s);
      res[a.id] = { ok: !!r.ok, detail: r.detail || '' };
    } catch (e) {
      res[a.id] = { ok: false, detail: `断言抛错：${e.message}` };
    }
  }
  return res;
}

const GROUPS = [
  'RUST',
  'IPC',
  'PLATFORM',
  'STORE',
  'DUR',
  'SEARCH',
  'UI',
  'PLAYER',
  'PLAYLIST',
  'HEARTBEAT',
  'LYRICS',
  'AUDIO',
  'CACHE',
  'SKIN',
  'QUEUE',
  'MENU',
  'ISLANDV',
  'RESTORE',
  'KEYS',
  'WEBVIEW',
  'CAPTURE',
];
function printGrouped(res) {
  let pass = 0;
  let fail = 0;
  for (const g of GROUPS) {
    const items = A.filter((a) => a.group === g);
    if (!items.length) continue;
    const gp = items.filter((a) => res[a.id].ok).length;
    const gf = items.length - gp;
    console.log(`\n【${g}】 ${gp}/${items.length}`);
    for (const a of items) {
      const r = res[a.id];
      if (r.ok) {
        pass++;
        console.log(`  ✓ ${a.id}`);
      } else {
        fail++;
        console.log(`  ✗ ${a.id}${r.detail ? `\n      ${r.detail}` : ''}`);
      }
    }
    void gf;
  }
  return { pass, fail };
}

// ── 反证用例：{name, file, find, replace, expect:[断言 id]} ──────────────────
// ============================ QUEUE（播放队列语义）============================
// 这一组防的是「currentSong 与 queue[currentIndex] 不是同一首」这类
// **不报错但状态自相矛盾**的故障：点「下一首」会从错误位置往后走、
// 队列抽屉高亮的也不是正在播的那首 —— 用户只会觉得"有点怪"，说不出哪里错。
//
// ⚠️ 判据一律用 `methodBody` 取函数体再匹配：全文扫 `queue` / `filter` 这类词
// 会被 store 里几十处其它代码命中（本项目已多次栽在"只判存在、不判作用域"）。

add('QUEUE.adoptOutOfQueue', 'QUEUE', (s) => {
  const body = methodBody(stripComments(s.store ?? ''), 'playSong');
  if (!body) return { ok: false, detail: 'store 里取不到 playSong 的实现体' };
  const missing = [];
  // 不传 queue 的分支：在现有队列里找；**找不到必须把这首歌接进队列**。
  // 此前此处"什么都不做"，于是从播放历史点一首队列外的歌会造成状态矛盾。
  if (!/findIndex/.test(body)) missing.push('未在现有队列里查找');
  // 只认 `set({ queue:` 这种**显式改队列**的写法：if 分支用的是 `queue,` 缩写，不会误命中
  if (!/set\(\{[^}]*queue:/.test(body)) missing.push('不在队列时未写入 queue（currentSong 会与队列项不一致）');
  if (!/MAX_PLAY_QUEUE/.test(body)) missing.push('未处理队列已满的边界');
  return { ok: missing.length === 0, detail: missing.length ? `队列接纳：${missing.join('、')}` : '' };
});

add('QUEUE.playNextInsert', 'QUEUE', (s) => {
  const body = methodBody(stripComments(s.store ?? ''), 'playNext');
  if (!body) return { ok: false, detail: 'store 没有 playNext（右键「下一首播放」依赖它）' };
  const missing = [];
  // 已在队列里 → 必须先摘掉再插，否则同一首在队列里出现两份
  if (!/filter\(\(s\)\s*=>\s*songKey\(s\)\s*!==\s*key\)/.test(body)) missing.push('未去重（同一首会在队列里出现两次）');
  // 插入点必须"按当前歌在新数组里的位置 +1"算 —— 不能用 currentIndex + 1 推：
  // 摘掉一项会让后面的项前移，那正是位置漂移的来源
  if (!/at\s*>=\s*0\s*\?\s*at\s*\+\s*1\s*:\s*0/.test(body))
    missing.push('插入点不是按当前歌重新算的（摘掉一项会让它漂移）');
  if (!/currentIndex:\s*idx/.test(body)) missing.push('插完未重新定位 currentIndex');
  return { ok: missing.length === 0, detail: missing.length ? `下一首播放：${missing.join('、')}` : '' };
});

add('QUEUE.playNextNoSelfRemove', 'QUEUE', (s) => {
  const body = methodBody(stripComments(s.store ?? ''), 'playNext');
  if (!body) return { ok: false, detail: 'store 没有 playNext' };
  const guard = 'songKey(currentSong) === key';
  const iGuard = body.indexOf(guard);
  const iFilter = body.indexOf('filter(');
  // 若对"正在播的那首"照常摘掉再插，会把当前项从队列里删掉
  // → currentSong 在播、队列里却找不到它（与 adoptOutOfQueue 是同一类矛盾）
  const ok = iGuard >= 0 && /return;/.test(body) && iGuard < iFilter;
  return {
    ok,
    detail: ok ? '' : '未先判「这首歌正在播」就 return（会把当前项从队列里摘掉）',
  };
});

// ============================ MENU（歌曲右键菜单）============================
// 这一组防的是**右键菜单这一层独有的静默失败**：菜单被滚动容器裁掉（看不见）、
// 点菜单项顺带把这一行也播了（两个动作同时发生）、菜单飘在原处与内容脱节、
// 以及"菜单里的播放与左键点击不是一个语义"（歌单里变成只播一首）。
//
// ⚠️ 判据一律先 `stripComments`：**本任务的注释里主动写出了被禁的写法**
// （注释里写了 `playSong(song)`、`click`、`mousedown` 等），不剥注释会恒绿。
// 判据涉及"某写法可能出现多处"时，一律按文件/函数体限定作用域，而不是全文扫。

/** 取 `export function <name>` 起到**下一个 export 或文件尾**的片段（带边界自校验） */
function exportSection(src, name) {
  const i = src.indexOf(`export function ${name}`);
  if (i < 0) return '';
  const tail = src.slice(i);
  const j = tail.indexOf('\nexport ', 1);
  return j < 0 ? tail : tail.slice(0, j);
}

add('MENU.portal', 'MENU', (s) => {
  const src = stripComments(s.contextMenu ?? '');
  const missing = [];
  if (!/\bcreatePortal\s*\(/.test(src)) missing.push('菜单没走 createPortal');
  // 目标必须是 body：列表都在 overflow 容器里，挂在行内会被裁掉
  if (!/createPortal\([\s\S]*?\bdocument\.body\b\s*,/.test(src)) missing.push('portal 的目标不是 document.body');
  return {
    ok: missing.length === 0,
    detail: missing.length ? `菜单未挂到 body（会被滚动容器裁掉）：${missing.join('、')}` : '',
  };
});

/**
 * 某个事件**是不是**「window.addEventListener(evt, handler, true)」这一条语句。
 *
 * ⚠️ 不能用 `addEventListener\(evt[\s\S]*?,\s*true\s*\)` 这种跨语句写法：
 * 把第三个参数改成 false 后，`[\s\S]*?` 会一路吃到下一条监听的 `, true)` 上，
 * 断言照样绿 —— 反证轮实测抓出的假阳性（改 false 仍判绿），故这里把整条语句钉死。
 */
const isCaptureListener = (src, evt, handler) =>
  new RegExp(`addEventListener\\(\\s*['"]${esc(evt)}['"]\\s*,\\s*${esc(handler)}\\s*,\\s*true\\s*\\)`).test(src);

add('MENU.closeCapture', 'MENU', (s) => {
  const src = stripComments(s.contextMenu ?? '');
  const missing = [];
  // 必须是 mousedown + 捕获阶段：click 到达 window 时行的 onClick 已经先跑完 →
  // 点菜单项会顺带播放这一行（用户只看到"歌切了"，说不清为什么）
  if (!isCaptureListener(src, 'mousedown', 'onDown')) missing.push('外部关闭不是「mousedown + 捕获阶段」');
  if (/addEventListener\(\s*['"]click['"]/.test(src))
    missing.push('用 click 做外部关闭（会被行 onClick 抢先，点菜单项 = 顺带播这一行）');
  return { ok: missing.length === 0, detail: missing.length ? `关闭监听：${missing.join('、')}` : '' };
});

add('MENU.scrollCapture', 'MENU', (s) => {
  const src = stripComments(s.contextMenu ?? '');
  const missing = [];
  // scroll **不冒泡**：只有捕获阶段的 window 监听能听到内层容器的滚动，否则菜单飘在原处
  if (!isCaptureListener(src, 'scroll', 'onClose'))
    missing.push('scroll 监听不是捕获阶段（听不到内层容器滚动 → 菜单与内容脱节）');
  if (!/addEventListener\(\s*['"]resize['"]\s*,/.test(src)) missing.push('resize 未关闭菜单');
  return { ok: missing.length === 0, detail: missing.length ? `视口变化关闭：${missing.join('、')}` : '' };
});

add('MENU.esc', 'MENU', (s) => {
  const src = stripComments(s.contextMenu ?? '');
  // ContextMenu 用「!== 'Escape' 早返回」的写法（而非 === 分支），故判据认这两种形态
  const ok =
    /addEventListener\(\s*['"]keydown['"]/.test(src) &&
    /e\.key\s*!==\s*['"]Escape['"]/.test(src) &&
    /\bonClose\(\)/.test(src);
  return { ok, detail: ok ? '' : 'Esc 不能关闭菜单（缺 keydown 监听或没判 Escape）' };
});

add('MENU.flip', 'MENU', (s) => {
  const src = stripComments(s.contextMenu ?? '');
  const missing = [];
  // 量**真实尺寸**后夹进视口（比常量估算准：菜单没渲染时拿不到真宽高）
  if (!/getBoundingClientRect\(\)/.test(src)) missing.push('未量菜单真实尺寸');
  if (!/window\.innerHeight\s*-\s*r\.height/.test(src)) missing.push('未判下边界');
  if (!/window\.innerWidth\s*-\s*r\.width/.test(src)) missing.push('未判右边界');
  if (!/Math\.max\(8,\s*Math\.min\(/.test(src)) missing.push('未把坐标夹进视口（贴边会溢出）');
  return { ok: missing.length === 0, detail: missing.length ? `视口边缘夹取：${missing.join('、')}` : '' };
});

add('MENU.noBubble', 'MENU', (s) => {
  const src = stripComments(s.contextMenu ?? '');
  // portal 的事件沿 **React 树** 冒泡回宿主；宿主是可点击的行时，根节点必须截断 onClick，
  // 否则「点菜单项 = 顺带点了这一行」（行 onClick 会播这首歌）。
  const ok = /onClick=\{\(e\)\s*=>\s*e\.stopPropagation\(\)\}/.test(src);
  return { ok, detail: ok ? '' : '菜单根节点没有截断 onClick（点菜单项会顺带触发宿主行的点击）' };
});

add('MENU.playSemantics', 'MENU', (s) => {
  const src = stripComments(s.songRowShared ?? '');
  const missing = [];
  // 宿主给了 onPlay 就用宿主的（与左键点击同一语义）……
  if (!/if\s*\(\s*menu\.onPlay\s*\)\s*menu\.onPlay\(\s*\)/.test(src)) missing.push('「播放」没有优先用宿主的 onPlay');
  // ……没给才退回 playSong：绝不在这里猜一个"大概对"的语义
  if (!/else\s+void\s+playSong\(menu\.song\)/.test(src)) missing.push('宿主没给 onPlay 时未退回 playSong(song)');
  return { ok: missing.length === 0, detail: missing.length ? `播放语义：${missing.join('、')}` : '' };
});

add('MENU.nextItem', 'MENU', (s) => {
  const src = stripComments(s.songRowShared ?? '');
  const missing = [];
  if (!/下一首播放/.test(src)) missing.push('菜单里没有「下一首播放」项');
  if (!/playNext\(menu\.song\)/.test(src)) missing.push('「下一首播放」没有调 playNext');
  return { ok: missing.length === 0, detail: missing.length ? `下一首播放：${missing.join('、')}` : '' };
});

add('MENU.noDownload', 'MENU', (s) => {
  // 本轮不做：取流要动 Rust。留一个"点了没反应"的菜单项比没有更糟。
  // 判据不限作用域但限定三处菜单来源，且**不剥注释** —— 注释里也不该出现它。
  const hit =
    /下载/.test(s.songRowShared ?? '') || /下载/.test(s.queueDrawer ?? '') || /下载/.test(s.contextMenu ?? '');
  return { ok: !hit, detail: hit ? '菜单里出现了「下载」项（本轮不做，避免点了没用）' : '' };
});

add('MENU.rowContextMenu', 'MENU', (s) => {
  const body = exportSection(stripComments(s.songRowShared ?? ''), 'SongRow');
  if (!body) return { ok: false, detail: 'shared.tsx 里取不到 SongRow' };
  const missing = [];
  if (!/\bonContextMenu=/.test(body)) missing.push('SongRow 没接 onContextMenu（右键没反应）');
  if (!/setMenu\(\{\s*x:\s*e\.clientX,\s*y:\s*e\.clientY,\s*song,\s*onPlay\s*\}\)/.test(body))
    missing.push('右键没有把宿主的 onPlay 带进菜单');
  if (!/onPlay\?:/.test(body)) missing.push('SongRow 没有可选的 onPlay prop');
  if (!/<ContextMenu\b/.test(body)) missing.push('SongRow 没渲染菜单（ContextMenu）');
  return { ok: missing.length === 0, detail: missing.length ? `歌曲行菜单：${missing.join('、')}` : '' };
});

/** 四个列表：左键点击与右键「播放」必须是**同一个**回调（各 songs 处一一对应） */
const hostOnPlay = (id, key, min) =>
  add(`MENU.onPlay.${id}`, 'MENU', (s) => {
    const src = stripComments(s[key] ?? '');
    const nClick = (src.match(/onClick=\{play\}/g) || []).length;
    const nPlay = (src.match(/onPlay=\{play\}/g) || []).length;
    const ok = nClick >= min && nPlay === nClick;
    return {
      ok,
      detail: ok
        ? ''
        : `${key}：onClick={play} ${nClick} 处 / onPlay={play} ${nPlay} 处（应 ≥${min} 且两者相等 —— 少一处就是右键「播放」与左键点击不是一个语义）`,
    };
  });
hostOnPlay('left', 'leftPanel', 1); // 歌单曲目
hostOnPlay('right', 'rightPanel', 3); // 搜索结果 / 榜单曲目 / 每日推荐 —— 三处逐一接
hostOnPlay('local', 'localView', 1); // 本地曲库
hostOnPlay('history', 'historyView', 1); // 播放历史

add('MENU.queueRow', 'MENU', (s) => {
  const src = stripComments(s.queueDrawer ?? '');
  const missing = [];
  const iState = src.indexOf('const [menu, setMenu] = useState<');
  const iEarly = src.indexOf('if (!queueOpen) return null;');
  if (iState < 0) missing.push('QueueDrawer 没有菜单状态');
  else if (iEarly >= 0 && iState > iEarly)
    missing.push('菜单状态在早退之后声明（放 renderItem 里同理 —— 顺序会随行数变）');
  // 队列行不是 SongRow，是自己接的：不给 onPlay → 走 playSong(s) 的"在现有队列里定位"语义
  if (!/onContextMenu=\{\(e\)\s*=>\s*\{/.test(src)) missing.push('队列行没接 onContextMenu');
  if (!/<ContextMenu\b/.test(src)) missing.push('QueueDrawer 没渲染菜单（ContextMenu）');
  return { ok: missing.length === 0, detail: missing.length ? `队列行菜单：${missing.join('、')}` : '' };
});

add('MENU.css', 'MENU', (s) => {
  const css = s.css ?? '';
  // 菜单样式已收口到通用单元的 .ui-menu（components.scss）；music 屏不再自造 .music-menu
  const i = css.indexOf('.ui-menu {');
  const block = i < 0 ? '' : css.slice(i, css.indexOf('}', i));
  const missing = [];
  if (!block) missing.push('样式缺 .ui-menu 规则');
  else {
    const tokens = (block.match(/var\(--md-/g) || []).length;
    if (tokens < 3) missing.push(`.ui-menu 只用了 ${tokens} 个设计令牌（深色模式不跟随）`);
  }
  // 右键菜单（.ui-ctx）必须高于队列抽屉(72)/展开播放器(70)、低于模态(80)
  const ci = css.indexOf('.ui-menu.ui-ctx');
  const ctxBlock = ci < 0 ? '' : css.slice(ci, css.indexOf('}', ci));
  if (!/z-index:\s*78\b/.test(ctxBlock)) missing.push('右键菜单未抬到 z-index 78（会被队列抽屉/展开播放器压住看不见）');
  if (!/\.ui-menu-item\s*\{/.test(css)) missing.push('样式缺 .ui-menu-item 规则');
  return { ok: missing.length === 0, detail: missing.length ? `菜单样式：${missing.join('、')}` : '' };
});

// ============================ KEYS（音乐快捷键）============================
// 这一组防的是「快捷键**看起来装上了、实际不响或不敢响**」这一族静默失败。
// 快捷键层没有编译期保障：少写一个 `preventDefault`、判据少写一个标签、���抖键位
// 多包了一层，全都是**编译绿、tsc绿、界面正常，只有真按键盘才知道对不对**。
//
// 三条最容易假绿的地方，本组逐条钉死：
//  ① 让位判据**只用 tagName**⇒ 焦点落在 IconButton 内部的 <svg>/<path> 上时判不出来
//     ⇒「按空格暂停」变成「按空格点了静音」；
//  ② `preventDefault` 写在去抖**之后** ⇒ 连按 ⌘+← 时浏览器原生"后退"跟着一起触发；
//  ③ 去抖时间戳**全键共用一个**⇒ 「⌘+→ 连按两下再按 ⌘+←」时后者被吃掉，上一首按不动。
//
// ⚠️ 本组判据一律先 `stripComments`：hook 的注释里**主动写出了被判的写法**
// （如 `preventDefault` 在去抖之前的说明、`Record<string, number>`、
// `contenteditable="false"`），不剥注释会恒绿（该红没红）。
// ⚠️ 凡"某写法可能出现多处"（`stepVolume` / `preventDefault` / `closest(`）一律**数次数或限定作用域**。

/**
 * 取 `switch (e.key)` 里某个 `case '<key>': { … }` 的**花括号块**。
 *
 * ## 为什么必须按 case 块限定作用域
 *
 * `preventDefault()` / `stepVolume()` / `!mod` 这些写法在 hook 里都出现多次
 * （5 个 case 各一份）。只判「文件里存在」⇒ 改掉其中任何一个 case，断言仍绿
 * （本项目第9 次「只判存在不判唯一」家族）。按 case 取块后，
 * 判据只落在那一个 case 的体内，改哪一格就红哪一格。
 */
function caseBlock(src, key) {
  const at = src.indexOf(`case '${key}': {`);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  const end = matchBracket(src, open);
  return end < 0 ? null : src.slice(open, end + 1);
}

/** 取模块级 `const NAME = [ … ].join(…)` 的数组块（判据限定在选择器名单体内） */
function constArrayBlock(src, name) {
  const at = src.indexOf(`const ${name} = [`);
  if (at < 0) return null;
  const end = src.indexOf('].join(', at);
  return end < 0 ? null : src.slice(at, end);
}

/**
 * 取 `const <name> = ( … )… => { … }` 这个**箭头 const 函数**的函数体。
 *
 * ## 为什么不能复用 fnBodyAny
 *
 * fnBodyAny 只认 `function name(` 的写法（带 `function` 关键字），
 * 而 hook 里的 `trackSwitchBlocked` / `onKeyDown` 都是
 * `const x = (…) => {…}` 这种**箭头 const** 形态 —— 用 fnBodyAny 会恒返空，
 * 而空串会被判据读成"什么都没找到"⇒ 断言恒红（比恒绿更隐蔽：
 * 反证轮里任何破坏都"变红"，看着 100% 覆盖，其实是空转）。
 *
 * 要求 `=>` 与 `{` 之间只有类型注解/空白，避免把 `=> ({…})` 这类返回对象字面量的
 * 形态误当成函数体（取体起点必须是那个 `{`）。
 */
function arrowConstBody(src, name) {
  // ⚠️ 返回类型标注里也有 `{`（如 `(key: string): boolean => {`）。
  // 用 `[^=]*` 匹配标注会被 `{` 匹配掉（`{` 不是 `=`）⇒ `start` 落到**类型标注的 `{`**，
  // 而 `matchBracket` 从那里起算会立刻在标注末尾的 `}` 处闭合 ⇒ 取到的是空壳/半截函数体
  // ⇒ 判据读不到真正要判的那几行。
  // 正确做法：只允许标注里出现**不含 `{` 的字符**，让它一路吃到箭头前的 `=>`。
  const re = new RegExp(`\\n\\s*const ${esc(name)}\\s*=\\s*\\([^)]*\\)\\s*(?::[^{}=]*)?=>\\s*\\{`);
  const m = re.exec(src);
  if (!m) return null;
  const start = src.indexOf('{', m.index + m[0].length - 1);
  if (start < 0) return null;
  const end = matchBracket(src, start);
  return end < 0 ? null : src.slice(start, end + 1);
}

// ── ① 常驻性：挂在 MusicKernel（App.tsx 的 shell 常驻层），不是 MusicScreen ──
add('KEYS.mountedInKernel', 'KEYS', (s) => {
  // 需求是「打开过就一直生效（跨屏也有效）」。MusicScreen 是**条件渲染**、
  // 切屏即卸载 ⇒ 挂那里用户一切到设置页快捷键就静默失效。
  // 判据钉在 MusicKernel.tsx 确实调用了 useMusicHotkeys()。
  const kernel = stripComments(s.kernel ?? '');
  const screen = stripComments(s.musicScreen ?? '');
  const missing = [];
  if (!/from '@hooks\/useMusicHotkeys'/.test(kernel)) missing.push('MusicKernel 没有引入 useMusicHotkeys');
  // 调用点：必须是 `useMusicHotkeys();` 这样的**调用**，而不是只import
  if (!/^\s*useMusicHotkeys\(\);\s*$/m.test(kernel))
    missing.push('MusicKernel 没有实际调用 useMusicHotkeys()（只 import 不调用 = 快捷键永不生效）');
  // 钉死"只此一处"：kernel 里出现两次调用就意味着重复注册监听器
  const calls = occurrences(kernel, 'useMusicHotkeys();');
  if (calls !== 1)
    missing.push(
      `MusicKernel 里 useMusicHotkeys() 出现 ${calls} 次（应恰为 1 次：重复调用 = 监听器重复注册，一次按键触发多次）`,
    );
  // 反向：MusicScreen 里绝不能有（搬过去就等于前功尽弃）
  if (/useMusicHotkeys\(\)/.test(screen))
    missing.push('MusicScreen 里也调了 useMusicHotkeys()（条件渲染，切屏即卸载 ⇒ 快捷键失效）');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

// ── ② 五个键位映射：四个 store action 都被调到，stepVolume 带 ±0.05 ──
add('KEYS.fiveKeyMapping', 'KEYS', (s) => {
  const hk = stripComments(s.hotkeys ?? '');
  const missing = [];
  if (!hk) return { ok: false, detail: '找不到 hooks/useMusicHotkeys.ts' };
  // 裸空格 → 播放/暂停。限定在 case ' ' 块内，避免与别的 case 的调用串味
  const sp = caseBlock(hk, ' ') || '';
  if (!/s\.togglePlay\(\)/.test(sp)) missing.push(`裸空格没有调 s.togglePlay()（case ' ' 块内）`);
  // ⌘/Ctrl + ← → 上一首；⌘/Ctrl + → → 下一首。同样按 case 块限定
  const left = caseBlock(hk, 'ArrowLeft') || '';
  if (!/s\.prev\(\)/.test(left)) missing.push('⌘/Ctrl + ← 没有调 s.prev()（case ArrowLeft 块内）');
  const right = caseBlock(hk, 'ArrowRight') || '';
  if (!/s\.next\(\)/.test(right)) missing.push('⌘/Ctrl + → 没有调 s.next()（case ArrowRight 块内）');
  // 音量两个方向：按**实参**判，不按 `stepVolume(` 出现与否判
  const up = caseBlock(hk, 'ArrowUp') || '';
  const down = caseBlock(hk, 'ArrowDown') || '';
  const upArgs = /s\.stepVolume\(([^)]*)\)/.exec(up)?.[1]?.trim() ?? null;
  const downArgs = /s\.stepVolume\(([^)]*)\)/.exec(down)?.[1]?.trim() ?? null;
  if (upArgs === null) missing.push('↑ 没有调 s.stepVolume(...)（case ArrowUp 块内）');
  else if (upArgs !== '0.05') missing.push(`↑ 的步长实参是 ${upArgs}，应为 0.05（与滚轮调音量同口径）`);
  if (downArgs === null) missing.push('↓ 没有调 s.stepVolume(...)（case ArrowDown 块内）');
  else if (downArgs !== '-0.05') missing.push(`↓ 的步长实参是 ${downArgs}，应为 -0.05`);
  // 数次数：stepVolume 在本hook 里应恰有 2 个调用点（↑/↓ 各一）。
  // 多一处意味着某个 case 之外又调了一次（可能重复调音量）
  const n = occurrences(hk, 's.stepVolume(');
  if (n !== 2) missing.push(`s.stepVolume( 在 hook 里出现 ${n} 次（应恰为 2 次：↑ 与 ↓ 各一）`);
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

// ── ③ 焦点让位判据完整：input / textarea / select / contenteditable(排除 false) / button ──
add('KEYS.yieldSelectors', 'KEYS', (s) => {
  const hk = stripComments(s.hotkeys ?? '');
  const blk = constArrayBlock(hk, 'INTERACTIVE_SELECTOR');
  if (!blk) return { ok: false, detail: '找不到 INTERACTIVE_SELECTOR 选择器名单' };
  const missing = [];
  // 每项都要求**带引号的精确条目**（'input' 这种），而不是子串命中
  if (!/^\s*'input',?\s*$/m.test(blk))
    missing.push(`判据缺 'input'（打字；音量滑块本身就是 input[type=range]，抢过来会让同一控件有两套步长）`);
  if (!/^\s*'textarea',?\s*$/m.test(blk)) missing.push(`判据缺 'textarea'`);
  if (!/^\s*'select',?\s*$/m.test(blk)) missing.push(`判据缺 'select'`);
  // contenteditable 必须**排除**显式 "false"：那是"不可编辑"的声明
  if (!/\[contenteditable\]:not\(\[contenteditable="false"\]\)/.test(blk))
    missing.push(
      '判据缺 [contenteditable]:not([contenteditable="false"])（必须排除显式 false —— 那恰恰是不可编辑的声明）',
    );
  if (!/^\s*'button',?\s*$/m.test(blk))
    missing.push(`判据缺 'button'（空格在按钮上的原生行为是点它；播放条上排着一排 IconButton）`);
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

// ── ④ 用 closest 而非只比 tagName（本组最致命的一条）──
add('KEYS.usesClosest', 'KEYS', (s) => {
  // IconButton 内部包着 lucide 的 <svg>/<path>，焦点落在它们上面时
  // e.target.tagName 是 'svg'/'path' ⇒ 只比 tagName 会**误劫持**：
  // 用户按空格想暂停，结果触发了那个按钮。
  // 判据：让位函数里必须有 closest( 调用。
  const hk = stripComments(s.hotkeys ?? '');
  const body = fnBodyAny(hk, 'shouldYieldToNative') || '';
  const missing = [];
  if (!body) missing.push('找不到 shouldYieldToNative 函数');
  else {
    if (!/\.closest\(/.test(body))
      missing.push(
        'shouldYieldToNative 没有用 closest()（焦点落在 IconButton 内的 <svg>/<path> 上时只比 tagName 会误劫持：按空格变成点那个按钮）',
      );
    // 反向：closest 必须真的被用来产��判据，而不是判了等于没判
    if (!/closest\([^)]*\)\s*!==\s*null/.test(body))
      missing.push('closest() 的结果没有与 null 比较（判据写出来但没用于判断 = 等于没判）');
  }
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

// ── ⑤ preventDefault 存在，且位置在去抖判断之前 ──
add('KEYS.preventDefaultBeforeDebounce', 'KEYS', (s) => {
  const hk = stripComments(s.hotkeys ?? '');
  const missing = [];
  // 逐个 case 判：被去抖丢弃的按键**仍然属于本快捷键**（不是让位给原生），
  // 所以照样要拦默认行为 —— 否则连按 ⌘+← 时浏览器原生"后退"会跟着触发。
  for (const key of ['ArrowLeft', 'ArrowRight']) {
    const blk = caseBlock(hk, key);
    if (!blk) {
      missing.push(`case ${key} 块没找到`);
      continue;
    }
    const iPd = blk.indexOf('e.preventDefault()');
    const iDb = blk.indexOf('autoRepeatBlocked(');
    if (iPd < 0)
      missing.push(`case ${key} 没有 preventDefault（方向键的原生默认行为是滚动页面，不拦就是"切歌的同时页面滚一下"）`);
    else if (iDb < 0) missing.push(`case ${key} 没有合并调用（${key} 应走 autoRepeatBlocked）`);
    // 位置判据：两个下标都在同一块内，比大小即可（不跨语句，故不受邻居改动影响）
    else if (iPd > iDb)
      missing.push(
        `case ${key} 的 preventDefault 写在去抖判断**之后**（被去抖丢弃的按键仍属本快捷键，连按时原生"后退"/滚动会跟着一起触发）`,
      );
  }
  // 空格与音量两个方向：preventDefault 必须各自在本 case 内（滚动是它们的默认行为）
  for (const key of [' ', 'ArrowUp', 'ArrowDown']) {
    const blk = caseBlock(hk, key) || '';
    if (!/e\.preventDefault\(\)/.test(blk)) missing.push(`case '${key}' 没有 preventDefault（会带着页面滚动一起触发）`);
  }
  // 数次数：全文应恰有 5 处 preventDefault（5 个 case 各一）。
  // 多一处 ⇒ 某个让位路径也拦了默认行为（会把输入框/按钮的原生行为一起废掉）
  const n = occurrences(hk, 'e.preventDefault()');
  if (n !== 5)
    missing.push(
      `e.preventDefault() 在 hook 里出现 ${n} 次（应恰为 5 次：五个键各一；多出来的那处会把让位元素的原生行为也废掉）`,
    );
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

// ── ⑥ ⌘/Ctrl 双平台等价：不按平台分叉 ──
add('KEYS.metaCtrlEquivalent', 'KEYS', (s) => {
  // 判据钉在 `const mod = e.metaKey || e.ctrlKey;` 这一句上：
  // 两个平台等价 ⇒ 不该出现 navigator.platform / isMac 之类分叉。
  const hk = stripComments(s.hotkeys ?? '');
  const missing = [];
  if (!/const mod = e\.metaKey \|\| e\.ctrlKey;/.test(hk))
    missing.push('没有 `const mod = e.metaKey || e.ctrlKey;`（⌘ 与 Ctrl 必须等价合成一个判据）');
  // 反向：不得按平台分叉（win 用 Ctrl、mac 用 ⌘ 的写法会让另一个平台整体失灵）
  for (const bad of ['navigator.platform', 'navigator.userAgent', 'isMac', 'isWindows']) {
    if (hk.includes(bad)) missing.push(`出现了按平台分叉的判据 ${bad}（应统一用 mod，双平台等价）`);
  }
  // mod 必须真的被两个方向键用上（否则就是"定义了但没人用"）
  for (const key of ['ArrowLeft', 'ArrowRight']) {
    const blk = caseBlock(hk, key) || '';
    if (!/\bmod\b/.test(blk)) missing.push(`case ${key} 没有用到 mod（裸方向键必须靠 mod 守卫才不回���）`);
  }
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

// ── ⑦ 裸方向键不被响应（不劫持漫画对照视图翻页的唯一保证）──
add('KEYS.bareArrowsIgnored', 'KEYS', (s) => {
  // LibraryScreen 的 Compare 监听**裸** ArrowLeft/ArrowRight 翻页（全局 window 监听）。
  // 本 hook 若认裸方向键，就是在别的屏抢别人的键 ⇒ 翻页翻不动、音乐那边也没发生。
  const hk = stripComments(s.hotkeys ?? '');
  const missing = [];
  for (const key of ['ArrowLeft', 'ArrowRight']) {
    const blk = caseBlock(hk, key);
    if (!blk) {
      missing.push(`case ${key} 块没找到`);
      continue;
    }
    // 必须是「无修饰键则 return」这类**提前退出**，且必须出现在调用 prev/next 之前
    const guardAt = blk.search(/if\s*\(\s*!mod/);
    if (guardAt < 0) missing.push(`case ${key} 没有「无修饰键则不处理」的守卫（裸方向键会劫持漫画对照视图翻页）`);
    const callAt = blk.search(/s\.(prev|next)\(\)/);
    if (guardAt >= 0 && callAt >= 0 && guardAt > callAt)
      missing.push(
        `case ${key} 的守卫写在 ${key === 'ArrowLeft' ? 'prev()' : 'next()'} 调用之后（顺序颠倒 = 守卫无效）`,
      );
    // 守卫必须以 return 收尾（只是标记一个布尔、不退出的话裸键仍会走下去）
    if (guardAt >= 0 && !/return;/.test(blk.slice(guardAt, guardAt + 80)))
      missing.push(`case ${key} 的守卫没有 return（只判不退出 = 裸方向键照样被处理）`);
  }
  // 反向：全文不得出现"裸方向键调进度"的写法（本项目明确不做，Progress 由别处负责）
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

// ── ⑧ 只有切歌去抖、音量不去抖 ──
add('KEYS.manualRepeatOnly', 'KEYS', (s) => {
  // ⚠️ 独立于 KEYS.manualPressNotMerged：那条守的是「放行分支的**位置**」，
  // 这条守的是「放行分支**存在且形态正确**」。
  // 拆成两条的原因见 manualPressNotMerged 的注释：**反证必须一对一**。
  //
  // ⚠️ 判据**不用 arrowConstBody 取体**，改为在剥注释后的全文里找唯一多行锚点。
  // 取体器在本文件上不可靠：`stripComments` 后仍有注释残片，`matchBracket`
  // 遇到残留的 `{` 会提前闭合 ⇒ 返回空壳 `{ }`，而 `indexOf` 在空壳里"命中"了
  // 别处的同名文本 → **判据读的一直是注释**，判绿也不代表代码对。
  // 这是本项目"注释吞掉判据"老坑的第 N 次变种。
  const hk = stripComments(s.hotkeys ?? '');
  const missing = [];
  // 同样**不用单行锚点**（注释里就写着 `if (!e.repeat) return false;`，
  // `stripComments` 只删注释标记、保留文字 ⇒ 单行匹配会被注释冒充）。
  // 要求「放行分支紧跟取时刻」这两行**连续**出现 —— 注释冒充不了连续两行。
  const ok = /if\s*\(\s*!\s*e\.repeat\s*\)\s*return false;\s*\n\s*const now = performance\.now\(\);/.test(hk);
  if (!ok) {
    missing.push('autoRepeatBlocked 里「放行分支 → 取时刻」两行不连续或缺失（一律合并会让手动连点少跳一首）');
  }
  // 反向：该函数必须真的存在（否则上面那句可能在别处出现而误判为通过）
  if (!/const\s+autoRepeatBlocked\s*=/.test(hk)) missing.push('找不到 autoRepeatBlocked（切歌的自动重复合并没了）');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('KEYS.manualPressNotMerged', 'KEYS', (s) => {
  // ⚠️ 这条**只**守「放行分支的**位置**」——即它必须在更新时间戳之前。
  // 「放行分支存在且形态正确」由 KEYS.manualRepeatOnly 独立守护。
  // 拆成两条的原因见那条断言的注释：**反证必须一对一**，两条反证共用一条断言时
  // 两处破坏会在同一次基线比对里互相掩盖，反证轮会报"该红没红"的假阳性。
  //
  // 背景：本轮实测出的真实缺陷 —— 原先用"一律去抖 250ms"来防连按刷请求，
  // 结果把**手动连点**和**按住不放**混为一谈：手速 150ms 连点 3 下（想跳 3 首）
  // 只跳 2 首，看起来就是"按了没反应"，比多发几次请求更糟。
  // 正确形态：**只拦 `e.repeat === true`**（系统按住不放产生的自动重复）。
  const hk = stripComments(s.hotkeys ?? '');
  const missing = [];
  // ⚠️ 判据**不用取体器、也不用单行锚点**。
  // ① 取体器（arrowConstBody）在本文件上返回空壳：`stripComments` 只删注释**标记**、
  //    保留文字，所以注释里出现的 `{` 仍在文本里，`matchBracket` 提前闭合 ⇒ 取到 `{}`，
  //    而 `indexOf` 在空壳里"命中"了别处 → **判据一直在读注释**（这是假绿的真因）。
  // ② 单行锚点也不可靠：注释里就写着 `if (!e.repeat) return false;`。
  // 可靠做法：**要求多行连续**。注释不可能恰好连续复制这五行代码，
  // 实测「这五行」与「反序五行」在文件里各唯一命中一次。
  const ORDERED =
    'if (!e.repeat) return false;\n        const now = performance.now();\n        const prevAt = lastAt.current[key] ?? -Infinity;\n        if (now - prevAt < TRACK_SWITCH_REPEAT_GUARD_MS) return true;\n        lastAt.current[key] = now;';
  const SWAPPED =
    'const now = performance.now();\n        const prevAt = lastAt.current[key] ?? -Infinity;\n        if (now - prevAt < TRACK_SWITCH_REPEAT_GUARD_MS) return true;\n        if (!e.repeat) return false;\n        lastAt.current[key] = now;';
  if (hk.includes(SWAPPED)) {
    missing.push('放行分支写在更新时间戳**之后**（长按后紧接着的一次手动点击会被吃掉）');
  } else if (!hk.includes(ORDERED)) {
    missing.push('autoRepeatBlocked 里「放行分支 → 取时刻 → 比较 → 写回」这五行的顺序不对或缺失（手动连点会被合并掉）');
  }
  // ③ ⚠️ 判据必须与 `manualRepeatOnly` 一样**对称**：
  // 原来这里写的是「旧名 TRACK_SWITCH_DEBOUNCE_MS 不应残留」，那只覆盖了"改名"这一个破坏形态，
  // 改成"新名必须存在"才能覆盖"整个常量被删掉" ⇒ 否则反证轮报"该红没红"的假阳性。
  // 一条反证只破坏一个判据、且该判据必须真能因这个破坏而红。
  if (!/TRACK_SWITCH_REPEAT_GUARD_MS\s*=\s*250/.test(hk)) {
    missing.push('合并窗口常量不是 TRACK_SWITCH_REPEAT_GUARD_MS = 250（合并窗口没落住，合并形同虚设或退回旧语义）');
  }
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('KEYS.shiftLeftToSystem', 'KEYS', (s) => {
  // 带 Shift 的组合键（Shift+↑/↓ 之类）应留给系统与窗口管理器。
  // ⚠️ 这是本轮实测发现的第二个缺陷：注释写着"带修饰键一律不抢"，
  // 但判据只把 metaKey/ctrlKey/altKey 算进去，漏了 Shift ⇒ Shift+↑ 会一边被系统
  // 处理、一边又把音量调了。**判据与注释不一致 = 注释说了但代码没做**。
  const hk = stripComments(s.hotkeys ?? '');
  const missing = [];
  // ① shift 必须被提取成变量（否则各 case 只能重复写 e.shiftKey，容易漏）
  if (!/const\s+shift\s*=\s*e\.shiftKey\s*;/.test(hk)) {
    missing.push('没有提取 const shift = e.shiftKey（各 case 分散判断容易漏掉 Shift）');
  }
  // ② 五个 case 全部必须把 shift 列入"不处理"条件。数次数：应恰 5 处。
  //    ⚠️ 数次数而不是"存在即过" —— 漏一个键就是漏一条让位路径（本项目已犯 3 次）。
  const n = occurrences(hk, '|| shift) return;');
  if (n !== 5) {
    missing.push(
      `"|| shift) return;" 出现 ${n} 次（应恰为 5 次：空格/↑/↓/←/→ 五个 case 各一；漏一个键就是漏一条让位路径）`,
    );
  }
  // ③ 音量与空格的裸键条件也必须含 shift（这四处是"裸键才生效"的收窄）
  for (const key of [' ', 'ArrowUp', 'ArrowDown']) {
    const blk = caseBlock(hk, key) || '';
    if (blk && !/e\.altKey\s*\|\|\s*shift\s*\)\s*return;/.test(blk)) {
      missing.push(`case '${key}' 的裸键条件漏了 shift（Shift+该键会同时被系统与应用处理）`);
    }
  }
  // ④ 切歌两处守卫也要含 shift
  for (const key of ['ArrowLeft', 'ArrowRight']) {
    const blk = caseBlock(hk, key) || '';
    if (blk && !/e\.altKey\s*\|\|\s*shift\s*\)\s*return;/.test(blk)) {
      missing.push(`case ${key} 的守卫漏了 shift`);
    }
  }
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('KEYS.debounceTrackSwitchOnly', 'KEYS', (s) => {
  // 合并自动重复的目的是压住"按住不放时连续发副作用"，而音量恰恰相反：
  // ↑ 是**连续动作**（20%→60% 就是按 8 次）。给音量套上合并，快速连按只生效一次，音量爬不上去。
  const hk = stripComments(s.hotkeys ?? '');
  const missing = [];
  // 两个音量 case 的块内**不得**出现合并调用
  for (const key of ['ArrowUp', 'ArrowDown']) {
    const blk = caseBlock(hk, key) || '';
    if (/autoRepeatBlocked\(/.test(blk))
      missing.push(`case ${key}（音量）被合并逻辑包裹了（音量必须每次都生效，否则快速连按爬不上去）`);
    // 反向：音量 case 必须真的调到了 stepVolume（否则"不合并"就变成了"不处理"）
    if (!/s\.stepVolume\(/.test(blk)) missing.push(`case ${key} 没有调 s.stepVolume(...)（音量键位丢失）`);
  }
  // 反向：切歌两个 case 必须**确实**在合并（否则本组变成"都没合并"也算过）
  for (const key of ['ArrowLeft', 'ArrowRight']) {
    const blk = caseBlock(hk, key) || '';
    if (!/autoRepeatBlocked\(/.test(blk))
      missing.push(`case ${key}（切歌）没有走合并（心动模式下 next() 会发网络请求，按住不放就是刷接口）`);
  }
  // 数次数：合并函数应恰有 2 个调用点（prev/next 各一）。多出第三处 = 又有键被合并了。
  // ⚠️ 锚点是 `autoRepeatBlocked(`（带左括号）—— 定义处写的是 `autoRepeatBlocked =`，
  // 不带括号，所以这里数到的**只有调用点**，不需要为定义处额外 +1。
  const n = occurrences(hk, 'autoRepeatBlocked(');
  if (n !== 2)
    missing.push(
      `autoRepeatBlocked( 在 hook 里出现 ${n} 次（应恰为 2 次：prev/next 各一；多出来的那处说明又有键被合并了）`,
    );
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

// ── ⑨ 去抖按键独立计时（不能全键共用一个时间戳）──
add('KEYS.debouncePerKey', 'KEYS', (s) => {
  // ⚠️ 这是"只判存在不判结构"的典型形态：若lastAt 是单一数字，
  // 「⌘+→ 连按两下再立刻 ⌘+←」会让第二次 ⌘+← 被上一串的窗口吃掉
  // ⇒ 变成"上一首按不动"，比原来的连发问题更糟。
  const hk = stripComments(s.hotkeys ?? '');
  const missing = [];
  // 必须是按 key 索引的结构
  if (!/useRef<Record<string, number>>/.test(hk))
    missing.push(
      'lastAt 不是 Record<string, number>（各键共用一个时间戳 ⇒ 连按 ⌘+→ 后再按 ⌘+← 会被吃掉，上一首按不动）',
    );
  // 实际取上一时刻时必须**带下标**
  const body = arrowConstBody(hk, 'autoRepeatBlocked');
  if (!body) {
    missing.push('找不到 autoRepeatBlocked 函数（切歌的自动重复合并没了）');
  } else {
    // 实际取上一时刻时必须**带下标**。⚠️ 同样**不用取体器**（在本文件上会返回空壳，
    // 判据会读到注释里去），直接在剥注释后的全文里判 —— 这条判据读的是唯一的赋值形态。
    if (!/lastAt\.current\[key\]\s*=\s*now/.test(hk))
      missing.push('没有按 key 写 lastAt.current[key]（共用时间戳 ⇒ 上一首会被上一首的窗口吃掉）');
    if (!/lastAt\.current\[key\]\s*\?\?\s*-Infinity/.test(hk)) missing.push('没有按 key 读 lastAt.current[key]');
  }
  // 两个切歌键必须传**不同的** key 名（共用同一个名字就等于共用一个窗口）
  const keys = [...hk.matchAll(/autoRepeatBlocked\('([^']+)'\)/g)].map((m) => m[1]);
  const uniq = new Set(keys);
  if (uniq.size !== keys.length)
    missing.push(`切歌两键传了同一个合并 key（${keys.join('/')}）⇒ 等于共用一个窗口，其中一键会按不动`);
  if (keys.length !== 2) missing.push(`autoRepeatBlocked 的调用点数是 ${keys.length}（应恰为 2：prev/next 各一）`);
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

// ============================ 截图取证通道（CAPTURE） ============================
/*
 * 为什么音乐域管这个：**音乐屏与桌面歌词窗这两个画面在这一轮被纳入取证序列**。
 * 它跨两个文件、两份手写的清单：
 *   Rust `selftest/capture.rs` 的 steps  —— 真正截哪几张
 *   `e2e/capture.mjs` 的 SHOTS           —— 入库前要收哪几张
 * 两者漂移时**不会报错**：Rust 多截一张（图没人收，白截）、JS 多要一张
 * （要到真在 macOS 上跑一次 capture 才报"没截到"）。故钉在源码上。
 */
add('CAPTURE.musicStep', 'CAPTURE', (s) => {
  const src = s.captureRs ?? '';
  const missing = [];
  if (!/"07-music\.png"/.test(src)) missing.push('取证序列里没有音乐屏那一步');
  // 侧栏标签可被用户关掉（D-84）⇒ 必须按 aria-label 定位；
  // 按 textContent 过滤会在「关掉图标标签」时永远找不到入口（轮询超时 → 截到上一屏）。
  if (!src.includes('.nav-item.is-app[aria-label=\\"音乐\\"]'))
    missing.push('音乐屏那一步没按 aria-label 定位侧栏入口（关掉标签偏好后会找不到它）');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});
add('CAPTURE.lyricsStep', 'CAPTURE', (s) => {
  const src = s.captureRs ?? '';
  const missing = [];
  if (!/"08-lyrics-window\.png"/.test(src)) missing.push('取证序列里没有桌面歌词窗那一步');
  // 🔴 必须截**歌词窗自己**：写回 MAIN_WIN 就会产出「文件名说歌词窗、内容是主窗」的假证据
  if (!/shot_win:\s*LYRICS_WINDOW/.test(src)) missing.push('歌词窗那一步没有把 shot_win 指到 LYRICS_WINDOW');
  if (!/action:\s*Some\(open_lyrics_act\)/.test(src)) missing.push('歌词窗那一步没有走产品自己的 open_lyrics_window');
  // 歌词窗是第二个 HTML 入口下的独立文档，**不挂**主窗主题 provider ⇒ 没有 dataset.theme 可回读。
  // 硬塞一条主题自证只会得到恒红（更坏的是被人改成恒真）。
  if (!/want_theme:\s*None/.test(src)) missing.push('歌词窗那一步仍在要求主题自证（该窗口没有 dataset.theme）');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});
add('CAPTURE.assetsMatchJs', 'CAPTURE', (s) => {
  // 两份清单必须**逐名对齐**：Rust 截的 == JS 收的
  const rustNames = [...(s.captureRs ?? '').matchAll(/"(0\d-[a-z-]+\.png)"/g)].map((m) => m[1]);
  const jsNames = [...(s.captureMjs ?? '').matchAll(/\['(0\d-[a-z-]+\.png)'/g)].map((m) => m[1]);
  const missing = [];
  const onlyRust = rustNames.filter((n) => !jsNames.includes(n));
  const onlyJs = jsNames.filter((n) => !rustNames.includes(n));
  if (onlyRust.length) missing.push(`Rust 截了但 JS 不收：${onlyRust.join('、')}`);
  if (onlyJs.length) missing.push(`JS 要收但 Rust 不截：${onlyJs.join('、')}`);
  if (rustNames.length === 0 || jsNames.length === 0)
    missing.push(`有一侧清单解析为空（rust=${rustNames.length} / js=${jsNames.length}）—— 判据本身失效`);
  return {
    ok: missing.length === 0,
    detail: missing.length ? missing.join('；') : `${rustNames.length} 张两侧逐名对齐`,
  };
});

const MUTATIONS = [
  {
    name: '删掉 platform.ts 里 search 的 migu 分支',
    file: F.platform,
    // 锚点含 offset：签名变过一次（未分页 → 分页），锚点跟着更新，
    // 否则会静默退化成「无法反证」（见脚本底部的分母守卫）
    find: "    case 'migu':\n      return ipc.miguSearch(keywords, limit, offset);\n",
    replace: '',
    expect: ['PLATFORM.dispatch.search'],
  },
  {
    name: '把 kugou 项从 PLATFORMS 里去掉',
    file: F.platform,
    find: "  { id: 'kugou', label: '酷狗音乐', short: '酷', color: '#6E97B9', desc: '千万曲库 · 高品质音效' },\n",
    replace: '',
    expect: ['PLATFORM.list'],
  },
  {
    name: '把 migu 的能力位 chartByName 改回 false',
    file: F.platform,
    find: '    chartByName: true,\n',
    replace: '    chartByName: false,\n',
    expect: ['PLATFORM.caps.chartByName'],
  },
  {
    name: '往 platform.ts 注入被禁品牌标识',
    file: F.platform,
    find: 'export const PLATFORMS',
    replace: `// ${BANNED}\nexport const PLATFORMS`,
    expect: ['PLATFORM.nobrand'],
  },
  {
    name: '删掉 store.ts 里 switchPlaybackSource 的清空逻辑',
    file: path.join(F.actionsDir, 'platform.ts'),
    find: '      officialCharts: [],\n      recommendPlaylists: [],\n      dailySongs: [],\n',
    replace: '      // [refute] 清空逻辑被移除\n',
    expect: ['STORE.switchClears'],
  },
  {
    name: '把 store.ts 的 toggleLike action 改名（模拟漏实现）',
    file: path.join(F.actionsDir, 'like.ts'),
    // 锚点只取到参数表左括号为止：参数名会随实现调整（如 songId → song），
    // 若把参数名写进锚点，一次合法重构就会让这条反证静默失效（「无法反证」≠「已证伪」）。
    find: '  toggleLike: async (',
    replace: '  toggleLikeDisabled: async (',
    expect: ['STORE.actions'],
  },
  {
    name: '从 commands/mod.rs 的 generate_handler! 里摘掉 migu_rank_songs 注册（定义仍在）',
    file: F.rustRegistry,
    find: '        crate::music::migu_rank_songs,\n',
    replace: '',
    expect: ['RUST.registered.migu'],
  },
  {
    name: '把 music/mod.rs 的 migu_search 改名（模拟定义缺失）',
    file: F.rustMod,
    find: 'pub async fn migu_search(',
    replace: 'pub async fn migu_search_disabled(',
    expect: ['RUST.defined.migu'],
  },
  {
    name: '把 ipc.ts 的 kugou_rank_list 命令名写错一个字',
    file: F.ipc,
    find: "'kugou_rank_list'",
    replace: "'kugou_rank_list_broken'",
    expect: ['IPC.kugou'],
  },
  {
    name: '把 VirtualList 的窗口切片去掉（改成全量渲染，退化成非虚拟列表）',
    file: F.virtualList,
    find: 'items.slice(start, end)',
    replace: 'items',
    expect: ['UI.virtualList'],
  },
  {
    name: '把推荐歌单从封面卡网格退回列表行（推荐位的图没了）',
    file: path.join(F.musicUiDir, 'RightPanel.tsx'),
    find: 'className="card-grid"',
    replace: 'className="music-list"',
    expect: ['UI.playlistCards'],
  },
  {
    name: '把今日精选的表头摘掉（用户要自己猜第二列是专辑还是歌手）',
    file: path.join(F.musicUiDir, 'RightPanel.tsx'),
    find: 'className="song-head"',
    replace: 'className="song-head-gone"',
    expect: ['UI.songTable'],
  },
  {
    name: '把播放条的毛玻璃摘掉（退回一张普通白卡）',
    file: F.musicScss,
    /* ⚠️ 锚点要连 `-webkit-backdrop-filter` 那行一起改：只改标准属性时，
       前缀那行仍带 blur(20px)，断言的 blur 检查照样满足 ⇒ 假反证（实测踩过）。 */
    find: '  backdrop-filter: blur(20px) saturate(1.3);\n  -webkit-backdrop-filter: blur(20px) saturate(1.3);',
    replace: '  backdrop-filter: none;\n  -webkit-backdrop-filter: none;',
    expect: ['UI.playerBarGlass'],
  },
  {
    name: '把榜单卡的排行改成写死的假数据（设计稿是演示数据，产品必须接真数据）',
    file: path.join(F.musicUiDir, 'Charts.tsx'),
    find: 'const rows = pl.preview ?? [];',
    replace: "const rows = [{ title: '示例歌名', artist: '示例歌手' }];",
    expect: ['UI.chartGrid'],
  },
  {
    name: '把节头的轻动作键换回带底色的 music-btn（节头比标题还重）',
    file: path.join(F.musicUiDir, 'Charts.tsx'),
    find: 'className="link-btn"',
    replace: 'className="music-btn out"',
    expect: ['UI.sectionLinkBtn'],
  },
  {
    name: '把 preview 条数从 5 改成 3（设计稿卡里是 5 行）',
    file: path.join(APP, 'src', 'modules', 'music', 'actions', 'right.ts'),
    find: 'const CHART_PREVIEW_N = 5;',
    replace: 'const CHART_PREVIEW_N = 3;',
    expect: ['UI.chartCardPreview'],
  },
  {
    name: '把首页的一节改回旧类名 music-sec（节间距 20 静默失效）',
    file: path.join(F.musicUiDir, 'Charts.tsx'),
    find: 'className="mc-section"',
    replace: 'className="music-sec"',
    expect: ['UI.sectionHeadClass'],
  },
  {
    name: '把节头改回 music-card-hd（与 .mc-section-head 两套叫法并存）',
    file: path.join(F.musicUiDir, 'RightPanel.tsx'),
    find: 'className="mc-section-head"',
    replace: 'className="music-card-hd"',
    expect: ['UI.sectionHeadClass'],
  },
  {
    name: '把搜索中改回光秃秃的「搜索中…」（不说搜的是哪个平台）',
    file: path.join(F.musicUiDir, 'RightPanel.tsx'),
    find: '<Empty sub="搜索结果会同时出现歌曲与专辑">正在搜索 {providerLabel(searchProvider)}…</Empty>',
    replace: '<Empty>搜索中…</Empty>',
    expect: ['SEARCH.inProgressCopy'],
  },
  {
    name: '把队列空态的 toast 摘掉（按播放键静默无反应，像按钮坏了）',
    file: F.musicActionsPlayback,
    find: "      get().toast('播放队列是空的', 'warning', '从首页或搜索里挑一首歌吧');",
    replace: '',
    expect: ['QUEUE.emptyToastCopy'],
  },
  {
    name: '把搜索源胶囊挪回视图壳（首页/榜单页也一直挂着它）',
    file: path.join(F.musicUiDir, 'RightPanel.tsx'),
    find: '        {searchActive ? <SearchResults /> : <Discover />}',
    replace: '        <SearchCaps />\n        {searchActive ? <SearchResults /> : <Discover />}',
    expect: ['UI.searchSourcesInResults'],
  },
  {
    name: '搜索结果里摘掉搜索源胶囊（用户搜完才发现选错平台，无法当场换）',
    file: path.join(F.musicUiDir, 'RightPanel.tsx'),
    /*
     * 破坏点：把**无结果**这条分支里的 `<SearchCaps />` 换成别的元素。
     *
     * ⚠️ 两类"看起来能用"的锚点都不成立，记下来免得下次再试：
     *   · `all: true` —— 本执行器不支持（只有单次 `txt.replace`）；
     *   · 改函数名（`SearchCaps` → `SearchCapsGone`、`SearchResults` → `SearchResultsGone`）——
     *     断言用的是 `indexOf('function SearchResults')` / `/<SearchCaps\s*\/>/`，
     *     改名后**前缀仍然命中**，等于没改。
     * 所以用一条只会命中一次、且会真的减少一处胶囊的锚点：无结果分支的第一行。
     */
    find: '        <SearchCaps />\n        <Empty sub="试试更短的关键词，或切换搜索源。">没有找到「{searchText}」</Empty>',
    replace: '        <Empty sub="试试更短的关键词，或切换搜索源。">没有找到「{searchText}」</Empty>',
    expect: ['UI.searchSourcesInResults'],
  },
  {
    name: '在视图里加回 .music-rightbody 包裹层（多一层，滚动与高度链要重算）',
    file: path.join(F.musicUiDir, 'RightPanel.tsx'),
    find: '        {searchActive ? <SearchResults /> : <Discover />}',
    replace: '        <div className="music-rightbody">{searchActive ? <SearchResults /> : <Discover />}</div>',
    expect: ['UI.noCenterWrapper'],
  },
  {
    name: '把左栏歌单列表的分组拆掉（退回"一条扁平行表"）',
    file: path.join(F.musicUiDir, 'LeftPanel.tsx'),
    find: 'className="ms-group"',
    replace: 'className="ms-flat"',
    expect: ['UI.sideGroups'],
  },
  {
    name: '把左栏组内空态换成通用 Empty（会占满高度，把组头挤走）',
    file: path.join(F.musicUiDir, 'LeftPanel.tsx'),
    find: 'className="ms-empty"',
    replace: 'className="ui-empty"',
    expect: ['UI.sideGroups'],
  },
  {
    name: '把歌单曲目列表的虚拟滚动摘掉（上千首会卡）',
    file: path.join(F.musicUiDir, 'LeftPanel.tsx'),
    find: '<VirtualList',
    replace: '<TrackList',
    expect: ['UI.leftTracksVirtual'],
  },
  {
    name: '把 QueueDrawer 的虚拟列表换回普通列表（模拟漏接某个长列表）',

    file: path.join(F.musicUiDir, 'QueueDrawer.tsx'),

    find: '<VirtualList',

    replace: '<QueueList',

    expect: ['UI.virtualListUsed'],
  },
  {
    name: '把 QueueDrawer 的时长又当成秒（duration * 1000，复现时间显示异常）',
    file: path.join(F.musicUiDir, 'QueueDrawer.tsx'),
    find: '{fmtTime(s.duration)}',
    replace: '{fmtTime(s.duration * 1000)}',
    expect: ['DUR.msContract'],
  },
  {
    name: '把 music_search 的 offset 参数摘掉（搜索退回不可分页）',
    file: F.rustMod,
    find: 'pub async fn music_search(keywords: String, limit: Option<u32>, offset: Option<u32>)',
    replace: 'pub async fn music_search(keywords: String, limit: Option<u32>)',
    expect: ['SEARCH.rustOffset'],
  },
  {
    name: '把 store 的 loadMoreSearch 改名（模拟漏实现续拉）',
    file: path.join(F.actionsDir, 'search.ts'),
    find: '  loadMoreSearch: async (',
    replace: '  loadMoreSearchDisabled: async (',
    expect: ['SEARCH.storePaging'],
  },
  {
    name: '把 RightPanel 搜索结果的分页接线拆掉',
    file: path.join(F.musicUiDir, 'RightPanel.tsx'),
    find: 'const loadMore = useMusicStore((s) => s.loadMoreSearch);',
    replace: 'const loadMore = () => {};',
    expect: ['SEARCH.uiWire'],
  },
  {
    name: '把播放条改成恒显（队列为空也显示）',
    file: F.musicScreen,
    find: 'hidden={queueLength === 0}',
    replace: 'hidden={false}',
    expect: ['UI.playerBarRule'],
  },

  // ── PLAYER · A 播放内核常驻 ────────────────────────────────────────────
  {
    name: '把 MusicKernel.tsx 里的 <audio> 元素删掉（模拟内核搬走/未实现）',
    file: F.kernel,
    // 锚点带上后续属性行：文件注释里也出现过 `<audio>`，只写 `<audio` 会 replace 到注释上（改了没生效）
    find: '    <audio\n      ref={audioRef}',
    replace: '    <audioGone\n      ref={audioRef}',
    expect: ['PLAYER.kernelExists'],
  },
  {
    name: '把 App.tsx 里的 <MusicKernel /> 删掉（实现了但没挂）',
    file: F.app,
    find: '      <MusicKernel />\n',
    replace: '',
    expect: ['PLAYER.kernelAtRoot'],
  },
  {
    name: '把 <audio> 挪回 screens/MusicScreen.tsx',
    file: F.musicScreen,
    find: '    <div className="music">',
    replace: '    <audio />\n    <div className="music">',
    expect: ['PLAYER.audioLeftScreen'],
  },
  {
    name: '把 store.ts 的 registerAudioElement 改名（模拟内核拿不到登记通道）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: 'export function registerAudioElement(el: HTMLAudioElement | null): void {',
    replace: 'export function registerAudioElementGone(el: HTMLAudioElement | null): void {',
    expect: ['PLAYER.registerApi'],
  },
  {
    name: '把 MusicKernel 挂载时的 registerAudioElement 调用去掉',
    file: F.kernel,
    find: '    registerAudioElement(audioRef.current);',
    replace: '    /* [refute] 未登记 audio 元素 */',
    expect: ['PLAYER.kernelRegisters'],
  },
  {
    name: '把 seek 里的 audioEl.currentTime 那行删掉（退回"只改进度不动音频"）',
    file: path.join(F.actionsDir, 'playback.ts'),
    // 锚点不含变量名：`currentTime = ms / 1000` 是全局唯一片段，变量改名也不会让这条静默失效
    find: 'currentTime = ms / 1000',
    replace: 'currentTimeMoved = ms / 1000',
    expect: ['PLAYER.seekMovesAudio'],
  },
  {
    name: '把 audioEl 塞进 zustand state（DOM 引用进了 state）',
    file: F.store,
    find: '  currentBitrate: 0,\n',
    replace: '  currentBitrate: 0,\n  audioEl: null,\n',
    expect: ['PLAYER.audioElNotInState'],
  },

  // ── PLAYER · B 展开动画 + 点歌自动展开 ────────────────────────────────
  {
    name: '把 @keyframes music-exp-down 改名（退场动画关键帧丢失）',
    file: F.musicScss,
    find: '@keyframes music-exp-down {',
    replace: '@keyframes music-exp-gone {',
    expect: ['PLAYER.animKeyframes'],
  },
  {
    name: '把 .music-exp 的进场动画那行删掉',
    file: F.musicScss,
    // 锚点随 2026-10-12 的改版更新：进场动画不再独占一行，而是与动态背景流动
    // 写在同一个 animation 列表里（分开写会让动态开关重播进场动画 ⇒ 整屏闪一下）。
    find: 'music-exp-up 0.34s cubic-bezier(0.4, 0, 0.2, 1) 1 both,',
    replace: '',
    expect: ['PLAYER.animEnter'],
  },
  {
    name: '把 .is-closing 的退场动画指向 music-exp-up（不再下播）',
    file: F.musicScss,
    find: 'animation: music-exp-down 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards;',
    replace: 'animation: music-exp-up 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards;',
    expect: ['PLAYER.animClosing'],
  },
  {
    name: '把 CSS 里 .is-closing 的 0.3s 改成 0.5s（退场时长两处不一致）',
    file: F.musicScss,
    find: 'animation: music-exp-down 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards;',
    replace: 'animation: music-exp-down 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards;',
    expect: ['PLAYER.durationSync'],
  },
  {
    name: '把 next() 里 { expand: false } 删掉（自动切歌会弹开播放器）',
    file: path.join(F.actionsDir, 'playback.ts'),
    // 破坏必须**清掉全部** playSong 的 expand:false —— 断言判的是"每条路径都传了"，
    // 只删一处它仍为真（这个假阳性是反证轮实测抓出来的，不是推理出来的）
    find: '    void get().playSong(queue[idx], undefined, { expand: false });',
    replace: '    void get().playSong(queue[idx], undefined);',
    expect: ['PLAYER.nextExpandFalse'],
  },
  {
    name: '把 prev() 里 { expand: false } 删掉',
    file: path.join(F.actionsDir, 'playback.ts'),
    // 锚点随 2026-10-12 的五档改版更新：prev 现在按模式分流，线性分支收在 else 里
    find: '      idx = (currentIndex - 1 + queue.length) % queue.length;\n    }\n    void get().playSong(queue[idx], undefined, { expand: false });',
    replace:
      '      idx = (currentIndex - 1 + queue.length) % queue.length;\n    }\n    void get().playSong(queue[idx], undefined);',
    expect: ['PLAYER.prevExpandFalse'],
  },
  {
    name: '把 playSong 的 opts?.expand 判定去掉（永远展开）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '      ...(opts?.expand === false ? {} : { expanded: true }),',
    replace: '      expanded: true,',
    expect: ['PLAYER.playSongExpandOpt'],
  },
  {
    name: '把 ExpandedPlayer 的收起按钮改回 setExpanded(false)',
    file: F.expanded,
    find: 'onClick={() => closeExpanded()}',
    replace: 'onClick={() => setExpanded(false)}',
    expect: ['PLAYER.closePath'],
  },
  {
    name: '把 App 根的 Esc 分支改回 setExpanded(false)',
    file: F.app,
    find: "if (e.key === 'Escape') closeMusicExpanded();",
    replace: "if (e.key === 'Escape') setMusicExpanded(false);",
    expect: ['PLAYER.escPath'],
  },
  {
    name: '让 MusicScreen 也监听 closeExpanded（两处重复触发退场动画）',
    file: F.musicScreen,
    find: "      if (e.key === 'Escape') {\n        setQueueOpen(false);",
    replace: "      if (e.key === 'Escape') {\n        closeExpanded();\n        setQueueOpen(false);",
    expect: ['PLAYER.escPath'],
  },
  {
    name: '把 <ExpandedPlayer> 挪回 MusicScreen 内（从设置页点「打开播放器」就没反应）',
    file: F.app,
    find: '      <ExpandedPlayer onSeek={onMusicSeek} />\n',
    replace: '',
    expect: ['PLAYER.expandedMountedAtRoot'],
  },

  // ── PLAYER · C 播放条补全 ─────────────────────────────────────────────
  {
    name: '把 PlayerBar 的静音按钮接线拆掉',
    file: F.playerBar,
    find: 'onClick={() => toggleMute()}',
    replace: 'onClick={() => undefined}',
    expect: ['PLAYER.bar.mute'],
  },
  {
    name: '把 PlayerBar 的 onWheel 那行删掉（滚轮调音量失效）',
    file: F.playerBar,
    find: '          onWheel={(e) => stepVolume(e.deltaY < 0 ? 0.05 : -0.05)}\n',
    replace: '',
    expect: ['PLAYER.bar.wheelVolume'],
  },
  {
    name: '把 PlayerBar 音质下拉的选项清空（QUALITY_OPTIONS 丢失）',
    file: F.playerBar,
    find: 'options={QUALITY_OPTIONS}',
    replace: 'options={[]}',
    expect: ['PLAYER.bar.qualitySelect'],
  },
  {
    name: '把 PlayerBar 的 music-br 码率块类名改掉（实际音质显示丢失）',
    file: F.playerBar,
    find: 'className="music-br"',
    replace: 'className="music-br-removed"',
    expect: ['PLAYER.bar.bitrate'],
  },
  {
    name: '把 PlayerBar 的关闭播放按钮接线拆掉',
    file: F.playerBar,
    find: 'onClick={() => closePlayback()}',
    replace: 'onClick={() => undefined}',
    expect: ['PLAYER.bar.closePlayback'],
  },
  {
    name: '把 PlayerBar 的 onChange 改回 onSeek(...)（退回逐帧提交）',
    file: F.playerBar,
    find: 'onChange={(e) => setDragMs(Number(e.target.value))}',
    replace: 'onChange={(e) => onSeek(Number(e.target.value))}',
    expect: ['PLAYER.bar.dragSession'],
  },
  {
    name: '把 PlayerBar 的提交改回松手即 seek（去掉 0.1s 静默期）',
    file: F.playerBar,
    find: `  const commit = () => {
    if (dragMs === null) return;
    const target = dragMs;
    if (seekCommitTimer.current !== null) clearTimeout(seekCommitTimer.current);
    seekCommitTimer.current = setTimeout(() => {
      seekCommitTimer.current = null;
      // 这 0.1s 里用户又拖过了 ⇒ 旧目标作废，等下一次松手重新提交
      if (latestDragMsRef.current !== target) return;
      onSeek(target);
      setDragMs(null);
    }, SEEK_COMMIT_DELAY_MS);
  };`,
    replace: `  const commit = () => {
    if (dragMs === null) return;
    onSeek(dragMs);
    setDragMs(null);
  };`,
    expect: ['PLAYER.bar.dragSession'],
  },
  {
    name: '把 ExpandedPlayer 的 onChange 改回 onSeek(...)（退回逐帧提交）',
    file: F.expanded,
    find: 'onChange={(e) => setDragMs(Number(e.target.value))}',
    replace: 'onChange={(e) => onSeek(Number(e.target.value))}',
    expect: ['PLAYER.exp.dragSession'],
  },
  {
    name: '把 ExpandedPlayer 的提交改回松手即 seek（去掉 0.1s 静默期）',
    file: F.expanded,
    find: `  const commitSeek = () => {
    if (dragMs === null) return;
    const target = dragMs;
    if (seekCommitTimer.current !== null) clearTimeout(seekCommitTimer.current);
    seekCommitTimer.current = setTimeout(() => {
      seekCommitTimer.current = null;
      // 这 0.1s 里用户又拖过了 ⇒ 旧目标作废，等下一次松手重新提交
      if (latestDragMsRef.current !== target) return;
      onSeek(target);
      setDragMs(null);
    }, SEEK_COMMIT_DELAY_MS);
  };`,
    replace: `  const commitSeek = () => {
    if (dragMs === null) return;
    onSeek(dragMs);
    setDragMs(null);
  };`,
    expect: ['PLAYER.exp.dragSession'],
  },

  // ── PLAYER · D 实际音质回写 ───────────────────────────────────────────
  {
    name: '把 resolveOnlineUrl 里 currentBitrate 的写入删掉（音质标签变假 UI）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '    currentBitrate: r.br || 0,\n',
    replace: '',
    expect: ['PLAYER.resolveWrites'],
  },

  // ── HEARTBEAT 心动模式（五档改版）────────────────────────────────────
  {
    name: "把 types.ts 的 PlayMode 去掉 'order'（顺序播放从类型层消失）",
    file: F.types,
    find: "export type PlayMode = 'list' | 'one' | 'shuffle' | 'order' | 'heartbeat';",
    replace: "export type PlayMode = 'list' | 'one' | 'shuffle' | 'heartbeat';",
    expect: ['HEARTBEAT.modeInType'],
  },
  {
    name: '把 cycleMode 的档位数组退回四档（去掉顺序播放）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: "    const order: PlayMode[] = ['list', 'one', 'shuffle', 'order', 'heartbeat'];",
    replace: "    const order: PlayMode[] = ['list', 'one', 'shuffle', 'heartbeat'];",
    expect: ['HEARTBEAT.cycleFive'],
  },
  {
    name: '把档位数组的两个档位对调（点一下会跳档）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: "    const order: PlayMode[] = ['list', 'one', 'shuffle', 'order', 'heartbeat'];",
    replace: "    const order: PlayMode[] = ['list', 'one', 'order', 'shuffle', 'heartbeat'];",
    expect: ['HEARTBEAT.cycleFive'],
  },
  {
    name: '把默认播放模式从顺序播放改回列表循环',
    file: F.store,
    find: "  playMode: 'order',",
    replace: "  playMode: 'list',",
    expect: ['HEARTBEAT.defaultIsOrder'],
  },
  {
    name: 'canUseHeartbeat 硬编码平台名（不再走平台能力函数）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '  return platform.supportsSimilar(state.playbackSource) && state.queueFromLiked;',
    replace: "  return state.playbackSource === 'netease' && state.queueFromLiked;",
    expect: ['HEARTBEAT.gatedByLikedAndPlatform'],
  },
  {
    name: 'canUseHeartbeat 丢掉「我喜欢的音乐」上下文（任何队列都能进心动）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '  return platform.supportsSimilar(state.playbackSource) && state.queueFromLiked;',
    replace: '  return platform.supportsSimilar(state.playbackSource);',
    expect: ['HEARTBEAT.gatedByLikedAndPlatform'],
  },
  {
    name: '把 supportsSimilar 对酷狗也放开（酷狗无"按 songid 找相似"接口）',
    file: F.platform,
    find: "export function supportsSimilar(provider: MusicProvider): boolean {\n  return provider === 'netease';\n}",
    replace:
      "export function supportsSimilar(provider: MusicProvider): boolean {\n  return provider === 'netease' || provider === 'kugou';\n}",
    expect: ['HEARTBEAT.gatedByLikedAndPlatform'],
  },
  {
    name: 'cycleMode 不再跳过不可用的心动档（会落在一个用不了的档上）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: "      if (cand === 'heartbeat' && !canUseHeartbeat(get())) continue;",
    replace: '      if (false) continue;',
    expect: ['HEARTBEAT.noRandomDegrade'],
  },
  {
    name: 'setPlayMode 去掉心动可用性的兜底闸（可绕过 cycleMode 直接落档）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '      if (!canUseHeartbeat(get())) return;',
    replace: '      if (false) return;',
    expect: ['HEARTBEAT.noRandomDegrade'],
  },
  {
    name: '不可用时又弹回"心动模式仅在网易云…可用"的提示（需求已改为不显示按钮即可）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '      if (!canUseHeartbeat(get())) return;',
    replace: "      if (!canUseHeartbeat(get())) { get().toast('心动模式不可用'); return; }",
    expect: ['HEARTBEAT.noRandomDegrade'],
  },
  {
    name: '模式按钮不再按可用性隐藏心动档（非喜欢歌单时照常显示心跳图标）',
    file: F.playModeButton,
    find: "    mode === 'heartbeat' && !heartbeatAvailable",
    replace: "    false && mode === 'heartbeat' && !heartbeatAvailable",
    expect: ['HEARTBEAT.noRandomDegrade'],
  },
  {
    name: '播放条漏传 heartbeatAvailable（非喜欢歌单时模式按钮仍显示心动档）',
    file: F.playerBar,
    find: 'heartbeatAvailable={heartbeatAvailable}',
    replace: 'heartbeatAvailable={true}',
    expect: ['HEARTBEAT.noRandomDegrade'],
  },
  {
    name: '展开播放器漏传 heartbeatAvailable（两处显示不一致）',
    file: F.expanded,
    find: '              heartbeatAvailable={heartbeatAvailable}',
    replace: '              heartbeatAvailable={true}',
    expect: ['HEARTBEAT.noRandomDegrade'],
  },
  {
    name: '冷启动不再挡下偏好里的 heartbeat（会出现"显示心动却点不动"）',
    file: path.join(F.actionsDir, 'init.ts'),
    find: "      ALL_MODES.includes(prefs.playMode as PlayMode) && prefs.playMode !== 'heartbeat'",
    replace: '      ALL_MODES.includes(prefs.playMode as PlayMode)',
    expect: ['HEARTBEAT.noRandomDegrade'],
  },
  {
    name: '心动队列不分首次/再次（首次进入也把种子歌摆在队首却播新列表第一首）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '    const nextQueue = already ? [seed, ...pick] : pick;',
    replace: '    const nextQueue = [seed, ...pick];',
    expect: ['HEARTBEAT.enterRebuildsQueue'],
  },
  {
    name: '心动队列丢掉当前歌（currentIndex 与 currentSong 会对不上）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '    const nextQueue = already ? [seed, ...pick] : pick;',
    replace: '    const nextQueue = [...pick];',
    expect: ['HEARTBEAT.enterRebuildsQueue'],
  },
  {
    name: '首次进入播种子歌而不是心动列表第一首（需求要求直接播新列表第一首）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '    await get().playSong(nextQueue[0], nextQueue, { autoplay: true, expand: false });',
    replace: '    await get().playSong(seed, nextQueue, { autoplay: true, expand: false });',
    expect: ['HEARTBEAT.enterRebuildsQueue'],
  },
  {
    name: 'enterHeartbeat 不再区分首次/再次进入（每次切回来都把当前歌从头重播）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '    const already = get().heartbeatSeeded;',
    replace: '    const already = false;',
    expect: ['HEARTBEAT.enterRebuildsQueue'],
  },
  {
    name: '心动模式自然播完时无条件换一批（不前进 ⇒ 播完的歌原地重播、卡在首曲）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '        if (currentIndex + 1 < queue.length) {',
    replace: '        if (false) {',
    expect: ['HEARTBEAT.nextAdvances'],
  },
  {
    name: 'advance 路径不按首次/再次取起点（首次进入会跳过新列表真正的第一首）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '      const startAt = already ? 1 : 0;',
    replace: '      const startAt = 1;',
    expect: ['HEARTBEAT.nextAdvances'],
  },
  {
    name: '进入心动前不存原队列快照（切走时恢复不出原播放列表）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '        heartbeatRestore: {',
    replace: '        heartbeatSnapshotDisabled: {',
    expect: ['HEARTBEAT.restoresQueueOnLeave'],
  },
  {
    name: '切离心动时不恢复原队列（列表一直停在相似歌上）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: "    if (get().playMode === 'heartbeat' && get().heartbeatRestore) {",
    replace: '    if (false) {',
    expect: ['HEARTBEAT.restoresQueueOnLeave'],
  },
  {
    name: '恢复原队列时复位 heartbeatSeeded（再进心动会把当前歌从头重播）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '        queueFromLiked: snap.queueFromLiked,',
    replace: '        queueFromLiked: snap.queueFromLiked, heartbeatSeeded: false,',
    expect: ['HEARTBEAT.restoresQueueOnLeave'],
  },
  {
    name: '切离心动时不把"不在原列表里的当前歌"置顶（会悄悄换成另一首）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: 'cur && found < 0 ? [cur, ...snap.queue] : snap.queue;',
    replace: 'snap.queue;',
    expect: ['HEARTBEAT.restoresQueueOnLeave'],
  },
  {
    name: '抽屉副标题不写模式（心动模式下与左栏歌单对不上且无提示）',
    file: F.queueDrawer,
    find: 'subtitle={`${queue.length} 首 · ${playModeLabel(playMode)}`}',
    replace: 'subtitle={`${queue.length} 首`}',
    expect: ['QUEUE.heartbeatTitle'],
  },

  // ── PLAYLIST 播放列表入口 ────────────────────────────────────────────
  {
    name: '播放全部恒定从第一首起（随机档退化成顺序播）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: 'Math.floor(Math.random() * songs.length)',
    replace: '0',
    expect: ['PLAYLIST.startIndexByMode'],
  },
  {
    name: '播放全部时忽略用户点的具体某一首（模式改写精确意图）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '      opts?.index != null',
    replace: '      false',
    expect: ['PLAYLIST.startIndexByMode'],
  },
  {
    name: '本地曲库退回 playQueue（不再是独立播放列表）',
    file: F.localView,
    find: 'void playPlaylist(localQueue, { index: i });',
    replace: 'void playQueue(localQueue, i);',
    expect: ['PLAYLIST.rowsGoThroughPlaylist'],
  },
  {
    name: '播放历史退回"只播点中那一首"（不再是独立播放列表）',
    file: F.historyView,
    find: 'void playPlaylist(historyQueue, { index: i, fromHistory: true });',
    replace: 'void playQueue(historyQueue, i);',
    expect: ['PLAYLIST.rowsGoThroughPlaylist'],
  },
  {
    name: '切歌单时不把心动模式切成顺序播放',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: "    if (get().playMode === 'heartbeat') {\n      set({ playMode: 'order' });",
    replace: "    if (false) {\n      set({ playMode: 'order' });",
    expect: ['PLAYLIST.leavesHeartbeatToOrder'],
  },
  {
    name: '切进「我喜欢的音乐」时不自动恢复心动模式',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '    if (liked && get().likedHeartbeatOn) {',
    replace: '    if (false) {',
    expect: ['PLAYLIST.likedAutoHeartbeat'],
  },
  {
    name: '拉歌单时不打「我喜欢的音乐」标识（isLiked 永远为假）',
    file: path.join(F.actionsDir, 'left.ts'),
    // 锚点随 2026-10-12 的规则变更更新：识别口径从"下标 0"改为
    // "第一个 subscribed===false 的歌单"。这里把 findIndex 打成 -1 ⇒ 一条都不打标。
    find: '      const likedIdx = list.findIndex((pl) => pl.subscribed === false);',
    replace: '      const likedIdx = -1;',
    expect: ['PLAYLIST.likedAutoHeartbeat'],
  },
  {
    name: '不把「我喜欢的音乐」改名（界面仍显示接口原名，各平台叫法不一）',
    file: path.join(F.actionsDir, 'left.ts'),
    find: 'i === likedIdx ? { ...pl, name: LIKED_PLAYLIST_NAME, isLiked: true } : pl',
    replace: 'i === likedIdx ? { ...pl, isLiked: true } : pl',
    expect: ['PLAYLIST.likedAutoHeartbeat'],
  },
  {
    name: 'likedHeartbeatOn 不落偏好（重启就丢"开启过心动"这件事）',
    file: path.join(APP, 'src', 'modules', 'music', 'prefs.ts'),
    find: '  likedHeartbeatOn: boolean;',
    replace: '  likedHeartbeatOnRemoved?: boolean;',
    expect: ['PLAYLIST.likedAutoHeartbeat'],
  },

  // ── QUEUE 播放列表抽屉（当前曲常驻顶部 + 从右滑入）──────────────────
  {
    name: '队列抽屉不再把「正在播放」段固定在顶部（当前曲被混进滚动列表）',
    file: F.queueDrawer,
    find: '<p className="qd-caption">正在播放</p>',
    replace: '<p className="qd-caption">队列</p>',
    expect: ['QUEUE.scrollsToCurrent'],
  },
  {
    name: '「接下来」段从队首切起（把正在播的那首也算进接下来）',
    file: F.queueDrawer,
    find: 'queue.slice(currentIndex + 1)',
    replace: 'queue.slice(0)',
    expect: ['QUEUE.scrollsToCurrent'],
  },
  {
    name: '抽屉进场动画删掉（不再从右往左展开）',
    file: F.componentsScss,
    find: '  animation: ui-drawer-in var(--miao-dur-base) var(--miao-ease-out);',
    replace: '',
    expect: ['QUEUE.drawerSlidesIn'],
  },
  {
    name: '抽屉进场起点改成从下方（不再是"从右往左"）',
    file: F.componentsScss,
    find: '    transform: translateX(24px);',
    replace: '    transform: translateY(24px);',
    expect: ['QUEUE.drawerSlidesIn'],
  },
  {
    name: '让蒙层也跟着抽屉平移（整屏遮罩横移会露出底下界面）',
    file: F.componentsScss,
    find: '  animation: miao-fade-in var(--miao-dur-fast) var(--miao-ease-out);',
    replace: '  transform: translateX(24px);\n  animation: miao-fade-in var(--miao-dur-fast) var(--miao-ease-out);',
    expect: ['QUEUE.drawerSlidesIn'],
  },

  // ── LYRICS 桌面歌词 ──────────────────────────────────────────────────
  {
    name: '从 commands/mod.rs 摘掉 lyrics_push 注册（定义仍在但调不到）',
    file: F.rustRegistry,
    find: '        crate::commands::lyrics_window::lyrics_push,',
    replace: '',
    expect: ['LYRICS.rustCommands'],
  },
  {
    name: '歌词窗改用 WebviewUrl::External（跨 origin → 读不到偏好）',
    file: F.rustLyrics,
    find: 'WebviewUrl::App("templates/lyrics.html".into())',
    replace: 'WebviewUrl::External("https://example.com/lyrics.html".parse().unwrap())',
    expect: ['LYRICS.sameOrigin'],
  },
  {
    name: '从 capabilities 的 windows 里删掉 desktop-lyrics（ACL 会拒该窗口所有命令）',
    file: F.capabilities,
    find: '"windows": ["main", "desktop-lyrics"]',
    replace: '"windows": ["main"]',
    expect: ['LYRICS.capabilityWindow'],
  },
  {
    name: '从 capabilities 里删掉 allow-start-dragging（拖动会被拒）',
    file: F.capabilities,
    find: '    "core:window:allow-start-dragging",\n',
    replace: '',
    expect: ['LYRICS.dragPermission'],
  },
  {
    name: '把 vite 的第二入口 lyrics 删掉（dist 里将没有 lyrics.html）',
    file: F.viteConfig,
    find: "lyrics: new URL('./templates/lyrics.html', import.meta.url).pathname,",
    replace: '',
    expect: ['LYRICS.viteMultiEntry'],
  },
  {
    // 这条模拟的是最容易发生的真实事故：有人为了让歌词"跟得更准"就顺手加一次推送
    name: '在 setProgress 里加一次桌面歌词推送（每秒数次 → 打满事件通道）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '  setProgress: (ms) => set({ progressMs: ms }),',
    replace: '  setProgress: (ms) => { set({ progressMs: ms }); void get().pushLyricsState(); },',
    expect: ['LYRICS.progressNotPushed'],
  },
  {
    name: '歌词窗用 setInterval 推进进度（后台被节流到 ~1Hz → 歌词一跳一跳）',
    file: F.desktopLyrics,
    // ⚠️ 反证的 replace 只替**第一处**（String.replace 的语义），锚点必须落在**多处**里
    // 仍能触发红的那一类上。这里替掉两处 rAF 调用（含 `cancelAnimationFrame` 侧的清理），
    // 换成 setInterval 形态 —— 断言的反向判据（不得出现 setInterval）会如期变红。
    find: '      raf = requestAnimationFrame(tick);\n',
    replace: '      raf = setInterval(tick, 100) as unknown as number;\n',
    expect: ['LYRICS.rafAdvance'],
  },
  {
    name: '歌词窗用 window.close() 关闭（绕过主窗状态 → 开关与实际不符）',
    file: F.desktopLyrics,
    find: "invoke('close_lyrics_window')",
    replace: "window.close(); void invoke('noop_close')",
    expect: ['LYRICS.closeViaRust'],
  },
  {
    // 这条反证模拟的**正是本轮真实发生的缺陷**：我改了 Rust 的字段口径（offset_y → y），
    // 漏改前端 → serde 反序列化失败 → 命令静默失效。tsc/vite/cargo 全都测不到。
    name: '把前端 WindowState 的字段名改回 offset_y（与 Rust 的 y 对不上）',
    file: F.desktopLyrics,
    // ⚠️ 锚点必须跟着实现走：persist 改为「部分更新」后，字段来源从 `next.y` 变成了 `known.y`。
    // 锚点一旦漂移，这条反证会退化成「锚点未找到 / 跳过」—— 跳过 ≠ 通过。
    find: '        y: known.y,',
    replace: '        offset_y: known.y,',
    expect: ['LYRICS.stateFieldMatch'],
  },
  {
    // 模拟 D-53 缺陷 ②：关掉 assetProtocol → 本地歌曲静默播不了
    name: '把 assetProtocol 的 enable 关掉（本地歌曲 asset:// 会被拒）',
    file: F.tauriConf,
    find: '        "enable": true,\n',
    replace: '        "enable": false,\n',
    expect: ['LYRICS.assetProtocol'],
  },
  {
    // 模拟 D-53 缺陷 ② 的**另一半**：conf 配了但 Cargo feature 没开 →
    // asset 协议根本不注册，`enable: true` 被静默忽略（这一处比 conf 更隐蔽）
    name: '从 Cargo.toml 摘掉 protocol-asset feature（协议不注册，conf 被忽略）',
    file: F.cargoToml,
    find: 'tauri = { version = "2", features = ["protocol-asset", "tray-icon"] }',
    replace: 'tauri = { version = "2", features = ["tray-icon"] }',
    expect: ['LYRICS.assetProtocol'],
  },
  {
    // 模拟 D-53 缺陷 ①：去掉物理→逻辑换算 → 窗口落到屏幕外
    name: '在坐标换算里去掉 scale_factor（物理像素当逻辑像素用）',
    file: F.rustLyrics,
    find: '            let scale = m.scale_factor();',
    replace: '            let scale = 1.0;',
    expect: ['LYRICS.coordUnit'],
  },
  {
    name: '把统一换算函数 monitor_logical_size 改掉（换算散落多处）',
    file: F.rustLyrics,
    find: 'fn monitor_logical_size(app: &AppHandle) -> (f64, f64) {',
    replace: 'fn ad_hoc_screen_size(app: &AppHandle) -> (f64, f64) {',
    expect: ['LYRICS.coordUnit'],
  },
  {
    // 模拟"设置改了不生效"：Rust 有命令但前端没调
    name: '从桌面歌词窗摘掉 resize_lyrics_window 调用（改行数不生效）',
    file: F.desktopLyrics,
    find: "    void invoke('resize_lyrics_window', {",
    replace: "    void invoke('noop_resize_disabled', {",
    expect: ['LYRICS.windowAutoHeight'],
  },
  {
    // 模拟"变高后往屏幕下方溢出"：只改尺寸不调位置
    name: '从 resize_lyrics_window 里去掉 set_position（变高会溢出屏幕下方）',
    file: F.rustLyrics,
    find: '        let _ = w.set_position(tauri::LogicalPosition::new(x, new_y));',
    replace: '        let _ = (x, new_y);',
    expect: ['LYRICS.windowAutoHeight'],
  },
  {
    name: '去掉 <audio> 的 crossOrigin（网络歌曲被音频图接管后静音）',
    file: 'src/components/MusicKernel.tsx',
    find: "      crossOrigin={corsMode ? 'anonymous' : undefined}",
    replace: '      crossOrigin={undefined}',
    expect: ['AUDIO.corsMode'],
  },
  {
    name: '去掉 CORS 回退里的 markNotWirable 标记（回退后在非 CORS 下被接管 → 静音）',
    file: 'src/components/MusicKernel.tsx',
    find: '          markNotWirable(a);',
    replace: '          void a;',
    expect: ['AUDIO.fallback'],
  },
  {
    name: '让 isWirable 不再检查 CORS 模式（非 CORS 元素也会被接管）',
    file: 'src/modules/music/audioGraph.ts',
    find: "  return el.crossOrigin === 'anonymous';",
    replace: '  return true;',
    expect: ['AUDIO.refuseNonCors'],
  },
  {
    name: '去掉 gain → destination 的连接（接管即静音）',
    file: 'src/modules/music/audioGraph.ts',
    find: '      gain.connect(ctx.destination); // 唯一出口：不接回 destination = 静音',
    replace: '      void gain; // 反证：不接回出口',
    expect: ['AUDIO.connectDestination'],
  },
  {
    name: '在灵动岛里再建一次音频图（第二个调用方会抛 InvalidStateError）',
    file: 'src/components/DynamicIsland.tsx',
    find: '      const got = await attachAnalyser(findAudioElement());',
    replace:
      '      const got = await attachAnalyser(findAudioElement());\n      const __probe = (window as unknown as { createMediaElementSource?: unknown })\n        .createMediaElementSource;\n      void __probe;',
    expect: ['AUDIO.singleEntry'],
  },
  {
    name: 'Rust 不再把载荷写入缓存（歌词窗补拉永远拿到空 → 打开还是没歌词）',
    file: 'src-tauri/src/commands/lyrics_window.rs',
    find: '        *g = Some(payload.clone());',
    replace: '        let _ = &mut g;',
    expect: ['LYRICS.stateBackfill'],
  },
  {
    name: '歌词窗去掉挂载后的补拉（回到"暂停再播放才显示"）',
    file: 'src/screens/lyrics/DesktopLyrics.tsx',
    find: "        const cached = await invoke<LyricsPayload | LyricsPrefsPayload | null>('get_lyrics_state');",
    replace: '        const cached = null as LyricsPayload | LyricsPrefsPayload | null;',
    expect: ['LYRICS.stateBackfill'],
  },
  {
    name: 'commands/mod.rs 不注册 lyrics_control（调用报"命令不存在"，被 catch 吞掉）',
    file: 'src-tauri/src/commands/mod.rs',
    find: '        crate::commands::lyrics_window::lyrics_control,\n',
    replace: '',
    expect: ['LYRICS.controlBridge'],
  },
  {
    name: '主窗不处理 next 动作（该按钮点了没反应）',
    file: 'src/components/MusicKernel.tsx',
    find: "            case 'next':\n              s.next();\n              break;",
    replace: "            case 'unused-next':\n              break;",
    expect: ['LYRICS.controlBridge'],
  },
  {
    name: 'cycle-mode 后不补推状态（歌词窗模式图标滞后，像点了没反应）',
    file: 'src/components/MusicKernel.tsx',
    find: '              void s.pushLyricsState();',
    replace: '              void 0;',
    expect: ['LYRICS.modeIconSync'],
  },
  {
    name: 'store 推送时不带 playMode（歌词窗永远显示默认模式）',
    file: path.join(F.actionsDir, 'desktop.ts'),
    find: '      // 播放模式要跟着走：歌词窗的控制栏靠它显示正确的模式图标（两窗 store 互不可见）\n      playMode,',
    replace: '      // 反证：不带 playMode',
    expect: ['LYRICS.playModeContract'],
  },

  // ── LYRICS 逐字歌词（卡拉OK）────────────────────────────────────────
  {
    name: '把 parseYrc 改名（模拟"定义了但没接进来"）',
    file: F.lyrics,
    find: 'export function parseYrc(yrc: string): ParsedLyricLine[] {',
    replace: 'export function parseYrcDisabled(yrc: string): ParsedLyricLine[] {',
    expect: ['LYRICS.parseYrcUsed'],
  },
  {
    // 模拟"只留定义、删掉调用"—— 这是「只查标识符存在」型断言最经典的漏网方式
    name: 'loadLyrics 不再调用 parseYrc（只走 LRC，逐字高亮静默失效）',
    file: path.join(F.actionsDir, 'lyrics.ts'),
    find: "        lines = l.yrc ? parseYrc(l.yrc) : parseLrc(l.lyric || '');\n",
    replace: "        lines = parseLrc(l.lyric || '');\n",
    expect: ['LYRICS.parseYrcUsed'],
  },
  {
    // 本任务最关键的反证：破坏「无 yrc 时的行级插值」—— 绝大多数歌走的就是这条路
    name: 'finalizeLineDurations 去掉 [0.45, 12] 夹紧（退化路径失去边界保护）',
    file: F.lyrics,
    find: '    lines[i].duration = Math.max(0.45, Math.min(12, lines[i].duration as number));\n',
    replace: '    lines[i].duration = lines[i].duration as number;\n',
    expect: ['LYRICS.lineInterpolation'],
  },
  {
    name: 'parseLrc 不再补 duration（LRC 退化路径断头 → 无 yrc 的歌没有推进跨度）',
    file: F.lyrics,
    find: '  // ⚠️ LRC **只有行级时间**，没有逐字数据 —— 必须在这里补出行持续时长，\n  // 否则「无 yrc 的歌」在渲染层没有可插值的跨度，逐字推进会整体失效。\n  return finalizeLineDurations(lines);',
    replace: '  return lines;',
    expect: ['LYRICS.lineInterpolation'],
  },
  {
    name: '渲染层去掉顶层高亮元素（kara-over → 双层退化为单层，无逐字效果）',
    file: F.karaoke,
    find: 'className="kara-over"',
    replace: 'className="kara-over-disabled"',
    expect: ['LYRICS.karaRender'],
  },
  {
    name: '渲染层去掉 mask 渐变（顶层裁切边变成硬线）',
    file: F.karaoke,
    find: 'style={{ maskImage: maskGradient, WebkitMaskImage: maskGradient }}',
    replace: 'style={{}}',
    expect: ['LYRICS.karaRender'],
  },
  {
    name: '渲染层用 setInterval 代替 RAF（后台被节流 → 推进一跳一跳）',
    file: F.karaoke,
    find: '    raf = requestAnimationFrame(tick);\n    return () => cancelAnimationFrame(raf);',
    replace: '    raf = setInterval(tick, 100) as unknown as number;\n    return () => clearInterval(raf);',
    expect: ['LYRICS.karaRender'],
  },
  {
    name: '渲染层不再读音频真实时间（拿不到平滑时间 → 只能靠 4Hz progressMs 一跳一跳）',
    file: F.karaoke,
    find: '      const el = findAudioElement();',
    replace: '      const el = null as HTMLAudioElement | null;',
    expect: ['LYRICS.karaTimeSource'],
  },

  // ── SKIN 六皮肤 ──────────────────────────────────────────────────────
  {
    name: '通透皮肤的 blur 改成 none（不再是唯一毛玻璃皮肤）',
    file: F.expanded,
    find: "      skinBlur = 'blur(20px)';",
    replace: "      skinBlur = 'none';",
    expect: ['SKIN.blurOnlyGlass'],
  },
  {
    name: '给「现代」也加 blur（毛玻璃不再唯一 → 计数变 2）',
    file: F.expanded,
    find: '      skinBg = modernBg;',
    replace: "      skinBg = modernBg;\n      skinBlur = 'blur(20px)';",
    expect: ['SKIN.blurOnlyGlass'],
  },
  {
    name: '现代暗色端点写死成封面色（丢掉 ×0.25 暗化）',
    file: F.expanded,
    find: '  const modernDark = `rgb(${Math.round(cr * 0.25)},${Math.round(cg * 0.25)},${Math.round(cb * 0.25)})`;',
    replace: '  const modernDark = `rgb(${Math.round(cr * 1)},${Math.round(cg * 1)},${Math.round(cb * 1)})`;',
    expect: ['SKIN.bgModern'],
  },
  {
    name: '封面渐染改用封面主色代替右缘色（背景与封面右缘不再相融）',
    file: F.expanded,
    find: '  const coverBg = coverUrl ? edgeColor.hex : modernBg;',
    replace: '  const coverBg = coverUrl ? modernSolid : modernBg;',
    expect: ['SKIN.bgCover'],
  },
  {
    name: '沉浸不再用 makeVividColor 派生色板（退回硬编码渐变）',
    file: F.expanded,
    find: 'makeVividColor(coverColor.rgb[0], coverColor.rgb[1], coverColor.rgb[2])',
    replace: '(() => ({ hex: "#126d83", deep: "#126d83", light: "#126d83", rgb: [18, 109, 131] }))()',
    expect: ['SKIN.bgImmersive'],
  },
  {
    name: '音域回响下不再隐藏歌词（去掉 !isSpectrum 守卫）',
    file: F.expanded,
    find: '        {!isSpectrum ? (',
    replace: '        {true ? (',
    expect: ['SKIN.spectrumNoLyrics'],
  },
  {
    name: '唱片的 animationPlayState 写成常量（暂停仍在转）',
    file: F.vinylDisc,
    find: "            boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.28), inset 0 0 60px ${hexToRgba(accentColor, 0.35)}`,\n            animationPlayState: isPlaying ? 'running' : 'paused',",
    replace:
      "            boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.28), inset 0 0 60px ${hexToRgba(accentColor, 0.35)}`,\n            animationPlayState: 'running',",
    expect: ['SKIN.vinylPause'],
  },
  {
    name: '波纹层类名改坏（沉浸专属视觉丢失）',
    file: F.expanded,
    find: 'className="skin-ripple-layer"',
    replace: 'className="skin-ripple-layer-off"',
    expect: ['SKIN.bgImmersive'],
  },
  {
    name: '音域回响自建音频图（绕过 audioGraph 唯一入口）',
    file: F.spectrumScene,
    // 锚点带 `void ` 前缀：组件注释里也写了 attachAnalyser(findAudioElement())，
    // 不带前缀的话 String.replace 会先改到注释那处，代码仍在 → 断言不红（假阳性）。
    find: '    void attachAnalyser(findAudioElement()).then((g) => {',
    replace: '    void Promise.resolve(null).then((g) => {',
    expect: ['SKIN.spectrumAudio'],
  },
  {
    name: 'ExpandedPlayer 不再引用 useCoverColor（取色基础设施悬空）',
    file: F.expanded,
    find: "import { makeVividColor, useCoverColor, useCoverEdgeColor } from '@hooks/useCoverColor';",
    replace: "import { makeVividColor, useCoverEdgeColor } from '@hooks/useCoverColor';",
    expect: ['SKIN.colorHook'],
  },
  {
    name: '歌词行 flex-shrink:0 被删（当前句被 flex 收缩压扁 → 整行消失、换句后上一句才出现）',
    file: F.musicScss,
    find: '.music-exp-lyr-box .music-lyr-line {',
    replace: '.music-exp-lyr-box .music-lyr-line-off {',
    expect: ['SKIN.lyrNoFlexShrink'],
  },
  {
    name: '从音频图里去掉 GainNode（音量退回依赖元素 volume，部分平台会失效）',
    file: 'src/modules/music/audioGraph.ts',
    find: '    gain = gain ?? ctx.createGain();',
    replace: '    gain = gain ?? null;',
    expect: ['AUDIO.connectDestination'],
  },
  {
    name: '把 onEnded 改回直接调 next()（单曲循环失效）',
    file: 'src/components/MusicKernel.tsx',
    find: '      onEnded={() => handleTrackEnded()}',
    replace: '      onEnded={() => void 0}',
    expect: ['AUDIO.trackEndedOne'],
  },
  {
    name: '把播放队列的 z-index 降回展开播放器之下（点「播放队列」看不到东西）',
    file: F.componentsScss,
    find: '  z-index: 92;',
    replace: '  z-index: 60;',
    expect: ['UI.drawerAboveExpanded'],
  },
  {
    // 复现 2026-10-16 的真机缺陷：模态 ≤ 展开播放器 ⇒ 退出确认被盖住且不报错
    name: '把模态遮罩降回展开播放器之下（点「退出喵坞」的二次确认被铺满的播放器盖住，且不报错）',
    file: F.componentsScss,
    find: '  z-index: 95;',
    replace: '  z-index: 40;',
    expect: ['UI.modalAboveExpanded'],
  },
  {
    // 复现用户报的"边拖边跳"：定位效果不再避让拖拽 ⇒ 拖拽中歌词跟着播放头连续跳
    name: 'KaraokeLyrics 的定位不再避让拖拽（拖进度条时歌词跟着跳）',
    file: F.karaoke,
    find: '    if (seeking) {',
    replace: '    if (false) {',
    expect: ['LYRICS.seekDeferLocate'],
  },
  {
    // 复现用户报的"有的歌词有翻译、有的没有"：同文本复用被摘掉 ⇒ 副歌第二处等重复句永远没译文
    name: 'mergeTranslation 去掉同文本复用（副歌第二处等重复句永远拿不到译文）',
    file: F.lyrics,
    find: '    if (reuse) line.translation = reuse;',
    replace: '    if (false) line.translation = reuse;',
    expect: ['LYRICS.translationMerge'],
  },
  {
    // 同一缺陷的另一半：容差卡回 0.5s ⇒ 平台整体偏移时整段丢翻译
    name: 'mergeTranslation 容差卡回 0.5s（平台时间戳整体偏移时整段丢翻译）',
    file: F.lyrics,
    find: '  const TOL = 1.5;',
    replace: '  const TOL = 0.5;',
    expect: ['LYRICS.translationMerge'],
  },
  {
    name: '不在队列的歌不接进队列（历史点歌会与 currentIndex 不一致）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '        set({ queue: next, currentIndex: next.length - 1 });',
    replace: '        set({ currentIndex: next.length - 1 });',
    expect: ['QUEUE.adoptOutOfQueue'],
  },
  {
    name: 'playNext 不去重（同一首会在队列里出现两次）',
    file: path.join(F.actionsDir, 'queue.ts'),
    find: '    const without = queue.filter((s) => songKey(s) !== key);',
    replace: '    const without = queue;',
    expect: ['QUEUE.playNextInsert'],
  },
  {
    name: 'playNext 不判「正在播」就摘掉重插（把当前项从队列里删掉）',
    file: path.join(F.actionsDir, 'queue.ts'),
    find: "      get().toast('这首歌正在播放');\n      return;",
    replace: "      get().toast('这首歌正在播放');",
    expect: ['QUEUE.playNextNoSelfRemove'],
  },

  // ── MENU 歌曲右键菜单 ──────────────────────────────────────────────────
  {
    name: '菜单挂回行内（不 portal 到 body → 被滚动容器裁掉）',
    file: F.contextMenu,
    find: '    document.body,\n',
    replace: '    document.documentElement,\n',
    expect: ['MENU.portal'],
  },
  {
    name: '外部关闭的 mousedown 改成冒泡阶段（点菜单项会顺带播放这一行）',
    file: F.contextMenu,
    find: "window.addEventListener('mousedown', onDown, true);",
    replace: "window.addEventListener('mousedown', onDown, false);",
    expect: ['MENU.closeCapture'],
  },
  {
    name: '外部关闭改用 click（被行的 onClick 抢先 → 点菜单项 = 顺带播这一行）',
    file: F.contextMenu,
    find: "window.addEventListener('mousedown', onDown, true);",
    replace: "window.addEventListener('click', onDown, true);",
    expect: ['MENU.closeCapture'],
  },
  {
    name: 'scroll 监听改成冒泡阶段（听不到内层容器滚动 → 菜单飘在原处）',
    file: F.contextMenu,
    find: "window.addEventListener('scroll', onClose, true);",
    replace: "window.addEventListener('scroll', onClose, false);",
    expect: ['MENU.scrollCapture'],
  },
  {
    name: 'Esc 判据写错（按 Esc 关不掉菜单）',
    file: F.contextMenu,
    find: "if (e.key !== 'Escape') return;",
    replace: "if (e.key !== 'Esc') return;",
    expect: ['MENU.esc'],
  },
  {
    name: '右边放不下时不夹进视口（菜单被视口右缘切掉一半）',
    file: F.contextMenu,
    find: 'const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));',
    replace: 'const left = x;',
    expect: ['MENU.flip'],
  },
  {
    name: '菜单根节点不截断 onClick（点菜单项 = 顺带触发宿主行的点击）',
    file: F.contextMenu,
    find: '      onClick={(e) => e.stopPropagation()}\n',
    replace: '',
    expect: ['MENU.noBubble'],
  },
  {
    name: '「下一首播放」不调 playNext（点了没反应）',
    file: F.songRowShared,
    find: 'playNext(menu.song);',
    replace: 'void menu.song;',
    expect: ['MENU.nextItem'],
  },
  {
    name: '加回一个点了没用的「下载」菜单项（本轮不做）',
    file: F.songRowShared,
    find: '                label="下一首播放"',
    replace: '                label="下一首播放"\n                sub="下载"',
    expect: ['MENU.noDownload'],
  },
  {
    name: '播放兜底去掉（宿主没传 onPlay 时菜单点了没反应）',
    file: F.songRowShared,
    find: 'else void playSong(menu.song);',
    replace: 'else void 0;',
    expect: ['MENU.playSemantics'],
  },
  {
    name: 'SongRow 不接 onContextMenu（右键没反应）',
    file: F.songRowShared,
    find:
      '      onContextMenu={(e) => {\n' +
      '        e.preventDefault(); // 关掉系统右键菜单，否则两层菜单叠在一起\n' +
      '        setMenu({ x: e.clientX, y: e.clientY, song, onPlay });\n' +
      '      }}\n',
    replace: '',
    expect: ['MENU.rowContextMenu'],
  },
  {
    name: '搜索结果行漏接 onPlay（右键「播放」与左键点击不是一个语义）',
    file: F.rightPanel,
    find: '              onClick={play}\n              onPlay={play}\n              actions={',
    replace: '              onClick={play}\n              actions={',
    expect: ['MENU.onPlay.right'],
  },
  {
    name: '播放历史行漏接 onPlay（右键「播放」丢掉 fromHistory 来源标记）',
    file: F.historyView,
    find: '                onClick={play}\n                onPlay={play}\n',
    replace: '                onClick={play}\n',
    expect: ['MENU.onPlay.history'],
  },
  {
    name: 'QueueDrawer 把菜单状态挪到早退之后（顺序随行数变）',
    file: F.queueDrawer,
    find: '  const [menu, setMenu] = useState<{ x: number; y: number; song: Song } | null>(null);',
    replace:
      '  if (!queueOpen) return null;\n' +
      '  const [menu, setMenu] = useState<{ x: number; y: number; song: Song } | null>(null);',
    expect: ['MENU.queueRow'],
  },
  {
    name: '右键菜单去掉 z-index 78（被队列抽屉 / 展开播放器压住看不见）',
    file: F.componentsScss,
    find: 'z-index: 78',
    replace: 'z-index: 7',
    expect: ['MENU.css'],
  },

  // ── ISLANDV 灵动岛第 4 态（歌词卡）──────────────────────────────────────
  {
    name: 'islandView 的默认值改成 lyrics（首次使用就落在歌词卡）',
    file: 'src/modules/music/store.ts',
    find: "  islandView: 'play',\n",
    replace: "  islandView: 'lyrics',\n",
    expect: ['ISLANDV.pref.default'],
  },
  {
    name: 'IslandView 放宽成 string（localStorage 里的脏值能一路流到渲染层）',
    file: 'src/modules/music/store.ts',
    find: "export type IslandView = 'play' | 'lyrics';",
    replace: 'export type IslandView = string;',
    expect: ['ISLANDV.pref.type'],
  },
  {
    name: "islandView 改用 ?? 回落（脏值 'xxx' 会被原样读进内存）",
    file: path.join(F.actionsDir, 'init.ts'),
    find: "    const islandView: IslandView = prefs.islandView === 'lyrics' ? 'lyrics' : 'play';",
    replace: "    const islandView: IslandView = (prefs.islandView ?? 'play') as IslandView;",
    expect: ['ISLANDV.pref.hydrate'],
  },
  {
    name: 'hydratePrefs 恢复时漏掉 islandView（冷启动回到默认值）',
    file: path.join(F.actionsDir, 'init.ts'),
    find: '      islandView,\n',
    replace: '',
    expect: ['ISLANDV.pref.hydrate'],
  },
  {
    name: 'setIslandView 不写 savePrefs（切到歌词卡后重开就回到播放卡）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '    savePrefs({ islandView: v });\n',
    replace: '    // [refute] 偏好未持久化\n',
    expect: ['ISLANDV.pref.persist'],
  },
  {
    name: '灵动岛不复用 KaraokeLyrics（自己再写一份逐字实现）',
    file: F.island,
    find: "import { KaraokeLyrics } from '@screens/music/KaraokeLyrics';\n",
    replace: '',
    expect: ['ISLANDV.reuseKaraoke'],
  },
  {
    name: 'KaraokeLyrics 去掉 scroll 开关（小卡片里 scrollIntoView 会把布局顶歪）',
    file: F.karaoke,
    find: '  scroll?: boolean;\n',
    replace: '',
    expect: ['ISLANDV.windowMode'],
  },
  {
    name: '窗口起点不兜底 -1（没开唱时歌词卡一片空白，而其它断言全绿）',
    file: F.karaoke,
    find: '  const winStart = windowSize && windowSize > 0 ? Math.max(0, activeIndex) : 0;',
    replace: '  const winStart = windowSize && windowSize > 0 ? activeIndex : 0;',
    expect: ['ISLANDV.windowIdleStart'],
  },
  {
    name: '歌词窗口改成 6 行（150px 高的卡片装不下）',
    file: F.island,
    find: 'const ISLAND_LYR_WINDOW = 2;',
    replace: 'const ISLAND_LYR_WINDOW = 6;',
    expect: ['ISLANDV.twoRows'],
  },
  {
    name: '纯音乐降级文案改掉（无歌词时卡片不是约定的提示）',
    file: F.island,
    find: '♪ 纯音乐，请欣赏',
    replace: '暂无歌词',
    expect: ['ISLANDV.pureMusic'],
  },
  {
    name: '切换键只留一个方向（进了歌词卡出不来）',
    file: F.island,
    find: "title={view === 'lyrics' ? '播放' : '歌词'}",
    replace: '              title="歌词"',
    expect: ['ISLANDV.toggleBothWays'],
  },
  {
    name: '歌词卡另立高度（大卡常量被改成 180，形变对不上）',
    file: F.island,
    find: 'const MUSIC_EXPANDED_HEIGHT = 160;',
    replace: 'const MUSIC_EXPANDED_HEIGHT = 180;',
    expect: ['ISLANDV.cardSize'],
  },
  {
    name: '歌词卡不注入 --lyr-hl（用户选的高亮色在灵动岛不生效）',
    file: F.island,
    find: "    '--lyr-hl': highlight,\n",
    replace: '',
    expect: ['ISLANDV.hlVarInjected'],
  },
  {
    name: '.is-dynamic 用 animation 简写开关动态背景（重播进场动画 ⇒ 整屏闪一下）',
    file: F.musicScss,
    find: '  animation-play-state: running, running;\n}',
    replace: '  animation: music-exp-flow 8s ease-in-out infinite;\n}',
    expect: ['PLAYER.noAnimShorthandClash'],
  },
  {
    name: '歌词卡把按钮栏按钮压回 26px（两态总宽不同 ⇒ 居中位移 + 上下跳）',
    file: F.musicScss,
    find: '.di-card.is-lyr {\n  /* 上内边距仍要让开共享封面（62）；下内边距与播放卡**同值**（42 = 按钮栏顶边），\n     两态的内容区底边因此对齐；歌词区实得 150-62-42 = 46px，容得下两行 14/12。 */\n  padding: 62px 16px 42px;',
    replace:
      '.di-card.is-lyr {\n  padding: 62px 16px 42px;\n}\n.di-card.is-lyr .di-ctl .ui-cbtn {\n  width: 26px;\n  height: 26px;\n}',
    expect: ['ISLANDV.ctlStableAcrossViews'],
  },
  {
    name: '.di-toggle 外层跟着内容缩成 26px（整行总宽变 ⇒ 居中位移）',
    file: F.musicScss,
    find: '.di-toggle {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 30px;\n  height: 30px;\n  flex: 0 0 auto;\n}',
    replace:
      '.di-toggle {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 26px;\n  height: 26px;\n}',
    expect: ['ISLANDV.ctlStableAcrossViews'],
  },
  {
    name: '把 .di-prog 放回文档流（切视图时进度条位置随内容高度变）',
    file: F.musicScss,
    find: '.di-prog {\n  position: absolute;\n  left: 16px;\n  right: 16px;\n  bottom: 50px;\n  height: 12px;\n  display: flex;',
    replace: '.di-prog {\n  display: flex;',
    expect: ['ISLANDV.ctlStableAcrossViews'],
  },
  {
    name: '歌词卡字号接回 --lyr-size（跟随用户 17–48 的量程 → 320px 卡片被撑爆）',
    file: F.musicScss,
    find: '.di-card .di-lyr .music-lyr-line {\n  font-size: var(--di-lyr-size, 12px);',
    replace: '.di-card .di-lyr .music-lyr-line {\n  font-size: var(--lyr-size, 12px);',
    expect: ['ISLANDV.fontSizeLocal'],
  },
  {
    name: '提前删掉桌面歌词的状态推送（本轮红线：只加不删）',
    file: path.join(F.actionsDir, 'desktop.ts'),
    find: '  pushLyricsState: async () => {',
    replace: '  pushLyricsStateRemoved: async () => {',
    expect: ['ISLANDV.desktopLyricsKept'],
  },

  // ── WEBVIEW（窗口 WebView2 参数一致性：防「登录窗口打开失败」复发）──────────
  // ⚠️ 锚点一律用**单行**：工作区是 CRLF（core.autocrlf=true），而反证轮用的是
  //    `txt.includes(find)`（裸字符串比较）—— 多行 find 里的 `\n` 匹配不上 `\r\n`，
  //    会被判"破坏锚点未找到"而**静默跳过**（跳过 ≠ 通过）。本仓库已踩过一次。
  {
    // 只给**一个**窗口单独加参数 —— 这正是本次缺陷的形态：
    // 主窗走 wry 默认值、登录窗走自定义值 ⇒ WebView2 以 0x8007139F 拒绝建窗。
    // `.inner_size(940.0, 760.0)` 全文唯一（网易云登录窗），故锚点稳定。
    name: '只给网易云登录窗单独设 additional_browser_args（与主窗默认值冲突 ⇒ 建窗失败）',
    file: F.rustMod,
    find: '        .inner_size(940.0, 760.0)',
    replace: '        .additional_browser_args("--disable-features=Foo")\n        .inner_size(940.0, 760.0)',
    expect: ['WEBVIEW.sameArgsEverywhere'],
  },
  {
    // 把登录窗改成加载应用自身页面（很自然的错：照抄桌面歌词窗的 WebviewUrl::App）。
    // 编译能过、运行不报错，只是**登录页不再出现**。
    name: '把网易云登录窗改成加载应用自身页面（照抄歌词窗写法 ⇒ 登录页不出现）',
    file: F.rustMod,
    find: '            WebviewUrl::External("about:blank".parse().map_err(|e: url::ParseError| e.to_string())?),',
    replace: '            WebviewUrl::App("templates/index.html".into()),',
    expect: ['WEBVIEW.loginExternal'],
  },

  // ── RESTORE（启动恢复）──────────────────────────────────────────────────
  // 每条断言都配一条反证。恢复链路的失效形态全是**静默**的（重开是空的、
  // 定位没生效、队列被清空），没有反证就分不清"功能坏了"和"从没实现过"。
  {
    name: '暂停时不再存快照（"听完暂停、第二天再开"丢进度）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '    if (!get().isPlaying) get().persistSnapshot();',
    replace: '    // 反证：暂停不存快照',
    expect: ['RESTORE.snapshotPersisted'],
  },
  {
    name: '快照不校验版本号（拿旧结构继续跑 → "恢复了但队列是空的"且不报错）',
    file: F.persist,
    find: 'if (s.v !== SNAPSHOT_VERSION) return null;',
    replace: '// 反证：不校验版本',
    expect: ['RESTORE.snapshotVersioned'],
  },
  {
    name: '截断队列时不重算 index（当前歌被截出窗口 → 恢复后停在一首无关的歌上）',
    file: F.persist,
    find: 'return { queue: queue.slice(start, start + max), index: index - start };',
    replace: 'return { queue: queue.slice(start, start + max), index };',
    expect: ['RESTORE.truncateKeepsCurrent'],
  },
  {
    name: '切平台时不存 playbackSource（重启后恒为网易云 → 恢复按错平台校验登录态）',
    file: path.join(F.actionsDir, 'platform.ts'),
    find: '    savePrefs({ playbackSource: p });',
    replace: '    // 反证：不存平台偏好',
    expect: ['RESTORE.playbackSourcePersisted'],
  },
  {
    // 这一条是 Q1 的核心：把「探不动」当「登出」→ 用户一断网就丢播放进度
    name: '把「探测失败」也判成明确未登录（断网即清快照，Q1 语义反了）',
    file: path.join(F.actionsDir, 'init.ts'),
    find: "  if (info === null || info === undefined) return 'probe_failed';",
    replace: "  if (info === null || info === undefined) return 'logged_out';",
    expect: ['RESTORE.verdictThreeStates'],
  },
  {
    name: '恢复时不传 autoplay:false（重开应用直接自动播放，违背需求）',
    file: path.join(F.actionsDir, 'init.ts'),
    find: '      autoplay: false,\n      expand: false,\n      resumeAtMs: snap.progressMs,',
    replace: '      expand: false,\n      resumeAtMs: snap.progressMs,',
    expect: ['RESTORE.restoredPaused'],
  },
  {
    // 只保留快照不退回闸：断网时第一次进屏就把闸关死，网络好了也永不再试
    name: '探针失败时不把「只跑一次」的闸退回 false（断网一次 → 恢复功能永久失效）',
    file: path.join(F.actionsDir, 'init.ts'),
    find: '      set({ restoreAttempted: false });',
    replace: '      // 反证：不退回闸',
    expect: ['RESTORE.probeFailKeepsSnapshot'],
  },
  {
    // 闸只开不关：用户之后正常播放遇到一次网络抖动，就会静默遍历整个队列并清空
    name: 'URL 解析抛错时不关恢复态（playUrl 永不设置 → 没有任何路径会关闸）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '      set({ isPlaying: false, restoring: false });',
    replace: '      set({ isPlaying: false });',
    expect: ['RESTORE.restoringClosed'],
  },
  {
    name: '不在 loadedmetadata 后定位（全新加载时设 currentTime 会被静默忽略 → 从 0 开始）',
    file: F.kernel,
    find: '          a.currentTime = resumeAtMs / 1000;\n',
    replace: '          // 反证：不定位\n',
    expect: ['RESTORE.seekAfterMetadata'],
  },
  {
    // 本地文件被移走时若走 CORS 降级，会 markNotWirable → 常驻 audio 元素永久失去音频图
    name: '本地文件也走 CORS 降级（文件被移走时会把 audio 永久标记为不可接管 → 音量失效）',
    file: F.kernel,
    find: 'if (corsMode && a && !isLocalFile) {',
    replace: 'if (corsMode && a) {',
    expect: ['RESTORE.localSkipsCorsFallback'],
  },
  {
    // Q4：写死 10 → 恢复时"整条队列都失败"永远走不到清空那一步
    name: '恢复态的跳歌上限写死 10 首（遍历不完就停 → 该清的队列没清）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: 'const skipLimit = restoring ? Math.max(1, get().queue.length) : 10;',
    replace: 'const skipLimit = 10;',
    expect: ['RESTORE.skipLimitRestoring'],
  },
  {
    name: '去掉「本次会话只恢复一次」的闸（切走再切回会重复恢复并覆盖用户的操作）',
    file: path.join(F.actionsDir, 'init.ts'),
    find: '    if (get().restoreAttempted) return;',
    replace: '    // 反证：无闸',
    expect: ['RESTORE.onlyOnce'],
  },

  // ── CACHE（音乐缓存接线）─────────────────────────────────────────────────
  // 这组反证针对的都是「漏接线/接错」——**编译全绿、功能静默失效**。
  // 每条破坏都对应一个具体的用户可见后果，故注释里写明后果而非只写"破坏"。
  {
    // ⭐ 最关键的一条：删掉 quality 实参。命中缓存时与"按请求档位命中"不可区分，
    // 后果是用户切到「无损」后播的仍是上次的「极高」文件，界面显示新档位 —— 察觉不到。
    // 这条反证同时证明 CACHE.keyHasQuality 不是恒绿。
    name: '查缓存时删掉 quality 实参（⇒ 切档位后命中上次文件，界面显示新档位实际播旧码率）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: 'ipc.musicAudioCached(provider, audioCacheId(provider, song), quality)',
    replace: 'ipc.musicAudioCached(provider, audioCacheId(provider, song))',
    expect: ['CACHE.keyHasQuality'],
  },
  {
    name: '把查缓存的档位换成 r.quality（四平台值域不同 ⇒ 同一首歌每次 key 都不同 ⇒ 永不命中）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '  const quality = state.playbackQuality;',
    replace: "  const quality = String((await platform.songUrl(provider, song, 'standard')).quality || '');",
    expect: ['CACHE.qualityFromState'],
  },
  {
    name: '把档位默认成 standard（参数传漏时静默命中标准音质 ⇒ 用户以为在听高音质）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '  const quality = state.playbackQuality;',
    replace: "  const quality = state.playbackQuality || 'standard';",
    expect: ['CACHE.noQualityFallback'],
  },
  {
    name: '本地歌曲不再排除（用户导入的文件被计入「音乐缓存」统计 ⇒ 设置页占用数字失真）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '  if (song._localPath) return null;\n',
    replace: '  // 反证：本地歌曲也入缓存链\n',
    expect: ['CACHE.localSongExcluded'],
  },
  {
    name: '预热不再排除本地歌曲（本地文件被重复问一次缓存，且计入音乐缓存统计）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '  if (song._localPath) return;\n',
    replace: '  // 反证：预热不排除本地\n',
    expect: ['CACHE.localSongExcluded'],
  },
  {
    name: '把查缓存挪到取流地址之后（先回源再查 ⇒ 命中也省不掉这次网络往返，白接缓存）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '  const cached = await lookupAudioCache(song, provider, quality);\n',
    replace: '  // 反证：不查缓存\n',
    expect: ['CACHE.hitSkipsSongUrl'],
  },
  {
    name: '缓存命中后不 return（命中了还会继续往下调 songUrl ⇒ 缓存等于没接）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '    return cached;\n',
    replace: '    // 反证：命中不返回\n',
    expect: ['CACHE.hitSkipsSongUrl'],
  },
  {
    // 这一条是**跨语言契约**的守护：Rust 改名 → 前端读到 undefined → 累加不报错 → 显示 0，
    // 症状是"缓存统计永远是 0"，看起来像功能没做，而不像字段名拼错。
    // ⚠️ 锚点必须**只命中 CacheStats**：字段名会复用（`CacheProviderStat` 也有
    // `audio_bytes`，且它同样以 `audio_bytes: number;\n}` 结尾）⇒ 用那一行做锚点
    // 会改到另一个接口上，CacheStats 纹丝不动，断言恒绿（反证轮已实测报出这条假阳性）。
    // `limit_audio` 全文件只出现一次，是唯一安全锚点。
    name: '把 CacheStats 的 limit_audio 字段名改错（与 Rust models.rs 不一致 ⇒ 设置页读到 undefined 显示 0）',
    file: F.types,
    find: '  limit_audio: number;',
    replace: '  limitAudio: number;',
    expect: ['CACHE.statsShapeForSettings'],
  },
  {
    name: '把 ipc.ts 的 music_audio_cached 命令名写错一个字（tsc 全绿，运行时才发现命令不存在）',
    file: F.ipc,
    find: "'music_audio_cached'",
    replace: "'music_audio_cached_typo'",
    expect: ['CACHE.ipcWrapped'],
  },
  {
    name: '从 commands/mod.rs 的 generate_handler! 里摘掉 music_cache_stats 注册（定义仍在）',
    file: F.rustRegistry,
    find: '        crate::music::audio_cache::music_cache_stats,\n',
    replace: '',
    expect: ['CACHE.ipcWrapped'],
  },
  {
    name: '缓存命中路径不走 convertFileSrc（绝对路径直喂 <audio> 被跨源挡住 ⇒ 命中反而播不出声）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '    return hit ? convertFileSrc(hit) : null;',
    replace: '    return hit || null;',
    expect: ['CACHE.hitUsesConvertFileSrc'],
  },
  {
    name: '把预热 await 住（慢网下点歌要等整首下载完才响；下载失败还会被当成"播放失败"跳歌）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '  void ipc.musicCacheDownload(provider, audioCacheId(provider, song), quality, url).catch(() => {});',
    replace: '  await ipc.musicCacheDownload(provider, audioCacheId(provider, song), quality, url);',
    expect: ['CACHE.downloadNonBlocking', 'CACHE.downloadFailureSilent'],
  },
  {
    name: '下载失败不上抛（未处理的 Promise 拒绝会中断播放链路 ⇒ 缓存失败变成歌放不出来）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: '  void ipc.musicCacheDownload(provider, audioCacheId(provider, song), quality, url).catch(() => {});',
    replace: '  void ipc.musicCacheDownload(provider, audioCacheId(provider, song), quality, url);',
    expect: ['CACHE.downloadFailureSilent'],
  },

  // ── KEYS · 音乐快捷键 ──────────────────────────────────────────────────
  // 这一组每条反证对应上面 KEYS 组的 9 条断言，逐条单点破坏。
  // ⚠️ 锚点一律要求**唯一命中**：本组判据大量涉及"多处出现的写法"
  // （preventDefault / stepVolume / trackSwitchBlocked / !mod），锚点若不唯一，
  // 破坏会打到邻居语句上 ⇒ 断言该红没红（本项目栽过 3 次）。
  {
    name: '把 MusicKernel 里的 useMusicHotkeys() 调用删掉（快捷键永不生效）',
    file: F.kernel,
    // 锚点带缩进与分号：文件里还有 import 行与注释都含useMusicHotkeys，
    // 只写函数名会 replace 到 import 上（改了没生效）
    find: '  useMusicHotkeys();\n',
    replace: '',
    expect: ['KEYS.mountedInKernel'],
  },
  {
    name: '把 ↑ 的步长从 0.05 改成 0.5（音量步长与滚轮/滑块口径不一致）',
    file: F.hotkeys,
    find: 's.stepVolume(0.05);',
    replace: 's.stepVolume(0.5);',
    expect: ['KEYS.fiveKeyMapping'],
  },
  {
    name: '把让位判据里的 textarea 删掉（在备注/歌词输入框里按空格会被劫持）',
    file: F.hotkeys,
    find: "  'textarea',\n",
    replace: '',
    expect: ['KEYS.yieldSelectors'],
  },
  {
    name: '把让位判据从 closest() 退化成只比 tagName（焦点落在 IconButton 内的 svg 上时误劫持）',
    file: F.hotkeys,
    // 这一条同时打掉 KEYS.usesClosest；顺带确认 KEYS.yieldSelectors 不受影响
    // （选择器名单本身没动，改的只是怎么用它）
    find: '  return target.closest(INTERACTIVE_SELECTOR) !== null;',
    replace: "  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName);",
    expect: ['KEYS.usesClosest'],
  },
  {
    name: '把 ⌘+← 的 preventDefault 挪到合并判断之后（连按时原生「后退」跟着一起触发）',
    file: F.hotkeys,
    // 锚点含紧邻两行：只替换 `e.preventDefault();` 会打到 Space/↑/↓ 那一处（邻居语句）。
    // ⚠️ 锚点必须与实现**当前**的形态一致 —— 实现把合并函数改名成 autoRepeatBlocked
    // 之后，这里若还锚 trackSwitchBlocked 就会"锚点未找到 → 静默跳过"（假覆盖）。
    find: "          e.preventDefault();\n          if (autoRepeatBlocked('prev')) return;\n",
    replace: "          if (autoRepeatBlocked('prev')) return;\n          e.preventDefault();\n",
    expect: ['KEYS.preventDefaultBeforeDebounce'],
  },
  {
    name: '把 ⌘/Ctrl 双平台等价改成只认 metaKey（Windows/Linux 整体失灵）',
    file: F.hotkeys,
    find: '      const mod = e.metaKey || e.ctrlKey;',
    replace: '      const mod = e.metaKey;',
    expect: ['KEYS.metaCtrlEquivalent'],
  },
  {
    name: '去掉裸方向键的守卫（裸 ←/→ 也切歌 ⇒ 劫持漫画对照视图翻页）',
    file: F.hotkeys,
    // 锚点带上 ArrowLeft 的那行注释，保证只打到 ArrowLeft 那一处
    // （守卫行 `if (!mod || e.altKey || shift) return;` 在文件里出现两次）
    find: '          // ⚠️ **必须带 ⌘/Ctrl**：裸 ← 归漫画对照视图翻页（见文件头）\n          if (!mod || e.altKey || shift) return;\n',
    replace: '          // ⚠️ **必须带 ⌘/Ctrl**：裸 ← 归漫画对照视图翻页（见文件头）\n',
    expect: ['KEYS.bareArrowsIgnored'],
  },
  {
    name: '给音量 ↑ 也套上合并（快速连按只生效一次，音量爬不上去）',
    file: F.hotkeys,
    find: '          s.stepVolume(0.05);\n',
    replace: "          if (autoRepeatBlocked('vol')) return;\n          s.stepVolume(0.05);\n",
    expect: ['KEYS.debounceTrackSwitchOnly'],
  },
  {
    name: '把去抖改成全键共用一个时间戳（⌘+→ 连按后按 ⌘+← 会被吃掉，上一首按不动）',
    file: F.hotkeys,
    // 锚点含 ref 声明 + 读写两行，一次改成"单一数值"形态
    find: '  const lastAt = useRef<Record<string, number>>({});',
    replace: '  const lastAt = useRef<number>(0);',
    expect: ['KEYS.debouncePerKey'],
  },
  {
    name: '删掉"手动按键无条件放行"（回到一律合并 ⇒ 手速快点 3 下只跳 2 首，看起来像按了没反应）',
    file: F.hotkeys,
    find: '        if (!e.repeat) return false;\n',
    replace: '',
    expect: ['KEYS.manualRepeatOnly'],
  },
  {
    name: '把放行分支挪到更新时间戳之后（长按后紧接着的一次手动点击会被误判成还在自动重复而吃掉）',
    file: F.hotkeys,
    find: '        if (!e.repeat) return false;\n        const now = performance.now();\n        const prevAt = lastAt.current[key] ?? -Infinity;\n        if (now - prevAt < TRACK_SWITCH_REPEAT_GUARD_MS) return true;\n        lastAt.current[key] = now;\n        return false;',
    replace:
      '        const now = performance.now();\n        const prevAt = lastAt.current[key] ?? -Infinity;\n        if (now - prevAt < TRACK_SWITCH_REPEAT_GUARD_MS) return true;\n        if (!e.repeat) return false;\n        lastAt.current[key] = now;\n        return false;',
    expect: ['KEYS.manualPressNotMerged'],
  },
  {
    name: '把常量名退回 TRACK_SWITCH_DEBOUNCE_MS（一律合并的旧语义复活，注释与代码分叉）',
    file: F.hotkeys,
    find: 'const TRACK_SWITCH_REPEAT_GUARD_MS = 250;',
    replace: 'const TRACK_SWITCH_DEBOUNCE_MS = 250;',
    expect: ['KEYS.manualPressNotMerged'],
  },
  {
    name: '把 Shift 漏出裸键条件（Shift+↑ 会一边被系统处理、一边又把音量调了 —— 注释写着"带修饰键不抢"但代码没做）',
    file: F.hotkeys,
    find: '          if (e.metaKey || e.ctrlKey || e.altKey || shift) return;\n          e.preventDefault();\n          /**',
    replace: '          if (e.metaKey || e.ctrlKey || e.altKey) return;\n          e.preventDefault();\n          /**',
    expect: ['KEYS.shiftLeftToSystem'],
  },
  {
    name: '删掉 const shift = e.shiftKey（各 case 只能分散判 e.shiftKey，必然漏一个）',
    file: F.hotkeys,
    find: '      const shift = e.shiftKey;\n',
    replace: '',
    expect: ['KEYS.shiftLeftToSystem'],
  },
  {
    name: '把 store 的 lyricsMode 默认值改成裸字面量（与 LYRICS_MODE_DEF 漂移成两份事实）',
    file: F.store,
    find: '  lyricsMode: LYRICS_MODE_DEF,',
    replace: "  lyricsMode: 'line',",
    expect: ['LYRICS.modeStoreChain'],
  },
  {
    /*
     * D-137：整行从「双层 + width 写死 100%」改成**单层渲染**，原先锚在那个三元上的
     * 反证已失效（锚点不存在 ⇒ 静默跳过，跳过 ≠ 通过）。换成三条打在新结构上的反证：
     * 分别破坏「单层」「RAF 闸门」「样式过渡」三处，缺任一条断言就该红。
     */
    name: '整行分支里把单层改回双层（重新引入可被 RAF 改写的 width 通路）',
    file: F.karaoke,
    find: '            <div key={i} ref={activeRowRef} className="music-lyr-line is-on kara-line">',
    replace:
      '            <div key={i} ref={activeRowRef} className="music-lyr-line is-on kara-line kara-line-on">\n' +
      '              <span className="kara-dup"><span className="kara-under">{line.text}</span></span>',
    expect: ['LYRICS.modeLineRender'],
  },
  {
    name: '去掉 RAF 的整行闸门（整行模式又开始逐帧写 width）',
    file: F.karaoke,
    find: "if (el && idx >= 0 && modeRef.current !== 'line') {",
    replace: 'if (el && idx >= 0) {',
    expect: ['LYRICS.modeLineRender'],
  },
  {
    name: '样式里去掉 .is-line-mode 的 transition:none（整行高亮又变成缓缓位移）',
    file: F.musicScss,
    find: '.music-exp-lyr-box.is-line-mode .music-lyr-line {\n  transition: none;\n}',
    replace: '.music-exp-lyr-box.is-line-mode .music-lyr-line {\n  transition: all 0.2s;\n}',
    expect: ['LYRICS.modeLineRender'],
  },
  {
    name: '删掉 loadLyrics 里的 mergeTranslation 调用（翻译歌词永远不显示）',
    file: path.join(F.actionsDir, 'lyrics.ts'),
    find: "mergeTranslation(lines, l.translation || '');",
    replace: 'void 0;',
    expect: ['LYRICS.translationMerge'],
  },
  {
    name: '把 showTranslation 默认值改成 true（灵动岛也会显示翻译，撑爆卡片）',
    file: F.karaoke,
    find: '  showTranslation = false,',
    replace: '  showTranslation = true,',
    expect: ['LYRICS.translationRender'],
  },
  {
    name: '把展开播放器传给 KaraokeLyrics 的 headerLine 删掉（演唱行从歌词流消失）',
    file: F.expanded,
    find: '                  headerLine={currentSong?.artist ? `演唱：${currentSong.artist}` : undefined}\n',
    replace: '',
    expect: ['LYRICS.artistLine'],
  },
  {
    name: '把「译」开关写死成 false（详情页永远不显示翻译）',
    file: F.expanded,
    find: 'showTranslation={showTranslation}',
    replace: 'showTranslation={false}',
    expect: ['LYRICS.showTranslationWired'],
  },
  // ---- D-56 新增 4 条断言的反证：每条破坏对应机制，必须变红 ----
  {
    name: '把行级插值改回 smoothstep 缓动（高亮重新"追不上播放"）',
    file: F.karaoke,
    find: '  const prog = Math.max(0, Math.min(1, (now - line.time) / span));\n  return prog;',
    replace:
      '  const prog = Math.max(0, Math.min(1, (now - line.time) / span));\n  return prog * prog * (3 - 2 * prog);',
    expect: ['LYRICS.noLagOffset'],
  },
  {
    name: '给 nowSec 加回 +0.02s 视觉补偿（每行高亮起点被推后 ⇒ 滞后）',
    file: F.karaoke,
    find: '  const now = nowSec;',
    replace: '  const now = nowSec + 0.02;',
    expect: ['LYRICS.noLagOffset'],
  },
  {
    name: '删掉 RAF 给翻译顶层写 width 的那行（翻译不再随原文同步点亮）',
    file: F.karaoke,
    find: '          const tEl = transOverlayRef.current;\n          if (tEl) tEl.style.width = w;',
    replace: '          const tEl = transOverlayRef.current;\n          if (tEl) tEl.style.width = "0%";',
    expect: ['LYRICS.transHighlightSync'],
  },
  {
    name: '把翻译的当前行从双层叠加退化成单层（只整行变色，与原文不同步）',
    file: F.karaoke,
    find: '              <span className="kara-dup kara-trans-dup">',
    replace: '              <span className="kara-trans">',
    expect: ['LYRICS.transHighlightSync'],
  },
  {
    name: '把 headerLine 塞进 lines 数组当 time=0 的普通歌词行（前奏期整列不高亮）',
    file: F.karaoke,
    find: '  linesRef.current = lines;',
    replace: '  linesRef.current = headerLine ? [{ time: 0, text: headerLine }, ...lines] : lines;',
    expect: ['LYRICS.headerNotInLines'],
  },
  {
    name: '把进度条轨道的渐变填充改回纯色（已调节段不再有高亮色）',
    file: F.musicScss,
    find: '  background: linear-gradient(to right, var(--fill-c) 0 var(--fill, 0%), var(--track-c) var(--fill, 0%) 100%);\n}\n.music-prog-bar::-webkit-slider-thumb',
    replace: '  background: var(--md-line);\n}\n.music-prog-bar::-webkit-slider-thumb',
    expect: ['LYRICS.sliderFill'],
  },
  {
    name: '删掉 PlayerBar 注入的 --fill（渐变在但分界恒为 0% ⇒ 看不到填充）',
    file: F.playerBar,
    find: "style={{ '--fill': `${progFill.toFixed(2)}%` } as FillStyle}",
    replace: 'style={{} as FillStyle}',
    expect: ['LYRICS.sliderFill'],
  },
  {
    name: '把歌词窗那一步的 shot_win 改回主窗（文件名说歌词窗、内容是主窗）',
    file: F.captureRs,
    find: 'shot_win: LYRICS_WINDOW,',
    replace: 'shot_win: MAIN_WIN,',
    expect: ['CAPTURE.lyricsStep'],
  },
  {
    name: '把音乐屏那一步的侧栏定位从 aria-label 换成文字（关掉图标标签后找不到入口）',
    file: F.captureRs,
    find: 'click_when_ready(".nav-item.is-app[aria-label=\\"音乐\\"]", None)',
    replace: 'click_when_ready(".nav-item.is-app", Some("音乐"))',
    expect: ['CAPTURE.musicStep'],
  },
  {
    name: '从 e2e/capture.mjs 的 SHOTS 里删掉音乐屏那张（Rust 截了，入库清单不收）',
    file: F.captureMjs,
    find: "['07-music.png', '音乐应用（未播放 / 未登录时的空态）'],",
    replace: '',
    expect: ['CAPTURE.assetsMatchJs'],
  },
];

// ── 主流程 ────────────────────────────────────────────────────────────────
const refute = process.argv.includes('--refute');

console.log('音乐模块 · 四平台接通断言' + (refute ? ' · 反证轮' : ''));
console.log(`根目录：${ROOT}`);
console.log(`断言总数：${A.length}（${GROUPS.join('/')}）`);

if (!refute) {
  const res = runAll(loadSources());
  const { pass, fail } = printGrouped(res);
  console.log('\n' + '─'.repeat(56));
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) {
    const uiFail = A.filter((a) => a.group === 'UI' && !res[a.id].ok).length;
    console.log(`\n下一步：`);
    if (uiFail)
      console.log(`  · UI 组有 ${uiFail} 条未通过 —— 该层由另一位同事并行重写，属已知真实缺口，待其落地后复跑。`);
    if (fail > uiFail)
      console.log(
        `  · 非 UI 组存在未通过项，请按上面 ✗ 的 detail 定位（是脚本写错还是真实缺口，勿为转绿而放宽断言）。`,
      );
  }
  process.exitCode = fail === 0 ? 0 : 1;
} else {
  const base = runAll(loadSources());
  // 基线快照（用于说明"该红没红"是否因为基线本就红）
  const wasGreenBase = {};
  for (const a of A) wasGreenBase[a.id] = base[a.id].ok;

  let total = 0;
  let red = 0;
  let skipped = 0;
  const falsePositives = [];
  const restored = new Map(); // file -> original Buffer（最终整批校验）
  // 分母固定：应执行的破坏条数在脚本里写死，少执行一条即判红。
  // 理由——比率型指标会吞掉分母变化：「9/9」和「8/8」在肉眼看来都是全绿，
  // 而后者已经永久少了一条覆盖（锚点随被测代码重构漂移时会这样静默降级）。
  const expectedTotal = MUTATIONS.reduce((n, m) => n + m.expect.length, 0);

  console.log('\n破坏源文件 → 断言必须变红 → 恢复\n');
  for (const mut of MUTATIONS) {
    // 统一绝对路径：mutation 的 file 既有绝对路径（F.xxx）也有相对路径字面量，
    // override 层用路径作 key，两者不归一就会「破坏写了相对路径、断言查绝对路径」→ 假阴性
    const file = path.resolve(ROOT, mut.file);
    const original = readBytes(file);
    restored.set(file, original);
    let okApply = true;
    try {
      const txt = original.toString('utf8');
      // ⚠️ EOL 容错：工作区是 CRLF（core.autocrlf=true），而多行锚点在脚本里写作 `\n`。
      // 不换算就会 `includes` 失败 ⇒ 该条被判"锚点未找到"而**跳过**（跳过 ≠ 通过）；
      // 实测上一次在 Windows 上就有 61 条这样静默消失，而 Linux/macOS 的 LF 检出看不出来。
      // 做法与 units-structure-check.mjs 一致：按目标文件实际的 EOL 重写锚点后再匹配。
      const eol = txt.includes('\r\n') ? '\r\n' : '\n';
      const find = txt.includes(mut.find) ? mut.find : mut.find.split('\n').join(eol);
      if (!txt.includes(find)) {
        console.log(`⚠ ${mut.name}\n    破坏锚点未找到（源文件已变？）—— 本条无法反证`);
        okApply = false;
        skipped += mut.expect.length;
      } else {
        // 内存破坏：只写 override 层（不写磁盘），断言经缓存读到的就是破坏后内容
        overrideFile(file, txt.replace(find, mut.replace.split('\n').join(eol)));
      }
      if (okApply) {
        const res = runAll(loadSources(), mut.expect);
        console.log(`🔴 ${mut.name}`);
        for (const id of mut.expect) {
          total++;
          const isRed = res[id] && res[id].ok === false;
          if (isRed) {
            red++;
            console.log(`  ✓ ${id} 按预期变红`);
          } else {
            falsePositives.push(id);
            console.log(`  ✗ ${id} 该红没红 ← 假阳性（断言测不到它声称捕捉的改错）`);
          }
          if (!wasGreenBase[id]) console.log(`     注：${id} 基线本就是红，无法据此判定断言有效性`);
        }
      }
    } finally {
      overrideFile(file, null); // 清除本条覆盖（磁盘从未被写，无需字节恢复）
    }
  }
  clearOverrides(); // 兜底清空覆盖层，防任何残留影响后续读

  // 恢复校验：所有被改文件必须与原始字节完全一致
  console.log('\n恢复校验');
  let restoreFail = 0;
  for (const [file, original] of restored) {
    if (original == null) continue;
    const back = existsSync(file) ? readFileSync(file) : null; // 直接读磁盘，确认从未被污染
    const same = back != null && back.equals(original);
    if (!same) restoreFail++;
    console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, file)} 字节${same ? '一致' : '不一致！'}`);
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红（应执行 ${expectedTotal} 条）`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（破坏锚点未找到）—— 跳过 ≠ 通过`);
  if (restoreFail) console.log(`✗ 有 ${restoreFail} 个文件未恢复到原始字节`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(', ')}`);
  process.exitCode = red === total && total === expectedTotal && skipped === 0 && restoreFail === 0 ? 0 : 1;
}
