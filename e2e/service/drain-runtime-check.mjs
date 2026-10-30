#!/usr/bin/env node
/**
 * F5 · 队列驱动线程的钉子（D-150）：**引擎在飞时必须放锁**，且队列仍要跑到底
 * =============================================================================
 * 为什么要有这个钉子：`drain.rs` 把 `Store::drain` 放到独立线程上跑。本仓的 store 是**同步
 * 模型**（`Arc<Mutex<Store>>`），最省事的写法是「拿锁 → 一口气 drain 到底 → 放锁」。那样写，
 * 引擎在飞的那几秒里 `GET /tasks` / `GET /queue` / `POST .../cancel` **全被挡在同一把锁后面**，
 * 于是三类**中间态**在 HTTP 上根本观察不到：
 *   ① 任务正在跑（`running`）与某页正在翻（`translating`）—— 详情页轮询只能看到上一次终态；
 *   ② 排队位次（`/queue` 的 `running` / `queued[].position`）—— 队列页永远是空的；
 *   ③ 取消（`cancelTask` 要等当前张跑完）—— 请求被挡到任务已终态，只能回 409。
 * e2e 的 A10/A11/A13/A15/A20 量的就是这三件事，实测**全红**；而「任务最终跑完了」这条
 * 却是绿的 —— 典型的「功能对了、时序错了」，不写钉子就会被当成偶发。
 *
 * 🔴 隔离实验（登记 D-151 的**更正**）：早期把这类卡死归因于「驱动线程复用了主运行时的
 *    `Handle::block_on`」（D-151）。加开关把「持锁 / 放锁」与「自持运行时 / 复用 Handle」
 *    四象限实测，结论是：**变量是「持锁」** —— `Handle` 在「放锁」形态下完全正常（读延迟 1ms、
 *    任务照常 done）；两种驱动在「持锁」形态下都挡中间态，且叠加并发读压时会硬卡死。
 *    ⇒ 自持运行时（`EngineDriver::Own`）保留为**防御性**选择（队列推进不依赖主运行时的
 *    driver），但**不是**本钉子要钉的东西；本钉子钉的是「持锁期间不可读」。
 *
 * ## 断言（正向：默认形态）
 *   D150.precondition          靶子是 rust（本钉子只对 Rust 驱动线程有意义）
 *   D150.ready                 服务就绪（模拟引擎 + mangasvc）
 *   D150.intermediateVisible   运行期 `GET /tasks/{id}` 及时返回，且如实给出 running + translating
 *   D150.queueReadable         运行期 `GET /queue` 及时返回，且 running 就是该任务
 *   D150.queuePositionVisible  运行期提交的第二个任务在 `/queue` 里可见且有位次 1
 *   D150.drainsUnderLoad       读压之下队列仍跑到底（两个任务都 done）
 *   D150.readPressureClean     读压请求零错误
 *
 * ## 反证轮（--refute：`MIAO_DRAIN_HOLD_LOCK=1` 把整段 drain 压回一把锁）
 *   D150.refuteIntermediateHidden  运行期 `GET /tasks/{id}` **被挡到任务跑完**（读不到中间态）
 *   D150.refuteQueueBlocked        运行期 `GET /queue` 同样被挡
 *   D150.refuteAlive               服务进程仍存活（是「被挡住」不是崩溃）
 *
 * ## 为什么必须带并发读压
 * 只在「有人读」时才挡；不读的话「持锁」与「放锁」观察不到差别（假绿）。读压也顺带覆盖了
 * 「多路轮询下队列仍能推进」这条真实场景（前端详情页 + 队列页同时轮询）。
 *
 * 用法：node e2e/service/drain-runtime-check.mjs [--refute]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { encodePng } from '../../engine/src/png.mjs';
import { IMPL, killTree, SERVICE_ENTRY, spawnTarget } from './_service-harness.mjs';

const REFUTE = process.argv.includes('--refute');

// 起的是模拟引擎（`engine/src/server.mjs`，ver1.0 字节式协议），**不是**真实引擎协议 ⇒ 老实声明。
process.env.MIAO_ENGINE_PROTOCOL = 'mock';
// 本钉子不验 ③ 的生命周期（那有自己的脚本），且要反复起停实例 ⇒ 显式退出预拉起。
process.env.MIAO_NO_LLM_AUTOSTART = '1';

/** 模拟引擎每张的耗时 —— 撑开一个足够宽的「运行期」窗口（4 张 ⇒ 约 2s）。 */
const ITEM_MS = 500;
const IMAGES = 4;
/** 「及时返回」的判据：正常形态下读是毫秒级；持锁形态下会被挡到任务跑完（> 2s）。 */
const READ_DEADLINE_MS = 1500;
/** 读压：4 条独立连接持续轮询 `/queue`（模拟前端队列页 + 详情页同时轮询）。 */
const POLLERS = 4;
/** 每个请求自己的硬超时 —— 保证脚本**永不**因为服务被卡住而挂起。 */
const REQ_TIMEOUT_MS = 5000;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-drain-runtime-'));
const ENGINE_ENTRY = path.resolve(import.meta.dirname, '..', '..', 'engine', 'src', 'server.mjs');
const TOKEN = 'e'.repeat(64);

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
  }
}

const sleep = (ms) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

function pngBytes(seed) {
  return encodePng(40, 60, (x, y, put) => {
    put((seed * 37 + x) % 256, (seed * 17 + y) % 256, (seed * 7) % 256);
  });
}

/** 带硬超时的请求：超时返回 `{ status: 'TIMEOUT', ms }`，**不抛**。 */
function request(port, method, pathname, { headers = {}, body = null, token } = {}) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const h = { ...headers };
    if (token) h['X-Box-Token'] = token;
    if (body) h['Content-Length'] = body.length;
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), ms: Date.now() - t0 }),
      );
    });
    req.on('error', (e) => done({ status: 'ERR', err: String(e.message), ms: Date.now() - t0 }));
    req.setTimeout(REQ_TIMEOUT_MS, () => {
      req.destroy();
      done({ status: 'TIMEOUT', ms: Date.now() - t0 });
    });
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

function buildMultipart(comicName, count) {
  const boundary = `----miaodrain${crypto.randomUUID()}`;
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, 'utf8'));
  push(`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n`);
  push(JSON.stringify({ comicName, idempotencyKey: crypto.randomUUID() }));
  push('\r\n');
  for (let i = 1; i <= count; i += 1) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="images[]"; filename="${String(i).padStart(3, '0')}.png"\r\nContent-Type: image/png\r\n\r\n`,
    );
    parts.push(pngBytes(i));
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return { body: Buffer.concat(parts), boundary };
}

function spawnProc(entry, env, tag) {
  const child = spawnTarget(entry, env);
  const state = { child, out: '', err: '', ready: null, tag, exitCode: null };
  child.stdout.on('data', (d) => {
    state.out += d.toString();
    const m = /MIAO_(?:ENGINE_)?READY (\{.*\})/.exec(state.out);
    if (m && !state.ready) {
      try {
        state.ready = JSON.parse(m[1]);
      } catch {
        /* 继续等 */
      }
    }
  });
  child.stderr.on('data', (d) => {
    state.err += d.toString();
  });
  child.on('exit', (code) => {
    state.exitCode = code;
  });
  return state;
}

async function waitReady(state, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (!state.ready && Date.now() < until) await sleep(50);
  if (!state.ready) throw new Error(`${state.tag} 未就绪。stdout=${state.out}\nstderr=${state.err}`);
  return state.ready;
}

function killProc(state) {
  // 🔴 杀进程树（不是只杀主进程）：rust 服务派生的引擎②/③ 否则全成孤儿（D-202）
  if (state && state.child && state.child.exitCode === null) killTree(state.child);
}

async function submit(port, comicName, count) {
  const mp = buildMultipart(comicName, count);
  const res = await request(port, 'POST', '/api/v1/tasks', {
    token: TOKEN,
    headers: { 'Content-Type': `multipart/form-data; boundary=${mp.boundary}` },
    body: mp.body,
  });
  const body = json(res);
  if (res.status !== 201 || !body?.taskId)
    throw new Error(`建单失败 status=${res.status} ms=${res.ms} body=${JSON.stringify(body)}`);
  return body.taskId;
}

/** 等终态；超时/被挡返回 null（**不抛** —— 被挡正是本钉子的观察对象）。 */
async function waitTerminal(port, taskId, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(port, 'GET', `/api/v1/tasks/${taskId}`, { token: TOKEN });
    const t = json(res);
    if (['done', 'partial_failed', 'failed', 'canceled'].includes(t?.status)) return t;
    if (Date.now() > until) return null;
    await sleep(60);
  }
}

/** 读压：独立连接持续轮询 `/queue`，记录错误与最长延迟。 */
function startPollers(port) {
  const state = { stop: false, errors: 0, maxMs: 0, n: 0 };
  const workers = Array.from({ length: POLLERS }, async () => {
    while (!state.stop) {
      const res = await request(port, 'GET', '/api/v1/queue', { token: TOKEN });
      state.n += 1;
      state.maxMs = Math.max(state.maxMs, res.ms || 0);
      if (res.status !== 200) state.errors += 1;
      await sleep(20);
    }
  });
  return { state, workers };
}

async function main() {
  check('D150.precondition — 靶子是 rust（本钉子只对 Rust 驱动线程有意义）', IMPL === 'rust', IMPL);
  if (IMPL !== 'rust') return;

  const engine = spawnProc(ENGINE_ENTRY, { MIAO_ENGINE_ITEM_MS: String(ITEM_MS) }, 'engine');
  let service = null;
  let pollers = null;
  try {
    const eng = await waitReady(engine);
    service = spawnProc(
      SERVICE_ENTRY,
      {
        MIAO_MANGA_ROOT_DIR: path.join(TMP, 'root'),
        MIAO_MANGA_STATE_DIR: path.join(TMP, 'state'),
        MIAO_TOKEN: TOKEN,
        MIAO_ENGINE_PORT: String(eng.port),
        // 🔴 反证钩子：把整段 drain 压回一把锁（D-150 的旧形态）。
        ...(REFUTE ? { MIAO_DRAIN_HOLD_LOCK: '1' } : {}),
      },
      REFUTE ? 'service-refute' : 'service',
    );
    const svc = await waitReady(service);
    check('D150.ready — 服务就绪（模拟引擎 + mangasvc）', !!svc.port, svc);
    const port = svc.port;

    pollers = startPollers(port);
    await sleep(50);

    // ---- 主任务：4 张慢图 ⇒ 约 2s 的运行期窗口 ----
    const taskA = await submit(port, 'D150 甲', IMAGES);
    await sleep(200); // 让它进到「第 1 张 translating」

    // 两条读**并发**发出：否则第一条被锁挡到任务跑完后，第二条自然「不挡」——
    // 那就测不出「持锁时两路读都不可用」，反证会变成看时序（假红/假绿都可能）。
    const [readA, readQ] = await Promise.all([
      request(port, 'GET', `/api/v1/tasks/${taskA}`, { token: TOKEN }),
      request(port, 'GET', '/api/v1/queue', { token: TOKEN }),
    ]);
    const taskAJson = json(readA);
    const itemsA = (taskAJson?.items || []).map((i) => i.status);
    const queueJson = json(readQ);

    // 「运行期可读」的判据（正向必须成立、反证必须**不**成立 —— 一条断言的严格取反）。
    const intermediateReadable =
      readA.status === 200 &&
      readA.ms < READ_DEADLINE_MS &&
      taskAJson?.status === 'running' &&
      itemsA.includes('translating');
    const queueReadable = readQ.status === 200 && readQ.ms < READ_DEADLINE_MS && queueJson?.running?.taskId === taskA;

    // ---- 排队可见性：运行期再提交一个 ----
    const taskB = await submit(port, 'D150 乙', IMAGES);
    const readQ2 = await request(port, 'GET', '/api/v1/queue', { token: TOKEN });
    const queueJson2 = json(readQ2);

    if (REFUTE) {
      check(
        `D150.refuteIntermediateHidden — 持锁 ⇒ 运行期 GET /tasks **读不到** running+translating（实测 ${readA.ms}ms）`,
        !intermediateReadable,
        { ms: readA.ms, status: readA.status, taskStatus: taskAJson?.status, items: itemsA },
      );
      check(
        `D150.refuteQueueUnreadable — 持锁 ⇒ 运行期 GET /queue **读不到** running=A（实测 ${readQ.ms}ms）`,
        !queueReadable,
        { ms: readQ.ms, status: readQ.status, running: queueJson?.running?.taskId ?? null },
      );
      check('D150.refuteAlive — 服务进程仍存活（是「被挡住」不是崩溃）', service.exitCode === null, {
        exitCode: service.exitCode,
      });
    } else {
      check(
        `D150.intermediateVisible — 运行期 GET /tasks 及时返回且如实给出中间态（${readA.ms}ms）`,
        intermediateReadable,
        { ms: readA.ms, taskStatus: taskAJson?.status, items: itemsA },
      );
      check(`D150.queueReadable — 运行期 GET /queue 及时返回且 running 就是它（${readQ.ms}ms）`, queueReadable, {
        ms: readQ.ms,
        running: queueJson?.running?.taskId ?? null,
        want: taskA,
      });
      check(
        `D150.queuePositionVisible — 运行期提交的第二个任务在 /queue 里可见且位次为 1（${readQ2.ms}ms）`,
        readQ2.status === 200 &&
          readQ2.ms < READ_DEADLINE_MS &&
          queueJson2?.queued?.[0]?.taskId === taskB &&
          queueJson2?.queued?.[0]?.position === 1,
        { ms: readQ2.ms, queued: queueJson2?.queued ?? [] },
      );
    }

    // ---- 队列必须在读压之下依旧跑到底 ----
    const finA = await waitTerminal(port, taskA, 25_000);
    const finB = await waitTerminal(port, taskB, 25_000);
    pollers.state.stop = true;
    await Promise.all(pollers.workers);
    const { errors, maxMs, n } = pollers.state;
    pollers = null;

    if (REFUTE) {
      // 反证轮不要求「跑到底」（持锁 + 读压下可能硬卡死）—— 只如实报出来，便于归因。
      console.log(
        `  ℹ 反证轮：终态 A=${finA ? finA.status : '未拿到'} B=${finB ? finB.status : '未拿到'}；读压 ${n} 次，错误 ${errors} 次，最慢 ${maxMs}ms`,
      );
    } else {
      check(
        'D150.drainsUnderLoad — 读压之下队列仍跑到底（两个任务都 done）',
        finA?.status === 'done' && finB?.status === 'done',
        { a: finA?.status ?? null, b: finB?.status ?? null },
      );
      check(`D150.readPressureClean — 读压请求零错误（${n} 次，最慢 ${maxMs}ms）`, errors === 0, { errors, maxMs, n });
    }
  } finally {
    if (pollers) {
      pollers.state.stop = true;
      await Promise.all(pollers.workers);
    }
    killProc(service);
    killProc(engine);
    await sleep(200);
  }
}

await main();

if (REFUTE) {
  console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed, refute: true }));
  console.log(
    `\nD-150 队列可见性（反证轮）：${passed} / ${passed + failed}${failed ? `；未按预期：${failures.join('、')}` : ' —— 持锁确实挡中间态'}`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(
  `\nD-150 队列可见性：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`,
);
process.exit(failed === 0 ? 0 : 1);
