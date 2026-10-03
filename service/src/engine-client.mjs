// sidecar（翻译引擎）客户端 —— box-service 与 mangatranslator 之间的**内部 HTTP 边界**
//
// 契约依据：§1 服务拓扑（sidecar 端口自动探测、默认 5003；**对客户端永久不可见**）
//
// 为什么单独成文件：真实模型就绪前用模拟引擎顶替（docs/spec-notes.md D-09）。
// 真实引擎的协议若与模拟引擎不同，**只需替换本文件**，store/server 无需改动。
//
// 边界约定（本文档即该内部协议的唯一定义处）：
//   POST {base}/translate
//     Header: Content-Type: <原图 MIME>、X-Miao-Seq: <序号>、X-Miao-From: ja、X-Miao-To: zh
//     Body:   原图字节（原样透传，不做任何编码转换）
//     200 →   译文图字节（Content-Type 标明格式）；非 200 → JSON { error: { code, message } }
//   GET  {base}/ready
//     200 →   { status: "ok", service: "mangatranslator", engine: "..." }
import http from 'node:http';

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

function requestOnce(pathname, { method = 'POST', headers = {}, body = null } = {}) {
  const { engineHost: host, enginePort: port, engineTimeoutMs } = config;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path: pathname, method, headers, timeout: engineTimeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('timeout', () => {
      req.destroy(new EngineError('ENGINE_TIMEOUT', `引擎响应超时（${engineTimeoutMs}ms）`));
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

/**
 * 单张翻译。
 * @param {Buffer} bytes 原图字节
 * @param {{seq:number, from?:string, to?:string, mime?:string}} opts
 * @returns {Promise<{bytes:Buffer, ext:string, mime:string}>}
 */
export async function translateImage(bytes, opts) {
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

  // 扩展名取**服务端对返回字节的嗅探结果**，不信任引擎自称的 Content-Type
  const ext = sniffImageType(res.body);
  if (!ext) {
    throw new EngineError('ENGINE_BAD_OUTPUT', '引擎返回的字节不是可识别的图片（PNG/JPEG/WEBP）');
  }
  return { bytes: res.body, ext, mime: `image/${ext === 'jpg' ? 'jpeg' : ext}` };
}

/** sidecar 就绪探测（契约 §5.1 的 `sidecar.state`）：不抛错，只回答「就绪 / 未就绪」 */
export async function probeEngine() {
  if (config.sidecarDown) return { state: 'stopped', port: null, engine: null };
  try {
    const res = await requestOnce('/ready', { method: 'GET' });
    if (res.status !== 200) return { state: 'starting', port: config.enginePort, engine: null };
    const parsed = JSON.parse(res.body.toString('utf8'));
    return { state: 'running', port: config.enginePort, engine: parsed.engine || null };
  } catch {
    return { state: 'stopped', port: null, engine: null };
  }
}
