#!/usr/bin/env node
/**
 * ver2.2 · 在线翻译服务 · **假上游正反断言脚本**（方案 §10 验收计划）
 * =============================================================================
 *
 * ## 验什么
 * `service/src/manga/translate/**` 一族（门面 / 注册表 / 契约 / 设置三层 / 密钥隔离 /
 * 错误归一 / 五层超时 / 限流 / 流式解析）+ `server.mjs` 的 5 条 `/api/v1/translate/*` 路由。
 * 断言分七组，每组一条硬纪律：
 *
 * | 组 | 条数 | 验什么 | 纪律 |
 * |---|---|---|---|
 * | S  | 16 | 签名 v3 与两接口协议（截断 / salt 防重放 / 字段集 / 判成功 / 错误码表 / SSE 帧解析 / 半包尾包 / 零帧兜底） | §5 / §7.2 |
 * | T  | 4  | connect / ttfb / idle / total 四层超时**互不混淆**（`details.stage` 归因） | §7.1 |
 * | L  | 2  | 令牌桶并发 3 + QPS 10；排队超时归 429 而不是 504 | §7.4 |
 * | C  | 6  | 三层设置（env > 文件 > 默认）+ 双向不对称校验 + 坏文件不阻断 | §8.1/§8.2 |
 * | K  | 4  | 密钥隔离：只写不读回显、缺密钥不出网、保存校验与原子写 | §8.3 |
 * | A  | 12 | 契约与适配器：未知平台 / 能力协商 / 语言码不猜 / 参数裁剪 / 首块锁定 / 非 2xx 先判死 | §4 / §5.4 / §7.3 |
 * | R  | 8  | 路由端到端：真起一个 box-service 子进程，5 条路由 + 鉴权 + SSE 三事件 | §6.3 |
 *
 * ## 为什么是「假上游」而不是真有道
 * 真上游要**联网 + 真密钥 + 按量计费**，且不可重放（同一 salt 第二次必被 207 挡回）——
 * 那意味着"重试路径""防重放""签名算错"这三类最关键的行为**一次都没法验**。
 * 本脚本在进程内起一个 `http.Server(127.0.0.1:0)` 冒充有道：同一套签名算法**独立再实现一遍**
 * 用来验签（两边算法不一致 ⇒ 假上游自己先说清），并按 `salt` 记账实现真防重放。
 * 于是"我们这边签名算错""salt 复用""字段名拼错"都会以**确定的**上游错误码回来，
 * 而不是靠运气。
 *
 * ## 八条反证开关各护什么（`--refute` 轮，一个开关一个子进程）
 * `refute.mjs` 在**模块顶层**读 env ⇒ 进程内不可回滚 ⇒ 每个开关必须另起子进程
 * （`engine-settings-check.mjs` 的同款纪律）。子进程跑**同一套正向断言**，
 * 指定的那几条必须变红，且**只能**红那几条。
 *
 * ## 两条自设纪律（否则断言会互相污染）
 * ① 除 S1 外，每次调用的 text 都 ≤20 字符 —— 只有 S1 需要 >20 字符去触发签名截断，
 *    别的用例一超 20 就会在 `NO_TRUNCATE` 反证轮里被顺带打红，归因就散了。
 * ② 每次调用的 text 全局唯一（计数器拼后缀）—— 假上游按 `salt` 防重放，
 *    而 salt 由我们生成；但**同一 text 发两次**在 `REUSE_SALT` 开关下会撞 207，
 *    在正向轮里也会让"两次请求"的取证混在一起。唯一 text 让每条断言能按 text 反查记账。
 *
 * 用法：
 *   node e2e/service/translate-check.mjs            正向轮
 *   node e2e/service/translate-check.mjs --refute   反证轮（8 个开关 → 8 个子进程）
 *
 * 约束：纯 Node、零第三方依赖；**禁止静态 import 任何 translate 模块**（env 必须先布置）；
 *       临时目录自建自清（成功即清、失败保留并打印路径）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// F0：服务入口解析的唯一事实源（MIAO_SERVICE_IMPL=node|rust 切换靶子）
import { SERVICE_ENTRY, spawnTarget } from './_service-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = path.join(ROOT, 'e2e', 'service', 'translate-check.mjs');
const TR = path.join(ROOT, 'service', 'src', 'manga', 'translate');
const IS_CHILD = process.argv.includes('--refute-child');
const IS_REFUTE_PARENT = process.argv.includes('--refute') && !IS_CHILD;
const TOKEN = 't'.repeat(64);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-translate-'));
const STATE_DIR = path.join(TMP, 'state');
const SETTINGS_FILE = path.join(STATE_DIR, 'translate-settings.json');
const CREDENTIALS_FILE = path.join(STATE_DIR, 'translate-credentials.json');
/** 测试密钥（方案 §10：`ak-e2e` + `sk-e2e-secret`；假上游只认这一对） */
const TEST_APP_KEY = 'ak-e2e';
const TEST_APP_SECRET = 'sk-e2e-secret';
/** 黑洞地址候选（RFC 5737 保留段 / RFC 1918 不可达段）：连上去**挂住**不报错，用来验 connect 层 */
const BLACKHOLE_CANDIDATES = ['192.0.2.1', '10.255.255.1', '198.51.100.1'];

// ------------------------------------------------------------------ 条数分母（写死自检）
// 🔴 每个数字都要与实际写出来的断言条数一致 —— 少写一条就静默少验一条，
//    而"少验"在输出里完全看不出来（AGENTS.md §2-4：看着覆盖、实则空转）。
const EXPECTED_S = 16;
const EXPECTED_T = 4;
const EXPECTED_L = 2;
const EXPECTED_C = 6;
const EXPECTED_K = 4;
const EXPECTED_A = 12;
const EXPECTED_R = 8;

// ------------------------------------------------------------------ hermetic 基线
// 🔴 必须在**任何** translate 模块被 import 之前跑：`refute.mjs` 在模块顶层读 env，
//    `platforms/youdao.mjs` 的 `baseUrl()` / `envMs()` 每次调用现读 env。
//    从 shell / 父进程漏进来的任何一个 `MIAO_TRANSLATE_*` / `MIAO_YOUDAO_*` 都会把
//    "产品路径"偷偷换成夹具路径，而那种失败极难归因（夹具自己没改任何东西）。
// ⚠️ 反证子进程要保留 `MIAO_TRANSLATE_REFUTE_*` —— 删了它，反证轮就变成正向轮，
//    于是"每条开关都 0 条变红"，看上去像破坏没生效，其实是开关根本没打开。
for (const k of Object.keys(process.env)) {
  if (k.startsWith('MIAO_TRANSLATE_') || k.startsWith('MIAO_YOUDAO_')) {
    if (IS_CHILD && k.startsWith('MIAO_TRANSLATE_REFUTE_')) continue;
    delete process.env[k];
  }
}

// ------------------------------------------------------------------ 结果收集
// 范式照抄 `engine-client-check.mjs`：`check` / `attempt` / `matchById` / `printResults`
// + 一条机器可读的 `[RESULT]` 行（反证轮的父进程只认这一行）。

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}

/**
 * 调产品代码的**唯一安全入口**：把抛错转成"可记录的失败"，而不是打死进程。
 * 🔴 反证轮要的是"破坏后断言**变红**"。若被测代码一抛错就把脚本带走，反证轮只能看到
 *    "子进程没有结果行" —— 那是「断言炸了」，与「断言变红」是两件事，必须分开。
 */
async function attempt(fn) {
  try { return { value: await fn(), err: null }; }
  catch (err) { return { value: null, err }; }
}

/** 调用抛错时的可读说明（`attempt()` 配套） */
function errText(err) {
  if (!err) return '';
  const d = err.details ? ` details=${JSON.stringify(err.details)}` : '';
  return `抛错 ${err.code || err.name}: ${err.message}${d}`;
}

/** 断言 id 形如 `「短码」 描述`；反证轮的 expectRed 只写短码，必须按前缀匹配 */
function matchById(list, code) {
  return list.find((r) => r.id === code || r.id.startsWith(`${code} `));
}

function printResults(title) {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n### ${title}`);
  for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.id}${r.detail ? `  ${r.detail}` : ''}`);
  console.log(`[RESULT] ${JSON.stringify({ results, pass, fail })}`);
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  return { pass, fail };
}

// ------------------------------------------------------------------ 小工具

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const dynImport = (p) => import(pathToFileURL(p).href);

/** 全局计数器：**每次翻译调用的 text 都不重样**（见文件头纪律②） */
let seq = 0;
const nextN = () => { seq += 1; return String(seq).padStart(3, '0'); };
const nextText = (tag) => `${tag}${nextN()}`;
/** 内容触发文本：`__T_<TOKEN>__<序号>`（≤20 字符，见文件头纪律①） */
const trig = (token) => `__T_${token}__${nextN()}`;
const LONG_LEN = 30;
/** S1 专用长文本：精确 30 字符（>20 才会走签名截断） */
const longText = () => `L${nextN()}${'M'.repeat(LONG_LEN - 4)}`;

/** 临时改 env（`baseUrl()` / `envMs()` 每次现读，所以这是唯一能切超时档/切址的办法） */
async function withEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) { saved[k] = process.env[k]; process.env[k] = patch[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(patch)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** 临时切假上游模式（`holdMs` 仅 stall / slow-head-hold 用） */
async function withMode(mode, holdMs, fn) {
  const m = fake.state.mode;
  const h = fake.state.holdMs;
  fake.state.mode = mode;
  fake.state.holdMs = holdMs || 0;
  try { return await fn(); } finally { fake.state.mode = m; fake.state.holdMs = h; }
}

/** 临时把门面的两个盘上文件指到别处（C1/K4 要用干净的目录） */
async function withConfigure(files, fn) {
  mods.index.configureTranslate(files);
  try { return await fn(); } finally {
    mods.index.configureTranslate({ settingsFile: SETTINGS_FILE, credentialsFile: CREDENTIALS_FILE });
  }
}

// ------------------------------------------------------------------ 网络小工具

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function findFreePort(start) {
  for (let p = start; p < start + 400; p += 1) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`从 ${start} 起 400 个端口全部被占用`);
}

/**
 * 探一个地址是否"挂住"（SYN 发出去石沉大海）：既没连上也不报错。
 * 只有这种地址能验 connect 层 —— 连上但不回话是 ttfb 层，立刻拒了是 ECONNREFUSED。
 */
function probeHang(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { s.destroy(); } catch { /* ignore */ } resolve(v); } };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(false));
    s.once('timeout', () => done(true));
    s.once('error', () => done(false));
  });
}

let blackholeCache;
async function findBlackhole() {
  if (blackholeCache !== undefined) return blackholeCache;
  for (const host of BLACKHOLE_CANDIDATES) {
    if (await probeHang(host, 443, 400)) { blackholeCache = host; return host; }
  }
  blackholeCache = null;
  return null;
}

// ------------------------------------------------------------------ 假上游

/** 内容触发 → **上游业务错误码**（按 path 选形状回：text 回 errorCode，llm 回 code） */
const ERR_TRIGGERS = {
  E101: '101', E103: '103', E108: '108', E202: '202',
  E301: '301', E302: '302', E304: '304', E310: '310',
  E401: '401', E411: '411', E412: '412', E999: '999',
  E1: '1', E206: '206', E902000: '902000',
};
/** 内容触发 → **响应形态** */
const MODE_TRIGGERS = {
  M500G: 'http500-garbage', MSTALL: 'stall', MHANG: 'hang-head',
  MNEVER: 'never-end', MHOLD: 'slow-head-hold', MBREAK: 'ok-then-break',
  MHALF: 'half-packet', MTAIL: 'tail-packet', MNOOK: 'no-success',
};

/**
 * 「真协议假上游」：只实现有道两接口的契约面。
 *
 * ## 记账（断言**不信自报**，只信这里的账）
 * `hits[]` 每条含 `api / path / fields / contentType / salt / curtime / sign / signOk / at` ——
 * "字段名拼错""Content-Type 不对""salt 复用""重试了几次"全部以它为准。
 * `signOk` 是**这一条请求自己的**验签结果：断言只认自己那一条，不认全局 `badSign` 计数 ——
 * 全局计数会被"故意签错"的用例（S1，以及 NO_TRUNCATE 反证轮）污染，
 * 跟在后面的断言会跟着红，"这条开关到底打坏了什么"就说不清了（假绿纪律：归因必须单线）。
 * `badSign` 全程验签失败总次数（只在 RUN 行做汇总展示）；`seenSalts` 真防重放；
 * `peakInflight` 在飞数峰值（限流取证）。
 *
 * ## 处理顺序（顺序即语义）
 * ① 验签（独立再实现一遍 `input = len(q)<=20 ? q : 前10+len+后10`）不一致 → 202
 * ② 防重放：salt 见过 → 207
 * ③ 内容触发：`__T_<TOKEN>__` 决定这一次回什么（错误码 / 响应形态）
 * ④ 模式分发（默认 ok）
 */
function createFakeUpstream() {
  const DEFAULT_DELTAS = ['甲', '乙', '丙'];
  const state = {
    mode: 'ok',            // ok | hang-head | never-end | slow-head-hold | ok-then-break | half-packet | tail-packet | http500-garbage | stall | no-success
    holdMs: 0,
    llmDeltas: DEFAULT_DELTAS,
    llmLangType: 'zh-CHS',
    /** 最近一次 llm 回话写给客户端的**原始字节**（S14 取证：证明假上游发的是真 SSE 帧） */
    lastLlmRaw: '',
    hits: [],
    badSign: 0,
    seenSalts: new Set(),
    first303: new Set(),
    inflight: 0,
    peakInflight: 0,
  };

  /** 与服务端**同一套算法、独立实现一遍**：两边不一致 ⇒ 假上游自己先说清 */
  const signExpect = (q, salt, curtime) => {
    const input = q.length <= 20 ? q : `${q.slice(0, 10)}${q.length}${q.slice(-10)}`;
    return sha(TEST_APP_KEY + input + salt + curtime + TEST_APP_SECRET);
  };

  /**
   * llm 回话按**真实有道的 SSE 帧**发：`event:message\ndata:{...}\n\n`。
   * 🔴 D-130：旧假上游发的是"裸 JSON 行"，与真上游（SSE 帧）不一致 ⇒ 断言全绿却验不出
   *    解析器读不了 SSE 帧。假上游从此以真形态回话；`line-json` 模式单独保留，用来验
   *    "两种形态都要吃得下"。
   */
  const sseFrame = (obj) => `event:message\ndata:${JSON.stringify(obj)}\n\n`;

  const replyErr = (res, isLlm, code) => {
    const body = isLlm
      ? sseFrame({ code, msg: 'injected by fake upstream' })
      : JSON.stringify({ errorCode: code, query: 'injected by fake upstream' });
    if (isLlm) state.lastLlmRaw = body;
    res.writeHead(200, {
      'Content-Type': isLlm ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
    });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    res.on('error', () => { /* 客户端已走：不让它变成 unhandled 'error' 打死进程 */ });
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const pathname = String(req.url || '').split('?')[0];
      const isLlm = pathname === '/proxy/http/llm-trans';
      const fields = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      const q = String(isLlm ? (fields.i ?? '') : (fields.q ?? ''));
      const salt = String(fields.salt ?? '');
      const curtime = String(fields.curtime ?? '');

      state.inflight += 1;
      if (state.inflight > state.peakInflight) state.peakInflight = state.inflight;
      // 每条 hit 记**自己这条请求**的验签结果（理由见上面 signOk 注释）
      const signOk = signExpect(q, salt, curtime) === String(fields.sign ?? '');
      state.hits.push({
        api: isLlm ? 'llm' : 'text',
        path: pathname,
        fields,
        contentType: String(req.headers['content-type'] || ''),
        salt, curtime, sign: String(fields.sign ?? ''), signOk,
        at: Date.now(),
      });
      let released = false;
      res.on('close', () => { if (!released) { released = true; state.inflight = Math.max(0, state.inflight - 1); } });

      // ① 验签
      if (!signOk) {
        state.badSign += 1;
        replyErr(res, isLlm, '202');
        return;
      }
      // ② 防重放（salt 每次请求都必须重新生成，否则必撞这里）
      if (state.seenSalts.has(salt)) { replyErr(res, isLlm, '207'); return; }
      state.seenSalts.add(salt);

      // ③ 内容触发
      const tm = /__T_([A-Z0-9]+)__/.exec(q);
      const token = tm ? tm[1] : '';
      if (token === 'M303F') {
        // 第一次 303（可重试），之后正常 —— 用来验"重试真的发生了且换了 salt"
        if (!state.first303.has(q)) { state.first303.add(q); replyErr(res, isLlm, '303'); return; }
      }
      if (Object.prototype.hasOwnProperty.call(ERR_TRIGGERS, token)) {
        replyErr(res, isLlm, ERR_TRIGGERS[token]);
        return;
      }
      let mode = state.mode;
      let oneLine = false;
      if (Object.prototype.hasOwnProperty.call(MODE_TRIGGERS, token)) mode = MODE_TRIGGERS[token];
      if (token === 'M1LINE') oneLine = true;

      const safeWrite = (chunk) => {
        if (res.destroyed || res.writableEnded) return false;
        try { return res.write(chunk); } catch { return false; }
      };

      /** 正常回话：text 回整体 JSON；llm 回**真实有道的 SSE 帧**（`event:message` + `data:`） */
      const replyOk = () => {
        if (isLlm) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          const objOf = (d, i) => ({
            code: '0', successful: true,
            data: { transIncre: d, ...(i === 0 ? { langType: state.llmLangType } : {}) },
          });
          if (mode === 'line-json') {
            // 兼容协议：裸 JSON 行（**不是**真上游形态；单独留着验"两种都要吃得下"）
            state.lastLlmRaw = state.llmDeltas.map((d, i) => `${JSON.stringify(objOf(d, i))}\n`).join('');
            safeWrite(state.lastLlmRaw);
            res.end();
            return;
          }
          if (mode === 'empty-frames') {
            // 200 SSE 但**零数据帧**（只有元数据）⇒ 解析器零帧 ⇒ 适配器必须报错而非"空译文"（D-130）
            state.lastLlmRaw = 'event:message\n\n';
            safeWrite(state.lastLlmRaw);
            res.end();
            return;
          }
          const frames = state.llmDeltas.map((d, i) => sseFrame(objOf(d, i)));
          state.lastLlmRaw = frames.join('');
          if (mode === 'half-packet') {
            // 半包：一帧被拆进两个 TCP 块，中间隔 80ms
            const s = frames[0];
            const cut = Math.max(1, Math.floor(s.length / 2));
            safeWrite(s.slice(0, cut));
            setTimeout(() => {
              safeWrite(s.slice(cut));
              for (const f of frames.slice(1)) safeWrite(f);
              res.end();
            }, 80);
            return;
          }
          if (mode === 'tail-packet') {
            // 尾包：最后一帧**没有**收尾的空行（缺一个 \n）
            frames.forEach((f, i) => safeWrite(i === frames.length - 1 ? f.replace(/\n\n$/, '') : f));
            res.end();
            return;
          }
          safeWrite(state.lastLlmRaw);
          res.end();
          return;
        }
        const body = JSON.stringify({
          errorCode: '0',
          query: q,
          translation: oneLine ? [q] : q.split('\n').map((l) => `[译]${l}`),
          l: `x2${String(fields.to ?? 'zh-CHS')}`,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      };

      switch (mode) {
        case 'hang-head': return;                       // 永不回话 → ttfb 层
        case 'stall': setTimeout(replyOk, state.holdMs); return;
        case 'slow-head-hold':                          // 头先拖一会，再给半截身子 → idle 层
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            safeWrite('{"errorCode":"0","translation":["半');
          }, state.holdMs);
          return;
        case 'never-end':
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          safeWrite('{"errorCode":"0","translation":["半');
          return;
        case 'ok-then-break': {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          state.lastLlmRaw = sseFrame({ code: '0', successful: true, data: { transIncre: state.llmDeltas[0], langType: state.llmLangType } });
          safeWrite(state.lastLlmRaw);
          setTimeout(() => { try { res.socket?.destroy(); } catch { /* ignore */ } }, 40);
          return;
        }
        case 'http500-garbage':
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('this is not json at all —— 500 + 垃圾体');
          return;
        case 'no-success':
          // code:"0" 但 successful:false —— llm 双判必须判失败（按真 SSE 帧发）
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          state.lastLlmRaw = sseFrame({ code: '0', successful: false });
          res.end(state.lastLlmRaw);
          return;
        default: replyOk();
      }
    });
    req.on('aborted', () => { /* 客户端中途走了：等 'close' 释放即可 */ });
  });

  return { state, server, port: 0 };
}

// ------------------------------------------------------------------ 进程夹具（R 组起真服务）

let fake = null;
let mods = null;

function spawnProc(entry, env, tag, args = []) {
  // 🔴 反证开关是**进程内夹具**，绝不漏进服务子进程：R 组量的是产品路径（路由层接线），
  //    而产品路径上没有人会设这些变量。漏进去会让同一条断言被好几个开关同时打红，
  //    "一条开关护一条机制"的归因就散了（各开关的哨兵在 S/T/L/C/K/A 组里，K1 盯 echoSecret）。
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (k.startsWith('MIAO_TRANSLATE_REFUTE_')) delete clean[k];
  // entry 是服务 ⇒ 按 MIAO_SERVICE_IMPL 选靶子；是 refute 子进程（SELF）⇒ 原样走 node
  const child = spawnTarget(entry, { ...clean, ...env }, args);
  const st = { child, tag, out: '', err: '', ready: null };
  child.stdout.on('data', (d) => {
    st.out += d.toString();
    const m = /MIAO_READY (\{.*\})/.exec(st.out);
    if (m && !st.ready) { try { st.ready = JSON.parse(m[1]); } catch { /* 继续等 */ } }
  });
  child.stderr.on('data', (d) => { st.err += d.toString(); });
  return st;
}

async function waitReady(st, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (!st.ready && Date.now() < until) await sleep(40);
  if (!st.ready) throw new Error(`${st.tag} 未就绪：stdout=${st.out}\nstderr=${st.err}`);
  return st.ready;
}

function killProc(st) {
  if (st && st.child.exitCode === null) { try { st.child.kill('SIGTERM'); } catch { /* ignore */ } }
}

// ------------------------------------------------------------------ HTTP 小工具（R 组打真路由）

function httpReq(port, method, pathname, { headers = {}, body = null, token } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (token) h['X-Box-Token'] = token;
    if (body) h['Content-Length'] = body.length;
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, headers: h, agent: false,
    }, (res) => {
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
const get = (port, p) => httpReq(port, 'GET', p, { token: TOKEN });
const post = (port, p, obj) => httpReq(port, 'POST', p, {
  token: TOKEN,
  headers: { 'Content-Type': 'application/json' },
  body: Buffer.from(JSON.stringify(obj), 'utf8'),
});

/** 把 SSE 响应体切成事件（`id: N\nevent: X\ndata: {...}\n\n`，见 `manga/sse.mjs`） */
function parseSse(buf) {
  const out = [];
  for (const block of buf.toString('utf8').split('\n\n')) {
    const t = block.trim();
    if (t === '') continue;
    const ev = { id: null, event: null, data: null };
    for (const line of t.split('\n')) {
      const i = line.indexOf(':');
      if (i === -1) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k === 'id') ev.id = Number(v);
      else if (k === 'event') ev.event = v;
      else if (k === 'data') { try { ev.data = JSON.parse(v); } catch { ev.data = v; } }
    }
    if (ev.event) out.push(ev);
  }
  return out;
}

// ================================================================ S · 签名与协议

async function groupS() {
  const { translateText, translateStream } = mods.index;

  // S1 长文本（>20 字符）走签名截断
  {
    const text = longText();
    const r = await attempt(() => translateText({ text, from: 'ja', to: 'zh', timeoutMs: 8000 }));
    const hit = fake.state.hits[fake.state.hits.length - 1];
    const input = `${text.slice(0, 10)}${text.length}${text.slice(-10)}`;
    const expect = sha(TEST_APP_KEY + input + hit.salt + hit.curtime + TEST_APP_SECRET);
    check(`S1 长文本（${text.length} 字符 > 20）按「前10+长度+后10」截断后参与签名：假上游同算法验签通过、独立重算的 sign 逐字一致`,
      text.length === LONG_LEN && !r.err && expect === hit.sign && hit.signOk,
      r.err ? errText(r.err) : `input=${input} sign=${hit.sign.slice(0, 8)}… 假上游验签=${hit.signOk ? '通过' : '拒绝'}`);
  }

  // S2 短文本（≤20）不截断
  {
    const text = nextText('短');
    const r = await attempt(() => translateText({ text, from: 'ja', to: 'zh', timeoutMs: 8000 }));
    const hit = fake.state.hits[fake.state.hits.length - 1];
    const expect = sha(TEST_APP_KEY + text + hit.salt + hit.curtime + TEST_APP_SECRET);
    check('S2 短文本（≤20 字符）原样参与签名（不截断）：独立重算的 sign 逐字一致',
      !r.err && text.length <= 20 && expect === hit.sign && hit.signOk,
      r.err ? errText(r.err) : `len=${text.length} sign=${hit.sign.slice(0, 8)}…`);
  }

  // S3 每次请求换 salt
  {
    const a = nextText('盐');
    const b = nextText('盐');
    const ra = await attempt(() => translateText({ text: a, from: 'ja', to: 'zh', timeoutMs: 8000 }));
    const rb = await attempt(() => translateText({ text: b, from: 'ja', to: 'zh', timeoutMs: 8000 }));
    const ha = fake.state.hits[fake.state.hits.length - 2];
    const hb = fake.state.hits[fake.state.hits.length - 1];
    check('S3 每次请求重新生成 salt + curtime + sign（不是进程级常量）：两次不同 text 的 salt 必然不同',
      !ra.err && !rb.err && ha.salt !== hb.salt && ha.sign !== hb.sign && ha.signOk && hb.signOk,
      `saltA=${ha.salt.slice(0, 8)}… saltB=${hb.salt.slice(0, 8)}…`);
  }

  // S4 重试也换 salt
  {
    const text = trig('M303F');
    const r = await attempt(() => translateText({ text, from: 'ja', to: 'zh', timeoutMs: 8000 }));
    const mine = fake.state.hits.filter((h) => h.fields.q === text);
    check('S4 重试也重新生成 salt（§7.3：复用 salt 必撞上游防重放 207）：第一次 303 → 重试即成功，两次 salt 不同、两次都过验签',
      !r.err && mine.length === 2 && mine[0].salt !== mine[1].salt && mine.every((h) => h.signOk)
      && r.value.text === `[译]${text}`,
      r.err ? errText(r.err) : `请求数=${mine.length} salt0=${mine[0].salt.slice(0, 8)}… salt1=${mine[1].salt.slice(0, 8)}… 译文=${r.value.text}`);
  }

  // S5 text 出网字段集
  {
    const text = nextText('字段');
    const r = await attempt(() => translateText({ text, from: 'ja', to: 'zh', timeoutMs: 8000 }));
    const hit = fake.state.hits[fake.state.hits.length - 1];
    const keys = Object.keys(hit.fields).sort().join(',');
    check('S5 text 出网协议：Content-Type 为 form-urlencoded；字段恰为 q/from/to/domain/strict + 签名五件套（signType=v3、strict=false）',
      !r.err && hit.contentType.startsWith('application/x-www-form-urlencoded')
      && keys === 'appKey,curtime,domain,from,q,salt,sign,signType,strict,to'
      && hit.fields.signType === 'v3' && hit.fields.strict === 'false'
      && hit.fields.from === 'ja' && hit.fields.to === 'zh-CHS',
      `ct=${hit.contentType} 字段=${keys}`);
  }

  // S6 llm 出网字段集
  {
    const text = nextText('流字段');
    const r = await attempt(() => translateStream({ text, from: 'ja', to: 'zh', timeoutMs: 8000 }));
    const hit = fake.state.hits[fake.state.hits.length - 1];
    const keys = Object.keys(hit.fields).sort().join(',');
    check('S6 llm 出网协议：字段恰为 i/prompt/from/to/streamType/handleOption + 签名五件套（streamType=increment、handleOption 缺省 0）',
      !r.err && hit.path === '/proxy/http/llm-trans' && hit.contentType.startsWith('application/x-www-form-urlencoded')
      && keys === 'appKey,curtime,from,handleOption,i,prompt,salt,sign,signType,streamType,to'
      && hit.fields.streamType === 'increment' && hit.fields.handleOption === '0' && hit.fields.i === text,
      `字段=${keys}`);
  }

  // S7 首块锁定
  {
    const text = trig('MBREAK');
    const deltas = [];
    const r = await attempt(() => translateStream({ text, from: 'ja', to: 'zh', timeoutMs: 8000 }, { onDelta: (d) => deltas.push(d) }));
    const mine = fake.state.hits.filter((h) => h.fields.i === text);
    check('S7 首块锁定：首块之后失败**绝不重试**（§7.3 —— 重来会重复/覆盖已吐给用户的增量）：上游吐了一块就掐流，请求数仍为 1',
      mine.length === 1 && deltas.length === 1 && r.err?.code === 'TRANSLATE_UPSTREAM_UNREACHABLE',
      `请求数=${mine.length} 已吐增量=${deltas.length} ${r.err ? errText(r.err) : '竟然成功了'}`);
  }

  // S8 text 判成功单判
  {
    const text = nextText('判成');
    const r = await attempt(() => translateText({ text, from: 'ja', to: 'zh', timeoutMs: 8000 }));
    check('S8 text 判成功按 `errorCode === "0"` **单判**：假上游的回话里**没有** successful 字段也判成功（不拿 llm 的双判去要求 text 接口）',
      !r.err && r.value.text === `[译]${text}`,
      r.err ? errText(r.err) : `译文=${r.value.text}`);
  }

  // S9 llm 判成功双判
  {
    const text = trig('MNOOK');
    const r = await attempt(() => translateStream({ text, from: 'ja', to: 'zh', timeoutMs: 8000 }));
    const mine = fake.state.hits.filter((h) => h.fields.i === text);
    check('S9 llm 判成功按 `code === "0"` **且** `successful === true` 双判：code 是 "0" 但 successful=false 必须判失败（而不是当成功吐个空译文）',
      r.err?.code === 'TRANSLATE_UPSTREAM_ERROR' && mine.length === 1,
      `${r.err ? errText(r.err) : '竟然成功了'} 请求数=${mine.length}`);
  }

  // S10 上游业务码 → 统一码（表驱动）
  {
    const rows = [
      ['text', 'E101', 'TRANSLATE_INVALID_INPUT'],
      ['text', 'E103', 'TRANSLATE_TEXT_TOO_LONG'],
      ['text', 'E108', 'TRANSLATE_AUTH_FAILED'],
      ['text', 'E202', 'TRANSLATE_AUTH_FAILED'],
      ['text', 'E301', 'TRANSLATE_UPSTREAM_ERROR'],
      ['text', 'E302', 'TRANSLATE_UPSTREAM_ERROR'],
      ['text', 'E304', 'TRANSLATE_UPSTREAM_ERROR'],
      ['text', 'E310', 'TRANSLATE_UNSUPPORTED_FEATURE'],
      ['text', 'E401', 'TRANSLATE_QUOTA_EXCEEDED'],
      ['text', 'E411', 'TRANSLATE_RATE_LIMITED'],
      ['text', 'E412', 'TRANSLATE_RATE_LIMITED'],
      ['text', 'E999', 'TRANSLATE_UPSTREAM_ERROR'],
      ['llm', 'E1', 'TRANSLATE_UPSTREAM_ERROR'],
      ['llm', 'E101', 'TRANSLATE_INVALID_INPUT'],
      ['llm', 'E108', 'TRANSLATE_AUTH_FAILED'],
      ['llm', 'E202', 'TRANSLATE_AUTH_FAILED'],
      ['llm', 'E206', 'TRANSLATE_AUTH_FAILED'],
      ['llm', 'E902000', 'TRANSLATE_UPSTREAM_ERROR'],
      ['llm', 'E999', 'TRANSLATE_UPSTREAM_ERROR'],
    ];
    const bad = [];
    for (const [api, token, want] of rows) {
      const text = trig(token);
      const r = api === 'text'
        ? await attempt(() => translateText({ text, from: 'ja', to: 'zh', timeoutMs: 8000 }))
        : await attempt(() => translateStream({ text, from: 'ja', to: 'zh', timeoutMs: 8000 }));
      const wantStatus = mods.errors.TRANSLATE_CODES[want];
      if (r.err?.code !== want || r.err?.status !== wantStatus) {
        bad.push(`${api}/${token}→${r.err ? r.err.code : '成功'}（要 ${want}/${wantStatus}）`);
      }
    }
    check(`S10 上游业务码 → 统一码 + HTTP 状态（${rows.length} 行表驱动，两接口各查自己那张表；未登记码 999 落兜底 UPSTREAM_ERROR）`,
      bad.length === 0, bad.length ? `不符：${bad.join('；')}` : `${rows.length} 行全部命中`);
  }

  // S11 半包 / 尾包（流式取证只认 onDelta / onDone —— translateStream 本身返回 void）
  {
    const keep = fake.state.llmDeltas;
    fake.state.llmDeltas = ['ABCD'];
    const d1 = [];
    let done1 = null;
    const r1 = await attempt(() => translateStream({ text: trig('MHALF'), from: 'ja', to: 'zh', timeoutMs: 8000 },
      { onDelta: (d) => d1.push(d), onDone: (d) => { done1 = d; } }));
    fake.state.llmDeltas = ['XY', 'Z'];
    const d2 = [];
    let done2 = null;
    const r2 = await attempt(() => translateStream({ text: trig('MTAIL'), from: 'ja', to: 'zh', timeoutMs: 8000 },
      { onDelta: (d) => d2.push(d), onDone: (d) => { done2 = d; } }));
    fake.state.llmDeltas = keep;
    check('S11 半包（一行拆在两个 TCP 块里）与尾包（最后一行没有换行符）都吃得下：增量不丢不重、顺序不乱，onDone 的累计全文与增量拼接逐字一致',
      !r1.err && !r2.err && d1.join('') === 'ABCD' && d2.join('') === 'XYZ'
      && !!done1 && done1.text === 'ABCD' && !!done2 && done2.text === 'XYZ',
      `半包=${JSON.stringify(d1)} 尾包=${JSON.stringify(d2)}`);
  }

  // S12 原生 Error 归一支路（顺序即优先级）
  {
    const { mapUpstreamError } = mods.errors;
    const errWith = (patch) => Object.assign(new Error('x'), patch);
    const rows = [
      [errWith({ details: { stage: 'idle' }, code: 'ECONNRESET' }), 'TRANSLATE_TIMEOUT', 'stage 优先于网络族'],
      [errWith({ code: 'ECONNREFUSED' }), 'TRANSLATE_UPSTREAM_UNREACHABLE', '网络族 ECONNREFUSED'],
      [errWith({ code: 'ENOTFOUND' }), 'TRANSLATE_UPSTREAM_UNREACHABLE', '网络族 ENOTFOUND'],
      [new Error('getaddrinfo EAI_AGAIN openapi.youdao.com'), 'TRANSLATE_UPSTREAM_UNREACHABLE', 'message 兜底'],
      [errWith({ status: 500 }), 'TRANSLATE_UPSTREAM_ERROR', 'HTTP 500'],
      [errWith({ status: 503 }), 'TRANSLATE_UPSTREAM_ERROR', 'HTTP 503'],
      [errWith({ code: 'ABORT_ERR' }), 'TRANSLATE_UPSTREAM_ERROR', '取消不是上游错误'],
      [new Error('boom'), 'TRANSLATE_UPSTREAM_ERROR', '兜底'],
    ];
    const bad = rows.filter(([e, want]) => mapUpstreamError('youdao', 'text', e).code !== want)
      .map(([, , why]) => why);
    const t = mapUpstreamError('youdao', 'text', errWith({ details: { stage: 'ttfb' } }));
    check('S12 出网原生 Error 的归一支路（顺序即优先级）：stage→TIMEOUT > 网络族→UNREACHABLE > 5xx→UPSTREAM_ERROR > ABORT_ERR/兜底→UPSTREAM_ERROR',
      bad.length === 0 && t.details.stage === 'ttfb',
      bad.length ? `不符：${bad.join('；')}` : '8 条支路全部命中，stage 原样透传到 details');
  }

  // S13 统一码 → HTTP 状态，且与根 errors.mjs 逐字一致
  {
    const { TRANSLATE_CODES } = mods.errors;
    const want = {
      TRANSLATE_NOT_CONFIGURED: 503, TRANSLATE_AUTH_FAILED: 502, TRANSLATE_INVALID_INPUT: 400,
      TRANSLATE_TEXT_TOO_LONG: 400, TRANSLATE_RATE_LIMITED: 429, TRANSLATE_QUOTA_EXCEEDED: 402,
      TRANSLATE_UNSUPPORTED_FEATURE: 400, TRANSLATE_UPSTREAM_ERROR: 502,
      TRANSLATE_UPSTREAM_UNREACHABLE: 502, TRANSLATE_TIMEOUT: 504, TRANSLATE_CAPABILITY_UNSUPPORTED: 400,
    };
    const inner = Object.entries(want).filter(([k, v]) => TRANSLATE_CODES[k] !== v).map(([k]) => k);
    const rootCodes = mods.root.CODES;
    const drift = Object.keys(want).filter((k) => rootCodes[k] !== want[k]);
    check('S13 翻译域 11 个统一码的 HTTP 状态与**根 errors.mjs 逐字一致**（门面转 ApiError 时两边同一状态码出信封，不许有一丝偏差）',
      inner.length === 0 && drift.length === 0 && Object.keys(TRANSLATE_CODES).length === 11,
      `域内不符=${inner.join(',') || '无'} 与根表漂移=${drift.join(',') || '无'}`);
  }

  // S14 真上游形态：SSE 帧（`event:message` + `data:`）必须被解析
  {
    const text = nextText('帧');
    const deltas = [];
    let done = null;
    const r = await attempt(() => translateStream({ text, from: 'ja', to: 'zh', timeoutMs: 8000 },
      { onDelta: (d) => deltas.push(d), onDone: (d) => { done = d; } }));
    const raw = fake.state.lastLlmRaw;
    check('S14 🔴 真上游形态是**标准 SSE 帧**（`event:message` + `data:{...}`，D-130 真机取证）：解析器逐帧取出 3 条增量、onDone 累计一致；且假上游确以该形态回话（旧"裸 JSON 行"解析器在这条上必红）',
      !r.err && /^event:message\ndata:\{/.test(raw) && deltas.join('') === '甲乙丙'
      && !!done && done.text === '甲乙丙',
      r.err ? errText(r.err) : `raw=${JSON.stringify(raw.slice(0, 40))}… 增量=${JSON.stringify(deltas)}`);
  }

  // S15 向后兼容：裸 JSON 行
  {
    const keep = fake.state.llmDeltas;
    fake.state.llmDeltas = ['AB', 'C'];
    const deltas = [];
    let done = null;
    const r = await attempt(() => withMode('line-json', 0, () => translateStream(
      { text: trig('MLINEJSON'), from: 'ja', to: 'zh', timeoutMs: 8000 },
      { onDelta: (d) => deltas.push(d), onDone: (d) => { done = d; } })));
    const raw = fake.state.lastLlmRaw;
    fake.state.llmDeltas = keep;
    check('S15 向后兼容：**裸 JSON 行**（非 SSE 帧）仍被解析 —— 上一步的修复不许把"逐行 JSON"这条形态打死（两种形态都要吃得下）',
      !r.err && !raw.startsWith('event:') && deltas.join('') === 'ABC' && !!done && done.text === 'ABC',
      r.err ? errText(r.err) : `raw=${JSON.stringify(raw.slice(0, 30))}… 增量=${JSON.stringify(deltas)}`);
  }

  // S16 200 但零帧 ⇒ 报错，不许"成功 + 空译文"
  {
    const text = trig('MEMPTY');
    const deltas = [];
    const r = await attempt(() => withMode('empty-frames', 0, () => translateStream(
      { text, from: 'ja', to: 'zh', timeoutMs: 8000 },
      { onDelta: (d) => deltas.push(d) })));
    const mine = fake.state.hits.filter((h) => h.fields.i === text);
    check('S16 🔴 上游 200 但**零可解析帧**（协议错配/空响应）⇒ 报 UPSTREAM_ERROR（reason=no_frames），绝不返回"成功 + 空译文"（与"非 2xx 先判死"配对：前者挡挂掉的上游，这一判挡"回话了却读不出"的上游）',
      r.err?.code === 'TRANSLATE_UPSTREAM_ERROR' && r.err.details?.reason === 'no_frames'
      && deltas.length === 0 && mine.length === 1,
      `${r.err ? errText(r.err) : '竟然成功了（空译文）'} 请求数=${mine.length} 增量=${deltas.length}`);
  }
}

// ================================================================ T · 四层超时

async function groupT() {
  const { translateText } = mods.index;
  const BH = await findBlackhole();

  // T1 connect 层
  if (!BH) {
    check('T1 connect 层超时（黑洞地址，`details.stage === "connect"`）', false,
      `候选 ${BLACKHOLE_CANDIDATES.join(' / ')} 全部探不通（既没挂住也没拒），本机网络环境不支持该用例`);
  } else {
    const before = fake.state.hits.length;
    await withEnv({
      MIAO_TRANSLATE_YOUDAO_BASE: `http://${BH}:443`,
      MIAO_TRANSLATE_CONNECT_MS: '400', MIAO_TRANSLATE_TTFB_MS: '5000', MIAO_TRANSLATE_IDLE_MS: '20000',
    }, async () => {
      const r = await attempt(() => translateText({ text: nextText('建连'), from: 'ja', to: 'zh', timeoutMs: 8000 }));
      check('T1 connect 层：黑洞地址 400ms 内建不上 → 504 TIMEOUT 且 `details.stage === "connect"`（不可达要**快败**，不是等满总超时）；一个请求都没到假上游',
        r.err?.code === 'TRANSLATE_TIMEOUT' && r.err.details?.stage === 'connect' && fake.state.hits.length === before,
        r.err ? errText(r.err) : '竟然成功了');
    });
  }

  // T2 ttfb 层
  await withEnv({ MIAO_TRANSLATE_CONNECT_MS: '5000', MIAO_TRANSLATE_TTFB_MS: '400', MIAO_TRANSLATE_IDLE_MS: '20000' },
    () => withMode('hang-head', 0, async () => {
      const r = await attempt(() => translateText({ text: nextText('首字节'), from: 'ja', to: 'zh', timeoutMs: 8000 }));
      check('T2 ttfb 层：连上了但上游 400ms 不给响应头 → 504 TIMEOUT 且 stage === "ttfb"（大模型首字慢与整段慢是两件事，单独一档）',
        r.err?.code === 'TRANSLATE_TIMEOUT' && r.err.details?.stage === 'ttfb',
        r.err ? errText(r.err) : '竟然成功了');
    }));

  // T3 idle 层
  await withEnv({ MIAO_TRANSLATE_CONNECT_MS: '5000', MIAO_TRANSLATE_TTFB_MS: '5000', MIAO_TRANSLATE_IDLE_MS: '400' },
    () => withMode('never-end', 0, async () => {
      const r = await attempt(() => translateText({ text: nextText('空闲'), from: 'ja', to: 'zh', timeoutMs: 5000 }));
      check('T3 idle 层：响应头到了、身子只剩半截且不再有字节 → 504 TIMEOUT 且 stage === "idle"（「卡住」与「慢慢吐」只有空闲超时能区分）',
        r.err?.code === 'TRANSLATE_TIMEOUT' && r.err.details?.stage === 'idle',
        r.err ? errText(r.err) : '竟然成功了');
    }));

  // T4 total 层
  await withEnv({ MIAO_TRANSLATE_CONNECT_MS: '5000', MIAO_TRANSLATE_TTFB_MS: '5000', MIAO_TRANSLATE_IDLE_MS: '60000' },
    () => withMode('slow-head-hold', 250, async () => {
      const r = await attempt(() => translateText({ text: nextText('总时长'), from: 'ja', to: 'zh', timeoutMs: 800 }));
      check('T4 total 层：idle 档放到 60s、请求自带 800ms 总预算 → 504 TIMEOUT 且 stage === "total"（总体永不结束要兜底，且不与 idle 混为一谈）',
        r.err?.code === 'TRANSLATE_TIMEOUT' && r.err.details?.stage === 'total',
        r.err ? errText(r.err) : '竟然成功了');
    }));
}

// ================================================================ L · 限流

async function groupL() {
  const { translateText } = mods.index;

  // 先把服务侧在飞数放干，再开始量峰值：T 组的超时用例是**客户端主动放弃**的请求，
  // 它对应的 `res.on('close')` 释放可能比 L1 突发晚几个事件循环 tick 才被处理 ——
  // 那时这个"早已废弃的请求"仍记在在飞数里，会把峰值抬到 4，而限流闸门明明只放了 3 个
  // （假绿纪律：峰值必须只由 L1 自己的请求构成，不吃上一组的记账竞态）。
  // 等待有上限：真漏了不永久卡死，而是以 `突发前在飞>0` + 峰值超标的形式红出来。
  {
    const until = Date.now() + 2000;
    while (fake.state.inflight > 0 && Date.now() < until) await sleep(20);
  }

  // L1 并发闸门（stall 300ms 把三个在飞请求钉住，峰值才测得准）
  {
    const startInflight = fake.state.inflight;
    const before = fake.state.hits.length;
    const rs = await withMode('stall', 300, () => Promise.all(Array.from({ length: 6 }, () =>
      attempt(() => translateText({ text: nextText('并发'), from: 'ja', to: 'zh', timeoutMs: 8000 })))));
    const errs = rs.filter((r) => r.err).length;
    check('L1 并发闸门：6 个并发 stall 请求 → 假上游**在飞数峰值恰为 3**（不超过 3）、6 个全部成功',
      errs === 0 && fake.state.peakInflight === 3 && fake.state.hits.length - before === 6,
      `peak=${fake.state.peakInflight} hits+${fake.state.hits.length - before} 失败=${errs} 突发前在飞=${startInflight}`);
  }

  // L2 速率闸门
  {
    const rs = await Promise.all(Array.from({ length: 25 }, () =>
      attempt(() => translateText({ text: nextText('速率'), from: 'ja', to: 'zh', timeoutMs: 400 }))));
    const ok = rs.filter((r) => !r.err).length;
    const limited = rs.filter((r) => r.err?.code === 'TRANSLATE_RATE_LIMITED');
    check('L2 速率闸门：25 个并发 + 400ms 排队上限 → 至少 1 个 429 RATE_LIMITED 且 `details.stage === "limiter"`（**不是** 504：用户该做的是"等一会儿再点"，重试只会更堵）；成功+限流 = 25',
      limited.length >= 1 && ok + limited.length === 25 && ok >= 3
      && limited.every((r) => r.err.details?.stage === 'limiter'),
      `成功=${ok} 限流=${limited.length}`);
  }
}

// ================================================================ C · 三层设置

async function groupC() {
  const { saveTranslateSettings, translateOptionsView, currentTranslateSource, translateText } = mods.index;
  const { readTranslateSettings } = mods.settings;

  // C1 文件不存在 = 正常首次启动
  await withConfigure({ settingsFile: path.join(TMP, 'c1', 's.json'), credentialsFile: CREDENTIALS_FILE },
    async () => {
      const v = await attempt(() => translateOptionsView());
      check('C1 设置文件不存在 = **正常的首次启动**（不是错误）：全部出厂默认、sources 逐键标 default、fileIssues.exists=false',
        !v.err && v.value.settings.platform === 'youdao' && v.value.settings.source === 'local'
        && v.value.settings['youdao.llmModel'] === 'pro' && v.value.settings['youdao.textDomain'] === 'general'
        && v.value.settings.timeoutMs === 30000
        && Object.values(v.value.sources).every((s) => s === 'default')
        && v.value.fileIssues.exists === false && v.value.fileIssues.corrupt === false,
        v.err ? errText(v.err) : JSON.stringify(v.value.sources));
    });

  // C2 保存补丁（以盘上文件为准）
  {
    fs.rmSync(SETTINGS_FILE, { force: true });
    const r = await attempt(() => saveTranslateSettings({ 'youdao.llmModel': 'lite', timeoutMs: 12345 }));
    const disk = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const v = await attempt(() => translateOptionsView());
    check('C2 保存补丁：返回 changed 与生效值，**回读盘上那个 JSON** 一致（不信响应自报），options 的 sources 逐键标为 file',
      !r.err && r.value.changed.length === 2 && r.value.settings['youdao.llmModel'] === 'lite'
      && disk['youdao.llmModel'] === 'lite' && disk.timeoutMs === 12345
      && !v.err && v.value.settings['youdao.llmModel'] === 'lite' && v.value.sources['youdao.llmModel'] === 'file'
      && v.value.sources.timeoutMs === 'file',
      r.err ? errText(r.err) : JSON.stringify(disk));
  }

  // C3 env 优先（且逐键可追溯）
  await withEnv({ MIAO_TRANSLATE_SOURCE: 'online', MIAO_TRANSLATE_TIMEOUT_MS: '7777' }, async () => {
    const v = await attempt(() => translateOptionsView());
    check('C3 env 覆盖文件（env > 文件 > 默认）：source=online / timeoutMs=7777 且 sources 标为 env；同一份视图里文件键仍标 file（"这个值谁定的"必须答得出来）',
      !v.err && v.value.settings.source === 'online' && v.value.sources.source === 'env'
      && v.value.settings.timeoutMs === 7777 && v.value.sources.timeoutMs === 'env'
      && v.value.settings['youdao.llmModel'] === 'lite' && v.value.sources['youdao.llmModel'] === 'file'
      && currentTranslateSource() === 'online',
      v.err ? errText(v.err) : `source=${v.value.settings.source} timeoutMs=${v.value.settings.timeoutMs}`);
  });

  // C4 补丁 strict：一律拒绝且不落盘
  {
    const before = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const r1 = await attempt(() => saveTranslateSettings({ 'youdao.llmmodel': 'pro' }));   // 未知键（大小写写错）
    const r2 = await attempt(() => saveTranslateSettings({ timeoutMs: 'abc' }));            // 非法值
    const r3 = await attempt(() => saveTranslateSettings({}));                               // 空补丁
    const r4 = await attempt(() => saveTranslateSettings({ platform: 'bogus' }));            // 未登记平台
    const after = fs.readFileSync(SETTINGS_FILE, 'utf8');
    check('C4 补丁 strict 校验：未知键 / 非法值 / 空补丁 / 未登记平台 一律 INVALID_SETTING 抛错（不静默丢），且**盘上文件一字节未动**',
      [r1, r2, r3, r4].every((r) => r.err && r.err.name === 'TranslateSettingsError' && r.err.code === 'INVALID_SETTING')
      && before === after,
      `${[r1, r2, r3, r4].map((r) => (r.err ? r.err.code : '通过')).join('/')} 盘上未动=${before === after}`);
  }

  // C5 读路径 strict:false：丢弃 + 上报
  {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      platform: 'youdao', bogusKey: 1, timeoutMs: 'not-a-number', 'youdao.textDomain': 'medicine',
    }));
    const read = readTranslateSettings({ file: SETTINGS_FILE });
    const v = await attempt(() => translateOptionsView());
    check('C5 读路径 strict:false：未知键与非法值**丢弃 + 上报**（不静默、也不为一个多余键让整份设置失效），上报一路带到 options 的 fileIssues',
      read.settings.platform === 'youdao' && read.settings['youdao.textDomain'] === 'medicine'
      && read.settings.timeoutMs === undefined
      && read.unknownKeys.length === 1 && read.unknownKeys[0] === 'bogusKey'
      && read.invalid.length === 1 && read.invalid[0].key === 'timeoutMs'
      && !v.err && v.value.fileIssues.unknownKeys[0] === 'bogusKey' && v.value.fileIssues.invalid[0].key === 'timeoutMs',
      JSON.stringify({ unknownKeys: read.unknownKeys, invalid: read.invalid }));
  }

  // C6 坏文件不阻断
  {
    fs.writeFileSync(SETTINGS_FILE, '{ 这不是合法 JSON');
    const read = readTranslateSettings({ file: SETTINGS_FILE });
    const before = fake.state.hits.length;
    const r = await attempt(() => translateText({ text: nextText('坏文件'), from: 'ja', to: 'zh', timeoutMs: 8000 }));
    check('C6 损坏文件：corrupt=true + reason 说清是哪一种坏，且**不阻断翻译**（落出厂默认照常出网，一次都没少）',
      read.corrupt === true && String(read.reason).includes('JSON 解析失败')
      && !r.err && fake.state.hits.length === before + 1,
      `corrupt=${read.corrupt} reason=${read.reason} ${r.err ? errText(r.err) : '翻译正常'}`);
    fs.rmSync(SETTINGS_FILE, { force: true });
  }
}

// ================================================================ K · 密钥隔离

async function groupK() {
  const { saveTranslateCredentials, translateText } = mods.index;
  const { credentialsView } = mods.credentials;

  // K1 脱敏视图
  {
    const view = credentialsView({ file: CREDENTIALS_FILE });
    const raw = JSON.stringify(view);
    check('K1 密钥视图脱敏：只回 `{ appKey, hasSecret }`，**任何出口都不回显 appSecret**（连 JSON 串里都搜不到）',
      view.youdao && view.youdao.appKey === TEST_APP_KEY && view.youdao.hasSecret === true
      && Object.keys(view.youdao).sort().join(',') === 'appKey,hasSecret'
      && !raw.includes(TEST_APP_SECRET),
      JSON.stringify(view));
  }

  // K2 缺密钥 → 不出网
  {
    const before = fake.state.hits.length;
    fs.rmSync(CREDENTIALS_FILE, { force: true });
    const r = await attempt(() => translateText({ text: nextText('无密钥'), from: 'ja', to: 'zh', timeoutMs: 8000 }));
    check('K2 未配置密钥 → 503 NOT_CONFIGURED，且**一个请求都没出网**（在适配器断言密钥那一关就挡下，不是发出去再失败）',
      r.err?.code === 'TRANSLATE_NOT_CONFIGURED' && r.err.status === 503 && fake.state.hits.length === before,
      `${r.err ? errText(r.err) : '竟然成功了'} hits+${fake.state.hits.length - before}`);
  }

  // K3 改了密钥下次调用即生效
  {
    const r1 = await attempt(() => saveTranslateCredentials({ platform: 'youdao', appKey: TEST_APP_KEY, appSecret: TEST_APP_SECRET }));
    const r2 = await attempt(() => translateText({ text: nextText('补密钥'), from: 'ja', to: 'zh', timeoutMs: 8000 }));
    check('K3 重新保存密钥后**立即生效**（每次调用现读、适配器不缓存）：翻译恢复成功，且保存响应只回 {platform, appKey}',
      !r1.err && r1.value.appKey === TEST_APP_KEY && !('appSecret' in r1.value) && !r2.err,
      r1.err ? errText(r1.err) : r2.err ? errText(r2.err) : `保存回 ${JSON.stringify(r1.value)}；译文=${r2.value.text}`);
  }

  // K4 保存校验 + 原子写
  await withConfigure({ settingsFile: SETTINGS_FILE, credentialsFile: path.join(TMP, 'k4', 'creds.json') },
    async () => {
      const dir = path.join(TMP, 'k4');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, 'creds.json');
      const r1 = await attempt(() => saveTranslateCredentials({ platform: 'youdao', appKey: '', appSecret: 'x' }));
      const r2 = await attempt(() => saveTranslateCredentials({ platform: 'youdao', appKey: 'ak', appSecret: '' }));
      const r3 = await attempt(() => saveTranslateCredentials({ platform: 'youdao', appKey: 'ak', appSecret: 'x'.repeat(129) }));
      const r4 = await attempt(() => saveTranslateCredentials({ platform: ' youdao ', appKey: ' ak ', appSecret: ' sk ' }));
      const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
      const mode = (fs.statSync(f).mode & 0o777).toString(8);
      // Windows 上只有"可写/只读"一位，0o600 会落成 0o666 —— 权限位数的口径按平台分开
      const modeOk = process.platform === 'win32' ? mode === '666' : mode === '600';
      check('K4 保存校验：appKey 空 / appSecret 空 / appSecret 超 128 一律 400 INVALID_INPUT；成功的那次 trim + 原子写（无 tmp 残留）+ 权限位收紧',
        [r1, r2, r3].every((r) => r.err?.code === 'TRANSLATE_INVALID_INPUT') && !r4.err
        && modeOk && leftovers.length === 0
        && JSON.parse(fs.readFileSync(f, 'utf8')).platforms.youdao.appKey === 'ak',
        `mode=${mode} tmp残留=${leftovers.length} ${[r1, r2, r3].map((r) => (r.err ? r.err.code : '通过')).join('/')}`);
    });
}

// ================================================================ A · 契约与适配器

/**
 * A 组验的是「抽象层真的存在」：门面只认契约，平台细节全在适配器里。
 * 反证假平台（`platforms/__fake__.mjs`，**只测试注册**）只有 'text' 能力且不实现
 * translateStream —— 谁绕过 capabilities 直接调 llm，A3 立刻红。
 */
async function groupA() {
  const { translateText, translateStream, translateApiError } = mods.index;
  const { assertAdapter } = mods.contract;
  const { getAdapter, FACTORIES } = mods.registry;
  const { TranslateError } = mods.errors;
  const { TranslateSettingsError, setPlatformIds } = mods.settings;
  const { ApiError } = mods.root;

  // A1 注册反证假平台（测试期注入；产品 FACTORIES 只有 youdao）
  {
    FACTORIES.fake = () => dynImport(path.join(TR, 'platforms', '__fake__.mjs')).then((m) => m.create());
    // platform 是路由开关：settings 的白名单必须与注册表同源（registry.mjs 顶层也调它）
    setPlatformIds(Object.keys(FACTORIES));
    const r = await attempt(() => getAdapter('fake'));
    const a = r.value;
    check('A1 反证假平台注册即过契约自检：只有 text 能力、**刻意不实现** translateStream —— assertAdapter 认这个形状（缺 llm 实现不违法，能力集没声明而已）',
      !r.err && a && a.id === 'fake' && a.capabilities.has('text') && !a.capabilities.has('llm')
      && typeof a.translateStream !== 'function' && a.langCode('ja') === 'ja' && a.langCode('ko') === null,
      r.err ? errText(r.err) : `capabilities=${[...a.capabilities].join(',')}`);
  }

  // A2 未知平台
  {
    const before = fake.state.hits.length;
    const r = await attempt(() => translateText({ platform: 'bogus', text: nextText('未知平台'), from: 'ja', to: 'zh', timeoutMs: 8000 }));
    check('A2 未知平台 id → 400 INVALID_INPUT 且 details.available 报得出有哪些平台（界面据此提示"只能选这些"，不让用户面对一个光秃秃的"翻译失败"）',
      r.err?.code === 'TRANSLATE_INVALID_INPUT' && Array.isArray(r.err.details?.available)
      && r.err.details.available.includes('youdao') && fake.state.hits.length === before,
      r.err ? errText(r.err) : '竟然成功了');
  }

  // A3 能力协商（假平台反证的核心）
  {
    const before = fake.state.hits.length;
    const r = await attempt(() => translateStream({ platform: 'fake', text: nextText('能力'), from: 'ja', to: 'zh', timeoutMs: 8000 }));
    check('A3 能力协商：假平台只有 text 能力，请求 mode:"llm" → 400 CAPABILITY_UNSUPPORTED，且**一个字节都没出网**（门面先查 capabilities，不落到适配器、更不到上游）',
      r.err?.code === 'TRANSLATE_CAPABILITY_UNSUPPORTED' && r.err.details?.mode === 'llm'
      && JSON.stringify(r.err.details?.capabilities) === '["text"]' && fake.state.hits.length === before,
      r.err ? errText(r.err) : '竟然成功了');
  }

  // A4 假平台真的被路由到
  {
    const text = nextText('假平台');
    const r = await attempt(() => translateText({ platform: 'fake', text, from: 'ja', to: 'zh', timeoutMs: 8000 }));
    check('A4 同一个请求显式指定 platform:"fake" → 走的是**假平台自己**的 translateText（回显 `[FAKE]` 前缀，不是有道的 `[译]`）：证明门面真的按 platform 路由到适配器',
      !r.err && r.value.text === `[FAKE]${text}`,
      r.err ? errText(r.err) : `译文=${r.value.text}`);
  }

  // A5 语言码不猜
  {
    const before = fake.state.hits.length;
    const r1 = await attempt(() => translateText({ text: nextText('方向'), from: 'xx', to: 'zh', timeoutMs: 8000 }));
    const r2 = await attempt(() => translateStream({ text: nextText('方向'), from: 'ko', to: 'zh', timeoutMs: 8000 }));
    check('A5 语言码「认不出就不猜」：text 收完全不认识的 xx、llm 收 ko（ko 只在 text 表里，llm 表更短）→ 一律 400 INVALID_INPUT，details.api 分别记 text/llm（两表分别查过的证据）；两次都没出网',
      r1.err?.code === 'TRANSLATE_INVALID_INPUT' && r1.err.details?.api === 'text'
      && r2.err?.code === 'TRANSLATE_INVALID_INPUT' && r2.err.details?.api === 'llm'
      && Array.isArray(r2.err.details?.langs) && r2.err.details.langs.includes('ja')
      && fake.state.hits.length === before,
      `${r1.err ? r1.err.code : '通过'} / ${r2.err ? r2.err.code : '通过'} hits+${fake.state.hits.length - before}`);
  }

  // A6 参数裁剪
  {
    const t1 = nextText('裁剪');
    const r1 = await attempt(() => translateText({
      text: t1, from: 'ja', to: 'zh', domain: 'computers', vocabId: 'v-1', prompt: '不该来', model: 'pro', timeoutMs: 8000,
    }));
    const h1 = fake.state.hits[fake.state.hits.length - 1];
    const k1 = Object.keys(h1.fields).sort().join(',');
    const t2 = nextText('裁剪');
    const r2 = await attempt(() => translateStream({ text: t2, from: 'ja', to: 'zh', domain: 'computers', vocabId: 'v-1', timeoutMs: 8000 }));
    const h2 = fake.state.hits[fake.state.hits.length - 1];
    const k2 = Object.keys(h2.fields).sort().join(',');
    check('A6 参数裁剪（§5.4）：text 出网只带 q/from/to/domain/vocabId/strict + 签名五件套（prompt/model 传进来也漏不出去）；llm 出网只带 i/prompt/from/to/streamType/handleOption + 签名五件套（domain/vocabId 同理）',
      !r1.err && !r2.err
      && k1 === 'appKey,curtime,domain,from,q,salt,sign,signType,strict,to,vocabId'
      && h1.fields.domain === 'computers' && h1.fields.vocabId === 'v-1'
      && k2 === 'appKey,curtime,from,handleOption,i,prompt,salt,sign,signType,streamType,to',
      `text字段=${k1}｜llm字段=${k2}`);
  }

  // A7 按行对齐的双向不对称
  {
    const r1 = await attempt(() => translateText({ text: 'A\nB\nC', from: 'ja', to: 'zh', splitLines: true, timeoutMs: 8000 }));
    const one = `${trig('M1LINE')}\nX`;   // 上游把整段当一行回（translation 长度 1 ≠ 入参 2 行）
    const r2 = await attempt(() => translateText({ text: one, from: 'ja', to: 'zh', splitLines: true, timeoutMs: 8000 }));
    check('A7 按行对齐**双向不对称**：上游逐行数与入参行数一致才给 lines（3=3 → 3 行）；不一致（1≠2）**整个 lines 键都不给** —— 错位的逐行译文比没逐行危害大得多（会把 A 行译文贴到 B 行）',
      !r1.err && !r2.err && Array.isArray(r1.value.lines) && r1.value.lines.length === 3
      && r1.value.lines[0] === '[译]A' && !('lines' in r2.value),
      // detail 也要防空：反证轮里 r1/r2 可能是 err（value 为 null），
      // 模板里直接点 .value 会把「断言变红」升级成「脚本崩了」—— 两件事必须分开。
      `一致→lines=${r1.err ? errText(r1.err) : JSON.stringify(r1.value.lines)}；不一致→${r2.err ? errText(r2.err) : Object.keys(r2.value).join(',')}`);
  }

  // A8 模型档位 → handleOption
  {
    const rows = [['pro', '0'], ['lite', '3'], [undefined, '0']];
    const bad = [];
    for (const [model, want] of rows) {
      const r = await attempt(() => translateStream({ text: nextText('档位'), from: 'ja', to: 'zh', model, timeoutMs: 8000 }));
      const h = fake.state.hits[fake.state.hits.length - 1];
      const got = h ? h.fields.handleOption : '无请求';
      if (r.err || got !== want) bad.push(`${model === undefined ? '缺省' : model}→${got}（要 ${want}）`);
    }
    const before = fake.state.hits.length;
    const rb = await attempt(() => translateStream({ text: nextText('档位'), from: 'ja', to: 'zh', model: 'bogus', timeoutMs: 8000 }));
    check('A8 模型档位 → handleOption：pro→"0"（子曰 14B）/ lite→"3"（1.5B）/ 缺省→"0"；非法值当场 400 INVALID_INPUT 且**不出网**（不静默回落成 pro —— 那会让人以为在用车，其实在用另一辆）',
      bad.length === 0 && rb.err?.code === 'TRANSLATE_INVALID_INPUT' && fake.state.hits.length === before,
      bad.length ? `不符：${bad.join('；')}` : `三档命中；bogus→${rb.err ? rb.err.code : '竟然出网了'}`);
  }

  // A9 llm 非 2xx 先判死
  {
    const text = trig('M500G');
    const deltas = [];
    const r = await attempt(() => translateStream({ text, from: 'ja', to: 'zh', timeoutMs: 8000 }, { onDelta: (d) => deltas.push(d) }));
    const mine = fake.state.hits.filter((h) => h.fields.i === text);
    check('A9 llm 非 2xx **先判死**：上游回 500 + 垃圾体（不是逐行 JSON）→ UPSTREAM_ERROR + httpStatus=500；绝不解析出空译文当成功（那对用户是"译了一整遍，结果是空的"）。5xx 属可重试 → 退避重试一次仍 500',
      r.err?.code === 'TRANSLATE_UPSTREAM_ERROR' && r.err.details?.httpStatus === 500
      && deltas.length === 0 && mine.length === 2,
      `${r.err ? errText(r.err) : '竟然成功了'} 请求数=${mine.length} 增量=${deltas.length}`);
  }

  // A10 可重试面
  {
    const t1 = trig('M303F');
    const r1 = await attempt(() => translateText({ text: t1, from: 'ja', to: 'zh', timeoutMs: 8000 }));
    const n1 = fake.state.hits.filter((h) => h.fields.q === t1).length;
    const t2 = trig('E411');
    const r2 = await attempt(() => translateText({ text: t2, from: 'ja', to: 'zh', timeoutMs: 8000 }));
    const n2 = fake.state.hits.filter((h) => h.fields.q === t2).length;
    check('A10 可重试面（§7.3）：上游 303（服务端异常）→ 退避重试一次即成功（请求数 2）；411（频率受限）→ **不重试**（请求数 1）直接 429 —— 已经被限还重试只会更堵',
      !r1.err && n1 === 2 && r2.err?.code === 'TRANSLATE_RATE_LIMITED' && r2.err.status === 429 && n2 === 1,
      `303→请求数 ${n1} ${r1.err ? errText(r1.err) : '成功'}；411→请求数 ${n2} ${r2.err ? r2.err.code : '通过'}`);
  }

  // A11 llm 流式累计
  {
    const deltas = [];
    let done = null;
    const r = await attempt(() => translateStream({ text: nextText('流式'), from: 'ja', to: 'zh', timeoutMs: 8000 },
      { onDelta: (d) => deltas.push(d), onDone: (d) => { done = d; } }));
    check('A11 llm 流式累计：3 条 transIncre 增量按序交给 onDelta，累计全文 + langType 由 onDone 一次性给出（拼接归门面，适配器不返全文）；translateStream 本身返回 void',
      !r.err && r.value === undefined && deltas.join('') === '甲乙丙'
      && done && done.text === '甲乙丙' && done.langType === 'zh-CHS',
      `增量=${JSON.stringify(deltas)} done=${JSON.stringify(done)}`);
  }

  // A12 契约自检 + 错误归一出口
  {
    const base = {
      id: 'x', label: 'X', capabilities: new Set(['text']), langCode: () => null, translateText: async () => ({}),
    };
    const cases = [
      [null, '非对象'],
      [{ ...base, id: '  ' }, 'id 空白'],
      [{ ...base, label: '' }, 'label 空'],
      [{ ...base, capabilities: ['text'] }, 'capabilities 不是 Set'],
      [{ ...base, capabilities: new Set() }, 'capabilities 空 Set'],
      [{ ...base, capabilities: new Set(['text', 'bogus']) }, '未知能力 token'],
      [{ ...base, translateText: undefined }, '缺 translateText'],
      [{ ...base, capabilities: new Set(['llm', 'text']) }, '声明 llm 却没 translateStream'],
    ];
    const bad = cases.filter(([a]) => { try { assertAdapter(a); return true; } catch { return false; } })
      .map(([, why]) => why);
    const e1 = translateApiError(new TranslateError('TRANSLATE_AUTH_FAILED', '密钥错', { platform: 'youdao' }));
    const e2 = translateApiError(new TranslateSettingsError('INVALID_SETTING', '补丁为空', { patch: {} }));
    const plain = new Error('内部 bug');
    const e3 = translateApiError(plain);
    check('A12 契约自检 8 种缺法逐一抛错（不留到运行期才炸）+ translateApiError 三分支归一：TranslateError→ApiError 同码同状态同 details；TranslateSettingsError→INVALID_SETTING(400)；非翻译域错误**原样返回**（不把内部 bug 洗成"翻译失败"）',
      bad.length === 0
      && e1 instanceof ApiError && e1.code === 'TRANSLATE_AUTH_FAILED' && e1.status === 502 && e1.details.platform === 'youdao'
      && e2 instanceof ApiError && e2.code === 'INVALID_SETTING' && e2.status === 400
      && e3 === plain && !(e3 instanceof ApiError),
      bad.length ? `未抛错：${bad.join('；')}` : '8 种全抛；三分支归一全部正确');
  }
}

// ================================================================ R · 路由端到端

/**
 * R 组**真起一个 box-service 子进程**（不是进程内直调门面）：验的是路由层接线 ——
 * 鉴权、请求体形状、SSE 三事件的顺序与字段、错误信封、只写不读。
 * 子进程的 env 显式给全（`MIAO_TOKEN` 可覆盖，见 config.mjs），出网基址指向本进程的假上游。
 */
async function groupR() {
  const port = await findFreePort(5860);
  const stateDir = path.join(TMP, 'r-state');
  const rootDir = path.join(TMP, 'r-root');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(rootDir, { recursive: true });
  // 预置密钥文件：门面每次调用现读，适配器不缓存（这里顺带验"盘上密钥直接可用"）
  fs.writeFileSync(path.join(stateDir, 'translate-credentials.json'),
    JSON.stringify({ platforms: { youdao: { appKey: TEST_APP_KEY, appSecret: TEST_APP_SECRET } } }), { mode: 0o600 });

  const st = spawnProc(SERVICE_ENTRY, {
    MIAO_PORT: String(port),
    MIAO_ROOT: rootDir,
    MIAO_STATE_DIR: stateDir,
    MIAO_TOKEN: TOKEN,
    MIAO_NO_LLM_AUTOSTART: '1',   // 本组不关心三进程生命周期
    MIAO_TRANSLATE_YOUDAO_BASE: `http://127.0.0.1:${fake.port}`,
    MIAO_TRANSLATE_CONNECT_MS: '5000',
    MIAO_TRANSLATE_TTFB_MS: '5000',
    MIAO_TRANSLATE_IDLE_MS: '20000',
  }, 'box-service(translate)');
  try {
    await waitReady(st);

    // R1 text 路由
    {
      const text = nextText('路由');
      const res = await post(port, '/api/v1/translate/text', { text, from: 'ja', to: 'zh' });
      const v = jsonOf(res);
      check('R1 POST /api/v1/translate/text → 200，译文带假上游的 `[译]` 前缀：路由 → 门面 → 适配器 → 假上游整条链通（且密钥是从盘上现读的）',
        res.status === 200 && v && v.text === `[译]${text}`,
        `${res.status} ${JSON.stringify(v)}`);
    }

    // R2 无令牌
    {
      const res = await httpReq(port, 'POST', '/api/v1/translate/text', {
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ text: 'x', from: 'ja', to: 'zh' }), 'utf8'),
      });
      const v = jsonOf(res);
      check('R2 同一路由**无令牌 → 403 PERMISSION_DENIED**：翻译端点是 Box 专用端点，不是免鉴权例外（请求里带着密钥出网，裸奔的代价比别的端点更大）',
        res.status === 403 && v?.error?.code === 'PERMISSION_DENIED',
        `${res.status} ${v?.error?.code}`);
    }

    // R3 流式路由 SSE 三事件（ happy path ）
    {
      const res = await post(port, '/api/v1/translate/stream', { text: nextText('路由流'), from: 'ja', to: 'zh' });
      const evs = parseSse(res.body);
      const deltas = evs.filter((e) => e.event === 'translate.delta');
      const done = evs.find((e) => e.event === 'translate.done');
      check('R3 POST /api/v1/translate/stream → 200 text/event-stream：3 条 translate.delta（增量按序）+ 1 条 translate.done（累计全文 + langType），事件 id 自增',
        res.status === 200 && String(res.headers['content-type']).startsWith('text/event-stream')
        && deltas.length === 3 && deltas.map((d) => d.data.text).join('') === '甲乙丙'
        && !!done && done.data.text === '甲乙丙' && done.data.langType === 'zh-CHS'
        && evs.every((e, i) => e.id === i + 1),
        `${res.status} 事件=${evs.map((e) => e.event).join(',')}`);
    }

    // R4 options 视图（必须排在 R5 之前：R5 会写设置文件，把 default 来源改成 file）
    {
      const res = await get(port, '/api/v1/translate/options');
      const v = jsonOf(res);
      const raw = res.body.toString('utf8');
      check('R4 GET /api/v1/translate/options → 200：platforms 只列已注册平台（youdao，capabilities 含 llm+text）、settings 全出厂默认、sources 逐键标 default、credentials 只回 {appKey, hasSecret}（secret 永不回显）',
        res.status === 200 && v && v.platforms.length === 1 && v.platforms[0].id === 'youdao'
        && v.platforms[0].capabilities.includes('llm') && v.platforms[0].capabilities.includes('text')
        && v.settings.timeoutMs === 30000 && v.settings['youdao.llmModel'] === 'pro' && v.settings.source === 'local'
        && Object.values(v.sources).every((s) => s === 'default')
        && v.credentials.youdao.appKey === TEST_APP_KEY && v.credentials.youdao.hasSecret === true
        && Object.keys(v.credentials.youdao).sort().join(',') === 'appKey,hasSecret'
        && !raw.includes(TEST_APP_SECRET),
        `${res.status} ${raw.slice(0, 140)}…`);
    }

    // R5 settings 补丁
    {
      const ok1 = await post(port, '/api/v1/translate/settings', { timeoutMs: 15000 });
      const v1 = jsonOf(ok1);
      const bad = await post(port, '/api/v1/translate/settings', { 'youdao.llmModel': 'pro', bogusKey: 1 });
      const v2 = jsonOf(bad);
      check('R5 POST /api/v1/translate/settings：合法补丁 → 200 {ok, changed, settings}；混入未知键 → 400 INVALID_SETTING（白名单 strict：不静默丢，丢了的键在界面上就是假控件）',
        ok1.status === 200 && v1.ok === true && Array.isArray(v1.changed) && v1.changed.includes('timeoutMs')
        && v1.settings.timeoutMs === 15000
        && bad.status === 400 && v2?.error?.code === 'INVALID_SETTING',
        `${ok1.status} / ${bad.status} ${v2?.error?.code}`);
    }

    // R6 credentials 只写不读
    {
      const res = await post(port, '/api/v1/translate/credentials',
        { platform: 'youdao', appKey: TEST_APP_KEY, appSecret: TEST_APP_SECRET });
      const v = jsonOf(res);
      const raw = res.body.toString('utf8');
      check('R6 POST /api/v1/translate/credentials → 200 {ok, saved:{platform, appKey}}：**只写不读**，响应体里搜不到 appSecret（§8.3：secret 永不回显，回显一次就等于把它写进了日志与网络抓包）',
        res.status === 200 && v.ok === true && v.saved.platform === 'youdao'
        && v.saved.appKey === TEST_APP_KEY && !('appSecret' in v.saved) && !raw.includes(TEST_APP_SECRET),
        `${res.status} ${raw}`);
    }

    // R7 错误信封
    {
      const res = await post(port, '/api/v1/translate/text', { text: '', from: 'ja', to: 'zh' });
      const v = jsonOf(res);
      check('R7 错误信封：空 text → 400，形状为 {error:{code,message,details}}，code 是翻译域统一码 TRANSLATE_INVALID_INPUT（不是笼统的"翻译失败" —— 用户看不出该改什么）',
        res.status === 400 && v?.error?.code === 'TRANSLATE_INVALID_INPUT'
        && typeof v.error.message === 'string' && v.error.details && typeof v.error.details === 'object',
        `${res.status} ${JSON.stringify(v).slice(0, 160)}`);
    }

    // R8 流式中途失败
    {
      const res = await post(port, '/api/v1/translate/stream', { text: trig('MBREAK'), from: 'ja', to: 'zh' });
      const evs = parseSse(res.body);
      const deltas = evs.filter((e) => e.event === 'translate.delta');
      const err = evs.find((e) => e.event === 'translate.error');
      check('R8 流式中途失败：先 translate.delta 再 translate.error（**顺序不能反** —— 反了浏览器拿到的是"流干净结束"），error 带 afterChars 现场证据（已吐出 1 个增量，用户知道丢在哪）',
        res.status === 200 && deltas.length === 1 && !!err
        && err.data.code === 'TRANSLATE_UPSTREAM_UNREACHABLE' && err.data.afterChars === 1,
        `事件=${evs.map((e) => e.event).join(',')} ${JSON.stringify(err?.data)}`);
    }
  } finally {
    killProc(st);
    await sleep(120);
  }
}

// ================================================================ 条数自检

/**
 * 每组条数与写死的分母比对。
 * 🔴 少写一条断言就静默少验一条，而"少验"在输出里完全看不出来 —— 所以分母必须写死并自检。
 */
function checkCounts() {
  const want = {
    S: EXPECTED_S, T: EXPECTED_T, L: EXPECTED_L, C: EXPECTED_C,
    K: EXPECTED_K, A: EXPECTED_A, R: EXPECTED_R,
  };
  const got = {};
  for (const r of results) {
    const m = /^([A-Z])(\d+)\s/.exec(r.id);
    if (m) got[m[1]] = (got[m[1]] || 0) + 1;
  }
  const bad = Object.entries(want).filter(([g, n]) => got[g] !== n)
    .map(([g, n]) => `${g} 组实际 ${got[g] || 0} 条 ≠ 分母 ${n}`);
  const total = Object.values(want).reduce((a, b) => a + b, 0);
  check(`COUNT 各组条数与写死的分母一致（${total} 条业务断言 + 本行 + RUN，共 ${total + 2} 条）`,
    bad.length === 0,
    bad.length ? `不符：${bad.join('；')}` : Object.entries(want).map(([g, n]) => `${g}=${got[g]}`).join(' '));
}

// ================================================================ 一轮完整断言

/** 起假上游 → 布置接缝 env → 动态 import → 依次跑七组 → 条数自检 → RUN 兜底 */
async function runOnePass() {
  await listen(fake.server, 0);
  fake.port = fake.server.address().port;
  // 接缝 env（hermetic 基线之后布置；`baseUrl()`/`envMs()` 每次调用现读，故此处即生效）
  process.env.MIAO_TRANSLATE_YOUDAO_BASE = `http://127.0.0.1:${fake.port}`;
  process.env.MIAO_TRANSLATE_CONNECT_MS = '5000';
  process.env.MIAO_TRANSLATE_TTFB_MS = '5000';
  process.env.MIAO_TRANSLATE_IDLE_MS = '20000';

  // 🔴 禁止静态 import：env 必须先布置完（refute.mjs 在模块顶层读 env）
  mods = {
    index: await dynImport(path.join(TR, 'index.mjs')),
    settings: await dynImport(path.join(TR, 'settings.mjs')),
    credentials: await dynImport(path.join(TR, 'credentials.mjs')),
    errors: await dynImport(path.join(TR, 'errors.mjs')),
    contract: await dynImport(path.join(TR, 'contract.mjs')),
    registry: await dynImport(path.join(TR, 'registry.mjs')),
    http: await dynImport(path.join(TR, 'http.mjs')),
    root: await dynImport(path.join(ROOT, 'service', 'src', 'errors.mjs')),
  };

  fs.mkdirSync(STATE_DIR, { recursive: true });
  mods.index.configureTranslate({ settingsFile: SETTINGS_FILE, credentialsFile: CREDENTIALS_FILE });
  const saved = await attempt(() => mods.index.saveTranslateCredentials({
    platform: 'youdao', appKey: TEST_APP_KEY, appSecret: TEST_APP_SECRET,
  }));
  if (saved.err) throw saved.err; // 密钥没落下 = 夹具没搭好，后面全组都会莫名其妙地红

  await groupS();
  await groupT();
  await groupL();
  await groupC();
  await groupK();
  await groupA();
  await groupR();
  checkCounts();
  check('RUN 脚本完整跑完（顶层未崩：崩了只会没有 [RESULT] 行，反证轮会把「断言炸了」误读成「破坏没生效」）',
    true, `假上游端口=${fake.port} 记账 ${fake.state.hits.length} 条 / 验签失败 ${fake.state.badSign} 次`);
}

// ================================================================ 反证轮

/**
 * 六个开关，一个开关一个子进程（`refute.mjs` 模块顶层读 env ⇒ 进程内不可回滚）。
 *
 * `expectRed` 的取法：**先跑一次子进程看实际红集合，再连同锚点一起硬编码进来**。
 * 除了锚点本身，还包含**级联**（一个开关顺带打红的断言）—— 级联必须在注释里说清
 * 是哪一条传导链，否则"一条开关护一条机制"的归因就散了。
 */
const SWITCHES = [
  {
    name: 'MIAO_TRANSLATE_REFUTE_NO_TRUNCATE（签名不截断 input）',
    env: { MIAO_TRANSLATE_REFUTE_NO_TRUNCATE: '1' },
    expectRed: ['S1'],
    why: '锚点 S1：>20 字符长文本不走「前10+长度+后10」⇒ 假上游同算法重算 sign 不一致 → 202 AUTH_FAILED。不级联的两个保证：① 除 S1 外所有用例 text ≤20 字符（文件头纪律①），截断与否同值；② 验签结果逐 hit 记 signOk，S2/S3/S4 只认自己那条请求，不吃 S1 故意签错的全局污染。',
  },
  {
    name: 'MIAO_TRANSLATE_REFUTE_REUSE_SALT（重试复用旧 salt）',
    env: { MIAO_TRANSLATE_REFUTE_REUSE_SALT: '1' },
    expectRed: ['S4', 'T2', 'T3', 'T4', 'A9', 'A10'],
    why: '锚点 S4：重试复用 salt 必撞上游防重放 207。级联：凡"第一次失败→重试"的用例第二次都撞 207 变 AUTH_FAILED —— T2/T3/T4（超时属可重试，第二次请求发得出去，salt 已被假上游记账）、A9（500 可重试）、A10（303 可重试）。T1 不红：黑洞地址根本到不了假上游，salt 从未被记账，两次都是 connect 超时。',
  },
  {
    name: 'MIAO_TRANSLATE_REFUTE_IDLE_AS_TOTAL（idleMs 并进 totalMs）',
    env: { MIAO_TRANSLATE_REFUTE_IDLE_AS_TOTAL: '1' },
    expectRed: ['T3'],
    why: '锚点 T3：idle 档被并成 totalMs（5000）⇒ 与 total 定时器同时刻到期，而 total 定时器起跑更早 ⇒ stage 从 idle 变 total。T2/T4 不红：T2 的 stage 由 ttfb 定时器归因（与 idleMs 无关），T4 预期就是 total。',
  },
  {
    name: 'MIAO_TRANSLATE_REFUTE_ECHO_SECRET（密钥视图回显 secret）',
    env: { MIAO_TRANSLATE_REFUTE_ECHO_SECRET: '1' },
    expectRed: ['K1'],
    why: '锚点 K1：credentialsView 多回一个 appSecret 键，"secret 永不回显"被破坏。R4/R6 不红：服务子进程由 spawnProc 剥掉 REFUTE_*，量的是产品路径。',
  },
  {
    name: 'MIAO_TRANSLATE_REFUTE_STREAM_RETRY_AFTER_FIRST（首块后仍重试）',
    env: { MIAO_TRANSLATE_REFUTE_STREAM_RETRY_AFTER_FIRST: '1' },
    expectRed: ['S7'],
    why: '锚点 S7：首块锁定被摘掉 ⇒ 已吐给用户的增量之后仍重试，假上游请求数 1→2、增量 1→2（重复/覆盖已给出的内容）。',
  },
  {
    name: 'MIAO_TRANSLATE_REFUTE_SWAP_JUDGE（两接口判成功互换）',
    env: { MIAO_TRANSLATE_REFUTE_SWAP_JUDGE: '1' },
    expectRed: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S10', 'S11', 'S14', 'S15',
      'L1', 'L2', 'C6', 'K3', 'A6', 'A7', 'A8', 'A10', 'A11'],
    why: '锚点 S8/S9 一族：text 改用 llm 双判、llm 改用 text 单判 ⇒ 每一个"调用成功"类断言全红。级联说明：S1-S7/S10/S11/S14/S15 的取证都以"成功拿到译文/成功建流"为前提（S14/S15 是 llm 流式成功的两种协议形态）；L1/L2 的收尾断言要求 6/25 个请求成功；C6/K3 的收尾是一次成功翻译；A6/A7/A8/A10/A11 同属"翻译成功"类（A8 的三档档位也要流式真成功才判命中）。不红的都是与判成功无关的面：S9/S16（期望的正是 UPSTREAM_ERROR —— 判反了也红不到它）、S12/S13（纯函数）、T 组（超时路径不判成功）、C1-C5/K1/K2/K4（设置与密钥面）、A1-A5（注册/能力/路由/语言码，失败早于判成功）、A9（非 2xx 先判死，早于任何判成功）、A12（纯函数）、R 组（服务子进程由 spawnProc 剥掉 REFUTE_*，量的是产品路径）。',
  },
  {
    name: 'MIAO_TRANSLATE_REFUTE_LEGACY_LINE_JSON（解析器只认裸 JSON 行、丢弃 SSE `data:` 帧）',
    env: { MIAO_TRANSLATE_REFUTE_LEGACY_LINE_JSON: '1' },
    expectRed: ['S6', 'S7', 'S10', 'S11', 'S14', 'A6', 'A8', 'A11'],
    why: '锚点 S14：真上游形态是**标准 SSE 帧**，退回"只认裸 JSON 行"后 `data:` 帧被整片丢弃 ⇒ 凡"llm 流式成功"类断言全红 —— **这正是 D-130 的线上症状**（译了一整遍、结果是空的）。级联：S6（llm 出网后要收到帧才算成功）、S7（首块锁定要求至少 1 个增量）、S10（llm 业务码行要按真码归一）、S11（半包/尾包增量）、A6（llm 裁剪要成功收尾）、A8（档位要成功才取到记账）、A11（流式累计）。两条仍绿恰好证明"两种形态都要吃得下"：S9（期望的正是 UPSTREAM_ERROR，零帧兜底替它报了错）、S15（本就走裸 JSON 行形态）；S16 也绿（零帧兜底与形态无关）。',
  },
  {
    name: 'MIAO_TRANSLATE_REFUTE_NO_FRAME_GUARD（流式不做"200 但零帧即报错"兜底）',
    env: { MIAO_TRANSLATE_REFUTE_NO_FRAME_GUARD: '1' },
    expectRed: ['S16'],
    why: '锚点 S16：摘掉零帧兜底 ⇒ 上游 200 但零帧时返回"成功 + 空译文"（用户看到的那句假话），S16 从"报 UPSTREAM_ERROR"退化成"竟然成功了（空译文）"。只红 S16：其余用例的 llm 回话都至少有一帧。',
  },
];
const EXPECTED_SWITCHES = 8; // 分母写死

async function runRefute() {
  console.log('ver2.2 在线翻译 · 反证轮');
  console.log(`逃生开关 → 指定断言必须变红（应执行 ${EXPECTED_SWITCHES} 条）\n`);
  let asExpected = 0;
  const problems = [];

  for (const sw of SWITCHES) {
    // 每个开关独立跑一次：refute.mjs 在模块顶层读 env ⇒ 进程内无法回滚 ⇒ 另起子进程。
    // spawnProc 会先剥掉父进程里的 MIAO_TRANSLATE_REFUTE_*，再合并本开关的那一个。
    const st = spawnProc(SELF, sw.env, sw.name, ['--refute-child']);
    let out = '';
    st.child.stdout.on('data', (d) => { out += d.toString(); });
    st.child.stderr.on('data', (d) => { out += d.toString(); });
    await new Promise((resolve) => st.child.once('exit', resolve));

    const line = out.split('\n').find((l) => l.startsWith('[RESULT] '));
    if (!line) {
      problems.push(`${sw.name}：子进程未产出结果行（输出尾部：${out.slice(-300)}）`);
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
      // 连 detail 一起打：只给 id 的话，"多红的那条到底败在哪"还得再手动复跑一次子进程
      for (const id of extra) {
        const r = parsed.results.find((x) => x.id === id);
        console.log(`   ⚠ 额外变红（本开关不该影响）：${id}${r && r.detail ? `  ${r.detail}` : ''}`);
      }
      problems.push(`${sw.name}：额外变红 ${extra.length} 条 → ${extra.join(' | ')}`);
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
  if (IS_REFUTE_PARENT) {
    await runRefute();
  } else {
    fake = createFakeUpstream();
    await runOnePass();
    const { fail } = printResults('ver2.2 在线翻译 · 假上游正向断言'
      + '（S 签名与协议 / T 四层超时 / L 限流 / C 三层设置 / K 密钥隔离 / A 契约与适配器 / R 路由端到端）');
    process.exitCode = fail === 0 ? 0 : 1;
  }
} catch (err) {
  // 无论多崩都要吐 [RESULT] 行：没有结果行，反证轮只能看到"子进程没输出"，
  // 那是「断言炸了」而不是「断言变红」，两件事必须分开（AGENTS.md §2-4）。
  check('RUN 脚本完整跑完（顶层未崩）', false, err && err.stack ? err.stack : String(err));
  printResults('ver2.2 在线翻译 · 顶层异常');
  process.exitCode = 1;
} finally {
  if (fake && fake.server.listening) {
    await new Promise((resolve) => { fake.server.close(() => resolve()); });
  }
  const anyRed = results.some((r) => !r.ok);
  if (IS_REFUTE_PARENT || !anyRed) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    console.log(`\n[临时目录保留] ${TMP}`);
  }
}

