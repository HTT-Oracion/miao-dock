#!/usr/bin/env node
/**
 * 应用生命周期验收 —— 把「跑一次」变成一条命令。两组：
 *
 *   B 组（默认）   窗与托盘 / 服务常驻（B1–B3，走应用自身的 `MIAO_SELFTEST=1` 模式）
 *   E11（--e11）   **三进程树回收**：SIGKILL 主进程 → ①②③ 自行退出、端口释放
 *
 * 为什么 B1–B3 要由应用自己跑：本机没有授予「自动化」权限（osascript 被 TCC 以 -10004 拒绝，
 * 非沙箱同样如此），所以验收由应用自身程序化触发**同一条代码路径**（`window.close()` 触发的
 * 正是点关闭按钮的 `CloseRequested`）。
 *
 * 为什么 E11 要**从外面**看：SIGKILL 之下应用没有任何机会执行清理代码 —— "我退干净了"
 * 这句自证在这条路径上根本不成立。只有外部观察者能回答「端口释放了吗、还有没有孤儿」。
 * 配套反证开关 `MIAO_NO_PARENT_WATCH=1`（关掉子进程的父死看守）⇒ 必然出现孤儿 ⇒ 断言必须变红。
 *
 * 用法：
 *   node scripts/lifespan-selftest.mjs                 B 组（期望全绿）
 *   node scripts/lifespan-selftest.mjs --refute        B 组反证（期望**拿不到结果**）
 *   node scripts/lifespan-selftest.mjs --e11           E11（期望三进程全退、端口释放）
 *   node scripts/lifespan-selftest.mjs --e11 --refute  E11 反证（期望**端口不释放**）
 *
 * 见 ~/.workbuddy/skills/falsifiable-verification。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { ensureDevServer, portOpen } from './_devserver.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = path.join(ROOT, 'app');
const BIN = path.join(APP, 'src-tauri', 'target', 'debug', 'miao-dock');
/// 落盘根目录与状态目录都指到仓库内的临时目录：既别碰用户的 ~/Pictures/Box 漫画，
/// 也让每次自检从空目录开始（否则续做/编号会受上一轮残留影响）。
const TMP = path.join(ROOT, '.tmp-selftest');
/// 服务端口段（契约 §1）+ 引擎端口 + LLM 端口（S2 起 ③ 是独立进程）
const SERVICE_PORTS = Array.from({ length: 11 }, (_, i) => 5180 + i);
const LLM_PORT = 8080;

const refute = process.argv.includes('--refute');
const e11 = process.argv.includes('--e11');
/// 引擎栈模式：默认 mock（秒级、可复现）。`--mode real` 才起 Python + llama-server（分钟级），
/// 用于 E1/E11 的**真进程**取证 —— 那是 mock 替身替代不了的部分。
const modeIdx = process.argv.indexOf('--mode');
const MODE = modeIdx > -1 ? String(process.argv[modeIdx + 1] || '').toLowerCase() : 'mock';
if (!['mock', 'real'].includes(MODE)) {
  console.error(`--mode 取值非法：${MODE}（可选 mock | real）`);
  process.exit(2);
}
/// 引擎端口按模式分档（与 `service/src/config.mjs` 的 `enginePort` 同一口径）：
/// mock = 5003（模拟引擎水位）；real = 8000（uvicorn 水位，执行器固定占 8001）
const ENGINE_PORT = MODE === 'real' ? 8000 : 5003;
const EXECUTOR_PORT = ENGINE_PORT + 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// E11 期间要盯的全部端口。real 模式多一个**执行器端口** —— 它才是"树回收"的真正考点：
/// 它是引擎主进程的**孙进程**，只杀直接子进程时它会被 reparent 后继续占着（孤儿）。
const ALL_PORTS = [...SERVICE_PORTS, ENGINE_PORT, LLM_PORT, ...(MODE === 'real' ? [EXECUTOR_PORT] : [])];

function requireBin() {
  if (!existsSync(BIN)) {
    console.error(`找不到二进制：${BIN}\n先在 app/src-tauri 下 cargo build`);
    process.exit(2);
  }
}

/**
 * 拉起应用。**引擎栈模式显式声明 mock** —— 不显式声明时 Rust 侧默认 `real`，
 * 会去起 Python + 8 GB 权重（分钟级）；测试要的是秒级可复现，不是"顺手测了真引擎"。
 */
function spawnApp(env) {
  return spawn(BIN, [], {
    cwd: path.join(APP, 'src-tauri'),
    env: {
      ...process.env,
      MIAO_ENGINE_PROTOCOL: MODE,
      MIAO_ROOT: path.join(TMP, 'root'),
      MIAO_STATE_DIR: path.join(TMP, 'state'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runApp() {
  requireBin();
  return new Promise((resolve) => {
    const child = spawnApp(refute ? { MIAO_SELFTEST: '1', MIAO_CLOSE_QUITS: '1' } : { MIAO_SELFTEST: '1' });
    let out = '';
    child.stdout.on('data', (b) => (out += b.toString('utf8')));
    child.stderr.on('data', (b) => (out += b.toString('utf8')));
    // 自检最长约 20s（S2 起多了 ③ 与两轮探针）；再留一点余量就要能收工
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

function parseResult(out) {
  const line = out.split('\n').find((l) => l.includes('MIAO_SELFTEST_RESULT'));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(line.indexOf('{')));
  } catch {
    return null;
  }
}

/**
 * 谁占着这个端口 —— 只在判红时调用，用来把「仍被占用：5180」变成可行动的线索。
 *
 * 加它的直接原因：一次验收里 5180 报红，实际坐的是**上一轮截图失败留下的 service 残留**
 * （所以 M3 自己的 service 才升到 5181）。光看「5180 被占」会怀疑本轮代码；
 * 报出占用者是谁、什么进程，就不用再查一轮。取不到就算了，绝不让它影响断言本身。
 */
function whoHolds(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pcn'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = /^p(\d+)/m.exec(out)?.[1];
    const cmd = /^c(.+)$/m.exec(out)?.[1];
    return pid ? { pid: Number(pid), text: `${cmd || '?'}(pid ${pid})` } : null;
  } catch {
    return null;
  }
}

/** 等这些端口**全部**释放（B4：退出后不留孤儿占着 5180 / 5003 / 8080） */
async function waitPortsFreed(ports, timeoutMs = 12_000) {
  const busyNow = async () => {
    const busy = [];
    for (const p of ports) if (await portOpen(p, 200)) busy.push(p);
    return busy;
  };
  const until = Date.now() + timeoutMs;
  let busy = await busyNow();
  while (busy.length && Date.now() < until) {
    await sleep(400);
    busy = await busyNow();
  }
  return { ok: busy.length === 0, busy };
}

/** 等「三进程都起来」：服务任选一个端口在听 + 引擎在听 + LLM 在听 */
async function waitStackUp(timeoutMs = 40_000) {
  const until = Date.now() + timeoutMs;
  let service = 0;
  for (;;) {
    for (const p of SERVICE_PORTS) if (await portOpen(p, 200)) service = service || p;
    const engine = await portOpen(ENGINE_PORT, 200);
    const llm = await portOpen(LLM_PORT, 200);
    // real 模式还要等**执行器**（`port+1`）—— 它是引擎主进程的孙进程，缺它不算起全
    const executor = MODE !== 'real' || (await portOpen(EXECUTOR_PORT, 200));
    if (service && engine && llm && executor) return { ok: true, service, engine, llm };
    if (Date.now() > until) return { ok: false, service, engine, llm, executor };
    await sleep(400);
  }
}

/** 反证轮跑完会故意留下孤儿 —— 必须收干净，否则下一轮验收的端口探测会受它影响 */
function forceCleanup(ports) {
  for (const p of ports) {
    const h = whoHolds(p);
    if (h) {
      try {
        process.kill(h.pid, 'SIGKILL');
        console.log(`  （清理）杀掉残留 ${h.text} @${p}`);
      } catch {
        /* ignore */
      }
    }
  }
}

function describeBusy(busy) {
  return busy
    .map((p) => {
      const h = whoHolds(p);
      return h ? `${p}（${h.text}）` : String(p);
    })
    .join('、');
}

// ------------------------------------------------------------------ E11：三进程树回收

async function runE11() {
  requireBin();
  const startedVite = await ensureDevServer({ root: ROOT });
  const child = spawnApp(refute ? { MIAO_NO_PARENT_WATCH: '1' } : {});
  let out = '';
  child.stdout.on('data', (b) => (out += b.toString('utf8')));
  child.stderr.on('data', (b) => (out += b.toString('utf8')));
  let failed = 0;
  try {
    // real 模式首启要把 python 依赖导入 + uvicorn 起监听，给足分钟级余量
    const upBudget = MODE === 'real' ? 300_000 : 40_000;
    const up = await waitStackUp(upBudget);
    console.log(
      `[mode=${MODE}] 三进程拉起：服务 ${up.service || '✗'} · 引擎 ${up.engine ? ENGINE_PORT : '✗'} · LLM ${up.llm ? LLM_PORT : '✗'}`,
    );
    if (!up.ok) {
      console.log(`✗ 三进程未能在 ${upBudget / 1000}s 内全部就绪，E11 无法开始`);
      console.log(out.split('\n').slice(-15).join('\n'));
      return 1;
    }

    // E1 的另一半：**日志里真的打出了生效参数快照**（不是"配置里写了"）。
    // 从外面读应用的 stdout —— 这与 `S2b` 在应用内读日志是两条独立取证路径。
    const snap = out
      .split('\n')
      .filter((l) => l.includes('生效参数快照') || /\[miao-dock\] [①②③] /.test(l));
    console.log(`E1 生效参数快照（从应用 stdout 读回，共 ${snap.length} 行）：`);
    for (const l of snap) console.log(`  ${l.trim()}`);
    if (snap.length < 4) {
      console.log('✗ E1：没从应用 stdout 里读到完整的参数快照（期望 ≥4 行）');
      return 1;
    }

    // 主进程被**强杀**：没有任何清理代码有机会执行
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));

    // real 模式下 python/llama-server 的退出比 Node 慢（要跑各自的清理），余量给足
    const freed = await waitPortsFreed(ALL_PORTS, MODE === 'real' ? 30_000 : 15_000);
    if (refute) {
      // 反证：关掉父死看护后必须留下孤儿。若端口照样全释放，说明这组断言没测到看守机制。
      if (freed.ok) {
        console.log('✗ 反证失败：关掉父死看守后端口**仍然**全部释放 —— 说明 E11 测的不是看守机制');
        failed = 1;
      } else {
        console.log(`✓ 反证成立：关掉父死看守 ⇒ 留下孤儿（${describeBusy(freed.busy)}）`);
      }
      forceCleanup(ALL_PORTS);
      const after = await waitPortsFreed(ALL_PORTS, 8_000);
      console.log(`  ${after.ok ? '✓' : '✗'} 清理后端口已释放 — ${after.ok ? '干净' : describeBusy(after.busy)}`);
      if (!after.ok) failed = 1;
    } else if (!freed.ok) {
      console.log(`✗ E11：主进程 SIGKILL 后仍有端口被占用 —— ${describeBusy(freed.busy)}`);
      failed = 1;
    } else {
      console.log(`✓ E11：主进程 SIGKILL 后 ①②③ 全部自退，${ALL_PORTS.length} 个端口全部释放，无孤儿`);
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (startedVite) startedVite.kill('SIGTERM');
  }
  return failed;
}

// ------------------------------------------------------------------ B 组：窗与托盘 / 服务常驻

async function runB() {
  const startedVite = await ensureDevServer({ root: ROOT });
  let failed = 0;
  try {
    const { out } = await runApp();
    const result = parseResult(out);
    // B4：退出后端口必须释放。这条只能从**外面**看 —— 应用自己已经在收尾了，
    // 没法再自证「我退干净了」。
    const freed = await waitPortsFreed(ALL_PORTS);
    const freedDetail = freed.ok
      ? `${SERVICE_PORTS[0]}–${SERVICE_PORTS.at(-1)} / ${ENGINE_PORT} / ${LLM_PORT} 均已释放，无孤儿进程`
      : `仍被占用：${describeBusy(freed.busy)}`;

    if (refute) {
      // 反证：关窗即退进程 ⇒ 自检根本走不到打印那一步
      if (result) {
        console.log('✗ 反证失败：关掉看守后断言**仍然**出了结果 —— 说明这组断言没测到「关窗仅隐藏」');
        console.log(JSON.stringify(result, null, 2));
        failed = 1;
      } else {
        console.log('✓ 反证成立：关窗即退进程时自检拿不到结果，断言确实作用在「关窗仅隐藏」上');
      }
      console.log(`  ${freed.ok ? '✓' : '✗'} B4（反证轮）退出后端口释放 — ${freedDetail}`);
      if (!freed.ok) failed = 1;
    } else if (!result) {
      console.log('✗ 未拿到自检结果：');
      console.log(out.split('\n').slice(-12).join('\n'));
      failed = 1;
    } else {
      console.log(`应用生命周期验收\n\n关窗与托盘（B1–B3）+ 三进程生命周期（S2）：${result.passed} / ${result.total} 通过`);
      for (const c of result.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.id} — ${c.detail}`);
      failed = result.checks.filter((c) => !c.ok).length;

      console.log('\n退出清理（B4）：');
      console.log(`  ${freed.ok ? '✓' : '✗'} 应用退出后端口释放 — ${freedDetail}`);
      if (!freed.ok) failed += 1;
      return failed;
    }
  } finally {
    if (startedVite) startedVite.kill('SIGTERM');
  }
  return failed;
}

const failed = e11 ? await runE11() : await runB();
process.exit(failed ? 1 : 0);
