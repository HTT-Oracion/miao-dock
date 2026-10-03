// box-service HTTP 入口（真实服务）
// 契约依据：§1 拓扑与端口、§2 通用约定、§5 端点、§8 安全
// 与 `miao-trans/mock-service` 同源（同契约）：差异集中在「真实化」——
// 令牌 CSPRNG、落盘根目录归位、sidecar 由真实探测（而非计时器模拟）、翻译走引擎。
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  API_VERSION, BASE_PATH, BATCH_LIMIT, ORIGINAL_SCAN_RE, ROOT_DIR,
  SERVICE_NAME, SERVICE_VERSION, STATE_DIR, TASKS_STATE_DIR, TRANSLATED_SCAN_RE,
  TOKEN_FILE, assertInsideRoot, config, validateRoot,
} from './config.mjs';
import { ApiError, errorEnvelope, permissionDenied } from './errors.mjs';
import { probeEngine } from './engine-client.mjs';
import { allFieldStrings, firstField, groupParts, parseMultipartEx } from './multipart.mjs';
import { normalizeComicName, isSafeDirName } from './names.mjs';
import { Store } from './store.mjs';
import { HEARTBEAT_MS, SSE_HEADERS, writeComment } from './sse.mjs';

const MAX_BODY = 256 * 1024 * 1024; // 20 张高分辨率原图的宽松上限
const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

// ------------------------------------------------------------------ 启动准备

// 落盘根目录：启动时校验一次（契约 §8.2 校验点 1）
const rootCanonical = validateRoot(ROOT_DIR);
const store = new Store(rootCanonical);
const restore = store.init();
store.startedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const bootedAt = Date.now();

// sidecar（引擎）状态 —— **真实探测**，不再是计时器模拟
// 带 2s 缓存：插件端口探测（5180→5190）会高频打 /health，无需每次都做一次引擎握手
const SIDECAR_CACHE_MS = 2000;
let sidecarProbe = { at: 0, value: null };

async function sidecarState() {
  if (config.sidecarDown) return { state: 'down', port: null, engine: null };
  const now = Date.now();
  if (sidecarProbe.value && now - sidecarProbe.at < SIDECAR_CACHE_MS) return sidecarProbe.value;
  const value = await probeEngine();
  sidecarProbe = { at: now, value };
  return value;
}

const serverLog = (msg) => console.log(`[box-service] ${msg}`);
const securityLog = (msg) => console.warn(`[box-service][security] ${msg}`);

/**
 * §8.2 校验点 2：`normalizedComicName` 不含 `/ \ ..`（再断言一次，不信任上游）。
 * 命中 → 403 PERMISSION_DENIED + 安全日志（这是**安全拒绝**，不是「落盘失败」，
 * 因此不适用 §4.2 的 `saved:false` 降级路径）。
 */
function assertSafeDirName(name) {
  if (!isSafeDirName(name)) {
    securityLog(`拒绝路径越界的漫画名（§8.2 校验点 2）：${JSON.stringify(name)}`);
    throw permissionDenied();
  }
}

/**
 * F-3 / §2.2 `DISK_FULL(507)`：创建任务前探测一次落盘根目录**可写性**。
 * 请求级落盘不可用 → 507；item 级落盘失败仍走 §4.2 的 `saved:false`（任务继续）。
 */
function assertRootWritable() {
  const probe = path.join(store.root, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
  } catch (err) {
    try { fs.unlinkSync(probe); } catch { /* 尽力清理 */ }
    securityLog(`落盘根目录不可写（DISK_FULL）：${store.root}（${err && err.code}）`);
    throw new ApiError('DISK_FULL', '落盘根目录不可写（磁盘满或权限不足），无法创建任务',
      { root: store.root, reason: err && err.code });
  }
}

/** sidecar 未就绪 → 503 UNAVAILABLE（契约 §2.2） */
async function assertSidecarReady() {
  const { state } = await sidecarState();
  if (state !== 'running') {
    throw new ApiError('UNAVAILABLE', `翻译引擎（sidecar）未就绪：state=${state}`,
      { sidecar: { state, port: config.enginePort } });
  }
}

// ------------------------------------------------------------------ CORS / 鉴权

/**
 * Origin 白名单：chrome-extension://* 或 null（Box 桌面端）
 * @returns {{ok:boolean, allow:string|null}}
 */
function checkOrigin(originHeader) {
  if (originHeader === undefined || originHeader === null || String(originHeader).trim() === '') {
    return { ok: true, allow: null };
  }
  const o = String(originHeader).trim();
  if (o === 'null') return { ok: true, allow: 'null' };
  if (/^chrome-extension:\/\/[A-Za-z0-9._-]+$/.test(o)) return { ok: true, allow: o };
  return { ok: false, allow: null };
}

function corsHeaders(allow) {
  const h = {
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'X-Box-Token, X-Box-Client',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
  };
  // 绝不返回 `*`；无 Origin 时不带此头
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

function tokenMatches(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(config.token, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, body, cors) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    ...cors,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

function sendError(res, err, cors) {
  const { status, body } = errorEnvelope(err);
  if (!(err instanceof ApiError)) {
    console.error('[box-service] 未预期错误：', err);
  }
  sendJson(res, status, body, cors);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      throw new ApiError('INVALID_IMAGE', '请求体过大', { limitBytes: MAX_BODY });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ 端点实现

async function healthView() {
  const sidecar = await sidecarState();
  const status = sidecar.state === 'running' ? 'ok' : (sidecar.state === 'starting' ? 'starting' : 'degraded');
  return {
    status,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    apiVersion: API_VERSION,
    sidecar: { state: sidecar.state, port: sidecar.port, engine: sidecar.engine },
    rootDir: store.root,
    startedAt: store.startedAt,
  };
}

/** 解析 multipart 表单：payload + images[] + imageOrder[] */
function parseUploadRequest(req, body) {
  const ct = req.headers['content-type'] || '';
  if (!/multipart\/form-data/i.test(ct)) {
    throw new ApiError('INVALID_IMAGE', 'Content-Type 必须是 multipart/form-data', { contentType: ct });
  }
  // Content-Length 与解析出的字节数一致性（能加则加；chunked 无此头时跳过）
  const declaredLen = Number.parseInt(req.headers['content-length'] ?? '', 10);
  if (Number.isFinite(declaredLen) && declaredLen !== body.length) {
    throw new ApiError('INVALID_IMAGE', 'Content-Length 与实际请求体字节数不一致',
      { contentLength: declaredLen, actualBytes: body.length });
  }
  const parsed = parseMultipartEx(body, ct);
  if (parsed === null) {
    throw new ApiError('INVALID_IMAGE', 'multipart 缺少 boundary', {});
  }
  if (!parsed.complete) {
    // 未以 `--boundary--` 收尾：请求体被截断，宁可报错也不要静默少收几张图
    throw new ApiError('INVALID_IMAGE', 'multipart 请求体被截断（缺少结束分隔符）',
      { bytes: body.length });
  }
  const { fields, files } = groupParts(parsed.parts);
  const images = (files.get('images') || []).map((p) => ({
    filename: p.filename,
    contentType: p.contentType,
    data: p.data,
  }));

  if (images.length === 0) {
    throw new ApiError('INVALID_IMAGE', 'images[] 缺失或为空（至少需要 1 张图片）', { submitted: 0 });
  }
  if (images.length > BATCH_LIMIT) {
    throw new ApiError('BATCH_LIMIT_EXCEEDED',
      `单次最多提交 ${BATCH_LIMIT} 张，当前 ${images.length} 张`,
      { limit: BATCH_LIMIT, submitted: images.length });
  }

  let payload = {};
  // `payload` 既可能是普通字段（推荐），也可能被客户端当文件 part 上传，两者都接受
  let rawPayload = firstField(fields, 'payload');
  if (rawPayload === null) {
    const asFile = files.get('payload');
    if (asFile && asFile.length > 0) rawPayload = asFile[0].data.toString('utf8');
  }
  if (rawPayload !== null && rawPayload !== undefined && rawPayload.trim() !== '') {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      payload = {};
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
  return { payload, images, imageOrder: allFieldStrings(fields, 'imageOrder') };
}

/**
 * 「来源」归因。
 *
 * 契约 §2 把 `X-Box-Client` 定义为**可选头，用于日志归因**，而 X-C1 队列页有一列「来源」
 * （示例值「来自浏览器插件」），但契约请求体里没有该字段、也不该为它新增字段。
 * 于是复用这个既有可选头做归因：插件端本就发 `extension/x.y.z`，桌面端发
 * `box-desktop/x.y.z`。**请求体零改动、契约零改动**，只是把它同时用于列表视图。
 * 未带该头（或值不认识）的任务归为 `unknown`——不猜，宁可显示「—」。
 */
function sourceOf(req) {
  const c = String(req.headers['x-box-client'] || '').toLowerCase();
  if (c.startsWith('extension/')) return 'extension';
  if (c.startsWith('box-desktop/')) return 'desktop';
  return 'unknown';
}

function handleCreateTask(req, res, cors) {
  return readBody(req).then(async (body) => {
    await assertSidecarReady();
    const { payload, images, imageOrder } = parseUploadRequest(req, body);
    const norm = normalizeComicName(payload.comicName);
    if (!norm.ok) throw new ApiError(norm.code, norm.message, norm.details);
    // §8.2 校验点 2：请求校验期就断言，绝不等到落盘期才失败
    assertSafeDirName(norm.name);
    assertRootWritable(); // §2.2 DISK_FULL(507)：请求级落盘不可用
    payload.__normalizedName = norm.name;

    const { task, replay } = store.createTask({
      payload, images, imageOrder, source: sourceOf(req),
    });
    const view = store.createView(task);
    // IDEMPOTENT_REPLAY：HTTP 200（重放）vs 201（新建），响应体不做任何额外标注
    sendJson(res, replay ? 200 : 201, view, cors);
  });
}

function handleAppendBatch(req, res, cors, taskId) {
  return readBody(req).then(async (body) => {
    await assertSidecarReady();
    const { payload, images, imageOrder } = parseUploadRequest(req, body);
    // §8.2 校验点 2：不带 comicName，用任务上已存的归一化名再断言一次
    assertSafeDirName(store.mustTask(taskId).dirName);
    const { task } = store.appendBatch(taskId, { payload, images, imageOrder });
    const view = store.createView(task);
    sendJson(res, 200, view, cors);
  });
}

function handleTaskDetail(req, res, cors, taskId, url) {
  const task = store.mustTask(taskId);
  const from = url.searchParams.get('itemsFrom');
  const to = url.searchParams.get('itemsTo');
  const opts = {};
  if (from !== null) opts.itemsFrom = Number.parseInt(from, 10);
  if (to !== null) opts.itemsTo = Number.parseInt(to, 10);
  sendJson(res, 200, store.detailView(task, opts), cors);
}

function handleSse(req, res, cors, taskId) {
  store.mustTask(taskId); // 先抛 404，再升级为事件流
  const headerId = req.headers['last-event-id'];
  const url = new URL(req.url, 'http://127.0.0.1');
  const rawId = headerId !== undefined ? headerId : url.searchParams.get('lastEventId');
  const lastEventId = rawId === null || rawId === undefined ? -1 : Number.parseInt(String(rawId), 10);

  res.writeHead(200, { ...cors, ...SSE_HEADERS });
  res.socket?.setNoDelay?.(true);
  res.socket?.setTimeout?.(0);
  writeComment(res, 'connected');
  const unsubscribe = store.subscribe(taskId, res, Number.isFinite(lastEventId) ? lastEventId : -1);

  const cleanup = () => unsubscribe();
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

async function handleCancel(req, res, cors, taskId) {
  const result = await store.cancelTask(taskId);
  sendJson(res, 200, result, cors);
}

function handleQueue(req, res, cors) {
  sendJson(res, 200, store.queueSnapshot(), cors);
}

/**
 * `GET /tasks` —— 队列页的列表数据源（**契约外增量端点**，见 docs/spec-notes.md G-04）。
 *
 * 契约 §5.7 的 `/queue` 只覆盖 running + queued，而 X-C1 的表格要同时渲染
 * 「已完成 / 部分失败 / 失败 / 已取消」的历史行。为不动契约已有端点的语义，
 * 这里**新增**一个只读端点，不改 `/queue` 一个字。
 *
 * 查询参数：`status`（默认 `all`，可逗号分隔多个）、`limit`（正整数）。
 */
function handleTaskList(req, res, cors, url) {
  const status = url.searchParams.get('status') || 'all';
  const limitText = url.searchParams.get('limit');
  let limit;
  if (limitText !== null) {
    limit = Number.parseInt(limitText, 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new ApiError('INVALID_IMAGE', 'limit 必须是正整数', { limit: limitText });
    }
  }
  sendJson(res, 200, store.taskListView({ status, limit }), cors);
}

// ------------------------------------------------------------------ 库与导出

function scanLibrary() {
  const root = store.root;
  const comics = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch { /* 根目录不存在 → 空库 */ }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const originals = new Set();
    const translated = new Set();
    let modifiedMs = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        let m = ORIGINAL_SCAN_RE.exec(f);
        if (m) originals.add(Number(m[1]));
        m = TRANSLATED_SCAN_RE.exec(f);
        if (m) translated.add(Number(m[1]));
      }
      modifiedMs = fs.statSync(dir).mtimeMs;
    } catch { /* ignore */ }
    const seqMax = originals.size ? Math.max(...originals) : 0;
    comics.push({
      comicName: entry.name,
      dirName: entry.name,
      outputDir: dir,
      imageCount: originals.size,
      translatedCount: translated.size,
      seqMax,
      nextSeq: seqMax + 1,
      modifiedAt: modifiedMs ? new Date(modifiedMs).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    });
  }
  comics.sort((a, b) => a.comicName.localeCompare(b.comicName, 'zh-Hans-CN'));
  return {
    root,
    count: comics.length,
    comics,
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/**
 * 解析并校验漫画目录（路径穿越 → 403 + 安全日志，契约 §8.2）。
 * 注意：这里的 comicName 直接来自 URL，**先对原始名做 §8.2 校验点 2 的断言**——
 * 归一化会把 `/ \ :` 剥离掉，若只断言归一化结果，`../../etc` 会退化成合法的 `....etc`
 * 而返回 404，掩盖了越界意图。§8.2 只允许 403。
 */
function resolveComicDir(rawName) {
  if (!isSafeDirName(rawName)) {
    securityLog(`拒绝路径越界的漫画名（§8.2 校验点 2）：${JSON.stringify(rawName)}`);
    throw permissionDenied();
  }
  const norm = normalizeComicName(rawName);
  if (!norm.ok) throw new ApiError(norm.code, norm.message, norm.details);
  if (!isSafeDirName(norm.name)) {
    securityLog(`拒绝路径越界的漫画名：${JSON.stringify(rawName)}`);
    throw permissionDenied();
  }
  const dir = path.join(store.root, norm.name);
  try {
    assertInsideRoot(store.root, path.join(dir, 'x.png'));
  } catch {
    securityLog(`拼接后前缀校验失败：${dir}（root=${store.root}）`);
    throw permissionDenied();
  }
  return { name: norm.name, dir };
}

function findFile(dir, seq, variant) {
  const wantTranslated = variant === 'translated';
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const f of names) {
    const m = wantTranslated ? TRANSLATED_SCAN_RE.exec(f) : ORIGINAL_SCAN_RE.exec(f);
    if (m && Number(m[1]) === seq) return f;
  }
  return null;
}

function handleLibraryFile(req, res, cors, rawName, seqText, url) {
  const { dir } = resolveComicDir(rawName);
  const seq = Number.parseInt(seqText, 10);
  if (!Number.isFinite(seq) || seq < 1 || seq > 999) {
    throw new ApiError('INVALID_IMAGE', 'seq 必须是 1–999 的整数', { seq: seqText });
  }
  const variant = url.searchParams.get('variant') || 'translated';
  if (!['original', 'translated'].includes(variant)) {
    throw new ApiError('INVALID_IMAGE', 'variant 只能是 original 或 translated', { variant });
  }
  const name = findFile(dir, seq, variant);
  if (!name) {
    throw new ApiError('TASK_NOT_FOUND', '漫画库中找不到该文件', {
      comicName: path.basename(dir), seq, variant, root: store.root,
    });
  }
  const file = path.join(dir, name);
  try {
    assertInsideRoot(store.root, file); // 打开文件前再校验一次（防 TOCTOU）
  } catch {
    securityLog(`文件读取越界：${file}`);
    throw permissionDenied();
  }
  const ext = name.split('.').pop().toLowerCase();
  const stat = fs.statSync(file);
  res.writeHead(200, {
    ...cors,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `inline; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

function handleReveal(req, res, cors, rawName) {
  const { dir, name } = resolveComicDir(rawName);
  if (!fs.existsSync(dir)) {
    throw new ApiError('TASK_NOT_FOUND', '漫画目录不存在', { comicName: name, outputDir: dir });
  }
  // mock 不真的打开系统文件管理器，但必须完成路径校验
  sendJson(res, 200, { ok: true, path: dir, comicName: name }, cors);
}

// ------------------------------------------------------------------ 路由

function splitPath(pathname) {
  return pathname.split('/').filter((s) => s.length > 0).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

async function route(req, res, cors, url) {
  const seg = splitPath(url.pathname);
  const method = req.method || 'GET';

  // GET /health —— 唯一免鉴权
  if (seg.length === 3 && seg[0] === 'api' && seg[1] === API_VERSION && seg[2] === 'health' && method === 'GET') {
    return sendJson(res, 200, await healthView(), cors);
  }
  // 兼容 /api/v1 之外的健康探测
  if (seg.length === 1 && seg[0] === 'health' && method === 'GET') {
    return sendJson(res, 200, await healthView(), cors);
  }

  if (seg[0] !== 'api' || seg[1] !== API_VERSION) {
    throw new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });
  }
  const p = seg.slice(2);

  // /tasks
  if (p.length === 1 && p[0] === 'tasks') {
    if (method === 'POST') return handleCreateTask(req, res, cors);
    if (method === 'GET') return handleTaskList(req, res, cors, url);
    throw new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });
  }
  // /tasks/{taskId}
  if (p.length === 2 && p[0] === 'tasks') {
    if (method === 'GET') return handleTaskDetail(req, res, cors, p[1], url);
    throw new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });
  }
  // /tasks/{taskId}/batches | events | cancel
  if (p.length === 3 && p[0] === 'tasks') {
    if (p[2] === 'batches' && method === 'POST') return handleAppendBatch(req, res, cors, p[1]);
    if (p[2] === 'events' && method === 'GET') return handleSse(req, res, cors, p[1]);
    if (p[2] === 'cancel' && method === 'POST') return handleCancel(req, res, cors, p[1]);
    throw new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });
  }

  // /queue
  if (p.length === 1 && p[0] === 'queue' && method === 'GET') {
    return handleQueue(req, res, cors);
  }

  // /library
  if (p.length === 1 && p[0] === 'library' && method === 'GET') {
    return sendJson(res, 200, scanLibrary(), cors);
  }
  // /library/{comicName}/files/{seq}
  if (p.length === 4 && p[0] === 'library' && p[2] === 'files' && method === 'GET') {
    return handleLibraryFile(req, res, cors, p[1], p[3], url);
  }
  // /library/{comicName}/reveal
  if (p.length === 3 && p[0] === 'library' && p[2] === 'reveal' && method === 'POST') {
    return handleReveal(req, res, cors, p[1]);
  }

  throw new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });
}

// ------------------------------------------------------------------ 请求入口

function createHandler() {
  return async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const origin = checkOrigin(req.headers.origin);
    const cors = corsHeaders(origin.allow);
    const client = req.headers['x-box-client'] || '-';
    const isHealth = /^\/(api\/v1\/)?health$/.test(url.pathname);

    try {
      // 1) Origin 校验（含 Origin 才校验）
      if (!origin.ok) {
        securityLog(`Origin 拒绝：${req.headers.origin}；${req.method} ${url.pathname}；client=${client}`);
        throw permissionDenied();
      }
      // 2) CORS 预检：multipart/form-data 属简单请求不触发预检，预检不作为安全边界
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }
      // 3) 鉴权（/health 豁免）
      if (!isHealth && !tokenMatches(req.headers['x-box-token'])) {
        securityLog(`令牌校验失败：${req.method} ${url.pathname}；client=${client}`);
        throw permissionDenied();
      }
      return await route(req, res, cors, url);
    } catch (err) {
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        console.error('[box-service] 响应已开始后出错：', err);
        return;
      }
      return sendError(res, err, cors);
    }
  };
}

// ------------------------------------------------------------------ 监听

function listenOnce(handler, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    // 本地服务的长连接策略：Node 默认 keepAliveTimeout=5s，而客户端（浏览器 fetch / 插件）
    // 会复用空闲连接——当两端对「空闲多久算超时」的预期不一致时，就会出现
    // 「服务端已关闭、客户端仍复用该 socket」的 ECONNRESET 竞态。
    // 把服务端超时抬到 65s（远大于任何客户端的空闲预期），从根上避免这一类随机失败。
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

/** §1：默认 5180；被占时在 5180–5190 内探测；全段被占则启动失败 */
async function listenWithProbe(handler) {
  const candidates = config.explicitPort !== null
    ? [config.explicitPort]
    : Array.from({ length: config.portEnd - config.portStart + 1 }, (_, i) => config.portStart + i);

  let lastErr = null;
  for (const port of candidates) {
    try {
      const server = await listenOnce(handler, port);
      return { server, port };
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        serverLog(`端口 ${port} 被占用，尝试下一个…`);
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  const range = config.explicitPort !== null
    ? `${config.explicitPort}（MIAO_PORT 指定）`
    : `${config.portStart}–${config.portEnd}`;
  throw new Error(
    `端口 ${range} 全部被占用，box-service 启动失败（不静默换到段外）。最后错误：${lastErr && lastErr.message}`);
}

const { server, port } = await listenWithProbe(createHandler());
store.port = port;

const heartbeatTimer = setInterval(() => store.broadcastHeartbeat(), HEARTBEAT_MS);
heartbeatTimer.unref?.();

const sidecar = await sidecarState();

serverLog('================ 喵坞 box-service 已启动 ================');
serverLog(`监听地址   : http://127.0.0.1:${port}${BASE_PATH}`);
serverLog(`令牌       : ${config.token}`);
serverLog(`令牌文件   : ${TOKEN_FILE}`);
serverLog(`落盘根目录 : ${store.root}`);
serverLog(`状态目录   : ${STATE_DIR}`);
serverLog(`sidecar    : ${sidecar.state} port=${sidecar.port ?? '-'} engine=${sidecar.engine ?? '-'}`);
serverLog(`失败注入   : FAIL_SEQ=[${[...config.failSeqs].join(',')}] ITEM_FAIL_RATE=${config.itemFailRate} `
  + `DISK_FULL=${config.diskFull} SIDECAR_DOWN=${config.sidecarDown} SKIP_EXISTING=${config.skipExisting}`);
if (restore.restored > 0) {
  serverLog(`任务清单恢复：${restore.restored} 个（其中 ${restore.aborted} 个非终态任务已按 failed 收尾）`);
}
// 机器可读的就绪行：桌面端 Rust 层据此拿到端口与令牌，不必去猜端口段或读文件
serverLog(`MIAO_READY ${JSON.stringify({ port, token: config.token, rootDir: store.root })}`);
serverLog('=========================================================');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    serverLog(`收到 ${sig}，关闭中…`);
    clearInterval(heartbeatTimer);
    server.close(() => process.exit(0));
    // 兜底：SSE 长连接可能让 close 回调迟迟不触发
    setTimeout(() => process.exit(0), 500).unref();
  });
}
