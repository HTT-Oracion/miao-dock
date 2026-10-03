// mangatranslator-mock —— sidecar 模拟引擎（内部件，对客户端不可见）
//
// 契约依据：§1 服务拓扑（sidecar 监听 127.0.0.1，端口自动探测，默认 5003；**客户端永久不可见**）
// 顶替理由：真实模型未就绪（docs/spec-notes.md D-09）。本文件实现**内部 HTTP 边界**，
// 真实引擎接入时替换本进程即可——Service 侧只依赖 service/src/engine-client.mjs 一处。
//
// 边界：
//   GET  /ready      → { status:"ok", service:"mangatranslator", engine:"sakura-mock" }
//   POST /translate  → Header: X-Miao-Seq / X-Miao-From / X-Miao-To / Content-Type
//                      Body: 原图字节 → 200 译文图字节（image/png）| 非 200 错误信封
//
// 零第三方依赖；仅绑定 127.0.0.1。
import http from 'node:http';

import { readImageSize, sniffImageType } from './image.mjs';
import { renderTranslatedPage } from './render.mjs';

const HOST = '127.0.0.1';
const PORT_START = Number.parseInt(process.env.MIAO_ENGINE_PORT || '5003', 10);
const PORT_END = PORT_START + 7; // §1「自动探测」：5003 起连续 8 个端口

/** 每张耗时（模拟推理），±20% 抖动；默认 300ms —— 20 张约 6 秒，便于验收观察进度 */
const ITEM_MS = Number.parseInt(process.env.MIAO_ENGINE_ITEM_MS || '300', 10);
/** 启动就绪延迟：覆盖 Service 的 `starting` 态与画面 X-C3 */
const START_MS = Number.parseInt(process.env.MIAO_ENGINE_START_MS || '0', 10);
/** 失败注入：指定 seq 必然失败（覆盖 failed / partial_failed / 重试） */
const FAIL_SEQS = new Set(
  String(process.env.MIAO_ENGINE_FAIL_SEQ || '')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0),
);
/** 随机失败率（0–1） */
const FAIL_RATE = Math.max(0, Math.min(1, Number(process.env.MIAO_ENGINE_FAIL_RATE || 0) || 0));

const bootedAt = Date.now();
const log = (msg) => console.log(`[mangatranslator-mock] ${msg}`);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const ready = () => Date.now() - bootedAt >= START_MS;

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function sendBytes(res, status, buf, mime) {
  res.writeHead(status, { 'Content-Type': mime, 'Content-Length': buf.length });
  res.end(buf);
}

const handler = async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const method = req.method || 'GET';

  try {
    if (method === 'GET' && (url.pathname === '/ready' || url.pathname === '/health')) {
      if (!ready()) return sendJson(res, 503, { status: 'starting', service: 'mangatranslator' });
      return sendJson(res, 200, {
        status: 'ok',
        service: 'mangatranslator',
        engine: 'sakura-mock',
        model: 'sakura-mock-1',
        lang: { from: 'ja', to: 'zh' },
        itemMs: ITEM_MS,
      });
    }

    if (method === 'POST' && url.pathname === '/translate') {
      if (!ready()) return sendJson(res, 503, { error: { code: 'ENGINE_STARTING', message: '引擎预热中' } });

      const bytes = await readBody(req);
      const seq = Number.parseInt(req.headers['x-miao-seq'] || '0', 10) || 0;
      const ext = sniffImageType(bytes);
      if (!ext) {
        return sendJson(res, 400, { error: { code: 'ENGINE_BAD_INPUT', message: '输入字节不是可识别图片' } });
      }

      // 模拟推理耗时
      await sleep(Math.max(1, Math.round(ITEM_MS * (0.8 + Math.random() * 0.4))));

      if (FAIL_SEQS.has(seq) || (FAIL_RATE > 0 && Math.random() < FAIL_RATE)) {
        return sendJson(res, 500, {
          error: { code: 'ENGINE_INFERENCE_FAILED', message: `推理失败（seq=${seq}，注入）` },
        });
      }

      const size = readImageSize(bytes, ext) || { width: 400, height: 600 };
      const png = renderTranslatedPage(size.width, size.height, seq || 1);
      return sendBytes(res, 200, png, 'image/png');
    }

    return sendJson(res, 404, { error: { code: 'ENGINE_NOT_FOUND', message: `未知端点：${method} ${url.pathname}` } });
  } catch (err) {
    return sendJson(res, 500, { error: { code: 'ENGINE_ERROR', message: String((err && err.message) || err) } });
  }
};

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

let server = null;
let port = null;
let lastErr = null;
for (let p = PORT_START; p <= PORT_END; p += 1) {
  try {
    server = await listenOnce(p);
    port = p;
    break;
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      log(`端口 ${p} 被占用，尝试下一个…`);
      lastErr = err;
      continue;
    }
    throw err;
  }
}
if (!server) {
  throw new Error(`端口 ${PORT_START}–${PORT_END} 全部被占用，模拟引擎启动失败。最后错误：${lastErr && lastErr.message}`);
}

log('============== mangatranslator-mock 已启动 ==============');
log(`监听地址 : http://${HOST}:${port}`);
log(`引擎     : sakura-mock（ja→zh）`);
log(`单张耗时 : ${ITEM_MS}ms（±20% 抖动）`);
log(`就绪延迟 : ${START_MS}ms`);
log(`失败注入 : FAIL_SEQ=[${[...FAIL_SEQS].join(',')}] FAIL_RATE=${FAIL_RATE}`);
// 机器可读就绪行：桌面端 Rust 层据此确认 sidecar 端口
log(`MIAO_ENGINE_READY ${JSON.stringify({ port, engine: 'sakura-mock' })}`);
log('========================================================');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`收到 ${sig}，关闭中…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 300).unref();
  });
}
