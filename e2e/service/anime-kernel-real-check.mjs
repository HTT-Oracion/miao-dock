#!/usr/bin/env node
/**
 * 内核轨的**真机半边**：拿**真 mpv** 跑一遍 `animesvc --kernel-selftest`（17 例）。
 * =============================================================================
 * 为什么单独一条：`check:anime` 的 A8 用的是**假 mpv 夹具**（证明协议与状态机），
 * 它跑得再绿也回答不了「真 mpv 会不会接受这些命令」。这条用真二进制回答，
 * 并且**硬前置缺一即失败并点名**（与 `check:e7:real` 同口径，跳过 ≠ 通过）。
 *
 * 前置：
 *   ① `cargo build --bin animesvc`（缺 ⇒ 点名这条命令）
 *   ② mpv 二进制：`MIAO_MPV_REAL` 或 `src-tauri/resources/mpv/<平台>/mpv[.exe]`
 *      （缺 ⇒ 点名 `npm run task -- fetch:mpv`）
 *
 * 用法：node e2e/service/anime-kernel-real-check.mjs [--refute]
 * 反证：① 拿假 mpv 夹具冒充 ⇒ 本门必须非零退出；② 前置缺失 ⇒ 退出码 2。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, '..', '..');
const WIN = process.platform === 'win32';
const EXE = (name) => path.join(REPO, 'src-tauri', 'target', 'debug', WIN ? `${name}.exe` : name);
const REFUTE = process.argv.includes('--refute');

/** 与 `animesvc/kernel/mpv.rs::platform_tag()` 逐字一致 */
function platformTag() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'win32-arm64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin') return 'darwin-x64';
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

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
    console.log(`  ✗ ${name}${extra !== undefined ? `  → ${JSON.stringify(extra).slice(0, 300)}` : ''}`);
  }
}

const ANIME_BIN = process.env.MIAO_ANIMESVC_BIN || EXE('animesvc');
const MPV =
  process.env.MIAO_MPV_REAL || path.join(REPO, 'src-tauri', 'resources', 'mpv', platformTag(), WIN ? 'mpv.exe' : 'mpv');

console.log('=== 内核轨真机半边：真 mpv × animesvc --kernel-selftest ===');
console.log(`仓库：${REPO}`);

// 硬前置：缺了就失败并点名（不是跳过）
{
  const missing = [];
  if (!fs.existsSync(ANIME_BIN)) missing.push('animesvc 未构建 ⇒ cd src-tauri && cargo build --bin animesvc');
  if (!fs.existsSync(MPV)) missing.push('mpv 不在位 ⇒ npm run task -- fetch:mpv（或设 MIAO_MPV_REAL）');
  check('P0 硬前置齐备（animesvc + 真 mpv）', missing.length === 0, missing);
  if (missing.length) {
    console.log('\n────────────────────────────────────────────────────────');
    console.log(`通过 ${passed} / 失败 ${failed}`);
    process.exit(2);
  }
}

const runSelftest = (bin) =>
  spawnSync(ANIME_BIN, ['--kernel-selftest'], {
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, MIAO_MPV_BIN: bin, MIAO_MPV_SCRIPT: '' },
  });

if (!REFUTE) {
  // 真二进制的基本形态：夹具是 node 脚本，绝不会是 100 MB 级的可执行文件
  const size = fs.statSync(MPV).size;
  check(
    'P1 指向的是真 mpv 二进制（体积 > 10 MB，不是夹具）',
    size > 10 * 1024 * 1024,
    `${(size / 1024 / 1024).toFixed(1)} MB`,
  );

  const r = runSelftest(MPV);
  let out;
  try {
    out = JSON.parse((r.stdout || '').trim());
  } catch {
    out = null;
  }
  check('P2 自检跑得完并输出 JSON', r.status === 0 && out !== null, {
    status: r.status,
    stderr: (r.stderr || '').slice(-300),
  });
  check(
    'P3 真 mpv 上 17 例全绿',
    out?.ok === true && out?.cases?.length === 17,
    out?.cases?.filter((c) => !c.ok),
  );
  check('P4 自报的路径就是这一个二进制', out?.info?.path === MPV, out?.info);
} else {
  // 反证：拿**假 mpv 夹具**冒充真二进制 ⇒ 这条门必须非零退出（证明 P1/P3 不是恒真）
  const fake = path.join(REPO, 'e2e', 'fixtures', '_fake-mpv.mjs');
  const runSelf = (mpvPath) =>
    spawnSync(process.execPath, [import.meta.filename], {
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, MIAO_MPV_REAL: mpvPath },
    });

  const withFake = runSelf(fake);
  check('R1 夹具冒充 mpv ⇒ 本门必须失败（体积判据不是恒真）', withFake.status !== 0, {
    status: withFake.status,
    tail: (withFake.stdout || '').slice(-200),
  });

  const withGhost = runSelf(path.join(REPO, '.tmp', 'no-such-mpv', WIN ? 'mpv.exe' : 'mpv'));
  check('R2 前置缺失 ⇒ 退出码 2 并点名 fetch:mpv（不是软跳过）', withGhost.status === 2, {
    status: withGhost.status,
    tail: (withGhost.stdout || '').slice(-200),
  });
}

console.log('\n────────────────────────────────────────────────────────');
console.log(`通过 ${passed} / 失败 ${failed}`);
if (failures.length) console.log(`失败项：\n${failures.map((f) => `  - ${f}`).join('\n')}`);
process.exit(failed > 0 ? 1 : 0);
