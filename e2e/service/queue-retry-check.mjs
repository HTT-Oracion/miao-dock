#!/usr/bin/env node
/**
 * 队列行「重试」的**任务身份**取证：重跑**同一个任务**、不在历史里冒新行 —— 且必须可反证
 * =====================================================================================
 * ## 为什么单独一个脚本
 *
 * 用户 2026-10-07 报的原话是「翻译队列点击重试后，直接把状态变成翻译中就行，**不要新出来
 * 一个历史任务**」。旧实现里队列行的「重试」走的是 `POST /library/{name}/resume` ——
 * 那是**漫画库 X-D1「继续翻译」**的端点：按**目录**找「有原图、缺译文」的页，**新建一个
 * taskId**。于是队列页上的表现是「点了重试，历史里又多出一条任务行」，而不是「这一行变回
 * 翻译中」。
 *
 * 这条断言**在其他任何门里都不成立**，因为它们只看"重试之后失败页有没有被重新翻"——
 * 新建任务同样满足。能抓住这个缺陷的只有**任务身份**：taskId 变没变、任务总数涨没涨。
 *
 * `e2e/e2e.mjs` 的 D3g/D3h 测的是 `resume` 本身（漫画库「继续翻译」），**不是**这条 ——
 * 所以两件事必须分开写，别互相当成对方的覆盖（那是本项目的假绿家族第 4 类）。
 *
 * ## 判据（本脚本的可反证形式）
 *   1. `POST /tasks/{id}/retry` 返回的 taskId **就是**请求的那个（没新建任务）；
 *   2. 被点的那一行**回到活动态**（running/queued）= 用户要的「直接变成翻译中」；
 *   3. `GET /tasks` 的**总数不变**（历史里不冒新行）；
 *   4. 同一个 taskId 真的**重跑过了**（终态时间戳前移），且页集合不变（同一件事再来一遍）；
 *   5. 前端 App.tsx 的「重试」打的是这条路由，**不再**打 `/library/{name}/resume`。
 *
 * ## 反证轮（`--refute`）
 *   破坏源文件 → 对应断言**必须变红** → 按字节还原。四条变异：
 *     M1 服务端把 `/retry` 退回 `createResumeTask`（= 旧行为）⇒ R2/R3/R4/R5 应变红；
 *     M2 前端把 `/retry` 退回 `/resume` ⇒ R6 应变红；
 *     M3 服务端不再校验方向白名单（`zh>ja` 被放行）⇒ R7 应变红；
 *     M4 `store._processItem` 把方向写死 ja/zh ⇒ R9 应变红。
 *   服务是**子进程**（不是 in-process import），所以磁盘上的破坏会被新起的进程读到 ——
 *   不需要 engine-client-check 那套"子进程重新 import"来绕 ESM 缓存。
 *
 * 用法：
 *   node e2e/service/queue-retry-check.mjs          正向跑（期望全绿）
 *   node e2e/service/queue-retry-check.mjs --refute 反证轮（破坏 → 变红 → 还原）
 *
 * 约束：纯 Node、零依赖；起**模拟引擎**（快速、可控、可注入失败）；临时目录落 os.tmpdir；
 * 反证轮结束**必须**按字节还原。见 ~/.workbuddy/skills/falsifiable-verification。
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { encodePng } from '../../engine/src/png.mjs';
// F0：服务入口解析的唯一事实源（MIAO_SERVICE_IMPL=node|rust 切换靶子）
import { killTree, SERVICE_ENTRY, spawnTarget } from './_service-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENGINE_ENTRY = path.join(ROOT, 'engine', 'src', 'server.mjs');
const APP_SRC = path.join(ROOT, 'app', 'src', 'App.tsx'); // 前端源码**不属** service/，保留
const CARGO_DIR = path.join(ROOT, 'app', 'src-tauri');
/** 反证轮要破坏的 Rust 源码（三处，作用各不相同，别合并）。 */
const RUST_HANDLERS_SRC = path.join(CARGO_DIR, 'src', 'boxsvc', 'handlers.rs');
const RUST_EXEC_SRC = path.join(CARGO_DIR, 'src', 'boxsvc', 'store', 'exec.rs');

/**
 * 编译 Rust 靶子（反证轮改完源码必须重编，否则断言验的是"上一份产物"）。
 * 🔴 编译失败**不算通过**：它记 skipped —— 锚点选错行与"覆盖不足"在报告里长得一样，
 *    必须分开记，否则"反证没跑成"会被读成"反证通过"。
 */
function buildRust() {
  const r = spawnSync('cargo', ['build', '--bin', 'boxsvc'], {
    cwd: CARGO_DIR, encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, log: log.split('\n').slice(-6).join(' | ').slice(0, 400) };
}

const REFUTE = process.argv.includes('--refute');
/// 声明 `mock`：起的是模拟引擎（ver1.0 自定义协议），**不是**真实引擎协议。
/// 不声明的话服务侧默认 `real`，会拿真协议去打替身 —— 「以为在测 real、其实 mock」的镜像版本。
const ENGINE_PROTOCOL = 'mock';
const ENGINE_PORT = 5025;
/// 注入 seq=2 失败：这是"有失败页可重试"的**前置条件**，也是重跑后仍失败的确定性来源。
const FAIL_SEQ = 2;
const TOTAL_IMAGES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (id, label, ok, detail) => {
  results.push({ id, label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
};

// ------------------------------------------------------------------ 子进程

function spawnProc(entry, env, tag) {
  // entry 是服务 ⇒ 按 MIAO_SERVICE_IMPL 选靶子；是模拟引擎 ⇒ 原样走 node
  const child = spawnTarget(entry, env);
  const state = { child, tag, out: '' };
  child.stdout.on('data', (b) => (state.out += b.toString('utf8')));
  child.stderr.on('data', (b) => (state.out += b.toString('utf8')));
  return state;
}

async function waitReady(state, re, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const m = re.exec(state.out);
    if (m) return JSON.parse(m[1]);
    await sleep(120);
  }
  throw new Error(`${state.tag} 未在 ${timeoutMs}ms 内就绪：\n${state.out.slice(-800)}`);
}

function killProc(state) {
  if (!state || !state.child || state.child.exitCode !== null) return Promise.resolve();
  const child = state.child;
  // 🔴 杀进程树（不是只杀主进程）：rust 服务派生的引擎②/③ 否则全成孤儿（D-202）
  killTree(child);
  // ⚠️ **必须等它真的退出**再往下走。Windows 上「刚被 kill 的子进程」会**短暂**继续占着
  //    它加载过的文件句柄 —— 于是紧随其后的 `writeFileSync(service/src/server.mjs)`
  //    会抛 `EPERM: operation not permitted`（本脚本第一次跑反证轮就撞上了）。
  //    等退出是根治，`writeRetry` 的重试是兜底，两者都要。
  return new Promise((resolve) => {
    const until = Date.now() + 3000;
    const tick = () => {
      if (child.exitCode !== null || Date.now() > until) {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * 带重试的写文件（同步语义、异步等待）。
 *
 * 上界**必须有**：否则"文件被占"会被重试循环拖成静默挂死 —— 那正是本仓库反复踩过的
 * 「静默没有上界」那一类缺陷（见 stall-guard-check 的文件头）。次数用完就把原错误抛出去。
 */
async function writeRetry(file, data, tries = 40) {
  for (let i = 1; ; i++) {
    try {
      fs.writeFileSync(file, data);
      return;
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(100);
    }
  }
}

// ------------------------------------------------------------------ HTTP

function request(port, method, urlPath, { token, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: { ...(token ? { 'X-Box-Token': token } : {}), ...headers },
        agent: false, // 不复用连接：避免"复用了已关闭的空闲 socket"这类与契约无关的噪声
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
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

function buildMultipart(payload, images) {
  const boundary = `----miaoretry${Math.random().toString(16).slice(2)}`;
  const parts = [];
  if (payload) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(payload)}\r\n`,
        'utf8',
      ),
    );
  }
  for (const img of images) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="${img.filename}"\r\n` +
          `Content-Type: ${img.contentType}\r\n\r\n`,
        'utf8',
      ),
    );
    parts.push(img.data);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

const makeImages = (n) =>
  Array.from({ length: n }, (_, i) => ({
    filename: `${String(i + 1).padStart(3, '0')}.png`,
    contentType: 'image/png',
    data: encodePng(40, 60, (x, y, put) => put((x * 6 + i * 13) % 256, (y * 4 + i * 7) % 256, 128)),
  }));

async function submit(port, token, comicName, images, lang) {
  const payload = { comicName, idempotencyKey: crypto.randomUUID() };
  if (lang) payload.lang = lang;
  const mp = buildMultipart(payload, images);
  const res = await request(port, 'POST', '/api/v1/tasks', {
    token,
    headers: { 'Content-Type': mp.contentType },
    body: mp.body,
  });
  return { status: res.status, json: json(res) };
}

/** 读落盘的任务记录（`state/tasks/<taskId>.json`）—— 方向的**持久化**事实 */
function readTaskState(stateDir, taskId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, 'tasks', `${taskId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/** 问引擎「最近一次请求的方向」（替身把 `X-Miao-From/To` 记在 `/ready` 的 `lang` 上） */
async function engineSeenLang(port) {
  try {
    const res = await request(port, 'GET', '/ready', {});
    const body = json(res);
    return body && body.lang ? body.lang : null;
  } catch {
    return null;
  }
}

const detail = async (port, token, taskId) =>
  json(await request(port, 'GET', `/api/v1/tasks/${taskId}`, { token }));

const TERMINAL = ['done', 'partial_failed', 'failed', 'canceled'];

async function waitTask(port, token, taskId, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const t = await detail(port, token, taskId);
    if (t && TERMINAL.includes(t.status)) return t;
    if (Date.now() > until) throw new Error(`${taskId} 未在 ${timeoutMs}ms 内到终态（当前 ${t && t.status}）`);
    await sleep(120);
  }
}

// ------------------------------------------------------------------ 正向断言

/** 每一次调用都起**全新的**引擎+服务（反证轮要在源文件被破坏后重跑，进程必须是新的） */
async function runAll() {
  results.length = 0;
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-retry-'));
  const ROOT_DIR = path.join(TMP, '漫画');
  const STATE_DIR = path.join(TMP, 'state');
  fs.mkdirSync(ROOT_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });

  let engine = null;
  let service = null;
  try {
    engine = spawnProc(
      ENGINE_ENTRY,
      { MIAO_ENGINE_PORT: String(ENGINE_PORT), MIAO_ENGINE_FAIL_SEQ: String(FAIL_SEQ) },
      'engine',
    );
    const engineInfo = await waitReady(engine, /MIAO_ENGINE_READY (\{[^\n]*\})/);

    service = spawnProc(
      SERVICE_ENTRY,
      {
        MIAO_ENGINE_PORT: String(engineInfo.port),
        MIAO_ENGINE_PROTOCOL: ENGINE_PROTOCOL,
        MIAO_ROOT: ROOT_DIR,
        MIAO_STATE_DIR: STATE_DIR,
      },
      'service',
    );
    const svcInfo = await waitReady(service, /MIAO_READY (\{[^\n]*\})/);
    const PORT = svcInfo.port;
    const TOKEN = svcInfo.token;

    // ---- R1 前置：交 3 张，注入 seq=2 失败 ⇒ partial_failed ----
    const submitted = await submit(PORT, TOKEN, '重试身份', makeImages(TOTAL_IMAGES));
    const taskId = submitted.json?.taskId;
    const first = taskId ? await waitTask(PORT, TOKEN, taskId) : null;
    const firstState = taskId ? readTaskState(STATE_DIR, taskId) : null;
    const failedSeqs = (first?.items ?? []).filter((i) => i.status === 'failed').map((i) => i.seq);
    check(
      'R1',
      `前置：交 ${TOTAL_IMAGES} 张、注入 seq=${FAIL_SEQ} 失败 ⇒ 终态 partial_failed，恰好一页失败`,
      first?.status === 'partial_failed' && JSON.stringify(failedSeqs) === JSON.stringify([FAIL_SEQ]),
      `status=${first?.status} failed=[${failedSeqs.join(',')}]`,
    );
    if (!taskId || first?.status !== 'partial_failed') return; // 前置没成立，后面的断言没有意义

    const listBefore = json(await request(PORT, 'GET', '/api/v1/tasks', { token: TOKEN }));

    // ---- R2/R3：重试打的是**同一个任务**，且它回到活动态 ----
    const rt = await request(PORT, 'POST', `/api/v1/tasks/${taskId}/retry`, { token: TOKEN });
    const rtJson = json(rt);
    check(
      'R2',
      '重试返回 **200 且 taskId 与请求的完全相同**（复用这一个任务，不是新建）',
      rt.status === 200 && rtJson?.taskId === taskId,
      `HTTP ${rt.status} taskId=${rtJson?.taskId}（请求 ${taskId}）`,
    );
    const sameRow = await detail(PORT, TOKEN, taskId);
    check(
      'R3',
      '被点的那一行**回到活动态**（running/queued）—— 用户要的「直接变成翻译中」',
      ['running', 'queued'].includes(sameRow?.status),
      `status=${sameRow?.status}`,
    );

    // ---- R4：历史里不冒新行 ----
    const listAfter = json(await request(PORT, 'GET', '/api/v1/tasks', { token: TOKEN }));
    check(
      'R4',
      '重试之后 `GET /tasks` 的**总数不变**（历史里不冒出一条新任务行）',
      listBefore?.total === listAfter?.total && listAfter?.total > 0,
      `before=${listBefore?.total} after=${listAfter?.total}`,
    );

    // ---- R5：同一个 taskId 真的重跑过了，且页集合不变 ----
    const second = await waitTask(PORT, TOKEN, taskId);
    const failedSeqs2 = (second?.items ?? []).filter((i) => i.status === 'failed').map((i) => i.seq);
    const reRan =
      Date.parse(second?.finishedAt || '') > Date.parse(first?.finishedAt || '');
    check(
      'R5',
      '同一条任务**又跑了一遍**（终态时间戳前移）且页集合不变 ⇒ 是"同一件事再来一次"，不是新任务',
      second?.taskId === taskId &&
        reRan &&
        second?.progress?.total === TOTAL_IMAGES &&
        JSON.stringify(failedSeqs2) === JSON.stringify([FAIL_SEQ]),
      `taskId=${second?.taskId} finishedAt ${first?.finishedAt} → ${second?.finishedAt} total=${second?.progress?.total} failed=[${failedSeqs2.join(',')}]`,
    );

    // ---- R7~R10：翻译方向（ver2.1）—— 白名单 / 落库 / 端到端到引擎 / 重试继承 ----
    const badLang = await submit(PORT, TOKEN, '方向白名单', makeImages(1), { from: 'zh', to: 'ja' });
    check(
      'R7',
      '非法方向（`zh>ja`：两个码各自合法、但**不在支持表里**）→ **400 INVALID_TRANSLATE_LANG**。静默回落成日译中会让英文漫画以日语送进引擎 ⇒ 整页原文照抄',
      badLang.status === 400 && badLang.json?.error?.code === 'INVALID_TRANSLATE_LANG',
      `HTTP ${badLang.status} code=${badLang.json?.error?.code}`,
    );

    const enTask = await submit(PORT, TOKEN, '方向贯通', makeImages(2), { from: 'en', to: 'zh' });
    const enId = enTask.json?.taskId;
    const enDone = enId ? await waitTask(PORT, TOKEN, enId) : null;
    const enPersisted = enId ? readTaskState(STATE_DIR, enId) : null;
    check(
      'R8',
      '`lang:{en,zh}` 的任务**方向落库**（`state/tasks/*.json` 的 `lang` 是 en>zh，不是默认的 ja>zh）',
      enPersisted?.lang?.from === 'en' && enPersisted?.lang?.to === 'zh',
      JSON.stringify(enPersisted?.lang),
    );
    const seen = await engineSeenLang(engineInfo.port);
    check(
      'R9',
      '方向**真的送到了引擎**（替身把最近一次请求的 `X-Miao-From/To` 报在 `/ready` 的 `lang` 上）—— 这是 `store._processItem` 那一段链路的唯一观测点',
      seen?.from === 'en' && seen?.to === 'zh',
      `引擎看到 ${JSON.stringify(seen)}（任务终态 ${enDone?.status}）`,
    );

    const afterRetry = readTaskState(STATE_DIR, taskId);
    check(
      'R10',
      '重试**不改方向**（复用同一 task ⇒ 继承原方向；重试后落库的 `lang` 与首次一致）',
      afterRetry?.lang?.from === 'ja' && afterRetry?.lang?.to === 'zh'
        && JSON.stringify(afterRetry.lang) === JSON.stringify(firstState?.lang),
      `首次 ${JSON.stringify(firstState?.lang)} → 重试后 ${JSON.stringify(afterRetry?.lang)}`,
    );

    // ---- R6：前端接线（源码断言）----
    const appSrc = fs.readFileSync(APP_SRC, 'utf8');
    const from = appSrc.indexOf('const retry =');
    const to = appSrc.indexOf('const openTaskDir', from);
    const seg = from >= 0 && to > from ? appSrc.slice(from, to) : '';
    check(
      'R6',
      '前端「重试」打的是 `POST /tasks/{id}/retry`，**不再**打 `/library/{name}/resume`',
      seg.includes('/retry') && seg.includes('t.taskId') && !seg.includes('/resume'),
      seg ? `retry 段 ${seg.length} 字：/retry=${seg.includes('/retry')} t.taskId=${seg.includes('t.taskId')} /resume=${seg.includes('/resume')}` : '未定位到 App.tsx 的 retry 段',
    );
  } finally {
    await killProc(service);
    await killProc(engine);
    await sleep(150);
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 清不掉不影响判定 */
    }
  }
}

// ------------------------------------------------------------------ 输出

function printResults(title) {
  console.log(`\n【${title}】`);
  let fail = 0;
  for (const r of results) {
    if (!r.ok) fail++;
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.id} ${r.label}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log('\n' + '─'.repeat(56));
  console.log(`通过 ${results.length - fail} / 失败 ${fail}`);
  return { fail, pass: results.length - fail };
}

// ------------------------------------------------------------------ 反证

/// 每条变异：破坏哪个文件、把什么换成什么、**哪几条断言必须因此变红**。
const MUTATIONS = [
  {
    name: 'M1 服务端重试时不再复用原 taskId（= 旧行为：新建任务）',
    // ⚠️ 多行锚点按 **CRLF** 拼：Rust 源是 CRLF，用 `\n` 拼的 `includes()` 永远为假 ——
    //    那会被记成「本条无法反证」，看起来像覆盖不足，其实只是行尾。
    edits: [
      {
        file: RUST_EXEC_SRC,
        find: '        Ok(RetryOutcome { task_id: task_id.to_string(), reused })',
        replace: '        Ok(RetryOutcome { task_id: format!("{task_id}-refute"), reused }) // refute：重试不再复用原 taskId',
      },
    ],
    expect: ['R2', 'R3', 'R4', 'R5'],
  },
  {
    name: 'M2 前端「重试」退回 /library/{name}/resume',
    edits: [
      {
        file: APP_SRC,
        find: '      await apiPost(`/tasks/${encodeURIComponent(t.taskId)}/retry`, {});',
        replace: '      await apiPost(`/library/${encodeURIComponent(t.comicName)}/resume`, {}); // refute',
      },
    ],
    expect: ['R6'],
  },
  {
    name: 'M3 服务端不再校验方向白名单（非法方向被当成默认方向放行 ⇒ 英文漫画以日语送引擎）',
    edits: [
      {
        file: RUST_HANDLERS_SRC,
        // ⚠️ 多行锚点按 CRLF 拼（Rust 源是 CRLF，用 `\n` 拼的 `includes()` 永远为假）。
        find: 'fn is_supported_direction(d: &Lang) -> bool {\r\n    TRANSLATE_DIRECTIONS.iter().any(|(f, t)| *f == d.from && *t == d.to)\r\n}',
        replace: 'fn is_supported_direction(d: &Lang) -> bool {\r\n    let _ = d;\r\n    true // refute：白名单恒通过\r\n}',
      },
    ],
    expect: ['R7'],
  },
  {
    name: 'M4 `store._processItem` 把方向写死成 ja/zh（任务方向没传下去 ⇒ 替身看到的方向永远是日语）',
    edits: [
      {
        file: RUST_EXEC_SRC,
        // ⚠️ 多行锚点按 CRLF 拼；缩进照抄源码（12 空格，写错就变成"锚点未找到"）。
        find: '            lang_from: task.lang.from.clone(),\r\n            lang_to: task.lang.to.clone(),',
        replace: '            lang_from: "ja".to_string(), // refute：方向写死\r\n            lang_to: "zh".to_string(),',
      },
    ],
    expect: ['R9'],
  },
];

const readBytes = (f) => {
  try {
    return fs.readFileSync(f);
  } catch {
    return null;
  }
};

const main = async () => {
  console.log(`队列「重试」任务身份取证${REFUTE ? ' · 反证轮' : ''}`);

  if (!REFUTE) {
    await runAll();
    const { fail } = printResults('队列重试 · 任务身份');
    process.exitCode = fail === 0 ? 0 : 1;
    return;
  }

  // 🔴 进反证轮前先确保「产物 == 磁盘源码」：否则基线跑的是上一份编译结果，
  //    而「变异全红」里有一部分红是被这份陈旧产物误打误撞造成的。
  const pre = buildRust();
  if (!pre.ok) {
    console.log(`✗ 开跑前 cargo build 失败，无法反证：${pre.log}`);
    process.exitCode = 1;
    return;
  }

  await runAll();
  const wasGreen = {};
  for (const r of results) wasGreen[r.id] = r.ok;

  const expectedTotal = MUTATIONS.reduce((n, m) => n + m.expect.length, 0);
  let total = 0;
  let red = 0;
  let skipped = 0;
  const falsePositives = [];
  const originals = new Map();

  console.log('\n破坏源文件 → 断言必须变红 → 按字节还原\n');
  for (const mut of MUTATIONS) {
    let anchorMissing = false;
    for (const [i, e] of mut.edits.entries()) {
      if (!originals.has(e.file)) originals.set(e.file, readBytes(e.file));
      const txt = originals.get(e.file).toString('utf8');
      // 🔴 多行锚点**必须按目标文件的实际 EOL 归一化**：工作区有 CRLF 文件（如 Rust 源），
      //    锚点里写死 `\n` 会在 `includes` 那一步就失败 ⇒ 被当成"锚点未找到"**静默跳过**，
      //    表现为「应执行 7 条、实际只反证了 6 条」这种分母虚高（真红过的坑）。
      const eol = txt.includes('\r\n') ? '\r\n' : '\n';
      const find = e.find.replace(/\r?\n/g, eol);
      const replace = e.replace.replace(/\r?\n/g, eol);
      if (!txt.includes(find)) {
        console.log(`⚠ ${mut.name}\n    破坏锚点未找到（第 ${i + 1} 处，${path.relative(ROOT, e.file)}）—— 本条无法反证`);
        anchorMissing = true;
        break;
      }
      await writeRetry(e.file, txt.replace(find, replace));
    }
    // 🔴 锚点缺失时**整条跳过**，不能只跳那一个 edit：继续往下跑 `runAll()`，测的还是
    //    未被破坏的产物 ⇒ 那条 expect 必然"该红没红"，被记成**假阳性** ——
    //    而真相是"这条根本没反证"。两种故障长得几乎一样，只有这条 flag 能分开它们。
    if (anchorMissing) { skipped += mut.expect.length; continue; }
    // 🔴 改完 Rust 源码**必须重编**才作数：不编就等于拿旧产物跑断言，红的绿的都说明不了问题。
    const built = buildRust();
    if (!built.ok) {
      console.log(`⚠ ${mut.name}\n    破坏后编译失败（多半是锚点选错行），本条无法反证：${built.log}`);
      // 🔴 这里**必须先还原再 continue**：下面的还原写在 `finally` 里，`continue` 会跳过它 ——
      //    源码会被永久留在被破坏状态（e4-tier 上踩过同族坑）。
      for (const [f, snap] of originals) await writeRetry(f, snap);
      skipped += mut.expect.length;
      continue;
    }
    // 🔴 还原一律进 `finally`：破坏若让 `runAll()` 抛异常，写在 try 之后的还原就不会执行，
    //    源文件会永久留成被破坏状态（E4 / E8 上都踩到过这一条）。
    let res = {};
    let roundErr = null;
    try {
      await runAll();
      for (const r of results) res[r.id] = r;
    } catch (err) {
      roundErr = err;
    } finally {
      for (const [f, snap] of originals) await writeRetry(f, snap);
    }
    console.log(`🔴 ${mut.name}`);
    if (roundErr) console.log(`   ⚠ 本轮 runAll 抛异常（源文件已被破坏）：${String(roundErr.message).split('\n')[0]}`);
    for (const id of mut.expect) {
      total++;
      const isRed = (res[id] && res[id].ok === false) || (!res[id] && roundErr !== null);
      if (isRed) {
        red++;
        console.log(`  ✓ ${id} 按预期变红`);
      } else {
        falsePositives.push(id);
        console.log(`  ✗ ${id} 该红没红 ← 假阳性`);
      }
      if (!wasGreen[id]) console.log('     注：该条基线本就是红，无法据此判定断言有效性');
    }
  }

  console.log('\n恢复校验');
  let restoreFail = 0;
  for (const [f, snap] of originals) {
    const back = readBytes(f);
    const same = back != null && back.equals(snap);
    if (!same) restoreFail++;
    console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, f)} 字节${same ? '一致' : '不一致！'}`);
  }
  // 源码还原了，**产物也必须还原** —— 否则留下一个「源码是好的、跑起来是坏的」的机器。
  const rebuilt = buildRust();
  if (!rebuilt.ok) { restoreFail++; console.log(`  ✗ cargo build 还原失败：${rebuilt.log}`); }
  else console.log('  ✓ cargo build 已把靶子重编回未破坏状态');

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红（应执行 ${expectedTotal} 条）`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（破坏锚点未找到）—— 跳过 ≠ 通过`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(', ')}`);
  process.exitCode = red === expectedTotal && skipped === 0 && restoreFail === 0 ? 0 : 1;
};

main().catch((err) => {
  console.error(`\n脚本异常：${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
