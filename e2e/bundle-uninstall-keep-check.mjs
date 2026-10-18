#!/usr/bin/env node
/**
 * E3 · 「卸载不碰用户自装的引擎运行时」—— 用**真安装器**验一次（nightly 层）
 * =============================================================================
 * E3 的验收②是两条**硬要求**：
 *   ① 卸载**绝不**自动删除 `<appData>/runtimes`；
 *   ② 也绝不触碰作品目录 `~/Pictures/Box 漫画`。
 *
 * `check:bundle` 的 W10 在**源码层**钉了形态（删数据前必过 `guard()`、静默档不碰数据）。
 * 而这条要求一旦被写错，代价是**用户几十分钟的装配成果被删掉** ——
 * 那种错不能只靠"读源码看着对"。⇒ 这里用真安装器跑一次静默卸载，看它**到底动了什么**。
 *
 * ## 为什么必须显式验"静默档"
 * 静默档是两条判据的交汇点：
 *   · 它必须**不挂住**（挂住 = CI 超时，不是变红）；
 *   · 它必须**保留**用户资产（"只删程序"不等于"顺手把数据也删了"）。
 * 2026-10-18 起安装/卸载由单文件安装器与卸载器自己完成（NSIS 钩子退役），
 * 静默档的参数是 `--silent`（旧的 `/S` 已不存在）。
 *
 * ## 硬前置（不软跳过）
 * 安装器得先构建：`npm run task -- install:kit`；且本机得真有一份引擎运行时
 * （`<appData>/runtimes/manga-translator`）—— 这条要验的就是"卸载不碰它"，
 * 没有它这条就无从谈起（缺则**失败并点名**，不是"跳过"）。
 *
 * 断言：
 *   P0 前置：安装器在 + 引擎运行时在（记录卸载前快照）
 *   P1 单文件安装器静默安装成功
 *   P2 静默**卸载**成功且**不挂住**（挂住的话脚本根本走不到这里）
 *   P3 安装目录被清掉（含卸载器自删 —— 卸载真的生效，不是"点了没反应"）
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
/** 交付物优先；没有就退回构建产物 */
const KIT_INSTALLER = path.join(ROOT, 'release', 'MiaoDock-Setup.exe');
const BUILT_INSTALLER = path.join(ROOT, 'installer', 'src-tauri', 'target', 'release', 'miaodock-installer.exe');

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

/** 找单文件安装器；没有 ⇒ **报错**（不静默跳过）。 */
function findInstaller() {
  for (const candidate of [KIT_INSTALLER, BUILT_INSTALLER]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 目录快照：存在与否 + 一层条目名（**不递归算大小** —— 13 GB 的目录没必要为此全量遍历）。 */
function snapDir(p) {
  if (!fs.existsSync(p)) return { exists: false, entries: [] };
  try {
    return { exists: true, entries: fs.readdirSync(p).sort() };
  } catch {
    return { exists: true, entries: ['<读不到>'] };
  }
}

function runTool(exe, args) {
  return new Promise((resolve) => {
    const p = spawn(exe, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      // 「挂住」是这个脚本最该抓的失败形态：不是变红，是永远不返回
      try {
        p.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, why: '超时未返回 —— 静默档被某个模态交互拦住了' });
    }, 180_000);
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

const installer = findInstaller();
if (!installer) {
  console.error(
    `✗ 找不到单文件安装器：\n  ${path.relative(ROOT, KIT_INSTALLER)}\n  ${path.relative(ROOT, BUILT_INSTALLER)}\n` +
      '先构建：npm run task -- install:kit',
  );
  process.exit(1);
}

const rtBefore = snapDir(RUNTIMES);
const picBefore = snapDir(PICTURES);
check('P0 前置：真安装器在 + 本机真有引擎运行时（这条要验的就是"卸载不碰它"，缺它无从谈起）', rtBefore.exists, {
  installer: path.relative(ROOT, installer),
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
  // 断言用 `--per-user`：不写 HKLM、不进 Program Files，测试不需要管理员
  const ins = await runTool(installer, ['--silent', '--per-user', '--no-shortcuts', '--dir', installDir]);
  check('P1 单文件安装器静默安装成功', ins.ok, ins);

  const exe = path.join(installDir, 'miao-dock.exe');
  check('P1b 安装目录里有 miao-dock.exe', fs.existsSync(exe), installDir);

  const un = path.join(installDir, 'MiaoDock-Uninstaller.exe');
  const unOut = fs.existsSync(un)
    ? await runTool(un, ['--silent'])
    : { ok: false, why: '卸载器不在（安装器没把它解包出来？）' };
  check('P2 静默卸载成功且**不挂住**（静默档全程不开窗 —— 不返回比变红更难查）', unOut.ok, unOut);

  // 卸载器先删内容、再起后台清理自己与目录：给它一点时间（但不无限等）
  for (let i = 0; i < 60 && fs.existsSync(installDir); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  check('P3 安装目录被清掉（含卸载器自删 —— 卸载真的生效，不是"点了没反应"）', !fs.existsSync(installDir), installDir);

  const rtAfter = snapDir(RUNTIMES);
  check(
    'P4 引擎运行时**原封不动**（E3 硬要求①：默认保留 —— 静默档不碰数据）',
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
  // 自删是异步的：清理失败不该让验收变成"环境残留"的假象，但要说出来
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch (error) {
    console.warn(`⚠ 临时目录没清掉（后台清理可能还在跑）：${String(error.message || error)}`);
  }
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
