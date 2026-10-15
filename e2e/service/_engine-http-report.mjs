#!/usr/bin/env node
/**
 * F4-b engine **HTTP 运行期** 的伪引擎 + 用例表 + Rust 侧取证 —— 共用唯一一份。
 * =============================================================================
 * 为什么单独一个文件：`check:engine-http` 原先是「Rust `boxsvc --engine-http-selftest` ⟷ Node
 * `engine-client.mjs`（逐例子进程）」双靶对拍。F5 摘除 Node 服务层后没有对照对象，改以冻结
 * golden 快照作**单向金标**。伪引擎与用例表是**夹具**（不是对照端），必须两边同一份 ——
 * 各写一遍 = 用例悄悄少一个都不会有人发现。
 *
 * ## 为什么伪引擎（Node http server）仍要留着
 * Rust 侧要有一个「真的会按脚本回话」的 HTTP 端点来验 `requestOnce` / 帧解析 / 探针 /
 * 超时语义。它与 llm-supervisor 的 `mock-llm.mjs` 同理：摘 Node 摘的是**产品运行时与随包**，
 * 不是测试替身。
 *
 * 用法：`import { collect } from './_engine-http-report.mjs'` ⇒ `{ results, payloads }`
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
const PROBE_MS = 400;

const { encodePng } = await import(pathToFileURL(path.join(REPO_ROOT, 'engine', 'src', 'png.mjs')).href);
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
  ok: (res, p) =>
    p === '/translate/image/stream'
      ? octet(res, Buffer.concat([frame(1, '识别中…'), frame(3, '2'), frame(4, ''), frame(0, PNG)]))
      : notFound(res),
  err: (res, p) =>
    p === '/translate/image/stream' ? octet(res, Buffer.concat([frame(1, '识别中'), frame(2, 'boom')])) : notFound(res),
  nores: (res, p) =>
    p === '/translate/image/stream' ? octet(res, Buffer.concat([frame(1, '识别中')])) : notFound(res),
  badout: (res, p) =>
    p === '/translate/image/stream'
      ? octet(res, Buffer.concat([frame(0, Buffer.from('not an image at all'))]))
      : notFound(res),
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
  // 先回一帧**队列位次 0**再永久静默 —— 上游 `myqueue.py:99` 在执行器被卡死任务占住时的真实形状：
  // `free_executors()` 恒为 0、`queue_pos` 恒为 0，于是只反复发这一帧。
  // 🔴 与 `slow` 的区别不是"多一帧"：`slow` 证明"超时会带走已收到的字节"，
  //    而这里证明的是**带走的字节里有没有那句能定位到"排队"的原话**（只带一个进度帧的话，
  //    "排不上队"与"卡在推理"仍然分不开 —— 那是 U10② 现场无法归因的根因）。
  queue_stall: (res, p) => {
    if (p !== '/translate/image/stream') return notFound(res);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write(frame(3, '0')); // 排队位次 0 —— 永远轮不到执行器
    res.write(frame(1, 'recognizing')); // 然后进入识别阶段……
    // ……此后静默：不再有任何字节（上游卡在 Sakura 调用时的真实形状）
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
export const CASES = [
  {
    name: 'real.ok_ja_zh',
    protocol: 'real',
    kind: 'translate',
    scenario: 'ok',
    input: 'png',
    seq: 1,
    lang: { from: 'ja', to: 'zh' },
    payload: true,
  },
  {
    name: 'real.ok_en_zh',
    protocol: 'real',
    kind: 'translate',
    scenario: 'ok',
    input: 'png',
    seq: 2,
    lang: { from: 'en', to: 'zh' },
    payload: true,
  },
  { name: 'real.err_frame', protocol: 'real', kind: 'translate', scenario: 'err', input: 'png', seq: 3 },
  { name: 'real.no_result_frame', protocol: 'real', kind: 'translate', scenario: 'nores', input: 'png', seq: 4 },
  { name: 'real.bad_output_bytes', protocol: 'real', kind: 'translate', scenario: 'badout', input: 'png', seq: 5 },
  { name: 'real.http_422', protocol: 'real', kind: 'translate', scenario: 'http422', input: 'png', seq: 6 },
  { name: 'real.http_500_plain', protocol: 'real', kind: 'translate', scenario: 'http500', input: 'png', seq: 7 },
  { name: 'real.empty_input', protocol: 'real', kind: 'translate', scenario: 'none', input: 'empty', seq: 8 },
  {
    name: 'real.timeout_partial',
    protocol: 'real',
    kind: 'translate',
    scenario: 'slow',
    input: 'png',
    seq: 9,
    timeoutMs: 700,
  },
  {
    name: 'real.queue_position_then_silent',
    protocol: 'real',
    kind: 'translate',
    scenario: 'queue_stall',
    input: 'png',
    seq: 11,
    timeoutMs: 700,
  },
  { name: 'real.probe_running', protocol: 'real', kind: 'probe', scenario: 'probe_running' },
  { name: 'real.probe_prewarming', protocol: 'real', kind: 'probe', scenario: 'probe_prewarming' },
  { name: 'real.probe_starting', protocol: 'real', kind: 'probe', scenario: 'probe_starting' },
  { name: 'real.probe_stopped', protocol: 'real', kind: 'probe', scenario: 'probe_stopped' },
  { name: 'mock.ok', protocol: 'mock', kind: 'translate', scenario: 'mock_translate', input: 'png', seq: 10 },
  { name: 'mock.probe_running', protocol: 'mock', kind: 'probe', scenario: 'mock_ready' },
  { name: 'mock.probe_stopped', protocol: 'mock', kind: 'probe', scenario: 'mock_stopped' },
];

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

// ------------------------------------------------------------------ Rust 侧
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

async function runRust(list, protocol) {
  if (!fs.existsSync(RUST_BIN)) {
    throw new Error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd src-tauri && cargo build --bin boxsvc`);
  }
  const out = await runCmd(RUST_BIN, ['--engine-http-selftest', JSON.stringify(rustCases(list, protocol))], {
    MIAO_ENGINE_PROTOCOL: protocol,
    MIAO_ENGINE_PROBE_MS: String(PROBE_MS),
  });
  return JSON.parse(out).results;
}

// ------------------------------------------------------------------ 投影
export const projTranslate = (r) => ({
  ok: r.ok,
  code: r.ok ? null : r.code,
  ext: r.ok ? r.ext : null,
  mime: r.ok ? r.mime : null,
  bytesB64: r.ok ? r.bytesB64 : null,
  // 🔴 只留 `{code, text}`：`Frame` 还带 `size` / `truncated`（按字节长度与截断标志算的），
  //    那是**传输层**属性，进契约对拍只会让同一件事因机器差异而红。证据面是"说了什么"。
  frames: (r.frames ?? []).map((f) => ({ code: f.code, text: f.text ?? null })),
  stageLines: r.stageLines ?? [],
});
export const projProbe = (r) => r.probe;
export function projPayload(rec) {
  const obj = JSON.parse(Buffer.from(rec.bodyB64, 'base64').toString('utf8'));
  return { method: rec.method, path: rec.path, contentType: rec.contentType, image: obj.image, config: obj.config };
}

/**
 * 完整取证一遍：起全部伪引擎 → Rust 按协议各跑一遍 → 收每例结果 + 每例请求体。
 * 返回 `{ results, payloads }`（results 保 CASES 顺序；payloads 只含 `payload: true` 的用例）。
 *
 * @param {string[]|null} only 只跑这几个用例名（`stall-guard` 的 S6 只要一条，
 *   不必为此起满 17 个伪引擎）。`null` = 全量。
 */
export async function collect(only = null) {
  const pick = only ? new Set(only) : null;
  const cases = JSON.parse(JSON.stringify(CASES)).filter((c) => !pick || pick.has(c.name));
  if (pick) {
    const missing = [...pick].filter((n) => !cases.some((c) => c.name === n));
    if (missing.length) throw new Error(`未知用例名：${missing.join(' / ')}`);
  }
  for (const c of cases) c.inputB64 = c.input === 'empty' ? '' : PNG.toString('base64');
  const contexts = new Map();
  const keep = [];
  try {
    for (const c of cases) {
      const ctx = await setupCase(c);
      contexts.set(c.name, ctx);
      keep.push(...ctx.servers);
    }
    const results = [];
    for (const protocol of ['real', 'mock']) {
      const list = cases.filter((c) => c.protocol === protocol);
      if (!list.length) continue;
      for (const r of await runRust(list, protocol)) results.push(r);
    }
    const payloads = {};
    for (const c of cases) {
      const rec = contexts.get(c.name).rec;
      if (c.payload && rec.length >= 1) payloads[c.name] = projPayload(rec[0]);
    }
    return { results, payloads };
  } finally {
    await closeAll(keep);
  }
}
