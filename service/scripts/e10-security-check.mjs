#!/usr/bin/env node
/**
 * E10 · 安全验收（《04》§14.2 原文逐条）
 * =============================================================================
 * 判据原文：**非 `127.0.0.1` 访问被拒；nonce 错误被拒；非图片字节不进引擎即 `INVALID_IMAGE`**
 *
 * 三条判据的处置各不相同，先讲清楚，免得读报告时把"偏差"当成"通过"：
 *
 *   ① **非 127.0.0.1 访问被拒** —— 可达。用本机**非回环**地址去连服务与引擎两个端口，
 *      连接必须失败。⚠️ 只在**真**监听回环时才有意义：如果哪天 bind 改成 `0.0.0.0`，
 *      这条会红 —— 那正是它要拦的事。
 *
 *   ② **nonce 错误被拒** —— **本版上游不适用**（不是"没做"，是"不能做"）。
 *      `service/src/config.mjs` 的记录：执行器的 nonce 校验与"单图翻译"在本版上游**互斥**
 *      （传空串反而生成随机 nonce ⇒ 单图必 401；`params['nonce']=='None'` 才跳过校验）。
 *      ⇒ 访问控制降级为**只监听 127.0.0.1**，用 ① 那条代偿。
 *      本脚本对这一点**只做现状锁定**（断言启动配方里确实没有 `--nonce`、host 确实是回环），
 *      并在报告里明确标注为**偏差**，而不是"E10 的 nonce 判据已通过"。
 *
 *   ③ **非图片字节不进引擎即 `INVALID_IMAGE`** —— 可达，而且是**两层**防的：
 *      `store.mjs::_buildItems` 在建单前嗅探字节；`engine-client.mjs::translateImage` 在送图前
 *      再嗅探一次。所以这条要在**引擎侧**取证：起一个会记账的假引擎，断言
 *        · 非法字节 → 400 `INVALID_IMAGE`，且引擎侧 **0 次** `/translate/image/stream`
 *        · 合法图片 → 引擎侧 **≥1 次**（**反证守卫**：没有它，"0 次"是恒真的假绿 ——
 *          引擎压根没被连上时它照样绿）
 *
 * ## 为什么另起脚本
 * `selftest.mjs` 的 A3 覆盖的是**令牌 / Origin**（那是 §2.1 的访问控制面）。
 * 本脚本要的是"**字节到没到引擎**"这种**跨进程取证**，需要会记账的假引擎 —— 夹具不同，别混。
 *
 * 用法：
 *   node service/scripts/e10-security-check.mjs            正向
 *   node service/scripts/e10-security-check.mjs --refute    反证轮（破坏源文件 → 断言必须变红 → 按字节还原）
 *
 * 约束：纯 Node、零第三方依赖；临时目录自建自清；不占 5180–5190（box-service 的段）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { encodePng } from '../../engine/src/png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVICE_ENTRY = path.join(ROOT, 'service', 'src', 'server.mjs');
const SERVER_SRC = path.join(ROOT, 'service', 'src', 'server.mjs');
const STORE_SRC = path.join(ROOT, 'service', 'src', 'store.mjs');
const CONFIG_SRC = path.join(ROOT, 'service', 'src', 'config.mjs');
const CLIENT_SRC = path.join(ROOT, 'service', 'src', 'engine-client.mjs');
const TOKEN = 'e'.repeat(64);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-e10-'));
const REFUTE = process.argv.includes('--refute');

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 本脚本声明的断言条数（分母写死：少执行一条即判红） */
const DECLARED = 7;

// ------------------------------------------------------------------ 结果收集

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}
function printResults(title) {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n### ${title}`);
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.id}${r.detail ? `  ${r.detail}` : ''}`);
  console.log(`\n通过 ${pass} / 失败 ${results.length - pass} / 声明 ${DECLARED}`);
  return { pass, fail: results.length - pass };
}

// ------------------------------------------------------------------ 小工具

function httpReq(port, method, pathname, { headers = {}, body = null, token } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (token) h['X-Box-Token'] = token;
    if (body) h['Content-Length'] = body.length;
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const jsonOf = (res) => { try { return JSON.parse(res.body.toString('utf8')); } catch { return null; } };

function portOpenOn(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}
const portOpen = (port) => portOpenOn('127.0.0.1', port);

async function findFreePort(start, need = 2) {
  for (let p = start; p < start + 400; p += 1) {
    let ok = true;
    for (let i = 0; i < need; i += 1) if (await portOpen(p + i)) { ok = false; break; }
    if (ok) return p;
  }
  throw new Error(`从 ${start} 起找不到 ${need} 个连续空闲端口`);
}

/** 本机非回环地址 —— 用来验"只监听回环"。取不到时返回 null（该条断言随后会明确报"无法取证"）。 */
function nonLoopbackIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

// ------------------------------------------------------------------ multipart

function buildMultipart({ payload, images }) {
  const boundary = `----miaoe10${Math.random().toString(16).slice(2)}`;
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, 'utf8'));
  push(`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n`);
  push(JSON.stringify(payload));
  push('\r\n');
  for (const img of images) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="${img.filename}"\r\n`);
    push(`Content-Type: ${img.contentType}\r\n\r\n`);
    parts.push(img.data);
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

// ------------------------------------------------------------------ 假引擎（会记账）

/** 结果流帧格式：1 字节 code + 4 字节大端长度 + 数据（code 0=结果 PNG，1=进度 2=错误） */
function frame(code, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const head = Buffer.alloc(5);
  head[0] = code;
  head.writeUInt32BE(buf.length, 1);
  return Buffer.concat([head, buf]);
}

function startFakeEngine(port, executorPort) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push(`${req.method} ${req.url}`);
      if (req.url === '/queue-size') {
        const b = Buffer.from('0');
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': b.length });
        return res.end(b);
      }
      if (req.url === '/translate/image/stream') {
        // 一个进度帧 + 一个结果帧。结果帧必须是**可识别的真图片**，否则适配层的
        // `sniffImageType(result)` 会把它判成 ENGINE_BAD_OUTPUT —— 与 E10 无关的噪声。
        const body = Buffer.concat([frame(1, 'detection'), frame(0, encodePng(40, 60, (x, y, put) => put((x * 5) % 256, (y * 3) % 256, 200)))]);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
        return res.end(body);
      }
      res.writeHead(404, { 'Content-Length': 0 });
      res.end();
    });
  });
  const executor = net.createServer(() => { /* 哑 socket：只为让 port+1 "在听" ⇒ running */ });
  return { server, executor, hits, port, executorPort };
}

// ------------------------------------------------------------------ 服务进程

function spawnService(env) {
  const child = spawn(process.execPath, [SERVICE_ENTRY], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const st = { child, out: '', err: '', ready: null };
  child.stdout.on('data', (d) => {
    st.out += d.toString();
    const m = /MIAO_READY (\{.*\})/.exec(st.out);
    if (m && !st.ready) { try { st.ready = JSON.parse(m[1]); } catch { /* 继续等 */ } }
  });
  child.stderr.on('data', (d) => { st.err += d.toString(); });
  return st;
}

async function waitReady(st, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (!st.ready && Date.now() < until) await sleep(40);
  if (!st.ready) throw new Error(`服务未就绪：stdout=${st.out}\nstderr=${st.err}`);
  return st.ready;
}

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
});
const closeAll = (servers) => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));

/**
 * 在**子进程**里问一次引擎启动配方（`resolveEngineLaunch().cmd`）。
 *
 * 为什么不在父进程 `import()`：ESM 按 URL 缓存模块 —— 反证轮改了 `config.mjs` 之后，
 * 父进程第二次 `import()` 仍拿到第一份缓存，启动配方不会变，那条反证**永远不可能变红**。
 * 子进程每次重读源文件，才吃得到反证轮的改动。顺带也把 `MIAO_ENGINE_PROTOCOL=real` 隔离在子进程里。
 */
function launchPlanCmd(port) {
  const js = `
    const m = await import(${JSON.stringify(new URL('../src/engine-client.mjs', import.meta.url).href)});
    const l = m.resolveEngineLaunch({ port: Number(process.argv[1]), useGpu: true, modelsTtl: 0 });
    process.stdout.write(JSON.stringify(l.cmd));
  `;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', js, String(port)], {
      encoding: 'utf8',
      env: { ...process.env, MIAO_ENGINE_PROTOCOL: 'real' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out.trim());
  } catch (e) {
    return [`(取不到启动配方：${String(e.message).slice(0, 200)})`];
  }
}

// ------------------------------------------------------------------ 断言体

/**
 * 一轮完整取证：起假引擎 + 起服务 + 跑全部 E10 断言。
 * 正向轮与反证轮都调它 —— 反证轮改的是**源文件**，所以每轮都要重启进程才吃得到改动。
 * @returns {Promise<Record<string, {ok:boolean}>>}
 */
async function runAll() {
  results.length = 0;

  const svcPort = await findFreePort(5300, 1);
  const engPort = await findFreePort(5400, 2);
  const fake = startFakeEngine(engPort, engPort + 1);
  await listen(fake.server, engPort);
  await listen(fake.executor, engPort + 1);

  const st = spawnService({
    MIAO_ENGINE_PROTOCOL: 'real',
    MIAO_ENGINE_PORT: String(engPort),
    MIAO_ENGINE_PROBE_MS: '300',
    MIAO_ENGINE_TIMEOUT_MS: '8000',
    MIAO_PORT: String(svcPort),
    MIAO_TOKEN: TOKEN,
    MIAO_STATE_DIR: path.join(TMP, 'state'),
    MIAO_ROOT: path.join(TMP, 'root'),
    // ③ 由 box-service 持有；这里不让它真去拉 llama-server（E10 不考 ③）
    MIAO_NO_LLM_AUTOSTART: '1',
  });

  try {
    const info = await waitReady(st);
    const PORT = info.port;

    // ---- E10.1 / E10.2：只监听回环 ----
    const lan = nonLoopbackIPv4();
    if (lan === null) {
      check('E10.1 服务只监听回环（非 127.0.0.1 连不上）', false, '⚠️ 本机取不到非回环 IPv4 ⇒ 本条无法取证（不是通过）');
      check('E10.2 引擎只监听回环（非 127.0.0.1 连不上）', false, '⚠️ 同上');
    } else {
      // ⚠️ 反向的假绿在这里：如果本机 LAN 地址**恰好**也是服务在听的那个（不可能，但仍要防），
      //    或防火墙把连接静默丢弃（表现为超时），都要让 detail 能看出来是哪种。
      const svcLan = await portOpenOn(lan, PORT, 700);
      check('E10.1 服务只监听回环（非 127.0.0.1 连不上）', svcLan === false, `尝试连 ${lan}:${PORT} ⇒ ${svcLan ? '连上了（不该）' : '被拒'}`);
      const engLan = await portOpenOn(lan, engPort, 700);
      check('E10.2 引擎只监听回环（非 127.0.0.1 连不上）', engLan === false, `尝试连 ${lan}:${engPort} ⇒ ${engLan ? '连上了（不该）' : '被拒'}`);
    }

    // ---- E10.3：nonce 现状锁定（**偏差**，不是通过） ----
    // 🔴 必须**另起一个 node 子进程**去问启动配方，不能在父进程 `import()`：
    //    ESM 模块是**按 URL 缓存**的，反证轮改了 `config.mjs` 之后，父进程第二次 `import()`
    //    拿到的仍是第一次那份缓存 ⇒ 启动配方看着没变 ⇒ 这条反证**永远不可能变红**，
    //    而它看起来"跑过了"。子进程每次重读源文件，才吃得到反证轮的改动。
    const cmdArr = launchPlanCmd(engPort);
    const nonceIdx = cmdArr.indexOf('--nonce');
    // 🔴 期望的是**字面量 `None`**，不是"没有这个参数"、也不是"随便一个随机值"：
    //    执行器侧只在 `params['nonce'] == "None"` 时把它转成 Python `None` ⇒ `if self.nonce:` 为假
    //    ⇒ **跳过校验**（见 service/src/config.mjs 的 §nonce 段，实测记录）。
    //    传空串反而会生成随机 nonce ⇒ 单图必 401。所以"看起来最安全的写法"恰好是这里最坏的写法。
    //    第一次写这条断言时我按直觉断言成「不该有 --nonce」，实测**变红**——那句直觉是错的，
    //    而它正好证明了这条断言不是照抄注释、是真的在读启动配方。
    const nonceValue = nonceIdx >= 0 ? cmdArr[nonceIdx + 1] : null;
    const hostIdx = cmdArr.indexOf('--host');
    const hostValue = hostIdx >= 0 ? cmdArr[hostIdx + 1] : null;
    check('E10.3 【偏差锁定】nonce 显式置为字面量 `None`（执行器跳过校验）+ host 固定 127.0.0.1 —— E10 原文的「nonce 错误被拒」在本版上游不适用',
      nonceValue === 'None' && hostValue === '127.0.0.1',
      `--nonce ${JSON.stringify(nonceValue)} / --host ${JSON.stringify(hostValue)}；依据 service/src/config.mjs §nonce 段（上游 nonce 与单图翻译互斥）`);

    // ---- E10.4 / E10.5：非图片字节 -> 400，且**不进引擎** ----
    const before = jsonOf(await httpReq(PORT, 'GET', '/api/v1/tasks', { token: TOKEN }));
    const notAnImage = Buffer.from('这不是图片，只是一段文本。definitely not a PNG header.\n'.repeat(20), 'utf8');
    const mp = buildMultipart({
      payload: { comicName: 'E10 非法字节', idempotencyKey: `e10-${Date.now()}` },
      // 🔴 Content-Type **故意谎称** image/png：要证的是「按字节判」而不是「按自称判」。
      images: [{ filename: '001.png', contentType: 'image/png', data: notAnImage }],
    });
    const bad = await httpReq(PORT, 'POST', '/api/v1/tasks', {
      token: TOKEN, headers: { 'Content-Type': mp.contentType }, body: mp.body,
    });
    const badJson = jsonOf(bad);
    const after = jsonOf(await httpReq(PORT, 'GET', '/api/v1/tasks', { token: TOKEN }));
    check('E10.4 非图片字节（Content-Type 谎称 image/png）→ 400 INVALID_IMAGE，且**未建单**',
      bad.status === 400 && badJson?.error?.code === 'INVALID_IMAGE'
        && (after?.tasks?.length ?? -1) === (before?.tasks?.length ?? -2),
      `HTTP ${bad.status} / ${badJson?.error?.code} / 任务数 ${before?.tasks?.length} → ${after?.tasks?.length}`);

    const streamHits = fake.hits.filter((h) => h.includes('/translate/image/stream')).length;
    check('E10.5 上述非法字节**从未到达引擎**（引擎侧 /translate/image/stream 计数 = 0）',
      streamHits === 0, `引擎收到的请求：${JSON.stringify(fake.hits)}`);

    // ---- E10.6：反证守卫 —— 合法图片必须真的到达引擎 ----
    // 没有这一条，E10.5 在"引擎压根没被连上"时也照样绿 —— 那是本项目的头号假绿形态。
    const mpOk = buildMultipart({
      payload: { comicName: 'E10 合法图片', idempotencyKey: `e10ok-${Date.now()}` },
      images: [{ filename: '001.png', contentType: 'image/png', data: encodePng(40, 60, (x, y, put) => put(x % 256, y % 256, 90)) }],
    });
    const okRes = await httpReq(PORT, 'POST', '/api/v1/tasks', {
      token: TOKEN, headers: { 'Content-Type': mpOk.contentType }, body: mpOk.body,
    });
    const okJson = jsonOf(okRes);
    const taskId = okJson?.taskId;
    // 等一小会儿让 item 真的流到引擎（队列是串行的，第一次翻译还在跑）
    let hitsAfter = 0;
    for (let i = 0; i < 60; i += 1) {
      hitsAfter = fake.hits.filter((h) => h.includes('/translate/image/stream')).length;
      if (hitsAfter > 0) break;
      await sleep(200);
    }
    check('E10.6 【反证守卫】合法图片**确实**到达引擎（否则 E10.5 是恒真的假绿）',
      okRes.status === 201 && !!taskId && hitsAfter >= 1,
      `HTTP ${okRes.status} / taskId=${taskId} / 引擎收到 ${hitsAfter} 次 /translate/image/stream`);

    // ---- E10.7：鉴权面确实存在（无令牌 -> 拒绝） ----
    const noToken = await httpReq(PORT, 'GET', '/api/v1/tasks');
    check('E10.7 无令牌访问 → 403 PERMISSION_DENIED（安全面存在，不是裸奔）',
      noToken.status === 403 && jsonOf(noToken)?.error?.code === 'PERMISSION_DENIED',
      `HTTP ${noToken.status} / ${jsonOf(noToken)?.error?.code}`);
  } finally {
    if (st.child.exitCode === null) st.child.kill('SIGTERM');
    await sleep(150);
    await closeAll([fake.server, fake.executor]);
  }

  const map = {};
  for (const r of results) map[r.id] = r;
  return map;
}

// ------------------------------------------------------------------ 反证轮

/**
 * 反证：破坏源文件 → 指定断言必须变红 → **按字节还原**。
 *
 * ⚠️ E10.5 的破坏必须**同时**改两个文件（store 的建单前嗅探 + 适配层的送图前嗅探）：
 *    这条判据是**两层**防的，只破一层时另一层仍会拦住 —— 断言不变红，
 *    反证看起来"失败"，其实是"这条防线是纵深部署的"。把这一点写在锚点旁边，
 *    免得下一个人见到"破一处不红"就以为断言写错了，去把断言放宽。
 */
const MUTATIONS = [
  {
    name: 'E10.4：拿掉建单前的字节嗅探（store._buildItems）',
    expect: ['E10.4 非图片字节（Content-Type 谎称 image/png）→ 400 INVALID_IMAGE，且**未建单**'],
    edits: [{ file: STORE_SRC, find: 'if (!ext || bytes.length === 0) {', replace: 'if (false && (!ext || bytes.length === 0)) {' }],
  },
  {
    name: 'E10.5：同时拿掉两层嗅探（store + engine-client，纵深部署需两处都破）',
    expect: ['E10.5 上述非法字节**从未到达引擎**（引擎侧 /translate/image/stream 计数 = 0）'],
    edits: [
      { file: STORE_SRC, find: 'if (!ext || bytes.length === 0) {', replace: 'if (false && (!ext || bytes.length === 0)) {' },
      { file: CLIENT_SRC, find: "throw new EngineError('BAD_INPUT', '原图字节不是可识别图片（PNG/JPEG/WEBP）');", replace: '/* refute: 去掉适配层的字节嗅探 */' },
    ],
  },
  {
    name: 'E10.7：让鉴权恒通过（tokenMatches 短路）',
    expect: ['E10.7 无令牌访问 → 403 PERMISSION_DENIED（安全面存在，不是裸奔）'],
    edits: [{
      file: SERVER_SRC,
      find: "  if (typeof provided !== 'string' || provided.length === 0) return false;",
      replace: '  if (true) return true; // refute：鉴权恒通过',
    }],
  },
  {
    // 这条反证盯的是「nonce 必须是字面量 None」这个**反直觉**的点：
    // 把默认值改成空串（"看起来更安全"）→ 上游会生成随机 nonce → 单图必 401。
    // 断言必须先红，才能证明它真的在守这个点。
    name: "E10.3：把 nonce 默认值从 'None' 改成空串（直觉上更安全、实际必坏）",
    expect: ['E10.3 【偏差锁定】nonce 显式置为字面量 `None`（执行器跳过校验）+ host 固定 127.0.0.1 —— E10 原文的「nonce 错误被拒」在本版上游不适用'],
    edits: [{
      file: CONFIG_SRC,
      find: "engineNonce: process.env.MIAO_ENGINE_NONCE || 'None',",
      replace: "engineNonce: process.env.MIAO_ENGINE_NONCE || '',",
    }],
  },
];

const readBytes = (f) => { try { return fs.readFileSync(f); } catch { return null; } };

const main = async () => {
  console.log(`E10 安全验收${REFUTE ? ' · 反证轮' : ''}（《04》§14.2）`);

  if (!REFUTE) {
    await runAll();
    const { fail } = printResults('E10 安全取证');
    const executed = results.length;
    if (executed !== DECLARED) console.log(`\n🔴 分母不符：声明 ${DECLARED} 条，实际执行 ${executed} 条 —— 视为失败`);
    process.exitCode = fail === 0 && executed === DECLARED ? 0 : 1;
    return;
  }

  const base = await runAll();
  const wasGreen = {};
  for (const r of results) wasGreen[r.id] = r.ok;

  const expectedTotal = MUTATIONS.reduce((n, m) => n + m.expect.length, 0);
  let total = 0;
  let red = 0;
  let skipped = 0;
  const falsePositives = [];
  const originals = new Map();

  console.log('\n破坏源文件 → 断言必须变红 → 按字节还原\n');
  for (const mut of MUTATIONS) {
    for (const [i, e] of mut.edits.entries()) {
      if (!originals.has(e.file)) originals.set(e.file, readBytes(e.file));
      const snap = originals.get(e.file);
      const txt = snap.toString('utf8');
      if (!txt.includes(e.find)) {
        console.log(`⚠ ${mut.name}\n    破坏锚点未找到（第 ${i + 1} 处，${path.relative(ROOT, e.file)}）—— 本条无法反证`);
        skipped += mut.expect.length;
        continue;
      }
      writeFileSync(e.file, txt.replace(e.find, e.replace));
    }
    const res = await runAll();
    console.log(`🔴 ${mut.name}`);
    for (const id of mut.expect) {
      total++;
      const isRed = res[id] && res[id].ok === false;
      if (isRed) { red++; console.log(`  ✓ ${id.slice(0, 24)}… 按预期变红`); }
      else { falsePositives.push(id); console.log(`  ✗ ${id.slice(0, 24)}… 该红没红 ← 假阳性`); }
      if (!wasGreen[id]) console.log('     注：该条基线本就是红，无法据此判定断言有效性');
    }
    for (const [f, snap] of originals) writeFileSync(f, snap);
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
  if (restoreFail) console.log(`✗ 有 ${restoreFail} 个文件未恢复到原始字节`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(' / ')}`);
  process.exitCode = red === total && total === expectedTotal && skipped === 0 && restoreFail === 0 ? 0 : 1;
};

await main();
