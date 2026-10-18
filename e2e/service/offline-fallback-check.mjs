#!/usr/bin/env node
/**
 * C4 · 「模型预置后的离线兜底」钉子 —— 「断网也能加载」
 * =============================================================================
 * 对应计划文档 C4：沿用 D-97c/D-99 既有实现 —— `HF_HUB_OFFLINE` + `fetch:models --link`
 * 零网络重建。验收①「断网后引擎仍能加载 nllb 与视觉模型」，②「清掉 `src/models/` 的
 * 硬链接 ⇒ 变红」。
 *
 * ## 它钉的是**机制**，以及这条机制**真的接到了产品上**
 *
 * 真机那一半（pull 掉网线、起真引擎翻译一张）要 13 GB 真权重 + 真引擎，
 * 只能归 `check:e3:real` / `check:nightly` 那一层（见文末"取证边界"）。
 * 本脚本钉的是让那一半成立的三条机制，全部**可在秒级、零网络下反证**：
 *
 *   ① **离线键只在权重确实在盘时才注入**（`hf_offline_env`）：没装就宣布离线，
 *      会把"首次下载"一并堵死；装了却不注入，引擎会去联网重下几个 GB。
 *      两个方向都要验 —— 只验"注入了"的话，恒注入也能绿。
 *   ② **`--link` 真的零网络**：把清单里的 `url` 指向**不可达地址**（`127.0.0.1:1`），
 *      任何一步真去联网就必然失败。这是"零网络"唯一能自查的形态
 *      —— 光看代码"没调 http"是读注释。
 *   ③ **零网络重建之后，引擎真会去打开的那条路径在位**：`<root>/src/<linkTo>`
 *      与 HF 缓存布局（`<cache>/snapshots/<rev>/<file>` + `refs/main`）。
 *      D-99 的结论是"只平铺 blobs 的话 HF 看不见它" ⇒ 判据必须落到 snapshots+refs 上。
 *
 * ## 验收②怎么写成可反证的形式（🔴 这里有一处**分层**，写错就等于没测）
 * 「清掉 `src/models/` 的硬链接 ⇒ 变红」。但`--fetch-models --check` 判的是 **store 里的
 * 权威副本**（下载器自己的完整性检查），清掉引擎树里的链接后它**照样全绿** —— 实测过。
 * 「引擎能不能打开」判的是**引擎源码树**，由 `--engine-model-files`
 * （`model_status::abs_for`：有 `linkTo` 的看 `<root>/src/<linkTo>`）回答。
 * 两者可以同时"一方全绿、另一方全红"，而那正是 R6「文件明明在、引擎说找不到」的形态。
 * 所以 W3 系列把**两层一起**钉住：引擎树那一路随链接存在与否翻转（W3a/W3c），
 * 同时 store 那一路**始终全绿**（W3b）—— 后一条是"分层真的存在"的证据，
 * 少了它就分不清"测对了层"与"两层其实是一条判据"。
 *
 * ## 反证轮（--refute）
 * - M1 `hf_offline_env` 恒返回空（等于"从不注入"）⇒ W1b 红。
 * - M2 `hf_offline_env` 忽略逃生开关（等于"永远注入"）⇒ W4 红。
 * - M3 `link_models` 不再写 HF 的 `snapshots` / `refs`（"链接建好了、权重还是不被认"）⇒ W2c 红。
 *   🔴 三条各挡一类失效，缺一条就有一类漏网（M1/M2 是同一条判据的两端，只留一条会假绿）。
 *
 * ## 取证边界（如实记账）
 * 「真引擎在断网下真的加载了 nllb 与视觉模型」这一步**没有**在本脚本里跑：
 * 它需要真权重（≈13 GB）与真引擎，属 `nightly` 层。本脚本证明的是**上游条件**：
 * 离线键按盘上事实注入、零网络能重建出引擎真要打开的那条路径。
 * 真机那一半在 `docs/internal/spec-notes-1.md` 里按 `unverified` 记账，不计入"已验"。
 *
 * 用法：node e2e/service/offline-fallback-check.mjs [--refute]
 * 前置：`cd src-tauri && cargo build --bin mangasvc`
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUST_BIN, REPO_ROOT } from './_service-harness.mjs';

const REFUTE = process.argv.includes('--refute');
const SELF = fileURLToPath(import.meta.url);
const ENGINE_RS = path.join(REPO_ROOT, 'src-tauri', 'src', 'mangasvc', 'engine.rs');
const MODEL_STORE_RS = path.join(REPO_ROOT, 'src-tauri', 'src', 'mangasvc', 'engine', 'model_store.rs');
const SRC_TAURI = path.join(REPO_ROOT, 'src-tauri');
const CARGO = process.env.CARGO || 'cargo';

/** HF 缓存根（相对 `<root>/src`）—— 与清单 `linkTo` 的 `<缓存>/blobs/<blob>` 约定一致。 */
const NLLB_CACHE = 'models/translators/nllb/models--facebook--nllb-200-distilled-600M';
const REV = 'rev1';

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

if (!fs.existsSync(RUST_BIN)) {
  console.error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd src-tauri && cargo build --bin mangasvc`);
  process.exit(1);
}

// ------------------------------------------------------------------ 夹具

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const contentA = 'visual-weight-image\n';
const contentB = 'nllb-pytorch-model\n';

/**
 * 两条条目：`a` 走 `linkTo`（视觉模型那条路），`hf1` 带 `hf`（nllb 那条路）。
 *
 * 🔴 `url` 一律指向 **不可达地址**（`http://127.0.0.1:1/…`）。这是本脚本能声称
 * "零网络"的依据：只要哪一步真去联网，它必然失败，而不是"悄悄成功了"。
 */
function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-offline-'));
  const manifest = {
    manifestVersion: 1,
    engineCommit: 'deadbeef',
    sets: { visual: { files: ['a'] }, translation: { files: ['hf1'] } },
    files: [
      {
        id: 'a',
        set: 'visual',
        dest: 'models-store/a.bin',
        linkTo: 'models/a.bin',
        sha256: sha(contentA),
        sizeBytes: Buffer.byteLength(contentA),
        url: 'http://127.0.0.1:1/a.bin',
      },
      {
        id: 'hf1',
        set: 'translation',
        dest: `models-store/nllb/blobs/blobAAA`,
        linkTo: `${NLLB_CACHE}/blobs/blobAAA`,
        hf: { revision: REV, filename: 'pytorch_model.bin' },
        sha256: sha(contentB),
        sizeBytes: Buffer.byteLength(contentB),
        url: 'http://127.0.0.1:1/blobAAA',
      },
    ],
  };
  const mp = path.join(root, 'models.manifest.json');
  fs.writeFileSync(mp, JSON.stringify(manifest, null, 2));
  // store 里的**权威副本**（下载已经做过了，现在只谈"离线重建"）
  fs.mkdirSync(path.join(root, 'models-store', 'nllb', 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'models-store', 'a.bin'), contentA);
  fs.writeFileSync(path.join(root, 'models-store', 'nllb', 'blobs', 'blobAAA'), contentB);
  // 引擎源码树（`MIAO_ENGINE_DIR`）—— 链接基准与"快照目录存不存在"都看它
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-offline-state-'));
  return { root, mp, state, engineDir: path.join(root, 'src') };
}

/** 引擎树里"引擎真会去打开"的两条路径（与清单逐字对齐，不猜）。 */
const enginePaths = (fx) => ({
  visual: path.join(fx.engineDir, 'models', 'a.bin'),
  snapshot: path.join(fx.engineDir, NLLB_CACHE, 'snapshots', REV, 'pytorch_model.bin'),
  refs: path.join(fx.engineDir, NLLB_CACHE, 'refs', 'main'),
});

/** 环境：模型根 / 清单 / 引擎目录 / 状态目录一律指夹具（绝不碰用户真实 appData）。 */
const envFor = (fx, extra = {}) => ({
  MIAO_MODEL_MANIFEST: fx.mp,
  MIAO_MODEL_ROOT: fx.root,
  MIAO_ENGINE_DIR: fx.engineDir,
  MIAO_MANGA_STATE_DIR: fx.state,
  ...extra,
});

function runAsync(args, env) {
  return new Promise((resolve) => {
    const c = spawn(RUST_BIN, args, {
      env: { ...process.env, ...env },
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

const planFor = async (fx, extra = {}) => {
  const r = await runAsync(['--print-launch-plan', 'real'], envFor(fx, extra));
  if (r.code !== 0) throw new Error(`--print-launch-plan 退出 ${r.code}：${r.err.slice(0, 300)}`);
  return JSON.parse(r.out);
};

/** `--check --report`，返回 `{ verify, hf }`。缺文件时按设计退出码 1 ⇒ 只看 report。 */
async function checkReport(fx) {
  const report = path.join(fx.root, `report-${Math.random().toString(36).slice(2)}.json`);
  await runAsync(['--fetch-models', '--check', '--manifest', fx.mp, '--root', fx.root, '--report', report], envFor(fx));
  const body = JSON.parse(fs.readFileSync(report, 'utf8'));
  fs.rmSync(report, { force: true });
  return body;
}

const missingIds = (body) => {
  const v = body.verify ?? {};
  return [...new Set([...(v.bad ?? []).map((b) => b.id), ...(v.missing ?? [])])];
};

/**
 * 「**引擎真会去打开的那条路径**在不在」—— 走 D8 的 `--engine-model-files`
 * （`model_status::abs_for`：有 `linkTo` 的看 `<root>/src/<linkTo>`，不是看 store 的 `dest`）。
 *
 * 🔴 这是本脚本里最关键的一处分层：`--fetch-models --check` 判的是 **store 里的权威副本**
 * （下载器自己的完整性检查），而"引擎能不能打开"判的是**引擎源码树**。
 * 两者可以同时"一方全绿、另一方全红" —— 那正是 R6「文件明明在、引擎说找不到」的形态。
 * 把验收②写在 store 那一路上的话，清掉链接后照样全绿（实测过），等于没测。
 */
async function engineTreeReady(fx) {
  const r = await runAsync(['--engine-model-files'], envFor(fx));
  if (r.code !== 0) throw new Error(`--engine-model-files 退出 ${r.code}：${r.err.slice(0, 300)}`);
  return Object.fromEntries((JSON.parse(r.out).files ?? []).map((f) => [f.id, f.ready]));
}

const hasOfflineKeys = (plan) => {
  const env = plan?.engine?.env ?? {};
  return env.HF_HUB_OFFLINE === '1' && env.TRANSFORMERS_OFFLINE === '1';
};

// ------------------------------------------------------------------ W1：离线键只在权重在盘时注入

{
  const fx = buildFixture(); // 引擎树里**没有** snapshots ⇒ 权重未预置
  const plan = await planFor(fx);
  check(
    'W1a 权重**未**预置 ⇒ 配方的 `engine.env` 里**不含** HF 离线键（否则会把首次下载一并堵死）',
    !hasOfflineKeys(plan),
    { env: plan?.engine?.env ?? {} },
  );
  fs.rmSync(fx.root, { recursive: true, force: true });
  fs.rmSync(fx.state, { recursive: true, force: true });
}

{
  const fx = buildFixture();
  // 造出"权重已预置"的盘上事实：HF 快照目录存在（`translation_weights_present` 认的就是它）
  fs.mkdirSync(path.dirname(enginePaths(fx).snapshot), { recursive: true });
  const plan = await planFor(fx);
  check(
    'W1b 权重已预置 ⇒ 配方的 `engine.env` 含 `HF_HUB_OFFLINE=1` + `TRANSFORMERS_OFFLINE=1`（断网加载的前提）',
    hasOfflineKeys(plan),
    { env: plan?.engine?.env ?? {} },
  );

  /*
   * ---- W4：逃生开关（**必须在清引擎树之前跑**）----
   * 逃生开关只在"权重在盘"时才可观测：`present=false` 时无论开关怎样都不注入，
   * 于是"忽略开关"的变异会在那时伪装成"没问题"。放在这里，`present` 恰好为真。
   */
  const off = await planFor(fx, { MIAO_NO_HF_OFFLINE: '1' });
  check(
    'W4 `MIAO_NO_HF_OFFLINE=1` ⇒ 离线键消失（逃生开关真的在起作用；否则"永远注入"也会让 W1b 绿）',
    !hasOfflineKeys(off),
    { env: off?.engine?.env ?? {} },
  );

  // ---- W3：清掉链接 ⇒ 引擎树那一层必须红（验收②）----
  const before = await engineTreeReady(fx);
  check(
    'W3a 链接尚未建立（store 里有、引擎树里没有）⇒ 「引擎真要打开的那条路径」两条全未就绪',
    before.a === false && before.hf1 === false,
    before,
  );

  // 🔴 与此同时 **store 那一路**是全绿 —— 两层判据确实分层，不是同一条判据的两个说法。
  //    没有这一条，把验收②写在 store 上（清链接后照样绿）这个错误也看不出来。
  const storeBefore = await checkReport(fx);
  check(
    'W3b 同一时刻 `--fetch-models --check`（判 **store 权威副本**）报 0 缺失 ⇒ 两层判据真的分层：' +
      '"store 完好"与"引擎打不开"可以同时成立（R6 的陷阱正是它）',
    missingIds(storeBefore).length === 0,
    { missing: missingIds(storeBefore), hfMissing: storeBefore.hf?.missing?.map((m) => m.id) },
  );

  const link = await runAsync(['--fetch-models', '--link', '--manifest', fx.mp, '--root', fx.root], envFor(fx));
  check(
    'W2 `--link` 在 `url` 指向**不可达地址**时仍然成功 ⇒ 这条收尾路径真的零网络',
    link.code === 0 && /链接：/.test(link.out),
    { code: link.code, out: link.out.slice(0, 200), err: link.err.slice(0, 200) },
  );

  const paths = enginePaths(fx);
  check('W2b 重建后 `<root>/src/<linkTo>`（引擎实际打开的那一个）在位', fs.existsSync(paths.visual), {
    want: paths.visual,
  });

  const after = await engineTreeReady(fx);
  const hfAfter = await checkReport(fx);
  check(
    'W2c 重建后：引擎树那一路两条都就绪（`ready=true`），且 HF 缓存布局' +
      '（`snapshots/<rev>/<file>` + `refs/main`）全部可解析 —— 这才是"断网也加载得起来"',
    after.a === true &&
      after.hf1 === true &&
      (hfAfter.hf?.missing ?? []).length === 0 &&
      fs.existsSync(paths.snapshot) &&
      fs.existsSync(paths.refs),
    {
      ready: after,
      hfMissing: hfAfter.hf?.missing?.map((m) => m.id),
      snapshot: fs.existsSync(paths.snapshot),
      refs: fs.existsSync(paths.refs),
    },
  );

  // 验收②：清掉引擎树里的链接/快照 ⇒ 引擎树那一路必须重新红，**而 store 里的权威副本仍在**
  fs.rmSync(path.join(fx.engineDir, 'models'), { recursive: true, force: true });
  const storeIntact = fs.existsSync(path.join(fx.root, 'models-store', 'a.bin'));
  const cleared = await engineTreeReady(fx);
  const storeAfter = await checkReport(fx);
  check(
    'W3c 清掉引擎树里的链接/快照 ⇒ 两条立刻回到未就绪，而 store 里的权威副本**仍在**（该绿的一直绿、该红的立刻红）',
    storeIntact && cleared.a === false && cleared.hf1 === false && missingIds(storeAfter).length === 0,
    { storeIntact, cleared, storeMissing: missingIds(storeAfter) },
  );

  fs.rmSync(fx.root, { recursive: true, force: true });
  fs.rmSync(fx.state, { recursive: true, force: true });
}

// ------------------------------------------------------------------ 反证轮

if (REFUTE) {
  console.log('\n── 反证轮（改源码 ⇒ 指定断言必须红；跑完按字节还原）──\n');

  const rebuild = () =>
    new Promise((resolve) => {
      const b = spawn(CARGO, ['build', '--bin', 'mangasvc'], { cwd: SRC_TAURI, stdio: 'ignore' });
      b.on('close', (c) => resolve(c === 0));
      b.on('error', () => resolve(false));
    });

  function mutateFile(file, from, to) {
    const original = fs.readFileSync(file);
    const text = original.toString('utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const f = from.replace(/\r?\n/g, eol);
    const t = to.replace(/\r?\n/g, eol);
    if (!text.includes(f)) throw new Error(`反证锚点未命中（写法变了？）：${file}\n  ${from.slice(0, 80)}`);
    fs.writeFileSync(file, Buffer.from(text.replace(f, t), 'utf8'));
    return () => fs.writeFileSync(file, original);
  }

  const runForward = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [SELF], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => {
        out += d;
      });
      c.stderr.on('data', (d) => {
        out += d;
      });
      c.on('error', () => resolve({ code: -1, out }));
      c.on('close', (code) => resolve({ code, out }));
    });

  const hasRed = (out, name) => out.split('\n').some((l) => l.trimStart().startsWith('✗') && l.includes(name));
  const redOn = (out) =>
    out
      .split('\n')
      .filter((l) => l.trimStart().startsWith('✗'))
      .map((l) => l.trim().slice(0, 46));

  const GUARD = 'if disabled || !present {';

  // ---- M1：从不注入（权重在盘也不宣布离线）----
  {
    const restore = mutateFile(ENGINE_RS, GUARD, 'if true {');
    const built = await rebuild();
    const r = await runForward();
    const red = built && r.code !== 0 && hasRed(r.out, 'W1b');
    check('M1 `hf_offline_env` 恒返回空（从不注入）⇒ W1b 红 —— 引擎会去联网重下几个 GB', red, {
      built,
      code: r.code,
      redOn: redOn(r.out),
    });
    restore();
    await rebuild();
  }

  // ---- M2：永远注入（逃生开关失效）----
  {
    const restore = mutateFile(ENGINE_RS, GUARD, 'if !present {');
    const built = await rebuild();
    const r = await runForward();
    const red = built && r.code !== 0 && hasRed(r.out, 'W4');
    check('M2 `hf_offline_env` 忽略逃生开关（永远注入）⇒ W4 红', red, { built, code: r.code, redOn: redOn(r.out) });
    restore();
    await rebuild();
  }

  // ---- M3：`--link` 不再写 HF 的 `refs/main`（"链接建好了、权重还是不被认"）----
  {
    const REFS_LINE = 'let refs_written = write_refs_if_changed(&hf.refs_to, &hf.refs_content)?;';
    const restore = mutateFile(MODEL_STORE_RS, REFS_LINE, 'let refs_written = false;');
    const built = await rebuild();
    const r = await runForward();
    const red = built && r.code !== 0 && hasRed(r.out, 'W2c');
    check('M3 `--link` 不再写 HF 的 `refs/main` ⇒ W2c 红（blob 在、HF 仍然看不见这份权重）', red, {
      built,
      code: r.code,
      redOn: redOn(r.out),
    });
    restore();
    await rebuild();
  }

  // 收尾：确认还原到位（源码逐字节）
  {
    const bad = [];
    if (!fs.readFileSync(ENGINE_RS, 'utf8').includes(GUARD)) bad.push('engine.rs 残留 M1/M2');
    if (!fs.readFileSync(MODEL_STORE_RS, 'utf8').includes('write_refs_if_changed(&hf.refs_to, &hf.refs_content)?;')) {
      bad.push('model_store.rs 残留 M3');
    }
    check('R1 变异收尾：两处源码按字节还原', bad.length === 0, bad);
  }
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
