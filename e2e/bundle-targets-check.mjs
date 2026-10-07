#!/usr/bin/env node
/**
 * Windows 打包配置的**根因钉子** —— 且必须可反证
 * ================================================================
 * ## 为什么钉配置，而不是"打个包看看"
 *
 * 「Windows 不能打包」这条缺陷的成因**全在配置里**，而验证它的代价是**一次完整 release
 * 构建 + Tauri 下载 NSIS 工具链**（分钟级、且要联网）。把成因钉在配置上，改错立刻变红，
 * 不必每次都真打一次包。
 *
 * 钉的**不是风格**，是**成因**（每条对应一个真实机制）：
 *
 *   W1 `tauri.windows.conf.json` 存在且 `bundle.targets === ["nsis"]`。
 *      基座 `tauri.conf.json` 的 targets 是 `["app","dmg"]` —— **这两个都是 macOS 专有包型**，
 *      Windows 上没有任何可用包型 ⇒ `npm run app:build` 在 Windows 直接没有可产出的包。
 *      Windows 侧的修法见 W2。
 *
 *   W2 基座 `tauri.conf.json` 的 targets **仍是 `["app","dmg"]`**（不许被改成 `"all"` 或塞进 `nsis`）。
 *      「支持 Windows」**必须走平台分叉**（`tauri.windows.conf.json`，Tauri 按
 *      JSON Merge Patch 合并、**数组整体替换**），而不是改基座 —— 后者会连 macOS 的打包行为
 *      一起改掉，违反本仓 D-85「平台分叉一律只加分支（macOS 逐字节不变）」。
 *
 *   W3 基座 `bundle.icon` 含 `.ico`。
 *      Windows 打包要 `.ico`（macOS 用 `.icns`，Linux 用 `.png`）。三份图标缺一不可，
 *      缺了会在**打包阶段**报错而不是启动时。
 *
 *   W4 `tauri.windows.conf.json` 只放 Windows 特有的键，**不复制**基座里已有的键
 *      （`productName` / `identifier` / `icon` / `active` / `macOS`…）。
 *      平台配置一旦把基座的键也抄一份，同一事实就有了两处来源，必然漂移 ——
 *      例如基座换了图标而 windows 配置还指着旧文件。**注意**：允许新增 Windows 专有键
 *      （如 `bundle.windows.nsis`），本条只禁「复制基座已有键」。
 *
 * ## 反证轮（`--refute`）
 *   逐条把上面的写法**改回缺陷形态** → 对应断言**必须变红** → 按字节还原。
 *
 * ⚠️ 边界，别误读：本脚本证明的是**"打包配置被钉住了、且没被改基座污染"**，
 *   **不是**"`npm run app:build` 真的产出了 NSIS 安装包" —— 那条只能靠真跑一次 release 构建。
 *   （已手工真跑过一次：2026-10-08 带 MSVC 环境 release 构建，产出
 *   `target/release/bundle/nsis/喵坞_2.0.0_x64-setup.exe`；详见台账 D-93 §六。
 *   ⚠️ 那次构建还暴露出一个环境坑：**沙箱 shell 没设 `INCLUDE`/`LIB` 时 `ring` 编不过**
 *   （`cl.exe` 报 `C1034`，但诊断走 stdout、cargo 的 stderr 段是空的）—— 见 D-93 §四。）
 *
 * 用法：
 *   node e2e/bundle-targets-check.mjs            正向跑（期望全绿）
 *   node e2e/bundle-targets-check.mjs --refute   反证轮（破坏 → 变红 → 还原）
 *
 * 约束：纯 Node、零依赖、不起任何进程；反证轮结束**必须**按字节还原。
 * 见 ~/.workbuddy/skills/falsifiable-verification。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE_CONF = path.join(ROOT, 'app', 'src-tauri', 'tauri.conf.json');
const WIN_CONF = path.join(ROOT, 'app', 'src-tauri', 'tauri.windows.conf.json');

const REFUTE = process.argv.includes('--refute');

const results = [];
const check = (id, label, ok, detail) => {
  results.push({ id, label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
};

const read = (f) => fs.readFileSync(f, 'utf8');
const readJson = (f) => {
  try {
    return JSON.parse(read(f));
  } catch {
    return null;
  }
};
const eqArr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

/// 基座里**不该被 windows 配置复制**的键（复制 = 同一事实两处来源）。
/// ⚠️ **`targets` 刻意不在表里** —— 它正是平台配置**应该**覆盖的那个键
///   （基座 `["app","dmg"]` 是 macOS 专有包型，Windows 必须换成 `["nsis"]`）。
///   把它列进来会让本断言在**基线上就红**（自己写错、不是实现坏）。
const BASE_OWNED_KEYS = ['productName', 'identifier', 'version', 'icon', 'active', 'macOS', 'resources'];

// ------------------------------------------------------------------ 正向断言

function runAll() {
  results.length = 0;

  const base = readJson(BASE_CONF);
  const win = readJson(WIN_CONF);

  // ---- W1：Windows 平台配置存在且指定 nsis ----
  const winTargets = win && win.bundle ? win.bundle.targets : undefined;
  check(
    'W1',
    '`tauri.windows.conf.json` 存在，且 `bundle.targets === ["nsis"]`（否则 Windows 上没有可产出的包型）',
    !!win && eqArr(winTargets, ['nsis']),
    win ? `windows targets=${JSON.stringify(winTargets)}` : '文件缺失或不是合法 JSON',
  );

  // ---- W2：基座 targets 未被改动（macOS 逐字节不变）----
  const baseTargets = base && base.bundle ? base.bundle.targets : undefined;
  check(
    'W2',
    '基座 `tauri.conf.json` 的 `bundle.targets` **仍是 `["app","dmg"]`**（Windows 支持必须走平台分叉，不许改基座污染 macOS）',
    eqArr(baseTargets, ['app', 'dmg']),
    `base targets=${JSON.stringify(baseTargets)}`,
  );

  // ---- W3：图标含 .ico ----
  const icons = (base && base.bundle && base.bundle.icon) || [];
  check(
    'W3',
    '基座 `bundle.icon` 含 `.ico`（Windows 打包必需；缺了会在打包阶段报错）',
    Array.isArray(icons) && icons.some((p) => String(p).toLowerCase().endsWith('.ico')),
    `icon=${JSON.stringify(icons)}`,
  );

  // ---- W4：windows 配置只放 Windows 专有键，不复制基座的键 ----
  const winBundleKeys = win && win.bundle ? Object.keys(win.bundle) : [];
  const topKeys = win ? Object.keys(win).filter((k) => k !== '$schema') : [];
  const copied = [...topKeys, ...winBundleKeys].filter((k) => BASE_OWNED_KEYS.includes(k));
  check(
    'W4',
    '`tauri.windows.conf.json` **不复制**基座已有的键（`productName`/`identifier`/`icon`/`active`/`macOS`/`resources`）—— 同一事实两处来源必漂移',
    copied.length === 0,
    copied.length ? `复制了：${copied.join(', ')}` : `顶层键=${JSON.stringify(topKeys)} bundle 键=${JSON.stringify(winBundleKeys)}`,
  );
}

// ------------------------------------------------------------------ 输出

function printResults(title) {
  console.log(`\n【${title}】`);
  let fail = 0;
  for (const r of results) {
    if (!r.ok) fail++;
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.id} ${r.label}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log('\n' + '─'.repeat(56));
  console.log(`通过 ${results.length - fail} / 失败 ${fail}`);
  return { fail };
}

// ------------------------------------------------------------------ 反证

/// 每条变异 = 把某一处**改回缺陷形态**，并声明哪几条断言必须因此变红。
/// 注意：W1 的两条变异分别破坏「存在」与「取值」两种形态，覆盖两种真实回退方式。
const MUTATIONS = [
  {
    name: 'M1 windows 配置的 targets 退回空数组（等于没配）',
    edits: [{ file: WIN_CONF, find: '"targets": ["nsis"]', replace: '"targets": []' }],
    expect: ['W1'],
  },
  {
    name: 'M2 用改基座的方式"支持 Windows"（targets 改成 "all"）',
    edits: [{ file: BASE_CONF, find: '"targets": ["app", "dmg"]', replace: '"targets": "all"' }],
    expect: ['W2'],
  },
  {
    name: 'M3 从基座图标里删掉 .ico',
    edits: [{ file: BASE_CONF, find: '"icons/icon.ico", ', replace: '' }],
    expect: ['W3'],
  },
  {
    name: 'M4 windows 配置把基座的 icon 也抄了一份（埋下漂移）',
    edits: [
      {
        file: WIN_CONF,
        find: '"targets": ["nsis"]',
        replace: '"targets": ["nsis"],\n    "icon": ["icons/icon.ico"]',
        // 注意：JSON 里 "icon" 与 "targets" 同级（都在 bundle 下），复制它即触发 W4
      },
    ],
    expect: ['W4'],
  },
];

const readBytes = (f) => {
  try {
    return fs.readFileSync(f);
  } catch {
    return null;
  }
};

const main = () => {
  console.log(`Windows 打包配置钉子${REFUTE ? ' · 反证轮' : ''}`);

  if (!REFUTE) {
    runAll();
    const { fail } = printResults('Windows 打包 · 配置钉子');
    process.exitCode = fail === 0 ? 0 : 1;
    return;
  }

  runAll();
  const wasGreen = {};
  for (const r of results) wasGreen[r.id] = r.ok;

  const expectedTotal = MUTATIONS.reduce((n, m) => n + m.expect.length, 0);
  let total = 0;
  let red = 0;
  let skipped = 0;
  const falsePositives = [];
  const originals = new Map();

  console.log('\n破坏配置文件 → 断言必须变红 → 按字节还原\n');
  for (const mut of MUTATIONS) {
    let missing = false;
    for (const [i, e] of mut.edits.entries()) {
      if (!originals.has(e.file)) originals.set(e.file, readBytes(e.file));
      const txt = originals.get(e.file).toString('utf8');
      if (!txt.includes(e.find)) {
        console.log(`⚠ ${mut.name}\n    破坏锚点未找到（第 ${i + 1} 处，${path.relative(ROOT, e.file)}）—— 本条无法反证`);
        skipped += mut.expect.length;
        missing = true;
        continue;
      }
      fs.writeFileSync(e.file, txt.replace(e.find, e.replace));
    }
    if (missing) {
      for (const [f, snap] of originals) fs.writeFileSync(f, snap); // 还原已改的那几处
      continue;
    }

    // 🔴 还原一律进 `finally`：破坏若让 `runAll()` 抛异常，写在 try 之后的还原就不会执行，
    //    配置文件会永久留成被破坏状态。
    let res = {};
    let roundErr = null;
    try {
      runAll();
      for (const r of results) res[r.id] = r;
    } catch (err) {
      roundErr = err;
    } finally {
      for (const [f, snap] of originals) fs.writeFileSync(f, snap);
    }

    console.log(`🔴 ${mut.name}`);
    if (roundErr) console.log(`   ⚠ 本轮 runAll 抛异常（文件已被破坏）：${String(roundErr.message).split('\n')[0]}`);
    for (const id of mut.expect) {
      total++;
      const isRed = (res[id] && res[id].ok === false) || (!res[id] && roundErr !== null);
      if (isRed) {
        red++;
        console.log(`  ✓ ${id} 按预期变红`);
      } else {
        falsePositives.push(id);
        console.log(`  ✗ ${id} 该红没红 ← 假阳性`);
      }
      if (!wasGreen[id]) console.log('     注：该条基线本就是红，无法据此判定断言有效性');
    }
  }

  console.log('\n恢复校验');
  let restoreFail = 0;
  for (const [f, snap] of originals) {
    const back = readBytes(f);
    const same = back != null && back.equals(snap);
    if (!same) restoreFail++;
    console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, f)} 字节${same ? '一致' : '不一致！'}`);
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红（应执行 ${expectedTotal} 条）`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（破坏锚点未找到）—— 跳过 ≠ 通过`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(', ')}`);
  process.exitCode = red === expectedTotal && skipped === 0 && restoreFail === 0 ? 0 : 1;
};

try {
  main();
} catch (err) {
  console.error(`\n脚本异常：${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
}
