#!/usr/bin/env node
/**
 * `engine/scripts/child-watch.mjs` 的 **Windows killTree** 源码钉子。
 *
 * ## 为什么单列一条源码钉子
 * `child-watch-check.mjs` 是**行为对照**（起真进程测"父死 ⇒ 子树被带走"），但它：
 *   ① 依赖 `pkill` / `ps` / `lsof` 等 **Unix 命令**，Windows 上只能凑合跑、且目标进程
 *      用的是 **node**（不是真模式的 Python 执行器），没真正测到孙进程那层；
 *   ② 不区分「SIGTERM 先礼」与「SIGKILL 后兵」—— 只要最终杀了就绿，掩盖了
 *      「先礼不带 /F 对控制台进程无效」这个平台缺陷。
 *
 * 这条缺陷（D-89）的真身：Windows 上 `taskkill /T` 不带 `/F` 对 node 返回 255、对
 * Python 返回 128，目标进程一个不死。于是 `killTree('SIGTERM')`（先礼）名存实亡，要等
 * 1500ms 的 `setTimeout(..., .unref())` 才 `/F` —— 若看守在这窗口内自身退出，`/F` 被跳过，
 * 真引擎的执行器（孙进程）就成孤儿占着 port+1。修法：Windows 分支无论 SIGTERM/SIGKILL
 * 都直接 `/F`。
 *
 * ## 判据（源码级，不起进程）
 *   S1 `child-watch.mjs` 的 Windows `killTree` 分支里，`taskkill` 的 `/F` 必须**无条件**出现，
 *      **不得**写成 `...(sig === 'SIGKILL' ? ['/F'] : [])` 这种「只 SIGKILL 才 /F」的条件式。
 *
 * 用法：
 *   node e2e/child-watch-kill-check.mjs            正向（期望全绿）
 *   node e2e/child-watch-kill-check.mjs --refute   反证（破坏 → 变红 → 按字节还原）
 *
 * 约束：纯 Node、零依赖、不起进程；反证轮结束**必须**按字节还原。
 * 见 ~/.workbuddy/skills/falsifiable-verification。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WATCH = path.join(ROOT, 'engine', 'scripts', 'child-watch.mjs');
const REFUTE = process.argv.includes('--refute');

const read = () => fs.readFileSync(WATCH, 'utf8');

const results = [];
const check = (id, label, ok, detail) =>
  results.push({ id, label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

function runAll() {
  results.length = 0;
  const src = read();

  // ---- S1：Windows killTree 无条件 /F ----
  // 缺陷形态是 `...(sig === 'SIGKILL' ? ['/F'] : [])`（条件 /F）；修法是无条件 '/F'。
  // 判据：taskkill 那一行必须含字面 '/F'，且**不得**出现「只 SIGKILL 才 /F」的条件三元。
  const conditionalF = src.includes("sig === 'SIGKILL' ? ['/F'] : []");
  const unconditionalF = /spawn\('taskkill',\s*\[[^\]]*'\/F'[^\]]*\]/.test(src);
  check(
    'S1',
    'Windows `killTree` 的 `taskkill` 无条件带 `/F`（不得是「只 SIGKILL 才 /F」的条件式 —— 否则先礼对 Python/node 无效、留孤儿执行器）',
    unconditionalF && !conditionalF,
    `无条件/F=${unconditionalF} 条件式=${conditionalF}`,
  );
}

function printResults(title) {
  console.log(`\n【${title}】`);
  let fail = 0;
  for (const r of results) {
    if (!r.ok) fail++;
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.id} ${r.label}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log('\n' + '─'.repeat(56));
  console.log(`通过 ${results.length - fail} / 失败 ${fail}`);
  return { fail };
}

const MUTATIONS = [
  {
    name: 'M1 Windows killTree 退回「只 SIGKILL 才 /F」的条件式（先礼不带 /F ⇒ 孤儿执行器）',
    find: "      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {",
    replace:
      "      spawn('taskkill', ['/PID', String(pid), '/T', ...(sig === 'SIGKILL' ? ['/F'] : [])], {",
    expect: ['S1'],
  },
];

const readBytes = () => {
  try {
    return fs.readFileSync(WATCH);
  } catch {
    return null;
  }
};

function main() {
  console.log(`child-watch Windows killTree · 源码钉子${REFUTE ? ' · 反证轮' : ''}`);

  if (!REFUTE) {
    runAll();
    const { fail } = printResults('child-watch Windows killTree · 源码钉子');
    process.exitCode = fail === 0 ? 0 : 1;
    return;
  }

  runAll();
  const wasGreen = {};
  for (const r of results) wasGreen[r.id] = r.ok;

  const expectedTotal = MUTATIONS.reduce((n, m) => n + m.expect.length, 0);
  let total = 0;
  let red = 0;
  let skipped = 0;
  const falsePositives = [];
  const original = readBytes();

  console.log('\n破坏源文件 → 断言必须变红 → 按字节还原\n');
  for (const mut of MUTATIONS) {
    const txt = original.toString('utf8');
    if (!txt.includes(mut.find)) {
      console.log(`⚠ ${mut.name}\n    破坏锚点未找到 —— 本条无法反证`);
      skipped += mut.expect.length;
      continue;
    }
    fs.writeFileSync(WATCH, txt.replace(mut.find, mut.replace));

    let res = {};
    let roundErr = null;
    try {
      runAll();
      for (const r of results) res[r.id] = r;
    } catch (err) {
      roundErr = err;
    } finally {
      fs.writeFileSync(WATCH, original);
    }

    console.log(`🔴 ${mut.name}`);
    if (roundErr) console.log(`   ⚠ 本轮 runAll 抛异常（源文件已被破坏）：${String(roundErr.message).split('\n')[0]}`);
    for (const id of mut.expect) {
      total++;
      const isRed = (res[id] && res[id].ok === false) || (!res[id] && roundErr !== null);
      if (isRed) {
        red++;
        console.log(`  ✓ ${id} 按预期变红`);
      } else {
        falsePositives.push(id);
        console.log(`  ✗ ${id} 该红没红 ← 假阳性`);
      }
      if (!wasGreen[id]) console.log('     注：该条基线本就是红，无法据此判定断言有效性');
    }
  }

  console.log('\n恢复校验');
  const back = readBytes();
  const same = back != null && back.equals(original);
  console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, WATCH)} 字节${same ? '一致' : '不一致！'}`);

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红（应执行 ${expectedTotal} 条）`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（破坏锚点未找到）—— 跳过 ≠ 通过`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(', ')}`);
  process.exitCode = red === expectedTotal && skipped === 0 && same ? 0 : 1;
}

try {
  main();
} catch (err) {
  console.error(`\n脚本异常：${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
}
