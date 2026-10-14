#!/usr/bin/env node
/**
 * D3 · 「校验收尾中断可恢复」钉子 —— 解包必须是**原子**的
 * =============================================================================
 * 对应计划文档 D3：`.part` + 原子改名；修 `setup-engine.mjs::extract()` 的
 * 「先删后解、失败不回滚」（D-95 待修项）。验收：
 *   ① 收尾中途 kill ⇒ 重跑能继续，而不是报「目录已存在但内容坏」；
 *   ② 反证：还原旧实现 ⇒ 变红。
 *
 * ## 为什么这一条必须**真跑**，不能只做源码钉
 * 「先删后解」的坏处是**不可逆**的：解包失败时 `destDir` **已经被删掉**、只剩半份内容，
 * 而这个状态与"装好了"在目录层面看不出区别。源码里"看起来像原子"的写法（先 mkdir、
 * 再 tar、失败时 throw）与真正的原子写法**长得几乎一样**，但失败后盘上的结果截然不同。
 * 所以这里用真 `tar` + 夹具归档，把失败路径**跑出来**再看盘上还剩什么。
 *
 * 判据落在两件事上（都可反证）：
 *   · 失败时 `destDir` **一个字节都没动**（旧内容连文件都在）；
 *   · 失败后**不留 `.part`**（半成品会被下一次运行当成"上一次没跑完"，也会混进新的解包）。
 *
 * ## 反证轮（--refute）
 *   M1 把 `extractAtomic` 改回「先删后解」⇒ EA.W3 红（这是 D-95 的原形态）；
 *   M2 `cleanupPart` 变成空操作 ⇒ EA.W4/EA.W6 红（失败后残留半成品）；
 *   M3 `verify` 结果被忽略（`if (false)`）⇒ EA.W4 红（坏归档会被提交落位）。
 *
 * 用法：node e2e/engine/extract-atomic-check.mjs [--refute]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REFUTE = process.argv.includes('--refute');
const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..', '..');
const ATOMIC_MJS = path.join(ROOT, 'engine', 'scripts', 'atomic-extract.mjs');
const SETUP_MJS = path.join(ROOT, 'engine', 'scripts', 'setup-engine.mjs');
/** 变异前的字节快照 —— 收尾的"按字节还原"拿它比，不用文本判据（文本判据会被注释骗）。 */
const ATOMIC_ORIGINAL = fs.readFileSync(ATOMIC_MJS);

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

/** 每次**重新 import**：反证轮改了盘上的模块，缓存不清就会读到改前的那份（假绿）。 */
async function loadAtomic() {
  const url = `${pathToFileURL(ATOMIC_MJS).href}?t=${Date.now()}${Math.random()}`;
  return import(url);
}

const { extractAtomic, leftovers } = await loadAtomic();

// ------------------------------------------------------------------ 夹具

/** 造一个 `root/…` 结构的归档（`--strip-components=1` 之后落成 `dest/keep.txt`）。 */
function makeArchive(dir, name, content) {
  const stage = path.join(dir, `stage-${name}`);
  fs.mkdirSync(path.join(stage, 'root'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'root', 'keep.txt'), content);
  const archive = path.join(dir, `${name}.tar.gz`);
  const rc = spawnSync('tar', ['-czf', archive, '-C', stage, 'root'], { stdio: 'ignore' });
  if (rc.status !== 0) throw new Error(`造夹具归档失败：${name}`);
  fs.rmSync(stage, { recursive: true, force: true });
  return archive;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-extract-'));
const goodArchive = makeArchive(tmp, 'good', 'NEW-CONTENT\n');
const badArchive = path.join(tmp, 'bad.tar.gz');
fs.writeFileSync(badArchive, 'this is definitely not a tar archive\n');

/** 造一份"上一次已经装好"的目标目录（旧内容 + 一个只属于旧版本的文件）。 */
function seedDest(name) {
  const dest = path.join(tmp, name);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'keep.txt'), 'OLD-CONTENT\n');
  fs.writeFileSync(path.join(dest, 'old-only.txt'), 'OLD-ONLY\n');
  return dest;
}

const destSnapshot = (dest) => {
  if (!fs.existsSync(dest)) return null;
  const out = {};
  for (const n of fs.readdirSync(dest).sort()) out[n] = fs.readFileSync(path.join(dest, n), 'utf8');
  return out;
};

// ------------------------------------------------------------------ EA.W1 接线

{
  const setup = fs.readFileSync(SETUP_MJS, 'utf8');
  const importsIt = /from '\.\/atomic-extract\.mjs'/.test(setup);
  // 本地 extract 实现里**不许**再出现「对 destDir 直接 rmSync」——那正是 D-95 的原形态
  const fnStart = setup.indexOf('function extract(');
  const fnEnd = fnStart < 0 ? -1 : setup.indexOf('\n}', fnStart);
  const body = fnStart >= 0 && fnEnd > fnStart ? setup.slice(fnStart, fnEnd + 2) : '';
  check('EA.W1 `setup-engine.mjs` 的解包走 `atomic-extract.mjs`（引入 + 转调），且本地实现里没有「对 destDir 直接 rmSync」',
    importsIt && /extractAtomic\(/.test(body) && !/rmSync\(\s*destDir/.test(body),
    { importsIt, delegates: /extractAtomic\(/.test(body), deletesDest: /rmSync\(\s*destDir/.test(body) });
}

// ------------------------------------------------------------------ EA.W2 成功路径：整体替换

{
  const dest = seedDest('ok');
  extractAtomic(goodArchive, dest, { strip: 1 });
  const got = destSnapshot(dest);
  check('EA.W2 成功路径：新内容落位（`keep.txt` = 新内容），旧版本独有的文件随旧目录一起被换掉',
    got && got['keep.txt'] === 'NEW-CONTENT\n' && !('old-only.txt' in got), got);
}

// ------------------------------------------------------------------ EA.W3 失败路径（tar 失败）：destDir 一个字节都不动

{
  const dest = seedDest('fail-tar');
  const before = destSnapshot(dest);
  let threw = false;
  try {
    extractAtomic(badArchive, dest, { strip: 1 });
  } catch {
    threw = true;
  }
  const after = destSnapshot(dest);
  check('EA.W3 解包失败（坏归档）⇒ 抛错，且 `destDir` **原封不动**（D-95 的原形态在这里会把旧目录先删掉）',
    threw && JSON.stringify(before) === JSON.stringify(after), { threw, before, after });
}

// ------------------------------------------------------------------ EA.W4 失败路径（verify 失败）：不动 destDir + 不留 .part

{
  const dest = seedDest('fail-verify');
  const before = destSnapshot(dest);
  let threw = false;
  try {
    extractAtomic(goodArchive, dest, { strip: 1, verify: () => { throw new Error('校验没过（故意）'); } });
  } catch {
    threw = true;
  }
  const after = destSnapshot(dest);
  const left = leftovers(dest);
  check('EA.W4 校验失败 ⇒ 抛错、`destDir` 原封不动、且**不留半成品**（`.part` 必须被清掉 —— 留着它下一次会被当成"上一次没跑完"）',
    threw && JSON.stringify(before) === JSON.stringify(after) && left.length === 0,
    { threw, same: JSON.stringify(before) === JSON.stringify(after), leftovers: left });
}

// ------------------------------------------------------------------ EA.W5 成功路径不留残渣

{
  const dest = seedDest('clean');
  extractAtomic(goodArchive, dest, { strip: 1 });
  const left = leftovers(dest);
  check('EA.W5 成功路径不留残渣（`.part` / `.old-*` 都不该剩下）',
    left.length === 0, left);
}

// ------------------------------------------------------------------ EA.W6 上次中断留下的 .part 不干扰

{
  const dest = path.join(tmp, 'stale');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'keep.txt'), 'OLD-CONTENT\n');
  // 模拟"上一次解到一半就断了"：半成品目录里塞一个会混进新内容的文件
  fs.mkdirSync(`${dest}.part`, { recursive: true });
  fs.writeFileSync(path.join(`${dest}.part`, 'stale-junk.txt'), 'JUNK\n');

  extractAtomic(goodArchive, dest, { strip: 1 });
  const got = destSnapshot(dest);
  check('EA.W6 上一次中断留下的 `.part` 不干扰本次解包（半成品被先清掉，不会把旧文件混进新内容），结束后也不留残渣',
    got && got['keep.txt'] === 'NEW-CONTENT\n' && !('stale-junk.txt' in got) && leftovers(dest).length === 0,
    { got, leftovers: leftovers(dest) });
}

// ------------------------------------------------------------------ 反证轮

if (REFUTE) {
  console.log('\n── 反证轮（改源码 ⇒ 指定断言必须红；跑完按字节还原）──\n');

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
      const c = spawnSync(process.execPath, [SELF], { cwd: ROOT, encoding: 'utf8' });
      resolve({ code: c.status, out: `${c.stdout ?? ''}${c.stderr ?? ''}` });
    });

  const hasRed = (out, name) => out.split('\n').some((l) => l.trimStart().startsWith('✗') && l.includes(name));
  const redOn = (out) => out.split('\n').filter((l) => l.trimStart().startsWith('✗')).map((l) => l.trim().slice(0, 44));

  const MKDIR_PART = 'fs.mkdirSync(part, { recursive: true });';
  const CLEANUP_BODY = 'fs.rmSync(dir, { recursive: true, force: true });';
  const VERIFY_GUARD = 'if (verify) {';

  // ---- M1：改回「先删后解」（D-95 的原形态）----
  {
    const restore = mutateFile(ATOMIC_MJS, MKDIR_PART, `fs.rmSync(destDir, { recursive: true, force: true });\n  ${MKDIR_PART}`);
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'EA.W3');
    check('M1 改回「先删后解」（解包前就把 `destDir` 删掉）⇒ EA.W3 红 —— 这正是 D-95 记的那个形态',
      red, { code: r.code, redOn: redOn(r.out) });
    restore();
  }

  // ---- M2：cleanupPart 变空操作（失败后残留半成品）----
  {
    const restore = mutateFile(ATOMIC_MJS, CLEANUP_BODY, '/* M2：不清了 */');
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'EA.W4');
    check('M2 `cleanupPart` 变空操作 ⇒ EA.W4 红（失败后留下半成品，下一次运行会被它误导）',
      red, { code: r.code, redOn: redOn(r.out) });
    restore();
  }

  // ---- M3：verify 结果被忽略（坏内容照提交）----
  {
    const restore = mutateFile(ATOMIC_MJS, VERIFY_GUARD, 'if (false) {');
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'EA.W4');
    check('M3 `verify` 被忽略（`if (false)`）⇒ EA.W4 红（校验没过也照样落位）',
      red, { code: r.code, redOn: redOn(r.out) });
    restore();
  }

  /*
   * 收尾：确认还原到位 —— **按字节比**，不用文本判据。
   *
   * ⚠️ 这里踩过一次：最早写成「源码里不含 `fs.rmSync(destDir`」，而那个串**本来就在**
   * 文件头的注释里（"老写法是……"那段示例代码）⇒ 这条收尾判据恒红。
   * "按字节还原"就该拿字节比。
   */
  {
    const same = ATOMIC_ORIGINAL.equals(fs.readFileSync(ATOMIC_MJS));
    check('R1 变异收尾：`atomic-extract.mjs` 按字节还原', same, { same });
  }
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
