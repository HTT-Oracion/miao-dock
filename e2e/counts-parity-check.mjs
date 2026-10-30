// 条数对账：AGENTS.md §3 里 **static 层**那批 check 的「N 条」必须与脚本自报一致（零依赖）
//
// ## 为什么需要它
// 2026-10-16 核对时发现：§3 里十几个条数声明已经漂移 —— `check:tls` 写 14 实际 9、
// `check:bundle` 写 15 实际 16、`check:pydensecrf-wheel` 写 13 实际 20、
// `check:docpaths` 写 5 实际 4、`check:quit` 写 5 实际 4（有一条既有反证锚点缺失）。
// 漂移**不会报错**：文档说 14、脚本跑出 9，两处各自都"正常"，只有人去数才发现。
// 本脚本把这一类变成可执行检查。
//
// ## 口径（重要，别扩大范围）
// ① 只对 **static 层**（秒级可跑的那批）做机器对账 —— service / nightly 动辄起真进程、
//    分钟级，塞进 static 门会让闸门从 10s 变成 4 分钟，那等于没有门。
// ② 只对**正向条数**对账：反证轮要额外跑一遍每个脚本的 `--refute`，代价翻倍且各脚本
//    汇总行格式不统一。反证条数在文档里保留为**参考值**，跑一次 `--refute` 才知道真相。
// ③ **`check:docs` 已对账的那四个套件本脚本跳过**（music / units / settings / autostart，
//    见 `docs-consistency-check.mjs` 的 SUITES）：它们各自要跑 10s 量级，再跑一遍等于把
//    static 门从 10s 抬到 60s。跳过的是"重复劳动"，不是"放过"—— 那四条由 `check:docs`
//    对 AGENTS.md / README.md / project_rules.md 三处声明一起钉着。
// ④ 因此 §3 里 service / nightly 那批的数字是**人工快照**，本脚本不碰它们 ——
//    这一点写在 AGENTS.md §3 的口径说明里，读者不会误以为它们也被钉着。
//
// ## 反证轮要覆盖**两个方向**
// 漂移有两端，只测一端等于没测：文档改了（脚本没变）与**脚本变了**（文档没跟）。
// 故三条破坏是：改小文档数字 ⇒ `staticParity` 红 · 把「N 条」改成「N 项」⇒
// `staticDeclared` 红 · **删掉某个脚本里的一条钉子**（自报 9→8）⇒ `staticParity` 红。
// 🔴 第三条必须**真改盘**：被对账的脚本是本进程用 `execFileSync` 起的**子进程**，
//    内存覆盖层对它不可见（见 `_file-cache.mjs` 里「改盘 vs 覆盖」的说明），
//    因此跑完按字节还原并复核 —— 留下一个被改坏的脚本比没测更糟。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cachedReadText, overrideFile, clearOverrides } from './_file-cache.mjs';
import { buildCommands } from './_commands.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/*
 * 🔴 2026-10-28 起，条数声明的**唯一事实源**是 `docs/internal/commands.md`。
 *
 * 原来它读 `AGENTS.md` §3 —— 那份文件同时承担入口、分层规范、工程纪律、命令参考、
 * 决策台账、环境陷阱六件事，120 行的命令区里有 48 行超 200 字符、31 行是历史/根因叙述。
 * 把命令表搬出去之后，AGENTS 只写"跑哪四条"，本脚本跟着改读新文件。
 *
 * ⚠️ 扫描目标变了，但**判据没变**：文档写的 N 条仍须 == 脚本自报数。
 */
const COMMANDS_DOC = path.join(ROOT, 'docs', 'internal', 'commands.md');
const AGENTS = path.join(ROOT, 'AGENTS.md');
const README = path.join(ROOT, 'README.md');

/** `check:docs` 已经机器对账过条数的套件（本脚本不重复跑，理由见文件头③） */
const DOCS_COVERED = new Set(['check:music', 'check:units', 'check:settings', 'check:autostart']);

/**
 * 自己也不进对账范围 —— **自指**：本脚本绿时是 2/2，红时只有 1 条通过。
 * 若把自己算进去，"文档写 2"会在它红的那一刻变成新的红 ⇒ 越修越红，且修不好。
 */
const SELF = 'check:counts';

const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });

/** static 层的清单条目（id + cmd），去掉 `check:docs` 已覆盖的那几个。条目字段见 `_commands.mjs` */
const STATIC = buildCommands()
  .filter((c) => c.group === 'static')
  .filter((c) => !DOCS_COVERED.has(c.id) && c.id !== SELF);

/** 从任意一种汇总行里取正向条数（各脚本格式不一，见文件头②） */
function selfReported(out) {
  const rules = [
    /通过\s+(\d+)\s*\/\s*失败\s*\d+/,
    /(\d+)\s*通过\s*\/\s*\d+\s*失败/,
    /"pass":\s*(\d+)/,
    /(\d+)\s*\/\s*\d+\s*通过/,
  ];
  for (const r of rules) {
    const m = out.match(r);
    if (m) return Number(m[1]);
  }
  return null;
}

function runScript(cmd) {
  // 清单里的 cmd 形如 `node e2e/xxx.mjs`（已含解释器）⇒ 用本进程的 node 顶上，
  // 别再套一层 process.execPath，否则等于 `node node e2e/xxx.mjs`（MODULE_NOT_FOUND）。
  const parts = cmd.split(/\s+/);
  const exe = parts[0] === 'node' ? process.execPath : parts[0];
  const args = parts[0] === 'node' ? parts.slice(1) : parts;
  try {
    return execFileSync(exe, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // 非零退出时 stdout 里仍有汇总行（既有红就是这么被读到的）
    return String(e.stdout || '') + String(e.stderr || '');
  }
}

/** 每个 static 项的「声明条数」；没声明返回 null */
function declaredCount(docText, id) {
  /*
   * 形态（`docs/internal/commands.md` 的表格）：
   *   | `npm run task -- check:xxx[:refute]` | 说明 … · **N 条** |
   * 与旧版（`AGENTS.md` §3 的 `命令 # 说明`）的差别只是分隔符从 `#` 变成 `|`。
   * 两种都认，免得文档再改一次排版就静默失配。
   */
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`npm run task -- ${esc}(?:\\[:refute\\])?[\`\\s|]*(?:\\||#)([^\\n|]*)`);
  const m = docText.match(re);
  if (!m) return null;
  const n = m[1].match(/(\d+)\s*\**\s*条/);
  return n ? Number(n[1]) : null;
}

/** 条数声明所在的正文（`commands.md` 全表；它本身就是"§3"那份内容的唯一事实源） */
function section3(text) {
  return text;
}

/**
 * 防回退：`AGENTS.md` / `README.md` 里**不许**再出现「check 命令 + N 条」的声明。
 *
 * 两张表必然漂移（2026-10 首次核对就抓到五处）。命令表搬进 `commands.md` 之后，
 * 这两份文件只允许指向它；谁再抄一行带条数的命令说明，这条就红。
 */
function strayDeclarations(agents, readme) {
  const bad = [];
  for (const [name, text] of [
    ['AGENTS.md', agents],
    ['README.md', readme],
  ]) {
    for (const m of text.matchAll(/^.*npm run task -- check:[^\s|]*.*$/gm)) {
      if (/(\d+)\s*\**\s*条/.test(m[0])) bad.push(`${name}: ${m[0].trim().slice(0, 60)}…`);
    }
  }
  return bad;
}

function runAll() {
  const doc = cachedReadText(COMMANDS_DOC);
  const s3 = section3(doc);

  const missing = [];
  const drifted = [];
  let checked = 0;

  for (const c of STATIC) {
    const declared = declaredCount(s3, c.id);
    if (declared == null) {
      missing.push(c.id);
      continue;
    }
    const actual = selfReported(runScript(c.cmd));
    checked++;
    if (actual == null) {
      drifted.push(`${c.id}：脚本没打出自报条数（抓不到汇总行）`);
    } else if (actual !== declared) {
      drifted.push(`${c.id}：文档写 ${declared}，脚本实际 ${actual}`);
    }
  }

  add(
    'COUNTS.staticDeclared',
    missing.length === 0,
    missing.length ? `commands.md 没写条数：${missing.join('、')}` : `${STATIC.length} 项全部声明`,
  );
  add('COUNTS.staticParity', drifted.length === 0, drifted.length ? drifted.join('；') : `${checked} 项与脚本自报一致`);

  // 防回退：命令表只许有一份
  const stray = strayDeclarations(cachedReadText(AGENTS), cachedReadText(README));
  add(
    'COUNTS.singleSource',
    stray.length === 0,
    stray.length
      ? `命令条数只许写在 docs/internal/commands.md：${stray.join('；')}`
      : 'AGENTS / README 未再声明 check 条数',
  );
}

const REFUTE = process.argv.includes('--refute');

console.log('条数对账（AGENTS.md §3 ↔ static 层脚本自报）' + (REFUTE ? ' · 反证轮' : ''));
console.log(`根目录：${ROOT}`);
console.log(`对账范围：static 层 ${STATIC.length} 项（service / nightly 不进机器对账，见文件头口径）\n`);

if (!REFUTE) {
  runAll();
  const pass = results.filter((r) => r.ok).length;
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`);
  console.log('\n' + '─'.repeat(56));
  console.log(`通过 ${pass} / 失败 ${results.length - pass}`);
  if (pass !== results.length) process.exitCode = 1;
} else {
  /*
   * 反证轮：三条破坏，覆盖漂移的**两端**。
   * 破坏面有两种，机制不同（不是绕路，是被测对象决定的）：
   *  · `AGENTS.md` —— 本进程自己读它 ⇒ 走内存覆盖层（不写盘）。
   *  · 被对账的脚本 —— 本进程把它当子进程跑 ⇒ 覆盖层不可见，只能真改盘。
   */
  const MUTATIONS = [
    {
      name: '把 check:tls 的条数改小（文档说 9、脚本跑出 9 以外的任何数）',
      file: AGENTS,
      find: 'npm run task -- check:tls             # TLS 依赖链 9 条（三层）',
      replace: 'npm run task -- check:tls             # TLS 依赖链 8 条（三层）',
      expect: ['COUNTS.staticParity'],
    },
    {
      name: '把 check:ia 的条数从「N 条」改成「N 项」（声明消失，而没人会发现）',
      file: AGENTS,
      find: 'npm run task -- check:ia              # IA 结构 32 条',
      replace: 'npm run task -- check:ia              # IA 结构 32 项',
      expect: ['COUNTS.staticDeclared'],
    },
    {
      name: '删掉 check:tls 的一条钉子（脚本自报 9 → 8，文档没跟）—— 漂移的另一端',
      file: path.join(ROOT, 'e2e', 'tls-check.mjs'),
      find: "ok(/reqwest\\s*=/.test(toml), 'Cargo.toml 声明了 reqwest');",
      replace: '// 反证：这条钉子被删掉（模拟"脚本少了一条、文档没跟"）',
      expect: ['COUNTS.staticParity'],
    },
  ];

  const base = {};
  runAll();
  for (const r of results) base[r.name] = r.ok;

  let red = 0;
  let total = 0;
  let skipped = 0;
  let restoreFail = 0;

  /** 一条破坏跑完后的判定（两种破坏面共用） */
  const judge = (mut) => {
    console.log(`🔴 ${mut.name}`);
    for (const id of mut.expect) {
      total++;
      const isRed = results.find((r) => r.name === id)?.ok === false;
      if (isRed) {
        red++;
        console.log(`  ✓ ${id} 按预期变红`);
      } else {
        console.log(`  ✗ ${id} 该红没红 ← 假阳性`);
      }
      if (!base[id]) console.log(`     注：${id} 基线本就是红，无法据此判定断言有效性`);
    }
  };

  console.log('\n破坏源文件 → 断言必须变红 → 还原\n');
  for (const mut of MUTATIONS) {
    if (mut.file !== AGENTS) {
      // 改盘的那条：跑完必须**按字节还原**并复核（坏脚本留在盘上比没测更糟）
      const original = readFileSync(mut.file);
      if (!original.toString('utf8').includes(mut.find)) {
        console.log(`⚠ ${mut.name}\n    破坏锚点未找到（脚本写法变了？）—— 本条无法反证`);
        skipped += mut.expect.length;
        continue;
      }
      writeFileSync(mut.file, original.toString('utf8').replace(mut.find, mut.replace));
      try {
        results.length = 0;
        runAll();
        judge(mut);
      } finally {
        writeFileSync(mut.file, original);
        if (!readFileSync(mut.file).equals(original)) {
          restoreFail++;
          console.log(`  ✗ ${path.relative(ROOT, mut.file)} 未按字节还原！`);
        }
      }
      continue;
    }

    const original = cachedReadText(AGENTS);
    if (!original.includes(mut.find)) {
      console.log(`⚠ ${mut.name}\n    破坏锚点未找到（AGENTS.md 的写法变了？）—— 本条无法反证`);
      skipped += mut.expect.length;
      continue;
    }
    overrideFile(AGENTS, original.replace(mut.find, mut.replace));
    results.length = 0;
    runAll();
    judge(mut);
    overrideFile(AGENTS, null);
  }
  clearOverrides();

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红（应执行 ${total} 条）`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（锚点未找到）—— 跳过 ≠ 通过`);
  if (restoreFail) console.log(`✗ 有 ${restoreFail} 个文件未按字节还原`);
  if (red !== total || skipped || restoreFail) process.exitCode = 1;
}
