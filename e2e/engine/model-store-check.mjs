#!/usr/bin/env node
/**
 * model-store-check.mjs —— S3 模型下载器的 E7 验收（正向 + 反证）· **双靶**
 * =============================================================================
 * E7 原文（交付计划 §4.1-S3）：**中断续传成功；篡改一字节 → SHA256 失败 → 自动重下**。
 *
 * ## 取证方式
 * 起一个**真 HTTP 服务器**（不是打桩）当模型源，它能：
 *   · 支持 / 忽略 `Range`（两条路都要验：206 追加 vs 200 全量必须重新计）
 *   · 在指定字节数处**切断连接**（制造真中断，不是"返回错误码"假装中断）
 *   · 篡改自己吐出的字节（制造"内容坏了"，且不影响请求成功）
 *   · 记录每一条收到的请求（路径 + Range 头）—— 判"是否真续传"靠它，不靠日志文字
 *
 * ## 🔴 为什么改成**子进程驱动**（A3d 之前是直接 import 库调用）
 * Rust 那份是 **CLI**（`mangasvc --fetch-models`），不是可 import 的库。要让两靶跑
 * **同一份用例**，就只能统一到"起进程 → 读盘取证"这个口径。副作用是好的：
 *   · 取证不再依赖实现语言的内部 API ⇒ 「Node 版与 Rust 版行为一致」这件事才是真被验了
 *     （各调各的库 = 各验各的，两边都绿也说明不了它们一致）。
 *   · 反证开关走**子进程 env**，两靶天然通用（进程内 `process.env` 只管得住 Node 靶）。
 *
 * ## 为此给两个 CLI 加的参数（两侧同构，缺一不可）
 *   `--manifest <p>` —— 原 Node 版把清单路径写死，对拍必须用**夹具清单**；
 *   `--report <p>`   —— 结构化结果落盘（盘上取证，不解析 stdout 文本）；
 *   `--progress-log <p>` —— 逐行 JSON 进度（续传/进度断言靠它）。
 *   另有 `--root` / `--link-base` 覆盖落点与建链基准。
 *
 * ## 🔴 有意的能力收敛：F 组（可暂停）从「进程内 abort」改为「杀进程」
 * Node 库版给 `ensureModels` 传 `AbortSignal`，能吐 `MODEL_ABORTED`。Rust 版**没有**
 * signal 入参 —— 也没有调用方需要它：产品跑的是 CLI，而"暂停"在产品里的真实形态
 * 就是**杀掉进程**（`.part` 留下即是断点）。保留一条只有一边能跑的能力，不如换成
 * 两靶都跑得了的等价判据：**杀了之后 .part 留存 + 再跑从断点恢复**。
 *
 * 🔴 本脚本的核心纪律：正向与反证**共用同一套 `scn*` 事实函数与 `PRED` 谓词**。
 *    若反证另写一遍实现，它证明的就是另一件事了（本项目"两条反证共用一条断言"的变体）。
 *
 * 用法：node e2e/engine/model-store-check.mjs [--refute]
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const REFUTE = process.argv.includes('--refute');
// 临时根按模式分家：正向轮与反证轮会各自 freshRoot() 掉同名子目录，
// 共用根目录时两轮并行跑会互删对方的落盘（症状：正向轮报 ENOENT .../resume/big.bin）。
const TMP = path.join(REPO, '.tmp', 'models', REFUTE ? 'refute' : 'pos');

const NODE_SCRIPT = path.join(REPO, 'engine', 'scripts', 'fetch-models.mjs');
const RUST_BIN = path.join(
  REPO,
  'src-tauri',
  'target',
  'debug',
  `mangasvc${process.platform === 'win32' ? '.exe' : ''}`,
);

/** 两个靶子：**Node 对照端** vs **Rust 移植**（A3d），跑同一份用例、同一套谓词。 */
const TARGETS = [
  {
    id: 'node',
    label: 'fetch-models.mjs（Node 对照端）',
    argv: (a) => [process.execPath, [NODE_SCRIPT, ...a]],
  },
  {
    id: 'rust',
    label: 'mangasvc --fetch-models（A3d Rust 移植）',
    argv: (a) => [RUST_BIN, ['--fetch-models', ...a]],
  },
];

// ------------------------------------------------------------------ 断言收集

const results = [];
let group = '';
const setGroup = (g) => {
  group = g;
  console.log(`\n${g}`);
};
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
    if (!st) {
      res.writeHead(404, { 'Content-Length': '0' }).end();
      return;
    }
    if (st.failTimes > 0) {
      st.failTimes -= 1;
      res.writeHead(500, { 'Content-Length': '4' }).end('boom');
      return;
    }

    let body = st.buf;
    if (st.corruptTimes > 0 && st.corruptAt != null) {
      st.corruptTimes -= 1;
      body = Buffer.from(body);
      body[st.corruptAt] ^= 0xff; // 翻一个字节 —— 大小不变，只有哈希会变
    }

    const total = body.length;
    let start = 0;
    let status = 200;
    let contentRange = null;
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
        if (cut && limit < slice.length) {
          res.socket.destroy();
          return;
        }
        res.end();
        return;
      }
      const n = Math.min(CHUNK, limit - i);
      const ok = res.write(slice.subarray(i, i + n));
      i += n;
      // `slowMs`：每块之间加延迟。用途是让 F 组（杀进程）**来得及**在下载中途动手 ——
      // 本机 2 MB 几十毫秒就下完了，不加延迟的话"杀"永远落在"已经下完"之后，
      // 于是 F 组会退化成一条恒绿的摆设（这类"偶尔绿"比红更坏）。
      //
      // 🔴 `drain` 必须**当场**注册，不能推迟到 `setTimeout` 里再注册：
      //    缓冲可能在定时器到期之前就已经排空并触发过 drain 了 —— 那时再 `once('drain')`
      //    将永远等不到下一次 ⇒ 服务器永久停在第一块（实测：下载卡在 64KB 不动）。
      const schedule = () => {
        if (st.slowMs > 0) setTimeout(pump, st.slowMs);
        else setImmediate(pump);
      };
      if (ok) schedule();
      else res.once('drain', schedule);
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
        supportsRange: true,
        cutAfter: null,
        cutTimes: 0,
        corruptAt: null,
        corruptTimes: 0,
        failTimes: 0,
        slowMs: 0,
        ...opts,
      });
    },
    count(p) {
      return requests.filter((r) => r.path === p).length;
    },
    ranged(p) {
      return requests.filter((r) => r.path === p && r.range).length;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

// ------------------------------------------------------------------ 夹具数据

function makeBytes(n, seed) {
  const buf = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i += 1) {
    x = (x * 1664525 + 1013904223) >>> 0;
    buf[i] = x >>> 24;
  }
  return buf;
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function freshRoot(name) {
  const root = path.join(TMP, name);
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(root, { recursive: true });
  return root;
}

/** 每个靶 × 每个场景一套独立路径（两靶若共用，会互删对方的落盘）。 */
async function setup(t, name) {
  return {
    root: await freshRoot(`${t.id}-${name}`),
    manifestPath: path.join(TMP, `${t.id}-${name}.manifest.json`),
    reportPath: path.join(TMP, `${t.id}-${name}.report.json`),
    progPath: path.join(TMP, `${t.id}-${name}.progress.log`),
  };
}

function writeManifest(p, m) {
  fs.writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
  return p;
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
      ...(e.hf ? { hf: e.hf } : {}),
      ...(e.platform ? { platform: e.platform } : {}),
      sha256: e.sha256,
      sizeBytes: e.sizeBytes,
      url: `${fx.base}${e.path}`,
      sources: [`${fx.base}${e.path}`],
    })),
  };
}

// ------------------------------------------------------------------ 跑实现（子进程）

/** 反证开关的载体：由 `withEnv` 写入，`run` 读取并注入子进程。 */
let REFUTE_ENV = {};

/**
 * 起一个靶子进程。`opts.killWhen` 用于 F 组（中途杀）。
 *
 * 🔴 只用**异步** `spawn`：本机沙箱里 `spawnSync` / `execFileSync` 起子进程会 EBUSY。
 */
function run(t, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const [bin, base] = t.argv([]);
    const p = spawn(bin, [...base, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...REFUTE_ENV, ...(opts.env ?? {}) },
    });
    let out = '';
    let err = '';
    let timer = null;
    let killed = false;
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', (d) => {
      err += d;
    });
    if (opts.killWhen) {
      timer = setInterval(() => {
        if (killed) return;
        Promise.resolve(opts.killWhen())
          .then((yes) => {
            if (yes && !killed) {
              killed = true;
              p.kill();
            }
          })
          .catch(() => {});
      }, 30);
    }
    const done = (code) => {
      if (timer) clearInterval(timer);
      resolve({ code: code ?? -1, out, err, killed });
    };
    p.once('exit', done);
    p.once('error', reject);
  });
}

async function readReport(p) {
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function readProgress(p) {
  try {
    return (await fsp.readFile(p, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** 从 stderr 抽 `[CODE]` —— 两靶的错误文案都是 `✗ [CODE] msg`。 */
function errCode(errText) {
  const m = /\[([A-Z_0-9]+)\]/.exec(errText);
  return m ? m[1] : null;
}

const sizeOf = async (p) => {
  try {
    return (await fsp.stat(p)).size;
  } catch {
    return 0;
  }
};
const exists = (p) => fs.existsSync(p);
const sha256File = async (p) =>
  crypto
    .createHash('sha256')
    .update(await fsp.readFile(p))
    .digest('hex');
const statSafe = async (p) => {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
};
const readMarker = async (root) => {
  try {
    return JSON.parse(await fsp.readFile(path.join(root, '.models.ready.json'), 'utf8'));
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------ 场景（返回事实）

/** A/B：首次下载 + 校验 + .ready；随后幂等复用 */
async function scnFreshIdempotent(fx, t, alpha, beta) {
  const s = await setup(t, 'fresh');
  fx.def('/alpha', { buf: alpha.buf });
  fx.def('/beta', { buf: beta.buf });
  writeManifest(s.manifestPath, fixtureManifest(fx, [alpha, beta]));

  const base = ['--root', s.root, '--manifest', s.manifestPath, '--report', s.reportPath, '--progress-log', s.progPath];
  await run(t, [...base, '--integrity', 'hash', '--no-link']);
  const rep1 = await readReport(s.reportPath);
  const progress = await readProgress(s.progPath);

  const destA = path.join(s.root, 'alpha.bin');
  const hashA = await sha256File(destA);
  const marker = await readMarker(s.root);
  const st = await fsp.stat(destA);

  const before = fx.requests.length;
  await run(t, [...base, '--integrity', 'cached', '--no-link']);
  const rep2 = await readReport(s.reportPath);
  const newRequests = fx.requests.length - before;

  // 进度单调性：只看向上走、且终值等于文件大小
  const sizes = progress.filter((e) => e.id === 'alpha' && e.phase === 'downloading').map((e) => e.received);
  const monotonic = sizes.every((v, i) => i === 0 || v >= sizes[i - 1]);
  const totals = progress.filter((e) => e.id === 'alpha' && e.phase === 'downloading').map((e) => e.total);

  return {
    downloaded: rep1?.ensure?.downloaded ?? [],
    reused1: rep1?.ensure?.reused ?? [],
    bytes: rep1?.ensure?.bytes ?? 0,
    hashOk: hashA === alpha.sha256,
    sizeOk: st.size === alpha.sizeBytes,
    size: st.size,
    markerExists: !!marker,
    markerHashOk: marker?.files?.alpha?.sha256 === alpha.sha256,
    markerSizeOk: marker?.files?.alpha?.sizeBytes === alpha.sizeBytes,
    reused2: rep2?.ensure?.reused ?? [],
    downloaded2: rep2?.ensure?.downloaded ?? [],
    newRequests,
    progressMonotonic: monotonic,
    progressFinal: sizes.at(-1) ?? -1,
    progressTotalOk: totals.length > 0 && totals.every((x) => x === alpha.sizeBytes),
    progressEvents: sizes.length,
    root: s.root,
  };
}

/** C：中断续传（源支持 Range；在 400KB 处切断一次） */
async function scnResume(fx, t, big) {
  const s = await setup(t, 'resume');
  fx.def('/big', { buf: big.buf, cutAfter: 400 * 1024, cutTimes: 1, slowMs: 8 });
  writeManifest(s.manifestPath, fixtureManifest(fx, [big]));

  await run(t, [
    '--root',
    s.root,
    '--manifest',
    s.manifestPath,
    '--integrity',
    'hash',
    '--no-link',
    '--report',
    s.reportPath,
    '--progress-log',
    s.progPath,
  ]);
  const rep = await readReport(s.reportPath);

  const dest = path.join(s.root, 'big.bin');
  const st = await fsp.stat(dest);
  const hashOk = (await sha256File(dest)) === big.sha256;
  const partLeft = exists(`${dest}.part`);

  return {
    hashOk,
    sizeOk: st.size === big.sizeBytes,
    size: st.size,
    rangedRequests: fx.ranged('/big'),
    requests: fx.count('/big'),
    resumedFrom: rep?.ensure?.resumeFrom?.big ?? 0,
    partLeft,
    downloaded: rep?.ensure?.downloaded ?? [],
  };
}

/** D：源**不支持** Range（发了 Range 也回 200）⇒ 必须截断重来，不能追加 */
async function scnNoRange(fx, t, big) {
  const s = await setup(t, 'norange');
  fx.def('/big', { buf: big.buf, supportsRange: false, cutAfter: 400 * 1024, cutTimes: 1, slowMs: 8 });
  writeManifest(s.manifestPath, fixtureManifest(fx, [big]));

  await run(t, [
    '--root',
    s.root,
    '--manifest',
    s.manifestPath,
    '--integrity',
    'hash',
    '--no-link',
    '--report',
    s.reportPath,
  ]);
  const rep = await readReport(s.reportPath);

  const dest = path.join(s.root, 'big.bin');
  const st = await fsp.stat(dest);
  const hashOk = (await sha256File(dest)) === big.sha256;

  return {
    hashOk,
    sizeOk: st.size === big.sizeBytes,
    size: st.size,
    rangedRequests: fx.ranged('/big'), // 我们发了 Range，但对方回 200
    requests: fx.count('/big'),
    resumedFrom: rep?.ensure?.resumeFrom?.big ?? 0, // 必须为 0（重新计）
  };
}

/** E：篡改一字节 → 检出 → 自动重下；且**只有**被篡改的那个文件重下 */
async function scnTamper(fx, t, alpha, beta) {
  const s = await setup(t, 'tamper');
  fx.def('/alpha', { buf: alpha.buf });
  fx.def('/beta', { buf: beta.buf });
  writeManifest(s.manifestPath, fixtureManifest(fx, [alpha, beta]));
  const base = [
    '--root',
    s.root,
    '--manifest',
    s.manifestPath,
    '--integrity',
    'hash',
    '--no-link',
    '--report',
    s.reportPath,
  ];

  await run(t, base);
  const destA = path.join(s.root, 'alpha.bin');
  const betaBefore = await fsp.stat(path.join(s.root, 'beta.bin'));

  // 篡改一字节（大小不变；mtime 会变）
  const raw = await fsp.readFile(destA);
  raw[1024] ^= 0xff;
  await fsp.writeFile(destA, raw);
  const tamperedHash = await sha256File(destA);

  const reqAlphaBefore = fx.count('/alpha');
  const reqBetaBefore = fx.count('/beta');

  await run(t, base);
  const rep = await readReport(s.reportPath);
  const fixed = await sha256File(destA);
  const betaAfter = await fsp.stat(path.join(s.root, 'beta.bin'));

  return {
    tamperActuallyChanged: tamperedHash !== alpha.sha256,
    detected: (rep?.ensure?.redownloaded ?? []).includes('alpha'),
    redownloaded: rep?.ensure?.redownloaded ?? [],
    fixed: fixed === alpha.sha256,
    alphaRefetched: fx.count('/alpha') - reqAlphaBefore,
    betaRefetched: fx.count('/beta') - reqBetaBefore,
    betaUntouched: betaAfter.mtimeMs === betaBefore.mtimeMs && betaAfter.size === betaBefore.size,
  };
}

/** F：源内容本身就是坏的 ⇒ 重下到位后必须**报错**，不得静默接受 */
async function scnAlwaysBad(fx, t, alpha) {
  const s = await setup(t, 'alwaysbad');
  fx.def('/alpha', { buf: alpha.buf, corruptAt: 512, corruptTimes: 99 });
  writeManifest(s.manifestPath, fixtureManifest(fx, [alpha]));
  const before = fx.count('/alpha');

  const res = await run(t, [
    '--root',
    s.root,
    '--manifest',
    s.manifestPath,
    '--integrity',
    'hash',
    '--no-link',
    '--report',
    s.reportPath,
  ]);

  return {
    code: errCode(res.err),
    msg: res.err.trim().split('\n').at(-1) ?? '',
    threw: errCode(res.err) === 'MODEL_SHA256_MISMATCH',
    fetchCount: fx.count('/alpha') - before,
    // REDOWNLOAD_LIMIT = 1 ⇒ 首次 + 重下一次 = 2
    expectedFetchCount: 1 + 1,
    leftover: exists(path.join(s.root, 'alpha.bin')),
  };
}

/**
 * G：可暂停 → .part 留存 → 再跑从断点恢复
 * =============================================================================
 * 🔴 取证从「进程内 AbortSignal」改成「**杀掉进程**」：产品跑的是 CLI，"暂停"的真实
 *    形态就是杀进程（`.part` 留下即是断点）；Rust 侧没有 signal 入参，也没有调用方需要它。
 *    换成杀进程后，这条判据两靶都跑得了 —— 保留一条只有一边能跑的能力，不如换成等价的。
 */
async function scnAbortResume(fx, t, big) {
  const s = await setup(t, 'abort');
  fx.def('/big', { buf: big.buf, slowMs: 15 });
  writeManifest(s.manifestPath, fixtureManifest(fx, [big]));
  const dest = path.join(s.root, 'big.bin');
  const part = `${dest}.part`;
  const base = [
    '--root',
    s.root,
    '--manifest',
    s.manifestPath,
    '--integrity',
    'hash',
    '--no-link',
    '--report',
    s.reportPath,
  ];

  const killed = await run(t, base, { killWhen: async () => (await sizeOf(part)) > 300 * 1024 });

  const partSize = await sizeOf(part);
  const destExistsAfterAbort = exists(dest);

  await run(t, base);
  const rep = await readReport(s.reportPath);
  const hashOk = await sha256File(dest).catch(() => null);
  const st = await statSafe(dest);

  return {
    killed: killed.killed,
    partSize,
    destExistsAfterAbort,
    resumedFrom: rep?.ensure?.resumeFrom?.big ?? 0,
    hashOk: hashOk === big.sha256,
    sizeOk: !!st && st.size === big.sizeBytes,
    partLeft: exists(part),
    total: big.sizeBytes,
  };
}

/** H：纯离线校验（不联网） */
async function scnVerifyOffline(fx, t, alpha) {
  const s = await setup(t, 'verify');
  fx.def('/alpha', { buf: alpha.buf });
  writeManifest(s.manifestPath, fixtureManifest(fx, [alpha]));
  const base = ['--root', s.root, '--manifest', s.manifestPath, '--check', '--report', s.reportPath];

  // 先下好，再只跑校验
  await run(t, ['--root', s.root, '--manifest', s.manifestPath, '--integrity', 'hash', '--no-link']);
  const before = fx.requests.length;
  await run(t, base);
  const ok1 = await readReport(s.reportPath);

  const dest = path.join(s.root, 'alpha.bin');
  const raw = await fsp.readFile(dest);
  raw[2048] ^= 0xff;
  await fsp.writeFile(dest, raw);
  await run(t, base);
  const ok2 = await readReport(s.reportPath);

  return {
    cleanOk:
      (ok1?.verify?.ok ?? []).includes('alpha') &&
      (ok1?.verify?.bad ?? []).length === 0 &&
      (ok1?.verify?.missing ?? []).length === 0,
    dirtyOk: (ok2?.verify?.bad ?? []).some((b) => b.id === 'alpha'),
    noNetwork: fx.requests.length === before,
  };
}

/** I：多源回退（第一个源 500 → 换第二个源） */
async function scnFallback(fx, t, alpha) {
  const s = await setup(t, 'fallback');
  fx.def('/bad', { buf: alpha.buf, failTimes: 99 });
  fx.def('/good', { buf: alpha.buf });
  const m = {
    manifestVersion: 999,
    engineCommit: 'fixture',
    sets: {},
    files: [
      {
        id: 'alpha',
        set: 'all',
        dest: 'alpha.bin',
        sha256: alpha.sha256,
        sizeBytes: alpha.sizeBytes,
        url: `${fx.base}/bad`,
        sources: [`${fx.base}/bad`, `${fx.base}/good`],
      },
    ],
  };
  writeManifest(s.manifestPath, m);
  await run(t, [
    '--root',
    s.root,
    '--manifest',
    s.manifestPath,
    '--integrity',
    'hash',
    '--no-link',
    '--report',
    s.reportPath,
  ]);
  const rep = await readReport(s.reportPath);
  const hashOk = (await sha256File(path.join(s.root, 'alpha.bin'))) === alpha.sha256;
  return { hashOk, downloaded: rep?.ensure?.downloaded ?? [], badTried: fx.count('/bad'), goodUsed: fx.count('/good') };
}

/**
 * I2：**清单原 `url` 可用 + `sources` 全挂** ⇒ 仍要下成（原 `url` 不许被 `sources` 挤掉）。
 *
 * 🔴 这条是 H1 的反照，专门咬 D-217 那个缺陷：`sources` 一旦非空，清单原 `url` 就被整个丢掉
 *    （Node 侧 `sources?.length ? sources : [file.url]`、Rust 侧 `if sources.is_empty() {…}`）。
 *    ⚠️ **H1 咬不住它**：H1 的夹具把坏路径同时写进 `url` 与 `sources[0]`，旧实现照样能过 ——
 *    这正是"长期全绿却从未抓到 bug"的形态。H2 把**好的那个只放在 `url` 上**、坏的只放 `sources`：
 *    丢掉 `url` 的实现必然下不成（= 2026-10-16 真机整段装配失败的形态）。
 *    反证：`MIAO_NO_URL_FIRST=1`（退回旧行为）⇒ 本场景必红。
 */
async function scnUrlNotDropped(fx, t, alpha) {
  const s = await setup(t, 'url-first');
  fx.def('/bad', { buf: alpha.buf, failTimes: 99 });
  fx.def('/good', { buf: alpha.buf });
  const m = {
    manifestVersion: 999,
    engineCommit: 'fixture',
    sets: {},
    files: [
      {
        id: 'alpha',
        set: 'all',
        dest: 'alpha.bin',
        sha256: alpha.sha256,
        sizeBytes: alpha.sizeBytes,
        url: `${fx.base}/good`,
        sources: [`${fx.base}/bad`],
      },
    ],
  };
  writeManifest(s.manifestPath, m);
  await run(t, [
    '--root',
    s.root,
    '--manifest',
    s.manifestPath,
    '--integrity',
    'hash',
    '--no-link',
    '--report',
    s.reportPath,
  ]);
  const rep = await readReport(s.reportPath);
  // 🔴 先判存在再读：反证态（丢掉原 url）下根本下不成、文件不在盘上，
  //    直接 `sha256File` 会抛 ENOENT 把**反证轮本身**炸掉 —— 那样看到的是"检查崩了"，
  //    而不是"H2 按预期变红"（崩掉 ≠ 变红）。
  const dest = path.join(s.root, 'alpha.bin');
  const hashOk = exists(dest) && (await sha256File(dest)) === alpha.sha256;
  return {
    hashOk,
    downloaded: rep?.ensure?.downloaded ?? [],
    badTried: fx.count('/bad'),
    goodUsed: fx.count('/good'),
  };
}

/**
 * N：store + 硬链接 —— **引擎换版本不重下模型**
 * 模拟真实现状：引擎把模型路径硬编码在源码树里（BASE_PATH/models），
 * 于是"换版本"= 整棵 `src/` 被删掉再解包。权威副本在 store，引擎树里那份只是硬链接。
 */
async function scnRelink(fx, t, alpha) {
  const s = await setup(t, 'relink');
  const linkBase = path.join(s.root, 'engine-src'); // 扮演引擎源码树 src/
  fx.def('/alpha', { buf: alpha.buf });
  const entry = { ...alpha, dest: 'store/alpha.bin', linkTo: 'models/alpha.bin' };
  writeManifest(s.manifestPath, fixtureManifest(fx, [entry]));

  await run(t, ['--root', s.root, '--manifest', s.manifestPath, '--integrity', 'hash', '--no-link']);
  await run(t, [
    '--root',
    s.root,
    '--manifest',
    s.manifestPath,
    '--link',
    '--link-base',
    linkBase,
    '--report',
    s.reportPath,
  ]);
  const l1 = (await readReport(s.reportPath))?.link ?? {};

  const enginePath = path.join(linkBase, 'models/alpha.bin');
  const storePath = path.join(s.root, 'store/alpha.bin');
  const s1 = await statSafe(enginePath);
  const s0 = await statSafe(storePath);
  const sameInode = !!s1 && !!s0 && s1.ino === s0.ino && s1.dev === s0.dev;

  // —— 模拟「引擎换版本」：整棵源码树被删除（模型也跟着没了）
  await fsp.rm(linkBase, { recursive: true, force: true });

  const before = fx.requests.length;
  await run(t, [
    '--root',
    s.root,
    '--manifest',
    s.manifestPath,
    '--link',
    '--link-base',
    linkBase,
    '--report',
    s.reportPath,
  ]);
  const l2 = (await readReport(s.reportPath))?.link ?? {};
  const newRequests = fx.requests.length - before; // 这一步**必须**是 0
  const restoredOk = exists(enginePath) ? (await sha256File(enginePath)) === alpha.sha256 : false;
  const storeIntact = (await sha256File(storePath)) === alpha.sha256;

  return {
    linked1: l1.linked ?? [],
    copied1: l1.copied ?? [],
    sameInode,
    relinked2: l2.linked ?? [],
    restoredOk,
    newRequests,
    storeIntact,
  };
}

/**
 * P：**HuggingFace 缓存布局** —— blobs + snapshots/<rev>/<file> + refs/main 三件齐备
 * =============================================================================
 * 为什么必须单独立一组：HF 的 `try_to_load_from_cache()`（引擎 `_check_downloaded` 与
 * D-97c 的探针都靠它）**不认**"文件在 src/models/ 下"这件事，它认的是
 * `<cache>/models--<org>--<name>/snapshots/<revision>/<filename>` + `refs/main`。
 * 只把 blob 硬链接过去 = 「链接建好了、权重还是不被认」⇒ 引擎联网重下 ⇒ 本机 `ProxyError 502`。
 * 本组是这一整类问题的唯一承担者（见 docs/internal/spec-notes.md D-99）。
 */
async function scnHfLayout(fx, t, alpha) {
  const s = await setup(t, 'hf');
  const linkBase = path.join(s.root, 'engine-src'); // 扮演引擎源码树 src/
  fx.def('/alpha', { buf: alpha.buf });
  const rev = 'f8d333a098d19b4fd9a8b18f94170487ad3f821d';
  const cache = 'models/translators/nllb/models--facebook--nllb-200-distilled-600M';
  const entry = {
    ...alpha,
    dest: `store/${cache}/blobs/BLOB`,
    linkTo: `${cache}/blobs/BLOB`,
    hf: { revision: rev, filename: 'config.json' },
  };
  writeManifest(s.manifestPath, fixtureManifest(fx, [entry]));

  await run(t, ['--root', s.root, '--manifest', s.manifestPath, '--integrity', 'hash', '--no-link']);
  await run(t, [
    '--root',
    s.root,
    '--manifest',
    s.manifestPath,
    '--link',
    '--link-base',
    linkBase,
    '--report',
    s.reportPath,
  ]);
  const l1 = (await readReport(s.reportPath))?.link ?? {};

  const store = path.join(s.root, entry.dest);
  const blobTo = path.join(linkBase, entry.linkTo);
  const snapTo = path.join(linkBase, cache, 'snapshots', rev, 'config.json');
  const refsTo = path.join(linkBase, cache, 'refs', 'main');
  const sStore = await statSafe(store);
  const sBlob = await statSafe(blobTo);
  const sSnap = await statSafe(snapTo);
  const refs = exists(refsTo) ? fs.readFileSync(refsTo, 'utf8') : null;

  await run(t, [
    '--root',
    s.root,
    '--manifest',
    s.manifestPath,
    '--check',
    '--link-base',
    linkBase,
    '--report',
    s.reportPath,
  ]);
  const v1 = (await readReport(s.reportPath))?.hf ?? {};

  // —— 模拟「引擎换版本」：整棵 src/ 被删（模型目录跟着没了）
  await fsp.rm(linkBase, { recursive: true, force: true });
  const before = fx.requests.length;
  await run(t, [
    '--root',
    s.root,
    '--manifest',
    s.manifestPath,
    '--link',
    '--link-base',
    linkBase,
    '--report',
    s.reportPath,
  ]);
  const l2 = (await readReport(s.reportPath))?.link ?? {};
  const newRequests = fx.requests.length - before; // 必须 0
  const sSnap2 = await statSafe(snapTo);
  await run(t, [
    '--root',
    s.root,
    '--manifest',
    s.manifestPath,
    '--check',
    '--link-base',
    linkBase,
    '--report',
    s.reportPath,
  ]);
  const v2 = (await readReport(s.reportPath))?.hf ?? {};

  // —— 反例：linkTo 不落在 blobs/ 下 ⇒ 必须失败退出，不许静默猜 <cache> 根
  // 🔴 `dest` 必须指向**已存在**的 store 副本：两侧实现都是"先判 store 里有没有、没有就 skip"，
  //    而 skip 发生在 `hfLayout` **之前** —— 副本不存在的话这条断言根本咬不到判据
  //    （实测两靶都返回 code=null）。让它指向刚下载好的那份，判据才会真正执行。
  const badEntry = {
    ...alpha,
    id: 'bad',
    dest: entry.dest,
    linkTo: `${cache}/files/config.json`,
    hf: { revision: rev, filename: 'config.json' },
  };
  const badPath = path.join(TMP, `${t.id}-hf-bad.manifest.json`);
  writeManifest(badPath, fixtureManifest(fx, [badEntry]));
  const badRun = await run(t, ['--root', s.root, '--manifest', badPath, '--link', '--link-base', linkBase]);
  const badCode = errCode(badRun.err);

  return {
    hfCount: (l1.hf ?? []).length,
    refsContent: refs,
    refsOk: refs === rev,
    blobLinked: !!sBlob && !!sStore && sBlob.ino === sStore.ino,
    snapshotLinked: !!sSnap && !!sStore && sSnap.ino === sStore.ino && sSnap.dev === sStore.dev,
    verifyOk: (v1.ok ?? []).includes('alpha') && (v1.missing ?? []).length === 0,
    relinkedHf: (l2.hf ?? []).length,
    restoredSnapshot: !!sSnap2 && !!sStore && sSnap2.ino === sStore.ino,
    verifyOkAfterRelink: (v2.ok ?? []).includes('alpha') && (v2.missing ?? []).length === 0,
    newRequests,
    badCode,
    badExit: badRun.code,
  };
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
  // —— 多源（组 H）：H2 咬"原 url 被 sources 挤掉"，H1 咬不了它（见 scnUrlNotDropped 的注释）
  'H2 清单原 url 可用 + sources 全挂 ⇒ 仍要下成（原 url 不许被 sources 挤掉）': (f) => f.hashOk && f.goodUsed > 0,
  'E7-4a 引擎树里那份是与 store 同一 inode 的硬链接': (f) => f.sameInode && f.linked1.includes('alpha'),
  'E7-4b 换版本（src/ 整棵被删）后重链即恢复且哈希正确': (f) => f.relinked2.includes('alpha') && f.restoredOk,
  'E7-4c 重链全程 0 次网络请求（这就是"换版本不重下"）': (f) => f.newRequests === 0,
  // —— HF 缓存布局（组 P）：HF 认的是 snapshots/<rev>/<file> + refs/main，不是"文件就在 src 下"
  'P1 带 hf 的条目补齐 snapshot 与 refs/main（HF 才看得见）': (f) => f.hfCount === 1 && f.refsOk,
  'P2 snapshot 与 store 权威副本同一 inode（硬链接，不多占盘）': (f) => f.snapshotLinked && f.blobLinked,
  'P3 verifyHfCache 认定可解析': (f) => f.verifyOk,
  'P4 换版本后重链即恢复可解析（0 次网络）': (f) =>
    f.relinkedHf === 1 && f.restoredSnapshot && f.verifyOkAfterRelink && f.newRequests === 0,
  'P5 linkTo 不落在 blobs/ 下 ⇒ 报 MODEL_HF_BAD_LINK（不静默猜）': (f) =>
    f.badCode === 'MODEL_HF_BAD_LINK' && f.badExit !== 0,
};

/** 取谓词并在缺失时**立刻炸**：拼错名字不该退化成"静默跳过"。 */
function P(name) {
  const fn = PRED[name];
  if (!fn) throw new Error(`未定义的谓词：${name}`);
  return fn;
}

// ------------------------------------------------------------------ 主流程

/** 一个靶子的**全部**正向断言（38 条）。两靶 ⇒ 76 条。 */
async function runTarget(fx, t, fixtures) {
  const { alpha, beta, big } = fixtures;

  setGroup(`【${t.id}-A】首次下载 + 校验 + 幂等`);
  const fresh = await scnFreshIdempotent(fx, t, alpha, beta);
  add(
    'A1 两个文件都下成且哈希正确',
    fresh.downloaded.length === 2 && fresh.hashOk,
    `downloaded=${fresh.downloaded.join(',')} hashOk=${fresh.hashOk}`,
  );
  add('A2 落盘大小等于清单大小', fresh.sizeOk, `size=${fresh.size}`);
  add(
    'A3 进度按文件单调递增，且 total 等于文件大小',
    fresh.progressMonotonic && fresh.progressTotalOk,
    `事件 ${fresh.progressEvents} 条，终值 ${fresh.progressFinal}`,
  );
  add(
    'E7-3a .ready 幂等标记存在且记录与清单一致',
    PRED['E7-3a .ready 幂等标记存在且记录与清单一致'](fresh),
    `marker=${fresh.markerExists} hash=${fresh.markerHashOk} size=${fresh.markerSizeOk}`,
  );
  add(
    'E7-3b 第二次运行不联网（全复用）',
    PRED['E7-3b 第二次运行不联网（全复用）'](fresh),
    `新请求 ${fresh.newRequests} 次 · 复用 ${fresh.reused2.length} 个`,
  );

  setGroup(`【${t.id}-B】E7-1 中断续传（真切 socket）`);
  const resume = await scnResume(fx, t, big);
  add(
    'E7-1a 中断后仍下成完整正确的文件',
    PRED['E7-1a 中断后仍下成完整正确的文件'](resume),
    `size=${resume.size} hashOk=${resume.hashOk}`,
  );
  add(
    'E7-1b 续传确实发了 Range（不是整包重来）',
    PRED['E7-1b 续传确实发了 Range（不是整包重来）'](resume),
    `Range 请求 ${resume.rangedRequests} 次 / 共 ${resume.requests} 次`,
  );
  add(
    'E7-1c 续传起点 = 已落盘的部分',
    PRED['E7-1c 续传起点 = 已落盘的部分'](resume),
    `resumedFrom=${resume.resumedFrom}`,
  );
  add('E7-1d 断点文件不残留', PRED['E7-1d 断点文件不残留'](resume), `partLeft=${resume.partLeft}`);

  setGroup(`【${t.id}-C】源不支持 Range ⇒ 必须截断重来（不能追加到 .part 后面）`);
  const noRange = await scnNoRange(fx, t, big);
  add('C1 对方回 200 时仍下成正确文件', noRange.hashOk, `hashOk=${noRange.hashOk}`);
  add(
    'C2 大小**没有**被追加成 2×（这正是"整包当续传"会出的错）',
    noRange.sizeOk && noRange.resumedFrom === 0,
    `size=${noRange.size}（期望 ${big.sizeBytes}）resumedFrom=${noRange.resumedFrom}`,
  );

  setGroup(`【${t.id}-D】E7-2 篡改一字节 → SHA256 失败 → 自动重下`);
  const tamper = await scnTamper(fx, t, alpha, beta);
  add('D1 篡改前后哈希确实变了（先证明夹具真的破坏了内容）', tamper.tamperActuallyChanged, '');
  add(
    'E7-2a 篡改一字节被检出并标记重下',
    PRED['E7-2a 篡改一字节被检出并标记重下'](tamper),
    `redownloaded=${tamper.redownloaded.join(',')}`,
  );
  add('E7-2b 重下后哈希恢复正确', PRED['E7-2b 重下后哈希恢复正确'](tamper), `fixed=${tamper.fixed}`);
  add(
    'D4 只有被篡改的那个文件重下（失败**单文件**重下）',
    tamper.alphaRefetched > 0 && tamper.betaRefetched === 0 && tamper.betaUntouched,
    `alpha 重取 ${tamper.alphaRefetched} 次 · beta 重取 ${tamper.betaRefetched} 次 · beta 未被动过=${tamper.betaUntouched}`,
  );

  setGroup(`【${t.id}-E】源内容修不好 ⇒ 重下到位后必须报错`);
  const bad = await scnAlwaysBad(fx, t, alpha);
  add(
    'E7-2c 源内容坏到修不好 → 必须报错，不静默接受',
    PRED['E7-2c 源内容坏到修不好 → 必须报错，不静默接受'](bad),
    `code=${bad.code}`,
  );
  add(
    'E2 重试次数 = 1 + REDOWNLOAD_LIMIT（不无限重试）',
    bad.fetchCount === bad.expectedFetchCount,
    `实际 ${bad.fetchCount} 次（期望 ${bad.expectedFetchCount}）`,
  );
  add('E3 失败时不留半好文件（不留下会被静默使用的坏模型）', !bad.leftover, `leftover=${bad.leftover}`);

  setGroup(`【${t.id}-F】可暂停 / 恢复（杀进程 ⇒ .part 留存 ⇒ 从断点续下）`);
  const ab = await scnAbortResume(fx, t, big);
  add(
    'F1 中途被杀 ⇒ .part 留存且只是部分（断点就是它）',
    ab.killed && ab.partSize > 0 && ab.partSize < ab.total,
    `killed=${ab.killed} part=${ab.partSize} / ${ab.total}`,
  );
  add('F2 被杀后不留半截正式文件', !ab.destExistsAfterAbort, '');
  add(
    'F3 再跑从断点恢复并下成正确文件',
    ab.resumedFrom > 0 && ab.hashOk && ab.sizeOk && !ab.partLeft,
    `resumedFrom=${ab.resumedFrom} hashOk=${ab.hashOk}`,
  );

  setGroup(`【${t.id}-G】纯离线校验（诊断口径）`);
  const vf = await scnVerifyOffline(fx, t, alpha);
  add('G1 干净文件 → ok，且不联网', vf.cleanOk && vf.noNetwork, `noNetwork=${vf.noNetwork}`);
  add('G2 被篡改文件 → bad（不上网也能判出来）', vf.dirtyOk, '');

  setGroup(`【${t.id}-H】多源回退`);
  const fb = await scnFallback(fx, t, alpha);
  add(
    'H1 第一个源 500 → 自动换第二个源并下成',
    fb.hashOk && fb.goodUsed > 0,
    `bad 尝试 ${fb.badTried} 次 · good 用上 ${fb.goodUsed} 次`,
  );
  const nu = await scnUrlNotDropped(fx, t, alpha);
  add(
    'H2 清单原 url 可用 + sources 全挂 ⇒ 仍要下成（原 url 不许被 sources 挤掉）',
    PRED['H2 清单原 url 可用 + sources 全挂 ⇒ 仍要下成（原 url 不许被 sources 挤掉）'](nu),
    `hashOk=${nu.hashOk} · bad 尝试 ${nu.badTried} 次 · good 用上 ${nu.goodUsed} 次`,
  );

  setGroup(`【${t.id}-N】引擎换版本不重下模型（store + 硬链接）`);
  const rl = await scnRelink(fx, t, alpha);
  add(
    'E7-4a 引擎树里那份是与 store 同一 inode 的硬链接',
    P('E7-4a 引擎树里那份是与 store 同一 inode 的硬链接')(rl),
    `新建 ${rl.linked1.length} 个 · 复制 ${rl.copied1.length} 个（复制=退化了，不是链接）`,
  );
  add(
    'E7-4b 换版本（src/ 整棵被删）后重链即恢复且哈希正确',
    P('E7-4b 换版本（src/ 整棵被删）后重链即恢复且哈希正确')(rl),
    `重链 ${rl.relinked2.length} 个 · 恢复后哈希正确=${rl.restoredOk}`,
  );
  add(
    'E7-4c 重链全程 0 次网络请求（这就是"换版本不重下"）',
    P('E7-4c 重链全程 0 次网络请求（这就是"换版本不重下"）')(rl),
    `新请求 ${rl.newRequests} 次`,
  );
  add('N4 store 权威副本未被牵连', rl.storeIntact, '');

  setGroup(`【${t.id}-P】HF 缓存布局（blobs + snapshots/<rev>/<file> + refs/main）`);
  const hf = await scnHfLayout(fx, t, alpha);
  add(
    'P1 带 hf 的条目补齐 snapshot 与 refs/main（HF 才看得见）',
    P('P1 带 hf 的条目补齐 snapshot 与 refs/main（HF 才看得见）')(hf),
    `hf 条目 ${hf.hfCount} 个 · refs/main=${hf.refsOk ? '对' : hf.refsContent}`,
  );
  add(
    'P2 snapshot 与 store 权威副本同一 inode（硬链接，不多占盘）',
    P('P2 snapshot 与 store 权威副本同一 inode（硬链接，不多占盘）')(hf),
    `blob=${hf.blobLinked} snapshot=${hf.snapshotLinked}`,
  );
  add('P3 verifyHfCache 认定可解析', P('P3 verifyHfCache 认定可解析')(hf), '');
  add(
    'P4 换版本后重链即恢复可解析（0 次网络）',
    P('P4 换版本后重链即恢复可解析（0 次网络）')(hf),
    `重链 ${hf.relinkedHf} 个 · 网络请求 ${hf.newRequests} 次`,
  );
  add(
    'P5 linkTo 不落在 blobs/ 下 ⇒ 报 MODEL_HF_BAD_LINK（不静默猜）',
    P('P5 linkTo 不落在 blobs/ 下 ⇒ 报 MODEL_HF_BAD_LINK（不静默猜）')(hf),
    `code=${hf.badCode}`,
  );

  setGroup(`【${t.id}-M】真实清单自洽（与实现无关，两靶同判）`);
  const real = JSON.parse(fs.readFileSync(path.join(REPO, 'engine', 'models.manifest.json'), 'utf8'));
  const ids = real.files.map((f) => f.id);
  const required = ['id', 'dest', 'sha256', 'sizeBytes', 'url'];
  const fieldsOk = real.files.every((f) => required.every((k) => f[k] != null));
  const shaOk = real.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256));
  const setsOk = Object.values(real.sets).every((s) => s.files.every((id) => ids.includes(id)));
  add('M1 逐条字段齐备', fieldsOk, `共 ${real.files.length} 条`);
  add('M2 sha256 全是 64 位小写十六进制', shaOk, '');
  add('M3 sets 引用的 id 都存在', setsOk, Object.keys(real.sets).join(' / '));
  // hf 条目最容易出的一类错：linkTo 与 dest 的 blob 名走散（复制粘贴换了一个忘了另一个）
  // —— 那会让"下载落在 A、链接指到 B"，而两边都不报错。这里钉住这条等式。
  const hfFiles = real.files.filter((f) => f.hf);
  const hfOk =
    hfFiles.length > 0 &&
    hfFiles.every((f) => {
      const segs = String(f.linkTo).split('/');
      return (
        !!f.hf.revision &&
        !!f.hf.filename &&
        segs[segs.length - 2] === 'blobs' &&
        segs[segs.length - 1] === String(f.dest).split('/').pop()
      );
    });
  add(
    'M4 hf 条目契约：revision/filename 齐备 · linkTo 落在 blobs/ · blob 名与 dest 一致',
    hfOk,
    `hf 条目 ${hfFiles.length} 个`,
  );
}

async function main() {
  await fsp.mkdir(TMP, { recursive: true });

  const alpha = { id: 'alpha', path: '/alpha', buf: makeBytes(1500 * 1024, 11) };
  const beta = { id: 'beta', path: '/beta', buf: makeBytes(512 * 1024, 22) };
  const big = { id: 'big', path: '/big', buf: makeBytes(2048 * 1024, 33) };
  for (const o of [alpha, beta, big]) {
    o.sha256 = sha(o.buf);
    o.sizeBytes = o.buf.length;
  }

  if (!REFUTE) {
    console.log('S3 模型下载器 · E7 验收（正向轮 · 双靶）');
    const fx = await startFixture();
    console.log(`  夹具源：${fx.base} · 夹具文件 alpha 1.5MB / beta 0.5MB / big 2MB`);
    for (const t of TARGETS) {
      console.log(`\n${'═'.repeat(56)}\n▶ 靶子：${t.label}`);
      await runTarget(fx, t, { alpha, beta, big });
    }
    await fx.close();

    // ------------------------------------------------------------------ 汇总
    const pass = results.filter((r) => r.ok).length;
    const fail = results.length - pass;
    console.log(`\n${'─'.repeat(56)}`);
    const EXPECTED_TOTAL = 38 * TARGETS.length;
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
    return;
  }

  console.log('S3 模型下载器 · E7 反证轮（双靶）');
  console.log('（每个开关都必须让**某一条具名断言**变红；红不了就说明那条断言是摆设）');

  const refutes = [
    {
      id: 'R1',
      env: 'MIAO_NO_MODEL_VERIFY',
      desc: '关掉 SHA256 校验',
      target: 'E7-2a 篡改一字节被检出并标记重下',
      run: async (fx, t) => scnTamper(fx, t, alpha, beta),
    },
    {
      id: 'R2',
      env: 'MIAO_NO_RESUME',
      desc: '关掉断点续传（每次从 0 全量下）',
      target: 'E7-1b 续传确实发了 Range（不是整包重来）',
      run: async (fx, t) => scnResume(fx, t, big),
    },
    {
      id: 'R3',
      env: 'MIAO_NO_READY',
      desc: '关掉 .ready 幂等标记',
      target: 'E7-3a .ready 幂等标记存在且记录与清单一致',
      run: async (fx, t) => scnFreshIdempotent(fx, t, alpha, beta),
    },
    {
      id: 'R4',
      env: 'MIAO_NO_MODEL_VERIFY',
      desc: '关掉校验后，坏源也不会被拦下',
      target: 'E7-2c 源内容坏到修不好 → 必须报错，不静默接受',
      run: async (fx, t) => scnAlwaysBad(fx, t, alpha),
    },
    {
      id: 'R5',
      env: 'MIAO_NO_LINK',
      desc: '关掉"把 store 链进引擎树"这一步',
      target: 'E7-4b 换版本（src/ 整棵被删）后重链即恢复且哈希正确',
      run: async (fx, t) => scnRelink(fx, t, alpha),
    },
    {
      id: 'R6',
      env: 'MIAO_NO_LINK',
      desc: '关掉建链 ⇒ hf 条目的 snapshot / refs/main 也补不上',
      target: 'P1 带 hf 的条目补齐 snapshot 与 refs/main（HF 才看得见）',
      run: async (fx, t) => scnHfLayout(fx, t, alpha),
    },
    {
      id: 'R7',
      env: 'MIAO_NO_URL_FIRST',
      desc: '关掉「清单原 url 优先」⇒ 退回只试 sources（D-217 之前的旧行为）',
      target: 'H2 清单原 url 可用 + sources 全挂 ⇒ 仍要下成（原 url 不许被 sources 挤掉）',
      run: async (fx, t) => scnUrlNotDropped(fx, t, alpha),
    },
  ];

  const fx = await startFixture();
  let redCount = 0;
  const expected = refutes.length * TARGETS.length;

  // 🔴 反证开关走**子进程 env**：实现在子进程里，只在 `process.env` 上设值的话
  //    Rust 靶根本收不到 ⇒ 它会"永远绿"—— 那是假绿里最坏的一种
  //    （反证没咬到任何东西却报通过）。
  for (const t of TARGETS) {
    for (const r of refutes) {
      REFUTE_ENV = { [r.env]: '1' };
      let facts;
      try {
        facts = await r.run(fx, t);
      } finally {
        REFUTE_ENV = {};
      }
      const predicate = PRED[r.target];
      if (!predicate) throw new Error(`反证 ${r.id} 指定的断言不存在：${r.target}`);
      const turnedRed = !predicate(facts);
      if (turnedRed) redCount += 1;
      console.log(`\n🔴 ${r.id} · [${t.id}] ${r.desc}（${r.env}=1）`);
      console.log(`   目标断言：${r.target}`);
      console.log(`   ${turnedRed ? '✓ 按预期变红' : '✗ 竟然还是绿的 —— 这条断言抓不住该机制'}`);
    }
  }
  await fx.close();

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`反证：${redCount} / ${expected} 条按预期变红（应执行 ${expected}）`);
  if (redCount !== expected) {
    console.log('✗ 有反证没变红 ⇒ 对应断言无效，不得算通过。');
    process.exit(1);
  }
  console.log('✓ 全部反证成立：每条断言都能捕捉到它声称捕捉的机制。');
  // ⚠️ R1 与 R4 共用同一个开关，但打的是**两条不同的断言**（检出篡改 / 坏源必须报错）。
  //    它们不是"两条反证共用一条断言"，而是"一个开关的两处作用面"——两条判据各自独立。
  //    R5 与 R6 同理（都关建链，但一个咬"换版本后重链恢复"，一个咬"hf 缓存布局补齐"）。
  console.log('注：R1/R4 共用 MIAO_NO_MODEL_VERIFY，R5/R6 共用 MIAO_NO_LINK，但每对都打在两条互相独立的判据上。');
}

main().catch((e) => {
  console.error(`\n✗ ${e.stack || e.message}`);
  process.exit(1);
});
