#!/usr/bin/env node
/**
 * C3 · 「`llama-server` 按平台分化」钉子 —— 「别在 Windows 上引导用户下 macOS 的包」
 * =============================================================================
 * 对应计划文档 C3：引导清单（D8）与校验收尾（C2）必须共用**同一个** `selectFiles`，
 * 不许各自过滤一遍。
 *
 * ## 为什么这条在 C3 里单独立钉子
 * `check:models-guide` 的 W3 已经钉了「引导清单的 `applicable` 与**下载器**同判据」——
 * 但那一条是**同一次运行内部**的自洽（同一个进程里两个调用点）。它抓不到的是：
 * 下载器**真的按平台挑**了吗？`--set runtime` 在 Windows 上会不会把 mac 的 llama.cpp
 * 一起挑走？（Rust 侧 `select_files()` 的 `set` 分支与 `ids` 分支行为**刻意不同**：
 * 点名 id 不过滤、按 set 过滤 —— 只测一边等于没测。）
 *
 * ## 验收①怎么在一台机器上验完
 * 「Windows 上只引导 win32-x64 条目」这句话的另一半是「darwin-arm64 下只引导 mac 条目」，
 * 本机只跑得了其中一半。产品侧为此留了**取证接缝** `MIAO_PLATFORM`（`model_store::platform_key`），
 * 于是两个镜像都能在同一台机器上跑 —— 判据与安装引导那套「同源镜像表」是同一个思路：
 * 镜像表自身由**当前平台那条真断言**钉住，两边不会一起走散。
 *
 * ## 它钉的是什么
 * ① 带 `platform` 的条目，其 `applicable` **恰好**等于「`platform` == 假装的平台」；
 * ② 两个平台下「适用集合」互补：带 `platform` 的条目被两边**恰好分完**（并集 = 全部、交集 = 空）；
 * ③ 无 `platform` 的条目（平台无关）在两侧都适用 —— 平台过滤不许误伤它；
 * ④ **引导清单 ⟷ 下载器选择**同判据：`--fetch-models --set runtime --check` 实际挑中的 id 集合
 *    == 引导清单里「`set == runtime` 且 `applicable`」的 id 集合（两个平台各验一次）——
 *    这条才是 C3 那句「共用同一个 `selectFiles`」的**可反证形态**；
 * ⑤ runtime 档在 Windows 下非空且**不含任何 darwin-arm64 条目**：清单非空是必须的
 *    （空清单会让用户以为不用装 llama.cpp），但内容不许串平台。
 *
 * ## 反证轮（--refute）
 * - M1 `platform_matches` 恒 true（关掉平台过滤）⇒ W1/W2 红。
 * - M2 引导侧另写一份判据（`model_status.rs` 的 `applicable` 恒 true）⇒ W1 红
 *      （引导把 mac 条目也说成"你要下"）。
 * - M3 下载器的 `set` 分支丢掉平台过滤 ⇒ W4 红（下载器多挑，而引导清单没有）。
 *   🔴 M1/M2/M3 是**三种不同的失效**：全局关掉、只有引导退化、只有下载器退化。
 *      只留一条的话，「两处各写一遍」这个 C3 真正要防的形态会漏掉。
 *
 * 用法：node e2e/service/platform-guide-check.mjs [--refute]
 * 前置：`cd app/src-tauri && cargo build --bin boxsvc`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUST_BIN, REPO_ROOT } from './_service-harness.mjs';

const REFUTE = process.argv.includes('--refute');
/** 本脚本自身（反证轮要重跑一次不含 `--refute` 的它）。
 *  用 `fileURLToPath` 而不是 `.pathname` —— Windows 上后者会给出 `/F:/...`，spawn 起不来。 */
const SELF = fileURLToPath(import.meta.url);
const MANIFEST = path.join(REPO_ROOT, 'engine', 'models.manifest.json');
const MODEL_STORE_RS = path.join(REPO_ROOT, 'app', 'src-tauri', 'src', 'boxsvc', 'engine', 'model_store.rs');
const MODEL_STATUS_RS = path.join(REPO_ROOT, 'app', 'src-tauri', 'src', 'boxsvc', 'engine', 'model_status.rs');
const SRC_TAURI = path.join(REPO_ROOT, 'app', 'src-tauri');
/** `cargo` 可执行：`CARGO` env 覆盖，否则交给 PATH。 */
const CARGO = process.env.CARGO || 'cargo';

/** 取证用的两个假平台 —— 清单里 `platform` 字段只出现过这两个取值。 */
const WIN = 'win32-x64';
const MAC = 'darwin-arm64';

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

// ------------------------------------------------------------------ 取证入口

/** 跑一条 `boxsvc` 子命令，返回 { code, out, err }。 */
function boxsvc(argv, extraEnv) {
  return new Promise((resolve, reject) => {
    const c = spawn(RUST_BIN, argv, {
      env: { ...process.env, ...extraEnv },
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
    c.on('error', reject);
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

/** 引导清单（`--engine-model-files` 打印整个 `ModelStatus`）。 */
async function guideFor(platform, manifest = MANIFEST) {
  const r = await boxsvc(['--engine-model-files'], {
    MIAO_PLATFORM: platform,
    MIAO_MODEL_MANIFEST: manifest,
    // 空模型根 ⇒ 逐条必然未就绪；本脚本只关心"适用性"，不关心"装了没"。
    MIAO_MODEL_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'miao-plat-root-')),
  });
  if (r.code !== 0) throw new Error(`--engine-model-files 退出 ${r.code}：${r.err.slice(0, 400)}`);
  return JSON.parse(r.out);
}

/**
 * **下载器**在给定平台、给定档位下实际挑中的 id 集合。
 *
 * 走 `--check --report`：结果落盘成 JSON（比解析 stdout 文本可靠），
 * 选中集合 = `ok` ∪ `bad` ∪ `missing` 三份的 id —— 空模型根下它们全落在 `missing` 里，
 * 但三份都取才不依赖"这台机器上刚好装了什么"。
 */
async function downloaderPick(platform, set, manifest = MANIFEST) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-plat-pick-'));
  const report = path.join(root, 'report.json');
  // `--check` 在缺文件时**按设计**返回 1（"盘上不全"不是脚本出错）⇒ 这里只看 report。
  await boxsvc(
    ['--fetch-models', '--check', '--manifest', manifest, '--root', root, '--report', report, '--set', set],
    { MIAO_PLATFORM: platform },
  );
  const body = JSON.parse(fs.readFileSync(report, 'utf8'));
  const v = body.verify ?? {};
  const ids = new Set([...(v.ok ?? []), ...(v.bad ?? []).map((b) => b.id), ...(v.missing ?? [])]);
  fs.rmSync(root, { recursive: true, force: true });
  return ids;
}

if (!fs.existsSync(RUST_BIN)) {
  console.error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd app/src-tauri && cargo build --bin boxsvc`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const withPlatform = manifest.files.filter((f) => f.platform);
const noPlatform = manifest.files.filter((f) => !f.platform);
const idsOf = (arr) => arr.map((f) => f.id);
const sorted = (xs) => [...xs].sort();

if (withPlatform.length === 0) {
  console.error('真清单里没有任何带 `platform` 的条目 ⇒ 本脚本的判据没有作用对象（清单被改坏了？）');
  process.exit(1);
}

// ------------------------------------------------------------------ W1/W2：两侧镜像
//
// 判据**不是**"硬编码一份期望 id 列表"（那就成了两边各写一个常量，D-178 明令禁止），
// 而是"从清单里那条 `platform` 字段现算"：`applicable === (platform === 假装的平台)`。

const guideWin = await guideFor(WIN);
const guideMac = await guideFor(MAC);
const byWin = Object.fromEntries((guideWin.files ?? []).map((f) => [f.id, f]));
const byMac = Object.fromEntries((guideMac.files ?? []).map((f) => [f.id, f]));

{
  const badWin = withPlatform.filter((f) => (byWin[f.id]?.applicable ?? null) !== (f.platform === WIN));
  check(`W1 ${WIN} 下：带 platform 的条目逐条 applicable == (platform === "${WIN}")`, badWin.length === 0, {
    bad: badWin.map((f) => `${f.id}(${f.platform})`),
    got: withPlatform.map((f) => `${f.id}=${byWin[f.id]?.applicable}`),
  });

  // 点名：Windows 上不许把 mac 的 llama.cpp 说成"你要下"。
  const macLlama = withPlatform.filter((f) => f.platform === MAC);
  const leaked = macLlama.filter((f) => byWin[f.id]?.applicable !== false);
  check(
    `W1b ${WIN} 下：${MAC} 的条目（llama.cpp 等 ${macLlama.length} 条）一律 applicable=false —— 别在 Windows 上引导用户下 mac 的包`,
    macLlama.length > 0 && leaked.length === 0,
    { leaked: leaked.map((f) => f.id) },
  );

  const badMac = withPlatform.filter((f) => (byMac[f.id]?.applicable ?? null) !== (f.platform === MAC));
  check(`W2 ${MAC} 下（镜像）：带 platform 的条目逐条 applicable == (platform === "${MAC}")`, badMac.length === 0, {
    bad: badMac.map((f) => f.id),
  });

  const winEntries = withPlatform.filter((f) => f.platform === WIN);
  const leakedMac = winEntries.filter((f) => byMac[f.id]?.applicable !== false);
  check(
    `W2b ${MAC} 下（镜像）：${WIN} 的条目（${winEntries.length} 条）一律 applicable=false`,
    winEntries.length > 0 && leakedMac.length === 0,
    { leaked: leakedMac.map((f) => f.id) },
  );

  // 互补性：带 platform 的条目被两个平台**恰好分完** —— 不多（漏一条 = 用户少下一块）、不少。
  const winSet = new Set(withPlatform.filter((f) => byWin[f.id]?.applicable).map((f) => f.id));
  const macSet = new Set(withPlatform.filter((f) => byMac[f.id]?.applicable).map((f) => f.id));
  const unionSize = new Set([...winSet, ...macSet]).size;
  const overlap = [...winSet].filter((id) => macSet.has(id));
  check(
    'W2c 两个平台的适用集合互补：并集 == 全部带 platform 的条目、交集为空',
    unionSize === withPlatform.length && overlap.length === 0,
    { unionSize, total: withPlatform.length, overlap },
  );
}

// ------------------------------------------------------------------ W3：平台无关条目两侧都适用

{
  const missWin = noPlatform.filter((f) => byWin[f.id]?.applicable !== true);
  const missMac = noPlatform.filter((f) => byMac[f.id]?.applicable !== true);
  check(
    'W3 无 platform 的条目（平台无关）在两侧都 applicable=true —— 平台过滤不许误伤它',
    noPlatform.length > 0 && missWin.length === 0 && missMac.length === 0,
    { win: missWin.map((f) => f.id), mac: missMac.map((f) => f.id) },
  );
}

// ------------------------------------------------------------------ W4：引导清单 ⟷ 下载器同判据
//
// 🔴 这是 C3 那句「共用同一个 selectFiles」的**可反证形态**：两侧各算一遍，
//    任何一侧单独退化（多挑/少挑）都会当场不一致。

{
  for (const [platform, guide] of [
    [WIN, guideWin],
    [MAC, guideMac],
  ]) {
    const picked = await downloaderPick(platform, 'runtime');
    const want = sorted((guide.files ?? []).filter((f) => f.set === 'runtime' && f.applicable).map((f) => f.id));
    const got = sorted(picked);
    check(
      `W4 ${platform} 下：下载器 \`--set runtime\` 挑中的 id 集合 == 引导清单里 set=runtime 且 applicable 的 id 集合`,
      got.length > 0 && got.join(',') === want.join(','),
      { got, want },
    );
  }
}

// ------------------------------------------------------------------ W5：runtime 档非空且不串平台

{
  // ⚠️ `--engine-model-files` 吐的是**全量**清单（每条带 `applicable`），界面才按它过滤
  //    —— 所以"引导清单"= `applicable` 的那些，判据必须落在这一子集上。
  //    （把它写成"全量里不含 mac 条目"会立刻假红：全量**本来就**含，只是标了不适用。）
  const winRuntime = (guideWin.files ?? []).filter((f) => f.set === 'runtime' && f.applicable);
  const macOnly = winRuntime.filter((f) => f.platform === MAC);
  const unknown = winRuntime.filter((f) => f.platform && f.platform !== WIN);
  check(
    `W5 ${WIN} 下**面向用户的** runtime 档非空、且不含任何非 ${WIN} 的条目（空清单会让用户以为不用装 llama.cpp）`,
    winRuntime.length > 0 && macOnly.length === 0 && unknown.length === 0,
    {
      visible: winRuntime.map((f) => `${f.id}(${f.platform ?? '无关'})`),
      macOnly: macOnly.map((f) => f.id),
      unknown: unknown.map((f) => f.id),
    },
  );

  // 至少有一条 llama.cpp 条目在本平台适用（llama-server 正是 runtime 档里那个二进制）。
  const llamaOk = winRuntime.filter((f) => /llama/.test(f.id));
  check(`W5b ${WIN} 下至少有一条 llama 条目可见（llama-server 是 runtime 档里的关键二进制）`, llamaOk.length > 0, {
    visible: winRuntime.map((f) => f.id),
  });

  // 镜像侧同样成立 —— 否则"非空"可能是靠"两边都空"以外的巧合满足的。
  const macRuntime = (guideMac.files ?? []).filter((f) => f.set === 'runtime' && f.applicable);
  check(
    `W5c ${MAC} 下（镜像）可见的 runtime 档同样非空、且不含 ${WIN} 条目`,
    macRuntime.length > 0 && macRuntime.every((f) => f.platform !== WIN),
    { visible: macRuntime.map((f) => `${f.id}(${f.platform ?? '无关'})`) },
  );
}

// ------------------------------------------------------------------ W6：接缝本身透明（取证边界）

{
  check(
    'W6 `guidance.platform` 跟随取证接缝 —— 报告里说得出"这次是假装成谁跑出来的"',
    guideWin.guidance?.platform === WIN && guideMac.guidance?.platform === MAC,
    { win: guideWin.guidance?.platform, mac: guideMac.guidance?.platform },
  );
}

// ------------------------------------------------------------------ 反证轮

if (REFUTE) {
  console.log('\n── 反证轮（改源码 ⇒ 指定断言必须红；跑完按字节还原）──\n');

  const rebuild = () =>
    new Promise((resolve) => {
      const b = spawn(CARGO, ['build', '--bin', 'boxsvc'], { cwd: SRC_TAURI, stdio: 'ignore' });
      b.on('close', (c) => resolve(c === 0));
      b.on('error', () => resolve(false));
    });

  /**
   * 改文件里的一处文本（返回还原函数）。
   * 锚点里的 `\n` 按**文件实际 EOL** 展开：源文件是 CRLF，锚点写死 LF 会永远匹配不上
   * —— 那会让"变异失败"被误读成"断言没红"。
   */
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

  // ---- M1：全局关掉平台过滤（判据本身恒 true）----
  {
    const restore = mutateFile(
      MODEL_STORE_RS,
      'pub fn platform_matches(platform: Option<&str>, key: &str) -> bool {\n    match platform {\n        None => true,\n        Some(p) => p == key,\n    }\n}',
      'pub fn platform_matches(platform: Option<&str>, key: &str) -> bool {\n    let _ = (platform, key);\n    true\n}',
    );
    const built = await rebuild();
    const r = await runForward();
    const red = built && r.code !== 0 && hasRed(r.out, 'W1') && hasRed(r.out, 'W2');
    check('M1 平台判据恒 true（关掉过滤）⇒ W1/W2 红', red, { built, code: r.code, redOn: redOn(r.out) });
    restore();
    await rebuild();
  }

  // ---- M2：只有**引导侧**退化（另写一份判据）----
  {
    const restore = mutateFile(
      MODEL_STATUS_RS,
      'applicable: super::model_store::platform_matches(platform.as_deref(), &key),',
      'applicable: { let _ = (&platform, &key); true },',
    );
    const built = await rebuild();
    const r = await runForward();
    // 引导把 mac 条目也说成"你要下" ⇒ W1/W1b 红；同时 W4 失配（引导多出条目）⇒ 也红
    const red = built && r.code !== 0 && hasRed(r.out, 'W1') && hasRed(r.out, 'W4');
    check('M2 引导侧另写一份判据（applicable 恒 true）⇒ W1/W4 红（引导与下载器不同答案）', red, {
      built,
      code: r.code,
      redOn: redOn(r.out),
    });
    restore();
    await rebuild();
  }

  // ---- M3：只有**下载器**退化（set 分支丢掉平台过滤）----
  {
    const restore = mutateFile(
      MODEL_STORE_RS,
      '.filter(|f| want.iter().any(|w| **w == f.id) && matches_platform(f, &key))',
      '.filter(|f| want.iter().any(|w| **w == f.id))',
    );
    const built = await rebuild();
    const r = await runForward();
    const red = built && r.code !== 0 && hasRed(r.out, 'W4');
    check('M3 下载器 set 分支丢掉平台过滤 ⇒ W4 红（下载器多挑、引导清单没有）', red, {
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
    if (!fs.readFileSync(MODEL_STORE_RS, 'utf8').includes('Some(p) => p == key,')) bad.push('model_store.rs 残留 M1');
    if (!fs.readFileSync(MODEL_STORE_RS, 'utf8').includes('&& matches_platform(f, &key))'))
      bad.push('model_store.rs 残留 M3');
    if (
      !fs
        .readFileSync(MODEL_STATUS_RS, 'utf8')
        .includes('applicable: super::model_store::platform_matches(platform.as_deref(), &key),')
    ) {
      bad.push('model_status.rs 残留 M2');
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
