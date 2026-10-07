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
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

import { config } from './config.mjs';
import { sniffImageType } from './image.mjs';

/**
 * 仓库根 —— `engine/` 与 `service/` 都在它下面。
 * 放在文件顶部（而不是原先"启动配方"那一节里）是因为 `ENGINE_VERSION` 在模块初始化时
 * 就要用它去读清单：const 有 TDZ，靠"反正调用得晚"是**时序巧合**，不是结构保证。
 */
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

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
    // `chunks` / `received` 提到响应回调**之外**：超时那一刻也要能把已收到的字节交出去。
    const chunks = [];
    let received = 0;
    const req = http.request(
      { host, port, path: pathname, method, headers, timeout: limit },
      (res) => {
        res.on('data', (c) => { chunks.push(c); received += c.length; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('timeout', () => {
      // 🔴 **超时必须带走"已经收到了什么"**。
      // 只报一句"超时了"回答不了真正要问的问题：引擎是**在推理**（有进度帧）、
      // 是**排不上队**（只有队列位次帧）、还是**完全没动静**（一个字节都没有）？
      // U10② 的现场就死在"不可归因"上 —— 事后只剩"静默 17 分钟"，
      // 谁也说不清卡在哪一层，于是只能登记成"偶发、成因待抓"。
      // 把已收到的**部分字节**附上，上层就能解析出它最后在做什么（见 realTranslateImage）。
      const err = new EngineError(
        'ENGINE_TIMEOUT',
        `引擎响应超时（${limit}ms 内没等到结帧；期间收到 ${received} 字节）`,
        { timeoutMs: limit, receivedBytes: received },
      );
      err.partialBody = received > 0 ? Buffer.concat(chunks) : null;
      req.destroy(err);
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

/**
 * 所有返回 `sidecar` 形状的地方都必须带上 `engineVersion`。
 *
 * 它有别于 `engine`：`engineVersion` 是**安装事实**（我们接的是哪一版引擎，来自入库的
 * version lock），`engine` 是**进程事实**（`stopped` 时它是 `null` —— 那时并没有哪台引擎在跑）。
 * 两者口径不同是故意的：版本号在引擎没起来时也答得出来，而且**答得出来才有用**
 * （诊断视图正是要在"起不来"的时候告诉你它本该是哪一版）。
 */
function placeholderFields() {
  return { tier: null, accel: null, warmed: null, llm: null, model: null };
}

// ================================================================ 引擎身份 / 参数快照
//
// 这两块都喂 `/health` 的 `sidecar`（§5.1）与 `/engine/status`（§5.2）。

/** 清单路径（`engine/models.manifest.json`，入库、可版本控制） */
const MANIFEST_PATH = path.join(REPO_ROOT, 'engine', 'models.manifest.json');

/**
 * 引擎② 的版本标识（`sidecar.engineVersion` / `/engine/status` 的 `engine.version`）。
 *
 * 真档 = `models.manifest.json:engineCommit` 的**短 sha**。
 *   🔴 上游**没有可用的版本号**：`pyproject.toml` 是 `0.1.0`（占位值，不是发布号）、
 *      `CHANGELOG.md` 停在 2022 年的 beta-0.3，而 `VERSIONS.lock §1` 明确"锁 commit、不锁 tag"。
 *      ⇒ 唯一对得上的东西就是那个 commit。报 `0.1.0` 才是失真（它既不是发布号，
 *      也不随代码变），而 commit 短 sha 能真回答"我跑的是哪一版源码"。
 *   ⚠️ 读的是**版本控制内的清单**（不是运行期问引擎）—— 真实引擎**没有版本端点**（见文件头）。
 *  mock 档 = `'mock'`（起的是替身就老实说；与 `probeEngine` 里 `engine` 字段同一姿态）。
 *  读不到清单 → `null`（=未知，**不编一个假版本号**）。
 */
function readEngineCommit() {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const c = String(m.engineCommit || '').trim();
    return /^[0-9a-f]{7,40}$/i.test(c) ? c.slice(0, 7) : null;
  } catch {
    return null;
  }
}

export const ENGINE_VERSION = config.engineProtocol === 'mock' ? 'mock' : readEngineCommit();

/**
 * 引擎侧对 `detection_size` 的默认值（我们**不指定**它，所以它生效）。
 * 出处：`runtimes/manga-translator/src/manga_translator/config.py:276`
 *   `class DetectorConfig: detection_size: int = 2048`
 * 我们只按请求注入 `detector.detector`，其余字段留空 ⇒ pydantic 用默认值补齐。
 * 若将来开始显式下发（`MIAO_ENGINE_DETECTION_SIZE`），`engineConfigSnapshot()` 会自动跟着变，
 * 不再是"引擎默认值"——所以这里不需要第二个开关去记得改文案。
 */
export const ENGINE_DEFAULT_DETECTION_SIZE = 2048;

/**
 * **生效参数快照**（《03》§5.2 的 `config` 块）—— 供 Box 做「界面与文档对账」。
 *
 * 🔴 跨层字段名漂移陷阱，这份映射就是它的挡板：
 *      **发给引擎的是 snake_case**（`config.engineConfig`，引擎 pydantic 认得）
 *      **报给 Box 的是 camelCase**（§5.2 的 JSON 逐字如此：`targetLang` / `detectionSize`）
 *    两边必须从**同一处**派生。若这里重抄一遍字面量，将来改参数只改了发给引擎的那边，
 *    诊断视图就会继续展示旧值 —— 一个"界面与事实不一致、且谁也不报错"的偏差。
 */
export function engineConfigSnapshot() {
  const c = config.engineConfig || {};
  return {
    translator: c.translator?.translator ?? null,
    targetLang: c.translator?.target_lang ?? null,
    detector: c.detector?.detector ?? null,
    detectionSize: c.detector?.detection_size ?? ENGINE_DEFAULT_DETECTION_SIZE,
    ocr: c.ocr?.ocr ?? null,
    inpainter: c.inpainter?.inpainter ?? null,
  };
}

// ================================================================ 阶段日志（§5.2 recentStageLog）
//
// 来源是**引擎自己**：`manga_translator.py` 的 `_report_progress(state, ...)` 把阶段名
// （`detection` / `ocr` / `textline_merge` / `translating` / `inpainting` / `rendering` …）
// 经 progress hook → 执行器 → 结果流 **code 1 帧**送出来（`mode/share.py:64-70`）。
// 所以这里存的是**引擎的原话**，不做改名、不做翻译 —— 一旦我们自作主张映射成
// `detect/ocr/inpaint`，将来引擎改阶段名时日志会继续显示旧名，而且看不出哪里不对。
//
// ⚠️ mock 档没有阶段帧（ver1.0 的自定义协议是单包响应）⇒ 该档下 `recentStageLog` 恒空。
//    这是**如实的空**，不是"没实现"：诊断视图会显示"(本次运行尚无阶段日志)"。

/** 环形缓冲上限。50 条 ≈ 4–5 张图的量，够看清"卡在哪一阶段" */
const STAGE_LOG_MAX = 50;
const STAGE_LOG = [];

/** 记一条阶段（`seq` 是**服务端**的图片序号，不是引擎的） */
export function pushStage(seq, text) {
  const line = String(text ?? '').trim();
  if (!line) return;
  STAGE_LOG.push(`seq ${seq}: ${line.slice(0, 120)}`);
  if (STAGE_LOG.length > STAGE_LOG_MAX) STAGE_LOG.splice(0, STAGE_LOG.length - STAGE_LOG_MAX);
}

/** 取尾部 `n` 条（新的在后）；`n <= 0` 取全部。给 `/engine/status` 用 */
export function recentStageLog(n = 20) {
  return n > 0 ? STAGE_LOG.slice(-n) : [...STAGE_LOG];
}

/** 清空。**只给验收夹具用**：让"这段日志确实来自本次请求"可被取证，而不是撞上上一轮的残留 */
export function clearStageLog() {
  STAGE_LOG.length = 0;
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
    // 帧对象带 `text`：code 1/2 的载荷就是文本（阶段名 / 错误说明）。
    // 只留 `{code,size}` 会让"进度帧"变成不可解释的计数 —— 而它是诊断视图里
    // 「卡在哪一阶段」的唯一来源（§5.2 的 `recentStageLog`）。
    // ⚠️ 截断到 200 字符：这些帧会随错误详情（`details.frames`）一起进响应体，
    //    不设上限时一个话多的引擎能把错误回包撑到几百 KB。
    const frame = { code, size };
    const data = body.subarray(off + 5, off + 5 + size);
    if (code === 0) result = data;
    // code 3 的载荷是**队列位次**（`myqueue.py:99` 把 `str(queue_pos)` 编成 utf-8 发出来）。
    // 🔴 它过去**不给 `text`**（只有 1/2 给）⇒ 位次在解析这一步就被丢掉了，
    //    上层根本无从判断"引擎在排队"还是"引擎在推理"。见 `recordFrame`。
    // code 4（等待翻译实例）的载荷为空，`text` 自然为 `''`。
    else if (code === 1 || code === 2 || code === 3) {
      frame.text = data.toString('utf8').slice(0, 200);
      if (code === 2) error = frame.text;
    }
    frames.push(frame);
    off += 5 + size;
  }
  return { result, error, frames };
}

/**
 * 把一帧记进阶段日志。
 *
 * 🔴 code 3/4（**队列位次** / **等待翻译实例**）过去是**被丢掉的** —— 只有 code 1 进日志。
 * 而这两种帧恰恰是「引擎活着、但拿不到执行器」的**唯一直接证据**：
 * 上游 `server/myqueue.py:100` 的判据是 `queue_pos < free_executors()`，而上游
 * `instance.py:43` 的 `free_executors()` 数的是 `busy == False` 的实例 —— 一旦某次
 * `sent_stream` 卡住不返回，那个实例**永远不会被释放**（`free_executor` 只在成功路径与
 * `except` 路径上调用），此后所有请求都只会反复报 `排队位次 0` 然后静默。
 * 没有这一条，诊断视图里就只剩"卡在某个阶段"，指不到"排队"这一层。
 */
function recordFrame(seq, frame) {
  if (frame.code === 4) { pushStage(seq, '等待翻译实例'); return; }  // 载荷为空，先于 text 判断
  if (!frame.text) return;
  if (frame.code === 1) pushStage(seq, frame.text);
  else if (frame.code === 3) pushStage(seq, `排队位次 ${frame.text}`);
  else if (frame.code === 2) pushStage(seq, `引擎报错：${frame.text}`);
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
    // 由 store 的**单项总预算**下发（`store._processItem`）：重试只能吃剩下的时间。
    timeoutMs: opts && opts.timeoutMs,
  }).catch((err) => {
    // 超时也要留下"它最后在做什么"：把已收到的部分字节解析成阶段，附进错误详情。
    // 这是区分「引擎在推理」/「引擎排不上队」/「引擎完全没动静」的**唯一**证据，
    // 也正是 U10② 那次"静默 17 分钟"事后无法归因的原因。
    if (err instanceof EngineError && err.code === 'ENGINE_TIMEOUT' && err.partialBody) {
      const { frames } = parseResultStream(err.partialBody);
      for (const f of frames) recordFrame(seq, f);
      err.detail = { ...(err.detail || {}), frames };
      delete err.partialBody;
    }
    throw err;
  });

  // 流式端点的错误分两层：handler 之前的（422 等）走 HTTP 状态码；之后（推理失败）走流里的 code 2
  if (res.status !== 200) throw normalizeHttpError(res.status, res.body);

  const { result, error, frames } = parseResultStream(res.body);
  // 先记阶段、再判成败 —— 失败路径恰恰**最需要**知道"卡在哪个阶段"。
  // 反过来写（成功才记）会让诊断视图在真正出问题的那张图上恰好是空的。
  for (const f of frames) recordFrame(seq, f);
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
 *   ② HTTP `POST /queue-size` 200 —— 否则 `starting`（进程在、HTTP 层还没接客）
 *   ③ **执行器端口**（`port+1`）在听 —— 否则 `prewarming`（HTTP 在、翻译能力还没接客 = L3 预热）
 *
 * 为什么必须有 ③：`server/main.py:288` spawn 执行器时用 `args.port + 1`，而 `:270`
 * **spawn 后立即注册实例、不等端口就绪** ⇒ 只看 ①② 会把"执行器还在起"（torch 加载中，
 * 真机可达数十秒）误判成 `running`，于是**第一张必挂**。
 *
 * ③ 落在 §5.1 `sidecar.state` 的哪个枚举值上：`prewarming`（而非 `starting`）。
 * 依据是《04》§10.2 映射表把"引擎启动中 / 加载模型"并列写成 `starting/prewarming`，
 * 而这两件事在本探测里**分得开**，就没有理由合报成一个词。
 */
async function realProbe() {
  const host = config.engineHost;
  const port = config.enginePort;
  const probeMs = config.engineProbeMs;
  const EMPTY = placeholderFields();

  if (!(await probeTcp(host, port, probeMs))) {
    return { state: 'stopped', port: null, engine: null, engineVersion: ENGINE_VERSION, ...EMPTY };
  }

  let httpOk = false;
  try {
    // ⚠️ **POST**（`server/main.py:161` 是 `@app.post("/queue-size")`）。写成 GET 会 405。
    const res = await requestOnce('/queue-size', { method: 'POST', timeoutMs: probeMs });
    httpOk = res.status === 200;
  } catch { /* 端口在听但还不接客（uvicorn 启动中）→ starting */ }
  if (!httpOk) {
    // 进程在、HTTP 层还没接客 = uvicorn 启动中（§6.1 的 L1 之后、接客之前）
    return { state: 'starting', port, engine: 'manga-image-translator', engineVersion: ENGINE_VERSION, ...EMPTY };
  }

  // ③ 未就绪**不等于**引擎未就绪（§10.2 把两者分别映射到「面板准备中，不报错」与「可翻译」）。
  // 这里把"HTTP 已接客、执行器端口还没起"单列成 `prewarming`（§5.1 的枚举值）：
  // 它对应的正是 §6.1 的 **L3 预热**——执行器在加载 torch/模型，真机可达数十秒。
  // ⚠️ 报 `starting` 也不算谎，但会把"整个引擎还没起"和"就差最后一哆嗦"显示成同一句话；
  //    而这两者对用户的意义不同（前者要等更久）。能分开就分开。
  const executorUp = await probeTcp(host, port + 1, probeMs);
  return {
    state: executorUp ? 'running' : 'prewarming',
    port,
    engine: 'manga-image-translator',
    engineVersion: ENGINE_VERSION,
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
    timeoutMs: opts && opts.timeoutMs,
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
  const id = { engineVersion: ENGINE_VERSION };
  try {
    const res = await requestOnce('/ready', { method: 'GET', timeoutMs: config.engineProbeMs });
    if (res.status !== 200) return { state: 'starting', port: config.enginePort, engine: null, ...id, ...EMPTY };
    const parsed = JSON.parse(res.body.toString('utf8'));
    return { state: 'running', port: config.enginePort, engine: parsed.engine || null, ...id, ...EMPTY };
  } catch {
    return { state: 'stopped', port: null, engine: null, ...id, ...EMPTY };
  }
}

// ================================================================ 对外接口

/**
 * 单张翻译。**签名与 ver1.0 保持一致**（《04》§4.5）——`store.mjs` 不应感知引擎换代：
 * ver1.0 怎么调 mock 引擎，ver2.0 就以同样方式调真实引擎。
 * @param {Buffer} bytes 原图字节
 * @param {{seq:number, from?:string, to?:string, mime?:string, timeoutMs?:number}} opts
 *   `timeoutMs` 缺省 `config.engineTimeoutMs`。由 `store` 下发
 *   **`min(单项剩余预算, engineTimeoutMs)`** —— 前者管"整项还有多久"，后者管
 *   "一次请求多久算没响应"，两者都要满足才不会出现「一次挂住吃掉整个预算」。
 *   见 `store._processItem` 的 `deadline` / `attemptTimeoutMs`。
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
 * 返回 **9 字段**（《03》§5.1 / §5.2 的 `sidecar` 契约面），其中：
 *   · `state` / `port` / `engine` —— 进程事实（ver1.0 就有）
 *   · `engineVersion`              —— **安装事实**（S5 起有值；S1 时是占位 null）
 *   · `tier` / `accel` / `warmed` / `llm` / `model` —— **仍然恒为 null**
 *     🔴 这 5 个是**服务级**事实（档位控制器 / 硬件探测 / ③ 的进程），只存在于 `server.mjs`。
 *        它们**不在本文件里凑齐**，而是在 `server.mjs` 的 `composeSidecar()` 里合成 ——
 *        本文件是「box-service ↔ 引擎」的耦合点，不该反过来持有 llama-server 的进程句柄。
 *        把 5 个 null 从这里"顺手填上"会让两台机器（服务与引擎）的状态互相污染。
 *
 * ⚠️ 因此本函数**只回答引擎侧**的问题。要完整的 9 字段请走 `server.mjs` 的 `sidecarState()`。
 */
export async function probeEngine() {
  if (config.sidecarDown) {
    return { state: 'stopped', port: null, engine: null, engineVersion: ENGINE_VERSION, ...placeholderFields() };
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
/** `runtimes/manga-translator/`（`engineDir` 是它下面的 `src/`） */
const ENGINE_RT = path.resolve(config.engineDir, '..');

/**
 * llama.cpp 解包后的**版本目录名**。
 * 🔴 它与 `engine/scripts/fetch-models.mjs --extract` 的落点、以及 `models.manifest.json`
 *    里 runtime 条目的版本号**必须一致** —— 三处任一对不上，`resolveLlmLaunch` 给出的就是
 *    一条指向不存在文件的命令（症状："llama-server 起不来"，而根因在一个目录名上）。
 */
export const LLAMA_VERSION_DIR = 'llama-b11417';

/**
 * `llama-server` 可执行文件的默认路径。**按平台分叉文件名后缀**：
 * POSIX 是 `llama-server`，Windows 是 `llama-server.exe`。写死无后缀会在 Windows 上
 * 拼出一条指向不存在文件的命令。`MIAO_LLM_BIN` 可覆盖。
 */
function defaultLlmServerBin() {
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  return path.resolve(ENGINE_RT, 'bin', 'llama', LLAMA_VERSION_DIR, name);
}

/**
 * 引擎③（LLM）的**归属方** —— 《04》§9.1 规定 Tier1 空闲卸载「实现方 = box-service
 * （③ 不在引擎 TTL 范围内）」，故 ③ 必须由 box-service 持有，Rust 侧只负责**打印配方**不负责拉起。
 *
 * 为什么把它写成常量并对外导出：这是一个**跨进程归属约定**，Rust（`LaunchSpec.owner`）、
 * `print-launch-plan.mjs`、`llm-supervisor.mjs` 三处都要认同一个值。散着写三个字面量，
 * 将来改归属就会漏掉一处 —— 而漏掉的表现是**两个 llama-server 抢 8080**，报错离根因极远。
 */
export const LLM_OWNER = 'service';

/**
 * 档位 → Sakura 权重文件名（《04》§6.3 量化档 / §7.2 档位映射）。
 *
 * 🔴 **只有 Tiny 的权重被固化进了 `engine/models.manifest.json`**（S3 的固化范围就是它 +
 *    llama-server 二进制）。Small(7B) / Medium(13~14B) 的**文件名与校验值都还没有来源**
 *    ⇒ 这里显式写 `null`，调用方必须**报错**，绝不允许"回落成 tiny 的文件"：
 *    回落会让用户以为自己在跑 7B，实际跑的是 1.5B —— 质量差异被静默吞掉，
 *    而"翻译变差了"这种反馈**根本追溯不到根因**。
 *
 * 补齐方式：先按 §6.3 选定量化档、把权重纳入 manifest 的 `llm` set（拿到真实文件名 + sha256），
 * 再回来把这里的 `null` 换成文件名。见 `engine/VERSIONS.lock` §4。
 */
export const TIER_LLM_MODELS = {
  tiny: 'sakura-1.5b-qwen2.5-v1.0-fp16.gguf',
  small: null,
  medium: null,
};

/** 档位对应的权重绝对路径；该档未声明权重时返回 `null`（**不是**回落成 tiny） */
export function tierModelPath(tier) {
  const name = TIER_LLM_MODELS[tier];
  return name ? path.resolve(ENGINE_RT, 'models', 'sakura', name) : null;
}

/**
 * **本进程能真跑的档位**（低 → 高）—— 供需"把期望档位夹到实际可用档位"时用。
 *
 * ⚠️ 两个协议下含义不同，这不是含糊，而是**两种模式的能力本来就不同**：
 *   · `real`：可用性由「权重在不在」决定（`TIER_LLM_MODELS` 目前的固化范围只有 Tiny）。
 *   · `mock`：替身只认 `--model <tier>` 这个**名字**，没有权重可读 ⇒ 三档都能"模拟"。
 *     若这里也照 `TIER_LLM_MODELS` 夹回 Tiny，S4 的两条关键回路（§8 降档 / §9 卸载后换档重启）
 *     **在 mock 档将永远无法触发** —— 只能靠分钟级、几 GB 权重的真档去验，
 *     等于"平时不验、换版本才验"。这与 `mock-llm.mjs` 文件头写下的理由是同一条。
 */
export function availableTiers() {
  if (config.engineProtocol === 'mock') return ['tiny', 'small', 'medium'];
  return Object.keys(TIER_LLM_MODELS).filter((t) => TIER_LLM_MODELS[t]);
}

/**
 * 引擎③（LLM / llama-server）的启动配方 —— 按协议分两支。
 *
 * 为什么放在本文件：本文件是「box-service ↔ 引擎」的**唯一耦合点**（见文件头）。
 * llama.cpp 的版本目录名、权重文件名、上下文长度、卸载层数**全是引擎侧细节**；
 * 一旦在别处再写一份，换版本时就必然漏改一处（两个地方谁说了算？）。
 * ⇒ 调用方（Rust 的 ServiceManager 只拿到配方文本用于打印；box-service 的 LlmSupervisor
 *   真正按它拉起）**都不自己拼命令**。
 *
 * ⚠️ 路径默认值对应 `engine/VERSIONS.lock` §3 锁定的 llama.cpp 构建与 §4 的 Sakura 权重。
 *    换版本 = 改 VERSIONS.lock + 改这里（同一处评审），不允许"顺手升级"。
 */
export function resolveLlmLaunch(overrides = {}) {
  return config.engineProtocol === 'mock'
    ? resolveMockLlmLaunch(overrides)
    : resolveRealLlmLaunch(overrides);
}

/** 真档：`llama-server`（外部二进制） */
function resolveRealLlmLaunch(overrides = {}) {
  const {
    tier = 'tiny',
    bin = process.env.MIAO_LLM_BIN || defaultLlmServerBin(),
    port = envIntLocal('MIAO_LLM_PORT', 8080),
    ctx = envIntLocal('MIAO_LLM_CTX', 4096),
    ngl = envIntLocal('MIAO_LLM_NGL', 99),
  } = overrides || {};

  // 档位决定权重。**未声明权重的档位直接抛错**，不静默沿用 tiny 的文件（理由见 TIER_LLM_MODELS）。
  const model = overrides.model || process.env.MIAO_LLM_MODEL || tierModelPath(tier);
  if (!model) {
    throw new EngineError(
      'TIER_MODEL_UNDECLARED',
      `档位 ${tier} 的权重尚未纳入 models.manifest.json（当前仅 ${availableTiers().join('/')} 可用）`,
      { tier, available: availableTiers() },
    );
  }

  return {
    label: 'llm',
    tier,
    model,
    cmd: [bin, '-m', model, '--port', String(port), '-c', String(ctx), '-ngl', String(ngl)],
    cwd: null,
    env: {},
    // 就绪探针：`llama-server` 的 HTTP 面就是 OpenAI 兼容的 `/v1/models`（M1/S1 实测用它判就绪）
    probes: [
      { kind: 'tcp', port },
      { kind: 'http', port, method: 'GET', path: '/v1/models', expect: 200 },
    ],
  };
}

/**
 * mock 档：仓内替身 `engine/src/mock-llm.mjs`。
 *
 * 为什么 mock 也要有 ③：三进程的**结构性**东西（可拉起 / 可回收 / 崩溃分级 / 空闲卸载 /
 * 降档重启）若只在真档才存在，就只能靠分钟级、几 GB 权重的回路去验 —— 那等于
 * "平时不验、换版本才验"。（这也是 `mock-llm.mjs` 文件头写下的话。）
 *
 * ⚠️ 与真档不同：这里**不标** `watch`。替身是我们自己的 Node 进程，内部已装父死看管
 *    （`engine/src/parent-watch.mjs`），再包一层 child-watch 只是多一层进程。
 * ⚠️ 档位以 `--model <tier>` 透传给替身 —— 降档断言需要用**真进程的启动参数**取证
 *    "它换的是另一档"，而不是读一句自报的日志。
 */
function resolveMockLlmLaunch(overrides = {}) {
  const { port = envIntLocal('MIAO_LLM_PORT', 8080), tier = 'tiny' } = overrides || {};
  return {
    label: 'llm',
    tier,
    model: `sakura-mock:${tier}`,
    cmd: [process.execPath, path.join(REPO_ROOT, 'engine', 'src', 'mock-llm.mjs'),
      '--port', String(port), '--model', tier],
    cwd: null,
    env: {},
    probes: [
      { kind: 'tcp', port },
      { kind: 'http', port, method: 'GET', path: '/v1/models', expect: 200 },
    ],
  };
}

function envIntLocal(name, def) {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * 本机地址 —— 引擎子进程**必须**直连、绝不能过代理的三个写法（`::1` 是 Node/uvicorn 在本机
 * 可能绑到的 IPv6 回环，少了它就等于"IPv4 放行、IPv6 照样被劫"）。
 */
const LOCAL_NO_PROXY_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/**
 * 本地引擎子进程的**代理旁路**环境（`NO_PROXY`）—— 见 spec-notes D-86。
 *
 * 🔴 为什么非有不可（真机实测链路，2026-10-07）：
 *   `resolveEngineLaunch` 的 env 是 `{ ...process.env, ... }`，于是**用户机器上的
 *   `http_proxy` / `HTTP_PROXY` / `ALL_PROXY` 会被原样继承给引擎进程**；引擎侧
 *   `translators/sakura.py` 用 openai SDK（httpx，默认 `trust_env=True`）访问
 *   `SAKURA_API_BASE` —— 那是 **`http://127.0.0.1:8080/v1`，一个纯本机地址** ——
 *   而 httpx 会老老实实把这个本机请求交给代理。
 *   国内用户普遍挂 Clash / V2Ray 一类的**系统代理或 proxy 环境变量**；只要代理没把
 *   `127.0.0.1` 放进直连名单，本机推理链路就被拦在门外。实测症状（本机 sandbox 代理）：
 *     ① 代理答 `HTTP 502 upstream connect failed ... (os error 10061)`；
 *     ② 引擎 `_handle_translation_request` 重试 `_RETRY_ATTEMPTS=3` 次全 502 后 `return prompt`；
 *     ③ 而 `prompt` 是 **list**，上层 `_translate` 做 `'…' + response` ⇒
 *        `TypeError: can only concatenate str (not "list") to str`；
 *     ④ 整张图被判 `engine_engine_error`，16 张全 `failed`、磁盘上 0 张译文。
 *
 * 语义边界（**只加旁路，不删代理**）：
 *   引擎若改用云端翻译器（非本机 sakura），**仍然需要**走代理 ⇒ 这里保留用户原有的
 *   `http_proxy` 等，只把**本机地址**并进 `NO_PROXY`。删代理会把"云端翻译"一起打死，
 *   而那种坏法（翻译器连不上外网）与本次的坏法（本机被劫）看起来一模一样的难查。
 *
 * 两个大小写都写：httpx / requests / curl 读法不一致（`NO_PROXY` 与 `no_proxy` 都认的库
 * 占多数，但只认其中一个的也不少），写两份的成本是零，漏一份的成本是一次"偶发"。
 *
 * @param {object} env 取值来源（默认 `process.env`；可注入以便断言）
 * @returns {{ NO_PROXY: string, no_proxy: string }}
 */
export function engineLocalNoProxy(env = process.env) {
  const cur = String(env.NO_PROXY ?? env.no_proxy ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [...new Set([...cur, ...LOCAL_NO_PROXY_HOSTS])].join(',');
  return { NO_PROXY: merged, no_proxy: merged };
}

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
    label: 'engine',
    cmd,
    cwd: config.engineServerDir,
    env: {
      ...process.env,
      // 🔴 顺序要紧：必须在 `...process.env` **之后**。若用户（或本机 sandbox）已经设了
      //    `NO_PROXY`，要的是"把它并上本机地址"的那一份，而不是被它原样盖掉（D-86）。
      ...engineLocalNoProxy(),
      // 🔴 引擎子进程的 stdio **必须**是 UTF-8（见 spec-notes D-88）。
      //
      // 不加这一条时，Windows 上 Python 的 stdout/stderr 按**ANSI 代码页**编码
      //（中文机 = GBK/cp936）；而真引擎会把**日文**原文/译文写进日志 —— `utils/log.py`
      // 的 `logging.basicConfig()` 把 root StreamHandler 接到了 **stderr** ⇒ 日志里第一行
      // 日文就是一堆**非法 UTF-8 字节**。
      //
      // 那会连带打死两件事（都实测过）：
      //  ① 上层按行读子进程输出的一端（Rust `service.rs`）读到非法 UTF-8 后会**停止读取**
      //     并关掉管道读端；此后引擎**再写 stderr** 就报 `OSError: [Errno 22] Invalid argument`
      //     —— 而它冒出来的地方看着毫不相干（`tqdm` 初始化时那句 `sys.stderr.flush()`），
      //     整张图因此在「掩码细化」处失败（本 bug 的直接现象）。
      //  ② 即使不崩，日志面板里的日文也会是乱码。
      //
      // 只钉 **stdio**（`PYTHONIOENCODING`），不用 `PYTHONUTF8`：后者会连带改掉
      // locale/文件系统编码，影响面远超"日志用什么编码"这一件事。
      // 顺序同样必须在 `...process.env` 之后 —— 用户机器上那份（若有）说了不算，
      // 因为"上层按 UTF-8 读"是我们这边的硬契约。
      PYTHONIOENCODING: 'utf-8',
      // 引擎③（Sakura LLM）地址：`translators/keys.py` 读 SAKURA_API_BASE
      SAKURA_API_BASE: sakuraBase,
      // nonce 走 env 亦可（`args.py --nonce` 的默认值就是 MT_WEB_NONCE）
      ...(nonce ? { MT_WEB_NONCE: nonce } : {}),
    },
    executorPort: port + 1,
    // 就绪探针 —— 与 `realProbe()` 的三重判定**同源**（不是另写一份）：
    //   ① uvicorn 在听（TCP 8000）② 存活探针应答（POST /queue-size，**POST 不是 GET**）
    //   ③ **执行器端口在听**（TCP 8001）—— 缺 ③ 会把"模型还在加载"误判成 running。
    probes: [
      { kind: 'tcp', port },
      { kind: 'http', port, method: 'POST', path: '/queue-size', expect: 200 },
      { kind: 'tcp', port: port + 1 },
    ],
  };
}
