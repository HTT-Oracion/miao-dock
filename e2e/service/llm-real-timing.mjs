#!/usr/bin/env node
/**
 * 真 ③（`llama-server`）的**冷启动耗时 + 常驻内存**实测 —— 走**产品路径**（`LlmSupervisor`）。
 *
 * ## 为什么必须实测而不是照抄规格
 * 《04》§9.1 给了三档的释放量（Tiny ≈ 1.5–2 GB / Small ≈ 5 GB / Medium ≈ 9–10 GB），
 * 而「空闲卸载值不值得做」这个判断、以及 S6 设置页那句「下次翻译会稍慢」到底该写"稍慢"还是
 * "要等一会儿"，**只能由本机实测数字决定**。拍脑袋写文案的后果是：用户以为只是"稍慢"，
 * 实际等了半分钟，于是以为坏了。
 *
 * ## 它顺带验了三件事（都是 S4 的真档回路，平时没有权重就验不到）
 *   ① `resolveLlmLaunch()`（real 档）拼出来的命令行**真能把 llama-server 拉起来**；
 *   ② `child-watch.mjs` 包住外部二进制后，就绪探针（tcp + `GET /v1/models`）能正常通过；
 *   ③ `stop()` 之后**进程真的没了**（而不是只关了个句柄）—— 内存回落是它的外部证据。
 *
 * 用法：`node e2e/service/llm-real-timing.mjs`
 * 约束：只读**产品落点**（B1 起为 `<appData>/runtimes/manga-translator/`，经 `resolveLlmLaunch()` 解析）
 *       下的 llama.cpp 二进制与权重；只绑 127.0.0.1；结束一定停进程。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-llm-timing-'));

// 必须在 import config 之前落下（config 顶层就读）
process.env.MIAO_ENGINE_PROTOCOL = 'real';
process.env.MIAO_TOKEN = process.env.MIAO_TOKEN || '0'.repeat(64);
process.env.MIAO_STATE_DIR = path.join(TMP, 'state');
process.env.MIAO_LLM_PORT = String(await findFreePort(9200));

const { LlmSupervisor } = await import(pathToFileURL(path.join(ROOT, 'service', 'src', 'settings', 'llm-supervisor.mjs')).href);

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function findFreePort(start) {
  const net = await import('node:net');
  for (let p = start; p < start + 200; p += 1) {
    const free = await new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: p });
      const done = (v) => { s.destroy(); resolve(v); };
      s.setTimeout(120);
      s.once('connect', () => done(false));
      s.once('timeout', () => done(true));
      s.once('error', () => done(true));
    });
    if (free) return p;
  }
  throw new Error('找不到空闲端口');
}

function psField(pid, field) {
  try {
    const out = execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const n = Number.parseInt(String(out).trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/**
 * 真正的 `llama-server` 进程。
 *
 * ⚠️ 两个坑，两个都实测踩过：
 *   ① `pgrep -f llama-server` 匹配的是**整条命令行** —— child-watch 那层 Node 的命令行里
 *      也含 `llama-server`（它是被包装的目标），于是会多匹配出一个 node 进程；
 *   ② macOS 的 `ps -o rss=` 单位是 **KB**（不是 Linux 的 KB 也一样，但很多人按 MB 读），
 *      直接当 MB 会得到"3 万 MB 内存"这种一眼假的数字。
 *   所以这里按 `comm` 的 basename 精确挑，并在格式化处做 KB → MB 换算。
 */
function llamaServerPids() {
  let raw = [];
  try {
    const out = execFileSync('pgrep', ['-f', 'llama-server'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    raw = String(out).split('\n').map((s) => Number.parseInt(s.trim(), 10)).filter(Number.isFinite);
  } catch { return []; }
  return raw.filter((pid) => {
    try {
      const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
        encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return path.basename(comm) === 'llama-server';
    } catch { return false; }
  });
}

/** 系统可用内存（free + inactive + speculative 页）—— 用 macOS 自带的 `vm_stat`，不装任何东西 */
function freeMemMb() {
  try {
    const out = execFileSync('vm_stat', [], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const pageSize = Number.parseInt(/page size of (\d+) bytes/.exec(out)?.[1] ?? '4096', 10);
    const pages = ['Pages free', 'Pages inactive', 'Pages speculative']
      .map((k) => Number.parseInt(new RegExp(`${k}:\\s+(\\d+)\\.`).exec(out)?.[1] ?? '0', 10))
      .reduce((a, b) => a + b, 0);
    return Math.round((pages * pageSize) / 1024 / 1024);
  } catch { return null; }
}

const mb = (n) => (n === null ? '未测到' : `${n} MB`);
/** macOS 的 `ps -o rss=` 单位是 KB ⇒ 换算成 MB 再展示（不换算会得到"3 万 MB"这种一眼假的数字） */
const rssMb = (kb) => (kb === null ? '未测到' : `${Math.round(kb / 1024)} MB（ps 原值 ${kb} KB）`);
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;

const sup = new LlmSupervisor({ watch: true, log: (m) => console.log(`   · ${m}`) });
let pids = [];
try {
  const freeBefore = freeMemMb();
  console.log(`\n真 ③ 实测（产品路径：LlmSupervisor + child-watch + 真 llama-server）`);
  console.log(`端口 ${sup.port} / 权重 ${path.basename(sup.launch.model)} / 命令 ${sup.launch.cmd.length} 段`);
  if (!fs.existsSync(sup.launch.cmd[0])) throw new Error(`llama-server 二进制不存在：${sup.launch.cmd[0]}`);
  if (!fs.existsSync(sup.launch.model)) throw new Error(`权重不存在：${sup.launch.model}`);

  console.log(`\n[1/3] 冷启动（含读取权重 + 首次 Metal 初始化）…`);
  const t0 = Date.now();
  const snap = await sup.start({ timeoutMs: 180_000 });
  const bootMs = Date.now() - t0;
  pids = llamaServerPids();
  const rss = pids.length ? psField(pids[0], 'rss') : null;
  const freeAfter = freeMemMb();

  console.log(`\n[2/3] 就绪快照`);
  console.log(`   冷启动耗时 : ${sec(bootMs)}（到 \`GET /v1/models\` 200 为止）`);
  console.log(`   state/模型 : ${snap.state} / ${snap.model}`);
  console.log(`   llama-server pid : ${pids.join(',') || '未匹配到'}（LlmSupervisor 报的是 child-watch 层 pid=${snap.pid}）`);
  console.log(`   常驻内存   : RSS ${rssMb(rss)}`);
  console.log(`   系统可用内存 : ${mb(freeBefore)} → ${mb(freeAfter)}（差 ${freeBefore !== null && freeAfter !== null ? `${Math.round((freeBefore - freeAfter))} MB` : '未测到'}）`);

  console.log(`\n[3/3] 停 ③（模拟空闲卸载）…`);
  const t1 = Date.now();
  const stopped = await sup.stop({ reason: '计时收尾', graceMs: 10_000 });
  const stopMs = Date.now() - t1;
  // 停完等 2s 再看系统可用内存：内核回收 mmap / Metal buffer 有个窗口，
  // 只等 500ms 会明显低估 Tier1 的释放量（实测差异可达数倍）。
  await sleep(2000);
  const freeStopped = freeMemMb();
  console.log(`   停止耗时   : ${sec(stopMs)}（优雅退出=${stopped.exited} 端口释放=${stopped.portFreed}）`);
  console.log(`   残留 llama-server : ${llamaServerPids().length} 个`);
  console.log(`   系统可用内存 : ${mb(freeAfter)} → ${mb(freeStopped)}（**Tier1 释放量**：${freeAfter !== null && freeStopped !== null ? `${freeStopped - freeAfter} MB` : '未测到'}）`);

  console.log(`\n结论（供 S6 文案与默认阈值取用）：`);
  console.log(`   · 卸载后再次翻译要**多等约 ${sec(bootMs)}** ⇒ 界面文案不能用"无感"；`);
  console.log(`   · 默认阈值 5 min 的前提是"连续翻译的间隔远小于 5 min"，若实测间隔更短要调大。`);
} finally {
  await sup.stop({ reason: '兜底', graceMs: 5000 }).catch(() => {});
  for (const p of llamaServerPids()) { try { process.kill(p, 'SIGKILL'); } catch { /* ignore */ } }
  fs.rmSync(TMP, { recursive: true, force: true });
}
