// 现行文档里引用的仓库路径必须真实存在（审计 §9「文档漂移」的机器化）。
//
// ## 为什么需要它
// 文档写错路径**不会报错**，但新人照着 `AGENTS.md` 的域目录清单去找文件会找不到；
// 更糟的一类：文档说「已改成 X」而代码里还是 Y —— 那种漂移连 grep 都难发现。
// 本脚本把这一类变成可执行检查：路径不存在就非零退出。
//
// ## 检查范围（**只查现行文档**）
//   AGENTS.md · README.md · docs/internal/spec-notes-1.md · .trae/rules/project_rules.md
// 🔴 `docs/internal/spec-notes.md` **明确不在范围**：它已封卷于 D-136（文件头明写），
//    里面有大量历史路径（`service/scripts/selftest.mjs` 等，实际已迁到 `e2e/service/`）——
//    历史痕迹本身有价值，改它才是错。要查旧路径请查续篇。
//
// ## 匹配规则（刻意收得很窄，避免误报）
//   反引号包裹 + 已知顶层目录 + 带扩展名的**文件**路径。
//   🔴 顶层目录表里**故意留着 `app/` 与 `service/`** —— 它们都是「现在不该存在」的旧形态：
//   留着不是遗漏，而是让"文档又写回 `app/src/...`"这种回退**当场变红**（表里删掉就变成静默跳过）。
//   不收目录（`service/src/manga/` 这类在文档里常被泛泛提及，误报率高），
//   不收裸文本（会把"曾经的 foo.ts"这种叙述算进来）。
//   🔴 例外：tauri 配置里声明的**包内落点**（`bundle.resources` 的「值」）不按仓库路径判 ——
//   它们本就只存在于包里，最典型是 D-211：`engine/wheels.manifest.json` 在包内改名成
//   `engine/wheel-manifest.json`（避开与 `engine/wheels/` 目录同名）。文档把包内落点写成
//   反引号路径是**对的**，判据只该钉「仓库里该有的文件」，故把配置声明的落点并入允许集合。
//   依据是**配置本身**：配置里删掉这条落点，文档的引用就会重新变红（不会假绿）。
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { cachedReadText, overrideFile, clearOverrides } from './_file-cache.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const LIVE_DOCS = [
  'AGENTS.md',
  'README.md',
  'docs/internal/spec-notes-1.md',
  'docs/dev-setup.md',
  '.trae/rules/project_rules.md',
];
const PATH_RE =
  /`((?:src|src-tauri|public|scripts|e2e|docs|engine|service|app)\/[\w./-]+\.(?:mjs|ts|tsx|rs|md|json|scss|css|html))`/g;

/** tauri 配置里声明的**包内落点**（`bundle.resources` 的「值」）。这些是装进包里的名字，
 *  仓库里本就不该有同名文件（D-211 的 `engine/wheel-manifest.json` 即为避开与
 *  `engine/wheels/` 目录同名而改的名）。依据是配置本身，不是给某个名字开后门。 */
function bundleTargets() {
  const out = new Set();
  for (const cfg of ['tauri.conf.json', 'tauri.windows.conf.json']) {
    const txt = cachedReadText(path.join(ROOT, 'src-tauri', cfg));
    if (!txt) continue;
    try {
      const res = JSON.parse(txt)?.bundle?.resources;
      const vals = Array.isArray(res) ? res : res && typeof res === 'object' ? Object.values(res) : [];
      for (const v of vals) if (typeof v === 'string') out.add(v);
    } catch {
      // 配置读不动就当没有包内落点：判据退回「只认仓库路径」（只会假红，不会假绿）
    }
  }
  return out;
}

/**
 * 被 `.gitignore` 声明忽略的路径 —— 它们**不在仓库里**（构建产物等），文档不该写成仓库文件。
 *
 * 🔴 为什么必须查这一条：`existsSync` 只看得见**本机**文件系统。像
 *    `src-tauri/gen/schemas/acl-manifests.json` 这种 Tauri 构建产物，
 *    跑过 `npm run app` 的机器上**存在**、全新克隆（CI）上**不存在** ——
 *    于是本地永远绿、CI 必红（2026-10-30 就是这样挂的）。
 *    判据来自 git 自身（`.gitignore` 是仓库配置），不是给某个文件名开后门。
 */
function ignoredSet(paths) {
  if (paths.length === 0) return new Set();
  const parse = (s) =>
    new Set(
      String(s ?? '')
        .split(/\r?\n/)
        .filter(Boolean),
    );
  try {
    return parse(
      execFileSync('git', ['check-ignore', '--stdin'], {
        cwd: ROOT,
        input: paths.join('\n'),
        encoding: 'utf8',
      }),
    );
  } catch (e) {
    // `check-ignore` 在「一条都没命中」时退出码为 1，此时命中项仍写在 stdout 里
    return parse(e.stdout);
  }
}

function runAll() {
  const BUNDLE = bundleTargets();
  const scan = LIVE_DOCS.map((d) => {
    const abs = path.join(ROOT, d);
    if (!existsSync(abs)) return { d, txt: null, hits: [] };
    const txt = cachedReadText(abs);
    const hits = [];
    PATH_RE.lastIndex = 0;
    let m;
    while ((m = PATH_RE.exec(txt))) hits.push(m[1]);
    return { d, txt, hits };
  });
  // 一次 git 调用判完全部引用，避免逐条 spawn
  const IGNORED = ignoredSet([...new Set(scan.flatMap((s) => s.hits))].filter((p) => !BUNDLE.has(p)));

  return scan.map(({ d, txt, hits }) => {
    if (txt === null) return { name: `DOCS.path.${d}`, ok: false, detail: '文档自身不存在' };
    const missing = [];
    for (const rel of hits) {
      if (BUNDLE.has(rel)) continue; // 包内落点：仓库里没有是**对的**
      if (IGNORED.has(rel)) {
        missing.push(`${rel}（被 .gitignore 忽略，不是仓库文件）`);
        continue;
      }
      if (!existsSync(path.join(ROOT, rel))) missing.push(rel);
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
    find: 'npm run check:full',
    replace: 'npm run check:full\n\n> 反证：`service/src/no-such-file.mjs` 应当不存在',
    expect: ['DOCS.path.AGENTS.md'],
  },
  {
    name: '在 project_rules.md 里插一个不存在的路径',
    file: '.trae/rules/project_rules.md',
    find: 'screens/manga/meta.ts',
    replace: 'screens/manga/meta.ts` 与 `src/nope/gone.ts',
    expect: ['DOCS.path..trae/rules/project_rules.md'],
  },
  {
    /*
     * 这条专钉「本机存在 ⇒ 本地永远绿」那个漏洞（2026-10-30 CI 挂的正是它）。
     * 靶子是 Tauri 构建产物：跑过构建的机器上有文件、全新克隆里没有。
     * 判据若只靠 `existsSync`，本条在开发机上**不会变红**（假绿）—— 现在靠 `.gitignore` 判。
     */
    name: '在 AGENTS.md 里引用被 .gitignore 忽略的构建产物（本机存在、克隆里没有）',
    file: 'AGENTS.md',
    find: 'npm run check:nightly',
    replace: 'npm run check:nightly\n\n> 反证：`src-tauri/gen/schemas/acl-manifests.json` 不属于仓库',
    expect: ['DOCS.path.AGENTS.md'],
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
