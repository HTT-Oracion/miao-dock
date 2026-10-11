#!/usr/bin/env node
/**
 * E8 · 加速后端（《04》§14.2）—— 真机半边
 * =============================================================================
 * 判据原文：**macOS 走 MPS；GPU 启动失败 → 自动回退 CPU 且 `degraded` 上报（不静默）**
 *
 * ## 这条判据里最容易被写坏的是"不静默"的**反面**：静默地喊狼来了
 * 「回退 CPU 就报 degraded」很好写，而且永远不会有漏报。但它会把**用户主动选的 CPU**
 * 一起报成故障 —— 设置页里明明写着「强制 CPU（最慢，但兼容性最好）」，用户点了，
 * 界面却弹一个 `degraded`。下次真回退时用户已经学会忽略它了。
 *
 * 规格的依据是《04》§7.4-3 的措辞：**"若指定 GPU 后端启动失败 → 自动回退 CPU 并…"** ——
 * 触发条件是「**启动失败**」，不是「没在用 GPU」。两条路径在本版里长得一样（都是
 * `useGpu === false`），靠 `choice` 区分：
 *   · `choice === 'cpu'` ← 用户设置页选的（`config.mjs` 随之把 useGpu 也算成 false）；
 *   · `choice === 'auto'` 而 useGpu false ← Rust 侧 GPU 起不来、注入 `MIAO_ENGINE_USE_GPU=0` 重拉。
 * ⇒ 本脚本把这两条路径**分别起真服务**取证，缺一条都不算验过。
 *
 * ## 真机半边的边界（诚实标注）
 * 「macOS 走 MPS」的**探测输入**是真机（`probeHardware()` 读 `process.platform/arch` 与
 * 本机 GPU 探测），这一步是真机事实。但「MPS 启动**真的失败**并触发回退」这一半本机**做不到**：
 * 本机 M4 的 MPS 是好的，人为把它搞挂需要改引擎/系统层。所以 E8 验的是
 * "**回退发生之后**服务怎么上报"，而"回退是**谁**触发的"（Rust 侧 `ServiceManager` 的失败检测）
 * 列在 `docs/engine-e2e-acceptance-report.md` 的 unverified register，**不计入已完成**。
 *
 * 用法：
 *   node e2e/service/e8-accel-check.mjs            正向
 *   node e2e/service/e8-accel-check.mjs --refute    反证轮（破坏源文件 → 断言必须变红 → 按字节还原）
 *
 * 约束：纯 Node、零第三方依赖；临时目录自建自清；不占 5180–5190（box-service 的段）。
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVICE_ENTRY = path.join(ROOT, 'service', 'src', 'server.mjs');
const SERVER_SRC = path.join(ROOT, 'service', 'src', 'server.mjs');
const PROFILE_SRC = path.join(ROOT, 'service', 'src', 'settings', 'engine-profile.mjs');
const TOKEN = 'e'.repeat(64);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-e8-'));
const REFUTE = process.argv.includes('--refute');

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 声明的断言条数（分母写死：少执行一条即判红） */
const DECLARED = 6;

// ------------------------------------------------------------------ 结果收集

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}
function printResults(title) {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n### ${title}`);
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.id}${r.detail ? `  ${r.detail}` : ''}`);
  console.log(`\n通过 ${pass} / 失败 ${results.length - pass} / 声明 ${DECLARED}`);
  return { pass, fail: results.length - pass };
}

// ------------------------------------------------------------------ 小工具

const portOpen = (port, timeoutMs = 300) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  let settled = false;
  const done = (v) => { if (!settled) { settled = true; s.destroy(); resolve(v); } };
  s.setTimeout(timeoutMs);
  s.once('connect', () => done(true));
  s.once('timeout', () => done(false));
  s.once('error', () => done(false));
});

async function findFreePort(start, need = 2) {
  for (let p = start; p < start + 400; p += 1) {
    let ok = true;
    for (let i = 0; i < need; i += 1) if (await portOpen(p + i)) { ok = false; break; }
    if (ok) return p;
  }
  throw new Error(`从 ${start} 起找不到 ${need} 个连续空闲端口`);
}

function httpGetJson(port, pathname, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: token ? { 'X-Box-Token': token } : {}, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * 在**子进程**里问一次 `engine-profile.mjs` 的纯函数。
 *
 * 🔴 为什么必须另起进程：ESM 按 URL 缓存模块 —— 反证轮改了 `engine-profile.mjs` 之后，
 *    父进程再 `import()` 仍拿到第一份缓存 ⇒ 断言不可能变红，而它看起来"跑过了"。
 *    （同一坑在 E4 / E10 / E7 上各踩过一次，这里直接按结论写。）
 */
function askProfile(expr) {
  const js = `
    const m = await import(${JSON.stringify(new URL('../../service/src/settings/engine-profile.mjs', import.meta.url).href)});
    const out = (${expr});
    process.stdout.write(JSON.stringify(out));
  `;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', js], {
      encoding: 'utf8',
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out.trim());
  } catch (e) {
    return { __error: String(e.message).slice(0, 300) };
  }
}

// ------------------------------------------------------------------ 假引擎 + 服务

/** 只应答就绪探针（TCP + POST /queue-size + 执行器端口），不做翻译 —— E8 不需要真翻译。 */
function startFakeEngine(port) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/queue-size') {
        const b = Buffer.from('0');
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': b.length });
        return res.end(b);
      }
      res.writeHead(404, { 'Content-Length': 0 });
      res.end();
    });
  });
  const executor = net.createServer(() => { /* 哑 socket ⇒ running */ });
  return { server, executor };
}

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
});
const closeAll = (servers) => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));

function spawnService(env) {
  const child = spawn(process.execPath, [SERVICE_ENTRY], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const st = { child, out: '', err: '', ready: null };
  child.stdout.on('data', (d) => {
    st.out += d.toString();
    const m = /MIAO_READY (\{.*\})/.exec(st.out);
    if (m && !st.ready) { try { st.ready = JSON.parse(m[1]); } catch { /* 继续等 */ } }
  });
  child.stderr.on('data', (d) => { st.err += d.toString(); });
  return st;
}

async function waitReady(st, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (!st.ready && Date.now() < until) await sleep(40);
  if (!st.ready) throw new Error(`服务未就绪：stdout=${st.out}\nstderr=${st.err}`);
  return st.ready;
}

/**
 * 起一轮真服务并取回三份视图（`/health` + `/engine/status` + `/engine/options`）。
 *
 * @param {object} opts
 * @param {object} opts.env 额外的服务环境变量
 * @param {object|null} opts.settings 启动前写进 `state/engine-settings.json` 的内容（模拟"用户在设置页选过"）
 */
async function round({ env = {}, settings = null } = {}) {
  const tag = Math.random().toString(36).slice(2, 8);
  const svcPort = await findFreePort(5350, 1);
  const engPort = await findFreePort(5450, 2);
  const stateDir = path.join(TMP, `state-${tag}`);
  fs.mkdirSync(stateDir, { recursive: true });
  if (settings) fs.writeFileSync(path.join(stateDir, 'engine-settings.json'), JSON.stringify(settings));

  const fake = startFakeEngine(engPort);
  await listen(fake.server, engPort);
  await listen(fake.executor, engPort + 1);

  const st = spawnService({
    MIAO_ENGINE_PROTOCOL: 'real',
    MIAO_ENGINE_PORT: String(engPort),
    MIAO_ENGINE_PROBE_MS: '300',
    MIAO_PORT: String(svcPort),
    MIAO_TOKEN: TOKEN,
    MIAO_STATE_DIR: stateDir,
    MIAO_ROOT: path.join(TMP, `root-${tag}`),
    MIAO_NO_LLM_AUTOSTART: '1',
    ...env,
  });

  try {
    const info = await waitReady(st);
    const PORT = info.port;
    // 等引擎被探到 running（假引擎在听，应该很快）—— `degraded` 的升级前提就是引擎在跑
    let health = null;
    for (let i = 0; i < 60; i += 1) {
      const r = await httpGetJson(PORT, '/api/v1/health', TOKEN);
      if (r.status === 200 && r.body?.sidecar?.state === 'running') { health = r.body; break; }
      if (r.status === 200 && r.body?.sidecar?.state === 'degraded') { health = r.body; break; }
      await sleep(150);
    }
    const eng = await httpGetJson(PORT, '/api/v1/engine/status', TOKEN);
    const opt = await httpGetJson(PORT, '/api/v1/engine/options', TOKEN);
    return { health, status: eng.body, options: opt.body };
  } finally {
    if (st.child.exitCode === null) st.child.kill('SIGTERM');
    await sleep(150);
    await closeAll([fake.server, fake.executor]);
  }
}

// ------------------------------------------------------------------ 断言体

async function runAll() {
  results.length = 0;

  // ---- E8.1：真机硬件探测与**平台一致**（不是"代码里写了 mps"）----
  // 🔴 原先写死 `platform==='darwin' && arch==='arm64' && accel==='mps'` ⇒ 非 macOS 上恒红，
  //    会直接卡住双平台 CI（D-140）。改为**平台忠实**：darwin ⇒ metal/mps；非 darwin ⇒ **不**出现 mps。
  const hw = askProfile('m.probeHardware()');
  const hwAccelOk = hw?.platform === 'darwin'
    ? hw?.accel === 'mps' && hw?.gpu?.kind === 'metal'
    : hw?.accel !== 'mps' && hw?.gpu?.kind !== 'metal';
  check('E8.1 真机硬件探测与平台一致：darwin ⇒ accel=mps/gpu=metal；非 darwin ⇒ **不**出现 mps（"macOS 走 MPS"的实测依据）',
    hwAccelOk && !!hw?.recommendedTier,
    `platform=${hw?.platform} arch=${hw?.arch} accel=${hw?.accel} gpu=${JSON.stringify(hw?.gpu)} tier=${hw?.recommendedTier} ram=${Number(hw?.totalRamGb).toFixed(1)}GB`);

  // ---- E8.2：对照组 —— 什么都不关时 `accel` 等于**本机推荐后端** + ok（证明下面的 degraded 不是"恒报"）----
  const normal = await round();
  check('E8.2 对照组：不关 GPU 时 `accel` 等于本机推荐后端 且 `/health.status === "ok"`（degraded **不是**恒报）',
    normal.health?.sidecar?.accel === hw?.accel && normal.health?.status === 'ok' && normal.health?.sidecar?.state === 'running',
    `status=${normal.health?.status} state=${normal.health?.sidecar?.state} accel=${normal.health?.sidecar?.accel} 本机推荐=${hw?.accel}`);

  // ---- E8.3：**真回退**要不静默（§7.4-3）：Rust 侧注入 USE_GPU=0，choice 仍是 auto ----
  const fallback = await round({ env: { MIAO_ENGINE_USE_GPU: '0' } });
  check('E8.3 GPU 被关掉（choice=auto，即"启动失败后重拉"这条路径）⇒ `accel=cpu` + `state=degraded` + 顶层 `status=degraded`（§7.4-3「不静默」）',
    fallback.health?.sidecar?.accel === 'cpu'
    && fallback.health?.sidecar?.state === 'degraded'
    && fallback.health?.status === 'degraded',
    `status=${fallback.health?.status} state=${fallback.health?.sidecar?.state} accel=${fallback.health?.sidecar?.accel}`);

  // ---- E8.4：**用户自选 CPU 不是故障** —— 设置页里真实存在这个选项，报 degraded 就是喊狼来了 ----
  const byChoice = await round({ settings: { accel: 'cpu' } });
  check('E8.4 用户在设置里选了「强制 CPU」⇒ `accel=cpu` 但**不**报 degraded（`state=running` / `status=ok`）',
    byChoice.health?.sidecar?.accel === 'cpu'
    && byChoice.health?.sidecar?.state === 'running'
    && byChoice.health?.status === 'ok',
    `status=${byChoice.health?.status} state=${byChoice.health?.sidecar?.state} accel=${byChoice.health?.sidecar?.accel} choice=${byChoice.options?.accel?.choice} source=${byChoice.options?.accel?.source}`);

  // ---- E8.5：两处同源 + 理由可分 —— 界面拿到的 effective 必须与 sidecar 同值 ----
  const sameAll = normal.options?.accel?.effective === normal.health?.sidecar?.accel
    && fallback.options?.accel?.effective === fallback.health?.sidecar?.accel
    && byChoice.options?.accel?.effective === byChoice.health?.sidecar?.accel;
  const reasons = [fallback.options?.accel?.reason, byChoice.options?.accel?.reason].map((s) => String(s ?? ''));
  check('E8.5 `/engine/options.accel.effective` 与 `/health.sidecar.accel` 三轮都同值；且两轮 cpu 的 `reason` **文案不同**（回退 vs 用户指定）',
    sameAll && reasons[0] && reasons[1] && reasons[0] !== reasons[1],
    `同值三轮=${sameAll} / 回退理由=${JSON.stringify(reasons[0])} / 自选理由=${JSON.stringify(reasons[1])}`);

  // ---- E8.6：不给假控件 —— 候选必须**反映本机**（无 Metal 不出 mps、无 CUDA 不出 cuda）----
  const accels = (normal.options?.accel?.options ?? []).map((o) => o.value);
  const isMetal = hw?.gpu?.kind === 'metal';
  const isCuda = hw?.gpu?.kind === 'cuda';
  check('E8.6 加速后端候选**反映本机**：含 auto/cpu 与本机推荐后端，且**不含**本机不可用的 mps/cuda（假控件比缺控件更伤）',
    accels.includes('auto') && accels.includes('cpu') && accels.includes(hw?.accel)
      && (isMetal ? accels.includes('mps') : !accels.includes('mps'))
      && (isCuda ? accels.includes('cuda') : !accels.includes('cuda')),
    `候选=[${accels.join(',')}] / 本机 gpu=${hw?.gpu?.kind} accel=${hw?.accel} hardwareRecommended=${normal.options?.accel?.hardwareRecommended}`);

  // 反证轮要按 id 取"这一轮的结果"，所以回一份 map（与 E4/E7 同形）。
  const map = {};
  for (const r of results) map[r.id] = r;
  return map;
}

// ------------------------------------------------------------------ 反证轮

const MUTATIONS = [
  {
    name: 'E8.3：让"真回退"**不报** degraded（把回退做成静默的）',
    expect: ['E8.3 GPU 被关掉（choice=auto，即"启动失败后重拉"这条路径）⇒ `accel=cpu` + `state=degraded` + 顶层 `status=degraded`（§7.4-3「不静默」）'],
    edits: [{
      file: PROFILE_SRC,
      find: '      degraded: !byUserChoice && hardwareAccel !== \'cpu\',',
      replace: '      degraded: false, // refute：回退也静默',
    }],
  },
  {
    name: 'E8.4：去掉"用户自选"的区分（把用户选的 CPU 也报成 degraded —— 喊狼来了）',
    expect: ['E8.4 用户在设置里选了「强制 CPU」⇒ `accel=cpu` 但**不**报 degraded（`state=running` / `status=ok`）'],
    edits: [{
      file: PROFILE_SRC,
      find: '      degraded: !byUserChoice && hardwareAccel !== \'cpu\',',
      replace: '      degraded: hardwareAccel !== \'cpu\', // refute：不区分用户自选',
    }],
  },
  {
    name: 'E8.1：真机探测不给出推荐档位（recommendedTier 置空）',
    expect: ['E8.1 真机硬件探测与平台一致：darwin ⇒ accel=mps/gpu=metal；非 darwin ⇒ **不**出现 mps（"macOS 走 MPS"的实测依据）'],
    // 🔴 锚点选 `recommendedTier`（**每个平台都经过**），而不是 darwin 专有的 metal→mps 映射 ——
    //    后者在非 macOS 上根本不被执行 ⇒ 反证轮"该红没红"（假阴性），双平台 CI 会挂（D-140）。
    edits: [{
      file: PROFILE_SRC,
      find: '    recommendedTier: mapTier({ totalRamGb, gpu }),',
      replace: '    recommendedTier: null, // refute：探测不给推荐档位',
    }],
  },
  {
    name: 'E8.6：让后端候选恒含全部后端（Metal 机器上也给"点了没用"的假控件）',
    expect: ['E8.6 加速后端候选**反映本机**：含 auto/cpu 与本机推荐后端，且**不含**本机不可用的 mps/cuda（假控件比缺控件更伤）'],
    edits: [{
      file: SERVER_SRC,
      find: '      options: accelOptions(hardware.accel, { all: config.settingsRefute.accelOpen }),',
      replace: '      options: accelOptions(hardware.accel, { all: true }), // refute：恒列全部后端',
    }],
  },
];

const readBytes = (f) => { try { return fs.readFileSync(f); } catch { return null; } };

const main = async () => {
  console.log(`E8 加速后端（《04》§14.2）${REFUTE ? ' · 反证轮' : ''}`);

  if (!REFUTE) {
    await runAll();
    const { fail } = printResults('E8 加速后端取证');
    const executed = results.length;
    if (executed !== DECLARED) console.log(`\n🔴 分母不符：声明 ${DECLARED} 条，实际执行 ${executed} 条 —— 视为失败`);
    process.exitCode = fail === 0 && executed === DECLARED ? 0 : 1;
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
    for (const [i, e] of mut.edits.entries()) {
      if (!originals.has(e.file)) originals.set(e.file, readBytes(e.file));
      const txt = originals.get(e.file).toString('utf8');
      if (!txt.includes(e.find)) {
        console.log(`⚠ ${mut.name}\n    破坏锚点未找到（第 ${i + 1} 处，${path.relative(ROOT, e.file)}）—— 本条无法反证`);
        skipped += mut.expect.length;
        continue;
      }
      fs.writeFileSync(e.file, txt.replace(e.find, e.replace));
    }
    // 🔴 还原一律进 `finally`：破坏若让 `runAll()` 抛异常（例如源码语法被改坏、服务起不来），
    //    写在 try 之后的还原语句就不会执行，源文件会**永久留成被破坏状态**（E4 上踩到过）。
    let res = {};
    let roundErr = null;
    try {
      res = await runAll();
    } catch (err) {
      roundErr = err;
    } finally {
      for (const [f, snap] of originals) fs.writeFileSync(f, snap);
    }
    console.log(`🔴 ${mut.name}`);
    if (roundErr) console.log(`   ⚠ 本轮 runAll 抛异常（源文件已被破坏）：${String(roundErr.message).split('\n')[0]}`);
    for (const id of mut.expect) {
      total++;
      const isRed = (res[id] && res[id].ok === false) || (!res[id] && roundErr !== null);
      if (isRed) { red++; console.log(`  ✓ ${id.slice(0, 22)}… 按预期变红${res[id] ? '' : '（因本轮未能执行）'}`); }
      else { falsePositives.push(id); console.log(`  ✗ ${id.slice(0, 22)}… 该红没红 ← 假阳性`); }
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
  if (restoreFail) console.log(`✗ 有 ${restoreFail} 个文件未恢复到原始字节`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(' / ')}`);
  process.exitCode = red === total && total === expectedTotal && skipped === 0 && restoreFail === 0 ? 0 : 1;
};

await main();
