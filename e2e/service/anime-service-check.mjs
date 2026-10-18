#!/usr/bin/env node
/**
 * D-242 · 动漫服务进程（`animesvc`）与漫画服务（`mangasvc`）的**共存**验收
 * =============================================================================
 * 为什么单独一条：两个 exe 同时跑不是"各配一个端口"就完事 —— 只要落点、令牌、库根
 * 有任何一样共用，症状都是**静默串味**（番剧出现在漫画库里 / 拿漫画令牌调动漫端点），
 * 而不是启动失败。这一轮把四件东西逐条钉住：
 *
 *   A1 `--print-paths` 的键与默认形状（动漫侧独立快照，不混进漫画金标）
 *   A2 三个 `MIAO_ANIME_*` 覆盖逐项生效（验收夹具能把落点整体搬进临时目录）
 *   A3 两个 exe **同时**跑：端口不同 / 两个 /health 都 200 / 令牌不同 / 库根不同
 *   A4 库隔离：番剧只在 `/anime/library`，漫画只在 `/library`（双向）
 *   A5 动漫退出后漫画照旧可用（两个进程互不为"父"）
 *   A6 令牌隔离：拿错令牌打动漫端点 ⇒ 403 PERMISSION_DENIED
 *
 * ## 反证轮（--refute）
 *   R1 把动漫库根故意指到**漫画库根** ⇒ A4 的隔离判据必须变红（证明 A4 不是恒真）
 *
 * 用法：node e2e/service/anime-service-check.mjs [--refute]
 * 前置：`cd src-tauri && cargo build --bin mangasvc --bin animesvc`
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, '..', '..');
const WIN = process.platform === 'win32';
const EXE = (name) => path.join(REPO, 'src-tauri', 'target', 'debug', WIN ? `${name}.exe` : name);

const ANIME_BIN = process.env.MIAO_ANIMESVC_BIN || EXE('animesvc');
const MANGA_BIN = process.env.MIAO_MANGASVC_BIN || EXE('mangasvc');

const REFUTE = process.argv.includes('--refute');

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
    console.log(`  ✗ ${name}${extra !== undefined ? `  → ${JSON.stringify(extra).slice(0, 400)}` : ''}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-anime-'));
const D = {
  data: path.join(TMP, 'data'),
  mangaLib: path.join(TMP, 'manga-lib'),
  mangaState: path.join(TMP, 'manga-state'),
  mangaRuntime: path.join(TMP, 'manga-runtime'),
  animeLib: path.join(TMP, 'anime-lib'),
  animeState: path.join(TMP, 'anime-state'),
  animeRuntime: path.join(TMP, 'anime-runtime'),
};
for (const d of Object.values(D)) fs.mkdirSync(d, { recursive: true });

// 两边的夹具：一本漫画、一部番剧（**不同名字**，隔离断言靠它们分辨）
fs.mkdirSync(path.join(D.mangaLib, 'OnePiece'), { recursive: true });
fs.writeFileSync(path.join(D.mangaLib, 'OnePiece', '001.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
fs.mkdirSync(path.join(D.animeLib, 'Frieren', 'EP01'), { recursive: true });
fs.writeFileSync(path.join(D.animeLib, 'Frieren', 'EP01', '001.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

/** 跑一次 `--print-paths`（同步、毫秒级）。 */
function printPaths(bin, env = {}) {
  const r = spawnSync(bin, ['--print-paths'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(`${path.basename(bin)} --print-paths 退出 ${r.status}：${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

const norm = (p) => path.resolve(p);

/** 起一个服务，等它的就绪行。 */
function startSvc(bin, env, readyRe, label) {
  const child = spawn(bin, [], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const ready = new Promise((resolve, reject) => {
    const to = setTimeout(
      () => reject(new Error(`${label} 未在 30s 内打印就绪行\nstdout=${out.slice(-600)}\nstderr=${err.slice(-600)}`)),
      30_000,
    );
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = readyRe.exec(out);
      if (m) {
        clearTimeout(to);
        resolve(JSON.parse(m[1]));
      }
    });
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => {
      clearTimeout(to);
      reject(new Error(`${label} 提前退出（${code}）：${err.slice(-600)}`));
    });
    child.on('error', reject);
  });
  return { child, ready, log: () => `${out}${err}` };
}

function killTree(child) {
  if (!child || child.killed) return;
  if (WIN) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
}

function getJson(url, headers = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {
          /* 非 JSON 也原样带回 */
        }
        resolve({ status: res.statusCode, body, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url}`)));
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起服务后再等 /health（就绪行只保证"已绑定"，探活多给一点余量）。 */
async function waitHealthy(url, headers = {}) {
  let last = null;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await getJson(url, headers);
      if (r.status === 200) return r;
      last = r.status;
    } catch (e) {
      last = String(e.message || e);
    }
    await sleep(100);
  }
  throw new Error(`/health 一直不可用（最后：${last}）`);
}

const svcs = [];
function cleanup() {
  for (const s of svcs) killTree(s);
  fs.rmSync(TMP, { recursive: true, force: true });
}
process.on('exit', () => {
  for (const s of svcs) killTree(s);
});

// ------------------------------------------------------------------ 正向
console.log('=== D-242 · animesvc 与 mangasvc 共存 ===');
console.log(`临时目录：${TMP}`);

{
  const missing = [ANIME_BIN, MANGA_BIN].filter((b) => !fs.existsSync(b));
  check('A0 两个靶子都已构建（cargo build --bin mangasvc --bin animesvc）', missing.length === 0, missing);
  if (missing.length) {
    console.log('\n────────────────────────────────────────────────────────');
    console.log(`通过 ${passed} / 失败 ${failed}`);
    process.exit(1);
  }
}

{
  // A1：动漫侧快照的键与默认形状（不混进漫画金标）
  const snap = printPaths(ANIME_BIN);
  const keys = Object.keys(snap).sort();
  check(
    'A1 `animesvc --print-paths` 的键集合恰为 5 个（dataRoot + 动漫四件）',
    keys.join(',') === 'animeRootDir,animeRuntimeRoot,animeStateDir,animeTokenFile,dataRoot',
    keys,
  );
  check(
    'A1 动漫三件默认挂在 `<数据根>/anime/` 下',
    ['animeStateDir', 'animeRootDir', 'animeRuntimeRoot'].every((k) =>
      norm(snap[k]).startsWith(path.join(norm(snap.dataRoot), 'anime')),
    ),
    snap,
  );
  check(
    'A1 令牌文件在动漫 state 目录内',
    norm(snap.animeTokenFile) === path.join(norm(snap.animeStateDir), 'token'),
    snap.animeTokenFile,
  );
}

{
  // A2：三个覆盖逐项生效（夹具能把落点整体搬进临时目录）
  const snap = printPaths(ANIME_BIN, {
    MIAO_ROOT: D.data,
    MIAO_ANIME_STATE_DIR: D.animeState,
    MIAO_ANIME_ROOT_DIR: D.animeLib,
    MIAO_ANIME_RUNTIME_ROOT: D.animeRuntime,
  });
  check('A2 `MIAO_ROOT` 覆盖数据根', norm(snap.dataRoot) === norm(D.data), snap.dataRoot);
  check(
    'A2 `MIAO_ANIME_STATE_DIR` 覆盖动漫 state',
    norm(snap.animeStateDir) === norm(D.animeState),
    snap.animeStateDir,
  );
  check('A2 `MIAO_ANIME_ROOT_DIR` 覆盖动漫库根', norm(snap.animeRootDir) === norm(D.animeLib), snap.animeRootDir);
  check(
    'A2 `MIAO_ANIME_RUNTIME_ROOT` 覆盖动漫运行时根',
    norm(snap.animeRuntimeRoot) === norm(D.animeRuntime),
    snap.animeRuntimeRoot,
  );
}

const commonEnv = { MIAO_ROOT: D.data };
const mangaEnv = {
  ...commonEnv,
  MIAO_MANGA_ROOT_DIR: D.mangaLib,
  MIAO_MANGA_STATE_DIR: D.mangaState,
  MIAO_MANGA_RUNTIME_ROOT: D.mangaRuntime,
  MIAO_ENGINE_PROTOCOL: 'mock',
  MIAO_NO_LLM_AUTOSTART: '1',
};
const animeEnv = {
  ...commonEnv,
  MIAO_ANIME_ROOT_DIR: D.animeLib,
  MIAO_ANIME_STATE_DIR: D.animeState,
  MIAO_ANIME_RUNTIME_ROOT: D.animeRuntime,
};

let manga = null;
let anime = null;
let mangaInfo = null;
let animeInfo = null;

try {
  // A3：同时起两个进程
  manga = startSvc(MANGA_BIN, mangaEnv, /\[manga-service\] MIAO_READY (\{[^\n]*\})/, 'mangasvc');
  anime = startSvc(ANIME_BIN, animeEnv, /\[anime-service\] ANIME_READY (\{[^\n]*\})/, 'animesvc');
  svcs.push(manga.child, anime.child);
  [mangaInfo, animeInfo] = await Promise.all([manga.ready, anime.ready]);

  check('A3 两个进程拿到**不同**端口（探测式绑定，未抢同一口）', mangaInfo.port !== animeInfo.port, {
    manga: mangaInfo.port,
    anime: animeInfo.port,
  });
  check('A3 两个进程的令牌**不同**（各持 `<state>/token`）', mangaInfo.token !== animeInfo.token);
  check('A3 两个进程的库根**不同**', norm(mangaInfo.rootDir) !== norm(animeInfo.rootDir), {
    manga: mangaInfo.rootDir,
    anime: animeInfo.rootDir,
  });

  const mHealth = await waitHealthy(`http://127.0.0.1:${mangaInfo.port}/api/v1/health`);
  const aHealth = await waitHealthy(`http://127.0.0.1:${animeInfo.port}/api/v1/health`);
  check('A3 mangasvc /health 200', mHealth.status === 200);
  check(
    'A3 animesvc /health 200 且自报 service=anime-service',
    aHealth.status === 200 && aHealth.json?.service === 'anime-service',
    aHealth.body,
  );
  check(
    'A3 animesvc /health 自报库根 = 传入的 `MIAO_ANIME_ROOT_DIR`',
    norm(aHealth.json?.rootDir || '') === norm(D.animeLib),
    aHealth.json,
  );

  // A4：库隔离（双向）
  const aLib = await getJson(`http://127.0.0.1:${animeInfo.port}/api/v1/anime/library`, {
    'x-box-token': animeInfo.token,
  });
  const mLib = await getJson(`http://127.0.0.1:${mangaInfo.port}/api/v1/library`, {
    'x-box-token': mangaInfo.token,
  });
  check(
    'A4 动漫库列出本域作品（Frieren）',
    aLib.status === 200 && aLib.body.includes('Frieren'),
    aLib.body.slice(0, 200),
  );
  check('A4 动漫库**看不到**漫画作品（OnePiece）', !aLib.body.includes('OnePiece'), aLib.body.slice(0, 200));
  check(
    'A4 漫画库列出本域作品（OnePiece）',
    mLib.status === 200 && mLib.body.includes('OnePiece'),
    mLib.body.slice(0, 200),
  );
  check('A4 漫画库**看不到**番剧（Frieren）', !mLib.body.includes('Frieren'), mLib.body.slice(0, 200));

  // A6：令牌隔离（拿漫画令牌打动漫端点）
  const cross = await getJson(`http://127.0.0.1:${animeInfo.port}/api/v1/anime/library`, {
    'x-box-token': mangaInfo.token,
  });
  check(
    'A6 拿漫画令牌打动漫端点 ⇒ 403 PERMISSION_DENIED',
    cross.status === 403 && cross.json?.error?.code === 'PERMISSION_DENIED',
    {
      status: cross.status,
      body: cross.body.slice(0, 200),
    },
  );

  // A5：动漫退出后漫画照旧
  killTree(anime.child);
  await sleep(600);
  const still = await getJson(`http://127.0.0.1:${mangaInfo.port}/api/v1/health`);
  check('A5 动漫进程退出后，漫画服务仍 200（两者互不为父）', still.status === 200, still.status);
} catch (e) {
  check('SETUP — 起服务 / 探活', false, String(e.message || e));
} finally {
  killTree(anime?.child);
  killTree(manga?.child);
}

// ------------------------------------------------------------------ 反证轮
if (REFUTE) {
  if (failed > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    cleanup();
    process.exit(1);
  }
  console.log('\n反证轮：把动漫库根故意指到漫画库根 ⇒ A4 的隔离判据必须变红\n');

  let ref = null;
  try {
    ref = startSvc(
      ANIME_BIN,
      { ...commonEnv, MIAO_ANIME_ROOT_DIR: D.mangaLib, MIAO_ANIME_STATE_DIR: path.join(TMP, 'anime-state-refute') },
      /\[anime-service\] ANIME_READY (\{[^\n]*\})/,
      'animesvc(refute)',
    );
    svcs.push(ref.child);
    const info = await ref.ready;
    const r = await getJson(`http://127.0.0.1:${info.port}/api/v1/anime/library`, { 'x-box-token': info.token });
    // 共用库根时，动漫库会看到漫画作品 —— 这正是 A4 要抓的"串味"
    const leaked = r.status === 200 && r.body.includes('OnePiece');
    check('R1 共用库根 ⇒ 动漫库**确实**看到了漫画作品（A4 不是恒真）', leaked, r.body.slice(0, 200));
  } catch (e) {
    check('R1 共用库根 ⇒ 动漫库确实看到了漫画作品（A4 不是恒真）', false, String(e.message || e));
  } finally {
    killTree(ref?.child);
  }
  console.log(`\nREFUTE: ${passed}/${passed + failed} 条按预期变红`);
}

console.log('\n────────────────────────────────────────────────────────');
console.log(`通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log(`失败项：\n${failures.map((f) => `  - ${f}`).join('\n')}`);
}
cleanup();
process.exit(failed > 0 ? 1 : 0);
