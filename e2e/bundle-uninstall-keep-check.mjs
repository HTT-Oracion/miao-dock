#!/usr/bin/env node
/**
 * E3 · 「卸载不碰用户自装的引擎运行时」—— 用**真安装器**验一次（nightly 层）
 * =============================================================================
 * E3 的验收②是两条**硬要求**：
 *   ① 卸载脚本**绝不**自动删除 `<appData>/runtimes`；
 *   ② 也绝不触碰作品目录 `~/Pictures/Box 漫画`。
 *
 * `check:bundle` 的 W10 只在**源码层**钉了形态（默认保留 + `RMDir` 在 `IDYES` 之后 +
 * 不出现作品目录字样）。而这条要求一旦被写错，代价是**用户几十分钟的装配成果被删掉** ——
 * 那种错不能只靠"读源码看着对"。⇒ 这里用真安装器跑一次静默卸载，看它**到底动了什么**。
 *
 * ## 为什么必须显式验"静默档"
 * NSIS 的 `MessageBox` 在 `/S` 下**照样弹并阻塞**（D-195）。我们的钩子在静默档直接跳过问询
 * （走默认 = 保留）—— 于是"静默卸载"同时是两条判据的交汇点：
 *   · 它必须**不挂住**（挂住 = CI 超时，不是变红）；
 *   · 它必须**保留**用户资产（跳过问询 ≠ 顺手删掉）。
 *
 * ## 硬前置（不软跳过）
 * 安装器得先构建：`npm run app:build`；且本机得真有一份引擎运行时
 * （`<appData>/runtimes/manga-translator`）—— 这条要验的就是"卸载不碰它"，
 * 没有它这条就无从谈起（缺则**失败并点名**，不是"跳过"）。
 *
 * 断言：
 *   P0 前置：安装器在 + 引擎运行时在（记录卸载前快照）
 *   P1 NSIS 静默安装成功
 *   P2 静默**卸载**成功且**不挂住**（挂住的话脚本根本走不到这里）
 *   P3 安装目录被清掉（卸载真的生效，不是"点了没反应"）
 *   P4 引擎运行时**原封不动**（E3 硬要求①：默认保留）
 *   P5 作品目录**原封不动**（E3 硬要求②：绝不触碰）
 *
 * 用法：node e2e/bundle-uninstall-keep-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TARGET = path.join(ROOT, 'app', 'src-tauri', 'target');
const NSIS_DIR = path.join(TARGET, 'release', 'bundle', 'nsis');

const APP_DATA =
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : path.join(os.homedir(), '.local', 'share');
const RUNTIMES = path.join(APP_DATA, 'runtimes', 'manga-translator');
/** 作品目录（`paths::default_root_dir`）—— 「绝不触碰」的那一个。 */
const PICTURES = path.join(os.homedir(), 'Pictures', 'Box 漫画');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
  }
}

/** 找 NSIS 安装包；没有 ⇒ **报错**（不静默跳过）。 */
function findSetup() {
  if (!fs.existsSync(NSIS_DIR)) return null;
  const hits = fs.readdirSync(NSIS_DIR).filter((f) => /-setup\.exe$/i.test(f));
  return hits.length ? path.join(NSIS_DIR, hits.sort().at(-1)) : null;
}

/** 目录快照：存在与否 + 一层条目名（**不递归算大小** —— 13 GB 的目录没必要为此全量遍历）。 */
function snapDir(p) {
  if (!fs.existsSync(p)) return { exists: false, entries: [] };
  let entries = [];
  try {
    entries = fs.readdirSync(p).sort();
  } catch {
    entries = ['<读不到>'];
  }
  return { exists: true, entries };
}

function runSetup(exe, args) {
  return new Promise((resolve) => {
    // ⚠️ `/D` 必须**最后**且不加引号（NSIS 自己的规矩）
    const p = spawn(exe, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      // 「挂住」是这个脚本最该抓的失败形态：不是变红，是永远不返回（D-195）
      try {
        p.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, why: '超时未返回 —— 极可能是弹窗把静默档拦住了（D-195 的形态）' });
    }, 120_000);
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, why: String(e.message || e) });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code });
    });
  });
}

const setup = findSetup();
if (!setup) {
  console.error(`✗ 找不到 NSIS 安装包：${NSIS_DIR}\\*-setup.exe\n先构建：npm run app:build`);
  process.exit(1);
}

const rtBefore = snapDir(RUNTIMES);
const picBefore = snapDir(PICTURES);
check('P0 前置：真安装器在 + 本机真有引擎运行时（这条要验的就是"卸载不碰它"，缺它无从谈起）', rtBefore.exists, {
  setup: path.relative(ROOT, setup),
  runtimes: RUNTIMES,
  exists: rtBefore.exists,
});
if (!rtBefore.exists) {
  console.error('\n⇒ 前置不满足：先装一份引擎（npm run task -- setup:engine / deps:engine / fetch:models）。');
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-unkeep-'));
const installDir = path.join(work, 'install');

try {
  const ins = await runSetup(setup, ['/S', `/D=${installDir}`]);
  check('P1 NSIS 静默安装成功', ins.ok, ins);

  const exe = path.join(installDir, 'miao-dock.exe');
  check('P1b 安装目录里有 miao-dock.exe', fs.existsSync(exe), installDir);

  const un = path.join(installDir, 'uninstall.exe');
  const unOut = fs.existsSync(un)
    ? await runSetup(un, ['/S'])
    : { ok: false, why: 'uninstall.exe 不在（装完没生成卸载器？）' };
  check('P2 静默卸载成功且**不挂住**（NSIS 的弹窗在 `/S` 下照样阻塞 ⇒ 钩子必须 `IfSilent` 跳过）', unOut.ok, unOut);

  // 卸载器可能稍后才删完，给它一点时间（但不无限等）
  for (let i = 0; i < 20 && fs.existsSync(exe); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  check('P3 安装目录被清掉（卸载真的生效，不是"点了没反应"）', !fs.existsSync(exe), installDir);

  const rtAfter = snapDir(RUNTIMES);
  check(
    'P4 引擎运行时**原封不动**（E3 硬要求①：默认保留 —— 跳过问询 ≠ 顺手删掉）',
    rtAfter.exists && rtAfter.entries.join('|') === rtBefore.entries.join('|'),
    { before: rtBefore.entries, after: rtAfter.entries, dir: RUNTIMES },
  );

  const picAfter = snapDir(PICTURES);
  check(
    'P5 作品目录**原封不动**（E3 硬要求②：绝不触碰）',
    picAfter.exists === picBefore.exists && picAfter.entries.join('|') === picBefore.entries.join('|'),
    { before: picBefore, after: picAfter, dir: PICTURES },
  );
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
