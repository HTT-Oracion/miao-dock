#!/usr/bin/env node
/**
 * B3 · 路径推导**单源化**钉子 —— 防「检测说没装、启动却起了」
 * =============================================================================
 * 本方向最大风险（计划文档 R1）：检测与启动各写一份路径推导 ⇒ 两边**都看起来在工作**，
 * 而用户看到的是"诊断说没装 Python，点开始却跑起来了"（或反过来）—— 离根因极远、且无法自证。
 *
 * ## 机制
 * 两侧都从**同一个 env** 出发，各取各的路径，再逐字节比：
 *   · 检测侧：起服务打 `GET /api/v1/engine/runtime`，取 `python` 项的 `path`
 *   · 启动侧：`boxsvc --print-launch-plan`，取 `engine.cmd[0]`（真实启动命令的第一个参数）
 * 任一侧自己拼路径（哪怕拼得"也对"）都会让这一条红 —— 这正是它要防的东西。
 *
 * 🔴 为什么不能只比"存在性"：另写一份推导在**装好了的机器上照样判得出真伪**（B2 全绿），
 *    只有把两边的**字符串**摆在一起才能发现它们是两份代码。
 *
 * ## 反证轮（--refute）
 * - M1 把检测侧的解释器判据换成**另写一份**（写死 POSIX 的 `venv/bin/python`）⇒ Windows 上
 *   两边字符串不同 ⇒ 变红。这一刀同时验证了「平台分叉只有一处」（`paths::venv_python_rel`）。
 *
 * 用法：node e2e/service/path-single-source-check.mjs [--refute]
 * 前置：`cd src-tauri && cargo build --bin boxsvc`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUST_BIN } from './_service-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const REFUTE = process.argv.includes('--refute');
const TOKEN = 'a'.repeat(64);
const PROBE_RS = path.join(REPO_ROOT, 'src-tauri', 'src', 'boxsvc', 'engine', 'runtime_probe.rs');
const SRC_TAURI = path.join(REPO_ROOT, 'src-tauri');
const CARGO = process.env.CARGO || 'cargo';

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

// ------------------------------------------------------------------ 夹具

/** 一套 env：把引擎路径全部指到 TMP（绝不去读用户真实 appData）。 */
function fixtureEnv(base) {
  const src = path.join(base, 'manga-translator', 'src');
  const venv = path.join(base, 'manga-translator', 'venv');
  const py = path.join(
    venv,
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python',
  );
  fs.mkdirSync(path.join(src, 'server'), { recursive: true });
  fs.mkdirSync(path.dirname(py), { recursive: true });
  fs.writeFileSync(path.join(src, 'server', 'main.py'), '# fixture\n');
  fs.writeFileSync(py, process.platform === 'win32' ? 'MZ' : '#!/bin/sh\n');
  return {
    MIAO_RUNTIME_ROOT: base,
    MIAO_ENGINE_DIR: src,
    MIAO_ENGINE_PYTHON: py,
  };
}

// ------------------------------------------------------------------ 取证

/** 启动侧：`--print-launch-plan` 的 `engine.cmd[0]`。 */
function launchInterpreter(env) {
  return new Promise((resolve, reject) => {
    // 🔴 异步 spawn：本机沙箱里同步起子进程会 EBUSY。
    const p = spawn(RUST_BIN, ['--print-launch-plan'], { env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`--print-launch-plan 退出 ${code}：${err.slice(0, 400)}`));
      try {
        resolve(JSON.parse(out).engine.cmd[0]);
      } catch (e) {
        reject(new Error(`启动配方不是合法 JSON：${e.message}`));
      }
    });
  });
}

/** 检测侧：起服务打 `/engine/runtime`，取 `python` 项的 path。 */
function probeInterpreter(env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-single-src-'));
  const child = spawn(RUST_BIN, [], {
    env: {
      ...process.env,
      MIAO_TOKEN: TOKEN,
      MIAO_ROOT: path.join(tmp, 'root'),
      MIAO_STATE_DIR: path.join(tmp, 'state'),
      MIAO_ENGINE_PROTOCOL: 'mock',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => {
      child.kill();
      reject(new Error('boxsvc 15s 内未就绪'));
    }, 15000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /MIAO_READY (\{.*\})/.exec(buf);
      if (!m) return;
      clearTimeout(to);
      const port = JSON.parse(m[1]).port;
      fetch(`http://127.0.0.1:${port}/api/v1/engine/runtime`, { headers: { 'x-box-token': TOKEN } })
        .then((r) => r.json())
        .then((body) => {
          child.kill();
          const py = (body?.items ?? []).find((i) => i.id === 'python');
          resolve(py ? py.path : null);
        })
        .catch((e) => {
          child.kill();
          reject(e);
        });
    });
    child.stderr.on('data', (d) => (buf += d));
    child.on('close', (code) => {
      clearTimeout(to);
      reject(new Error(`boxsvc 退出 ${code}：${buf.slice(0, 400)}`));
    });
  });
}

// ------------------------------------------------------------------ 正向

if (!fs.existsSync(RUST_BIN)) {
  console.error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd src-tauri && cargo build --bin boxsvc`);
  process.exit(1);
}

// 场景①：显式覆盖解释器 ⇒ 两边必须给出**同一个字符串**
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-single-a-'));
  const env = fixtureEnv(base);
  const launch = await launchInterpreter(env);
  const probe = await probeInterpreter(env);
  check(
    'B3.a 检测到的解释器路径与启动命令里的逐字节相同（MIAO_ENGINE_PYTHON 覆盖）',
    typeof launch === 'string' && launch === probe && launch === env.MIAO_ENGINE_PYTHON,
    { launch, probe, env: env.MIAO_ENGINE_PYTHON },
  );
  fs.rmSync(base, { recursive: true, force: true });
}

// 场景②：**不覆盖**解释器 ⇒ 走默认值（`<runtimeRoot>/manga-translator/venv/...`）。
//   这一条钉的是"默认值也只有一处"：把默认值改回仓库布局只会让两边一起错，但**不会**让它们分叉；
//   而任一侧另写一份默认推导就会在这里现形。
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-single-b-'));
  const env = { MIAO_RUNTIME_ROOT: base, MIAO_ROOT: path.join(base, 'root'), MIAO_STATE_DIR: path.join(base, 'state') };
  const launch = await launchInterpreter(env);
  const probe = await probeInterpreter(env);
  check(
    'B3.b 未覆盖时检测与启动仍逐字节相同（默认值也只在一处推导）',
    typeof launch === 'string' && launch === probe && launch.length > 0,
    { launch, probe },
  );
  fs.rmSync(base, { recursive: true, force: true });
}

// 场景③：平台分叉只有一处 —— `venv_python_rel()` 是唯一的 POSIX/Windows 分叉点。
//   检测侧若自己拼一份 `Scripts/python.exe` / `bin/python`，这里就会和启动侧分叉。
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-single-c-'));
  const env = { MIAO_RUNTIME_ROOT: base };
  const launch = await launchInterpreter(env);
  const seg = process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');
  check(
    'B3.c 两边都落在 venv 的平台分叉路径上（同一处分叉，没有第二份）',
    typeof launch === 'string' && launch.endsWith(seg),
    { launch, seg },
  );
  fs.rmSync(base, { recursive: true, force: true });
}

// 场景④（B1 验收②）：real 档 + runtime 未装配 ⇒ 启动日志**逐项**报「引擎运行时未就绪」
//   （带绝对路径 + 装法），而不是让用户白等 240 s 再看到一句 Connection error。
//   同时钉住反面：**mock 档不报** —— mock 本来就不要真引擎，报了会误导用户去装一个用不上的运行时。
{
  const warnsFor = (protocol) =>
    new Promise((resolve, reject) => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), `miao-single-${protocol}-`));
      const child = spawn(RUST_BIN, [], {
        env: {
          ...process.env,
          MIAO_TOKEN: TOKEN,
          MIAO_ENGINE_PROTOCOL: protocol,
          MIAO_RUNTIME_ROOT: base,
          MIAO_ROOT: path.join(base, 'root'),
          MIAO_STATE_DIR: path.join(base, 'state'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let buf = '';
      const to = setTimeout(() => {
        child.kill();
        resolve(buf);
      }, 4000);
      child.stdout.on('data', (d) => (buf += d));
      child.stderr.on('data', (d) => (buf += d));
      child.on('close', () => {
        clearTimeout(to);
        resolve(buf);
      });
      child.on('error', (e) => {
        clearTimeout(to);
        reject(e);
      });
    });

  const real = (await warnsFor('real')).split(/\r?\n/).filter((l) => l.includes('引擎运行时未就绪'));
  const mock = (await warnsFor('mock')).split(/\r?\n/).filter((l) => l.includes('引擎运行时未就绪'));
  check(
    'B3.d real 档 + runtime 未装配 ⇒ 启动日志逐项报「运行时未就绪」（B1 验收②）',
    real.length === 5 && real.every((l) => /· (venvRoot|python|source|deps|patches)：.*[A-Z]:\\|~\//.test(l)),
    real,
  );
  check('B3.d2 mock 档**不**报运行时未就绪（mock 不要真引擎，报了会误导用户）', mock.length === 0, mock);
}
if (REFUTE) {
  if (failed > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }
  const original = fs.readFileSync(PROBE_RS, 'utf8');

  function rebuild() {
    const b = spawn(CARGO, ['build', '--bin', 'boxsvc'], { cwd: SRC_TAURI, stdio: 'ignore' });
    return new Promise((resolve) => {
      b.on('close', (c) => resolve(c === 0));
      b.on('error', () => resolve(false));
    });
  }

  const mutations = [
    {
      id: 'M1',
      what: '检测侧另写一份推导（写死 POSIX 的 venv/bin/python）',
      edit: () => {
        // 把 `paths::engine_python()` 换成手拼路径 —— 这就是 R1 的成因写法
        const weak = original.replace(
          /let py = paths::engine_python\(\);/,
          'let py = venv_dir().join("bin").join("python");',
        );
        if (weak === original) throw new Error('M1 锚点未命中');
        fs.writeFileSync(PROBE_RS, weak);
      },
      probe: async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-single-M1-'));
        const env = fixtureEnv(base);
        const launch = await launchInterpreter(env);
        const probe = await probeInterpreter(env);
        fs.rmSync(base, { recursive: true, force: true });
        return launch !== probe;
      },
    },
  ];

  let allRed = true;
  for (const m of mutations) {
    try {
      m.edit();
      // 🔴 改了 Rust 源码必须**重编译**：靶子是另一个进程，不重编等于没改
      if (!(await rebuild())) throw new Error('cargo build 失败');
      const red = await m.probe();
      if (!red) allRed = false;
      console.log(`  ${red ? '✓' : '✗'} ${m.id} ${m.what} → ${red ? '按预期变红' : '**没有红**'}`);
    } catch (e) {
      allRed = false;
      console.log(`  ✗ ${m.id} ${m.what} → 变异本身失败：${String(e.message || e).slice(0, 200)}`);
    } finally {
      fs.writeFileSync(PROBE_RS, original);
      await rebuild();
    }
  }
  check('REFUTE.restore — runtime_probe.rs 已按字节还原', fs.readFileSync(PROBE_RS, 'utf8') === original);
  console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed, allRed }));
  console.log(
    `\nB3 路径单源化：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`,
  );
  process.exit(allRed && failed === 0 ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(
  `\nB3 路径单源化：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`,
);
process.exit(failed === 0 ? 0 : 1);
