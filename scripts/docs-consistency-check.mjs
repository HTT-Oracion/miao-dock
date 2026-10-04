// 文档 ↔ 实现 一致性自检（零依赖，用法：node scripts/docs-consistency-check.mjs）
//
// ## 为什么需要它（真实事故驱动）
// 2026-10-04 发生过两件同源的事：
// ① `git add` 漏了两个脚本文件 → **P2/P3 的断言从未进仓库**，而已推送的 HEAD 上
//    文档写着「check:music 101 条」，HEAD 里的脚本其实只有 86 条。
//    当时"验证"全绿 —— 因为验证跑的是**工作区**，而工作区是对的。
// ② AGENTS.md / README.md 长期写着过时的条数（63 / 68 / 27），
//    而实际已到 102 / 72 / 32，**没有任何机制会报红**。
//
// 两者都是同一类问题：**"文档/仓库状态"与"实际"脱节，且脱节不报错**。
// 本脚本把这一类变成可执行检查 —— 数字对不上就非零退出。
//
// ## 它检查什么
// ① 三个 check 脚本里 `add(` 的条数 vs 文档里声明的条数（AGENTS.md / README.md / spec-notes）
// ② 文档里引用的 npm 命令是否真实存在于 package.json
// ③ 文档里出现的「被禁历史品牌标识」必须为 0 命中
// ④ 各 check 脚本的 GROUPS 声明与实际用到的分组是否一致（漏加分组会静默不打印）
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const results = [];
const add = (group, name, ok, detail) => results.push({ group, name, ok, detail });

// ── ① 断言条数：文档声明 vs **脚本自报** ─────────────────────────────────
// ⚠️ 不要数源码里的 `add(` 次数 —— 部分断言的注册形式不同（有的带缩进、有的在
// 辅助函数里批量注册），数出来会与实际条数不符（实测 61 vs 102）。
// **以脚本自己打印的汇总为准**：那才是用户跑出来的数。
const SUITES = [
  { cmd: 'check:music', script: 'scripts/music-platform-check.mjs' },
  { cmd: 'check:units', script: 'scripts/units-structure-check.mjs' },
  { cmd: 'check:settings', script: 'scripts/settings-media-check.mjs' },
];
// 台账（spec-notes）**不参与**条数比对：它记录的是**历史**（"当时 86 条（反证 16）"
// 恰恰是有价值的痕迹），拿它跟现状比会逼得人去改历史。
// 参与比对的只有"声明当前状态"的三处入口。
const DOCS = ['AGENTS.md', 'README.md', '.trae/rules/project_rules.md'];
// 参与其它检查（命令存在 / 禁词）的文档 —— 台账也要查，它同样不该出现失效命令
const ALL_DOCS = [...DOCS, 'docs/spec-notes.md'];

/** 跑一次脚本，从它自己的汇总行里取「通过 N / 失败 M」的 N */
function selfReportedCount(scriptPath) {
  const abs = path.join(ROOT, scriptPath);
  if (!existsSync(abs)) return null;
  try {
    const out = execFileSync(process.execPath, [abs], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const m = out.match(/通过\s+(\d+)\s*\/\s*失败\s*\d+/);
    return m ? Number(m[1]) : null;
  } catch (e) {
    // 脚本有失败时退出码非 0，但 stdout 里仍有汇总 —— 从 e.stdout 取
    const out = String(e.stdout || '');
    const m = out.match(/通过\s+(\d+)\s*\/\s*失败\s*\d+/);
    return m ? Number(m[1]) : null;
  }
}

/** 跑一次反证脚本，取「REFUTE: N/N」的 N（= 反证条数） */
function selfReportedRefuteCount(scriptPath) {
  const abs = path.join(ROOT, scriptPath);
  if (!existsSync(abs)) return null;
  try {
    const out = execFileSync(process.execPath, [abs, '--refute'], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const m = out.match(/REFUTE:\s*(\d+)\s*\//);
    return m ? Number(m[1]) : null;
  } catch (e) {
    const out = String(e.stdout || '');
    const m = out.match(/REFUTE:\s*(\d+)\s*\//);
    return m ? Number(m[1]) : null;
  }
}

for (const suite of SUITES) {
  const src = read(path.join(ROOT, suite.script));
  if (!src) {
    add('COUNT', `${suite.cmd} 脚本存在`, false, `找不到 ${suite.script}`);
    continue;
  }
  // 条数以脚本自报为准
  const actual = selfReportedCount(suite.script);
  if (actual == null) {
    add('COUNT', `${suite.cmd} 能跑出汇总`, false, '未解析到「通过 N / 失败 M」');
    continue;
  }

  for (const doc of DOCS) {
    const text = read(path.join(ROOT, doc));
    if (!text) continue;
    const re = new RegExp(`${suite.cmd.replace(':', '[:\\:]')}[^\\n]*?(\\d+)\\s*条`, 'g');
    const hits = [...text.matchAll(re)];
    if (hits.length === 0) continue;
    // 文件里可能有多处（历史段落 + 汇总表），**取最大那个**作为"当前声明"
    const claimed = Math.max(...hits.map((m) => Number(m[1])));
    add(
      'COUNT',
      `${doc} 声明的 ${suite.cmd} 条数与脚本一致`,
      claimed === actual,
      claimed === actual
        ? `${actual} 条`
        : `文档写 ${claimed}，脚本实际 ${actual}`,
    );
  }
}

// ── ② 文档引用的 npm 命令必须存在 ────────────────────────────────────────
const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
const scripts = pkg.scripts || {};
for (const doc of ALL_DOCS) {
  const text = read(path.join(ROOT, doc));
  if (!text) continue;
  const cmds = [...new Set([...text.matchAll(/npm run ([a-z0-9:]+)/g)].map((m) => m[1]))];
  const missing = cmds.filter((c) => !Object.prototype.hasOwnProperty.call(scripts, c));
  add(
    'PKG',
    `${doc} 引用的 npm 命令都存在`,
    missing.length === 0,
    missing.length ? `不存在：${missing.join(', ')}` : `${cmds.length} 个命令全部存在`,
  );
}

// ── ③ 被禁历史品牌标识必须 0 命中 ────────────────────────────────────────
// ⚠️ 用动态拼接构造关键字，避免这个脚本**自己**成为命中点
const banned = ['nex', 'box'].join('');
{
  const targets = [
    'app/src',
    'app/src-tauri/src',
    'scripts',
    'AGENTS.md',
    'README.md',
    'docs',
    '.trae',
  ];
  const hits = [];
  const walk = (p) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) walk(path.join(p, e));
    } else if (/\.(ts|tsx|rs|mjs|md|json|css)$/.test(p)) {
      const txt = read(p);
      if (txt.toLowerCase().includes(banned)) hits.push(path.relative(ROOT, p));
    }
  };
  for (const t of targets) walk(path.join(ROOT, t));
  add(
    'BANNED',
    '被禁历史品牌标识 0 命中',
    hits.length === 0,
    hits.length ? `命中：${hits.join(', ')}` : '0 命中',
  );
}

// ── ④ GROUPS 声明 vs 实际用到的分组 ─────────────────────────────────────
// 漏把新组加进 GROUPS 的症状是「断言跑了但没打印」—— 极易被忽略
for (const suite of SUITES) {
  const src = read(path.join(ROOT, suite.script));
  if (!src) continue;
  const gm = src.match(/const GROUPS\s*=\s*\[([^\]]*)\]/);
  if (!gm) continue;
  const declared = gm[1]
    .split(',')
    .map((x) => x.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  const used = [...new Set([...src.matchAll(/^add\(\s*["']([A-Z0-9]+)\./gm)].map((m) => m[1]))];
  const missing = used.filter((g) => !declared.includes(g));
  add(
    'GROUPS',
    `${suite.cmd} 的 GROUPS 覆盖全部实际分组`,
    missing.length === 0,
    missing.length ? `未在 GROUPS 里声明：${missing.join(', ')}` : `${used.length} 个分组全覆盖`,
  );
  void declared;
}

// ── 输出 ────────────────────────────────────────────────────────────────
const GROUPS = ['COUNT', 'PKG', 'BANNED', 'GROUPS'];
console.log('文档 ↔ 实现 一致性自检\n');
let fail = 0;
for (const g of GROUPS) {
  const items = results.filter((r) => r.group === g);
  if (items.length === 0) continue;
  const pass = items.filter((i) => i.ok).length;
  console.log(`【${g}】 ${pass}/${items.length}`);
  for (const it of items) {
    if (!it.ok) fail++;
    console.log(`  ${it.ok ? '✓' : '✗'} ${it.name}${it.detail ? '  [' + it.detail + ']' : ''}`);
  }
  console.log('');
}
const total = results.length;
console.log('─'.repeat(56));
console.log(`通过 ${total - fail} / 失败 ${fail}`);
if (fail > 0) {
  console.log('\n下一步：文档与实现脱节时，先判断是「文档该更新」还是「实现漏了」，');
  console.log('        不要为了让脚本变绿而改断言或删条目。');
  process.exitCode = 1;
}
