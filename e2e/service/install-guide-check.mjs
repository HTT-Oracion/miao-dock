#!/usr/bin/env node
/**
 * D5 · 分平台安装引导钉子 —— 「文档里的落点/体积/就绪项，必须与**产品**逐项对上」
 * =============================================================================
 * 对应计划文档 D5：`docs/` 出 Windows / macOS 两份安装引导 —— 落点写成第一步、
 * 命令分平台、体积如实告知、写明「落点定了别挪、别放同步盘」。
 *
 * ## 为什么这份文档需要钉子（而不是"写完就算"）
 * D5 的验收②原话：「反证：把文档里的落点写错 ⇒ 装完仍报未装配（证明文档真的被验证过，
 * 不是写完就忘）」。一份**没有对拍**的安装引导，漂移方式是隐秘的：
 *   · 产品把运行时刻从 A 改到 B（B1 就干过这件事）⇒ 老文档把人引到 A，装完报未装配；
 *   · 清单换了一版权重 ⇒ 文档里的"13 GB"变成谎话，而没人会发现；
 *   · 检测侧新增一个就绪项（B5 加了 `patches`）⇒ 文档的"三件事"漏掉一件。
 * 三种都**不报错**，只是把用户送进死胡同 —— 正是本仓一贯要消灭的那类"脱节且不报错"。
 *
 * ## 钉法：文档里放可复算的字面量，脚本把它们还原成"产品会给出的值"
 * ① **落点**：文档写的是模板（`%LOCALAPPDATA%\runtimes\manga-translator` /
 *    `~/Library/Application Support/runtimes/manga-translator`）。脚本把模板**代入**本机
 *    环境算出实际路径，与产品算的落点**逐字节**比。产品侧的答案有两个来源：
 *      · **当前平台** ⇒ `mangasvc --print-paths` 的 `runtimeRoot`（真二进制，最强）；
 *      · **另一个平台** ⇒ 同源镜像表（`paths.rs::app_data_dir` / `config.mjs::defaultAppDataDir`
 *        的分叉规则）。镜像表本身由上面那条断言**在当前平台**钉住 ⇒ 两边不会一起走散。
 *    🔴 **诚实的取证边界**：本机只能跑一个平台的二进制，所以"另一个平台"的分支永远只能
 *    对镜像表、对不到真机二进制。macOS 侧的真机验收归 **D7**（在它完成前 macOS 引导标
 *    `unverified`），本脚本不假装它被验过。
 * ② **体积**：文档里放 `<!-- install-guide:size platform=<tag> bytes=<n> -->`，脚本按
 *    `platform` 过滤清单求和后比对；**正文里那个千分位数字也必须一致** ⇒
 *    "文档写一个好看的数字、清单里是另一个"会被抓出来。清单路径取自 `--print-paths`
 *    的 `modelManifest`（产品报的清单），不是本脚本自己拼的路径。
 * ③ **五项就绪项**：`venvRoot`/`python`/`source`/`deps`/`patches` 五个 id 必须都在文档里
 *    —— 它们就是"照文档装完"的验收面（B2），漏一项文档就漏一步。
 * ④ **平台形态**：Windows 文档必须是 `venv\Scripts\python.exe` 形态、macOS 必须是
 *    `venv/bin/python` 形态，且**互不出现对方的形态**（B3 的同源分叉在文档侧的镜像）。
 * ⑤ **引用的命令必须存在**：`npm run <入口>` 与 `package.json` 对账、
 *    `npm run task -- <id>` 与 `e2eScripts.json` 的命令清单对账（两种形态分别判，见代码 ⑦ 段）。
 *
 * ## 反证轮（--refute）
 * - M1 改 Windows 文档的落点字面量 ⇒ 落点断言红（D5 验收②要求的那条）。
 * - M2 改 macOS 文档的体积标记一位数 ⇒ 体积断言红。
 * - M3 **改清单副本**（`--manifest` 指向临时副本，动一条 `sizeBytes`）⇒ 体积断言红
 *      —— 证明数字是"从清单算的"，不是"两边写死同一个常量"（否则 M2 单独就能满足）。
 * - M4 把 macOS 文档的解释器路径改成 Windows 形态 ⇒ 平台形态断言红。
 * - M5 删掉 Windows 文档里的 `patches` 项 ⇒ 五项断言红。
 * 变异只动**文档**与**临时副本**（后者在 TMP 里，不碰仓库文件）；文档按字节还原。
 *
 * 用法：node e2e/service/install-guide-check.mjs [--refute] [--manifest <path>]
 * 前置：`cd src-tauri && cargo build --bin mangasvc`（拿产品的落点与清单路径）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildCommands } from '../_commands.mjs';
import { RUST_BIN, REPO_ROOT } from './_service-harness.mjs';

const SELF = fileURLToPath(import.meta.url);

// 用户主目录：与 `paths::home_dir()`（`dirs::home_dir()`）同义。
const HOME = os.homedir();

/// 产品的**五项就绪项** id（B2/B5）。它们就是"照文档装完"要验的东西。
const READY_IDS = ['venvRoot', 'python', 'source', 'deps', 'patches'];

/// 三条纪律的关键词（每条对应一类真实故障，见引导 §0）。
const DISCIPLINES = [
  { key: '别挪', words: ['别挪'] },
  { key: '别放同步盘', words: ['同步'] },
  { key: '别放临时目录', words: ['临时'] },
];

/**
 * 两份引导的**平台事实表**。
 *
 * 🔴 `appData` 与 `paths.rs::app_data_dir()`（Rust）和 `config.mjs::defaultAppDataDir()`（Node
 *    的同源对照端）逐条对应；它只覆盖**两个**分支，而"分支是否真的这么算"由
 *    `IG.mirror` 在**当前平台**上对真二进制取证（另一个分支对不到 ⇒ 见文件头的诚实边界）。
 */
const GUIDES = [
  {
    tag: 'win32-x64',
    os: 'win32',
    file: 'docs/install-guide-windows.md',
    title: 'Windows',
    /** 文档里写的落点**模板**（模板里的占位符由 `expand` 代入本机环境）。 */
    rootTemplate: '%LOCALAPPDATA%\\runtimes\\manga-translator',
    expand: (tpl) => tpl.replace('%LOCALAPPDATA%', process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local')),
    appData: () => process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'),
    /** 平台专属解释器形态（B3 的同一处分叉）。 */
    pythonShape: 'venv\\Scripts\\python.exe',
    forbiddenShape: 'venv/bin/python',
  },
  {
    tag: 'darwin-arm64',
    os: 'darwin',
    file: 'docs/install-guide-macos.md',
    title: 'macOS',
    rootTemplate: '~/Library/Application Support/runtimes/manga-translator',
    expand: (tpl) => tpl.replace(/^~/, HOME),
    appData: () => path.join(HOME, 'Library', 'Application Support'),
    pythonShape: 'venv/bin/python',
    forbiddenShape: 'Scripts\\python.exe',
  },
];

const REFUTE = process.argv.includes('--refute');
const MANIFEST_OVERRIDE = (() => {
  const i = process.argv.indexOf('--manifest');
  return i >= 0 ? process.argv[i + 1] : null;
})();

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

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// ------------------------------------------------------------------ 产品侧答案

if (!fs.existsSync(RUST_BIN)) {
  console.error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd src-tauri && cargo build --bin mangasvc`);
  process.exit(1);
}

/** 跑一次 `mangasvc --print-paths`，拿产品报的落点与清单路径。 */
function printPaths() {
  return new Promise((resolve, reject) => {
    const c = spawn(RUST_BIN, ['--print-paths'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => {
      out += d;
    });
    c.on('error', reject);
    c.on('close', (code) => {
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`--print-paths 输出不可解析（退出码 ${code}）：${out.slice(0, 200)}`));
      }
    });
  });
}

const paths = await printPaths();
/// 产品的引擎落点 = `<runtimeRoot>/manga-translator`（`paths::runtimes_dir()`）。
const PRODUCT_ROOT = path.join(paths.runtimeRoot, 'manga-translator');
const MANIFEST = MANIFEST_OVERRIDE || paths.modelManifest;

/** 按平台过滤清单求和（与 `model-store.mjs::matchesPlatform` 同义）。 */
function manifestSum(tag) {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const files = m.files.filter((f) => !f.platform || f.platform === tag);
  return { bytes: files.reduce((a, f) => a + (f.sizeBytes || 0), 0), count: files.length };
}

// ------------------------------------------------------------------ 正向

/** 文档里「落点」出现的位置 vs 第一条安装命令的位置 —— "落点写成第一步"的机械判据。 */
function rootBeforeFirstCommand(text, tpl) {
  const atRoot = text.indexOf(tpl);
  // 安装命令：`npm run <入口>` / `npm run task -- <id>`；`mangasvc --print-paths` 不算（它是查落点，本身属于第一步）
  const atCmd = text.indexOf('npm run ');
  if (atRoot < 0) return { ok: false, why: '文档里找不到落点字面量' };
  if (atCmd < 0) return { ok: false, why: '文档里没有任何 npm run 命令（是不是写漏了？）' };
  return { ok: atRoot < atCmd, why: `落点在 ${atRoot}、第一条命令在 ${atCmd}` };
}

const pkg = JSON.parse(read('package.json'));
const scripts = pkg.scripts || {};
const manifestIds = new Set(buildCommands().map((c) => c.id));

for (const g of GUIDES) {
  const text = read(g.file);

  // ① 落点：模板在 + 代入后 == 产品算的落点
  const expanded = path.join(g.expand(g.rootTemplate));
  check(
    `${g.title} 落点与产品一致（模板代入本机后逐字节 == mangasvc --print-paths 推出的落点）`,
    text.includes(g.rootTemplate) &&
      path.normalize(expanded) ===
        path.normalize(
          g.os === process.platform ? PRODUCT_ROOT : path.join(g.appData(), 'runtimes', 'manga-translator'),
        ),
    { template: g.rootTemplate, expanded, product: PRODUCT_ROOT, platform: process.platform },
  );

  // ② 落点是第一步（出现在任何安装命令之前）
  const order = rootBeforeFirstCommand(text, g.rootTemplate);
  check(`${g.title} 把落点写成了第一步（先于第一条 npm run 命令）`, order.ok, order.why);

  // ③ 体积：标记 == 清单求和，且正文里的千分位数字与之一致
  const size = manifestSum(g.tag);
  const commas = size.bytes.toLocaleString('en-US');
  const markerRe = new RegExp(`install-guide:size\\s+platform=${g.tag.replace(/[-]/g, '\\-')}\\s+bytes=(\\d+)`);
  const marker = text.match(markerRe);
  check(
    `${g.title} 体积与清单一致（标记 bytes == ${g.tag} 条目求和，且正文数字与之一致）`,
    !!marker && Number(marker[1]) === size.bytes && text.includes(commas),
    { marker: marker?.[1] ?? null, manifest: size.bytes, commas, entries: size.count, manifestPath: MANIFEST },
  );

  // ④ 五项就绪项全覆盖
  const absent = READY_IDS.filter((id) => !text.includes(id));
  check(
    `${g.title} 覆盖全部 ${READY_IDS.length} 个就绪项（照文档装完要能全真）`,
    absent.length === 0,
    absent.length ? `缺：${absent.join(', ')}` : undefined,
  );

  // ⑤ 三条纪律
  const missingDisc = DISCIPLINES.filter((d) => !d.words.some((w) => text.includes(w))).map((d) => d.key);
  check(
    `${g.title} 写明三条落点纪律（别挪 / 别放同步盘 / 别放临时目录）`,
    missingDisc.length === 0,
    missingDisc.length ? `缺：${missingDisc.join('、')}` : undefined,
  );

  // ⑥ 平台形态（且互不串平台）
  check(
    `${g.title} 解释器形态是 ${g.pythonShape} 且不出现另一平台的形态`,
    text.includes(g.pythonShape) && !text.includes(g.forbiddenShape),
    { has: text.includes(g.pythonShape), forbidden: text.includes(g.forbiddenShape) },
  );

  // ⑦ 引用的命令都存在
  // 🔴 两种形态各对各自的事实源（合并判定会把"早就不能跑的 `npm run check:X`"判成存在）：
  //    · `npm run <入口>`        → `package.json` 的三类入口
  //    · `npm run task -- <id>`  → `e2eScripts.json` 的命令清单
  const direct = new Set();
  const dispatched = new Set();
  for (const m of text.matchAll(/npm run (?:(task) -- )?([a-z0-9:-]+)/g)) {
    if (m[2].startsWith('-')) continue; // runner 自己的旗标（如 `--list`）不是清单 id
    (m[1] ? dispatched : direct).add(m[2]);
  }
  const missingCmd = [...direct].filter((c) => !Object.prototype.hasOwnProperty.call(scripts, c));
  const missingId = [...dispatched].filter((c) => !manifestIds.has(c));
  check(
    `${g.title} 引用的 npm 入口命令都存在`,
    missingCmd.length === 0,
    missingCmd.length ? `不存在：${missingCmd.join(', ')}` : `${direct.size} 个入口`,
  );
  check(
    `${g.title} 引用的 task 清单 id 都存在`,
    missingId.length === 0,
    missingId.length ? `清单里没有：${missingId.join(', ')}` : `${dispatched.size} 个 id`,
  );
}

// ⑧ 镜像表自身被产品钉住（当前平台）—— 另一平台的分支只能靠这一条间接保证
{
  const branch = GUIDES.find((g) => g.os === process.platform);
  const ok = !!branch && path.normalize(path.join(branch.appData(), 'runtimes')) === path.normalize(paths.runtimeRoot);
  check(
    'IG.mirror — 当前平台的 appData 镜像表与产品 --print-paths 的 runtimeRoot 逐字节一致' +
      '（另一平台的分支在本机对不到真二进制 ⇒ 归 D7 真机验收）',
    ok,
    {
      platform: process.platform,
      mirror: branch ? path.join(branch.appData(), 'runtimes') : null,
      product: paths.runtimeRoot,
    },
  );
}

// ⑨ 两份引导都让用户去问**产品**要落点（`--print-paths`），而不是只信文档里那行字
{
  const missing = GUIDES.filter((g) => !read(g.file).includes('--print-paths')).map((g) => g.title);
  check(
    '两份引导都说清了「落点以产品为准」（含 `mangasvc --print-paths` 这一步）',
    missing.length === 0,
    missing.length ? `缺：${missing.join('、')}` : undefined,
  );
}

// ------------------------------------------------------------------ 反证

const EXPECTED = 18; // 7 组 × 2 份 + 镜像 + 契约；其中 ⑦ 命令存在一组是**两种形态各一条**（写死分母，防"少跑一组还全绿"）
if (!REFUTE && passed + failed !== EXPECTED) {
  console.log(`\n⚠️ 断言条数 ${passed + failed} ≠ 写死的 ${EXPECTED}（新增/删除断言必须同步这个数）`);
  process.exit(1);
}

if (REFUTE) {
  if (failed > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }

  const wins = GUIDES[0];
  const macs = GUIDES[1];
  const winFile = path.join(REPO_ROOT, wins.file);
  const macFile = path.join(REPO_ROOT, macs.file);
  const winOriginal = fs.readFileSync(winFile, 'utf8');
  const macOriginal = fs.readFileSync(macFile, 'utf8');

  /**
   * 只改文档里的字面量，跑一次本脚本（不带 --refute）看有没有红。
   * 🔴 并且要求红在**指定的那条断言**上 —— "红在别的断言上"（如条数守卫）是假反证：
   *    它只证明"脚本会失败"，不证明这条变异咬住了它该咬的机制（同 D-113 的锚点纪律）。
   */
  const runOnce = (extraArgs = []) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [SELF, ...extraArgs], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      c.stdout.on('data', (d) => {
        out += d;
      });
      c.stderr.on('data', (d) => {
        out += d;
      });
      c.on('error', () => resolve({ code: -1, out }));
      c.on('close', (code) => resolve({ code, out }));
    });

  /** 变异后输出里是否出现了指定断言的 ✗ 行。 */
  const hasRedLine = (out, namePrefix) =>
    out.split('\n').some((l) => l.trimStart().startsWith('✗') && l.includes(namePrefix));

  const mutations = [];

  // M1：改 Windows 文档的落点 ⇒ 落点断言红（D5 验收②点名的那条）
  mutations.push({
    id: 'M1',
    what: 'Windows 文档的落点写成 C:\\Box\\runtimes\\manga-translator',
    edit: () =>
      fs.writeFileSync(winFile, winOriginal.replace(wins.rootTemplate, 'C:\\Box\\runtimes\\manga-translator')),
    probe: async () => {
      const r = await runOnce();
      return r.code !== 0 && hasRedLine(r.out, `✗ ${wins.title} 落点与产品一致`);
    },
  });

  // M2：改 macOS 文档的体积标记一位数 ⇒ 体积断言红
  mutations.push({
    id: 'M2',
    what: 'macOS 文档的体积标记少 1 字节',
    edit: () => {
      const m = macOriginal.match(/install-guide:size\s+platform=darwin-arm64\s+bytes=(\d+)/);
      if (!m) throw new Error('M2 锚点未命中（体积标记的写法变了？）');
      fs.writeFileSync(macFile, macOriginal.replace(`bytes=${m[1]}`, `bytes=${Number(m[1]) - 1}`));
    },
    probe: async () => {
      const r = await runOnce();
      return r.code !== 0 && hasRedLine(r.out, `✗ ${macs.title} 体积与清单一致`);
    },
  });

  // M3：改**清单副本**一条 sizeBytes ⇒ 体积断言红（证明数字来自清单而非两处写死同一个常量）
  mutations.push({
    id: 'M3',
    what: '清单副本里一条 sizeBytes +1（--manifest 指向它）',
    edit: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-guide-manifest-'));
      const copy = path.join(dir, 'models.manifest.json');
      const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
      const target = m.files.find((f) => !f.platform || f.platform === 'win32-x64');
      if (!target) throw new Error('M3 夹具失败：清单里找不到 win32-x64 可见项');
      target.sizeBytes += 1;
      fs.writeFileSync(copy, JSON.stringify(m, null, 2));
      mutations.find((x) => x.id === 'M3').manifest = copy;
    },
    probe: async () => {
      const m3 = mutations.find((x) => x.id === 'M3');
      const r = await runOnce(['--manifest', m3.manifest]);
      // 该条目不带 platform ⇒ 两个平台都可见 ⇒ 两份引导的体积断言都该红
      return (
        r.code !== 0 &&
        hasRedLine(r.out, `✗ ${wins.title} 体积与清单一致`) &&
        hasRedLine(r.out, `✗ ${macs.title} 体积与清单一致`)
      );
    },
  });

  // M4：macOS 文档的解释器路径改成 Windows 形态 ⇒ 平台形态断言红
  mutations.push({
    id: 'M4',
    what: 'macOS 文档写成了 Windows 的 Scripts\\python.exe 形态',
    edit: () => fs.writeFileSync(macFile, macOriginal.replace(macs.pythonShape, 'venv\\Scripts\\python.exe')),
    probe: async () => {
      const r = await runOnce();
      return r.code !== 0 && hasRedLine(r.out, `✗ ${macs.title} 解释器形态`);
    },
  });

  // M5：Windows 文档漏掉一个就绪项 ⇒ 五项断言红
  mutations.push({
    id: 'M5',
    what: 'Windows 文档删掉 patches 就绪项',
    // 🔴 反引号**可选**：断言侧是 `text.includes('patches')`（裸字符串匹配），
    //    所以变异体也必须把**裸写**的那种一并抹掉。只抹 `` `patches` `` 的话，
    //    文档里任何一处顺笔写的 "patches"（例如验收清单里的"五项（… / patches）"）
    //    都会让这条变异**咬空** ⇒ 反证看着绿、其实什么都没验（D-113 的锚点纪律）。
    edit: () => fs.writeFileSync(winFile, winOriginal.replace(/`?patches`?/g, 'patch-x')),
    probe: async () => {
      const r = await runOnce();
      return r.code !== 0 && hasRedLine(r.out, `✗ ${wins.title} 覆盖全部`);
    },
  });

  let allRed = true;
  for (const m of mutations) {
    try {
      m.edit();
      const red = await m.probe();
      if (!red) allRed = false;
      console.log(`  ${red ? '✓' : '✗'} ${m.id} ${m.what} → ${red ? '按预期变红' : '**没有红**'}`);
    } catch (e) {
      allRed = false;
      console.log(`  ✗ ${m.id} ${m.what} → 变异本身失败：${String(e.message || e).slice(0, 200)}`);
    } finally {
      fs.writeFileSync(winFile, winOriginal);
      fs.writeFileSync(macFile, macOriginal);
    }
  }
  check(
    'REFUTE.restore — 两份引导已按字节还原',
    fs.readFileSync(winFile, 'utf8') === winOriginal && fs.readFileSync(macFile, 'utf8') === macOriginal,
  );
  console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed, allRed }));
  console.log(
    `\nD5 分平台安装引导：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`,
  );
  process.exit(allRed && failed === 0 ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(
  `\nD5 分平台安装引导：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`,
);
process.exit(failed === 0 ? 0 : 1);
