#!/usr/bin/env node
/**
 * B4 · 「`pydensecrf` 预编译 wheel」钉子 —— 无编译器的机器也能装
 * =============================================================================
 * 对应计划文档 B4：用户自装的最大摩擦点（要 MSVC / Xcode CLT）。
 * 落点：按平台预构建 wheel 放镜像通道并**清单化 sha256**；**不随包**。
 *
 * ## 本脚本钉的是什么（以及为什么不钉"真装一次"）
 * 「真装一次并让引擎跑起来」需要一台**没有**编译器的目标机 + 真 wheel ——
 * 那只能在目标平台真机做（归 `check:e3:real` / 人工验收）。
 * 但这条链路上真正会静默失效的是**选择逻辑**，而它完全可以在秒级内被钉住：
 *
 *   WB.W2 清单为空 ⇒ 走源码编译（**回退是前提，不是降级**：清单空不该让装配整体失败）；
 *   WB.W3 有本平台条目且 **sha256 对得上** ⇒ 优先走 wheel（验收①的机器形态）；
 *   WB.W4 sha256 对不上 ⇒ **拒绝使用**、回退源码编译 —— 这一条证明"清单化 sha256"
 *         真的在起作用，而不只是一个躺在 JSON 里的字段；
 *   WB.W5 wheel 不在盘上 ⇒ 回退，不报错；
 *   WB.W6 清单里只有**别的平台**的条目 ⇒ 回退（不许在 Windows 上装 macOS 的 wheel，
 *         同 C3 那个教训：平台过滤只该有一处实现）。
 *
 * 🔴 全部断言都走 `--print-plan` 这个**产品自己的出口**，不是脚本里另写一遍判定 ——
 *    另写一遍就等于测"我抄得对不对"，而产品走的是另一条路。
 *
 * ## 反证轮（--refute）
 *   MB1 去掉 sha256 比对 ⇒ WB.W4 红；
 *   MB2 去掉平台/ABI 过滤 ⇒ WB.W6 红；
 *   MB3 命中条目也返回 `source` ⇒ WB.W3 红。
 *
 * 用法：node e2e/engine/pydensecrf-wheel-check.mjs [--refute]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REFUTE = process.argv.includes('--refute');
const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..', '..');
const DEPS_MJS = path.join(ROOT, 'engine', 'scripts', 'install-engine-deps.mjs');
const WHEELS_JSON = path.join(ROOT, 'engine', 'wheels.manifest.json');
const GUIDE_WIN = path.join(ROOT, 'docs', 'install-guide-windows.md');
const GUIDE_MAC = path.join(ROOT, 'docs', 'install-guide-macos.md');
const MJS_ORIGINAL = fs.readFileSync(DEPS_MJS);
const WHEELS_ORIGINAL = fs.readFileSync(WHEELS_JSON);

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

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 跑产品的 `--print-plan`（夹具通过 `MIAO_*` 接缝注入），返回解析后的 JSON。 */
function printPlan(env = {}) {
  const r = spawnSync(process.execPath, [DEPS_MJS, '--print-plan'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const text = `${r.stdout ?? ''}`.trim();
  try {
    return { ...JSON.parse(text), code: r.status };
  } catch {
    return { parseError: true, code: r.status, out: text.slice(0, 300), err: String(r.stderr ?? '').slice(0, 300) };
  }
}

// ------------------------------------------------------------------ 夹具

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-wheel-'));
const wheelDir = path.join(tmp, 'wheels');
fs.mkdirSync(wheelDir, { recursive: true });

/** 先问产品"你是哪个平台"，再照它写夹具 —— 夹具自己推平台名就等于把判据抄了一遍。 */
const probe = printPlan({ MIAO_WHEELS_MANIFEST: path.join(tmp, 'empty.json') });
const PLATFORM = probe.platform;
const PY_TAG = probe.pythonTag;
if (!PLATFORM || !PY_TAG) {
  console.error(`无法从产品取得平台/ABI（--print-plan 输出异常）：${JSON.stringify(probe)}`);
  process.exit(1);
}

const REAL_FILE = `pydensecrf-2.2.2-${PY_TAG}-${PY_TAG}-fixture.whl`;
const otherFile = 'pydensecrf-2.2.2-cp311-cp311-other.whl';
const wheelBytes = Buffer.from('not a real wheel, but the hash is real\n');
fs.writeFileSync(path.join(wheelDir, REAL_FILE), wheelBytes);

function writeManifest(name, wheels, extra = {}) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify({ manifestVersion: 1, purpose: '夹具', wheels, ...extra }, null, 2));
  return p;
}

const envFor = (manifestPath) => ({ MIAO_WHEELS_MANIFEST: manifestPath, MIAO_WHEEL_DIR: wheelDir });

// ------------------------------------------------------------------ Rust 侧产品出口
//
// 上面 WB.W1–W12 全部走 Node 对照端（`install-engine-deps.mjs --print-plan`）。
// 🔴 但**打包用户机上跑的是 Rust 侧** `boxsvc/engine/wheels.rs::plan_crf`
//    （经 `boxsvc --engine-crf-plan`）—— 两边语义必须一致，而"一致"不能靠读代码相信。
//    这一组判据直接打产品出口，与上面那组构成**双靶**。

const BOXSVC = path.join(ROOT, 'app', 'src-tauri', 'target', 'debug', 'boxsvc.exe');
const hasBoxsvc = fs.existsSync(BOXSVC);

/** 跑产品的 `boxsvc --engine-crf-plan`，返回解析后的 JSON。 */
function rustPlan(env = {}) {
  const r = spawnSync(BOXSVC, ['--engine-crf-plan'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const text = `${r.stdout ?? ''}`.trim();
  try {
    return { ...JSON.parse(text), code: r.status };
  } catch {
    return { parseError: true, code: r.status, out: text.slice(0, 300), err: String(r.stderr ?? '').slice(0, 300) };
  }
}

// 🔴 `MIAO_WHEEL_DIR` 的语义两侧一致：它就是 **wheel 所在目录本身**
//    （Rust `wheel_dir()` 与 Node `wheelDir()` 都直接用它，不再往下拼 `.download-cache/wheels`）。
//    传成 `<root>/.download-cache/wheels` 会让 Rust 侧去找
//    `<root>/.download-cache/wheels/.download-cache/wheels` ⇒ 永远"不在盘上"。
const rustEnvFor = (manifestPath, modelRoot) => ({
  MIAO_WHEELS_MANIFEST: manifestPath,
  MIAO_WHEEL_DIR: wheelDir,
  MIAO_MODEL_ROOT: modelRoot,
});

if (hasBoxsvc) {
  // ---- WB.R1 平台/ABI 与 Node 侧同源 ----
  {
    const rustProbe = rustPlan(rustEnvFor(path.join(tmp, 'empty.json'), tmp));
    const nodeProbe = probe;
    check(
      'WB.R1 Rust 出口自报的平台/ABI 与 Node 侧一致（双靶同源，否则两侧会选出不同的 wheel）',
      rustProbe.platform === nodeProbe.platform && rustProbe.pythonTag === nodeProbe.pythonTag,
      { rust: [rustProbe.platform, rustProbe.pythonTag], node: [nodeProbe.platform, nodeProbe.pythonTag] },
    );
  }

  // ---- WB.R2 四态：命中 / 哈希不符 / 文件不在 / 无本平台条目 ----
  {
    const ok = writeManifest('rust-ok.json', [
      {
        id: 'fixture',
        platform: PLATFORM,
        pythonTag: PY_TAG,
        file: REAL_FILE,
        sha256: sha256(wheelBytes),
        sizeBytes: wheelBytes.length,
        bundled: false,
        path: '',
      },
    ]);
    const p1 = rustPlan(rustEnvFor(ok, tmp));
    check('WB.R2a Rust 出口：平台匹配 + 文件在盘 + sha256 相符 ⇒ route=wheel', p1.route === 'wheel', p1);

    const bad = writeManifest('rust-bad.json', [
      {
        id: 'fixture',
        platform: PLATFORM,
        pythonTag: PY_TAG,
        file: REAL_FILE,
        sha256: '0'.repeat(64),
        sizeBytes: wheelBytes.length,
        bundled: false,
        path: '',
      },
    ]);
    const p2 = rustPlan(rustEnvFor(bad, tmp));
    check(
      'WB.R2b Rust 出口：sha256 不符 ⇒ 拒绝并回退源码编译（宁可慢，也不装没验过的东西）',
      p2.route === 'source' && /sha256 与清单不符/.test(String(p2.reason)),
      p2,
    );

    const missing = writeManifest('rust-missing.json', [
      {
        id: 'fixture',
        platform: PLATFORM,
        pythonTag: PY_TAG,
        file: 'not-on-disk.whl',
        sha256: sha256(wheelBytes),
        sizeBytes: wheelBytes.length,
        bundled: false,
        path: '',
      },
    ]);
    const p3 = rustPlan(rustEnvFor(missing, tmp));
    check(
      'WB.R2c Rust 出口：文件不在盘上 ⇒ 回退且**不报错**（便利件缺件不该让装配失败）',
      p3.route === 'source' && /不在盘上/.test(String(p3.reason)),
      p3,
    );

    const p4 = rustPlan(rustEnvFor(path.join(tmp, 'empty.json'), tmp));
    check('WB.R2d Rust 出口：清单为空 ⇒ 回退源码编译（回退是前提，不是降级）', p4.route === 'source', p4);
  }

  // ---- WB.R3 macOS 镜像：清单里只有 Windows 条目 ⇒ 如实说"没有本平台" ----
  //     这一条是 macOS 边界的事实源：`wheels.manifest.json` 目前只有 win32-x64 一条，
  //     所以真机上 macOS 走的正是这条分支。它必须**说得出原因**（用户要知道自己为什么要装 CLT），
  //     而不是静默回退后让人在几分钟的编译失败里自己猜。
  {
    const foreign = writeManifest('rust-foreign.json', [
      {
        id: 'fixture',
        platform: 'win32-x64',
        pythonTag: 'cp311',
        file: otherFile,
        sha256: sha256(wheelBytes),
        sizeBytes: wheelBytes.length,
        bundled: false,
        path: '',
      },
    ]);
    const p = rustPlan({ ...rustEnvFor(foreign, tmp), MIAO_PLATFORM: 'darwin-arm64' });
    check(
      'WB.R3 macOS 镜像下 Rust 出口如实报「没有本平台条目 ⇒ 走源码编译」（不静默 —— 用户需要知道要装 Xcode CLT）',
      p.route === 'source' && p.platform === 'darwin-arm64' && /没有本平台/.test(String(p.reason)),
      p,
    );
  }

  // ---- WB.R4 随包那一份优先（包内 > 本机目录）----
  //     顺序反了的表现是：用户机上没有 `.download-cache`、也没有编译器 ⇒ 静默退回源码编译。
  {
    const repoWheel = path.join(ROOT, 'engine', 'wheels', 'pydensecrf-1.0-cp311-cp311-win_amd64.whl');
    const manifest = JSON.parse(fs.readFileSync(WHEELS_JSON, 'utf8'));
    const bundledEntry = (manifest.wheels || []).find((w) => w.bundled === true);
    const p = rustPlan({ MIAO_MODEL_ROOT: tmp });
    check(
      'WB.R4 真仓库上 Rust 出口选中**随包**那份 wheel（from=包内、sha256 已核对）',
      p.route === 'wheel' && p.from === '包内' && !!bundledEntry && fs.existsSync(repoWheel),
      p,
    );
  }
} else {
  // 🔴 没有 boxsvc 时**不许静默跳过**：跳过 ≠ 通过（E4 纪律）。
  //    先 `cargo build --bin boxsvc` 再跑本脚本。
  check('WB.R0 `boxsvc` 未构建（cargo build --bin boxsvc）—— Rust 侧产品出口因此无法取证', false, { boxsvc: BOXSVC });
}

// ------------------------------------------------------------------ WB.W1 清单结构

{
  const j = JSON.parse(fs.readFileSync(WHEELS_JSON, 'utf8'));
  const problems = [];
  if (j.manifestVersion !== 1) problems.push('manifestVersion 不是 1');
  if (!Array.isArray(j.wheels)) problems.push('wheels 不是数组');
  if (!j.purpose) problems.push('缺 purpose（不写清它是什么，后来者会以为它必须非空）');
  if (!j.fillHowTo) problems.push('缺 fillHowTo（"怎么填一条"必须写在文件里，不能只活在对话里）');
  for (const w of j.wheels ?? []) {
    if (!w.platform) problems.push(`${w.id ?? '?'}: 缺 platform`);
    if (!w.pythonTag) problems.push(`${w.id ?? '?'}: 缺 pythonTag`);
    if (!w.file) problems.push(`${w.id ?? '?'}: 缺 file`);
    // 🔴 sha256 形态必须钉：凭记忆写一个假的比不写更坏（校验会拦下真 wheel，或者更糟：拦不住假的）
    if (!/^[0-9a-f]{64}$/.test(String(w.sha256 ?? ''))) problems.push(`${w.id ?? '?'}: sha256 不是 64 位小写十六进制`);
    if (typeof w.sizeBytes !== 'number' || w.sizeBytes <= 0) problems.push(`${w.id ?? '?'}: sizeBytes 不是正数`);
    /*
     * 分发形态**三态恰取其一**：`bundled: true`（随包分发，G3）· `local: true`（本机构建、
     * **尚未托管**）· `url`（已上传镜像通道）。
     *
     * 为什么不是"必须有 url"：托管通道本仓还不存在，而把"本机真构建出来的那颗"如实登记
     * 是有价值的（跑过一次 `--build-wheel` 的机器就能走 wheel 不编译），前提是**说清它没托管**。
     * 为什么不是"url 可选"：那会让"已托管"与"没托管"混在一张表里 ——
     * 用户照着清单去下载却下不到，且没人知道该怪谁。
     * 为什么多出 `bundled`：G3 把它升为"零编译器机器上的唯一来源"，它的**落地位置**是仓库
     * （`path`），与"从哪儿下载"是两回事 ⇒ 混进 url 那一态会让优先级失去意义。
     */
    const isBundled = w.bundled === true;
    const isLocal = w.local === true;
    const hasUrl = typeof w.url === 'string' && w.url.trim() !== '';
    const states = [isBundled, isLocal, hasUrl].filter(Boolean).length;
    if (states > 1) problems.push(`${w.id ?? '?'}: 同时标了 bundled / local / url 中的多项（三态必须恰取其一）`);
    if (states === 0)
      problems.push(`${w.id ?? '?'}: 既没标 bundled、也没有 url、也没标 local: true（这条到底怎么分发？谁来提供它？）`);
    if (isBundled && !w.path) problems.push(`${w.id ?? '?'}: 标了 bundled 却没有 path（包内那一份在哪儿？）`);
  }
  check(
    'WB.W1 `engine/wheels.manifest.json` 结构合法：条目（若有）逐条带 platform / pythonTag / file / 64 位 sha256 / 正数体积，' +
      '且分发形态 **bundled / local / url 三态恰取其一**（"随包"与"尚未托管"都必须说出来），并写清了 purpose 与 fillHowTo',
    problems.length === 0,
    problems,
  );
}

// ------------------------------------------------------------------ WB.W1b 随包那一份必须真实存在且哈希一致（G3）

{
  /*
   * G3 的全部意义是「用户机零编译器也能装」—— 而它成立的前提只有一个：
   * **包内那个文件真的在仓库里、且 sha256 与清单一致**。
   * 少了这条，清单可以写一条"随包"而仓库里什么都没有：正向全绿、装机时静默回退源码编译
   * （症状是在没编译器的机器上装不上，离"清单里明明写着 bundled"极远）。
   */
  const j = JSON.parse(fs.readFileSync(WHEELS_JSON, 'utf8'));
  const problems = [];
  let bundledCount = 0;
  for (const w of j.wheels ?? []) {
    if (w.bundled !== true) continue;
    bundledCount += 1;
    const abs = path.resolve(path.join(ROOT, 'engine'), String(w.path));
    if (!fs.existsSync(abs)) {
      problems.push(`${w.id ?? '?'}: bundled 条目的 path 在仓库里不存在（${abs}）`);
      continue;
    }
    const got = sha256(fs.readFileSync(abs));
    if (got !== w.sha256)
      problems.push(
        `${w.id ?? '?'}: 包内 wheel 的 sha256 与清单不符（清单 ${String(w.sha256).slice(0, 12)}… / 实际 ${got.slice(0, 12)}…）`,
      );
    if (fs.statSync(abs).size !== w.sizeBytes)
      problems.push(
        `${w.id ?? '?'}: 包内 wheel 的体积与清单不符（清单 ${w.sizeBytes} / 实际 ${fs.statSync(abs).size}）`,
      );
  }
  check(
    `WB.W1b 随包（bundled）条目的文件**真的在仓库里**且 sha256 / 体积与清单一致（G3 的成立前提；本清单 ${bundledCount} 条）`,
    problems.length === 0 && bundledCount > 0,
    problems.length ? problems : { bundledCount },
  );
}

// ------------------------------------------------------------------ WB.W2 空清单 ⇒ 回退源码编译

{
  const empty = writeManifest('empty.json', []);
  const plan = printPlan(envFor(empty));
  check(
    'WB.W2 清单为空 ⇒ 走源码编译（**回退是前提**：清单空不该让装配整体失败），且 reason 说得出为什么',
    plan.route === 'source' && /还没有任何条目/.test(String(plan.reason)),
    plan,
  );
}

// ------------------------------------------------------------------ WB.W3 命中 ⇒ 优先 wheel

{
  const ok = writeManifest('ok.json', [
    {
      id: 'fixture',
      platform: PLATFORM,
      pythonTag: PY_TAG,
      file: REAL_FILE,
      sha256: sha256(wheelBytes),
      sizeBytes: wheelBytes.length,
      url: 'https://example.invalid/whl',
    },
  ]);
  const plan = printPlan(envFor(ok));
  check(
    'WB.W3 有本平台条目且 sha256 对得上 ⇒ 走 **wheel**（不编译 —— 这正是"无编译器也能装"的全部意义）',
    plan.route === 'wheel' &&
      /sha256 已核对/.test(String(plan.reason)) &&
      plan.wheelAbs === path.join(wheelDir, REAL_FILE),
    plan,
  );
}

// ------------------------------------------------------------------ WB.W3b 包内（bundled）优先于本机目录（G3）

{
  /*
   * 用户机上没有 `.download-cache` ⇒ 包内那一份必须**先被看到**。
   * 判据：同一个 `file` 名在包内与本机目录各有一份（内容不同 ⇒ 哈希不同），
   * 清单的 sha256 算的是**包内**那一份 ⇒ 优先级反了会因哈希不符退回源码编译，
   * 或者更坏：拿本机目录里那份**没验过**的文件去装。
   * 🔴 平台 / ABI 走接缝强制命中真实包内条目 —— 这条判据要**跨平台可测**（macOS 机器上也要能跑）。
   */
  const real = JSON.parse(fs.readFileSync(WHEELS_JSON, 'utf8')).wheels.find((w) => w.bundled === true);
  if (!real) {
    check('WB.W3b `bundled` 条目优先于本机目录（清单里没有 bundled 条目 ⇒ 本条无从取证）', false, {
      reason: '清单无 bundled 条目',
    });
  } else {
    const decoyPath = path.join(wheelDir, String(real.file));
    fs.writeFileSync(decoyPath, Buffer.from('decoy: same file name, different bytes\n'));
    const mf = writeManifest('bundled-priority.json', [
      {
        id: real.id,
        platform: real.platform,
        pythonTag: real.pythonTag,
        file: real.file,
        sha256: real.sha256,
        sizeBytes: real.sizeBytes,
        bundled: true,
        path: real.path,
        local: false,
        url: null,
      },
    ]);
    const plan = printPlan({ ...envFor(mf), MIAO_PLATFORM: real.platform, MIAO_PY_VERSION: '3.11' });
    const wantAbs = path.resolve(path.join(ROOT, 'engine'), String(real.path));
    check(
      'WB.W3b `bundled` 条目**优先于本机目录**（同名诱饵内容不同 ⇒ 必须取包内那一份，否则用户机上必然回退源码编译）',
      plan.route === 'wheel' && plan.wheelAbs === wantAbs && /来源 包内/.test(String(plan.reason)),
      { route: plan.route, wheelAbs: plan.wheelAbs, wantAbs, reason: plan.reason },
    );
    fs.rmSync(decoyPath, { force: true });
  }
}

// ------------------------------------------------------------------ WB.W4 sha256 不符 ⇒ 拒绝

{
  const bad = writeManifest('badhash.json', [
    {
      id: 'fixture',
      platform: PLATFORM,
      pythonTag: PY_TAG,
      file: REAL_FILE,
      sha256: '0'.repeat(64),
      sizeBytes: wheelBytes.length,
      url: 'https://example.invalid/whl',
    },
  ]);
  const plan = printPlan(envFor(bad));
  check(
    'WB.W4 sha256 与盘上不符 ⇒ **拒绝使用**并回退源码编译（宁可慢，也不装一个不是我们验过的东西）' +
      '—— 这一条证明"清单化 sha256"真的在起作用，不只是个字段',
    plan.route === 'source' && /sha256 与清单不符/.test(String(plan.reason)),
    plan,
  );
}

// ------------------------------------------------------------------ WB.W5 wheel 不在盘上 ⇒ 回退

{
  const missing = writeManifest('missing.json', [
    {
      id: 'fixture',
      platform: PLATFORM,
      pythonTag: PY_TAG,
      file: 'not-downloaded-yet.whl',
      sha256: sha256(wheelBytes),
      sizeBytes: wheelBytes.length,
      url: 'https://example.invalid/whl',
    },
  ]);
  const plan = printPlan(envFor(missing));
  check(
    'WB.W5 清单有本平台条目但 wheel 不在盘上 ⇒ 回退源码编译（**不报错**：便利通道缺件不该让装配失败）',
    plan.route === 'source' && /不在盘上/.test(String(plan.reason)),
    plan,
  );
}

// ------------------------------------------------------------------ WB.W6 别的平台的条目 ⇒ 不许用

{
  const other = PLATFORM === 'win32-x64' ? 'darwin-arm64' : 'win32-x64';
  const foreign = writeManifest('foreign.json', [
    {
      id: 'fixture',
      platform: other,
      pythonTag: PY_TAG,
      file: otherFile,
      sha256: sha256(wheelBytes),
      sizeBytes: wheelBytes.length,
      url: 'https://example.invalid/whl',
    },
  ]);
  const plan = printPlan(envFor(foreign));
  check(
    'WB.W6 清单里只有**别的平台**的条目 ⇒ 回退源码编译（不许在 Windows 上装 macOS 的 wheel —— 平台过滤只该有一处实现）',
    plan.route === 'source' && /没有本平台/.test(String(plan.reason)),
    { plan, other },
  );
}

// ------------------------------------------------------------------ WB.W9 跨平台可问：`--print-plan` 不受平台闸门限制

{
  /*
   * macOS 引导里让用户先跑 `--print-plan` 看有没有 wheel —— 如果那条命令在 macOS 上
   * 因为平台闸门直接退出 2，文档就给了一条跑不通的指令（而且看起来"照做了却什么都没发生"）。
   */
  const mac = printPlan({ MIAO_PLATFORM: 'darwin-arm64', MIAO_WHEELS_MANIFEST: path.join(tmp, 'empty.json') });
  check(
    'WB.W9 「非 Windows 就拒绝」的闸门**不覆盖** `--print-plan`：接缝设成 darwin-arm64 时它仍能打印计划',
    mac.code === 0 && mac.platform === 'darwin-arm64' && mac.route === 'source',
    { code: mac.code, platform: mac.platform, reason: mac.reason },
  );

  // 反过来：默认调用（不带 `--print-plan`）在非 Windows 下**必须**仍被闸门拦下（D7 验收②）
  const refused = spawnSync(process.execPath, [DEPS_MJS], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, MIAO_PLATFORM: 'darwin-arm64' },
  });
  check(
    'WB.W9b 同一接缝下**默认调用**仍被平台闸门拒绝（exit 2 + PLATFORM_UNSUPPORTED）—— 旁路只给只读的 `--print-plan`',
    refused.status === 2 && /PLATFORM_UNSUPPORTED/.test(`${refused.stdout}${refused.stderr}`),
    { code: refused.status },
  );
}

// ------------------------------------------------------------------ WB.W11 `--wheel-entry` 也是只读模式（macOS 用户也要能算哈希）

{
  /*
   * macOS 引导里让用户用 `--wheel-entry` 算 sha256 并生成清单条目 —— 如果那条命令在 macOS 上
   * 因为平台闸门直接退出 2，文档就给了一条跑不通的指令。
   * 判据走**产品自己的出口**：给一颗夹具 whl，接缝设成 darwin-arm64，看它能不能算出正确的条目。
   */
  const fakeWhl = path.join(tmp, `pydensecrf-1.0-${PY_TAG}-${PY_TAG}-darwin.whl`);
  fs.writeFileSync(fakeWhl, wheelBytes);
  const r = spawnSync(process.execPath, [DEPS_MJS, '--wheel-entry', fakeWhl], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, MIAO_PLATFORM: 'darwin-arm64' },
  });
  let entry = null;
  try {
    // ⚠️ JSON 之后还有一行 `⚠ 把上面这条粘进…` 的提示 ⇒ 只取**第一个 `{` 到最后一个 `}`**
    //    （那行提示里没有 `}`，所以最后一个 `}` 就是 JSON 的收尾）。直接 `slice(indexOf('{'))` 会带上尾巴而解析失败。
    const out = String(r.stdout ?? '');
    entry = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  } catch {
    /* 下面判据会红 */
  }
  check(
    'WB.W11 `--wheel-entry` 属于**只读模式**：非 Windows 下仍能用（算 sha256 + 出条目），' +
      '且 `platform` 跟随接缝 —— 否则 macOS 引导里那条命令根本跑不通',
    r.status === 0 &&
      entry &&
      entry.sha256 === sha256(wheelBytes) &&
      entry.sizeBytes === wheelBytes.length &&
      entry.platform === 'darwin-arm64',
    { status: r.status, entry, wantSha: sha256(wheelBytes).slice(0, 12) },
  );
}

// ------------------------------------------------------------------ WB.W7 文档

{
  const win = fs.readFileSync(GUIDE_WIN, 'utf8');
  const mac = fs.readFileSync(GUIDE_MAC, 'utf8');
  check(
    'WB.W7 两份安装引导都把"预编译 wheel 通道 / 没有编译器也能装"写出来了（否则用户永远只知道要装 MSVC / Xcode CLT）',
    /wheel/i.test(win) &&
      /wheel/i.test(mac) &&
      /wheels\.manifest\.json/.test(win) &&
      /wheels\.manifest\.json/.test(mac),
    { winHasWheel: /wheel/i.test(win), macHasWheel: /wheel/i.test(mac) },
  );
}

// ------------------------------------------------------------------ WB.W8 单源

{
  const src = fs.readFileSync(DEPS_MJS, 'utf8');
  const planCalls = (src.match(/planCrf\(\)/g) ?? []).length;
  // `--print-plan` 与批 B 各调一次；再少就说明有一处自己另判了一遍
  check(
    'WB.W8 `--print-plan` 与批 B **共用** `planCrf()`（>= 2 处调用），没有第二份"平台匹配 + 哈希比对"的实现',
    planCalls >= 2 && !/(w\.platform === key)/.test(src.replace(/function planCrf[\s\S]*?\n}/, '')),
    { planCalls },
  );
}

// ------------------------------------------------------------------ 反证轮

if (REFUTE) {
  console.log('\n── 反证轮（改源码 ⇒ 指定断言必须红；跑完按字节还原）──\n');

  function mutate(from, to) {
    const text = MJS_ORIGINAL.toString('utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const f = from.replace(/\r?\n/g, eol);
    const t = to.replace(/\r?\n/g, eol);
    if (!text.includes(f)) throw new Error(`反证锚点未命中（写法变了？）：\n  ${from.slice(0, 90)}`);
    fs.writeFileSync(DEPS_MJS, Buffer.from(text.replace(f, t), 'utf8'));
    return () => fs.writeFileSync(DEPS_MJS, MJS_ORIGINAL);
  }

  /** 同 `mutate`，但改的是**清单**（WB.W1 的判据对象）。 */
  function mutateManifest(from, to) {
    const original = fs.readFileSync(WHEELS_JSON);
    const text = original.toString('utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const f = from.replace(/\r?\n/g, eol);
    const t = to.replace(/\r?\n/g, eol);
    if (!text.includes(f)) throw new Error(`清单反证锚点未命中（写法变了？）：\n  ${from.slice(0, 90)}`);
    fs.writeFileSync(WHEELS_JSON, Buffer.from(text.replace(f, t), 'utf8'));
    return () => fs.writeFileSync(WHEELS_JSON, original);
  }

  const runForward = () => {
    const r = spawnSync(process.execPath, [SELF], { cwd: ROOT, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const hasRed = (out, name) => out.split('\n').some((l) => l.trimStart().startsWith('✗') && l.includes(name));
  const redOn = (out) =>
    out
      .split('\n')
      .filter((l) => l.trimStart().startsWith('✗'))
      .map((l) => l.trim().slice(0, 44));

  const HASH_GUARD = 'if (got !== w.sha256) {';
  const PLATFORM_FILTER = 'w.platform === key && w.pythonTag === tag';
  const HIT_RETURN = "route: 'wheel',";

  // ---- MB1：不比对哈希（"清单里写了就信"）----
  {
    const restore = mutate(HASH_GUARD, 'if (false) {');
    const r = runForward();
    check('MB1 去掉 sha256 比对（"清单里写了就信"）⇒ WB.W4 红', r.code !== 0 && hasRed(r.out, 'WB.W4'), {
      code: r.code,
      redOn: redOn(r.out),
    });
    restore();
  }

  // ---- MB2：不过滤平台/ABI（跨平台装错 wheel）----
  {
    const restore = mutate(PLATFORM_FILTER, 'true');
    const r = runForward();
    check(
      'MB2 去掉平台/ABI 过滤 ⇒ WB.W6 红（Windows 上会去装 macOS 的 wheel）',
      r.code !== 0 && hasRed(r.out, 'WB.W6'),
      { code: r.code, redOn: redOn(r.out) },
    );
    restore();
  }

  // ---- MB4：给"随包"的条目再补一个 url（三态混写）----
  {
    // ⚠️ 变异对象是**清单**而不是脚本：`mutate()` 只改 `install-engine-deps.mjs`
    //    （MB1–MB3 用它），拿它改清单会"锚点未命中"直接抛 —— 反证轮里没有第 4 类退出码，
    //    所以这里必须另有一个 helper，别想着"顺手复用"。
    // ⚠️ 也别用"**追加**一个 url 键"的写法：同一对象里两个 `url` ⇒ `JSON.parse` 取**最后一个**
    //    （`null`）⇒ 变异其实没生效，反证轮会报假阳性。要改就改**已有的那个键**。
    const restore = mutateManifest('"url": null,', '"url": "https://example.invalid/whl",');
    const r = runForward();
    check(
      'MB4 给 `bundled: true` 的条目再补上 url ⇒ WB.W1 红（"随包"与"已托管"不能同时成立，三态恰取其一）',
      r.code !== 0 && hasRed(r.out, 'WB.W1'),
      { code: r.code, redOn: redOn(r.out) },
    );
    restore();
  }

  // ---- MB5：去掉 bundled 又不给 url / local（这条到底怎么分发？）----
  {
    const restore = mutateManifest('"bundled": true,', '"bundled": false,');
    const r = runForward();
    check(
      'MB5 去掉 `bundled: true` 又不给 url / local ⇒ WB.W1 红（用户照清单去找却拿不到，且没人知道该怪谁）',
      r.code !== 0 && hasRed(r.out, 'WB.W1'),
      { code: r.code, redOn: redOn(r.out) },
    );
    restore();
  }

  // ---- MB7：包内优先被摘掉（只看本机目录）----
  {
    const restore = mutate(
      "const abs = bundled && fs.existsSync(bundled) ? bundled : path.join(wheelDir(), String(w.file || ''));",
      "const abs = path.join(wheelDir(), String(w.file || ''));",
    );
    const r = runForward();
    check(
      'MB7 摘掉"包内优先"（只看本机目录）⇒ WB.W3b 红（用户机上没有 .download-cache ⇒ 必然回退源码编译）',
      r.code !== 0 && hasRed(r.out, 'WB.W3b'),
      { code: r.code, redOn: redOn(r.out) },
    );
    restore();
  }

  // ---- MB8：bundled 的 path 指向一个不存在的文件 ----
  {
    const restore = mutateManifest(
      '"path": "wheels/pydensecrf-1.0-cp311-cp311-win_amd64.whl",',
      '"path": "wheels/no-such-file.whl",',
    );
    const r = runForward();
    check(
      'MB8 `bundled` 的 path 指向不存在的文件 ⇒ WB.W1b 红（清单可以写"随包"而仓库里什么都没有）',
      r.code !== 0 && hasRed(r.out, 'WB.W1b'),
      { code: r.code, redOn: redOn(r.out) },
    );
    restore();
  }

  // ---- MB6：把 `--wheel-entry` 从只读白名单里摘掉（macOS 上那条命令会 exit 2）----
  {
    const restore = mutate(
      "const READONLY_MODES = ['--print-plan', '--wheel-entry'];",
      "const READONLY_MODES = ['--print-plan'];",
    );
    const r = runForward();
    check(
      'MB6 `--wheel-entry` 不再属于只读模式 ⇒ WB.W11 红（macOS 引导里让用户跑的命令会直接退出 2）',
      r.code !== 0 && hasRed(r.out, 'WB.W11'),
      { code: r.code, redOn: redOn(r.out) },
    );
    restore();
  }

  // ---- MB3：命中也不走 wheel（便利通道形同虚设）----
  {
    const restore = mutate(HIT_RETURN, "route: 'source',");
    const r = runForward();
    check(
      'MB3 命中条目也返回 `source` ⇒ WB.W3 红（wheel 通道形同虚设，等于没做）',
      r.code !== 0 && hasRed(r.out, 'WB.W3'),
      { code: r.code, redOn: redOn(r.out) },
    );
    restore();
  }

  // 收尾：脚本与清单都要按字节还原（MB4/MB5/MB8 改的是清单，只查脚本会漏）
  check(
    'R1 变异收尾：`install-engine-deps.mjs` 与 `wheels.manifest.json` 都按字节还原',
    MJS_ORIGINAL.equals(fs.readFileSync(DEPS_MJS)) && WHEELS_ORIGINAL.equals(fs.readFileSync(WHEELS_JSON)),
    null,
  );
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
