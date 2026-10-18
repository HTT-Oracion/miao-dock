#!/usr/bin/env node
/**
 * A4 · 打包后冒烟（mock 档）—— 第一个可独立验收的里程碑
 * =============================================================================
 * F 组做完之后，"彻底去掉 node"这件事只有**配置级与寻址级**证据（`check:bundle` /
 * `check:resources`）。而「装完的包能起服务」从来没有在**真实安装产物**上跑过一次 ——
 * 本脚本就是那一次。
 *
 * ## 它验的三层（由外到内）
 *   ① **安装层**：单文件安装器 `--silent --per-user` 装到 TMP ⇒ 安装目录里真有 `miao-dock.exe` 与
 *      `engine/models.manifest.json`（A1 的落点 + A2 的进包），且**没有** `service/`、`node.zip`
 *      （F5 验收③ 在真实产物上的复现）。
 *   ② **服务层**：从安装布局起服务（release 构建、`MIAO_RESOURCE_DIR` 指向安装目录）⇒
 *      `/health` 200、`mode=mock` 可见。
 *   ③ **资产层**：`mangasvc --check-assets` 在同一资源目录上报 `ok=true`。
 *
 * ## 为什么不起 `miao-dock.exe`（GUI）而用 mangasvc
 * GUI 需要 WebView 与显示环境，无头机器上必然起不来 —— 那会让本钉子在不同机器上给出
 * 不同结论（时红时绿），而这种钉子比没有更坏。服务栈本身与 GUI 解耦（契约《02》§2.1：
 * 服务生命周期 ≠ 窗口），故用同一份 release 源码编出的 `mangasvc` 起服务、把资源目录指向
 * **真实安装产物**里的资产 —— 要证的"装完能起服务"因此是可判定的。
 *
 * ## 反证轮（--refute）
 * 先取**基线**（变异前那几条必须绿），再破坏，再要求它们**变红** ——
 * 只报"红了几条"而不报"该红的是不是这几条"，是反证轮最常见的自我欺骗。
 *   R1 删掉安装目录里的 `engine/models.manifest.json` **并切断仓库回退**
 *      （`MIAO_REPO_ROOT` 指空目录：开发机上仓库就在旁边，不切断会回退成功 ⇒ P4 假绿）
 *      ⇒ **P4 / P7 必须红**；
 *   R3 连 `engine/wheel-manifest.json` 一起删 ⇒ **P9 必须红**（产品退回源码编译）。
 *   ⚠️ 不配"把 exe 挪走 ⇒ 安装层断言红"那条：安装层断言本身就是 FS 事实，挪走 exe 之后
 *      再断言"文件不在"，是同义反复 —— 它不测产品，属**假反证**，故不写。
 * 退出码：反证成立（基线绿 + 指定三条红 + 无预期外的红）⇒ 0；否则 1。
 *
 * 用法：
 *   node e2e/packaged-smoke.mjs            正向（先 `npm run app:build`）
 *   node e2e/packaged-smoke.mjs --refute   反证轮
 *
 * 🔴 没有产物时**不静默跳过**：报错并提示先构建。"跳过即通过"是假绿里最坏的一种。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REFUTE = process.argv.includes('--refute');
const TOKEN = 'a'.repeat(64);

const TARGET = path.join(ROOT, 'src-tauri', 'target');
/** 单文件安装器：优先用套件里的**交付物**（对外分发物就是它），退回构建产物 */
const RELEASE_DIR = path.join(ROOT, 'release');
const BUILT_INSTALLER = path.join(ROOT, 'installer', 'src-tauri', 'target', 'release', 'miaodock-installer.exe');
const RELEASE_MANGASVC = path.join(TARGET, 'release', process.platform === 'win32' ? 'mangasvc.exe' : 'mangasvc');

let passed = 0;
let failed = 0;
const failures = [];
/** 断言 id → 结论（反证轮要按 id 判定"该红的那几条红没红"，只数总数做不到）。 */
const results = new Map();
function check(name, cond, extra) {
  const id = String(name).split(/[\s：]/)[0];
  if (!results.has(id)) results.set(id, cond);
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
  }
}

/** 反证轮必须变红的断言（与 `R0` 基线一起构成"反证成立"的判据） */
const EXPECT_RED = ['P4', 'P7', 'P9'];

// ------------------------------------------------------------------ 安装产物

/**
 * 找单文件安装器；没有 ⇒ **报错**（不静默跳过）。
 *
 * 🔴 交付名带版本号（`MiaoDock_2.2.1_x64-setup.exe`）⇒ 按**形态**找，不写死文件名：
 *    写死之后每次发版这条断言都会"找不到产物"，而那种红是最容易被当成噪声忽略的。
 */
function findInstaller() {
  if (fs.existsSync(RELEASE_DIR)) {
    const hits = fs
      .readdirSync(RELEASE_DIR)
      .filter((f) => /^MiaoDock_.+_x64-setup\.exe$/i.test(f))
      .map((f) => path.join(RELEASE_DIR, f));
    if (hits.length) return hits.sort().at(-1);
  }
  return fs.existsSync(BUILT_INSTALLER) ? BUILT_INSTALLER : null;
}

/**
 * 静默安装到 `dest`。
 *
 * 🔴 断言用 `--per-user`：不写 HKLM、不进 `Program Files`，测试不需要管理员，
 *    也不会在开发机上留一条系统级卸载项。
 * 🔴 `--no-shortcuts`：验收不该往用户的桌面/开始菜单塞东西。
 */
function installSilently(installer, dest) {
  return new Promise((resolve) => {
    const p = spawn(installer, ['--silent', '--per-user', '--no-shortcuts', '--dir', dest], {
      stdio: 'ignore',
      detached: false,
    });
    // 安装器是独立进程，`close` 即装完
    p.on('error', (e) => resolve({ ok: false, why: String(e.message || e) }));
    p.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

/** 等安装目录里出现可执行（轮询，最多 60 s）。 */
async function waitForExe(dir, timeoutMs = 60_000) {
  const exe = path.join(dir, 'miao-dock.exe');
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(exe)) return exe;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** 静默卸载（安装器把卸载器一起装进安装目录）。失败不阻断 —— TMP 终究会被清掉。 */
function uninstallSilently(dir) {
  const un = path.join(dir, 'MiaoDock-Uninstaller.exe');
  if (!fs.existsSync(un)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const p = spawn(un, ['--silent'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (c) => resolve(c === 0));
  });
}

// ------------------------------------------------------------------ 产品出口（只读 CLI）

/**
 * 跑 release `mangasvc` 的**只读出口**，资源目录指向**安装布局**。
 *
 * 🔴 收成一个出口的理由不只是省行数：反证轮要在**变异前**先取一次基线
 *    （不然"变异后变红"与"基线本来就红"长得一模一样）。三处断言若各自内联一份 spawn，
 *    基线就得再抄三份 —— 抄出来的第二份迟早与第一份不同源。
 */
function runCli(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const p = spawn(RELEASE_MANGASVC, args, {
      env: { ...process.env, MIAO_RESOURCE_DIR: installDir, ...extraEnv },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => resolve({ code: -1, out: String(e.message || e) }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

/** 资产自检（`--check-assets`）⇒ {code, rep}。非 JSON（缺失时它走 stderr 文本）时 rep=null。 */
async function assetsProbe() {
  const { code, out } = await runCli(['--check-assets']);
  let rep = null;
  try {
    rep = JSON.parse(out);
  } catch {
    /* 保持 null */
  }
  return { code, rep, out };
}

/** 生效路径快照（`--print-paths`）⇒ 解析后的对象，解析不了给 null（让断言自己红）。 */
async function pathsProbe(extraEnv = {}) {
  const { out } = await runCli(['--print-paths'], extraEnv);
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * CRF wheel 计划（`--engine-crf-plan`）—— **产品自己的出口**。
 *
 * 🔴 为什么这条比"文件在盘上"重要：装完包只断言 `engine/wheels/*.whl` 存在，
 *    测的是**安装器**；而"用户机上到底走 wheel 还是退回源码编译"取决于**产品读不读得到**它
 *    （读不到 = 没装编译器的机器上装配到一半失败，且 dev 态永远测不出来：仓库就在旁边会回退成功）。
 */
async function crfPlan() {
  const { code, out } = await runCli(['--engine-crf-plan']);
  try {
    return { ...JSON.parse(out), code };
  } catch {
    return { code, route: null, reason: out.slice(0, 200) };
  }
}

// ------------------------------------------------------------------ 服务层取证

/** 起一个服务（release mangasvc），资源目录指向安装布局；返回 {port, kill, out}。 */
function startService(env) {
  const child = spawn(RELEASE_MANGASVC, [], {
    env: {
      ...process.env,
      MIAO_TOKEN: TOKEN,
      MIAO_ENGINE_PROTOCOL: 'mock',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => {
      child.kill();
      reject(new Error('mangasvc 20s 内未就绪'));
    }, 20000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /MIAO_READY (\{.*\})/.exec(buf);
      if (m) {
        clearTimeout(to);
        resolve({ port: JSON.parse(m[1]).port, kill: () => child.kill(), out: buf });
      }
    });
    child.stderr.on('data', (d) => (buf += d));
    child.on('close', (code) => {
      clearTimeout(to);
      reject(new Error(`mangasvc 退出 ${code}：${buf.slice(0, 600)}`));
    });
  });
}

// ------------------------------------------------------------------ 主流程

const installer = findInstaller();
if (!installer) {
  console.error(
    `找不到单文件安装器：\n  ${path.relative(ROOT, RELEASE_DIR)}\\MiaoDock_<版本>_x64-setup.exe\n  ${path.relative(ROOT, BUILT_INSTALLER)}\n` +
      '先构建：npm run app:build',
  );
  process.exit(1);
}
if (!fs.existsSync(RELEASE_MANGASVC)) {
  console.error(`找不到 release 服务靶子：${RELEASE_MANGASVC}\n先构建：npm run app:build`);
  process.exit(1);
}
console.log(`A4 打包后冒烟${REFUTE ? '（反证轮）' : ''}\n安装器：${path.relative(ROOT, installer)}`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-packaged-'));
const installDir = path.join(work, 'install');
try {
  const ins = await installSilently(installer, installDir);
  check('P0 单文件安装器静默安装成功', ins.ok, ins);
  const exe = await waitForExe(installDir);
  check('P1 安装目录里有 miao-dock.exe（装完真的有桌面端）', !!exe, installDir);

  // ---- ① 安装层：A2 进包的资产在**真实产物**里 ----
  const manifest = path.join(installDir, 'engine', 'models.manifest.json');
  check('P2 安装目录里有 engine/models.manifest.json（A1 落点 + A2 进包）', fs.existsSync(manifest), manifest);
  // G3/W13b：wheel 清单与随包 wheel 也必须在真实产物里。
  // 🔴 为什么单独断言：`plan_crf()` 要读这份清单才能选中包内 wheel；清单不在包里
  //    ⇒ 产品"看不见"那颗明明随包了的 wheel，静默退回源码编译 ⇒ 没装 MSVC 的机器上装到一半失败。
  //    这种失效在 dev 态永远测不出来（仓库就在旁边，代码会回退过去），只能在真产物上钉。
  // 🔴 落点是 `engine/wheel-manifest.json` 而不是 `engine/wheels.manifest.json`：
  //    后者与目录 `engine/wheels/` 同名，Tauri 的 NSIS 安装后会把它吞掉（真机复现：
  //    release 产物两份都在、静默安装后只剩 wheel）。这条断言就是那个坑的守门人。
  const wheelsManifest = path.join(installDir, 'engine', 'wheel-manifest.json');
  const bundledWheel = path.join(installDir, 'engine', 'wheels', 'pydensecrf-1.0-cp311-cp311-win_amd64.whl');
  check(
    'P2b 安装目录里有 engine/wheel-manifest.json（产品侧 plan_crf 要读它才能选中包内 wheel）',
    fs.existsSync(wheelsManifest),
    wheelsManifest,
  );
  check(
    'P2c 安装目录里有随包的 pydensecrf wheel（G3：目标机零编译器的全部依据）',
    fs.existsSync(bundledWheel),
    bundledWheel,
  );
  const nodePayload = ['service', 'node.zip'].filter((k) => fs.existsSync(path.join(installDir, k)));
  check('P3 安装目录里没有 service/ 与 node.zip（F5 验收③ 在真实产物上复现）', nodePayload.length === 0, nodePayload);

  if (REFUTE) {
    // ---- 基线（变异**前**）：下面要变红的那三条，此刻必须**先绿** ----
    // 这一步不能省：只跑"变异后"的话，"该红的红了"与"基线本来就是红的"完全同形。
    const baseState = path.join(work, 'base-state');
    fs.mkdirSync(baseState, { recursive: true });
    const baseAssets = await assetsProbe();
    const basePaths = await pathsProbe({ MIAO_STATE_DIR: baseState, MIAO_ROOT: path.join(work, 'root') });
    const basePlan = await crfPlan();
    check(
      'R0 基线（变异前）：P4/P7/P9 三条必须先绿 —— 否则"变异后变红"无法与"基线本来就红"区分',
      baseAssets.code === 0 &&
        baseAssets.rep?.ok === true &&
        typeof basePaths?.modelManifest === 'string' &&
        basePaths.modelManifest.startsWith(installDir) &&
        basePlan.route === 'wheel',
      { assetsOk: baseAssets.rep?.ok, manifest: basePaths?.modelManifest, route: basePlan.route },
    );

    // R1：把刚验过的资产删掉 —— 资产层与服务层必须因此红。
    // 🔴 必须**同时切断仓库回退**（`MIAO_REPO_ROOT` 指到空目录）：`missing_assets()` 的判据是
    //    「资源目录没有 **且** 仓库也没有」，而开发机上仓库就在旁边 ⇒ 不切断就会回退成功、
    //    P4 仍旧绿 —— 那是**假绿**（真实用户机器上没有仓库，删了就是缺）。
    if (fs.existsSync(manifest)) fs.rmSync(manifest);
    // R3：连 wheel 清单一起删 ⇒ **P9** 必须红（`plan_crf` 在打包态正是靠它找到包内 wheel 的）。
    if (fs.existsSync(wheelsManifest)) fs.rmSync(wheelsManifest);
    const emptyRepo = path.join(work, 'empty-repo');
    fs.mkdirSync(emptyRepo, { recursive: true });
    process.env.MIAO_REPO_ROOT = emptyRepo;
    console.log(
      '\n[反证] 已删掉安装目录里的 engine/models.manifest.json 与 engine/wheel-manifest.json，并切断仓库回退',
    );
  }

  // ---- ③ 资产层：自检在同一资源目录上报 ok；且**产品自己的出口**认得出包内 wheel ----
  {
    const { code, rep, out } = await assetsProbe();
    check('P4 资产自检在安装目录上报 ok=true（资源目录优先于仓库回退）', code === 0 && rep?.ok === true, {
      code,
      out: out.slice(0, 300),
    });
    // P9：只断言"wheel 文件在盘上"测的是**安装器**；这一条测**产品读不读得到它** ——
    //     读不到 ⇒ 没装编译器的机器上装配退回源码编译，而 dev 态永远测不出来（仓库就在旁边会回退成功）。
    const plan = await crfPlan();
    check(
      'P9 打包态 wheel 计划命中**包内** wheel（`--engine-crf-plan` 是产品出口，G3 零编译器的依据）',
      plan.code === 0 && plan.route === 'wheel' && plan.from === '包内',
      plan,
    );
  }

  // ---- ② 服务层：从安装布局起服务，mock 档 ----
  {
    const stateDir = path.join(work, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    let svc = null;
    try {
      svc = await startService({
        MIAO_RESOURCE_DIR: installDir,
        MIAO_STATE_DIR: stateDir,
        MIAO_ROOT: path.join(work, 'root'),
      });
      const h = await fetch(`http://127.0.0.1:${svc.port}/api/v1/health`, { headers: { 'x-box-token': TOKEN } });
      check('P5 装完能起服务：/health 200', h.status === 200, h.status);
      // `mode` 的两处可见面：启动配方的 `mode` 字段 + 服务内引擎替身的 `version=mock`
      // （`/engine/status` 顶层没有 `protocol` —— 那在 `/engine/options`，别照 G2 的键名猜）
      const st = await fetch(`http://127.0.0.1:${svc.port}/api/v1/engine/status`, {
        headers: { 'x-box-token': TOKEN },
      });
      const stBody = await st.json().catch(() => null);
      check('P6 服务内引擎是 mock 替身（version=mock，不是 real 档的残影）', stBody?.engine?.version === 'mock', {
        version: stBody?.engine?.version,
      });
      // 清单路径必须指向**安装目录里那一份**（而不是回退到仓库）
      const snap = await pathsProbe({ MIAO_STATE_DIR: stateDir, MIAO_ROOT: path.join(work, 'root') });
      check(
        'P7 生效的清单路径落在**安装目录**内（A1：资源目录优先，不是回退仓库）',
        typeof snap?.modelManifest === 'string' && snap.modelManifest.startsWith(installDir),
        snap?.modelManifest,
      );
      // 台账原话「mode=mock 可见」：启动配方是它的权威出处。
      // ⚠️ `--print-launch-plan` 的 mode 是**位置参数**（不读 env，见 mangasvc.rs）⇒ 显式传 `mock`。
      const { out: planOut } = await runCli(['--print-launch-plan', 'mock'], {
        MIAO_STATE_DIR: stateDir,
        MIAO_ROOT: path.join(work, 'root'),
      });
      let launch = null;
      try {
        launch = JSON.parse(planOut);
      } catch {
        /* 解析不了 ⇒ 让断言自己红（别把解析异常伪装成"服务没起来"） */
      }
      check('P8 启动配方 mode=mock（台账原话的那一半）', launch?.mode === 'mock', launch?.mode);
    } catch (e) {
      check('P5 装完能起服务：/health 200', false, String(e.message || e).slice(0, 300));
      check('P6 /health 里 mode=mock 可见', false, '服务没起来');
      check('P7 生效的清单路径落在安装目录内', false, '服务没起来');
    } finally {
      if (svc) svc.kill();
    }
  }
} finally {
  // 现场一律清掉（含反证轮）：装在 TMP 里的东西不该留在用户机器上。
  // ⚠️ 反证轮**不能**为了"供人工核对"而保留 —— 那会在开发机上堆一堆安装副本。
  await uninstallSilently(installDir);
  fs.rmSync(work, { recursive: true, force: true });
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(
  `\nA4 打包后冒烟：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`,
);

/*
 * 反证轮的成败**不能**用"失败为 0"判：这一轮本来就要让三条变红（失败数必然 > 0）。
 * 判据是两件事同时成立：
 *   ① 基线绿（R0）—— 否则"该红的红了"与"基线本来就是红的"同形，反证归因不成立；
 *   ② 红的就是指定那三条，且**没有预期外的红**。
 * 用退出码表达，`npm run task -- check:packaged:refute` 才能进 CI；只印一行"红了几条"
 * 的反证轮等于永远红（这正是它此前的问题：跑对了也 exit 1）。
 */
if (REFUTE) {
  const reds = EXPECT_RED.filter((id) => results.get(id) === false);
  const unexpected = [...results.entries()]
    .filter(([id, ok]) => ok === false && id !== 'R0' && !EXPECT_RED.includes(id))
    .map(([id]) => id);
  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${reds.length}/${EXPECT_RED.length} 条按预期变红（应执行 ${EXPECT_RED.length} 条）`);
  if (results.get('R0') !== true) console.log('✗ 基线（变异前）就没绿 —— 本轮反证不成立，先修基线');
  if (unexpected.length) console.log(`✗ 预期外的红：${unexpected.join('、')}（反证轮只该让指定那几条变红）`);
  const ok = reds.length === EXPECT_RED.length && results.get('R0') === true && unexpected.length === 0;
  process.exit(ok ? 0 : 1);
}
process.exit(failed === 0 ? 0 : 1);
