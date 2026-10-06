#!/usr/bin/env node
/**
 * U10② 引擎**卡死**（挂住不答）——「静默必须有上界、且必须留痕」的取证
 * =============================================================================
 * ## 这一条要验的不是"能跑通"，而是"跑不通时会不会静默"
 * E9 真机长任务下出现过一次引擎停摆（3 次运行复现 1 次）。事后翻现场得到的时间轴是：
 *
 *   20:52:19  第 027 张送进引擎（引擎日志最后一行停在这一张的 Sakura 调用）
 *   20:52:21  **此后 17.5 分钟**：引擎日志、llama 日志、磁盘译文、任务状态文件
 *             —— 四样东西**一起停住**，没有任何新的字节
 *   21:09:54  测试脚本放弃（`{total:13, done:8, failed:0, current:0}`，磁盘与 20:52:19 一模一样）
 *
 * 而单项超时本该在 **+10 分钟**落地（`MIAO_ENGINE_TIMEOUT_MS` 默认 600 s）。
 * 逐条对代码后，两件事能解释"为什么看不出来、为什么这么久"：
 *
 *   ① **重试把静默叠乘**：`store.mjs` 的 `MAX_ATTEMPTS = 2`，而超时被当成普通瞬时错误重试
 *      ⇒ 一次挂住 = 600 s + 600 s = **20 分钟完全静默**，脚本 15 分钟的等待**活不过它**，
 *      于是读到的是"还没失败"，看起来像"任务没跑"。
 *   ② **进行中的项在磁盘上不存在**：`item.status = 'translating'` 之后没落盘
 *      （`_emitItemStatus` / `_syncBatchStatuses` 只改内存 + 发事件）⇒ 快照里 `current: 0`，
 *      连"有一页正在飞"都看不出来。
 *   ③ 顺带：超时那一刻**只报一句"超时了"**，已收到的字节被丢掉 ⇒ 无法区分
 *      「引擎在推理」/「引擎排不上队」/「引擎完全没动静」。上游 `myqueue.py` 的实例
 *      一旦被卡死任务占住就**永不释放**（`free_executors()` 数的是 `busy == False`），
 *      此后所有请求只会反复报 `排队位次 0` —— 而这个信号过去是**被丢弃的**（只记 code 1）。
 *
 * ## 判据（本脚本的可反证形式）
 *   卡住时，**单项的等待时间有上界**（不随重试叠乘）**且**盘上/日志里留得下痕。
 *
 * ## 偶发 → 确定复现
 * 靠反复跑真机去等它复现，一次十几分钟且不可控。而这里要验的东西只与"引擎不回答"这一事实
 * 有关，与被测代码无关 ⇒ 用**注入**把它变成确定事件：
 *   · `engine/src/server.mjs` 的 `MIAO_ENGINE_STALL_SEQ=<n>`：该 seq **永不返回**
 *     （连响应头都不发）—— 覆盖"超时"这条唯一能照出"静默叠乘"的路径；
 *     `MIAO_ENGINE_FAIL_SEQ` 是"立刻返回错误"，照不出它（两者互补）。
 *   · 第二段用**真协议**的假引擎（先发进度帧再静默）直接打 `translateImage`，
 *     验"超时必须带走已收到的帧"。
 *
 * 用法：
 *   node service/scripts/stall-guard-check.mjs            正向
 *   node service/scripts/stall-guard-check.mjs --refute   反证轮（去掉机制 → 断言必须变红）
 *
 * 约束：纯 Node、零第三方依赖；临时目录自建自清；不占 5180–5190（那是 box-service 的段）。
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { encodePng } from '../../engine/src/png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVICE_ENTRY = path.join(ROOT, 'service', 'src', 'server.mjs');
const ENGINE_ENTRY = path.join(ROOT, 'engine', 'src', 'server.mjs');
const STORE_SRC = path.join(ROOT, 'service', 'src', 'store.mjs');
const CLIENT_SRC = path.join(ROOT, 'service', 'src', 'engine-client.mjs');

const REFUTE = process.argv.includes('--refute');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-stall-'));
const TOKEN = 'c'.repeat(64);

/** 声明条数（分母写死：少执行一条即判红） */
const DECLARED = 7;
/** 单项预算 / 单次请求超时：压到 1.5 s —— 真等 10 分钟是不可反证的断言 */
const BUDGET_MS = 1500;
/** 被注入卡死的序号（第 2 张），另两张正常 */
const STALL_SEQ = 2;
const N_IMAGES = 3;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ------------------------------------------------------------------ 进程 / 端口

function portOpen(port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function findFreePort(start, count = 1) {
  for (let p = start; p < start + 300; p += 1) {
    let ok = true;
    for (let i = 0; i < count; i += 1) if (await portOpen(p + i, 100)) { ok = false; break; }
    if (ok) return p;
  }
  throw new Error(`从 ${start} 起找不到 ${count} 个连续空闲端口`);
}

function spawnProc(entry, env, tag) {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const st = { child, out: '', err: '', ready: null, tag };
  child.stdout.on('data', (d) => {
    st.out += d.toString();
    const m = /MIAO_(?:ENGINE_)?READY (\{.*\})/.exec(st.out);
    if (m && !st.ready) { try { st.ready = JSON.parse(m[1]); } catch { /* 继续等 */ } }
  });
  child.stderr.on('data', (d) => { st.err += d.toString(); });
  return st;
}

async function waitReady(st, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (!st.ready && Date.now() < until) await sleep(40);
  if (!st.ready) throw new Error(`${st.tag} 未就绪。stdout=${st.out.slice(-500)}\nstderr=${st.err.slice(-400)}`);
  return st.ready;
}

const killProc = (st) => { if (st && st.child && st.child.exitCode === null) st.child.kill('SIGTERM'); };

// ------------------------------------------------------------------ 服务 HTTP 夹子

function request(port, method, pathname, { headers = {}, body = null, token } = {}) {
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

const json = (res) => { try { return JSON.parse(res.body.toString('utf8')); } catch { return null; } };

function buildMultipart({ payload, images }) {
  const boundary = `----miao${crypto.randomBytes(8).toString('hex')}`;
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, 'utf8'));
  push(`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n`);
  push(JSON.stringify(payload));
  push('\r\n');
  for (const img of images) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="images[]"; filename="${img.filename}"\r\n`
      + `Content-Type: ${img.contentType || 'application/octet-stream'}\r\n\r\n`);
    parts.push(img.data);
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return { body: Buffer.concat(parts), boundary };
}

const pngBytes = (seed) => encodePng(40, 60, (x, y, put) => {
  put((seed * 37 + x) % 256, (seed * 17 + y) % 256, (seed * 7) % 256);
});

// ------------------------------------------------------------------ 断言收集

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

// ------------------------------------------------------------------ 一轮：真服务 + 真引擎（mock 协议）+ 卡死注入

/**
 * 读**磁盘上**的任务状态（不是 API 的内存视图）。
 *
 * 🔴 这一条是本脚本的关键取证手段之一：`translating` 有没有落盘，只能在文件里看。
 * 读 API 会拿到内存里的答案 —— 而那正是"磁盘说谎"时要照出来的东西。
 */
function diskItemStatuses(stateDir) {
  const dir = path.join(stateDir, 'tasks');
  const seen = new Set();
  let raw = '';
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return { seen, files: [] }; }
  for (const f of files) {
    try {
      raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const j = JSON.parse(raw);
      for (const b of j.batches || []) for (const it of b.items || []) seen.add(it.status);
    } catch { /* 写一半的瞬间，跳过 */ }
  }
  return { seen, files };
}

async function serviceRound({ stallSeq = null }) {
  const svcPort = await findFreePort(5300);
  const engPort = await findFreePort(5400);
  const stateDir = path.join(TMP, `state-${Math.random().toString(36).slice(2, 8)}`);
  const rootDir = path.join(TMP, `root-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(stateDir, { recursive: true });

  const eng = spawnProc(ENGINE_ENTRY, {
    MIAO_ENGINE_PORT: String(engPort),
    MIAO_ENGINE_ITEM_MS: '250',
    MIAO_ENGINE_STALL_SEQ: stallSeq ? String(stallSeq) : '',
  }, 'engine');
  const svc = spawnProc(SERVICE_ENTRY, {
    MIAO_ENGINE_PROTOCOL: 'mock',
    MIAO_ENGINE_PORT: String(engPort),
    MIAO_ENGINE_PROBE_MS: '300',
    // 预算与单次超时同值：这正是产品的默认关系（同为 600 s / mock 下同为 60 s）
    MIAO_ENGINE_TIMEOUT_MS: String(BUDGET_MS),
    MIAO_ITEM_TIMEOUT_MS: String(BUDGET_MS),
    MIAO_PORT: String(svcPort),
    MIAO_TOKEN: TOKEN,
    MIAO_STATE_DIR: stateDir,
    MIAO_ROOT: rootDir,
    MIAO_SKIP_EXISTING: '0',
  }, 'service');

  try {
    await waitReady(eng);
    const info = await waitReady(svc);
    const PORT = info.port;

    const { body, boundary } = buildMultipart({
      payload: { comicName: 'U10b 卡死取证', idempotencyKey: crypto.randomUUID() },
      images: Array.from({ length: N_IMAGES }, (_, i) => ({
        filename: `${String(i + 1).padStart(3, '0')}.png`, contentType: 'image/png', data: pngBytes(i + 3),
      })),
    });
    const sub = await request(PORT, 'POST', '/api/v1/tasks', {
      token: TOKEN,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    if (sub.status !== 201 && sub.status !== 200) {
      throw new Error(`建单失败 status=${sub.status} body=${sub.body.toString('utf8').slice(0, 200)}`);
    }
    const taskId = json(sub).taskId;

    // 一边等终态，一边按 **磁盘** 采样（要看 `translating` 有没有落盘）
    const diskSeen = new Set();
    let diskFiles = 0;
    let task = null;
    const until = Date.now() + 40_000;
    for (;;) {
      const snap = diskItemStatuses(stateDir);
      for (const s of snap.seen) diskSeen.add(s);
      diskFiles = snap.files.length;
      const res = await request(PORT, 'GET', `/api/v1/tasks/${taskId}`, { token: TOKEN });
      task = json(res);
      if (task && ['done', 'partial_failed', 'failed', 'canceled'].includes(task.status)) break;
      if (Date.now() > until) throw new Error(`任务未在 40s 内结束（当前 ${task && task.status}）`);
      await sleep(25);
    }
    return { task, diskSeen, diskFiles, svcLog: svc.out + svc.err, stateDir };
  } finally {
    killProc(svc);
    killProc(eng);
    await sleep(200);
  }
}

// ------------------------------------------------------------------ 第二段：真协议下"超时要带走证据"

/**
 * 起一个**真协议**的假引擎：先发 `排队位次 0` + 一个进度帧，然后**永远静默**。
 *
 * 为什么单独用真协议：`code 3`（队列位次）是上游 `myqueue.py:99` 在
 * `queue_pos < free_executors()` 为假时反复发的帧 —— 而实例被卡死任务占住时，
 * `free_executors()` 恒为 0、`queue_pos` 恒为 0。于是这一帧是"**引擎活着但拿不到执行器**"
 * 的唯一直接证据。过去它被丢弃（只记 code 1），超时又只报一句"超时了" ⇒ 不可归因。
 *
 * 直接 `import` 模块（不走服务）：被测的就是 `engine-client.mjs` 自己，
 * 少一层进程也少一份环境变量要凑。子进程是必须的 —— ESM 按 URL 缓存模块，
 * 环境变量只能在 import 之前生效。
 */
function evidenceProbe(port) {
  const mod = new URL('../src/engine-client.mjs', import.meta.url).href;
  const js = `
    import http from 'node:http';
    import { translateImage, recentStageLog } from ${JSON.stringify(mod)};
    const frame = (code, text) => {
      const p = Buffer.from(text, 'utf8');
      const h = Buffer.alloc(5); h[0] = code; h.writeUInt32BE(p.length, 1);
      return Buffer.concat([h, p]);
    };
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.write(frame(3, '0'));            // 排队位次 0 —— 永远轮不到执行器
        res.write(frame(1, 'recognizing'));  // 然后进入识别阶段……
        // ……此后静默：不再有任何字节（上游卡在 Sakura 调用时的真实形状）
      });
    });
    await new Promise((r) => srv.listen(${port}, '127.0.0.1', r));
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    let out = { code: null, frames: [], stages: [] };
    try {
      await translateImage(png, { seq: 7, timeoutMs: ${BUDGET_MS} });
      out.code = 'NO_ERROR';
    } catch (err) {
      out.code = err.code || 'unknown';
      out.frames = ((err.detail && err.detail.frames) || []).map((f) => ({ code: f.code, text: f.text }));
      out.message = String(err.message).slice(0, 160);
    }
    out.stages = recentStageLog(10).map((s) => (s && s.text) || s);
    srv.close();
    srv.closeAllConnections && srv.closeAllConnections();
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  `;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', js], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MIAO_ENGINE_PROTOCOL: 'real',
        MIAO_ENGINE_PORT: String(port),
        MIAO_ENGINE_TIMEOUT_MS: String(BUDGET_MS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out.trim());
  } catch (e) {
    return { __error: String(e.message).slice(0, 300), stderr: String(e.stderr || '').slice(0, 300) };
  }
}

// ------------------------------------------------------------------ 断言体

const itemOf = (task, seq) => (task?.items ?? []).find((i) => i.seq === seq);

async function runAll() {
  results.length = 0;

  // ---- 对照组：不注入卡死 ⇒ 全绿。用来证明下面的失败不是"恒红"（本条自身就是断言）----
  const control = await serviceRound({});
  const controlOk = control.task?.status === 'done'
    && (control.task?.items ?? []).every((i) => i.status === 'success');
  check('S7 对照组：不注入卡死时同参数下 3 张全部成功（下面的失败不是"恒红"）',
    controlOk,
    `status=${control.task?.status} items=${(control.task?.items ?? []).map((i) => i.status).join(',')}`);

  // ---- 注入卡死 ----
  const round = await serviceRound({ stallSeq: STALL_SEQ });
  const task = round.task;
  const stalled = itemOf(task, STALL_SEQ);
  const others = (task?.items ?? []).filter((i) => i.seq !== STALL_SEQ);

  // S1：卡死项**必须落到终态**（而不是永远挂在那里）
  check('S1 被卡死的那一张落到终态 `failed`（挂住 ≠ 永远进行中）',
    stalled?.status === 'failed',
    `seq=${STALL_SEQ} status=${stalled?.status} reason=${stalled?.reason} err=${String(stalled?.errorMessage || '').slice(0, 60)}`);

  // S2：等待时间**有上界**，且**不随重试叠乘** —— 本条是"静默不叠乘"的承重点
  const dur = Number(stalled?.durationMs ?? -1);
  check(`S2 卡死项的等待时间有上界（≤ 预算×1.6 = ${Math.round(BUDGET_MS * 1.6)}ms，且**严格小于 2×预算 = ${2 * BUDGET_MS}ms**：没有变成"超时 × 重试次数"）`,
    dur > 0 && dur <= BUDGET_MS * 1.6 && dur < 2 * BUDGET_MS,
    `durationMs=${dur} / 预算=${BUDGET_MS} / 2×预算=${2 * BUDGET_MS}`);

  // S3：一张卡死不拖垮整批（其余页照常翻完）
  check('S3 同一批其余张照常成功（一个卡死页不拖垮整批）',
    others.length === N_IMAGES - 1 && others.every((i) => i.status === 'success'),
    `其余=${others.map((i) => `${i.seq}:${i.status}`).join(',')} 任务=${task?.status}`);

  // S4：**留痕** —— 每一次尝试失败都要有一行日志（否则"超时了"与"慢慢推理中"逐字节相同）
  const hasAttemptLine = /第 \d+\/\d+ 次尝试失败：ENGINE_TIMEOUT/.test(round.svcLog);
  check('S4 服务端日志里有一次尝试失败的**明确一行**（ENGINE_TIMEOUT + 第几次 + 已用时 ⇒ 不再是静默）',
    hasAttemptLine,
    (round.svcLog.match(/\[item [^\]]+\] 第 [^\n]*/g) || []).slice(0, 2).join(' ｜ ').slice(0, 220) || '(日志里没有这一行)');

  // S5：**进行中必须落盘** —— 快照要能回答"现在在跑哪一页"（U10② 现场就是回答不了）
  const diskSawTranslating = round.diskSeen.has('translating');
  check('S5 **磁盘**状态文件里出现过 `translating`（进行中的项不再"在磁盘上不存在"，`current` 才有意义）',
    diskSawTranslating,
    `磁盘出现过的 item 状态={${[...round.diskSeen].sort().join(',')}} · 任务文件数=${round.diskFiles}`);

  // S6：真协议下，超时**带走已收到的帧**（能区分"排不上队"与"没动静"）
  const evPort = await findFreePort(5500);
  const ev = evidenceProbe(evPort);
  const frames = (ev && ev.frames) || [];
  const stages = (ev && ev.stages) || [];
  const sawQueue = frames.some((f) => f.code === 3 && f.text === '0');
  const stageText = stages.join(' | ');
  check('S6 真协议超时时**带上已收到的帧**：错误里能读出 `排队位次 0`（= 引擎活着但拿不到执行器），阶段日志同样留痕',
    ev && ev.code === 'ENGINE_TIMEOUT' && sawQueue && stageText.includes('排队位次 0'),
    `code=${ev && ev.code} frames=${JSON.stringify(frames)} stages=${stageText.slice(0, 120)}${ev && ev.__error ? ` ERR=${ev.__error}` : ''}`);

  const map = {};
  for (const r of results) map[r.id] = r;
  return map;
}

// ------------------------------------------------------------------ 反证轮

const MUTATIONS = [
  {
    name: 'S2：去掉**单项总预算**（回到「超时 × 重试次数」的旧形状 —— 静默重新叠乘）',
    expect: [`S2 卡死项的等待时间有上界（≤ 预算×1.6 = ${Math.round(BUDGET_MS * 1.6)}ms，且**严格小于 2×预算 = ${2 * BUDGET_MS}ms**：没有变成"超时 × 重试次数"）`],
    edits: [{
      file: STORE_SRC,
      find: '      const remaining = deadline - Date.now();\n'
        + '      if (remaining <= 0) {\n'
        + '        lastErr = new EngineError(\'ENGINE_TIMEOUT\',\n'
        + '          `单项总预算 ${config.itemTimeoutMs}ms 已耗尽（第 ${attempt} 次尝试开始前）`);\n'
        + '        break;\n'
        + '      }',
      replace: '      const remaining = config.engineTimeoutMs; // refute：去掉单项预算（重试各自再等一个满额超时）',
    }],
  },
  {
    name: 'S5：去掉「进行中落盘」（`translating` 只改内存 ⇒ 磁盘又看不出在跑哪一页）',
    expect: ['S5 **磁盘**状态文件里出现过 `translating`（进行中的项不再"在磁盘上不存在"，`current` 才有意义）'],
    edits: [{
      file: STORE_SRC,
      find: '    // 磁盘状态必须能回答"现在在跑哪一页"，否则崩溃/挂死现场一律无法归因。\n'
        + '    await this._persist(task);',
      replace: '    // 磁盘状态必须能回答"现在在跑哪一页"，否则崩溃/挂死现场一律无法归因。\n'
        + '    // refute：去掉这一句',
    }],
  },
  {
    name: 'S6：让超时**不带走**已收到的字节（回到"只报一句超时了"，不可归因）',
    expect: ['S6 真协议超时时**带上已收到的帧**：错误里能读出 `排队位次 0`（= 引擎活着但拿不到执行器），阶段日志同样留痕'],
    edits: [{
      file: CLIENT_SRC,
      find: '      err.partialBody = received > 0 ? Buffer.concat(chunks) : null;',
      replace: '      err.partialBody = null; // refute：超时不带走已收到的字节',
    }],
  },
];

const readBytes = (f) => { try { return fs.readFileSync(f); } catch { return null; } };

const main = async () => {
  console.log(`U10② 引擎卡死：「静默有上界 + 留痕」取证${REFUTE ? ' · 反证轮' : ''}`);

  if (!REFUTE) {
    await runAll();
    const { fail } = printResults('U10② 卡死取证');
    const executed = results.length;
    if (executed !== DECLARED) console.log(`\n🔴 分母不符：声明 ${DECLARED} 条，实际执行 ${executed} 条 —— 视为失败`);
    process.exitCode = fail === 0 && executed === DECLARED ? 0 : 1;
    return;
  }

  await runAll();
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
      const txt = originals.get(e.file).toString('utf8');
      if (!txt.includes(e.find)) {
        console.log(`⚠ ${mut.name}\n    破坏锚点未找到（第 ${i + 1} 处，${path.relative(ROOT, e.file)}）—— 本条无法反证`);
        skipped += mut.expect.length;
        continue;
      }
      fs.writeFileSync(e.file, txt.replace(e.find, e.replace));
    }
    // 🔴 还原一律进 `finally`：破坏若让 `runAll()` 抛异常，写在 try 之后的还原就不会执行，
    //    源文件会永久留成被破坏状态（E4 / E8 上都踩到过这一条，见报告 §3-3）。
    let res = {};
    let roundErr = null;
    try {
      res = await runAll();
    } catch (err) {
      roundErr = err;
    } finally {
      for (const [f, snap] of originals) fs.writeFileSync(f, snap);
    }
    console.log(`🔴 ${mut.name}`);
    if (roundErr) console.log(`   ⚠ 本轮 runAll 抛异常（源文件已被破坏）：${String(roundErr.message).split('\n')[0]}`);
    for (const id of mut.expect) {
      total++;
      const isRed = (res[id] && res[id].ok === false) || (!res[id] && roundErr !== null);
      if (isRed) { red++; console.log(`  ✓ ${id.slice(0, 24)}… 按预期变红`); }
      else { falsePositives.push(id); console.log(`  ✗ ${id.slice(0, 24)}… 该红没红 ← 假阳性`); }
      if (!wasGreen[id]) console.log('     注：该条基线本就是红，无法据此判定断言有效性');
    }
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
