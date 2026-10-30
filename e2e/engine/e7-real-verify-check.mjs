#!/usr/bin/env node
/**
 * E7 · 模型续传与校验（《04》§14.2）—— **真机半边**
 * =============================================================================
 * 判据原文：**下载中断后续传成功；篡改一个字节 → SHA256 校验失败 → 自动重下**
 *
 * ## 为什么还要一个脚本：`check:models` 已经验过了，但它用的是夹具
 * `e2e/engine/model-store-check.mjs` 用**夹具 HTTP 服务器**把 E7 的两件事都验了，
 * 而且验得很实（真发 `Range` 请求、真算 sha256、真检出篡改 → 真重下）：
 *   · E7-1a…1d 续传：下成 / 确实发了 Range / 起点 = 已落盘字节数 / 断点不残留
 *   · E7-2a…2c 篡改：篡改一字节被检出 → 标记重下 → 重下后哈希恢复
 * ⇒ **不为凑数重造这些断言**（§5.3：不许把同一件事写成两条）。
 *
 * 夹具验不到的是**规模**：夹具里的"文件"是几 KB 的合成字节，而产线上被校验的是
 * **4.0 GB 的 GalTransl 权重**。两者差的不是数量，是**能不能跑完**：
 *   · 流式哈希写错（一次性 `readFileSync`）在夹具上照样过，在 3.6 G 上直接 OOM；
 *   · 只校验头部 / 只看文件大小，在夹具的小文件上也照样过；
 *   · 大文件在真盘上的 mtime / inode 语义（硬链接、apfs 克隆）与夹具不同。
 * ⇒ 本脚本只补这三件**只能在真文件上问的问题**，用**盘上真实权重**做证据。
 *
 * ## 真机半边的边界（必须明说，不计入已完成）
 * 「下载中断 → 续传」的这一半**本机做不到真机验证**：它要真的从上游拉几 GB 再掐断，
 * 而本项目的权重是**预置**的（见 `offline-engine-bringup` 的结论）。
 * 这一半的取证停在夹具层（真 Range 请求），已足够证明**代码路径**正确；
 * 但"上游真实 CDN 的 `Content-Range` 行为"这一条列进
 * `docs/internal/engine-e2e-acceptance-report.md` 的 unverified register。
 *
 * 用法：
 *   node e2e/engine/e7-real-verify-check.mjs            正向
 *   node e2e/engine/e7-real-verify-check.mjs --refute    反证轮（改坏源文件 → 断言必须变红 → 按字节还原）
 *
 * 约束：纯 Node、零第三方依赖；**只读**真权重（绝不写 `runtimes/` 下的任何文件）；
 *       篡改实验一律在 `os.tmpdir()` 的副本上做，跑完自清。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { runtimesDir } from '../../engine/scripts/runtime-root.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
// 🔴 B1：真机取权重的落点与产品同源（`<appData>/runtimes/manga-translator`）。
const MODEL_ROOT = process.env.MIAO_MODEL_ROOT || runtimesDir();
const MANIFEST_PATH = path.join(ROOT, 'engine', 'models.manifest.json');
const STORE_SRC = path.join(ROOT, 'engine', 'model-store.mjs');
const REFUTE = process.argv.includes('--refute');

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

/** 大盘权重（3.6 G）：用来证明"流式哈希在真实规模上跑得完且对得上" */
const BIG_ID = 'llm_galtransl_7b_v37_iq4xs';
/** 小文件（186 KB）：篡改实验用它 —— 快、且 sha256 语义与大盘文件完全同一条代码路径 */
const SMALL_ID = 'ocr_alphabet_v7';

const byId = (id) => manifest.files.find((f) => f.id === id);
const BIG = byId(BIG_ID);
const SMALL = byId(SMALL_ID);

/** 声明的断言条数（分母写死：少执行一条即判红） */
const DECLARED = 6;

// ------------------------------------------------------------------ 结果收集

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}
function printResults(title) {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n### ${title}`);
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.id}${r.detail ? `  ${r.detail}` : ''}`);
  console.log(`\n通过 ${pass} / 失败 ${results.length - pass} / 声明 ${DECLARED}`);
  return { pass, fail: results.length - pass };
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * 取 `model-store.mjs` 的**当前**导出。
 *
 * 🔴 为什么必须走"带缓存破坏键的动态 import"，而不是顶部的静态 `import`：
 *    反证轮会直接改写磁盘上的 `model-store.mjs`，而 ESM 按 URL **强缓存**模块 ——
 *    静态导入拿到的永远是进程启动时那一份，于是"破坏了源码"却一条断言也不变红
 *    （本轮实测：0/3 假阳性，看起来像"断言无效"，其实是取证方式无效）。
 *    键取 `mtimeMs:size`：源文件一变就换 URL ⇒ 重新求值，拿到被破坏后的那份。
 *    （E4 的 `askChild()` 用另起子进程解决同一问题；这里就地加载更省一次进程。）
 */
let _store = null;
let _storeKey = null;
async function store() {
  const st = fs.statSync(STORE_SRC);
  const key = `${st.mtimeMs}:${st.size}`;
  if (_storeKey !== key) {
    _store = await import(`${pathToFileURL(STORE_SRC).href}?v=${key}`);
    _storeKey = key;
  }
  return _store;
}

// ------------------------------------------------------------------ 篡改夹具

/**
 * 把一份真实文件复制到临时目录，并在指定偏移**翻一个 bit**。
 *
 * 🔴 为什么要**复制**而不能硬链接：硬链接与源文件共享 inode —— "篡改副本"会同时毁掉
 *    盘上那份真权重。本项目整套设计（`verifyModels()` 是硬链接的安全网）正建立在
 *    "能被悄悄改坏的只有 inode"这件事上，夹具自己犯这个错就没有可信度了。
 *
 * @param {string} srcAbs 源文件绝对路径
 * @param {string} destRel 临时根下的相对路径
 * @param {'middle'|'last'} where 翻哪一字节
 */
async function tamperCopy(srcAbs, tmpRoot, destRel, where) {
  const destAbs = path.join(tmpRoot, destRel);
  await fsp.mkdir(path.dirname(destAbs), { recursive: true });
  await fsp.copyFile(srcAbs, destAbs);
  const fh = await fsp.open(destAbs, 'r+');
  try {
    const size = (await fh.stat()).size;
    // `last` 用来堵"只校验头部 / 只看大小"这类伪校验：把坏的字节放在最末尾，
    // 任何"读前 N KB 就够了"的实现都会漏掉它。
    const offset = where === 'last' ? size - 1 : Math.floor(size / 2);
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, offset);
    buf[0] ^= 0xff; // 翻满 8 位：确保与原文**必然**不同（不是"可能不同"）
    await fh.write(buf, 0, 1, offset);
    return { destAbs, offset, size, before: buf[0] ^ 0xff, after: buf[0] };
  } finally {
    await fh.close();
  }
}

/** 造一份"dest 指到临时根"的 manifest 副本；**sha256 保持清单原值**（清单是权威） */
function manifestWithDest(id, destRel) {
  return {
    ...manifest,
    files: manifest.files.map((f) => (f.id === id ? { ...f, dest: destRel } : f)),
  };
}

// ------------------------------------------------------------------ 正向

async function runAll() {
  results.length = 0; // 反证轮会重复调用，不清空分母就累积（E4 同款）
  const s = await store(); // 见 `store()` 的注释：必须是这一轮**磁盘上**的那份实现

  // 前置：真权重必须在盘上，否则这轮什么也证明不了
  for (const f of [BIG, SMALL]) {
    if (!f) throw new Error(`manifest 里找不到 ${f?.id ?? '?'} —— 清单被改过？`);
    const p = path.join(MODEL_ROOT, f.dest);
    if (!fs.existsSync(p)) {
      throw new Error(`真机取证需要盘上有 ${f.id}：${p}\n请先 \`npm run task -- fetch:models\` 或按预置流程放入权重。`);
    }
  }

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'miao-e7-real-'));
  try {
    // ---- E7-A：真实大盘权重的哈希**能跑完且与清单一致**（流式实现没有在 3.6 G 上崩）----
    const t0 = Date.now();
    const big = await s.verifyModels(manifest, { rootDir: MODEL_ROOT, ids: [BIG_ID] });
    const bigMs = Date.now() - t0;
    check(
      'E7-A 3.6 GB 真权重的 sha256 **跑得完**且与清单一致（流式实现不在真实规模上崩）',
      big.ok.length === 1 && big.bad.length === 0 && big.missing.length === 0,
      `ok=${JSON.stringify(big.ok)} bad=${big.bad.length} missing=${JSON.stringify(big.missing)} / 文件 ${mb(BIG.sizeBytes)} / 耗时 ${(bigMs / 1000).toFixed(1)} s / 清单 sha=${BIG.sha256.slice(0, 12)}…`,
    );

    // ---- E7-B：篡改**中间**一个字节 → 必须被检出（且报出实际哈希，不是照抄期望值）----
    const midRel = 'mid/alphabet.txt';
    const midInfo = await tamperCopy(path.join(MODEL_ROOT, SMALL.dest), tmpRoot, midRel, 'middle');
    const midManifest = manifestWithDest(SMALL_ID, midRel);
    const mid = await s.verifyModels(midManifest, { rootDir: tmpRoot, ids: [SMALL_ID] });
    const midBad = mid.bad[0];
    check(
      'E7-B 篡改**中间**一字节 → sha256 校验失败，且报出的是**实际算出**的哈希（≠ 清单值）',
      mid.bad.length === 1 &&
        mid.ok.length === 0 &&
        midBad?.actual !== SMALL.sha256 &&
        /^[0-9a-f]{64}$/.test(midBad?.actual ?? ''),
      `offset=${midInfo.offset} / 字节 ${midInfo.before}→${midInfo.after} / 实际=${String(midBad?.actual).slice(0, 12)}… / 清单=${SMALL.sha256.slice(0, 12)}…`,
    );

    // ---- E7-C：篡改**最后一个字节** → 同样必须被检出（堵"只校验头部/只看大小"的伪校验）----
    const lastRel = 'last/alphabet.txt';
    const lastInfo = await tamperCopy(path.join(MODEL_ROOT, SMALL.dest), tmpRoot, lastRel, 'last');
    const lastManifest = manifestWithDest(SMALL_ID, lastRel);
    const lastRes = await s.verifyModels(lastManifest, { rootDir: tmpRoot, ids: [SMALL_ID] });
    check(
      'E7-C 篡改**最后一个字节** → 仍被检出（排除"只读头部 / 只看文件大小"的伪校验）',
      lastRes.bad.length === 1 && lastRes.bad[0].actual !== SMALL.sha256,
      `offset=${lastInfo.offset}（size=${lastInfo.size}）→ 位置在文件末尾 / 检出=${lastRes.bad.length === 1}`,
    );

    // ---- E7-D：未篡改的副本必须判 ok —— 证明上面的"bad"不是"一律判坏" ----
    const cleanRel = 'clean/alphabet.txt';
    await fsp.mkdir(path.join(tmpRoot, 'clean'), { recursive: true });
    await fsp.copyFile(path.join(MODEL_ROOT, SMALL.dest), path.join(tmpRoot, cleanRel));
    const cleanManifest = manifestWithDest(SMALL_ID, cleanRel);
    const clean = await s.verifyModels(cleanManifest, { rootDir: tmpRoot, ids: [SMALL_ID] });
    check(
      'E7-D 同一份字节**未篡改**时判 ok（"bad"来自字节差异，不是校验器一律判坏）',
      clean.ok.length === 1 && clean.bad.length === 0,
      `ok=${JSON.stringify(clean.ok)} bad=${clean.bad.length}`,
    );

    // ---- E7-E：坏的**再验一次仍是坏的**（不"第二次就放过"，也不偷偷修好）----
    const again = await s.verifyModels(midManifest, { rootDir: tmpRoot, ids: [SMALL_ID] });
    check(
      'E7-E 坏文件再验一次仍判 bad（校验是幂等的判定，不"重试一次就放行"）',
      again.bad.length === 1 && again.bad[0].actual === midBad?.actual,
      `第二次 actual=${String(again.bad[0]?.actual).slice(0, 12)}… == 第一次？${again.bad[0]?.actual === midBad?.actual}`,
    );

    // ---- E7-F：真权重目录在整轮取证里**一个字节都没被我们改过** ----
    // 这条是防"夹具自己把真模型搞坏了" —— 上面所有篡改都发生在 tmp 副本上。
    const bigAfter = await s.sha256File(path.join(MODEL_ROOT, BIG.dest));
    check(
      'E7-F 真权重目录在整轮取证后**未被改动**（篡改只发生在 tmp 副本上）',
      bigAfter === BIG.sha256,
      `重算 ${bigAfter.slice(0, 12)}… == 清单 ${BIG.sha256.slice(0, 12)}…`,
    );
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }

  // 反证轮要按 id 取"这一轮的结果"，所以回一份 map（与 E4 脚本同形）。
  const map = {};
  for (const r of results) map[r.id] = r;
  return map;
}

// ------------------------------------------------------------------ 反证轮

const MUTATIONS = [
  {
    // 这条盯的是 E7-B/C 的**核心防线**：校验结果必须来自"算出来的哈希"。
    // 改成恒判通过后，篡改就检不出来了 —— 那时模型坏了也没人喊。
    name: 'E7-B/C：让 `verifyModels` 的哈希比对**恒判通过**（"坏文件也算好"）',
    expect: [
      'E7-B 篡改**中间**一字节 → sha256 校验失败，且报出的是**实际算出**的哈希（≠ 清单值）',
      'E7-C 篡改**最后一个字节** → 仍被检出（排除"只读头部 / 只看文件大小"的伪校验）',
    ],
    // ⚠️ 破坏必须**语法合法**：只换掉 `if (...)` 那一行会留下悬空的 `else` ⇒ 模块加载就抛
    //    `Unexpected token 'else'`，断言"变红"是因为根本没跑起来，而不是因为它抓到了机制 ——
    //    那种红不算证据（本轮实测踩到过）。所以把 `if/else` **两行一起**换掉。
    edits: [
      {
        file: STORE_SRC,
        find:
          '    if (got === file.sha256) out.ok.push(file.id);\n' +
          '    else out.bad.push({ id: file.id, expected: file.sha256, actual: got });',
        replace: '    out.ok.push(file.id); // refute：不分好坏，一律判通过',
      },
    ],
  },
  {
    // 这条盯的是"实际哈希"这个**字段本身**：把 actual 写成 expected（照抄），
    // E7-B/E7-C 里"actual ≠ 清单值"这一条会红 —— 因为那时它报的是抄来的值。
    name: 'E7-B/C：让 `bad` 里的 `actual` **照抄清单的期望值**（"看起来校验过了"）',
    expect: ['E7-B 篡改**中间**一字节 → sha256 校验失败，且报出的是**实际算出**的哈希（≠ 清单值）'],
    edits: [
      {
        file: STORE_SRC,
        find: '    else out.bad.push({ id: file.id, expected: file.sha256, actual: got });',
        replace:
          '    else out.bad.push({ id: file.id, expected: file.sha256, actual: file.sha256 }); // refute：照抄期望值',
      },
    ],
  },
];

const readBytes = (f) => {
  try {
    return fs.readFileSync(f);
  } catch {
    return null;
  }
};

const main = async () => {
  console.log(`E7 模型续传与校验 · 真机半边（《04》§14.2）${REFUTE ? ' · 反证轮' : ''}`);
  console.log(`模型根目录 ${MODEL_ROOT}`);

  if (!REFUTE) {
    await runAll();
    const { fail } = printResults('E7 真机取证');
    const executed = results.length;
    if (executed !== DECLARED) console.log(`\n🔴 分母不符：声明 ${DECLARED} 条，实际执行 ${executed} 条 —— 视为失败`);
    process.exitCode = fail === 0 && executed === DECLARED ? 0 : 1;
    return;
  }

  await runAll();
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
    for (const [i, e] of mut.edits.entries()) {
      if (!originals.has(e.file)) originals.set(e.file, readBytes(e.file));
      const txt = originals.get(e.file).toString('utf8');
      if (!txt.includes(e.find)) {
        console.log(
          `⚠ ${mut.name}\n    破坏锚点未找到（第 ${i + 1} 处，${path.relative(ROOT, e.file)}）—— 本条无法反证`,
        );
        skipped += mut.expect.length;
        continue;
      }
      fs.writeFileSync(e.file, txt.replace(e.find, e.replace));
    }
    // 🔴 还原一律进 `finally`：破坏若让 `runAll()` 抛异常（例如真权重不在盘上时的前置检查），
    //    写在 try 之后的还原语句就**不会执行**，源文件会停在被改坏的状态。
    let res = {};
    let roundErr = null;
    try {
      res = await runAll();
    } catch (err) {
      roundErr = err;
    } finally {
      for (const [f, snap] of originals) fs.writeFileSync(f, snap);
    }
    console.log(`🔴 ${mut.name}`);
    if (roundErr) console.log(`   ⚠ 本轮 runAll 抛异常（源文件已被破坏）：${String(roundErr.message).split('\n')[0]}`);
    for (const id of mut.expect) {
      total++;
      const isRed = (res[id] && res[id].ok === false) || (!res[id] && roundErr !== null);
      if (isRed) {
        red++;
        console.log(`  ✓ ${id.slice(0, 22)}… 按预期变红${res[id] ? '' : '（因本轮未能执行）'}`);
      } else {
        falsePositives.push(id);
        console.log(`  ✗ ${id.slice(0, 22)}… 该红没红 ← 假阳性`);
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
  if (restoreFail) console.log(`✗ 有 ${restoreFail} 个文件未恢复到原始字节`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(' / ')}`);
  process.exitCode = red === total && total === expectedTotal && skipped === 0 && restoreFail === 0 ? 0 : 1;
};

await main();
