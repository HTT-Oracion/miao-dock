#!/usr/bin/env node
/**
 * setup-engine.mjs —— 引擎运行时装配（Python 解释器 + 引擎源码）
 * =============================================================================
 * 只做「manifest 管不到的那三件事」：
 *   · Python 解释器（python-build-standalone）→ runtimes/manga-translator/python-3.11/
 *   · venv（用上面那个解释器建）            → runtimes/manga-translator/venv/
 *   · 引擎源码（上游 commit 归档）        → runtimes/manga-translator/src/
 * 模型权重 / llama.cpp 二进制走 `engine/scripts/fetch-models.mjs`（manifest 是唯一清单）。
 *
 * 版本一律以 `engine/VERSIONS.lock` 为准（本文件里的常量与那份 lock 一一对应）。
 *
 * 用法：
 *   node engine/scripts/setup-engine.mjs            # 装 Python + venv + 引擎源码
 *   node engine/scripts/setup-engine.mjs --python   # 只装 Python 运行时
 *   node engine/scripts/setup-engine.mjs --venv     # 只建 venv（需 Python 已就位）
 *   node engine/scripts/setup-engine.mjs --source   # 只装引擎源码
 *   node engine/scripts/setup-engine.mjs --check    # 只报告现状，不下载
 *
 * 环境变量：
 *   MIAO_MODEL_ROOT   模型根目录（默认 runtimes/manga-translator）
 *   MIAO_PY_URL / MIAO_SRC_URL  覆盖下载地址（换镜像用）
 *
 * ⚠️ 幂等：目标目录已存在且非空则跳过；`--force` 才重下。
 * ⚠️ 只依赖 node 内置模块 + 系统 `tar`（Windows 10 自带 bsdtar，可解 tar.gz 与 zip）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RT = process.env.MIAO_MODEL_ROOT || path.join(REPO, 'runtimes', 'manga-translator');

/** 与 engine/VERSIONS.lock §2 / §1 对应（换版本改这两处 + 那份 lock） */
const PY_VERSION = '3.11.17';
const PY_TAG = '20261003';
const ENGINE_COMMIT = '441d07c59a735c7db3db2e7bb8b07920afd8a9cc';

/** 按平台选 python-build-standalone 的产物三元组 */
function pyTriple() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'win32') return a === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  if (p === 'darwin') return a === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  return a === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
}

const PY_TRIPLE = pyTriple();
const PY_URL = process.env.MIAO_PY_URL
  || `https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone/${PY_TAG}/cpython-${PY_VERSION}%2B${PY_TAG}-${PY_TRIPLE}-install_only.tar.gz`;
const SRC_URL = process.env.MIAO_SRC_URL
  || `https://codeload.github.com/zyddnys/manga-image-translator/tar.gz/${ENGINE_COMMIT}`;

const PY_DIR = path.join(RT, 'python-3.11');
const SRC_DIR = path.join(RT, 'src');
const VENV_DIR = path.join(RT, 'venv');
const CACHE = path.join(RT, '.download-cache');

/** Python 运行时里的解释器 —— Windows 是 `python.exe`，POSIX 是 `bin/python3`。 */
function pyExe() {
  return process.platform === 'win32'
    ? path.join(PY_DIR, 'python.exe')
    : path.join(PY_DIR, 'bin', 'python3');
}

/** venv 里的解释器 —— Windows 是 `venv/Scripts/python.exe`，POSIX 是 `venv/bin/python`。 */
function venvExe() {
  return process.platform === 'win32'
    ? path.join(VENV_DIR, 'Scripts', 'python.exe')
    : path.join(VENV_DIR, 'bin', 'python');
}

const log = (m) => console.log(m);

async function existsNonEmpty(dir) {
  try {
    const ents = await fsp.readdir(dir);
    return ents.length > 0;
  } catch { return false; }
}

/**
 * 引擎源码是否**真的**装好了。
 * 🔴 判据必须是源码标志文件（`server/main.py`），**不能**是"src/ 目录非空" ——
 *    `fetch-models.mjs --link` 会先往 `src/models/` 里建链接，于是 `src/` 非空但**根本没有源码**，
 *    用"非空"当判据会把"没装源码"误判成"已装"（本脚本第一版就踩了这个坑）。
 */
async function sourceReady() {
  return fs.existsSync(path.join(SRC_DIR, 'server', 'main.py'));
}

/** 流式下载（支持断点续传；失败重试 3 次）。 */
async function download(url, dest, { retries = 3 } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let offset = 0;
    try { offset = (await fsp.stat(dest)).size; } catch { offset = 0; }
    try {
      const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const acceptsRange = res.status === 206;
      const from = offset > 0 && acceptsRange ? offset : 0;
      const ws = fs.createWriteStream(dest, { flags: from > 0 ? 'a' : 'w' });
      let received = from;
      const total = acceptsRange
        ? Number((/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '') || [])[1]) || null
        : Number(res.headers.get('content-length') || 0) || null;
      const reader = res.body.getReader();
      let lastPct = -1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        received += buf.length;
        if (!ws.write(buf)) await new Promise((r) => ws.once('drain', r));
        if (total) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            process.stdout.write(`\r  ${path.basename(dest)} ${pct}%（${(received / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB）`);
          }
        }
      }
      ws.end();
      await new Promise((r, j) => { ws.on('finish', r); ws.on('error', j); });
      process.stdout.write('\r' + ' '.repeat(70) + '\r');
      return dest;
    } catch (e) {
      if (attempt >= retries) throw new Error(`下载失败 ${url}：${e.message}`);
      log(`  [重试 ${attempt + 1}] ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

function extract(archive, destDir, { strip = 1 } = {}) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const args = ['-xf', archive, '-C', destDir];
  if (strip > 0) args.push(`--strip-components=${strip}`);
  const rc = spawnSync('tar', args, { stdio: 'inherit' });
  if (rc.status !== 0) throw new Error(`解包失败（exit ${rc.status}）：${archive}`);
}

async function installPython(force) {
  if (!force && await existsNonEmpty(PY_DIR)) { log(`[跳过] Python 运行时已就位：${PY_DIR}`); return; }
  const cache = path.join(CACHE, path.basename(decodeURIComponent(PY_URL)));
  log(`Python ${PY_VERSION}（${PY_TRIPLE}）`);
  log(`  URL: ${PY_URL}`);
  await download(PY_URL, cache);
  log('  解包…');
  extract(cache, PY_DIR);
  // 校验解释器存在
  const exe = pyExe();
  if (!fs.existsSync(exe)) throw new Error(`解包后未找到解释器：${exe}`);
  log(`  ✓ 解释器：${exe}`);
}

/**
 * 用装好的 Python 运行时建 venv。
 * 🔴 引擎依赖（`install-engine-deps.mjs` / `pip -r requirements.txt`）都装进**这个 venv**，
 *    服务侧 `config.enginePython` 与 e2e 也**只认这个路径** ⇒ 它必须在装依赖**之前**建好。
 *    venv 就位判据用「解释器文件存在」而不是「venv/ 目录存在」—— 目录非空但缺 Scripts/bin 是残的。
 */
async function installVenv(force) {
  if (!force && fs.existsSync(venvExe())) { log(`[跳过] venv 已就位：${VENV_DIR}`); return; }
  const exe = pyExe();
  if (!fs.existsSync(exe)) throw new Error(`Python 运行时不在 ${exe}（先跑一次 setup-engine.mjs --python）`);
  log(`建 venv → ${VENV_DIR}`);
  const rc = spawnSync(exe, ['-m', 'venv', VENV_DIR], { stdio: 'inherit' });
  if (rc.status !== 0) throw new Error(`创建 venv 失败（exit ${rc.status}）：${VENV_DIR}`);
  if (!fs.existsSync(venvExe())) throw new Error(`venv 建好后未找到解释器：${venvExe()}`);
  log(`  ✓ venv：${venvExe()}`);
}

async function installSource(force) {
  if (!force && await sourceReady()) { log(`[跳过] 引擎源码已就位：${SRC_DIR}`); return; }
  const cache = path.join(CACHE, `manga-translator-${ENGINE_COMMIT.slice(0, 12)}.tar.gz`);
  log(`引擎源码 commit ${ENGINE_COMMIT.slice(0, 12)}`);
  await download(SRC_URL, cache);
  log('  解包…');
  extract(cache, SRC_DIR);
  if (!fs.existsSync(path.join(SRC_DIR, 'server', 'main.py'))) {
    throw new Error(`解包后未找到 server/main.py：${SRC_DIR}`);
  }
  log(`  ✓ 源码：${SRC_DIR}`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const check = args.has('--check');
  const force = args.has('--force');
  const onlyPy = args.has('--python');
  const onlyVenv = args.has('--venv');
  const onlySrc = args.has('--source');

  log(`模型根目录：${RT}`);
  if (check) {
    log(`Python(${PY_VERSION})：${fs.existsSync(pyExe()) ? '✓ 已装' : '✗ 缺'}`);
    log(`venv：${fs.existsSync(venvExe()) ? '✓ 已建' : '✗ 缺'}`);
    log(`引擎源码：${await sourceReady() ? '✓ 已装' : '✗ 缺'}`);
    return 0;
  }
  await fsp.mkdir(RT, { recursive: true });
  // 给了任一「只装某一步」的开关 ⇒ 只跑被点名的那一步；一个都没给 ⇒ 三步全跑（顺序：Python → venv → 源码）。
  const selective = onlyPy || onlyVenv || onlySrc;
  if (!selective || onlyPy) await installPython(force);
  if (!selective || onlyVenv) await installVenv(force);
  if (!selective || onlySrc) await installSource(force);
  log('完成。');
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(`\n✗ ${e.stack || e.message}`); process.exit(1); });
