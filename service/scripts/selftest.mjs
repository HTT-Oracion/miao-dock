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
    if (task && ['done', 'partial_failed', 'failed', 'canceled'].includes(task.status)) return task;
    if (Date.now() > until) throw new Error(`任务 ${taskId} 未在 ${timeoutMs}ms 内结束（当前 ${task && task.status}）`);
    await sleep(120);
  }
}

// ------------------------------------------------------------------ 进程管理

function spawnProc(entry, env, tag) {
  const child = spawn(process.execPath, [entry], {
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
    // 用 2 张图（引擎对 seq=3 恒失败，这里要的是「全部成功 → done」，便于断言 progress）
    const imgs = (n) => Array.from({ length: n }, (_, i) => ({
      filename: `${String(i + 1).padStart(3, '0')}.png`, contentType: 'image/png', data: pngBytes(40, 60, i),
    }));

    const desk = await submit(port, TOKEN, 'A15 本机投放', imgs(2), { headers: { 'X-Box-Client': 'box-desktop/0.1.0' } });
    const ext = await submit(port, TOKEN, 'A15 插件来源', imgs(2), { headers: { 'X-Box-Client': 'extension/2.3.0' } });
    const anon = await submit(port, TOKEN, 'A15 无来源头', imgs(2));
    // 刻意不 sleep：要在「第一个任务仍在跑」的窗口内验证排序（引擎每张 60ms）

    const live = json(await request(port, 'GET', '/api/v1/tasks', { token: TOKEN }));
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
    check('A15 终态行仍留在列表里（X-C1 的历史行来源）',
      ours.every((t) => t && t.status === 'done'), ours.map((t) => t && t.status));
    check('A15 行内带 progress 与 outputDir（进度列 /「打开目录」依赖）',
      ours.every((t) => t.progress && Number.isFinite(t.progress.total) && typeof t.outputDir === 'string'),
      ours[0]);
    check('A15 全部成功 → progress.done === total === 2',
      ours.every((t) => t.progress.total === 2 && t.progress.done === 2), ours.map((t) => t.progress));

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
    const dir = path.join(rootDir, 'A14 魔数');
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
