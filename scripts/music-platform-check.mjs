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
  musicScreen: path.join(APP, 'src', 'screens', 'MusicScreen.tsx'),
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
    musicScreen: readMaybe(F.musicScreen),
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

const GROUPS = ['RUST', 'IPC', 'PLATFORM', 'STORE', 'DUR', 'SEARCH', 'UI'];
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
];

// ── 主流程 ────────────────────────────────────────────────────────────────
const refute = process.argv.includes('--refute');

console.log('音乐模块 · 四平台接通断言' + (refute ? ' · 反证轮' : ''));
console.log(`根目录：${ROOT}`);
console.log(`断言总数：${A.length}（RUST/IPC/PLATFORM/STORE/UI）`);

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
