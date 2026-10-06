// box-service 契约自测 —— 覆盖 dev-plan.md §4 验收表 A1–A14
//
// 运行：node e2e/service/selftest.mjs
// 原则：每个断言都对应契约里的一条明文规则，断言失败即契约不符合。
// 全部 I/O 落在临时目录（MIAO_ROOT / MIAO_STATE_DIR），不触碰用户真实图片目录。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { encodePng } from '../../engine/src/png.mjs';

// 🔴 本套用例起的是**模拟引擎**（`../engine/src/server.mjs`）——它实现的是 ver1.0 的自定义协议
// （`/ready` + 字节式 `/translate`），**不是真实引擎协议**（`/translate/image` + JSON/data URI）。
// 所以这里**强制**声明 `mock`：起的是替身，就老实说。生产默认值仍是 `real`（见 config.mjs）。
// 真实协议路径的断言在 `e2e/service/engine-client-check.mjs`（真协议假引擎 + S1 真引擎实测）。
process.env.MIAO_ENGINE_PROTOCOL = 'mock';
// 本套用例只关心**任务 / 队列 / 落盘 / 安全**契约，不验 ③ 的生命周期（那有自己的脚本：
// `engine-profile-check.mjs`）。而本脚本会在 A1 里**反复起停** box-service 实例，
// 每个实例都去抢 8080 会引入与代码无关的 flake（"上一实例的 ③ 还没退干净"）。
// ⇒ 显式退出预拉起。**这是给夹具的开关，不是给产品的**（产品路径永远预拉起）。
process.env.MIAO_NO_LLM_AUTOSTART = '1';

const ROOT = path.resolve(import.meta.dirname, '..', '..', 'service'); // .../service
const SERVICE_ENTRY = path.join(ROOT, 'src', 'server.mjs');
const ENGINE_ENTRY = path.resolve(ROOT, '..', 'engine', 'src', 'server.mjs');
/** 「假父进程」外壳：A18 要强杀一个父进程，不能拿自测自己冒险 */
const HARNESS = path.join(import.meta.dirname, '_parent-harness.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-service-selftest-'));

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

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 失败项摘要（断言失败时给出可诊断的上下文） */
const FailedItemsSummary = (items) => items.map((it) => ({ seq: it.seq, status: it.status, reason: it.reason, retryCount: it.retryCount }));

// ------------------------------------------------------------------ 夹具

/** 生成一张纯色 PNG（尺寸可控，供嗅探与落盘校验） */
function pngBytes(w = 40, h = 60, seed = 1) {
  return encodePng(w, h, (x, y, put) => {
    put((seed * 37 + x) % 256, (seed * 17 + y) % 256, (seed * 7) % 256);
  });
}

/** 最小 JPEG 头（嗅探只需前 3 字节 FF D8 FF；尺寸解析失败时引擎回退 400×600） */
function jpegBytes() {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(64, 0x20)]);
}

/** 最小 WEBP 头（RIFF....WEBP + VP8X）；用于「伪造 filename」的安全用例 */
function webpBytes() {
  const head = Buffer.alloc(30, 0);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(22, 4);
  head.write('WEBP', 8, 'latin1');
  head.write('VP8X', 12, 'latin1');
  head[24] = 0x0f; // width-1 = 15 → 16px
  head[27] = 0x0f; // height-1 = 15 → 16px
  return head;
}

/** multipart/form-data 构造（契约 §5.2：payload + images[] + imageOrder[]） */
function buildMultipart({ payload, images, imageOrder }) {
  const boundary = `----miao${Math.random().toString(16).slice(2)}`;
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, 'utf8'));
  if (payload !== undefined) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n`);
    push(JSON.stringify(payload));
    push('\r\n');
  }
  for (const img of images) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="images[]"; filename="${img.filename}"\r\n`
      + `Content-Type: ${img.contentType || 'application/octet-stream'}\r\n\r\n`);
    parts.push(img.data);
    push('\r\n');
  }
  if (imageOrder) {
    for (const o of imageOrder) {
      push(`--${boundary}\r\nContent-Disposition: form-data; name="imageOrder[]"\r\n\r\n`);
      push(String(o));
      push('\r\n');
    }
  }
  push(`--${boundary}--\r\n`);
  return { body: Buffer.concat(parts), boundary };
}

function request(port, method, pathname, { headers = {}, body = null, token } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (token) h['X-Box-Token'] = token;
    if (body) h['Content-Length'] = body.length;
    // agent:false —— 每个请求独立连接：测试里存在「同步写 999 个文件」这类长间隔，
    // 若复用全局 keep-alive 连接池会与服务端的空闲回收打架（ECONNRESET 竞态）
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

const json = (res) => {
  try { return JSON.parse(res.body.toString('utf8')); } catch { return null; }
};

/** 提交一批图片（≥1 张）；返回 {status, json} */
async function submit(port, token, comicName, images, extra = {}) {
  const body = buildMultipart({ payload: { comicName, idempotencyKey: extra.idempotencyKey || crypto.randomUUID(), ...extra.payload }, images });
  const res = await request(port, 'POST', '/api/v1/tasks', {
    token,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${body.boundary}`,
      ...(extra.headers || {}),
    },
    body: body.body,
  });
  return { status: res.status, json: json(res), raw: res };
}

/** 等待任务进入终态 */
async function waitTask(port, token, taskId, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(port, 'GET', `/api/v1/tasks/${taskId}`, { token });
    const task = json(res);
    // 非 200 不静默吞掉：否则「服务不可用 / 任务被清理」会被误读成「还没到终态」，
    // 现场信息全丢，排查时只能靠猜。
    if (res.status !== 200 || !task || !task.taskId) {
      throw new Error(
        `任务详情读取失败 taskId=${taskId} status=${res.status} body=${res.body.toString('utf8').slice(0, 200)}`,
      );
    }
    if (['done', 'partial_failed', 'failed', 'canceled'].includes(task.status)) return task;
    if (Date.now() > until) throw new Error(`任务 ${taskId} 未在 ${timeoutMs}ms 内结束（当前 ${task.status}）`);
    await sleep(120);
  }
}

// ------------------------------------------------------------------ 进程管理

function spawnProc(entry, env, tag, extraArgv = []) {
  const child = spawn(process.execPath, [entry, ...extraArgv], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, out: '', err: '', ready: null, tag };
  child.stdout.on('data', (d) => {
    state.out += d.toString();
    const m = /MIAO_(?:ENGINE_)?READY (\{.*\})/.exec(state.out);
    if (m && !state.ready) {
      try { state.ready = JSON.parse(m[1]); } catch { /* 继续等 */ }
    }
  });
  child.stderr.on('data', (d) => { state.err += d.toString(); });
  return state;
}

async function waitReady(state, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (!state.ready && Date.now() < until) await sleep(50);
  if (!state.ready) throw new Error(`${state.tag} 未就绪。stdout=${state.out}\nstderr=${state.err}`);
  return state.ready;
}

function killProc(state) {
  if (state && state.child && state.child.exitCode === null) state.child.kill('SIGTERM');
}

/**
 * 端口是否可连。
 * A18 必须用它而不是 `child.exitCode` 来判断存活：那里的 child 是「假父进程」，
 * 而我们要观察的是父进程死后、**另一个进程**（服务）是否还在监听。
 */
function portOpen(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

function listenOccupied(port) {
  return new Promise((resolve) => {
    const srv = net.createServer(() => {});
    srv.listen(port, '127.0.0.1', () => resolve(srv));
    srv.on('error', () => resolve(null));
  });
}

/**
 * A1 端口段 5180–5190 —— **必须在主服务启动之前跑**，否则主服务自身占着段内端口会让
 * 「全段被占」用例的前置条件不成立。
 */
async function portSegmentTests() {
  console.log('A1 端口段 5180–5190');
  // ① 5180 被占 → 新实例落到 5181（段内探测，不越段）
  const only5180 = await listenOccupied(5180);
  check('A1 前置：成功占用 5180', !!only5180);
  const probe = spawnProc(SERVICE_ENTRY, {
    MIAO_ROOT: path.join(TMP, 'root-probe'), MIAO_STATE_DIR: path.join(TMP, 'state-probe'), MIAO_TOKEN: TOKEN,
  }, 'service-probe');
  let probePort;
  try {
    probePort = (await waitReady(probe, 8000)).port;
  } catch (err) {
    probePort = `未就绪（${err.message.slice(0, 60)}）`;
  }
  check('A1 5180 被占 → 自动落到 5181（段内探测）', probePort === 5181, probePort);
  killProc(probe);
  if (only5180) only5180.close();
  await sleep(250);

  // ② 5180–5190 全占 → 启动失败并明确报错（不静默换到段外）
  const blockers = [];
  for (let p = 5180; p <= 5190; p += 1) {
    const s = await listenOccupied(p);
    if (s) blockers.push(s);
  }
  check('A1 前置：5180–5190 十一个端口全部占满', blockers.length === 11, blockers.length);
  const full = spawnProc(SERVICE_ENTRY, {
    MIAO_ROOT: path.join(TMP, 'root-full'), MIAO_STATE_DIR: path.join(TMP, 'state-full'), MIAO_TOKEN: TOKEN,
  }, 'service-full');
  const code = await new Promise((resolve) => {
    full.child.on('exit', (c) => resolve(c));
    setTimeout(() => { killProc(full); resolve('timeout'); }, 10_000);
  });
  check('A1 全段被占 → 启动失败且不静默换到段外',
    code !== 0 && code !== 'timeout' && /全部被占用/.test(full.err + full.out),
    { code, stderr: full.err.trim().split('\n')[0] });
  for (const s of blockers) { try { s.close(); } catch { /* ignore */ } }
  await sleep(250);
}

// ------------------------------------------------------------------ 主流程

const engine = spawnProc(ENGINE_ENTRY, {
  MIAO_ENGINE_ITEM_MS: '60',
  MIAO_ENGINE_FAIL_SEQ: '3', // seq=3 必然失败 → 覆盖 failed / partial_failed
}, 'engine');

const rootDir = path.join(TMP, 'Box 漫画');
const stateDir = path.join(TMP, 'state');
const TOKEN = 'f'.repeat(64);

let svc = null;
let eng = null;
let service = null;
try {
  eng = await waitReady(engine);
  // 端口段用例必须抢占式地先跑（主服务一启动就会占住段内端口）
  await portSegmentTests();

  // 用引擎的实际端口启动 Service
  service = spawnProc(SERVICE_ENTRY, {
    MIAO_ROOT: rootDir,
    MIAO_STATE_DIR: stateDir,
    MIAO_TOKEN: TOKEN,
    MIAO_ENGINE_PORT: String(eng.port),
  }, 'service');
  svc = await waitReady(service);

  const port = svc.port;
  console.log(`\n[selftest] service 端口探测命中 → ${port}；engine 端口 ${eng.port}`);
  console.log(`[selftest] root=${rootDir}\n`);

  // ================================================================ A2 健康检查
  console.log('A2 健康检查');
  {
    const res = await request(port, 'GET', '/api/v1/health'); // 刻意不带令牌
    const h = json(res);
    check('A2 /health 免鉴权（无令牌可访问）', res.status === 200);
    check('A2 service === "box-service"', h && h.service === 'box-service', h);
    check('A2 apiVersion === "v1"', h && h.apiVersion === 'v1', h);
    check('A2 status ∈ ok|degraded|starting', h && ['ok', 'degraded', 'starting'].includes(h.status), h && h.status);
    check('A2 sidecar 真实探测为 running', h && h.sidecar && h.sidecar.state === 'running', h && h.sidecar);
  }

  // ================================================================ A3 鉴权
  console.log('A3 鉴权与 Origin');
  {
    const noToken = await request(port, 'GET', '/api/v1/queue');
    check('A3 缺令牌 → 403 PERMISSION_DENIED', noToken.status === 403 && json(noToken)?.error?.code === 'PERMISSION_DENIED', json(noToken));

    const badToken = await request(port, 'GET', '/api/v1/queue', { token: 'a'.repeat(64) });
    check('A3 错令牌 → 403 同一错误码', badToken.status === 403 && json(badToken)?.error?.code === 'PERMISSION_DENIED');

    const badOrigin = await request(port, 'GET', '/api/v1/queue', { token: TOKEN, headers: { Origin: 'https://evil.example' } });
    check('A3 非白名单 Origin → 403 同一错误码（不泄露是哪项失败）',
      badOrigin.status === 403 && json(badOrigin)?.error?.code === 'PERMISSION_DENIED', json(badOrigin));

    const extOrigin = await request(port, 'GET', '/api/v1/queue', {
      token: TOKEN, headers: { Origin: 'chrome-extension://abcdefghijklmnop' },
    });
    check('A3 chrome-extension:// Origin 放行 + CORS 不回 *', extOrigin.status === 200
      && extOrigin.headers['access-control-allow-origin'] === 'chrome-extension://abcdefghijklmnop', extOrigin.headers);

    const nullOrigin = await request(port, 'GET', '/api/v1/queue', { token: TOKEN, headers: { Origin: 'null' } });
    check('A3 Origin: null（Box 桌面端）放行', nullOrigin.status === 200);
  }

  // ================================================================ A4 批量上限
  console.log('A4 单次上限 20');
  {
    const images = Array.from({ length: 21 }, (_, i) => ({ filename: `${String(i + 1).padStart(3, '0')}.png`, contentType: 'image/png', data: pngBytes(40, 60, i) }));
    const r = await submit(port, TOKEN, 'A4 超限', images);
    check('A4 21 张 → 400 BATCH_LIMIT_EXCEEDED', r.status === 400 && r.json?.error?.code === 'BATCH_LIMIT_EXCEEDED', r.json);
    check('A4 details.limit=20 / submitted=21', r.json?.error?.details?.limit === 20 && r.json?.error?.details?.submitted === 21, r.json?.error?.details);
  }

  // ================================================================ A6 漫画名规范化
  console.log('A6 漫画名规范化（服务端唯一执行）');
  {
    const cases = [
      { input: '第12话/学园祭', expect: '第12话学园祭', desc: '路径分隔符剥离' },
      { input: '第12话\\学园祭', expect: '第12话学园祭', desc: '反斜杠剥离' },
      { input: '  第12话 · 学园祭  ', expect: '第12话 · 学园祭', desc: '去首尾空白' },
      { input: '第12话   学园祭', expect: '第12话 学园祭', desc: '连续空白折叠' },
      { input: '第１２３话', expect: '第123话', desc: 'NFKC 折叠全角数字' },
      { input: '第12话.  ', expect: '第12话', desc: '去尾部点与空格' },
    ];
    for (const c of cases) {
      const r = await submit(port, TOKEN, c.input, [{ filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 1) }]);
      check(`A6 ${c.desc}：「${c.input}」→「${c.expect}」`,
        r.status === 201 && r.json?.normalizedComicName === c.expect,
        r.json && (r.json.normalizedComicName || r.json.error));
    }

    const reserved = await submit(port, TOKEN, 'ＣＯＮ', [{ filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 1) }]);
    check('A6 全角 ＣＯＮ 经 NFKC 后命中保留名 → INVALID_COMIC_NAME',
      reserved.status === 400 && reserved.json?.error?.code === 'INVALID_COMIC_NAME', reserved.json);

    const reservedExt = await submit(port, TOKEN, 'CON.txt', [{ filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 1) }]);
    check('A6 CON.txt（忽略扩展名匹配保留名）→ 拒绝', reservedExt.status === 400 && reservedExt.json?.error?.code === 'INVALID_COMIC_NAME');

    const tooLong = await submit(port, TOKEN, '长'.repeat(65), [{ filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 1) }]);
    check('A6 65 个字符 → 拒绝（不静默截断）', tooLong.status === 400 && tooLong.json?.error?.code === 'INVALID_COMIC_NAME');

    const empty = await submit(port, TOKEN, '///', [{ filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 1) }]);
    check('A6 「///」→ COMIC_NAME_REQUIRED', empty.status === 400 && empty.json?.error?.code === 'COMIC_NAME_REQUIRED', empty.json);

    const missing = await submit(port, TOKEN, undefined, [{ filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 1) }]);
    check('A6 缺 comicName → COMIC_NAME_REQUIRED', missing.status === 400 && missing.json?.error?.code === 'COMIC_NAME_REQUIRED');
  }

  // ================================================================ A8/A9 落盘与幂等续做
  console.log('A8/A9 落盘规则与幂等续做');
  {
    const comicName = 'A8 落盘';
    const r = await submit(port, TOKEN, comicName, [
      { filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 1) },
      { filename: '002.png', contentType: 'image/png', data: pngBytes(40, 60, 2) },
    ]);
    const dir = path.join(rootDir, comicName);
    check('A8 queued 态目录不存在（惰性创建）', !fs.existsSync(dir), dir);
    check('A8 seqFrom=1 / seqTo=2', r.json?.batches?.[0]?.seqFrom === 1 && r.json?.batches?.[0]?.seqTo === 2, r.json?.batches);

    const task = await waitTask(port, TOKEN, r.json.taskId);
    check('A8 任务 done', task.status === 'done', task.status);
    const files = fs.readdirSync(dir).sort();
    check('A8 落盘成对：001.png / 001_translated.png / 002.png / 002_translated.png',
      JSON.stringify(files) === JSON.stringify(['001.png', '001_translated.png', '002.png', '002_translated.png']), files);
    check('A8 译文为真实 PNG（嗅探通过）', fs.readFileSync(path.join(dir, '001_translated.png')).subarray(0, 4).toString('hex') === '89504e47');
    check('A8 任务清单持久化到 state/tasks', fs.existsSync(path.join(stateDir, 'tasks', `${r.json.taskId}.json`)));

    // 永不覆盖：同目录再提交一张，序号续到 003，且旧文件字节不变
    const before = fs.readFileSync(path.join(dir, '001.png'));
    const r2 = await submit(port, TOKEN, comicName, [{ filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 9) }]);
    check('A7 续编号：目录内已有 001/002 → seqFrom=3', r2.json?.batches?.[0]?.seqFrom === 3, r2.json?.batches);
    await waitTask(port, TOKEN, r2.json.taskId);
    check('A8 永不覆盖：001.png 字节未被改写', before.equals(fs.readFileSync(path.join(dir, '001.png'))));

    // A9 幂等续做：只有 001_translated.png 存在时，nextSeq=1 → 该 item 置 skipped(already_exists)
    const dir2 = path.join(rootDir, 'A9 续做');
    fs.mkdirSync(dir2, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir2, '001_translated.png'), pngBytes(40, 60, 5));
    const r3 = await submit(port, TOKEN, 'A9 续做', [{ filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 6) }]);
    const t3 = await waitTask(port, TOKEN, r3.json.taskId);
    const item1 = t3.items.find((it) => it.seq === 1);
    check('A9 已存在译文 → item skipped(already_exists)', item1?.status === 'skipped' && item1?.reason === 'already_exists', item1);
    check('A9 skipped 不计入失败，任务仍 done', t3.status === 'done', t3.status);
    check('A9 序号不变（仍为 001）', item1?.seq === 1);
  }

  // ================================================================ A7 序号上限
  console.log('A7 序号上限 999');
  {
    const dir = path.join(rootDir, 'A7 溢出');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let i = 1; i <= 999; i += 1) fs.writeFileSync(path.join(dir, `${String(i).padStart(3, '0')}.png`), Buffer.alloc(8));
    const r = await submit(port, TOKEN, 'A7 溢出', [{ filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 1) }]);
    check('A7 续编号 > 999 → 409 SEQUENCE_OVERFLOW', r.status === 409 && r.json?.error?.code === 'SEQUENCE_OVERFLOW', r.json);
  }

  // ================================================================ A5 幂等
  console.log('A5 idempotencyKey 去重');
  {
    const key = crypto.randomUUID();
    const images = [{ filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 1) }];
    const first = await submit(port, TOKEN, 'A5 幂等', images, { idempotencyKey: key });
    const second = await submit(port, TOKEN, 'A5 幂等', images, { idempotencyKey: key });
    check('A5 重复 key → 复用同一 taskId', first.json?.taskId === second.json?.taskId, [first.json?.taskId, second.json?.taskId]);
    check('A5 重放 HTTP 200（非 201）且不报错', second.status === 200, second.status);
    await waitTask(port, TOKEN, first.json.taskId);
  }

  // ================================================================ A11 三层模型与状态机
  console.log('A11 Task/Batch/Item 三层 + 终态追加');
  {
    const images1 = Array.from({ length: 20 }, (_, i) => ({ filename: `${String(i + 1).padStart(3, '0')}.png`, contentType: 'image/png', data: pngBytes(40, 60, i) }));
    const first = await submit(port, TOKEN, 'A11 分批', images1);
    check('A11 首批 20 张 → 1 个 batch', first.json?.batches?.length === 1);

    const images2 = Array.from({ length: 11 }, (_, i) => ({ filename: `${String(i + 21).padStart(3, '0')}.png`, contentType: 'image/png', data: pngBytes(40, 60, i) }));
    const mp = buildMultipart({ payload: { idempotencyKey: crypto.randomUUID() }, images: images2 });
    const append = await request(port, 'POST', `/api/v1/tasks/${first.json.taskId}/batches`, {
      token: TOKEN,
      headers: { 'Content-Type': `multipart/form-data; boundary=${mp.boundary}` },
      body: mp.body,
    });
    const appended = json(append);
    check('A11 追加 11 张 → 仍同一 Task，batches 变 2', append.status === 200 && appended?.batches?.length === 2, appended?.batches);
    check('A11 B2.seqFrom === B1.seqTo + 1（序号连续）', appended?.batches?.[1]?.seqFrom === appended?.batches?.[0]?.seqTo + 1, appended?.batches);
    check('A11 总张数 31 = 20 + 11', appended?.batches?.reduce((s, b) => s + b.count, 0) === 31);

    const done = await waitTask(port, TOKEN, first.json.taskId, 60_000);
    // 引擎对 seq=3 注入了必然失败 → 本用例同时覆盖契约 §4.1 的 partial_failed 迁移与重试
    const failedItems = done.items.filter((it) => it.status === 'failed');
    check('A11 ≥1 成功且 ≥1 失败 → partial_failed', done.status === 'partial_failed', done.status);
    check('A11 失败项恰为注入的 seq=3（其余 30 张成功）',
      failedItems.length === 1 && failedItems[0].seq === 3
      && done.items.filter((it) => it.status === 'success').length === 30,
      FailedItemsSummary(failedItems));
    check('A11 失败原因来自引擎（非服务端注入）', /^engine_/.test(failedItems[0]?.reason || ''), failedItems[0]?.reason);
    check('A11 重试 1 次后判失败（MAX_ATTEMPTS=2）', failedItems[0]?.retryCount === 1, failedItems[0]?.retryCount);

    const mp2 = buildMultipart({ payload: { idempotencyKey: crypto.randomUUID() }, images: [{ filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 1) }] });
    const late = await request(port, 'POST', `/api/v1/tasks/${first.json.taskId}/batches`, {
      token: TOKEN,
      headers: { 'Content-Type': `multipart/form-data; boundary=${mp2.boundary}` },
      body: mp2.body,
    });
    check('A11 终态追加 → 409 TASK_NOT_APPENDABLE', late.status === 409 && json(late)?.error?.code === 'TASK_NOT_APPENDABLE', json(late));

    const cancelDone = await request(port, 'POST', `/api/v1/tasks/${first.json.taskId}/cancel`, { token: TOKEN });
    check('A11 已结束任务取消 → 409 TASK_NOT_CANCELABLE', cancelDone.status === 409 && json(cancelDone)?.error?.code === 'TASK_NOT_CANCELABLE', json(cancelDone));
  }

  // ================================================================ A10 取消语义
  console.log('A10 取消语义（等当前张跑完 / 未开始不落盘 / 已落盘保留）');
  {
    const images = Array.from({ length: 20 }, (_, i) => ({ filename: `${String(i + 1).padStart(3, '0')}.png`, contentType: 'image/png', data: pngBytes(40, 60, i) }));
    const r = await submit(port, TOKEN, 'A10 取消', images);
    await sleep(250); // 让首张进入 translating 并落盘若干张
    const cancel = await request(port, 'POST', `/api/v1/tasks/${r.json.taskId}/cancel`, { token: TOKEN });
    const c = json(cancel);
    check('A10 running 取消 → 200 canceled', cancel.status === 200 && c?.status === 'canceled', c);
    const t = await waitTask(port, TOKEN, r.json.taskId);
    const doneCount = t.items.filter((it) => it.status === 'success').length;
    const skipped = t.items.filter((it) => it.status === 'skipped');
    check('A10 未开始 item 全部 skipped(canceled)', skipped.length > 0 && skipped.every((it) => it.reason === 'canceled'), skipped.length);
    check('A10 已落盘的保留（success 计数 > 0）', doneCount > 0, doneCount);
    check('A10 keptItems 与实际 success 数一致', c?.keptItems === doneCount, [c?.keptItems, doneCount]);

    const dir = path.join(rootDir, 'A10 取消');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const origCount = files.filter((f) => /^\d{3}\.(png|jpg|jpeg|webp)$/.test(f)).length;
    const failedCount = t.items.filter((it) => it.status === 'failed').length;

    /*
     * 这里原先断言的是「原图数 == 译文数」（即『不存在只有原图没有译文的残缺目录』）。
     * G-11 裁定 A 之后那个等式**不再是正确的不变量**：「已处理但失败」的页会合法地
     * 留下一张单独的原图，那正是它能被续做的原因。但它想守的东西没变，只是要收窄到
     * 它真正管的那一格 —— **用户没轮到的页不该在磁盘上留下任何东西**。
     */
    const skippedSeqs = skipped.map((it) => it.seq);
    const leftover = files.filter((f) => skippedSeqs.some((s) => f.startsWith(String(s).padStart(3, '0'))));
    check('A10 未开始的页在磁盘上一张文件都不留（取消不产生残缺目录）',
      skippedSeqs.length > 0 && leftover.length === 0,
      `skipped ${skippedSeqs.length} 页 [${skippedSeqs.join(',')}]；残留：${leftover.join(',') || '无'}`);

    // 账目自洽：每张原图都对得上一个「真的处理过」的 item（成功或失败），不多不少。
    // 多出来 → 有页没被记账（幽灵文件）；少了 → 某张的原图在异常路径上丢了（正是 G-11 要防的）。
    check('A10 磁盘账目自洽：原图数 == 成功 + 失败（失败页的原图由 G-11 保下来）',
      origCount === doneCount + failedCount,
      { origCount, doneCount, failedCount, files: files.length });

    // G-12：取消还要把**暂存区**一起收干净。未处理页的字节到此彻底作废，
    // 留着只会变成「没人认领的孤儿」躺在 state 里；而它们**绝不能**被搬进漫画目录
    // —— 那正是 §4.3「避免只有原图没有译文的残缺目录」要防的事。
    const stageDir = path.join(stateDir, 'pending', r.json.taskId);
    check('A10 取消后该任务的暂存区被清干净（未处理页的字节不留孤儿）',
      !fs.existsSync(stageDir), fs.existsSync(stageDir) ? fs.readdirSync(stageDir) : '已清空');
  }

  // ================================================================ A13 队列
  console.log('A13 队列：FIFO、位次与 eta 的唯一来源');
  {
    const slow = Array.from({ length: 6 }, (_, i) => ({ filename: `${String(i + 1).padStart(3, '0')}.png`, contentType: 'image/png', data: pngBytes(40, 60, i) }));
    const a = await submit(port, TOKEN, 'A13 队列甲', slow);
    const b = await submit(port, TOKEN, 'A13 队列乙', [{ filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 1) }]);
    await sleep(300);
    const q = json(await request(port, 'GET', '/api/v1/queue', { token: TOKEN }));
    check('A13 running 唯一（同一时刻只跑一个任务）', q?.running?.taskId === a.json.taskId, q?.running?.taskId);
    check('A13 queued 位次从 1 起，且为后提交者', q?.queued?.[0]?.taskId === b.json.taskId && q?.queued?.[0]?.position === 1, q?.queued);
    check('A13 eta 为服务端给出的区间（非客户端估算）',
      q?.queued?.[0]?.etaSeconds?.min > 0 && q?.queued?.[0]?.etaSeconds?.max >= q?.queued?.[0]?.etaSeconds?.min, q?.queued?.[0]?.etaSeconds);

    const bq = json(await request(port, 'GET', `/api/v1/tasks/${b.json.taskId}`, { token: TOKEN }));
    check('A13 任务详情 queuePosition 与 /queue 一致', bq?.queuePosition === 1, bq?.queuePosition);

    await waitTask(port, TOKEN, a.json.taskId, 60_000);
    await waitTask(port, TOKEN, b.json.taskId, 60_000);
    const q2 = json(await request(port, 'GET', '/api/v1/queue', { token: TOKEN }));
    check('A13 队列清空后 running=null / queued=[]', q2?.running === null && q2?.queued?.length === 0, q2);
  }

  // ================================================================ A15 任务列表（列表端点 + 来源归因）
  // 覆盖 dev-plan.md §4 的 G-04 增量：X-C1 队列页需要「已完成 / 部分失败 / 失败」历史行，
  // 而契约 §5.7 的 /queue 只给 running+queued，故新增只读端点 GET /tasks（docs/spec-notes.md G-04）。
  console.log('A15 任务列表：跨状态汇总、排序、来源归因');
  {
    const imgs = (n) => Array.from({ length: n }, (_, i) => ({
      filename: `${String(i + 1).padStart(3, '0')}.png`, contentType: 'image/png', data: pngBytes(40, 60, i),
    }));

    /*
     * 排序用例要求「存在一个正在运行的任务」，这本身是个**瞬时状态**。
     * 不能让断言去赌窗口：让首个任务足够长（20 张 × 60ms ≈ 1.2s，远超几次 HTTP 往返），
     * 再**轮询到 running 出现**才断言 —— 这样在负载毛刺下也不会假失败。
     * （20 张含 seq=3，引擎对该 seq 恒失败，故它最终是 partial_failed，后面按此断言。）
     */
    const desk = await submit(port, TOKEN, 'A15 本机投放', imgs(20), { headers: { 'X-Box-Client': 'box-desktop/0.1.0' } });
    const ext = await submit(port, TOKEN, 'A15 插件来源', imgs(2), { headers: { 'X-Box-Client': 'extension/2.3.0' } });
    const anon = await submit(port, TOKEN, 'A15 无来源头', imgs(2));

    const snapshot = async () => json(await request(port, 'GET', '/api/v1/tasks', { token: TOKEN }));
    let live = await snapshot();
    {
      const until = Date.now() + 8000;
      while (Date.now() < until &&
             (live?.tasks || []).find((t) => t.taskId === desk.json.taskId)?.status !== 'running') {
        await sleep(40);
        live = await snapshot();
      }
    }
    const rows0 = live?.tasks || [];
    const liveById = new Map(rows0.map((t) => [t.taskId, t]));
    const idxOf = (id) => rows0.findIndex((t) => t.taskId === id);

    check('A15 列表含刚创建的三个任务',
      [desk, ext, anon].every((r) => liveById.has(r.json.taskId)), live?.count);
    check('A15 排序：A15 三行按「运行中 → 排队 → 排队」出现，位次即提交序',
      idxOf(desk.json.taskId) < idxOf(ext.json.taskId) &&
      idxOf(ext.json.taskId) < idxOf(anon.json.taskId) &&
      liveById.get(desk.json.taskId)?.status === 'running' &&
      liveById.get(ext.json.taskId)?.status === 'queued' &&
      liveById.get(anon.json.taskId)?.status === 'queued',
      rows0.map((t) => t.status));
    {
      // 全局次序：非终态（running/queued）在前，终态在后且不再夹带非终态
      const TERM = ['done', 'partial_failed', 'failed', 'canceled'];
      const firstTerm = rows0.findIndex((t) => TERM.includes(t.status));
      check('A15 排序：运行中与排队中一律排在终态之前',
        firstTerm >= 0 && rows0.slice(0, firstTerm).every((t) => t.status === 'running' || t.status === 'queued') &&
        rows0.slice(firstTerm).every((t) => TERM.includes(t.status)),
        { firstTerm, statuses: rows0.map((t) => t.status) });
    }
    check('A15 来源归因：X-Box-Client=box-desktop/* → desktop',
      liveById.get(desk.json.taskId)?.source === 'desktop', liveById.get(desk.json.taskId)?.source);
    check('A15 来源归因：X-Box-Client=extension/* → extension',
      liveById.get(ext.json.taskId)?.source === 'extension', liveById.get(ext.json.taskId)?.source);
    check('A15 来源归因：无该头 → unknown（不猜）',
      liveById.get(anon.json.taskId)?.source === 'unknown', liveById.get(anon.json.taskId)?.source);
    check('A15 归因不改契约请求体：createView 仍是 §5.2 形状（无 source 字段）',
      !Object.prototype.hasOwnProperty.call(desk.json, 'source'), Object.keys(desk.json));

    for (const r of [desk, ext, anon]) await waitTask(port, TOKEN, r.json.taskId, 60_000);
    await sleep(250);

    const list2 = json(await request(port, 'GET', '/api/v1/tasks', { token: TOKEN }));
    const after = new Map((list2?.tasks || []).map((t) => [t.taskId, t]));
    const ours = [desk, ext, anon].map((r) => after.get(r.json.taskId));
    const byId2 = (id) => after.get(id);
    check('A15 终态行仍留在列表里，且各自状态正确（X-C1 的历史行来源）',
      byId2(desk.json.taskId)?.status === 'partial_failed' &&
      byId2(ext.json.taskId)?.status === 'done' &&
      byId2(anon.json.taskId)?.status === 'done',
      ours.map((t) => t && t.status));
    check('A15 行内带 progress 与 outputDir（进度列 /「打开目录」依赖）',
      ours.every((t) => t.progress && Number.isFinite(t.progress.total) && typeof t.outputDir === 'string'),
      ours[0]);
    check('A15 完成度如实反映：2 张全成 → done/done，20 张含 1 张失败 → 19/20',
      byId2(ext.json.taskId)?.progress.done === 2 && byId2(ext.json.taskId)?.progress.total === 2 &&
      byId2(desk.json.taskId)?.progress.done === 19 && byId2(desk.json.taskId)?.progress.total === 20 &&
      byId2(desk.json.taskId)?.progress.failed === 1,
      ours.map((t) => t.progress));

    const fin = (list2?.tasks || []).filter((t) => t.finishedAt).map((t) => Date.parse(t.finishedAt));
    check('A15 终态按 finishedAt 倒序（最新的在最上）',
      fin.every((v, i) => i === 0 || fin[i - 1] >= v), fin.length);

    const doneOnly = json(await request(port, 'GET', '/api/v1/tasks?status=done', { token: TOKEN }));
    check('A15 status=done 只返回已完成，且 total 反映过滤后全集',
      (doneOnly?.tasks || []).length > 0 && (doneOnly?.tasks || []).every((t) => t.status === 'done') &&
      doneOnly.total === doneOnly.tasks.length, [doneOnly?.count, doneOnly?.total]);

    const limited = json(await request(port, 'GET', '/api/v1/tasks?limit=2', { token: TOKEN }));
    check('A15 limit 截断 tasks 但 total 仍为全集（前端可据此分页）',
      limited?.tasks?.length === 2 && limited.count === 2 && limited.total > 2, [limited?.count, limited?.total]);

    const badLimit = await request(port, 'GET', '/api/v1/tasks?limit=0', { token: TOKEN });
    check('A15 limit=0 → 400 且走契约 §2.2 错误信封',
      badLimit.status === 400 && typeof json(badLimit)?.error?.code === 'string', json(badLimit));

    const q3 = json(await request(port, 'GET', '/api/v1/queue', { token: TOKEN }));
    check('A15 新增端点未污染 /queue 语义（仍严格只含 running+queued，此刻皆空）',
      q3?.running === null && q3?.queued?.length === 0, q3);

    const noTokenList = await request(port, 'GET', '/api/v1/tasks');
    check('A15 列表端点同样受鉴权保护（缺令牌 → 403）',
      noTokenList.status === 403, noTokenList.status);
  }

  // ================================================================ A12 SSE
  console.log('A12 SSE 事件流');
  {
    const images = Array.from({ length: 4 }, (_, i) => ({ filename: `${String(i + 1).padStart(3, '0')}.png`, contentType: 'image/png', data: pngBytes(40, 60, i) }));
    const r = await submit(port, TOKEN, 'A12 事件', images);
    const taskId = r.json.taskId;

    const received = await new Promise((resolve) => {
      const events = [];
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(events); } };
      const req = http.request({ host: '127.0.0.1', port, path: `/api/v1/tasks/${taskId}/events`, headers: { 'X-Box-Token': TOKEN, Accept: 'text/event-stream' } }, (res) => {
        check('A12 SSE 响应头 text/event-stream', /text\/event-stream/.test(res.headers['content-type'] || ''), res.headers['content-type']);
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const rawEvent = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const idLine = /^id: (\d+)$/m.exec(rawEvent);
            const typeLine = /^event: (.+)$/m.exec(rawEvent);
            const dataLine = /^data: (.+)$/m.exec(rawEvent);
            if (typeLine && dataLine) {
              events.push({ id: idLine ? Number(idLine[1]) : null, type: typeLine[1].trim(), data: JSON.parse(dataLine[1]) });
            }
          }
          if (events.some((e) => e.type === 'task.status' && e.data.status === 'done')) {
            res.destroy();
            finish();
          }
        });
      });
      req.end();
      setTimeout(() => { req.destroy(); finish(); }, 25_000);
    });

    const types = new Set(received.map((e) => e.type));
    check('A12 含 task.status', types.has('task.status'), [...types]);
    check('A12 含 batch.status', types.has('batch.status'), [...types]);
    check('A12 含 item.status', types.has('item.status'), [...types]);
    check('A12 item.status 带 saved/outputFile/durationMs 字段',
      received.some((e) => e.type === 'item.status' && 'saved' in e.data && 'outputFile' in e.data && 'durationMs' in e.data),
      received.find((e) => e.type === 'item.status')?.data);
    const ids = received.map((e) => e.id).filter((n) => n !== null);
    check('A12 事件 id 单调递增（可作 Last-Event-ID）', ids.every((n, i) => i === 0 || n > ids[i - 1]), ids);

    // 带 Last-Event-ID 重连：不得重放更早的事件
    const mid = ids.length > 2 ? ids[Math.floor(ids.length / 2)] : null;
    const replay = await new Promise((resolve) => {
      const out = [];
      const req = http.request({
        host: '127.0.0.1', port, path: `/api/v1/tasks/${taskId}/events`,
        headers: { 'X-Box-Token': TOKEN, Accept: 'text/event-stream', 'Last-Event-ID': String(mid) },
      }, (res) => {
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const rawEvent = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const idLine = /^id: (\d+)$/m.exec(rawEvent);
            const typeLine = /^event: (.+)$/m.exec(rawEvent);
            if (typeLine && typeLine[1].trim() !== 'heartbeat' && idLine) out.push(Number(idLine[1]));
          }
        });
      });
      req.end();
      setTimeout(() => { req.destroy(); resolve(out); }, 800);
    });
    check('A12 Last-Event-ID 续传：不回放早于该 id 的事件',
      mid === null || replay.every((n) => n > mid), { mid, replay });
  }

  // ================================================================ A14 安全
  console.log('A14 安全：魔数嗅探 / 路径越界 / 根目录黑名单');
  {
    const spoof = await submit(port, TOKEN, 'A14 魔数', [{ filename: 'evil.png', contentType: 'image/png', data: webpBytes() }]);
    check('A14 伪造 filename=evil.png 但字节是 WEBP → 请求被接受', spoof.status === 201, spoof.json);
    const t = await waitTask(port, TOKEN, spoof.json.taskId);
    // 目录名取服务端回传的规范化结果，不在测试里复述一遍归一化规则
    const dir = path.join(rootDir, t.normalizedComicName);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    check('A14 原图扩展名取嗅探结果（001.webp，而非声明的 .png）', files.includes('001.webp'), files);
    check('A14 译文扩展名取引擎返回字节的嗅探结果（001_translated.png）——同一 seq 两侧各自独立嗅探',
      t.items[0]?.outputFile === '001_translated.png', t.items[0]?.outputFile);

    const invalid = await submit(port, TOKEN, 'A14 坏图', [{ filename: '001.png', contentType: 'image/png', data: Buffer.alloc(0) }]);
    check('A14 0 字节图片 → 400 INVALID_IMAGE', invalid.status === 400 && invalid.json?.error?.code === 'INVALID_IMAGE', invalid.json);

    const traversal = await submit(port, TOKEN, '../../etc/passwd', [{ filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 1) }]);
    check('A14 漫画名含父目录语义 → 被剥离为合法目录名（不越出根目录）',
      traversal.status === 201 && !/[/\\]/.test(traversal.json.normalizedComicName), traversal.json?.normalizedComicName);
    if (traversal.status === 201) await waitTask(port, TOKEN, traversal.json.taskId);

    // 根目录黑名单：另起一个进程，MIAO_ROOT=/tmp
    const bad = spawnProc(SERVICE_ENTRY, {
      MIAO_ROOT: '/tmp', MIAO_STATE_DIR: path.join(TMP, 'state-bad'), MIAO_TOKEN: TOKEN,
    }, 'service-bad-root');
    const exitCode = await new Promise((resolve) => {
      bad.child.on('exit', (code) => resolve(code));
      setTimeout(() => { killProc(bad); resolve('timeout'); }, 6000);
    });
    check('A14 根目录命中黑名单（/tmp）→ 启动失败并明确报错',
      exitCode !== 0 && exitCode !== 'timeout' && /黑名单/.test(bad.err + bad.out), { exitCode, err: bad.err.trim().split('\n')[0] });
  }

  // ================================================================ A16 库扫描（X-D1 的数据面）
  // 契约 §5.8 只说 `GET /library`「扫描落盘根目录返回漫画列表」，未固化字段，
  // 故容量口径（G-01）与聚合字段由实现决定，这里把口径钉成断言。
  console.log('A16 漫画库：容量口径（G-01）与文件流');
  {
    const name = 'A16 库扫描';
    const imgs = Array.from({ length: 2 }, (_, i) => ({
      filename: `${String(i + 1).padStart(3, '0')}.png`, contentType: 'image/png', data: pngBytes(48, 64, i + 4),
    }));
    const r = await submit(port, TOKEN, name, imgs, { headers: { 'X-Box-Client': 'box-desktop/0.1.0' } });
    const dirName = r.json.normalizedComicName;
    await waitTask(port, TOKEN, r.json.taskId, 60_000);

    const lib = json(await request(port, 'GET', '/api/v1/library', { token: TOKEN }));
    const comic = (lib?.comics || []).find((c) => c.comicName === dirName);
    check('A16 库中能找到刚翻译完的漫画', !!comic, (lib?.comics || []).map((c) => c.comicName));
    check('A16 imageCount / translatedCount 各为 2（原译成对）',
      comic?.imageCount === 2 && comic?.translatedCount === 2, comic);

    // G-01 口径：目录内所有文件字节数之和
    const dir = path.join(rootDir, dirName);
    const onDisk = fs.readdirSync(dir).reduce((n, f) => {
      const st = fs.statSync(path.join(dir, f));
      return st.isFile() ? n + st.size : n;
    }, 0);
    check('A16 byteSize === 目录内所有文件字节数之和（G-01 口径）',
      comic?.byteSize === onDisk && onDisk > 0, { byteSize: comic?.byteSize, onDisk });

    check('A16 totalImages / totalBytes 为全库聚合，且 totalBytes >= 本漫画容量',
      (lib?.totalImages || 0) >= 2 && (lib?.totalBytes || 0) >= (comic?.byteSize || 0),
      { totalImages: lib?.totalImages, totalBytes: lib?.totalBytes });

    const trans = await request(port, 'GET', `/api/v1/library/${encodeURIComponent(dirName)}/files/1?variant=translated`, { token: TOKEN });
    check('A16 译文文件流：200 + image/png + 非空', trans.status === 200 && trans.headers['content-type'] === 'image/png' && trans.body.length > 0,
      { status: trans.status, ct: trans.headers['content-type'], len: trans.body.length });
    const orig = await request(port, 'GET', `/api/v1/library/${encodeURIComponent(dirName)}/files/1?variant=original`, { token: TOKEN });
    check('A16 原图文件流同 seq 可用（对照页 X-D2 依赖）', orig.status === 200 && orig.body.length > 0, orig.status);

    const missing = await request(port, 'GET', `/api/v1/library/${encodeURIComponent(dirName)}/files/9?variant=translated`, { token: TOKEN });
    check('A16 不存在的 seq → 404 TASK_NOT_FOUND（不返回空文件）',
      missing.status === 404 && json(missing)?.error?.code === 'TASK_NOT_FOUND', json(missing));

    const reveal = await request(port, 'POST', `/api/v1/library/${encodeURIComponent(dirName)}/reveal`, { token: TOKEN });
    // 服务端把 root 做了 realpath 规范化（macOS 上 /var → /private/var），故断言用 realpath 对齐
    check('A16 reveal 返回目录路径（由 Box 侧唤起访达）',
      reveal.status === 200 && json(reveal)?.ok === true && json(reveal)?.path === fs.realpathSync(dir),
      { got: json(reveal)?.path, want: fs.realpathSync(dir) });

    const libNoToken = await request(port, 'GET', '/api/v1/library');
    check('A16 /library 同样受鉴权保护', libNoToken.status === 403, libNoToken.status);
  }

  // ================================================================ A16b 逐页集合（spec-notes.md G-10 + G-11）
  // 缺陷形状：只给 `translatedCount` 时，客户端只能拿 `seq <= translatedCount` 当代理指标。
  // 这个代理**只在「缺口全在尾部」时碰巧对**；缺口一旦落在中间，它会把后面每一页的判定
  // 整体前移 —— 没有译文的页被说成「已译」，真正有译文的尾页被说成「待译」，**两个方向同时错**。
  //
  // 本块的编号布局：提交 4 张，而自测引擎注入了 seq=3 失败（见 A11 的启动参数）。
  // G-11 裁定 A 之后，这一页在磁盘上是「**有原图、缺译文**」的中间缺口 —— 不再需要手工伪造
  // （以前要额外删掉一张译文才凑得出这个形状）。这比伪造更强：缺口来自**真实失败**。
  //
  // 块尾再手工删掉一张**原图**，把另一种缺口补上：「连原图都没有」= 库里该显示「缺页」。
  // 引擎失败已经不再产生这种页（那正是 G-11 裁 A 的效果），但外部流程仍可能造成
  // ——用户自己删了文件、目录没拷全——所以这条路径必须继续被覆盖。
  console.log('A16b 漫画库：中间缺口时逐页集合必须精确（「数量代理」在此双向必错）');
  {
    const name = 'A16b 中间缺口';
    const imgs = Array.from({ length: 4 }, (_, i) => ({
      filename: `${String(i + 1).padStart(3, '0')}.png`, contentType: 'image/png', data: pngBytes(48, 64, i + 20),
    }));
    const r = await submit(port, TOKEN, name, imgs);
    const dirName = r.json.normalizedComicName;
    const t = await waitTask(port, TOKEN, r.json.taskId, 60_000);

    const dir = path.join(rootDir, dirName);
    const onDisk = fs.readdirSync(dir).sort();
    check('A16b 前置：4 原 + 3 译 = 7 个文件，缺口落在**中间**（003 有原图、无译文）',
      JSON.stringify(onDisk) === '["001.png","001_translated.png","002.png","002_translated.png","003.png","004.png","004_translated.png"]',
      `任务 ${t.status}；items=${JSON.stringify((t.items || []).map((it) => `${it.seq}:${it.status}`))}；磁盘 ${JSON.stringify(onDisk)}`);

    const lib = json(await request(port, 'GET', '/api/v1/library', { token: TOKEN }));
    const comic = (lib?.comics || []).find((c) => c.comicName === dirName);
    check('A16b 张数仍是「译了几页」口径：原图 4 / 译文 3（张数本身不表达是哪几页）',
      comic?.imageCount === 4 && comic?.translatedCount === 3,
      `imageCount=${comic?.imageCount} translatedCount=${comic?.translatedCount}`);

    check('A16b translatedSeqs 逐页精确 = [1,2,4]（**不是**用张数推出来的 [1,2,3]）',
      JSON.stringify(comic?.translatedSeqs) === '[1,2,4]', JSON.stringify(comic?.translatedSeqs));
    check('A16b missingSeqs 为空 —— 失败页的原图在磁盘上（G-11 裁 A），它不是「缺页」',
      Array.isArray(comic?.missingSeqs) && comic.missingSeqs.length === 0,
      JSON.stringify(comic?.missingSeqs));
    check('A16b 出现中间缺口后 seqMax 仍为 4（编号段不因缺口被截断）',
      comic?.seqMax === 4, comic?.seqMax);

    // 反证：把旧实现（数量代理）与新实现（逐页集合）逐个 seq 的结论摆在一起比。
    // 若哪天有人图省事退回张数口径，这条会红；若逐页集合算错了，这条也会红。
    const naive = (s) => s <= comic.translatedCount; // 旧前端：seq <= translatedCount
    const truth = new Set(comic?.translatedSeqs);
    const naiveSet = [];
    for (let s = 1; s <= comic.seqMax; s += 1) if (naive(s)) naiveSet.push(s);
    check('A16b 反证：旧的「数量代理」给出 [1,2,3]，事实是 [1,2,4] —— 第 3 页被误判为已译、第 4 页被误判为待译',
      // 一个方向是假阳性（没有译文的说成已译），另一个方向是假阴性（有译文的说成待译）——
      // 必须**两个方向同时**断言，否则只测出「代理偏保守」或只测出「代理偏激进」都能骗过这条。
      naive(3) === true && truth.has(3) === false &&
      naive(4) === false && truth.has(4) === true &&
      naiveSet.length === 3,
      `代理 [${naiveSet.join(',')}] vs 事实 {${(comic?.translatedSeqs || []).join(',')}}；`
      + `第 3 页 代理说已译/事实说没有（3 <= ${comic?.translatedCount}），`
      + `第 4 页 代理说待译/事实说有（4 > ${comic?.translatedCount}）`);

    // 「缺页」态仍须可达且精确：手工删掉一张原图（模拟用户自己删了文件 / 目录没拷全）。
    // 引擎失败已经不再产生这种页，但扫描逻辑不能因此就丢掉这条分支 —— 库里那张卡
    // 必须能把「用户根本没给过这一页」和「给了但没译成」如实分开（前者在 GridState 里是「缺页」）。
    fs.rmSync(path.join(dir, '002.png'));
    const lib2 = json(await request(port, 'GET', '/api/v1/library', { token: TOKEN }));
    const c2 = (lib2?.comics || []).find((x) => x.comicName === dirName);
    check('A16b 外部删掉一张原图后 missingSeqs = [2]（「缺页」态仍可达且精确）',
      JSON.stringify(c2?.missingSeqs) === '[2]', JSON.stringify(c2?.missingSeqs));
    check('A16b 缺页不影响译文集合：translatedSeqs 仍为 [1,2,4]',
      JSON.stringify(c2?.translatedSeqs) === '[1,2,4]', JSON.stringify(c2?.translatedSeqs));
    check('A16b 出现缺页后 seqMax 仍为 4（编号段不因缺页被截断）', c2?.seqMax === 4, c2?.seqMax);
  }

  // ================================================================ A17 本地续做（X-D1「继续翻译」）
  // 契约 §5.8 未定义「哪几页还没翻」，而 X-D1 的「继续翻译」需要它 → 新增 resume 端点（spec-notes.md G-07）。
  // 核心风险是「续做会不会重复原图 / 覆盖原图」，故这两条必须钉死。
  console.log('A17 本地续做：按已有原图补译文，不新增编号、不覆盖原图');
  {
    const name = 'A17 续做';
    const imgs = Array.from({ length: 2 }, (_, i) => ({
      filename: `${String(i + 1).padStart(3, '0')}.png`, contentType: 'image/png', data: pngBytes(48, 64, i + 9),
    }));
    const r = await submit(port, TOKEN, name, imgs, { headers: { 'X-Box-Client': 'box-desktop/0.1.0' } });
    const dirName = r.json.normalizedComicName;
    await waitTask(port, TOKEN, r.json.taskId, 60_000);

    const dir = path.join(rootDir, dirName);
    const original2Before = fs.readFileSync(path.join(dir, '002.png'));
    const origCountBefore = fs.readdirSync(dir).filter((f) => /^\d{3}\.(png|jpg|jpeg|webp)$/.test(f)).length;

    // 模拟「第 2 页没翻成」：删掉它的译文
    const t2 = fs.readdirSync(dir).find((f) => /^002_translated\./.test(f));
    check('A17 前置：002 的译文存在（准备删除以构造缺页）', !!t2, fs.readdirSync(dir));
    fs.unlinkSync(path.join(dir, t2));

    const plan = json(await request(port, 'GET', `/api/v1/library/${encodeURIComponent(dirName)}/resume`, { token: TOKEN }));
    check('A17 续做清单只列出缺译文的页',
      plan?.imageCount === 2 && plan?.translatedCount === 1 && plan?.pendingCount === 1 &&
      plan?.pendings?.[0]?.seq === 2, plan && { i: plan.imageCount, t: plan.translatedCount, p: plan.pendings });

    const rs = await request(port, 'POST', `/api/v1/library/${encodeURIComponent(dirName)}/resume`, {
      token: TOKEN,
      headers: { 'Content-Type': 'application/json', 'X-Box-Client': 'box-desktop/0.1.0' },
      body: Buffer.from(JSON.stringify({})),
    });
    const rsJson = json(rs);
    check('A17 续做建单返回 201 且来源归因为 desktop',
      rs.status === 201 && rsJson?.taskId && rsJson?.normalizedComicName === dirName, rsJson);

    const done = await waitTask(port, TOKEN, rsJson.taskId, 60_000);
    check('A17 续做任务终态为 done（1 张成功）',
      done.status === 'done' && done.progress.total === 1 && done.progress.done === 1, done.progress);

    // 关键回归 ①：不新增原图 —— 否则每次续做都会把整本漫画重下一遍
    const origCountAfter = fs.readdirSync(dir).filter((f) => /^\d{3}\.(png|jpg|jpeg|webp)$/.test(f)).length;
    check('A17 续做不新增原图（编号未被重排）',
      origCountAfter === origCountBefore && origCountAfter === 2, { before: origCountBefore, after: origCountAfter });

    // 关键回归 ②：原图字节不变 —— 契约 §7.2「永不覆盖」
    check('A17 续做不改动已存在的原图字节（永不覆盖）',
      fs.readFileSync(path.join(dir, '002.png')).equals(original2Before));

    const retrans = fs.readdirSync(dir).find((f) => /^002_translated\./.test(f));
    check('A17 译文已补齐（002_translated.*）', !!retrans, fs.readdirSync(dir));

    const plan2 = json(await request(port, 'GET', `/api/v1/library/${encodeURIComponent(dirName)}/resume`, { token: TOKEN }));
    check('A17 补齐后清单为空，前端据此把「继续翻译」置灰', plan2?.pendingCount === 0, plan2);

    const again = await request(port, 'POST', `/api/v1/library/${encodeURIComponent(dirName)}/resume`, {
      token: TOKEN, headers: { 'Content-Type': 'application/json' }, body: Buffer.from('{}'),
    });
    check('A17 无可续做页时 → 404（不静默建出空任务）',
      again.status === 404 && json(again)?.error?.code === 'TASK_NOT_FOUND', json(again));

    const wrongSeq = await request(port, 'POST', `/api/v1/library/${encodeURIComponent(dirName)}/resume`, {
      token: TOKEN, headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify({ seqs: [1] })),
    });
    check('A17 显式指定已有译文的页 → 404（不做无意义的重译）',
      wrongSeq.status === 404, json(wrongSeq));

    const badSeqs = await request(port, 'POST', `/api/v1/library/${encodeURIComponent(dirName)}/resume`, {
      token: TOKEN, headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify({ seqs: 'two' })),
    });
    check('A17 seqs 非数组 → 400', badSeqs.status === 400 && json(badSeqs)?.error?.code === 'INVALID_IMAGE', json(badSeqs));

    const resumeNoToken = await request(port, 'GET', `/api/v1/library/${encodeURIComponent(dirName)}/resume`);
    check('A17 续做端点同样受鉴权保护', resumeNoToken.status === 403, resumeNoToken.status);
  }

  // ================================================================ A19 失败页保原图（spec-notes.md G-11，裁定 A）
  // 自测引擎固定注入 seq=3 必然失败（MIAO_ENGINE_FAIL_SEQ），故提交 3 张即可造出
  // 一个「**已处理但没译出来**」的页 —— 这正是 G-11 要管的那一格（区别于用户主动取消、从未处理的页）。
  //
  // 旧行为下该页**原图也不落盘**，于是同时丢掉三件事：① 不可续做（/resume 只挑「有原图、缺译文」的页）；
  // ② 库扫描把它算进 missingSeqs → 卡片显示「缺页」（读起来像用户没给过这页），而队列屏写的是
  // 「1 张失败」—— 同一张图两屏两个故事；③ 契约 §4.3「单图重跑」变成做不到的动作。
  console.log('A19 失败页保原图：可续做，且库里如实显示「待译」而不是「缺页」');
  {
    const name = 'A19 失败保原图';
    const imgs = Array.from({ length: 3 }, (_, i) => ({
      filename: `${String(i + 1).padStart(3, '0')}.png`, contentType: 'image/png', data: pngBytes(48, 64, i + 40),
    }));
    const r = await submit(port, TOKEN, name, imgs);
    const dirName = r.json.normalizedComicName;
    const done = await waitTask(port, TOKEN, r.json.taskId, 60_000);
    check('A19 前置：3 张里恰有 1 张失败（引擎注入 seq=3），任务判 partial_failed',
      done.status === 'partial_failed' && done.progress?.failed === 1,
      { status: done.status, progress: done.progress });

    const dir = path.join(rootDir, dirName);
    const files = fs.readdirSync(dir).sort();
    // 旧行为 4 个文件（2 原 + 2 译）；新行为 5 个（3 原 + 2 译）—— 差的那一个就是 003.png 自己。
    check('A19 失败页的原图也在磁盘上（3 原 + 2 译 = 5 个，而非 4 个）',
      files.length === 5 && files.includes('003.png'), files);
    check('A19 失败页不留译文（003_translated.* 不存在）',
      !files.some((f) => f.startsWith('003_translated')), files);

    const lib = json(await request(port, 'GET', '/api/v1/library', { token: TOKEN }));
    const comic = (lib?.comics || []).find((c) => c.comicName === dirName);
    check('A19 库里该页进「待译」：translatedSeqs = [1,2]、missingSeqs 为空',
      JSON.stringify(comic?.translatedSeqs) === '[1,2]' &&
      Array.isArray(comic?.missingSeqs) && comic.missingSeqs.length === 0,
      { translatedSeqs: comic?.translatedSeqs, missingSeqs: comic?.missingSeqs, imageCount: comic?.imageCount, translatedCount: comic?.translatedCount });

    // 反证：这是 G-11 两个选项**唯一的可见差别**。若哪天真退回「失败不落原图」，
    // missingSeqs 会变成 [3]（库把该页报成「缺页」），这条立刻变红。
    check('A19 反证：该页不落进 missingSeqs（落进去就意味着库里报「缺页」）',
      !(comic?.missingSeqs || []).includes(3), JSON.stringify(comic?.missingSeqs));

    const plan = json(await request(port, 'GET', `/api/v1/library/${encodeURIComponent(dirName)}/resume`, { token: TOKEN }));
    check('A19 该页出现在「继续翻译」清单里（旧行为下清单为空 → 根本不可续做）',
      plan?.pendingCount === 1 && plan?.pendings?.[0]?.seq === 3,
      plan && { imageCount: plan.imageCount, translatedCount: plan.translatedCount, pendingCount: plan.pendingCount, pendings: plan.pendings });

    // 续做一次：关键是**失败原因**。失败注入是永久的，所以它还会失败，但
    //   engine_*          → 原图读到了、真的把这张图送进引擎了（「可续做」成立）
    //   original_missing  → 原图不在，续做是句空话（旧行为）
    const original3Before = fs.readFileSync(path.join(dir, '003.png'));
    const rs = await request(port, 'POST', `/api/v1/library/${encodeURIComponent(dirName)}/resume`, {
      token: TOKEN,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ seqs: [3] })),
    });
    const rsJson = json(rs);
    const retry = await waitTask(port, TOKEN, rsJson.taskId, 60_000);
    const it = (retry.items || [])[0];
    check('A19 续做真能拿到原图送去引擎（失败原因是 engine_*，不是 original_missing）',
      /^engine_/.test(it?.reason || ''),
      { status: it?.status, reason: it?.reason, seq: it?.seq });
    check('A19 续做未改动原图字节（§7.2 永不覆盖）',
      fs.readFileSync(path.join(dir, '003.png')).equals(original3Before));
  }

  // ================================================================ A20 上传字节暂存（spec-notes.md G-12，裁定 B）
  // G-12 的病灶：上传字节原先只活在服务进程的内存里（`store.blobs`），进程一崩就全丢 ——
  // 不只是「正在翻译那一张」，而是**所有尚未落盘的页**（实测：5 张里 4 张永久消失，
  // 且库里的张数会静默缩水、点「重试」还会被回一句「该漫画已全部翻译完成」）。
  // 修法：上传即把字节落一份到 `state/pending/<taskId>/`（**漫画目录之外** —— 见下），
  // 某页原图确认进漫画目录后再撤掉那一份；取消则整批丢弃。
  //
  // 本段要钉死三件事：① 修复没有破坏《02》§4.3 / 契约 §4.1（漫画目录不得提前出现）；
  // ② 崩溃重启后未落盘的页确实被救回（库里「待译」、清单可续做、原图能送到引擎）；
  // ③ **反证**：把暂存偷走再走一遍，必须救不回来 —— 否则「救回」可能另有来源。
  console.log('A20 上传字节暂存：崩溃重启后未落盘的原图仍能救回，取消则不留痕');
  {
    const g12Root = path.join(TMP, 'g12-root');
    const g12State = path.join(TMP, 'g12-state');
    const stageDirOf = (taskId) => path.join(g12State, 'pending', taskId);
    const filesIn = (d) => { try { return fs.readdirSync(d).sort(); } catch { return null; } };

    /*
     * 「假引擎」：`/ready` 立刻回 200（否则服务的 sidecar 门禁会把提交挡成 503，
     * 见 server.mjs::assertSidecarReady），但 `/translate` **收下请求后永不回应**。
     *
     * 为什么非要用它、而不是「没人监听的端口」：后者会立刻 ECONNREFUSED，第一张
     * 瞬间失败并落盘，「还有几页没落盘」的窗口根本不存在，整段测试就变成看运气。
     * 用「只连不答」才让每张都卡在超时上（MIAO_ENGINE_TIMEOUT_MS），窗口稳定可复现。
     */
    const fakeEngine = http.createServer((req, res) => {
      if (req.url === '/ready') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'mangatranslator', engine: 'fake-silent' }));
        return;
      }
      req.resume(); // /translate：把 body 吃掉，然后装作在思考
    });
    let fakePort = 0;
    for (let p = 5301; p <= 5311 && !fakePort; p += 1) {
      const ok = await new Promise((resolve) => {
        const onErr = () => resolve(false);
        fakeEngine.once('error', onErr);
        fakeEngine.listen(p, '127.0.0.1', () => { fakeEngine.off('error', onErr); resolve(true); });
      });
      if (ok) fakePort = p;
    }
    check('A20 前置：假引擎就绪（/ready 答 200，/translate 永不回应）', fakePort > 0, fakePort);

    const g12Env = {
      MIAO_ROOT: g12Root,
      MIAO_STATE_DIR: g12State,
      MIAO_TOKEN: TOKEN,
      MIAO_ENGINE_PORT: String(fakePort),
      MIAO_ENGINE_TIMEOUT_MS: '700',
    };
    const imgs = Array.from({ length: 4 }, (_, i) => ({
      filename: `${String(i + 1).padStart(3, '0')}.png`, contentType: 'image/png', data: pngBytes(40, 60, i + 21),
    }));
    /** 死等第 1 张进入 translating（此后它卡在引擎超时上，给我们一个稳定窗口） */
    const waitFirstTranslating = async (p, taskId) => {
      const until = Date.now() + 8000;
      for (;;) {
        const d = json(await request(p, 'GET', `/api/v1/tasks/${taskId}`, { token: TOKEN }));
        if (d?.items?.[0]?.status === 'translating') return true;
        if (Date.now() > until) return false;
        await sleep(25);
      }
    };
    const waitPortGone = async (p) => {
      const until = Date.now() + 8000;
      while (await portOpen(p)) { if (Date.now() > until) return false; await sleep(40); }
      return true;
    };

    let g12svc = spawnProc(SERVICE_ENTRY, g12Env, 'service-g12');
    try {
      let g12port = (await waitReady(g12svc)).port;

      // ---- ① 建单后：字节进了暂存区，而漫画目录**仍不存在** ----
      const r = await submit(g12port, TOKEN, 'A20 崩溃', imgs);
      const taskId = r.json.taskId;
      const dirName = r.json.normalizedComicName;
      const comicDir = path.join(g12Root, dirName);

      const staged = filesIn(stageDirOf(taskId));
      check('A20 建单后 4 份字节已落 state 暂存区（活得过进程）',
        staged !== null && staged.length === 4, staged);
      check('A20 且漫画目录尚未创建 —— §4.1 目录惰性创建 / §4.3 不提前留痕未被破坏',
        !fs.existsSync(comicDir), fs.existsSync(comicDir) ? filesIn(comicDir) : '不存在');

      // ---- ② 冻结进程再观察，然后强杀 ----
      // 先 SIGSTOP 再断言，是为了让「观察」与「杀」之间**没有时间窗口**：
      // 否则暂停的这一瞬它可能刚好把第 1 张落盘，断言就成了看运气。
      check('A20 前置：第 1 张已进入 translating', await waitFirstTranslating(g12port, taskId));
      g12svc.child.kill('SIGSTOP');
      await sleep(120);
      check('A20 打断前：漫画目录里一张都没有（这一轮丢的就是它们）',
        !fs.existsSync(comicDir), fs.existsSync(comicDir) ? filesIn(comicDir) : '不存在');
      check('A20 打断前：暂存区仍有 4 份（这是唯一的字节副本）',
        (filesIn(stageDirOf(taskId)) || []).length === 4, filesIn(stageDirOf(taskId)));

      g12svc.child.kill('SIGKILL'); // 模拟崩溃：不可捕获、没有清理机会
      check('A20 SIGKILL 后端口释放（确认它真死了，下面的重启才有意义）', await waitPortGone(g12port));

      // ---- ③ 原地重启（同一 root + state）：未落盘的原图应当被搬回漫画目录 ----
      g12svc = spawnProc(SERVICE_ENTRY, g12Env, 'service-g12b');
      g12port = (await waitReady(g12svc)).port;

      const after = filesIn(comicDir);
      check('A20 重启后：4 张原图全部被搬回漫画目录（修复前它们永久消失）',
        after !== null && after.length === 4 && after.every((f) => /^\d{3}\.png$/.test(f)), after);
      check('A20 重启后：没有任何译文（一张也没翻成，故库里的正确说法是「待译」而非「已译完」）',
        !(after || []).some((f) => /_translated\./.test(f)), after);
      check('A20 重启后：暂存区已被收干净（搬空即删，不留孤儿）',
        filesIn(stageDirOf(taskId)) === null, filesIn(stageDirOf(taskId)));

      const detail = json(await request(g12port, 'GET', `/api/v1/tasks/${taskId}`, { token: TOKEN }));
      check('A20 任务仍按 failed(service_restarted) 收尾 —— 姿态是「不做后台自动续做，由用户触发」',
        detail?.status === 'failed' &&
        (detail?.items || []).every((it) => it.status === 'failed' && it.reason === 'service_restarted'),
        { status: detail?.status, items: FailedItemsSummary(detail?.items || []) });

      const lib = json(await request(g12port, 'GET', '/api/v1/library', { token: TOKEN }));
      const comic = (lib?.comics || []).find((c) => c.comicName === dirName);
      check('A20 库里这本是 4 页、seqMax=4（修复前会静默缩水成 1 页，连「缺页」都显示不出来）',
        comic?.imageCount === 4 && comic?.seqMax === 4,
        comic && { imageCount: comic.imageCount, seqMax: comic.seqMax });
      check('A20 逐页集合：4 页都在「待译」位置，没有一页落进「缺页」',
        JSON.stringify(comic?.translatedSeqs) === '[]' && JSON.stringify(comic?.missingSeqs) === '[]',
        comic && { translatedSeqs: comic.translatedSeqs, missingSeqs: comic.missingSeqs });

      const plan = json(await request(g12port, 'GET', `/api/v1/library/${encodeURIComponent(dirName)}/resume`, { token: TOKEN }));
      check('A20 4 页全部进入「继续翻译」清单（修复前清单为空 → 点重试必 404）',
        plan?.pendingCount === 4 && (plan?.pendings || []).map((p) => p.seq).join(',') === '1,2,3,4',
        plan && { pendingCount: plan.pendingCount, seqs: (plan.pendings || []).map((p) => p.seq) });

      const rs = await request(g12port, 'POST', `/api/v1/library/${encodeURIComponent(dirName)}/resume`, {
        token: TOKEN, headers: { 'Content-Type': 'application/json' }, body: Buffer.from('{}'),
      });
      check('A20 点「继续翻译」真的建出任务（201，不再是一句「已全部翻译完成」）',
        rs.status === 201 && !!json(rs)?.taskId, { status: rs.status, body: json(rs) });
      const rsDone = await waitTask(g12port, TOKEN, json(rs).taskId, 60_000);
      check('A20 续做时送进引擎的是**恢复出来的原图**（失败原因是 engine_*，不是 original_missing）',
        (rsDone.items || []).length === 4 && rsDone.items.every((it) => /^engine_/.test(String(it.reason))),
        FailedItemsSummary(rsDone.items || []));

      // ---- ④ 反证：把暂存偷走再走一遍，必须**救不回来** ----
      // 排除「救回是别的东西顺带完成的」这种解释：字节当时只存在于内存与暂存两处，
      // 内存随进程消失，于是唯一可能的来源就是暂存 —— 拿掉它，救回必须随之消失。
      const r2 = await submit(g12port, TOKEN, 'A20 反证', imgs);
      const taskId2 = r2.json.taskId;
      const comicDir2 = path.join(g12Root, r2.json.normalizedComicName);
      check('A20 反证前置：第 2 条任务也卡在 translating', await waitFirstTranslating(g12port, taskId2));
      g12svc.child.kill('SIGSTOP');
      await sleep(120);
      const stolen = (filesIn(stageDirOf(taskId2)) || []).length;
      fs.rmSync(stageDirOf(taskId2), { recursive: true, force: true }); // 把唯一的字节副本偷走
      g12svc.child.kill('SIGKILL');
      await waitPortGone(g12port);

      g12svc = spawnProc(SERVICE_ENTRY, g12Env, 'service-g12c');
      g12port = (await waitReady(g12svc)).port;
      check('A20 反证：偷走暂存后重启，漫画目录**依旧不存在** —— 救回确实来自暂存，不是别的东西',
        stolen === 4 && !fs.existsSync(comicDir2),
        { stolen, exists: fs.existsSync(comicDir2), files: filesIn(comicDir2) });
      const plan2 = await request(g12port, 'GET', `/api/v1/library/${encodeURIComponent(r2.json.normalizedComicName)}/resume`, { token: TOKEN });
      check('A20 反证：这本漫画连库里的条目都不存在 —— 「静默缩水」正是 G-12 的病灶本身',
        plan2.status === 404 && json(plan2)?.error?.code === 'TASK_NOT_FOUND',
        { status: plan2.status, body: json(plan2) });
    } finally {
      if (g12svc?.child && g12svc.child.exitCode === null) g12svc.child.kill('SIGKILL');
      await new Promise((resolve) => fakeEngine.close(resolve));
      await sleep(200);
    }
  }

  // ================================================================ A21 落盘根目录可写性（契约 §2.2 DISK_FULL）
  // §2.2 要求「创建任务前探测一次根目录可写性；不可写 → 507 DISK_FULL」。这一段把它钉住，
  // 并且双向钉住 —— 因为「507」的文案是「**磁盘满或权限不足**」，那是一句会让人去清磁盘的话：
  //   ① 真的文件系统错误（带 errno）→ 必须是 507，且原因要带得出来；
  //   ② **不带 errno** 的错误（来自别处，不是文件系统）→ **不得**伪装成 507。
  // ② 不是假想的：本机实测踩过一次 —— 运行时策略层拦下一次探测写入，磁盘明明还剩 58 GB，
  // 服务却回了一句 507 DISK_FULL，而 details 里连个 errno 都没有，完全无从判断。
  console.log('A21 落盘根目录可写性：真 fs 错误 → 507；非文件系统错误不得伪装成 507');
  {
    // ---- ① 根目录只读 → 507 DISK_FULL，且 details.reason 必须带得出原因 ----
    const roRoot = path.join(TMP, 'ro-root');
    const roSvc = spawnProc(SERVICE_ENTRY, {
      MIAO_ROOT: roRoot, MIAO_STATE_DIR: path.join(TMP, 'ro-state'),
      MIAO_TOKEN: TOKEN, MIAO_ENGINE_PORT: String(eng.port),
    }, 'service-ro');
    try {
      const roPort = (await waitReady(roSvc)).port;
      fs.chmodSync(roRoot, 0o500); // 去掉写位：这是 spec-notes D-10 一直在用的可注入条件
      const res = await submit(roPort, TOKEN, 'A21 只读', [
        { filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 31) },
      ]);
      const body = res.json; // 注意：不是 json(res) —— submit 返回的是 {status, json, raw}
      check('A21 根目录不可写 → 507 DISK_FULL（§2.2）',
        res.status === 507 && body?.error?.code === 'DISK_FULL', { status: res.status, body });
      check('A21 details.reason 带得出 errno —— 原先只回 err.code，遇到无 errno 的错误就成了「（undefined）」',
        body?.error?.details?.reason === 'EACCES', body?.error?.details);
      check('A21 探测失败不留 probe 残留文件',
        !fs.readdirSync(roRoot).some((f) => f.startsWith('.write-probe-')),
        fs.readdirSync(roRoot));
    } finally {
      try { fs.chmodSync(roRoot, 0o700); } catch { /* ignore */ }
      killProc(roSvc);
      await sleep(200);
    }

    // ---- ② 注入一个**刻意不带 errno** 的探测写入错误 → 必须是 500，不能是 507 ----
    // 手段：`NODE_OPTIONS=--import` 给服务进程挂一个钩子，只让探测写入抛一个没有 code 的 Error。
    // 这是唯一能稳定构造这个形状的办法 —— 真实环境里它由运行时策略层抛出，无法从外部按需触发。
    const hook = path.join(TMP, 'inject-probe-error.mjs');
    fs.writeFileSync(hook, [
      "import fs from 'node:fs';",
      'const orig = fs.writeFileSync;',
      'fs.writeFileSync = function (p, ...rest) {',
      "  if (String(p).includes('.write-probe-')) {",
      "    throw new Error('injected: 写入被外部策略层拦下（刻意不带 errno）');",
      '  }',
      '  return orig.call(fs, p, ...rest);',
      '};',
    ].join('\n'));
    const injSvc = spawnProc(SERVICE_ENTRY, {
      MIAO_ROOT: path.join(TMP, 'inj-root'), MIAO_STATE_DIR: path.join(TMP, 'inj-state'),
      MIAO_TOKEN: TOKEN, MIAO_ENGINE_PORT: String(eng.port),
      NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`,
    }, 'service-inj');
    try {
      const injPort = (await waitReady(injSvc)).port;
      const res = await submit(injPort, TOKEN, 'A21 注入', [
        { filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 32) },
      ]);
      const body = res.json; // 同上：submit 的返回值里已带解析好的 json
      check('A21 非文件系统错误不得被伪装成 507「磁盘满或权限不足」',
        res.status !== 507 && body?.error?.code === 'INTERNAL',
        { status: res.status, code: body?.error?.code, details: body?.error?.details });
      check('A21 该错误的原因留在 details.reason 里（可查），而不是被吞掉',
        /injected/.test(String(body?.error?.details?.reason || '')), body?.error?.details);
    } finally {
      killProc(injSvc);
      await sleep(200);
    }
  }

  // ================================================================ A14（补充）sidecar 未就绪
  console.log('A14b sidecar 未就绪 → 503 UNAVAILABLE');
  {
    const down = spawnProc(SERVICE_ENTRY, {
      MIAO_ROOT: path.join(TMP, 'root-down'),
      MIAO_STATE_DIR: path.join(TMP, 'state-down'),
      MIAO_TOKEN: TOKEN,
      MIAO_SIDECAR_DOWN: '1',
      MIAO_PORT: '5179',
    }, 'service-down');
    const info = await waitReady(down, 8000);
    const res = await request(info.port, 'GET', '/api/v1/health');
    const h = json(res);
    check('A14b sidecar down → /health status=degraded', h?.status === 'degraded', h?.status);
    const r = await submit(info.port, TOKEN, 'A14b', [{ filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 1) }]);
    check('A14b 未就绪时提交 → 503 UNAVAILABLE', r.status === 503 && r.json?.error?.code === 'UNAVAILABLE', r.json);
    killProc(down);
  }

  // ================================================================ A18 父进程看守
  console.log('A18 父进程看守：主进程被强杀后子进程自救（契约 B4 的异常分支）');
  {
    // 为什么需要这个用例：ServiceManager 只在**正常退出**路径调 stop()。
    // 主进程崩溃 / 被活动监视器强制退出时是 SIGKILL —— 不可捕获，Rust 侧没有机会清理。
    // 此前只能指望 stdout 管道破裂（EPIPE）的副作用，若无日志写入则进程会赖着占端口。
    const WATCH_PORT = 5189;
    const h = spawnProc(HARNESS, {
      MIAO_PORT: String(WATCH_PORT),
      MIAO_ROOT: path.join(TMP, 'root-watch'),
      MIAO_STATE_DIR: path.join(TMP, 'state-watch'),
      MIAO_TOKEN: TOKEN,
      MIAO_HARNESS_LOG: path.join(TMP, 'watch-service.log'),
    }, 'service-watch', [SERVICE_ENTRY]);
    let svcPid = null;
    try {
      // 直接探测端口，不解析就绪行：本用例刻意让服务的 stdout 走**文件**而非管道，
      // 以免 EPIPE 冒充「看守生效」把用例变成假阳性（见 _parent-harness.mjs 的说明）
      let up = false;
      for (let i = 0; i < 50 && !up; i++) {
        up = await portOpen(WATCH_PORT);
        if (!up) await sleep(200);
      }
      check('A18 前置：经「假父进程」拉起的服务就绪', up, `端口 ${WATCH_PORT} 不可达`);

      // 跨过 2 个看守周期（intervalMs = 2000）再确认一次：看守不能误杀
      await sleep(2600);
      check('A18 父进程健在 → 服务持续存活（看守不误杀）',
        await portOpen(WATCH_PORT), `端口 ${WATCH_PORT} 不可达`);

      const pidMatch = /HARNESS_CHILD_PID (\d+)/.exec(h.out);
      svcPid = pidMatch ? Number(pidMatch[1]) : null;

      h.child.kill('SIGKILL'); // 只杀「假父进程」，服务应自行退出
      const until = Date.now() + 8000;
      let stillUp = true;
      while (Date.now() < until) {
        if (!(await portOpen(WATCH_PORT))) { stillUp = false; break; }
        await sleep(200);
      }
      check('A18 强杀父进程后服务自行退出（不残留孤儿占住端口）',
        !stillUp, stillUp ? `仍在监听 ${WATCH_PORT}，看守失效` : '');
    } finally {
      // 无论断言结果如何都要收拾干净：否则残留进程会污染后续运行
      if (svcPid) { try { process.kill(svcPid, 'SIGKILL'); } catch { /* 已退出 */ } }
      if (h.child.exitCode === null) h.child.kill('SIGKILL');
      await sleep(250);
    }
  }
} catch (err) {
  console.error('\n[selftest] 运行期异常：', err);
  if (service && service.err.trim()) console.error(`[selftest] service stderr:\n${service.err.trim()}`);
  if (engine && engine.err.trim()) console.error(`[selftest] engine stderr:\n${engine.err.trim()}`);
  failed++;
  failures.push(`运行期异常：${err.message}`);
} finally {
  killProc(service);
  killProc(engine);
  await sleep(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n================ 服务契约自测 ================`);
console.log(`  通过 ${passed} / 失败 ${failed}`);
if (failures.length) {
  console.log('  失败项：');
  for (const f of failures) console.log(`    · ${f}`);
}
console.log('=============================================');
process.exit(failed === 0 ? 0 : 1);
