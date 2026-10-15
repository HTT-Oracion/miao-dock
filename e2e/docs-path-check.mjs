// 现行文档里引用的仓库路径必须真实存在（审计 §9「文档漂移」的机器化）。
//
// ## 为什么需要它
// 文档写错路径**不会报错**，但新人照着 `AGENTS.md` 的域目录清单去找文件会找不到；
// 更糟的一类：文档说「已改成 X」而代码里还是 Y —— 那种漂移连 grep 都难发现。
// 本脚本把这一类变成可执行检查：路径不存在就非零退出。
//
// ## 检查范围（**只查现行文档**）
//   AGENTS.md · README.md · docs/spec-notes-1.md · .trae/rules/project_rules.md
// 🔴 `docs/spec-notes.md` **明确不在范围**：它已封卷于 D-136（文件头明写），
//    里面有大量历史路径（`service/scripts/selftest.mjs` 等，实际已迁到 `e2e/service/`）——
//    历史痕迹本身有价值，改它才是错。要查旧路径请查续篇。
//
// ## 匹配规则（刻意收得很窄，避免误报）
//   反引号包裹 + 已知顶层目录 + 带扩展名的**文件**路径。
//   🔴 顶层目录表里**故意留着 `app/` 与 `service/`** —— 它们都是「现在不该存在」的旧形态：
//   留着不是遗漏，而是让"文档又写回 `app/src/...`"这种回退**当场变红**（表里删掉就变成静默跳过）。
//   不收目录（`service/src/manga/` 这类在文档里常被泛泛提及，误报率高），
//   不收裸文本（会把"曾经的 foo.ts"这种叙述算进来）。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cachedReadText, overrideFile, clearOverrides } from './_file-cache.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const LIVE_DOCS = [
  'AGENTS.md',
  'README.md',
  'docs/spec-notes-1.md',
  'docs/dev-setup.md',
  '.trae/rules/project_rules.md',
];
const PATH_RE =
  /`((?:src|src-tauri|public|scripts|e2e|docs|engine|service|app)\/[\w./-]+\.(?:mjs|ts|tsx|rs|md|json|scss|css|html))`/g;

function runAll() {
  return LIVE_DOCS.map((d) => {
    const abs = path.join(ROOT, d);
    if (!existsSync(abs)) return { name: `DOCS.path.${d}`, ok: false, detail: '文档自身不存在' };
    const txt = cachedReadText(abs);
    const missing = [];
    PATH_RE.lastIndex = 0;
    let m;
    while ((m = PATH_RE.exec(txt))) {
      if (!existsSync(path.join(ROOT, m[1]))) missing.push(m[1]);
    }
    return {
      name: `DOCS.path.${d}`,
      ok: missing.length === 0,
      detail: missing.length ? `引用了不存在的路径：${missing.join('、')}` : '',
    };
  });
}

// ── 反证：每条变异把一条路径引用改成不存在的，对应断言必须变红 ─────────────
const MUTATIONS = [
  {
    name: '在 AGENTS.md 里插一个不存在的仓库路径（文档漂移复发时的形状）',
    file: 'AGENTS.md',
    find: 'npm run task -- check:docs',
    replace: 'npm run task -- check:docs\n\n> 反证：`service/src/no-such-file.mjs` 应当不存在',
    expect: ['DOCS.path.AGENTS.md'],
  },
  {
    name: '在 project_rules.md 里插一个不存在的路径',
    file: '.trae/rules/project_rules.md',
    find: 'screens/library/meta.ts',
    replace: 'screens/library/meta.ts` 与 `src/nope/gone.ts',
    expect: ['DOCS.path..trae/rules/project_rules.md'],
  },
];

if (process.argv.includes('--refute')) {
  let total = 0,
    passed = 0,
    skipped = 0;
  for (const mut of MUTATIONS) {
    const file = path.resolve(ROOT, mut.file);
    const original = readFileSync(file);
    const txt = original.toString('utf8');
    const eol = txt.includes('\r\n') ? '\r\n' : '\n';
    const find = txt.includes(mut.find) ? mut.find : mut.find.split('\n').join(eol);
    if (!txt.includes(find)) {
      console.log(`⚠ ${mut.name}\n    破坏锚点未找到（源文件已变？）—— 本条无法反证`);
      skipped += mut.expect.length;
      continue;
    }
    overrideFile(file, txt.replace(find, mut.replace.split('\n').join(eol)));
    const res = runAll();
    for (const id of mut.expect) {
      total++;
      const r = res.find((x) => x.name === id);
      if (r && !r.ok) {
        passed++;
        console.log(`🔴 ${mut.name} → ${id} 按预期变红`);
      } else console.log(`✗ ${mut.name} → ${id} **没有变红**（假阳性！）`);
    }
    clearOverrides();
  }
  console.log(`\nREFUTE: ${passed}/${total} 条按预期变红（应执行 ${total} 条）`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（锚点未找到）—— 跳过 ≠ 通过`);
  process.exit(passed === total && skipped === 0 ? 0 : 1);
}

const res = runAll();
for (const r of res) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`);
const failed = res.filter((r) => !r.ok).length;
console.log(`\n通过 ${res.length - failed} / 失败 ${failed}`);
process.exit(failed ? 1 : 0);
