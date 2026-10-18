// sakura-mock-llm —— 引擎③（LLM）的**模拟替身**
//
// 为什么要有它：真实链路里 LLM 是**第三个独立进程**（`llama-server`，见 D-xx S2）。
// 而 `engine/src/server.mjs`（模拟引擎）只在 mock 协议下顶替**引擎②**，链路里没有 ③。
// 若 mock 模式只有两个进程，那么「三进程可拉起 / 可回收」「崩溃分级（③挂 ⇒ 仅翻译阶段失败）」
// 这两条在**秒级可反证的回路**里就根本走不到 —— 只能靠跑真引擎（分钟级、几 GB 权重）去验。
// ⇒ 补一个极小的 ③ 替身，让结构性的东西在快速回路里也被真的执行到。
//
// 边界（只实现**就绪探针用到的那一个端点**，别的一律 404 —— 假装得越像越危险）：
//   GET /v1/models → 200 OpenAI 兼容模型列表（真 `llama-server` 亦如此，就绪判据同源）
//   GET /health    → 200
// 零第三方依赖；仅绑定 127.0.0.1；装父死看门狗（与 ② 同一份，见 parent-watch.mjs）。
import http from 'node:http';

import { watchParent } from './parent-watch.mjs';

const HOST = '127.0.0.1';

function argPort() {
  const i = process.argv.indexOf('--port');
  if (i > -1) {
    const n = Number.parseInt(process.argv[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const n = Number.parseInt(process.env.MIAO_LLM_PORT || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 8080;
}

const PORT = argPort();
const log = (m) => console.log(`[sakura-mock-llm] ${m}`);

/**
 * 档位（`--model tiny|small|medium`）。
 *
 * 为什么替身也要认档位：降档重试（《04》§8）的判据是「③ 换成了**另一档**的权重」。
 * 若替身对档位毫无反应，那条断言就只能读一句**自报的日志** —— 而日志是可以被写成
 * "说降了但没降"的。让它出现在 `/v1/models` 里，外部观察者就能**从真实的进程参数**取证。
 */
function argModel() {
  const i = process.argv.indexOf('--model');
  if (i > -1 && process.argv[i + 1]) return String(process.argv[i + 1]);
  return process.env.MIAO_LLM_TIER || 'tiny';
}

const TIER = argModel();
const MODEL_ID = `sakura-mock:${TIER}`;

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}:${PORT}`);
  const send = (code, body) => {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length });
    res.end(buf);
  };
  if (req.method === 'GET' && pathname === '/v1/models') {
    return send(200, { object: 'list', data: [{ id: MODEL_ID, object: 'model' }] });
  }
  if (req.method === 'GET' && pathname === '/health') {
    return send(200, { status: 'ok', engine: 'sakura-mock-llm', model: MODEL_ID });
  }
  return send(404, { error: { code: 'NOT_FOUND', message: `${req.method} ${pathname}` } });
});

server.on('error', (e) => {
  log(`监听失败：${e.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log('========================================================');
  log(`监听地址 : http://${HOST}:${PORT}`);
  log(`模型     : ${MODEL_ID}（档位替身，不出译文，只证明"③ 这个进程在"、且处在哪一档）`);
  // 机器可读就绪行：与真实 llama-server 的 `/v1/models` 对应，供 Rust 层确认端口
  log(`MIAO_LLM_READY ${JSON.stringify({ port: PORT, engine: 'sakura-mock-llm', model: MODEL_ID })}`);
  log('========================================================');
});

// 父进程（S4 起是 **manga-service**；此前是 Rust 壳）被强杀时自我退出，避免变成占住 8080 的孤儿（E11）
watchParent();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`收到 ${sig}，关闭中…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 300).unref();
  });
}
