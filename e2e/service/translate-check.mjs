#!/usr/bin/env node
/**
 * ver2.2 · 在线翻译服务 · **假上游正反断言脚本**（方案 §10 验收计划）
 * =============================================================================
 *
 * ## 验什么
 * Rust 门面 `app/src-tauri/src/boxsvc/translate/**`（门面 / 注册表 / 契约 / 设置三层 /
 * 密钥隔离 / 错误归一 / 四层超时 / 限流 / 流式解析）+ 5 条 `/api/v1/translate/*` 路由。
 * 断言分八组，每组一条硬纪律：
 *
 * | 组 | 条数 | 验什么 | 纪律 |
 * |---|---|---|---|
 * | S  | 14 | 签名 v3 与两接口协议（截断 / salt 防重放 / 字段集 / 判成功 / 错误码表 / SSE 帧解析 / 半包尾包 / 零帧兜底） | §5 / §7.2 |
 * | T  | 4  | connect / ttfb / idle / total 四层超时**互不混淆**（`details.stage` 归因） | §7.1 |
 * | L  | 2  | 令牌桶并发 3 + QPS 10；排队超时归 429 而不是 504 | §7.4 |
 * | C  | 6  | 三层设置（env > 文件 > 默认）+ 双向不对称校验 + 坏文件不阻断 | §8.1/§8.2 |
 * | K  | 4  | 密钥隔离：只写不读回显、缺密钥不出网、保存校验与原子写 | §8.3 |
 * | A  | 8  | 契约与适配器：未知平台 / 语言码不猜 / 参数裁剪 / 首块锁定 / 非 2xx 先判死 | §4 / §5.4 / §7.3 |
 * | R  | 8  | 路由端到端：真起一个 boxsvc 子进程，5 条路由 + 鉴权 + SSE 三事件 | §6.3 |
 * | P  | 6  | 纯逻辑面（统一码表 / 签名截断 / 语言码表 / 上游码映射 / 出网错误族 / 可重试） ⟷ 冻结 golden | §7.2 |
 *
 * ## 换靶（F5.5）
 * 原先 S/T/L/C/K/A 组是**进程内直调 Node 门面**（`service/src/manga/translate/**`）。Node 服务
 * 实现退役后，改为 `boxsvc --translate-cases '<json>'` —— 把每用例的 body / env 喂给 **Rust 门面**
 * 让它真发 HTTP 打到本进程的假上游。断言面逐条对应，且比原来**更接近产品**（真门面 + 真出网 +
 * 真 `MIAO_*` 现读）。纯逻辑面（注册表是编译期常量、错误族由 reqwest 抛，**不经过路由**）走
 * `boxsvc --translate-selftest` 的确定性报告，由 `golden/translate-selftest.json` 冻结为金标。
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
 * `refute.rs` 是 `OnceLock`（复刻 Node 模块顶层求值语义）⇒ 进程内不可回滚 ⇒ 每个开关必须另起
 * 子进程（`engine-settings-check.mjs` 的同款纪律）。子进程跑**同一套正向断言**，
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
 * 约束：纯 Node、零第三方依赖；临时目录自建自清（成功即清、失败保留并打印路径）。
 * 前置：`cd app/src-tauri && cargo build --bin boxsvc`
 * 重新生成 golden：`node e2e/service/_gen-golden.mjs translate`
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// F0：服务入口解析的唯一事实源（靶子只剩 Rust 一个）
import { killTree, RUST_BIN, SERVICE_ENTRY, spawnTarget } from './_service-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = path.join(ROOT, 'e2e', 'service', 'translate-check.mjs');
const GOLDEN = path.join(ROOT, 'e2e', 'service', 'golden', 'translate-selftest.json');
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
const EXPECTED_S = 14;
const EXPECTED_T = 4;
const EXPECTED_L = 2;
const EXPECTED_C = 6;
const EXPECTED_K = 4;
const EXPECTED_A = 8;
const EXPECTED_R = 8;
const EXPECTED_P = 6;

// ------------------------------------------------------------------ 统一码表（**硬编码**，不向被测实现要）
// 🔴 期望值必须来自契约而不是来自被测实现 —— 从实现里取表（旧脚本曾 `mods.errors.TRANSLATE_CODES[want]`）
//    是同义反复：实现把 429 写成 504，断言会跟着一起改，永远不会红。
const CODE_STATUS = {
  TRANSLATE_NOT_CONFIGURED: 503,
  TRANSLATE_AUTH_FAILED: 502,
  TRANSLATE_INVALID_INPUT: 400,
  TRANSLATE_TEXT_TOO_LONG: 400,
  TRANSLATE_RATE_LIMITED: 429,
  TRANSLATE_QUOTA_EXCEEDED: 402,
  TRANSLATE_UNSUPPORTED_FEATURE: 400,
  TRANSLATE_UPSTREAM_ERROR: 502,
  TRANSLATE_UPSTREAM_UNREACHABLE: 502,
  TRANSLATE_TIMEOUT: 504,
  TRANSLATE_CAPABILITY_UNSUPPORTED: 400,
  INVALID_SETTING: 400,
};

// ------------------------------------------------------------------ hermetic 基线
// 🔴 必须在**任何**门面调用之前跑：`refute.rs` 在首次 `get()` 读 env，
//    `youdao.rs` 的 `base_url()` / `env_ms()` 每次调用现读 env。
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
const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
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

// ------------------------------------------------------------------ 调门面：唯一通路
//
// 🔴 全部经 `boxsvc --translate-cases`（**Rust 门面**）—— 本进程里没有一行 Node 产品代码。
//    子进程 env **继承**本进程（反证轮的 `MIAO_TRANSLATE_REFUTE_*` 就是靠这条传下去的），
//    再叠加用例自己的 env（切址 / 切超时档 / 切落盘目录）。

/** 起 boxsvc 子命令并收 stdout（🔴 本机 `execFileSync/spawnSync` 起子进程会 EBUSY，只能异步 spawn）。 */
function runRust(args, env = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(RUST_BIN)) {
      reject(new Error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd app/src-tauri && cargo build --bin boxsvc`));
      return;
    }
    const c = spawn(RUST_BIN, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => {
      out += d.toString();
    });
    c.stderr.on('data', (d) => {
      err += d.toString();
    });
    c.on('error', reject);
    c.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`boxsvc ${args[0]} 退出码 ${code}：${(err || out).slice(0, 600)}`));
    });
  });
}

/** 跑一批用例，返回 `results`（保序）。 */
async function runCases(list) {
  const out = await runRust(['--translate-cases', JSON.stringify({ cases: list })]);
  const parsed = JSON.parse(out);
  return parsed.results || [];
}

/**
 * 单次门面调用。返回 `{ ok, value?, err?, deltas?, source? }` ——
 * 形状与旧脚本 `attempt()` 的 `{value, err}` 一致（失败时 `value` 为 undefined、
 * 成功时 `err` 为 undefined），断言因此可以照旧写 `r.err?.code` / `r.value.text`。
 */
async function call(kind, body, env) {
  const [r] = await runCases([{ name: 'call', kind, body: body ?? {}, env: env ?? {} }]);
  if (!r) return { ok: false, err: { code: 'SELFTEST_NO_RESULT', message: '用例未返回结果', status: 0, details: {} } };
  return r;
}
/** 简化调用（S/T/C/K/A 组用；`timeoutMs` 等仍在 body 里）。 */
const text = (body, env) => call('text', body, env);
const stream = (body, env) => call('stream', body, env);
const options = (env) => call('options', null, env);
const saveSettings = (patch, env) => call('settings', patch, env);
const saveCredentials = (body, env) => call('credentials', body, env);
/**
 * 并发用例：N 个调用在**同一个 Rust 进程**里同时发出（量的是同一个令牌桶）。
 * `bodies` 逐条给 body（每条 text 唯一，见文件头纪律②）。
 */
const batch = (spec, env) => call('batch', spec, env);
/** N 条互不相同的 body（唯一 text，见文件头纪律②） */
const uniqueBodies = (n, tag, extra = {}) =>
  Array.from({ length: n }, () => ({
    text: nextText(tag),
    from: 'ja',
    to: 'zh',
    ...extra,
  }));

/** 调用失败时的可读说明 */
function errText(err) {
  if (!err) return '';
  const d = err.details ? ` details=${JSON.stringify(err.details)}` : '';
  return `抛错 ${err.code || err.name}: ${err.message}${d}`;
}

/**
 * 最近一条记账（缺省值保证"根本没出网"时断言只变红、不炸脚本 ——
 * 断言变红与脚本崩了是两件事，反证轮对后者的读法完全不同，AGENTS.md §2-4）。
 */
function lastHit() {
  return (
    fake.state.hits[fake.state.hits.length - 1] || {
      api: '',
      path: '',
      fields: {},
      contentType: '',
      salt: '',
      curtime: '',
      sign: '',
      signOk: false,
      at: 0,
    }
  );
}

// ------------------------------------------------------------------ 小工具

const sleep = (ms) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** 全局计数器：**每次翻译调用的 text 都不重样**（见文件头纪律②） */
let seq = 0;
const nextN = () => {
  seq += 1;
  return String(seq).padStart(3, '0');
};
const nextText = (tag) => `${tag}${nextN()}`;
/** 内容触发文本：`__T_<TOKEN>__<序号>`（≤20 字符，见文件头纪律①） */
const trig = (token) => `__T_${token}__${nextN()}`;
const LONG_LEN = 30;
/** S1 专用长文本：精确 30 字符（>20 才会走签名截断） */
const longText = () => `L${nextN()}${'M'.repeat(LONG_LEN - 4)}`;

/** 门面调用的默认 env：假上游地址 + 落盘目录 + 宽松超时（用例各自覆盖需要动的那一项）。 */
function baseEnv(overrides = {}) {
  return {
    MIAO_STATE_DIR: STATE_DIR,
    MIAO_TRANSLATE_YOUDAO_BASE: fake ? `http://127.0.0.1:${fake.port}` : '',
    MIAO_TRANSLATE_CONNECT_MS: '5000',
    MIAO_TRANSLATE_TTFB_MS: '5000',
    MIAO_TRANSLATE_IDLE_MS: '20000',
    ...overrides,
  };
}

/** 合并默认 env 与覆盖项（`undefined` 覆盖项表示"沿用默认"）。 */
const envOf = (overrides) =>
  baseEnv(Object.fromEntries(Object.entries(overrides || {}).filter(([, v]) => v !== undefined)));

/** 临时切假上游模式（`holdMs` 仅 stall / slow-head-hold 用） */
async function withMode(mode, holdMs, fn) {
  const m = fake.state.mode;
  const h = fake.state.holdMs;
  fake.state.mode = mode;
  fake.state.holdMs = holdMs || 0;
  try {
    return await fn();
  } finally {
    fake.state.mode = m;
    fake.state.holdMs = h;
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
    const done = (v) => {
      if (!settled) {
        settled = true;
        try {
          s.destroy();
        } catch {
          /* ignore */
        }
        resolve(v);
      }
    };
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
    if (await probeHang(host, 443, 400)) {
      blackholeCache = host;
      return host;
    }
  }
  blackholeCache = null;
  return null;
}

// ------------------------------------------------------------------ 假上游

/** 内容触发 → **上游业务错误码**（按 path 选形状回：text 回 errorCode，llm 回 code） */
const ERR_TRIGGERS = {
  E101: '101',
  E103: '103',
  E108: '108',
  E202: '202',
  E301: '301',
  E302: '302',
  E304: '304',
  E310: '310',
  E401: '401',
  E411: '411',
  E412: '412',
  E999: '999',
  E1: '1',
  E206: '206',
  E902000: '902000',
};
/** 内容触发 → **响应形态** */
const MODE_TRIGGERS = {
  M500G: 'http500-garbage',
  MSTALL: 'stall',
  MHANG: 'hang-head',
  MNEVER: 'never-end',
  MHOLD: 'slow-head-hold',
  MBREAK: 'ok-then-break',
  MHALF: 'half-packet',
  MTAIL: 'tail-packet',
  MNOOK: 'no-success',
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
    mode: 'ok', // ok | hang-head | never-end | slow-head-hold | ok-then-break | half-packet | tail-packet | http500-garbage | stall | no-success | line-json | empty-frames
    holdMs: 0,
    llmDeltas: DEFAULT_DELTAS,
    llmLangType: 'zh-CHS',
    /** 最近一次 llm 回话写给客户端的**原始字节**（S12 取证：证明假上游发的是真 SSE 帧） */
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
    res.on('error', () => {
      /* 客户端已走：不让它变成 unhandled 'error' 打死进程 */
    });
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
        salt,
        curtime,
        sign: String(fields.sign ?? ''),
        signOk,
        at: Date.now(),
      });
      let released = false;
      res.on('close', () => {
        if (!released) {
          released = true;
          state.inflight = Math.max(0, state.inflight - 1);
        }
      });

      // ① 验签
      if (!signOk) {
        state.badSign += 1;
        replyErr(res, isLlm, '202');
        return;
      }
      // ② 防重放（salt 每次请求都必须重新生成，否则必撞这里）
      if (state.seenSalts.has(salt)) {
        replyErr(res, isLlm, '207');
        return;
      }
      state.seenSalts.add(salt);

      // ③ 内容触发
      const tm = /__T_([A-Z0-9]+)__/.exec(q);
      const token = tm ? tm[1] : '';
      if (token === 'M303F') {
        // 第一次 303（可重试），之后正常 —— 用来验"重试真的发生了且换了 salt"
        if (!state.first303.has(q)) {
          state.first303.add(q);
          replyErr(res, isLlm, '303');
          return;
        }
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
        try {
          return res.write(chunk);
        } catch {
          return false;
        }
      };

      /** 正常回话：text 回整体 JSON；llm 回**真实有道的 SSE 帧**（`event:message` + `data:`） */
      const replyOk = () => {
        if (isLlm) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          const objOf = (d, i) => ({
            code: '0',
            successful: true,
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
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
      };

      switch (mode) {
        case 'hang-head':
          return; // 永不回话 → ttfb 层
        case 'stall':
          setTimeout(replyOk, state.holdMs);
          return;
        case 'slow-head-hold': // 头先拖一会，再给半截身子 → idle 层
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
          state.lastLlmRaw = sseFrame({
            code: '0',
            successful: true,
            data: { transIncre: state.llmDeltas[0], langType: state.llmLangType },
          });
          safeWrite(state.lastLlmRaw);
          setTimeout(() => {
            try {
              res.socket?.destroy();
            } catch {
              /* ignore */
            }
          }, 40);
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
        default:
          replyOk();
      }
    });
    req.on('aborted', () => {
      /* 客户端中途走了：等 'close' 释放即可 */
    });
  });

  return { state, server, port: 0 };
}

// ------------------------------------------------------------------ 进程夹具（R 组起真服务）

let fake = null;

function spawnProc(entry, env, tag, args = []) {
  // 🔴 反证开关是**进程内夹具**，绝不漏进服务子进程：R 组量的是产品路径（路由层接线），
  //    而产品路径上没有人会设这些变量。漏进去会让同一条断言被好几个开关同时打红，
  //    "一条开关护一条机制"的归因就散了（各开关的哨兵在 S/T/L/C/K/A 组里，K1 盯 echoSecret）。
  // ⚠️ 不能"从副本里删掉"：`spawnTarget` 内部会 `{...process.env, ...env}`（它要保留 PATH 等），
  //    副本里删掉的键会从 `process.env` 原样回来 —— 必须**在 spawn 那一刻**把父进程里的这几个键
  //    摘掉再还原（env 快照在 spawn 时同步取走，晚一步还原不影响子进程）。
  const stash = [];
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('MIAO_TRANSLATE_REFUTE_')) {
      stash.push([k, process.env[k]]);
      delete process.env[k];
    }
  }
  let child;
  try {
    // entry 是服务 ⇒ 按 harness 选靶子（只剩 boxsvc）；是 refute 子进程（SELF）⇒ 原样走 node
    child = spawnTarget(entry, env, args);
  } finally {
    for (const [k, v] of stash) process.env[k] = v;
  }
  const st = { child, tag, out: '', err: '', ready: null };
  child.stdout.on('data', (d) => {
    st.out += d.toString();
    const m = /MIAO_READY (\{.*\})/.exec(st.out);
    if (m && !st.ready) {
      try {
        st.ready = JSON.parse(m[1]);
      } catch {
        /* 继续等 */
      }
    }
  });
  child.stderr.on('data', (d) => {
    st.err += d.toString();
  });
  return st;
}

async function waitReady(st, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (!st.ready && Date.now() < until) await sleep(40);
  if (!st.ready) throw new Error(`${st.tag} 未就绪：stdout=${st.out}\nstderr=${st.err}`);
  return st.ready;
}

function killProc(st) {
  // 🔴 杀进程树（不是只杀主进程）：rust 服务派生的引擎②/③ 否则全成孤儿（D-202）
  if (st && st.child.exitCode === null) killTree(st.child);
}

// ------------------------------------------------------------------ HTTP 小工具（R 组打真路由）

function httpReq(port, method, pathname, { headers = {}, body = null, token } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (token) h['X-Box-Token'] = token;
    if (body) h['Content-Length'] = body.length;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: h,
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const jsonOf = (res) => {
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    return null;
  }
};
const get = (port, p) => httpReq(port, 'GET', p, { token: TOKEN });
const post = (port, p, obj) =>
  httpReq(port, 'POST', p, {
    token: TOKEN,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(obj), 'utf8'),
  });

/** 把 SSE 响应体切成事件（`id: N\nevent: X\ndata: {...}\n\n`） */
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
      else if (k === 'data') {
        try {
          ev.data = JSON.parse(v);
        } catch {
          ev.data = v;
        }
      }
    }
    if (ev.event) out.push(ev);
  }
  return out;
}

// ================================================================ S · 签名与协议

async function groupS() {
  // S1 长文本（>20 字符）走签名截断
  {
    const t = longText();
    const r = await text({ text: t, from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    const hit = lastHit();
    const input = `${t.slice(0, 10)}${t.length}${t.slice(-10)}`;
    const expect = sha(TEST_APP_KEY + input + hit.salt + hit.curtime + TEST_APP_SECRET);
    check(
      `S1 长文本（${t.length} 字符 > 20）按「前10+长度+后10」截断后参与签名：假上游同算法验签通过、独立重算的 sign 逐字一致`,
      t.length === LONG_LEN && !r.err && expect === hit.sign && hit.signOk,
      r.err
        ? errText(r.err)
        : `input=${input} sign=${hit.sign.slice(0, 8)}… 假上游验签=${hit.signOk ? '通过' : '拒绝'}`,
    );
  }

  // S2 短文本（≤20）不截断
  {
    const t = nextText('短');
    const r = await text({ text: t, from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    const hit = lastHit();
    const expect = sha(TEST_APP_KEY + t + hit.salt + hit.curtime + TEST_APP_SECRET);
    check(
      'S2 短文本（≤20 字符）原样参与签名（不截断）：独立重算的 sign 逐字一致',
      !r.err && t.length <= 20 && expect === hit.sign && hit.signOk,
      r.err ? errText(r.err) : `len=${t.length} sign=${hit.sign.slice(0, 8)}…`,
    );
  }

  // S3 每次请求换 salt
  {
    const a = nextText('盐');
    const b = nextText('盐');
    const ra = await text({ text: a, from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    const rb = await text({ text: b, from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    const ha = fake.state.hits[fake.state.hits.length - 2];
    const hb = fake.state.hits[fake.state.hits.length - 1];
    check(
      'S3 每次请求重新生成 salt + curtime + sign（不是进程级常量）：两次不同 text 的 salt 必然不同',
      !ra.err && !rb.err && ha.salt !== hb.salt && ha.sign !== hb.sign && ha.signOk && hb.signOk,
      `saltA=${ha.salt.slice(0, 8)}… saltB=${hb.salt.slice(0, 8)}…`,
    );
  }

  // S4 重试也换 salt
  {
    const t = trig('M303F');
    const r = await text({ text: t, from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    const mine = fake.state.hits.filter((h) => h.fields.q === t);
    check(
      'S4 重试也重新生成 salt（§7.3：复用 salt 必撞上游防重放 207）：第一次 303 → 重试即成功，两次 salt 不同、两次都过验签',
      !r.err &&
        mine.length === 2 &&
        mine[0].salt !== mine[1].salt &&
        mine.every((h) => h.signOk) &&
        r.value.text === `[译]${t}`,
      r.err
        ? errText(r.err)
        : `请求数=${mine.length} salt0=${mine[0].salt.slice(0, 8)}… salt1=${mine[1].salt.slice(0, 8)}… 译文=${r.value.text}`,
    );
  }

  // S5 text 出网字段集
  {
    const t = nextText('字段');
    const r = await text({ text: t, from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    const hit = lastHit();
    const keys = Object.keys(hit.fields).sort().join(',');
    check(
      'S5 text 出网协议：Content-Type 为 form-urlencoded；字段恰为 q/from/to/domain/strict + 签名五件套（signType=v3、strict=false）',
      !r.err &&
        hit.contentType.startsWith('application/x-www-form-urlencoded') &&
        keys === 'appKey,curtime,domain,from,q,salt,sign,signType,strict,to' &&
        hit.fields.signType === 'v3' &&
        hit.fields.strict === 'false' &&
        hit.fields.from === 'ja' &&
        hit.fields.to === 'zh-CHS',
      `ct=${hit.contentType} 字段=${keys}`,
    );
  }

  // S6 llm 出网字段集
  {
    const t = nextText('流字段');
    const r = await stream({ text: t, from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    const hit = lastHit();
    const keys = Object.keys(hit.fields).sort().join(',');
    check(
      'S6 llm 出网协议：字段恰为 i/prompt/from/to/streamType/handleOption + 签名五件套（streamType=increment、handleOption 缺省 0）',
      !r.err &&
        hit.path === '/proxy/http/llm-trans' &&
        hit.contentType.startsWith('application/x-www-form-urlencoded') &&
        keys === 'appKey,curtime,from,handleOption,i,prompt,salt,sign,signType,streamType,to' &&
        hit.fields.streamType === 'increment' &&
        hit.fields.handleOption === '0' &&
        hit.fields.i === t,
      `字段=${keys}`,
    );
  }

  // S7 首块锁定
  {
    const t = trig('MBREAK');
    const r = await stream({ text: t, from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    const mine = fake.state.hits.filter((h) => h.fields.i === t);
    check(
      'S7 首块锁定：首块之后失败**绝不重试**（§7.3 —— 重来会重复/覆盖已吐给用户的增量）：上游吐了一块就掐流，请求数仍为 1',
      mine.length === 1 && (r.deltas || []).length === 1 && r.err?.code === 'TRANSLATE_UPSTREAM_UNREACHABLE',
      `请求数=${mine.length} 已吐增量=${(r.deltas || []).length} ${r.err ? errText(r.err) : '竟然成功了'}`,
    );
  }

  // S8 text 判成功单判
  {
    const t = nextText('判成');
    const r = await text({ text: t, from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    check(
      'S8 text 判成功按 `errorCode === "0"` **单判**：假上游的回话里**没有** successful 字段也判成功（不拿 llm 的双判去要求 text 接口）',
      !r.err && r.value.text === `[译]${t}`,
      r.err ? errText(r.err) : `译文=${r.value.text}`,
    );
  }

  // S9 llm 判成功双判
  {
    const t = trig('MNOOK');
    const r = await stream({ text: t, from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    const mine = fake.state.hits.filter((h) => h.fields.i === t);
    check(
      'S9 llm 判成功按 `code === "0"` **且** `successful === true` 双判：code 是 "0" 但 successful=false 必须判失败（而不是当成功吐个空译文）',
      r.err?.code === 'TRANSLATE_UPSTREAM_ERROR' && mine.length === 1,
      `${r.err ? errText(r.err) : '竟然成功了'} 请求数=${mine.length}`,
    );
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
    const listed = rows.map(([api, token]) => ({
      name: `${api}/${token}`,
      kind: api === 'text' ? 'text' : 'stream',
      body: { text: trig(token), from: 'ja', to: 'zh', timeoutMs: 8000 },
      env: envOf(),
    }));
    const got = await runCases(listed);
    const bad = [];
    rows.forEach(([api, token, want], i) => {
      const r = got[i] || {};
      const wantStatus = CODE_STATUS[want];
      if (r.err?.code !== want || r.err?.status !== wantStatus) {
        bad.push(`${api}/${token}→${r.err ? `${r.err.code}/${r.err.status}` : '成功'}（要 ${want}/${wantStatus}）`);
      }
    });
    check(
      `S10 上游业务码 → 统一码 + HTTP 状态（${rows.length} 行表驱动，两接口各查自己那张表；未登记码 999 落兜底 UPSTREAM_ERROR）`,
      bad.length === 0,
      bad.length ? `不符：${bad.join('；')}` : `${rows.length} 行全部命中`,
    );
  }

  // S11 半包 / 尾包
  {
    const keep = fake.state.llmDeltas;
    fake.state.llmDeltas = ['ABCD'];
    const r1 = await stream({ text: trig('MHALF'), from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    fake.state.llmDeltas = ['XY', 'Z'];
    const r2 = await stream({ text: trig('MTAIL'), from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    fake.state.llmDeltas = keep;
    const d1 = r1.deltas || [];
    const d2 = r2.deltas || [];
    check(
      'S11 半包（一帧拆在两个 TCP 块里）与尾包（最后一帧没有收尾空行）都吃得下：增量不丢不重、顺序不乱，累计全文与增量拼接逐字一致',
      !r1.err &&
        !r2.err &&
        d1.join('') === 'ABCD' &&
        d2.join('') === 'XYZ' &&
        r1.value.text === 'ABCD' &&
        r2.value.text === 'XYZ',
      `半包=${JSON.stringify(d1)}/${JSON.stringify(r1.value && r1.value.text)} 尾包=${JSON.stringify(d2)}/${JSON.stringify(r2.value && r2.value.text)}`,
    );
  }

  // S12 真上游形态：SSE 帧（`event:message` + `data:`）必须被解析
  {
    const t = nextText('帧');
    const r = await stream({ text: t, from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    const raw = fake.state.lastLlmRaw;
    const deltas = r.deltas || [];
    check(
      'S12 🔴 真上游形态是**标准 SSE 帧**（`event:message` + `data:{...}`，D-130 真机取证）：解析器逐帧取出 3 条增量、累计一致；且假上游确以该形态回话（旧"裸 JSON 行"解析器在这条上必红）',
      !r.err && /^event:message\ndata:\{/.test(raw) && deltas.join('') === '甲乙丙' && r.value.text === '甲乙丙',
      r.err ? errText(r.err) : `raw=${JSON.stringify(raw.slice(0, 40))}… 增量=${JSON.stringify(deltas)}`,
    );
  }

  // S13 向后兼容：裸 JSON 行
  {
    const keep = fake.state.llmDeltas;
    fake.state.llmDeltas = ['AB', 'C'];
    const r = await withMode('line-json', 0, () =>
      stream({ text: trig('MLINEJSON'), from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf()),
    );
    const raw = fake.state.lastLlmRaw;
    fake.state.llmDeltas = keep;
    const deltas = r.deltas || [];
    check(
      'S13 向后兼容：**裸 JSON 行**（非 SSE 帧）仍被解析 —— 上一步的修复不许把"逐行 JSON"这条形态打死（两种形态都要吃得下）',
      !r.err && !raw.startsWith('event:') && deltas.join('') === 'ABC' && r.value.text === 'ABC',
      r.err ? errText(r.err) : `raw=${JSON.stringify(raw.slice(0, 30))}… 增量=${JSON.stringify(deltas)}`,
    );
  }

  // S14 200 但零帧 ⇒ 报错，不许"成功 + 空译文"
  {
    const t = trig('MEMPTY');
    const r = await withMode('empty-frames', 0, () =>
      stream({ text: t, from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf()),
    );
    const mine = fake.state.hits.filter((h) => h.fields.i === t);
    check(
      'S14 🔴 上游 200 但**零可解析帧**（协议错配/空响应）⇒ 报 UPSTREAM_ERROR（reason=no_frames），绝不返回"成功 + 空译文"（与"非 2xx 先判死"配对：前者挡挂掉的上游，这一判挡"回话了却读不出"的上游）',
      r.err?.code === 'TRANSLATE_UPSTREAM_ERROR' &&
        r.err.details?.reason === 'no_frames' &&
        (r.deltas || []).length === 0 &&
        mine.length === 1,
      `${r.err ? errText(r.err) : '竟然成功了（空译文）'} 请求数=${mine.length} 增量=${(r.deltas || []).length}`,
    );
  }
}

// ================================================================ T · 四层超时

async function groupT() {
  const BH = await findBlackhole();

  // T1 connect 层
  if (!BH) {
    check(
      'T1 connect 层超时（黑洞地址，`details.stage === "connect"`）',
      false,
      `候选 ${BLACKHOLE_CANDIDATES.join(' / ')} 全部探不通（既没挂住也没拒），本机网络环境不支持该用例`,
    );
  } else {
    const before = fake.state.hits.length;
    const r = await text(
      { text: nextText('建连'), from: 'ja', to: 'zh', timeoutMs: 8000 },
      envOf({ MIAO_TRANSLATE_YOUDAO_BASE: `http://${BH}:443`, MIAO_TRANSLATE_CONNECT_MS: '400' }),
    );
    check(
      'T1 connect 层：黑洞地址 400ms 内建不上 → 504 TIMEOUT 且 `details.stage === "connect"`（不可达要**快败**，不是等满总超时）；一个请求都没到假上游',
      r.err?.code === 'TRANSLATE_TIMEOUT' && r.err.details?.stage === 'connect' && fake.state.hits.length === before,
      r.err ? errText(r.err) : '竟然成功了',
    );
  }

  // T2 ttfb 层
  {
    const r = await withMode('hang-head', 0, () =>
      text(
        { text: nextText('首字节'), from: 'ja', to: 'zh', timeoutMs: 8000 },
        envOf({ MIAO_TRANSLATE_TTFB_MS: '400' }),
      ),
    );
    check(
      'T2 ttfb 层：连上了但上游 400ms 不给响应头 → 504 TIMEOUT 且 stage === "ttfb"（大模型首字慢与整段慢是两件事，单独一档）',
      r.err?.code === 'TRANSLATE_TIMEOUT' && r.err.details?.stage === 'ttfb',
      r.err ? errText(r.err) : '竟然成功了',
    );
  }

  // T3 idle 层
  {
    const r = await withMode('never-end', 0, () =>
      text({ text: nextText('空闲'), from: 'ja', to: 'zh', timeoutMs: 5000 }, envOf({ MIAO_TRANSLATE_IDLE_MS: '400' })),
    );
    check(
      'T3 idle 层：响应头到了、身子只剩半截且不再有字节 → 504 TIMEOUT 且 stage === "idle"（「卡住」与「慢慢吐」只有空闲超时能区分）',
      r.err?.code === 'TRANSLATE_TIMEOUT' && r.err.details?.stage === 'idle',
      r.err ? errText(r.err) : '竟然成功了',
    );
  }

  // T4 total 层
  {
    const r = await withMode('slow-head-hold', 250, () =>
      text(
        { text: nextText('总时长'), from: 'ja', to: 'zh', timeoutMs: 800 },
        envOf({ MIAO_TRANSLATE_IDLE_MS: '60000' }),
      ),
    );
    check(
      'T4 total 层：idle 档放到 60s、请求自带 800ms 总预算 → 504 TIMEOUT 且 stage === "total"（总体永不结束要兜底，且不与 idle 混为一谈）',
      r.err?.code === 'TRANSLATE_TIMEOUT' && r.err.details?.stage === 'total',
      r.err ? errText(r.err) : '竟然成功了',
    );
  }
}

// ================================================================ L · 限流

async function groupL() {
  // 先把服务侧在飞数放干，再开始量峰值：T 组的超时用例是**客户端主动放弃**的请求，
  // 它对应的 `res.on('close')` 释放可能比 L1 突发晚几个事件循环 tick 才被处理 ——
  // 那时这个"早已废弃的请求"仍记在在飞数里，会把峰值抬到 4，而限流闸门明明只放了 3 个
  // （假绿纪律：峰值必须只由 L1 自己的请求构成，不吃上一组的记账竞态）。
  {
    const until = Date.now() + 2000;
    while (fake.state.inflight > 0 && Date.now() < until) await sleep(20);
  }

  // L1 并发闸门（stall 300ms 把三个在飞请求钉住，峰值才测得准）
  {
    const startInflight = fake.state.inflight;
    const before = fake.state.hits.length;
    const r = await withMode('stall', 300, () =>
      batch({ call: 'text', count: 6, bodies: uniqueBodies(6, '并发', { timeoutMs: 8000 }) }, envOf()),
    );
    const items = r.items || [];
    const errs = items.filter((x) => x.err).length;
    check(
      'L1 并发闸门：6 个并发 stall 请求 → 假上游**在飞数峰值恰为 3**（不超过 3）、6 个全部成功',
      items.length === 6 && errs === 0 && fake.state.peakInflight === 3 && fake.state.hits.length - before === 6,
      `peak=${fake.state.peakInflight} hits+${fake.state.hits.length - before} 失败=${errs} 突发前在飞=${startInflight}`,
    );
  }

  // L2 速率闸门
  {
    const r = await batch({ call: 'text', count: 25, bodies: uniqueBodies(25, '速率', { timeoutMs: 400 }) }, envOf());
    const items = r.items || [];
    const ok = items.filter((x) => !x.err).length;
    const limited = items.filter((x) => x.err?.code === 'TRANSLATE_RATE_LIMITED');
    check(
      'L2 速率闸门：25 个并发 + 400ms 排队上限 → 至少 1 个 429 RATE_LIMITED 且 `details.stage === "limiter"`（**不是** 504：用户该做的是"等一会儿再点"，重试只会更堵）；成功+限流 = 25',
      items.length === 25 &&
        limited.length >= 1 &&
        ok + limited.length === 25 &&
        ok >= 3 &&
        limited.every((x) => x.err.details?.stage === 'limiter'),
      `成功=${ok} 限流=${limited.length}`,
    );
  }
}

// ================================================================ C · 三层设置

async function groupC() {
  const C1_DIR = path.join(TMP, 'c1');
  fs.mkdirSync(C1_DIR, { recursive: true });

  // C1 文件不存在 = 正常首次启动
  {
    const v = await options(envOf({ MIAO_STATE_DIR: C1_DIR }));
    check(
      'C1 设置文件不存在 = **正常的首次启动**（不是错误）：全部出厂默认、sources 逐键标 default、fileIssues.exists=false',
      !v.err &&
        v.value.settings.platform === 'youdao' &&
        v.value.settings.source === 'local' &&
        v.value.settings['youdao.llmModel'] === 'pro' &&
        v.value.settings['youdao.textDomain'] === 'general' &&
        v.value.settings.timeoutMs === 30000 &&
        Object.values(v.value.sources).every((s) => s === 'default') &&
        v.value.fileIssues.exists === false &&
        v.value.fileIssues.corrupt === false,
      v.err ? errText(v.err) : JSON.stringify(v.value.sources),
    );
  }

  // C2 保存补丁（以盘上文件为准）
  {
    fs.rmSync(SETTINGS_FILE, { force: true });
    const r = await saveSettings({ 'youdao.llmModel': 'lite', timeoutMs: 12345 }, envOf());
    const disk = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const v = await options(envOf());
    check(
      'C2 保存补丁：返回 changed 与生效值，**回读盘上那个 JSON** 一致（不信响应自报），options 的 sources 逐键标为 file',
      !r.err &&
        r.value.changed.length === 2 &&
        r.value.settings['youdao.llmModel'] === 'lite' &&
        disk['youdao.llmModel'] === 'lite' &&
        disk.timeoutMs === 12345 &&
        !v.err &&
        v.value.settings['youdao.llmModel'] === 'lite' &&
        v.value.sources['youdao.llmModel'] === 'file' &&
        v.value.sources.timeoutMs === 'file',
      r.err ? errText(r.err) : JSON.stringify(disk),
    );
  }

  // C3 env 优先（且逐键可追溯）
  {
    const v = await options(envOf({ MIAO_TRANSLATE_SOURCE: 'online', MIAO_TRANSLATE_TIMEOUT_MS: '7777' }));
    check(
      'C3 env 覆盖文件（env > 文件 > 默认）：source=online / timeoutMs=7777 且 sources 标为 env；同一份视图里文件键仍标 file（"这个值谁定的"必须答得出来）',
      !v.err &&
        v.value.settings.source === 'online' &&
        v.value.sources.source === 'env' &&
        v.value.settings.timeoutMs === 7777 &&
        v.value.sources.timeoutMs === 'env' &&
        v.value.settings['youdao.llmModel'] === 'lite' &&
        v.value.sources['youdao.llmModel'] === 'file' &&
        v.source === 'online',
      v.err
        ? errText(v.err)
        : `source=${v.value.settings.source} timeoutMs=${v.value.settings.timeoutMs} 入口来源=${v.source}`,
    );
  }

  // C4 补丁 strict：一律拒绝且不落盘
  {
    const before = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const patches = [
      ['youdao.llmmodel', 'pro', '未知键（大小写写错）'],
      [{ timeoutMs: 'abc' }, null, '非法值'],
      [{}, null, '空补丁'],
      [{ platform: 'bogus' }, null, '未登记平台'],
    ];
    const rs = [];
    for (const [key, val, why] of patches) {
      const patch = typeof key === 'string' ? { [key]: val } : key;
      const r = await saveSettings(patch, envOf());
      rs.push({ r, why });
    }
    const after = fs.readFileSync(SETTINGS_FILE, 'utf8');
    check(
      'C4 补丁 strict 校验：未知键 / 非法值 / 空补丁 / 未登记平台 一律 INVALID_SETTING 抛错（不静默丢），且**盘上文件一字节未动**',
      rs.every(({ r }) => r.err && r.err.code === 'INVALID_SETTING' && r.err.status === 400) && before === after,
      `${rs.map(({ r, why }) => (r.err ? r.err.code : `通过(${why})`)).join('/')} 盘上未动=${before === after}`,
    );
  }

  // C5 读路径 strict:false：丢弃 + 上报
  {
    fs.writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({
        platform: 'youdao',
        bogusKey: 1,
        timeoutMs: 'not-a-number',
        'youdao.textDomain': 'medicine',
      }),
    );
    const v = await options(envOf());
    check(
      'C5 读路径 strict:false：未知键与非法值**丢弃 + 上报**（不静默、也不为一个多余键让整份设置失效），上报一路带到 options 的 fileIssues；合法键照常生效',
      !v.err &&
        v.value.settings.platform === 'youdao' &&
        v.value.settings['youdao.textDomain'] === 'medicine' &&
        v.value.settings.timeoutMs === 30000 &&
        v.value.fileIssues.unknownKeys.length === 1 &&
        v.value.fileIssues.unknownKeys[0] === 'bogusKey' &&
        v.value.fileIssues.invalid.length === 1 &&
        v.value.fileIssues.invalid[0].key === 'timeoutMs',
      v.err
        ? errText(v.err)
        : JSON.stringify({ unknownKeys: v.value.fileIssues.unknownKeys, invalid: v.value.fileIssues.invalid }),
    );
  }

  // C6 坏文件不阻断
  {
    fs.writeFileSync(SETTINGS_FILE, '{ 这不是合法 JSON');
    const before = fake.state.hits.length;
    const v = await options(envOf());
    const r = await text({ text: nextText('坏文件'), from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    check(
      'C6 损坏文件：corrupt=true + reason 说清是哪一种坏，且**不阻断翻译**（落出厂默认照常出网，一次都没少）',
      !v.err &&
        v.value.fileIssues.corrupt === true &&
        String(v.value.fileIssues.reason).includes('JSON 解析失败') &&
        !r.err &&
        fake.state.hits.length === before + 1,
      `corrupt=${v.value && v.value.fileIssues.corrupt} reason=${v.value && v.value.fileIssues.reason} ${r.err ? errText(r.err) : '翻译正常'}`,
    );
    fs.rmSync(SETTINGS_FILE, { force: true });
  }
}

// ================================================================ K · 密钥隔离

async function groupK() {
  // K1 脱敏视图
  {
    const v = await options(envOf());
    const view = v.value && v.value.credentials;
    const raw = JSON.stringify(view);
    check(
      'K1 密钥视图脱敏：只回 `{ appKey, hasSecret }`，**任何出口都不回显 appSecret**（连 JSON 串里都搜不到）',
      !v.err &&
        view &&
        view.youdao &&
        view.youdao.appKey === TEST_APP_KEY &&
        view.youdao.hasSecret === true &&
        Object.keys(view.youdao).sort().join(',') === 'appKey,hasSecret' &&
        !raw.includes(TEST_APP_SECRET),
      JSON.stringify(view),
    );
  }

  // K2 缺密钥 → 不出网
  {
    const before = fake.state.hits.length;
    fs.rmSync(CREDENTIALS_FILE, { force: true });
    const r = await text({ text: nextText('无密钥'), from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    check(
      'K2 未配置密钥 → 503 NOT_CONFIGURED，且**一个请求都没出网**（在适配器断言密钥那一关就挡下，不是发出去再失败）',
      r.err?.code === 'TRANSLATE_NOT_CONFIGURED' && r.err.status === 503 && fake.state.hits.length === before,
      `${r.err ? errText(r.err) : '竟然成功了'} hits+${fake.state.hits.length - before}`,
    );
  }

  // K3 改了密钥下次调用即生效
  {
    const r1 = await saveCredentials({ platform: 'youdao', appKey: TEST_APP_KEY, appSecret: TEST_APP_SECRET }, envOf());
    const r2 = await text({ text: nextText('补密钥'), from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    const saved = r1.value && r1.value.saved;
    check(
      'K3 重新保存密钥后**立即生效**（每次调用现读、适配器不缓存）：翻译恢复成功，且保存响应只回 {platform, appKey}',
      !r1.err &&
        saved &&
        saved.platform === 'youdao' &&
        saved.appKey === TEST_APP_KEY &&
        !('appSecret' in saved) &&
        !JSON.stringify(r1.value).includes(TEST_APP_SECRET) &&
        !r2.err,
      r1.err ? errText(r1.err) : r2.err ? errText(r2.err) : `保存回 ${JSON.stringify(r1.value)}；译文=${r2.value.text}`,
    );
  }

  // K4 保存校验 + 原子写
  {
    const dir = path.join(TMP, 'k4');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'translate-credentials.json');
    const env = envOf({ MIAO_STATE_DIR: dir });
    const r1 = await saveCredentials({ platform: 'youdao', appKey: '', appSecret: 'x' }, env);
    const r2 = await saveCredentials({ platform: 'youdao', appKey: 'ak', appSecret: '' }, env);
    const r3 = await saveCredentials({ platform: 'youdao', appKey: 'ak', appSecret: 'x'.repeat(129) }, env);
    const r4 = await saveCredentials({ platform: ' youdao ', appKey: ' ak ', appSecret: ' sk ' }, env);
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
    const mode = (fs.statSync(f).mode & 0o777).toString(8);
    // Windows 上只有"可写/只读"一位，0o600 会落成 0o666 —— 权限位数的口径按平台分开
    const modeOk = process.platform === 'win32' ? mode === '666' : mode === '600';
    check(
      'K4 保存校验：appKey 空 / appSecret 空 / appSecret 超 128 一律 400 INVALID_INPUT；成功的那次 trim + 原子写（无 tmp 残留）+ 权限位收紧',
      [r1, r2, r3].every((r) => r.err?.code === 'TRANSLATE_INVALID_INPUT') &&
        !r4.err &&
        modeOk &&
        leftovers.length === 0 &&
        JSON.parse(fs.readFileSync(f, 'utf8')).platforms.youdao.appKey === 'ak',
      `mode=${mode} tmp残留=${leftovers.length} ${[r1, r2, r3].map((r) => (r.err ? r.err.code : '通过')).join('/')}`,
    );
  }
}

// ================================================================ A · 契约与适配器

async function groupA() {
  // A1 未知平台
  {
    const before = fake.state.hits.length;
    const r = await text(
      { platform: 'bogus', text: nextText('未知平台'), from: 'ja', to: 'zh', timeoutMs: 8000 },
      envOf(),
    );
    check(
      'A1 未知平台 id → 400 INVALID_INPUT 且 details.available 报得出有哪些平台（界面据此提示"只能选这些"，不让用户面对一个光秃秃的"翻译失败"）',
      r.err?.code === 'TRANSLATE_INVALID_INPUT' &&
        Array.isArray(r.err.details?.available) &&
        r.err.details.available.includes('youdao') &&
        fake.state.hits.length === before,
      r.err ? errText(r.err) : '竟然成功了',
    );
  }

  // A2 语言码不猜
  {
    const before = fake.state.hits.length;
    const r1 = await text({ text: nextText('方向'), from: 'xx', to: 'zh', timeoutMs: 8000 }, envOf());
    const r2 = await stream({ text: nextText('方向'), from: 'ko', to: 'zh', timeoutMs: 8000 }, envOf());
    check(
      'A2 语言码「认不出就不猜」：text 收完全不认识的 xx、llm 收 ko（ko 只在 text 表里，llm 表更短）→ 一律 400 INVALID_INPUT，details.api 分别记 text/llm（两表分别查过的证据）；两次都没出网',
      r1.err?.code === 'TRANSLATE_INVALID_INPUT' &&
        r1.err.details?.api === 'text' &&
        r2.err?.code === 'TRANSLATE_INVALID_INPUT' &&
        r2.err.details?.api === 'llm' &&
        Array.isArray(r2.err.details?.langs) &&
        r2.err.details.langs.includes('ja') &&
        fake.state.hits.length === before,
      `${r1.err ? r1.err.code : '通过'} / ${r2.err ? r2.err.code : '通过'} hits+${fake.state.hits.length - before}`,
    );
  }

  // A3 参数裁剪
  {
    const t1 = nextText('裁剪');
    const r1 = await text(
      {
        text: t1,
        from: 'ja',
        to: 'zh',
        domain: 'computers',
        vocabId: 'v-1',
        prompt: '不该来',
        model: 'pro',
        timeoutMs: 8000,
      },
      envOf(),
    );
    const h1 = lastHit();
    const k1 = Object.keys(h1.fields).sort().join(',');
    const t2 = nextText('裁剪');
    const r2 = await stream(
      { text: t2, from: 'ja', to: 'zh', domain: 'computers', vocabId: 'v-1', timeoutMs: 8000 },
      envOf(),
    );
    const h2 = lastHit();
    const k2 = Object.keys(h2.fields).sort().join(',');
    check(
      'A3 参数裁剪（§5.4）：text 出网只带 q/from/to/domain/vocabId/strict + 签名五件套（prompt/model 传进来也漏不出去）；llm 出网只带 i/prompt/from/to/streamType/handleOption + 签名五件套（domain/vocabId 同理）',
      !r1.err &&
        !r2.err &&
        k1 === 'appKey,curtime,domain,from,q,salt,sign,signType,strict,to,vocabId' &&
        h1.fields.domain === 'computers' &&
        h1.fields.vocabId === 'v-1' &&
        k2 === 'appKey,curtime,from,handleOption,i,prompt,salt,sign,signType,streamType,to',
      `text字段=${k1}｜llm字段=${k2}`,
    );
  }

  // A4 按行对齐的双向不对称
  {
    const r1 = await text({ text: 'A\nB\nC', from: 'ja', to: 'zh', splitLines: true, timeoutMs: 8000 }, envOf());
    const one = `${trig('M1LINE')}\nX`; // 上游把整段当一行回（translation 长度 1 ≠ 入参 2 行）
    const r2 = await text({ text: one, from: 'ja', to: 'zh', splitLines: true, timeoutMs: 8000 }, envOf());
    check(
      'A4 按行对齐**双向不对称**：上游逐行数与入参行数一致才给 lines（3=3 → 3 行）；不一致（1≠2）**整个 lines 键都不给** —— 错位的逐行译文比没逐行危害大得多（会把 A 行译文贴到 B 行）',
      !r1.err &&
        !r2.err &&
        Array.isArray(r1.value.lines) &&
        r1.value.lines.length === 3 &&
        r1.value.lines[0] === '[译]A' &&
        !('lines' in r2.value),
      // detail 也要防空：反证轮里 r1/r2 可能是 err（value 为 null），
      // 模板里直接点 .value 会把「断言变红」升级成「脚本崩了」—— 两件事必须分开。
      `一致→lines=${r1.err ? errText(r1.err) : JSON.stringify(r1.value.lines)}；不一致→${r2.err ? errText(r2.err) : Object.keys(r2.value).join(',')}`,
    );
  }

  // A5 模型档位 → handleOption
  {
    const rows = [
      ['pro', '0'],
      ['lite', '3'],
      [undefined, '0'],
    ];
    const bad = [];
    for (const [model, want] of rows) {
      const r = await stream({ text: nextText('档位'), from: 'ja', to: 'zh', model, timeoutMs: 8000 }, envOf());
      const h = lastHit();
      const got = h.fields.handleOption ?? '无请求';
      if (r.err || got !== want) bad.push(`${model === undefined ? '缺省' : model}→${got}（要 ${want}）`);
    }
    const before = fake.state.hits.length;
    const rb = await stream({ text: nextText('档位'), from: 'ja', to: 'zh', model: 'bogus', timeoutMs: 8000 }, envOf());
    check(
      'A5 模型档位 → handleOption：pro→"0"（子曰 14B）/ lite→"3"（1.5B）/ 缺省→"0"；非法值当场 400 INVALID_INPUT 且**不出网**（不静默回落成 pro —— 那会让人以为在用车，其实在用另一辆）',
      bad.length === 0 && rb.err?.code === 'TRANSLATE_INVALID_INPUT' && fake.state.hits.length === before,
      bad.length ? `不符：${bad.join('；')}` : `三档命中；bogus→${rb.err ? rb.err.code : '竟然出网了'}`,
    );
  }

  // A6 llm 非 2xx 先判死
  {
    const t = trig('M500G');
    const r = await stream({ text: t, from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    const mine = fake.state.hits.filter((h) => h.fields.i === t);
    check(
      'A6 llm 非 2xx **先判死**：上游回 500 + 垃圾体（不是逐行 JSON）→ UPSTREAM_ERROR + httpStatus=500；绝不解析出空译文当成功（那对用户是"译了一整遍，结果是空的"）。5xx 属可重试 → 退避重试一次仍 500',
      r.err?.code === 'TRANSLATE_UPSTREAM_ERROR' &&
        r.err.details?.httpStatus === 500 &&
        (r.deltas || []).length === 0 &&
        mine.length === 2,
      `${r.err ? errText(r.err) : '竟然成功了'} 请求数=${mine.length} 增量=${(r.deltas || []).length}`,
    );
  }

  // A7 可重试面
  {
    const t1 = trig('M303F');
    const r1 = await text({ text: t1, from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    const n1 = fake.state.hits.filter((h) => h.fields.q === t1).length;
    const t2 = trig('E411');
    const r2 = await text({ text: t2, from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    const n2 = fake.state.hits.filter((h) => h.fields.q === t2).length;
    check(
      'A7 可重试面（§7.3）：上游 303（服务端异常）→ 退避重试一次即成功（请求数 2）；411（频率受限）→ **不重试**（请求数 1）直接 429 —— 已经被限还重试只会更堵',
      !r1.err && n1 === 2 && r2.err?.code === 'TRANSLATE_RATE_LIMITED' && r2.err.status === 429 && n2 === 1,
      `303→请求数 ${n1} ${r1.err ? errText(r1.err) : '成功'}；411→请求数 ${n2} ${r2.err ? r2.err.code : '通过'}`,
    );
  }

  // A8 llm 流式累计
  {
    const r = await stream({ text: nextText('流式'), from: 'ja', to: 'zh', timeoutMs: 8000 }, envOf());
    const deltas = r.deltas || [];
    check(
      'A8 llm 流式累计：3 条 transIncre 增量按序交出，累计全文 + langType 一次性给出（拼接归门面，适配器不返全文）',
      !r.err && deltas.join('') === '甲乙丙' && r.value.text === '甲乙丙' && r.value.langType === 'zh-CHS',
      `增量=${JSON.stringify(deltas)} value=${JSON.stringify(r.value)}`,
    );
  }
}

// ================================================================ R · 路由端到端

/**
 * R 组**真起一个 boxsvc 子进程**（不是进程内直调门面）：验的是路由层接线 ——
 * 鉴权、请求体形状、SSE 三事件的顺序与字段、错误信封、只写不读。
 * 子进程的 env 显式给全（`MIAO_TOKEN` 可覆盖，见 config），出网基址指向本进程的假上游。
 */
async function groupR() {
  const port = await findFreePort(5860);
  const stateDir = path.join(TMP, 'r-state');
  const rootDir = path.join(TMP, 'r-root');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(rootDir, { recursive: true });
  // 预置密钥文件：门面每次调用现读，适配器不缓存（这里顺带验"盘上密钥直接可用"）
  fs.writeFileSync(
    path.join(stateDir, 'translate-credentials.json'),
    JSON.stringify({ platforms: { youdao: { appKey: TEST_APP_KEY, appSecret: TEST_APP_SECRET } } }),
    { mode: 0o600 },
  );

  const st = spawnProc(
    SERVICE_ENTRY,
    {
      MIAO_PORT: String(port),
      MIAO_ROOT: rootDir,
      MIAO_STATE_DIR: stateDir,
      MIAO_TOKEN: TOKEN,
      MIAO_NO_LLM_AUTOSTART: '1', // 本组不关心三进程生命周期
      MIAO_TRANSLATE_YOUDAO_BASE: `http://127.0.0.1:${fake.port}`,
      MIAO_TRANSLATE_CONNECT_MS: '5000',
      MIAO_TRANSLATE_TTFB_MS: '5000',
      MIAO_TRANSLATE_IDLE_MS: '20000',
    },
    'box-service(translate)',
  );
  try {
    await waitReady(st);

    // R1 text 路由
    {
      const t = nextText('路由');
      const res = await post(port, '/api/v1/translate/text', { text: t, from: 'ja', to: 'zh' });
      const v = jsonOf(res);
      check(
        'R1 POST /api/v1/translate/text → 200，译文带假上游的 `[译]` 前缀：路由 → 门面 → 适配器 → 假上游整条链通（且密钥是从盘上现读的）',
        res.status === 200 && v && v.text === `[译]${t}`,
        `${res.status} ${JSON.stringify(v)}`,
      );
    }

    // R2 无令牌
    {
      const res = await httpReq(port, 'POST', '/api/v1/translate/text', {
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ text: 'x', from: 'ja', to: 'zh' }), 'utf8'),
      });
      const v = jsonOf(res);
      check(
        'R2 同一路由**无令牌 → 403 PERMISSION_DENIED**：翻译端点是 Box 专用端点，不是免鉴权例外（请求里带着密钥出网，裸奔的代价比别的端点更大）',
        res.status === 403 && v?.error?.code === 'PERMISSION_DENIED',
        `${res.status} ${v?.error?.code}`,
      );
    }

    // R3 流式路由 SSE 三事件（ happy path ）
    {
      const res = await post(port, '/api/v1/translate/stream', { text: nextText('路由流'), from: 'ja', to: 'zh' });
      const evs = parseSse(res.body);
      const deltas = evs.filter((e) => e.event === 'translate.delta');
      const done = evs.find((e) => e.event === 'translate.done');
      check(
        'R3 POST /api/v1/translate/stream → 200 text/event-stream：3 条 translate.delta（增量按序）+ 1 条 translate.done（累计全文 + langType），事件 id 自增',
        res.status === 200 &&
          String(res.headers['content-type']).startsWith('text/event-stream') &&
          deltas.length === 3 &&
          deltas.map((d) => d.data.text).join('') === '甲乙丙' &&
          !!done &&
          done.data.text === '甲乙丙' &&
          done.data.langType === 'zh-CHS' &&
          evs.every((e, i) => e.id === i + 1),
        `${res.status} 事件=${evs.map((e) => e.event).join(',')}`,
      );
    }

    // R4 options 视图（必须排在 R5 之前：R5 会写设置文件，把 default 来源改成 file）
    {
      const res = await get(port, '/api/v1/translate/options');
      const v = jsonOf(res);
      const raw = res.body.toString('utf8');
      check(
        'R4 GET /api/v1/translate/options → 200：platforms 只列已注册平台（youdao，capabilities 含 llm+text）、settings 全出厂默认、sources 逐键标 default、credentials 只回 {appKey, hasSecret}（secret 永不回显）',
        res.status === 200 &&
          v &&
          v.platforms.length === 1 &&
          v.platforms[0].id === 'youdao' &&
          v.platforms[0].capabilities.includes('llm') &&
          v.platforms[0].capabilities.includes('text') &&
          v.settings.timeoutMs === 30000 &&
          v.settings['youdao.llmModel'] === 'pro' &&
          v.settings.source === 'local' &&
          Object.values(v.sources).every((s) => s === 'default') &&
          v.credentials.youdao.appKey === TEST_APP_KEY &&
          v.credentials.youdao.hasSecret === true &&
          Object.keys(v.credentials.youdao).sort().join(',') === 'appKey,hasSecret' &&
          !raw.includes(TEST_APP_SECRET),
        `${res.status} ${raw.slice(0, 140)}…`,
      );
    }

    // R5 settings 补丁
    {
      const ok1 = await post(port, '/api/v1/translate/settings', { timeoutMs: 15000 });
      const v1 = jsonOf(ok1);
      const bad = await post(port, '/api/v1/translate/settings', { 'youdao.llmModel': 'pro', bogusKey: 1 });
      const v2 = jsonOf(bad);
      check(
        'R5 POST /api/v1/translate/settings：合法补丁 → 200 {ok, changed, settings}；混入未知键 → 400 INVALID_SETTING（白名单 strict：不静默丢，丢了的键在界面上就是假控件）',
        ok1.status === 200 &&
          v1.ok === true &&
          Array.isArray(v1.changed) &&
          v1.changed.includes('timeoutMs') &&
          v1.settings.timeoutMs === 15000 &&
          bad.status === 400 &&
          v2?.error?.code === 'INVALID_SETTING',
        `${ok1.status} / ${bad.status} ${v2?.error?.code}`,
      );
    }

    // R6 credentials 只写不读
    {
      const res = await post(port, '/api/v1/translate/credentials', {
        platform: 'youdao',
        appKey: TEST_APP_KEY,
        appSecret: TEST_APP_SECRET,
      });
      const v = jsonOf(res);
      const raw = res.body.toString('utf8');
      check(
        'R6 POST /api/v1/translate/credentials → 200 {ok, saved:{platform, appKey}}：**只写不读**，响应体里搜不到 appSecret（§8.3：secret 永不回显，回显一次就等于把它写进了日志与网络抓包）',
        res.status === 200 &&
          v.ok === true &&
          v.saved.platform === 'youdao' &&
          v.saved.appKey === TEST_APP_KEY &&
          !('appSecret' in v.saved) &&
          !raw.includes(TEST_APP_SECRET),
        `${res.status} ${raw}`,
      );
    }

    // R7 错误信封
    {
      const res = await post(port, '/api/v1/translate/text', { text: '', from: 'ja', to: 'zh' });
      const v = jsonOf(res);
      check(
        'R7 错误信封：空 text → 400，形状为 {error:{code,message,details}}，code 是翻译域统一码 TRANSLATE_INVALID_INPUT（不是笼统的"翻译失败" —— 用户看不出该改什么）',
        res.status === 400 &&
          v?.error?.code === 'TRANSLATE_INVALID_INPUT' &&
          typeof v.error.message === 'string' &&
          v.error.details &&
          typeof v.error.details === 'object',
        `${res.status} ${JSON.stringify(v).slice(0, 160)}`,
      );
    }

    // R8 流式中途失败
    {
      const res = await post(port, '/api/v1/translate/stream', { text: trig('MBREAK'), from: 'ja', to: 'zh' });
      const evs = parseSse(res.body);
      const deltas = evs.filter((e) => e.event === 'translate.delta');
      const err = evs.find((e) => e.event === 'translate.error');
      check(
        'R8 流式中途失败：先 translate.delta 再 translate.error（**顺序不能反** —— 反了浏览器拿到的是"流干净结束"），error 带 afterChars 现场证据（已吐出 1 个增量，用户知道丢在哪）',
        res.status === 200 &&
          deltas.length === 1 &&
          !!err &&
          err.data.code === 'TRANSLATE_UPSTREAM_UNREACHABLE' &&
          err.data.afterChars === 1,
        `事件=${evs.map((e) => e.event).join(',')} ${JSON.stringify(err?.data)}`,
      );
    }
  } finally {
    killProc(st);
    await sleep(120);
  }
}

// ================================================================ P · 纯逻辑面 ⟷ 冻结 golden

/**
 * 纯逻辑面（统一码表 / 签名截断 / 语言码表 / 上游码映射 / 出网错误族 / 可重试）**不经过路由**：
 * 注册表是编译期常量、错误族由 reqwest 抛 ⇒ 只能靠 `--translate-selftest` 的确定性报告取证。
 * 金标是 Node 同源对齐时代冻结的最后一份正确输出（`golden/translate-selftest.json`）；
 * 未来 Rust 侧**有意**变更这些语义时，跑 `_gen-golden.mjs translate` 重冻并把 diff 写进提交说明。
 */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  }
  return v;
}
const sameJSON = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

async function groupP() {
  let golden = null;
  let live = null;
  try {
    golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    live = JSON.parse(await runRust(['--translate-selftest']));
  } catch (e) {
    check('SETUP 取 Rust 纯逻辑报告 / 读 golden', false, String(e.message || e));
    return;
  }

  // 统一码表：先与**硬编码契约**对（防"实现与 golden 一起错"），再与 golden 对（防漂移）
  {
    const got = Object.fromEntries((live.codes || []).map((c) => [c.code, c.status]));
    const drift = Object.keys(CODE_STATUS).filter((k) => got[k] !== CODE_STATUS[k]);
    const total = Object.keys(CODE_STATUS).length;
    check(
      `P1 统一码表：${total} 个码的 HTTP 状态与硬编码契约逐一相符（503/502/400/429/402/504…），且与 golden 一致；未登记码落 502`,
      drift.length === 0 &&
        Object.keys(got).length === total &&
        live.unknownCodeStatus === 502 &&
        sameJSON(live.codes, golden.codes),
      `不符=${drift.join(',') || '无'} 条目=${Object.keys(got).length}/${total} 未登记码状态=${live.unknownCodeStatus}`,
    );
  }

  check(
    'P2 签名 input 截断规则 ⟷ golden：`len<=20` 原样；否则「前10 + len + 后10」，len 按 **UTF-16 码元**（含 20/21 边界与代理对）',
    sameJSON(live.truncate, golden.truncate),
    (live.truncate || [])
      .map((x) => `${x.utf16}:${x.q}→${x.input}`)
      .join(' | ')
      .slice(0, 300),
  );

  check(
    'P3 语言码两张表（按接口分表：text 表更长，ko 只在 text 表里）⟷ golden：认不出返回 null，绝不猜',
    sameJSON(live.langCode, golden.langCode),
    JSON.stringify(live.langCode && live.langCode.llm),
  );

  check(
    'P4 上游业务码 → (统一码, 状态) 两接口各查自己那张表；未登记码落兜底 UPSTREAM_ERROR ⟷ golden',
    sameJSON(live.upstream, golden.upstream),
    `${(live.upstream || []).length} 行`,
  );

  check(
    'P5 出网错误族归因（顺序即优先级：超时 > 网络族 > 兜底）⟷ golden：四层 stage 原样透传、网络族归 UNREACHABLE、取消/兜底归 UPSTREAM_ERROR',
    sameJSON(live.faults, golden.faults),
    (live.faults || []).map((f) => `${f.name}→${f.code}/${f.stage}`).join(' | '),
  );

  check(
    'P6 可重试判定 ⟷ golden：链路与超时可重试；UPSTREAM_ERROR **仅限** 5xx 与上游 303；限流/鉴权/入参一律不重试',
    sameJSON(live.retryable, golden.retryable),
    (live.retryable || [])
      .filter((r) => r.retryable)
      .map((r) => r.name)
      .join(','),
  );
}

// ================================================================ 条数自检

/**
 * 每组条数与写死的分母比对。
 * 🔴 少写一条断言就静默少验一条，而"少验"在输出里完全看不出来 —— 所以分母必须写死并自检。
 */
function checkCounts() {
  const want = {
    S: EXPECTED_S,
    T: EXPECTED_T,
    L: EXPECTED_L,
    C: EXPECTED_C,
    K: EXPECTED_K,
    A: EXPECTED_A,
    R: EXPECTED_R,
    P: EXPECTED_P,
  };
  const got = {};
  for (const r of results) {
    const m = /^([A-Z])(\d+)\s/.exec(r.id);
    if (m) got[m[1]] = (got[m[1]] || 0) + 1;
  }
  const bad = Object.entries(want)
    .filter(([g, n]) => got[g] !== n)
    .map(([g, n]) => `${g} 组实际 ${got[g] || 0} 条 ≠ 分母 ${n}`);
  const total = Object.values(want).reduce((a, b) => a + b, 0);
  check(
    `COUNT 各组条数与写死的分母一致（${total} 条业务断言 + 本行 + RUN，共 ${total + 2} 条）`,
    bad.length === 0,
    bad.length
      ? `不符：${bad.join('；')}`
      : Object.entries(want)
          .map(([g, n]) => `${g}=${got[g]}`)
          .join(' '),
  );
}

// ================================================================ 一轮完整断言

/** 起假上游 → 布置接缝 env → 落密钥 → 依次跑八组 → 条数自检 → RUN 兜底 */
async function runOnePass() {
  await listen(fake.server, 0);
  fake.port = fake.server.address().port;

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const saved = await saveCredentials(
    { platform: 'youdao', appKey: TEST_APP_KEY, appSecret: TEST_APP_SECRET },
    envOf(),
  );
  if (saved.err) throw new Error(`夹具密钥没落下，后面全组都会莫名其妙地红：${errText(saved.err)}`);

  await groupP();
  await groupS();
  await groupT();
  await groupL();
  await groupC();
  await groupK();
  await groupA();
  await groupR();
  checkCounts();
  check(
    'RUN 脚本完整跑完（顶层未崩：崩了只会没有 [RESULT] 行，反证轮会把「断言炸了」误读成「破坏没生效」）',
    true,
    `假上游端口=${fake.port} 记账 ${fake.state.hits.length} 条 / 验签失败 ${fake.state.badSign} 次`,
  );
}

// ================================================================ 反证轮

/**
 * 八个开关，一个开关一个子进程（`refute.rs` 的 `OnceLock` ⇒ 进程内不可回滚）。
 *
 * `expectRed` 的取法：**先跑一次子进程看实际红集合，再连同锚点一起硬编码进来**。
 * 除了锚点本身，还包含**级联**（一个开关顺带打红的断言）—— 级联必须在注释里说清
 * 是哪一条传导链，否则"一条开关护一条机制"的归因就散了。
 */
const SWITCHES = [
  {
    name: 'MIAO_TRANSLATE_REFUTE_NO_TRUNCATE（签名不截断 input）',
    env: { MIAO_TRANSLATE_REFUTE_NO_TRUNCATE: '1' },
    expectRed: ['S1', 'P2'],
    why: '锚点 S1 + P2：>20 字符长文本不走「前10+长度+后10」⇒ 假上游同算法重算 sign 不一致 → 202 AUTH_FAILED；纯逻辑报告里的 `truncate` 段同时变样。不级联的两个保证：① 除 S1 外所有用例 text ≤20 字符（文件头纪律①），截断与否同值；② 验签结果逐 hit 记 signOk，S2/S3/S4 只认自己那条请求，不吃 S1 故意签错的全局污染。',
  },
  {
    name: 'MIAO_TRANSLATE_REFUTE_REUSE_SALT（重试复用旧 salt）',
    env: { MIAO_TRANSLATE_REFUTE_REUSE_SALT: '1' },
    expectRed: ['S4', 'T2', 'T3', 'T4', 'A6', 'A7'],
    why: '锚点 S4：重试复用 salt 必撞上游防重放 207。级联：凡"第一次失败→重试"的用例第二次都撞 207 变 AUTH_FAILED —— T2/T3/T4（超时属可重试，第二次请求发得出去，salt 已被假上游记账）、A6（500 可重试）、A7（303 可重试）。T1 不红：黑洞地址根本到不了假上游，salt 从未被记账，两次都是 connect 超时。',
  },
  {
    name: 'MIAO_TRANSLATE_REFUTE_IDLE_AS_TOTAL（idleMs 并进 totalMs）',
    env: { MIAO_TRANSLATE_REFUTE_IDLE_AS_TOTAL: '1' },
    expectRed: ['T3'],
    why: '锚点 T3：idle 档被并成 totalMs（5000）⇒ 与 total 定时器同时刻到期，而 total 计时轴起跑更早 ⇒ stage 从 idle 变 total。T2/T4 不红：T2 的 stage 由 ttfb 阶段归因（与 idleMs 无关），T4 预期就是 total。',
  },
  {
    name: 'MIAO_TRANSLATE_REFUTE_ECHO_SECRET（密钥视图回显 secret）',
    env: { MIAO_TRANSLATE_REFUTE_ECHO_SECRET: '1' },
    expectRed: ['K1'],
    why: '锚点 K1：credentials 视图多回一个 appSecret 键，"secret 永不回显"被破坏（连 JSON 串里都搜得到）。R4/R6 不红：服务子进程由 spawnProc 剥掉 REFUTE_*，量的是产品路径。',
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
    expectRed: [
      'S1',
      'S2',
      'S3',
      'S4',
      'S5',
      'S6',
      'S7',
      'S8',
      'S10',
      'S11',
      'S12',
      'S13',
      'L1',
      'L2',
      'C6',
      'K3',
      'A3',
      'A4',
      'A5',
      'A7',
      'A8',
    ],
    why: '锚点 S8/S9 一族：text 改用 llm 双判、llm 改用 text 单判 ⇒ 每一个"调用成功"类断言全红。级联说明：S1-S8/S10-S13 的取证都以"成功拿到译文/成功建流"为前提（S12/S13 是 llm 流式成功的两种协议形态）；L1/L2 的收尾断言要求 6/25 个请求成功；C6/K3 的收尾是一次成功翻译；A3/A4/A5/A7/A8 同属"翻译成功"类（A5 的三档档位也要流式真成功才判命中）。不红的都是与判成功无关的面：S9/S14（期望的正是 UPSTREAM_ERROR —— 判反了也红不到它）、T 组（超时路径不判成功）、C1-C5/K1/K2/K4（设置与密钥面）、A1-A2（注册/语言码，失败早于判成功）、A6（非 2xx 先判死，早于任何判成功）、P 组（纯逻辑表，不经路由）、R 组（服务子进程由 spawnProc 剥掉 REFUTE_*，量的是产品路径）。',
  },
  {
    name: 'MIAO_TRANSLATE_REFUTE_LEGACY_LINE_JSON（解析器只认裸 JSON 行、丢弃 SSE `data:` 帧）',
    env: { MIAO_TRANSLATE_REFUTE_LEGACY_LINE_JSON: '1' },
    expectRed: ['S6', 'S7', 'S10', 'S11', 'S12', 'A3', 'A5', 'A8'],
    why: '锚点 S12：真上游形态是**标准 SSE 帧**，退回"只认裸 JSON 行"后 `data:` 帧被整片丢弃 ⇒ 凡"llm 流式成功"类断言全红 —— **这正是 D-130 的线上症状**（译了一整遍、结果是空的）。级联：S6（llm 出网后要收到帧才算成功）、S7（首块锁定要求至少 1 个增量）、S10（llm 业务码行要按真码归一）、S11（半包/尾包增量）、A3（llm 裁剪要成功收尾）、A5（档位要成功才取到记账）、A8（流式累计）。两条仍绿恰好证明"两种形态都要吃得下"：S9（期望的正是 UPSTREAM_ERROR，零帧兜底替它报了错）、S13（本就走裸 JSON 行形态）；S14 也绿（零帧兜底与形态无关）。',
  },
  {
    name: 'MIAO_TRANSLATE_REFUTE_NO_FRAME_GUARD（流式不做"200 但零帧即报错"兜底）',
    env: { MIAO_TRANSLATE_REFUTE_NO_FRAME_GUARD: '1' },
    expectRed: ['S14'],
    why: '锚点 S14：摘掉零帧兜底 ⇒ 上游 200 但零帧时返回"成功 + 空译文"（用户看到的那句假话），S14 从"报 UPSTREAM_ERROR"退化成"竟然成功了（空译文）"。只红 S14：其余用例的 llm 回话都至少有一帧。',
  },
];
const EXPECTED_SWITCHES = 8; // 分母写死

async function runRefute() {
  console.log('ver2.2 在线翻译 · 反证轮');
  console.log(`逃生开关 → 指定断言必须变红（应执行 ${EXPECTED_SWITCHES} 条）\n`);
  let asExpected = 0;
  const problems = [];

  for (const sw of SWITCHES) {
    // 每个开关独立跑一次：refute.rs 的 OnceLock ⇒ 进程内无法回滚 ⇒ 另起子进程。
    // spawnProc 会先剥掉父进程里的 MIAO_TRANSLATE_REFUTE_*，再合并本开关的那一个。
    const st = spawnProc(SELF, sw.env, sw.name, ['--refute-child']);
    let out = '';
    st.child.stdout.on('data', (d) => {
      out += d.toString();
    });
    st.child.stderr.on('data', (d) => {
      out += d.toString();
    });
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
      console.log(
        `   ${red ? '✓' : '✗'} ${code} ${red ? '按预期变红' : `**没有变红**（${hit ? hit.detail : '缺该条'}）`}`,
      );
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
    const { fail } = printResults(
      'ver2.2 在线翻译 · 假上游正向断言' +
        '（S 签名与协议 / T 四层超时 / L 限流 / C 三层设置 / K 密钥隔离 / A 契约与适配器 / R 路由端到端 / P 纯逻辑⟷golden）',
    );
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
    await new Promise((resolve) => {
      fake.server.close(() => resolve());
    });
  }
  const anyRed = results.some((r) => !r.ok);
  if (IS_REFUTE_PARENT || !anyRed) {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  } else {
    console.log(`\n[临时目录保留] ${TMP}`);
  }
}
