#!/usr/bin/env node
/**
 * 队列多选删除 + 漫画库「删除/隐藏/恢复」的取证 —— 且必须可反证
 * =========================================================================
 * ## 覆盖的四件事（用户 2026-10-07 提的可用性增量）
 *
 * 1. **队列多选删除**（`POST /tasks/delete`）：只删**记录**，不动漫画目录；
 *    翻译中 / 排队中**不可删**（逐条回报 `skipped`，不整批失败）。
 * 2. **漫画库删除**（`POST /library/{name}/delete`）的两个分支：
 *    · `deleteFiles:false` ⇒ **只隐藏**（目录原样保留，`GET /library` 不再列出）；
 *    · `deleteFiles:true`  ⇒ 递归删除该漫画目录，并清掉隐藏记录。
 * 3. **恢复隐藏**（`POST /library/{name}/unhide`）—— 没有它，"只隐藏"就是死胡同。
 * 4. **越界守卫**：删除端点复用 `resolveComicDir`，`../..` 必须被 403 挡下（契约 §8.2）。
 *
 * ## 为什么这几条**不能**并进 e2e.mjs 的既有门
 * 既有门测的是"翻译链路对不对"（图有没有翻、落盘对不对）。而这里的语义是
 * **"删的是记录还是文件"** —— 一个"删得很干净"的实现同样能让"图翻对了"全绿。
 * 能抓住语义混淆的只有**删除之后去看它到底删了什么**：目录还在不在、库里还列不列它、
 * 任务记录还在不在。所以必须单开一个脚本。
 *
 * ## 判据（见下方 L1..L8 的 label）
 * ## 反证轮（`--refute`）：四条变异，各自必须让指定断言变红
 *   M1 去掉 `deleteTasks` 的终态门 ⇒ 翻译中的任务也会被删 ⇒ L1 变红；
 *   M2 `scanLibrary` 不跳过隐藏项 ⇒ 隐藏了还列出来 ⇒ L4 变红；
 *   M3 `handleLibraryDelete` 无视 `deleteFiles`（恒为 false）⇒ L6 变红；
 *   M4 前端把 `/tasks/delete` 写错 ⇒ L8 变红。
 * 服务/前端都按源码破坏来验（服务是**子进程**，磁盘破坏会被新进程读到）。
 *
 * 用法：
 *   node e2e/service/library-manage-check.mjs           正向跑（期望全绿）
 *   node e2e/service/library-manage-check.mjs --refute  反证轮（破坏 → 变红 → 按字节还原）
 *
 * 约束：纯 Node、零依赖；起**模拟引擎**；临时目录落 os.tmpdir；反证轮结束必须按字节还原。
 * 见 ~/.workbuddy/skills/falsifiable-verification。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { encodePng } from '../../engine/src/png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENGINE_ENTRY = path.join(ROOT, 'engine', 'src', 'server.mjs');
const SERVICE_ENTRY = path.join(ROOT, 'service', 'src', 'server.mjs');
const STORE_SRC = path.join(ROOT, 'service', 'src', 'manga', 'store.mjs');
const SERVER_SRC = path.join(ROOT, 'service', 'src', 'server.mjs');
const APP_SRC = path.join(ROOT, 'app', 'src', 'App.tsx');

const REFUTE = process.argv.includes('--refute');
/// 起的是模拟引擎（ver1.0 自定义协议）；不声明会让服务按 real 协议去打替身。
const ENGINE_PROTOCOL = 'mock';
const ENGINE_PORT = 5026;

/** 主任务：小、先跑完 ⇒ 拿它做"可删的终态任务"与"库里的漫画"。 */
const COMIC_A = '库管理甲';
const IMAGES_A = 3;
/** 占位任务：批量塞进队列，用来取一条"翻译中/排队中"的任务做"不可删"的对照。 */
const COMIC_B = '库管理乙';
const COMIC_C = '库管理丙';
const COMIC_D = '库管理丁';
const IMAGES_FILL = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (id, label, ok, detail) => {
  results.push({ id, label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
};

// ------------------------------------------------------------------ 子进程

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
  child.kill('SIGTERM');
  // Windows：刚被 kill 的子进程会短暂占着文件句柄，随后写源文件会 EPERM —— 必须等它真的退出。
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

/** 带重试写文件；上界必须有，否则"文件被占"会被拖成静默挂死 */
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

const postJson = (port, token, urlPath, obj) =>
  request(port, 'POST', urlPath, {
    token,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(obj), 'utf8'),
  });

function buildMultipart(payload, images) {
  const boundary = `----miaomanage${Math.random().toString(16).slice(2)}`;
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

async function submit(port, token, comicName, images) {
  const mp = buildMultipart({ comicName, idempotencyKey: crypto.randomUUID() }, images);
  const res = await request(port, 'POST', '/api/v1/tasks', {
    token,
    headers: { 'Content-Type': mp.contentType },
    body: mp.body,
  });
  return { status: res.status, json: json(res) };
}

const TERMINAL = ['done', 'partial_failed', 'failed', 'canceled'];

async function waitTask(port, token, taskId, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const t = json(await request(port, 'GET', `/api/v1/tasks/${taskId}`, { token }));
    if (t && TERMINAL.includes(t.status)) return t;
    if (Date.now() > until) throw new Error(`${taskId} 未在 ${timeoutMs}ms 内到终态（当前 ${t && t.status}）`);
    await sleep(120);
  }
}

const getLibrary = async (port, token) => json(await request(port, 'GET', '/api/v1/library', { token }));
const getTasks = async (port, token) => json(await request(port, 'GET', '/api/v1/tasks', { token }));

const names = (lib) => (lib?.comics ?? []).map((c) => c.comicName);

/**
 * 去掉 `//` 与 `/* *\/` 注释（带字符串状态机）。
 *
 * 为什么源码断言必须先剥注释：本仓的注释**主动写出了被禁/被查的字面量**
 * （例如 App.tsx 的注释里就写着「队列多选删除（`POST /tasks/delete`）」）。
 * 不剥注释时，L8 在"真实调用点已被改错"之后仍会因为注释里的 `/tasks/delete` 而判绿 ——
 * 这正是本仓反复出现的那类假阳性（断言测的是注释，不是代码）。
 */
function stripComments(src) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '*') {
        state = 'block';
        out += '  ';
        i++;
        continue;
      }
      if (c === '/' && c2 === '/') {
        state = 'line';
        out += '  ';
        i++;
        continue;
      }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out += c;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') {
        state = 'code';
        out += '  ';
        i++;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += '\n';
      } else out += ' ';
      continue;
    }
    // 字符串三态：原样保留内容（含其中的 // 与 /*），只在引号处收尾
    out += c;
    if (state === 'sq' && c === "'" && src[i - 1] !== '\\') state = 'code';
    else if (state === 'dq' && c === '"' && src[i - 1] !== '\\') state = 'code';
    else if (state === 'tpl' && c === '`' && src[i - 1] !== '\\') state = 'code';
  }
  return out;
}

// ------------------------------------------------------------------ 正向

async function runAll() {
  results.length = 0;
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-libman-'));
  const ROOT_DIR = path.join(TMP, '漫画');
  const STATE_DIR = path.join(TMP, 'state');
  fs.mkdirSync(ROOT_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });

  let engine = null;
  let service = null;
  try {
    engine = spawnProc(ENGINE_ENTRY, { MIAO_ENGINE_PORT: String(ENGINE_PORT) }, 'engine');
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

    // ---- 前置：A 跑完（终态），B/C/D 塞进队列占位 ----
    const a = await submit(PORT, TOKEN, COMIC_A, makeImages(IMAGES_A));
    const taskA = a.json?.taskId;
    const doneA = taskA ? await waitTask(PORT, TOKEN, taskA) : null;
    const dirA = path.join(ROOT_DIR, COMIC_A);
    check(
      'P0',
      `前置：${COMIC_A} 交 ${IMAGES_A} 张、跑到终态，且目录已落盘`,
      doneA?.status === 'done' && fs.existsSync(dirA),
      `status=${doneA?.status} dir=${fs.existsSync(dirA)}`,
    );
    if (doneA?.status !== 'done') return;

    const b = await submit(PORT, TOKEN, COMIC_B, makeImages(IMAGES_FILL));
    const c = await submit(PORT, TOKEN, COMIC_C, makeImages(IMAGES_FILL));
    const d = await submit(PORT, TOKEN, COMIC_D, makeImages(IMAGES_FILL));
    const taskD = d.json?.taskId;
    const listBefore = await getTasks(PORT, TOKEN);

    // ---- L1：批量删除逐条回报：终态删、非终态跳过、不存在报 not_found ----
    const BOGUS = 'tsk_nope_00000000';
    const del = await postJson(PORT, TOKEN, '/api/v1/tasks/delete', {
      taskIds: [taskA, taskD, BOGUS],
    });
    const dj = json(del);
    const skippedD = (dj?.skipped ?? []).find((s) => s.taskId === taskD);
    const skippedBogus = (dj?.skipped ?? []).find((s) => s.taskId === BOGUS);
    check(
      'L1',
      '队列删除逐条回报：终态任务被删、翻译中/排队中被跳过、不存在的报 not_found（不整批失败）',
      del.status === 200 &&
        dj?.deleted?.length === 1 &&
        dj.deleted[0] === taskA &&
        dj.skippedCount === 2 &&
        skippedD?.reason === 'not_deletable' &&
        skippedBogus?.reason === 'not_found',
      `HTTP ${del.status} deleted=[${(dj?.deleted ?? []).join(',')}] skipped=${JSON.stringify(dj?.skipped ?? [])}`,
    );

    // ---- L2：删的是"记录"——列表少一行、盘上 json 没了，但**漫画目录毫发无损** ----
    const listAfter = await getTasks(PORT, TOKEN);
    const recordGone = !fs.existsSync(path.join(STATE_DIR, 'tasks', `${taskA}.json`));
    const dStillThere = (listAfter?.tasks ?? []).some((t) => t.taskId === taskD);
    check(
      'L2',
      '队列删除只删记录：任务列表少一行、落盘 json 消失、队列里其他任务仍在（画布未收拾它）',
      listAfter?.total === listBefore?.total - 1 && recordGone && dStillThere,
      `total ${listBefore?.total}→${listAfter?.total} recordGone=${recordGone} dStillThere=${dStillThere}`,
    );

    // ---- L4：deleteFiles:false ⇒ 只隐藏（目录还在、库里不列、hidden 记名）----
    const hid = json(await postJson(PORT, TOKEN, `/api/v1/library/${encodeURIComponent(COMIC_A)}/delete`, { deleteFiles: false }));
    const libAfterHide = await getLibrary(PORT, TOKEN);
    const hiddenFile = path.join(STATE_DIR, 'hidden-comics.json');
    let hiddenOnDisk = null;
    try {
      hiddenOnDisk = JSON.parse(fs.readFileSync(hiddenFile, 'utf8'));
    } catch {
      hiddenOnDisk = null;
    }
    check(
      'L4',
      'deleteFiles:false ⇒ 只隐藏：目录仍在盘上、`GET /library` 不再列出、hidden 记名并落盘',
      hid?.deletedFiles === false &&
        fs.existsSync(dirA) &&
        !names(libAfterHide).includes(COMIC_A) &&
        (libAfterHide?.hidden ?? []).includes(COMIC_A) &&
        Array.isArray(hiddenOnDisk?.comics) &&
        hiddenOnDisk.comics.includes(COMIC_A),
      `deletedFiles=${hid?.deletedFiles} dir=${fs.existsSync(dirA)} listed=${names(libAfterHide).includes(COMIC_A)} hidden=${JSON.stringify(libAfterHide?.hidden ?? [])}`,
    );

    // ---- L5：unhide ⇒ 恢复显示（"只隐藏"不是死胡同）----
    const un = json(await postJson(PORT, TOKEN, `/api/v1/library/${encodeURIComponent(COMIC_A)}/unhide`, {}));
    const libAfterUnhide = await getLibrary(PORT, TOKEN);
    check(
      'L5',
      '取消隐藏：`GET /library` 重新列出该漫画，hidden 清单里不再有它',
      un?.hiddenCount === 0 &&
        names(libAfterUnhide).includes(COMIC_A) &&
        !(libAfterUnhide?.hidden ?? []).includes(COMIC_A),
      `hiddenCount=${un?.hiddenCount} listed=${names(libAfterUnhide).includes(COMIC_A)} hidden=${JSON.stringify(libAfterUnhide?.hidden ?? [])}`,
    );

    // ---- L6：deleteFiles:true ⇒ 递归删目录，并清掉隐藏记录 ----
    const rm = json(await postJson(PORT, TOKEN, `/api/v1/library/${encodeURIComponent(COMIC_A)}/delete`, { deleteFiles: true }));
    const libAfterRm = await getLibrary(PORT, TOKEN);
    check(
      'L6',
      'deleteFiles:true ⇒ 漫画目录被真删、库里不再列出、隐藏记录一并清除',
      rm?.deletedFiles === true &&
        !fs.existsSync(dirA) &&
        !names(libAfterRm).includes(COMIC_A) &&
        !(libAfterRm?.hidden ?? []).includes(COMIC_A),
      `deletedFiles=${rm?.deletedFiles} dir=${fs.existsSync(dirA)} hidden=${JSON.stringify(libAfterRm?.hidden ?? [])}`,
    );

    // ---- L7：越界漫画名必须 403（复用 §8.2 校验点）----
    const trav = await postJson(PORT, TOKEN, '/api/v1/library/..%2F..%2Fetc/delete', { deleteFiles: true });
    const travJ = json(trav);
    check(
      'L7',
      '越界漫画名（`../../etc`）在删除端点被 403 挡下，且错误码是 PERMISSION_DENIED',
      trav.status === 403 && travJ?.error?.code === 'PERMISSION_DENIED',
      `HTTP ${trav.status} code=${travJ?.error?.code}`,
    );

    // ---- L8：前端接线（源码断言）——队列删的是 /tasks/delete，库删带 deleteFiles ----
    // ⚠️ 先剥注释再判：注释里写着端点名（本仓惯例会写），不剥就会测到注释而非调用点。
    const appSrc = stripComments(fs.readFileSync(APP_SRC, 'utf8'));
    const libSrc = stripComments(fs.readFileSync(path.join(ROOT, 'app', 'src', 'screens', 'LibraryScreen.tsx'), 'utf8'));
    check(
      'L8',
      '前端接线：队列删打 `/tasks/delete`；漫画库删打 `/delete` 且带 `deleteFiles` 勾选结果',
      /\/tasks\/delete/.test(appSrc) && /\/delete/.test(libSrc) && /deleteFiles/.test(libSrc),
      `app:/tasks/delete=${/\/tasks\/delete/.test(appSrc)} lib:/delete=${/\/delete/.test(libSrc)} deleteFiles=${/deleteFiles/.test(libSrc)}`,
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

const MUTATIONS = [
  {
    name: 'M1 去掉 deleteTasks 的终态门（翻译中/排队中也会被删）',
    edits: [
      {
        file: STORE_SRC,
        find: '      if (!TASK_TERMINAL.has(task.status)) {\n        skipped.push({ taskId, reason: \'not_deletable\', status: task.status });\n        continue;\n      }',
        replace: '      if (false) { // refute：不再拦翻译中/排队中\n        skipped.push({ taskId, reason: \'not_deletable\', status: task.status });\n        continue;\n      }',
      },
    ],
    expect: ['L1'],
  },
  {
    name: 'M2 scanLibrary 不跳过隐藏项（隐藏了还列出来）',
    edits: [
      {
        file: SERVER_SRC,
        find: '    if (store.hiddenComics.has(entry.name)) continue;',
        replace: '    if (false) continue; // refute：不跳过隐藏项',
      },
    ],
    expect: ['L4'],
  },
  {
    name: 'M3 handleLibraryDelete 无视 deleteFiles（恒为 false ⇒ 永远不会真删）',
    edits: [
      {
        file: SERVER_SRC,
        find: '  const deleteFiles = parsed?.deleteFiles === true;',
        replace: '  const deleteFiles = false; // refute：无视勾选',
      },
    ],
    expect: ['L6'],
  },
  {
    name: 'M4 前端队列删除打错端点（不再是 /tasks/delete）',
    edits: [
      {
        file: APP_SRC,
        find: "        const r = await apiPost<DeleteTasksResponse>('/tasks/delete', { taskIds });",
        replace: "        const r = await apiPost<DeleteTasksResponse>('/tasks/nope', { taskIds }); // refute",
      },
    ],
    expect: ['L8'],
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
  console.log(`队列删除 + 漫画库删除/隐藏/恢复 取证${REFUTE ? ' · 反证轮' : ''}`);

  if (!REFUTE) {
    await runAll();
    const { fail } = printResults('库管理 · 删除/隐藏/恢复');
    process.exitCode = fail === 0 ? 0 : 1;
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
    for (const e of mut.edits) {
      if (!originals.has(e.file)) originals.set(e.file, readBytes(e.file));
      const snap = originals.get(e.file);
      const txt = snap.toString('utf8');
      // 🔴 本仓 `core.autocrlf=true`：工作区是 CRLF、锚点写的是 LF。不折算行尾，
      //    任何**跨行**锚点都会"锚点未找到" → 该条静默不反证（跳过 ≠ 通过）。
      const eol = txt.includes('\r\n') ? '\r\n' : '\n';
      const find = e.find.split('\n').join(eol);
      const repl = e.replace.split('\n').join(eol);
      if (!txt.includes(find)) {
        console.log(`⚠ ${mut.name}\n    破坏锚点未找到（${path.relative(ROOT, e.file)}）—— 本条无法反证`);
        skipped += mut.expect.length;
        continue;
      }
      await writeRetry(e.file, txt.replace(find, repl));
    }
    // 还原一律进 finally：破坏若让 runAll() 抛异常，写在 try 之后的还原就不会执行
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
