#!/usr/bin/env node
/**
 * C4 · 「断网也能加载」的**真引擎**那一半（nightly 层）
 * =============================================================================
 * `offline-fallback-check.mjs` 钉的是**机制**（离线键按盘上事实注入、`--link` 零网络重建、
 * 清链接必红），但它全部跑在夹具上。C4 的验收①是「断网后引擎**仍能加载** nllb 与视觉模型」
 * —— 那要一台装着真权重（≈13 GB）与真引擎的机器。**本机就是那台机器**，所以这条能真跑。
 *
 * ## 「断网」怎么在**不拔网线**的前提下被证明
 * 产品在**权重确实在盘**时会给引擎子进程注入 `HF_HUB_OFFLINE=1` + `TRANSFORMERS_OFFLINE=1`。
 * 这两个键的语义是**硬**的：`huggingface_hub` / `transformers` 在离线模式下**不会去联网**，
 * 需要什么而本地没有就直接**抛错**。⇒ 在这两个键生效的前提下把一张漫画走完
 * （视觉模型 + nllb 翻译都真的被加载并推理），就等于证明了"权重是从**本地**解析出来的"。
 * 这比"把网线拔了再跑一遍"更可复现，且**失败原因可归因**（离线模式下缺文件会直接报缺哪个）。
 *
 * 🔴 只走**产品**（`boxsvc`，Rust），不走 Node 对照端：C4 是关于**产品行为**的结论。
 *    Node 侧那份由 `check:engine-parity` 的配方同源对拍钉住（含这三条启动 env）。
 *
 * ## 一个必须显式处理的细节：配方的 env 是**差量**
 * `build_launch_plan` 的 `engine.env` 是 diff（只留与**当前进程环境**不同的键）。
 * 所以：若跑本脚本的 shell 里已经存在 `HF_HUB_OFFLINE=1`，配方里就**看不到**它 ——
 * 那会被误判成"产品没注入"。故本脚本**先从子进程环境里清掉**这三个键
 * （`HF_HUB_OFFLINE` / `TRANSFORMERS_OFFLINE` / `MIAO_NO_HF_OFFLINE`）再起服务，
 * 让"谁注入的"这件事没有歧义。
 *
 * ## 断言（W1–W6）
 *   W1 前置：权重/引擎/llama-server 都在盘（缺则**失败并点名**，不静默跳过）
 *   W2 产品配方（真档、未关离线）里 `engine.env` 含两个离线键，且命令文件真实存在
 *   W2b 设 `MIAO_NO_HF_OFFLINE=1` ⇒ 两键消失（证明 W2 判的是**产品行为**，不是环境里本来就有）
 *   W3 起 `boxsvc`（real）⇒ `/health` 200 且 `sidecar.mode=real`（不是替身）
 *   W4 引擎到达 `running`（**离线键生效的前提下**起来的）
 *   W5 提交 1 张真图 ⇒ 任务终态 `done`、项 `success`、译文落盘且与原文不同
 *      ⇒ 视觉模型与 nllb 都是**本地**加载出来的
 *   W6 收尾：进程树清干净、端口全部释放（不留占用）
 *
 * ## 为什么**不设**反证轮（与 `check:e3:real` 同待遇）
 * 本条要真权重 + 真引擎 + 分钟级，源码变异＋重跑一轮不现实；而它依赖的每条**判据形态**
 * 都已在夹具层反证过（`check:offline-fallback` 的 M1/M2/M3 正是"恒不注入 / 忽略逃生开关 /
 * 不写 refs"）。这里补的是**真实链路**那一次取证，不是新判据。
 *
 * 用法：node e2e/service/offline-real-check.mjs [--keep]
 * 前置：真引擎已按 docs/install-guide-*.md 装好（本机 `${appData}/runtimes/manga-translator/`）
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { RUST_BIN, REPO_ROOT } from './_service-harness.mjs';

const KEEP = process.argv.includes('--keep');
const log = (m) => console.log(`[offline-real] ${m}`);
const sleep = (ms) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

/** 产品默认落点（`<appData>/runtimes/manga-translator`）—— 不覆盖任何 `MIAO_*`，测的就是**默认路径**。 */
const RT =
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'runtimes', 'manga-translator')
    : path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'runtimes',
        'manga-translator',
      );
const VENV_PY = path.join(
  RT,
  'venv',
  process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'),
);
const SAKURA_GGUF = path.join(RT, 'models', 'sakura', 'sakura-1.5b-qwen2.5-v1.0-fp16.gguf');

/**
 * 验收素材：**英文**页（`test-manga/en/`）。
 *
 * 🔴 为什么必须用英文那页：C4 的验收①点名的就是 **nllb** —— 而 `nllb` 只在 `ENG>CHS`
 * 方向上被选中（`DIRECTION_TRANSLATOR`：`sakura` 的 prompt 把源语言硬编码成日文，
 * 对英文是原文照抄）。用日文页跑出来的是 Sakura，**验不到 nllb 的 HF 缓存**。
 * `test-manga/` 未入库（本机验收素材，`.gitignore:35`）⇒ 逐个候选探测，找不到就**失败并点名**。
 */
const IMAGE_CANDIDATES = [
  { rel: 'en/test-0.png', mime: 'image/png' },
  { rel: 'en/test_0.png', mime: 'image/png' },
  { rel: 'test_0.webp', mime: 'image/webp' },
  { rel: 'jp/test_0.webp', mime: 'image/webp' },
];
const pickImage = () => {
  for (const c of IMAGE_CANDIDATES) {
    const abs = path.join(REPO_ROOT, 'test-manga', c.rel);
    if (fs.existsSync(abs)) return { ...c, abs };
  }
  return null;
};
const IMAGE = pickImage();
const TEST_IMAGE = IMAGE?.abs ?? path.join(REPO_ROOT, 'test-manga', 'en', 'test-0.png');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-offline-real-'));
const OUT_ROOT = path.join(TMP, 'out');
const STATE_DIR = path.join(TMP, 'state');

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

// ------------------------------------------------------------------ 小工具

const portOpen = (port, timeoutMs = 400) =>
  new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => {
      if (!done) {
        done = true;
        s.destroy();
        resolve(v);
      }
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
  });

async function freePorts(base, n) {
  const out = [];
  for (let p = base; out.length < n; p++) if (!(await portOpen(p))) out.push(p);
  return out;
}

function runCli(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const c = spawn(RUST_BIN, args, { env: { ...cleanEnv(), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => {
      out += d;
    });
    c.stderr.on('data', (d) => {
      err += d;
    });
    c.on('error', (e) => resolve({ code: -1, out, err: `${err}${e.message}` }));
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

/**
 * 🔴 清掉这三个键（见文件头）：不然"谁注入了离线旗标"这件事说不清 ——
 * 配方的 env 是**差量**，父环境里已有的键不会出现在配方里。
 */
function cleanEnv() {
  const e = { ...process.env };
  for (const k of ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'MIAO_NO_HF_OFFLINE']) delete e[k];
  return e;
}

function request(port, method, urlPath, { token, headers = {}, body, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: { ...(token ? { 'X-Box-Token': token } : {}), ...headers },
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`请求超时 ${urlPath}`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const asJson = (res) => {
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    return null;
  }
};

function buildMultipart(payload, images) {
  const boundary = `----miaooff${crypto.randomBytes(8).toString('hex')}`;
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

/** Windows 用 `taskkill /T /F` 带走整棵子树；POSIX 杀进程组。 */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    /* 收尾尽力而为 */
  }
}

// ------------------------------------------------------------------ 前置

if (!fs.existsSync(RUST_BIN)) {
  console.error(`✗ 找不到 Rust 靶子：${RUST_BIN}\n先构建：cd app/src-tauri && cargo build --bin boxsvc`);
  process.exit(1);
}
if (!IMAGE) {
  console.error(
    '✗ 找不到测试素材（test-manga/ 未入库，属本机素材）。试过：\n  ' +
      IMAGE_CANDIDATES.map((c) => `test-manga/${c.rel}`).join('\n  ') +
      '\n放在 <repo>/test-manga/ 下即可（**英文页优先** —— C4 要验的是 nllb 的 HF 缓存）。',
  );
  process.exit(1);
}

const pre = [];
if (!fs.existsSync(VENV_PY)) pre.push(`venv 解释器不在：${VENV_PY}`);
if (!fs.existsSync(SAKURA_GGUF)) pre.push(`Sakura 权重不在：${SAKURA_GGUF}`);
const filesRes = await runCli(['--engine-model-files']);
let files = [];
try {
  files = JSON.parse(filesRes.out).files ?? [];
} catch {
  /* 下面判据会红 */
}
const notReady = files.filter((f) => f.applicable && !f.ready).map((f) => `${f.id}(${f.path})`);
if (files.length === 0) pre.push('--engine-model-files 没有输出任何条目（清单/落点不对？）');
if (notReady.length) pre.push(`未就绪的模型资产：${notReady.join(' / ')}`);

/*
 * 端口与公共 env **先定**：配方的 `--port` / `SAKURA_API_BASE` 是从 env 推出来的，
 * 先问配方再定端口的话，两处会各用一套（引擎听 A、服务去连 B）——那正是 R1 那类偏差。
 */
fs.mkdirSync(OUT_ROOT, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

/*
 * 🔴 端口分配必须避开配方的**约定**：引擎的执行器端口 = **引擎端口 + 1**
 *    （`resolve_engine_launch` 的 `executorPort`；引擎据此去调执行器）。
 *    第一次写成"连取三个空闲端口"（5911/5912/5913）⇒ 执行器(5913) 与 ③ llama-server(5913) **撞了**，
 *    症状是翻译时报 `404 File Not Found`（执行器的请求打到了 llama-server 上，
 *    body 还是 OpenAI 风格的错误结构）—— 从"端口撞了"到"404"这条链**完全看不出来**。
 *    ⇒ 所以：③ 必须落在引擎端口 **+4 之后**，且执行器端口本身也要确认空闲。
 */
const [SERVICE_PORT] = await freePorts(5911, 1);
let ENGINE_PORT = 0;
for (let p = SERVICE_PORT + 2; p < SERVICE_PORT + 40; p++) {
  if (!(await portOpen(p)) && !(await portOpen(p + 1))) {
    ENGINE_PORT = p;
    break;
  }
}
if (!ENGINE_PORT) throw new Error('找不到连续两个空闲端口给"引擎 + 执行器"（先清掉占用）');
const [LLM_PORT] = await freePorts(ENGINE_PORT + 4, 1);
const TOKEN = crypto.randomBytes(32).toString('hex');
const ENV_COMMON = {
  MIAO_ENGINE_PROTOCOL: 'real',
  MIAO_PORT: String(SERVICE_PORT),
  MIAO_ENGINE_PORT: String(ENGINE_PORT),
  MIAO_LLM_PORT: String(LLM_PORT),
  MIAO_ENGINE_TIMEOUT_MS: '180000',
  MIAO_TOKEN: TOKEN,
  MIAO_ROOT: OUT_ROOT,
  MIAO_STATE_DIR: STATE_DIR,
  PYTHONIOENCODING: 'utf-8',
};
log(`端口：服务 ${SERVICE_PORT} · 引擎 ${ENGINE_PORT} · ③ ${LLM_PORT}`);

const planRes = await runCli(['--print-launch-plan', 'real'], ENV_COMMON);
let plan = null;
try {
  plan = JSON.parse(planRes.out);
} catch {
  /* 下面判据会红 */
}

check('W1 前置齐备：venv + Sakura 权重 + **本平台全部模型资产就绪**（缺则点名，不静默跳过）', pre.length === 0, pre);
if (pre.length > 0) {
  console.log('\n⇒ 前置不满足，本条无法进行（这是**硬前置**，不是跳过）。装法见 docs/install-guide-*.md');
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  process.exit(1);
}

// ------------------------------------------------------------------ W2：产品配方里的离线键

const hasOffline = (e) => e.HF_HUB_OFFLINE === '1' && e.TRANSFORMERS_OFFLINE === '1';
const planEnv = plan?.engine?.env ?? {};

check(
  'W2 产品真档配方的 `engine.env` 含 `HF_HUB_OFFLINE=1` + `TRANSFORMERS_OFFLINE=1`' +
    '（这是"断网加载"的**机制前提**，且是产品自己注入的 —— 本脚本已先清掉父环境里这三个键）',
  hasOffline(planEnv),
  { env: planEnv },
);

const cmdFiles = [plan?.engine?.cmd?.[0], plan?.llm?.cmd?.[0]].filter((x) => typeof x === 'string');
check(
  'W2b 配方里的引擎解释器与 `llama-server` 文件都真实存在（"装齐了"不是靠目录存在推的）',
  cmdFiles.length === 2 && cmdFiles.every((f) => fs.existsSync(f)),
  { cmdFiles, exists: cmdFiles.map((f) => fs.existsSync(f)) },
);

const offRes = await runCli(['--print-launch-plan', 'real'], { ...ENV_COMMON, MIAO_NO_HF_OFFLINE: '1' });
let offPlan = null;
try {
  offPlan = JSON.parse(offRes.out);
} catch {
  /* 下面判据会红 */
}
check(
  'W2c 设 `MIAO_NO_HF_OFFLINE=1` ⇒ 两键消失（证明 W2 判的是**产品行为**，不是环境里本来就有的）',
  !hasOffline(offPlan?.engine?.env ?? {}),
  { env: offPlan?.engine?.env ?? {} },
);

// ------------------------------------------------------------------ W3–W6：真起服务、真跑一张

/*
 * 🔴 **取证边界（必须说清）**：`boxsvc` **不负责**拉起 ② 引擎 —— ② 由 Box 外壳（Tauri app）
 * 按同一份配方 spawn，box-service 只是它的兄弟进程（所以 `/engine/status` 里 `engine.pid`
 * 恒为 `null`，那是归属使然）。
 * 本脚本因此**扮演 Box 外壳那一半**：用 `--print-launch-plan real` 给出的
 * `cmd` / `cwd` / `env` 去 spawn ② —— 命令、工作目录、环境**全部来自产品**，
 * 测试只负责"谁来 spawn"。⇒ 结论落在产品行为上，不是夹具自造的启动方式。
 * （③ 仍由 `boxsvc` 自己按配方拉起 —— 那一半是真产品在管。）
 */
const engineSpec = plan?.engine;
const engine = engineSpec?.cmd
  ? spawn(engineSpec.cmd[0], engineSpec.cmd.slice(1), {
      cwd: engineSpec.cwd ?? undefined,
      // 配方的 env 是**差量**（只含与当前进程环境不同的键）⇒ 必须叠在继承环境之上
      env: { ...cleanEnv(), ...ENV_COMMON, ...(engineSpec.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  : null;
let engLog = '';
if (engine) {
  engine.stdout.on('data', (d) => {
    engLog += d.toString();
  });
  engine.stderr.on('data', (d) => {
    engLog += d.toString();
  });
}

// 🔴 不设 `MIAO_NO_LLM_AUTOSTART`：③ **必须**由服务按配方拉起 ——
//    「断网也能加载」这句话里最重的一块就是 3.3 GB 的 Sakura 权重。
const svc = spawn(RUST_BIN, [], {
  env: { ...cleanEnv(), ...ENV_COMMON },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});
let svcLog = '';
svc.stdout.on('data', (d) => {
  svcLog += d.toString();
});
svc.stderr.on('data', (d) => {
  svcLog += d.toString();
});

async function shutdown() {
  killTree(svc);
  killTree(engine);
  await sleep(1200);
}

try {
  let port = null;
  let token = TOKEN;
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const m = /MIAO_READY (\{[^\n]*\})/.exec(svcLog);
    if (m) {
      const info = JSON.parse(m[1]);
      port = info.port ?? SERVICE_PORT;
      token = info.token ?? TOKEN;
      break;
    }
    if (svc.exitCode !== null) throw new Error(`服务进程已退出（code=${svc.exitCode}）：\n${svcLog.slice(-1500)}`);
    await sleep(120);
  }
  if (!port) throw new Error(`服务 30s 内没打印就绪行：\n${svcLog.slice(-1500)}`);
  log(`服务就绪 @${port}`);

  /*
   * W3：「真档」怎么证：`sidecar.engineVersion` 报的是 `models.manifest.json:engineCommit` 的
   * 短 sha（mock 档恒 `"mock"`）。⇒ 期望值**从清单推**，不写死字面量 ——
   * 写死的话，换引擎 commit 时这条会变成"断言过期"而不是"行为变了"。
   */
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'engine', 'models.manifest.json'), 'utf8'));
  const wantVer = String(manifest.engineCommit ?? '').slice(0, 7);

  let health = null;
  let hj = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 6 * 60_000) {
    health = await request(port, 'GET', '/api/v1/health', { token, timeoutMs: 10_000 });
    hj = asJson(health);
    if (hj?.sidecar?.state === 'running') break;
    if (svc.exitCode !== null) throw new Error(`服务中途退出：\n${svcLog.slice(-1500)}`);
    await sleep(700);
  }
  check(
    'W3 `/api/v1/health` 200 且 `sidecar.state=running`，`engineVersion` == 清单 `engineCommit` 短 sha' +
      '（真档的硬证据：mock 档这里恒为 "mock" ⇒ 否则这条路白测）',
    health?.status === 200 && hj?.sidecar?.state === 'running' && hj?.sidecar?.engineVersion === wantVer,
    { status: health?.status, sidecar: hj?.sidecar, wantVer, waitedMs: Date.now() - t0 },
  );

  /*
   * W4：② 与 ③ 都要在**离线键生效**的前提下起来。
   * 🔴 ③（`llama-server` + 3.3 GB Sakura 权重）是这句话里最重的一块：
   *    视觉模型与 nllb 走 HuggingFace 的缓存解析，而 Sakura 是**本地 gguf 文件** ——
   *    两条路都不该有任何联网动作。
   */
  let engineState = null;
  let llmState = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 6 * 60_000) {
    const st = await request(port, 'GET', '/api/v1/engine/status', { token });
    const sj = asJson(st);
    engineState = sj?.engine?.state ?? null;
    llmState = sj?.llm?.state ?? null;
    if (engineState === 'running' && llmState === 'running') break;
    if (svc.exitCode !== null) throw new Error(`服务中途退出：\n${svcLog.slice(-1500)}`);
    if (engine && engine.exitCode !== null)
      throw new Error(`② 引擎退出（code=${engine.exitCode}）：\n${engLog.slice(-1500)}`);
    await sleep(700);
  }
  check(
    'W4 ② 与 ③ 在**离线键生效**的前提下都到达 `running`（真引擎 + 真 llama-server/Sakura 权重，' +
      '不是"进程在但没就绪"）',
    engineState === 'running' && llmState === 'running',
    { engineState, llmState, waitedMs: Date.now() - t1 },
  );

  // ---- W5：真翻译一张（视觉模型 + nllb 都要被加载）
  const img = {
    filename: `001${path.extname(IMAGE.rel)}`,
    contentType: IMAGE.mime,
    data: fs.readFileSync(TEST_IMAGE),
  };
  /*
   * 🔴 `direction.from = 'en'` 是这条用例的**关键开关**：`build_engine_config` 会因此把
   *    translator 切成 `nllb` 并下发 `from_lang=ENG`（见 `DIRECTION_TRANSLATOR`）。
   *    不发方向 ⇒ 走基线 `sakura` ⇒ 验不到 nllb 的 HF 缓存（而 C4 点名的正是它）。
   */
  const mp = buildMultipart(
    { comicName: 'C4 离线真引擎', idempotencyKey: crypto.randomUUID(), lang: { from: 'en', to: 'zh' } },
    [img],
  );
  const create = await request(port, 'POST', '/api/v1/tasks', {
    token,
    headers: { 'Content-Type': mp.contentType, 'X-Box-Client': 'extension/2.3.0' },
    body: mp.body,
    timeoutMs: 60_000,
  });
  const cj = asJson(create);
  const taskId = cj?.taskId;
  check('W5a `POST /api/v1/tasks` 201 + taskId', create.status === 201 && !!taskId, {
    status: create.status,
    body: JSON.stringify(cj)?.slice(0, 200),
  });

  let task = null;
  const t2 = Date.now();
  while (taskId && Date.now() - t2 < 8 * 60_000) {
    const d = await request(port, 'GET', `/api/v1/tasks/${taskId}`, { token });
    task = asJson(d);
    const s = task?.status;
    if (['done', 'partial_failed', 'failed', 'canceled'].includes(s)) break;
    await sleep(1000);
  }
  const items = task?.items ?? [];
  const transFile = (() => {
    const dirName = task?.normalizedComicName ?? task?.comicName;
    const dir = dirName ? path.join(OUT_ROOT, dirName) : null;
    if (!dir || !fs.existsSync(dir)) return null;
    const f = fs.readdirSync(dir).find((n) => /_translated\./.test(n));
    return f ? path.join(dir, f) : null;
  })();
  check(
    'W5b 任务终态 `done`、项 `success`、译文**真的落盘**（离线键生效 ⇒ 视觉模型与 nllb 都是从本地加载的）',
    task?.status === 'done' && items.length === 1 && items[0]?.status === 'success' && !!transFile,
    {
      status: task?.status,
      items: items.map((i) => `${i.seq}:${i.status}`),
      transFile,
      ms: Date.now() - t2,
      // 🔴 失败时把两侧日志尾部一起带出来：这一条的失败原因（端口撞了 / 引擎缺什么）
      //    只可能出现在引擎或服务的日志里，而"只报 status=failed"等于把排查成本推给下一个人。
      itemError: items[0]?.errorMessage ?? items[0]?.error ?? null,
      engineLogTail: engLog.slice(-500),
      svcLogTail: svcLog.slice(-500),
    },
  );
  if (transFile) {
    const src = fs.readFileSync(TEST_IMAGE);
    const out = fs.readFileSync(transFile);
    check(
      'W5c 产物与原文**不同**（不是把原图抄了一份 —— "离线"不该以"其实没翻译"为代价）',
      out.length > 0 && !out.equals(src),
      { srcBytes: src.length, outBytes: out.length },
    );
  }
} catch (e) {
  check(`W3–W5 真链路抛错：${String(e.message).slice(0, 200)}`, false, {
    svcLogTail: svcLog.slice(-700),
    engineLogTail: engLog.slice(-700),
  });
} finally {
  await shutdown();
}

// ------------------------------------------------------------------ W6：收尾不留占用

const stillOpen = [];
for (const p of [SERVICE_PORT, ENGINE_PORT, LLM_PORT]) if (await portOpen(p, 700)) stillOpen.push(p);
check('W6 进程树收干净：服务 / 引擎 / ③ 三个端口全部释放（不留占用给下一次）', stillOpen.length === 0, { stillOpen });

if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });
else log(`保留现场：${TMP}`);

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  if (svcLog) console.log(`\n服务日志尾部：\n${svcLog.slice(-1500)}`);
  process.exit(1);
}
