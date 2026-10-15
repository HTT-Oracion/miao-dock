#!/usr/bin/env node
/**
 * S5 · 契约增量验收（《03》§2.3 / §5.1 / §5.2 / §4.5）
 * =============================================================================
 * 验的是**新增的契约面**，共四件事：
 *   ① `/health` 的 `sidecar` 从 3 字段扩到 **9 字段**（§5.1，**向后兼容**）
 *   ② 新增 `ENGINE_NOT_READY(503)` 与既有 `UNAVAILABLE(503)` **严格区分**（§2.3 的「边界」）
 *   ③ 新增 `MODEL_DOWNLOAD_FAILED(503)`（模型不在盘上 ⇒ 引导重下，而不是引导重启）
 *   ④ 新增 `GET /engine/status`（§5.2，需鉴权、插件不用）
 *
 * ## 为什么另起一个脚本，不塞进 `selftest.mjs`
 * `selftest.mjs` 跑的是**任务/队列/落盘/安全**那套契约（mock 档 + 模拟引擎）。本脚本要的是
 * **按状态构造引擎**：`starting` / `prewarming` / `running` / 停了 —— 需要三个只做应答、
 * 不做翻译的"假引擎"夹具，以及一个**停着的**引擎。两者的夹具与心智模型都不同；
 * 混进 selftest 会把那个已经 159 条的底板变成"两个东西共用一套夹具"的模样。
 *
 * ## 关键取证（都不信"自报"）
 *   · **503 的错误码**：直接看响应体 `error.code`，而不是看文案。
 *   · **不建单、不分配序号**（§2.3）：拒绝前后各查一次 `/queue` 与 `/tasks`，两者必须**逐字节相同**。
 *     只断言"返回了 503"是不够的 —— 先建单再报错也满足它。
 *   · **`ENGINE_NOT_READY` 不是 `UNAVAILABLE` 的别名**：让引擎分别处于 `starting` 与 `prewarming`
 *     （两个不同的探测分支），两者都必须给同一个新码；而**引擎停着**时必须给旧码。
 *     三条一起看，才能确定这个码真的按"进程在不在"分流。
 *   · **`warmed` 不是 `state` 的复读**：实例 C（引擎 running、③ 停着）必须 `state=running`
 *     且 `warmed=false` —— 这正是《04》§9.4「卸载 ≠ 未就绪」在字段层面的可见性。
 *
 * 用法：
 *   node e2e/service/contract-delta-check.mjs            正向
 *   node e2e/service/contract-delta-check.mjs --refute   反证轮（**逃生开关**→ 指定断言必须变红）
 *
 * 约束：纯 Node、零第三方依赖；临时目录自建自清；不占 5180–5190（box-service 的段）。
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { encodePng } from '../../engine/src/png.mjs';
// F0：服务入口解析的唯一事实源（MIAO_SERVICE_IMPL=node|rust 切换靶子；本文件不再自己拼入口）
import { IMPL, SERVICE_ENTRY, spawnTarget } from './_service-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SELF = path.join(ROOT, 'e2e', 'service', 'contract-delta-check.mjs');
const MOCK_ENGINE = path.join(ROOT, 'engine', 'src', 'server.mjs');
const TOKEN = 'c'.repeat(64);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-contract-'));
const REFUTE = process.argv.includes('--refute');

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ------------------------------------------------------------------ 结果收集

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}
function matchById(list, code) {
  return list.find((r) => r.id === code || r.id.startsWith(`${code} `));
}
function printResults(title) {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n### ${title}`);
  for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.id}${r.detail ? `  ${r.detail}` : ''}`);
  console.log(`[RESULT] ${JSON.stringify({ results, pass, fail: results.length - pass })}`);
  console.log(`\n通过 ${pass} / 失败 ${results.length - pass}`);
  return { pass, fail: results.length - pass };
}

// ------------------------------------------------------------------ HTTP 小工具

function httpReq(port, method, pathname, { headers = {}, body = null, token } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (token) h['X-Box-Token'] = token;
    if (body) h['Content-Length'] = body.length;
    // agent:false：本脚本会短时间起停多个服务实例，复用 keep-alive 连接池会撞上服务端的空闲回收
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

function portOpen(port, timeoutMs = 250) {
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

async function findFreePort(start, { need = 1, avoid = [] } = {}) {
  for (let p = start; p < start + 400; p += 1) {
    if (avoid.includes(p)) continue;
    let ok = true;
    for (let i = 0; i < need; i += 1) if (await portOpen(p + i, 80)) { ok = false; break; }
    if (ok) return p;
  }
  throw new Error(`从 ${start} 起找不到 ${need} 个连续空闲端口`);
}

// ------------------------------------------------------------------ multipart 提交

function buildMultipart({ payload, images }) {
  const boundary = `----miao${Math.random().toString(16).slice(2)}`;
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

function pngBytes(w = 40, h = 60, seed = 1) {
  return encodePng(w, h, (x, y, put) => put((x * seed) % 256, (y * seed) % 256, (x + y) % 256));
}

async function submit(port, comicName, images = [{ filename: '001.png', contentType: 'image/png', data: pngBytes() }]) {
  const m = buildMultipart({ payload: { comicName, idempotencyKey: crypto.randomUUID() }, images });
  return httpReq(port, 'POST', '/api/v1/tasks', {
    token: TOKEN,
    headers: { 'Content-Type': `multipart/form-data; boundary=${m.boundary}` },
    body: m.body,
  });
}

// ------------------------------------------------------------------ 服务 / 引擎夹具

/** 起一个 box-service 实例并等它就绪行；返回 {child, port} */
function spawnService(env, tag) {
  const child = spawnTarget(SERVICE_ENTRY, env);
  const st = { child, tag, out: '', err: '', ready: null };
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
  if (!st.ready) throw new Error(`${st.tag} 未就绪：stdout=${st.out}\nstderr=${st.err}`);
  return st.ready;
}

/**
 * 杀**进程树**，不是只杀主进程。
 *
 * 🔴 rust 靶子的服务会派生子进程（引擎② sidecar、③ llama-server），Windows 上
 *    `child.kill()` 只结束主进程 ⇒ 孙进程全成孤儿。实测（D-202 第四节）：攒了 12 个
 *    llama-server（每个 3.5 GB 权重）把机器卡死、别的应用跟着崩。
 *    `taskkill /T /F` 连子树一起收；主进程已退出时它返回非 0，那不是失败。
 */
function killService(st) {
  if (!st || st.child.exitCode !== null) return;
  try {
    execFileSync('taskkill', ['/pid', String(st.child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* 进程已退出 */
  }
  try { st.child.kill('SIGTERM'); } catch { /* ignore */ }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
}

/**
 * 假引擎 —— 只实现**就绪探测**要的那两件事，不实现翻译。
 * 三个闸门分别对应 §5.1 的三个状态：
 *   · 什么也不答（纯 TCP 在听）        → `starting`（uvicorn 启动中）
 *   · `POST /queue-size` 200、执行器端口无 → `prewarming`（L3 预热）
 *   · 再加一个监听在 port+1 上的哑 socket → `running`
 */
function fakeEngine({ answerQueue, executorPort }) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push(`${req.method} ${req.url}`);
      if (req.url === '/queue-size' && answerQueue) {
        const b = Buffer.from('0');
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': b.length });
        return res.end(b);
      }
      res.writeHead(404, { 'Content-Length': 0 });
      res.end();
    });
  });
  return { server, hits, executorPort };
}

/** 哑 socket 服务器（只为了让某个端口"在听"） */
function silentListener() {
  return net.createServer(() => { /* 收下连接、永不回应 */ });
}

// ------------------------------------------------------------------ 实例场景

/**
 * 每个场景 = 一个服务实例 + 一组断言。
 * 返回可复用的上下文（port / 引擎夹具），让断言写在调用处、读起来跟契约条文一一对应。
 */
async function withService(env, tag, fn, { timeoutMs = 15_000 } = {}) {
  const st = spawnService(env, tag);
  try {
    const info = await waitReady(st, timeoutMs);
    return await fn(info, st);
  } finally {
    killService(st);
    await sleep(120);
  }
}

// ------------------------------------------------------------------ 断言体

/** S5.1 / S5.5：`/health` 的 sidecar 契约面（9 键） */
function assertSidecarShape(sc, label) {
  const keys = ['state', 'port', 'engine', 'engineVersion', 'tier', 'model', 'accel', 'warmed', 'llm'];
  check(`S5.1 /health.sidecar 是契约 §5.1 的 **9 键**（${label}）`,
    sc && keys.every((k) => k in sc) && Object.keys(sc).length === keys.length,
    sc ? Object.keys(sc).join(',') : 'sidecar 缺失');
  check(`S5.1b sidecar.accel ∈ cuda|mps|cpu 且 state ∈ §5.1 枚举（${label}）`,
    ['cuda', 'mps', 'cpu'].includes(sc?.accel)
    && ['stopped', 'starting', 'downloading', 'prewarming', 'running', 'unloading', 'degraded', 'error'].includes(sc?.state),
    `accel=${sc?.accel} state=${sc?.state}`);
  check(`S5.1c sidecar.llm 是 {state, port} 形状（③ 可被单独停/启，§5.1）且 state 在 LLM 枚举内（${label}）`,
    sc?.llm && Object.keys(sc.llm).every((k) => ['state', 'port'].includes(k))
    && ['stopped', 'starting', 'running', 'unloading', 'error'].includes(sc.llm.state),
    JSON.stringify(sc?.llm));
}

/** S5.6 / S5.7：`/engine/status` 的形状与鉴权 */
async function assertEngineStatus(port, label, expectState) {
  // 无令牌 → 403（§5.2 明写"**不是**免鉴权例外"）
  const noToken = await httpReq(port, 'GET', '/api/v1/engine/status');
  check(`S5.6 /engine/status 无令牌 → 403 PERMISSION_DENIED（§5.2：不是免鉴权例外）（${label}）`,
    noToken.status === 403 && jsonOf(noToken)?.error?.code === 'PERMISSION_DENIED',
    `${noToken.status} ${jsonOf(noToken)?.error?.code}`);

  const res = await httpReq(port, 'GET', '/api/v1/engine/status', { token: TOKEN });
  const v = jsonOf(res);
  // S6 起多一个 `modelDownload`（「重新下载模型」的任务实况）⇒ 8 → 9 键。
  // 它同样属"Box 专用、不进插件契约"那一类（§5.2 与 `recentStageLog` 同性质）。
  // **D1 起 Rust 侧再多一个 `runtime`**（与 `GET /engine/runtime` 同一份 `runtime_view()`，
  // 见 `state.rs::engine_status_view`）⇒ **rust 靶子是 10 键**。Node 对照端没有这个键
  // （它没有 runtime_probe 实现），双靶期这是**已知契约差**（F5 摘除 Node 后 `runtime`
  // 就是契约面的一部分，届时只剩 10 键这一种形态）。
  // ⚠️ 两条都保持**精确等值**（不是"包含"）是刻意的：`tier` 少键那次事故就是它抓到的
  //    （见 `composeSidecar` 里 `currentTier()` 的注释）。改这条必须同时改这里的期望值。
  const topKeys = IMPL === 'rust'
    ? ['engine', 'llm', 'tier', 'accel', 'warmed', 'config', 'models', 'runtime', 'recentStageLog', 'modelDownload']
    : ['engine', 'llm', 'tier', 'accel', 'warmed', 'config', 'models', 'recentStageLog', 'modelDownload'];
  check(`S5.7 /engine/status 带令牌 → 200 且顶层 ${topKeys.length} 键齐（§5.2 + S6 的 modelDownload${IMPL === 'rust' ? ' + D1 的 runtime' : ''}）（${label}）`,
    res.status === 200 && v && topKeys.every((k) => k in v) && Object.keys(v).length === topKeys.length,
    res.status === 200 ? Object.keys(v || {}).join(',') : `status=${res.status} body=${res.body.toString('utf8').slice(0, 200)}`);
  check(`S5.7b engine 是 {state, version, port, pid}；version 非空且 state=${expectState}（${label}）`,
    v?.engine && ['state', 'version', 'port', 'pid'].every((k) => k in v.engine)
    && typeof v.engine.version === 'string' && v.engine.version.length > 0
    && v.engine.state === expectState,
    JSON.stringify(v?.engine));
  // ver2.1 起多一个 `fromLang`（源语言基线，`null` = 逐任务下发）⇒ 6 → **7 键**。
  check(`S5.7c config 是 **camelCase** 的 7 键（fromLang / targetLang / detectionSize，不是 from_lang / target_lang / detection_size）（${label}）`,
    v?.config && ['translator', 'fromLang', 'targetLang', 'detector', 'detectionSize', 'ocr', 'inpainter'].every((k) => k in v.config)
    && !('from_lang' in v.config) && !('target_lang' in v.config) && !('detection_size' in v.config),
    JSON.stringify(v?.config));
  check(`S5.7d models 是 {visualReady, sakuraReady, lastVerifiedAt} 三键（§5.2）（${label}）`,
    v?.models && ['visualReady', 'sakuraReady', 'lastVerifiedAt'].every((k) => k in v.models)
    && typeof v.models.visualReady === 'boolean' && typeof v.models.sakuraReady === 'boolean',
    JSON.stringify(v?.models));
  check(`S5.7e recentStageLog 是数组（阶段日志**不进插件契约**，只满足 Box 诊断）（${label}）`,
    Array.isArray(v?.recentStageLog), JSON.stringify(v?.recentStageLog)?.slice(0, 80));
  check(`S5.7f llm 是 {state, model, port, pid}（③ 的归属方是本进程 ⇒ pid 我们有真值）（${label}）`,
    v?.llm && ['state', 'model', 'port', 'pid'].every((k) => k in v.llm),
    JSON.stringify(v?.llm));
  return v;
}

/**
 * 去掉快照里的 `updatedAt` 之后再比 —— 它是**读时取的 now**，不是队列/任务状态。
 *
 * 🔴 为什么非去掉不可：`/queue` 与 `/tasks` 两侧实现都在**构造快照的那一刻**取 `now`
 *    （Node `store.mjs` 的 `queueSnapshot()` / `taskListSnapshot()`；Rust `store.rs` 的同名视图）。
 *    于是"两次读取逐字节相同"实际断言的是**"这两次读取落在同一秒内"** —— 一个系统既未承诺、
 *    也不可能承诺的性质。它的失败形态是**偶发红**：实测 rust 靶子 6 次里红 4 次，node 靶子
 *    3 次全绿（差别只是两次读取之间有没有跨过秒边界，与实现无关）。
 *
 *    偶发红比恒定红更坏：它会让人去改一段本来就对的代码，或者干脆把这条断言注释掉。
 *    本断言真正要咬的是「被拒之后**没有建单、没有分配序号**」，那件事由 `queued` /
 *    `running` / `tasks` 三者完全覆盖，与这个时间戳无关。`updatedAt` 本身的**存在性**
 *    仍然断言（见 `check` 的条件），所以不会因此丢掉字段覆盖。
 */
function withoutReadClock(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const { updatedAt, ...rest } = snapshot;
  return rest;
}

/** S5.2~S5.4：引擎在准备中 ⇒ `ENGINE_NOT_READY`，且**不建单、不分配序号** */
async function assertNotReady(port, label, expectRawState) {
  const before = {
    queue: jsonOf(await httpReq(port, 'GET', '/api/v1/queue', { token: TOKEN })),
    tasks: jsonOf(await httpReq(port, 'GET', '/api/v1/tasks', { token: TOKEN })),
  };
  const res = await submit(port, `S5 未就绪（${label}）`);
  const body = jsonOf(res);
  check(`S5.2 引擎 ${expectRawState} 时提交 → 503 **ENGINE_NOT_READY**（不是 UNAVAILABLE）（${label}）`,
    res.status === 503 && body?.error?.code === 'ENGINE_NOT_READY',
    `${res.status} ${body?.error?.code}`);
  check(`S5.2b details.sidecar.state=${expectRawState}（把"哪一态"带出来，面板才好写「准备中」的细分文案）（${label}）`,
    body?.error?.details?.sidecar?.state === expectRawState,
    JSON.stringify(body?.error?.details));
  const after = {
    queue: jsonOf(await httpReq(port, 'GET', '/api/v1/queue', { token: TOKEN })),
    tasks: jsonOf(await httpReq(port, 'GET', '/api/v1/tasks', { token: TOKEN })),
  };
  // 只断言"返回了 503"是不够的：**先建单再报错**也满足它。必须证明队列与任务清单没动过。
  // ⚠️ 比 `/queue` 与 `/tasks` 时都剔除 `updatedAt`（读时时间戳，见 `withoutReadClock`），
  //    但**仍要求两边都带这个字段**（有值即可，不比它等不等）。
  const qBefore = withoutReadClock(before.queue);
  const qAfter = withoutReadClock(after.queue);
  const tBefore = withoutReadClock(before.tasks);
  const tAfter = withoutReadClock(after.tasks);
  const hasClock = typeof before.queue?.updatedAt === 'string' && before.queue.updatedAt.length > 0
    && typeof before.tasks?.updatedAt === 'string' && before.tasks.updatedAt.length > 0;
  check(`S5.3 被拒后**不建单、不分配序号**（§2.3）：/queue 与 /tasks（均除读时 updatedAt）与拒绝前逐字节相同（${label}）`,
    JSON.stringify(qBefore) === JSON.stringify(qAfter)
    && JSON.stringify(tBefore) === JSON.stringify(tAfter)
    && hasClock,
    `queue(-updatedAt) ${JSON.stringify(qBefore)} → ${JSON.stringify(qAfter)}；`
    + `tasks(-updatedAt) ${JSON.stringify(tBefore)} → ${JSON.stringify(tAfter)}`);
  return { res, body };
}

/** S5.4：引擎**进程不在** ⇒ 旧码 `UNAVAILABLE`（与 above 同一位置、不同原因，必须可区分） */
async function assertUnavailable(port, label) {
  const res = await submit(port, `S5 不可用（${label}）`);
  const body = jsonOf(res);
  check(`S5.4 引擎**进程不在**时提交 → 503 UNAVAILABLE（§2.3「进程不在」那一支；与 ENGINE_NOT_READY 严格分开）（${label}）`,
    res.status === 503 && body?.error?.code === 'UNAVAILABLE',
    `${res.status} ${body?.error?.code}`);
  return body;
}

// ------------------------------------------------------------------ 正向

/** 每个实例的公共 env：不占 5180–5190 段、状态与落盘都在临时目录 */
function baseEnv(port, extra = {}) {
  return {
    MIAO_PORT: String(port),
    MIAO_ROOT: path.join(TMP, `root-${port}`),
    MIAO_STATE_DIR: path.join(TMP, `state-${port}`),
    MIAO_TOKEN: TOKEN,
    // 本脚本只关心契约面（错误码 / 字段），**不验 ③ 的生命周期**（那有自己的脚本）。
    // 默认退出预拉起，避免多个实例互抢 8080 —— 需要 `warmed=true` 的那个实例单独打开它。
    MIAO_NO_LLM_AUTOSTART: '1',
    ...extra,
  };
}

/** 连续 n 个空闲端口（引擎 / 执行器 / 服务三者**必须互不相同**，否则服务起不来） */
async function freePorts(start, n = 1) {
  const p = await findFreePort(start, { need: n });
  return Array.from({ length: n }, (_, i) => p + i);
}

async function runPositive() {
  // ---------------------------------------------------------------- A · real + uvicorn 还没接客 → starting
  {
    const [engPort, svcPort] = await freePorts(5600, 2);
    const eng = fakeEngine({ answerQueue: false });
    await listen(eng.server, engPort);
    try {
      await withService(
        baseEnv(svcPort, { MIAO_ENGINE_PROTOCOL: 'real', MIAO_ENGINE_PORT: String(engPort), MIAO_ENGINE_PROBE_MS: '300' }),
        `service-A-${svcPort}`,
        async (info) => {
          const h = jsonOf(await httpReq(info.port, 'GET', '/api/v1/health'));
          check('S5.0a 引擎 starting 时 /health.status=starting（§5.1 顶层枚举）（A）',
            h?.status === 'starting', h?.status);
          assertSidecarShape(h?.sidecar, 'A');
          check('S5.0b 引擎 starting 时 sidecar.engineVersion 仍非空（安装事实 ≠ 进程事实）（A）',
            typeof h?.sidecar?.engineVersion === 'string' && h.sidecar.engineVersion.length > 0,
            String(h?.sidecar?.engineVersion));
          await assertNotReady(info.port, 'A', 'starting');
          await assertEngineStatus(info.port, 'A', 'starting');
        },
      );
    } finally { eng.server.close(); }
  }

  // ---------------------------------------------------------------- B · real + HTTP 已接客、执行器未起 → prewarming
  {
    const [engPort, execPort, svcPort] = await freePorts(5620, 3);
    const eng = fakeEngine({ answerQueue: true, executorPort: execPort });
    await listen(eng.server, engPort);
    try {
      await withService(
        baseEnv(svcPort, { MIAO_ENGINE_PROTOCOL: 'real', MIAO_ENGINE_PORT: String(engPort), MIAO_ENGINE_PROBE_MS: '300' }),
        `service-B-${svcPort}`,
        async (info) => {
          const h = jsonOf(await httpReq(info.port, 'GET', '/api/v1/health'));
          check('S5.0c 执行器端口未监听 → sidecar.state=**prewarming**（= L3 预热，与 starting 分开）（B）',
            h?.sidecar?.state === 'prewarming', h?.sidecar?.state);
          await assertNotReady(info.port, 'B', 'prewarming');
        },
      );
    } finally { eng.server.close(); }
  }

  // ---------------------------------------------------------------- C · real + 引擎 running、③ 停着 → warmed=false（§9.4）
  {
    const [engPort, execPort, svcPort] = await freePorts(5640, 3);
    const eng = fakeEngine({ answerQueue: true, executorPort: execPort });
    const ex = silentListener();
    await listen(eng.server, engPort);
    await listen(ex, execPort);
    try {
      await withService(
        baseEnv(svcPort, { MIAO_ENGINE_PROTOCOL: 'real', MIAO_ENGINE_PORT: String(engPort), MIAO_ENGINE_PROBE_MS: '300' }),
        `service-C-${svcPort}`,
        async (info) => {
          const h = jsonOf(await httpReq(info.port, 'GET', '/api/v1/health'));
          const sc = h?.sidecar;
          check('S5.0d 引擎三重就绪 → sidecar.state=running、/health.status=ok（C）',
            sc?.state === 'running' && h?.status === 'ok', `${sc?.state} ${h?.status}`);
          // 🔴 本脚本最要紧的一条：《04》§9.4「卸载 ≠ 未就绪」。
          //    state 仍是 running（进程在），但 warmed 转 false ⇒ 客户端据此提示「首张稍慢」。
          check('S5.9 ③ 停着时 state=running 而 warmed=**false** —— 「卸载 ≠ 未就绪」（§9.4）在字段层面可见（C）',
            sc?.state === 'running' && sc?.warmed === false && sc?.llm?.state === 'stopped',
            `state=${sc?.state} warmed=${sc?.warmed} llm=${JSON.stringify(sc?.llm)}`);
          check('S5.9b ③ 停着时 llm.port=null（"端口为 null"的口径由 LlmSupervisor 统一给出，不在这里二次加工）（C）',
            sc?.llm?.port === null, JSON.stringify(sc?.llm));
          check('S5.9c engine running（≠stopped）时 tier/model 有值：tier=tiny、model=Sakura 权重名（C）',
            sc?.tier === 'tiny' && typeof sc?.model === 'string' && /sakura/i.test(sc.model),
            `tier=${sc?.tier} model=${sc?.model}`);

          const v = await assertEngineStatus(info.port, 'C', 'running');
          check('S5.7g engine.pid 恒为 null —— 引擎② 由 Rust 的 ServiceManager spawn，box-service 是它的**兄弟进程**，拿不到它的 pid（不编、也不去猜端口占用者）（C）',
            v?.engine?.pid === null, String(v?.engine?.pid));
          check('S5.7h /engine/status 的 warmed 与 /health 同源（同一处合成，不会两处各说一套）（C）',
            v?.warmed === sc?.warmed, `${v?.warmed} vs ${sc?.warmed}`);

          // running ⇒ 提交必须**被接受**（201）。它证明"可翻译"这条判定确实按状态走，
          // 而不是所有请求都撞在同一个 503 上（否则 S5.2 那几条就毫无信息量）。
          const ok = await submit(info.port, 'S5 可翻译（C）');
          check('S5.5 引擎 running 时提交 → **201**（不是 503）：说明状态分流真的按 sidecar.state 走（C）',
            ok.status === 201, `${ok.status} ${jsonOf(ok)?.error?.code ?? ''}`);
          const taskId = jsonOf(ok)?.taskId;
          if (taskId) {
            await httpReq(info.port, 'POST', `/api/v1/tasks/${taskId}/cancel`, { token: TOKEN });
          }
        },
      );
    } finally { eng.server.close(); ex.close(); }
  }

  // ---------------------------------------------------------------- D · real + 指定了 GPU 却在 CPU 上 → degraded（§7.4-3）
  {
    const [engPort, execPort, svcPort] = await freePorts(5660, 3);
    const eng = fakeEngine({ answerQueue: true, executorPort: execPort });
    const ex = silentListener();
    await listen(eng.server, engPort);
    await listen(ex, execPort);
    try {
      await withService(
        baseEnv(svcPort, {
          MIAO_ENGINE_PROTOCOL: 'real', MIAO_ENGINE_PORT: String(engPort), MIAO_ENGINE_PROBE_MS: '300',
          // §7.4-3：指定 GPU 后端却失败 ⇒ 回退 CPU 并**以 degraded 上报，不静默**。
          // 这里直接注入"已回退"的结果（Rust 侧检测到 GPU 启动失败后会这样重拉），验的是上报。
          MIAO_ENGINE_USE_GPU: '0',
        }),
        `service-D-${svcPort}`,
        async (info) => {
          const h = jsonOf(await httpReq(info.port, 'GET', '/api/v1/health'));
          const sc = h?.sidecar;
          check('S5.10 硬件推荐 GPU 而实际未启用 → sidecar.state=**degraded**、accel=**cpu**（§7.4-3「不静默」）（D）',
            sc?.state === 'degraded' && sc?.accel === 'cpu', `state=${sc?.state} accel=${sc?.accel}`);
          check('S5.10b degraded **仍可翻译**：提交 → 201（降级是"慢"，不是"不可用"）（D）',
            (await submit(info.port, 'S5 降级仍可译（D）')).status === 201, sc?.state);
          const v = await assertEngineStatus(info.port, 'D', 'degraded');
          check('S5.10c 诊断视图与 /health 报同一个 accel（对账用途，两处不一致就等于没有对账）（D）',
            v?.accel === sc?.accel, `${v?.accel} vs ${sc?.accel}`);
        },
      );
    } finally { eng.server.close(); ex.close(); }
  }

  // ---------------------------------------------------------------- E · real + 引擎不在 + 模型齐 → UNAVAILABLE
  // ---------------------------------------------------------------- F · real + 引擎不在 + 模型缺 → MODEL_DOWNLOAD_FAILED
  {
    // 清单夹具：两个 set（visual / llm），文件故意做得极小（本脚本只验"在位且大小一致"这一判据）
    const modelRoot = path.join(TMP, 'models');
    fs.mkdirSync(path.join(modelRoot, 'v'), { recursive: true });
    fs.mkdirSync(path.join(modelRoot, 'l'), { recursive: true });
    const vFile = path.join(modelRoot, 'v', 'detect.bin');
    const lFile = path.join(modelRoot, 'l', 'sakura.bin');
    fs.writeFileSync(vFile, Buffer.alloc(16, 7));
    fs.writeFileSync(lFile, Buffer.alloc(32, 9));
    const manifest = {
      manifestVersion: 1,
      engineCommit: 'f'.repeat(40),
      sets: { visual: { files: ['v1'] }, llm: { files: ['l1'] } },
      files: [
        { id: 'v1', set: 'visual', dest: 'v/detect.bin', sha256: 'x', sizeBytes: 16, url: 'https://example.invalid/v' },
        { id: 'l1', set: 'llm', dest: 'l/sakura.bin', sha256: 'y', sizeBytes: 32, url: 'https://example.invalid/l' },
      ],
    };
    const manifestPath = path.join(TMP, 'fixture.manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const common = {
      MIAO_ENGINE_PROTOCOL: 'real',
      MIAO_SIDECAR_DOWN: '1', // 引擎"进程不在"（`probeEngine` 直接返回 stopped）
      MIAO_MODEL_ROOT: modelRoot,
      MIAO_MODEL_MANIFEST: manifestPath,
    };

    // E：文件都在 ⇒ 模型就绪 ⇒ 该报的是"进程不在"
    const [peSvc] = await freePorts(5680, 1);
    await withService(baseEnv(peSvc, common), `service-E-${peSvc}`, async (info) => {
      const h = jsonOf(await httpReq(info.port, 'GET', '/api/v1/health'));
      check('S5.11 引擎不在时 sidecar.state=stopped 且 tier/model=null（引擎都没跑，不报"跑着的是 tiny"）（E）',
        h?.sidecar?.state === 'stopped' && h?.sidecar?.tier === null && h?.sidecar?.model === null,
        JSON.stringify(h?.sidecar));
      await assertUnavailable(info.port, 'E');
      const v = await assertEngineStatus(info.port, 'E', 'stopped');
      check('S5.11b 模型齐时 models.visualReady 与 sakuraReady 均为 true（判据=在位且大小与清单一致）（E）',
        v?.models?.visualReady === true && v?.models?.sakuraReady === true, JSON.stringify(v?.models));
    });

    // F：把权重删掉 ⇒ 报 `MODEL_DOWNLOAD_FAILED`（引导重下），而不是"引导重启"
    fs.rmSync(lFile);
    const [pfSvc] = await freePorts(5700, 1);
    await withService(baseEnv(pfSvc, common), `service-F-${pfSvc}`, async (info) => {
      const res = await submit(info.port, 'S5 模型缺（F）');
      const body = jsonOf(res);
      check('S5.12 引擎不在 **且** Sakura 权重不在盘上 → 503 MODEL_DOWNLOAD_FAILED（引导"重新下载模型"，而不是"启动 Box"）（F）',
        res.status === 503 && body?.error?.code === 'MODEL_DOWNLOAD_FAILED',
        `${res.status} ${body?.error?.code}`);
      check('S5.12b details.models 把"哪一半缺"带出来（供 Box 显示重下入口）（F）',
        body?.error?.details?.models?.sakuraReady === false
        && body?.error?.details?.models?.visualReady === true,
        JSON.stringify(body?.error?.details?.models));
      const v = await assertEngineStatus(info.port, 'F', 'stopped');
      check('S5.12c 诊断视图的 models 与提交时的判定同源（同一处算出来，不会两处各说一套）（F）',
        v?.models?.sakuraReady === false, JSON.stringify(v?.models));
    });

    // G：mock 档**不做**模型诊断 —— 模型是真引擎的概念，替身没有模型需求。
    //    不加这道门槛，任何没装过 runtimes/ 的机器跑 mock 档都会得到 MODEL_DOWNLOAD_FAILED。
    const [pgSvc, pgEng] = await freePorts(5720, 2);
    await withService(baseEnv(pgSvc, {
      MIAO_ENGINE_PROTOCOL: 'mock',
      MIAO_ENGINE_PORT: String(pgEng),
      MIAO_SIDECAR_DOWN: '1',
      MIAO_MODEL_ROOT: modelRoot,
      MIAO_MODEL_MANIFEST: manifestPath,
    }), `service-G-${pgSvc}`, async (info) => {
      const body = await assertUnavailable(info.port, 'G（mock 档）');
      check('S5.13 mock 档即使"模型缺"也报 UNAVAILABLE —— 模型诊断只在 real 档生效（替身没有模型需求）（G）',
        body?.error?.code === 'UNAVAILABLE', body?.error?.code);
    });
  }

  // ---------------------------------------------------------------- H · mock 档 + ③ 在跑 → warmed=true
  {
    const [engPort, svcPort, llmPort] = await freePorts(5740, 3);
    const eng = spawn(process.execPath, [MOCK_ENGINE], {
      env: { ...process.env, MIAO_ENGINE_PORT: String(engPort), MIAO_ENGINE_ITEM_MS: '20' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let engOut = '';
    eng.stdout.on('data', (d) => { engOut += d.toString(); });
    eng.stderr.on('data', (d) => { engOut += d.toString(); });
    for (let i = 0; i < 120 && !/MIAO_ENGINE_READY/.test(engOut); i += 1) await sleep(50);
    try {
      await withService(
        baseEnv(svcPort, {
          MIAO_ENGINE_PROTOCOL: 'mock',
          MIAO_ENGINE_PORT: String(engPort),
          MIAO_ENGINE_PROBE_MS: '800',
          MIAO_LLM_PORT: String(llmPort),
          MIAO_NO_LLM_AUTOSTART: '0', // 本实例要的就是"③ 在跑"那一半
        }),
        `service-H-${svcPort}`,
        async (info) => {
          // ③ 是被服务**预拉起**的，等它就绪（mock 替身秒级）
          let sc = null;
          for (let i = 0; i < 60; i += 1) {
            const h = jsonOf(await httpReq(info.port, 'GET', '/api/v1/health'));
            sc = h?.sidecar;
            if (sc?.llm?.state === 'running') break;
            await sleep(150);
          }
          check('S5.14 ③ 在跑时 warmed=true（与实例 C 的 warmed=false 成对：这个字段确实在表达"要不要等"）（H）',
            sc?.warmed === true && sc?.llm?.state === 'running',
            `warmed=${sc?.warmed} llm=${JSON.stringify(sc?.llm)}`);
          check('S5.14b llm.port = ③ 实际监听端口（与 MIAO_LLM_PORT 一致）（H）',
            sc?.llm?.port === llmPort, `${sc?.llm?.port} vs ${llmPort}`);
          const v = await assertEngineStatus(info.port, 'H', 'running');
          check('S5.14c mock 档 engine.version=`mock`（起的是替身就老实说）（H）',
            v?.engine?.version === 'mock', String(v?.engine?.version));
          check('S5.14d llm.pid 是**真 pid**（③ 归 box-service 所有，它有真值；对照 S5.7g 的 engine.pid=null）（H）',
            Number.isInteger(v?.llm?.pid) && v.llm.pid > 0, String(v?.llm?.pid));
          check('S5.14e mock 档 recentStageLog 为空数组 —— 是**如实的空**（ver1.0 自定义协议是单包响应，没有阶段帧），不是"没实现"（H）',
            Array.isArray(v?.recentStageLog) && v.recentStageLog.length === 0,
            JSON.stringify(v?.recentStageLog));
        },
      );
    } finally {
      try { eng.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
}

// ------------------------------------------------------------------ 反证轮

/**
 * 逃生开关 → 期望变红的断言。
 *
 * 为什么用开关而不是改源码：这四条破坏全都"退回上一个版本的行为"（新码退回旧码、
 * 9 键退回 3 键、要鉴权退回不要、真值退回常数）。用 env 表达比在源码里 find/replace
 * 更不容易把锚点写错（锚点写错的表现是"没变红"，而真相是"破坏没生效" —— 分不清）。
 * 开关定义集中在 `config.mjs` 的 `contractRefute`，一处可 grep 全部。
 */
const SWITCHES = [
  {
    name: 'ENGINE_NOT_READY 退回 UNAVAILABLE（§2.3 的边界消失 ⇒「准备中」与「不可用」不可分）',
    env: { MIAO_NOT_READY_AS_UNAVAILABLE: '1' },
    // 只该打红"错误码"那一条：`details.sidecar.state` 仍会如实带出 `starting`
    //（它是从探测结果抄的，与用哪个码上报无关）—— 这正是"两条断言各自咬住不同事实"的证据。
    expectRed: ['S5.2'],
  },
  {
    name: '/health 的 sidecar 退回 ver1.0 的 3 字段（§5.1 的扩展面消失）',
    env: { MIAO_SIDECAR_LEGACY3: '1' },
    // 3 键一退，凡是读新增字段的断言全红：形状、accel 枚举、llm 形状、warmed、llm.port、tier/model
    expectRed: ['S5.1', 'S5.1b', 'S5.1c', 'S5.9', 'S5.9b', 'S5.9c'],
  },
  {
    name: '/engine/status 免除鉴权（§5.2「不是免鉴权例外」被破坏）',
    env: { MIAO_ENGINE_STATUS_OPEN: '1' },
    expectRed: ['S5.6'],
  },
  {
    name: 'warmed 恒 true（§9.4「卸载 ≠ 未就绪」在字段层面不可见）',
    env: { MIAO_WARMED_ALWAYS: '1' },
    expectRed: ['S5.9'],
  },
];
const EXPECTED_SWITCHES = 4; // 分母写死

async function runOnePassForRefute() {
  // 反证轮只需要 A/B/C 三个实例：它们覆盖了四条开关能咬到的全部断言。
  // 少起 4 个实例 = 反证轮快一倍，且不会因为无关实例的偶发 flake 污染结论。
  const [engPortA, svcPortA] = await freePorts(5600, 2);
  const engA = fakeEngine({ answerQueue: false });
  await listen(engA.server, engPortA);
  try {
    await withService(baseEnv(svcPortA, { MIAO_ENGINE_PROTOCOL: 'real', MIAO_ENGINE_PORT: String(engPortA), MIAO_ENGINE_PROBE_MS: '300' }),
      `refute-A-${svcPortA}`, async (info) => {
        const h = jsonOf(await httpReq(info.port, 'GET', '/api/v1/health'));
        assertSidecarShape(h?.sidecar, 'refute-A');
        await assertNotReady(info.port, 'refute-A', 'starting');
        await assertEngineStatus(info.port, 'refute-A', 'starting');
      });
  } finally { engA.server.close(); }

  const [engPortC, execPortC, svcPortC] = await freePorts(5640, 3);
  const engC = fakeEngine({ answerQueue: true, executorPort: execPortC });
  const exC = silentListener();
  await listen(engC.server, engPortC);
  await listen(exC, execPortC);
  try {
    await withService(baseEnv(svcPortC, { MIAO_ENGINE_PROTOCOL: 'real', MIAO_ENGINE_PORT: String(engPortC), MIAO_ENGINE_PROBE_MS: '300' }),
      `refute-C-${svcPortC}`, async (info) => {
        const h = jsonOf(await httpReq(info.port, 'GET', '/api/v1/health'));
        const sc = h?.sidecar;
        check('S5.9 ③ 停着时 state=running 而 warmed=false（§9.4）', sc?.state === 'running' && sc?.warmed === false, `warmed=${sc?.warmed}`);
        check('S5.9b ③ 停着时 llm.port=null', sc?.llm?.port === null, JSON.stringify(sc?.llm));
        check('S5.9c engine running 时 tier/model 有值', sc?.tier === 'tiny' && typeof sc?.model === 'string', `tier=${sc?.tier}`);
        await assertEngineStatus(info.port, 'refute-C', 'running');
      });
  } finally { engC.server.close(); exC.close(); }
}

async function runRefute() {
  console.log('S5 契约增量 · 反证轮');
  console.log(`逃生开关 → 指定断言必须变红（应执行 ${EXPECTED_SWITCHES} 条）\n`);
  let asExpected = 0;
  const problems = [];

  for (const sw of SWITCHES) {
    // 每个开关独立跑一次完整判定：进程内 env 无法回滚（`config.mjs` 在模块顶层读 env），
    // 所以**另起子进程**，把开关通过 env 传进去。子进程用 `--refute-child` 区分入口，
    // 不复用父进程的 `--refute`（否则它会自己也去开反证轮，递归下去）。
    const child = spawn(process.execPath, [SELF, '--refute-child'],
      { env: { ...process.env, ...sw.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stdout += d.toString(); });
    await new Promise((resolve) => child.once('exit', resolve));

    const line = stdout.split('\n').find((l) => l.startsWith('[RESULT] '));
    if (!line) {
      problems.push(`${sw.name}：子进程未产出结果行（stdout 尾部：${stdout.slice(-300)}）`);
      console.log(`⚠ ${sw.name}\n    子进程没有结果行`);
      continue;
    }
    const parsed = JSON.parse(line.slice('[RESULT] '.length));
    const redIds = parsed.results.filter((r) => !r.ok).map((r) => r.id);
    console.log(`🔴 ${sw.name}`);
    const missed = [];
    for (const code of sw.expectRed) {
      const hit = matchById(parsed.results, code);
      const red = hit && hit.ok === false;
      console.log(`   ${red ? '✓' : '✗'} ${code} ${red ? '按预期变红' : `**没有变红**（${hit ? hit.detail : '缺该条'}）`}`);
      if (!red) missed.push(code);
    }
    // 「只红这些」：多红说明这个开关顺带打坏了别的东西，结论就不能归给这一条机制。
    const extra = redIds.filter((id) => !sw.expectRed.some((c) => id === c || id.startsWith(`${c} `)));
    if (extra.length) {
      console.log(`   ⚠ 额外变红（本开关不该影响）：${extra.join(' | ')}`);
      problems.push(`${sw.name}：额外变红 ${extra.length} 条`);
    }
    if (missed.length === 0) asExpected += 1;
    else problems.push(`${sw.name}：${missed.join(',')} 未变红`);
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`反证：${asExpected} / ${EXPECTED_SWITCHES} 条按预期变红（应执行 ${EXPECTED_SWITCHES}）`);
  if (asExpected !== EXPECTED_SWITCHES) {
    console.log('\n下面是未达预期的条目：');
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exitCode = 1;
  } else if (problems.length) {
    console.log('\n（有附注：）');
    for (const p of problems) console.log(`  ⚠ ${p}`);
  }
}

// ================================================================ 入口

try {
  if (REFUTE && !process.argv.includes('--refute-child')) {
    await runRefute();
  } else if (process.argv.includes('--refute-child')) {
    // 子进程：带着某个逃生开关跑一遍判定，只吐结果行
    await runOnePassForRefute();
    printResults('反证子进程（带逃生开关）');
  } else {
    await runPositive();
    const { fail } = printResults('汇总（S5 · 契约增量：9 键 sidecar / ENGINE_NOT_READY / MODEL_DOWNLOAD_FAILED / /engine/status）');
    process.exitCode = fail === 0 ? 0 : 1;
  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}
