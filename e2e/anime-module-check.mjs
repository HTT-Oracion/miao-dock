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
  style: path.join(ROOT, 'src', 'styles', 'anime.scss'),
  styleIndex: path.join(ROOT, 'src', 'styles', 'index.scss'),
  rustAnime: path.join(ROOT, 'src-tauri', 'src', 'anime', 'mod.rs'),
  rustAnimesvc: path.join(ROOT, 'src-tauri', 'src', 'animesvc.rs'),
  rustManifest: path.join(ROOT, 'src-tauri', 'src', 'animesvc', 'manifest.rs'),
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
    id: 'SETTINGS.section',
    run: (s) => {
      const okMain = /'anime'/.test(s.settingsCatalogMain);
      const okScreen = /AnimeSettingsSection/.test(s.settingsScreen);
      const okItems = (s.settingsCatalog.match(/id: '[a-z]+\.[a-z]+'/g) ?? []).length === 30;
      return {
        ok: okMain && okScreen && okItems,
        detail: `番剧设置未接全：catalog 段 ${okMain ? '有' : '缺'}、设置页挂载 ${okScreen ? '有' : '缺'}、项数 30 ${okItems ? '对' : '不对'}`,
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
