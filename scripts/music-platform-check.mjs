#!/usr/bin/env node
/**
 * 音乐模块「四平台完整接通」验收断言（除汽水外）—— 且必须**可反证**。
 *
 * 为什么需要它（D-20「每层都要断言」+ D-31「假阳性比没测试更危险」）：
 *
 *   一条「四平台接通」的改动横跨五层：
 *     RUST     app/src-tauri/src/music/mod.rs 定义 + main.rs 的 generate_handler! 注册
 *     IPC      app/src/music/ipc.ts 的 invoke('<command>') 封装
 *     PLATFORM app/src/music/platform.ts 的能力矩阵 + 派发分支
 *     STORE    app/src/music/store.ts 的平台感知状态与 action
 *     UI       app/src/screens/MusicScreen.tsx + screens/music/* + styles/app.css
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
 *   node scripts/music-platform-check.mjs            正向跑（期望 RUST/IPC/PLATFORM/STORE 全绿）
 *   node scripts/music-platform-check.mjs --refute   反证轮（破坏源文件 → 断言必须变红 → 恢复）
 *
 * 注意：UI 层由另一位同事并行重写，**尚未落地是已知真实缺口**。脚本对这一层
 * 不假绿 —— 缺片段就直接标 ✗ 并写明「UI 尚未落地/待负责人复核」，让负责人看得见。
 *
 * 禁止事项：本脚本刻意**不写出**某个历史品牌标识的字面量（见下方 BANNED 的拆分构造），
 * 因为该标识本身就在被 forbid 的清单里，脚本自身也不得命中它。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = path.join(ROOT, 'app');

const F = {
  rustMod: path.join(APP, 'src-tauri', 'src', 'music', 'mod.rs'),
  rustModels: path.join(APP, 'src-tauri', 'src', 'music', 'models.rs'),
  rustMain: path.join(APP, 'src-tauri', 'src', 'main.rs'),
  ipc: path.join(APP, 'src', 'music', 'ipc.ts'),
  platform: path.join(APP, 'src', 'music', 'platform.ts'),
  store: path.join(APP, 'src', 'music', 'store.ts'),
  types: path.join(APP, 'src', 'music', 'types.ts'),
  // ── 桌面歌词（P3）──
  rustLyrics: path.join(APP, 'src-tauri', 'src', 'lyrics_window.rs'),
  capabilities: path.join(APP, 'src-tauri', 'capabilities', 'default.json'),
  tauriConf: path.join(APP, 'src-tauri', 'tauri.conf.json'),
  cargoToml: path.join(APP, 'src-tauri', 'Cargo.toml'),
  viteConfig: path.join(APP, 'vite.config.ts'),
  lyricsHtml: path.join(APP, 'lyrics.html'),
  desktopLyrics: path.join(APP, 'src', 'screens', 'lyrics', 'DesktopLyrics.tsx'),
  musicScreen: path.join(APP, 'src', 'screens', 'MusicScreen.tsx'),
  app: path.join(APP, 'src', 'App.tsx'),
  kernel: path.join(APP, 'src', 'components', 'MusicKernel.tsx'),
  island: path.join(APP, 'src', 'components', 'DynamicIsland.tsx'),
  audioGraph: path.join(APP, 'src', 'music', 'audioGraph.ts'),
  playerBar: path.join(APP, 'src', 'screens', 'music', 'PlayerBar.tsx'),
  expanded: path.join(APP, 'src', 'screens', 'music', 'ExpandedPlayer.tsx'),
  // 逐字歌词渲染组件（逐字高亮任务新增）
  karaoke: path.join(APP, 'src', 'screens', 'music', 'KaraokeLyrics.tsx'),
  // 六皮肤专属模块（展开播放器换肤任务新增）
  coverColor: path.join(APP, 'src', 'hooks', 'useCoverColor.ts'),
  vinylDisc: path.join(APP, 'src', 'screens', 'music', 'VinylDisc.tsx'),
  spectrumScene: path.join(APP, 'src', 'screens', 'music', 'SpectrumScene.tsx'),
  musicUiDir: path.join(APP, 'src', 'screens', 'music'),
  virtualList: path.join(APP, 'src', 'components', 'units', 'VirtualList.tsx'),
  css: path.join(APP, 'src', 'styles', 'app.css'),
  srcDir: path.join(APP, 'src'),
  rustSrcDir: path.join(APP, 'src-tauri', 'src'),
};

/** 被 forbid 的历史品牌标识 —— 拆成字符数组再 join，确保本脚本源码里不出现该字面量 */
const BANNED = ['n', 'e', 'x', 'b', 'o', 'x'].join('');

// ── 冻结的契约：命令清单（负责人冻结，本脚本照抄，不改口径） ──────────────
const CONTRACT = {
  netease: [
    'music_search', 'music_song_url', 'music_login_status', 'music_logout',
    'music_user_playlist', 'music_playlist_tracks', 'music_playlist_tracks_range',
    'music_playlist_detail', 'music_likelist', 'music_like', 'music_playlist_subscribe',
    'music_lyric', 'music_song_comments', 'music_personalized', 'music_recommend_songs',
    'music_recommend_resource', 'music_artist_search', 'music_playlist_search', 'music_artist_songs',
  ],
  kugou: [
    'kugou_search', 'kugou_song_url', 'kugou_lyric', 'kugou_login_status', 'kugou_logout',
    'kugou_user_playlists', 'kugou_playlist_tracks', 'kugou_playlist_tracks_range',
    'kugou_rank_list', 'kugou_rank_songs', 'kugou_like_toggle', 'kugou_liked_hashes',
    'kugou_artist_search', 'kugou_playlist_search', 'kugou_artist_songs', 'kugou_guess_like',
  ],
  qqmusic: [
    'qq_search', 'qq_song_url', 'qq_lyric', 'qq_login_status', 'qq_logout',
    'qq_user_playlists', 'qq_playlist_tracks', 'qq_playlist_tracks_range',
    'qq_rank_list', 'qq_rank_songs', 'qq_like_toggle', 'qq_liked_hashes',
    'qq_artist_search', 'qq_playlist_search', 'qq_artist_songs', 'music_qq_recommend_playlists',
  ],
  migu: [
    'migu_search', 'migu_song_url', 'migu_lyric', 'migu_login_status', 'migu_logout',
    'migu_user_playlists', 'migu_playlist_tracks', 'migu_playlist_tracks_range',
    'migu_rank_list', 'migu_rank_songs', 'migu_recommend_playlists',
    'migu_playlist_search', 'migu_artist_search', 'migu_artist_songs',
  ],
  multi: [
    'music_get_login_statuses', 'music_switch_provider', 'music_get_playback_source',
    'music_open_login_window',
  ],
};
const PLATFORM_KEYS = ['netease', 'kugou', 'qqmusic', 'migu'];

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
const readMaybe = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const readBytes = (p) => (existsSync(p) ? readFileSync(p) : null);

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
      else if (exts.some((x) => e.name.endsWith(x))) out.push(readFileSync(p, 'utf8'));
    }
  }
  return out.join('\n');
}

function loadSources() {
  const s = {
    rustMod: readMaybe(F.rustMod),
    rustMain: readMaybe(F.rustMain),
    ipc: readMaybe(F.ipc),
    platform: readMaybe(F.platform),
    store: readMaybe(F.store),
    types: readMaybe(F.types),
    rustLyrics: readMaybe(F.rustLyrics),
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
    css: readMaybe(F.css),
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
function stripComments(src) {
  let out = '';
  let state = 'code';
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
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out += c;
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
    if (state === 'sq' && c === "'") state = 'code';
    else if (state === 'dq' && c === '"') state = 'code';
    else if (state === 'tpl' && c === '`') state = 'code';
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

const CAP_KEYS = ['charts', 'chartGrid', 'chartByName', 'recommendPlaylists', 'dailySongs', 'comments', 'likeWrite', 'artistExtra'];

// ── 断言表：每条 { id, group, run(s) -> {ok, detail} } ─────────────────────
const A = [];
const add = (id, group, run) => A.push({ id, group, run });
const UI_GAP = 'UI 尚未落地（app/src/screens/music/ 缺失或缺关键片段）/待负责人复核';

// ============================ RUST ============================
for (const [plat, cmds] of Object.entries(CONTRACT)) {
  add(`RUST.defined.${plat}`, 'RUST', (s) => {
    const missing = cmds.filter((c) => !new RegExp(`\\bfn\\s+${esc(c)}\\s*\\(`).test(s.rustMod));
    return { ok: missing.length === 0, detail: missing.length ? `mod.rs 未定义：${missing.join(', ')}` : '' };
  });
}
for (const [plat, cmds] of Object.entries(CONTRACT)) {
  add(`RUST.registered.${plat}`, 'RUST', (s) => {
    const missing = cmds.filter((c) => !new RegExp(`music::${esc(c)}\\s*,`).test(s.rustMain));
    return {
      ok: missing.length === 0,
      detail: missing.length ? `main.rs generate_handler! 未注册：${missing.join(', ')}` : '',
    };
  });
}
add('RUST.noqishui', 'RUST', (s) => {
  // 汽水延后后不应有任何汽水命令：generate_handler! 块与 music/mod.rs 里都不得出现该标识
  const block = (() => {
    const i = s.rustMain.indexOf('generate_handler!');
    return i < 0 ? '' : s.rustMain.slice(i, s.rustMain.indexOf('])', i));
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
  for (const p of PLATFORM_KEYS) if (caps[p]) for (const k of CAP_KEYS) if (!(k in caps[p])) missingKey.push(`${p}.${k}`);
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
capCheck('comments', { 'netease.comments': true, 'kugou.comments': false, 'qqmusic.comments': false, 'migu.comments': false });
capCheck('chartGrid', { 'kugou.chartGrid': true, 'qqmusic.chartGrid': true, 'netease.chartGrid': false });
capCheck('chartByName', { 'migu.chartByName': true });
capCheck('dailySongs', { 'netease.dailySongs': true, 'kugou.dailySongs': false, 'qqmusic.dailySongs': false, 'migu.dailySongs': false });
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
    'switchPlaybackSource', 'setSearchProvider', 'loadAllLoginStatuses', 'loadLoginStatus',
    'loadCharts', 'loadRecommend', 'openRightChart', 'openRightPlaylist', 'openLeftPlaylist',
    'loadMoreLeft', 'loadMoreRight', 'loadLikedList', 'toggleLike', 'openLogin', 'logoutFor',
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
add('UI.platformSwitch', 'UI', (s) => ({
  ok: /\bPLATFORMS\b/.test(s.uiSource),
  detail: uiNote(s, '未读到平台切换 UI（PLATFORMS）'),
}));
add('UI.searchCapsule', 'UI', (s) => ({
  ok: /\bsearchProvider\b/.test(s.uiSource) && /\bsetSearchProvider\b/.test(s.uiSource),
  detail: uiNote(s, '未读到搜索源胶囊（searchProvider/setSearchProvider）'),
}));
add('UI.chartGrid', 'UI', (s) => ({
  ok: /\bchartGrid\b/.test(s.uiSource) || /charts\s+grid/i.test(s.uiSource),
  detail: uiNote(s, '未读到榜单网格形态（chartGrid / charts grid）'),
}));
add('UI.chartScroll', 'UI', (s) => ({
  ok: /scrollLeft\s*\+=/.test(s.uiSource) && /\bdeltaY\b/.test(s.uiSource),
  detail: uiNote(s, '未读到「滚轮纵向 → scrollLeft」横向滚动映射（scrollLeft += / deltaY）'),
}));
add('UI.dailyEntry', 'UI', (s) => ({
  ok: /\bdailySongs\b/.test(s.uiSource) || /setRightView\(\s*['"]daily['"]/.test(s.uiSource),
  detail: uiNote(s, "未读到每日推荐入口（dailySongs / setRightView('daily')）"),
}));
add('UI.playHistory', 'UI', (s) => ({
  ok: /\bplayHistoryList\b/.test(s.uiSource),
  detail: uiNote(s, '未读到播放历史视图（playHistoryList）'),
}));
add('UI.loadMore', 'UI', (s) => ({
  ok: /\bloadMoreLeft\b/.test(s.uiSource) || /\bloadMoreRight\b/.test(s.uiSource),
  detail: uiNote(s, '未读到歌单滚动加载（loadMoreLeft/loadMoreRight）'),
}));

/** 需要走虚拟滚动的长列表（行数无上界：歌单曲目可上千首、队列上限 2000） */
const ROW_LISTS = {
  'LeftPanel.tsx': '左栏「我的歌单 / 歌单曲目」',
  'RightPanel.tsx': '右栏「搜索结果 / 推荐歌单 / 曲目 / 每日推荐」',
  'HistoryView.tsx': '播放历史',
  'LocalView.tsx': '本地曲库',
  'QueueDrawer.tsx': '播放队列',
};

// 只断言「窗口化」的两条本质特征，不锁 rAF / ResizeObserver 这些优化手法 ——
// 后者被替换掉不影响「是否虚拟滚动」这个事实，锁死它们只会让断言在合法重构时误红。
add('UI.virtualList', 'UI', (s) => {
  const v = readMaybe(F.virtualList);
  if (!v) return { ok: false, detail: uiNote(s, '未读到 app/src/components/units/VirtualList.tsx') };
  const need = [
    [/items\.slice\(/, '按窗口切片渲染（items.slice）'],
    [/ui-vlist-inner/, '撑高元素（否则滚动条长度不反映真实内容）'],
  ];
  const missing = need.filter(([re]) => !re.test(v)).map(([, n]) => n);
  return { ok: missing.length === 0, detail: missing.length ? `虚拟列表缺：${missing.join('、')}` : '' };
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
  const sources = { 'store.ts': s.store, 'platform.ts': s.platform, 'ui': `${s.musicUi}\n${s.musicScreen}` };
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
  const missing = SEARCH_CMDS.filter(
    (n) => !new RegExp(`pub async fn ${esc(n)}\\([^)]*offset`).test(s.rustMod),
  );
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
  if (!/(^|\n)\s*height:\s*100%/.test(block)) missing.push('app.css 的 .music 未改成定高（仍是 min-height:100%，会撑出页面级滚动）');
  const cols = (s.css.match(/\.music-cols\s*\{([^}]*)\}/) || [, ''])[1];
  if (!/grid-template-rows\s*:\s*minmax\(\s*0\s*,/.test(cols)) {
    missing.push('.music-cols 未固定行高（缺 grid-template-rows: minmax(0, 1fr)，卡片会被内容撑开、失去内部滚动）');
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
  if (!k) return { ok: false, detail: '未读到 app/src/components/MusicKernel.tsx' };
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
  if (!/\bregisterAudioElement\s*\(\s*(?!null\b)/.test(k)) missing.push('挂载时未登记 audio 元素（未调用 registerAudioElement(元素)）');
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
  return { ok: missing.length === 0, detail: missing.length ? `app.css 缺进场/退场关键帧：${missing.join('、')}` : '' };
});
add('PLAYER.animEnter', 'PLAYER', (s) => {
  const rule = (s.css.match(/(?:^|\n)\.music-exp\s*\{([^}]*)\}/) || [, ''])[1];
  return { ok: /animation\s*:\s*music-exp-up/.test(rule), detail: 'app.css 的 .music-exp 未自带进场动画 music-exp-up' };
});
add('PLAYER.animClosing', 'PLAYER', (s) => {
  const rule = (s.css.match(/\.music-exp\.is-closing\s*\{([^}]*)\}/) || [, ''])[1];
  return { ok: /animation\s*:\s*music-exp-down/.test(rule), detail: 'app.css 的 .music-exp.is-closing 未播退场动画 music-exp-down' };
});
add('PLAYER.durationSync', 'PLAYER', (s) => {
  // 双向：CSS 的退场时长 ↔ store 的延时，两个数都取出来比对 —— 改一处忘另一处 = 动画没播完就消失
  const rule = (s.css.match(/\.music-exp\.is-closing\s*\{([^}]*)\}/) || [, ''])[1];
  const cssM = /animation\s*:\s*music-exp-down\s+([\d.]+)s/.exec(rule);
  const body = methodBody(stripComments(s.store), 'closeExpanded');
  const msM = body && /\}\s*,\s*(\d+)\s*\)\s*;/.exec(body);
  if (!cssM) return { ok: false, detail: 'app.css 未取到 .music-exp.is-closing 的退场时长（0.Ns）' };
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
  const ms = stripComments(s.musicScreen);
  const missing = [];
  if (!/closeExpanded\s*\(\s*\)/.test(ms)) missing.push('Esc 分支未走 closeExpanded()');
  if (/setExpanded\s*\(\s*false\s*\)/.test(ms)) missing.push('仍直接 setExpanded(false)');
  return { ok: missing.length === 0, detail: missing.length ? `MusicScreen Esc 收起：${missing.join('、')}` : '' };
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
    detail: calls === guarded
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
  const pb = stripComments(s.playerBar);
  const missing = [];
  if (!/\buseState\b/.test(pb)) missing.push('未用 useState 保存拖拽会话');
  if (!/\bdragMs\b/.test(pb) || !/\bsetDragMs\s*\(/.test(pb)) missing.push('缺本地拖拽状态 dragMs');
  if (!/onChange=\{[^}]*setDragMs\s*\(/.test(pb)) missing.push('onChange 未只做 setDragMs(');
  if (/onChange=\{[^}]*onSeek\s*\(/.test(pb)) missing.push('onChange 里直接调 onSeek(（退回逐帧提交）');
  if (!/\bonPointerUp\s*=/.test(pb)) missing.push('缺 onPointerUp 提交');
  if (!/\bonKeyUp\s*=/.test(pb)) missing.push('缺 onKeyUp 提交');
  return { ok: missing.length === 0, detail: missing.length ? `播放条进度条拖拽会话：${missing.join('、')}` : '' };
});
add('PLAYER.resolveWrites', 'PLAYER', (s) => {
  // D 组防回归：resolveOnlineUrl 此前从不写 currentQuality/currentBitrate → 播放条音质标签是假 UI
  const body = fnBodyAny(stripComments(s.store), 'resolveOnlineUrl');
  if (body == null) return { ok: false, detail: 'store.ts 未定义 resolveOnlineUrl' };
  const missing = [];
  if (!/\bcurrentQuality\b/.test(body)) missing.push('currentQuality 未写回');
  if (!/\bcurrentBitrate\b/.test(body)) missing.push('currentBitrate 未写回');
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `resolveOnlineUrl 缺回写：${missing.join('、')}（字段定义了却永远是空 —— 播放条音质标签是假 UI）`
      : '',
  };
});

// ── 心动模式（heartbeat · 拍板第 4 项）────────────────────────────────────
add('HEARTBEAT.modeInType', 'HEARTBEAT', (s) => {
  // 类型层：PlayMode 必须含 heartbeat，否则 store 里判它是"不可能状态"
  if (!/\bheartbeat\b/.test(s.types)) return { ok: false, detail: 'types.ts 的 PlayMode 未含 heartbeat' };
  return { ok: true, detail: '' };
});
add('HEARTBEAT.cycleFour', 'HEARTBEAT', (s) => {
  // cycleMode 的 order 数组必须含四档。**只判"含 heartbeat"不够** ——
  // 一旦有人把数组写成 ['list','shuffle','one','heartbeat','heartbeat'] 也能骗过"含"，
  // 但那样点两下就卡在同一档。判据改成"数组恰为四项"。
  const body = methodBody(stripComments(s.store), 'cycleMode');
  if (body == null) return { ok: false, detail: 'store.ts 未定义 cycleMode' };
  const m = body.match(/order:\s*PlayMode\[\]\s*=\s*\[([^\]]*)\]/);
  if (!m) return { ok: false, detail: 'cycleMode 里找不到 order 数组' };
  const items = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
  const want = ['list', 'shuffle', 'one', 'heartbeat'];
  const ok = items.length === want.length && want.every((w) => items.includes(w));
  return {
    ok,
    detail: ok ? '' : `cycleMode 档位应恰为 ${want.join('/')}，实为 ${items.join('/') || '(空)'}`,
  };
});
add('HEARTBEAT.warnsOnDegrade', 'HEARTBEAT', (s) => {
  // 降级必须**告诉用户**：切到心动档而平台不支持时，若静默降级成随机，
  // 用户会以为在听相似歌曲 —— 这与"假控件"同级的问题（D-37 的判据）。
  const body = methodBody(stripComments(s.store), 'cycleMode');
  if (body == null) return { ok: false, detail: 'store.ts 未定义 cycleMode' };
  const ok = /supportsSimilar/.test(body) && /\.toast\(/.test(body);
  return {
    ok,
    detail: ok ? '' : '切到心动档时未按平台能力提示降级（静默降级 = 假控件）',
  };
});
add('HEARTBEAT.nextUsesSimilar', 'HEARTBEAT', (s) => {
  // next 在 heartbeat 下必须真的走相似接口，而不是当 shuffle 处理
  const body = methodBody(stripComments(s.store), 'next');
  if (body == null) return { ok: false, detail: 'store.ts 未定义 next' };
  const missing = [];
  if (!/heartbeat/.test(body)) missing.push('未判 heartbeat');
  // ⚠️ 判"这条分支真的可达"，不能只判"代码里出现过 similarSongs(" ——
  // 把门禁写成 `&& false` 后调用照样在源码里，但运行时永远走不到（反证轮实测假阳性）。
  // 判据取**门禁条件本身**：必须仍是 supportsSimilar(get().playbackSource)，
  // 且它在同一条件里取反后有 fallbackNext 出口（不支持时走队列下一首，不是随机）。
  const gate = body.match(
    /playMode\s*===\s*'heartbeat'\s*&&\s*platform\.supportsSimilar\(\s*get\(\)\.playbackSource\s*\)/,
  );
  if (!gate) missing.push('心动分支被永久关闭（门禁取反）或未按平台能力分流');
  if (!/if\s*\(\s*playMode\s*===\s*'heartbeat'/.test(body)) missing.push('缺 heartbeat 入口判断');
  if (!/similarSongs\(/.test(body)) missing.push('未调 similarSongs');
  // 相似结果要替换队列（否则队列越滚越杂）
  if (!/playSong\(\s*nextSong\s*,\s*pick/.test(body)) missing.push('相似结果未作为新队列');
  // 必须排除当前这首（接口可能把它自己算进相似里 → 立刻重播同一首）
  if (!/songKey/.test(body)) missing.push('未按 songKey 排除当前曲');
  // 不支持相似 / 接口失败 / 拿到空结果，三条都要有降级出口
  const degrades = (body.match(/fallbackNext\(\)/g) || []).length;
  if (degrades < 2) missing.push(`降级出口只有 ${degrades} 处（空结果与异常各需一条）`);
  return { ok: missing.length === 0, detail: missing.length ? `next 的心动分支：${missing.join('、')}` : '' };
});
add('HEARTBEAT.platformGate', 'HEARTBEAT', (s) => {
  // 能力门禁：supportsSimilar 只对网易云为真。
  // 这条防的是"为了让它跑起来把门禁放开" —— 那会让三个平台都去调不存在的接口。
  if (!/supportsSimilar/.test(s.platform)) return { ok: false, detail: 'platform.ts 缺 supportsSimilar' };
  const body = fnBodyAny(stripComments(s.platform), 'supportsSimilar');
  if (body == null) return { ok: false, detail: 'platform.ts 未定义 supportsSimilar' };
  const ok = /netease/.test(body) && !/kugou/.test(body) && !/qqmusic/.test(body) && !/migu/.test(body);
  return {
    ok,
    detail: ok ? '' : 'supportsSimilar 应对非网易云一律 false（酷狗/QQ/咪咕无"按 songid 找相似"接口）',
  };
});
add('HEARTBEAT.fallbackExists', 'HEARTBEAT', (s) => {
  // 降级路径必须存在且是"队列下一首"（不是随机）：拿不到相似时
  // 直接静默停下或随机跳，都与"续播"语义不符。
  const body = methodBody(stripComments(s.store), 'fallbackNext');
  if (body == null) return { ok: false, detail: 'store.ts 未定义 fallbackNext' };
  const nextBody = methodBody(stripComments(s.store), 'next');
  if (nextBody == null) return { ok: false, detail: 'store.ts 未定义 next' };
  const ok = /fallbackNext\(\)/.test(nextBody) && /\+ 1\) %/.test(body);
  return {
    ok,
    detail: ok ? '' : '取不到相似歌曲时的降级路径不完整（应有 fallbackNext 且按队列顺序取）',
  };
});

// ── 桌面歌词（P3 · 拍板第 1 项）───────────────────────────────────────────
// 这一组断言的全都是「**静默失效**」型陷阱：每一条不满足时都不会报错，
// 只是某个功能在真机上悄悄不工作。所以必须逐条锁死。
add('LYRICS.rustCommands', 'LYRICS', (s) => {
  // 只定义不注册 = 不可调用，两层都要独立测到（与 RUST 组的判据同源）
  if (!s.rustLyrics) return { ok: false, detail: 'src-tauri/src/lyrics_window.rs 不存在' };
  const need = ['open_lyrics_window', 'close_lyrics_window', 'lyrics_push'];
  const missing = need.filter((n) => !new RegExp(`fn\\s+${n}\\s*\\(`).test(s.rustLyrics));
  const notRegd = need.filter((n) => !new RegExp(`lyrics_window::${n}`).test(s.rustMain));
  if (missing.length) return { ok: false, detail: `未定义：${missing.join('、')}` };
  if (notRegd.length)
    return { ok: false, detail: `已定义但未在 main.rs 注册（调用会抛 command not found）：${notRegd.join('、')}` };
  return { ok: true, detail: '' };
});
add('LYRICS.sameOrigin', 'LYRICS', (s) => {
  // ⚠️ 本条是**整条 P3 最关键**的一条：用 External 加载歌词窗 → 跨 origin →
  // localStorage 隔离 → 歌词窗读不到主窗写的字号/高亮色/锁定态。
  // 与官方登录窗口（用 External）是**不同场景**，照抄就错。
  if (!s.rustLyrics) return { ok: false, detail: 'lyrics_window.rs 不存在' };
  const usesApp = /WebviewUrl::App\(\s*"lyrics\.html"/.test(s.rustLyrics);
  if (!usesApp) {
    const usesExternal = /WebviewUrl::External/.test(s.rustLyrics);
    return {
      ok: false,
      detail: usesExternal
        ? '歌词窗用了 WebviewUrl::External → 跨 origin → localStorage 隔离（读不到偏好）'
        : '未找到 WebviewUrl::App("lyrics.html")（歌词窗必须加载应用自身页面才同 origin）',
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
  // 单入口时 dist 里没有 lyrics.html，Rust 的 WebviewUrl::App("lyrics.html") 会加载失败
  if (!s.viteConfig) return { ok: false, detail: 'app/vite.config.ts 不存在' };
  if (!/lyrics:\s*new URL\(\s*"\.\/lyrics\.html"/.test(s.viteConfig))
    return { ok: false, detail: 'vite 未把 lyrics.html 配成第二个入口（dist 里不会有它）' };
  if (!s.lyricsHtml) return { ok: false, detail: 'app/lyrics.html 不存在' };
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
  if (!/lyrics_window::resize_lyrics_window/.test(s.rustMain)) missing.push('main.rs 未注册');
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
  if (!/\.connect\([^)]*destination\s*\)/.test(g))
    missing.push('音频图未接回 destination（接管即静音）');
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

// ── 桌面歌词：状态补拉 / 控制桥 ─────────────────────────────────────────────
// 这一组防的都是**跨窗口且不报错**的失效：事件丢了、指令没人接、命令没注册 ——
// 症状统一是"点了没反应 / 一打开是空的"，而日志干干净净。

add('LYRICS.stateBackfill', 'LYRICS', (s) => {
  // 防「刚打开桌面歌词时歌词区是空的，暂停再播放才正常」回归。
  // 根因：主窗建窗后**立刻**推送，而那一刻歌词窗的 `listen` 尚未注册，
  // 那条事件必然丢失（Tauri 事件不缓存、不回放）。
  // 修法三环节缺任一，症状都会原样复现：
  //   Rust 缓存 → get_lyrics_state 命令 → **在 main.rs 注册** → 歌词窗挂载后补拉
  const rust = stripComments(s.rustLyrics ?? '');
  const dl = stripComments(s.desktopLyrics ?? '');
  const main = stripComments(s.rustMain ?? '');
  const missing = [];
  // ⚠️ 判据必须精确到"**写入**那一步"，不能只查标识符存在：
  // 把 `*g = Some(payload.clone())` 删掉（缓存永不写入＝机制等于没有）断言仍会绿；
  // 把变量改名成 `LAST_LYRICS_X` 也一样（子串仍匹配）。本项目已因此栽过 5 次。
  if (!/LAST_LYRICS\s*\.\s*lock\(\)[\s\S]{0,160}?payload\s*\.\s*clone\(\)/.test(rust))
    missing.push('Rust 未把载荷写入缓存');
  if (!/fn\s+get_lyrics_state/.test(rust)) missing.push('缺 get_lyrics_state 命令');
  // 定义了但没注册 → 调用时报"命令不存在"（且被 catch 吞掉），是经典的不报错失效
  if (!/get_lyrics_state/.test(main)) missing.push('get_lyrics_state 未在 main.rs 注册');
  if (!/get_lyrics_state/.test(dl)) missing.push('歌词窗未补拉（挂载后仍是空的）');
  // 顺序：**先 listen 再补拉**。反过来的话，注册与拉取之间的事件会漏掉。
  const iListen = dl.indexOf("listen<LyricsPayload | LyricsPrefsPayload>('lyrics://state'");
  const iPull = dl.indexOf('get_lyrics_state');
  if (iListen >= 0 && iPull >= 0 && iPull < iListen)
    missing.push('顺序错：先补拉后注册 listen（中间会漏事件）');
  return { ok: missing.length === 0, detail: missing.length ? `状态补拉：${missing.join('、')}` : '' };
});

add('LYRICS.controlBridge', 'LYRICS', (s) => {
  // 桌面歌词控制栏是**跨窗口**的：歌词窗点按钮 → Rust 转发 → 主窗执行。
  // 四环节任一缺失，症状都是「点了没反应」且**不报任何错**：
  //   ① 歌词窗没发指令 ② Rust 没定义命令 ③ 定义了没注册 ④ 主窗没监听
  const dl = stripComments(s.desktopLyrics ?? '');
  const rust = stripComments(s.rustLyrics ?? '');
  const main = stripComments(s.rustMain ?? '');
  const kernel = stripComments(s.kernel ?? '');
  const missing = [];
  if (!/lyrics_control/.test(dl)) missing.push('歌词窗未发控制指令');
  if (!/fn\s+lyrics_control/.test(rust)) missing.push('Rust 缺 lyrics_control 命令');
  if (!/lyrics_control/.test(main)) missing.push('lyrics_control 未在 main.rs 注册');
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
  if (!/sentAtEpoch\s*:\s*Date\.now\(\)[\s\S]{0,240}?playMode/.test(store))
    missing.push('store 推送时未带 playMode');
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
  const store = stripComments(s.store ?? '');
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
  const store = stripComments(s.store ?? '');
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
  // ③ 渲染层必须有**无逐字**的行级插值分支（smoothstep），否则退化路径到不了画面
  if (!kara) missing.push('未读到 KaraokeLyrics.tsx');
  else if (!/\bsmoothstep\b/.test(kara)) missing.push('渲染层缺无逐字的行级插值（smoothstep）分支');
  return { ok: missing.length === 0, detail: missing.length ? `行级插值退化路径：${missing.join('、')}` : '' };
});

add('LYRICS.karaRender', 'LYRICS', (s) => {
  // 渲染层三要素：双层叠加 + RAF 驱动 + mask 柔边 + width 裁切。
  // 任缺其一，卡拉OK效果不成立，但页面照常显示歌词（静默降级）。
  const kara = stripComments(s.karaoke ?? '');
  if (!kara) return { ok: false, detail: '未读到 KaraokeLyrics.tsx' };
  const missing = [];
  // ① 双层：同一行文本渲染两次，且两层 class 齐全。
  // ⚠️ 类名判据必须**排除子串**：`kara-over` 是 `kara-over-disabled` 的子串，
  // 用裸子串匹配的话，把顶层类名改坏（导致双层退化成单层）断言仍会绿 ——
  // 反证轮实测抓到了这个假阳性，故改用「前后不得紧跟 \w 或 -」的精确词边界。
  if (!/(?<![\w-])kara-under(?![\w-])/.test(kara)) missing.push('缺底层（未唱）元素 kara-under');
  if (!/(?<![\w-])kara-over(?![\w-])/.test(kara)) missing.push('缺顶层（已唱）元素 kara-over');
  const textRenders = (kara.match(/\{line\.text\}/g) || []).length;
  if (textRenders < 2) missing.push(`同一行文本只渲染了 ${textRenders} 次（双层需 ≥2 次）`);
  // ② RAF 推进，且**不得**用 setInterval（后台被节流到 ~1Hz → 推进一跳一跳）
  if (!/requestAnimationFrame\s*\(/.test(kara)) missing.push('未用 requestAnimationFrame');
  if (!/cancelAnimationFrame\s*\(/.test(kara)) missing.push('未清理 RAF（cancelAnimationFrame）');
  if (/setInterval\s*\(/.test(kara)) missing.push('用了 setInterval（后台节流 → 推进一跳一跳）');
  // ③ width 裁切 + mask 柔边（含 -webkit- 前缀）
  if (!/style\.width\s*=/.test(kara)) missing.push('未用 width 裁切驱动顶层');
  if (!/maskImage/.test(kara) || !/linear-gradient/.test(kara)) missing.push('缺顶层 mask 渐变（裁切边会是硬线）');
  if (!/WebkitMaskImage/.test(kara)) missing.push('缺 -webkit- mask 前缀');
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
  if (/querySelector\(\s*['"]audio['"]\s*\)/.test(kara)) missing.push("自行 querySelector('audio')（应经 audioGraph 入口）");
  return { ok: missing.length === 0, detail: missing.length ? `逐字时间来源：${missing.join('、')}` : '' };
});

// ============================ SKIN（展开播放器六皮肤）============================
// 六皮肤必须各自是一整套视觉（背景/文字/专属组件/布局分支），而不是"只换一行 background"。
// 这一组的判据全部**限定作用域**（只看 ExpandedPlayer / 三个专属模块 / app.css 音乐区段），
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
  const missing = ['--skin-bg', '--skin-text', '--skin-sub', '--skin-hover', '--skin-blur']
    .filter((v) => !new RegExp(`['"]?${esc(v)}['"]?\\s*:`).test(e));
  const css = s.css ?? '';
  if (!/background:\s*var\(--skin-bg/.test(css)) missing.push('app.css 未消费 --skin-bg');
  if (!/backdrop-filter:\s*var\(--skin-blur/.test(css)) missing.push('app.css 未消费 --skin-blur');
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
  // 唱片旋转：app.css 有 skin-vinyl-spin keyframes 且盘体引用了它，转满 360°
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
  if (all !== cond) return { ok: false, detail: `有 ${all - cond} 处 animationPlayState 未跟随 isPlaying（该层暂停仍在转）` };
  return { ok: true, detail: '' };
});

add('SKIN.spectrumNoLyrics', 'SKIN', (s) => {
  // 音域回响激活时**不渲染歌词**（参考实现如此）：歌词面板被 !isSpectrum 守卫
  const e = stripComments(s.expanded ?? '');
  if (!/<KaraokeLyrics\b/.test(e)) return { ok: false, detail: '未渲染 <KaraokeLyrics>' };
  if (!/\{!isSpectrum\s*\?/.test(e)) return { ok: false, detail: '歌词面板未被 !isSpectrum 守卫（音域回响下仍会显示歌词）' };
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
  if (!/@keyframes\s+skin-spectrum-pulse\b/.test(s.css ?? '')) missing.push('app.css 缺降级动画 keyframes');
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
  if (!/\.music-exp-body\.is-immersive\s+\.music-lyr-line\b/.test(css)) missing.push('app.css 缺沉浸放大歌词规则');
  if (!/\.music-exp-body\.is-immersive\s+\.music-exp-lyr-box\b/.test(css)) missing.push('app.css 缺沉浸居中规则');
  return { ok: missing.length === 0, detail: missing.length ? `沉浸布局：${missing.join('、')}` : '' };
});

add('SKIN.vinylLayoutLeftAlign', 'SKIN', (s) => {
  // 彩胶/封面渐染：歌词左对齐（KaraokeLyrics 新增 align prop 只切类名，不改动画/双层逻辑）
  const css = s.css ?? '';
  const kara = stripComments(s.karaoke ?? '');
  const missing = [];
  if (!/align/.test(kara)) missing.push('KaraokeLyrics 未新增 align prop');
  if (!/is-left/.test(kara)) missing.push('KaraokeLyrics 未按 align 切 is-left 类名');
  if (!/\.music-exp-lyr-box\.is-left\s+\.music-lyr-line\b/.test(css)) missing.push('app.css 缺左对齐歌词规则');
  return { ok: missing.length === 0, detail: missing.length ? `左对齐歌词：${missing.join('、')}` : '' };
});

// ── 执行器 ────────────────────────────────────────────────────────────────
function runAll(s) {
  const res = {};
  for (const a of A) {
    try {
      const r = a.run(s);
      res[a.id] = { ok: !!r.ok, detail: r.detail || '' };
    } catch (e) {
      res[a.id] = { ok: false, detail: `断言抛错：${e.message}` };
    }
  }
  return res;
}

const GROUPS = ['RUST', 'IPC', 'PLATFORM', 'STORE', 'DUR', 'SEARCH', 'UI', 'PLAYER', 'HEARTBEAT', 'LYRICS', 'AUDIO', 'SKIN'];
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
    find: "  { id: 'kugou', label: '酷狗音乐', short: '酷', color: '#00A0E9', desc: '千万曲库 · 高品质音效' },\n",
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
    file: F.store,
    find: '      officialCharts: [],\n      recommendPlaylists: [],\n      dailySongs: [],\n',
    replace: '      // [refute] 清空逻辑被移除\n',
    expect: ['STORE.switchClears'],
  },
  {
    name: '把 store.ts 的 toggleLike action 改名（模拟漏实现）',
    file: F.store,
    // 锚点只取到参数表左括号为止：参数名会随实现调整（如 songId → song），
    // 若把参数名写进锚点，一次合法重构就会让这条反证静默失效（「无法反证」≠「已证伪」）。
    find: '  toggleLike: async (',
    replace: '  toggleLikeDisabled: async (',
    expect: ['STORE.actions'],
  },
  {
    name: '从 main.rs 的 generate_handler! 里摘掉 migu_rank_songs 注册（定义仍在）',
    file: F.rustMain,
    find: '            music::migu_rank_songs,\n',
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
    name: "把 ipc.ts 的 kugou_rank_list 命令名写错一个字",
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
    file: F.store,
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
    file: F.store,
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
    file: F.store,
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
    file: F.css,
    find: '@keyframes music-exp-down {',
    replace: '@keyframes music-exp-gone {',
    expect: ['PLAYER.animKeyframes'],
  },
  {
    name: '把 .music-exp 的进场动画那行删掉',
    file: F.css,
    find: '  animation: music-exp-up 0.34s cubic-bezier(0.4, 0, 0.2, 1);\n',
    replace: '',
    expect: ['PLAYER.animEnter'],
  },
  {
    name: '把 .is-closing 的退场动画指向 music-exp-up（不再下播）',
    file: F.css,
    find: 'animation: music-exp-down 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards;',
    replace: 'animation: music-exp-up 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards;',
    expect: ['PLAYER.animClosing'],
  },
  {
    name: '把 CSS 里 .is-closing 的 0.3s 改成 0.5s（退场时长两处不一致）',
    file: F.css,
    find: 'animation: music-exp-down 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards;',
    replace: 'animation: music-exp-down 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards;',
    expect: ['PLAYER.durationSync'],
  },
  {
    name: '把 next() 里 { expand: false } 删掉（自动切歌会弹开播放器）',
    file: F.store,
    // 破坏必须**清掉全部** playSong 的 expand:false —— 断言判的是"每条路径都传了"，
    // 只删一处它仍为真（这个假阳性是反证轮实测抓出来的，不是推理出来的）
    find: '    void get().playSong(queue[idx], undefined, { expand: false });',
    replace: '    void get().playSong(queue[idx], undefined);',
    expect: ['PLAYER.nextExpandFalse'],
  },
  {
    name: '把 prev() 里 { expand: false } 删掉',
    file: F.store,
    find:
      '        : (currentIndex - 1 + queue.length) % queue.length;\n    void get().playSong(queue[idx], undefined, { expand: false });',
    replace:
      '        : (currentIndex - 1 + queue.length) % queue.length;\n    void get().playSong(queue[idx], undefined);',
    expect: ['PLAYER.prevExpandFalse'],
  },
  {
    name: '把 playSong 的 opts?.expand 判定去掉（永远展开）',
    file: F.store,
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
    name: '把 MusicScreen 的 Esc 分支改回 setExpanded(false)',
    file: F.musicScreen,
    find: '        closeExpanded();',
    replace: '        setExpanded(false);',
    expect: ['PLAYER.escPath'],
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

  // ── PLAYER · D 实际音质回写 ───────────────────────────────────────────
  {
    name: '把 resolveOnlineUrl 里 currentBitrate 的写入删掉（音质标签变假 UI）',
    file: F.store,
    find: '    currentBitrate: r.br || 0,\n',
    replace: '',
    expect: ['PLAYER.resolveWrites'],
  },

  // ── HEARTBEAT 心动模式 ────────────────────────────────────────────────
  {
    name: '把 cycleMode 的档位数组退回三档（去掉心动）',
    file: F.store,
    find: "    const order: PlayMode[] = ['list', 'shuffle', 'one', 'heartbeat'];",
    replace: "    const order: PlayMode[] = ['list', 'shuffle', 'one'];",
    expect: ['HEARTBEAT.cycleFour'],
  },
  {
    name: '档位数组里 heartbeat 写两遍（点两下卡在同一档）',
    file: F.store,
    find: "    const order: PlayMode[] = ['list', 'shuffle', 'one', 'heartbeat'];",
    replace:
      "    const order: PlayMode[] = ['list', 'shuffle', 'one', 'heartbeat', 'heartbeat'];",
    expect: ['HEARTBEAT.cycleFour'],
  },
  {
    name: '删掉切心动档时的降级提示（静默降级 = 假控件）',
    file: F.store,
    find: "    if (nextMode === 'heartbeat' && !platform.supportsSimilar(get().playbackSource)) {",
    replace: '    if (false) {',
    expect: ['HEARTBEAT.warnsOnDegrade'],
  },
  {
    name: '让 next 把 heartbeat 当普通队列顺序（不走相似续播）',
    file: F.store,
    // 锚点只取到函数名的左括号，与参数/后续实现解耦（避免合法重构后静默失效）
    find: "if (playMode === 'heartbeat' && platform.supportsSimilar(get().playbackSource)) {",
    replace: "if (playMode === 'heartbeat' && false) {",
    expect: ['HEARTBEAT.nextUsesSimilar'],
  },
  {
    name: '相似结果不作为新队列（playSong 丢掉 pick，退回追加语义）',
    file: F.store,
    find: '          await get().playSong(nextSong, pick, { expand: false });',
    replace: '          await get().playSong(nextSong, undefined, { expand: false });',
    expect: ['HEARTBEAT.nextUsesSimilar'],
  },
  {
    name: '把 supportsSimilar 对酷狗也放开（酷狗无"按 songid 找相似"接口）',
    file: F.platform,
    find: "export function supportsSimilar(provider: MusicProvider): boolean {\n  return provider === 'netease';\n}",
    replace:
      "export function supportsSimilar(provider: MusicProvider): boolean {\n  return provider === 'netease' || provider === 'kugou';\n}",
    expect: ['HEARTBEAT.platformGate'],
  },
  {
    name: '删掉 fallbackNext（取不到相似时无处降级）',
    file: F.store,
    find: '  fallbackNext: () => {',
    replace: '  fallbackRemoved: () => {',
    expect: ['HEARTBEAT.fallbackExists'],
  },

  // ── LYRICS 桌面歌词 ──────────────────────────────────────────────────
  {
    name: '从 main.rs 摘掉 lyrics_push 注册（定义仍在但调不到）',
    file: F.rustMain,
    find: '            lyrics_window::lyrics_push,',
    replace: '',
    expect: ['LYRICS.rustCommands'],
  },
  {
    name: '歌词窗改用 WebviewUrl::External（跨 origin → 读不到偏好）',
    file: F.rustLyrics,
    find: 'WebviewUrl::App("lyrics.html".into())',
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
    find: '        lyrics: new URL("./lyrics.html", import.meta.url).pathname,\n',
    replace: '',
    expect: ['LYRICS.viteMultiEntry'],
  },
  {
    // 这条模拟的是最容易发生的真实事故：有人为了让歌词"跟得更准"就顺手加一次推送
    name: '在 setProgress 里加一次桌面歌词推送（每秒数次 → 打满事件通道）',
    file: F.store,
    find: '  setProgress: (ms) => set({ progressMs: ms }),',
    replace:
      '  setProgress: (ms) => { set({ progressMs: ms }); void get().pushLyricsState(); },',
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
    name: "去掉 <audio> 的 crossOrigin（网络歌曲被音频图接管后静音）",
    file: "app/src/components/MusicKernel.tsx",
    find: "      crossOrigin={corsMode ? 'anonymous' : undefined}",
    replace: "      crossOrigin={undefined}",
    expect: ["AUDIO.corsMode"],
  },
  {
    name: "去掉 CORS 回退里的 markNotWirable 标记（回退后在非 CORS 下被接管 → 静音）",
    file: "app/src/components/MusicKernel.tsx",
    find: "          markNotWirable(a);",
    replace: "          void a;",
    expect: ["AUDIO.fallback"],
  },
  {
    name: "让 isWirable 不再检查 CORS 模式（非 CORS 元素也会被接管）",
    file: "app/src/music/audioGraph.ts",
    find: "  return el.crossOrigin === 'anonymous';",
    replace: "  return true;",
    expect: ["AUDIO.refuseNonCors"],
  },
  {
    name: "去掉 gain → destination 的连接（接管即静音）",
    file: "app/src/music/audioGraph.ts",
    find: "      gain.connect(ctx.destination); // 唯一出口：不接回 destination = 静音",
    replace: "      void gain; // 反证：不接回出口",
    expect: ["AUDIO.connectDestination"],
  },
  {
    name: "在灵动岛里再建一次音频图（第二个调用方会抛 InvalidStateError）",
    file: "app/src/components/DynamicIsland.tsx",
    find: "      const got = await attachAnalyser(findAudioElement());",
    replace: "      const got = await attachAnalyser(findAudioElement());\n      const __probe = (window as unknown as { createMediaElementSource?: unknown })\n        .createMediaElementSource;\n      void __probe;",
    expect: ["AUDIO.singleEntry"],
  },
  {
    name: "Rust 不再把载荷写入缓存（歌词窗补拉永远拿到空 → 打开还是没歌词）",
    file: "app/src-tauri/src/lyrics_window.rs",
    find: "        *g = Some(payload.clone());",
    replace: "        let _ = &mut g;",
    expect: ["LYRICS.stateBackfill"],
  },
  {
    name: "歌词窗去掉挂载后的补拉（回到\"暂停再播放才显示\"）",
    file: "app/src/screens/lyrics/DesktopLyrics.tsx",
    find: "        const cached = await invoke<LyricsPayload | LyricsPrefsPayload | null>('get_lyrics_state');",
    replace: "        const cached = null as LyricsPayload | LyricsPrefsPayload | null;",
    expect: ["LYRICS.stateBackfill"],
  },
  {
    name: "main.rs 不注册 lyrics_control（调用报\"命令不存在\"，被 catch 吞掉）",
    file: "app/src-tauri/src/main.rs",
    find: "            lyrics_window::lyrics_control,",
    replace: "            // lyrics_window::lyrics_control,",
    expect: ["LYRICS.controlBridge"],
  },
  {
    name: "主窗不处理 next 动作（该按钮点了没反应）",
    file: "app/src/components/MusicKernel.tsx",
    find: "            case 'next':\n              s.next();\n              break;",
    replace: "            case 'unused-next':\n              break;",
    expect: ["LYRICS.controlBridge"],
  },
  {
    name: "cycle-mode 后不补推状态（歌词窗模式图标滞后，像点了没反应）",
    file: "app/src/components/MusicKernel.tsx",
    find: "              void s.pushLyricsState();",
    replace: "              void 0;",
    expect: ["LYRICS.modeIconSync"],
  },
  {
    name: "store 推送时不带 playMode（歌词窗永远显示默认模式）",
    file: "app/src/music/store.ts",
    find: "      // 播放模式要跟着走：歌词窗的控制栏靠它显示正确的模式图标（两窗 store 互不可见）\n      playMode,",
    replace: "      // 反证：不带 playMode",
    expect: ["LYRICS.playModeContract"],
  },

  // ── LYRICS 逐字歌词（卡拉OK）────────────────────────────────────────
  {
    name: '把 parseYrc 改名（模拟"定义了但没接进来"）',
    file: F.store,
    find: 'export function parseYrc(yrc: string): ParsedLyricLine[] {',
    replace: 'export function parseYrcDisabled(yrc: string): ParsedLyricLine[] {',
    expect: ['LYRICS.parseYrcUsed'],
  },
  {
    // 模拟"只留定义、删掉调用"—— 这是「只查标识符存在」型断言最经典的漏网方式
    name: 'loadLyrics 不再调用 parseYrc（只走 LRC，逐字高亮静默失效）',
    file: F.store,
    find: "        lines = l.yrc ? parseYrc(l.yrc) : parseLrc(l.lyric || '');\n",
    replace: "        lines = parseLrc(l.lyric || '');\n",
    expect: ['LYRICS.parseYrcUsed'],
  },
  {
    // 本任务最关键的反证：破坏「无 yrc 时的行级插值」—— 绝大多数歌走的就是这条路
    name: 'finalizeLineDurations 去掉 [0.45, 12] 夹紧（退化路径失去边界保护）',
    file: F.store,
    find: '    lines[i].duration = Math.max(0.45, Math.min(12, lines[i].duration as number));\n',
    replace: '    lines[i].duration = lines[i].duration as number;\n',
    expect: ['LYRICS.lineInterpolation'],
  },
  {
    name: 'parseLrc 不再补 duration（LRC 退化路径断头 → 无 yrc 的歌没有推进跨度）',
    file: F.store,
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
    find: '            boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.28), inset 0 0 60px ${hexToRgba(accentColor, 0.35)}`,\n            animationPlayState: isPlaying ? \'running\' : \'paused\',',
    replace: '            boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.28), inset 0 0 60px ${hexToRgba(accentColor, 0.35)}`,\n            animationPlayState: \'running\',',
    expect: ['SKIN.vinylPause'],
  },
  {
    name: '波纹层类名改坏（沉浸专属视觉丢失）',
    file: F.expanded,
    find: '          className="skin-ripple-layer"',
    replace: '          className="skin-ripple-layer-off"',
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
    name: "从音频图里去掉 GainNode（音量退回依赖元素 volume，部分平台会失效）",
    file: "app/src/music/audioGraph.ts",
    find: "    gain = gain ?? ctx.createGain();",
    replace: "    gain = gain ?? null;",
    expect: ["AUDIO.connectDestination"],
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
    if (uiFail) console.log(`  · UI 组有 ${uiFail} 条未通过 —— 该层由另一位同事并行重写，属已知真实缺口，待其落地后复跑。`);
    if (fail > uiFail) console.log(`  · 非 UI 组存在未通过项，请按上面 ✗ 的 detail 定位（是脚本写错还是真实缺口，勿为转绿而放宽断言）。`);
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
    const original = readBytes(mut.file);
    restored.set(mut.file, original);
    let okApply = true;
    try {
      const txt = original.toString('utf8');
      if (!txt.includes(mut.find)) {
        console.log(`⚠ ${mut.name}\n    破坏锚点未找到（源文件已变？）—— 本条无法反证`);
        okApply = false;
        skipped += mut.expect.length;
      } else {
        writeFileSync(mut.file, txt.replace(mut.find, mut.replace));
      }
      if (okApply) {
        const res = runAll(loadSources());
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
      if (original != null) writeFileSync(mut.file, original); // 精确按字节恢复
    }
  }

  // 恢复校验：所有被改文件必须与原始字节完全一致
  console.log('\n恢复校验');
  let restoreFail = 0;
  for (const [file, original] of restored) {
    if (original == null) continue;
    const back = readBytes(file);
    const same = back != null && back.equals(original);
    if (!same) restoreFail++;
    console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, file)} 字节${same ? '一致' : '不一致！'}`);
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红（应执行 ${expectedTotal} 条）`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（破坏锚点未找到）—— 跳过 ≠ 通过`);
  if (restoreFail) console.log(`✗ 有 ${restoreFail} 个文件未恢复到原始字节`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(', ')}`);
  process.exitCode =
    red === total && total === expectedTotal && skipped === 0 && restoreFail === 0 ? 0 : 1;
}
