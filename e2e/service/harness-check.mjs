#!/usr/bin/env node
/**
 * F0 · 服务靶子抽象的钉子 —— 「入口解析唯一」+「MIAO_SERVICE_IMPL 切换正确」
 * =============================================================================
 * 为什么要有这个钉子：F 组让 e2e 能打**两套服务实现**（node / rust）的唯一机制，是
 * 把「靶子是谁」收敛到 `_service-harness.mjs`。一旦某个脚本又自己拼一份入口，
 * 后果不是报错，而是**静默打在错的靶子上** —— 「两边都绿」其实是 node 跑了两遍
 * （计划文档 R16）。本钉子把「入口唯一」从散文纪律变成可反证的断言。
 *
 * ## 断言
 *   HARNESS.entrySingle       e2e/service/ 下除 harness 外**无人**定义 `SERVICE_ENTRY`
 *   HARNESS.entryImported     凡使用 `SERVICE_ENTRY` 的脚本，都必须从 harness import 它
 *   HARNESS.nodeTarget        `MIAO_SERVICE_IMPL=node` ⇒ command=node、args=[server.mjs,...]
 *   HARNESS.rustTarget        `MIAO_SERVICE_IMPL=rust` ⇒ command=boxsvc、args=[]
 *   HARNESS.rustMissingThrows rust 靶子缺失时**报错文本指向构建命令**（不是静默落回 node）
 *   HARNESS.engineUntouched   非服务入口（模拟引擎）在 rust 档下**不被劫持**（仍走 node）
 *   HARNESS.implMislabeled    未知 `MIAO_SERVICE_IMPL` 值 ⇒ 落回 node 且 **stderr 可见**（R16）
 *
 * ## 反证轮（--refute，3 个内存变异）
 *   M1 注入一份「本地定义 SERVICE_ENTRY」的脚本 → entrySingle 红
 *   M2 注入一份「用 SERVICE_ENTRY 但不 import harness」的脚本 → entryImported 红
 *   M3 把 node 档的 args 期望改坏（模拟 harness 没把入口接上）→ nodeTarget 红
 * 反证前先要求**正向全绿**（正向就红 ⇒ 反证证明不了任何事）。
 *
 * 用法：node e2e/service/harness-check.mjs [--refute]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/e2e/service
const REFUTE = process.argv.includes('--refute');
const HARNESS_FILE = '_service-harness.mjs';
const SELF_FILE = path.basename(fileURLToPath(import.meta.url));

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

// ------------------------------------------------------------------ 源码扫描（驱动 H1/H2）

/** 读 e2e/service/ 下所有 .mjs 的 { file, text }（harness 自身 + 本钉子除外，它们是基建）。 */
const SKIP = new Set([HARNESS_FILE, '_parent-harness.mjs', SELF_FILE]);
function readSources() {
  return fs
    .readdirSync(HERE)
    .filter((f) => f.endsWith('.mjs') && !SKIP.has(f))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(HERE, f), 'utf8') }));
}

/** 去掉行注释与块注释，避免「注释里提到 SERVICE_ENTRY」被当成使用（假红）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * H1：除 harness 外，没有任何脚本**定义** `SERVICE_ENTRY`（`const/let/var SERVICE_ENTRY =`）。
 * 返回违规文件名数组。
 */
export function findEntryDefinitions(sources) {
  const re = /(?:^|\s)(?:const|let|var)\s+SERVICE_ENTRY\s*=/;
  return sources.filter((s) => re.test(stripComments(s.text))).map((s) => s.file);
}

/**
 * H2：凡**使用** `SERVICE_ENTRY` 的脚本，都必须从 `_service-harness.mjs` import 它。
 * 返回违规文件名数组。
 */
export function findUnsourcedUsers(sources) {
  const bad = [];
  for (const s of sources) {
    const code = stripComments(s.text);
    if (!/\bSERVICE_ENTRY\b/.test(code)) continue;
    if (!/from\s+['"]\.\/_service-harness\.mjs['"]/.test(s.text)) bad.push(s.file);
  }
  return bad;
}

// ------------------------------------------------------------------ 子进程探针（驱动 H3–H7）
//
// `IMPL` 在模块加载时从 env 读定 —— 想验另一档，只能**另起一个 node** 带不同 env 去 import。
// 探针脚本：import harness → 打印 targetFor(entry) 或捕获异常 → JSON 出 stdout。
const PROBE = `
const harness = await import(${JSON.stringify('./' + HARNESS_FILE)});
const entry = process.argv[1];
const mode = process.argv[2];
try {
  const t = harness.targetFor(entry);
  process.stdout.write(JSON.stringify({ ok: true, command: t.command, args: t.args }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, message: String(e && e.message || e) }));
}
`;

function probe(env, entry, mode = 'target') {
  return runNode(['--input-type=module', '-e', PROBE, entry, mode], env).then((r) => JSON.parse(r.stdout.trim()));
}

/**
 * 起一个 node 子进程跑内联脚本，返回 {stdout, stderr, code}。
 * 🔴 必须用**异步** spawn：本机（Windows）`execFileSync` / `spawnSync` 起子进程会 `EBUSY`
 *    （同步 spawn 走的是另一条 CreateProcess 路径，被环境挡住），异步 spawn 正常。
 */
function runNode(args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, args, {
      cwd: HERE,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', (e) => resolve({ stdout: '', stderr: String(e), code: -1 }));
    c.on('close', (code) => resolve({ stdout: out, stderr: err, code }));
  });
}

// ------------------------------------------------------------------ 正向

const sources = readSources();

// H1
{
  const bad = findEntryDefinitions(sources);
  check('HARNESS.entrySingle — e2e/service/ 下除 harness 外无人定义 SERVICE_ENTRY', bad.length === 0, bad);
}
// H2
{
  const bad = findUnsourcedUsers(sources);
  check('HARNESS.entryImported — 使用 SERVICE_ENTRY 的脚本都从 harness import', bad.length === 0, bad);
}

// 入口常量（用 harness 自己算，避免本文件再拼一份 —— 那正是本钉子要禁的事）
const harnessMod = await import('./' + HARNESS_FILE);
const { NODE_ENTRY } = harnessMod;
const ENGINE_ENTRY = path.resolve(HERE, '..', '..', 'engine', 'src', 'server.mjs');

// H3 node 档
{
  const t = await probe({ MIAO_SERVICE_IMPL: 'node' }, NODE_ENTRY);
  const ok = t.ok && path.resolve(t.command) === path.resolve(process.execPath) && path.resolve(t.args[0]) === path.resolve(NODE_ENTRY);
  check('HARNESS.nodeTarget — node 档 ⇒ command=node，args[0]=service/src/server.mjs', ok, t);
}
// H4 rust 档（用临时假二进制占位，验「解析」而非「存在」）
{
  const dummy = path.join(HERE, '_tmp-boxsvc-probe.bin');
  fs.writeFileSync(dummy, '');
  try {
    const t = await probe({ MIAO_SERVICE_IMPL: 'rust', MIAO_BOXSVC_BIN: dummy }, NODE_ENTRY);
    const ok = t.ok && path.resolve(t.command) === path.resolve(dummy) && (t.args || []).length === 0;
    check('HARNESS.rustTarget — rust 档 ⇒ command=boxsvc，args 为空', ok, t);
  } finally {
    fs.rmSync(dummy, { force: true });
  }
}
// H5 rust 档但二进制缺失 ⇒ 明确报错（含构建指引），**不是**静默落回 node
{
  const missing = path.join(HERE, '_definitely_not_here_boxsvc');
  const t = await probe({ MIAO_SERVICE_IMPL: 'rust', MIAO_BOXSVC_BIN: missing }, NODE_ENTRY);
  const ok = t.ok === false && /cargo build --bin boxsvc/.test(t.message || '');
  check('HARNESS.rustMissingThrows — rust 靶子缺失时报错指向构建命令', ok, t);
}
// H6 非服务入口（模拟引擎）在 rust 档下不被劫持
{
  const dummy = path.join(HERE, '_tmp-boxsvc-probe2.bin');
  fs.writeFileSync(dummy, '');
  try {
    const t = await probe({ MIAO_SERVICE_IMPL: 'rust', MIAO_BOXSVC_BIN: dummy }, ENGINE_ENTRY);
    const ok = t.ok && path.resolve(t.command) === path.resolve(process.execPath) && path.resolve(t.args[0]) === path.resolve(ENGINE_ENTRY);
    check('HARNESS.engineUntouched — 模拟引擎入口在 rust 档下仍走 node', ok, t);
  } finally {
    fs.rmSync(dummy, { force: true });
  }
}
// H7 未知值落回 node 且 stderr 可见（R16）
{
  const r = await runNode(
    ['--input-type=module', '-e', `await import(${JSON.stringify('./' + HARNESS_FILE)}); process.stdout.write('done');`],
    { MIAO_SERVICE_IMPL: 'RUSTT' },
  );
  const ok = /未知 MIAO_SERVICE_IMPL/.test(r.stderr || '') && /RUSTT/i.test(r.stderr || '');
  check('HARNESS.implMislabeled — 未知 MIAO_SERVICE_IMPL 落回 node 且 stderr 可见', ok, { stderr: (r.stderr || '').trim() });
}

// ------------------------------------------------------------------ 反证
if (REFUTE) {
  if (failed > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }
  const fakeWithDef = { file: '__refute__.mjs', text: "const SERVICE_ENTRY = path.join(ROOT, 'service', 'src', 'server.mjs');" };
  const fakeUserNoImport = { file: '__refute2__.mjs', text: 'const c = spawnProc(SERVICE_ENTRY, env, tag);' };

  const mutations = [
    {
      id: 'M1',
      what: '注入一份本地定义 SERVICE_ENTRY 的脚本',
      run: () => findEntryDefinitions([...sources, fakeWithDef]).length > 0,
    },
    {
      id: 'M2',
      what: '注入一份用 SERVICE_ENTRY 但不 import harness 的脚本',
      run: () => findUnsourcedUsers([...sources, fakeUserNoImport]).includes('__refute2__.mjs'),
    },
    {
      id: 'M3',
      what: 'node 档 args 期望改坏（模拟入口没接上）',
      run: async () => {
        const t = await probe({ MIAO_SERVICE_IMPL: 'node' }, NODE_ENTRY);
        // 故意要求 args[0] 为空 —— 真实值非空 ⇒ 「断言」应当拒绝
        return !(t.ok && (t.args || []).length === 0);
      },
    },
  ];

  let allRed = true;
  for (const m of mutations) {
    const red = await m.run();
    if (!red) allRed = false;
    console.log(`  ${red ? '✓' : '✗'} ${m.id} ${m.what} → ${red ? '按预期变红' : '**没有红**（断言漏了它）'}`);
  }
  console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed, refute: mutations.length, allRed }));
  console.log(`\nF0 靶子抽象：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`);
  process.exit(allRed ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(`\nF0 靶子抽象：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`);
process.exit(failed === 0 ? 0 : 1);
