#!/usr/bin/env node
/**
 * S1 适配层（`service/src/engine-client.mjs`）契约断言 —— **且必须可反证**。
 *
 * 为什么单独一个脚本：S1 换的是**引擎协议**，而 service 的日常自测（`e2e/service/selftest.mjs`）
 * 起的是**模拟引擎**（ver1.0 自定义协议）——两者协议不同。若只靠 selftest，`real` 分支
 * 一行都没被执行过，却会因为 selftest 全绿而"看着没问题"（假绿家族第 4 类：看着覆盖、实则空转）。
 *
 * 本脚本用**「真协议假引擎」**覆盖 real 分支：一个只实现真实引擎契约
 * （`POST /translate/image` + `GET /queue-size`）的极简 HTTP 服务，可控、可注入、秒级返回。
 * 它证明的是**「管路通」**（请求形状对不对、错误怎么归一、三态怎么判）；
 * **「功能通」**（真引擎真的吐出中文译文）由 `.tmp/engine-test/` 的 S1 实测覆盖，
 * 两者是两件事，报告里必须分开写（`docs/engine-integration-plan.md` R7）。
 *
 * 断言分组：
 *   R  real 协议的单图调用（请求形状 / 返回值 / 错误归一化 / 输入拦截）
 *   P  real 协议的就绪三态（**三重判定**：端口 → HTTP → 执行器端口）
 *   L  启动参数拼装（**按 `server/args.py` 实测**，不是《04》§4.3 的示意列表）
 *   D  默认值与取值校验（防"改成 mock 让生产走替身"）
 *   M  mock 协议未被改坏（起真正的模拟引擎冒烟）
 *
 * 用法：
 *   node e2e/service/engine-client-check.mjs            正向跑
 *   node e2e/service/engine-client-check.mjs --refute   反证轮（破坏源文件 → 断言必须变红 → 按字节恢复）
 *
 * 约束：纯 Node、零依赖；不写用户目录（临时文件落 os.tmpdir）；反证轮结束**必须**按字节还原。
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { encodePng } from '../../engine/src/png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..', 'service'); // .../service
const REPO = path.resolve(ROOT, '..');
const RT = path.join(REPO, 'runtimes', 'manga-translator');
const SERVICE_SRC = path.join(ROOT, 'src');
const ENGINE_CLIENT = path.join(SERVICE_SRC, 'engine-client.mjs');
const CONFIG_FILE = path.join(SERVICE_SRC, 'config.mjs');
const MOCK_ENGINE = path.join(REPO, 'engine', 'src', 'server.mjs');
/**
 * 🔴 假引擎**必须按真实快照**回话，不能按"我以为的协议"回话。
 *
 * 这条是血换来的：第一版假引擎把 `/queue-size` 实现成 `GET`（凭印象写的），而真引擎是
 * `POST`（`server/main.py:161`）—— 于是**断言全绿、真引擎 405**，且 405 长得像"引擎没就绪"。
 * 所以这里用快照当"宪法"：**快照里没有的 method/路径，一律照 FastAPI 的规矩回 404/405**，
 * 让"写错 method"必然在这里就暴露，而不是留到真机。
 */
const SNAPSHOT_PATH = path.join(RT, 'openapi.engine.json');
const SNAPSHOT_PATHS = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')).paths;

const REFUTE = process.argv.includes('--refute');
const MOCK_CHILD = process.argv.includes('--mock-child');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-engine-client-check-'));

// ------------------------------------------------------------------ 结果收集

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}

/**
 * 调产品代码的**唯一安全入口**：把抛错转成"可记录的失败"，而不是打死进程。
 *
 * 🔴 反证轮要的是"破坏后断言**变红**"。若被测代码一抛错就把脚本带走，反证轮只能看到
 *    "子进程没有结果行" —— 那是「**断言炸了**」，与「**断言变红**」是两件事，
 *    必须分开（AGENTS.md §2-4：断言变绿 ≠ 事情做对；同理，脚本崩 ≠ 断言变红）。
 *    这条是实测踩出来的：破坏「结果流按 5 字节帧解析」后，`parseResultStream` 正确抛出
 *    ENGINE_BAD_OUTPUT，但脚本在未保护的 `await translateImage(...)` 上崩掉 ⇒ 反证轮报
 *    "E 未按预期变红"，看上去像**破坏没生效**，实则判据根本没机会跑。
 */
async function attempt(fn) {
  try { return { value: await fn(), err: null }; }
  catch (err) { return { value: null, err }; }
}

/** 调用抛错时的可读说明（`attempt()` 配套） */
function errText(err) {
  if (!err) return '';
  return `抛错 ${err.code || err.name}: ${err.message}`;
}
/**
 * 断言 id 的格式是 `「短码」 描述`。反证轮的 `expect` 只写短码，
 * 若直接 `byId['R5']` 会**永远 undefined** ⇒ "未变红"误报（而且看上去像破坏没生效）。
 * 必须按短码前缀匹配。
 */
function matchById(list, code) {
  return list.find((r) => r.id === code || r.id.startsWith(`${code} `));
}
const out = {
  pass: 0,
  fail: 0,
};
function emit() {
  out.pass = results.filter((r) => r.ok).length;
  out.fail = results.length - out.pass;
}

/** 机器可读结果行（反证轮的父进程据此解析） */
function printResults(title) {
  emit();
  console.log(`\n### ${title}`);
  for (const r of results) {
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.id}${r.detail ? `  ${r.detail}` : ''}`);
  }
  console.log(`[RESULT] ${JSON.stringify({ results, pass: out.pass, fail: out.fail })}`);
  console.log(`\n通过 ${out.pass} / 失败 ${out.fail}`);
}

// ------------------------------------------------------------------ 网络小工具

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** 找一对连续空闲端口（引擎端口 + 执行器端口 = port+1） */
async function findFreePortPair(start = 5420) {
  for (let p = start; p < start + 200; p += 1) {
    if (await isPortFree(p) && await isPortFree(p + 1)) return p;
  }
  throw new Error('找不到空闲端口对');
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

/**
 * 「真协议假引擎」：只实现真实引擎的契约面。
 * 行为由 state 控制（同进程可直接改），用于注入 422 / 500 / 挂起 / 非图片返回。
 */
function createFakeEngine() {
  const state = {
    hits: [],            // { method, path, body }
    mode: 'ok',          // 'ok' | 'hang' | 'http-status' | 'garbage-result' | 'stream-error' | 'queue-not-ready'
    status: 500,
    detail: 'injected',
    /** 结果帧前是否插进度帧 —— 用来证明解析器**按帧**走，不是"整包当图" */
    progressFrames: true,
    streamError: 'inference exploded',
    streamResult: null,  // 覆盖结果帧内容（默认是合法 PNG）
  };
  const png = encodePng(30, 40, (x, y, put) => put((x * 3) % 256, (y * 5) % 256, 128));

  /** 结果流的一帧：1 字节 code + 4 字节大端长度 + 数据（`server/streaming.py:11-18`） */
  const frame = (code, data) => {
    const head = Buffer.alloc(5);
    head[0] = code;
    head.writeUInt32BE(data.length, 1);
    return Buffer.concat([head, data]);
  };

  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const pathname = String(req.url || '').split('?')[0];
      const method = String(req.method || 'GET').toLowerCase();
      state.hits.push({ method: String(req.method || 'GET'), path: pathname, body: Buffer.concat(chunks) });

      const replyJson = (status, obj) => {
        const body = Buffer.from(JSON.stringify(obj));
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
        res.end(body);
      };
      const replyStream = (buf) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length });
        res.end(buf);
      };

      if (state.mode === 'hang') return; // 收下请求、永不回应 → 触发超时

      // ---- 快照当宪法：端点/方法不在 openapi 里 → 照 FastAPI 的规矩回 404/405 ----
      const entry = SNAPSHOT_PATHS[pathname];
      if (!entry) return replyJson(404, { detail: 'Not Found' });
      if (!entry[method]) return replyJson(405, { detail: 'Method Not Allowed' });

      if (state.mode === 'http-status') return replyJson(state.status, { detail: state.detail });

      // uvicorn 还没接客：端口在听、HTTP 层答不上（`P4b` 用它验 `state=starting`）
      if (pathname === '/queue-size' && state.mode === 'queue-not-ready') return replyJson(503, { detail: 'starting up' });

      if (pathname === '/queue-size') return replyJson(200, 0);

      if (pathname === '/translate/image/stream') {
        const parts = [];
        if (state.progressFrames) parts.push(frame(1, Buffer.from('检测中…', 'utf8')));
        if (state.mode === 'stream-error') {
          // 流式端点的"推理失败"走这里：HTTP 仍是 200，错误在流里（code 2）
          parts.push(frame(2, Buffer.from(state.streamError, 'utf8')));
          return replyStream(Buffer.concat(parts));
        }
        if (state.mode === 'garbage-result') {
          parts.push(frame(0, Buffer.from(JSON.stringify({ hello: 'not an image' }), 'utf8')));
          return replyStream(Buffer.concat(parts));
        }
        parts.push(frame(0, state.streamResult || png));
        return replyStream(Buffer.concat(parts));
      }
      return replyJson(404, { detail: 'Not Found' });
    });
  };
  return { state, server: http.createServer(handler) };
}

/** 最小合法 WEBP 头（嗅探只认前 12 字节；真解码不在本脚本范围内） */
function minimalWebp() {
  const buf = Buffer.alloc(32);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(24, 4);
  buf.write('WEBP', 8, 'latin1');
  buf.write('VP8X', 12, 'latin1');
  buf.writeUInt32LE(10, 16);
  return buf;
}

const pngBytes = (w = 40, h = 60, seed = 1) =>
  encodePng(w, h, (x, y, put) => put((seed * 37 + x) % 256, (seed * 17 + y) % 256, (seed * 7) % 256));

// ================================================================ mock 子进程分支

if (MOCK_CHILD) {
  const mod = await import(pathToFileURL(ENGINE_CLIENT).href);
  const { translateImage, probeEngine } = mod;

  const probe = await probeEngine();
  check('M1 mock 协议：probeEngine 为 running（起的是真正的模拟引擎）',
    probe.state === 'running', JSON.stringify(probe));
  check('M1b mock 协议：engineVersion 报 `mock` —— 起的是替身就老实说，绝不冒充上游 commit',
    probe.engineVersion === 'mock', String(probe.engineVersion));

  const res = await translateImage(pngBytes(40, 60, 9), { seq: 1, mime: 'image/png' });
  const isPng = Buffer.isBuffer(res.bytes) && res.bytes.length > 8
    && res.bytes[0] === 0x89 && res.bytes[1] === 0x50;
  check('M2 mock 协议：translateImage 返回可识别译文图（嗅探 ext=png）',
    isPng && res.ext === 'png', `${res.ext} ${res.bytes.length}B`);

  printResults('M · mock 协议冒烟（engine/src/server.mjs）');
  process.exit(out.fail === 0 ? 0 : 1);
}

// ================================================================ 正向断言

async function runPositive() {
  const enginePort = await findFreePortPair();

  // 引擎端口与协议都必须在 **import config 之前** 落进 env（config 在模块顶层读 env）
  process.env.MIAO_ENGINE_PORT = String(enginePort);
  process.env.MIAO_ENGINE_PROTOCOL = 'real';
  process.env.MIAO_ENGINE_PROBE_MS = '400';
  process.env.MIAO_ENGINE_TIMEOUT_MS = '1200'; // 超时用例要等它，不能是默认的 10 min
  process.env.MIAO_TOKEN = 'e'.repeat(64);
  process.env.MIAO_STATE_DIR = path.join(TMP, 'state'); // 别碰用户真实 token 文件

  const mod = await import(pathToFileURL(ENGINE_CLIENT).href);
  const {
    translateImage, probeEngine, resolveEngineLaunch, EngineError,
    recentStageLog, engineConfigSnapshot, ENGINE_VERSION, ENGINE_DEFAULT_DETECTION_SIZE,
    engineHfOfflineEnv, translationWeightsPresent,
  } = mod;
  const { config } = await import(pathToFileURL(CONFIG_FILE).href);

  const fake = createFakeEngine();
  await listen(fake.server, enginePort);
  // 执行器端口（enginePort+1）：默认起监听（= 引擎完全就绪）
  const executor = http.createServer((_req, res) => res.end());
  let executorUp = false;
  const startExecutor = async () => { if (!executorUp) { await listen(executor, enginePort + 1); executorUp = true; } };
  await startExecutor();

  const lastHit = () => fake.state.hits[fake.state.hits.length - 1];
  const hitCount = () => fake.state.hits.length;

  try {
    // ---------------------------------------------------------- R · real 单图调用
    fake.state.mode = 'ok';
    const before = hitCount();
    const a1 = await attempt(() => translateImage(pngBytes(40, 60, 1), { seq: 7, from: 'ja', to: 'zh', mime: 'image/png' }));
    const r1 = a1.value;

    check('R1 走真实端点 `/translate/image/stream`（不是 ver1.0 的 `/translate`，也不是必坏的 `/translate/image`）',
      lastHit()?.path === '/translate/image/stream' && lastHit()?.method === 'POST',
      `${lastHit()?.method} ${lastHit()?.path}`);
    check('R2 请求体是 JSON 且 image 字段是 data URI（否则引擎会把它当 URL 去 requests.get）',
      (() => {
        try {
          const o = JSON.parse(lastHit().body.toString('utf8'));
          return typeof o.image === 'string' && /^data:image\/[a-z]+;base64,/.test(o.image);
        } catch { return false; }
      })(),
      (() => { try { return JSON.parse(lastHit().body.toString('utf8')).image.slice(0, 40); } catch { return 'n/a'; } })());
    check('R3 请求体 config 的**基线四项**与 `config.engineConfig` 一致（sakura / CHS / 48px / lama_large / default）',
      (() => {
        try {
          const o = JSON.parse(lastHit().body.toString('utf8'));
          return o.config?.translator?.translator === 'sakura'
            && o.config?.translator?.target_lang === 'CHS'
            && o.config?.ocr?.ocr === '48px'
            && o.config?.inpainter?.inpainter === 'lama_large'
            && o.config?.detector?.detector === 'default';
        } catch { return false; }
      })(),
      (() => { try { return JSON.stringify(JSON.parse(lastHit().body.toString('utf8')).config); } catch { return 'n/a'; } })());
    // ↓ ver2.1 的两条**方向**断言：这是「服务把方向真的送到引擎」在**请求体层面**的取证。
    //   只测 R3 不够 —— R3 在 `from_lang` 缺失时同样绿（发 `config.engineConfig` 常量也一样绿）。
    check('R16 ja 方向 ⇒ 请求体下发 `config.translator.from_lang === "JPN"`（显式源语言，不再靠 langid 自动检测）',
      (() => {
        try { return JSON.parse(lastHit().body.toString('utf8')).config?.translator?.from_lang === 'JPN'; }
        catch { return false; }
      })(),
      (() => { try { return JSON.stringify(JSON.parse(lastHit().body.toString('utf8')).config.translator); } catch { return 'n/a'; } })());
    const a1en = await attempt(() => translateImage(pngBytes(40, 60, 5), { seq: 17, lang: { from: 'en', to: 'zh' }, mime: 'image/png' }));
    check('R17 en 方向 ⇒ `from_lang === "ENG"` **且**翻译器切成 `nllb`（sakura 的 prompt 硬编码日文、语言表只有 {CHS,JPN} ⇒ 英文必原文照抄，A 组实测 8/8 行）',
      (() => {
        try {
          const t = JSON.parse(lastHit().body.toString('utf8')).config?.translator;
          return t?.from_lang === 'ENG' && t?.translator === 'nllb' && t?.target_lang === 'CHS';
        } catch { return false; }
      })(),
      a1en.err ? errText(a1en.err) : (() => { try { return JSON.stringify(JSON.parse(lastHit().body.toString('utf8')).config.translator); } catch { return 'n/a'; } })());
    check('R4 返回 {bytes,ext,mime} 且 ext 由**字节嗅探**得出（不信引擎自称的 Content-Type）',
      !!r1 && Buffer.isBuffer(r1.bytes) && r1.ext === 'png' && r1.mime === 'image/png' && r1.bytes.length > 8,
      r1 ? `${r1.ext} ${r1.mime} ${r1.bytes.length}B` : errText(a1.err));

    // 传入**错误的** mime：data URI 里的 mime 必须仍来自嗅探（webp），而不是调用方那句谎话
    const a1b = await attempt(() => translateImage(minimalWebp(), { seq: 8, mime: 'image/png' }));
    const r1b = a1b.value;
    const uri1b = (() => { try { return JSON.parse(lastHit().body.toString('utf8')).image; } catch { return ''; } })();
    check('R5 data URI 的 mime 取自**字节嗅探**，不采信调用方声明的 mime（谎报 png 仍写出 image/webp）',
      !!r1b && uri1b.startsWith('data:image/webp;base64,') && r1b.ext === 'png',
      r1b ? uri1b.slice(0, 26) : errText(a1b.err));

    // 坏字节：本地拦下，**不给引擎发请求**
    const beforeBad = hitCount();
    let badCode = null;
    try {
      await translateImage(Buffer.from('这不是图片'), { seq: 9 });
    } catch (e) { badCode = e instanceof EngineError ? e.code : `非EngineError:${e.name}`; }
    check('R6 非图片字节 → 本地 BAD_INPUT，且**引擎一次都没被调用**（省一次网络往返）',
      badCode === 'BAD_INPUT' && hitCount() === beforeBad,
      `code=${badCode} hits+${hitCount() - beforeBad}`);

    // 错误归一化：422 / 500（**HTTP 层**，发生在 handler 之前；推理失败走流里 code 2，见 R15）
    fake.state.mode = 'http-status';
    fake.state.status = 422;
    fake.state.detail = 'cannot identify image file';
    let code422 = null;
    try { await translateImage(pngBytes(40, 60, 2), { seq: 10 }); } catch (e) { code422 = e.code; }
    check('R7 引擎 422 → ENGINE_BAD_INPUT（我们送的图/请求有问题，与"引擎坏了"分开）',
      code422 === 'ENGINE_BAD_INPUT', code422);

    fake.state.status = 500;
    fake.state.detail = 'handler exploded';
    let code500 = null;
    let msg500 = '';
    try { await translateImage(pngBytes(40, 60, 3), { seq: 11 }); } catch (e) { code500 = e.code; msg500 = e.message; }
    check('R8 引擎 500 → ENGINE_ERROR，且把 detail 带进 message（可查，不吞）',
      code500 === 'ENGINE_ERROR' && /handler exploded/.test(msg500), `${code500} ${msg500}`);

    // 200 但结果帧里不是图
    fake.state.mode = 'garbage-result';
    let codeGarbage = null;
    try { await translateImage(pngBytes(40, 60, 4), { seq: 12 }); } catch (e) { codeGarbage = e.code; }
    check('R9 HTTP 200 但**结果帧**不是图片 → ENGINE_BAD_OUTPUT（不把垃圾当译文落盘）',
      codeGarbage === 'ENGINE_BAD_OUTPUT', codeGarbage);

    // 流里 code 2 = 推理失败（**HTTP 仍是 200**，这是流式端点最容易漏判的一种错）
    fake.state.mode = 'stream-error';
    let codeStreamErr = null;
    let msgStreamErr = '';
    try { await translateImage(pngBytes(40, 60, 7), { seq: 15 }); } catch (e) { codeStreamErr = e.code; msgStreamErr = e.message; }
    check('R15 流里 code 2（推理失败）→ ENGINE_ERROR，且带上引擎侧文案 —— HTTP 200 不代表成功',
      codeStreamErr === 'ENGINE_ERROR' && /inference exploded/.test(msgStreamErr), `${codeStreamErr} ${msgStreamErr}`);

    // 结果帧前有 / 无进度帧，两种都要能取出结果
    fake.state.mode = 'ok';
    fake.state.progressFrames = false;
    const aNoProg = await attempt(() => translateImage(pngBytes(40, 60, 8), { seq: 16 }));
    fake.state.progressFrames = true;
    const aWithProg = await attempt(() => translateImage(pngBytes(40, 60, 8), { seq: 17 }));
    const rNoProg = aNoProg.value;
    const rWithProg = aWithProg.value;
    check('R14 结果帧**前有/无进度帧**两种情况都能取出结果 —— 证明解析按帧走，不是"整包当图"',
      !!rNoProg && !!rWithProg && rNoProg.ext === 'png' && rWithProg.ext === 'png'
        && rWithProg.bytes.length === rNoProg.bytes.length,
      (rNoProg && rWithProg)
        ? `无进度帧=${rNoProg.ext}/${rNoProg.bytes.length}B 有进度帧=${rWithProg.ext}/${rWithProg.bytes.length}B`
        : errText(aNoProg.err || aWithProg.err));

    // 端口不通
    fake.state.mode = 'ok';
    const savedPort = config.enginePort;
    config.enginePort = enginePort + 60; // 无人监听
    let codeUnavail = null;
    try { await translateImage(pngBytes(40, 60, 5), { seq: 13 }); } catch (e) { codeUnavail = e.code; }
    check('R10 端口不通 → ENGINE_UNAVAILABLE（进程不在，与"图坏了"分开）',
      codeUnavail === 'ENGINE_UNAVAILABLE', codeUnavail);

    // 就绪探测的三态之一：stopped（这里顺带验，免得再切一次端口）
    const p0 = await probeEngine();
    check('P1 端口不通 → state=stopped、port=null',
      p0.state === 'stopped' && p0.port === null, JSON.stringify(p0));
    config.enginePort = savedPort;

    // 超时
    fake.state.mode = 'hang';
    let codeTimeout = null;
    const t0 = Date.now();
    try { await translateImage(pngBytes(40, 60, 6), { seq: 14 }); } catch (e) { codeTimeout = e.code; }
    const elapsed = Date.now() - t0;
    check('R11 引擎收下但不应答 → ENGINE_TIMEOUT（约 1200ms 即返回，不挂死任务）',
      codeTimeout === 'ENGINE_TIMEOUT' && elapsed < 3000, `${codeTimeout} ${elapsed}ms`);
    fake.state.mode = 'ok';

    // ---------------------------------------------------------- P · 就绪三态（三重判定）
    await sleep(50);
    const pRunning = await probeEngine();
    check('P2 裸 HTTP 在 + 执行器端口在 → state=running',
      pRunning.state === 'running' && pRunning.port === enginePort, JSON.stringify(pRunning));
    check('P3 probeEngine 形状：9 个契约字段齐（§5.1）。⚠️ 其中 tier/accel/warmed/llm/model 恒为 null —— 它们是**服务级**事实，由 server.mjs 的 composeSidecar() 合成，本文件不持有它们',
      ['state', 'port', 'engine', 'engineVersion', 'tier', 'accel', 'warmed', 'llm', 'model']
        .every((k) => k in pRunning)
        && ['tier', 'accel', 'warmed', 'llm', 'model'].every((k) => pRunning[k] === null),
      Object.keys(pRunning).join(','));
    check(`P3b engineVersion 非空且等于清单里锁定的 commit 短 sha（real 档；上游没有可用版本号，见 ENGINE_VERSION 注释）`,
      pRunning.engineVersion === ENGINE_VERSION && /^[0-9a-f]{7}$/.test(String(ENGINE_VERSION)),
      `ENGINE_VERSION=${ENGINE_VERSION} probe=${pRunning.engineVersion}`);
    check('P3c engineVersion 是**安装事实**：引擎停下（端口不通）时它仍然答得出来，而 `engine` 变 null（进程事实）',
      p0.engineVersion === ENGINE_VERSION && p0.engine === null,
      `stopped: ${JSON.stringify({ engine: p0.engine, engineVersion: p0.engineVersion })}`);

    await new Promise((resolve) => { executor.close(resolve); executorUp = false; });
    await sleep(50);
    const pStarting = await probeEngine();
    check('P4 HTTP 在、**执行器端口未监听** → state=prewarming（= L3 预热：执行器在加载 torch/模型）。只看 HTTP 会把"模型还在加载"误判成 running，第一张必挂',
      pStarting.state === 'prewarming' && pStarting.port === enginePort, JSON.stringify(pStarting));

    // uvicorn 还没接客：端口在听、HTTP 层答不上 ⇒ starting。与 prewarming **必须分得开**：
    // §10.2 把两者并列写成 `starting/prewarming`，而本探测能分辨，就没有理由合报成一个词。
    fake.state.mode = 'queue-not-ready';
    const pUvicorn = await probeEngine();
    check('P4b 端口在听但 /queue-size 答不上（uvicorn 启动中）→ state=starting，与 prewarming 分开',
      pUvicorn.state === 'starting', JSON.stringify(pUvicorn));
    fake.state.mode = 'ok';

    // ---------------------------------------------------------- 快照一致性（防"按记忆写协议"）
    const snapViolations = fake.state.hits.filter((h) => {
      const e = SNAPSHOT_PATHS[h.path];
      return !e || !e[h.method.toLowerCase()];
    });
    check('R12 适配层说出的**每个 (method, path) 都在 openapi 快照里** —— 防"凭印象写协议"（`GET /queue-size` 405 那次就是栽在这）',
      fake.state.hits.length > 0 && snapViolations.length === 0,
      `共 ${fake.state.hits.length} 次请求，越界：${snapViolations.map((h) => `${h.method} ${h.path}`).join(',') || '无'}`);

    // ---------------------------------------------------------- L · 启动参数拼装
    const launch = resolveEngineLaunch({ port: enginePort, nonce: 'deadbeef', useGpu: true, modelsTtl: 1800 });
    const joined = launch.cmd.join(' ');
    check('L1 命令行是 `python main.py --host --port`，**不是** `-m server.main`（后者 `from args import` 必 ModuleNotFoundError）',
      /main\.py --host /.test(joined) && joined.includes('--port') && !joined.includes('-m '),
      joined);
    check('L2 不含 `--config-file` / `--model-dir` —— 服务端实测**没有**这两个参数（《04》§4.3 的示意列表在此处是错的）',
      !joined.includes('--config-file') && !joined.includes('--model-dir'), joined);
    check('L3 useGpu=true → 带 `--use-gpu`；modelsTtl>0 → 带 `--models-ttl 1800`；nonce → 带 `--nonce`',
      joined.includes('--use-gpu') && joined.includes('--models-ttl 1800') && joined.includes('--nonce deadbeef'),
      joined);
    check('L4 cwd 指向引擎 `src/server`（`from args import` 要求脚本目录在 sys.path[0]，`-m` 模式做不到）',
      launch.cwd === config.engineServerDir && fs.existsSync(path.join(launch.cwd, 'main.py')),
      launch.cwd);
    check('L5 cwd **不是** `src/` —— 执行器的 cwd 才是 `src/`（`main.py` 里 `Popen(cwd=src)` 写死），两者不能混用',
      path.resolve(launch.cwd) !== path.resolve(config.engineDir), `${launch.cwd} vs ${config.engineDir}`);
    check('L6 env 注入 SAKURA_API_BASE（引擎③地址，`translators/keys.py` 读它）',
      typeof launch.env.SAKURA_API_BASE === 'string' && launch.env.SAKURA_API_BASE.endsWith('/v1'),
      launch.env.SAKURA_API_BASE);
    check('L7 executorPort = port + 1（`server/main.py` spawn 执行器时写死 `args.port + 1`）',
      launch.executorPort === enginePort + 1, String(launch.executorPort));

    const defaultLaunch = resolveEngineLaunch({ port: enginePort });
    const nIdx = defaultLaunch.cmd.indexOf('--nonce');
    check('L8 默认 nonce 是**字面串** `"None"`（=禁用鉴权）—— 传空串会生成随机 nonce，传真值则主进程调执行器必 401（上游 `fetch_data` 不带 `X-Nonce`）',
      nIdx > -1 && defaultLaunch.cmd[nIdx + 1] === 'None',
      defaultLaunch.cmd.join(' '));

    // ---------------------------------------------------------- L9/L10 · 本机代理旁路（D-86）
    // 断言一律用**受控 env**：先清干净再取。不这么做，一台"恰好设了 NO_PROXY 含 127.0.0.1"
    // 的机器上，L9 会在**没有注入**的情况下也变绿 —— 而反证轮正是靠它变红来证明注入有用。
    const savedEnv = {
      NO_PROXY: process.env.NO_PROXY,
      no_proxy: process.env.no_proxy,
      http_proxy: process.env.http_proxy,
    };
    const restoreEnv = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };

    delete process.env.NO_PROXY; delete process.env.no_proxy;
    const noProxyLaunch = resolveEngineLaunch({ port: enginePort });
    restoreEnv('NO_PROXY', savedEnv.NO_PROXY);
    restoreEnv('no_proxy', savedEnv.no_proxy);
    const npList = String(noProxyLaunch.env.NO_PROXY || '').split(',').map((s) => s.trim());
    check('L9 启动 env 注入 NO_PROXY 且覆盖**本机三写法**（`127.0.0.1`/`localhost`/`::1`）—— 防"用户/沙箱挂了代理，把本机 8080 推理链路劫走"（D-86：就是本期 16 张图全 failed 的真根因）',
      ['127.0.0.1', 'localhost', '::1'].every((h) => npList.includes(h)),
      String(noProxyLaunch.env.NO_PROXY));

    // L10 是 L9 的**另一半**：旁路只能靠"加 NO_PROXY"实现，**不能靠删代理** ——
    // 引擎若改用云端翻译器仍然需要代理，删掉它会把那种配置静默打死（坏法与"本机被劫"一样难查）。
    //
    // ⚠️ 取值的写法有讲究：**Windows 的 env 是大小写不敏感的**，Node 的 `process.env` 会把
    //    `HTTP_PROXY` 与 `http_proxy` **折叠成同一个键**（保留先出现的那种写法）。于是这里用
    //    小写写进去、`{...process.env}` 摊出来的普通对象里却可能只有大写那个键 ⇒ 断言必须
    //    **按实际键名**去取，写死任一大小写都会在另一个平台上假红。
    process.env.http_proxy = 'http://10.0.0.9:3128';
    process.env.NO_PROXY = 'example.com';
    const proxyKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'http_proxy');
    const withProxyLaunch = resolveEngineLaunch({ port: enginePort });
    restoreEnv('http_proxy', savedEnv.http_proxy);
    restoreEnv('NO_PROXY', savedEnv.NO_PROXY);
    restoreEnv('no_proxy', savedEnv.no_proxy);
    check('L10 父进程设了代理 ⇒ env **保留**它（不删代理），且 NO_PROXY 是「原有项 + 本机」的并集（不是覆盖掉原有项）',
      withProxyLaunch.env[proxyKey] === 'http://10.0.0.9:3128'
      && String(withProxyLaunch.env.NO_PROXY).includes('example.com')
      && String(withProxyLaunch.env.NO_PROXY).includes('127.0.0.1'),
      JSON.stringify({ proxyKey, proxyVal: withProxyLaunch.env[proxyKey], NO_PROXY: withProxyLaunch.env.NO_PROXY }));
    // 只设**小写** `no_proxy` 时也要被"看见"并并集（有些工具只写小写），且两个大小写输出一致。
    delete process.env.NO_PROXY;
    process.env.no_proxy = 'corp.internal';
    const lowerLaunch = resolveEngineLaunch({ port: enginePort });
    restoreEnv('NO_PROXY', savedEnv.NO_PROXY);
    restoreEnv('no_proxy', savedEnv.no_proxy);
    const lowerNp = String(lowerLaunch.env.NO_PROXY || '');
    check('L11 只设**小写** `no_proxy` 时也能被并集进来，且两个大小写输出一致 —— httpx/requests/curl 读法不一致，漏一份的成本是一次"偶发"',
      lowerNp.includes('corp.internal') && lowerNp.includes('127.0.0.1')
      && lowerLaunch.env.no_proxy === lowerLaunch.env.NO_PROXY,
      `${lowerLaunch.env.no_proxy} vs ${lowerLaunch.env.NO_PROXY}`);

    // ---------------------------------------------------------- L12 · 引擎 stdio 编码（D-88）
    // 与 L9–L11 同类：**启动 env 里必须多带一个键**，否则真机必挂，而且挂的地方看着毫不相干。
    // 不加它时（实测链路）：Windows 上 Python 子进程的 stdio 按 ANSI 代码页（中文机 = GBK/cp936）
    // 编码 ⇒ 引擎写进日志的**日文**（`utils/log.py` 把 root StreamHandler 接到了 stderr）是
    // **非法 UTF-8 字节** ⇒ 上层按行读日志的一端读到非法字节就**停读并关掉管道读端** ⇒
    // 引擎**再写 stderr** 报 `OSError: [Errno 22] Invalid argument`（冒出来的是 `tqdm` 初始化
    // 那句 `sys.stderr.flush()`）⇒ 整张图在「掩码细化」处失败。
    // ⚠️ 同样用**受控 env**：先清掉这台机器上可能已有的 `PYTHONIOENCODING`，
    //    否则"本机恰好设了 utf-8"会让它在**没有注入**时也变绿（与 L9 同一个假绿家族）。
    const savedPio = process.env.PYTHONIOENCODING;
    delete process.env.PYTHONIOENCODING;
    const ioLaunch = resolveEngineLaunch({ port: enginePort });
    restoreEnv('PYTHONIOENCODING', savedPio);
    check('L12 启动 env 强制 `PYTHONIOENCODING=utf-8`（引擎 stdio 必须是 UTF-8）—— 否则中文 Windows 下 GBK 日文日志会让上层读日志的一端停读、关掉管道，引擎随后写 stderr 报 `[Errno 22] Invalid argument`（D-88）',
      String(ioLaunch.env.PYTHONIOENCODING || '').toLowerCase() === 'utf-8',
      `PYTHONIOENCODING=${ioLaunch.env.PYTHONIOENCODING}`);

    // ---------------------------------------------------------- L13/L14 · HF 离线 env（B3）
    // 与 L9–L12 同类：**启动 env 里必须多带一对键**。差别是它**依赖盘上状态**
    // （权重在 ⇒ 带上；不在 ⇒ 不带上，否则会把首次下载一并堵死）—— 所以分两层打：
    // L13 打纯函数（三种情形，与机器无关）；L14 打"这一项真的被合进了启动 env"。
    const hfOn = JSON.stringify(engineHfOfflineEnv({ present: true }));
    const hfOff = JSON.stringify(engineHfOfflineEnv({ present: false }));
    const hfDis = JSON.stringify(engineHfOfflineEnv({ present: true, disabled: true }));
    check('L13 权重在盘 ⇒ 带 `HF_HUB_OFFLINE=1` + `TRANSFORMERS_OFFLINE=1`；不在盘 ⇒ 不带；`MIAO_NO_HF_OFFLINE=1` ⇒ 不带',
      hfOn === JSON.stringify({ HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }) && hfOff === '{}' && hfDis === '{}',
      `on→${hfOn} off→${hfOff} disabled→${hfDis}（本机权重在盘=${translationWeightsPresent()}）`);

    // L14 是 L13 的**落点**：函数算得对 ≠ 真被合进启动 env（"算出来了但没接上"是常见的半成品形态）。
    // 用注入把这一项从"本机恰好有权重"里解耦 —— 否则在没有权重的机器上这条断言恒真空绿。
    const hfLaunch = resolveEngineLaunch({
      port: enginePort,
      hfOffline: { HF_HUB_OFFLINE: 'injected', TRANSFORMERS_OFFLINE: 'injected' },
    });
    check('L14 `resolveEngineLaunch` 的 env **真的**合入了 HF 离线项（不是算完就丢），且可注入覆盖',
      hfLaunch.env.HF_HUB_OFFLINE === 'injected' && hfLaunch.env.TRANSFORMERS_OFFLINE === 'injected',
      `HF_HUB_OFFLINE=${hfLaunch.env.HF_HUB_OFFLINE}`);

    // ---------------------------------------------------------- C · 生效参数快照（§5.2 的 `config` 块）
    const snap = engineConfigSnapshot();
    check('C1 `config` 是 **camelCase** 的 7 键（`fromLang` / `targetLang` / `detectionSize`）—— 发出去的是 snake_case、报出来的是 camelCase，两个形状必须出自同一处（跨层字段名漂移的挡板）',
      ['translator', 'fromLang', 'targetLang', 'detector', 'detectionSize', 'ocr', 'inpainter'].every((k) => k in snap)
      && !('from_lang' in snap) && !('target_lang' in snap) && !('detection_size' in snap),
      JSON.stringify(snap));
    check('C2 快照值与 `config.engineConfig`（基线）**逐项一致** —— 不是另抄一遍字面量（抄两遍 = 等它们走散）。`fromLang` 报的是基线（`null` = 基线不钉源语言、逐任务下发），不是某个任务的方向',
      snap.translator === config.engineConfig.translator.translator
      && snap.fromLang === (config.engineConfig.translator.from_lang ?? null)
      && snap.targetLang === config.engineConfig.translator.target_lang
      && snap.detector === config.engineConfig.detector.detector
      && snap.ocr === config.engineConfig.ocr.ocr
      && snap.inpainter === config.engineConfig.inpainter.inpainter,
      JSON.stringify({ snap, sent: config.engineConfig }));
    check('C3 未显式下发 `detection_size` 时，报的是**引擎默认值** 2048（`manga_translator/config.py:276`）—— 而不是"我们设的 2048"',
      config.engineConfig.detector.detection_size === undefined
      && snap.detectionSize === ENGINE_DEFAULT_DETECTION_SIZE,
      `detectionSize=${snap.detectionSize} default=${ENGINE_DEFAULT_DETECTION_SIZE}`);
    // 显式下发 ⇒ 快照跟着变。**另起进程**：env 在 `config.mjs` 顶层读，本进程改不动它。
    const cExplicit = spawnSync(process.execPath, ['-e',
      `import(${JSON.stringify(pathToFileURL(ENGINE_CLIENT).href)}).then(m=>console.log('DS='+JSON.stringify(m.engineConfigSnapshot().detectionSize))).catch(e=>console.log('ERR='+e.message));`,
    ], { env: { ...process.env, MIAO_ENGINE_DETECTION_SIZE: '1024' }, encoding: 'utf8' });
    check('C4 显式下发 `MIAO_ENGINE_DETECTION_SIZE=1024` ⇒ 快照报 1024（"不下发=用引擎默认"与"下发一个值"是两回事）',
      /DS=1024/.test(cExplicit.stdout), cExplicit.stdout.trim() || cExplicit.stderr.trim());

    // ---------------------------------------------------------- V · 阶段日志（§5.2 的 recentStageLog）
    // 假引擎在每个结果帧前发一条 code 1 进度帧（`检测中…`），等价于真引擎
    // `_report_progress('detection'|'ocr'|'inpainting'…)` 送出的阶段名。
    const stage = recentStageLog(50);
    check('V1 结果流里的 code 1 进度帧被记进 recentStageLog，格式 `seq N: <引擎原话>`（**不做改名映射** —— 映射了就会在引擎改阶段名时继续说旧名）',
      stage.includes('seq 7: 检测中…'), JSON.stringify(stage.slice(-5)));
    check('V2 记的是**服务端**的 seq 而不是引擎的序号，且每行都是 `seq N: …` 形状（同一张图的多个阶段各自一行）',
      stage.length > 0 && stage.every((l) => /^seq \d+: \S/.test(l)), JSON.stringify(stage.slice(-3)));

    // ---------------------------------------------------------- D · 默认值与取值校验
    // 必须**另起进程**且**不带** MIAO_ENGINE_PROTOCOL：本进程已把它设成 real，测不出默认值
    const cleanEnv = { ...process.env };
    delete cleanEnv.MIAO_ENGINE_PROTOCOL;
    cleanEnv.MIAO_TOKEN = 'e'.repeat(64);
    cleanEnv.MIAO_STATE_DIR = path.join(TMP, 'state2');
    const dDefault = spawnSync(process.execPath, ['-e',
      `import(${JSON.stringify(pathToFileURL(CONFIG_FILE).href)}).then(m=>console.log('PROTO='+m.config.engineProtocol)).catch(e=>console.log('ERR='+e.message));`,
    ], { env: cleanEnv, encoding: 'utf8' });
    check('D1 **默认协议是 real**（生产不许走替身；跑测试才显式声明 mock）',
      /PROTO=real/.test(dDefault.stdout), dDefault.stdout.trim() || dDefault.stderr.trim());

    const dBogus = spawnSync(process.execPath, ['-e',
      `import(${JSON.stringify(pathToFileURL(CONFIG_FILE).href)}).then(()=>console.log('NO_THROW')).catch(e=>console.log('THREW:'+e.message));`,
    ], { env: { ...cleanEnv, MIAO_ENGINE_PROTOCOL: 'bogus' }, encoding: 'utf8' });
    check('D2 协议取值非法 → **启动即抛错**（不静默回退：静默回退会让"以为在测 mock、其实走了 real"变成假绿）',
      /THREW:.*取值非法/.test(dBogus.stdout), dBogus.stdout.trim() || dBogus.stderr.trim());

    check('D3 超时按协议分档：real 默认 10 min（实测单张 1.6 min 的 ~6× 余量），mock 仍 60 s',
      config.engineTimeoutMs === 1200 // 本进程注入了覆盖值，故这里验证的是"注入生效"
      || config.engineTimeoutMs === 600_000, String(config.engineTimeoutMs));

    // ---------------------------------------------------------- M · mock 协议冒烟（子进程）
    const mockPort = await findFreePortPair(enginePort + 100);
    const mockChild = spawn(process.execPath, [MOCK_ENGINE], {
      env: { ...process.env, MIAO_ENGINE_PORT: String(mockPort), MIAO_ENGINE_ITEM_MS: '20' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let mockOut = '';
    mockChild.stdout.on('data', (d) => { mockOut += d.toString(); });
    mockChild.stderr.on('data', (d) => { mockOut += d.toString(); });
    const mockReady = await (async () => {
      for (let i = 0; i < 100; i += 1) {
        if (/MIAO_ENGINE_READY/.test(mockOut)) return true;
        await sleep(60);
      }
      return false;
    })();
    let mPass = 0;
    let mFail = 2;
    let mDetail = '模拟引擎未就绪';
    if (mockReady) {
      const child = spawnSync(process.execPath, [import.meta.filename, '--mock-child'], {
        env: {
          ...process.env,
          MIAO_ENGINE_PROTOCOL: 'mock',
          MIAO_ENGINE_PORT: String(mockPort),
          MIAO_ENGINE_PROBE_MS: '800',
        },
        encoding: 'utf8',
      });
      const line = (child.stdout || '').split('\n').find((l) => l.startsWith('[RESULT] '));
      if (line) {
        const parsed = JSON.parse(line.slice('[RESULT] '.length));
        mPass = parsed.pass;
        mFail = parsed.fail;
        const m1 = matchById(parsed.results, 'M1');
        const m1b = matchById(parsed.results, 'M1b');
        const m2 = matchById(parsed.results, 'M2');
        check('M1 mock 协议：probeEngine 为 running（起的是真正的模拟引擎）', !!m1?.ok, m1?.detail);
        check('M1b mock 协议：engineVersion 报 `mock`（不冒充上游 commit）', !!m1b?.ok, m1b?.detail);
        check('M2 mock 协议：translateImage 返回可识别译文图（嗅探 ext=png）', !!m2?.ok, m2?.detail);
      } else {
        check('M1 mock 协议：probeEngine 为 running（起的是真正的模拟引擎）', false, '子进程未产出结果行');
        check('M1b mock 协议：engineVersion 报 `mock`（不冒充上游 commit）', false, '子进程未产出结果行');
        check('M2 mock 协议：translateImage 返回可识别译文图（嗅探 ext=png）', false, child.stdout?.slice(-200));
      }
      check('M3 mock 子进程自报分母（3 条全绿）',
        mPass + mFail === 3 && mFail === 0, `${mPass}/${mPass + mFail}`);
    } else {
      check('M1 mock 协议：probeEngine 为 running（起的是真正的模拟引擎）', false, mDetail);
      check('M1b mock 协议：engineVersion 报 `mock`（不冒充上游 commit）', false, mDetail);
      check('M2 mock 协议：translateImage 返回可识别译文图（嗅探 ext=png）', false, mDetail);
      check('M3 mock 子进程自报分母（3 条全绿）', false, mDetail);
    }
    try { mockChild.kill('SIGTERM'); } catch { /* ignore */ }
  } finally {
    fake.server.closeAllConnections?.();
    await new Promise((r) => fake.server.close(r));
    if (executorUp) { executor.closeAllConnections?.(); await new Promise((r) => executor.close(r)); }
  }
}

// ================================================================ 反证轮

/**
 * 每条破坏**只针对一个机制**，期望的变红集合写在 `expect` 里。
 * 分母（应执行的破坏条数）在脚本里写死 —— 比率型指标会吞掉分母变化（AGENTS.md §2-1）。
 */
const MUTATIONS = [
  {
    name: 'A · data URI 的 mime 写死成 png（不再取自字节嗅探）',
    file: ENGINE_CLIENT,
    find: "image: `data:${mimeOfExt(ext)};base64,${bytes.toString('base64')}`,",
    replace: "image: `data:image/png;base64,${bytes.toString('base64')}`,",
    expect: ['R5'],
  },
  {
    name: 'B · 就绪判定砍掉「执行器端口」这一层（只看到 HTTP 就算 running）',
    file: ENGINE_CLIENT,
    find: 'const executorUp = await probeTcp(host, port + 1, probeMs);',
    replace: 'const executorUp = true;',
    expect: ['P4'],
  },
  {
    name: 'C · 默认协议改回 mock（生产就走替身了）',
    file: CONFIG_FILE,
    find: "const ENGINE_PROTOCOL = envEnum('MIAO_ENGINE_PROTOCOL', ENGINE_PROTOCOLS, 'real');",
    replace: "const ENGINE_PROTOCOL = envEnum('MIAO_ENGINE_PROTOCOL', ENGINE_PROTOCOLS, 'mock');",
    expect: ['D1'],
  },
  {
    name: 'D · 存活探针改回 `GET /queue-size`（真引擎是 POST ⇒ 405，而 405 长得像"引擎没就绪"）',
    file: ENGINE_CLIENT,
    find: "const res = await requestOnce('/queue-size', { method: 'POST', timeoutMs: probeMs });",
    replace: "const res = await requestOnce('/queue-size', { method: 'GET', timeoutMs: probeMs });",
    expect: ['P2', 'R12'],
  },
  {
    name: 'E · 结果流"整包当图"（不按 5 字节帧解析）',
    file: ENGINE_CLIENT,
    find: '    if (code === 0) result = data;',
    replace: '    if (code === 0) result = body;',
    expect: ['R4', 'R14'],
  },
  {
    name: 'F · 参数快照报回 snake_case（跨层字段名漂移：诊断视图报 `target_lang`，契约 §5.2 要的是 `targetLang`）',
    file: ENGINE_CLIENT,
    find: '    targetLang: c.translator?.target_lang ?? null,',
    replace: '    target_lang: c.translator?.target_lang ?? null,',
    expect: ['C1', 'C2'],
  },
  {
    name: 'G · `detectionSize` 忽略下发值、写死引擎默认（"不下发"与"下发 2048"被混为一谈）',
    file: ENGINE_CLIENT,
    find: '    detectionSize: c.detector?.detection_size ?? ENGINE_DEFAULT_DETECTION_SIZE,',
    replace: '    detectionSize: ENGINE_DEFAULT_DETECTION_SIZE,',
    expect: ['C4'],
  },
  {
    name: 'H · 阶段日志做改名映射（记 `detect` 而不是引擎原话 `检测中…`）',
    file: ENGINE_CLIENT,
    // ⚠️ 锚点已随源码重构更新：结果为帧的遍历从 `for (const f of frames) … pushStage(…)`
    //    改成了 `recordFrame(seq, f)`，真正记阶段名的是 `recordFrame` 里的这一句。
    //    旧锚点（`if (f.code === 1 && f.text)`）在源码里**已不存在**，于是这条变异长期恒报
    //    「锚点未找到」= 反证轮分母虚高（分母 9 而实际只跑得动 8），却看着像"跑过了"。
    find: '  if (frame.code === 1) pushStage(seq, frame.text);',
    replace: "  if (frame.code === 1) pushStage(seq, 'detect');",
    expect: ['V1'],
  },
  {
    name: 'I · 引擎启动 env 不再注入本机代理旁路（用户/沙箱挂了代理就把本机 8080 推理链路劫走：D-86）',
    file: ENGINE_CLIENT,
    // 不带行尾：本文件是 CRLF，锚点里写死 `\n` 会在匹配前就失败（写死 `\r\n` 又会在改用 LF 时失败）。
    find: '      ...engineLocalNoProxy(),',
    replace: '',
    expect: ['L9', 'L10', 'L11'],
  },
  {
    name: 'J · 引擎启动 env 不再强制 stdio 用 UTF-8（中文 Windows 下 GBK 日文日志会把读日志的一端打死：D-88）',
    file: ENGINE_CLIENT,
    // 不带行尾：本文件是 CRLF，锚点里写死 `\n` 会在匹配前就失败（同变异 I 的理由）。
    find: "      PYTHONIOENCODING: 'utf-8',",
    replace: '',
    expect: ['L12'],
  },
  {
    name: 'K · 引擎启动 env 不再合入 HF 离线项（权重已预置却仍去联网取 etag ⇒ 被系统代理拦成 502：B3）',
    file: ENGINE_CLIENT,
    // 不带行尾：本文件是 CRLF（同变异 I/J 的理由）。
    find: '      ...(hfOffline === undefined ? engineHfOfflineEnv() : hfOffline),',
    replace: '',
    expect: ['L14'],
  },
  {
    name: 'L · 请求体退回发 `config.engineConfig` 常量（逐任务方向被丢掉 ⇒ 英译中被当日语送进引擎：ver2.1 C2）',
    file: ENGINE_CLIENT,
    find: '    config: buildEngineConfig({ lang: langOf(opts) }),',
    replace: '    config: config.engineConfig,',
    expect: ['R16', 'R17'],
  },
];

const EXPECTED_MUTATIONS = 12; // 分母写死

function sha(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

async function runRefute() {
  console.log('S1 适配层断言 · 反证轮');
  console.log(`破坏源文件 → 断言必须变红 → 按字节恢复（应执行 ${EXPECTED_MUTATIONS} 条）\n`);

  const restored = [];
  const restoreAll = () => {
    for (const r of restored) {
      if (r.done) continue;
      fs.writeFileSync(r.file, r.bytes);
      r.done = true;
    }
  };
  // 信号也要恢复 —— 被超时杀掉就跳过恢复的话，源文件会停在破坏状态，
  // 而残留会让**下一次**反证变成"锚点未找到 → 跳过"，表现为分母忽大忽小。
  const onSignal = () => { restoreAll(); process.exit(130); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let executed = 0;
  let asExpected = 0;
  const problems = [];

  try {
    for (const mut of MUTATIONS) {
      const original = fs.readFileSync(mut.file);
      const record = { file: mut.file, bytes: original, done: false };
      restored.push(record);
      const before = sha(mut.file);
      const txt = original.toString('utf8');
      if (!txt.includes(mut.find)) {
        problems.push(`${mut.name}：锚点未找到（源文件已变？）`);
        continue;
      }
      fs.writeFileSync(mut.file, txt.replace(mut.find, mut.replace));

      const child = spawnSync(process.execPath, [import.meta.filename], { encoding: 'utf8' });
      const line = (child.stdout || '').split('\n').find((l) => l.startsWith('[RESULT] '));
      fs.writeFileSync(mut.file, original);
      record.done = true;
      const after = sha(mut.file);
      if (before !== after) problems.push(`${mut.name}：恢复后字节不一致（${before} ≠ ${after}）`);

      executed += 1;
      if (!line) {
        problems.push(`${mut.name}：子进程未产出结果行（stdout 尾部：${(child.stdout || '').slice(-200)}）`);
        console.log(`⚠ ${mut.name}\n    子进程没有结果行`);
        continue;
      }
      const parsed = JSON.parse(line.slice('[RESULT] '.length));
      const redIds = mut.expect.filter((code) => matchById(parsed.results, code)?.ok === false);
      const missed = mut.expect.filter((code) => matchById(parsed.results, code)?.ok !== false);
      console.log(`🔴 ${mut.name}`);
      for (const code of mut.expect) {
        const hit = matchById(parsed.results, code);
        console.log(`   ${hit?.ok === false ? '✓' : '✗'} ${code} ${hit?.ok === false ? '按预期变红' : `**没有变红**（${hit ? hit.detail : '缺该条'}）`}`);
      }
      if (missed.length === 0) asExpected += 1;
      else problems.push(`${mut.name}：${missed.join(',')} 未变红`);
    }
  } finally {
    restoreAll();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`反证：${asExpected} / ${EXPECTED_MUTATIONS} 条按预期变红（应执行 ${EXPECTED_MUTATIONS}）`);
  if (executed !== EXPECTED_MUTATIONS || asExpected !== EXPECTED_MUTATIONS) {
    console.log('\n下面是未达预期的条目：');
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exitCode = 1;
  } else if (problems.length) {
    console.log('\n（有附注：）');
    for (const p of problems) console.log(`  ⚠ ${p}`);
  }
}

// ================================================================ 入口

if (REFUTE) {
  await runRefute();
} else {
  console.log('S1 适配层（service/src/engine-client.mjs）契约断言');
  console.log(`引擎协议：real（真协议假引擎 @ 动态端口） + mock（真模拟引擎）`);
  // 兜底：即使 `runPositive` 里某处漏保护抛了错，也必须**照常吐结果行**。
  // 否则反证轮收到的是"没有结果行"，会被读成"破坏没生效"，而真相是脚本崩了。
  try {
    await runPositive();
  } catch (err) {
    check('RUN 断言脚本未预期崩溃（视为失败：脚本崩溃 ≠ 断言通过）', false, errText(err));
  }
  printResults('汇总（R real调用 · P 就绪三态 · L 启动参数 · C 参数快照 · V 阶段日志 · D 默认值 · M mock冒烟）');
  process.exitCode = out.fail === 0 ? 0 : 1;
}
