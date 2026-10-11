#!/usr/bin/env node
/**
 * service 层「依赖方向」钉子 —— 且必须可反证
 * ================================================================
 * ## 为什么值得单列
 * `AGENTS.md` §1 写着「`service/src/` 根只留跨模块底座」，但**没有任何机器判据** ——
 * 于是「底座 import 业务域」这种事只能靠人眼看 diff（审计 §13.1 正是这么发现的：
 * `engine-client.mjs` 底座曾 import `manga/image.mjs` 域模块）。
 * 一条 import 越界不会让任何测试变红，只会让"域能单独理解/单独测"这个前提慢慢失效。
 *
 * ## 钉的是方向，不是风格
 *   L0 `service/src/*.mjs` 的文件集 == 白名单。新增底座要**显式登记**（同 units MANIFEST 的做法）——
 *      否则"随手在根建一个模块"会让底座层无声膨胀。
 *   L1 底座层**不得** import `./manga/**`（业务域）。
 *   L2 底座层对 `./settings/**` 的导入**仅限 `engine-settings.mjs`** ——
 *      `config.mjs` 是组合根，读"用户可调引擎设置"是它的本分（其余 settings 模块属域层，
 *      底座碰不得）。
 *
 * ## 反证轮（`--refute`）
 *   只在内存里改源码字符串 / 增删文件条目 → 对应断言必须变红。**不碰工作区**。
 *
 * ⚠️ 边界：本脚本判的是**目录级的依赖方向**，不判"这个函数该不该在那"。
 *
 * 用法：
 *   node e2e/service/layering-check.mjs            正向跑（期望全绿）
 *   node e2e/service/layering-check.mjs --refute   反证轮
 *
 * 约束：纯 Node、零依赖、不起任何进程、不动工作区。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, 'service', 'src');
const REFUTE = process.argv.includes('--refute');

/** 底座层白名单（`service/src/` 根的 .mjs；不含子目录）。新增须在此登记 + 同步 AGENTS.md §1。 */
const BASE_MANIFEST = [
  'server.mjs',        // 装配入口
  'config.mjs',        // 运行期配置（组合根）
  'errors.mjs',
  'engine-client.mjs', // 引擎适配，唯一耦合点
  'multipart.mjs',
  'parent-watch.mjs',
  'atomic-file.mjs',   // 原子写 JSON（D-139）
  'image.mjs',         // 图片字节嗅探（D-141 从 manga/ 上移：底座不应依赖域）
];

/** 底座层对 `settings/` 的唯一允许导入（config 作为组合根读用户设置）。 */
const SETTINGS_ALLOW = './settings/engine-settings.mjs';

/** 装配入口（组合根）：把各域拼起来是它的**职责**，故不受 L1/L2 约束。 */
const ASSEMBLY = 'server.mjs';

/** 读入 `service/src/*.mjs`（不递归）。返回 { name: source }。 */
function readBase() {
  const files = {};
  for (const n of fs.readdirSync(SRC)) {
    if (!n.endsWith('.mjs')) continue;
    const p = path.join(SRC, n);
    if (!fs.statSync(p).isFile()) continue;
    files[n] = fs.readFileSync(p, 'utf8');
  }
  return files;
}

/** 取某文件所有 `import … from '<rel>'` 的相对目标（`./` 或 `../` 开头）。 */
function relImports(src) {
  const out = [];
  const re = /from\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

/** 纯函数：给定文件表，产出断言结果。反证轮喂变异后的表。 */
function evaluate(files) {
  const out = [];
  const add = (id, label, ok, detail) => out.push({ id, label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

  const names = Object.keys(files).sort();

  // ---- L0：底座层文件集 == 白名单 ----
  const expected = [...BASE_MANIFEST].sort();
  const extra = names.filter((n) => !expected.includes(n));
  const missing = expected.filter((n) => !names.includes(n));
  add('L0', `service/src 根的文件集 == 白名单（新增底座须显式登记）`,
    extra.length === 0 && missing.length === 0,
    extra.length || missing.length ? `多：${extra.join(',') || '-'} 少：${missing.join(',') || '-'}` : `${names.length} 个`);

  // ---- L1：底座层（除装配入口）不得 import ./manga/** ----
  const mangaHits = [];
  for (const n of names) {
    if (n === ASSEMBLY) continue;
    for (const rel of relImports(files[n])) {
      if (/^\.\/manga\//.test(rel)) mangaHits.push(`${n} → ${rel}`);
    }
  }
  add('L1', '底座层（装配入口 server.mjs 除外）不得 import ./manga/**（业务域）', mangaHits.length === 0,
    mangaHits.length ? mangaHits.join(' · ') : '');

  // ---- L2：底座层（除装配入口）对 settings 的导入仅限 engine-settings.mjs ----
  const badSettings = [];
  for (const n of names) {
    if (n === ASSEMBLY) continue;
    for (const rel of relImports(files[n])) {
      if (/^\.\/settings\//.test(rel) && rel !== SETTINGS_ALLOW) badSettings.push(`${n} → ${rel}`);
    }
  }
  add('L2', `底座层（装配入口除外）对 settings/ 的导入仅限 engine-settings.mjs（组合根读用户设置的唯一入口）`,
    badSettings.length === 0, badSettings.length ? badSettings.join(' · ') : '');

  return out;
}

function printResults(rows) {
  console.log('\n【service 依赖方向钉子】');
  let fail = 0;
  for (const r of rows) {
    if (!r.ok) fail++;
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.id} ${r.label}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log('\n' + '─'.repeat(56));
  console.log(`通过 ${rows.length - fail} / 失败 ${fail}`);
  return fail;
}

/// 每条变异 = 把方向改回违规形态（内存变异），并声明哪些断言必须变红。
const MUTATIONS = [
  {
    name: 'M1 让底座 engine-client 反向 import 业务域 manga/image.mjs',
    apply: (f) => ({ ...f, 'engine-client.mjs': f['engine-client.mjs'].replace("from './image.mjs'", "from './manga/image.mjs'") }),
    expect: ['L1'],
  },
  {
    name: 'M2 让底座 config 去 import 域层 settings/idle-policy.mjs',
    apply: (f) => ({ ...f, 'config.mjs': f['config.mjs'].replace("from './settings/engine-settings.mjs'", "from './settings/idle-policy.mjs'") }),
    expect: ['L2'],
  },
  {
    name: 'M3 在底座根随手新增一个未登记的模块',
    apply: (f) => ({ ...f, 'helper.mjs': 'export const x = 1;\n' }),
    expect: ['L0'],
  },
];

const main = () => {
  console.log(`service 依赖方向钉子${REFUTE ? ' · 反证轮' : ''}`);
  const files = readBase();

  if (!REFUTE) {
    process.exitCode = printResults(evaluate(files)) === 0 ? 0 : 1;
    return;
  }

  const baseline = evaluate(files);
  const wasGreen = {};
  for (const r of baseline) wasGreen[r.id] = r.ok;
  const baselineRed = baseline.filter((r) => !r.ok).map((r) => r.id);

  const expectedTotal = MUTATIONS.reduce((n, m) => n + m.expect.length, 0);
  let total = 0;
  let red = 0;
  let skipped = 0;
  const falsePositives = [];

  console.log('\n内存变异依赖方向 → 断言必须变红（不碰工作区）\n');
  for (const mut of MUTATIONS) {
    const mutated = mut.apply(files);
    const changed = Object.keys(mutated).length !== Object.keys(files).length
      || Object.keys(files).some((k) => mutated[k] !== files[k]);
    if (!changed) {
      console.log(`⚠ ${mut.name}\n    变异锚点未命中（源码已改？）—— 本条无法反证`);
      skipped += mut.expect.length;
      continue;
    }
    const byId = {};
    for (const r of evaluate(mutated)) byId[r.id] = r;

    console.log(`🔴 ${mut.name}`);
    for (const id of mut.expect) {
      total++;
      if (byId[id] && byId[id].ok === false) {
        red++;
        console.log(`  ✓ ${id} 按预期变红`);
      } else {
        falsePositives.push(id);
        console.log(`  ✗ ${id} 该红没红 ← 假阳性`);
      }
      if (!wasGreen[id]) console.log('     注：该条基线本就是红，无法据此判定断言有效性');
    }
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红（应执行 ${expectedTotal} 条）`);
  if (baselineRed.length) console.log(`✗ 基线存在红条：${baselineRed.join(', ')} —— 先修基线再谈反证`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（变异锚点未命中）—— 跳过 ≠ 通过`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(', ')}`);
  process.exitCode = red === expectedTotal && skipped === 0 && baselineRed.length === 0 ? 0 : 1;
};

try {
  main();
} catch (err) {
  console.error(`\n脚本异常：${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
}
