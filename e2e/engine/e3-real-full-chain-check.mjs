#!/usr/bin/env node
/**
 * E3 全链路实测（真引擎）—— 《04》§14.2 的 **E3**。
 *
 * 判据原文：
 *   提交 31 张 → **一个 Task 两个 Batch** → 逐张翻译 → 落盘 → **SSE 进度与落盘一致**
 *
 * 与 D 组（`e2e/e2e.mjs`）的分工，别混为一谈：
 *   D 组  = **模拟引擎**（替身协议、合成 PNG），考「服务契约在真实组合场景下的行为」—— 秒级、进常规门
 *   本脚本 = **真引擎 + 真模型 + 真 Sakura + 真漫画图**，考「这条链在真货上跑得通」—— 分钟级、手动跑
 *
 * 🔴 为什么必须单独一份而不是给 `e2e.mjs` 加个 `--real`：D 组是**已验证的回归基线**，
 *    往它里面塞一套「换掉引擎、换掉素材、换掉时效口径」的分支，等于让基线同时承担两种语义 ——
 *    那时任何一条变红，都先要花时间回答「红的是 real 分支还是 mock 分支」。
 *    共享的是**请求形状**（multipart / 端点 / 头），那是契约，两边本来就该一样。
 *
 * ⚠️ **不进常规门**：要几 GB 模型、分钟级耗时、真实 GPU。按需手动跑，同 `llm-real-timing.mjs`。
 *
 * 用法：
 *   node e2e/engine/e3-real-full-chain-check.mjs
 *   node e2e/engine/e3-real-full-chain-check.mjs --out <dir>   指定产物目录
 *   node e2e/engine/e3-real-full-chain-check.mjs --keep        跑完不杀进程
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RT = path.join(ROOT, 'runtimes', 'manga-translator');
// Windows 是 venv/Scripts/python.exe，POSIX 是 venv/bin/python
const VENV_PY = process.platform === 'win32'
  ? path.join(RT, 'venv', 'Scripts', 'python.exe')
  : path.join(RT, 'venv', 'bin', 'python');
const SAKURA_GGUF = path.join(RT, 'models', 'sakura', 'sakura-1.5b-qwen2.5-v1.0-fp16.gguf');
const TEST_IMAGE = path.join(ROOT, 'test-manga', 'test_0.webp');

const KEEP = process.argv.includes('--keep');
const outIdx = process.argv.indexOf('--out');

// 全链路的落盘根与 state 必须与用户真实目录隔离 —— 这个脚本会删自己那一片。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-e3-real-'));
const ROOT_DIR = path.join(TMP, 'root');
const STATE_DIR = path.join(TMP, 'state');
const OUT = outIdx > -1 ? path.resolve(process.argv[outIdx + 1]) : path.join(ROOT, '.tmp', 'engine-test', 'e3-real');

const ENGINE_PORT = 8000;
const EXECUTOR_PORT = ENGINE_PORT + 1;
const LLAMA_PORT = 8080;
const SERVICE_PORT = 5199; // 避开 5180–5190（真实 box-service 的水位段）

/**
 * 单张耗时预算。
 *
 * 🔴 与 D-0.8 同一条纪律：**不写死秒数**。E2 实测单张 12.6 s（21 个文本块逐句过 Sakura），
 *    31 张 ≈ 6.5 min。这里取 60 s/张 作**上限**（真机抖动、热降频、首个文本块等），
 *    而不是"期望值"—— 它只用来兜住"卡死"，不用来判性能。
 */
const ITEM_BUDGET_MS = Number.parseInt(process.env.MIAO_E3_ITEM_MS || '60000', 10);
const BATCH_LIMIT = 20;
const TOTAL_IMAGES = 31;
const TASK_TIMEOUT_MS = TOTAL_IMAGES * ITEM_BUDGET_MS + 120_000;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const pad3 = (n) => String(n).padStart(3, '0');
const log = (m) => console.log(`[e3-real] ${m}`);

/** 任务终态（与 D 组 / store 同一口径） */
const TERMINAL = ['done', 'partial_failed', 'failed', 'canceled'];

// ------------------------------------------------------------------ 断言账本
// 分母**写死**：跑完必须 executed === DECLARED，否则视为没跑完（禁止"跳过即通过"）。
const DECLARED = 8;
const results = [];
const check = (id, label, ok, detail) => {
  results.push({ id, label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
};

// ------------------------------------------------------------------ 进程

const procs = [];
function shutdown() {
  for (const p of procs) {
    if (p && p.exitCode === null) { try { p.kill('SIGTERM'); } catch { /* ignore */ } }
  }
}
process.on('SIGINT', () => { shutdown(); process.exit(130); });
process.on('SIGTERM', () => { shutdown(); process.exit(143); });
process.on('exit', () => { if (!KEEP) shutdown(); });

function spawnLogged(cmd, argv, opts, tag) {
  const child = spawn(cmd, argv, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  child.__log = '';
  child.stdout.on('data', (d) => { child.__log += d.toString(); });
  child.stderr.on('data', (d) => { child.__log += d.toString(); });
  child.on('exit', (code, sig) => log(`${tag} 退出 code=${code} sig=${sig}`));
  procs.push(child);
  return child;
}

// ------------------------------------------------------------------ HTTP

function request(port, method, urlPath, { token, headers = {}, body, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath,
        headers: { ...(token ? { 'X-Box-Token': token } : {}), ...headers },
        // 关 keep-alive 复用：长任务里复用空闲 socket 会混进与契约无关的噪声
        agent: false, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on('timeout', () => { req.destroy(new Error(`请求超时 ${urlPath}`)); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const asJson = (res) => { try { return JSON.parse(res.body.toString('utf8')); } catch { return null; } };

function buildMultipart(payload, images) {
  const boundary = `----miaoe3${crypto.randomBytes(8).toString('hex')}`;
  const parts = [];
  if (payload) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(payload)}\r\n`, 'utf8'));
  }
  for (const img of images) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="${img.filename}"\r\n`
      + `Content-Type: ${img.contentType}\r\n\r\n`, 'utf8'));
    parts.push(img.data);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

/** 31 张**真实**漫画图：同一张 test_0.webp 按 seq 改名。
 *  ⚠️ 为什么可以同一张：E3 考的是「链路的排布与一致性」（一个 Task / 两个 Batch / 序号连续 / SSE 对齐），
 *     不是「31 张不同漫画能否各自译对」—— 那是 E2（真实目视）与 E9（插件联调）的事。
 *     同一张反而让「逐页产物是否真的一页一译」更容易取证：任何两张译文不同就说明它按 seq 串了。 */
function loadRealImages() {
  const bytes = fs.readFileSync(TEST_IMAGE);
  return Array.from({ length: TOTAL_IMAGES }, (_, i) => ({
    filename: `${pad3(i + 1)}.webp`,
    contentType: 'image/webp',
    data: bytes,
  }));
}

const portOpen = (port, timeoutMs = 400) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  let done = false;
  const fin = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
  s.setTimeout(timeoutMs);
  s.once('connect', () => fin(true));
  s.once('timeout', () => fin(false));
  s.once('error', () => fin(false));
});

// ------------------------------------------------------------------ 主流程

fs.mkdirSync(ROOT_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(SAKURA_GGUF)) throw new Error(`Sakura 权重不在：${SAKURA_GGUF}（先 npm run fetch:models）`);
if (!fs.existsSync(TEST_IMAGE)) throw new Error(`测试图不在：${TEST_IMAGE}`);

// 适配层要在 import 之前拿到端口与协议（config 在模块顶层读 env）
process.env.MIAO_ENGINE_PORT = String(ENGINE_PORT);
process.env.MIAO_ENGINE_PROTOCOL = 'real';
process.env.MIAO_ENGINE_PROBE_MS = '500';
process.env.MIAO_ENGINE_TIMEOUT_MS = String(ITEM_BUDGET_MS);
process.env.MIAO_TOKEN = crypto.randomBytes(32).toString('hex');
process.env.MIAO_STATE_DIR = STATE_DIR;
process.env.MIAO_ROOT = ROOT_DIR;

const { probeEngine, resolveEngineLaunch } = await import(
  new URL('../../service/src/engine-client.mjs', import.meta.url).href
);

const report = {
  startedAt: new Date().toISOString(),
  phase: 'E3',
  declaredAssertions: DECLARED,
  ports: { engine: ENGINE_PORT, executor: EXECUTOR_PORT, llama: LLAMA_PORT, service: SERVICE_PORT },
  itemBudgetMs: ITEM_BUDGET_MS,
  taskTimeoutMs: TASK_TIMEOUT_MS,
};

log(`临时根目录 ${ROOT_DIR}`);
log(`单张预算上限 ${ITEM_BUDGET_MS} ms ⇒ 任务上限 ${TASK_TIMEOUT_MS} ms`);

/**
 * 🔴 前置闸：四个端口必须是空的。
 *
 * 为什么必须有：这轮要起真引擎 + 真服务，四分钟起步。如果机器上**已经**留着上一轮的
 * 引擎 / llama-server（本项目实测留下过孤儿进程），下面每一条都会"绿" —— 但绿的是那个残留进程，
 * 不是这一轮起的。这类假绿最难查：所有断言都对，只有进程不是你起的。
 * 宁可在这里花 400ms×4 说清楚。
 */
{
  const busy = [];
  for (const p of [ENGINE_PORT, EXECUTOR_PORT, LLAMA_PORT, SERVICE_PORT]) {
    if (await portOpen(p, 400)) busy.push(p);
  }
  if (busy.length) {
    console.error(
      `\n端口 ${busy.join(' / ')} 已被占用 —— 先清掉残留的引擎 / llama-server / 服务进程再跑。\n`
      + '（不清就跑：断言会变绿，但绿的是那个残留进程，不是这一轮起的。）',
    );
    process.exit(2);
  }
  report.precheck = { freePorts: [ENGINE_PORT, EXECUTOR_PORT, LLAMA_PORT, SERVICE_PORT] };
}

try {
  // ② 引擎（uvicorn + 执行器），用**适配层自己拼的启动参数**
  //
  // 🔴 ③ llama-server **不由本脚本拉起** —— S4 已把 ③ 的归属权移交给 box-service
  //    （《04》§9.1；见 D-73 决策 1）。本脚本自己起一份 llama-server 但让 box-service 也去起，
  //    会得到「两个进程抢 8080 / 第二个静默复用第一个」这种**看起来绿、其实没测到归属权**的结果。
  //    所以这里只起 ②，③ 交给下面的服务进程 —— 那才是产品里真实的进程树。
  const launch = resolveEngineLaunch({
    port: ENGINE_PORT, useGpu: true, modelsTtl: 0,
    sakuraBase: `http://127.0.0.1:${LLAMA_PORT}/v1`,
  });
  log(`拉起引擎：${launch.cmd.join(' ')}`);
  report.launch = { cmd: launch.cmd, cwd: launch.cwd, executorPort: launch.executorPort };
  const engine = spawnLogged(launch.cmd[0], launch.cmd.slice(1), { cwd: launch.cwd, env: launch.env }, 'engine');

  const t0 = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    const p = await probeEngine();
    if (p.state === 'running') break;
    if (engine.exitCode !== null) throw new Error(`引擎进程已退出（code=${engine.exitCode}）；日志尾部：\n${engine.__log.slice(-2000)}`);
    if (Date.now() - t0 > 5 * 60_000) throw new Error(`引擎 5 min 内未到 running；日志尾部：\n${engine.__log.slice(-2000)}`);
    await sleep(300);
  }
  report.engineReadyMs = Date.now() - t0;
  log(`引擎就绪（${(report.engineReadyMs / 1000).toFixed(1)} s）`);

  // ---- 2) box-service（真实服务进程；③ 由它按配方拉起）
  // 🔴 `MIAO_ENGINE_PROTOCOL=real` 必须**显式**给：默认虽也是 real，但显式声明让"这轮测的是真协议"
  //    写进进程环境，而不是靠默认值碰巧对上（mock 档默认值一改，这里会静默变成另一个东西）。
  const service = spawnLogged(process.execPath, [path.join(ROOT, 'service', 'src', 'server.mjs')], {
    env: {
      ...process.env,
      MIAO_ENGINE_PROTOCOL: 'real',
      MIAO_ENGINE_PORT: String(ENGINE_PORT),
      MIAO_ENGINE_PROBE_MS: '500',
      MIAO_ENGINE_TIMEOUT_MS: String(ITEM_BUDGET_MS),
      MIAO_ROOT: ROOT_DIR,
      MIAO_STATE_DIR: STATE_DIR,
      MIAO_PORT: String(SERVICE_PORT),
      MIAO_LLM_PORT: String(LLAMA_PORT),
    },
  }, 'service');

  const readyRe = /MIAO_READY (\{[^\n]*\})/;
  let svcInfo = null;
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const m = readyRe.exec(service.__log);
    if (m) { svcInfo = JSON.parse(m[1]); break; }
    await sleep(120);
  }
  if (!svcInfo) throw new Error(`服务未就绪：\n${service.__log.slice(-800)}`);
  const PORT = svcInfo.port;
  const TOKEN = svcInfo.token;
  log(`box-service 就绪 @${PORT}`);
  report.servicePort = PORT;

  const images = loadRealImages();

  // ---- 4) D1 同形状：第一批 20 张建任务，第二批 11 张追加到**同一个** Task
  const PLUGIN = { 'X-Box-Client': 'extension/2.3.0' };
  const mp1 = buildMultipart({ comicName: 'E3 真引擎全链路 31 张', idempotencyKey: crypto.randomUUID() }, images.slice(0, BATCH_LIMIT));
  const r1 = await request(PORT, 'POST', '/api/v1/tasks', {
    token: TOKEN, headers: { 'Content-Type': mp1.contentType, ...PLUGIN }, body: mp1.body,
  });
  const j1 = asJson(r1);
  const taskId = j1?.taskId;
  check('E3a', '第一批 20 张建立任务（HTTP 201 + taskId）', r1.status === 201 && !!taskId,
    `HTTP ${r1.status} / ${taskId ?? JSON.stringify(j1)}`);

  const mp2 = buildMultipart({ idempotencyKey: crypto.randomUUID() }, images.slice(BATCH_LIMIT));
  const r2 = await request(PORT, 'POST', `/api/v1/tasks/${taskId}/batches`, {
    token: TOKEN, headers: { 'Content-Type': mp2.contentType, ...PLUGIN }, body: mp2.body,
  });
  const j2 = asJson(r2);
  check('E3b', '第二批 11 张追加到**同一个** Task（GET 详情 taskId 不变）', r2.status === 200,
    `HTTP ${r2.status} / ${JSON.stringify(j2)?.slice(0, 200)}`);

  // ---- 5) SSE 全程订阅（在等终态**之前**挂上，否则会漏掉前面的进度）
  const events = await collectEvents(PORT, TOKEN, taskId, TASK_TIMEOUT_MS);
  log(`SSE 收到 ${events.length} 个事件`);

  const task = await waitTask(PORT, TOKEN, taskId, TASK_TIMEOUT_MS);
  report.task = { id: taskId, status: task?.status, batches: task?.batches?.length, items: task?.items?.length, progress: task?.progress };

  const batches = task?.batches ?? [];
  check('E3c', '恰好 2 个 Batch（一个 Task，不是两个），且 seq 连续无重号（1–20 / 21–31）',
    batches.length === 2 && batches[0]?.seqFrom === 1 && batches[0]?.seqTo === 20
      && batches[1]?.seqFrom === 21 && batches[1]?.seqTo === 31,
    `batches=${batches.length} / ${batches.map((b) => `${b.seqFrom}-${b.seqTo}`).join(' / ')}`);

  // ⚠️ 项状态字面量取自 store.mjs（`success` / `skipped` / `failed` / `translating` / `pending`）。
  //    这里**不写 'done'** —— 那是任务级终态的词，项级没有这个值；写错的话断言会恒红，
  //    而"恒红"看起来像"链路坏了"，实际是断言自己用错了词表。
  const ITEM_OK = ['success', 'skipped'];
  const badItems = (task?.items ?? []).filter((i) => !ITEM_OK.includes(i.status));
  check('E3d', '31 个 item 全部成功（success / skipped，无 failed）',
    task?.items?.length === TOTAL_IMAGES && badItems.length === 0,
    `items=${task?.items?.length} / 非成功=${badItems.map((i) => `${i.seq}:${i.status}`).join(',') || '无'}`);

  // ---- 6) 落盘：31 对，序号连续 001..031 无缺
  const dirName = task?.normalizedComicName ?? task?.comicName;
  const comicDir = path.join(ROOT_DIR, dirName);
  const files = fs.existsSync(comicDir) ? fs.readdirSync(comicDir) : [];
  const wantSeq = Array.from({ length: TOTAL_IMAGES }, (_, i) => i + 1);
  const missingOriginal = wantSeq.filter((s) => !files.includes(`${pad3(s)}.webp`));
  const missingTranslated = wantSeq.filter((s) => !files.some((f) => f.startsWith(`${pad3(s)}_translated.`)));
  const diskTranslatedSeqs = wantSeq.filter((s) => files.some((f) => f.startsWith(`${pad3(s)}_translated.`)));
  check('E3e', '31 对 NNN.webp + NNN_translated.* 全部落盘，序号 001–031 连续无缺',
    missingOriginal.length === 0 && missingTranslated.length === 0,
    `缺原图 [${missingOriginal.join(',')}] / 缺译文 [${missingTranslated.join(',')}] / 目录实际 ${files.length} 个文件`);
  report.landed = { dir: comicDir, fileCount: files.length, translated: diskTranslatedSeqs.length };

  // ---- 7) SSE 进度与落盘一致
  // 🔴 事实源是 `item.status` 事件流（`{seq, status, saved}`），**不是**一个叫 `progress` 的事件 ——
  //    服务端根本不发 progress 事件（事件类型只有 task.status / batch.status / item.status / heartbeat，
  //    见 store.mjs `_emit*`）。凭印象写一个 `data.current` 会**静默**取到 undefined，
  //    然后那条断言恒红或恒绿 —— 两种都是假绿家族。
  const successEvents = events.filter((e) => e.event === 'item.status' && e.data?.status === 'success' && e.data?.saved === true);
  const sseSavedSeqs = [...new Set(successEvents.map((e) => e.data.seq))].sort((a, b) => a - b);
  check('E3f', 'SSE 报「已落盘」的页集合 == 磁盘上真实存在的译文集合（两集合逐项相等，31 张）',
    sseSavedSeqs.length === TOTAL_IMAGES
      && sseSavedSeqs.join(',') === diskTranslatedSeqs.join(',')
      && task?.progress?.done === TOTAL_IMAGES,
    `SSE 报 ${sseSavedSeqs.length} 张 / 磁盘 ${diskTranslatedSeqs.length} 张 / 差集=${JSON.stringify({
      onlySse: sseSavedSeqs.filter((s) => !diskTranslatedSeqs.includes(s)),
      onlyDisk: diskTranslatedSeqs.filter((s) => !sseSavedSeqs.includes(s)),
    })} / progress.done=${task?.progress?.done}`);
  report.sse = {
    totalEvents: events.length,
    byType: events.reduce((acc, e) => { acc[e.event] = (acc[e.event] ?? 0) + 1; return acc; }, {}),
    savedSeqs: sseSavedSeqs.length,
    lastEventId: events.at(-1)?.id ?? null,
  };

  // ---- 8) 逐页产物确实被**翻译**过（不是把原图原样抄过去）
  // 用引擎 venv 的 numpy/PIL 算，不自己实现解码；抽样首/中/尾三张，覆盖两个 Batch。
  const samples = [1, 16, 31];
  const translatedOf = (s) => files.find((f) => f.startsWith(`${pad3(s)}_translated.`));
  const filesForPy = samples.map((s) => ({
    seq: s,
    src: path.join(comicDir, `${pad3(s)}.webp`),
    out: path.join(comicDir, translatedOf(s)),
  })).filter((x) => x.out && fs.existsSync(x.out));

  let compare = null;
  if (filesForPy.length === samples.length) {
    const py = `
import numpy as np, json
from PIL import Image
pairs = json.loads(${JSON.stringify(JSON.stringify(filesForPy))})
res = []
for p in pairs:
    a = np.asarray(Image.open(p['src']).convert('RGB')).astype(int)
    b = np.asarray(Image.open(p['out']).convert('RGB')).astype(int)
    r = {'seq': p['seq'], 'sameShape': a.shape == b.shape, 'srcSize': list(a.shape[1::-1]), 'outSize': list(b.shape[1::-1])}
    if a.shape == b.shape:
        d = np.abs(b - a).max(axis=2)
        r['changedPct'] = round(100*float((d > 8).mean()), 2)
    res.append(r)
print(json.dumps(res, ensure_ascii=False))
`;
    const r = spawnSync(VENV_PY, ['-c', py], { encoding: 'utf8' });
    const line = (r.stdout || '').trim().split('\n').pop();
    try { compare = JSON.parse(line); } catch { compare = { raw: r.stdout, err: r.stderr }; }
  }
  report.compare = compare;
  check('E3g', '抽样 3 张（首/中/尾，跨两个 Batch）译文与原文逐像素不同 —— 翻译阶段真的执行了',
    Array.isArray(compare) && compare.length === samples.length
      && compare.every((c) => c.sameShape && c.changedPct > 0.5),
    JSON.stringify(compare)?.slice(0, 400));

  // ---- 9) 一页一译：同一张原图，不同 seq 的译文**必须不同**（否则说明产物串了/全抄一张）
  let distinctPairs = null;
  if (filesForPy.length >= 2) {
    const digests = filesForPy.map((f) => crypto.createHash('sha256').update(fs.readFileSync(f.out)).digest('hex'));
    distinctPairs = new Set(digests).size;
  }
  check('E3h', '不同 seq 的译文互不相同（产物按页一一对应，没有整目录复写同一张）',
    distinctPairs === filesForPy.length,
    `不同产物哈希数=${distinctPairs} / 抽样数=${filesForPy.length}`);

  report.engineLogSnippet = engine.__log.slice(-1200);
  report.serviceLogSnippet = service.__log.slice(-1200);
} catch (e) {
  report.fatal = { message: String(e && e.message), stack: String(e && e.stack).split('\n').slice(0, 6) };
  log(`❌ 中断：${report.fatal.message}`);
} finally {
  // ---- 收口：账本与报告无论如何都要落盘，否则失败时只剩一句话
  const passed = results.filter((r) => r.ok).length;
  const executed = results.length;
  report.assertions = results;
  report.executed = executed;
  report.passed = passed;
  report.finishedAt = new Date().toISOString();
  report.cleanup = { killed: !KEEP, tmp: TMP };

  if (!KEEP) shutdown();

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  console.log('\n──────── E3 全链路（真引擎） ────────');
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.id} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n通过 ${passed} / 执行 ${executed} / 声明 ${DECLARED}`);
  console.log(`产物目录：${OUT}`);

  // 分母写死：声明几条就必须执行几条，少一条视同失败（禁止"跳过即通过"）
  const denominatorOk = executed === DECLARED;
  if (!denominatorOk) console.log(`\n🔴 分母不符：声明 ${DECLARED} 条，实际执行 ${executed} 条 —— 视为失败`);
  if (report.fatal) console.log(`\n致命错误：${report.fatal.message}`);

  process.exitCode = passed === DECLARED && denominatorOk && !report.fatal ? 0 : 1;
}

// ------------------------------------------------------------------ 用例内联函数
// （放在文件末尾：主流程 `await` 过它们，提升在这里只是让主流程读起来是一条线）

/** 订阅 SSE 直到终态；返回收到的事件序列（含原始 data 对象） */
function collectEvents(port, token, taskId, timeoutMs) {
  return new Promise((resolve) => {
    const events = [];
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: `/api/v1/tasks/${taskId}/events`, headers: { 'X-Box-Token': token, Accept: 'text/event-stream' }, agent: false },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          const frames = buf.split('\n\n');
          buf = frames.pop() ?? '';
          for (const frame of frames) {
            let name = null; let idText = null; let dataText = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) name = line.slice(6).trim();
              else if (line.startsWith('id:')) idText = line.slice(3).trim();
              else if (line.startsWith('data:')) dataText += line.slice(5).trim();
            }
            if (!dataText) continue;
            let data = null;
            try { data = JSON.parse(dataText); } catch { continue; }
            events.push({ id: idText ? Number(idText) : null, event: name, data });
            if (name === 'task.status' && ['done', 'partial_failed', 'failed', 'canceled'].includes(data.status)) {
              clearTimeout(timer);
              req.destroy();
              resolve(events);
            }
          }
        });
      },
    );
    const timer = setTimeout(() => { req.destroy(); resolve(events); }, timeoutMs);
    req.on('error', () => { clearTimeout(timer); resolve(events); });
    req.end();
  });
}

async function waitTask(port, token, taskId, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(port, 'GET', `/api/v1/tasks/${taskId}`, { token });
    const t = asJson(res);
    if (t && TERMINAL.includes(t.status)) return t;
    if (Date.now() > until) throw new Error(`${taskId} 未在 ${timeoutMs}ms 内到终态（当前 ${t && t.status}）`);
    await sleep(500);
  }
}
