#!/usr/bin/env node
/**
 * F4-b · engine **HTTP 运行期** 同源钉子 —— Rust(`boxsvc/engine/client.rs`) ⟷ Node(`engine-client.mjs`)
 * =========================================================================================
 * F4-a（`engine-parity-check.mjs`）钉住的是**纯函数**（启动配方 / 参数快照 / 帧解析）。
 * 这条钉住的是**真的发了 HTTP 的那一半**：`requestOnce` / `probeTcp` / `translateImage`(real+mock)
 * / `probeEngine`（三重判定）与阶段日志环 —— 它们改错时**一条断言都不会崩**，只会表现为
 * 「翻译静默变差 / 引擎看着在跑但第一张必挂 / 卡住后无法归因」。
 *
 * ## 机制（同一台「伪引擎」服务器，两边各打一遍）
 *   · 本脚本按用例起一个 **Node http 伪引擎**（返回固定的 5 字节帧 / 状态码 / 慢响应），
 *     并**记录**收到的请求（method/path/headers/body）。
 *   · Rust 侧：`boxsvc --engine-http-selftest '<cases>'`（新建 tokio runtime 真发 HTTP）。
 *   · Node 侧：`--report` 子进程（`config.mjs` 在**加载期读 env**，端口/协议只能在子进程里切）。
 *   · 两边结果**逐例**比对：translate 比 `{ok,code,ext,mime,bytesB64,stageLines}`；
 *     probe 比 9 字段；另有若干例比**请求体**（data URI + `config`）。
 *
 * ## 反证轮（--refute）
 *   M1 篡改 Rust 返回的 ext（png→jpg）        → translate 变红
 *   M2 删 Rust 一条阶段日志行                  → translate 变红（阶段是诊断视图唯一来源）
 *   M3 篡改 Rust 的 probe state（running→prewarming） → probe 变红
 *   M4 删 Rust 请求体里 translator 的一个键    → payload 变红
 *   M5 篡改 Rust mock 例的 mime                → translate 变红
 *
 * 用法：node e2e/service/engine-http-parity-check.mjs [--refute]
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
const REPORT = process.argv.includes('--report');
const PROBE_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { encodePng } = await import(pathToFileURL(path.join(REPO_ROOT, 'engine/src/png.mjs')).href);
const PNG = encodePng(20, 24, (x, y, put) => put(x % 256, y % 256, 128));

// ------------------------------------------------------------------ 帧（1 字节 code + 4 字节大端长度 + 数据）
const frame = (code, data) => {
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data ?? '', 'utf8');
  const h = Buffer.alloc(5);
  h[0] = code;
  h.writeUInt32BE(d.length, 1);
  return Buffer.concat([h, d]);
};

// ------------------------------------------------------------------ 伪引擎行为表（按用例场景）
const octet = (res, body) =>
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }).end(body);
const notFound = (res) => {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ detail: 'Not Found' }));
};

const BEHAVIORS = {
  // ---- real：结果流 ----
  ok: (res, p) => (p === '/translate/image/stream'
    ? octet(res, Buffer.concat([frame(1, '识别中…'), frame(3, '2'), frame(4, ''), frame(0, PNG)]))
    : notFound(res)),
  err: (res, p) => (p === '/translate/image/stream'
    ? octet(res, Buffer.concat([frame(1, '识别中'), frame(2, 'boom')]))
    : notFound(res)),
  nores: (res, p) => (p === '/translate/image/stream'
    ? octet(res, Buffer.concat([frame(1, '识别中')]))
    : notFound(res)),
  badout: (res, p) => (p === '/translate/image/stream'
    ? octet(res, Buffer.concat([frame(0, Buffer.from('not an image at all'))]))
    : notFound(res)),
  http422: (res) => {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'bad input' }));
  },
  http500: (res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('oops');
  },
  // 先吐一帧进度再挂住 ⇒ 客户端空闲超时，且**必须带走已收到的字节**（U10② 的机制）
  slow: (res, p) => {
    if (p !== '/translate/image/stream') return notFound(res);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write(frame(1, '开始'));
    setTimeout(() => {
      try {
        res.end();
      } catch {
        /* 对端已断开 */
      }
    }, 4000);
  },
  // ---- 就绪探针 ----
  queue200: (res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'),
  queue500: (res) => res.writeHead(500, { 'Content-Type': 'application/json' }).end('{}'),
  // ---- mock ----
  mock_translate: (res) => res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG),
  mock_ready: (res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ engine: 'mock-engine' }));
  },
};

// ------------------------------------------------------------------ 用例表
const CASES = [
  { name: 'real.ok_ja_zh', protocol: 'real', kind: 'translate', scenario: 'ok', input: 'png', seq: 1, lang: { from: 'ja', to: 'zh' }, payload: true },
  { name: 'real.ok_en_zh', protocol: 'real', kind: 'translate', scenario: 'ok', input: 'png', seq: 2, lang: { from: 'en', to: 'zh' }, payload: true },
  { name: 'real.err_frame', protocol: 'real', kind: 'translate', scenario: 'err', input: 'png', seq: 3 },
  { name: 'real.no_result_frame', protocol: 'real', kind: 'translate', scenario: 'nores', input: 'png', seq: 4 },
  { name: 'real.bad_output_bytes', protocol: 'real', kind: 'translate', scenario: 'badout', input: 'png', seq: 5 },
  { name: 'real.http_422', protocol: 'real', kind: 'translate', scenario: 'http422', input: 'png', seq: 6 },
  { name: 'real.http_500_plain', protocol: 'real', kind: 'translate', scenario: 'http500', input: 'png', seq: 7 },
  { name: 'real.empty_input', protocol: 'real', kind: 'translate', scenario: 'none', input: 'empty', seq: 8 },
  { name: 'real.timeout_partial', protocol: 'real', kind: 'translate', scenario: 'slow', input: 'png', seq: 9, timeoutMs: 700 },
  { name: 'real.probe_running', protocol: 'real', kind: 'probe', scenario: 'probe_running' },
  { name: 'real.probe_prewarming', protocol: 'real', kind: 'probe', scenario: 'probe_prewarming' },
  { name: 'real.probe_starting', protocol: 'real', kind: 'probe', scenario: 'probe_starting' },
  { name: 'real.probe_stopped', protocol: 'real', kind: 'probe', scenario: 'probe_stopped' },
  { name: 'mock.ok', protocol: 'mock', kind: 'translate', scenario: 'mock_translate', input: 'png', seq: 10 },
  { name: 'mock.probe_running', protocol: 'mock', kind: 'probe', scenario: 'mock_ready' },
  { name: 'mock.probe_stopped', protocol: 'mock', kind: 'probe', scenario: 'mock_stopped' },
];

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

/** 异步 spawn 收 stdout（🔴 本机 execFileSync/spawnSync 起子进程会 EBUSY）。 */
function runCmd(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', reject);
    c.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${err.slice(0, 600)}`)),
    );
  });
}

// ------------------------------------------------------------------ 端口分配（保证 P 与 P+1 都空）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-engine-http-'));
const used = new Set();
let cursor = 5700;
const nextStart = () => (cursor += 20);

const isPortFree = (p) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
  });

async function allocPort(start) {
  for (let p = start; p < start + 400; p += 1) {
    if (used.has(p)) continue;
    if (await isPortFree(p)) {
      used.add(p);
      return p;
    }
  }
  throw new Error('找不到空闲端口');
}
async function allocPair(start) {
  for (let p = start; p < start + 400; p += 1) {
    if (used.has(p) || used.has(p + 1)) continue;
    if ((await isPortFree(p)) && (await isPortFree(p + 1))) {
      used.add(p);
      used.add(p + 1);
      return p;
    }
  }
  throw new Error('找不到空闲端口对');
}

const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
const closeAll = (servers) =>
  Promise.all(
    servers.map(
      (s) =>
        new Promise((r) => {
          try {
            s.closeAllConnections?.();
            s.close(() => r());
          } catch {
            r();
          }
        }),
    ),
  );

// ------------------------------------------------------------------ 每个用例：起伪引擎 + 记录请求
function makeServer(behavior) {
  const rec = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const p = String(req.url || '').split('?')[0];
      rec.push({
        method: req.method,
        path: p,
        contentType: req.headers['content-type'] ?? null,
        bodyB64: Buffer.concat(chunks).toString('base64'),
      });
      behavior(res, p);
    });
  });
  return { server, rec };
}

async function setupCase(c) {
  const ctx = { servers: [], rec: [] };
  const s = c.scenario;
  if (s === 'none' || s === 'probe_stopped' || s === 'mock_stopped') {
    c.port = await allocPort(nextStart());
    return ctx;
  }
  if (s === 'probe_running') {
    c.port = await allocPair(nextStart());
    const a = makeServer(BEHAVIORS.queue200);
    ctx.servers.push(a.server);
    ctx.rec = a.rec;
    await listen(a.server, c.port);
    // 执行器端口（port+1）单独一个纯 TCP 监听（就绪判定的第 ③ 层）
    const b = net.createServer((sock) => sock.on('error', () => {}));
    ctx.servers.push(b);
    await listen(b, c.port + 1);
    return ctx;
  }
  if (s === 'probe_prewarming' || s === 'probe_starting') {
    c.port = await allocPair(nextStart());
    const a = makeServer(s === 'probe_prewarming' ? BEHAVIORS.queue200 : BEHAVIORS.queue500);
    ctx.servers.push(a.server);
    ctx.rec = a.rec;
    await listen(a.server, c.port);
    return ctx;
  }
  const b = BEHAVIORS[s];
  if (!b) throw new Error(`未知场景 ${s}`);
  c.port = await allocPort(nextStart());
  const a = makeServer(b);
  ctx.servers.push(a.server);
  ctx.rec = a.rec;
  await listen(a.server, c.port);
  return ctx;
}

// ------------------------------------------------------------------ Rust / Node 两侧
function rustCases(list, protocol) {
  return {
    cases: list.map((c) => ({
      name: c.name,
      kind: c.kind,
      protocol: c.protocol,
      host: '127.0.0.1',
      port: c.port,
      timeoutMs: c.timeoutMs ?? (c.protocol === 'mock' ? 60000 : 600000),
      probeMs: PROBE_MS,
      seq: c.seq ?? 0,
      lang: c.lang,
      mime: c.mime,
      inB64: c.inputB64,
    })),
  };
}

async function runRust(list, protocol) {
  if (!fs.existsSync(RUST_BIN)) {
    throw new Error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd app/src-tauri && cargo build --bin boxsvc`);
  }
  const arg = JSON.stringify(rustCases(list, protocol));
  const out = await runCmd(RUST_BIN, ['--engine-http-selftest', arg], {
    MIAO_ENGINE_PROTOCOL: protocol,
    MIAO_ENGINE_PROBE_MS: String(PROBE_MS),
  });
  return JSON.parse(out).results;
}

async function runNode(c) {
  const f = path.join(TMP, `case-${c.name.replace(/[^\w.-]/g, '_')}.json`);
  fs.writeFileSync(
    f,
    JSON.stringify({ name: c.name, kind: c.kind, seq: c.seq, lang: c.lang, mime: c.mime, inB64: c.inputB64 }),
  );
  const out = await runCmd(process.execPath, [import.meta.filename, '--report', '--case', f], {
    MIAO_ENGINE_PROTOCOL: c.protocol,
    MIAO_ENGINE_PORT: String(c.port),
    MIAO_ENGINE_PROBE_MS: String(PROBE_MS),
    MIAO_ENGINE_TIMEOUT_MS: String(c.timeoutMs ?? (c.protocol === 'mock' ? 60000 : 600000)),
  });
  const line = out.split('\n').find((l) => l.startsWith('[NODE]'));
  if (!line) throw new Error(`Node 报告缺失（stdout 尾部：${out.slice(-300)}）`);
  return JSON.parse(line.slice('[NODE]'.length));
}

// ------------------------------------------------------------------ --report 模式
async function runNodeCase(c) {
  const EC = await import(pathToFileURL(path.join(REPO_ROOT, 'service/src/engine-client.mjs')).href);
  if (c.kind === 'probe') {
    return { name: c.name, ok: true, probe: await EC.probeEngine() };
  }
  EC.clearStageLog();
  try {
    const bytes = Buffer.from(c.inB64 || '', 'base64');
    const opts = { seq: c.seq ?? 0 };
    if (c.lang) opts.lang = c.lang;
    if (c.mime) opts.mime = c.mime;
    const r = await EC.translateImage(bytes, opts);
    return {
      name: c.name,
      ok: true,
      bytesB64: r.bytes.toString('base64'),
      ext: r.ext,
      mime: r.mime,
      stageLines: EC.recentStageLog(50),
    };
  } catch (e) {
    return { name: c.name, ok: false, code: e.code ?? e.name, message: e.message, stageLines: EC.recentStageLog(50) };
  }
}

if (REPORT) {
  const c = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--case') + 1], 'utf8'));
  console.log('[NODE]' + JSON.stringify(await runNodeCase(c)));
  process.exit(0);
}

// ------------------------------------------------------------------ 投影
const projTranslate = (r) => ({
  ok: r.ok,
  code: r.ok ? null : r.code,
  ext: r.ok ? r.ext : null,
  mime: r.ok ? r.mime : null,
  bytesB64: r.ok ? r.bytesB64 : null,
  stageLines: r.stageLines ?? [],
});
const projProbe = (r) => r.probe;
function projPayload(rec) {
  const obj = JSON.parse(Buffer.from(rec.bodyB64, 'base64').toString('utf8'));
  return { method: rec.method, path: rec.path, contentType: rec.contentType, image: obj.image, config: obj.config };
}

function compareCase(c, rustR, nodeR) {
  return c.kind === 'probe' ? sameJSON(projProbe(rustR), projProbe(nodeR)) : sameJSON(projTranslate(rustR), projTranslate(nodeR));
}

// ------------------------------------------------------------------ 正向
console.log('=== F4-b · engine HTTP 运行期同源（Rust boxsvc --engine-http-selftest  ⟷  Node engine-client.mjs）===');

const rustByName = new Map();
const nodeByName = new Map();
const payloadPairs = new Map(); // caseName -> { rust, node }
const keepServers = [];

try {
  // 1) 起所有伪引擎
  const contexts = new Map();
  for (const c of CASES) {
    c.inputB64 = c.input === 'empty' ? '' : PNG.toString('base64');
    const ctx = await setupCase(c);
    contexts.set(c.name, ctx);
    keepServers.push(...ctx.servers);
  }

  // 2) Rust：按协议各跑一遍（env 协议在进程内不可变，故分两次）
  for (const protocol of ['real', 'mock']) {
    const list = CASES.filter((c) => c.protocol === protocol);
    if (!list.length) continue;
    for (const r of await runRust(list, protocol)) rustByName.set(r.name, r);
  }

  // 3) Node：逐例子进程（同一台伪引擎的请求记在 ctx.rec：先 Rust、后 Node）
  for (const c of CASES) {
    nodeByName.set(c.name, await runNode(c));
    const rec = contexts.get(c.name).rec;
    if (c.payload && rec.length >= 2) {
      payloadPairs.set(c.name, { rust: projPayload(rec[0]), node: projPayload(rec[1]) });
    }
  }

  // 4) 逐例比对
  for (const c of CASES) {
    const rustR = rustByName.get(c.name);
    const nodeR = nodeByName.get(c.name);
    const label = c.kind === 'probe' ? 'probe' : 'translate';
    check(
      `HTTP.${c.name}.${label} — 相同`,
      rustR && nodeR && compareCase(c, rustR, nodeR),
      { rust: rustR && (c.kind === 'probe' ? projProbe(rustR) : projTranslate(rustR)), node: nodeR && (c.kind === 'probe' ? projProbe(nodeR) : projTranslate(nodeR)) },
    );
  }
  // 5) 请求体（data URI + config）逐例比对
  for (const [name, pair] of payloadPairs) {
    check(`HTTP.${name}.payload — 请求体相同（data URI + config）`, sameJSON(pair.rust, pair.node), pair);
  }
} catch (e) {
  check('SETUP — 取 Rust / Node 结果', false, String(e.message || e));
} finally {
  await closeAll(keepServers);
}

// ------------------------------------------------------------------ 反证
if (REFUTE) {
  if (failed > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }
  const tc = CASES.find((c) => c.name === 'real.ok_ja_zh');
  const mc = CASES.find((c) => c.name === 'mock.ok');
  const pc = CASES.find((c) => c.name === 'real.probe_running');
  const rustT = rustByName.get('real.ok_ja_zh');
  const rustM = rustByName.get('mock.ok');
  const nodeT = nodeByName.get('real.ok_ja_zh');
  const nodeM = nodeByName.get('mock.ok');
  const rustP = rustByName.get('real.probe_running');
  const nodeP = nodeByName.get('real.probe_running');
  const pair = payloadPairs.get('real.ok_ja_zh');

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const mutations = [];

  // M1：篡改 Rust 返回的 ext
  mutations.push({
    id: 'M1',
    what: '篡改 Rust 返回的 ext（png→jpg）',
    red: (() => {
      const m = clone(rustT);
      m.ext = 'jpg';
      return !compareCase(tc, m, nodeT);
    })(),
  });
  // M2：删一条阶段日志行
  mutations.push({
    id: 'M2',
    what: '删 Rust 一条阶段日志行',
    red: (() => {
      const m = clone(rustT);
      m.stageLines = m.stageLines.slice(1);
      return !compareCase(tc, m, nodeT);
    })(),
  });
  // M3：篡改 probe state
  mutations.push({
    id: 'M3',
    what: '篡改 Rust 的 probe state（running→prewarming）',
    red: (() => {
      const m = clone(rustP);
      m.probe.state = 'prewarming';
      return !compareCase(pc, m, nodeP);
    })(),
  });
  // M4：删请求体里 translator 的一个键
  mutations.push({
    id: 'M4',
    what: '删 Rust 请求体 config.translator 的一个键',
    red: (() => {
      const m = clone(pair.rust);
      delete m.config.translator.target_lang;
      return !sameJSON(m, pair.node);
    })(),
  });
  // M5：篡改 mock 例的 mime
  mutations.push({
    id: 'M5',
    what: '篡改 Rust mock 例的 mime（png→jpeg）',
    red: (() => {
      const m = clone(rustM);
      m.mime = 'image/jpeg';
      return !compareCase(mc, m, nodeM);
    })(),
  });

  let allRed = true;
  for (const m of mutations) {
    if (!m.red) allRed = false;
    console.log(`  ${m.red ? '✓' : '✗'} ${m.id} ${m.what} → ${m.red ? '按预期变红' : '**没有红**（断言漏了它）'}`);
  }
  console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed, allRed }));
  console.log(`\nF4-b engine HTTP 同源：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`);
  process.exit(allRed ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(`\nF4-b engine HTTP 同源：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`);
process.exit(failed === 0 ? 0 : 1);
