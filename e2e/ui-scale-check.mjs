#!/usr/bin/env node
/**
 * 字号分档（`--ui-scale`）的构建期钉子
 * =============================================================================
 * 这一组的特殊性：**源码里看不到最终结果**。源码始终写 `font-size: 9.5px`，
 * 换算发生在编译产物里（见台账 D-347）。所以"字号到底有没有跟随视口"这件事
 * grep 源码查不出来，而构建配置一旦被改坏，界面会**静默退回不缩放**。
 *
 *   S1 插件确实被注册进 `plugins`（钩子写了没挂 = 什么都不发生，且不报错）
 *   S2 dev 与 build 两个阶段各挂一个钩子，且共用同一份 `scaleFonts`
 *      —— 实测过：只挂 transform 时 dev 正常、产物里 530 条字号仍是纯 px
 *   S3 换算**行为**正确（用配置里那份正则本尊跑一遍）：纯 px 命中并产出设计稿形式；
 *      `clamp(...)` 与 `var(--…)` 不命中（前者已随视口变、后者是用户设定的字面承诺）
 *   S4 五档的**值与断点**逐条等于设计稿：≥1500→1.06、≥1720→1.12、≥1920→1.18、≤1180→.95、默认 1
 *   S5 番剧就地不跟随：`.an-root { --ui-scale: 1 }`
 *      （按文件排除在 build 阶段失效 —— 产物里所有分片已合并成一个 CSS）
 *   S6 源码仍保持纯 px：分片里不得出现手写 `calc(Npx * var(--ui-scale))`，
 *      且每个非番剧分片都要有足量纯 px 字号（读到空文件也绿是这类判据最常见的死法）
 *
 * ## 反证（--refute）
 * 在内存里把成因改回缺陷形态（摘注册、删 build 钩子、放宽正则吞掉 clamp、
 * 改错一档数值、去掉番剧隔离、手搓一条 calc），逐条判它变红。不写盘。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** CSS 注释要剥掉：注释里出现的 `--ui-scale: 1` 或示例 `calc(...)` 都不算实现（否则判据会被注释喂绿） */
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');
/** 折叠空白：判据只关心"这几个 token 连在一起"，不关心 prettier 怎么换行 */
const flat = (s) => stripCss(s).replace(/\s+/g, ' ');

const CONFIG = read('vite.config.ts');
const BASE = stripCss(read('src/styles/base.scss'));
/** 参与换算的分片（番剧分片按隔离红线不参与，见 S5） */
const SHARDS = ['app.scss', 'components.scss', 'manga.scss', 'music.scss', 'settings.scss'];
const shardTexts = () => Object.fromEntries(SHARDS.map((n) => [n, stripCss(read(`src/styles/${n}`))]));

const results = [];
const check = (id, label, ok, detail = '') => results.push({ id, label, ok: !!ok, detail });

/** 从配置里取出 FONT_PX 字面量本体 —— 判据跑的是产品那份，不是抄一份 */
const extractRegex = (cfg) => {
  const m = /const FONT_PX = (\/.+\/g);/.exec(cfg);
  if (!m) return null;
  try {
    return new RegExp(m[1].slice(1, -2), 'g');
  } catch {
    return null;
  }
};

/** 换算动作（与配置里的 `scaleFonts` 同一份规则） */
const applyScale = (re, css) => css.replace(re, (_all, n) => `font-size: calc(${n}px * var(--ui-scale))`);

const judgeRegistered = (cfg) => /plugins:\s*\[[^\]]*uiScaleFonts\(\)/.test(cfg);

const judgeHooks = (cfg) =>
  /function uiScaleFonts\(\)/.test(cfg) &&
  /transform\(code, id\)/.test(cfg) &&
  /generateBundle\(/.test(cfg) &&
  /const scaleFonts = /.test(cfg) &&
  (cfg.match(/scaleFonts\(/g) ?? []).length >= 2; // 两个钩子都调这一份

const judgeBehavior = (re) => {
  if (!re) return false;
  return (
    applyScale(re, 'a{font-size: 9.5px}') === 'a{font-size: calc(9.5px * var(--ui-scale))}' &&
    applyScale(re, 'a{font-size: clamp(21px, 1.85vw, 27px)}') === 'a{font-size: clamp(21px, 1.85vw, 27px)}' &&
    applyScale(re, 'a{font-size: var(--lyr-size, 12px)}') === 'a{font-size: var(--lyr-size, 12px)}'
  );
};

const judgeTiers = (base) => {
  const f = flat(base);
  return [
    ':root { --ui-scale: 1; }',
    '@media (min-width: 1500px) { :root { --ui-scale: 1.06; } }',
    '@media (min-width: 1720px) { :root { --ui-scale: 1.12; } }',
    '@media (min-width: 1920px) { :root { --ui-scale: 1.18; } }',
    '@media (max-width: 1180px) { :root { --ui-scale: 0.95; } }',
  ].every((want) => f.includes(want));
};

const judgeAnimeIsolated = (base) => flat(base).includes('.an-root { --ui-scale: 1;');

const HANDWRITTEN = /font-size:\s*calc\(\s*[\d.]+px\s*\*\s*var\(--ui-scale\)\s*\)/;
const PLAIN_PX = /font-size:\s*\d+(?:\.\d+)?px/g;

const judgeSourceClean = (texts) => {
  let seenPlain = 0;
  for (const code of Object.values(texts)) {
    if (HANDWRITTEN.test(code)) return false; // 手搓换算 = 第二个事实源
    const n = (code.match(PLAIN_PX) ?? []).length;
    if (n < 10) return false; // 某片几乎没有可读字号 ⇒ 多半是读空了，判据会假绿
    seenPlain += n;
  }
  return seenPlain > 300; // 总量与实测规模同量级（现约 430），防"只读到半个文件"
};

const RE = extractRegex(CONFIG);

check('S1', '插件注册进 plugins（钩子写了没挂＝静默不运行）', judgeRegistered(CONFIG));
check('S2', 'dev 与 build 两钩子齐、共用同一份 scaleFonts', judgeHooks(CONFIG));
check('S3', '换算行为正确：纯 px 命中，clamp / var 不动', judgeBehavior(RE), RE ? '' : '取不到 FONT_PX 字面量');
check('S4', '五档值与断点逐条等于设计稿', judgeTiers(BASE));
check('S5', '番剧就地不跟随（.an-root --ui-scale: 1）', judgeAnimeIsolated(BASE));
check('S6', '源码仍是纯 px（无手写换算、每片都有可读字号）', judgeSourceClean(shardTexts()));

let fail = 0;
console.log('\n字号分档（构建期换算）\n');
for (const r of results) {
  if (!r.ok) fail++;
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.id} ${r.label}${r.detail ? `  [${r.detail}]` : ''}`);
}
console.log('\n' + '─'.repeat(56));
console.log(`通过 ${results.length - fail} / 失败 ${fail}`);

// ------------------------------------------------------------------ 反证
if (process.argv.includes('--refute')) {
  if (fail > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }
  const T = shardTexts();
  const mutations = [
    [
      'M1 把插件从 plugins 里摘掉（钩子还在、永不运行 ⇒ 全站静默不缩放）',
      () => judgeRegistered(CONFIG.replace(', uiScaleFonts()', '')),
    ],
    [
      'M2 只剩 dev 侧 transform（实测过的分叉：dev 正常、产物不跟随）',
      () => judgeHooks(CONFIG.replace(/generateBundle\([\s\S]*?\n {4}\},/, '')),
    ],
    ['M3 正则放宽到整条声明（clamp / var 也被乘 ⇒ 大标题双重放大）', () => judgeBehavior(/font-size:[^;}]+/g)],
    [
      'M4 1.06 档写成 1.05（源码里根本没这个数，漂了没人看得见）',
      () => judgeTiers(BASE.replace('--ui-scale: 1.06;', '--ui-scale: 1.05;')),
    ],
    [
      // ⚠️ 变异必须**真的命中**：锚点找不到时 `replace` 会原样返回，判据照样"通过"，
      //      反证轮就会把这条记成"没有红"（而不是静默跳过）—— 这里显式返回 true 让它响。
      'M5 去掉番剧隔离（合并产物里无法按文件排除 ⇒ .an-* 全被换算）',
      () => {
        // 只删 `.an-root` 里那一处 —— 直接 replace('--ui-scale: 1') 会命中 `:root` 的默认档，
        // 那就变成测 S4 而不是 S5（红在别的断言上，等于没反证）
        const at = BASE.indexOf('.an-root {');
        if (at < 0) return true;
        // 空白不敏感：注释被剥掉后缩进形状会变，写死 `'  --ui-scale: 1;\n'` 会静默不命中
        const cut = BASE.slice(0, at) + BASE.slice(at).replace(/\s*--ui-scale:\s*1;/, '');
        if (cut === BASE) return true; // 锚点未命中 ⇒ 当作"没有红"，逼人来修锚点
        return judgeAnimeIsolated(cut);
      },
    ],
    [
      'M6 有人在源码里手搓一条 calc（绕过统一规则的第二事实源）',
      () =>
        judgeSourceClean({
          ...T,
          'settings.scss': T['settings.scss'].replace('font-size: 11px;', 'font-size: calc(11px * var(--ui-scale));'),
        }),
    ],
  ];
  let allRed = true;
  for (const [name, run] of mutations) {
    const red = run() === false;
    if (!red) allRed = false;
    console.log(`  ${red ? '✓' : '✗'} ${name} → ${red ? '按预期变红' : '**没有红**'}`);
  }
  console.log(`\nREFUTE: ${mutations.filter(([, run]) => run() === false).length}/${mutations.length} 条按预期变红`);
  process.exit(allRed ? 0 : 1);
}

process.exit(fail === 0 ? 0 : 1);
