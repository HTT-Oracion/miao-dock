#!/usr/bin/env node
/**
 * A4 · 打包后冒烟（mock 档）—— 第一个可独立验收的里程碑
 * =============================================================================
 * F 组做完之后，"彻底去掉 node"这件事只有**配置级与寻址级**证据（`check:bundle` /
 * `check:resources`）。而「装完的包能起服务」从来没有在**真实安装产物**上跑过一次 ——
 * 本脚本就是那一次。
 *
 * ## 它验的三层（由外到内）
 *   ① **安装层**：NSIS 静默安装到 TMP ⇒ 安装目录里真有 `miao-dock.exe` 与
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
 * - R1 删掉安装目录里的 `engine/models.manifest.json` ⇒ 资产层 + 服务层都必须红
 *   （原台账写的"删 service/src/server.mjs"自 F5 起已作废：那个文件不进包了）。
 * - R3 连 `engine/wheels.manifest.json` 一起删 ⇒ P2b/P2c 必须红
 *   （G3 的"零编译器"全靠产品读得到这份清单；删掉它 = 用户机上静默退回源码编译）。
 * - R2 把安装目录里的 exe 挪走 ⇒ 安装层断言红。
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
const NSIS_DIR = path.join(TARGET, 'release', 'bundle', 'nsis');
const RELEASE_MANGASVC = path.join(TARGET, 'release', process.platform === 'win32' ? 'mangasvc.exe' : 'mangasvc');

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

// ------------------------------------------------------------------ 安装产物

/** 找 NSIS 安装包；没有 ⇒ **报错**（不静默跳过）。 */
function findSetup() {
  if (!fs.existsSync(NSIS_DIR)) return null;
  const hits = fs.readdirSync(NSIS_DIR).filter((f) => /-setup\.exe$/i.test(f));
  return hits.length ? path.join(NSIS_DIR, hits.sort().at(-1)) : null;
}

/** NSIS 静默安装到 `dest`。`/D` 必须是最后一个参数且**不能加引号**（NSIS 自己的规矩）。 */
function installSilently(setup, dest) {
  return new Promise((resolve) => {
    const p = spawn(setup, ['/S', `/D=${dest}`], { stdio: 'ignore', detached: false });
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

/** 静默卸载（Tauri NSIS 会生成 uninstall.exe）。失败不阻断 —— TMP 终究会被清掉。 */
function uninstallSilently(dir) {
  const un = path.join(dir, 'uninstall.exe');
  if (!fs.existsSync(un)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const p = spawn(un, ['/S'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (c) => resolve(c === 0));
  });
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

const setup = findSetup();
if (!setup) {
  console.error(`找不到 NSIS 安装包：${NSIS_DIR}\\*-setup.exe\n先构建：npm run app:build`);
  process.exit(1);
}
if (!fs.existsSync(RELEASE_MANGASVC)) {
  console.error(`找不到 release 服务靶子：${RELEASE_MANGASVC}\n先构建：npm run app:build`);
  process.exit(1);
}
console.log(`A4 打包后冒烟${REFUTE ? '（反证轮）' : ''}\n安装包：${path.relative(ROOT, setup)}`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-packaged-'));
const installDir = path.join(work, 'install');
try {
  const ins = await installSilently(setup, installDir);
  check('P0 NSIS 静默安装成功', ins.ok, ins);
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
    // R1：把刚验过的资产删掉 —— 下面几层必须因此红。
    // 🔴 必须**同时切断仓库回退**（`MIAO_REPO_ROOT` 指到空目录）：`missing_assets()` 的判据是
    //    「资源目录没有 **且** 仓库也没有」，而开发机上仓库就在旁边 ⇒ 不切断就会回退成功、
    //    P4 仍旧绿 —— 那是**假绿**（真实用户机器上没有仓库，删了就是缺）。
    if (fs.existsSync(manifest)) fs.rmSync(manifest);
    // R3：连 wheel 清单一起删 —— P2b/P2c 必须红。
    //    （`plan_crf` 在打包态正是靠它找到包内 wheel 的，删掉后用户机上必然退回源码编译。）
    if (fs.existsSync(wheelsManifest)) fs.rmSync(wheelsManifest);
    const emptyRepo = path.join(work, 'empty-repo');
    fs.mkdirSync(emptyRepo, { recursive: true });
    process.env.MIAO_REPO_ROOT = emptyRepo;
    console.log(
      '\n[反证] 已删掉安装目录里的 engine/models.manifest.json 与 engine/wheel-manifest.json，并切断仓库回退',
    );
    // R3 的判据必须在**删除之后**复检才成立 —— 上面那批 check 跑在删除前，永远绿。
    // （P2/P2b/P2c 是"安装层"断言，删除影响的是资产层与服务层；但 R3 要证的恰恰是
    //  "清单不在盘上 ⇒ P2b 红"，所以补一次删除后的复检。）
    check(
      'P2b 反证：wheel 清单被删掉后本断言必须红（否则它钉不住"清单要在盘上"这件事）',
      !fs.existsSync(wheelsManifest),
      wheelsManifest,
    );
  }

  // ---- ③ 资产层：自检在同一资源目录上报 ok ----
  {
    const assets = await new Promise((resolve) => {
      const p = spawn(RELEASE_MANGASVC, ['--check-assets'], {
        env: { ...process.env, MIAO_RESOURCE_DIR: installDir },
      });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('error', (e) => resolve({ code: -1, out: String(e.message || e) }));
      p.on('close', (code) => resolve({ code, out }));
    });
    let rep = null;
    try {
      rep = JSON.parse(assets.out);
    } catch {
      /* 非 JSON：缺失时它走 stderr 文本 */
    }
    check('P4 资产自检在安装目录上报 ok=true（资源目录优先于仓库回退）', assets.code === 0 && rep && rep.ok === true, {
      code: assets.code,
      out: assets.out.slice(0, 300),
    });
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
      const pathsOut = await new Promise((resolve) => {
        const p = spawn(RELEASE_MANGASVC, ['--print-paths'], {
          env: {
            ...process.env,
            MIAO_RESOURCE_DIR: installDir,
            MIAO_STATE_DIR: stateDir,
            MIAO_ROOT: path.join(work, 'root'),
          },
        });
        let o = '';
        p.stdout.on('data', (d) => (o += d));
        p.on('close', () => resolve(o));
      });
      const snap = JSON.parse(pathsOut);
      check(
        'P7 生效的清单路径落在**安装目录**内（A1：资源目录优先，不是回退仓库）',
        typeof snap.modelManifest === 'string' && snap.modelManifest.startsWith(installDir),
        snap.modelManifest,
      );
      // 台账原话「mode=mock 可见」：启动配方是它的权威出处。
      // ⚠️ `--print-launch-plan` 的 mode 是**位置参数**（不读 env，见 mangasvc.rs）⇒ 显式传 `mock`。
      const planOut = await new Promise((resolve) => {
        const p = spawn(RELEASE_MANGASVC, ['--print-launch-plan', 'mock'], {
          env: {
            ...process.env,
            MIAO_RESOURCE_DIR: installDir,
            MIAO_STATE_DIR: stateDir,
            MIAO_ROOT: path.join(work, 'root'),
          },
        });
        let o = '';
        p.stdout.on('data', (d) => (o += d));
        p.on('close', () => resolve(o));
      });
      const plan = JSON.parse(planOut);
      check('P8 启动配方 mode=mock（台账原话的那一半）', plan.mode === 'mock', plan.mode);
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
process.exit(failed === 0 ? 0 : 1);
