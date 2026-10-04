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
  viteConfig: path.join(APP, 'vite.config.ts'),
  lyricsHtml: path.join(APP, 'lyrics.html'),
  desktopLyrics: path.join(APP, 'src', 'screens', 'lyrics', 'DesktopLyrics.tsx'),
  musicScreen: path.join(APP, 'src', 'screens', 'MusicScreen.tsx'),
  app: path.join(APP, 'src', 'App.tsx'),
  kernel: path.join(APP, 'src', 'components', 'MusicKernel.tsx'),
  playerBar: path.join(APP, 'src', 'screens', 'music', 'PlayerBar.tsx'),
  expanded: path.join(APP, 'src', 'screens', 'music', 'ExpandedPlayer.tsx'),
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
    viteConfig: readMaybe(F.viteConfig),
    lyricsHtml: readMaybe(F.lyricsHtml),
    desktopLyrics: readMaybe(F.desktopLyrics),
    musicScreen: readMaybe(F.musicScreen),
    app: readMaybe(F.app),
    kernel: readMaybe(F.kernel),
    playerBar: readMaybe(F.playerBar),
    expanded: readMaybe(F.expanded),
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

const GROUPS = ['RUST', 'IPC', 'PLATFORM', 'STORE', 'DUR', 'SEARCH', 'UI', 'PLAYER', 'HEARTBEAT', 'LYRICS'];
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
    find: '        y: next.y ?? -1,',
    replace: '        offset_y: next.y ?? -1,',
    expect: ['LYRICS.stateFieldMatch'],
  },
];

// ── 主流程 ────────────────────────────────────────────────────────────────
const refute = process.argv.includes('--refute');

console.log('音乐模块 · 四平台接通断言' + (refute ? ' · 反证轮' : ''));
console.log(`根目录：${ROOT}`);
console.log(`断言总数：${A.length}（RUST/IPC/PLATFORM/STORE/DUR/SEARCH/UI/PLAYER）`);

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
