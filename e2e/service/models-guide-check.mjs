#!/usr/bin/env node
/**
 * D8 · 模型引导清单钉子 —— 「逐条**渲染**清单，而不是在界面里编写一份」
 * =============================================================================
 * 对应计划文档 D8：`models.manifest.json` 里本来就有 `url` / `sizeBytes` / `dest` /
 * `linkTo` / `platform`，引导清单**逐条吐出来**即可；顺带修 `modelStatus()` 只回三个
 * 聚合布尔、丢掉「哪一个文件缺」的既有隐患。
 *
 * ## 它钉的是什么
 * ① 每条都带**目标绝对路径**（且是"引擎真会去打开的那个"——有 `linkTo` 的条目落在
 *    `<root>/src/<linkTo>`，不是 `<root>/<dest>`）；
 * ② 平台适用性与**下载器**同判据（否则界面说 4 条待下、下载器只下 3 条）；
 * ③ 就绪判据是"在位**且大小一致**"，不是"文件存在就算好"；
 * ④ 三个聚合布尔必须与逐条清单**算自同一份判据**（不是两套各算各的）。
 *
 * ## 为什么必须有一条"改清单副本"的变异（D-178 的纪律）
 * 「界面显示 6.9 GB」「清单里写的是什么」这类事实，如果两边各写死一份常量，断言照样全绿
 * —— 而那正是要防的。所以本脚本**自带**一条自证的变异：把夹具清单里一条 `dest` 改掉，
 * 输出的 `path` 必须**跟着变**。产品侧若把落点写死，这条当场红。
 *
 * ## 取证入口：`mangasvc --engine-model-files`
 * 打印 `ModelStatus` 的 JSON（逐条 + 三个聚合布尔）。清单与模型根走 `paths` 的接缝
 * （`MIAO_MODEL_MANIFEST` / `MIAO_MODEL_ROOT`），整套夹具搬进临时目录跑，不碰磁盘上的真资产。
 *
 * ## 反证轮（--refute）
 * - M1 `abs_for` 的落点写死成常量 ⇒ W2/W9 红（"渲染"退化成"写死"）。
 * - M2 就绪判据退化成"存在即就绪" ⇒ W4/W6 红。
 * - M3 删掉 `EngineDiag.tsx` 的清单渲染 ⇒ W11 红（服务端给了，界面没接上）。
 * 三个变异跑完都**按字节还原**，M1/M2 还要重编译（靶子是另一个进程）。
 *
 * 用法：node e2e/service/models-guide-check.mjs [--refute]
 * 前置：`cd src-tauri && cargo build --bin mangasvc`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUST_BIN, REPO_ROOT } from './_service-harness.mjs';

const REFUTE = process.argv.includes('--refute');
/** 本脚本自身（反证轮要重跑一次不含 `--refute` 的它）。用 `fileURLToPath` 而不是 `.pathname`
 *  —— Windows 上后者会给出 `/F:/...`，`spawn` 起不来。 */
const SELF = fileURLToPath(import.meta.url);
const MANIFEST = path.join(REPO_ROOT, 'engine', 'models.manifest.json');
const MODEL_STATUS_RS = path.join(REPO_ROOT, 'src-tauri', 'src', 'mangasvc', 'engine', 'model_status.rs');
const ENGINE_DIAG = path.join(REPO_ROOT, 'src', 'screens', 'settings', 'EngineDiag.tsx');
const ENGINE_API = path.join(REPO_ROOT, 'src', 'screens', 'settings', 'engine-api.ts');
const SRC_TAURI = path.join(REPO_ROOT, 'src-tauri');
/** `cargo` 可执行：`CARGO` env 覆盖，否则交给 PATH。 */
const CARGO = process.env.CARGO || 'cargo';

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

// ------------------------------------------------------------------ 取证入口

/** 跑一次 `mangasvc --engine-model-files`，返回解析后的 JSON。 */
async function modelFiles(extraEnv) {
  const r = await new Promise((resolve, reject) => {
    const c = spawn(RUST_BIN, ['--engine-model-files'], {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => {
      out += d;
    });
    c.stderr.on('data', (d) => {
      err += d;
    });
    c.on('error', reject);
    c.on('close', (code) => resolve({ code, out, err }));
  });
  if (r.code !== 0) throw new Error(`--engine-model-files 退出 ${r.code}：${r.stderr.slice(0, 400)}`);
  return JSON.parse(r.out);
}

// ------------------------------------------------------------------ Node 侧独立算期望

/**
 * 平台标识 —— **不 import 产品代码**，这里按 Node 自己的口径算一遍再与产品比。
 * （`process.platform` / `process.arch` 就是清单 `platform` 字段的对齐口径。）
 */
const platformKey = () => `${process.platform}-${process.arch}`;

/** 一条清单条目"引擎真会去打开"的绝对路径 —— 期望值的**独立实现**。 */
function absFor(f, root) {
  const linkTo = f.linkTo || '';
  if (linkTo) return path.isAbsolute(linkTo) ? linkTo : path.join(root, 'src', linkTo);
  return path.join(root, f.dest || '');
}

/** 是否适用当前平台（无 `platform` = 平台无关）。 */
const applicableOf = (f) => !f.platform || f.platform === platformKey();

/** 读一份清单并落到临时目录（改动只影响副本）。 */
function copyManifest(dir, manifest) {
  const p = path.join(dir, 'models.manifest.json');
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
  return p;
}

if (!fs.existsSync(RUST_BIN)) {
  console.error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd src-tauri && cargo build --bin mangasvc`);
  process.exit(1);
}

// ------------------------------------------------------------------ W1~W4：真清单（空模型根）
//
// 用**仓库里那份真清单**跑：条数、id、逐条绝对路径、平台适用性全部按 Node 独立算一遍再比。
// 模型根是空临时目录 ⇒ 逐条必然未就绪（顺带钉住"空目录不算装上"）。
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-guide-real-'));
  const body = await modelFiles({ MIAO_MODEL_MANIFEST: MANIFEST, MIAO_MODEL_ROOT: root });
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const got = body.files ?? [];

  check('W1 真清单：逐条条数与清单一致', got.length === m.files.length, { got: got.length, want: m.files.length });

  const mism = [];
  m.files.forEach((f, i) => {
    const g = got[i];
    if (!g) {
      mism.push(`#${i} 缺失`);
      return;
    }
    if (g.id !== f.id) mism.push(`#${i} id ${g.id} ≠ ${f.id}（顺序也要一致）`);
    const want = absFor(f, root);
    if (g.path !== want) mism.push(`${f.id}: ${g.path} ≠ ${want}`);
    if (!path.isAbsolute(g.path)) mism.push(`${f.id} 的目标不是绝对路径：${g.path}`);
  });
  check('W2 真清单：逐条 id 与目标绝对路径都与清单一致（含 linkTo 优先）', mism.length === 0, mism.slice(0, 3));

  const appBad = m.files.filter((f, i) => got[i] && got[i].applicable !== applicableOf(f)).map((f) => f.id);
  check('W3 真清单：applicable 与下载器的平台判据一致', appBad.length === 0, appBad);

  const sizeBad = m.files
    .filter((f, i) => got[i] && (got[i].sizeBytes ?? null) !== (f.sizeBytes ?? null))
    .map((f) => f.id);
  check('W3b 真清单：sizeBytes 原样转发（界面要说"有多大"就不能自己估）', sizeBad.length === 0, sizeBad);

  check(
    'W4 空模型根 ⇒ 逐条 ready 全假、三个聚合布尔全假',
    got.length > 0 &&
      got.every((f) => f.ready === false) &&
      body.visualReady === false &&
      body.sakuraReady === false &&
      body.lastVerifiedAt === null,
    { anyReady: got.filter((f) => f.ready).map((f) => f.id) },
  );

  fs.rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------------------------ W5~W9：自制小清单（真造文件）
//
// 真清单的权重是 GB 级，不能真造。用一份**四条**的小清单把三种形态全覆盖：
//   a 无 linkTo（按 dest 落盘）· b 有相对 linkTo（落在 <root>/src 下）·
//   c/d 带 platform（一对互斥）。造 a/b 两个真文件，刚好覆盖"就绪/未就绪"两侧。
const FIX = {
  files: [
    { id: 'a', set: 'visual', dest: 'models-store/a.bin', sizeBytes: 3, url: 'https://example.invalid/a' },
    { id: 'b', set: 'visual', dest: 'models-store/b.bin', linkTo: 'models/b.bin', sizeBytes: 4 },
    { id: 'c', set: 'runtime', dest: 'bin/c.exe', platform: 'win32-x64', sizeBytes: 5 },
    { id: 'd', set: 'runtime', dest: 'bin/d', platform: 'darwin-arm64', sizeBytes: 6 },
  ],
  sets: { visual: { files: ['a', 'b'] }, runtime: { files: ['c', 'd'] } },
};

function buildSmallFixture(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-guide-small-'));
  const manifest = JSON.parse(JSON.stringify(FIX));
  if (mutate) mutate(manifest);
  const mp = copyManifest(root, manifest);
  fs.mkdirSync(path.join(root, 'models-store'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'models'), { recursive: true });
  fs.writeFileSync(path.join(root, 'models-store', 'a.bin'), Buffer.alloc(3));
  fs.writeFileSync(path.join(root, 'src', 'models', 'b.bin'), Buffer.alloc(4));
  return { root, mp, manifest };
}

{
  const { root, mp, manifest } = buildSmallFixture();
  const body = await modelFiles({ MIAO_MODEL_MANIFEST: mp, MIAO_MODEL_ROOT: root });
  const by = Object.fromEntries((body.files ?? []).map((f) => [f.id, f]));

  check(
    'W5 小清单：四条一条不少',
    (body.files ?? []).length === 4,
    (body.files ?? []).map((f) => f.id),
  );

  check(
    'W6 就绪判据 = 在位**且大小一致**（a/b 造了真文件 ⇒ 就绪；c/d 不在 ⇒ 未就绪）',
    by.a?.ready === true && by.b?.ready === true && by.c?.ready === false && by.d?.ready === false,
    { a: by.a?.ready, b: by.b?.ready, c: by.c?.ready, d: by.d?.ready },
  );

  check(
    'W7 三个聚合布尔与逐条**算自同一份判据**（visual 全就绪 ⇒ true；清单无 llm set ⇒ false）',
    body.visualReady === true && body.sakuraReady === false,
    { visualReady: body.visualReady, sakuraReady: body.sakuraReady },
  );

  const wantApp = Object.fromEntries(manifest.files.map((f) => [f.id, applicableOf(f)]));
  check(
    'W8 applicable 逐条与 Node 独立算的一致',
    manifest.files.every((f) => by[f.id]?.applicable === wantApp[f.id]),
    { got: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.applicable])), want: wantApp },
  );

  check(
    'W9 有 linkTo ⇒ 目标是 <root>/src/<linkTo>，不是 <root>/<dest>（引擎实际打开的那一个）',
    by.b?.path === absFor(manifest.files[1], root) && by.b.path.includes(`${path.sep}src${path.sep}`),
    { got: by.b?.path, want: absFor(manifest.files[1], root) },
  );

  // W6b：**在位但大小与清单不符** ⇒ 该条必须未就绪。
  // 🔴 这一条专抓"存在即就绪"的退化：只靠 c/d（文件整个不在）是抓不住的 ——
  //    那种情况下"存在才判就绪"和"大小也要对"给出同一个答案。
  fs.writeFileSync(path.join(root, 'models-store', 'a.bin'), Buffer.alloc(4));
  const body2 = await modelFiles({ MIAO_MODEL_MANIFEST: mp, MIAO_MODEL_ROOT: root });
  const by2 = Object.fromEntries((body2.files ?? []).map((f) => [f.id, f]));
  check('W6b 文件在、大小与清单不符 ⇒ 该条未就绪，其余不受影响', by2.a?.ready === false && by2.b?.ready === true, {
    a: by2.a?.ready,
    b: by2.b?.ready,
  });

  fs.rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------------------------ W10：改清单副本 ⇒ 输出必须跟着变
//
// 🔴 D8 验收②：证明清单是**渲染**出来的。若产品把落点/条目写死，改了副本也不会变 ⇒ 红。
//    这也是本脚本**唯一**不依赖"再跑一遍产品"的证明方式（D-178：不能两边写死同一个常量）。
{
  const { root, mp, manifest } = buildSmallFixture((m) => {
    m.files[0].dest = 'models-store/moved-a.bin';
  });
  const body = await modelFiles({ MIAO_MODEL_MANIFEST: mp, MIAO_MODEL_ROOT: root });
  const a = (body.files ?? []).find((f) => f.id === 'a');
  const want = absFor(manifest.files[0], root);
  check(
    'W10 改清单副本一条 dest ⇒ 渲染出的绝对路径跟着变（证明是渲染不是写死）',
    a?.path === want && a.path.endsWith('moved-a.bin'),
    { got: a?.path, want },
  );
  fs.rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------------------------ W11：前端真的把它渲染出来了
//
// 服务端给了逐条清单 ≠ 用户看得到。没有这条，把 EngineDiag 里那段删掉，上面全绿。
{
  const diag = fs.readFileSync(ENGINE_DIAG, 'utf8');
  const api = fs.readFileSync(ENGINE_API, 'utf8');
  check(
    'W11 前端：诊断视图把清单交给渲染组件，且用服务端给的 path（不是自己拼的）',
    /<ModelFiles\s+files=\{s\?\.models\?\.files\}/.test(diag) &&
      diag.includes('{f.path}') &&
      /files:\s*ModelFileStatus\[\]/.test(api),
    {
      wired: /<ModelFiles\s+files=\{s\?\.models\?\.files\}/.test(diag),
      usesServerPath: diag.includes('{f.path}'),
      typed: /files:\s*ModelFileStatus\[\]/.test(api),
    },
  );
  // 清单条目的类型必须逐字来自服务端契约（少一个字段，界面就读到 undefined）
  const need = ['id', 'dest', 'applicable', 'ready', 'path'];
  const missing = need.filter((k) => !new RegExp(`\\b${k}\\b`).test(api));
  check('W11b 前端：ModelFileStatus 契约含 id/dest/applicable/ready/path', missing.length === 0, missing);
}

// ------------------------------------------------------------------ 反证轮

if (REFUTE) {
  console.log('\n── 反证轮（改源码 ⇒ 指定断言必须红；跑完按字节还原）──\n');

  const rebuild = () =>
    new Promise((resolve) => {
      const b = spawn(CARGO, ['build', '--bin', 'mangasvc'], { cwd: SRC_TAURI, stdio: 'ignore' });
      b.on('close', (c) => resolve(c === 0));
      b.on('error', () => resolve(false));
    });

  /**
   * 改文件里的一处文本（返回还原函数）。
   *
   * 🔴 锚点里的 `\n` 要按**文件实际 EOL** 展开：源文件是 CRLF，锚点写死 LF 会永远匹配不上
   *    —— 而那会让反证"变异失败"却被误读成"断言没红"。
   */
  function mutateFile(file, from, to) {
    const original = fs.readFileSync(file);
    const text = original.toString('utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const f = from.replace(/\r?\n/g, eol);
    const t = to.replace(/\r?\n/g, eol);
    if (!text.includes(f)) throw new Error(`反证锚点未命中（写法变了？）：${file}\n  ${from.slice(0, 80)}`);
    fs.writeFileSync(file, Buffer.from(text.replace(f, t), 'utf8'));
    return () => fs.writeFileSync(file, original);
  }

  /** 跑一次转发脚本（不带 --refute），返回 { code, out }。 */
  const runForward = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [SELF], {
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

  const hasRed = (out, name) => out.split('\n').some((l) => l.trimStart().startsWith('✗') && l.includes(name));

  // ---- M1：落点写死 ----
  {
    // 常量用**正斜杠**：Windows 上同样是合法路径，且彻底避开 Rust 字符串转义
    // （`"C:\fixed"` 里的 `\f` 是**编译错误**，会让"变异成功但编不过"冒充成"断言红了"）。
    const restore = mutateFile(
      MODEL_STATUS_RS,
      'root_dir.join(f.get("dest").and_then(|v| v.as_str()).unwrap_or(""))',
      'PathBuf::from("C:/fixed-by-m1")',
    );
    const built = await rebuild();
    const r = await runForward();
    const redOn = r.out
      .split('\n')
      .filter((l) => l.trimStart().startsWith('✗'))
      .map((l) => l.trim().slice(0, 46));
    // 🔴 判据是 **W2 + W10**（不是 W9）：W9 走的是 `linkTo` 分支，而这个变异只动了 `dest`
    //    分支 —— 拿 W9 当判据会永远红不了，等于没反证。W10 才是"写死"的直接反面。
    const red = built && r.code !== 0 && hasRed(r.out, 'W2') && hasRed(r.out, 'W10');
    check('M1 dest 分支落点写死 ⇒ W2/W10 红（"渲染"退化成"写死"）', red, { built, code: r.code, redOn });
    restore();
    await rebuild();
  }

  // ---- M2：就绪判据退化成"存在即就绪" ----
  {
    const restore = mutateFile(MODEL_STATUS_RS, 'Some(want) => got == want,', 'Some(want) => { let _ = want; true },');
    const built = await rebuild();
    const r = await runForward();
    const red = built && r.code !== 0 && hasRed(r.out, 'W6');
    check('M2 就绪判据退化成"在就算好" ⇒ W6 红（大小不符必须判未就绪）', red, { built, code: r.code });
    restore();
    await rebuild();
  }

  // ---- M4：`linkTo` 分支落点写错（少了 `<root>/src` 这一层）----
  //
  // 没有它，W9 就是一条**永远红不了**的断言 —— 而"永远绿/永远红的断言"等于没写。
  {
    const restore = mutateFile(MODEL_STATUS_RS, 'base.join(link_to)', 'root_dir.join(link_to)');
    const built = await rebuild();
    const r = await runForward();
    const red = built && r.code !== 0 && hasRed(r.out, 'W9');
    check('M4 linkTo 分支丢掉 <root>/src 那一层 ⇒ W9 红', red, { built, code: r.code });
    restore();
    await rebuild();
  }

  // ---- M3：前端没接上 ----
  {
    const restore = mutateFile(ENGINE_DIAG, '<ModelFiles files={s?.models?.files} />', '');
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W11');
    check('M3 删前端渲染 ⇒ W11 红（服务端给了、界面没接上）', red, { code: r.code });
    restore();
  }

  // 收尾：确认还原到位（源码逐字节）
  {
    const bad = [];
    if (fs.readFileSync(MODEL_STATUS_RS, 'utf8').includes('fixed-by-m1')) bad.push('model_status.rs 残留 M1');
    if (!fs.readFileSync(MODEL_STATUS_RS, 'utf8').includes('Some(want) => got == want,'))
      bad.push('model_status.rs 残留 M2');
    if (!fs.readFileSync(ENGINE_DIAG, 'utf8').includes('<ModelFiles files={s?.models?.files} />'))
      bad.push('EngineDiag.tsx 未还原');
    check('R1 变异收尾：两处源码按字节还原', bad.length === 0, bad);
  }
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
