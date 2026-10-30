#!/usr/bin/env node
/**
 * C2 · 「校验 / 建链脚本随包定位」钉子 —— 「装完之后，收尾动作在包内必须跑得起来」
 * =============================================================================
 * 对应计划文档 C2。⚠️ **这条台账写在 A3d 之前**，那时执行体是 `node fetch-models.mjs`，
 * 「随包」= 把脚本放进资源目录。A3d 把下载器 Rust 化之后，「随包定位」有了**更强的形态**：
 * 执行体就是 `mangasvc` 自己（`std::env::current_exe()`）—— `mangasvc` 本来就随包，于是
 * "包内跑得起来"不再依赖任何资源配置，也不依赖解释器。本脚本钉的就是这件事**真的成立**，
 * 而不是"注释里这么写的"。
 *
 * ## 它钉的是什么
 * ① `download_runner`（= `/engine/models/verify` 与「重新下载模型」用的执行体）默认是
 *    **当前可执行文件自己** —— 用真起服务读 `/engine/status` 的方式验，不看源码注释；
 * ② 该执行体在盘上（`runnerExists`），且 `POST /engine/models/verify` 用它**真的跑得起来**
 *    —— 完成一次真调用并拿回结构化结果（**不是 INTERNAL**）。这正是"装包后不再返回
 *    INTERNAL"那条验收的可复现形态；
 * ③ 执行体**不在盘上**时如实报 INTERNAL 并**带上路径**（不是静默失败）—— 这是 ② 的反面：
 *    没有它，"永远返回 ok" 也能让 ② 绿；
 * ④ `--link` 收尾在夹具上零网络跑通（`linked` 有东西、`cross_device` 为空）；
 * ⑤ **跨卷**：硬链接跨卷 ⇒ 退化为复制，且**单独记账**（`cross_device`），不是笼统一句
 *    "硬链接失败"；跨卷且复制也失败时，错误消息里必须出现「跨卷」。
 *
 * ## 取证接缝
 * · 服务侧：真起一个 `mangasvc`（mock 档）读 `/engine/status` 与 `POST /engine/models/verify`；
 *   清单/模型根走 `MIAO_MODEL_MANIFEST` / `MIAO_MODEL_ROOT`。
 * · 建链：直接跑 `mangasvc --fetch-models --link --manifest <夹具> --root <夹具> --report <p>`。
 * · 跨卷：`MIAO_LINK_FORCE_CROSSDEV=1`（**夹具开关**，真跨卷要两块盘，跑测机器没有）。
 *
 * ## 反证轮（--refute）
 * - M1 把默认执行体改成**仓库相对路径** ⇒ W1 红。这条正是台账 C2 要消灭的那个形态：
 *   在本机能跑（`target/debug/` 就在那儿），装到用户机器上就不存在了。
 * - M2 跨卷判定恒 false ⇒ W5/W6 红（"跨卷"这条分支再也走不到）。
 * - M3 删掉 CLI 里打印跨卷的两处调用 ⇒ W8 红（记账在，但从不告诉用户）。
 * 变异跑完**按字节还原**；M1/M2 还重编译（靶子是另一个进程）。
 *
 * 用法：node e2e/service/model-runner-check.mjs [--refute]
 * 前置：`cd src-tauri && cargo build --bin mangasvc`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { killTree, RUST_BIN, REPO_ROOT } from './_service-harness.mjs';

const REFUTE = process.argv.includes('--refute');
const SELF = fileURLToPath(import.meta.url);
const TOKEN = 'a'.repeat(64);
const STATE_RS = path.join(REPO_ROOT, 'src-tauri', 'src', 'mangasvc', 'engine', 'state.rs');
const MODEL_STORE_RS = path.join(REPO_ROOT, 'src-tauri', 'src', 'mangasvc', 'engine', 'model_store.rs');
const FETCH_MODELS_RS = path.join(REPO_ROOT, 'src-tauri', 'src', 'mangasvc', 'engine', 'fetch_models.rs');
const SRC_TAURI = path.join(REPO_ROOT, 'src-tauri');
const CARGO = process.env.CARGO || 'cargo';

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

/** 两条条目：`a` 就地读、`b` 走 `linkTo`（覆盖两种落点）。**不造真文件** ⇒ 校验很快。 */
const FIX_FILES = [
  {
    id: 'a',
    set: 'visual',
    dest: 'models-store/a.bin',
    sha256: 'a'.repeat(64),
    sizeBytes: 10,
    url: 'https://example.invalid/a',
  },
  {
    id: 'b',
    set: 'visual',
    dest: 'models-store/b.bin',
    linkTo: 'models/b.bin',
    sha256: 'b'.repeat(64),
    sizeBytes: 10,
    url: 'https://example.invalid/b',
  },
];

/** 造一套夹具：清单 + 空模型根。`withStore` 时另造 store 里的权威副本（供 `--link` 用）。 */
function buildFixture({ withStore = false, linkDir = 'models' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-runner-'));
  const manifest = {
    manifestVersion: 1,
    engineCommit: 'deadbeef',
    sets: { visual: { files: ['a', 'b'] } },
    files: JSON.parse(JSON.stringify(FIX_FILES)).map((f) => (f.id === 'b' ? { ...f, linkTo: `${linkDir}/b.bin` } : f)),
  };
  const mp = path.join(root, 'models.manifest.json');
  fs.writeFileSync(mp, JSON.stringify(manifest, null, 2));
  fs.mkdirSync(path.join(root, 'models-store'), { recursive: true });
  if (withStore) {
    fs.writeFileSync(path.join(root, 'models-store', 'a.bin'), Buffer.alloc(10));
    fs.writeFileSync(path.join(root, 'models-store', 'b.bin'), Buffer.alloc(10));
  }
  return { root, mp };
}

/** 异步跑一个子进程（本机 `spawnSync` 稳定 EBUSY ⇒ 一律异步）。 */
function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, {
      env: { ...process.env, ...(opts.env || {}) },
      cwd: opts.cwd || REPO_ROOT,
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

/** 起一个 mangasvc 服务并等 `MIAO_READY`。 */
function startService(extraEnv) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-runner-svc-'));
  const child = spawn(RUST_BIN, [], {
    env: {
      ...process.env,
      MIAO_TOKEN: TOKEN,
      MIAO_MANGA_ROOT_DIR: path.join(tmp, 'library'),
      MIAO_MANGA_STATE_DIR: path.join(tmp, 'state'),
      MIAO_ENGINE_PROTOCOL: 'mock',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => {
      killTree(child);
      reject(new Error('mangasvc 15s 内未就绪'));
    }, 15000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /MIAO_READY (\{.*\})/.exec(buf);
      if (m) {
        clearTimeout(to);
        resolve({ port: JSON.parse(m[1]).port, kill: () => killTree(child) });
      }
    });
    child.stderr.on('data', (d) => (buf += d));
    child.on('close', (code) => {
      clearTimeout(to);
      reject(new Error(`mangasvc 退出 ${code}：${buf.slice(0, 500)}`));
    });
  });
}

const api = (port, p) => `http://127.0.0.1:${port}/api/v1${p}`;
const headers = { 'x-box-token': TOKEN, 'content-type': 'application/json' };

// ------------------------------------------------------------------ W1~W3：真起一次服务
{
  const { root, mp } = buildFixture();
  const svc = await startService({ MIAO_MODEL_MANIFEST: mp, MIAO_MODEL_ROOT: root });
  try {
    const st = await (await fetch(api(svc.port, '/engine/status'), { headers })).json();
    // ⚠️ `modelDownload` 在 `/engine/status` 的**顶层**（不在 `models` 里）：
    //    `models` 报的是"盘上文件在不在"，`modelDownload` 报的是"下载/校验这件**任务**"。
    const dl = st?.modelDownload ?? {};
    // 🔴 判据里必须有 **`path.isAbsolute`**：只比 `path.resolve()` 会被 cwd 掩盖 ——
    //    相对串 `src-tauri/target/debug/mangasvc.exe` 在本仓 cwd 下恰好解析成同一个文件，
    //    「装到用户机器上就不存在」这件事在断言里**看不出来**（M1 变异当初就是这么假绿的）。
    check(
      'W1 默认执行体 == **当前可执行文件自己**，且是绝对路径（相对路径在本机能跑、装完就没了）',
      typeof dl.runner === 'string' && path.isAbsolute(dl.runner) && path.resolve(dl.runner) === path.resolve(RUST_BIN),
      { got: dl.runner, want: RUST_BIN, isAbsolute: typeof dl.runner === 'string' ? path.isAbsolute(dl.runner) : null },
    );
    check('W1b `runnerExists` 为真（默认执行体必然在盘上：它就是正在跑的这个进程）', dl.runnerExists === true, {
      runnerExists: dl.runnerExists,
    });

    const res = await fetch(api(svc.port, '/engine/models/verify'), { method: 'POST', headers, body: '{}' });
    const body = await res.json().catch(() => ({}));
    // 夹具清单的条目都不在盘上 ⇒ 校验"完成、发现缺失"，那是 200 + ok:false，
    // **不是** INTERNAL（INTERNAL 意味着"执行体跑不起来"，两件事必须在出口上分得开）。
    check(
      'W2 `POST /engine/models/verify` 用默认执行体真的跑得起来（200 + 结构化结果，不是 INTERNAL）',
      res.status === 200 && body.ok === false && typeof body.missing === 'number' && body.missing === 2,
      { status: res.status, ok: body.ok, missing: body.missing, exitCode: body.exitCode },
    );
    check(
      'W2b 校验结果如实标出用的是哪份清单（不是"静默用默认那本"）',
      typeof body.manifest === 'string' && path.resolve(body.manifest) === path.resolve(mp),
      { got: body.manifest, want: mp },
    );
  } finally {
    svc.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ W3：执行体不在盘上 ⇒ 如实报 INTERNAL（W2 的反面）
{
  const { root, mp } = buildFixture();
  const ghost = path.join(root, 'no-such-runner.exe');
  const svc = await startService({ MIAO_MODEL_MANIFEST: mp, MIAO_MODEL_ROOT: root, MIAO_MODEL_DOWNLOAD_RUNNER: ghost });
  try {
    const st = await (await fetch(api(svc.port, '/engine/status'), { headers })).json();
    check(
      'W3a 覆盖成一个不存在的执行体 ⇒ `runnerExists` 为假（界面据此把按钮变灰）',
      st?.modelDownload?.runnerExists === false && path.resolve(st.modelDownload.runner) === path.resolve(ghost),
      { runner: st?.modelDownload?.runner, want: ghost },
    );

    const res = await fetch(api(svc.port, '/engine/models/verify'), { method: 'POST', headers, body: '{}' });
    const body = await res.json().catch(() => ({}));
    const text = JSON.stringify(body);
    check(
      'W3b 执行体不在盘上 ⇒ INTERNAL 且消息带路径（不是静默成功、也不是一句"失败"）',
      res.status === 500 && /INTERNAL/.test(text) && text.includes('no-such-runner.exe'),
      { status: res.status, body: text.slice(0, 200) },
    );
  } finally {
    svc.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ W4~W6：`--link` 收尾（零网络）
{
  const { root, mp } = buildFixture({ withStore: true });
  const report = path.join(root, 'report.json');
  const r = await runAsync(
    RUST_BIN,
    ['--fetch-models', '--link', '--manifest', mp, '--root', root, '--report', report],
    {},
  );
  const body = JSON.parse(fs.readFileSync(report, 'utf8'));
  const link = body.link ?? {};
  check(
    'W4 `--link` 收尾零网络跑通：该条目标为 `linked`，且**没有任何**跨卷降级',
    r.code === 0 && (link.linked ?? []).includes('b') && (link.cross_device ?? []).length === 0,
    { code: r.code, linked: link.linked, cross: link.cross_device, stderr: r.err.slice(0, 120) },
  );
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const { root, mp } = buildFixture({ withStore: true });
  const report = path.join(root, 'report.json');
  const r = await runAsync(
    RUST_BIN,
    ['--fetch-models', '--link', '--manifest', mp, '--root', root, '--report', report],
    {
      env: { MIAO_LINK_FORCE_CROSSDEV: '1' },
    },
  );
  const link = JSON.parse(fs.readFileSync(report, 'utf8')).link ?? {};
  check(
    'W5 跨卷 ⇒ 退化为复制，且**单独记账**在 `cross_device`（不是只写一行日志）',
    r.code === 0 &&
      (link.copied ?? []).includes('b') &&
      (link.linked ?? []).length === 0 &&
      (link.cross_device ?? []).includes('b'),
    { code: r.code, copied: link.copied, linked: link.linked, cross: link.cross_device },
  );
  check('W5b 跨卷时 CLI 把这件事**说出来**（用户按"几个 GB"留的盘会不够，得让他知道）', /跨卷/.test(r.out), {
    out: r.out.slice(0, 200),
  });
  fs.rmSync(root, { recursive: true, force: true });
}

{
  // 跨卷 **且** 复制也失败：把 linkTo 的父目录位置先占成一个**文件** ⇒ `create_dir_all` 失败
  // ⇒ `fs::copy` 失败。此时错误消息必须说"跨卷"，而不是笼统一句"链接失败"。
  const { root, mp } = buildFixture({ withStore: true, linkDir: 'models2' });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'models2'), 'occupied'); // 本应是目录，先占成文件
  const r = await runAsync(RUST_BIN, ['--fetch-models', '--link', '--manifest', mp, '--root', root], {
    env: { MIAO_LINK_FORCE_CROSSDEV: '1' },
  });
  check(
    'W6 跨卷且复制也失败 ⇒ 错误消息里出现「跨卷」（不是笼统的"硬链接失败"）',
    r.code === 1 && /跨卷/.test(r.err) && /复制也失败/.test(r.err),
    { code: r.code, err: r.err.slice(0, 200) },
  );
  fs.rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------------------------ W7~W8：源码钉
{
  const st = fs.readFileSync(STATE_RS, 'utf8');
  check(
    'W7 `state.rs` 的默认执行体是 `current_exe()`（随包定位的唯一正确推导）',
    /None => std::env::current_exe\(\)/.test(st),
    null,
  );

  const fm = fs.readFileSync(FETCH_MODELS_RS, 'utf8');
  const calls = (fm.match(/print_cross_device\(&l\);/g) || []).length;
  check(
    'W8 CLI 的两条链接路径（`--link` 与下载后的自动建链）都会把跨卷说出来',
    calls === 2 && /fn print_cross_device/.test(fm),
    { calls },
  );
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

  function mutateFile(file, from, to, { all = false } = {}) {
    const original = fs.readFileSync(file);
    const text = original.toString('utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const f = from.replace(/\r?\n/g, eol);
    const t = to.replace(/\r?\n/g, eol);
    if (!text.includes(f)) throw new Error(`反证锚点未命中（写法变了？）：${file}\n  ${from.slice(0, 80)}`);
    fs.writeFileSync(file, Buffer.from(all ? text.split(f).join(t) : text.replace(f, t), 'utf8'));
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

  // ---- M1：默认执行体退回**仓库相对路径**（台账 C2 要消灭的那个形态）----
  {
    const restore = mutateFile(
      STATE_RS,
      'None => std::env::current_exe().unwrap_or_else(|_| PathBuf::from("mangasvc")),',
      'None => PathBuf::from("src-tauri/target/debug/mangasvc.exe"),',
    );
    const built = await rebuild();
    const r = await runForward();
    // 判据是 W1 的**绝对性**那半句：相对串在"cwd 恰好是仓库根"的跑测环境里能解析到同一个
    // 文件，只有"必须绝对"这条能在本机把它抓出来（也正是装到用户机器后会断的那一点）。
    const red = built && r.code !== 0 && hasRed(r.out, 'W1');
    check('M1 默认执行体改成仓库相对路径 ⇒ W1 红（本机能跑、装完就没）', red, {
      built,
      code: r.code,
      redOn: redOn(r.out),
    });
    restore();
    await rebuild();
  }

  // ---- M2：跨卷判定恒 false ----
  {
    const restore = mutateFile(MODEL_STORE_RS, 'e.raw_os_error() == Some(17)', 'false');
    const built = await rebuild();
    const r = await runForward();
    const red = built && r.code !== 0 && hasRed(r.out, 'W5') && hasRed(r.out, 'W6');
    check('M2 跨卷判定恒 false ⇒ W5/W6 红（"跨卷"这条分支再也走不到）', red, {
      built,
      code: r.code,
      redOn: redOn(r.out),
    });
    restore();
    await rebuild();
  }

  // ---- M3：CLI 不再打印跨卷 ----
  {
    const restore = mutateFile(FETCH_MODELS_RS, 'print_cross_device(&l);', '', { all: true });
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W8');
    check('M3 删掉 CLI 里打印跨卷的两处调用 ⇒ W8 红（记账在，但从不告诉用户）', red, {
      code: r.code,
      redOn: redOn(r.out),
    });
    restore();
  }

  // 收尾：源码逐字节还原
  {
    const bad = [];
    if (
      !fs
        .readFileSync(STATE_RS, 'utf8')
        .includes('None => std::env::current_exe().unwrap_or_else(|_| PathBuf::from("mangasvc")),')
    )
      bad.push('state.rs 残留 M1');
    if (!fs.readFileSync(MODEL_STORE_RS, 'utf8').includes('e.raw_os_error() == Some(17)'))
      bad.push('model_store.rs 残留 M2');
    const fm = fs.readFileSync(FETCH_MODELS_RS, 'utf8');
    if ((fm.match(/print_cross_device\(&l\);/g) || []).length !== 2) bad.push('fetch_models.rs 残留 M3');
    check('R1 变异收尾：三处源码按字节还原', bad.length === 0, bad);
  }
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
