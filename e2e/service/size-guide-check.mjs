#!/usr/bin/env node
/**
 * C1 · 「体积与落点如实告知」钉子 —— 「装之前先说清楚要留多少盘」
 * =============================================================================
 * 对应计划文档 C1：13 GB 由用户自己下 ⇒ 下手前必须说清。
 * 引导页按**平台 + 档位**展示体积与落点；数字**从清单 `sizeBytes` 求和**，不许自估。
 *
 * ## 它钉的是什么
 * ① **总量** = 当前平台可见条目的 `sizeBytes` 之和（逐字节可复算，与 D1 的 `requiredBytes`
 *    必须是同一个数 —— 同一个量在两处显示、数字不同，是最坏的界面形态）；
 * ② **分档位**（`visual` / `translation` / `llm` / `runtime`）之和恒等于总量：
 *    分档回答的是"我只要视觉那部分是多少"，漏掉一档就是让用户少下一块；
 * ③ **平台过滤**：另一平台那条的体积不许混进来（Windows 用户不为 mac 的 llama.cpp 留盘）；
 * ④ **三方闭环**：文档（`docs/install-guide-*.md` 的体积标记）⟷ 服务端（`guidance.totalBytes`）
 *    ⟷ 清单求和 —— 同一份清单算出来必须是同一个数；
 * ⑤ 界面真的把服务端那几个数字渲染出来了（**不是**在 JSX 里另写一份）；
 * ⑥ 边角不丢：清单里登记过的**表外档位**、以及**不属于任何 set** 的条目，都必须出现在表里
 *    （分别进自己的档位与 `unassigned`），绝不允许从分档表里消失。
 *
 * ## 为什么必须有一条"改夹具清单"的变异（D-178 的纪律）
 * 「界面说 6.9 GB」「清单里是 7445962918 字节」这类事实，如果两边各写死一份常量，
 * 上面所有断言照样全绿。所以本脚本自带一条自证变异：把夹具清单一条 `sizeBytes` 改掉，
 * `totalBytes` 与对应档位**必须跟着变**。产品侧若把数字写死，那条当场红。
 *
 * ## 取证入口：`boxsvc --engine-model-files`
 * 打印 `ModelStatus` 的 JSON（C1 起含 `guidance`）。清单与模型根走 `paths` 的接缝
 * （`MIAO_MODEL_MANIFEST` / `MIAO_MODEL_ROOT`），夹具搬进临时目录跑，不碰真资产。
 *
 * ## 反证轮（--refute）
 * - M1 `total_bytes` 写成常量 ⇒ W1 红（"如实告知"退化成"编一个数"）。
 * - M2 分档表只留第一档 ⇒ W2 红（分档之和不再等于总量）。
 * - M3 删掉 `EngineDiag.tsx` 的引导区块 ⇒ W7 红（服务端算好了，界面没接上）。
 * 三个变异跑完都**按字节还原**，M1/M2 还要重编译（靶子是另一个进程）。
 *
 * 用法：node e2e/service/size-guide-check.mjs [--refute]
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
/** 本脚本自身（反证轮要重跑一次不含 `--refute` 的它）。 */
const SELF = fileURLToPath(import.meta.url);
const MANIFEST = path.join(REPO_ROOT, 'engine', 'models.manifest.json');
const MODEL_STATUS_RS = path.join(REPO_ROOT, 'app', 'src-tauri', 'src', 'boxsvc', 'engine', 'model_status.rs');
const ENGINE_DIAG = path.join(REPO_ROOT, 'app', 'src', 'screens', 'settings', 'EngineDiag.tsx');
const ENGINE_API = path.join(REPO_ROOT, 'app', 'src', 'screens', 'settings', 'engine-api.ts');
const SRC_TAURI = path.join(REPO_ROOT, 'app', 'src-tauri');
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

// ------------------------------------------------------------------ 取证入口

/** 跑一次 `boxsvc --engine-model-files`，返回解析后的 JSON。 */
async function modelFiles(extraEnv) {
  const r = await new Promise((resolve, reject) => {
    const c = spawn(RUST_BIN, ['--engine-model-files'], {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', reject);
    c.on('close', (code) => resolve({ code, out, err }));
  });
  if (r.code !== 0) throw new Error(`--engine-model-files 退出 ${r.code}：${r.stderr.slice(0, 400)}`);
  return JSON.parse(r.out);
}

// ------------------------------------------------------------------ Node 侧独立算期望
//
// ⚠️ 「两边各写死同一个常量」不算对拍（D-178）。这里 Node 侧**从清单文件**独立求和 ——
//    与产品同源于清单、但各算一遍；W6 的变异证明产品真的在算，而不是在读一个常量。

/** 平台标识 —— 与清单 `platform` 字段的对齐口径（不 import 产品代码）。 */
const platformKey = () => `${process.platform}-${process.arch}`;
/** 该条目是否适用当前平台（无 `platform` = 平台无关）。 */
const applicableOf = (f) => !f.platform || f.platform === platformKey();
/** 当前平台可见条目的字节和（缺 `sizeBytes` 的按 0 计）。 */
const sumOf = (files) => files.filter(applicableOf).reduce((a, f) => a + (f.sizeBytes || 0), 0);

/** 读一份清单并落到临时目录（改动只影响副本）。 */
function copyManifest(dir, manifest) {
  const p = path.join(dir, 'models.manifest.json');
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
  return p;
}

/** 文档里的体积标记：`<!-- install-guide:size platform=<tag> bytes=<n> -->`。 */
function docSizeOf(file, platform) {
  const text = fs.readFileSync(file, 'utf8');
  const m = new RegExp(`install-guide:size\\s+platform=${platform.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+bytes=(\\d+)`).exec(text);
  return m ? Number(m[1]) : null;
}

if (!fs.existsSync(RUST_BIN)) {
  console.error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd app/src-tauri && cargo build --bin boxsvc`);
  process.exit(1);
}

// ------------------------------------------------------------------ W1~W4：真清单（空模型根）
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-size-real-'));
  const body = await modelFiles({ MIAO_MODEL_MANIFEST: MANIFEST, MIAO_MODEL_ROOT: root });
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const g = body.guidance ?? {};
  const wantBytes = sumOf(m.files);
  const wantEntries = m.files.filter(applicableOf).length;

  check('W1 真清单：`guidance.totalBytes` == 本平台可见条目 `sizeBytes` 之和（逐字节）',
    g.totalBytes === wantBytes, { got: g.totalBytes, want: wantBytes });

  check('W1b 真清单：`guidance.entries` == 本平台可见条目数',
    g.entries === wantEntries, { got: g.entries, want: wantEntries });

  const setBytes = (g.sets ?? []).reduce((a, s) => a + s.bytes, 0);
  const setEntries = (g.sets ?? []).reduce((a, s) => a + s.entries, 0);
  check('W2 真清单：分档位体积求和 == 总量（有条目掉出分档表就红在这里）',
    setBytes === g.totalBytes, { setBytes, totalBytes: g.totalBytes, sets: (g.sets ?? []).map((s) => s.id) });
  check('W2b 真清单：分档位条数求和 == 总条数', setEntries === g.entries, { setEntries, entries: g.entries });

  check('W3 真清单：`guidance.platform` == 本机平台标识',
    g.platform === platformKey(), { got: g.platform, want: platformKey() });

  // W4：三方闭环 —— 文档标记 ⟷ 服务端 ⟷ 清单求和。
  // 文档那一份由 `check:install-guide` 钉在清单上；这里钉的是"服务端那一份"与它们同值。
  const guide = path.join(REPO_ROOT, 'docs', platformKey() === 'darwin-arm64' ? 'install-guide-macos.md' : 'install-guide-windows.md');
  const doc = fs.existsSync(guide) ? docSizeOf(guide, platformKey()) : null;
  check('W4 三方闭环：安装引导文档的体积标记 == `guidance.totalBytes` == 清单求和',
    doc === null || (doc === g.totalBytes && doc === wantBytes),
    { doc, totalBytes: g.totalBytes, manifestSum: wantBytes, guide: path.basename(guide) });

  fs.rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------------------------ W5：夹具（边角不丢）
//
// 真清单里每个条目都恰好属于一个 set，所以"分档不重不漏"在真清单上体现不出边角。
// 夹具补两种边角：**登记过的表外档位**（`audio`）与**不属于任何 set** 的条目。
const FIX = {
  files: [
    { id: 'a', set: 'visual', dest: 'models-store/a.bin', sizeBytes: 3, url: 'https://example.invalid/a' },
    { id: 'b', set: 'visual', dest: 'models-store/b.bin', linkTo: 'models/b.bin', sizeBytes: 4 },
    { id: 'c', set: 'runtime', dest: 'bin/c.exe', platform: 'win32-x64', sizeBytes: 5 },
    { id: 'd', set: 'runtime', dest: 'bin/d', platform: 'darwin-arm64', sizeBytes: 6 },
    { id: 'e', set: 'audio', dest: 'models-store/e.bin', sizeBytes: 7 },
    { id: 'f', dest: 'models-store/f.bin', sizeBytes: 8 },
  ],
  sets: { visual: { files: ['a', 'b'] }, runtime: { files: ['c', 'd'] }, audio: { files: ['e'] } },
};

function buildFixture(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-size-small-'));
  const manifest = JSON.parse(JSON.stringify(FIX));
  if (mutate) mutate(manifest);
  const mp = copyManifest(root, manifest);
  fs.mkdirSync(path.join(root, 'models-store'), { recursive: true });
  return { root, mp, manifest };
}

{
  const { root, mp, manifest } = buildFixture();
  const body = await modelFiles({ MIAO_MODEL_MANIFEST: mp, MIAO_MODEL_ROOT: root });
  const g = body.guidance ?? {};
  const ids = (g.sets ?? []).map((s) => s.id);

  check('W5 夹具：分档求和 == 总量（含表外档位与无 set 条目）',
    (g.sets ?? []).reduce((a, s) => a + s.bytes, 0) === g.totalBytes && g.totalBytes === sumOf(manifest.files),
    { sets: ids, totalBytes: g.totalBytes, want: sumOf(manifest.files) });

  check('W5b 夹具：清单登记过的表外档位（audio）出现在表里，且排在已知档位之后',
    ids.includes('audio') && ids.indexOf('visual') < ids.indexOf('audio'), { ids });

  check('W5c 夹具：不属于任何 set 的条目归入 `unassigned`，不许消失',
    ids.includes('unassigned') && (g.sets ?? []).find((s) => s.id === 'unassigned')?.bytes === 8, { ids });

  check('W5d 夹具：空档位不显示（清单里没有 llm 条目 ⇒ 表里没有 llm）',
    !ids.includes('llm'), { ids });

  // 平台过滤：另一平台那条（d，6 字节）不许计入
  const myBytes = manifest.files.filter(applicableOf).reduce((a, f) => a + f.sizeBytes, 0);
  const allBytes = manifest.files.reduce((a, f) => a + f.sizeBytes, 0);
  check('W5e 夹具：总量只含本平台可见条目（另一平台那条的体积不混进来）',
    g.totalBytes === myBytes && (myBytes === allBytes || g.totalBytes < allBytes),
    { totalBytes: g.totalBytes, mine: myBytes, all: allBytes });

  fs.rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------------------------ W6：改夹具清单 ⇒ 数字必须跟着变
//
// 🔴 C1 验收②。若产品把体积写成常量，改了副本也不会变 ⇒ 红。
{
  const { root, mp, manifest } = buildFixture((m) => { m.files[0].sizeBytes += 1000; });
  const body = await modelFiles({ MIAO_MODEL_MANIFEST: mp, MIAO_MODEL_ROOT: root });
  const g = body.guidance ?? {};
  const want = sumOf(manifest.files);
  const visual = (g.sets ?? []).find((s) => s.id === 'visual');
  check('W6 改夹具一条 `sizeBytes` ⇒ 总量与对应档位跟着变（证明是算的，不是写死的）',
    g.totalBytes === want && visual?.bytes === 3 + 1000 + 4,
    { totalBytes: g.totalBytes, want, visual: visual?.bytes });
  fs.rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------------------------ W7~W8：前端真的接上了
{
  const diag = fs.readFileSync(ENGINE_DIAG, 'utf8');
  const api = fs.readFileSync(ENGINE_API, 'utf8');

  check('W7 前端：诊断视图把 `guidance` 交给引导区块（服务端算好了，界面得接上）',
    /<ModelGuide\s+guidance=\{s\?\.models\?\.guidance\}/.test(diag) && diag.includes('guidance.totalBytes'),
    { wired: /<ModelGuide\s+guidance=\{s\?\.models\?\.guidance\}/.test(diag), usesServer: diag.includes('guidance.totalBytes') });

  // 代码里不许出现写死的 GB 数字（注释里的举例不算 —— 那是说明不是值）
  const code = diag.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const gbLiteral = /(?<![\w.$])\d+(\.\d+)?\s*GB/.test(code);
  check('W7b 前端：代码里没有写死的 GB 数字（体积只做单位换算）', !gbLiteral, { gbLiteral });

  const need = ['platform', 'entries', 'totalBytes', 'sets'];
  const missing = need.filter((k) => !new RegExp(`\\b${k}\\b`).test(api));
  check('W8 前端：`ModelGuidance` 契约含 platform/entries/totalBytes/sets', missing.length === 0, missing);
  check('W8b 前端：`ModelSetGuide` 契约含 id/bytes（界面不自己编档位名）',
    /interface ModelSetGuide/.test(api) && /id: string;/.test(api) && /bytes: number;/.test(api), null);
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

  /** 改文件里的一处文本（返回还原函数）。锚点按文件**实际 EOL** 展开（CRLF 纪律）。 */
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
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { out += d; });
      c.on('error', () => resolve({ code: -1, out }));
      c.on('close', (code) => resolve({ code, out }));
    });

  const hasRed = (out, name) => out.split('\n').some((l) => l.trimStart().startsWith('✗') && l.includes(name));
  const redOn = (out) => out.split('\n').filter((l) => l.trimStart().startsWith('✗')).map((l) => l.trim().slice(0, 46));

  // ---- M1：总量写成常量 ----
  {
    const restore = mutateFile(MODEL_STATUS_RS, 'ModelGuidance { platform: platform.to_string(), entries: mine.len(), total_bytes, sets }',
      'ModelGuidance { platform: platform.to_string(), entries: mine.len(), total_bytes: 1, sets }');
    const built = await rebuild();
    const r = await runForward();
    // 判据是 W1（总量对不上清单）；W6（改副本跟着变）同样会红
    const red = built && r.code !== 0 && hasRed(r.out, 'W1') && hasRed(r.out, 'W6');
    check('M1 总量写成常量 ⇒ W1/W6 红（"如实告知"退化成"编一个数"）', red, { built, code: r.code, redOn: redOn(r.out) });
    restore();
    await rebuild();
  }

  // ---- M2：分档表只留第一档 ----
  {
    const restore = mutateFile(MODEL_STATUS_RS, 'for name in &order {', 'for name in order.iter().take(1) {');
    const built = await rebuild();
    const r = await runForward();
    // 只留 visual ⇒ 分档之和不再等于总量
    const red = built && r.code !== 0 && hasRed(r.out, 'W2') && hasRed(r.out, 'W5');
    check('M2 分档表只留第一档 ⇒ W2/W5 红（分档之和不再等于总量）', red, { built, code: r.code, redOn: redOn(r.out) });
    restore();
    await rebuild();
  }

  // ---- M3：前端没接上 ----
  {
    const restore = mutateFile(ENGINE_DIAG, '<ModelGuide guidance={s?.models?.guidance} dir={o?.modelDir?.current} />', '');
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W7');
    check('M3 删前端引导区块 ⇒ W7 红（服务端算好了、界面没接上）', red, { code: r.code, redOn: redOn(r.out) });
    restore();
  }

  // 收尾：确认还原到位（源码逐字节）
  {
    const bad = [];
    const rs = fs.readFileSync(MODEL_STATUS_RS, 'utf8');
    if (!rs.includes('entries: mine.len(), total_bytes, sets }')) bad.push('model_status.rs 残留 M1');
    if (!rs.includes('for name in &order {')) bad.push('model_status.rs 残留 M2');
    if (!fs.readFileSync(ENGINE_DIAG, 'utf8').includes('<ModelGuide guidance={s?.models?.guidance} dir={o?.modelDir?.current} />')) bad.push('EngineDiag.tsx 未还原');
    check('R1 变异收尾：两处源码按字节还原', bad.length === 0, bad);
  }
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
