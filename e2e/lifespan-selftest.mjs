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
 *   node e2e/lifespan-selftest.mjs                 B 组 + 引导组（期望全绿）
 *   node e2e/lifespan-selftest.mjs --refute        B 组反证（期望**拿不到结果**）
 *   node e2e/lifespan-selftest.mjs --e11           E11（期望三进程全退、端口释放）
 *   node e2e/lifespan-selftest.mjs --e11 --refute  E11 反证（期望**端口不释放**）
 *   node e2e/lifespan-selftest.mjs --guide         只跑引导组（D-229）
 *
 * 见 ~/.workbuddy/skills/falsifiable-verification。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { ensureDevServer, portOpen } from './_devserver.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = ROOT;
// 平台后缀按需补：Windows 上的可执行文件是 `miao-dock.exe`，写死不带后缀会
// 在 `existsSync` 就判"没构建"（与 dev server 那处写死 `.bin/vite` 同一类错）。
const BIN = path.join(
  APP,
  'src-tauri',
  'target',
  'debug',
  process.platform === 'win32' ? 'miao-dock.exe' : 'miao-dock',
);
/// 落盘根目录与状态目录都指到仓库内的临时目录：既别碰用户的 ~/Pictures/Box 漫画，
/// 也让每次自检从空目录开始（否则续做/编号会受上一轮残留影响）。
const TMP = mkdtempSync(path.join(os.tmpdir(), 'miao-e11-'));

/// 落盘根目录与状态目录都指到**每次新建的空目录**：既别碰用户的 ~/Pictures/Box 漫画，
/// 也真让每次自检从空目录开始（否则续做/编号、以及"状态目录里带着上一轮终态任务"
/// 这类跨轮状态会污染断言）。
///
/// 🔴 曾经这里是仓库内**固定**的 `.tmp-selftest`，注释写着"让每次自检从空目录开始"，
///    代码却**从来没清过** —— 于是它跨轮累积了 12 条历史终态任务（最新一条是十几天前的）。
///    而 `idle-policy.lastActivityAt()` 当时把**历史活动**也当成"本次运行的活动"
///    ⇒ 重启后 ③ 刚拉起就被判"空闲 18 小时"卸掉 ⇒ E11 报 `LLM ✗`；
///    手工复现（用全新目录）却一切正常。看着像 E11 脚本的锅，实际是**产品缺陷**。
/// ⚠️ 所以"跨轮状态"这条**不是靠清目录规避的**：产品侧已改成只算本次运行的活动，
///    并由 `check:e5e6` 的 E6.7 用**同一状态目录故意重启**去验证。
///    这里换成 `mkdtempSync` 只为让 E11 专心考"树回收"，不掺别的变量。
/// ⚠️ 落点选 `os.tmpdir()`（`/var/folders/…`）而不是仓库内，除了不污染工作树，还因为
///    本机沙箱对 `fs.rmSync` 加了"单轮批量删除 > 50 条需确认"的守卫，递归清空仓库内
///    那个目录会**直接抛 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`**。`MIAO_ROOT` 另有黑名单
///    挡住系统 `/tmp`，而 `os.tmpdir()` 不在其中（`check:e5e6` 是同款做法）。
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
    console.error(`找不到二进制：${BIN}\n先在 src-tauri 下 cargo build`);
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
  console.log(`[tmp] 本轮落盘根：${TMP}（每轮新建，不作清理）`);
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
    const snap = out.split('\n').filter((l) => l.includes('生效参数快照') || /\[miao-dock\] [①②③] /.test(l));
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
  console.log(`[tmp] 本轮落盘根：${TMP}（每轮新建，不作清理）`);
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
      console.log(
        `应用生命周期验收\n\n关窗与托盘（B1–B3）+ 三进程生命周期（S2）：${result.passed} / ${result.total} 通过`,
      );
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

// ------------------------------------------------------------------ 引导组（D-229）：未装配时 ① 必须可用

/**
 * D1 引导页唯一的行动按钮是 `POST /engine/models/download` —— 它打的是**本地服务 ①**。
 * 所以「real 档 + 运行时未装配」时必须同时成立三件事，缺一件引导页就是死结
 * （真机实测现场：点「开始下载」→「本地翻译服务未运行（请确认喵坞的服务已启动）」）：
 *   ① ① **起得来**（D6 闸门在 D-229 之后只挡引擎 ②/③，不挡服务本体）；
 *   ② 那个下载端点**真的应答**（不是 `SERVICE_UNAVAILABLE` 信封）；
 *   ③ ②/③ **一个都不起**（闸门该做的仍然做到）。
 *
 * 夹具：运行时根指空目录 + 运行时清单指一份**没有任何 set** 的最小清单 ⇒ 下载执行体一起来
 * 就会快速失败（「清单里没有 set「python」」），**不碰网络、不下任何东西** —— 本组验的是
 * "按钮能不能落地"，不是"下载本身"（后者归 `check:progress-truth` / `check:engine-bootstrap-real`）。
 *
 * 反证（手工，要重编译）：把 `service.rs::start_blocking` 的闸门改回
 * `return self.fail(app, Some("L0"), msg)` ⇒ **G1 必须红**（服务都起不来，POST 更无从谈起）。
 */
async function runGuide() {
  requireBin();
  /*
   * 🔴 起服务那一下走 **`MIAO_SELFTEST=1`**（`main.rs` 里由 Rust 侧直接 `ServiceManager::start()`），
   *    不依赖 webview：否则本组会在"dev server 没起来 / 前端没挂在翻译屏"这类与产品无关的地方红掉
   *    （实测踩过两次）。代价是这条测试通道**跑完自己的场景就退出**、并把 ① 一起带走 ——
   *    所以探针必须是**一个请求**（见下面 G1 的循环重试），而不是"先 health 再干别的"。
   *
   * 反证（手工，要重编译）：把 `service.rs::start_blocking` 的闸门改回
   * `return self.fail(app, Some("L0"), msg)` ⇒ **G1 必须红**（服务根本起不来，POST 更无从谈起）。
   */
  const stateDir = path.join(TMP, 'guide-state');
  const rootDir = path.join(TMP, 'guide-root');
  const runtimeRoot = path.join(TMP, 'guide-empty-runtimes');
  for (const d of [stateDir, rootDir, runtimeRoot]) mkdirSync(d, { recursive: true });
  /*
   * 下载执行体换成**无害命令**：本组要证的是"按钮能落地"（200 + started），不是"真下载"。
   * 真执行体一起来就会去下 46 MB 的 Python 运行时（`--engine-bootstrap` 的第一阶段）——
   * 验收绝不允许拿用户网络做副作用。换成一条 `echo` 之后：POST 立刻返回 200，
   * 子进程随即 exit 0（`state=done`），全程零网络。
   */
  const runner = path.join(TMP, 'guide-fake-runner.cmd');
  writeFileSync(runner, '@echo off\r\necho fixture runner\r\nexit /b 0\r\n');

  const child = spawnApp({
    MIAO_SELFTEST: '1',
    MIAO_ENGINE_PROTOCOL: 'real',
    MIAO_RUNTIME_ROOT: runtimeRoot,
    MIAO_STATE_DIR: stateDir,
    MIAO_ROOT: rootDir,
    MIAO_MODEL_DOWNLOAD_RUNNER: runner,
  });
  let out = '';
  child.stdout.on('data', (b) => (out += b.toString('utf8')));
  child.stderr.on('data', (b) => (out += b.toString('utf8')));
  let failed = 0;
  const ok = (name, cond, detail = '') => {
    console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!cond) failed++;
  };
  try {
    const tokenFile = path.join(stateDir, 'token');
    /*
     * 🔴 探针就是**引导页那个按钮发的那一个请求**（`POST /engine/models/download`），循环重试到
     *    成功或超时 —— 一次请求同时回答两件事：① 服务起来了；② 那个端点能落地。
     *
     *     为什么不先 `/health` 再 POST：应用这条**自检通道跑完自己的场景就退出**（并把 ① 带走），
     *      能用的时间窗只有一两次请求 —— 实测「先 health 200、再 POST」必输（第二个请求撞上
     *      「对端已关闭」）。把要证的事压成**一个**请求，窗口就不再是变量。
     *
     *     为什么用**本次应用自己写下的令牌**：残留的旧服务也占着 5180–5190，只看端口会让本组
     *      假绿；令牌只在本进程的 state 目录里 ⇒ 答 200 的那个服务必然由它拉起。
     */
    let port = null;
    let dlStatus = 0;
    let dlCode = '-';
    let dlStarted = false;
    const until = Date.now() + 45_000;
    while (!dlStarted && Date.now() < until) {
      const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
      if (token) {
        for (const p of SERVICE_PORTS) {
          if (!(await portOpen(p, 150))) continue;
          try {
            const r = await fetch(`http://127.0.0.1:${p}/api/v1/engine/models/download`, {
              method: 'POST',
              headers: { 'x-box-token': token, 'content-type': 'application/json' },
              body: '{}',
            });
            const b = await r.json().catch(() => null);
            port = p;
            dlStatus = r.status;
            dlCode = b?.error?.code ?? '-';
            dlStarted = r.status === 200 && b?.started === true;
            if (dlStarted) break;
          } catch {
            /* 服务还没起来（或已被自检收走），继续等 */
          }
        }
      }
      if (!dlStarted) await sleep(300);
    }
    ok(
      'G1 引导页的「开始下载」必须能落地：POST /engine/models/download → 200 started=true' +
        '（不是 SERVICE_UNAVAILABLE；用本次令牌认服务，残留服务不算数）',
      dlStarted,
      dlStarted
        ? `端口 ${port} · HTTP 200 · started=true`
        : `端口 ${port ?? '-'} · HTTP ${dlStatus} · code=${dlCode}（45s 内没拿到 started）`,
    );
    if (!dlStarted) {
      // 失败必须**可行动**：把应用自己的输出尾部带出来 —— 启动现场的第一手证据在它那儿。
      console.log('  ↓ 应用输出尾部：');
      for (const l of out.split('\n').slice(-14)) if (l.trim()) console.log(`      ${l.trim()}`);
      return failed;
    }

    /*
     * 第二条只做**端口探测**（不发 HTTP ⇒ 不参与那个短窗口）：
     * "不挡服务"不等于"放引擎" —— ②/③ 仍必须一个都没起。
     */
    ok(
      'G2 ②/③ 一个都没起（闸门该做的仍然做到）',
      !(await portOpen(ENGINE_PORT, 300)) && !(await portOpen(LLM_PORT, 300)),
      `engine:${ENGINE_PORT} llm:${LLM_PORT} 都应关闭`,
    );
  } finally {
    /*
     * 🔴 杀完**必须等它真的退出**再让本进程收场：`SIGKILL` 之后立刻 `process.exit()` 会撞上
     * libuv 的 `!(handle->flags & UV_HANDLE_CLOSING)` 断言（实测：整脚本以 0xC0000409 收场，
     * 看着像"检查失败"，其实是自己把自己 crash 了）。等一次 `exit`（带兜底超时）即可。
     */
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise((r) => {
        child.once('exit', r);
        setTimeout(r, 4000);
      });
    }
  }
  return failed;
}

/*
 * 引导组单独一项（`selftest:app:guide`，service 层）：它要 real 档 + 空运行时根，
 * 与 B 组的 mock 场景不兼容（B 组断言的是三进程起全的轨迹）。
 */
const guide = process.argv.includes('--guide');
const failed = guide ? await runGuide() : e11 ? await runE11() : await runB();
process.exit(failed ? 1 : 0);
