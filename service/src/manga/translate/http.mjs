// 出网 HTTP 原语 —— 在线翻译模块**唯一真正触网**的件
// =============================================================================
// 依据：在线翻译服务设计方案 §7.1（五层超时）/ §5.1 注（form-urlencoded）。
// 本文件**不认识任何业务**：不知道有道、不解析 JSON、不解释字段、不判成功。
// 错误一律用 **node 原生 Error（带 code）**，归一成 `TRANSLATE_*` 是 `errors.mjs` 的事。
//
// 🔴 为什么「五个超时」而不是一个（§7.1）：
//    不可达要**快败**（connectMs）· 大模型首字慢与整段慢是两件事（ttfbMs）·
//    「卡住」与「慢慢吐」只有空闲超时能区分（idleMs）· 总体永不结束要兜底（totalMs）·
//    探测绝不能用业务超时（probeMs）。合成一个 30s，上述五种现场全部退化成"等 30s 后失败"。

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream';

/**
 * 五层超时默认值（方案 §7.1；调用方可按接口覆盖）。
 * `probeMs` 是给探测场景的快捷默认 —— 本文件不会自动用它，由调用方拼进 `timeouts`。
 */
export const DEFAULT_TIMEOUTS = Object.freeze({
  connectMs: 5000,
  ttfbMs: 15000,
  idleMs: 20000,
  totalMs: 30000,
  probeMs: 2000,
});

const STAGE_LABELS = { connect: '建连', ttfb: '首字节', idle: '空闲', total: '总时长' };

/** 超时错误：带 `code` 与 `details.stage`（哪一层），供 errors.mjs 归成 TRANSLATE_TIMEOUT */
function timeoutError(stage, ms) {
  const err = new Error(`出网请求超时：${STAGE_LABELS[stage]}层 ${ms}ms 内没有进展`);
  err.code = 'ETIMEDOUT';
  err.details = { stage, timeoutMs: ms };
  return err;
}

function abortError() {
  const err = new Error('出网请求被取消（signal 已触发）');
  err.code = 'ABORT_ERR';
  return err;
}

/** 上游把连接掐了（响应没走完）：与 ECONNRESET 同族但由 res 发出 */
function abortedError() {
  const err = new Error('上游中断了响应（连接被重置或关闭）');
  err.code = 'ECONNRESET';
  return err;
}

/**
 * 响应体解压：声明了 `content-encoding: gzip` 就过一遍 `createGunzip`。
 * 用 `pipeline` 而不是裸 `res.pipe(gunzip)`：pipeline 会把解压错误传播给消费端，
 * 裸 pipe 下 gzip 的 'error' 没人听就是一个 unhandled error。
 */
function maybeGunzip(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (!enc.includes('gzip')) return res;
  const gunzip = zlib.createGunzip();
  const out = pipeline(res, gunzip, (err) => {
    if (err && !out.destroyed) out.destroy(err);
  });
  return out;
}

/**
 * 出网请求内核。`postForm` / `postStream` 都走它。
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method='POST']
 * @param {object|null} [opts.fields]  form 字段（`application/x-www-form-urlencoded`）
 * @param {object} [opts.headers]      附加/覆盖请求头
 * @param {object} [opts.timeouts]     覆盖 `DEFAULT_TIMEOUTS` 的任意一层
 * @param {AbortSignal} [opts.signal]  外部取消：abort 即销毁 socket（按量计费，必须真断）
 * @param {boolean} [opts.wantStream]  true = 交回响应流（流式）；false = 收全体 Buffer
 * @returns {Promise<{status:number, headers:object, body?:Buffer, stream?:import('node:stream').Readable}>}
 */
function request(url, {
  method = 'POST', fields = null, headers = {}, timeouts = {}, signal = null, wantStream = false,
} = {}) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const t = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const body = fields === null || fields === undefined ? null : new URLSearchParams(fields).toString();

  const reqHeaders = { Accept: '*/*', 'Accept-Encoding': 'gzip', ...headers };
  if (body !== null) {
    reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    reqHeaders['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }

    let settled = false; // 本 Promise 是否已 resolve/reject
    let liveStream = null; // resolve 之后：后续超时/取消改为「毁掉已交出去的流」
    let connected = false;
    let responseSeen = false;
    let connectTimer = null;
    let totalTimer = null;
    let detachAbort = () => {};

    const clearTimers = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
      try { req.setTimeout(0); } catch { /* 请求可能已结束，ignore */ }
    };

    // 统一失败出口：resolve 之前 → reject；之后 → 毁流（消费端从 'error' 感知）
    const die = (err) => {
      if (settled) {
        detachAbort();
        if (liveStream && !liveStream.destroyed) liveStream.destroy(err);
        return;
      }
      settled = true;
      clearTimers();
      detachAbort();
      try { req.destroy(err); } catch { /* 已销毁，ignore */ }
      reject(err);
    };

    // socket 超时（ttfb/idle 两档共用；实测 Node v24：该超时**随 socket 活动自动重置**，
    // 即天然的「空闲」语义，且不受消费端 pause() 影响 —— 背压暂停读不会误触发）。
    const onSocketTimeout = () => {
      const stage = responseSeen ? 'idle' : (connected ? 'ttfb' : 'connect');
      const ms = stage === 'idle' ? t.idleMs : (stage === 'ttfb' ? t.ttfbMs : t.connectMs);
      die(timeoutError(stage, ms));
    };

    const onResponse = (res) => {
      responseSeen = true;
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      req.setTimeout(t.idleMs); // 响应头已到 → 切「空闲」档

      res.on('aborted', () => die(abortedError()));
      res.on('error', (err) => die(err));

      const out = maybeGunzip(res);

      if (!wantStream) {
        const chunks = [];
        out.on('data', (c) => chunks.push(c));
        out.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimers();
          detachAbort();
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
        out.on('error', (err) => die(err));
        return;
      }

      // 流式：ttfb 已达成，当场交出流；total/idle/取消此后都表现为「毁流」
      liveStream = out;
      // 防御性空监听：消费端从 resolve 到挂上自己的 'error' 之间有至少一个微任务间隙，
      // 这期间出错就是 unhandled 'error'（直接崩进程）。空监听不吞错误 ——
      // 消费端自己的监听仍会收到同一个 error（'error' 是多播的）。
      out.on('error', () => {});
      out.on('close', clearTimers);
      resolve({ status: res.statusCode, headers: res.headers, stream: out });
    };

    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: `${u.pathname}${u.search}`,
      method,
      headers: reqHeaders,
      // 不用连接池：每次全新连接。翻译是低频请求，复用收益小；
      // 而复用会把上一条连接的 socket 超时状态带过来，让「哪一层超时」归因变浑。
      agent: false,
    }, onResponse);

    req.on('error', (err) => die(err));
    req.on('timeout', onSocketTimeout);

    req.on('socket', (sock) => {
      const onConnect = () => {
        connected = true;
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        req.setTimeout(t.ttfbMs); // 建连完成 → 切「首字节」档
      };
      if (sock.connecting) sock.once('connect', onConnect);
      else onConnect();
    });

    if (signal) {
      const onAbort = () => die(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      detachAbort = () => signal.removeEventListener('abort', onAbort);
    }

    // connect 档必须用独立定时器：`req.setTimeout` 要等 socket **连上之后**才生效，
    // 对「根本连不上」（DNS 失败/对端关闭）不设防 —— 而那正是要快败的场景。
    connectTimer = setTimeout(() => {
      if (responseSeen) return;
      die(timeoutError('connect', t.connectMs));
    }, t.connectMs);
    totalTimer = setTimeout(() => die(timeoutError('total', t.totalMs)), t.totalMs);

    if (!req.destroyed) {
      if (body !== null) req.write(body);
      req.end();
    }
  });
}

/**
 * POST form，收**全体**响应。
 * 不跟随重定向（`http.request` 本来就不跟）：3xx 会作为普通 status 返回，由调用方决定 ——
 * 重定向可能换域名、换证书链，出网原语不替业务做这个决定。
 * @returns {Promise<{status:number, headers:object, body:Buffer}>}
 */
export function postForm(url, opts = {}) {
  return request(url, { ...opts, wantStream: false });
}

/**
 * POST form，收**响应流**（ttfb 即返回）。调用方负责读流；
 * 返回的 stream 可能 emit 'error'（超时/取消/上游中断），**必须**挂 error 监听。
 * @returns {Promise<{status:number, headers:object, stream:import('node:stream').Readable}>}
 */
export function postStream(url, opts = {}) {
  return request(url, { ...opts, wantStream: true });
}
