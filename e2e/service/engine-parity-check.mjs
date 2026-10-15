#!/usr/bin/env node
/**
 * F4 · engine 耦合点同源钉子 —— Rust(`mangasvc/engine.rs`) 对冻结 golden 快照
 * =================================================================================
 * 为什么必须有它：`engine-client.mjs` 曾是 manga-service 与翻译引擎之间的**唯一耦合点**：
 * 启动配方（`python main.py`）、就绪档位、代理旁路（D-86）、HF 离线（B3/D-100）、
 * 引擎 stdio 编码（D-88）、结果流 5 字节帧…… 这些**没有一条会在改错时崩溃**——全都表现为
 * 「引擎起不来 / 翻译静默变差 / 日志乱码」，而根因离现象极远。Rust 化过程中最容易发生的就是
 * 「照记忆重写了一份、逐字节不同」。
 *
 * ## 机制（F5 摘除 Node 后：Rust 输出 ⟷ 冻结 golden）
 *   · `mangasvc --engine-selftest` 打印 `pure` / `launch` / `llmLaunch` / `configSnapshot` /
 *     `constants` / `engineVersion`（real 与 mock 两档各一份）。
 *   · golden 快照 `e2e/service/golden/engine-selftest.json` 是「Node 版 engine-client 在同源
 *     对齐时代冻结的最后一份正确输出」，此后作为单向金标：Rust 侧任何一次悄然漂移必红。
 *   · 投影（projLaunch/projLlm/projFrames）只比契约面，规避动态端口 / env 大小写折叠；
 *     canon 剔 `updatedAt` + 路径归一化（home/仓库根 → `<HOME>`/`<REPO>`）。
 *
 * ## 断言
 *   ENG.<档>.constants / engineVersion / pure.* / configSnapshot / launch / llmLaunch / frames.*
 *
 * ## 反证轮（--refute）
 *   M1 换协议（real↔mock）⇒ 与 golden 对不上（证明「两边都跑了」而非比了同一份缓存）
 *   M2–M5 篡改 golden（cmd / env / 阶段日志 / 权重路径）⇒ 对应断言变红
 *
 * 用法：node e2e/service/engine-parity-check.mjs [--refute]
 * 前置：`cd src-tauri && cargo build --bin mangasvc`
 * 重新生成 golden：`node e2e/service/_gen-golden.mjs engine`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUST_BIN } from './_service-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const GOLDEN = path.join(HERE, 'golden', 'engine-selftest.json');
const REFUTE = process.argv.includes('--refute');

const normStr = (s) =>
  s.replace(/[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+/g, '<HOME>').replaceAll(REPO_ROOT, '<REPO>');

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
    console.log(`  ✗ ${name}${extra !== undefined ? `  → ${JSON.stringify(extra).slice(0, 500)}` : ''}`);
  }
}

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', reject);
    c.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${err.slice(0, 800)}`)),
    );
  });
}

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (k === 'updatedAt') continue;
      out[k] = canon(v[k]);
    }
    return out;
  }
  if (typeof v === 'string') return normStr(v);
  return v;
}
const sameJSON = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// ------------------------------------------------------------------ 环境（与 _gen-golden.mjs 完全一致）

const REAL_ENV = {
  MIAO_ENGINE_PROTOCOL: 'real',
  MIAO_ENGINE_PYTHON: '/py/python',
  NO_PROXY: 'parity.example',
  MIAO_ENGINE_PROBE_MS: '400',
};
const MOCK_ENV = { MIAO_ENGINE_PROTOCOL: 'mock', MIAO_ENGINE_DETECTION_SIZE: '1024' };

async function dumpRust(env) {
  if (!fs.existsSync(RUST_BIN)) {
    throw new Error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd src-tauri && cargo build --bin mangasvc`);
  }
  return JSON.parse((await run(RUST_BIN, ['--engine-selftest'], env)).trim());
}

// ------------------------------------------------------------------ 投影（只比契约面）

function projLaunch(l) {
  const env = l.env || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(env, k);
  const injected = {};
  for (const k of ['PYTHONIOENCODING', 'SAKURA_API_BASE', 'MT_WEB_NONCE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE'])
    injected[k] = has(k) ? env[k] : null;
  const noProxy = (has('NO_PROXY') ? env.NO_PROXY : has('no_proxy') ? env.no_proxy : null) ?? null;
  return {
    label: l.label,
    cmd: l.cmd,
    cwd: l.cwd ?? null,
    executorPort: l.executorPort ?? null,
    probes: l.probes,
    envInjected: injected,
    noProxy,
  };
}
function projLlm(l) {
  if (l && l.error) return { error: l.error };
  return {
    label: l.label,
    tier: l.tier ?? null,
    model: l.model ?? null,
    cmd: l.cmd,
    cwd: l.cwd ?? null,
    probes: l.probes,
  };
}
function projFrames(frames) {
  return frames.map((f) => ({
    name: f.name,
    resultB64: f.resultB64 ?? null,
    ext: f.ext ?? null,
    mime: f.mime ?? null,
    stageLines: f.stageLines,
  }));
}

/** 把 --engine-selftest 原输出投影成与 golden 同形的报告。 */
function project(o) {
  return {
    constants: canon(o.constants),
    engineVersion: o.engineVersion,
    pure: canon(o.pure),
    configSnapshot: canon(o.configSnapshot),
    launch: canon(projLaunch(o.launch)),
    llmLaunch: canon(projLlm(o.llmLaunch)),
    frames: o.pure.parseResultStream ? canon(projFrames(o.pure.parseResultStream)) : null,
  };
}

// ------------------------------------------------------------------ 正向：Rust 输出 ⟷ golden

console.log('=== F4 · engine 耦合点同源（Rust mangasvc --engine-selftest  ⟷  golden 快照）===');

let golden = null;
let realReport = null;
let mockReport = null;
try {
  golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  realReport = project(await dumpRust(REAL_ENV));
  mockReport = project(await dumpRust(MOCK_ENV));
} catch (e) {
  check('SETUP — 取 Rust 报告 / 读 golden', false, String(e.message || e));
}

function compareProtocol(tag, rust, gold) {
  check(`ENG.${tag}.constants — 常量相同`, sameJSON(rust.constants, gold.constants), {
    rust: rust.constants,
    golden: gold.constants,
  });
  check(
    `ENG.${tag}.engineVersion — ENGINE_VERSION 相同`,
    rust.engineVersion === gold.engineVersion,
    `rust=${rust.engineVersion} golden=${gold.engineVersion}`,
  );

  // `llmLaunchByTier` 是 E4 用的新出口（按档位各解析一次 ③ 配方）：并进对拍面后，
  // 「未声明档位必须显式报错」这条契约同时被 golden 与 E4 各钉一次，不会只活在一处。
  for (const key of [
    'engineLocalNoProxy',
    'engineHfOfflineEnv',
    'availableTiers',
    'tierModelPath',
    'llmLaunchByTier',
    'translationSnapshotDir',
    'translationWeightsPresent',
  ]) {
    check(
      `ENG.${tag}.pure.${key} — 相同`,
      sameJSON(rust.pure[key], gold.pure[key]),
      sameJSON(rust.pure[key], gold.pure[key]) ? undefined : { rust: rust.pure[key], golden: gold.pure[key] },
    );
  }

  check(`ENG.${tag}.configSnapshot — §5.2 的 config 块相同`, sameJSON(rust.configSnapshot, gold.configSnapshot), {
    rust: rust.configSnapshot,
    golden: gold.configSnapshot,
  });

  check(`ENG.${tag}.launch — 引擎启动配方相同`, sameJSON(rust.launch, gold.launch), {
    rust: rust.launch,
    golden: gold.launch,
  });
  check(`ENG.${tag}.llmLaunch — 引擎③ 配方相同`, sameJSON(rust.llmLaunch, gold.llmLaunch), {
    rust: rust.llmLaunch,
    golden: gold.llmLaunch,
  });

  if (tag === 'real' && gold.frames) {
    check('ENG.real.frames — 每帧 {结果字节, ext, mime, 阶段日志} 相同', sameJSON(rust.frames, gold.frames), {
      rust: rust.frames,
      golden: gold.frames,
    });
  }
}

if (realReport && mockReport && golden) {
  compareProtocol('real', realReport, golden.real);
  compareProtocol('mock', mockReport, golden.mock);
}

// ------------------------------------------------------------------ 反证

if (REFUTE) {
  if (failed > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }
  const mutations = [];

  // M1：换协议 ⇒ 与 golden 对不上（证明「两边都跑了」而非比了同一份缓存）
  {
    let red = false;
    let info = null;
    try {
      const r = project(await dumpRust({ MIAO_ENGINE_PROTOCOL: 'mock' })); // 缺 real 档的 python/no_proxy 注入
      red = !sameJSON(r.launch, golden.real.launch);
      info = { mockCmd: r.launch.cmd };
    } catch (e) {
      info = String(e.message || e);
    }
    mutations.push({ id: 'M1', what: 'Rust 侧换成 mock 档（与 real golden 对不上）', red, info });
  }
  // M2：篡改 golden 启动 cmd
  mutations.push({
    id: 'M2',
    what: '篡改 golden 启动 cmd（丢 --use-gpu）',
    red: !sameJSON(
      { ...golden.real.launch, cmd: golden.real.launch.cmd.filter((x) => x !== '--use-gpu') },
      realReport.launch,
    ),
  });
  // M3：篡改 golden 注入 env
  mutations.push({
    id: 'M3',
    what: '篡改 golden 注入 env（PYTHONIOENCODING → gbk）',
    red: !sameJSON(
      { ...golden.real.launch, envInjected: { ...golden.real.launch.envInjected, PYTHONIOENCODING: 'gbk' } },
      realReport.launch,
    ),
  });
  // M4：删 golden 一条阶段日志行
  mutations.push({
    id: 'M4',
    what: '删 golden 一条阶段日志行',
    red: (() => {
      const g = JSON.parse(JSON.stringify(golden.real.frames));
      const withLines = g.find((x) => x.stageLines.length > 0);
      withLines.stageLines = withLines.stageLines.slice(1);
      return !sameJSON(g, realReport.frames);
    })(),
  });
  // M5：篡改 golden 档位权重路径
  mutations.push({
    id: 'M5',
    what: '篡改 golden tierModelPath（tiny 指向别的文件）',
    red: !sameJSON(
      golden.real.pure.tierModelPath.map((x) => (x.tier === 'tiny' ? { ...x, path: '/nope/other.gguf' } : x)),
      realReport.pure.tierModelPath,
    ),
  });

  let allRed = true;
  for (const m of mutations) {
    if (!m.red) allRed = false;
    console.log(
      `  ${m.red ? '✓' : '✗'} ${m.id} ${m.what} → ${m.red ? '按预期变红' : '**没有红**（断言漏了它）'}${m.info ? ` ${JSON.stringify(m.info)}` : ''}`,
    );
  }
  console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed, allRed }));
  console.log(
    `\nF4 engine 同源：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`,
  );
  process.exit(allRed ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(
  `\nF4 engine 同源：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`,
);
process.exit(failed === 0 ? 0 : 1);
