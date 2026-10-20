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
 *   A7 媒体服务器远程播放中继（D-250）：票绑定「源 + 条目」、Range 原样透传、
 *      `api_key` 只走请求头（假上游记账）、停用 / 错类型 / 穿越 id 各有明确状态码
 *   A8 内核轨（D-251）：`--kernel-selftest` 走真 IPC（夹具假 mpv）+ 夹具记账证明命令真的发出去了
 *
 * ## 反证轮（--refute）
 *   R1 把动漫库根故意指到**漫画库根** ⇒ A4 的隔离判据必须变红（证明 A4 不是恒真）
 *
 * 用法：node e2e/service/anime-service-check.mjs [--refute]
 * 前置：`cd src-tauri && cargo build --bin mangasvc --bin animesvc`
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
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

/**
 * 通用请求：Range 的响应体不是文本，必须按字节读（`getJson` 会把它按 UTF-8 解坏）。
 * 同时带出响应头 —— CORS / Content-Range 这几条判据都在头上。
 */
function request(method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        headers,
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(buf.toString('utf8'));
          } catch {
            /* 非 JSON 原样带回 */
          }
          resolve({ status: res.statusCode, headers: res.headers, buf, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 票面签名：`sha256(token|key|exp)` 取前 32 个 hex（与 `stream::sign` 同一条算式）。 */
function ticketSig(token, key, exp) {
  return crypto.createHash('sha256').update(`${token}|${key}|${exp}`).digest('hex').slice(0, 32);
}

/**
 * 假 Jellyfin：只实现中继会用到的三条路由，并**记录**上游收到的认证头与 Range。
 *
 * 判据必须落在「上游看到了什么」上：只看中继的响应无法区分
 * 「密钥真的走了请求头」与「中继根本没发出去、恰好回了 200」。
 */
function startMockJellyfin(payload) {
  const seen = { auth: [], range: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/System/Info') {
      seen.auth.push(req.headers['x-emby-token'] || '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ServerName: 'Mock NAS', Version: '10.9.0' }));
      return;
    }
    if (u.pathname === '/Items') {
      seen.auth.push(req.headers['x-emby-token'] || '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          Items: [
            { Id: 'ep1', Name: 'S01E01', IndexNumber: 1, Type: 'Episode', SeriesName: 'Frieren' },
            { Id: 'ep2', Name: 'S01E02', IndexNumber: 2, Type: 'Episode', SeriesName: 'Frieren' },
          ],
        }),
      );
      return;
    }
    if (u.pathname.startsWith('/Videos/')) {
      seen.auth.push(req.headers['x-emby-token'] || '');
      seen.range.push(req.headers.range || '');
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : payload.length - 1;
        const slice = payload.subarray(start, end + 1);
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-range': `bytes ${start}-${end}/${payload.length}`,
          'content-length': String(slice.length),
          'accept-ranges': 'bytes',
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(payload.length) });
      res.end(payload);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
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
const mocks = [];
function cleanup() {
  for (const s of svcs) killTree(s);
  for (const m of mocks) m.close();
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

/**
 * 假 Bangumi：只实现探索页用到的四条路由。
 *
 * 为什么要它：`MIAO_BANGUMI_API` 是产品自己的镜像开关，指到这里就能证明
 * 「时间表 / 热度 / 条目建库」三条链路真的打到上游、真的落了盘 ——
 * 而不是前端对着空数组画空态。
 */
function startMockBangumi() {
  const subject = {
    id: 27364,
    name: '氷菓',
    name_cn: '冰菓',
    summary: '节能少年与好奇少女的校园推理。',
    date: '2012-04-22',
    images: { large: 'https://lain.bgm.tv/pic/cover/l/cd/38/27364.jpg', common: '', medium: '' },
    rating: { score: 8.1 },
    tags: [{ name: '京阿尼' }, { name: '校园' }],
    eps: 22,
    total_episodes: 26,
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // 先收完请求体再回：检索请求体要回显，筛选条有没有真发出去靠它取证
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let echo = null;
      try {
        echo = raw ? JSON.parse(raw) : null;
      } catch {
        echo = null;
      }
      if (u.pathname === '/calendar') return json([{ weekday: { id: 6 }, items: [subject] }]);
      if (u.pathname === '/v0/search/subjects') {
        // 校验筛选条真的发上来了：带 tag 就必须同时有 air_date 与 sort=heat；
        // 不带 tag 就必须是 sort=match 且没有 air_date。对不上直接 400 —— 让断言变红，
        // 而不是"产品没发筛选、mock 照样回 200"的假绿。
        const f = echo?.filter ?? {};
        const tag = f.tag?.[0];
        // 热度推荐走的是「空关键词 + sort=heat」，是另一条合法路径
        const isHot = (echo?.keyword ?? '') === '' && echo?.sort === 'heat' && !tag;
        const bad = isHot
          ? false
          : tag
            ? !(f.air_date?.[0] === '>=2024-04-01' && f.air_date?.[1] === '<2024-07-01' && echo?.sort === 'heat')
            : !(echo?.sort === 'match' && !f.air_date);
        if (bad) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ message: 'filters missing', echo }));
        }
        return json({ data: [subject] });
      }
      if (u.pathname === '/v0/subjects') return json({ data: [subject], total: 1 });
      if (u.pathname === '/v0/subjects/27364/characters') {
        return json([
          {
            id: 1,
            name: '千反田える',
            name_cn: '千反田爱瑠',
            relation: '主角',
            images: { large: 'https://lain.bgm.tv/pic/crt/l/1.jpg', common: '', medium: '' },
            actors: [{ id: 9, name: '佐藤聡美', images: { large: '', common: '', medium: '' } }],
          },
        ]);
      }
      if (u.pathname === '/v0/subjects/27364/persons') {
        return json([
          {
            id: 2,
            name: '京都アニメーション',
            relation: '动画制作',
            career: ['动画制作'],
            images: { large: '', common: '', medium: '' },
          },
        ]);
      }
      if (u.pathname === '/v0/subjects/27364/subjects') {
        return json([
          {
            id: 40000,
            name: '氷菓 第2期',
            name_cn: '冰菓 第二季',
            relation: '续集',
            images: { large: '', common: '', medium: '' },
          },
        ]);
      }
      if (u.pathname === '/v0/subjects/27364') return json(subject);
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
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
const bangumi = await startMockBangumi();
mocks.push(bangumi.server);

/**
 * 假站点：给通用网页源（选择器驱动）用。
 *
 * 判据落在**真抓真解析**上：列表页两条、详情页一个 `<video src>`，
 * 相对地址必须被解析成绝对地址 —— 只断言"接口 200"等于让空解析过关。
 */
function startMockSite() {
  const list = `<!doctype html><html><head><meta charset="utf-8"><title>列表</title></head><body>
    <ul class="list">
      <li class="item"><a href="/detail/1"><span class="t">第 1 话 冰菓</span></a></li>
      <li class="item"><a href="/detail/2"><span class="t">第 2 话 冰菓</span></a></li>
    </ul></body></html>`;
  const detail = `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <video controls src="/v/1.mp4"></video></body></html>`;
  // 多清晰度页：用于「优先分辨率」取证（只有 720 / 1080 两档，请求 2160 时应就近降级到 1080）
  const multi = `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <video><source src="/v/720.mp4" label="720P"><source src="/v/1080.mp4" label="1080P"></video></body></html>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    // `/guarded` 模拟「要过人机验证才给页面」的站：没有 session cookie 一律 403
    if (u.pathname === '/guarded') {
      if (!String(req.headers.cookie || '').includes('session=ok')) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<html><body>请先完成验证</body></html>');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(list);
    }
    if (u.pathname === '/list') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(list);
    }
    if (u.pathname === '/file.bin') {
      // 缓存下载的源：32 KB 固定字节，够验证「下完 + 落盘 + 进度」
      const buf = Buffer.alloc(32 * 1024, 7);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(buf.length) });
      return res.end(buf);
    }
    if (u.pathname === '/subscribe.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          name: '订阅来的站',
          kind: 'web',
          url: `${site.base}/list`,
          rules: { list: '.list .item', link: 'a', title: '.t', video: 'source' },
        }),
      );
    }
    if (u.pathname === '/subscribe-bad.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{ not json');
    }
    if (u.pathname === '/detail/multi') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(multi);
    }
    if (u.pathname.startsWith('/detail/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(detail);
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const site = await startMockSite();
mocks.push(site.server);

const animeEnv = {
  ...commonEnv,
  MIAO_ANIME_ROOT_DIR: D.animeLib,
  MIAO_ANIME_STATE_DIR: D.animeState,
  MIAO_ANIME_RUNTIME_ROOT: D.animeRuntime,
  // 探索页取数走这个「镜像」——产品自己的开关，不是测试专用分支
  MIAO_BANGUMI_API: bangumi.base,
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

  // A7：媒体服务器远程播放中继（D-250）
  //
  // 这一组判的是「密钥不出现在 URL、但确实到了上游」：只看中继的响应分不清
  // 「密钥走了请求头」与「中继根本没发出去、恰好回了 200」—— 所以假上游要记账。
  {
    const payload = Buffer.alloc(4096, 7);
    const mock = await startMockJellyfin(payload);
    mocks.push(mock.server);
    const base = `http://127.0.0.1:${animeInfo.port}`;
    const srcUrl = `http://127.0.0.1:${mock.port}?api_key=SECRET-KEY`;
    const auth = { 'x-box-token': animeInfo.token };
    const post = (body) =>
      request('POST', `${base}/api/v1/anime/sources`, {
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const relay = (src, item, exp, sig) =>
      `${base}/api/v1/anime/mediaserver/stream?src=${encodeURIComponent(src)}&item=${encodeURIComponent(item)}&exp=${exp}&sig=${sig}`;

    const saved = await post({ id: 'jf1', name: 'Mock NAS', kind: 'jellyfin', url: srcUrl, enabled: true });
    check('A7 保存媒体服务器源 200', saved.status === 200, saved.buf.toString().slice(0, 200));

    const probe = await request('POST', `${base}/api/v1/anime/sources/test`, {
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ url: srcUrl, kind: 'jellyfin', limit: 8 }),
    });
    check(
      'A7 源测试列出剧集（2 条）',
      probe.status === 200 && probe.json?.count === 2,
      probe.buf.toString().slice(0, 200),
    );
    check(
      'A7 源测试回传里没有 api_key',
      !probe.buf.toString().includes('SECRET-KEY'),
      probe.buf.toString().slice(0, 200),
    );
    check(
      'A7 上游探活真的收到了 api_key（走请求头）',
      mock.seen.auth.includes('SECRET-KEY'),
      mock.seen.auth.slice(0, 3),
    );

    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = ticketSig(animeInfo.token, 'ms:jf1:ep1', exp);
    const url = relay('jf1', 'ep1', exp, sig);
    check('A7 中继地址里没有 api_key（密钥不进 URL）', !url.includes('SECRET-KEY'));

    const ranged = await request('GET', url, { headers: { ...auth, range: 'bytes=0-99' } });
    check('A7 带票 + Range ⇒ 206', ranged.status === 206, {
      status: ranged.status,
      body: ranged.buf.toString().slice(0, 120),
    });
    check('A7 只回请求的那 100 字节', ranged.buf.length === 100, ranged.buf.length);
    check(
      'A7 Content-Range 原样透传',
      String(ranged.headers['content-range'] || '').startsWith('bytes 0-99/'),
      ranged.headers['content-range'],
    );
    check('A7 上游收到的 Range 原样转发', mock.seen.range.includes('bytes=0-99'), mock.seen.range.slice(0, 3));
    check('A7 中继响应带 CORS（字幕 / 截图要用）', ranged.headers['access-control-allow-origin'] === '*');
    check('A7 中继响应体确实是上游那 100 字节', ranged.buf.equals(payload.subarray(0, 100)));

    const noToken = await request('GET', url);
    check('A7 无令牌 ⇒ 403', noToken.status === 403, noToken.status);
    const badSig = await request('GET', relay('jf1', 'ep1', exp, 'deadbeef'), { headers: auth });
    check('A7 票面不对 ⇒ 403', badSig.status === 403, badSig.status);
    const oldExp = exp - 7200;
    const expired = await request(
      'GET',
      relay('jf1', 'ep1', oldExp, ticketSig(animeInfo.token, 'ms:jf1:ep1', oldExp)),
      {
        headers: auth,
      },
    );
    check('A7 过期票 ⇒ 403', expired.status === 403, expired.status);
    const reuse = await request('GET', relay('jf1', 'ep2', exp, sig), { headers: auth });
    check('A7 换一集沿用同一张票 ⇒ 403（票绑定条目）', reuse.status === 403, reuse.status);
    const badItem = '../../etc/passwd';
    const traversal = await request(
      'GET',
      relay('jf1', badItem, exp, ticketSig(animeInfo.token, `ms:jf1:${badItem}`, exp)),
      { headers: auth },
    );
    check('A7 条目 id 带路径分隔符 ⇒ 400', traversal.status === 400, traversal.status);
    const unknown = await request('GET', relay('nope', 'ep1', exp, ticketSig(animeInfo.token, 'ms:nope:ep1', exp)), {
      headers: auth,
    });
    check('A7 不存在的源 ⇒ 404', unknown.status === 404, unknown.status);

    await post({ id: 'rss1', name: 'Mock RSS', kind: 'rss', url: 'http://127.0.0.1:1/feed.xml', enabled: true });
    const wrongKind = await request('GET', relay('rss1', 'ep1', exp, ticketSig(animeInfo.token, 'ms:rss1:ep1', exp)), {
      headers: auth,
    });
    check('A7 源类型不是媒体服务器 ⇒ 404（中继不是开放代理）', wrongKind.status === 404, wrongKind.status);

    await post({ id: 'jf1', name: 'Mock NAS', kind: 'jellyfin', url: srcUrl, enabled: false });
    const disabled = await request('GET', url, { headers: auth });
    check('A7 源已停用 ⇒ 403', disabled.status === 403, disabled.status);
    // 复原，别把状态留给后面的断言
    await post({ id: 'jf1', name: 'Mock NAS', kind: 'jellyfin', url: srcUrl, enabled: true });
  }

  // A8：内核轨（libmpv 替身：随包 mpv + JSON IPC）
  //
  // 本机没有真 mpv 时用夹具跑：`MIAO_MPV_BIN=node` + `MIAO_MPV_SCRIPT=<夹具>`。
  // 判据分两层：① 自检脚本自己说全绿；② **夹具真的收到了那些命令**（否则"全绿"可能
  // 只是我们的客户端在对空气说话 —— 例如写端根本没连上）。
  {
    const logFile = path.join(TMP, 'fake-mpv.log');
    const selftest = spawnSync(ANIME_BIN, ['--kernel-selftest'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        ...animeEnv,
        MIAO_MPV_BIN: process.execPath,
        MIAO_MPV_SCRIPT: path.join(REPO, 'e2e', 'fixtures', '_fake-mpv.mjs'),
        MIAO_FAKE_MPV_LOG: logFile,
      },
    });
    let out = null;
    try {
      out = JSON.parse((selftest.stdout || '').trim());
    } catch {
      out = null;
    }
    check('A8 内核自检跑得完且输出 JSON', selftest.status === 0 && out !== null, {
      status: selftest.status,
      stderr: (selftest.stderr || '').slice(-300),
    });
    check(
      'A8 自检 ok=true',
      out?.ok === true,
      out?.cases?.filter((c) => !c.ok),
    );
    check('A8 用例条数写死 17 且全绿', out?.cases?.length === 17 && out.cases.every((c) => c.ok), out?.cases?.length);

    const cmds = fs.existsSync(logFile)
      ? fs
          .readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    const ops = cmds.map((c) => (Array.isArray(c.command) ? c.command[0] : ''));
    check('A8 夹具真的收到 loadfile（写端连上了）', ops.includes('loadfile'), ops.slice(0, 5));
    check('A8 夹具收到 observe_property（事件通道订阅了）', ops.includes('observe_property'), ops.slice(0, 5));
    check('A8 夹具收到 set_property（暂停 / 跳转 / 倍速都走命令）', ops.includes('set_property'), ops.slice(0, 5));
    check('A8 夹具收到 sub-add（外挂字幕）', ops.includes('sub-add'), ops.slice(0, 8));

    const probed = spawnSync(ANIME_BIN, ['--kernel-probe'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, ...animeEnv, MIAO_MPV_BIN: process.execPath },
    });
    let probeInfo = null;
    try {
      probeInfo = JSON.parse((probed.stdout || '').trim());
    } catch {
      probeInfo = null;
    }
    check(
      'A8 `--kernel-probe` 认 MIAO_MPV_BIN 并自报路径',
      probed.status === 0 && probeInfo?.available === true && probeInfo.path.length > 0,
      probeInfo,
    );

    const bare = spawnSync(ANIME_BIN, ['--kernel-probe'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, ...animeEnv, MIAO_MPV_BIN: '', PATH: '' },
    });
    let bareInfo = null;
    try {
      bareInfo = JSON.parse((bare.stdout || '').trim());
    } catch {
      bareInfo = null;
    }
    // 形状判据（机器无关）：可用 ⇒ 有路径；不可用 ⇒ 必须给出原因，不能只回一个 false
    const bareShapeOk =
      bareInfo !== null &&
      ((bareInfo.available === true && String(bareInfo.path || '').length > 0) ||
        (bareInfo.available === false && String(bareInfo.reason || '').includes('找不到 mpv')));
    check('A8 没有内核时如实说「找不到 mpv」而不是静默 false', bareShapeOk, bareInfo);
  }

  // A9：探索页取数（Bangumi 镜像指到本地 mock）
  //
  // 判据落在**服务端真打的请求 + 真落盘**上：只断言前端数组非空，等于让"对着空数组画空态"过关。
  {
    const base = `http://127.0.0.1:${animeInfo.port}`;
    const auth = { 'x-box-token': animeInfo.token };
    const postJson = (p, body) =>
      request('POST', `${base}${p}`, {
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const cal = await request('GET', `${base}/api/v1/anime/metadata/calendar`, { headers: auth });
    const day = cal.json?.days?.[0];
    check(
      'A9 时间表 200 且条目是整条 subject（周几 / 名字 / 封面都在）',
      cal.status === 200 &&
        day?.weekday === 5 &&
        day?.items?.[0]?.bgmId === 27364 &&
        day?.items?.[0]?.nameCn === '冰菓' &&
        String(day?.items?.[0]?.cover || '').includes('27364'),
      cal.buf.toString().slice(0, 240),
    );
    const noTok = await request('GET', `${base}/api/v1/anime/metadata/calendar`);
    check('A9 时间表无令牌 ⇒ 403', noTok.status === 403, noTok.status);

    const hotRes = await request('GET', `${base}/api/v1/anime/metadata/hot?limit=8`, { headers: auth });
    check(
      'A9 热度 200 且来源如实（source=heat）',
      hotRes.status === 200 && hotRes.json?.source === 'heat' && hotRes.json?.candidates?.[0]?.bgmId === 27364,
      hotRes.buf.toString().slice(0, 240),
    );

    const imp = await postJson('/api/v1/anime/metadata/import', { bgmId: 27364 });
    check(
      'A9 条目建库 200 且落在「冰菓」目录',
      imp.status === 200 && imp.json?.dir === '冰菓',
      imp.buf.toString().slice(0, 300),
    );
    const imp2 = await postJson('/api/v1/anime/metadata/import', { bgmId: 27364 });
    check(
      'A9 重复建库是幂等的（同一目录，不叠后缀）',
      imp2.status === 200 && imp2.json?.dir === imp.json?.dir,
      imp2.buf.toString().slice(0, 200),
    );

    const lib = await request('GET', `${base}/api/v1/anime/library`, { headers: auth });
    check(
      'A9 建完能扫到（库里有冰菓）',
      lib.status === 200 && lib.buf.toString().includes('冰菓'),
      lib.buf.toString().slice(0, 240),
    );
  }

  // A10：通用网页源（选择器驱动）：保存校验 / 测试抓取 / 详情页直链解析
  {
    const base = `http://127.0.0.1:${animeInfo.port}`;
    const auth = { 'x-box-token': animeInfo.token };
    const postJson = (p, body) =>
      request('POST', `${base}${p}`, {
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const rules = { list: '.list .item', link: 'a', title: '.t', video: 'video' };

    const save = await postJson('/api/v1/anime/sources', {
      id: 'mock-web',
      name: '夹具站',
      kind: 'web',
      url: `${site.base}/list`,
      enabled: true,
      rules,
    });
    check(
      'A10 网页源带规则保存成功并原样回读',
      save.status === 200 &&
        save.json?.source?.rules?.list === '.list .item' &&
        save.json?.source?.rules?.video === 'video',
      save.buf.toString().slice(0, 240),
    );

    const bad = await postJson('/api/v1/anime/sources', {
      id: 'bad-web',
      name: '坏规则',
      kind: 'web',
      url: `${site.base}/list`,
      enabled: true,
      rules: { list: 'a[' },
    });
    check(
      'A10 语法错的选择器在保存时就被拒（并点名是哪一条）',
      bad.status === 400 && /选择器语法不对/.test(bad.buf.toString()),
      bad.buf.toString().slice(0, 240),
    );

    const test = await postJson('/api/v1/anime/sources/test', { url: `${site.base}/list`, kind: 'web', rules });
    check(
      'A10 测试取到两条且相对链接已绝对化',
      test.status === 200 && test.json?.count === 2 && String(test.json?.items?.[0]?.link).startsWith(site.base),
      test.buf.toString().slice(0, 300),
    );

    const noRules = await postJson('/api/v1/anime/sources/test', { url: `${site.base}/list`, kind: 'web' });
    check(
      'A10 网页源缺规则 ⇒ 502 并说明缺选择器',
      noRules.status === 502 && /选择器/.test(noRules.buf.toString()),
      noRules.buf.toString().slice(0, 240),
    );

    const res = await postJson('/api/v1/anime/sources/resolve', { url: `${site.base}/detail/1`, rules });
    check(
      'A10 详情页解析出绝对直链',
      res.status === 200 && res.json?.url === `${site.base}/v/1.mp4`,
      res.buf.toString().slice(0, 240),
    );
  }

  // A11：详情页补充数据（角色 / 制作 / 关联）——三条各自真打上游、真映射
  {
    const base = `http://127.0.0.1:${animeInfo.port}`;
    const auth = { 'x-box-token': animeInfo.token };

    const ch = await request('GET', `${base}/api/v1/anime/metadata/characters?bgmId=27364`, { headers: auth });
    check(
      'A11 角色 200 且带关系与声优',
      ch.status === 200 &&
        ch.json?.characters?.[0]?.nameCn === '千反田爱瑠' &&
        ch.json?.characters?.[0]?.actors?.[0]?.name === '佐藤聡美',
      ch.buf.toString().slice(0, 240),
    );

    const st = await request('GET', `${base}/api/v1/anime/metadata/staff?bgmId=27364`, { headers: auth });
    check(
      'A11 制作人员 200 且带 career',
      st.status === 200 && st.json?.staff?.[0]?.career?.[0] === '动画制作',
      st.buf.toString().slice(0, 240),
    );

    const rel = await request('GET', `${base}/api/v1/anime/metadata/related?bgmId=27364`, { headers: auth });
    check(
      'A11 关联作品 200 且带 bgmId 与关系',
      rel.status === 200 && rel.json?.related?.[0]?.bgmId === 40000 && rel.json?.related?.[0]?.relation === '续集',
      rel.buf.toString().slice(0, 240),
    );

    const noTok = await request('GET', `${base}/api/v1/anime/metadata/characters?bgmId=27364`);
    check('A11 角色无令牌 ⇒ 403', noTok.status === 403, noTok.status);
  }

  // A12：验证码会话 cookie —— 带 cookie 才能拿到「要过人机验证」的页面
  {
    const base = `http://127.0.0.1:${animeInfo.port}`;
    const auth = { 'x-box-token': animeInfo.token };
    const postJson = (p, body) =>
      request('POST', `${base}${p}`, {
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const rules = { list: '.list .item', link: 'a', title: '.t' };

    const noCookie = await postJson('/api/v1/anime/sources/test', {
      url: `${site.base}/guarded`,
      kind: 'web',
      rules,
    });
    check(
      'A12 要验证的页面不带 cookie ⇒ 502（如实失败，不假装取到）',
      noCookie.status === 502,
      noCookie.buf.toString().slice(0, 240),
    );

    const withCookie = await postJson('/api/v1/anime/sources/test', {
      url: `${site.base}/guarded`,
      kind: 'web',
      rules,
      cookies: [{ name: 'session', value: 'ok' }],
    });
    check(
      'A12 带上会话 cookie ⇒ 200 且取到两条（验证码窗口那条链路成立）',
      withCookie.status === 200 && withCookie.json?.count === 2,
      withCookie.buf.toString().slice(0, 300),
    );
  }

  // A13：粘贴 Bangumi 链接 / 手输编号 → 建库（R2-5）
  {
    const base = `http://127.0.0.1:${animeInfo.port}`;
    const auth = { 'x-box-token': animeInfo.token };
    const postJson = (p, body) =>
      request('POST', `${base}${p}`, {
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const link = await postJson('/api/v1/anime/metadata/import-ref', { input: 'https://bgm.tv/subject/27364' });
    check(
      'A13 粘条目链接 ⇒ 200 且落在「冰菓」目录（占位文案兑现）',
      link.status === 200 && link.json?.dir === '冰菓' && link.json?.subject?.bgmId === 27364,
      link.buf.toString().slice(0, 240),
    );

    const garbage = await postJson('/api/v1/anime/metadata/import-ref', { input: '随便一段字' });
    check(
      'A13 认不出的输入 ⇒ 400 且明说「看不懂」（不猜）',
      garbage.status === 400 && /看不懂/.test(garbage.buf.toString()),
      garbage.buf.toString().slice(0, 240),
    );
  }

  // A14：检索筛选条（年份 / 季度 / 标签 / 排序）真的发到了上游请求体
  {
    const base = `http://127.0.0.1:${animeInfo.port}`;
    const auth = { 'x-box-token': animeInfo.token };

    const filtered = await request(
      'GET',
      `${base}/api/v1/anime/metadata/search?q=${encodeURIComponent('冰菓')}&year=2024&quarter=2&tag=${encodeURIComponent('校园')}&sort=heat`,
      { headers: auth },
    );
    // 假上游对筛选条做了校验：缺任何一条就 400，所以 200 本身就是「筛选真的发出去了」的证据
    check(
      'A14 带筛选的检索：tag / air_date / sort 都进了请求体',
      filtered.status === 200 && filtered.json?.count === 1,
      filtered.buf.toString().slice(0, 300),
    );

    const plain = await request('GET', `${base}/api/v1/anime/metadata/search?q=${encodeURIComponent('冰菓')}`, {
      headers: auth,
    });
    check(
      'A14 不带筛选：sort 回落 match，且不发空的 tag / air_date',
      plain.status === 200 && plain.json?.count === 1,
      plain.buf.toString().slice(0, 240),
    );
  }

  // A15：「优先分辨率」真的影响直链选择（多清晰度页面按它挑，缺档就近降级）
  {
    const base = `http://127.0.0.1:${animeInfo.port}`;
    const auth = { 'x-box-token': animeInfo.token };
    const postJson = (p, body) =>
      request('POST', `${base}${p}`, {
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const rules = { list: '.list .item', link: 'a', title: '.t', video: 'source' };

    const hi = await postJson('/api/v1/anime/sources/resolve', {
      url: `${site.base}/detail/multi`,
      rules,
      preferRes: '1080p',
    });
    check(
      'A15 preferRes=1080p ⇒ 选 1080 那一条',
      hi.status === 200 && hi.json?.url === `${site.base}/v/1080.mp4`,
      hi.buf.toString().slice(0, 240),
    );

    const downgrade = await postJson('/api/v1/anime/sources/resolve', {
      url: `${site.base}/detail/multi`,
      rules,
      preferRes: '2160p',
    });
    check(
      'A15 请求 2160p 但页面只有 720/1080 ⇒ 就近降级到 1080（不是随便给第一个）',
      downgrade.status === 200 && downgrade.json?.url === `${site.base}/v/1080.mp4`,
      downgrade.buf.toString().slice(0, 240),
    );
  }

  // A16：订阅导入（拉规则草稿，只解析不落盘）
  {
    const base = `http://127.0.0.1:${animeInfo.port}`;
    const auth = { 'x-box-token': animeInfo.token };
    const postJson = (p, body) =>
      request('POST', `${base}${p}`, {
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const ok = await postJson('/api/v1/anime/sources/subscribe', { url: `${site.base}/subscribe.json` });
    check(
      'A16 订阅导入返回规则草稿（名字 / 类型 / 四条选择器都在）',
      ok.status === 200 &&
        ok.json?.draft?.name === '订阅来的站' &&
        ok.json?.draft?.kind === 'web' &&
        ok.json?.draft?.rules?.list === '.list .item' &&
        ok.json?.draft?.rules?.video === 'source',
      ok.buf.toString().slice(0, 300),
    );

    const bad = await postJson('/api/v1/anime/sources/subscribe', { url: `${site.base}/subscribe-bad.json` });
    check(
      'A16 订阅内容不是 JSON ⇒ 502 且说明是内容问题（不是网络不通）',
      bad.status === 502 && /不是合法 JSON/.test(bad.buf.toString()),
      bad.buf.toString().slice(0, 240),
    );
  }

  // A17：缓存任务（新建 → 真下载 → 列表可见 → 删除）
  {
    const base = `http://127.0.0.1:${animeInfo.port}`;
    const auth = { 'x-box-token': animeInfo.token };
    const postJson = (p, body) =>
      request('POST', `${base}${p}`, {
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const cacheDir = path.join(D.animeState, 'cache');
    const add = await postJson('/api/v1/anime/cache', {
      subjectId: '冰菓',
      episodeIndex: 99,
      title: '第 99 话',
      url: `${site.base}/file.bin`,
      cacheDir,
    });
    check(
      'A17 新建缓存任务 200 且返回任务 id',
      add.status === 200 && add.json?.id === '冰菓#99',
      add.buf.toString().slice(0, 240),
    );

    // 下载在服务侧异步推进：轮询到 done（最多 ~5s）
    let task = null;
    for (let i = 0; i < 50 && !task; i++) {
      const list = await request('GET', `${base}/api/v1/anime/cache`, { headers: auth });
      const t = (list.json?.tasks ?? []).find((x) => x.id === '冰菓#99');
      if (t && t.state === 'done') task = t;
      else await sleep(100);
    }
    check(
      'A17 任务真下完（state=done 且字节数等于源大小）',
      task !== null && task.receivedBytes === 32 * 1024 && task.sizeBytes === 32 * 1024,
      task ?? '超时未完成',
    );

    const del = await postJson('/api/v1/anime/cache/delete', { id: '冰菓#99' });
    const after = await request('GET', `${base}/api/v1/anime/cache`, { headers: auth });
    check(
      'A17 删除后列表里不再有这条任务',
      del.status === 200 && !(after.json?.tasks ?? []).some((x) => x.id === '冰菓#99'),
      after.buf.toString().slice(0, 240),
    );
  }

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
