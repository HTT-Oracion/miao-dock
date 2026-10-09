#!/usr/bin/env node
/**
 * S4-a 硬件探测 / 档位映射 / 加速后端 断言 —— **且必须可反证**。
 *
 * 为什么单独一个脚本：本模块的判据全是「映射表逐行」——它是**纯查表**逻辑，
 * 最容易被"顺手优化"而不报警（§7.2 的 `else` 分支本身就是一条被写进映射表的结论）。
 * 故本脚本**把 §7.2 表格逐行钉住**，边界值（15.9/16、9.9/10、23.9/24、31.9/32）全部显式断言。
 *
 * 断言分组：
 *   H  硬件探测与档位映射（《04》§7.1/§7.2）—— 全部走**注入的假硬件**，与本机真实配置解耦
 *   A  加速后端与启动参数（《04》§7.3/§7.4）
 *   T  设置页档位选项（《02》§5：物理不可行档位不出现 / Small 标"不推荐"）
 *   L  ③ LLM 看守（`llm-supervisor.mjs`）—— **起真进程**，用 pid/端口/父死传播三重取证
 *   D  档位降档（`tier-downgrade.mjs`，《04》§8）—— 仅一次 / 服务级 / 不叠加 / 下界
 *   I  空闲卸载（`idle-policy.mjs`，《04》§9）—— 判定边界 + **真实进程**的 E6 集成
 *   R  真机自检（**非契约**：只把本机实际探测结果打印出来，供交叉核对）
 *
 * 用法：
 *   node e2e/service/engine-profile-check.mjs            正向跑
 *   node e2e/service/engine-profile-check.mjs --refute   反证轮（破坏源文件 → 断言必须变红 → 按字节恢复）
 *
 * 约束：纯 Node、零依赖；不写用户目录；反证轮结束**必须**按字节还原。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVICE_SRC = path.join(ROOT, 'service', 'src');
// 🔴 ver2.2 模块化：设置域模块下钻到 settings/，漫画域模块下钻到 manga/
const SETTINGS_SRC = path.join(SERVICE_SRC, 'settings');
const MANGA_SRC = path.join(SERVICE_SRC, 'manga');
const PROFILE_FILE = path.join(SETTINGS_SRC, 'engine-profile.mjs');
const SUPERVISOR_FILE = path.join(SETTINGS_SRC, 'llm-supervisor.mjs');
const DOWNGRADE_FILE = path.join(SETTINGS_SRC, 'tier-downgrade.mjs');
const IDLE_FILE = path.join(SETTINGS_SRC, 'idle-policy.mjs');
const STORE_FILE = path.join(MANGA_SRC, 'store.mjs');

const REFUTE = process.argv.includes('--refute');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-s4-check-'));

// ⚠️ 这些 env 必须在**任何** `config.mjs` 被 import 之前落下（config 在模块顶层读它们）：
//    · MIAO_TOKEN  —— 否则 config 顶层会 ensureToken() 去写**用户真实的** token 文件
//    · MIAO_STATE_DIR —— 落盘全在临时目录，不碰用户目录
//    · MIAO_ENGINE_PROTOCOL = mock —— ③ 用仓内替身（秒级、无权重）；真档共用同一段看守代码
process.env.MIAO_ENGINE_PROTOCOL = 'mock';
process.env.MIAO_TOKEN = process.env.MIAO_TOKEN || '0'.repeat(64);
process.env.MIAO_STATE_DIR = path.join(TMP, 'state');

// ------------------------------------------------------------------ 进程 / 端口小工具

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function portOpen(port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function findFreePort(start) {
  for (let p = start; p < start + 200; p += 1) if (!(await portOpen(p, 120))) return p;
  throw new Error('找不到空闲端口');
}

/** 直接打 ③ 的 HTTP 面（**独立于被测代码**的第二取证路径） */
async function httpUp(port, pathname) {
  const http = await import('node:http');
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', timeout: 800 },
      (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

const MOD = await import(pathToFileURL(PROFILE_FILE).href);
const {
  mapTier, detectAccel, detectGpu, probeHardware,
  feasibleTiers, tierOptions, accelLaunchFlags, TIERS, TIER_PEAK_GB,
} = MOD;

// ------------------------------------------------------------------ 结果收集

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}
function attempt(fn) {
  try { return { value: fn(), err: null }; }
  catch (err) { return { value: null, err }; }
}
function errText(err) {
  return err ? `抛错 ${err.code || err.name}: ${err.message}` : '';
}
/** 断言 id 形如 `「短码」 描述`；反证轮只写短码 ⇒ 必须按前缀匹配，否则恒 undefined→"未变红"误报 */
function matchById(list, code) {
  return list.find((r) => r.id === code || r.id.startsWith(`${code} `));
}
const out = { pass: 0, fail: 0 };
function emit() { out.pass = results.filter((r) => r.ok).length; out.fail = results.length - out.pass; }
function printResults(title) {
  emit();
  console.log(`\n### ${title}`);
  for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.id}${r.detail ? `  ${r.detail}` : ''}`);
  console.log(`[RESULT] ${JSON.stringify({ results, pass: out.pass, fail: out.fail })}`);
  console.log(`\n通过 ${out.pass} / 失败 ${out.fail}`);
}

// ------------------------------------------------------------------ 假硬件构造器

const metal = (unifiedGb) => ({ kind: 'metal', unifiedGb, name: 'fake-metal' });
const cuda = (vramGb) => ({ kind: 'cuda', vramGb, name: 'fake-cuda' });
const cpuGpu = { kind: 'cpu', name: 'fake-cpu' };

// ================================================================ L · ③ LLM 看守（真进程）

/**
 * 起**真的子进程**来验 ③ 的看守 —— 这一组不用假 spawn。
 *
 * 为什么必须真进程：「卸载后 ③ 真的退了吗」这个问题，只有 pid / ppid / 端口三样能回答。
 * 用假 spawn 的话，断言只能证明"我调用了 kill"，证明不了"进程没了、端口空了" ——
 * 而 §9.4 特意把「卸载 ≠ 未就绪」写成一条铁律，正是因为这两件事**很容易被混为一谈**。
 * 跑的是 mock 档的仓内替身（秒级、无权重）；真档 llama-server 走的是**同一段看守代码**，
 * 差异只在配方（见 `resolveLlmLaunch`）。
 */
async function runLlmSupervisor() {
  // ⚠️ 必须在 import `llm-supervisor.mjs` **之前**落进 env：它 import 的 `config.mjs` 在模块
  //    顶层就读这些值（读晚了就会拿到 real 协议与 8080）。
  process.env.MIAO_ENGINE_PROTOCOL = 'mock';
  process.env.MIAO_LLM_PORT = String(await findFreePort(5841));
  process.env.MIAO_TOKEN = process.env.MIAO_TOKEN || '0'.repeat(64);
  process.env.MIAO_STATE_DIR = path.join(TMP, 'state');
  const port = Number(process.env.MIAO_LLM_PORT);

  const { LlmSupervisor } = await import(pathToFileURL(SUPERVISOR_FILE).href);

  const logs = [];
  const sup = new LlmSupervisor({ log: (m) => logs.push(m) });
  const pids = [];
  try {
    const r1 = await sup.start({ timeoutMs: 30_000 });
    pids.push(r1.pid);
    check('L1 ③ 被真的拉起：state=running、pid>0、端口在听、`/v1/models` 200',
      r1.state === 'running' && r1.pid > 0 && r1.port === port && (await httpUp(port, '/v1/models')),
      JSON.stringify(r1));

    // model 必须取自配方的 **`model` 字段**（`resolveLlmLaunch` 算好、含档位），
    // 而不是从命令行反解 —— mock 配方的命令行里根本没有 `-m <权重文件>`（它用的是 `--model tiny`），
    // 所以能报出 `sakura-mock:tiny` 恰恰证明走的是"读配方"而不是"字符串考古"。
    check('L2 快照形状即契约：`{state,model,pid,port}` 四键；model 取自配方的 model 字段（含档位 ⇒ 降档后能报出新权重）',
      Object.keys(sup.snapshot()).sort().join(',') === 'model,pid,port,state'
        && sup.snapshot().model === 'sakura-mock:tiny' && sup.snapshot().model === sup.launch.model,
      JSON.stringify(sup.snapshot()));

    const stop1 = await sup.stop({ reason: 'S4 断言', graceMs: 4000 });
    const stillAlive = isAlive(r1.pid);
    const stillOpen = await portOpen(port);
    check('L4 停 = 进程**真的消失** + 端口**真的释放**（§9.4：卸载 ≠ 未就绪，两者必须能分开）',
      sup.state === 'stopped' && !stillAlive && !stillOpen,
      JSON.stringify({ state: sup.state, alive: stillAlive, portOpen: stillOpen, r: stop1 }));

    const r2 = await sup.restart({ timeoutMs: 30_000 });
    pids.push(r2.pid);
    check('L5 懒加载恢复（§9.3）：能重新拉起，**新 pid 与旧的不同**、端口重新在听',
      r2.state === 'running' && r2.pid > 0 && r2.pid !== r1.pid && (await httpUp(port, '/v1/models')),
      `旧 pid=${r1.pid} 新 pid=${r2.pid} restarts=${sup.restarts}`);

    check('L6 重启可观测（E6 取证用）：restarts=1，且卸载/重启都在日志里留痕',
      sup.restarts === 1 && logs.some((l) => l.includes('停止 ③')) && logs.some((l) => l.includes('③ LLM 就绪')),
      `restarts=${sup.restarts} logs=${logs.length}`);
  } finally {
    await sup.stop({ reason: '断言收尾', graceMs: 3000 }).catch(() => {});
    for (const p of pids) if (isAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* ignore */ } }
  }

  // ------------------------------------------------------- L3 · 父死传播（E11 在 ③ 归属移交后的版本）
  //
  // 为什么不用 `ps -o ppid=`：本机沙箱直接 `EPERM`（`spawnSync ps EPERM`），拿不到。
  // 而**父死传播**其实是更强的证据 —— 它同时回答两件事：
  //   ① ③ 的父进程确实是"承载看守的那个进程"（否则它不会随我们而死）；
  //   ② E11 的判据在归属权移交后依然成立（主进程被 SIGKILL 后 8080 必须释放）。
  // 做法：另起一个 harness 子进程去持有 ③，我们 SIGKILL harness —— 此时 ③ 只能自救。
  const fleet = String(await findFreePort(port + 40));
  const harnessSrc = `
    const { LlmSupervisor } = await import(${JSON.stringify(pathToFileURL(SUPERVISOR_FILE).href)});
    const sup = new LlmSupervisor({ log: () => {} });
    const s = await sup.start({ timeoutMs: 30000 });
    console.log('HARNESS_LLM ' + JSON.stringify(s));
    setInterval(() => {}, 1000);
  `;
  const harness = spawn(process.execPath, ['--input-type=module', '-e', harnessSrc], {
    env: { ...process.env, MIAO_ENGINE_PROTOCOL: 'mock', MIAO_LLM_PORT: fleet },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let harnessOut = '';
  harness.stdout.on('data', (b) => { harnessOut += b.toString(); });
  try {
    const until = Date.now() + 30_000;
    let started = null;
    while (Date.now() < until) {
      const m = /HARNESS_LLM (\{.*\})/.exec(harnessOut);
      if (m) { started = JSON.parse(m[1]); break; }
      await sleep(120);
    }
    if (!started) {
      check('L3 父死传播：③ 随持有它的进程一起消失、端口释放（E11 在归属移交后的版本）', false,
        `harness 未在 30s 内拉起 ③：${harnessOut.slice(-200)}`);
    } else {
      const llmPid = started.pid;
      // 强杀 harness —— 它没有任何机会执行清理代码（与 E11 对主进程做的事完全相同）
      harness.kill('SIGKILL');
      let gone = false;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (!isAlive(llmPid) && !(await portOpen(fleet))) { gone = true; break; }
        await sleep(200);
      }
      check('L3 父死传播：③ 随持有它的进程一起消失、端口释放（E11 在归属移交后的版本）',
        gone, gone ? `pid ${llmPid} 已退、端口 ${fleet} 已释放`
          : `pid ${llmPid} 仍活着=${isAlive(llmPid)} 端口仍开=${await portOpen(fleet)}`,
        );
      if (!gone) { try { process.kill(llmPid, 'SIGKILL'); } catch { /* ignore */ } }
    }
  } finally {
    if (harness.exitCode === null) harness.kill('SIGKILL');
  }
}

// ================================================================ D · 档位降档（纯判定，《04》§8）

/**
 * §8 的降档规则**全是判定**：什么时候降、降几档、降完还算不算重试、最低档怎么办。
 * 判定与"真去重启 ③"分开（后者在 `e5-e6-check.mjs` 用真进程验），
 * 是因为这些边界值（仅一次 / 最低档 / 关掉开关）如果只能靠真重启来验，
 * 一条断言就要几十秒 + 一个端口，最后必然被"只跑一次"给绕过。
 */
async function runDowngradeUnit() {
  const { nextLowerTier, isOomError, flattenError, createTierDowngrade } =
    await import(pathToFileURL(DOWNGRADE_FILE).href);

  check('D1 nextLowerTier 方向：medium→small→tiny→null（往**低**走；最低档明确给 null 而不是回绕到最高档）',
    nextLowerTier('medium') === 'small' && nextLowerTier('small') === 'tiny'
      && nextLowerTier('tiny') === null && nextLowerTier('某个没听过的档') === null,
    [nextLowerTier('medium'), nextLowerTier('small'), nextLowerTier('tiny'), nextLowerTier('某个没听过的档')].join(' → '));

  // §8.1 的触发条件写的是四类（CUDA OOM / MPS OOM / 系统内存 OOM / 显存不足以加载权重），
  // 而现实里这四类被**不同的层**用**不同的文案**报出来。只认一种写法 ⇒ 真 OOM 了却没降档。
  const oomSamples = [
    ['CUDA', 'CUDA out of memory. Tried to allocate 1.20 GiB (GPU 0; 16.00 GiB total capacity)'],
    ['MPS', 'MPS backend out of memory (MPS allocated: 1.51 GiB, other allocations: 128.00 MiB)'],
    ['系统内存', 'RuntimeError: Cannot allocate memory'],
    ['显存不足载权重', 'failed to allocate 6144.00 MB of memory for model weights'],
    ['llama.cpp 口径', 'llama.cpp: unable to allocate buffer of size 4096'],
    ['Python 口径', 'MemoryError'],
  ];
  const oomMiss = oomSamples.filter(([, t]) => !isOomError({ message: t }));
  check('D2 §8.1 四类 OOM 触发都能识别（CUDA / MPS / 系统内存 / 显存不足以加载权重），且兼容各层的实际文案',
    oomMiss.length === 0,
    oomMiss.length ? `漏识别：${oomMiss.map(([k]) => k).join(',')}` : `${oomSamples.length}/${oomSamples.length}`);

  const notOom = [
    'connect ECONNREFUSED 127.0.0.1:5003',
    '引擎返回 500',
    '结果流里没有结果帧（code 0）',
    'request timeout after 30000ms',
    '输入字节不是可识别图片',
    'ENGINE_INFERENCE_FAILED: 推理失败（seq=3，注入）',
  ];
  const wrongHit = notOom.filter((t) => isOomError({ message: t }));
  check('D3 非 OOM 失败**不得**命中签名（误判 ⇒ 白白降一档，用户看到翻译质量莫名下降且无从追溯）',
    wrongHit.length === 0,
    wrongHit.length ? `误判：${wrongHit.join(' | ')}` : `${notOom.length}/${notOom.length}`);

  check('D4 OOM 签名能穿透 `detail` 对象（引擎常把真正的原因放在 detail，message 只剩一句"推理失败"）；'
    + '但**只按错误码**认不出 OOM（`ENGINE_OOM` 这种自造码在真实引擎里未必存在 ⇒ 必须看文案）',
    isOomError({ message: '引擎报告：推理失败', detail: { cause: 'CUDA out of memory' } })
      && isOomError({ message: 'EngineError', detail: 'failed to allocate 4096 MB' })
      && flattenError({ message: 'a', detail: { b: 1 } }).includes('"b":1'),
    flattenError({ message: '引擎报告：推理失败', detail: { cause: 'CUDA out of memory' } }));

  const ctl = createTierDowngrade({ tier: 'medium' });
  const p1 = ctl.plan();
  const r1 = await ctl.tryDowngrade();
  const p2 = ctl.plan();
  check('D5 §8.1「仅降一次」：第一次降、第二次起拒绝（闩落下后 `plan()` 直接给 already-downgraded）',
    p1.downgrade === true && p1.to === 'small' && r1.downgraded === true && r1.to === 'small'
      && p2.downgrade === false && p2.reason === 'already-downgraded' && ctl.currentTier() === 'small',
    `${p1.to} → ${p2.reason}`);

  const low = createTierDowngrade({ tier: 'tiny' });
  const rLow = await low.tryDowngrade();
  check('D6 §8.2 底线：已是最低档（tiny）仍 OOM ⇒ 不降、不改状态（调用方据此把任务判 failed）',
    low.plan().reason === 'lowest-tier' && rLow.downgraded === false && low.currentTier() === 'tiny',
    `${low.plan().reason} downgraded=${rLow.downgraded}`);

  const applied = [];
  const logs = [];
  const WEIGHTS = { medium: 'sakura-7b.gguf', small: 'sakura-3b.gguf', tiny: 'sakura-1.5b-qwen2.5-v1.0-fp16.gguf' };
  const svc = createTierDowngrade({
    tier: 'medium',
    apply: async (t) => { applied.push(t); },
    log: (m) => logs.push(m),
    modelOf: (t) => WEIGHTS[t] || null,
  });
  await svc.tryDowngrade();
  check('D7 §8.2 服务级 + 留痕：`apply` 只调一次、history 一条、日志含「引擎已从 medium 降至 small」并带上两个权重名',
    applied.length === 1 && applied[0] === 'small' && svc.history().length === 1
      && logs.some((l) => l.includes('引擎已从 medium 降至 small'))
      && logs.some((l) => l.includes(WEIGHTS.medium) && l.includes(WEIGHTS.small)),
    `${logs.filter((l) => l.includes('引擎已从'))[0]?.slice(0, 120) ?? '无留痕'}`);

  const failLogs = [];
  const bad = createTierDowngrade({
    tier: 'small',
    apply: async () => { throw new Error('拉起失败'); },
    log: (m) => failLogs.push(m),
  });
  const rBad = await bad.tryDowngrade();
  check('D8 `apply` 抛错**也不退还**闩：第二次不再尝试（否则每次 OOM 都再重启一次 ③，越修越忙）',
    rBad.downgraded === false && rBad.reason === 'apply-failed' && bad.plan().reason === 'already-downgraded'
      && failLogs.some((l) => l.includes('降档落地失败')),
    `${rBad.reason} → ${bad.plan().reason}`);

  const off = createTierDowngrade({ tier: 'medium', disabled: true });
  check('D9 反证开关 `MIAO_NO_TIER_DOWNGRADE` 生效：直接拒绝降档（关掉机制后依赖它的断言必须变红）',
    off.plan().reason === 'disabled' && (await off.tryDowngrade()).downgraded === false,
    off.plan().reason);
}

// ================================================================ I · 空闲卸载（纯判定，《04》§9）

/**
 * §9.2 的**安全铁律**是这一组的全部重点：
 *   `允许卸载 ⇔ 队列无 running 任务 且 无 queued 任务 且 距最后一次任务完成 ≥ 阈值`
 * 而「有任务排队时『空闲 5 分钟』计时器**绝不能**触发」这句，是本项目**唯一**一条
 * 把"什么时候不许做"写成铁律的规格 —— 写错的方向不是"少卸一次"，是**正在排队时把引擎停掉**。
 * 故 I2/I8 两条断言专门钉它。
 */
async function runIdleUnit() {
  const { decideUnloadLlm, queueFacts, lastActivityAt, createIdleWatcher, UNLOAD_REASONS } =
    await import(pathToFileURL(IDLE_FILE).href);
  const R = UNLOAD_REASONS;

  check('I0 `UNLOAD_REASONS` 是**机器可读令牌**（snake_case），且七个取值与判定分支一一对应 —— '
    + '取值被断言依赖就是契约，不能同时兼任给人看的中文文案',
    R.ok === 'idle' && R.busyQueued === 'busy_queued' && R.busyRunning === 'busy_running'
      && R.neverRan === 'never_ran' && R.notIdleEnough === 'not_idle_enough'
      && R.disabled === 'disabled' && R.never === 'never'
      && new Set(Object.values(R)).size === 7,
    Object.values(R).join(','));

  const T0 = 1_700_000_000_000;
  const at = (o = {}) => decideUnloadLlm({
    now: T0, lastActivityAt: T0 - 300_000, running: 0, queued: 0, idleMs: 300_000, ...o,
  });

  check('I1 §9.1 阈值边界：恰好 5min 触发 · 差 1ms 不触发（`>=` 与 `>` 的区别被钉死在这里）',
    at().unload === true
      && at({ lastActivityAt: T0 - 299_999 }).unload === false
      && at({ lastActivityAt: T0 - 300_001 }).unload === true,
    `5min→${at().unload} 少1ms→${at({ lastActivityAt: T0 - 299_999 }).unload} 多1ms→${at({ lastActivityAt: T0 - 300_001 }).unload}`);

  const busyQ = at({ lastActivityAt: T0 - 3_600_000, queued: 1 });
  const busyR = at({ lastActivityAt: T0 - 3_600_000, running: 1 });
  check('I2 §9.2 安全铁律：有任务排队/在跑时**哪怕空闲 1 小时也绝不卸载**',
    busyQ.unload === false && busyQ.reason === R.busyQueued
      && busyR.unload === false && busyR.reason === R.busyRunning,
    `queued→${busyQ.reason} running→${busyR.reason}`);

  check('I3 本次运行还没跑过任务（`lastActivityAt=null`）⇒ 不卸：没有热态可卸，卸了只是白付一次冷启动',
    at({ lastActivityAt: null }).unload === false && at({ lastActivityAt: null }).reason === R.neverRan,
    at({ lastActivityAt: null }).reason);

  check('I4 「从不卸载」与反证开关 `MIAO_NO_IDLE_UNLOAD` 都能关掉它（§9.3 末句：用户配置『从不卸载』→ 两级都关）',
    at({ neverUnload: true }).reason === R.never && at({ neverUnload: true }).unload === false
      && at({ disabled: true }).reason === R.disabled && at({ disabled: true }).unload === false,
    `${at({ neverUnload: true }).reason} / ${at({ disabled: true }).reason}`);

  // 《02》§5：「空闲卸载 · LLM」在设置页是**数字（分钟）**，0 = 从不卸载。
  // 这是最容易写反的一格 —— 少一个判据，"0 分钟"就变成"立刻卸载"（用户拿到的是他要的反面）。
  const zero = at({ idleMs: 0, lastActivityAt: T0 - 3_600_000 });
  const badMs = [at({ idleMs: -1, lastActivityAt: T0 - 3_600_000 }), at({ idleMs: Number.NaN, lastActivityAt: T0 - 3_600_000 })];
  check('I9 《02》§5：阈值 **0 = 从不卸载**（不是"立刻卸载"）；负值/NaN 这类"配错了"也按最保守处理',
    zero.unload === false && zero.reason === R.never
      && badMs.every((d) => d.unload === false && d.reason === R.never),
    `0→${zero.reason} 负值→${badMs[0].reason} NaN→${badMs[1].reason}`);

  check('I5 `queueFacts` 用 `currentTaskId` 判 running、`queue.length` 判 queued —— '
    + '若改拿 `queueSnapshot().running`（对象或 null）当计数器，`null>0`/`{}>0` 恒 false ⇒ **恒判空闲**（典型假绿）',
    queueFacts({ currentTaskId: null, queue: [] }).busy === false
      && queueFacts({ currentTaskId: 't1', queue: [] }).running === 1
      && queueFacts({ currentTaskId: null, queue: [{}, {}] }).queued === 2,
    JSON.stringify(queueFacts({ currentTaskId: 't1', queue: [{}] })));

  const idStore = {
    tasks: new Map([
      ['a', { createdAt: new Date(T0 - 900_000).toISOString(), finishedAt: new Date(T0 - 800_000).toISOString() }],
      ['b', { createdAt: new Date(T0 - 100_000).toISOString(), finishedAt: null }],
    ]),
  };
  check('I6 「最后一次任务活动」取创建/收尾的**较大者**（任务刚创建、还在排队时也会把计时推后 ⇒ 偏保守，宁可少卸）',
    lastActivityAt(idStore) === T0 - 100_000 && lastActivityAt({ tasks: new Map() }) === null,
    `${lastActivityAt(idStore)} / 空任务表=${lastActivityAt({ tasks: new Map() })}`);

  let nowMs = T0;
  const stopped = [];
  const w = createIdleWatcher({
    store: { currentTaskId: null, queue: [], tasks: idStore.tasks },
    supervisor: { stop: async (o) => { stopped.push(o); } },
    idleMs: 300_000, now: () => nowMs, log: () => {},
  });
  const no1 = await w.tick();
  nowMs = T0 + 300_000;
  const yes = await w.tick();
  check('I7 看护可**手动步进**（注入可控时钟）：到点前不卸、到点后卸一次并带原因 —— '
    + '断言因此不必真等 5 分钟（"等 5 分钟"的断言不可反证：等不到就重跑，永远分不清是坏了还是慢）',
    no1.unload === false && no1.reason === R.notIdleEnough
      && yes.unload === true && stopped.length === 1 && stopped[0].reason === '空闲卸载',
    `${no1.reason} → unload=${yes.unload} stops=${stopped.length}`);

  let now2 = T0;
  const stopped2 = [];
  const w2 = createIdleWatcher({
    store: { currentTaskId: null, queue: [{}], tasks: idStore.tasks },
    supervisor: { stop: async () => { stopped2.push(1); } },
    idleMs: 300_000, now: () => now2, log: () => {},
  });
  now2 = T0 + 3_600_000;
  const busy = await w2.tick();
  check('I8 §9.2 在**真实接线**上的执行点：有任务排队时看护不动作（空闲一个小时也不动）',
    busy.unload === false && busy.reason === R.busyQueued && stopped2.length === 0,
    `${busy.reason} stops=${stopped2.length}`);

  // ---- I10 · 时间戳精度：判据两侧必须同精度 -------------------------------
  //
  // 🔴 这条是**从一个稳定的偶发红回填的**（`check:e5e6` 第 2~5 轮稳定 11/5、E6 整组红，
  //    而 E5 全绿、第二个服务实例的 E6.7/E6.8 也绿）。现场取值：
  //      下界 `runtimeStartedAtMs = 1791304803088`（毫秒）
  //      任务 `createdAt` 截断成 `...803000`（秒）⇒ `803000 < 803088` ⇒ `la=null`
  //      该轮 82 次巡检里 81 次 `never_ran` ⇒ 空闲卸载整轮不执行
  //    根因是**精度错配**（`nowIso()` 截毫秒 vs `Date.now()` 不截），不是阈值/队列判定。
  //
  // ⚠️ 窗口是**强制构造**的，不靠碰运气：把下界钉在"本秒内偏后"的位置，于是"截到秒"的
  //    时间戳必然落在下界之前 ≥ 600ms ⇒ 坏实现必红、好实现必绿，与机器快慢无关。
  //    自旋是**按条件等**（等时钟走到该位置），不是 sleep 一个定值。
  const { Store } = await import(pathToFileURL(STORE_FILE).href);
  const precStore = new Store(path.join(TMP, 'idle-precision'));
  while (Date.now() % 1000 < 600) { /* 等时钟进入本秒的后 400ms */ }
  const lowerBound = Date.now();
  precStore.runtimeStartedAtMs = lowerBound;
  const freshTask = precStore._newTask({ comicName: 'precision', dirName: 'precision', batches: [] });
  // 挂进 `tasks` 等价于 `createTask()` 的那一步，但避开它的落盘与起队列循环（本断言只问精度）
  precStore.tasks.set(freshTask.taskId, freshTask);

  check('I10 任务时间戳必须与 `runtimeStartedAtMs` **同精度**（两侧都带毫秒）：'
    + '下界是毫秒、任务却被截到秒 ⇒ 「与 Store 构造同一秒内创建的任务」会被判成**上一轮的历史**而过滤掉 ⇒ '
    + '本次运行永远 `neverRan` ⇒ 空闲卸载整轮不生效（③ LLM 常驻、不释放）。'
    + '下界已强制钉在本秒内偏后位置，修好后这条任务仍须算作**本次运行的活动**',
    /\.\d{3}Z$/.test(freshTask.createdAt)
      && Date.parse(freshTask.createdAt) >= lowerBound
      && lastActivityAt(precStore, lowerBound) === Date.parse(freshTask.createdAt),
    `createdAt=${freshTask.createdAt} 下界=${lowerBound} la=${lastActivityAt(precStore, lowerBound)}`);
}

// ================================================================ 正向断言

async function runPositive() {
  // ------------------------------------------------------- H · 档位映射（§7.2 逐行）

  // 本机口径：16GB Mac = Metal 统一内存 16 GB ⇒ **Tiny**（§7.2 修订点那一格）
  const mac16 = { totalRamGb: 16, gpu: metal(16) };
  check('H1 16GB Mac（Metal unified=16）→ tiny —— §7.2「else 分支」那一格，UI 也不出 Medium',
    mapTier(mac16) === 'tiny', mapTier(mac16));

  // 边界值：阈值本身与刚低于阈值必须分开（"顺手优化"最先改坏的就是这里）
  const metalBoundaries = [
    [16, 'tiny'], [23.9, 'tiny'], [24, 'small'], [31.9, 'small'], [32, 'medium'], [64, 'medium'],
  ];
  const metalWrong = metalBoundaries.filter(([gb, want]) => mapTier({ totalRamGb: gb, gpu: metal(gb) }) !== want);
  check('H2 Metal 阈值逐点：<24→tiny / 24→small / <32→small / 32→medium（§7.2 三档全在边界上）',
    metalWrong.length === 0,
    metalWrong.map(([gb, want]) => `${gb}→${mapTier({ totalRamGb: gb, gpu: metal(gb) })}≠${want}`).join(',') || '6/6');

  const cudaBoundaries = [
    [2, 'tiny'], [4, 'tiny'], [9.9, 'tiny'], [10, 'small'], [15.9, 'small'], [16, 'medium'], [24, 'medium'],
  ];
  const cudaWrong = cudaBoundaries.filter(([gb, want]) => mapTier({ totalRamGb: 32, gpu: cuda(gb) }) !== want);
  check('H3 CUDA 阈值逐点：<4→tiny / 4→tiny / <10→tiny / 10→small / <16→small / 16→medium（§7.2 CUDA 三行）',
    cudaWrong.length === 0,
    cudaWrong.map(([gb, want]) => `${gb}→${mapTier({ totalRamGb: 32, gpu: cuda(gb) })}≠${want}`).join(',') || '7/7');

  check('H4 纯 CPU → tiny（§7.2 末行；与内存多大无关）',
    mapTier({ totalRamGb: 128, gpu: cpuGpu }) === 'tiny'
      && mapTier({ totalRamGb: 8, gpu: cpuGpu }) === 'tiny');

  // 防御：gpu 缺省/未知 kind 不能抛，也不能给出"更高档"的乐观答案
  const weird = attempt(() => [
    mapTier({ totalRamGb: 64 }), mapTier({ totalRamGb: 64, gpu: {} }),
    mapTier({ totalRamGb: 64, gpu: { kind: 'npu' } }),
  ]);
  check('H5 gpu 缺省 / 未知 kind → tiny 且**不抛错**（宁可保守，不可乐观给高档）',
    !!weird.value && weird.value.every((t) => t === 'tiny'), weird.value ? weird.value.join(',') : errText(weird.err));

  // ------------------------------------------------------- A · 加速后端（§7.3/§7.4）
  check('A1 加速后端映射：metal→mps · cuda→cuda · cpu→cpu（《03》§5.1 `sidecar.accel` 枚举）',
    detectAccel(metal(16)) === 'mps' && detectAccel(cuda(16)) === 'cuda' && detectAccel(cpuGpu) === 'cpu'
      && detectAccel(undefined) === 'cpu',
    `${detectAccel(metal(16))}/${detectAccel(cuda(16))}/${detectAccel(cpuGpu)}/${detectAccel(undefined)}`);

  const fCpu = accelLaunchFlags('cpu');
  const fMps = accelLaunchFlags('mps');
  const fCuda = accelLaunchFlags('cuda');
  check('A2 启动参数：cpu ⇒ 引擎不加 --use-gpu 且 LLM 层数 0；mps/cuda ⇒ 开 GPU 且层数 -1（§7.3）',
    fCpu.engineUseGpu === false && fCpu.llmGpuLayers === 0
      && fMps.engineUseGpu === true && fMps.llmGpuLayers === -1
      && fCuda.engineUseGpu === true && fCuda.llmGpuLayers === -1,
    `cpu=${JSON.stringify(fCpu)} mps=${JSON.stringify(fMps)}`);

  // 探测顺序（§7.4）：darwin 一律 Metal；非 darwin 先试 nvidia-smi
  const gMac = detectGpu({ platform: 'darwin', arch: 'arm64', totalRamGb: 16 });
  const gNv = detectGpu({ platform: 'win32', arch: 'x64', totalRamGb: 32, runNvidiaSmi: () => 12 });
  const gNoNv = detectGpu({ platform: 'win32', arch: 'x64', totalRamGb: 32, runNvidiaSmi: () => null });
  const gThrow = detectGpu({ platform: 'linux', arch: 'x64', totalRamGb: 32, runNvidiaSmi: () => { throw new Error('ENOENT'); } });
  check('A3 探测顺序：darwin⇒metal(unified=整机内存) · 有 nvidia-smi⇒cuda · 无⇒cpu · nvidia-smi 抛错也⇒cpu（不吞成崩溃）',
    gMac.kind === 'metal' && gMac.unifiedGb === 16
      && gNv.kind === 'cuda' && gNv.vramGb === 12
      && gNoNv.kind === 'cpu' && gThrow.kind === 'cpu',
    `${gMac.kind}/${gNv.kind}(${gNv.vramGb})/${gNoNv.kind}/${gThrow.kind}`);

  // ------------------------------------------------------- T · 设置页档位选项（《02》§5）
  const mac16Profile = { totalRamGb: 16, gpu: metal(16), recommendedTier: 'tiny', accel: 'mps' };
  const feas = feasibleTiers(mac16Profile);
  check('T1 16GB Mac 的可行档位 = [tiny, small] —— **Medium 物理不可行不出现**（17.6 GB > 16 GB，《02》§5 那格）',
    feas.length === 2 && feas[0] === 'tiny' && feas[1] === 'small' && !feas.includes('medium'),
    JSON.stringify(feas));

  const opts = tierOptions(mac16Profile);
  check('T2 16GB Mac 档位选项：tiny 标 recommended、small 标「不推荐」+强警告、**无 medium 条目**',
    opts.length === 2
      && opts[0].tier === 'tiny' && opts[0].recommended === true && opts[0].warning === null
      && opts[1].tier === 'small' && opts[1].recommended === false && !!opts[1].warning
      && !opts.some((o) => o.tier === 'medium'),
    JSON.stringify(opts));

  check('T3 选项带该档**预估内存**（《02》§5「档位旁显示该档预估内存」）；且三档估算值与原文一致',
    opts.every((o) => o.peakGb === TIER_PEAK_GB[o.tier])
      && TIER_PEAK_GB.tiny === 9.4 && TIER_PEAK_GB.small === 12.8 && TIER_PEAK_GB.medium === 17.6,
    JSON.stringify(TIER_PEAK_GB));

  const bigMetal = feasibleTiers({ totalRamGb: 64, gpu: metal(64), recommendedTier: 'medium' });
  const bigCuda = feasibleTiers({ totalRamGb: 32, gpu: cuda(16), recommendedTier: 'medium' });
  const smallCuda = feasibleTiers({ totalRamGb: 32, gpu: cuda(8), recommendedTier: 'tiny' });
  check('T4 可行性按后端分池：64GB Mac 三档全出 · CUDA vram16 三档全出 · CUDA vram8 只出 tiny（权重进显存，与整机 RAM 无关）',
    bigMetal.length === 3 && bigCuda.length === 3
      && smallCuda.length === 1 && smallCuda[0] === 'tiny',
    `64M=${JSON.stringify(bigMetal)} cuda16=${JSON.stringify(bigCuda)} cuda8=${JSON.stringify(smallCuda)}`);

  check('T5 枚举常量未被改坏：TIERS 三档、顺序为展示序（低→高）',
    Array.isArray(TIERS) && TIERS.join(',') === 'tiny,small,medium', TIERS.join(','));

  // ------------------------------------------------------- probeHardware 依赖注入
  const inj = probeHardware({ platform: 'darwin', arch: 'arm64', totalRamGb: 32 });
  check('H6 probeHardware 注入生效：注入 32GB Mac ⇒ metal / mps / **medium**（unified>=32 落 Medium；推荐档随注入变，说明没读死本机）',
    inj.totalRamGb === 32 && inj.gpu.kind === 'metal' && inj.accel === 'mps' && inj.recommendedTier === 'medium',
    JSON.stringify({ ram: inj.totalRamGb, gpu: inj.gpu.kind, accel: inj.accel, tier: inj.recommendedTier }));

  const injCuda = probeHardware({ platform: 'win32', arch: 'x64', totalRamGb: 32, runNvidiaSmi: () => 12 });
  check('H7 probeHardware 非 darwin 分支：nvidia-smi 报 12 GiB ⇒ cuda / cuda / small（§7.2 CUDA >= 10 行）',
    injCuda.gpu.kind === 'cuda' && injCuda.accel === 'cuda' && injCuda.recommendedTier === 'small',
    JSON.stringify({ gpu: injCuda.gpu.kind, vram: injCuda.gpu.vramGb, accel: injCuda.accel, tier: injCuda.recommendedTier }));

  const injBytes = probeHardware({ platform: 'darwin', arch: 'arm64', totalMemBytes: 24 * 1024 ** 3 });
  check('H8 未注入 totalRamGb 时由 totalMemBytes 换算（24 GiB → 24 GB ⇒ Metal 落 small）',
    injBytes.totalRamGb === 24 && injBytes.recommendedTier === 'small',
    `${injBytes.totalRamGb}GB → ${injBytes.recommendedTier}`);

  // ------------------------------------------------------- R · 真机自检（非契约）
  const real = probeHardware();
  check(`R1 真机自检（**非契约**，只作交叉核对）：platform=${real.platform} arch=${real.arch} `
    + `ram=${real.totalRamGb}GB gpu=${real.gpu.kind} accel=${real.accel} tier=${real.recommendedTier}`
    + ` 可行档位=${JSON.stringify(feasibleTiers(real))}`,
    real.platform === 'darwin' ? real.gpu.kind === 'metal' && real.accel === 'mps' : true,
    JSON.stringify(real.gpu));

  // ------------------------------------------------------- D/I · 降档与空闲卸载的**判定**
  await runDowngradeUnit();
  await runIdleUnit();

  // ------------------------------------------------------- L · ③ LLM 看守（真进程）
  await runLlmSupervisor();
}

// ================================================================ 反证轮

/**
 * 每条破坏**只针对一个机制**，期望的变红集合写在 `expect` 里。
 * 分母（应执行的破坏条数）在脚本里**写死** —— 比率型指标会吞掉分母变化（AGENTS.md §2-1）。
 *
 * ⚠️ 四条 `expect` 互不相同（A→H1,H2；B→A1；C→T1,T2；D→A2）。
 *    若两条破坏命中同一条断言，它们会在各自的基线比对里互相掩盖（假绿家族第 5 类）。
 */
const MUTATIONS = [
  {
    name: 'A · Metal 阈值 "顺手优化"：24→16（16GB Mac 于是"够得着" Small）',
    file: PROFILE_FILE,
    find: "    if (unified >= 24) return 'small';",
    replace: "    if (unified >= 16) return 'small';",
    expect: ['H1', 'H2'],
  },
  {
    name: 'B · 加速后端把 metal 报成 cpu（GPU 没坏却说没 GPU ⇒ 白白退回 CPU）',
    file: PROFILE_FILE,
    find: "  if (gpu && gpu.kind === 'metal') return 'mps';",
    replace: "  if (gpu && gpu.kind === 'metal') return 'cpu';",
    expect: ['A1'],
  },
  {
    name: 'C · 取消「物理不可行档位不出现」的过滤（三档全渲染 ⇒ 16GB Mac 上 Medium 会点击必崩）',
    file: PROFILE_FILE,
    find: '  return TIERS.filter((tier) => tier === \'tiny\' || TIER_PEAK_GB[tier] <= totalRamGb);',
    replace: '  return TIERS.slice();',
    expect: ['T1', 'T2'],
  },
  {
    name: 'D · CPU 后端仍开 GPU（引擎加 --use-gpu、LLM 层数不归零 ⇒ 无 GPU 机器必启动失败）',
    file: PROFILE_FILE,
    find: '  return { engineUseGpu: !onCpu, llmGpuLayers: onCpu ? 0 : -1 };',
    replace: '  return { engineUseGpu: true, llmGpuLayers: -1 };',
    expect: ['A2'],
  },
  {
    name: 'E · `stop()` 只改状态、不真停进程（"我以为它退了"与"它退了"的差别）',
    file: SUPERVISOR_FILE,
    find: "    this.state = 'unloading';",
    replace: "    this.state = 'stopped'; this.pid = null; return { stopped: true, exited: true, portFreed: true };",
    expect: ['L4'],
  },
  {
    name: 'F · `restart()` 只报数、不真拉起（懒加载恢复于是变成"什么都没发生"）',
    file: SUPERVISOR_FILE,
    find: '    return this._serial(() => {\n      this.restarts += 1;\n      return this._startInner(opts);\n    });',
    replace: '    return this._serial(() => {\n      this.restarts += 1;\n      return this.snapshot();\n    });',
    expect: ['L5'],
  },
  {
    name: 'G · ③ 不装父死看管（E11 立刻退回"主进程一死就留孤儿占 8080"）',
    file: path.join(ROOT, 'engine', 'src', 'parent-watch.mjs'),
    find: "  if (process.env.MIAO_NO_PARENT_WATCH === '1') return () => {};",
    replace: '  return () => {}; // 反证：不装任何看守',
    expect: ['L3'],
  },
  {
    name: 'H · OOM 签名放宽成"什么错都算"（任何一次失败都降档 ⇒ 用户质量莫名下降）',
    file: DOWNGRADE_FILE,
    find: '  return OOM_PATTERNS.some((re) => re.test(text));',
    replace: '  return true; // 反证：什么都算 OOM',
    expect: ['D3'],
  },
  {
    name: 'I · 去掉「仅降一次」的闩（每次 OOM 都降 ⇒ 一路降到最低档，且与 item 级重试叠加）',
    file: DOWNGRADE_FILE,
    find: "      if (used) return { downgrade: false, reason: 'already-downgraded' };",
    replace: '      // 反证：去掉闩',
    expect: ['D5'],
  },
  {
    name: 'J · 删掉「有任务排队时不卸载」这条前置条件（§9.2 安全铁律被破：任务等着，引擎被停）',
    file: IDLE_FILE,
    find: '  if (queued > 0) return { unload: false, reason: UNLOAD_REASONS.busyQueued, idleForMs };',
    replace: '  // 反证：删掉排队保护',
    expect: ['I2', 'I8'],
  },
  {
    name: 'K · 空闲阈值方向写反（`< idleMs` 改成 `> idleMs` ⇒ 越热闹越卸）',
    file: IDLE_FILE,
    find: '  if (idleForMs < idleMs) return { unload: false, reason: UNLOAD_REASONS.notIdleEnough, idleForMs };',
    replace: '  if (idleForMs > idleMs) return { unload: false, reason: UNLOAD_REASONS.notIdleEnough, idleForMs };',
    expect: ['I1'],
  },
  {
    name: 'L · 空闲判定拿"对象当计数器"（`{} > 0` 恒 false ⇒ **恒判空闲**，有任务在跑也照卸）',
    file: IDLE_FILE,
    find: '  const running = store.currentTaskId ? 1 : 0;',
    replace: '  const running = store.running; // 反证：直接用对象当计数器',
    expect: ['I5'],
  },
  {
    name: 'M · 去掉「阈值 0 = 从不卸载」这一句（于是"0 分钟"变成"立刻卸载"——用户拿到他要的反面）',
    file: IDLE_FILE,
    find: '  if (neverUnload || !(idleMs > 0)) return { unload: false, reason: UNLOAD_REASONS.never, idleForMs };',
    replace: '  if (neverUnload) return { unload: false, reason: UNLOAD_REASONS.never, idleForMs };',
    expect: ['I9'],
  },
  {
    name: 'N · 任务时间戳退回**秒精度**（`nowIsoMs` → `nowIso`）'
      + '⇒ 「与 Store 构造同一秒内创建的任务算本次运行的活动」必须变红（精度错配 = 空闲卸载整轮失效）',
    file: STORE_FILE,
    find: '      createdAt: nowIsoMs(),',
    replace: '      createdAt: nowIso(),',
    expect: ['I10'],
  },
];

const EXPECTED_MUTATIONS = 14; // 分母写死

function sha(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

async function runRefute() {
  const { spawnSync } = await import('node:child_process');
  console.log('S4-a/b 硬件探测 / 档位映射 / 加速后端 / ③ 看守 · 反证轮');
  console.log(`破坏源文件 → 断言必须变红 → 按字节恢复（应执行 ${EXPECTED_MUTATIONS} 条）\n`);

  const restored = [];
  const restoreAll = () => {
    for (const r of restored) { if (!r.done) { fs.writeFileSync(r.file, r.bytes); r.done = true; } }
  };
  // 信号也要恢复 —— 被超时杀掉就跳过恢复的话，源文件会停在破坏状态，
  // 而残留会让**下一次**反证变成"锚点未找到 → 跳过"，表现为分母忽大忽小。
  const onSignal = () => { restoreAll(); process.exit(130); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let executed = 0; let asExpected = 0;
  const problems = [];
  try {
    for (const mut of MUTATIONS) {
      const target = mut.file;
      const original = fs.readFileSync(target);
      const record = { file: target, bytes: original, done: false };
      restored.push(record);
      const before = sha(target);
      const txt = original.toString('utf8');
      if (!txt.includes(mut.find)) { problems.push(`${mut.name}：锚点未找到（源文件已变？）`); continue; }
      fs.writeFileSync(target, txt.replace(mut.find, mut.replace));

      const child = spawnSync(process.execPath, [import.meta.filename], { encoding: 'utf8' });
      const line = (child.stdout || '').split('\n').find((l) => l.startsWith('[RESULT] '));
      fs.writeFileSync(target, original);
      record.done = true;
      const after = sha(target);
      if (before !== after) problems.push(`${mut.name}：恢复后字节不一致（${before} ≠ ${after}）`);

      executed += 1;
      if (!line) {
        problems.push(`${mut.name}：子进程未产出结果行（stdout 尾部：${(child.stdout || '').slice(-200)}）`);
        console.log(`⚠ ${mut.name}\n    子进程没有结果行`);
        continue;
      }
      const parsed = JSON.parse(line.slice('[RESULT] '.length));
      const missed = mut.expect.filter((code) => matchById(parsed.results, code)?.ok !== false);
      console.log(`🔴 ${mut.name}`);
      for (const code of mut.expect) {
        const hit = matchById(parsed.results, code);
        console.log(`   ${hit?.ok === false ? '✓' : '✗'} ${code} ${hit?.ok === false ? '按预期变红' : `**没有变红**（${hit ? hit.detail : '缺该条'}）`}`);
      }
      if (missed.length === 0) asExpected += 1;
      else problems.push(`${mut.name}：${missed.join(',')} 未变红`);
    }
  } finally {
    restoreAll();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`反证：${asExpected} / ${EXPECTED_MUTATIONS} 条按预期变红（应执行 ${EXPECTED_MUTATIONS}）`);
  if (executed !== EXPECTED_MUTATIONS || asExpected !== EXPECTED_MUTATIONS) {
    console.log('\n下面是未达预期的条目：');
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exitCode = 1;
  } else if (problems.length) {
    console.log('\n（有附注：）');
    for (const p of problems) console.log(`  ⚠ ${p}`);
  }
}

// ================================================================ 入口

if (REFUTE) {
  await runRefute();
} else {
  console.log('S4-a/b 硬件探测 / 档位映射 / 加速后端 / ③ 看守 断言');
  try {
    await runPositive();
  } catch (err) {
    check('RUN 断言脚本未预期崩溃（视为失败：脚本崩溃 ≠ 断言通过）', false, errText(err));
  }
  printResults('汇总（H 硬件/映射 · A 加速后端 · T 设置页档位 · L ③ 看守 · R 真机自检）');
  process.exitCode = out.fail === 0 ? 0 : 1;
}
