#!/usr/bin/env node
/**
 * S1 真引擎实测 —— **「功能通」的取证**。
 *
 * 与 `service/scripts/engine-client-check.mjs` 的分工（计划 §7-R7：两者不许混为一谈）：
 *   engine-client-check  → **管路通**：请求形状 / 错误归一 / 三态判定（真协议**假引擎**，秒级、可反证）
 *   本脚本               → **功能通**：真引擎 + 真模型 + 真 Sakura，真的吐出一张中文译文
 *
 * 它做三件事：
 *   ① 拉起引擎进程树（`llama-server` → `server.main` → 执行器），**用 `probeEngine()` 自己采样三态**
 *      （顺带证明三重判定在真进程上真的会经过 stopped → starting → running）；
 *   ② 用**适配层本身**（`service/src/engine-client.mjs` 的 real 分支）送 `test-manga/test_0.webp`，
 *      拿到译文图 —— 这一步刻意**不绕过适配层**，否则测的是别的东西；
 *   ③ 把产物与原图、与 M1 那次 `local` 模式产物（`runtimes/manga-translator/out-first/`）逐像素比对，
 *      给出**可复算的数字**，不是"我看着像中文"。
 *
 * 为什么不进 `npm run selftest`：它要几 GB 模型 + 分钟级耗时 + 真实 GPU。**按需手动跑**。
 *
 * 用法：
 *   node engine/scripts/s1-real-engine-check.mjs
 *   node engine/scripts/s1-real-engine-check.mjs --keep      跑完不杀进程（便于手工继续观察）
 *   node engine/scripts/s1-real-engine-check.mjs --out <dir> 指定产物目录
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RT = path.join(ROOT, 'runtimes', 'manga-translator');
const SRC = path.join(RT, 'src');
const VENV_PY = path.join(RT, 'venv', 'bin', 'python');
const LLAMA_BIN = path.join(RT, 'bin', 'llama', 'llama-b11417', 'llama-server');
const SAKURA_GGUF = path.join(RT, 'models', 'sakura', 'sakura-1.5b-qwen2.5-v1.0-fp16.gguf');
const TEST_IMAGE = path.join(ROOT, 'test-manga', 'test_0.webp');
const G1_OUTPUT = path.join(RT, 'out-first', 'test_0.webp'); // M1 的 local 模式产物

const KEEP = process.argv.includes('--keep');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 ? path.resolve(process.argv[outIdx + 1]) : path.join(ROOT, 'tmp-engine-test', 's1-real');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-s1-real-'));

const ENGINE_PORT = 8000;
const EXECUTOR_PORT = ENGINE_PORT + 1;
const LLAMA_PORT = 8080;
const TRANSLATE_TIMEOUT_MS = 15 * 60 * 1000; // 首张含模型加载；实测单张 1.6 min，给足余量

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const log = (m) => console.log(`[s1-real] ${m}`);

const procs = [];
function shutdown() {
  for (const p of procs) {
    if (p && p.exitCode === null) { try { p.kill('SIGTERM'); } catch { /* ignore */ } }
  }
}
process.on('SIGINT', () => { shutdown(); process.exit(130); });
process.on('SIGTERM', () => { shutdown(); process.exit(143); });
process.on('exit', () => { if (!KEEP) shutdown(); });

function spawnLogged(cmd, argv, opts, tag) {
  const child = spawn(cmd, argv, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  child.__log = '';
  child.stdout.on('data', (d) => { child.__log += d.toString(); });
  child.stderr.on('data', (d) => { child.__log += d.toString(); });
  child.on('exit', (code, sig) => log(`${tag} 退出 code=${code} sig=${sig}`));
  procs.push(child);
  return child;
}

async function httpGet(port, pathname, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
    req.end();
  });
}

const portOpen = (port, timeoutMs = 400) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  let done = false;
  const fin = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
  s.setTimeout(timeoutMs);
  s.once('connect', () => fin(true));
  s.once('timeout', () => fin(false));
  s.once('error', () => fin(false));
});

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// ------------------------------------------------------------------ 主流程

fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(SAKURA_GGUF)) throw new Error(`Sakura 权重不在：${SAKURA_GGUF}`);
if (!fs.existsSync(TEST_IMAGE)) throw new Error(`测试图不在：${TEST_IMAGE}`);

// 适配层要在 **import 之前** 拿到端口与协议（config 在模块顶层读 env）
process.env.MIAO_ENGINE_PORT = String(ENGINE_PORT);
process.env.MIAO_ENGINE_PROTOCOL = 'real';
process.env.MIAO_ENGINE_PROBE_MS = '500';
process.env.MIAO_ENGINE_TIMEOUT_MS = String(TRANSLATE_TIMEOUT_MS);
process.env.MIAO_TOKEN = 's'.repeat(64);
process.env.MIAO_STATE_DIR = path.join(TMP, 'state');

const { translateImage, probeEngine, resolveEngineLaunch, EngineError } = await import(
  new URL('../../service/src/engine-client.mjs', import.meta.url).href
);

const report = { startedAt: new Date().toISOString(), ports: { engine: ENGINE_PORT, executor: EXECUTOR_PORT, llama: LLAMA_PORT } };

// ---- 0) 起始态：什么都没有 → 期望 stopped
const s0 = await probeEngine();
log(`初始探测：${JSON.stringify(s0)}`);
report.probeInitial = s0;

// ---- 1) llama-server（引擎③ Sakura）
log('拉起 llama-server（Sakura 1.5B fp16）…');
const llama = spawnLogged(LLAMA_BIN, [
  '-m', SAKURA_GGUF, '--port', String(LLAMA_PORT), '-c', '4096', '-ngl', '99',
], {}, 'llama-server');
let llamaReady = false;
for (let i = 0; i < 600; i += 1) {
  if (await httpGet(LLAMA_PORT, '/v1/models', 1000) === 200) { llamaReady = true; break; }
  await sleep(500);
}
log(`llama-server 就绪=${llamaReady}（${await httpGet(LLAMA_PORT, '/v1/models') === 200}）`);
report.llmReady = llamaReady;
if (!llamaReady) throw new Error(`llama-server 未就绪；日志尾部：\n${llama.__log.slice(-1500)}`);

// ---- 2) 引擎（uvicorn + 执行器），同时采样三态
// 刻意用**适配层自己拼的启动参数**（`resolveEngineLaunch`）—— 这样这一步同时验证了那个纯函数，
// 而不是"脚本里另写一份能跑的命令、适配层那份从没被真正执行过"。
const launch = resolveEngineLaunch({
  port: ENGINE_PORT, useGpu: true, modelsTtl: 0,
  sakuraBase: `http://127.0.0.1:${LLAMA_PORT}/v1`,
});
log(`拉起引擎：${launch.cmd.join(' ')}  （cwd=${launch.cwd}）`);
report.launch = { cmd: launch.cmd, cwd: launch.cwd, executorPort: launch.executorPort };
const engine = spawnLogged(launch.cmd[0], launch.cmd.slice(1), { cwd: launch.cwd, env: launch.env }, 'engine');

const timeline = [];
let last = null;
const t0 = Date.now();
for (let i = 0; i < 600; i += 1) { // 最多 5 min
  const p = await probeEngine();
  if (p.state !== last) {
    timeline.push({ atMs: Date.now() - t0, state: p.state, port: p.port, executorUp: p.state === 'running' });
    log(`  t+${((Date.now() - t0) / 1000).toFixed(1)}s  state=${p.state}`);
    last = p.state;
  }
  if (p.state === 'running') break;
  if (engine.exitCode !== null) throw new Error(`引擎进程已退出（code=${engine.exitCode}）；日志尾部：\n${engine.__log.slice(-2000)}`);
  await sleep(300);
}
report.probeTimeline = timeline;
const states = [...new Set(timeline.map((t) => t.state))];
log(`三态采样序列：${states.join(' → ')}`);

// ---- 3) 用**适配层本身**送图
const bytes = fs.readFileSync(TEST_IMAGE);
log(`送图：test_0.webp（${bytes.length} B）→ 期待中文译文（首张含模型加载，可能数分钟）`);
const tStart = Date.now();
let out = null;
let err = null;
try {
  out = await translateImage(bytes, { seq: 1, from: 'ja', to: 'zh', mime: 'image/webp' });
} catch (e) {
  err = e;
}
const elapsedMs = Date.now() - tStart;
if (err) {
  report.translate = { ok: false, code: err instanceof EngineError ? err.code : err.name, message: String(err.message), elapsedMs };
  log(`❌ 翻译失败：${JSON.stringify(report.translate)}`);
  log(`引擎日志尾部：\n${engine.__log.slice(-2500)}`);
} else {
  const outPath = path.join(OUT, `server-mode.${out.ext}`);
  fs.writeFileSync(outPath, out.bytes);
  report.translate = {
    ok: true, ext: out.ext, mime: out.mime, bytes: out.bytes.length, elapsedMs, outPath,
    sha256: sha256(outPath),
  };
  log(`✅ 译文已落盘：${outPath}（${out.bytes.length} B，${(elapsedMs / 1000).toFixed(1)} s）`);
}

report.engineLogTail = engine.__log.slice(-4000);
report.llamaLogTail = llama.__log.slice(-1000);
report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

// ---- 4) 逐像素比对（用引擎 venv 的 numpy/PIL，不自己实现 PNG 解码）
if (report.translate?.ok) {
  const py = `
import numpy as np, json
from PIL import Image
src = np.asarray(Image.open(${JSON.stringify(TEST_IMAGE)}).convert('RGB')).astype(int)
s1  = np.asarray(Image.open(${JSON.stringify(report.translate.outPath)}).convert('RGB')).astype(int)
res = {'inputSize': list(src.shape[1::-1]), 'outputSize': list(s1.shape[1::-1])}
if src.shape == s1.shape:
    d = np.abs(s1 - src).max(axis=2)
    res['changedPct'] = round(100*float((d > 8).mean()), 2)
    res['maxChannelDiff'] = int(d.max())
import os
g1p = ${JSON.stringify(G1_OUTPUT)}
if os.path.exists(g1p):
    g1 = np.asarray(Image.open(g1p).convert('RGB')).astype(int)
    if g1.shape == s1.shape:
        d2 = np.abs(s1 - g1).max(axis=2)
        res['vsLocalModeChangedPct'] = round(100*float((d2 > 8).mean()), 2)
        res['vsLocalModeMaxDiff'] = int(d2.max())
print(json.dumps(res, ensure_ascii=False))
`;
  const r = spawnSync(VENV_PY, ['-c', py], { encoding: 'utf8' });
  const line = (r.stdout || '').trim().split('\n').pop();
  try { report.compare = JSON.parse(line); } catch { report.compare = { raw: r.stdout, err: r.stderr }; }
  log(`逐像素比对：${JSON.stringify(report.compare)}`);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
}

log(`报告：${path.join(OUT, 'report.json')}`);
if (!KEEP) { shutdown(); }
process.exitCode = report.translate?.ok ? 0 : 1;
