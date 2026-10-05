#!/usr/bin/env node
/**
 * model-store-check.mjs —— S3 模型下载器的 E7 验收（正向 + 反证）
 * =============================================================================
 * E7 原文（交付计划 §4.1-S3）：**中断续传成功；篡改一字节 → SHA256 失败 → 自动重下**。
 *
 * 取证方式：起一个**真 HTTP 服务器**（不是打桩）当模型源，它能：
 *   · 支持 / 忽略 `Range`（两条路都要验：206 追加 vs 200 全量必须重新计）
 *   · 在指定字节数处**切断连接**（制造真中断，不是"返回错误码"假装中断）
 *   · 篡改自己吐出的字节（制造"内容坏了"，且不影响请求成功）
 *   · 记录每一条收到的请求（路径 + Range 头）—— 判"是否真续传"靠它，不靠日志文字
 *
 * 🔴 本脚本的核心纪律：正向与反证**共用同一套 `scn*` 事实函数与 `PRED` 谓词**。
 *    若反证另写一遍实现，它证明的就是另一件事了（本项目"两条反证共用一条断言"的变体）。
 *
 * 用法：node engine/scripts/model-store-check.mjs [--refute]
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  ensureModels, verifyModels, linkModels, sha256File, readMarker, statSafe,
  ModelStoreError, REDOWNLOAD_LIMIT, READY_MARKER, PART_SUFFIX,
} from '../model-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const REFUTE = process.argv.includes('--refute');
// 临时根按模式分家：正向轮与反证轮会各自 freshRoot() 掉同名子目录，
// 共用根目录时两轮并行跑会互删对方的落盘（症状：正向轮报 ENOENT .../resume/big.bin）。
const TMP = path.join(REPO, '.tmp-models', REFUTE ? 'refute' : 'pos');

// ------------------------------------------------------------------ 断言收集

const results = [];
let group = '';
const setGroup = (g) => { group = g; console.log(`\n${g}`); };
function add(id, ok, detail = '') {
  results.push({ group, id, ok: !!ok });
  console.log(`  ${ok ? '✓' : '✗'} ${id}${detail ? `  ${detail}` : ''}`);
}

// ------------------------------------------------------------------ 夹具服务器

const CHUNK = 64 * 1024;

async function startFixture() {
  const routes = new Map();
  const requests = [];

  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    requests.push({ path: p, range: req.headers.range ?? null });
    const st = routes.get(p);
    if (!st) { res.writeHead(404, { 'Content-Length': '0' }).end(); return; }
    if (st.failTimes > 0) { st.failTimes -= 1; res.writeHead(500, { 'Content-Length': '4' }).end('boom'); return; }

    let body = st.buf;
    if (st.corruptTimes > 0 && st.corruptAt != null) {
      st.corruptTimes -= 1;
      body = Buffer.from(body);
      body[st.corruptAt] ^= 0xff; // 翻一个字节 —— 大小不变，只有哈希会变
    }

    const total = body.length;
    let start = 0; let status = 200; let contentRange = null;
    const rm = req.headers.range ? /^bytes=(\d+)-(\d*)$/.exec(req.headers.range) : null;
    if (rm && st.supportsRange) {
      start = Number(rm[1]);
      if (start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Content-Length': '0' }).end();
        return;
      }
      status = 206;
      contentRange = `bytes ${start}-${total - 1}/${total}`;
    }
    const slice = body.subarray(start);
    const headers = { 'Content-Length': String(slice.length) };
    if (contentRange) headers['Content-Range'] = contentRange;
    res.writeHead(status, headers);

    // 真中断：把 Content-Length 声明满，但只写一部分就 destroy 掉 socket
    const cut = st.cutTimes > 0 && st.cutAfter != null;
    if (cut) st.cutTimes -= 1;
    const limit = cut ? Math.min(st.cutAfter, slice.length) : slice.length;
    let i = 0;
    const pump = () => {
      if (i >= limit) {
        if (cut && limit < slice.length) { res.socket.destroy(); return; }
        res.end();
        return;
      }
      const n = Math.min(CHUNK, limit - i);
      const ok = res.write(slice.subarray(i, i + n));
      i += n;
      if (ok) setImmediate(pump); else res.once('drain', pump);
    };
    pump();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    def(p, opts) {
      routes.set(p, {
        supportsRange: true, cutAfter: null, cutTimes: 0,
        corruptAt: null, corruptTimes: 0, failTimes: 0, ...opts,
      });
    },
    count(p) { return requests.filter((r) => r.path === p).length; },
    ranged(p) { return requests.filter((r) => r.path === p && r.range).length; },
    close: () => new Promise((r) => server.close(r)),
  };
}

// ------------------------------------------------------------------ 夹具数据

function makeBytes(n, seed) {
  const buf = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i += 1) { x = (x * 1664525 + 1013904223) >>> 0; buf[i] = x >>> 24; }
  return buf;
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function freshRoot(name) {
  const root = path.join(TMP, name);
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(root, { recursive: true });
  return root;
}

function fixtureManifest(fx, entries) {
  return {
    manifestVersion: 999,
    engineCommit: 'fixture',
    sets: { all: { files: entries.map((e) => e.id) } },
    files: entries.map((e) => ({
      id: e.id,
      set: 'all',
      dest: e.dest ?? `${e.id}.bin`,
      ...(e.linkTo ? { linkTo: e.linkTo } : {}),
      sha256: e.sha256,
      sizeBytes: e.sizeBytes,
      url: `${fx.base}${e.path}`,
      sources: [`${fx.base}${e.path}`],
    })),
  };
}

// ------------------------------------------------------------------ 场景（返回事实）

/** A/B：首次下载 + 校验 + .ready；随后幂等复用 */
async function scnFreshIdempotent(fx, alpha, beta) {
  const root = await freshRoot('fresh');
  fx.def('/alpha', { buf: alpha.buf });
  fx.def('/beta', { buf: beta.buf });
  const m = fixtureManifest(fx, [alpha, beta]);

  const events = [];
  const r1 = await ensureModels(m, {
    rootDir: root, integrity: 'hash',
    onProgress: (p) => events.push({ ...p }),
    logger: () => {},
  });
  const destA = path.join(root, 'alpha.bin');
  const hashA = await sha256File(destA);
  const marker = await readMarker(root);
  const st = await fsp.stat(destA);

  const before = fx.requests.length;
  const r2 = await ensureModels(m, { rootDir: root, integrity: 'cached', logger: () => {} });
  const newRequests = fx.requests.length - before;

  // 进度单调性：只看向上走、且终值等于文件大小
  const sizes = events.filter((e) => e.id === 'alpha' && e.phase === 'downloading').map((e) => e.received);
  const monotonic = sizes.every((v, i) => i === 0 || v >= sizes[i - 1]);
  const totals = events.filter((e) => e.id === 'alpha' && e.phase === 'downloading').map((e) => e.total);

  return {
    downloaded: r1.downloaded, reused1: r1.reused, bytes: r1.bytes,
    hashOk: hashA === alpha.sha256, sizeOk: st.size === alpha.sizeBytes, size: st.size,
    markerExists: !!marker,
    markerHashOk: marker?.files?.alpha?.sha256 === alpha.sha256,
    markerSizeOk: marker?.files?.alpha?.sizeBytes === alpha.sizeBytes,
    reused2: r2.reused, downloaded2: r2.downloaded, newRequests,
    progressMonotonic: monotonic, progressFinal: sizes.at(-1) ?? -1,
    progressTotalOk: totals.length > 0 && totals.every((t) => t === alpha.sizeBytes),
    progressEvents: sizes.length,
    markerPath: path.join(root, READY_MARKER),
    root,
  };
}

/** C：中断续传（源支持 Range；在 400KB 处切断一次） */
async function scnResume(fx, big) {
  const root = await freshRoot('resume');
  fx.def('/big', { buf: big.buf, cutAfter: 400 * 1024, cutTimes: 1 });
  const m = fixtureManifest(fx, [big]);

  const r = await ensureModels(m, { rootDir: root, integrity: 'hash', logger: () => {} });
  const dest = path.join(root, 'big.bin');
  const st = await fsp.stat(dest);
  const hashOk = (await sha256File(dest)) === big.sha256;
  const partLeft = fs.existsSync(`${dest}${PART_SUFFIX}`);

  return {
    hashOk, sizeOk: st.size === big.sizeBytes, size: st.size,
    rangedRequests: fx.ranged('/big'), requests: fx.count('/big'),
    resumedFrom: r.resumeFrom.big ?? 0, partLeft, downloaded: r.downloaded,
  };
}

/** D：源**不支持** Range（发了 Range 也回 200）⇒ 必须截断重来，不能追加 */
async function scnNoRange(fx, big) {
  const root = await freshRoot('norange');
  fx.def('/big', { buf: big.buf, supportsRange: false, cutAfter: 400 * 1024, cutTimes: 1 });
  const m = fixtureManifest(fx, [big]);

  const r = await ensureModels(m, { rootDir: root, integrity: 'hash', logger: () => {} });
  const dest = path.join(root, 'big.bin');
  const st = await fsp.stat(dest);
  const hashOk = (await sha256File(dest)) === big.sha256;

  return {
    hashOk, sizeOk: st.size === big.sizeBytes, size: st.size,
    rangedRequests: fx.ranged('/big'),      // 我们发了 Range，但对方回 200
    requests: fx.count('/big'),
    resumedFrom: r.resumeFrom.big ?? 0,     // 必须为 0（重新计）
  };
}

/** E：篡改一字节 → 检出 → 自动重下；且**只有**被篡改的那个文件重下 */
async function scnTamper(fx, alpha, beta) {
  const root = await freshRoot('tamper');
  fx.def('/alpha', { buf: alpha.buf });
  fx.def('/beta', { buf: beta.buf });
  const m = fixtureManifest(fx, [alpha, beta]);

  await ensureModels(m, { rootDir: root, integrity: 'hash', logger: () => {} });
  const destA = path.join(root, 'alpha.bin');
  const betaBefore = await fsp.stat(path.join(root, 'beta.bin'));

  // 篡改一字节（大小不变；mtime 会变）
  const raw = await fsp.readFile(destA);
  raw[1024] ^= 0xff;
  await fsp.writeFile(destA, raw);
  const tamperedHash = await sha256File(destA);

  const reqAlphaBefore = fx.count('/alpha');
  const reqBetaBefore = fx.count('/beta');

  const r = await ensureModels(m, { rootDir: root, integrity: 'hash', logger: () => {} });
  const fixed = await sha256File(destA);
  const betaAfter = await fsp.stat(path.join(root, 'beta.bin'));

  return {
    tamperActuallyChanged: tamperedHash !== alpha.sha256,
    detected: r.redownloaded.includes('alpha'),
    redownloaded: r.redownloaded,
    fixed: fixed === alpha.sha256,
    alphaRefetched: fx.count('/alpha') - reqAlphaBefore,
    betaRefetched: fx.count('/beta') - reqBetaBefore,
    betaUntouched: betaAfter.mtimeMs === betaBefore.mtimeMs && betaAfter.size === betaBefore.size,
  };
}

/** F：源内容本身就是坏的 ⇒ 重下到位后必须**报错**，不得静默接受 */
async function scnAlwaysBad(fx, alpha) {
  const root = await freshRoot('alwaysbad');
  fx.def('/alpha', { buf: alpha.buf, corruptAt: 512, corruptTimes: 99 });
  const m = fixtureManifest(fx, [alpha]);
  const before = fx.count('/alpha');

  let code = null; let msg = '';
  try {
    await ensureModels(m, { rootDir: root, integrity: 'hash', logger: () => {} });
  } catch (e) { code = e?.code ?? e?.name; msg = e?.message ?? String(e); }

  return {
    code, msg,
    threw: code === 'MODEL_SHA256_MISMATCH',
    fetchCount: fx.count('/alpha') - before,
    expectedFetchCount: REDOWNLOAD_LIMIT + 1,
    leftover: fs.existsSync(path.join(root, 'alpha.bin')),
  };
}

/** G：可暂停（AbortSignal）→ .part 留存 → 再跑从断点恢复 */
async function scnAbortResume(fx, big) {
  const root = await freshRoot('abort');
  fx.def('/big', { buf: big.buf });
  const m = fixtureManifest(fx, [big]);
  const dest = path.join(root, 'big.bin');
  const part = `${dest}${PART_SUFFIX}`;

  const ac = new AbortController();
  let aborted = false; let code = null;
  try {
    await ensureModels(m, {
      rootDir: root, integrity: 'hash', signal: ac.signal, logger: () => {},
      onProgress: (p) => {
        if (!aborted && p.phase === 'downloading' && p.received > 300 * 1024) { aborted = true; ac.abort(); }
      },
    });
  } catch (e) { code = e?.code ?? e?.name; }

  const partSize = fs.existsSync(part) ? (await fsp.stat(part)).size : 0;
  const destExistsAfterAbort = fs.existsSync(dest);

  const r = await ensureModels(m, { rootDir: root, integrity: 'hash', logger: () => {} });
  const hashOk = (await sha256File(dest)) === big.sha256;
  const st = await fsp.stat(dest);

  return {
    aborted: code === 'MODEL_ABORTED',
    code, partSize, destExistsAfterAbort,
    resumedFrom: r.resumeFrom.big ?? 0, hashOk, sizeOk: st.size === big.sizeBytes,
    partLeft: fs.existsSync(part),
  };
}

/** H：纯离线校验（不联网） */
async function scnVerifyOffline(fx, alpha) {
  const root = path.join(TMP, 'fresh'); // 复用 A 的结果
  const m = fixtureManifest(fx, [alpha]);
  const before = fx.requests.length;
  const ok1 = await verifyModels(m, { rootDir: root });

  const dest = path.join(root, 'alpha.bin');
  const raw = await fsp.readFile(dest);
  raw[2048] ^= 0xff;
  await fsp.writeFile(dest, raw);
  const ok2 = await verifyModels(m, { rootDir: root });

  return {
    cleanOk: ok1.ok.includes('alpha') && ok1.bad.length === 0 && ok1.missing.length === 0,
    dirtyOk: ok2.bad.some((b) => b.id === 'alpha'),
    noNetwork: fx.requests.length === before,
  };
}

/**
 * N：store + 硬链接 —— **引擎换版本不重下模型**
 * 模拟真实现状：引擎把模型路径硬编码在源码树里（BASE_PATH/models），
 * 于是"换版本"= 整棵 `src/` 被删掉再解包。权威副本在 store，引擎树里那份只是硬链接。
 */
async function scnRelink(fx, alpha) {
  const root = await freshRoot('relink');
  const linkBase = path.join(root, 'engine-src'); // 扮演引擎源码树 src/
  fx.def('/alpha', { buf: alpha.buf });
  const entry = { ...alpha, dest: 'store/alpha.bin', linkTo: 'models/alpha.bin' };
  const m = fixtureManifest(fx, [entry]);

  await ensureModels(m, { rootDir: root, integrity: 'hash', logger: () => {} });
  const link1 = await linkModels(m, { rootDir: root, linkBase });

  const enginePath = path.join(linkBase, 'models/alpha.bin');
  const storePath = path.join(root, 'store/alpha.bin');
  const s1 = await statSafe(enginePath);
  const s0 = await statSafe(storePath);
  const sameInode = !!s1 && !!s0 && s1.ino === s0.ino && s1.dev === s0.dev;

  // —— 模拟「引擎换版本」：整棵源码树被删除（模型也跟着没了）
  await fsp.rm(linkBase, { recursive: true, force: true });

  const before = fx.requests.length;
  const link2 = await linkModels(m, { rootDir: root, linkBase });
  const newRequests = fx.requests.length - before; // 这一步**必须**是 0
  const restoredOk = fs.existsSync(enginePath) ? (await sha256File(enginePath)) === alpha.sha256 : false;
  const storeIntact = (await sha256File(storePath)) === alpha.sha256;

  return {
    linked1: link1.linked, copied1: link1.copied, sameInode,
    relinked2: link2.linked, restoredOk, newRequests, storeIntact,
  };
}

/** I：多源回退（第一个源 500 → 换第二个源） */async function scnFallback(fx, alpha) {
  const root = await freshRoot('fallback');
  fx.def('/bad', { buf: alpha.buf, failTimes: 99 });
  fx.def('/good', { buf: alpha.buf });
  const m = {
    manifestVersion: 999, engineCommit: 'fixture', sets: {},
    files: [{
      id: 'alpha', set: 'all', dest: 'alpha.bin',
      sha256: alpha.sha256, sizeBytes: alpha.sizeBytes,
      url: `${fx.base}/bad`, sources: [`${fx.base}/bad`, `${fx.base}/good`],
    }],
  };
  const r = await ensureModels(m, { rootDir: root, integrity: 'hash', logger: () => {} });
  const hashOk = (await sha256File(path.join(root, 'alpha.bin'))) === alpha.sha256;
  return { hashOk, downloaded: r.downloaded, badTried: fx.count('/bad'), goodUsed: fx.count('/good') };
}

// ------------------------------------------------------------------ 谓词（正反两轮共用）

const PRED = {
  'E7-1a 中断后仍下成完整正确的文件': (f) => f.hashOk && f.sizeOk,
  'E7-1b 续传确实发了 Range（不是整包重来）': (f) => f.rangedRequests > 0,
  'E7-1c 续传起点 = 已落盘的部分': (f) => f.resumedFrom > 0,
  'E7-1d 断点文件不残留': (f) => !f.partLeft,
  'E7-2a 篡改一字节被检出并标记重下': (f) => f.detected,
  'E7-2b 重下后哈希恢复正确': (f) => f.fixed,
  'E7-2c 源内容坏到修不好 → 必须报错，不静默接受': (f) => f.threw,
  'E7-3a .ready 幂等标记存在且记录与清单一致': (f) => f.markerExists && f.markerHashOk && f.markerSizeOk,
  'E7-3b 第二次运行不联网（全复用）': (f) => f.newRequests === 0 && f.downloaded2.length === 0,
  'E7-4a 引擎树里那份是与 store 同一 inode 的硬链接': (f) => f.sameInode && f.linked1.includes('alpha'),
  'E7-4b 换版本（src/ 整棵被删）后重链即恢复且哈希正确': (f) => f.relinked2.includes('alpha') && f.restoredOk,
  'E7-4c 重链全程 0 次网络请求（这就是"换版本不重下"）': (f) => f.newRequests === 0,
};

/** 取谓词并在缺失时**立刻炸**：拼错名字不该退化成"静默跳过"。 */
function P(name) {
  const fn = PRED[name];
  if (!fn) throw new Error(`未定义的谓词：${name}`);
  return fn;
}

// ------------------------------------------------------------------ 主流程

async function main() {
  await fsp.mkdir(TMP, { recursive: true });
  const fx = await startFixture();

  const alpha = { id: 'alpha', path: '/alpha', buf: makeBytes(1500 * 1024, 11) };
  const beta = { id: 'beta', path: '/beta', buf: makeBytes(512 * 1024, 22) };
  const big = { id: 'big', path: '/big', buf: makeBytes(2048 * 1024, 33) };
  for (const o of [alpha, beta, big]) { o.sha256 = sha(o.buf); o.sizeBytes = o.buf.length; }

  if (!REFUTE) {
    console.log('S3 模型下载器 · E7 验收（正向轮）');
    console.log(`  夹具源：${fx.base} · 夹具文件 alpha 1.5MB / beta 0.5MB / big 2MB`);

    setGroup('【A】首次下载 + 校验 + 幂等');
    const fresh = await scnFreshIdempotent(fx, alpha, beta);
    add('A1 两个文件都下成且哈希正确', fresh.downloaded.length === 2 && fresh.hashOk,
      `downloaded=${fresh.downloaded.join(',')} hashOk=${fresh.hashOk}`);
    add('A2 落盘大小等于清单大小', fresh.sizeOk, `size=${fresh.size}`);
    add('A3 进度按文件单调递增，且 total 等于文件大小', fresh.progressMonotonic && fresh.progressTotalOk,
      `事件 ${fresh.progressEvents} 条，终值 ${fresh.progressFinal}`);
    add('E7-3a .ready 幂等标记存在且记录与清单一致',
      PRED['E7-3a .ready 幂等标记存在且记录与清单一致'](fresh),
      `marker=${fresh.markerExists} hash=${fresh.markerHashOk} size=${fresh.markerSizeOk}`);
    add('E7-3b 第二次运行不联网（全复用）',
      PRED['E7-3b 第二次运行不联网（全复用）'](fresh),
      `新请求 ${fresh.newRequests} 次 · 复用 ${fresh.reused2.length} 个`);

    setGroup('【B】E7-1 中断续传（真切 socket）');
    const resume = await scnResume(fx, big);
    add('E7-1a 中断后仍下成完整正确的文件', PRED['E7-1a 中断后仍下成完整正确的文件'](resume),
      `size=${resume.size} hashOk=${resume.hashOk}`);
    add('E7-1b 续传确实发了 Range（不是整包重来）', PRED['E7-1b 续传确实发了 Range（不是整包重来）'](resume),
      `Range 请求 ${resume.rangedRequests} 次 / 共 ${resume.requests} 次`);
    add('E7-1c 续传起点 = 已落盘的部分', PRED['E7-1c 续传起点 = 已落盘的部分'](resume),
      `resumedFrom=${resume.resumedFrom}`);
    add('E7-1d 断点文件不残留', PRED['E7-1d 断点文件不残留'](resume), `partLeft=${resume.partLeft}`);

    setGroup('【C】源不支持 Range ⇒ 必须截断重来（不能追加到 .part 后面）');
    const noRange = await scnNoRange(fx, big);
    add('C1 对方回 200 时仍下成正确文件', noRange.hashOk, `hashOk=${noRange.hashOk}`);
    add('C2 大小**没有**被追加成 2×（这正是"整包当续传"会出的错）', noRange.sizeOk && noRange.resumedFrom === 0,
      `size=${noRange.size}（期望 ${big.sizeBytes}）resumedFrom=${noRange.resumedFrom}`);

    setGroup('【D】E7-2 篡改一字节 → SHA256 失败 → 自动重下');
    const tamper = await scnTamper(fx, alpha, beta);
    add('D1 篡改前后哈希确实变了（先证明夹具真的破坏了内容）', tamper.tamperActuallyChanged, '');
    add('E7-2a 篡改一字节被检出并标记重下', PRED['E7-2a 篡改一字节被检出并标记重下'](tamper),
      `redownloaded=${tamper.redownloaded.join(',')}`);
    add('E7-2b 重下后哈希恢复正确', PRED['E7-2b 重下后哈希恢复正确'](tamper), `fixed=${tamper.fixed}`);
    add('D4 只有被篡改的那个文件重下（失败**单文件**重下）',
      tamper.alphaRefetched > 0 && tamper.betaRefetched === 0 && tamper.betaUntouched,
      `alpha 重取 ${tamper.alphaRefetched} 次 · beta 重取 ${tamper.betaRefetched} 次 · beta 未被动过=${tamper.betaUntouched}`);

    setGroup('【E】源内容修不好 ⇒ 重下到位后必须报错');
    const bad = await scnAlwaysBad(fx, alpha);
    add('E7-2c 源内容坏到修不好 → 必须报错，不静默接受', PRED['E7-2c 源内容坏到修不好 → 必须报错，不静默接受'](bad),
      `code=${bad.code}`);
    add('E2 重试次数 = 1 + REDOWNLOAD_LIMIT（不无限重试）', bad.fetchCount === bad.expectedFetchCount,
      `实际 ${bad.fetchCount} 次（期望 ${bad.expectedFetchCount}）`);
    add('E3 失败时不留半好文件（不留下会被静默使用的坏模型）', !bad.leftover, `leftover=${bad.leftover}`);

    setGroup('【F】可暂停 / 恢复');
    const ab = await scnAbortResume(fx, big);
    add('F1 中止只吐一个错误码 MODEL_ABORTED', ab.aborted, `code=${ab.code}`);
    add('F2 中止后 .part 留存（断点就是它）', ab.partSize > 0 && ab.partSize < big.sizeBytes,
      `part=${ab.partSize} / ${big.sizeBytes}`);
    add('F3 中止后不留半截正式文件', !ab.destExistsAfterAbort, '');
    add('F4 再跑从断点恢复并下成正确文件',
      ab.resumedFrom > 0 && ab.hashOk && ab.sizeOk && !ab.partLeft,
      `resumedFrom=${ab.resumedFrom} hashOk=${ab.hashOk}`);

    setGroup('【G】纯离线校验（诊断口径）');
    const vf = await scnVerifyOffline(fx, alpha);
    add('G1 干净文件 → ok，且不联网', vf.cleanOk && vf.noNetwork, `noNetwork=${vf.noNetwork}`);
    add('G2 被篡改文件 → bad（不上网也能判出来）', vf.dirtyOk, '');

    setGroup('【H】多源回退');
    const fb = await scnFallback(fx, alpha);
    add('H1 第一个源 500 → 自动换第二个源并下成', fb.hashOk && fb.goodUsed > 0,
      `bad 尝试 ${fb.badTried} 次 · good 用上 ${fb.goodUsed} 次`);

    setGroup('【N】引擎换版本不重下模型（store + 硬链接）');
    const rl = await scnRelink(fx, alpha);
    add('E7-4a 引擎树里那份是与 store 同一 inode 的硬链接', P('E7-4a 引擎树里那份是与 store 同一 inode 的硬链接')(rl),
      `新建 ${rl.linked1.length} 个 · 复制 ${rl.copied1.length} 个（复制=退化了，不是链接）`);
    add('E7-4b 换版本（src/ 整棵被删）后重链即恢复且哈希正确', P('E7-4b 换版本（src/ 整棵被删）后重链即恢复且哈希正确')(rl),
      `重链 ${rl.relinked2.length} 个 · 恢复后哈希正确=${rl.restoredOk}`);
    add('E7-4c 重链全程 0 次网络请求（这就是"换版本不重下"）', P('E7-4c 重链全程 0 次网络请求（这就是"换版本不重下"）')(rl),
      `新请求 ${rl.newRequests} 次`);
    add('N4 store 权威副本未被牵连', rl.storeIntact, '');

    setGroup('【M】真实清单自洽');
    const real = JSON.parse(fs.readFileSync(path.join(REPO, 'engine', 'models.manifest.json'), 'utf8'));
    const ids = real.files.map((f) => f.id);
    const required = ['id', 'dest', 'sha256', 'sizeBytes', 'url'];
    const fieldsOk = real.files.every((f) => required.every((k) => f[k] != null));
    const shaOk = real.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256));
    const setsOk = Object.values(real.sets).every((s) => s.files.every((id) => ids.includes(id)));
    add('M1 逐条字段齐备', fieldsOk, `共 ${real.files.length} 条`);
    add('M2 sha256 全是 64 位小写十六进制', shaOk, '');
    add('M3 sets 引用的 id 都存在', setsOk, Object.keys(real.sets).join(' / '));

    await fx.close();
  } else {
    console.log('S3 模型下载器 · E7 反证轮');
    console.log('（每个开关都必须让**某一条具名断言**变红；红不了就说明那条断言是摆设）');

    const refutes = [
      {
        id: 'R1', env: 'MIAO_NO_MODEL_VERIFY', desc: '关掉 SHA256 校验',
        target: 'E7-2a 篡改一字节被检出并标记重下',
        run: async () => scnTamper(fx, alpha, beta),
      },
      {
        id: 'R2', env: 'MIAO_NO_RESUME', desc: '关掉断点续传（每次从 0 全量下）',
        target: 'E7-1b 续传确实发了 Range（不是整包重来）',
        run: async () => scnResume(fx, big),
      },
      {
        id: 'R3', env: 'MIAO_NO_READY', desc: '关掉 .ready 幂等标记',
        target: 'E7-3a .ready 幂等标记存在且记录与清单一致',
        run: async () => scnFreshIdempotent(fx, alpha, beta),
      },
      {
        id: 'R4', env: 'MIAO_NO_MODEL_VERIFY', desc: '关掉校验后，坏源也不会被拦下',
        target: 'E7-2c 源内容坏到修不好 → 必须报错，不静默接受',
        run: async () => scnAlwaysBad(fx, alpha),
      },
      {
        id: 'R5', env: 'MIAO_NO_LINK', desc: '关掉"把 store 链进引擎树"这一步',
        target: 'E7-4b 换版本（src/ 整棵被删）后重链即恢复且哈希正确',
        run: async () => scnRelink(fx, alpha),
      },
    ];

    let redCount = 0;
    for (const r of refutes) {
      process.env[r.env] = '1';
      let facts; let err = null;
      try { facts = await r.run(); } catch (e) { err = e; }
      delete process.env[r.env];

      const predicate = PRED[r.target];
      if (!predicate) throw new Error(`反证 ${r.id} 指定的断言不存在：${r.target}`);
      const wouldBeGreen = err ? false : predicate(facts);
      const turnedRed = !wouldBeGreen;
      if (turnedRed) redCount += 1;
      console.log(`\n🔴 ${r.id} · ${r.desc}（${r.env}=1）`);
      console.log(`   目标断言：${r.target}`);
      console.log(`   ${turnedRed ? '✓ 按预期变红' : '✗ 竟然还是绿的 —— 这条断言抓不住该机制'}`);
      if (err) console.log(`   （场景自身抛错：${err.message}）`);
    }

    await fx.close();

    console.log(`\n${'─'.repeat(56)}`);
    const expected = refutes.length;
    console.log(`反证：${redCount} / ${expected} 条按预期变红（应执行 ${expected}）`);
    if (redCount !== expected) {
      console.log('✗ 有反证没变红 ⇒ 对应断言无效，不得算通过。');
      process.exit(1);
    }
    console.log('✓ 全部反证成立：每条断言都能捕捉到它声称捕捉的机制。');
    // ⚠️ R1 与 R4 共用同一个开关，但打的是**两条不同的断言**（检出篡改 / 坏源必须报错）。
    //    它们不是"两条反证共用一条断言"，而是"一个开关的两处作用面"——两条判据各自独立。
    console.log('注：R1/R4 共用开关 MIAO_NO_MODEL_VERIFY，但目标是两条互相独立的判据。');
    return;
  }

  // ------------------------------------------------------------------ 汇总
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n${'─'.repeat(56)}`);
  const EXPECTED_TOTAL = 32;
  if (results.length !== EXPECTED_TOTAL) {
    console.log(`✗ 断言条数 ${results.length} ≠ 写死的 ${EXPECTED_TOTAL}（分母必须写死并断言）`);
    process.exit(1);
  }
  console.log(`通过 ${pass} / 失败 ${fail}（分母写死 ${EXPECTED_TOTAL}）`);
  if (fail) {
    console.log('✗ 有失败项：先判断是"实现漏了"还是"断言写错了"，不要为了转绿而放宽断言。');
    process.exit(1);
  }
  console.log('✓ 全部通过。');
}

main().catch((e) => {
  if (e instanceof ModelStoreError) console.error(`\n✗ [${e.code}] ${e.message}`);
  else console.error(`\n✗ ${e.stack || e.message}`);
  process.exit(1);
});
