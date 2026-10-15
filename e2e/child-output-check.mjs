#!/usr/bin/env node
/**
 * 子进程输出读取的**根因钉子**：谁把"读子进程日志"写成"**遇到非 UTF-8 就停读**"，
 * 就会连带打死子进程本身 —— 且报错出现在毫不相干的地方。必须可反证。
 * =====================================================================================
 * ## 这条缺陷的真身（2026-10-07 实测，见 docs/spec-notes.md D-88）
 *
 * 用户报的现象是「翻译日志显示 `[Errno 22] Invalid argument`」，整批 16 张图全 failed。
 * 追下去是一条**五段链**，其中只有第一段是"引擎的问题"：
 *
 *   ① 中文 Windows 上 Python 子进程的 stdout/stderr 默认按 **ANSI 代码页**（GBK/cp936）编码；
 *      而真引擎会把**日文**原文/译文写进日志（`utils/log.py` 的 `logging.basicConfig()`
 *      把 root StreamHandler 接到了 **stderr**）⇒ 日志里第一行日文就是一堆**非法 UTF-8 字节**。
 *   ② Rust 侧读子进程输出用的是 `BufReader::lines().map_while(Result::ok)` ——
 *      `lines()` 要求**合法 UTF-8**，不合法时返回 `Err`；`map_while(Result::ok)` 遇到第一个
 *      `Err` 就**结束迭代**。
 *   ③ 迭代结束 ⇒ `BufReader`（连同 `ChildStderr`）被丢弃 ⇒ **这一端的管道读句柄被关闭**。
 *   ④ 此后子进程**再往这个流写任何东西都失败**。Windows 上的报错是
 *      `OSError: [Errno 22] Invalid argument`（**不是** Linux 那种 `Broken pipe`）。
 *   ⑤ 它冒出来的位置是引擎里 `tqdm` 初始化时那句 `sys.stderr.flush()`（`tqdm/std.py:446`）——
 *      于是「一个进度条」把整张图的「掩码细化」阶段打挂，错误信息里**看不到任何**与
 *      "日志读取"有关的东西。
 *
 * 这个脚本钉的是 ②③ —— **我们自己的那两段**（①②里的①有另一半修复：
 * `resolveEngineLaunch` 注入 `PYTHONIOENCODING=utf-8`，由 `check:engine-client` 的 **L12** 钉，
 * 反证变异是那里的 **J**）。
 *
 * ## 判据
 *   S1 **源码钉子（回归钉子）**：`src-tauri/src/service.rs` 读子进程输出
 *      **代码里不得**出现 `map_while(Result::ok)`；**必须**走按字节 + `from_utf8_lossy` 的 `relay_lines`。
 *      谁把代码改回去，S1 立刻变红。
 *      ⚠️ 判定前先把行注释与块注释剥掉 —— 该文件里正好有一段注释在解释「为什么不能用它」，
 *         不剥注释就会把那句**说明文字**误当成「代码里用了它」而**假红**（本轮踩到过）。
 *   S2 **行为对照（机制取证）**：起一个**真子进程**，让它输出
 *      「ASCII 行 / 含非法 UTF-8 字节的行 / ASCII 行」，用两种**读取策略**读：
 *        · 旧策略 = 严格 UTF-8、遇错即停（复刻 ②）⇒ **丢行**；
 *        · 新策略 = 按字节切行 + lossy（复刻 `relay_lines`）⇒ **一行不丢**。
 *      它把 S1 的源码约束变成**可观察后果**（"改回去会怎样"），而不是"看着更整洁"。
 *
 * ⚠️ 边界，别误读：
 *   · S2 里的两种策略是 **Rust 那段代码的模型**，不是 Rust 本体 —— 真正的回归钉子仍是 S1。
 *   · 本脚本**不**证明"引擎能在 Windows 上跑通"。它只证明"读日志的一端不会因为编码停读"。
 *   · ④⑤ 那两段（管道被关掉后报 errno 22）是 **Windows 平台事实**，用一次性实测取证并记在
 *     台账 D-88 里，**不做成常驻断言**：那需要真起一个 Python 子进程 + 真管道，
 *     会把这条门变成"必须先装配真引擎"的重门，而它要防的回归点在 S1。
 *
 * 用法：
 *   node e2e/child-output-check.mjs            正向跑（期望全绿）
 *   node e2e/child-output-check.mjs --refute   反证轮（破坏 → 变红 → 按字节还原）
 *
 * 约束：纯 Node、零依赖、只起一个 `node -e` 子进程；反证轮结束**必须**按字节还原。
 * 见 ~/.workbuddy/skills/falsifiable-verification。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVICE_RS = path.join(ROOT, 'src-tauri', 'src', 'service.rs');
const REFUTE = process.argv.includes('--refute');

const results = [];
const check = (id, label, ok, detail) => {
  results.push({ id, label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
};

const read = (f) => fs.readFileSync(f, 'utf8');

/// 剥掉 Rust 注释（行注释 `//` 与块注释），保留代码与字符串内容。
/// 只跟踪**双引号字符串**：Rust 字符字面量装不下 `//`，而生命周期 `'a` 若被当字符串反而
/// 会漏剥注释（最坏只造成假绿，可接受）。这样"注释里提到禁用写法"就不会被误判成"代码里用了它"。
function stripRustComments(src) {
  let out = '';
  let i = 0;
  let inStr = false;
  let inBlock = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/// GBK（cp936）下的「荒木宰」—— 本机实测字节。中文 Windows 上引擎写日文日志就是这个形态。
const GBK_ARAKI = Buffer.from([0xbb, 0xc4, 0xc4, 0xbe, 0xd4, 0xd7]);

// ------------------------------------------------------------------ 正向断言

function runAll() {
  results.length = 0;

  // ---- S1：源码钉子 —— 读子进程输出必须 lossy，不得"遇错即停" ----
  // 剥掉注释再判定：`service.rs` 里有一段注释在解释"为什么不能用 map_while(Result::ok)"，
  // 不剥注释就会把那句说明本身当成"代码里用了它" ⇒ 假红。
  const svc = read(SERVICE_RS);
  const code = stripRustComments(svc);
  const hasRelay = code.includes('fn relay_lines');
  const hasLossy = code.includes('from_utf8_lossy');
  const stuckOnEncoding = code.includes('map_while(Result::ok)');
  check(
    'S1',
    '`service.rs` 代码里读子进程输出走 lossy 按字节（`relay_lines` + `from_utf8_lossy`），**不得**用会因编码停读的 `map_while(Result::ok)`（注释中的说明不算）',
    hasRelay && hasLossy && !stuckOnEncoding,
    `relay_lines=${hasRelay} from_utf8_lossy=${hasLossy} 代码内 map_while(Result::ok)=${stuckOnEncoding}`,
  );

  // ---- S2：行为对照 —— 真子进程输出非法 UTF-8 时，旧策略丢行、新策略不丢 ----
  // 子进程刻意用 **`Buffer` 直写字节**，绕开它自己的编码：这就是"子进程按非 UTF-8 输出"的等价物。
  const child = `process.stdout.write(Buffer.concat([
    Buffer.from('LINE-1-OK\\n'),
    Buffer.from([${[...GBK_ARAKI].map((b) => '0x' + b.toString(16)).join(',')}]),
    Buffer.from('\\n'),
    Buffer.from('LINE-3-OK\\n'),
  ]))`;
  const r = spawnSync(process.execPath, ['-e', child], { encoding: 'buffer', maxBuffer: 1 << 20 });
  const bytes = r.stdout || Buffer.alloc(0);

  // 按字节切成"行"（与 `relay_lines` 同一套切法）
  const rawLines = [];
  {
    let cur = [];
    for (const b of bytes) {
      if (b === 0x0a) {
        rawLines.push(Buffer.from(cur));
        cur = [];
      } else {
        cur.push(b);
      }
    }
    if (cur.length) rawLines.push(Buffer.from(cur));
  }

  const strict = new TextDecoder('utf-8', { fatal: true });
  // 旧策略：逐行严格解码；**第一行解不出来就停**（= Rust 的 lines() + map_while(Result::ok)）
  let oldSeen = 0;
  let oldDiedAt = null;
  for (const [i, line] of rawLines.entries()) {
    try {
      strict.decode(line);
      oldSeen++;
    } catch {
      oldDiedAt = i;
      break;
    }
  }
  // 新策略：逐行 lossy 解码，一行不落（= relay_lines）
  const lossy = rawLines.map((l) => new TextDecoder('utf-8').decode(l));

  check(
    'S2',
    '真子进程输出含**非法 UTF-8** 的行时：旧策略（严格+遇错即停）**丢行**，新策略（lossy）**一行不丢** —— 这把 S1 的约束变成可观察后果',
    rawLines.length === 3 && oldSeen === 1 && oldDiedAt === 1 && lossy.length === 3,
    `总行=${rawLines.length} 旧策略读到=${oldSeen}行（停在第${oldDiedAt === null ? '-' : oldDiedAt + 1}行） 新策略=${lossy.length}行`,
  );
}

// ------------------------------------------------------------------ 输出

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

// ------------------------------------------------------------------ 反证

/// 每条变异 = 把某一处**改回缺陷形态**，并声明哪几条断言必须因此变红。
const MUTATIONS = [
  {
    name: 'M1 读子进程输出退回「严格 UTF-8 + 遇错即停」（= D-88 的原始缺陷形态）',
    // 锚点带上 `relay_lines(` 前缀以确保唯一定位（`map_while(Result::ok)` 已全仓不再出现）。
    find: '            relay_lines(out, |line| {',
    replace: '            for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {',
    expect: ['S1'],
  },
];

const readBytes = (f) => {
  try {
    return fs.readFileSync(f);
  } catch {
    return null;
  }
};

const main = () => {
  console.log(`子进程输出读取 · 根因钉子${REFUTE ? ' · 反证轮' : ''}`);

  if (!REFUTE) {
    runAll();
    const { fail } = printResults('子进程输出 · 根因钉子');
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
  const originals = new Map();

  console.log('\n破坏源文件 → 断言必须变红 → 按字节还原\n');
  for (const mut of MUTATIONS) {
    if (!originals.has(mut.file || SERVICE_RS))
      originals.set(mut.file || SERVICE_RS, readBytes(mut.file || SERVICE_RS));
    const file = mut.file || SERVICE_RS;
    const txt = originals.get(file).toString('utf8');
    if (!txt.includes(mut.find)) {
      console.log(`⚠ ${mut.name}\n    破坏锚点未找到（${path.relative(ROOT, file)}）—— 本条无法反证`);
      skipped += mut.expect.length;
      continue;
    }
    fs.writeFileSync(file, txt.replace(mut.find, mut.replace));

    // 🔴 还原一律进 `finally`：破坏若让 `runAll()` 抛异常，写在 try 之后的还原就不会执行，
    //    源文件会永久留成被破坏状态（E4 / E8 上都踩到过这一条）。
    let res = {};
    let roundErr = null;
    try {
      runAll();
      for (const r of results) res[r.id] = r;
    } catch (err) {
      roundErr = err;
    } finally {
      fs.writeFileSync(file, originals.get(file));
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
  let restoreFail = 0;
  for (const [f, snap] of originals) {
    const back = readBytes(f);
    const same = back != null && back.equals(snap);
    if (!same) restoreFail++;
    console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, f)} 字节${same ? '一致' : '不一致！'}`);
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红（应执行 ${expectedTotal} 条）`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（破坏锚点未找到）—— 跳过 ≠ 通过`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(', ')}`);
  process.exitCode = red === expectedTotal && skipped === 0 && restoreFail === 0 ? 0 : 1;
};

try {
  main();
} catch (err) {
  console.error(`\n脚本异常：${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
}
