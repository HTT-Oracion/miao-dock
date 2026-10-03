// box-service 契约自测 —— 覆盖 dev-plan.md §4 验收表 A1–A14
//
// 运行：node service/scripts/selftest.mjs
// 原则：每个断言都对应契约里的一条明文规则，断言失败即契约不符合。
// 全部 I/O 落在临时目录（MIAO_ROOT / MIAO_STATE_DIR），不触碰用户真实图片目录。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { encodePng } from '../../engine/src/png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..'); // .../service
const SERVICE_ENTRY = path.join(ROOT, 'src', 'server.mjs');
const ENGINE_ENTRY = path.resolve(ROOT, '..', 'engine', 'src', 'server.mjs');
/** 「假父进程」外壳：A18 要强杀一个父进程，不能拿自测自己冒险 */
const HARNESS = path.join(ROOT, 'scripts', '_parent-harness.mjs');

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
    check('A10 「只有原图没有译文」的残缺目录不存在（原图数 == 译文数）',
      origCount === t.items.filter((it) => it.status === 'success').length, { origCount, files: files.length });
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

  // ================================================================ A16b 逐页集合（spec-notes.md G-10）
  // 缺陷形状：只给 `translatedCount` 时，客户端只能拿 `seq <= translatedCount` 当代理指标。
  // 这个代理**只在「缺页全在尾部」时碰巧对**；缺页一旦落在中间，它会把后面每一页的判定
  // 整体前移 —— 没有译文的页被说成「已译」，真正有译文的尾页被说成「待译」，**两个方向同时错**。
  //
  // 本块的编号布局：提交 4 张，而自测引擎注入了 seq=3 失败（见 A11 的启动参数），
  // 于是磁盘上 003 两侧都没有 → 天然一个**中间缺页**；再把 002 的译文删掉，
  // 得到「有原图、缺译文」的中间页 —— 这两种中间缺口的语义不同，前端要分别渲染。
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
    check('A16b 前置：seq=3 失败（引擎注入）→ 磁盘只有 001/002/004 三对，没有 003',
      JSON.stringify(onDisk) === '["001.png","001_translated.png","002.png","002_translated.png","004.png","004_translated.png"]',
      `任务 ${t.status}；items=${JSON.stringify((t.items || []).map((it) => `${it.seq}:${it.status}`))}；磁盘 ${JSON.stringify(onDisk)}`);

    // 让「有原图、缺译文」的缺口也落在中间（002 是中间页）
    fs.rmSync(path.join(dir, '002_translated.png'));

    const lib = json(await request(port, 'GET', '/api/v1/library', { token: TOKEN }));
    const comic = (lib?.comics || []).find((c) => c.comicName === dirName);
    check('A16b 张数仍是「译了几页」口径：原图 3 / 译文 2（张数本身不表达是哪几页）',
      comic?.imageCount === 3 && comic?.translatedCount === 2,
      `imageCount=${comic?.imageCount} translatedCount=${comic?.translatedCount}`);

    check('A16b translatedSeqs 逐页精确 = [1,4]（**不是**用张数推出来的 [1,2]）',
      JSON.stringify(comic?.translatedSeqs) === '[1,4]', JSON.stringify(comic?.translatedSeqs));
    check('A16b missingSeqs 精确列出编号段内没有原图的页 = [3]（seq=3 失败留下的洞）',
      JSON.stringify(comic?.missingSeqs) === '[3]', JSON.stringify(comic?.missingSeqs));
    check('A16b 出现中间缺口后 seqMax 仍为 4（编号段不因缺口被截断）',
      comic?.seqMax === 4, comic?.seqMax);

    // 反证：把旧实现（数量代理）与新实现（逐页集合）逐个 seq 的结论摆在一起比。
    // 若哪天有人图省事退回张数口径，这条会红；若逐页集合算错了，这条也会红。
    const naive = (s) => s <= comic.translatedCount; // 旧前端：seq <= translatedCount
    const truth = new Set(comic?.translatedSeqs);
    const naiveSet = [];
    for (let s = 1; s <= comic.seqMax; s += 1) if (naive(s)) naiveSet.push(s);
    check('A16b 反证：旧的「数量代理」给出 [1,2]，事实是 [1,4] —— 第 2 页被误判为已译、第 4 页被误判为待译',
      naive(2) === true && truth.has(2) === false && naive(4) === false && truth.has(4) === true,
      `代理 [${naiveSet.join(',')}] vs 事实 {${(comic?.translatedSeqs || []).join(',')}}；`
      + `第 2 页 代理说已译/事实说没有，第 4 页 代理说待译/事实说有`);
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
