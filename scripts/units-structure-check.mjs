#!/usr/bin/env node
/**
 * 「公共组件抽离到 app/src/components/units/」结构断言 —— 且必须**可反证**。
 *
 * 为什么需要它：
 *   把一批组件搬进 `units/` 这件事，验收标准不是「文件建好了」，而是三件互不覆盖的
 *   事实同时成立——少任何一件，抽离就只是「看起来干净」：
 *
 *     LAYOUT   清单齐、旧路径消失、桶文件能解析 —— 少一个文件，调用点在打包时才炸。
 *     PURITY   单元不得依赖业务数据层（store/ipc/types/platform/根 hooks/ipc/types/nav）
 *              —— 这是「该不该放 units」的**唯一硬判据**，靠人自觉必然漏。
 *     NAMING   类名迁移到 `ui-` 前缀、历史中性名（.btn/.badge/...）不被顺手改名
 *              —— 命名写错不报错，只在视觉上悄悄错位。
 *     CALLERS  调用点真的从 units 引、且原文件不再重复定义那些控件
 *              —— 定义还在、import 也补了，会出现"两个 Select"，编译能过、行为看运气。
 *     KEEP     **反向**断言：没抽过头 —— 音乐语义件/设置页排版件/应用级组件必须留下。
 *              只断言"该走的走了"，会奖励把所有东西都搬进 units 的过度抽离。
 *
 *   因此本脚本逐组断言，并配一次可反证的破坏轮：破坏后对应断言**必须变红**，否则
 *   它测的不是它声称的东西（D-31：假阳性比没测试更危险）。
 *
 * 用法：
 *   node scripts/units-structure-check.mjs            正向跑（期望 LAYOUT/PURITY/NAMING/CALLERS/KEEP 全绿）
 *   node scripts/units-structure-check.mjs --refute   反证轮（破坏源文件 → 断言必须变红 → 按字节恢复）
 *
 * 约束：纯 Node、零依赖；只读 `app/src/**`（--refute 轮临时破坏并保证按字节还原）。
 * 本脚本源码里刻意**不出现**任何被禁的历史品牌标识（需要提及时一律写「参考实现」）。
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = path.join(ROOT, 'app');
const SRC = path.join(APP, 'src');

const F = {
  units: path.join(SRC, 'components', 'units'),
  components: path.join(SRC, 'components'),
  app: path.join(SRC, 'App.tsx'),
  queueScreen: path.join(SRC, 'screens', 'QueueScreen.tsx'),
  rightPanel: path.join(SRC, 'screens', 'music', 'RightPanel.tsx'),
  queueDrawer: path.join(SRC, 'screens', 'music', 'QueueDrawer.tsx'),
  sections: path.join(SRC, 'screens', 'settings', 'sections.tsx'),
  quitConfirm: path.join(SRC, 'components', 'QuitConfirm.tsx'),
  parts: path.join(SRC, 'screens', 'settings', 'parts.tsx'),
  shared: path.join(SRC, 'screens', 'music', 'shared.tsx'),
  loginModal: path.join(SRC, 'screens', 'music', 'LoginModal.tsx'),
  legacyAtoms: path.join(SRC, 'components', 'atoms.tsx'),
  legacyVirtualList: path.join(SRC, 'screens', 'music', 'VirtualList.tsx'),
};

// ── 冻结的契约（负责人冻结，本脚本照抄，不改口径） ────────────────────────
/** units 目录应恰有的 11 个文件（多一个/少一个都判红） */
const MANIFEST = [
  'atoms.tsx', 'Select.tsx', 'Switch.tsx', 'Range.tsx', 'Swatches.tsx',
  'ColorPicker.tsx', 'IconButton.tsx', 'Empty.tsx', 'VirtualList.tsx',
  'useEsc.ts', 'index.ts',
];
/** 桶文件应统一出口的名字 */
const BARREL_EXPORTS = [
  'Badge', 'Btn', 'Dot', 'MagicCircle', 'Pill', 'ColorPicker', 'Empty',
  'IconButton', 'Range', 'Select', 'Swatches', 'Switch', 'ROW_GAP', 'ROW_H',
  'VirtualList', 'useEsc',
];
/** 允许被 units import 的裸包（其余裸包一律判红：新依赖需负责人确认） */
const PKG_ALLOW = [/^react(\/.+)?$/, /^react-dom(\/.+)?$/, /^lucide-react$/];
/** 允许的 scoped 包前缀 */
const PKG_ALLOW_SCOPE = ['@radix-ui/'];
/** 相对导入唯一允许"越出 units"的目标（theme/tokens 是设计令牌，纯数据） */
const THEME_TOKENS_RE = /(^|\/)theme\/tokens(\.\w+)?$/;

/** 调用点必须真的从 units 引 */
const CALLER_IMPORT_FILES = {
  'App.tsx': F.app,
  'screens/QueueScreen.tsx': F.queueScreen,
  'screens/music/RightPanel.tsx': F.rightPanel,
  'screens/music/QueueDrawer.tsx': F.queueDrawer,
  'screens/settings/sections.tsx': F.sections,
  'components/QuitConfirm.tsx': F.quitConfirm,
};

// ── 读文件 ───────────────────────────────────────────────────────────────
const readMaybe = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const readBytes = (p) => (existsSync(p) ? readFileSync(p) : null);
const listFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : [];

/**
 * 去掉 // 与 /\\* *\\/ 注释（带字符串状态机）——**必须在取字符串字面量/导入语句前先做**。
 *
 * 为什么要状态机而不是简单正则：units 文件的注释里就出现了带引号的片段，
 * 例如 Range.tsx 的注释写了 `` `.music-prog-bar` ``。若直接扫全文找 `music-`，
 * 注释会让 NAMING 断言在**完全合法**的源码上误红（这也是本类脚本最容易犯的假阳性）。
 */
function stripComments(src) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i++; continue; }
      if (c === '/' && c2 === '/') { state = 'line'; out += '  '; i++; continue; }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out += c;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i++; continue; }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; continue; }
      out += ' ';
      continue;
    }
    // 字符串内：转义后整体保留
    if (c === '\\') { out += c + (c2 ?? ''); i++; continue; }
    if (state === 'sq' && c === "'") state = 'code';
    else if (state === 'dq' && c === '"') state = 'code';
    else if (state === 'tpl' && c === '`') state = 'code';
    out += c;
  }
  return out;
}

/** 收集源码里全部字符串字面量的内容（注释已剔除，故不会误收注释里的引号片段） */
function stringLiterals(stripped) {
  const out = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const m of stripped.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** 把字符串字面量切成"类名样式"的 token（music-empty / ui-range-fill / btn …） */
function classTokens(stripped) {
  const set = new Set();
  for (const lit of stringLiterals(stripped)) {
    for (const m of lit.matchAll(/[A-Za-z_][A-Za-z0-9_-]*/g)) set.add(m[0]);
  }
  return set;
}

/** 收集源码里所有 `from '<spec>'` 与副作用 `import '<spec>'` 的模块说明符 */
function importSpecifiers(stripped) {
  const out = [];
  for (const m of stripped.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of stripped.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

/** 是否"声明"了某顶层名字（function/const/let/var/class）—— 与参数名/变量名解耦 */
function declaresName(stripped, name) {
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|const|let|var|class)\\s+${esc(name)}\\b`,
  );
  return re.test(stripped);
}

/** 是否"导出"了某顶层名字 */
function exportsName(stripped, name) {
  const re = new RegExp(
    `(?:^|\\n)\\s*export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${esc(name)}\\b`,
  );
  return re.test(stripped);
}

const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 解析一个相对说明符相对 baseDir 是否命中真实文件 */
function resolvesToFile(baseDir, spec) {
  const p = path.resolve(baseDir, spec);
  const cands = [p, `${p}.tsx`, `${p}.ts`, `${p}.jsx`, `${p}.js`, path.join(p, 'index.tsx'), path.join(p, 'index.ts')];
  return cands.some((c) => existsSync(c));
}

/** 某一 units 文件里出现的违规 import（越出 units 且非 theme/tokens，或非法裸包） */
function badImportsOf(absFile, text) {
  const stripped = stripComments(text);
  const dir = path.dirname(absFile);
  const bad = [];
  for (const spec of importSpecifiers(stripped)) {
    if (/^\.\.?\//.test(spec)) {
      const resolved = path.resolve(dir, spec);
      const inside = resolved === F.units || resolved.startsWith(F.units + path.sep);
      if (!inside && !THEME_TOKENS_RE.test(spec)) bad.push(spec);
    } else {
      const ok = PKG_ALLOW.some((re) => re.test(spec)) || PKG_ALLOW_SAFE_SCOPE(spec);
      if (!ok) bad.push(spec);
    }
  }
  return bad;
}
const PKG_ALLOW_SAFE_SCOPE = (spec) => PKG_ALLOW_SCOPE.some((p) => spec.startsWith(p));

// ── 载入快照 ─────────────────────────────────────────────────────────────
function loadSources() {
  const s = {};
  s.unitsDirMissing = !existsSync(F.units);
  s.unitsFiles = listFiles(F.units); // 全量（含非 ts 文件，便于抓"改名残留"）
  s.units = new Map(); // 仅 .ts/.tsx → 注释已剥 + 原文
  for (const name of s.unitsFiles) {
    if (!/\.(ts|tsx)$/.test(name)) continue;
    const text = readMaybe(path.join(F.units, name));
    s.units.set(name, { raw: text, stripped: stripComments(text), abs: path.join(F.units, name) });
  }
  s.index = s.units.get('index.ts')?.raw ?? '';
  s.parts = readMaybe(F.parts);
  s.shared = readMaybe(F.shared);
  s.loginModal = readMaybe(F.loginModal);
  s.callers = Object.fromEntries(
    Object.entries(CALLER_IMPORT_FILES).map(([k, p]) => [k, readMaybe(p)]),
  );
  s.componentsFiles = listFiles(F.components);
  s.legacyAtomsExists = existsSync(F.legacyAtoms);
  s.legacyVirtualListExists = existsSync(F.legacyVirtualList);
  return s;
}

// ── 断言表 ───────────────────────────────────────────────────────────────
const A = [];
const add = (id, group, run) => A.push({ id, group, run });

// ============================ LAYOUT ============================
add('LAYOUT.files', 'LAYOUT', (s) => {
  if (s.unitsDirMissing) return { ok: false, detail: `目录不存在：${path.relative(ROOT, F.units)}` };
  const got = new Set(s.unitsFiles);
  const want = new Set(MANIFEST);
  const missing = MANIFEST.filter((n) => !got.has(n));
  const extra = s.unitsFiles.filter((n) => !want.has(n));
  return {
    ok: missing.length === 0 && extra.length === 0,
    detail: [
      missing.length ? `缺件：${missing.join(', ')}` : '',
      extra.length ? `多余：${extra.join(', ')}` : '',
    ].filter(Boolean).join('；'),
  };
});

add('LAYOUT.barrelResolves', 'LAYOUT', (s) => {
  const idx = s.units.get('index.ts');
  if (!idx) return { ok: false, detail: 'units/index.ts 缺失，无法校验桶文件' };
  const specs = [...stripComments(idx.raw).matchAll(/\bfrom\s+['"](\.\.?\/[^'"]+)['"]/g)].map((m) => m[1]);
  const broken = specs.filter((sp) => !resolvesToFile(F.units, sp));
  return {
    ok: specs.length > 0 && broken.length === 0,
    detail: broken.length ? `桶文件指向不存在的模块：${broken.join(', ')}` : specs.length ? '' : '桶文件没有任何相对 re-export',
  };
});

add('LAYOUT.barrelExports', 'LAYOUT', (s) => {
  const idx = s.units.get('index.ts')?.raw ?? '';
  const named = [...stripComments(idx).matchAll(/export\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)]
    .map((m) => m[1])
    .join(',');
  const missing = BARREL_EXPORTS.filter((n) => !new RegExp(`\\b${esc(n)}\\b`).test(named));
  return { ok: missing.length === 0, detail: missing.length ? `桶文件未出口：${missing.join(', ')}` : '' };
});

add('LAYOUT.legacyAbsent', 'LAYOUT', (s) => {
  const alive = [];
  if (s.legacyAtomsExists) alive.push('components/atoms.tsx');
  if (s.legacyVirtualListExists) alive.push('screens/music/VirtualList.tsx');
  return {
    ok: alive.length === 0,
    detail: alive.length ? `旧路径未删除（不保留兼容再导出）：${alive.join('、')}` : '',
  };
});

// ============================ PURITY ============================
add('PURITY.noBusinessImports', 'PURITY', (s) => {
  if (s.unitsDirMissing) return { ok: false, detail: 'units 目录不存在' };
  const offenders = [];
  for (const [name, u] of s.units) {
    const bad = badImportsOf(u.abs, u.raw);
    if (bad.length) offenders.push(`${name} → ${bad.join(', ')}`);
  }
  return {
    ok: offenders.length === 0,
    detail: offenders.length
      ? `units 文件 import 了业务数据层（硬判据）：${offenders.join('；')}`
      : '',
  };
});

// ============================ NAMING ============================
add('NAMING.noMusic', 'NAMING', (s) => {
  const hits = [];
  for (const [name, u] of s.units) {
    for (const t of classTokens(u.stripped)) if (t.startsWith('music-')) hits.push(`${name}:${t}`);
  }
  return { ok: hits.length === 0, detail: hits.length ? `units 类名仍带 music- 前缀：${hits.join(', ')}` : '' };
});

add('NAMING.noSet', 'NAMING', (s) => {
  const hits = [];
  for (const [name, u] of s.units) {
    for (const t of classTokens(u.stripped)) if (t.startsWith('set-')) hits.push(`${name}:${t}`);
  }
  return { ok: hits.length === 0, detail: hits.length ? `units 类名仍带 set- 前缀：${hits.join(', ')}` : '' };
});

add('NAMING.uiPrefix', 'NAMING', (s) => {
  const want = [
    'ui-select', 'ui-select-menu', 'ui-select-item', 'ui-select-ico', 'ui-select-ok',
    'ui-range', 'ui-range-val', 'ui-swatch', 'ui-swatches', 'ui-color', 'ui-cbtn',
    'ui-empty', 'ui-vlist', 'ui-vlist-inner', 'ui-vlist-item',
  ];
  const all = new Set();
  for (const [, u] of s.units) for (const t of classTokens(u.stripped)) all.add(t);
  const missing = want.filter((t) => !all.has(t));
  return { ok: missing.length === 0, detail: missing.length ? `units 未出现约定的 ui- 类名：${missing.join(', ')}` : '' };
});

add('NAMING.neutralKept', 'NAMING', (s) => {
  const want = ['btn', 'badge', 'pill', 'dot', 'magic', 'switch'];
  const all = new Set();
  for (const [, u] of s.units) for (const t of classTokens(u.stripped)) all.add(t);
  const missing = want.filter((t) => !all.has(t));
  return { ok: missing.length === 0, detail: missing.length ? `历史中性类名被改名/丢失：${missing.join(', ')}` : '' };
});

// ============================ CALLERS ============================
add('CALLERS.partsNoControls', 'CALLERS', (s) => {
  const st = stripComments(s.parts);
  const banned = ['Select', 'Range', 'Switch', 'Swatches', 'ColorPicker'];
  const still = banned.filter((n) => declaresName(st, n));
  return { ok: still.length === 0, detail: still.length ? `settings/parts.tsx 仍在定义控件：${still.join(', ')}` : '' };
});

add('CALLERS.sharedNoUnits', 'CALLERS', (s) => {
  const st = stripComments(s.shared);
  const banned = ['IconButton', 'Empty', 'useEsc'];
  const still = banned.filter((n) => declaresName(st, n));
  return { ok: still.length === 0, detail: still.length ? `music/shared.tsx 仍在定义 units 件：${still.join(', ')}` : '' };
});

add('CALLERS.importsUnits', 'CALLERS', (s) => {
  const missing = [];
  for (const [label, text] of Object.entries(s.callers)) {
    if (!/(?:from|import)\s+['"][^'"]*units['"]/.test(stripComments(text))) missing.push(label);
  }
  return { ok: missing.length === 0, detail: missing.length ? `这些调用点未从 units 引：${missing.join('、')}` : '' };
});

add('CALLERS.loginNoRawCbtn', 'CALLERS', (s) => {
  const has = s.loginModal.includes('music-cbtn');
  return { ok: !has, detail: has ? 'LoginModal.tsx 又出现绕过组件直接写的 music-cbtn 类名' : '' };
});

// ============================ KEEP（反向：没抽过头） ============================
add('KEEP.sharedExports', 'KEEP', (s) => {
  const st = stripComments(s.shared);
  const need = ['SongRow', 'Cover'];
  const missing = need.filter((n) => !exportsName(st, n));
  return { ok: missing.length === 0, detail: missing.length ? `music/shared.tsx 丢了音乐语义件：${missing.join(', ')}（抽过头）` : '' };
});

add('KEEP.partsExports', 'KEEP', (s) => {
  const st = stripComments(s.parts);
  const need = ['Row', 'PendingRow'];
  const missing = need.filter((n) => !exportsName(st, n));
  return { ok: missing.length === 0, detail: missing.length ? `settings/parts.tsx 丢了设置页排版件：${missing.join(', ')}（抽过头）` : '' };
});

add('KEEP.appComponents', 'KEEP', (s) => {
  const need = ['Sidebar.tsx', 'Toolbar.tsx', 'ViewTabs.tsx', 'QuitConfirm.tsx'];
  const missing = need.filter((n) => !s.componentsFiles.includes(n));
  return { ok: missing.length === 0, detail: missing.length ? `components/ 丢了应用级组件：${missing.join(', ')}（不该进 units）` : '' };
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

const GROUPS = ['LAYOUT', 'PURITY', 'NAMING', 'CALLERS', 'KEEP'];
function printGrouped(res) {
  let pass = 0;
  let fail = 0;
  for (const g of GROUPS) {
    const items = A.filter((a) => a.group === g);
    if (!items.length) continue;
    const gp = items.filter((a) => res[a.id].ok).length;
    console.log(`\n【${g}】 ${gp}/${items.length}`);
    for (const a of items) {
      const r = res[a.id];
      if (r.ok) { pass++; console.log(`  ✓ ${a.id}`); }
      else { fail++; console.log(`  ✗ ${a.id}${r.detail ? `\n      ${r.detail}` : ''}`); }
    }
  }
  return { pass, fail };
}

// ── 反证用例 ──────────────────────────────────────────────────────────────
// 三种破坏动作：edit（改文本）/ rename（改名，模拟清单缺件）/ create（复活旧路径）
const MUTATIONS = [
  { name: '把 units/VirtualList.tsx 改名（模拟清单缺件）', from: F.units + '/VirtualList.tsx', to: F.units + '/VirtualList.bak', expect: ['LAYOUT.files', 'LAYOUT.barrelResolves'] },
  { name: '往 units/Empty.tsx 顶部注入业务 store import', file: F.units + '/Empty.tsx', find: "import type { ReactNode } from 'react';", replace: "import { useMusicStore } from '../../music/store';\nimport type { ReactNode } from 'react';", expect: ['PURITY.noBusinessImports'] },
  { name: '往 units/Select.tsx 注入根 types import（另一条被禁来源）', file: F.units + '/Select.tsx', find: "import * as RSelect from '@radix-ui/react-select';", replace: "import type { SongLike } from '../types';\nimport * as RSelect from '@radix-ui/react-select';", expect: ['PURITY.noBusinessImports'] },
  { name: '把 units/Empty.tsx 的 ui-empty 改回 music-empty', file: F.units + '/Empty.tsx', find: "'ui-empty'", replace: "'music-empty'", expect: ['NAMING.noMusic', 'NAMING.uiPrefix'] },
  { name: '往 units/Select.tsx 塞一个 set-select 类名', file: F.units + '/Select.tsx', find: 'className="ui-select-item"', replace: 'className="ui-select-item set-select"', expect: ['NAMING.noSet'] },
  { name: '把 settings/parts.tsx 里重新加回 export function Select', file: F.parts, find: 'export function SubTitle(', replace: 'export function Select() { return null; }\nexport function SubTitle(', expect: ['CALLERS.partsNoControls'] },
  { name: '把 music/shared.tsx 里的 SongRow 删掉（模拟抽过头）', file: F.shared, find: 'export function SongRow({', replace: 'export function SongRowGone({', expect: ['KEEP.sharedExports'] },
  { name: '把 music/shared.tsx 里重新加回 export function Empty', file: F.shared, find: 'export function providerName(', replace: 'export function Empty() { return null; }\nexport function providerName(', expect: ['CALLERS.sharedNoUnits'] },
  { name: '把 screens/music/RightPanel.tsx 的 units import 改路径', file: F.rightPanel, find: "from '../../components/units';", replace: "from '../../components/unitz';", expect: ['CALLERS.importsUnits'] },
  { name: '把 LoginModal.tsx 改回 <button className="music-cbtn">', file: F.loginModal, find: '          <IconButton title="关闭" onClick={closeLogin}>\n            <X size={15} />\n          </IconButton>', replace: '          <button type="button" className="music-cbtn" onClick={closeLogin}>\n            <X size={15} />\n          </button>', expect: ['CALLERS.loginNoRawCbtn'] },
  { name: '把 settings/parts.tsx 的 PendingRow 改名（模拟抽过头）', file: F.parts, find: 'export function PendingRow(', replace: 'export function PendingRowGone(', expect: ['KEEP.partsExports'] },
  { name: '把 components/Sidebar.tsx 改名（应用级组件不该消失）', from: F.components + '/Sidebar.tsx', to: F.components + '/Sidebar.bak', expect: ['KEEP.appComponents'] },
  { name: '复活旧路径 components/atoms.tsx（模拟保留兼容再导出）', create: F.legacyAtoms, content: 'export {};\n', expect: ['LAYOUT.legacyAbsent'] },
  { name: '把 index.ts 桶文件里 Badge 的出口摘掉（模拟漏出口）', file: F.units + '/index.ts', find: "export { Badge, Btn, Dot, MagicCircle, Pill } from './atoms';", replace: "export { Btn, Dot, MagicCircle, Pill } from './atoms';", expect: ['LAYOUT.barrelExports'] },
  { name: '把 atoms.tsx 的历史中性类名 .pill 改成 .ui-pill', file: F.units + '/atoms.tsx', find: '<span className="pill">', replace: '<span className="ui-pill">', expect: ['NAMING.neutralKept'] },
];

// ── 主流程 ────────────────────────────────────────────────────────────────
const refute = process.argv.includes('--refute');

console.log('公共组件抽离（components/units）结构断言' + (refute ? ' · 反证轮' : ''));
console.log(`根目录：${ROOT}`);
console.log(`断言总数：${A.length}（LAYOUT/PURITY/NAMING/CALLERS/KEEP）`);

if (!refute) {
  const res = runAll(loadSources());
  const { pass, fail } = printGrouped(res);
  console.log('\n' + '─'.repeat(56));
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) {
    console.log('\n下一步：逐条看上面 ✗ 的 detail —— 是脚本写错还是真实抽离缺口，勿为转绿而放宽断言。');
  }
  process.exitCode = fail === 0 ? 0 : 1;
} else {
  const base = runAll(loadSources());
  const wasGreenBase = {};
  for (const a of A) wasGreenBase[a.id] = base[a.id].ok;

  // 分母固定：应执行的破坏条数在脚本里写死。理由——比率型指标会吞掉分母变化：
  // 「13/13」与「12/12」肉眼都是全绿，而后者已永久少一条覆盖（锚点随重构漂移时会这样静默降级）。
  const expectedTotal = MUTATIONS.reduce((n, m) => n + m.expect.length, 0);

  let total = 0;
  let red = 0;
  let skipped = 0;
  const falsePositives = [];
  const applied = []; // {kind, ...} 用于最终恢复校验

  console.log(`\n破坏源文件 → 断言必须变红 → 按字节恢复（应执行 ${expectedTotal} 条）\n`);

  for (const mut of MUTATIONS) {
    let okApply = true;
    let record = null;
    try {
      if (mut.from) {
        // 改名
        if (!existsSync(mut.from)) {
          console.log(`⚠ ${mut.name}\n    源文件不存在：${path.relative(ROOT, mut.from)} —— 本条无法反证`);
          okApply = false;
          skipped += mut.expect.length;
        } else {
          const original = readBytes(mut.from);
          record = { kind: 'rename', from: mut.from, to: mut.to, original };
          renameSync(mut.from, mut.to);
        }
      } else if (mut.create) {
        if (existsSync(mut.create)) {
          console.log(`⚠ ${mut.name}\n    ${path.relative(ROOT, mut.create)} 已存在 —— 本条无法反证`);
          okApply = false;
          skipped += mut.expect.length;
        } else {
          record = { kind: 'create', file: mut.create };
          writeFileSync(mut.create, mut.content);
        }
      } else {
        const original = readBytes(mut.file);
        if (original == null) {
          console.log(`⚠ ${mut.name}\n    文件不存在：${path.relative(ROOT, mut.file)} —— 本条无法反证`);
          okApply = false;
          skipped += mut.expect.length;
        } else {
          const txt = original.toString('utf8');
          if (!txt.includes(mut.find)) {
            console.log(`⚠ ${mut.name}\n    破坏锚点未找到（源文件已变？）—— 本条无法反证`);
            okApply = false;
            skipped += mut.expect.length;
          } else {
            record = { kind: 'edit', file: mut.file, original };
            writeFileSync(mut.file, txt.replace(mut.find, mut.replace));
          }
        }
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
      // 精确按字节恢复
      if (record) {
        if (record.kind === 'rename' && existsSync(record.to)) renameSync(record.to, record.from);
        else if (record.kind === 'create' && existsSync(record.file)) unlinkSync(record.file);
        else if (record.kind === 'edit') writeFileSync(record.file, record.original);
        applied.push(record);
      }
    }
  }

  // 恢复校验：改过的按字节比对；改名的确认回位；新建的确认已删除
  console.log('\n恢复校验');
  let restoreFail = 0;
  for (const r of applied) {
    if (r.kind === 'edit') {
      const back = readBytes(r.file);
      const same = back != null && back.equals(r.original);
      if (!same) restoreFail++;
      console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, r.file)} 字节${same ? '一致' : '不一致！'}`);
    } else if (r.kind === 'rename') {
      const back = readBytes(r.from);
      const same = back != null && back.equals(r.original) && !existsSync(r.to);
      if (!same) restoreFail++;
      console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, r.from)} 已回位且字节${same ? '一致' : '不一致！'}`);
    } else if (r.kind === 'create') {
      const gone = !existsSync(r.file);
      if (!gone) restoreFail++;
      console.log(`  ${gone ? '✓' : '✗'} ${path.relative(ROOT, r.file)} 临时新建已清除`);
    }
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红（应执行 ${expectedTotal} 条）`);
  if (total !== expectedTotal) console.log(`✗ 实际执行 ${total} 条 ≠ 写死的 ${expectedTotal} 条（有破坏被静默跳过）`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（锚点未找到/源文件缺席）—— 跳过 ≠ 通过`);
  if (restoreFail) console.log(`✗ 有 ${restoreFail} 个文件未恢复到原始字节`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(', ')}`);
  process.exitCode =
    red === total && total === expectedTotal && skipped === 0 && restoreFail === 0 ? 0 : 1;
}
