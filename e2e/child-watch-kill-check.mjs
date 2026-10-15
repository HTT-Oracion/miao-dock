#!/usr/bin/env node
/**
 * `child-watch` 的 **Windows killTree 源码钉子（双靶：Node 原版 + A3c Rust 移植）**。
 *
 * ## 为什么单列一条源码钉子
 * `child-watch-check.mjs` 是**行为对照**（起真进程测「父死 ⇒ 子树被带走」），但它
 * **区分不了「SIGTERM 先礼」与「SIGKILL 后兵」**—— 只要最终死了就绿，掩盖了
 * 「先礼不带 /F 对控制台进程无效」这个平台缺陷。要钉住这个差别，只能读源码。
 *
 * ## 缺陷真身（D-89）
 * Windows 上 `taskkill /T` **不带 `/F`** 对 node 返回 255、对 Python 返回 128，
 * 目标进程一个不死。于是「先礼」名存实亡：要等 `SHUTDOWN_GRACE_MS` 才补 `/F` ——
 * 若看守器在这窗口内自身退出，`/F` 就被跳过，真引擎的执行器（孙进程）成孤儿占着
 * port+1。修法：**Windows 分支无论先礼后兵都直接 `/F`**（平台没有「优雅」这一档，
 * 硬保留先礼只会空等、还给孙进程留被 reparent 成孤儿的窗口）。
 *
 * ## 判据（源码级，不起进程）
 *   S1 Node 靶：`engine/scripts/child-watch.mjs` 的 `taskkill` 参数数组里 `/F` **无条件**出现，
 *      不得写成 `...(sig === 'SIGKILL' ? ['/F'] : [])` 这种「只 SIGKILL 才 /F」的条件式。
 *   S2 Rust 靶：`src-tauri/src/platform/child_watch.rs` 的 `kill_tree` 里 `taskkill` 参数数组
 *      同样**无条件**含 `"/F"`，且不得出现「按 `force` 决定加不加 `/F`」的写法。
 *
 * 🔴 两靶都要钉，不能只留一个：
 *   · `service/src/settings/llm-supervisor.mjs` **仍在用** `child-watch.mjs`（Node 对照端
 *     是真实产品路径，不是死代码），删了 Node 侧判据就少一半覆盖面；
 *   · Rust 侧是 A3c 之后 `service.rs` 与 `mangasvc::engine::supervisor` 真正走的路径。
 *
 * ## 用法
 *   node e2e/child-watch-kill-check.mjs            正向（期望全绿）
 *   node e2e/child-watch-kill-check.mjs --refute   反证（破坏 → 变红 → 按字节还原）
 *
 * 约束：纯 Node、零依赖、不起进程；反证轮结束**必须**按字节还原。
 * 见 ~/.workbuddy/skills/falsifiable-verification。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE_WATCH = path.join(ROOT, 'engine', 'scripts', 'child-watch.mjs');
const RUST_WATCH = path.join(ROOT, 'src-tauri', 'src', 'platform', 'child_watch.rs');
const REFUTE = process.argv.includes('--refute');

const read = (f) => fs.readFileSync(f, 'utf8');

const results = [];
const check = (id, label, ok, detail) =>
  results.push({ id, label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

/**
 * 剥掉行注释（Rust / JS 共用的双斜杠行注释与斜杠星号块注释），保留行数。
 *
 * 🔴 必须剥：本仓库的注释**主动写出了被禁的写法**（"不得写成 …只有 SIGKILL 才 /F"），
 * 不剥就会把注释当代码匹配 ⇒ 判据变成永远绿的空断言（D-149 同源问题）。
 * 只处理注释，不动字符串内容 —— 判据要匹配的 `'/F'` 就在字符串里。
 */
function stripComments(src) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        state = 'line';
        out += '  ';
        i++;
        continue;
      }
      if (c === '/' && c2 === '*') {
        state = 'block';
        out += '  ';
        i++;
        continue;
      }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      out += c;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += '\n';
        continue;
      }
      out += ' ';
      continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') {
        state = 'code';
        out += '  ';
        i++;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    // 字符串内：整体保留（判据匹配的就是这里面的内容）
    if (c === '\\') {
      out += c + (c2 ?? '');
      i++;
      continue;
    }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) state = 'code';
    out += c;
  }
  return out;
}

/** 取出 `fn kill_tree` 的函数体（Rust）。锚点连到被断言的**符号名**（D-113）。 */
function rustKillTree(src) {
  const anchor = src.indexOf('fn kill_tree');
  if (anchor < 0) return '';
  const open = src.indexOf('{', anchor);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

function runAll() {
  results.length = 0;

  // ---- S1：Node 靶 Windows taskkill 无条件 /F ----
  const js = stripComments(read(NODE_WATCH));
  const jsConditional = js.includes("sig === 'SIGKILL' ? ['/F'] : []");
  const jsUnconditional = /spawn\('taskkill',\s*\[[^\]]*'\/F'[^\]]*\]/.test(js);
  check(
    'S1',
    'Node 靶 `child-watch.mjs` 的 `taskkill` 无条件带 `/F`（不得是「只 SIGKILL 才 /F」的条件式 —— 否则先礼对 Python/node 无效、留孤儿执行器）',
    jsUnconditional && !jsConditional,
    `无条件/F=${jsUnconditional} 条件式=${jsConditional}`,
  );

  // ---- S2：Rust 靶 Windows taskkill 无条件 /F ----
  // 判据取「参数数组字面量里含 `"/F"`」而不是「`force` 有没有被用」：
  // `kill_tree` 的 `force` 参数在 Windows 分支**必须留着**（unix 分支靠它区分
  // SIGTERM/SIGKILL），所以「force 未被使用」不是缺陷的信号，参数数组才是。
  const rs = rustKillTree(stripComments(read(RUST_WATCH)));
  const rsHasFn = rs.length > 0;
  const rsUnconditional = /\bargs\(\s*\[[^\]]*"\/F"[^\]]*\]\s*\)/.test(rs);
  // 条件式形态：先 push 再按 force 决定加不加 `/F`
  const rsConditional = /if\s+force\s*\{[^}]*"\/F"/.test(rs);
  check(
    'S2',
    'Rust 靶 `child_watch.rs` 的 `kill_tree` 里 `taskkill` 参数数组无条件含 `"/F"`（否则 Windows 先礼档形同虚设、孤儿执行器占 port+1）',
    rsHasFn && rsUnconditional && !rsConditional,
    `找到kill_tree=${rsHasFn} 无条件/F=${rsUnconditional} 条件式=${rsConditional}`,
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
    name: 'M1 Node 靶 killTree 退回「只 SIGKILL 才 /F」的条件式（先礼不带 /F ⇒ 孤儿执行器）',
    file: NODE_WATCH,
    find: "      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {",
    replace: "      spawn('taskkill', ['/PID', String(pid), '/T', ...(sig === 'SIGKILL' ? ['/F'] : [])], {",
    expect: ['S1'],
  },
  {
    name: 'M2 Rust 靶 kill_tree 退回「先礼不带 /F」（按 force 决定加不加 ⇒ Windows 先礼档空转）',
    file: RUST_WATCH,
    find: '        c.args(["/PID", &pid.to_string(), "/T", "/F"]);',
    replace: [
      '        c.args(["/PID", &pid.to_string(), "/T"]);',
      '        if force {',
      '            c.arg("/F");',
      '        }',
    ].join('\n'),
    expect: ['S2'],
  },
];

const readBytes = (f) => {
  try {
    return fs.readFileSync(f);
  } catch {
    return null;
  }
};

function main() {
  console.log(`child-watch Windows killTree · 源码钉子（双靶）${REFUTE ? ' · 反证轮' : ''}`);

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
  const originals = new Map(MUTATIONS.map((m) => [m.file, readBytes(m.file)]));

  console.log('\n破坏源文件 → 断言必须变红 → 按字节还原\n');
  for (const mut of MUTATIONS) {
    const rel = path.relative(ROOT, mut.file);
    const original = originals.get(mut.file);
    const txt = original ? original.toString('utf8') : null;
    if (!txt || !txt.includes(mut.find)) {
      console.log(`⚠ ${mut.name}\n    破坏锚点未找到 —— 本条无法反证`);
      skipped += mut.expect.length;
      continue;
    }
    // 🔴 锚点按文件实际行尾归一化：脚本内字面量是 LF，磁盘上可能是 CRLF（D-149）。
    const eol = txt.includes('\r\n') ? '\r\n' : '\n';
    const find = mut.find.replace(/\n/g, eol);
    const replace = mut.replace.replace(/\n/g, eol);
    fs.writeFileSync(mut.file, txt.replace(find, replace));

    let res = {};
    let roundErr = null;
    try {
      runAll();
      for (const r of results) res[r.id] = r;
    } catch (err) {
      roundErr = err;
    } finally {
      fs.writeFileSync(mut.file, original);
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
  let same = true;
  for (const mut of MUTATIONS) {
    const rel = path.relative(ROOT, mut.file);
    const back = readBytes(mut.file);
    const ok = back != null && back.equals(originals.get(mut.file));
    if (!ok) same = false;
    console.log(`  ${ok ? '✓' : '✗'} ${rel} 字节${ok ? '一致' : '不一致！'}`);
  }

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
