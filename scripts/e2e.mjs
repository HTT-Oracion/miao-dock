#!/usr/bin/env node
/**
 * M5 端到端验收（D1–D5）—— 真实进程 + 真实落盘。
 *
 * 为什么不起 Tauri 壳：D1–D4 考的是**服务契约在真实组合场景下的行为**（跨批次的同一个 Task、
 * 同一条串行队列、成对落盘、时效与 SSE 一致），与外壳无关；外壳那一层（关窗仅隐藏、
 * 托盘常驻、退出清理）已经由 `scripts/lifespan-selftest.mjs` 用 B1–B4 覆盖。
 * 这里起的是**真实的 `engine` 与 `service` 进程**（不是自测里的 in-process 替身），
 * 落盘也是真的写进磁盘。
 *
 * 与 A 组契约自测的分工：
 *   A 组  = 逐条契约条款（端点形状、错误码、边界）—— 快、密、逐项对号
 *   D 组  = 端到端组合场景（31 张跨 2 批、与插件同请求形状、队列排布、真实落盘、时效）
 *
 * 用法：node scripts/e2e.mjs
 *
 * 落盘素材**故意留在原处**，因为紧接着的 `scripts/capture.mjs` 要拿它当截图取证的素材；
 * 清理放在**下一次运行的开头**。临时根目录默认 `.tmp-e2e/`，可用 `MIAO_E2E_TMP` 指到别处
 * （例如系统临时目录：`MIAO_E2E_TMP=$(mktemp -d)`），两个脚本共用该变量。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

import { encodePng } from '../engine/src/png.mjs';
import { TMP_ENV, describeE2eTmp, e2eRoot, e2eState, e2eTmp } from './_e2e-paths.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = e2eTmp();
const ROOT_DIR = e2eRoot();
const STATE_DIR = e2eState();
const BATCH_LIMIT = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (id, label, ok, detail) => {
  results.push({ id, label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
};

// ------------------------------------------------------------------ 进程

function spawnProc(entry, env, tag) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, tag, out: '' };
  child.stdout.on('data', (b) => (state.out += b.toString('utf8')));
  child.stderr.on('data', (b) => (state.out += b.toString('utf8')));
  return state;
}

async function waitReady(state, re, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  let m = null;
  while (Date.now() < until) {
    m = re.exec(state.out);
    if (m) return JSON.parse(m[1]);
    await sleep(120);
  }
  throw new Error(`${state.tag} 未在 ${timeoutMs}ms 内就绪：\n${state.out.slice(-800)}`);
}

function killProc(state) {
  if (state && state.child && state.child.exitCode === null) state.child.kill('SIGTERM');
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
        // 关掉 keep-alive 复用：服务端的 keepAliveTimeout 是 65s，但测试里来回很多次，
        // 用独立连接可以避免「复用了已关闭的空闲 socket」这类与契约无关的噪声。
        agent: false,
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
  const boundary = `----miaoe2e${Math.random().toString(16).slice(2)}`;
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

/** 造 n 张互不相同的 PNG（同一目录内），供上传 */
function makeImages(n) {
  return Array.from({ length: n }, (_, i) => ({
    filename: `${String(i + 1).padStart(3, '0')}.png`,
    contentType: 'image/png',
    data: encodePng(40, 60, (x, y, put) => put((x * 6 + i * 13) % 256, (y * 4 + i * 7) % 256, 128)),
  }));
}

async function submit(port, token, comicName, images, extra = {}) {
  const mp = buildMultipart({ comicName, idempotencyKey: crypto.randomUUID(), ...extra.payload }, images);
  const res = await request(port, 'POST', '/api/v1/tasks', {
    token,
    headers: { 'Content-Type': mp.contentType, ...extra.headers },
    body: mp.body,
  });
  return { status: res.status, json: json(res) };
}

async function appendBatch(port, token, taskId, images, extra = {}) {
  const mp = buildMultipart({ idempotencyKey: crypto.randomUUID() }, images);
  const res = await request(port, 'POST', `/api/v1/tasks/${taskId}/batches`, {
    token,
    headers: { 'Content-Type': mp.contentType, ...extra.headers },
    body: mp.body,
  });
  return { status: res.status, json: json(res) };
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
    await sleep(150);
  }
}

/** 订阅 SSE 直到终态，返回收到的事件序列（`{id, event, data}`） */
function collectEvents(port, token, taskId, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const events = [];
    let buf = '';
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: `/api/v1/tasks/${taskId}/events`, headers: { 'X-Box-Token': token }, agent: false },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          const blocks = buf.split('\n\n');
          buf = blocks.pop() ?? '';
          for (const block of blocks) {
            // SSE 帧里 `event:` / `id:` / `data:` 各占一行 —— 事件**类型不在** data 的 JSON 里，
            // 只读 data 行会得到一个没有类型的事件序列。
            const lines = block.split('\n');
            const nameOf = (k) => {
              const l = lines.find((x) => x.startsWith(`${k}:`));
              return l ? l.slice(k.length + 1).trim() : '';
            };
            const dataLine = lines.find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            let data;
            try {
              data = JSON.parse(dataLine.slice(5).trim());
            } catch {
              continue; // 心跳等非 JSON 行忽略
            }
            const idText = nameOf('id');
            events.push({ id: idText ? Number(idText) : null, event: nameOf('event'), data });
            if (nameOf('event') === 'task.status' && TERMINAL.includes(data.status)) {
              clearTimeout(timer);
              req.destroy();
              resolve(events);
            }
          }
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      resolve(events);
    }, timeoutMs);
    req.on('error', () => {
      clearTimeout(timer);
      resolve(events);
    });
    req.end();
  });
}

// ------------------------------------------------------------------ 主流程

// 清掉上一次的产物。这一步**只在下一次运行的开头做**（上一次跑完的东西要留给截图取证），
// 所以这里要删的是一整个「三五本漫画、几百个文件」的目录 —— 用 `MIAO_E2E_TMP` 把它挪到
// 系统临时目录，可以让工作区里不出现这种量级的一次性删除。
console.log(`临时目录：${describeE2eTmp()}${process.env[TMP_ENV] ? `（来自 ${TMP_ENV}）` : ''}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(ROOT_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

let engine = null;
let service = null;
let failed = 0;

try {
  // ---- 起真实进程：先引擎后服务（与壳里的顺序一致）----
  // 刻意注入 seq=3 失败：这样 D3a 的「失败项不得留下译文」才是**真断言** ——
  // 不注入失败时它恒真（一个失败项也没有，测了个空）。
  engine = spawnProc(
    path.join(ROOT, 'engine', 'src', 'server.mjs'),
    { MIAO_ENGINE_PORT: '5015', MIAO_ENGINE_FAIL_SEQ: '3' },
    'engine',
  );
  const engineInfo = await waitReady(engine, /MIAO_ENGINE_READY (\{[^\n]*\})/);
  console.log(`引擎就绪 @${engineInfo.port}（注入失败：seq=3）`);

  service = spawnProc(
    path.join(ROOT, 'service', 'src', 'server.mjs'),
    {
      MIAO_ENGINE_PORT: String(engineInfo.port),
      MIAO_ROOT: ROOT_DIR,
      MIAO_STATE_DIR: STATE_DIR,
    },
    'service',
  );
  const svcInfo = await waitReady(service, /MIAO_READY (\{[^\n]*\})/);
  const PORT = svcInfo.port;
  const TOKEN = svcInfo.token;
  console.log(`服务就绪 @${PORT}，落盘根目录 ${ROOT_DIR}\n`);

  // ================================================================ D1 与插件同契约联调
  {
    const PLUGIN = { 'X-Box-Client': 'extension/2.3.0' }; // 插件端在契约里的客户端标识
    const imgs = makeImages(31);

    // §5.3：分批提交的**唯一**实现路径 —— 第一批建单，后续批次追加到同一个 Task
    const first = await submit(PORT, TOKEN, 'D1 插件联调 31 张', imgs.slice(0, BATCH_LIMIT), { headers: PLUGIN });
    const taskId = first.json?.taskId;
    check('D1a', '第一批 20 张建立任务', first.status === 201 && !!taskId, `HTTP ${first.status} / ${taskId}`);

    const second = await appendBatch(PORT, TOKEN, taskId, imgs.slice(BATCH_LIMIT), { headers: PLUGIN });
    check('D1b', '第二批 11 张追加到**同一个** Task', second.status === 200, `HTTP ${second.status}`);

    const t = await detail(PORT, TOKEN, taskId);
    const batches = t?.batches ?? [];
    check(
      'D1c',
      '31 张 = 一个 Task 两个 Batch',
      batches.length === 2,
      `batches=${batches.length}`,
    );
    check(
      'D1d',
      'seqFrom/seqTo 连续无重号（1–20 / 21–31）',
      batches[0]?.seqFrom === 1 &&
        batches[0]?.seqTo === 20 &&
        batches[1]?.seqFrom === 21 &&
        batches[1]?.seqTo === 31,
      batches.map((b) => `${b.seqFrom}-${b.seqTo}`).join(' / '),
    );

    const q = json(await request(PORT, 'GET', '/api/v1/queue', { token: TOKEN }));
    const slots = [q?.running, ...(q?.queued ?? [])].filter(Boolean).map((x) => x.taskId);
    check(
      'D1e',
      '队列中占**一个**位置（不是两个）',
      slots.filter((id) => id === taskId).length === 1,
      `队列占用：${slots.join(' / ')}`,
    );

    const list = json(await request(PORT, 'GET', '/api/v1/tasks', { token: TOKEN }));
    check(
      'D1f',
      '任务列表里只出现一行（来源归因 extension）',
      (list?.tasks ?? []).filter((x) => x.taskId === taskId).length === 1 &&
        list?.tasks?.find((x) => x.taskId === taskId)?.source === 'extension',
      `source=${list?.tasks?.find((x) => x.taskId === taskId)?.source}`,
    );

    // ============================================================== D2 本机投放同队列
    const DESKTOP = { 'X-Box-Client': 'box-desktop/0.1.0' };

    const over = await submit(PORT, TOKEN, 'D2 超限', makeImages(BATCH_LIMIT + 1), { headers: DESKTOP });
    check(
      'D2a',
      '单次 21 张 → 同一个 BATCH_LIMIT_EXCEEDED',
      over.status === 400 && over.json?.error?.code === 'BATCH_LIMIT_EXCEEDED',
      `HTTP ${over.status} / ${over.json?.error?.code}`,
    );

    const d2imgs = makeImages(21);
    const d2first = await submit(PORT, TOKEN, 'D2 本机投放 21 张', d2imgs.slice(0, BATCH_LIMIT), { headers: DESKTOP });
    const d2id = d2first.json?.taskId;
    await appendBatch(PORT, TOKEN, d2id, d2imgs.slice(BATCH_LIMIT), { headers: DESKTOP });

    const q2 = json(await request(PORT, 'GET', '/api/v1/queue', { token: TOKEN }));
    const queuedIds = (q2?.queued ?? []).map((x) => x.taskId);
    check(
      'D2b',
      '投放的任务进入**同一条**串行队列（排在 D1 之后）',
      d2id === q2?.running?.taskId || queuedIds.includes(d2id),
      `running=${q2?.running?.taskId ?? '—'} queued=[${queuedIds.join(', ')}]`,
    );

    // ============================================================== D3 落盘可见
    const done1 = await waitTask(PORT, TOKEN, taskId);
    const dirName = done1.normalizedComicName;
    const dir = path.join(ROOT_DIR, dirName);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];

    const pad = (n) => String(n).padStart(3, '0');
    const okSeqs = (done1.items ?? []).filter((i) => i.status === 'success').map((i) => i.seq);
    const failSeqs = (done1.items ?? []).filter((i) => i.status === 'failed').map((i) => i.seq);
    // 定义在这里而不是 D5 段：D3d 之后的几条（D3f–D3h）都要用，放在下面会踩 TDZ
    const failSeq = failSeqs[0];

    check(
      'D3a',
      '成功项落盘为成对的 NNN.png + NNN_translated.png；失败项**不得**留下译文',
      okSeqs.length > 0 &&
        okSeqs.every((s) => files.includes(`${pad(s)}.png`) && files.includes(`${pad(s)}_translated.png`)) &&
        failSeqs.every((s) => !files.includes(`${pad(s)}_translated.png`)),
      `成功 ${okSeqs.length} 张全部成对；失败 ${failSeqs.length} 张（seq ${failSeqs.join(',') || '—'}）无译文；目录共 ${files.length} 个文件`,
    );

    // G-11（用户裁定 A，2026-10-03）：失败页的**原图也要落盘**。
    // 「有原图、缺译文」是「待译」（能续做），「连原图都没有」是「缺页」（没得救）——
    // 失败页属于前者，所以库里该显示「待译」而不是「缺页」。
    //
    // 这条与 D5c 原先是**反着**断言的（那时固化的是「失败即把原图丢掉」）。裁定落地后
    // 一起翻了过来 —— 两条互为对方的反证：谁把语义改回去，这两条立刻变红。
    const failedNoOriginal = failSeqs.filter((s) => !files.includes(`${pad(s)}.png`));
    check(
      'D3d',
      '失败项留有原图、但不留译文 —— 故库里判「待译」（可续做）而非「缺页」',
      failSeqs.length > 0 &&
        failedNoOriginal.length === 0 &&
        failSeqs.every((s) => !files.includes(`${pad(s)}_translated.png`)),
      `失败 ${failSeqs.length} 页（${failSeqs.join(',')}），其中缺原图的：${failedNoOriginal.join(',') || '无'}`,
    );

    // 这条就是当初发现 G-11 的那次数数：31 张原图 + 30 张译文 = **61** 个文件。
    // 旧行为下是 60（= 30 对）—— 差的那一个正是失败页自己，它的原图被连带丢掉了。
    // 数字型断言必须把**应当是多少**写出来，否则「60 == 30×2」看着永远自洽。
    check(
      'D3e',
      '目录内应恰有 31 原 + 30 译 = 61 个文件（旧行为下是 60，失败页的原图丢了）',
      files.length === okSeqs.length + okSeqs.length + failSeqs.length,
      `${files.length} 个文件（成功 ${okSeqs.length} / 失败 ${failSeqs.length}）`,
    );

    // 「可续做」不能只是个说法：失败页必须真的出现在该漫画的续做清单里，
    // 否则库里那张卡只是**看着**像「待译」，点「继续翻译」却无事发生。
    const plan = json(await request(PORT, 'GET', `/api/v1/library/${encodeURIComponent(dirName)}/resume`, { token: TOKEN }));
    check(
      'D3f',
      `续做清单列出失败页 [${failSeqs.join(',')}] —— 这是 G-11 裁 A 的实际用途`,
      JSON.stringify((plan?.pendings ?? []).map((p) => p.seq)) === JSON.stringify([...failSeqs].sort((a, b) => a - b)),
      `pendingCount=${plan?.pendingCount} pendings=[${(plan?.pendings ?? []).map((p) => p.seq).join(',')}]`,
    );

    // 队列屏「重试」按钮走的就是这条 POST /resume（App.tsx），不是重新上传。
    // 旧语义下它**点了会报错**：失败页没有原图 → 续做清单为空 → 404「无可续做页」，
    // 而按钮明明长在一条 partial_failed 的任务行上。这条断言把那条用户路径闭上。
    // 带上 X-Box-Client：真实应用是经 Rust 层转发的，那层给每个请求都打这个头
    // （`app/src-tauri/src/commands.rs`），故「来源」列才会显示「本机投放」。
    // 不带的话截图里会是一条「—」，看起来像缺陷，其实只是用例没照抄真实请求形状。
    const rs = await request(PORT, 'POST', `/api/v1/library/${encodeURIComponent(dirName)}/resume`, {
      token: TOKEN,
      headers: { 'Content-Type': 'application/json', 'X-Box-Client': 'box-desktop/0.1.0' },
      body: Buffer.from('{}'),
    });
    const rsJson = json(rs);
    check(
      'D3g',
      `队列屏「重试」在 partial_failed 任务上真的可用：POST /resume 建单 201 并指向失败页 seq=${failSeq}`,
      rs.status === 201 && !!rsJson?.taskId,
      `${rs.status} ${JSON.stringify(rsJson?.error ?? rsJson?.taskId)}`,
    );
    if (rsJson?.taskId) {
      const retry = await waitTask(PORT, TOKEN, rsJson.taskId);
      const retried = (retry.items ?? []).map((i) => i.seq);
      check(
        'D3h',
        `重试的任务只含失败页 [${failSeq}]，且原因是 engine_*（说明原图真读到了，不是 original_missing）`,
        JSON.stringify(retried) === JSON.stringify([failSeq]) &&
          /^engine_/.test((retry.items ?? [])[0]?.reason ?? ''),
        `items=[${retried.join(',')}] reason=${(retry.items ?? [])[0]?.reason}`,
      );
    }

    const lib = json(await request(PORT, 'GET', '/api/v1/library', { token: TOKEN }));
    const comic = (lib?.comics ?? []).find((c) => c.dirName === dirName);
    check(
      'D3b',
      '漫画库能看到它，且译文张数与磁盘一致',
      !!comic && comic.translatedCount === okSeqs.length && comic.imageCount >= okSeqs.length,
      comic
        ? `${comic.comicName} 原图 ${comic.imageCount} / 译文 ${comic.translatedCount} / ${comic.byteSize}B`
        : '未列出',
    );

    // 原/译文件流可按同 seq 取（对照页的数据来源）
    const firstOk = okSeqs[0];
    const orig = await request(PORT, 'GET', `/api/v1/library/${encodeURIComponent(dirName)}/files/${firstOk}?variant=original`, { token: TOKEN });
    const trans = await request(PORT, 'GET', `/api/v1/library/${encodeURIComponent(dirName)}/files/${firstOk}?variant=translated`, { token: TOKEN });
    check(
      'D3c',
      '对照页数据源：同 seq 的原图与译文都能取到真图',
      orig.status === 200 &&
        trans.status === 200 &&
        orig.body.subarray(1, 4).toString() === 'PNG' &&
        trans.body.subarray(1, 4).toString() === 'PNG',
      `seq ${firstOk}：原图 ${orig.status}/${orig.body.length}B，译文 ${trans.status}/${trans.body.length}B`,
    );

    // ============================================================== D5 逐页集合（spec-notes.md G-10）
    // 这组必须用**真实失败注入**来测，而且失败页必须落在**中间**（seq=3）：
    // 「哪一页已译」如果只靠 translatedCount，`seq <= translatedCount` 会把第 3 页
    // 说成已译 —— 代理指标只在「尾部缺页」时碰巧对，在「中间缺页」时必错。
    const sortedOk = [...okSeqs].sort((a, b) => a - b);
    check(
      'D5a',
      'translatedSeqs 逐页精确：等于磁盘上真实的成功序号集合',
      JSON.stringify(comic?.translatedSeqs ?? []) === JSON.stringify(sortedOk),
      `库报 [${(comic?.translatedSeqs ?? []).join(',')}] / 实际成功 ${sortedOk.length} 张 [${sortedOk.join(',')}]`,
    );
    check(
      'D5b',
      `失败页 seq=${failSeq} 在中间却不在已译集合里 —— 「seq <= 张数」的旧代理在此会说谎`,
      !!comic &&
        !comic.translatedSeqs.includes(failSeq) &&
        failSeq <= comic.translatedCount,
      `代理说「已译」（${failSeq} <= ${comic?.translatedCount}），事实是没有译文；两集合差集 = [${failSeq}]`,
    );
    // G-11 裁定 A 之后失败页的原图在磁盘上，故 missingSeqs 应当**为空**；
    // 若它又把失败页报进来，说明扫描或落盘有一侧退回了旧行为（库会显示「缺页」= 像用户没给过这页）。
    check(
      'D5c',
      'missingSeqs 为空 —— 失败页的原图在磁盘上，故库里是「待译」而不是「缺页」',
      Array.isArray(comic?.missingSeqs) && comic.missingSeqs.length === 0,
      JSON.stringify(comic?.missingSeqs),
    );

    await waitTask(PORT, TOKEN, d2id);

    // ============================================================== D4 时效 + SSE 一致
    const d4imgs = makeImages(20);
    const t0 = Date.now();
    const d4 = await submit(PORT, TOKEN, 'D4 时效', d4imgs, { headers: PLUGIN });
    const d4id = d4.json?.taskId;
    const events = await collectEvents(PORT, TOKEN, d4id);
    const done4 = await waitTask(PORT, TOKEN, d4id);
    const elapsed = (Date.now() - t0) / 1000;

    check('D4a', '20 张在 30 秒内完成', elapsed < 30, `实测 ${elapsed.toFixed(1)}s（终态 ${done4.status}）`);

    // 「进度与 SSE 一致」验的是：SSE 上逐条推来的完成项，与最后查询到的完成项**对得上**。
    // 这条比读一个进度数字更有意义 —— 少推 / 多推 / 重复推都会被它抓住。
    const sseOk = new Set(
      events
        .filter((e) => e.event === 'item.status' && e.data && e.data.status === 'success')
        .map((e) => e.data.seq),
    );
    const finalOk = new Set((done4.items ?? []).filter((i) => i.status === 'success').map((i) => i.seq));
    check(
      'D4b',
      '进度与 SSE 一致：SSE 推来的 success seq 集合 = 最终查询到的 success 集合',
      sseOk.size === finalOk.size && [...finalOk].every((s) => sseOk.has(s)) && finalOk.size === done4.progress.done,
      `SSE ${sseOk.size} 张 / 查询 ${finalOk.size} 张 / progress.done=${done4.progress.done}`,
    );

    const kinds = [...new Set(events.map((e) => e.event))];
    check(
      'D4c',
      'SSE 三类状态事件齐备（契约 §5.5 的第 4 类是 heartbeat，15s 周期，由 A12 覆盖）',
      kinds.includes('task.status') && kinds.includes('batch.status') && kinds.includes('item.status'),
      `共 ${events.length} 条，类型：${kinds.join(', ')}`,
    );

    const ids = events.map((e) => e.id).filter((n) => n !== null);
    check(
      'D4d',
      '事件 id 严格递增（Last-Event-ID 续传的前提）',
      ids.length === events.length && ids.every((v, i) => i === 0 || v > ids[i - 1]),
      ids.length ? `id ${ids[0]} → ${ids[ids.length - 1]}，共 ${ids.length} 条` : '无 id',
    );
  }
} catch (err) {
  check('FATAL', '端到端流程未跑完', false, err && err.message ? err.message : String(err));
} finally {
  killProc(service);
  killProc(engine);
  await sleep(600);
}

// ------------------------------------------------------------------ 报告

const passed = results.filter((r) => r.ok).length;
console.log('M5 端到端验收（真实进程 + 真实落盘）');
console.log(`\nD1–D5：${passed} / ${results.length} 通过\n`);
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.id} — ${r.label}\n      ${r.detail}`);
if (passed !== results.length) failed = 1;

process.exit(failed ? 1 : 0);
