#!/usr/bin/env node
/**
 * E5（降档重试）/ E6（空闲卸载 → 懒加载恢复）的**端到端**验收 —— 真服务 + 真引擎 + 真 ③。
 *
 * ## 为什么与 `engine-profile-check.mjs` 分家
 * 那边验的是**判定**（纯函数：映射表、降档规则、空闲阈值边界），秒级、可枚举全部边界值。
 * 这边验的是**动作**：`§8 降档`要真的把 ③ 停掉换成另一档再拉起来、`§9 空闲卸载`要真的让
 * 进程消失再懒加载回来。这类东西的判据是「进程还在不在、端口还听不听、新进程起的是哪一档」，
 * 只能靠真进程回答；而它同时要花掉一个端口段 + 十几秒 ⇒ 不适合塞进被反证轮反复 spawn 的脚本。
 *
 * ## 关键取证手段（都不信"自报"）
 *   · ③ 的**档位**：直接打它自己的 `GET /v1/models` 读 model id（`sakura-mock:<tier>`）——
 *     mock 替身把 `--model <tier>` 回显在模型列表里，故这是**该进程真实启动参数**的投影，
 *     而不是 manga-service 日志里那句话。
 *   · ③ 的**存活**：直接连它的端口。§9.4 特意把「卸载 ≠ 未就绪」写成铁律，
 *     所以卸载后还必须能读到 `/health` 的 `sidecar.state === 'running'` + 端口不通。
 *   · **卸载/重启/降档**的事件顺序：读服务 stdout（那是"什么时候发生的"的唯一时间线）。
 *
 * ## OOM 从哪来
 * `engine/src/server.mjs` 的 `MIAO_ENGINE_OOM_TIMES=N`：开播后前 N 次 `/translate` 返回
 * 显存不足（文案照 llama.cpp / torch 的真实形状），之后恢复正常 —— 模拟"降到低档就装得下了"。
 * 注入的是**可复现的内存不足**，被测的是 service 的降档判定与重启，链路本身没有被绕过。
 *
 * 用法：
 *   node e2e/service/e5-e6-check.mjs            正向跑
 *   node e2e/service/e5-e6-check.mjs --refute   反证轮（**逃生开关**：关掉机制 → 断言必须变红）
 *
 * 约束：纯 Node、零第三方依赖；临时目录自建自清；不碰用户目录；不占 5180–5190（那是 manga-service 的段）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { encodePng } from '../../engine/src/png.mjs';
// F0：服务入口解析的唯一事实源（MIAO_SERVICE_IMPL=node|rust 切换靶子）
import { killTree, SERVICE_ENTRY, spawnTarget } from './_service-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENGINE_ENTRY = path.join(ROOT, 'engine', 'src', 'server.mjs');

const REFUTE = process.argv.includes('--refute');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-e5e6-'));
const TOKEN = 'a'.repeat(64);
/** 空闲阈值压到 1.5s —— 真等 5 分钟是不可反证的断言（等不到就重跑，分不清是坏了还是慢） */
const IDLE_MS = 1500;
/** 看护的巡检间隔（`createIdleWatcher` 默认 5s）。压小它，让"到点卸载"落在这个脚本的耐心内 */
const IDLE_TICK_MS = 250;

const sleep = (ms) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

// ------------------------------------------------------------------ 进程 / 端口

function portOpen(port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        s.destroy();
        resolve(v);
      }
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function findFreePort(start, { avoid = [] } = {}) {
  for (let p = start; p < start + 300; p += 1) {
    if (avoid.includes(p)) continue;
    if (!(await portOpen(p, 100))) return p;
  }
  throw new Error(`从 ${start} 起找不到空闲端口`);
}

/** 直连 ③ 的 HTTP 面（**独立于被测代码**的第二取证路径）。返回 `{status, body}` 或 `null` */
function httpGet(port, pathname, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** ③ 自报的模型 id（`sakura-mock:<tier>`）—— 读不到就返回 null（进程不在或还没接客） */
async function llmModelId(port) {
  const res = await httpGet(port, '/v1/models');
  if (!res || res.status !== 200) return null;
  try {
    const parsed = JSON.parse(res.body);
    return parsed?.data?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

function spawnProc(entry, env, tag, extraArgv = []) {
  // entry 是服务 ⇒ 按 MIAO_SERVICE_IMPL 选靶子；是引擎 ⇒ 原样走 node（见 _service-harness.mjs）
  const child = spawnTarget(entry, env, extraArgv);
  const st = { child, out: '', err: '', ready: null, tag };
  child.stdout.on('data', (d) => {
    st.out += d.toString();
    const m = /MIAO_(?:ENGINE_)?READY (\{.*\})/.exec(st.out);
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
  while (!st.ready && Date.now() < until) await sleep(50);
  if (!st.ready) throw new Error(`${st.tag} 未就绪。stdout=${st.out.slice(-400)}\nstderr=${st.err.slice(-400)}`);
  return st.ready;
}

function killProc(st) {
  // 🔴 杀进程树（不是只杀主进程）：rust 服务派生的引擎②/③ 否则全成孤儿（D-202）
  if (st && st.child && st.child.exitCode === null) killTree(st.child);
}

/** 等子进程**真的**退出（SIGTERM 之后它还要收尾）—— 用 `exitCode` 而不是 sleep 一个定值 */
async function waitChildGone(st, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (st.child.exitCode === null && Date.now() < until) await sleep(50);
  return st.child.exitCode !== null;
}

/** 等端口彻底不通（旧服务的 ③ 要先让出端口，新服务的 ③ 才绑得上同一个号） */
async function waitPortClosed(port, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (await portOpen(port, 200)) {
    if (Date.now() > until) return false;
    await sleep(100);
  }
  return true;
}

// ------------------------------------------------------------------ 服务 HTTP 夹子

function request(port, method, pathname, { headers = {}, body = null, token } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (token) h['X-Box-Token'] = token;
    if (body) h['Content-Length'] = body.length;
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const json = (res) => {
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    return null;
  }
};

/** 契约 §5.2：payload + images[]（单张就够 —— 本脚本测的是引擎生命周期，不是批量） */
function buildMultipart({ payload, images }) {
  const boundary = `----miao${crypto.randomBytes(8).toString('hex')}`;
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, 'utf8'));
  push(`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n`);
  push(JSON.stringify(payload));
  push('\r\n');
  for (const img of images) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="images[]"; filename="${img.filename}"\r\n` +
        `Content-Type: ${img.contentType || 'application/octet-stream'}\r\n\r\n`,
    );
    parts.push(img.data);
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return { body: Buffer.concat(parts), boundary };
}

/** 一张最小可嗅探的 PNG —— `encodePng(w, h, painter)`；painter 收 `(x, y, put)` */
function pngBytes(w = 40, h = 60, seed = 1) {
  return encodePng(w, h, (x, y, put) => {
    put((seed * 37 + x) % 256, (seed * 17 + y) % 256, (seed * 7) % 256);
  });
}

async function submitOne(port, comicName) {
  const { body, boundary } = buildMultipart({
    payload: { comicName, idempotencyKey: crypto.randomUUID() },
    images: [{ filename: '001.png', contentType: 'image/png', data: pngBytes(40, 60, 3) }],
  });
  const res = await request(port, 'POST', '/api/v1/tasks', {
    token: TOKEN,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  return { status: res.status, json: json(res) };
}

async function waitTask(port, taskId, timeoutMs = 40_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(port, 'GET', `/api/v1/tasks/${taskId}`, { token: TOKEN });
    const task = json(res);
    if (res.status !== 200 || !task || !task.taskId) {
      throw new Error(`任务详情读取失败 status=${res.status} body=${res.body.toString('utf8').slice(0, 160)}`);
    }
    if (['done', 'partial_failed', 'failed', 'canceled'].includes(task.status)) return task;
    if (Date.now() > until) throw new Error(`任务 ${taskId} 未在 ${timeoutMs}ms 内结束（当前 ${task.status}）`);
    await sleep(100);
  }
}

// ------------------------------------------------------------------ 断言收集

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}
const out = { pass: 0, fail: 0 };
function printResults() {
  out.pass = results.filter((r) => r.ok).length;
  out.fail = results.length - out.pass;
  console.log('\n### 汇总（E5 降档重试 · E6 空闲卸载与懒加载恢复）');
  for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.id}${r.detail ? `  ${r.detail}` : ''}`);
  console.log(`[RESULT] ${JSON.stringify({ results, pass: out.pass, fail: out.fail })}`);
  console.log(`\n通过 ${out.pass} / 失败 ${out.fail}`);
}

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

/**
 * 等某条日志出现（最多 `timeoutMs`），返回匹配结果或 `null`。
 *
 * 🔴 为什么需要它：`③ LLM 就绪（pid=…）` 这句是**端口先通、日志随后写**——
 * 探针返回 true 之后才 `state='running'` 再打日志。所以"端口通了"就读 stdout 会读到
 * **上一轮**的行数（症状：`pidBefore=NaN`，或把上一代 ③ 的 pid 当成这一代的）。
 * 这类"取证比事实早一拍"的错误在本项目里出现过多次，故一律用等待而不是 sleep 固定毫秒。
 * ⚠️ 传进来的正则**不要带 `g`**（带 g 的正则有 lastIndex 状态，反复 exec 会漏配）。
 */
async function waitLog(st, re, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const m = re.exec(st.out);
    if (m) return m;
    if (Date.now() > until) return null;
    await sleep(50);
  }
}

// ------------------------------------------------------------------ 主流程

async function run() {
  const enginePort = await findFreePort(5300);
  const llmPort = await findFreePort(8900);
  const rootDir = path.join(TMP, 'Box 漫画');

  const engine = spawnProc(
    ENGINE_ENTRY,
    {
      MIAO_ENGINE_PORT: String(enginePort),
      MIAO_ENGINE_ITEM_MS: '40',
      MIAO_ENGINE_OOM_TIMES: '1', // E5 的现场条件：第 1 次翻译显存不足，第 2 次起正常
    },
    'engine',
  );

  let service = null;
  try {
    const eng = await waitReady(engine);

    // 服务进程的环境变量抽出来，因为 E6.7 要**用同一份配置重启**服务：
    // `MIAO_MANGA_ROOT_DIR` / `MIAO_MANGA_STATE_DIR` 必须与第一次完全一致，否则"上一轮的终态任务"
    // 根本不在盘上，那组断言就变成了空转（绿得毫无意义）。
    const svcEnv = {
      MIAO_ENGINE_PROTOCOL: 'mock',
      MIAO_ENGINE_PORT: String(eng.port),
      MIAO_LLM_PORT: String(llmPort),
      MIAO_MANGA_ROOT_DIR: rootDir,
      MIAO_MANGA_STATE_DIR: path.join(TMP, 'state'),
      MIAO_TOKEN: TOKEN,
      MIAO_ENGINE_TIER: 'small', // 用户配置档位 = small（本机硬件推荐是 tiny，故"降档"有空间可降）
      MIAO_IDLE_LLM_MS: String(IDLE_MS),
      MIAO_IDLE_TICK_MS: String(IDLE_TICK_MS),
    };
    service = spawnProc(SERVICE_ENTRY, svcEnv, 'service');
    const svc = await waitReady(service);
    const port = svc.port;
    console.log(`[e5e6] service=${port} engine=${eng.port} ③=${llmPort} 落盘=${rootDir}`);

    // ③ 是**异步**预拉起的（不等它，服务才能自己的就绪行尽快出来）⇒ 这里等它接客
    let tierBefore = null;
    for (let i = 0; i < 300; i += 1) {
      tierBefore = await llmModelId(llmPort);
      if (tierBefore) break;
      await sleep(100);
    }
    check(
      'E5.0 前置：③ 已按**用户配置档位**拉起（`MIAO_ENGINE_TIER=small` ⇒ 自己报 `sakura-mock:small`）' +
        ' —— 否则"降档"根本没有可降的空间，后面的断言会变成空转',
      tierBefore === 'sakura-mock:small',
      String(tierBefore),
    );
    const pidBefore = Number.parseInt((await waitLog(service, /③ LLM 就绪：[^（]*（pid=(\d+)）/))?.[1] ?? '', 10);

    // ============================================================ E5 · 降档重试（§8）
    const r1 = await submitOne(port, 'E5 降档');
    if (r1.status !== 201) throw new Error(`提交失败 status=${r1.status} ${JSON.stringify(r1.json)}`);
    const t1 = await waitTask(port, r1.json.taskId);
    const t1Items = t1.items || [];

    check(
      'E5.1 §8.2：OOM 后**降一档重试**，这一张最终仍成功（对用户是无感的，不是失败）',
      t1.status === 'done' && t1Items.length === 1 && t1Items[0].status === 'success',
      `任务=${t1.status} 明细=${JSON.stringify(t1Items.map((i) => ({ seq: i.seq, status: i.status, reason: i.reason })))}`,
    );

    check(
      'E5.2 现场条件成立：引擎**确实**先报了一次显存不足（否则 E5.1 是"没遇到 OOM 也能过"的假绿）',
      countOf(engine.out, '注入显存不足') === 1 && countOf(engine.out, 'OOM_TIMES=1') === 1,
      `注入 ${countOf(engine.out, '注入显存不足')} 次`,
    );

    check(
      'E5.3 §8.1「仅降一次」+ §8.2 留痕：日志里「引擎已从 small 降至 tiny」**恰好一次**' +
        '（出现两次就说明闩没生效；一次都不出现说明降档是"悄悄做的"）',
      countOf(service.out, '引擎已从 small 降至 tiny') === 1,
      `出现 ${countOf(service.out, '引擎已从 small 降至 tiny')} 次`,
    );

    // 降档是否**真的落到引擎**：直接问新 ③ 自己是哪一档
    let tierAfter = null;
    for (let i = 0; i < 100; i += 1) {
      tierAfter = await llmModelId(llmPort);
      if (tierAfter === 'sakura-mock:tiny') break;
      await sleep(100);
    }
    check(
      'E5.4 降档**真的落到引擎**：③ 现在自报 `sakura-mock:tiny`（不是只改了服务侧的一句日志）',
      tierAfter === 'sakura-mock:tiny',
      String(tierAfter),
    );

    const pids = [...service.out.matchAll(/③ LLM 就绪：[^（]*（pid=(\d+)）/g)].map((m) => Number.parseInt(m[1], 10));
    check(
      'E5.5 降档 = **换了一个进程**（换了权重就得换进程）：③ 的 pid 与降档前不同，且端口始终在同一个上听',
      pids.length === 2 && pids[0] === pidBefore && pids[1] !== pids[0] && (await portOpen(llmPort)),
      `pid ${pids.join(' → ')}（降档前=${pidBefore}）`,
    );

    check(
      'E5.6 §8.3 降档是**内部行为**、不新增客户端状态机节点：任务详情里 8 态仍是 done，' +
        '页级 `retryCount` 为 0（一次 OOM 只走降档一次，**不额外计 item 重试**）',
      t1Items[0].retryCount === 0 && t1.status === 'done',
      `retryCount=${t1Items[0].retryCount}`,
    );

    // ============================================================ E6 · 空闲卸载 + 懒加载恢复（§9）
    // 等 ③ 自己消失（阈值 1.5s、巡检 250ms，几秒内的事）
    let unloaded = false;
    const unloadDeadline = Date.now() + 20_000;
    while (Date.now() < unloadDeadline) {
      if (!(await portOpen(llmPort, 200))) {
        unloaded = true;
        break;
      }
      await sleep(120);
    }
    check(
      'E6.1 §9.1 Tier1：空闲达阈值后 ③ **真的退出**（端口不通 —— 不是"以为退了"）',
      unloaded,
      unloaded ? `端口 ${llmPort} 已不通` : `端口 ${llmPort} 20s 后仍在听，空闲卸载没发生`,
    );

    const health = await request(port, 'GET', '/api/v1/health');
    const hp = json(health);
    check(
      'E6.2 §9.4「卸载 ≠ 未就绪」：③ 卸载后服务**仍 running**、`/health` 照常 200' +
        '（若这里退了，是"未就绪"而不是"卸载"，客户端文案必须能区分这两件事）',
      health.status === 200 &&
        hp?.status === 'ok' &&
        hp?.sidecar?.state === 'running' &&
        !(await portOpen(llmPort, 200)),
      `health=${health.status} status=${hp?.status} sidecar=${hp?.sidecar?.state} ③端口通=${await portOpen(llmPort, 200)}`,
    );

    check(
      'E6.3 卸载事件留痕：日志里有「空闲 … ⇒ 卸载 ③ LLM」（E6 的现场凭证，排障时按这句定位）',
      /空闲 \d+s ≥ \d+s ⇒ 卸载 ③ LLM/.test(service.out),
      (service.out.match(/空闲 \d+s ≥ \d+s ⇒ 卸载 ③ LLM/) || ['无'])[0],
    );

    // 懒加载恢复：再来一个任务，③ 必须被自动拉回来，且任务成功
    const r2 = await submitOne(port, 'E6 懒加载');
    if (r2.status !== 201) throw new Error(`提交失败 status=${r2.status} ${JSON.stringify(r2.json)}`);
    const t2 = await waitTask(port, r2.json.taskId);

    const pids2 = [...service.out.matchAll(/③ LLM 就绪：[^（]*（pid=(\d+)）/g)].map((m) => Number.parseInt(m[1], 10));
    check(
      'E6.4 §9.3 懒加载恢复：③ 被自动拉起（**新 pid**）、端口重新在听，任务照常成功' +
        '（对用户表现为"这张稍慢"，而不是失败）',
      t2.status === 'done' && pids2.length === 3 && pids2[2] !== pids2[1] && (await portOpen(llmPort)),
      `任务=${t2.status} pid 轨迹=${pids2.join(' → ')}`,
    );

    check(
      'E6.5 §8.3 与 §9.3 的交叉：**重启后仍跑降档后的档位**（tiny）' +
        ' —— 降档只在本次运行期有效，但不该被一次空闲卸载抹掉',
      (await llmModelId(llmPort)) === 'sakura-mock:tiny',
      String(await llmModelId(llmPort)),
    );

    check(
      'E6.6 §9.2 安全铁律的**运行时**表现：E5/E6 两个任务全程，日志里没有出现过' +
        '「队列非空却卸载」这类越界动作（卸载次数 = 1，正好对上一次真正的空闲）',
      countOf(service.out, '⇒ 卸载 ③ LLM') === 1,
      `卸载 ${countOf(service.out, '⇒ 卸载 ③ LLM')} 次`,
    );

    // ============================================================ E6.7 / E6.8 · 跨进程重启（§9.1 的边界）
    //
    // 🔴 这一组是**从一个真缺陷回填的**：`store.init()` 会把上一轮的终态任务从盘上恢复进
    //    `store.tasks`（任务清单要显示历史），而最初的 `lastActivityAt()` 把这些历史活动的
    //    最大时刻直接当成"本次运行的活动" ⇒ 重启后第一次判定就是
    //    「距上次活动 N 小时 ≥ 阈值 ⇒ 卸载 ③」——③ 刚被拉起就被卸掉。
    //    用户看到的是"重启 Box 之后翻译一直起不来"；而在**全新状态目录**下跑（本脚本原先那样）
    //    永远不复现。所以这里**故意复用同一个 `MIAO_MANGA_STATE_DIR`** 重启服务，把它变成可反证的断言。
    //    反证开关 `MIAO_IDLE_SCOPE=all` 恢复旧口径 ⇒ E6.7 必须变红。
    killProc(service);
    await waitChildGone(service);
    await waitPortClosed(llmPort); // 旧 ③ 先让出端口，新服务才绑得上同一个号

    service = spawnProc(SERVICE_ENTRY, svcEnv, 'service');
    const svc2 = await waitReady(service);

    // ③ 是异步预拉起的：先等它接客，再开始计时
    let restartedLlmUp = false;
    for (let i = 0; i < 300; i += 1) {
      if (await llmModelId(llmPort)) {
        restartedLlmUp = true;
        break;
      }
      await sleep(100);
    }
    // ⚠️ 编号用 `E6.7a` 而不是 `E6.7 前置`：反证轮的 `matchById()` 是**前缀匹配**
    //    （`id.startsWith(code + ' ')`），若前置也叫 `E6.7 …`，它会命中前置那条，
    //    于是"主断言变红"可能被前置的绿盖住 ⇒ 反证误判。
    check(
      'E6.7a 前置：重启后 ③ **确实被重新拉起**（否则"没被卸"可能只是"压根没起来"，断言会变成空转）',
      restartedLlmUp,
      restartedLlmUp ? `端口 ${llmPort} 已接客` : `端口 ${llmPort} 30s 内没接客`,
    );

    // 观察窗口：阈值 1.5s、巡检 250ms ⇒ 6 次巡检。给足冗余，慢机器上也够判红。
    await sleep(Math.max(6 * IDLE_MS, 12 * IDLE_TICK_MS));
    const llmStillUp = await portOpen(llmPort, 300);
    check(
      'E6.7 §9.1 重启边界：状态目录里**带着上一轮的终态任务**时，本次运行还没跑过任务 ⇒ ' +
        '③ **不该**被判空闲卸载（"距上次活动 18 小时"是**上一次运行**的事，不是本次的热态）',
      llmStillUp && countOf(service.out, '⇒ 卸载 ③ LLM') === 0,
      `③端口通=${llmStillUp} · 本次运行卸载次数=${countOf(service.out, '⇒ 卸载 ③ LLM')}`,
    );

    // 对照：不能把机制改死 —— 本次运行**跑过**任务之后，空闲卸载仍然必须生效
    // （注意用 `svc2.port`：服务端口是自选的，重启后不一定还落在同一个号上）
    const r3 = await submitOne(svc2.port, 'E6 重启后');
    if (r3.status !== 201) throw new Error(`重启后提交失败 status=${r3.status} ${JSON.stringify(r3.json)}`);
    const t3 = await waitTask(svc2.port, r3.json.taskId);
    let unloaded2 = false;
    const dl2 = Date.now() + 20_000;
    while (Date.now() < dl2) {
      if (!(await portOpen(llmPort, 200))) {
        unloaded2 = true;
        break;
      }
      await sleep(120);
    }
    check(
      'E6.8 对照（防"把机制改死"）：重启后的新服务**跑过一个任务** ⇒ 空闲达阈值时 ③ 照常被卸载' +
        '（只绿 E6.7 不绿本条，说明是把卸载关掉了，而不是修对了范围）',
      t3.status === 'done' && unloaded2 && countOf(service.out, '⇒ 卸载 ③ LLM') === 1,
      `任务=${t3.status} · ③端口通=${await portOpen(llmPort, 200)} · 本次运行卸载次数=${countOf(service.out, '⇒ 卸载 ③ LLM')}`,
    );
  } finally {
    killProc(service);
    killProc(engine);
    await sleep(400);
    for (const st of [service, engine]) {
      if (st && st.child.exitCode === null) {
        try {
          st.child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
  }
}

// ================================================================ 反证轮

/**
 * 反证用**逃生开关**而不是改源码：`MIAO_NO_TIER_DOWNGRADE` / `MIAO_NO_IDLE_UNLOAD`
 * 是产品里真实存在的开关（关掉机制本身）。关掉之后目标断言必须变红 ——
 * 这才证明"断言测的确实是这个机制"，而不是"碰巧绿"。
 *
 * `expect` 只列**必须变红**的条目；其他条目可能连带变红（比如关掉降档后 ③ 的档位就不是 tiny 了），
 * 那是正常的连带，不影响判定。
 */
const REFUTATIONS = [
  {
    name: '关掉降档机制（`MIAO_NO_TIER_DOWNGRADE=1`）⇒ 降档相关断言必须变红',
    env: { MIAO_NO_TIER_DOWNGRADE: '1' },
    expect: ['E5.3', 'E5.4', 'E5.5'],
  },
  {
    name: '关掉空闲卸载（`MIAO_NO_IDLE_UNLOAD=1`）⇒ 卸载与懒加载相关断言必须变红',
    env: { MIAO_NO_IDLE_UNLOAD: '1' },
    expect: ['E6.1', 'E6.3', 'E6.4'],
  },
  {
    // 这条打的是**范围**（本次运行 vs 含历史），与上面那条打的**机制开关**（卸不卸）是不同的两面。
    name: '恢复旧口径「任务活动含历史记录」（`MIAO_IDLE_SCOPE=all`）⇒ 重启边界断言必须变红',
    env: { MIAO_IDLE_SCOPE: 'all' },
    expect: ['E6.7'],
  },
];

const EXPECTED_REFUTATIONS = 3; // 分母写死

function matchById(list, code) {
  return list.find((r) => r.id === code || r.id.startsWith(`${code} `));
}

async function runRefute() {
  const { spawnSync } = await import('node:child_process');
  console.log('E5/E6 · 反证轮（关掉机制 → 断言必须变红）');
  console.log(`应执行 ${EXPECTED_REFUTATIONS} 条\n`);

  let executed = 0;
  let asExpected = 0;
  const problems = [];

  for (const ref of REFUTATIONS) {
    const child = spawnSync(process.execPath, [import.meta.filename], {
      encoding: 'utf8',
      env: { ...process.env, ...ref.env },
    });
    const line = (child.stdout || '').split('\n').find((l) => l.startsWith('[RESULT] '));
    executed += 1;
    if (!line) {
      problems.push(`${ref.name}：子进程未产出结果行（stdout 尾部：${(child.stdout || '').slice(-300)}）`);
      console.log(`⚠ ${ref.name}\n    子进程没有结果行`);
      continue;
    }
    const parsed = JSON.parse(line.slice('[RESULT] '.length));
    const missed = ref.expect.filter((code) => matchById(parsed.results, code)?.ok !== false);
    console.log(`🔴 ${ref.name}`);
    for (const code of ref.expect) {
      const hit = matchById(parsed.results, code);
      console.log(
        `   ${hit?.ok === false ? '✓' : '✗'} ${code} ` +
          `${hit?.ok === false ? '按预期变红' : `**没有变红**（${hit ? hit.detail : '缺该条'}）`}`,
      );
    }
    if (missed.length === 0) asExpected += 1;
    else problems.push(`${ref.name}：${missed.join(',')} 未变红`);
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`反证：${asExpected} / ${EXPECTED_REFUTATIONS} 条按预期变红（应执行 ${EXPECTED_REFUTATIONS}）`);
  if (executed !== EXPECTED_REFUTATIONS || asExpected !== EXPECTED_REFUTATIONS) {
    console.log('\n下面是未达预期的条目：');
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exitCode = 1;
  }
}

// ================================================================ 入口

if (REFUTE) {
  await runRefute();
} else {
  console.log('E5 降档重试 / E6 空闲卸载与懒加载恢复 —— 端到端（真服务 + 真引擎 + 真 ③）');
  try {
    await run();
  } catch (err) {
    check('RUN 脚本未预期崩溃（视为失败：脚本崩溃 ≠ 断言通过）', false, `${err.message}`);
  }
  printResults();
  process.exitCode = out.fail === 0 ? 0 : 1;
}
