#!/usr/bin/env node
/**
 * 番剧模块（anime）的**接线断言** —— 纯源码分析，秒级。
 *
 * ## 与 `check:anime` 的分工
 * `check:anime`（service 层）证的是「animesvc 与 mangasvc 能同时跑、落点/令牌/库隔离」；
 * 本脚本证的是**壳层与前端有没有把它接上**：别名、路由、IA、屏装配、IPC 命令名、
 * 命令注册、样式分片、设置分组、文档同步。
 *
 * 为什么必须单独钉：这些挂点**缺一个都不会报错**——
 *   · 别名只加 vite 不加 tsconfig ⇒ dev 能跑、`tsc` 报错或反向；
 *   · 屏装配件漏登记 ⇒ `/anime` 走进 `ScreenPane` 取到 `undefined`，白屏；
 *   · 命令写了但漏登记 handler ⇒ 编译全绿，运行时 "command not found"；
 *   · 样式分片漏注册 ⇒ 文件在、样式不生效；
 *   · 文档漏同步 ⇒ 下一个人按文档加模块，静默少一步。
 *
 * 用法：node e2e/anime-module-check.mjs [--refute]
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const F = {
  vite: path.join(ROOT, 'vite.config.ts'),
  tsconfig: path.join(ROOT, 'tsconfig.json'),
  routes: path.join(ROOT, 'src', 'router', 'routes.ts'),
  nav: path.join(ROOT, 'src', 'stores', 'nav.ts'),
  panes: path.join(ROOT, 'src', 'router', 'panes', 'index.tsx'),
  animePane: path.join(ROOT, 'src', 'router', 'panes', 'AnimePane.tsx'),
  app: path.join(ROOT, 'src', 'App.tsx'),
  screen: path.join(ROOT, 'src', 'screens', 'AnimeScreen.tsx'),
  screensDir: path.join(ROOT, 'src', 'screens', 'anime'),
  module: path.join(ROOT, 'src', 'modules', 'anime'),
  store: path.join(ROOT, 'src', 'modules', 'anime', 'store.ts'),
  actionNav: path.join(ROOT, 'src', 'modules', 'anime', 'actions', 'navigation.ts'),
  actionLib: path.join(ROOT, 'src', 'modules', 'anime', 'actions', 'library.ts'),
  ipc: path.join(ROOT, 'src', 'modules', 'anime', 'ipc.ts'),
  prefs: path.join(ROOT, 'src', 'modules', 'anime', 'prefs.ts'),
  convertTs: path.join(ROOT, 'src', 'modules', 'anime', 'convert.ts'),
  selectorsTs: path.join(ROOT, 'src', 'modules', 'anime', 'selectors.ts'),
  optionsTs: path.join(ROOT, 'src', 'modules', 'anime', 'player-options.ts'),
  typesTs: path.join(ROOT, 'src', 'modules', 'anime', 'types.ts'),
  sliceTs: path.join(ROOT, 'src', 'modules', 'anime', 'slice.ts'),
  settingsCatalog: path.join(ROOT, 'src', 'modules', 'anime', 'settings-catalog.ts'),
  settingsScreen: path.join(ROOT, 'src', 'screens', 'SettingsScreen.tsx'),
  settingsCatalogMain: path.join(ROOT, 'src', 'screens', 'settings', 'catalog.ts'),
  animeSettings: path.join(ROOT, 'src', 'screens', 'anime', 'AnimeSettingsSection.tsx'),
  sourceScreen: path.join(ROOT, 'src', 'screens', 'anime', 'SourceScreen.tsx'),
  style: path.join(ROOT, 'src', 'styles', 'anime.scss'),
  styleIndex: path.join(ROOT, 'src', 'styles', 'index.scss'),
  playerModule: path.join(ROOT, 'src', 'modules', 'anime', 'player.ts'),
  playerHook: path.join(ROOT, 'src', 'hooks', 'use-anime-playback.ts'),
  playerScreen: path.join(ROOT, 'src', 'screens', 'anime', 'PlayerScreen.tsx'),
  detailScreen: path.join(ROOT, 'src', 'screens', 'anime', 'DetailScreen.tsx'),
  rustAnime: path.join(ROOT, 'src-tauri', 'src', 'anime', 'mod.rs'),
  rustAnimesvc: path.join(ROOT, 'src-tauri', 'src', 'animesvc.rs'),
  rustManifest: path.join(ROOT, 'src-tauri', 'src', 'animesvc', 'manifest.rs'),
  rustMetadata: path.join(ROOT, 'src-tauri', 'src', 'animesvc', 'metadata.rs'),
  rustRss: path.join(ROOT, 'src-tauri', 'src', 'animesvc', 'datasource', 'rss.rs'),
  rustDatasource: path.join(ROOT, 'src-tauri', 'src', 'animesvc', 'datasource', 'mod.rs'),
  rustMediaserver: path.join(ROOT, 'src-tauri', 'src', 'animesvc', 'datasource', 'mediaserver.rs'),
  rustPlayback: path.join(ROOT, 'src-tauri', 'src', 'animesvc', 'playback.rs'),
  rustAnimeBin: path.join(ROOT, 'src-tauri', 'src', 'bin', 'animesvc.rs'),
  rustMain: path.join(ROOT, 'src-tauri', 'src', 'main.rs'),
  rustCommands: path.join(ROOT, 'src-tauri', 'src', 'commands', 'mod.rs'),
  readme: path.join(ROOT, 'README.md'),
  agents: path.join(ROOT, 'AGENTS.md'),
};

/** 读文件；目录与缺失一律返回空串（`screensDir` / `module` 是目录，断言另用 existsSync 判） */
const read = (p) => {
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  } catch {
    return '';
  }
};
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 全部断言：id → 判据（输入一次读盘快照，返回 {ok, detail}） */
const CHECKS = [
  {
    id: 'ALIAS.vite',
    run: (s) => ({
      // 不剥注释：`vite.config.ts` 的 `'**/src-tauri/**'` 里含 `/*`，朴素块注释正则会从那里一路吞到别名段
      ok: /['"]@anime['"]\s*:\s*aliasPath\(\s*['"]\.\/src\/modules\/anime['"]\s*\)/.test(s.vite),
      detail: 'vite.config.ts 缺 @anime 别名（或指向错了目录）',
    }),
  },
  {
    id: 'ALIAS.tsconfig',
    run: (s) => {
      const okExact = /"@anime"\s*:\s*\[\s*"src\/modules\/anime"\s*\]/.test(s.tsconfig);
      const okWild = /"@anime\/\*"\s*:\s*\[\s*"src\/modules\/anime\/\*"\s*\]/.test(s.tsconfig);
      return {
        ok: okExact && okWild,
        detail: `tsconfig 的 @anime 别名不全：精确项 ${okExact ? '有' : '缺'}，通配项 ${okWild ? '有' : '缺'}（缺哪条那一类 import 就解析不到）`,
      };
    },
  },
  {
    id: 'ROUTE.anime',
    run: (s) => ({
      ok: /\{\s*path:\s*['"]\/anime['"]\s*,\s*screen:\s*['"]anime['"]\s*\}/.test(strip(s.routes)),
      detail: 'router/routes.ts 缺 /anime → screen:anime 的路由',
    }),
  },
  {
    id: 'IA.appId',
    run: (s) => ({
      ok: /export type AppId = 'translate' \| 'music' \| 'anime'/.test(strip(s.nav)),
      detail: "nav.ts 的 AppId 未含 'anime'",
    }),
  },
  {
    id: 'IA.label',
    run: (s) => ({
      ok: /anime:\s*'番剧'/.test(strip(s.nav)),
      detail: 'APP_LABEL 缺 anime:「番剧」',
    }),
  },
  {
    id: 'IA.viewsNull',
    run: (s) => ({
      ok: /APP_VIEWS[\s\S]{0,220}anime:\s*null/.test(strip(s.nav)),
      detail: 'APP_VIEWS.anime 必须是 null（模块内自成工作区，不进壳层 Tab）',
    }),
  },
  {
    id: 'IA.notBlocked',
    run: (s) => {
      const body = strip(s.nav).match(/export function isBlockedWhenNotReady[\s\S]*?\n\}/);
      return {
        ok: !!body && /return s === 'translate';/.test(body[0]),
        detail: '番剧屏不得随翻译服务未就绪让位（与音乐同一例外）',
      };
    },
  },
  {
    id: 'PANE.wired',
    run: (s) => ({
      ok:
        /anime:\s*AnimePane/.test(strip(s.panes)) &&
        /import \{ AnimeScreen \} from '@screens\/AnimeScreen'/.test(s.animePane) &&
        /import \{ AnimePane \}/.test(s.panes),
      detail: '屏装配件未接线：panes/index.tsx 的 anime → AnimePane → AnimeScreen 三段有一处缺失',
    }),
  },
  {
    id: 'SCREEN.tenViews',
    run: (s) => {
      const views = [
        'DiscoverScreen',
        'CollectionScreen',
        'CacheScreen',
        'DetailScreen',
        'PlayerScreen',
        'HistoryScreen',
        'AccountScreen',
        'SourceScreen',
        'StatesScreen',
      ];
      const missing = views.filter(
        (v) => !new RegExp(`import \\{ ${v} \\}`).test(s.screen) || !new RegExp(`<${v} />`).test(s.screen),
      );
      return { ok: missing.length === 0, detail: missing.length ? `AnimeScreen 未分派：${missing.join('、')}` : '' };
    },
  },
  {
    id: 'SCREEN.files',
    run: (_s) => {
      const files = [
        'DiscoverScreen',
        'CollectionScreen',
        'CacheScreen',
        'DetailScreen',
        'PlayerScreen',
        'HistoryScreen',
        'AccountScreen',
        'SourceScreen',
        'StatesScreen',
        'shared',
      ];
      const missing = files.filter((n) => !existsSync(path.join(F.screensDir, `${n}.tsx`)));
      return { ok: missing.length === 0, detail: missing.length ? `screens/anime 缺件：${missing.join('、')}` : '' };
    },
  },
  {
    id: 'STORE.zustand',
    run: (s) => ({
      ok: /import \{ create \} from 'zustand'/.test(s.store) && /create<AnimeState>\(\)/.test(s.store),
      detail: 'anime store 未用 zustand（跨组件共享状态必须走 zustand，禁 Context）',
    }),
  },
  {
    id: 'STORE.sliceTypeOnly',
    run: (s) => {
      // 吃快照（反证在内存里改，不会落盘）
      const actions = [s.actionNav, s.actionLib];
      const bad = actions.filter((a) =>
        /import \{[^}]*\b(AnimeState|StoreSet|StoreGet)\b[^}]*\} from '@anime\/slice'/.test(a),
      );
      return {
        ok: bad.length === 0,
        detail: bad.length ? '切片里以**值**形式从 @anime/slice 取类型（应与 store 保持 type-only，否则成环）' : '',
      };
    },
  },
  {
    id: 'IPC.commands',
    run: (s) => {
      const ipc = strip(s.ipc);
      const cmds = [
        'anime_status',
        'anime_start',
        'anime_library',
        'anime_entry',
        'anime_save_subject',
        'anime_set_collection',
        'anime_save_episode',
        'anime_seed_demo',
        'anime_clear_demo',
        'anime_paths',
        'anime_play_source',
        'anime_metadata_search',
        'anime_metadata_apply',
      ];
      const missing = cmds.filter((c) => !ipc.includes(`'${c}'`));
      return { ok: missing.length === 0, detail: missing.length ? `ipc.ts 缺命令封装：${missing.join('、')}` : '' };
    },
  },
  {
    id: 'RUST.registered',
    run: (s) => {
      const handler = strip(s.rustCommands);
      const need = [
        'anime_status',
        'anime_start',
        'anime_library',
        'anime_entry',
        'anime_save_subject',
        'anime_set_collection',
        'anime_save_episode',
        'anime_seed_demo',
        'anime_clear_demo',
        'anime_paths',
        'anime_play_source',
        'anime_metadata_search',
        'anime_metadata_apply',
      ];
      const missing = need.filter((c) => !new RegExp(`crate::anime::${c}\\b`).test(handler));
      return {
        ok: missing.length === 0,
        detail: missing.length ? `handler() 未登记：${missing.join('、')}（编译能过，运行时 command not found）` : '',
      };
    },
  },
  {
    id: 'RUST.bridge',
    run: (s) => ({
      ok:
        /mod anime;/.test(strip(s.rustMain)) &&
        /anime::stop\(\)/.test(s.rustMain) &&
        /animesvc/.test(s.rustAnime) &&
        /X-Box-Token/.test(s.rustAnime) &&
        /fn bin_path/.test(s.rustAnime),
      detail: 'main.rs 未声明 anime 模块 / 退出未收子进程 / 桥接缺令牌头或二进制定位',
    }),
  },
  {
    id: 'ANIMESVC.manifest',
    run: (s) => ({
      ok:
        /mod manifest;/.test(s.rustAnimesvc) &&
        /manifest::scan\(/.test(s.rustAnimesvc) &&
        /anime\/subject/.test(s.rustAnimesvc) &&
        /anime\/progress/.test(s.rustAnimesvc) &&
        /anime\/demo/.test(s.rustAnimesvc) &&
        /pub fn save\(/.test(s.rustManifest) &&
        /manifest\.json/.test(s.rustManifest),
      detail: 'animesvc 缺 manifest 读写或写入端点（条目/进度/示例）',
    }),
  },
  {
    id: 'PLAYBACK.contract',
    run: (s) => {
      const t = s.rustPlayback;
      const methods = [
        'fn open',
        'fn play',
        'fn pause',
        'fn seek',
        'fn set_rate',
        'fn select_track',
        'fn load_subtitle',
        'fn snapshot',
      ];
      const missing = methods.filter((m) => !new RegExp(`${m}\\(`).test(t));
      return {
        ok:
          /pub trait PlaybackCore\s*\{/.test(t) &&
          missing.length === 0 &&
          /pub fn selftest/.test(t) &&
          /--playback-selftest/.test(s.rustAnimeBin),
        detail: `播放契约未冻结：缺 ${missing.join('、') || '——'} / selftest 或 CLI 旗标缺失（两轨会各写一套控制逻辑）`,
      };
    },
  },
  {
    id: 'PLAYER.ipc',
    run: (s) => ({
      ok:
        /import \* as ipc from '@anime\/ipc'/.test(s.playerHook) &&
        /ipc\s*(?:\r?\n\s*)?\.animePlaySource\(/.test(s.playerHook),
      detail: '播放器没有向 anime_play_source 取播放事实（屏上只能猜「有没有片源」）',
    }),
  },
  {
    id: 'PLAYER.webview',
    run: (s) => ({
      ok:
        /import Artplayer from 'artplayer'/.test(s.playerModule) &&
        /import Hls from 'hls\.js'/.test(s.playerModule) &&
        /customType:\s*\{/.test(s.playerModule) &&
        /m3u8:/.test(s.playerModule) &&
        /crossOrigin = 'anonymous'/.test(s.playerModule),
      detail: 'WebView 轨缺 ArtPlayer / hls.js / 自定义片源类型（签名 URL 没有扩展名，靠 URL 猜类型会播不了）',
    }),
  },
  {
    id: 'PLAYER.kernel',
    run: (s) => ({
      ok:
        /source\.found && !source\.supported/.test(s.playerScreen) &&
        /这集需要随包播放内核/.test(s.playerScreen) &&
        /source\.reason/.test(s.playerScreen),
      detail: 'libmpv 轨没有说清「需要随包内核」，屏上会变成一块放不出来的黑屏',
    }),
  },
  {
    id: 'PLAYER.progress',
    run: (s) => ({
      ok:
        /savePosition/.test(s.playerScreen) &&
        /markWatched\(episodeId, true\)/.test(s.playerScreen) &&
        /autoNext/.test(s.playerScreen),
      detail: '播放器没接续看回写 / 播完标记 / 自动连播（进度会丢，看完也不会变状态）',
    }),
  },
  {
    id: 'META.bangumi',
    run: (s) => ({
      ok:
        /mod metadata;/.test(s.rustAnimesvc) &&
        /anime\/metadata\/apply/.test(s.rustAnimesvc) &&
        /search_default\(|apply_default\(/.test(s.rustAnimesvc) &&
        /crate::anime::anime_metadata_apply/.test(strip(s.rustCommands)) &&
        /'anime_metadata_apply'/.test(s.ipc) &&
        /fillMetadata/.test(s.detailScreen) &&
        /const UA: \(/.test(s.rustMetadata) &&
        /"HTT-Oracion"/.test(s.rustMetadata) &&
        /miao-dock/.test(s.rustMetadata) &&
        /MIAO_BANGUMI_API/.test(s.rustMetadata) &&
        /MIAO_BANGUMI_IMG/.test(s.rustMetadata),
      detail: 'Bangumi 客户端没接全：模块 / 路由 / 镜像列表 / 图片镜像 / UA 四段 / 命令注册 / 详情页入口缺一环',
    }),
  },
  {
    id: 'META.flat',
    run: (s) => ({
      ok:
        /for \(path, _size, _ext\) in media_files\(dir\)/.test(s.rustManifest) &&
        /fn flat_directory_synthesizes_episodes/.test(s.rustManifest),
      detail: '番目录下直接躺着的视频没合成剧集（BT / 下载工具的扁平落盘点不进播放器）',
    }),
  },
  {
    id: 'SETTINGS.wired',
    run: (s) => ({
      ok:
        /crate::anime::anime_set_library_root/.test(strip(s.rustCommands)) &&
        /crate::anime::anime_set_proxy/.test(strip(s.rustCommands)) &&
        /'anime_set_library_root'/.test(s.ipc) &&
        /'anime_set_proxy'/.test(s.ipc) &&
        /applyLibraryRoot/.test(s.animeSettings) &&
        /applyProxy/.test(s.animeSettings),
      detail: '设置页的库根 / 代理只写了偏好，没接到服务（用户改了不生效）',
    }),
  },
  {
    id: 'M3.sources',
    run: (s) => ({
      ok:
        /pub mod sources;/.test(s.rustAnimesvc) &&
        /pub mod import;/.test(s.rustAnimesvc) &&
        /anime\/sources/.test(s.rustAnimesvc) &&
        /anime\/import/.test(s.rustAnimesvc) &&
        /crate::anime::anime_import_folder/.test(strip(s.rustCommands)) &&
        /'anime_sources'/.test(s.ipc) &&
        /importFolder/.test(s.sourceScreen),
      detail: 'M3 起点没接全：源契约 / 导入端点 / 命令注册 / IPC / 数据源屏入口缺一环',
    }),
  },
  {
    id: 'M3.rss',
    run: (s) => ({
      ok:
        /pub mod datasource;/.test(s.rustAnimesvc) &&
        /anime\/sources\/test/.test(s.rustAnimesvc) &&
        /crate::anime::anime_test_source/.test(strip(s.rustCommands)) &&
        /'anime_test_source'/.test(s.ipc) &&
        /animeTestSource/.test(s.sourceScreen) &&
        /pub fn parse\(/.test(s.rustRss),
      detail: 'RSS 适配器没接全：取数模块 / 测试端点 / 命令注册 / IPC / 数据源屏测试入口缺一环',
    }),
  },
  {
    id: 'M3.remote',
    run: (s) => ({
      ok:
        /pub async fn relay\(/.test(s.rustMediaserver) &&
        /anime\/mediaserver\/stream/.test(s.rustAnimesvc) &&
        /crate::anime::anime_play_remote/.test(strip(s.rustCommands)) &&
        /'anime_play_remote'/.test(s.ipc) &&
        /playRemoteSource/.test(s.sourceScreen) &&
        /remoteSource/.test(s.playerHook) &&
        /RemoteStage/.test(s.playerScreen),
      detail: '远程播放没接全：中继端点 / 命令注册 / IPC / 数据源入口 / 播放器远程态缺一环',
    }),
  },
  {
    id: 'M3.mediaserver',
    run: (s) => ({
      ok:
        /pub mod mediaserver;/.test(s.rustDatasource) &&
        /"jellyfin" \| "emby"/.test(s.rustDatasource) &&
        /pub async fn probe\(/.test(s.rustMediaserver) &&
        /X-Emby-Token/.test(s.rustMediaserver) &&
        /pub fn split_source_url\(/.test(s.rustMediaserver),
      detail: '媒体服务器适配器没接全：模块 / jellyfin·emby 分派 / probe / 令牌走请求头（不回传 URL）/ 地址拆分缺一环',
    }),
  },
  {
    id: 'SETTINGS.section',
    run: (s) => {
      const okMain = /'anime'/.test(s.settingsCatalogMain);
      const okScreen = /AnimeSettingsSection/.test(s.settingsScreen);
      const okItems = (s.settingsCatalog.match(/id: '[a-z]+\.[a-z]+'/g) ?? []).length === 31;
      return {
        ok: okMain && okScreen && okItems,
        detail: `番剧设置未接全：catalog 段 ${okMain ? '有' : '缺'}、设置页挂载 ${okScreen ? '有' : '缺'}、项数 31 ${okItems ? '对' : '不对'}`,
      };
    },
  },
  {
    id: 'STYLE.registered',
    run: (s) => ({
      ok: /@use 'anime\.scss';/.test(s.styleIndex) && /\.an-root/.test(s.style),
      detail: 'anime.scss 未在 styles/index.scss 注册（文件在、样式不生效）',
    }),
  },
  {
    id: 'NODE.free',
    run: (s) => {
      // 读快照里的内容（不直接读盘）：反证轮是在内存里改的，直读盘会让这条永远绿
      const files = [
        ['ipc.ts', s.ipc],
        ['store.ts', s.store],
        ['convert.ts', s.convertTs],
        ['prefs.ts', s.prefs],
        ['selectors.ts', s.selectorsTs],
        ['player-options.ts', s.optionsTs],
        ['settings-catalog.ts', s.settingsCatalog],
        ['types.ts', s.typesTs],
        ['slice.ts', s.sliceTs],
        ['player.ts', s.playerModule],
        ['use-anime-playback.ts', s.playerHook],
      ];
      const bad = files.filter(([, text]) => /from ['"](node:|child_process|fs)|require\(/.test(text)).map(([n]) => n);
      const rust = /use std::process::\{[^}]*Command|std::process::Command/.test(s.rustAnime);
      return {
        ok: bad.length === 0 && rust,
        detail: bad.length
          ? `前端套了 Node 运行时依赖：${bad.join('、')}（运行期零 Node 是本模块硬约束）`
          : '桥接层未用 Rust 拉起进程',
      };
    },
  },
  {
    id: 'DOCS.synced',
    run: (s) => {
      // README 目录节按「父目录 + 子目录」写（`modules/ … anime/`），AGENTS 写全路径
      const readmeOk = /modules\/[\s\S]{0,200}?anime\//.test(s.readme);
      const agentsOk = /src\/modules\/anime/.test(s.agents);
      return {
        ok: readmeOk && agentsOk,
        detail: `文档未同步：README 目录节 ${readmeOk ? '有' : '缺'}、AGENTS 分层表 ${agentsOk ? '有' : '缺'}（新增目录必须同步，漏了就是静默少一步）`,
      };
    },
  },
];

/** 读一次盘（每个断言共享同一份快照） */
function snapshot() {
  const out = {};
  for (const [k, p] of Object.entries(F)) out[k] = read(p);
  return out;
}

function runAll(snap) {
  const res = {};
  for (const c of CHECKS) {
    const r = c.run(snap);
    res[c.id] = { ok: !!r.ok, detail: r.detail };
  }
  return res;
}

// ── 反证：每一条都必须让**指定**断言变红（改内存，不写盘）──────────────
const MUTATIONS = [
  // ⚠️ 锚点一律不写行尾换行：仓库在 Windows 上是 CRLF，带 `\n` 的锚点会静默失配（本轮踩过）
  {
    name: 'vite.config.ts 删掉 @anime 别名',
    file: F.vite,
    find: "'@anime': aliasPath('./src/modules/anime'),",
    replace: '',
    expect: ['ALIAS.vite'],
  },
  {
    name: 'tsconfig 删掉 @anime/* 通配项',
    file: F.tsconfig,
    find: '"@anime/*": ["src/modules/anime/*"],',
    replace: '',
    expect: ['ALIAS.tsconfig'],
  },
  {
    name: '路由表删掉 /anime（屏还在，点不过去）',
    file: F.routes,
    find: "{ path: '/anime', screen: 'anime' },",
    replace: '',
    expect: ['ROUTE.anime'],
  },
  {
    name: "AppId 去掉 'anime'（IA 少了第三应用）",
    file: F.nav,
    find: "export type AppId = 'translate' | 'music' | 'anime';",
    replace: "export type AppId = 'translate' | 'music';",
    expect: ['IA.appId'],
  },
  {
    name: 'APP_VIEWS.anime 改成数组（本该自成工作区）',
    file: F.nav,
    find: 'anime: null,',
    replace: 'anime: [],',
    expect: ['IA.viewsNull'],
  },
  { name: '屏装配件不登记 anime', file: F.panes, find: 'anime: AnimePane,', replace: '', expect: ['PANE.wired'] },
  {
    name: 'handler() 摘掉 anime_seed_demo 注册（定义仍在）',
    file: F.rustCommands,
    find: 'crate::anime::anime_seed_demo,',
    replace: '',
    expect: ['RUST.registered'],
  },
  {
    name: 'animesvc 摘掉 /anime/progress 路由',
    file: F.rustAnimesvc,
    find: '.route(&format!("/api/{API_VERSION}/anime/progress"), post(save_episode))',
    replace: '',
    expect: ['ANIMESVC.manifest'],
  },
  {
    name: '样式入口不 @use anime.scss',
    file: F.styleIndex,
    find: "@use 'anime.scss';",
    replace: '',
    expect: ['STYLE.registered'],
  },
  {
    name: '前端 IPC 引入 node:child_process（运行期零 Node 被破坏）',
    file: F.ipc,
    find: "import { invoke } from '@tauri-apps/api/core';",
    replace: "import { execSync } from 'node:child_process';\nimport { invoke } from '@tauri-apps/api/core';",
    expect: ['NODE.free'],
  },
  {
    name: '删掉播放契约 trait（两轨各写一套控制逻辑）',
    file: F.rustPlayback,
    find: 'pub trait PlaybackCore {',
    replace: 'pub trait PlaybackCoreRenamed {',
    expect: ['PLAYBACK.contract'],
  },
  {
    name: '播放器改调 anime_library（不再取播放事实）',
    file: F.playerHook,
    find: '.animePlaySource(subjectId, index)',
    replace: '.animeLibrary()',
    expect: ['PLAYER.ipc'],
  },
  {
    name: 'WebView 轨去掉 m3u8 自定义类型（URL 无扩展名时猜不出类型）',
    file: F.playerModule,
    find: 'm3u8: (video, url, player) => {',
    replace: 'm3u8Renamed: (video, url, player) => {',
    expect: ['PLAYER.webview'],
  },
  {
    name: 'libmpv 轨也当成可播（内核分支的条件摘掉）',
    file: F.playerScreen,
    find: 'source.found && !source.supported',
    replace: 'source.found && false',
    expect: ['PLAYER.kernel'],
  },
  {
    name: '播完不标看完（自动连播随后失效）',
    file: F.playerScreen,
    find: 'void markWatched(episodeId, true);',
    replace: '',
    expect: ['PLAYER.progress'],
  },
  {
    name: 'animesvc 不再挂元数据模块（命令还在，运行期 404）',
    file: F.rustAnimesvc,
    find: 'pub mod metadata;',
    replace: '',
    expect: ['META.bangumi'],
  },
  {
    name: 'UA 丢掉开发者 id（官方会按 UA 限流甚至挡掉）',
    file: F.rustMetadata,
    find: '    "HTT-Oracion",',
    replace: '    "",',
    expect: ['META.bangumi'],
  },
  {
    name: '扁平落盘的视频不再合成剧集（点不进播放器）',
    file: F.rustManifest,
    find: 'for (path, _size, _ext) in media_files(dir) {',
    replace: 'for (path, _size, _ext) in Vec::new() {',
    expect: ['META.flat'],
  },
  {
    name: '库根设置不再接服务（只写 localStorage，改了不生效）',
    file: F.rustCommands,
    find: 'crate::anime::anime_set_library_root,',
    replace: '',
    expect: ['SETTINGS.wired'],
  },
  {
    name: 'animesvc 摘掉导入模块（界面还在，运行期 404）',
    file: F.rustAnimesvc,
    find: 'pub mod import;',
    replace: '',
    expect: ['M3.sources'],
  },
  {
    name: 'animesvc 摘掉 RSS 取数模块（测试按钮还在，运行期 404）',
    file: F.rustAnimesvc,
    find: 'pub mod datasource;',
    replace: '',
    expect: ['M3.rss'],
  },
  {
    name: '取数层不再挂媒体服务器模块（jellyfin / emby 测试直接 404）',
    file: F.rustDatasource,
    find: 'pub mod mediaserver;',
    replace: '',
    expect: ['M3.mediaserver'],
  },
  {
    name: '认证头被摘掉（不带 key 的请求只会 401，测试永远不通）',
    file: F.rustMediaserver,
    find: 'req.header("X-Emby-Token", key).header("X-MediaBrowser-Token", key)',
    replace: 'req',
    expect: ['M3.mediaserver'],
  },
  {
    name: 'animesvc 摘掉中继路由（前端拿到地址也播不了）',
    file: F.rustAnimesvc,
    find: '.route(&format!("/api/{API_VERSION}/anime/mediaserver/stream"), get(datasource::mediaserver::relay))',
    replace: '',
    expect: ['M3.remote'],
  },
];

const REFUTE = process.argv.includes('--refute');

console.log('番剧模块（anime）接线断言' + (REFUTE ? ' · 反证轮' : ''));
console.log(`根目录：${ROOT}`);
console.log(`断言总数：${CHECKS.length}\n`);

if (!REFUTE) {
  const snap = snapshot();
  const res = runAll(snap);
  let pass = 0;
  for (const c of CHECKS) {
    const r = res[c.id];
    if (r.ok) pass++;
    console.log(`  ${r.ok ? '✓' : '✗'} ${c.id}${r.ok ? '' : `  → ${r.detail}`}`);
  }
  console.log('\n' + '─'.repeat(56));
  console.log(`通过 ${pass} / 失败 ${CHECKS.length - pass}`);
  if (pass !== CHECKS.length) process.exitCode = 1;
} else {
  const base = runAll(snapshot());
  let red = 0;
  let total = 0;
  let skipped = 0;
  for (const m of MUTATIONS) {
    const src = read(m.file);
    if (!src.includes(m.find)) {
      console.log(`⚠ ${m.name}\n    破坏锚点未找到 —— 本条无法反证（跳过 ≠ 通过）`);
      skipped += m.expect.length;
      continue;
    }
    // 内存覆盖：不改盘，只在快照里替换该文件内容
    const patched = { ...snapshot() };
    for (const [k, p] of Object.entries(F)) {
      if (path.resolve(p) === path.resolve(m.file)) patched[k] = src.replace(m.find, m.replace);
    }
    const res = runAll(patched);
    console.log(`🔴 ${m.name}`);
    for (const id of m.expect) {
      total++;
      const isRed = res[id] && res[id].ok === false;
      if (isRed) {
        red++;
        console.log(`  ✓ ${id} 按预期变红`);
      } else {
        console.log(`  ✗ ${id} 该红没红 ← 假阳性`);
      }
      if (!base[id]) console.log(`     注：${id} 基线本就是红，无法据此判定断言有效性`);
    }
  }
  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证 —— 跳过 ≠ 通过`);
  if (red !== total || skipped) process.exitCode = 1;
}
