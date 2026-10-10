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
 * ## 判据（见下方 L1..L8 / N1..N9 的 label）
 *
 * ## Step 8 扩展（plan「漫画库交互流程改造」）：新建 / 归并 / 封面
 * 5. **新建漫画**（`POST /library/create`）：建目录 + `manifest.json` 同步落盘（N1）；
 *    同名 → 409 `BOOK_NAME_TAKEN` 且不动已有目录（N2，判据是 existsSync 复检，D-118）。
 * 6. **归并**（`POST /library/{name}/merge`）：源有未终态任务 → 409 `MERGE_SOURCE_BUSY`（N3）；
 *    物理移动为 `<大类>/07_第7话`（NN_第N话 零填充，N4）；`episodes[]` 按目录重建（N5）。
 * 7. **封面**（`POST /library/{book}/cover`）：扩展名由**字节嗅探**决定（不信任 filename），
 *    `manifest.cover` 与 author 同一次请求同步写入，`GET /cover` 原样发回字节（N6）。
 * 8. **话号一位小数**（2026-10-11 需求）：归并 `no=14.1` → 目录 `14.1_第14.1话`、
 *    `episodes[].no` 记 14.1、`/chapters/14.1/…` 寻址到同一话（N7）；两位小数 / `.0`
 *    → 404 拒绝（N7b）。
 * 9. **归并撞 Windows 句柄占用**（D-125，线上"归并 22.1 → 服务内部错误"的修复）：
 *    源目录内文件被打开句柄占用时，`renameSync` 抛 EPERM。瞬时占用（350ms 后释放）被
 *    退避重试救回 → 200（N8）；持续占用重试耗尽 → 409 `MERGE_SOURCE_LOCKED` 而非
 *    500（N8b）；释放后重试成功、无半截目录残留（N8c）；页图/封面读流走 `pipeline`
 *    （中止即释放句柄，根因消除腿，源码级断言，N9）。
 *
 * ## 反证轮（`--refute`）：十一条变异，各自必须让指定断言变红
 *   M1 去掉 `deleteTasks` 的终态门 ⇒ 翻译中的任务也会被删 ⇒ L1 变红；
 *   M2 `scanLibrary` 不跳过隐藏项 ⇒ 隐藏了还列出来 ⇒ L4 变红；
 *   M3 `handleLibraryDelete` 无视 `deleteFiles`（恒为 false）⇒ L6 变红；
 *   M4 前端把 `/tasks/delete` 写错 ⇒ L8 变红；
 *   M5 新建的同名复检被去掉 ⇒ N2 变红；
 *   M6 归并的在跑任务门被去掉 ⇒ N3 变红；
 *   M7 话目录命名的零填充被去掉 ⇒ N4 变红；
 *   M8 封面落盘但 manifest.cover 不回写 ⇒ N6 变红；
 *   M9 页图读流退回 `.pipe`（中止泄漏句柄）⇒ N9 变红；
 *   M10 占用退避重试被去掉 ⇒ 瞬时占用也 500 ⇒ N8 变红；
 *   M11 占用终态不再归因 LOCKED ⇒ 回归 500 ⇒ N8b 变红。
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
const LIBRARY_SRC = path.join(ROOT, 'service', 'src', 'manga', 'library.mjs');
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

function buildMultipart(payload, images, fileField = 'images') {
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
        `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${img.filename}"\r\n` +
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

    // ================================================================
    // Step 8 扩展：新建 / 归并 / 封面（plan §Step 8 的后四件事）
    //
    // 前置：占位任务（B/C/D）全部到终态 —— 归并的「在跑拒绝」「物理移动」
    // 都要求"此刻没有别的任务搅局"，否则断言的是竞态而不是语义。
    for (const t of [b.json?.taskId, c.json?.taskId, taskD]) {
      if (t) await waitTask(PORT, TOKEN, t);
    }

    const NEW_BOOK = '新建测试书';
    const newDir = path.join(ROOT_DIR, NEW_BOOK);
    const readManifestOnDisk = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(newDir, 'manifest.json'), 'utf8'));
      } catch {
        return null;
      }
    };

    // ---- N1：新建漫画 → 建目录 + manifest.json 落盘（schema/author）+ 库里列为大类 ----
    const cr = await postJson(PORT, TOKEN, '/api/v1/library/create', { name: NEW_BOOK, author: '测试作者' });
    const crJ = json(cr);
    const createdBook = ((await getLibrary(PORT, TOKEN))?.books ?? []).find((x) => x.bookName === NEW_BOOK);
    const manifestCreated = readManifestOnDisk();
    check(
      'N1',
      '新建漫画：201 建目录，manifest.json 同步落盘（schema=1 + author），库里列为 0 话的大类',
      cr.status === 201 &&
        crJ?.bookName === NEW_BOOK &&
        fs.existsSync(newDir) &&
        manifestCreated?.schema === 1 &&
        manifestCreated?.author === '测试作者' &&
        createdBook?.chapterCount === 0,
      `HTTP ${cr.status} bookName=${crJ?.bookName} dir=${fs.existsSync(newDir)} schema=${manifestCreated?.schema} author=${manifestCreated?.author} chapterCount=${createdBook?.chapterCount}`,
    );

    // ---- N2：新建同名 → 409，且**不动**已有目录（部分建目录不留残骸）----
    const dup = await postJson(PORT, TOKEN, '/api/v1/library/create', { name: NEW_BOOK });
    const dupJ = json(dup);
    check(
      'N2',
      '新建同名：409 BOOK_NAME_TAKEN，已有目录原样保留（不存在"建了一半"的第二个目录）',
      dup.status === 409 &&
        dupJ?.error?.code === 'BOOK_NAME_TAKEN' &&
        fs.existsSync(newDir) &&
        readManifestOnDisk()?.author === '测试作者',
      `HTTP ${dup.status} code=${dupJ?.error?.code} dir=${fs.existsSync(newDir)} manifestAuthor=${readManifestOnDisk()?.author}`,
    );

    // ---- N3：归并拒绝在跑任务（源还有未终态任务 → 409 MERGE_SOURCE_BUSY）----
    // 连塞两个任务再立刻归并：队列是串行的，第二个必然还挂着 ⇒ 判定与引擎快慢无关。
    const bt1 = await submit(PORT, TOKEN, COMIC_B, makeImages(IMAGES_FILL));
    const bt2 = await submit(PORT, TOKEN, COMIC_B, makeImages(IMAGES_FILL));
    const mgBusy = await postJson(PORT, TOKEN, `/api/v1/library/${encodeURIComponent(COMIC_B)}/merge`, {
      targetBook: NEW_BOOK,
      no: 7,
    });
    const mgBusyJ = json(mgBusy);
    check(
      'N3',
      '归并拒绝在跑任务：源目录还有未终态任务 → 409 MERGE_SOURCE_BUSY（翻译中被搬走 = 写向不存在的路径）',
      mgBusy.status === 409 && mgBusyJ?.error?.code === 'MERGE_SOURCE_BUSY',
      `HTTP ${mgBusy.status} code=${mgBusyJ?.error?.code}`,
    );
    for (const t of [bt1.json?.taskId, bt2.json?.taskId]) {
      if (t) await waitTask(PORT, TOKEN, t);
    }

    // ---- N4：归并物理移动 → <大类>/07_第7话（两位零填充命名），原顶层目录消失 ----
    const dirB = path.join(ROOT_DIR, COMIC_B);
    const mg = await postJson(PORT, TOKEN, `/api/v1/library/${encodeURIComponent(COMIC_B)}/merge`, {
      targetBook: NEW_BOOK,
      no: 7,
    });
    const mgJ = json(mg);
    const libAfterMerge = await getLibrary(PORT, TOKEN);
    const mergedBook = (libAfterMerge?.books ?? []).find((x) => x.bookName === NEW_BOOK);
    check(
      'N4',
      '归并：源目录物理移动为 <大类>/07_第7话（NN_第N话 两位零填充），原顶层目录消失，库里 chapterCount=1',
      mg.status === 200 &&
        fs.existsSync(path.join(newDir, '07_第7话')) &&
        !fs.existsSync(dirB) &&
        mgJ?.merged?.to === `${NEW_BOOK}/07_第7话` &&
        mergedBook?.chapterCount === 1,
      `HTTP ${mg.status} to=${mgJ?.merged?.to} chDir=${fs.existsSync(path.join(newDir, '07_第7话'))} srcGone=${!fs.existsSync(dirB)} chapterCount=${mergedBook?.chapterCount}`,
    );

    // ---- N5：manifest 回写 → episodes[] 按目录重建（no 与 dir 两头都对）----
    const manifestAfterMerge = readManifestOnDisk();
    check(
      'N5',
      '归并后 manifest.json 的 episodes[] 按目录重建：唯一一条 {no:7, dir:"07_第7话"}',
      Array.isArray(manifestAfterMerge?.episodes) &&
        manifestAfterMerge.episodes.length === 1 &&
        manifestAfterMerge.episodes[0]?.no === 7 &&
        manifestAfterMerge.episodes[0]?.dir === '07_第7话',
      `episodes=${JSON.stringify(manifestAfterMerge?.episodes ?? null)}`,
    );

    // ---- N6：封面落盘 + json 同步（扩展名字段由**字节嗅探**决定，不信任 filename）----
    // 故意给 filename=.bin / contentType=application/octet-stream：落盘名必须是嗅探出来的 cover.png
    const coverPng = encodePng(8, 8, (x, y, put) => put(200, 30, 90));
    const mpCover = buildMultipart(
      { author: '测试作者2' },
      [{ filename: 'whatever.bin', contentType: 'application/octet-stream', data: coverPng }],
      'cover',
    );
    const cv = await request(PORT, 'POST', `/api/v1/library/${encodeURIComponent(NEW_BOOK)}/cover`, {
      token: TOKEN,
      headers: { 'Content-Type': mpCover.contentType },
      body: mpCover.body,
    });
    const cvJ = json(cv);
    const coverOnDisk = fs.existsSync(newDir) ? fs.readdirSync(newDir).find((f) => /^cover\./.test(f)) : null;
    const cvGet = await request(PORT, 'GET', `/api/v1/library/${encodeURIComponent(NEW_BOOK)}/cover`, { token: TOKEN });
    const manifestAfterCover = readManifestOnDisk();
    check(
      'N6',
      '封面：POST 落盘为 cover.png（嗅探命名），manifest.cover 与 author 同一次请求同步写入，GET /cover 原样发回字节',
      cv.status === 200 &&
        coverOnDisk === 'cover.png' &&
        manifestAfterCover?.cover === 'cover.png' &&
        manifestAfterCover?.author === '测试作者2' &&
        cvGet.status === 200 &&
        Buffer.isBuffer(cvGet.body) &&
        cvGet.body.equals(coverPng),
      `HTTP ${cv.status} coverOnDisk=${coverOnDisk} manifestCover=${manifestAfterCover?.cover} author=${manifestAfterCover?.author} getBytes=${cvGet.status}/${cvGet.body?.length}`,
    );

    // ---- N7：话号支持一位小数（2026-10-11 需求）----
    // 归并 body.no = 14.1 ⇒ 物理目录 `14.1_第14.1话`（整数话号 14.1 的 padStart 不动它）、
    // episodes[].no 记为 JSON 数 14.1、话级寻址 `/chapters/14.1/…` 可用。
    // 同时咬三件事：**格式**（14.1 不被当成非法）、**存储**（目录名/manifest 的真实形状）、
    // **寻址**（URL 里的小数话号能定位到同一话）。两位小数（14.55）在 resolveChapterDir
    // 的正则就 404，放在反证轮外用直连请求验（见下方 N7b）。
    const mgDec = await postJson(PORT, TOKEN, `/api/v1/library/${encodeURIComponent(COMIC_C)}/merge`, {
      targetBook: NEW_BOOK,
      no: 14.1,
    });
    const mgDecJ = json(mgDec);
    const decDir = path.join(newDir, '14.1_第14.1话');
    const libDec = await getLibrary(PORT, TOKEN);
    const decBook = (libDec?.books ?? []).find((x) => x.bookName === NEW_BOOK);
    const manifestDec = readManifestOnDisk();
    const rtDec = await request(
      PORT,
      'GET',
      `/api/v1/library/${encodeURIComponent(NEW_BOOK)}/chapters/14.1/retranslate`,
      { token: TOKEN },
    );
    const rtDecJ = json(rtDec);
    check(
      'N7',
      '话号一位小数：归并 no=14.1 → 目录 14.1_第14.1话，episodes 记 14.1，/chapters/14.1 寻址到同一话',
      mgDec.status === 200 &&
        mgDecJ?.merged?.to === `${NEW_BOOK}/14.1_第14.1话` &&
        fs.existsSync(decDir) &&
        manifestDec?.episodes?.some((e) => e.no === 14.1 && e.dir === '14.1_第14.1话') &&
        decBook?.chapterCount === 2 &&
        rtDec.status === 200 &&
        rtDecJ?.dirName === `${NEW_BOOK}/14.1_第14.1话`,
      `HTTP ${mgDec.status} to=${mgDecJ?.merged?.to} dir=${fs.existsSync(decDir)} episodes=${JSON.stringify(manifestDec?.episodes ?? null)} chCount=${decBook?.chapterCount} rt=${rtDec.status}/${rtDecJ?.dirName}`,
    );

    // ---- N7b：话号格式边界 —— 两位小数 / .0 必须被拒（404），一位小数放行 ----
    // 与 N7 同一函数的两条腿：N7 证"对的能过"，这条证"错的进不来"。
    const badDec = await request(
      PORT,
      'GET',
      `/api/v1/library/${encodeURIComponent(NEW_BOOK)}/chapters/14.55/retranslate`,
      { token: TOKEN },
    );
    const zeroDec = await request(
      PORT,
      'GET',
      `/api/v1/library/${encodeURIComponent(NEW_BOOK)}/chapters/14.0/retranslate`,
      { token: TOKEN },
    );
    check(
      'N7b',
      '话号格式边界：14.55（两位小数）/ 14.0（.0）→ 404 TASK_NOT_FOUND，不许静默解析',
      badDec.status === 404 && zeroDec.status === 404,
      `14.55=${badDec.status} 14.0=${zeroDec.status}`,
    );

    // ---- N8/N8b/N8c：归并撞 Windows「句柄占用族」（D-125）----
    // 用户点「归并」时该话的缩略图请求可能还在传（目录内有打开的读句柄），renameSync 抛
    // EPERM。修复前这条直接变 500「服务内部错误」——即线上实测的归并报障。修复后：
    // 瞬时占用被退避重试救回（N8）；持续占用归因成 409 MERGE_SOURCE_LOCKED，可解释可行动
    // （N8b）；释放后重试成功且无半截目录残留（N8c）。
    const busyA = '占用重试甲 22.1';
    const busyADir = path.join(ROOT_DIR, busyA);
    fs.mkdirSync(busyADir, { recursive: true });
    fs.writeFileSync(path.join(busyADir, '001.png'), encodePng(4, 4, (x, y, put) => put(10, 20, 30)));
    const heldA = fs.openSync(path.join(busyADir, '001.png'), 'r');
    setTimeout(() => {
      try { fs.closeSync(heldA); } catch { /* 已关 */ }
    }, 350); // 350ms < 重试窗口（5 次 × 200ms）⇒ 必须被重试救回
    const mgHold = await postJson(PORT, TOKEN, `/api/v1/library/${encodeURIComponent(busyA)}/merge`, {
      targetBook: NEW_BOOK,
      no: 22.1,
    });
    const mgHoldJ = json(mgHold);
    check(
      'N8',
      '归并撞瞬时句柄占用：退避重试窗口内释放 ⇒ 200 救回（不是 500 内部错误）',
      mgHold.status === 200 && mgHoldJ?.merged?.to === `${NEW_BOOK}/22.1_第22.1话`,
      `HTTP ${mgHold.status} to=${mgHoldJ?.merged?.to ?? mgHoldJ?.error?.code}`,
    );

    const busyB = '占用重试乙 22.2';
    const busyBDir = path.join(ROOT_DIR, busyB);
    fs.mkdirSync(busyBDir, { recursive: true });
    fs.writeFileSync(path.join(busyBDir, '001.png'), encodePng(4, 4, (x, y, put) => put(40, 50, 60)));
    const heldB = fs.openSync(path.join(busyBDir, '001.png'), 'r'); // 全程不释放 ⇒ 重试必然耗尽
    const mgLock = await postJson(PORT, TOKEN, `/api/v1/library/${encodeURIComponent(busyB)}/merge`, {
      targetBook: NEW_BOOK,
      no: 22.2,
    });
    const mgLockJ = json(mgLock);
    check(
      'N8b',
      '占用重试耗尽 → 409 MERGE_SOURCE_LOCKED（可解释、可行动），不许再是 500 INTERNAL',
      mgLock.status === 409 && mgLockJ?.error?.code === 'MERGE_SOURCE_LOCKED' && !fs.existsSync(path.join(newDir, '22.2_第22.2话')),
      `HTTP ${mgLock.status} code=${mgLockJ?.error?.code} dstCreated=${fs.existsSync(path.join(newDir, '22.2_第22.2话'))}`,
    );
    fs.closeSync(heldB);
    const mgUnlock = await postJson(PORT, TOKEN, `/api/v1/library/${encodeURIComponent(busyB)}/merge`, {
      targetBook: NEW_BOOK,
      no: 22.2,
    });
    check(
      'N8c',
      '句柄释放后重试同一话 → 200：LOCKED 是可恢复错误，源目录无残留、目标落位正确',
      mgUnlock.status === 200 && fs.existsSync(path.join(newDir, '22.2_第22.2话')),
      `HTTP ${mgUnlock.status} dst=${fs.existsSync(path.join(newDir, '22.2_第22.2话'))}`,
    );

    // ---- N9：发图/封面读流必须走 pipeline（D-125 的根因消除腿）----
    // .pipe() 在客户端中止（取消加载/切页）时**不销毁**源流 ⇒ 读句柄泄漏 ⇒ Windows 下该目录
    // 的归并 rename 撞 EPERM。行为级复现这条太脆（时序敏感），按 D-112 缺口的形态做源码级断言。
    const serverSrc = fs.readFileSync(SERVER_SRC, 'utf8');
    const pipelineCount = (serverSrc.match(/pipeline\(fs\.createReadStream\(file\), res\)/g) || []).length;
    const pipeResLeft = /\.pipe\(res\)/.test(serverSrc);
    check(
      'N9',
      '页图与封面两条读流都走 pipeline（中止即释放句柄），源码无 .pipe(res) 残留',
      pipelineCount === 2 && !pipeResLeft,
      `pipeline=${pipelineCount} pipeResLeft=${pipeResLeft}`,
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
  {
    // 🔴 同名判据是「existsSync 复检」而不是 err.code（D-118）。去掉它 ⇒ mkdir 的原始错误
    //    直接上抛成 500 —— N2 期望的 409/BOOK_NAME_TAKEN 就红。
    name: 'M5 新建漫画的同名复检被去掉（撞名错误直接 500，不再归因为 409）',
    edits: [
      {
        file: SERVER_SRC,
        find: '    if (fs.existsSync(path.join(store.root, norm.name))) {',
        replace: '    if (false) { // refute：同名复检被去掉',
      },
    ],
    expect: ['N2'],
  },
  {
    // 在跑门被去掉 ⇒ 归并真的会把带任务的目录搬走：N3 期望的 409 变 200。
    // （搬走后引擎往旧路径写会失败 ⇒ 该任务以 failed 终态收场，不阻塞后续轮次。）
    name: 'M6 归并的在跑任务门被去掉（翻译中的目录也能被搬走）',
    edits: [
      {
        file: SERVER_SRC,
        find: '  const busy = store.activeTasksForDir(srcName);\n  if (busy.length > 0) {',
        replace: '  const busy = []; // refute：在跑任务门被去掉\n  if (busy.length > 0) {',
      },
    ],
    expect: ['N3'],
  },
  {
    // 话目录命名只此一处定义（chapterDirName）。零填充被去掉 ⇒ 位移后的目录名是 `7_第7话`，
    // N4 断言的 `07_第7话`（位置、merged.to、chapterCount 三个口径）全部落空。
    name: 'M7 话目录命名的两位零填充被去掉（归并产物变成 7_第7话）',
    edits: [
      {
        file: LIBRARY_SRC,
        find: "  return `${String(no).padStart(2, '0')}_第${no}话`;",
        replace: "  return `${no}_第${no}话`; // refute：零填充被去掉",
      },
    ],
    expect: ['N4'],
  },
  {
    // 「同步写入」的验证点：封面文件照常落盘、GET 照常发回，唯独 manifest.cover 不回写 ⇒
    // 文件与 json 脱钩（这正是用户点名要防的缺陷），N6 红而其余子条件全绿 —— 说明断言咬的是同步性。
    name: 'M8 封面落盘但 manifest 的 cover 字段不回写（文件与 json 脱钩）',
    edits: [
      {
        file: SERVER_SRC,
        find: '  writeManifestAtomic(dir, { ...manifest, cover: coverName, episodes: episodesFromDirs(dir) });',
        replace:
          '  writeManifestAtomic(dir, { ...manifest, cover: null, episodes: episodesFromDirs(dir) }); // refute：cover 不回写',
      },
    ],
    expect: ['N6'],
  },
  {
    // 锚点连到 sendImageBytes 的收尾行 + 下一函数签名（该 pipeline 行出现两处，裸行不唯一，D-113）。
    // 退回 .pipe ⇒ 源码级断言 N9 红（pipeline 计数掉到 1 且出现 .pipe(res) 残留）。
    name: 'M9 页图读流退回 .pipe（客户端中止不销毁源流 ⇒ 句柄泄漏 ⇒ 归并 rename 撞 EPERM）',
    edits: [
      {
        file: SERVER_SRC,
        find: '  await pipeline(fs.createReadStream(file), res).catch(() => {});\n}\n\nfunction handleLibraryFile(req, res, cors, rawName, seqText, url) {',
        replace: '  fs.createReadStream(file).pipe(res); // refute：退回 pipe，中止即泄漏句柄\n}\n\nfunction handleLibraryFile(req, res, cors, rawName, seqText, url) {',
      },
    ],
    expect: ['N9'],
  },
  {
    // 重试被去掉 ⇒ 瞬时占用（350ms 后释放）也会在第一次 rename 失败时直接上抛 ⇒ N8 红成 500。
    // N8b/N8c 不 expect：它们不依赖重试次数（耗尽路径行为不变）。
    name: 'M10 归并移动的占用退避重试被去掉（EPERM 第一次就上抛 ⇒ 瞬时占用也 500）',
    edits: [
      {
        file: SERVER_SRC,
        find: '      if (!isBusyFsError(err) || i >= RENAME_RETRY.tries) throw err;',
        replace: '      throw err; // refute：占用重试被去掉',
      },
    ],
    expect: ['N8'],
  },
  {
    // 占用归因被短路 ⇒ 重试耗尽后 err 原样上抛 ⇒ 500 INTERNAL 回归，N8b 红成 500。
    name: 'M11 占用终态不再归因为 MERGE_SOURCE_LOCKED（回退成 500 内部错误）',
    edits: [
      {
        file: SERVER_SRC,
        find: '    if (isBusyFsError(err)) {\n      // 占用重试已耗尽（约 800ms）：把"500 服务内部错误"归因成用户能行动的 409（D-125）',
        replace: '    if (false) { // refute：占用不再归因\n      // 占用重试已耗尽（约 800ms）：把"500 服务内部错误"归因成用户能行动的 409（D-125）',
      },
    ],
    expect: ['N8b'],
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
