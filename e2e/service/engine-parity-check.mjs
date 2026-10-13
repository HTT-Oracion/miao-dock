#!/usr/bin/env node
/**
 * F4 · engine 耦合点 **同源**钉子 —— Rust(`boxsvc/engine.rs`) 与 Node(`engine-client.mjs`) 同输入同输出
 * =================================================================================
 * 为什么必须有它：`engine-client.mjs` 是 box-service 与翻译引擎之间的**唯一耦合点**（《04》§3.3）：
 * 启动配方（`python main.py` 而不是 `-m server.main`）、就绪档位、代理旁路（D-86）、HF 离线（B3/D-100）、
 * 引擎 stdio 编码（D-88）、结果流 5 字节帧…… 这些**没有一条会在改错时崩溃** —— 它们全都表现为
 * 「引擎起不来 / 翻译静默变差 / 日志乱码」，而根因离现象极远。Rust 化过程中最容易发生的事就是
 * 「照记忆重写了一份、逐字节不同」。于是这里把两边在**同一份固定输入**下的产物逐条钉住。
 *
 * ## 机制（输入的唯一事实源在 Rust）
 *   · `boxsvc --engine-selftest` 打印 `pureInputs`（帧字节 / 无代理 env / HF 情形 / 启动 overrides）
 *     + `pure`（Rust 输出）+ `launch` / `llmLaunch` / `configSnapshot` / `constants`
 *   · 本脚本**只读** Rust 给的输入，跑**真 `engine-client.mjs`** 算同一份，再与 Rust 的输出比对
 *
 * ## 为什么 Node 侧要另起子进程
 * `config.mjs` 在**模块加载期**读 env ⇒ 同一进程里改不了协议（real/mock 各要跑一遍）。
 * 故 `--report` 模式用子进程按指定协议重新加载，父进程只做对拍。
 *
 * ## 断言
 *   ENG.constants.*            常量（DEFAULT_DETECTION_SIZE / LLAMA_VERSION_DIR / LLM_OWNER / TIER_LLM_MODELS）
 *   ENG.engineVersion          ENGINE_VERSION（安装事实）
 *   ENG.pure.*                 engineLocalNoProxy / engineHfOfflineEnv / availableTiers / tierModelPath /
 *                              translationSnapshotDir / translationWeightsPresent
 *   ENG.frames.*               结果流：伪引擎喂帧 → 两边给出的 {result 字节, ext, mime} 与阶段日志行相同
 *   ENG.configSnapshot         §5.2 的 config 块（camelCase 7 键）
 *   ENG.launch                 引擎启动配方（cmd / cwd / executorPort / probes / 注入 env）
 *   ENG.llmLaunch              引擎③ 配方（real=llama-server / mock=仓内替身）
 *
 * ## 反证轮（--refute）
 *   M1 只给 Rust 换协议（mock）⇒ 与 Node 的 real 报告对不上 → 该场景变红
 *   M2 篡改 Rust 启动 cmd（丢 --use-gpu）     → launch 变红
 *   M3 篡改 Rust 注入 env（PYTHONIOENCODING）  → launch 变红
 *   M4 删 Rust 一条阶段日志行                  → frames 变红
 *   M5 篡改 Rust 档位权重路径                  → pure.tierModelPath 变红
 *
 * 用法：node e2e/service/engine-parity-check.mjs [--refute]
 * 前置：`cd app/src-tauri && cargo build --bin boxsvc`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RUST_BIN } from './_service-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const REFUTE = process.argv.includes('--refute');
const REPORT = process.argv.includes('--report'); // 子进程模式：跑 Node 一份报告

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 子进程模式（--report）

if (REPORT) {
  const rustPath = process.argv[process.argv.indexOf('--rust') + 1];
  const rust = JSON.parse(fs.readFileSync(rustPath, 'utf8'));
  const node = await buildNodeReport(rust);
  console.log('[NODE]' + JSON.stringify(node));
  process.exit(0);
}

// ------------------------------------------------------------------ 结果收集

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

/** 起子进程收 stdout（🔴 异步 spawn：本机 execFileSync/spawnSync 会 EBUSY）。 */
function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${err.slice(0, 800)}`))));
  });
}

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  }
  return v;
}
const sameJSON = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// ------------------------------------------------------------------ 环境（Rust 子进程与 Node 子进程共用）

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-engine-parity-'));
const TMP_ROOT = path.join(TMP, 'root');
const TMP_STATE = path.join(TMP, 'state');
fs.mkdirSync(TMP_ROOT, { recursive: true });
fs.mkdirSync(TMP_STATE, { recursive: true });

function protoEnv(protocol, port, extra = {}) {
  return {
    MIAO_ROOT: TMP_ROOT,
    MIAO_STATE_DIR: TMP_STATE,
    MIAO_TOKEN: 'e'.repeat(64),
    MIAO_ENGINE_PROTOCOL: protocol,
    MIAO_ENGINE_PYTHON: '/py/python',
    MIAO_ENGINE_PORT: String(port),
    MIAO_ENGINE_PROBE_MS: '400',
    NO_PROXY: 'parity.example',
    ...extra,
  };
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
async function findFreePort(start = 5490) {
  for (let p = start; p < start + 200; p += 1) if (await isPortFree(p)) return p;
  throw new Error('找不到空闲端口');
}

async function dumpRust(env) {
  if (!fs.existsSync(RUST_BIN)) {
    throw new Error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd app/src-tauri && cargo build --bin boxsvc`);
  }
  return JSON.parse((await run(RUST_BIN, ['--engine-selftest'], env)).trim());
}

async function dumpNode(rust, env) {
  const rustFile = path.join(TMP, `rust-${env.MIAO_ENGINE_PROTOCOL}.json`);
  fs.writeFileSync(rustFile, JSON.stringify(rust));
  const out = await run(process.execPath, [import.meta.filename, '--report', '--rust', rustFile], env);
  const line = out.split('\n').find((l) => l.startsWith('[NODE]'));
  if (!line) throw new Error(`Node 报告缺失（stdout 尾部：${out.slice(-300)}）`);
  return JSON.parse(line.slice('[NODE]'.length));
}

// ------------------------------------------------------------------ Node 报告（--report 模式调用）

async function buildNodeReport(rust) {
  const imp = (rel) => import(pathToFileURL(path.join(REPO_ROOT, rel)).href);
  const EC = await imp('service/src/engine-client.mjs');
  const CFG = await imp('service/src/config.mjs');
  const { encodePng } = await imp('engine/src/png.mjs');

  const inp = rust.pureInputs;

  // ---- 纯函数 ----
  const engineLocalNoProxy = inp.noProxyEnvs.map((e) => EC.engineLocalNoProxy(e));
  const engineHfOfflineEnv = inp.hfCases.map((c) => EC.engineHfOfflineEnv({ present: c.present, disabled: c.disabled }));
  const tierModelPath = ['tiny', 'small', 'medium'].map((tier) => ({ tier, path: EC.tierModelPath(tier) ?? null }));

  const pure = {
    engineLocalNoProxy,
    engineHfOfflineEnv,
    availableTiers: EC.availableTiers(),
    tierModelPath,
    translationSnapshotDir: EC.translationSnapshotDir() ?? null,
    translationWeightsPresent: EC.translationWeightsPresent(),
  };

  // ---- 结果流：伪引擎喂帧 → 真 translateImage ----
  const frames = [];
  if (rust.protocol === 'real') {
    const port = Number(process.env.MIAO_ENGINE_PORT);
    const state = { body: Buffer.alloc(0) };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const pathname = String(req.url || '').split('?')[0];
        if (req.method === 'POST' && pathname === '/translate/image/stream') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': state.body.length });
          res.end(state.body);
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Not Found' }));
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    const png = encodePng(20, 24, (x, y, put) => put(x % 256, y % 256, 128));
    for (const c of inp.frames) {
      state.body = Buffer.from(c.b64, 'base64');
      EC.clearStageLog();
      let result = null;
      let errText = null;
      try {
        const r = await EC.translateImage(png, { seq: c.seq });
        result = { resultB64: r.bytes.toString('base64'), ext: r.ext, mime: r.mime };
      } catch (e) {
        errText = e.message;
      }
      await sleep(5);
      frames.push({ name: c.name, seq: c.seq, ...(result || { resultB64: null, ext: null, mime: null }), errText, stageLines: EC.recentStageLog(50) });
    }
    await new Promise((r) => server.close(r));
  }

  // ---- 启动配方 ----
  const launch = EC.resolveEngineLaunch(inp.launchOverrides);
  const llmLaunch = EC.resolveLlmLaunch(inp.llmOverrides);

  return {
    protocol: CFG.config.engineProtocol,
    engineVersion: EC.ENGINE_VERSION ?? null,
    constants: {
      ENGINE_DEFAULT_DETECTION_SIZE: EC.ENGINE_DEFAULT_DETECTION_SIZE,
      LLAMA_VERSION_DIR: EC.LLAMA_VERSION_DIR,
      LLM_OWNER: EC.LLM_OWNER,
      TIER_LLM_MODELS: EC.TIER_LLM_MODELS,
    },
    pure,
    frames,
    configSnapshot: EC.engineConfigSnapshot(),
    launch,
    llmLaunch,
  };
}

// ------------------------------------------------------------------ 投影（只比契约面，规避 env 大小写折叠 / execPath 等环境差异）

function projLaunch(l) {
  const env = l.env || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(env, k);
  const injected = {};
  for (const k of ['PYTHONIOENCODING', 'SAKURA_API_BASE', 'MT_WEB_NONCE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE']) {
    injected[k] = has(k) ? env[k] : null;
  }
  // Windows 的 env 大小写不敏感（Node 会折叠 NO_PROXY/no_proxy）⇒ 取先有的那个，只比合并值。
  const noProxy = (has('NO_PROXY') ? env.NO_PROXY : has('no_proxy') ? env.no_proxy : null) ?? null;
  return { label: l.label, cmd: l.cmd, cwd: l.cwd ?? null, executorPort: l.executorPort ?? null, probes: l.probes, envInjected: injected, noProxy };
}
function projLlm(l) {
  if (l && l.error) return { error: l.error };
  return { label: l.label, tier: l.tier ?? null, model: l.model ?? null, cmd: l.cmd, cwd: l.cwd ?? null, probes: l.probes };
}
function projFrames(frames) {
  return frames.map((f) => ({ name: f.name, resultB64: f.resultB64 ?? null, ext: f.ext ?? null, mime: f.mime ?? null, stageLines: f.stageLines }));
}

// ------------------------------------------------------------------ 正向

console.log('=== F4 · engine 耦合点同源（Rust boxsvc --engine-selftest  ⟷  Node engine-client.mjs）===');

async function compareProtocol(protocol, port, extraEnv) {
  const env = protoEnv(protocol, port, extraEnv);
  const rust = await dumpRust(env);
  const node = await dumpNode(rust, env);
  const tag = protocol;

  check(`ENG.${tag}.constants — 常量相同`, sameJSON(rust.constants, node.constants), { rust: rust.constants, node: node.constants });
  check(`ENG.${tag}.engineVersion — ENGINE_VERSION 相同`, rust.engineVersion === node.engineVersion, `rust=${rust.engineVersion} node=${node.engineVersion}`);

  for (const key of ['engineLocalNoProxy', 'engineHfOfflineEnv', 'availableTiers', 'tierModelPath', 'translationSnapshotDir', 'translationWeightsPresent']) {
    check(
      `ENG.${tag}.pure.${key} — 相同`,
      sameJSON(rust.pure[key], node.pure[key]),
      sameJSON(rust.pure[key], node.pure[key]) ? undefined : { rust: rust.pure[key], node: node.pure[key] },
    );
  }

  check(
    `ENG.${tag}.configSnapshot — §5.2 的 config 块相同`,
    sameJSON(rust.configSnapshot, node.configSnapshot),
    { rust: canon(rust.configSnapshot), node: canon(node.configSnapshot) },
  );

  check(
    `ENG.${tag}.launch — 引擎启动配方相同（cmd/cwd/executorPort/probes/注入 env）`,
    sameJSON(projLaunch(rust.launch), projLaunch(node.launch)),
    { rust: projLaunch(rust.launch), node: projLaunch(node.launch) },
  );

  check(
    `ENG.${tag}.llmLaunch — 引擎③ 配方相同`,
    sameJSON(projLlm(rust.llmLaunch), projLlm(node.llmLaunch)),
    { rust: projLlm(rust.llmLaunch), node: projLlm(node.llmLaunch) },
  );

  // 结果流（仅 real：mock 协议走的是另一套单包响应，不解析帧）
  if (protocol === 'real') {
    const r = projFrames(rust.pure.parseResultStream);
    const n = projFrames(node.frames);
    check(`ENG.${tag}.frames.resultExtMime — 每帧的 {结果字节, ext, mime} 相同`, sameJSON(r.map(({ name, resultB64, ext, mime }) => ({ name, resultB64, ext, mime })), n.map(({ name, resultB64, ext, mime }) => ({ name, resultB64, ext, mime }))), { rust: r, node: n });
    check(`ENG.${tag}.frames.stageLines — 阶段日志行相同（seq N: 引擎原话）`, sameJSON(r.map(({ name, stageLines }) => ({ name, stageLines })), n.map(({ name, stageLines }) => ({ name, stageLines }))), { rust: r.map(({ name, stageLines }) => ({ name, stageLines })), node: n.map(({ name, stageLines }) => ({ name, stageLines })) });
  }

  return { rust, node };
}

let realPair = null;
let mockPair = null;
try {
  const realPort = Number(protoEnv('real', await findFreePort()).MIAO_ENGINE_PORT);
  realPair = await compareProtocol('real', realPort, {});
  const mockPort = await findFreePort(realPort + 50);
  // mock 档附带上「显式下发 detection_size」⇒ 覆盖 configSnapshot 的显式分支
  mockPair = await compareProtocol('mock', mockPort, { MIAO_ENGINE_DETECTION_SIZE: '1024', MIAO_NODE_EXEC: process.execPath });
} catch (e) {
  check('SETUP — 取 Rust / Node 报告', false, String(e.message || e));
}

// ------------------------------------------------------------------ 反证

if (REFUTE) {
  if (failed > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }
  const mutations = [];
  const rustReal = realPair.rust;
  const nodeReal = realPair.node;

  // M1：只给 Rust 换协议 ⇒ 与 Node 的 real 报告对不上（证明「两边都跑了」而不是「比了同一份缓存」）
  {
    let red = false;
    let info = null;
    try {
      const r = await dumpRust(protoEnv('mock', 5555, {}));
      red = r.engineVersion !== nodeReal.engineVersion || !sameJSON(r.pure.availableTiers, nodeReal.pure.availableTiers);
      info = { rustVersion: r.engineVersion, rustTiers: r.pure.availableTiers, nodeVersion: nodeReal.engineVersion };
    } catch (e) {
      info = String(e.message || e);
    }
    mutations.push({ id: 'M1', what: 'Rust 侧协议换成 mock（与 Node 的 real 对不上）', red, info });
  }
  // M2：篡改 Rust 启动 cmd
  mutations.push({
    id: 'M2',
    what: '篡改 Rust 启动 cmd（丢 --use-gpu）',
    red: !sameJSON(projLaunch({ ...rustReal.launch, cmd: rustReal.launch.cmd.filter((x) => x !== '--use-gpu') }), projLaunch(nodeReal.launch)),
  });
  // M3：篡改 Rust 注入 env
  mutations.push({
    id: 'M3',
    what: '篡改 Rust 注入 env（PYTHONIOENCODING → gbk）',
    red: !sameJSON(projLaunch({ ...rustReal.launch, env: { ...rustReal.launch.env, PYTHONIOENCODING: 'gbk' } }), projLaunch(nodeReal.launch)),
  });
  // M4：删 Rust 一条阶段日志行
  mutations.push({
    id: 'M4',
    what: '删 Rust 一条阶段日志行',
    red: (() => {
      const p = JSON.parse(JSON.stringify(rustReal.pure.parseResultStream));
      const withLines = p.find((x) => x.stageLines.length > 0);
      withLines.stageLines = withLines.stageLines.slice(1);
      return !sameJSON(projFrames(p).map(({ name, stageLines }) => ({ name, stageLines })), projFrames(nodeReal.frames).map(({ name, stageLines }) => ({ name, stageLines })));
    })(),
  });
  // M5：篡改 Rust 档位权重路径
  mutations.push({
    id: 'M5',
    what: '篡改 Rust tierModelPath（tiny 指向别的文件）',
    red: !sameJSON(
      rustReal.pure.tierModelPath.map((x) => (x.tier === 'tiny' ? { ...x, path: '/nope/other.gguf' } : x)),
      nodeReal.pure.tierModelPath,
    ),
  });

  let allRed = true;
  for (const m of mutations) {
    if (!m.red) allRed = false;
    console.log(`  ${m.red ? '✓' : '✗'} ${m.id} ${m.what} → ${m.red ? '按预期变红' : '**没有红**（断言漏了它）'}${m.info ? ` ${JSON.stringify(m.info)}` : ''}`);
  }
  console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed, allRed }));
  console.log(`\nF4 engine 同源：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`);
  process.exit(allRed ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(`\nF4 engine 同源：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`);
process.exit(failed === 0 ? 0 : 1);
