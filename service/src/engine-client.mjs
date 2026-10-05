// sidecar（翻译引擎）客户端 —— box-service 与翻译引擎之间的**内部 HTTP 边界**
//
// 契约依据（按证据强度排序，见 AGENTS.md §2-2「记忆不能当证据」）：
//   ① `runtimes/manga-translator/openapi.engine.json` —— 真实引擎 `GET /docs` 导出的快照（M1 产出）
//   ② `runtimes/manga-translator/src/server/{main,request_extraction,args}.py` —— 回读源码
//   ③ 《04》§4 —— 仅作方向性参考。⚠️ 实测与文档示意**不符**之处以 ①② 为准（见台账 D-62）
//
// 为什么单独成文件：本文件是 box-service 与引擎之间的**唯一耦合点**（《04》§3.3）——
// 换引擎版本**只允许改本文件 + `engine/VERSIONS.lock`**。越过它泄漏引擎细节 = 缺陷。
//
// ------------------------------------------------------------------ 两种协议
// 由 `config.engineProtocol` 选择（`MIAO_ENGINE_PROTOCOL`，默认 `real`）：
//
//   real —— 真实 manga-image-translator（`python main.py`，FastAPI）
//     🔴 启动形式是 **`python main.py` 且 cwd = `src/server`**，**不是** `python -m server.main`：
//        `main.py` 的 `__main__` 块是 `from args import parse_arguments`（平级相对导入），
//        `-m` 模式下 `sys.path[0]` 是 cwd（`src/`）⇒ `ModuleNotFoundError: No module named 'args'`
//        （实测，见台账 D-62；上游 README 写的也是 `$ python main.py --use-gpu`）。
//        ⚠️ 但执行器子进程**必须** cwd = `src/`（`main.py` 里 `Popen(..., cwd=src)` 写死，
//        因为 `python -m manga_translator` 要求包在 cwd）—— 两者不能想当然用同一个。
//
//     POST /translate/image/stream   Content-Type: application/json
//       Body: { image: "data:image/<png|jpeg|webp>;base64,…", config: <《04》§4.2 基线> }
//       200  → **自定义结果流**（不是 PNG！帧格式见 `parseResultStream`）：
//              1 字节 code + 4 字节大端长度 + 数据；code 0=结果(PNG字节) 1=进度 2=错误 3=位置 4=等实例
//              ⇒ **HTTP 状态码恒 200，错误在流里用 code 2 表达**（`server/main.py:98-100` → `while_streaming`）
//       非200 → FastAPI 错误信封 `{ detail: <string | object[]> }`（只发生在 handler 之前，如 422 校验）
//     🔴 **为什么用 stream 端点而不是 `/translate/image`**：后者在这版上游是**坏的**。
//        非流式链路 = `myqueue.py:125` → `ExecutorInstance.sent` → `sent_data_internal.fetch_data`
//        用 `json.loads(await response.text())` 解析，而执行器 `/simple_execute/{m}` 返回的是
//        **原始 pickle 字节**（`share.py:150` `Response(content=result_bytes, media_type="application/octet-stream")`）
//        ⇒ 必然 `'utf-8' codec can't decode byte 0x80 in position 0`（实测 500）。
//        流式链路两端是同版本的配套实现（`fetch_data_stream.process_stream` ↔ `share.py:100-106`），唯一能通的。
//     POST /queue-size           → 200 纯整数（**是 POST 不是 GET** —— 写成 GET 会得 405，
//       而 405 会长得像"引擎没就绪"，是最难查的一类错）。**唯一无副作用的存活探针**
//       （⚠️ 不能用 `GET /`：它读 index.html，**引擎刚起就 200**，与"能不能翻译"无关 → 假绿）
//     🔴 陷阱（`request_extraction.py:39-48`）：判断字符串用 `^data:image/.+;base64,`；
//        **不带该前缀的字符串会被当成 URL 去 `requests.get`** —— 静默走网络、然后报一个
//        看不出根因的错。⇒ image 字段必须是 data URI，且 mime 由**字节嗅探**得出（不信调用方自称）。
//     🔴 陷阱：**没有 `/health`、没有版本端点、没有 `--config-file`**（`server/args.py` 实测无此项）。
//        策略参数只能**按请求**注入（`TranslateRequest.config`），见 config.engineConfig。
//
//   mock —— 仓内模拟引擎（`engine/src/server.mjs`，ver1.0 起沿用的测试替身）
//     GET  /ready / POST /translate（自定义协议）。**仅供测试**：它提供可控耗时与失败注入，
//     这些是测试专用能力，不该进生产契约面。测试起的是它，就显式声明 `mock`。
import http from 'node:http';
import net from 'node:net';

import { config } from './config.mjs';
import { sniffImageType } from './image.mjs';

/** 引擎错误：带 code 便于上层区分「引擎不可用」与「单图翻译失败」 */
export class EngineError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.detail = detail;
  }
}

/** data URI 里的 mime：`jpg` 的规范写法是 `jpeg`（引擎侧正则只要求 `image/` 前缀，但按规范写） */
function mimeOfExt(ext) {
  return ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
}

/**
 * 单张翻译的入口校验：**real 协议下提前拦掉**，省一次网络往返（也把"图坏了"与"引擎坏了"分开）。
 * @returns {'png'|'jpg'|'webp'}
 */
function assertTranslatableImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new EngineError('BAD_INPUT', '原图字节为空，拒绝送翻译');
  }
  const ext = sniffImageType(bytes);
  if (!ext) {
    throw new EngineError('BAD_INPUT', '原图字节不是可识别图片（PNG/JPEG/WEBP）');
  }
  return ext;
}

/**
 * 单次 HTTP 往返。
 * `timeoutMs` 缺省取 `config.engineTimeoutMs`（单张翻译量级）；**探测必须显式传短超时**。
 */
function requestOnce(pathname, { method = 'POST', headers = {}, body = null, timeoutMs } = {}) {
  const { engineHost: host, enginePort: port } = config;
  const limit = timeoutMs ?? config.engineTimeoutMs;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path: pathname, method, headers, timeout: limit },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('timeout', () => {
      req.destroy(new EngineError('ENGINE_TIMEOUT', `引擎响应超时（${limit}ms）`, { timeoutMs: limit }));
    });
    req.on('error', (err) => {
      if (err instanceof EngineError) return reject(err);
      // ECONNREFUSED / ECONNRESET → sidecar 未就绪
      reject(new EngineError('ENGINE_UNAVAILABLE', `引擎不可达（${host}:${port}）：${err.code || err.message}`));
    });
    if (body) req.write(body);
    req.end();
  });
}

/** TCP 端口探测（就绪判定的第 ①/③ 层）。失败一律 `false`，不抛错。 */
function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** 从 FastAPI 错误信封取出人可读的 detail；解析不出来就回退原始文本 */
function readFastApiDetail(body) {
  const raw = body && body.length ? body.toString('utf8') : '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.detail !== undefined) {
      const { detail } = parsed;
      return typeof detail === 'string' ? detail : JSON.stringify(detail);
    }
  } catch { /* 非 JSON 错误体，回退原文 */ }
  return raw.slice(0, 300);
}

/** 归一化引擎 HTTP 错误 → `EngineError{code}`（`store.mjs` 据此生成 `engine_<code>` 失败原因） */
function normalizeHttpError(status, body) {
  const detail = readFastApiDetail(body);
  const code = status === 422 ? 'ENGINE_BAD_INPUT'
    : status === 404 ? 'ENGINE_NOT_FOUND'
      : 'ENGINE_ERROR';
  return new EngineError(code, `引擎返回 ${status}${detail ? `：${detail}` : ''}`, { status, detail });
}

/** 形状扩展里"位置占好、S1 还没值"的槽位（见 probeEngine 注释） */
function placeholderFields() {
  return { engineVersion: null, tier: null, accel: null, warmed: null, llm: null, model: null };
}

/**
 * 解析引擎的**结果流**。
 *
 * 帧格式（`server/streaming.py:11-18` + `manga_translator/mode/share.py:100-106` 两端一致）：
 *   `1 字节 code` + `4 字节大端长度` + `该长度的数据`；code 0=结果(PNG 字节) 1=进度文本
 *   2=错误文本 3=队列位次 4=等待翻译实例。流在 code 0 / 2 处结束（`streaming.py:8`）。
 *
 * 🔴 为什么必须走流式端点见文件头 —— 非流式的 `/translate/image` 在这版上游必然 500。
 * 注意**不要**把整包当成图片：结果帧前面可能有若干进度帧。
 */
function parseResultStream(body) {
  const frames = [];
  let result = null;
  let error = null;
  let off = 0;
  while (off + 5 <= body.length) {
    const code = body[off];
    const size = body.readUInt32BE(off + 1);
    if (off + 5 + size > body.length) { frames.push({ code, size, truncated: true }); break; }
    frames.push({ code, size });
    const data = body.subarray(off + 5, off + 5 + size);
    if (code === 0) result = data;
    else if (code === 2) error = data.toString('utf8');
    off += 5 + size;
  }
  return { result, error, frames };
}

// ================================================================ real 协议

async function realTranslateImage(bytes, opts) {
  const { seq } = opts || {};
  const ext = assertTranslatableImage(bytes);
  // 用**嗅探结果**构造 data URI —— 不信调用方给的 mime，也就绕开了「纯 base64 被当 URL」那个坑
  const payload = Buffer.from(JSON.stringify({
    image: `data:${mimeOfExt(ext)};base64,${bytes.toString('base64')}`,
    config: config.engineConfig,
  }), 'utf8');

  const res = await requestOnce('/translate/image/stream', {
    headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    body: payload,
  });

  // 流式端点的错误分两层：handler 之前的（422 等）走 HTTP 状态码；之后（推理失败）走流里的 code 2
  if (res.status !== 200) throw normalizeHttpError(res.status, res.body);

  const { result, error, frames } = parseResultStream(res.body);
  if (!result) {
    if (error) throw new EngineError('ENGINE_ERROR', `引擎报告：${error}`, { seq, frames });
    throw new EngineError('ENGINE_BAD_OUTPUT', '结果流里没有结果帧（code 0）', { seq, frames });
  }

  // 扩展名取**服务端对返回字节的嗅探结果**，不信任引擎自称的 Content-Type
  const outExt = sniffImageType(result);
  if (!outExt) {
    throw new EngineError('ENGINE_BAD_OUTPUT', '引擎返回的字节不是可识别的图片（PNG/JPEG/WEBP）',
      { seq, bytes: result.length, frames });
  }
  return { bytes: result, ext: outExt, mime: mimeOfExt(outExt) };
}

/**
 * 就绪**三重判定**（《04》§2.4 口径）：
 *   ① TCP 引擎端口在听            —— 否则 `stopped`（进程不在）
 *   ② HTTP `GET /queue-size` 200  —— 否则 `starting`（进程在、HTTP 层还没接客）
 *   ③ **执行器端口**（`port+1`）在听 —— 否则 `starting`（HTTP 在、翻译能力还没接客）
 *
 * 为什么必须有 ③：`server/main.py:288` spawn 执行器时用 `args.port + 1`，而 `:270`
 * **spawn 后立即注册实例、不等端口就绪** ⇒ 只看 ①② 会把"执行器还在起"（torch 加载中，
 * 真机可达数十秒）误判成 `running`，于是**第一张必挂**。
 */
async function realProbe() {
  const host = config.engineHost;
  const port = config.enginePort;
  const probeMs = config.engineProbeMs;
  const EMPTY = placeholderFields();

  if (!(await probeTcp(host, port, probeMs))) {
    return { state: 'stopped', port: null, engine: null, ...EMPTY };
  }

  let httpOk = false;
  try {
    // ⚠️ **POST**（`server/main.py:161` 是 `@app.post("/queue-size")`）。写成 GET 会 405。
    const res = await requestOnce('/queue-size', { method: 'POST', timeoutMs: probeMs });
    httpOk = res.status === 200;
  } catch { /* 端口在听但还不接客（uvicorn 启动中）→ starting */ }
  if (!httpOk) return { state: 'starting', port, engine: 'manga-image-translator', ...EMPTY };

  const executorUp = await probeTcp(host, port + 1, probeMs);
  return {
    state: executorUp ? 'running' : 'starting',
    port,
    engine: 'manga-image-translator',
    ...EMPTY,
  };
}

// ================================================================ mock 协议

async function mockTranslateImage(bytes, opts) {
  const { seq, from = 'ja', to = 'zh', mime = 'application/octet-stream' } = opts || {};
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new EngineError('BAD_INPUT', '原图字节为空，拒绝送翻译');
  }

  const res = await requestOnce('/translate', {
    headers: {
      'Content-Type': mime,
      'Content-Length': bytes.length,
      'X-Miao-Seq': String(seq),
      'X-Miao-From': from,
      'X-Miao-To': to,
    },
    body: bytes,
  });

  if (res.status !== 200) {
    let message = `引擎返回 ${res.status}`;
    let code = 'ENGINE_ERROR';
    try {
      const parsed = JSON.parse(res.body.toString('utf8'));
      if (parsed && parsed.error) {
        code = parsed.error.code || code;
        message = parsed.error.message || message;
      }
    } catch { /* 非 JSON 错误体，保留默认文案 */ }
    throw new EngineError(code, message, { status: res.status });
  }

  const ext = sniffImageType(res.body);
  if (!ext) {
    throw new EngineError('ENGINE_BAD_OUTPUT', '引擎返回的字节不是可识别的图片（PNG/JPEG/WEBP）');
  }
  return { bytes: res.body, ext, mime: mimeOfExt(ext) };
}

async function mockProbe() {
  const EMPTY = placeholderFields();
  try {
    const res = await requestOnce('/ready', { method: 'GET', timeoutMs: config.engineProbeMs });
    if (res.status !== 200) return { state: 'starting', port: config.enginePort, engine: null, ...EMPTY };
    const parsed = JSON.parse(res.body.toString('utf8'));
    return { state: 'running', port: config.enginePort, engine: parsed.engine || null, ...EMPTY };
  } catch {
    return { state: 'stopped', port: null, engine: null, ...EMPTY };
  }
}

// ================================================================ 对外接口

/**
 * 单张翻译。**签名与 ver1.0 保持一致**（《04》§4.5）——`store.mjs` 不应感知引擎换代：
 * ver1.0 怎么调 mock 引擎，ver2.0 就以同样方式调真实引擎。
 * @param {Buffer} bytes 原图字节
 * @param {{seq:number, from?:string, to?:string, mime?:string}} opts
 * @returns {Promise<{bytes:Buffer, ext:string, mime:string}>}
 */
export async function translateImage(bytes, opts) {
  return config.engineProtocol === 'mock'
    ? mockTranslateImage(bytes, opts)
    : realTranslateImage(bytes, opts);
}

/**
 * sidecar 就绪探测（契约 §5.1 的 `sidecar.state`）：**不抛错**，只回答状态。
 *
 * 返回**形状扩展**（《04》§4.5）：`state/port/engine` 是 ver1.0 就有的（`/health` 的契约面
 * 到 S5 才扩字段，故 `server.mjs` 仍只挑这三个对外）；其余 6 个是**为 S2–S4 预留的槽位**：
 *   `engineVersion` ← S0 锁定的 commit（S2 从 `engine/VERSIONS.lock` 注入）
 *   `tier` / `accel` ← S4 硬件探测与加速后端
 *   `warmed` ← S2 预热状态   `llm` ← S2 llama-server 进程   `model` ← S3 模型就绪
 * **S1 阶段这 6 个一律为 `null`** —— 不是"已实现"，是"位置占好了"。
 */
export async function probeEngine() {
  if (config.sidecarDown) {
    return { state: 'stopped', port: null, engine: null, ...placeholderFields() };
  }
  return config.engineProtocol === 'mock' ? mockProbe() : realProbe();
}

/**
 * 拼装引擎启动命令行（纯函数，便于断言与反证）。
 *
 * ⚠️ 两条都与**直觉相反**，都是实测出来的（台账 D-62）：
 *   ① 命令是 `python main.py`、cwd = `src/server` —— **不是** `python -m server.main`
 *      （`main.py` 的 `from args import` 是平级相对导入，`-m` 必 `ModuleNotFoundError`）。
 *   ② 参数表按 **`server/args.py` 实测**，**不是**《04》§4.3 的示意列表 ——
 *      服务端**没有** `--config-file` / `--model-dir`（策略改为按请求注入，见 config.engineConfig）。
 *
 * 消费方是 S2 的 `ServiceManager`；S1 只交付这个纯函数 + 断言。
 * @returns {{cmd:string[], cwd:string, env:object, executorPort:number}}
 */
export function resolveEngineLaunch(overrides = {}) {
  const {
    pythonBin = config.enginePython,
    host = config.engineHost,
    port = config.enginePort,
    useGpu = config.engineUseGpu,
    modelsTtl = config.engineModelsTtl,
    nonce = config.engineNonce,
    sakuraBase = config.engineSakuraBase,
  } = overrides || {};

  const cmd = [pythonBin, 'main.py', '--host', host, '--port', String(port)];
  if (useGpu) cmd.push('--use-gpu');
  if (modelsTtl > 0) cmd.push('--models-ttl', String(modelsTtl));
  if (nonce) cmd.push('--nonce', nonce);

  return {
    cmd,
    cwd: config.engineServerDir,
    env: {
      ...process.env,
      // 引擎③（Sakura LLM）地址：`translators/keys.py` 读 SAKURA_API_BASE
      SAKURA_API_BASE: sakuraBase,
      // nonce 走 env 亦可（`args.py --nonce` 的默认值就是 MT_WEB_NONCE）
      ...(nonce ? { MT_WEB_NONCE: nonce } : {}),
    },
    executorPort: port + 1,
  };
}
