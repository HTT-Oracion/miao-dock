#!/usr/bin/env node
/**
 * D2 · 「进度只来自真实来源」钉子 —— 「不编数字」
 * =============================================================================
 * 对应计划文档 D2：只显示子进程**真的打出来**的行；掐掉进度输出 ⇒ 界面
 * **不显示占位数字**。
 *
 * ## 为什么这条要分两层钉
 * 「界面没编数字」这句话，只钉前端源码会被**上游**绕过：界面忠实渲染了 `modelDownload.tail`，
 * 而 `tail` 里要是被塞了一行编造的"正在下载 42%"，界面照样把它当真实日志原样显示 ——
 * 断言全绿而用户被撒谎（AGENTS §2.4：只测最上面那层时下层坏掉照样全绿）。
 * 所以两层都要有，且**两层都要能反证**：
 *
 *   层一（数据源 · 真服务）：`tail` 必须**逐行等于**子进程真实 stdout 打出来的行。
 *     做法：真起一个 `mangasvc`（mock 档），用 `MIAO_MODEL_DOWNLOAD_RUNNER` 把它自己
 *     设成下载执行体（**产品默认就是它**），`POST /engine/models/download` 之后
 *     再**单独跑同一条命令**抓 stdout，两边逐行比。
 *   ⚠️ 不这么做的话，「tail 里是一行编造文本」与「tail 里是真实输出」在只读 `tail` 的
 *      断言下**完全同形** —— 那正是"假绿"的标准形态。
 *
 *   层二（前端 · 行为）：把 `lastLogLine` 的源码**抽出来在 Node 里求值**，直接验行为：
 *     全空日志 ⇒ `null`（不许补一个占位值）、末个非空行 ⇒ 原样返回（trim 后逐字节）。
 *     顺带钉一条结构性事实：该函数体内**没有非空字符串字面量** —— 没有可编的材料。
 *     并把 `EngineDiag` 的 `DownloadState` 那条「没有就不渲染」的守卫一起钉住。
 *
 * ## 反证轮（--refute）
 * - M1 `spawn_tail_reader` 推送**编造的行**而不是读到的行 ⇒ W1 红（层一）。
 * - M2 `lastLogLine` 加占位兜底 ⇒ W4b/W5 红（层二）。
 * - M3 `DownloadState` 去掉 `tail.length > 0` 守卫 ⇒ W6 红（"没有"时改成渲染空壳）。
 *
 * 用法：node e2e/service/progress-truth-check.mjs [--refute]
 * 前置：`cd src-tauri && cargo build --bin mangasvc`
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUST_BIN, REPO_ROOT } from './_service-harness.mjs';

const REFUTE = process.argv.includes('--refute');
const SELF = fileURLToPath(import.meta.url);
const TOKEN = 'a'.repeat(64);
const STATE_RS = path.join(REPO_ROOT, 'src-tauri', 'src', 'mangasvc', 'engine', 'state.rs');
const NOT_READY_TSX = path.join(REPO_ROOT, 'src', 'screens', 'manga', 'NotReadyScreen.tsx');
/// D-233：明细渲染搬进时间线组件（`detail` 的守卫也一起搬了）。
const TIMELINE_TSX = path.join(REPO_ROOT, 'src', 'screens', 'manga', 'AssemblyTimeline.tsx');
const ENGINE_DIAG = path.join(REPO_ROOT, 'src', 'screens', 'settings', 'EngineDiag.tsx');
const SRC_TAURI = path.join(REPO_ROOT, 'src-tauri');
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

if (!fs.existsSync(RUST_BIN)) {
  console.error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd src-tauri && cargo build --bin mangasvc`);
  process.exit(1);
}

// ------------------------------------------------------------------ 夹具
//
// 🔴 唯一能让"下载"这条路**秒级、零网络**跑通的形态：造**内容与清单完全一致**的文件，
//    于是 `ensure_models` 走"复用"分支，既不联网也不会重下。
//    （用 `sha256: 'a'.repeat(64)` 那种假摘要会去 example.invalid 下真文件 —— 慢且看运气。）

const contentA = 'miao-fixture-a\n';
const contentB = 'miao-fixture-b\n';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const shaBytes = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * 夹具归档：**只造一份字节，两边复制同一份**。
 *
 * `tar -czf` 两次产物的大小/时间戳可能不同（gzip 头带 mtime），而 W1 是"逐行等于"——
 * 差一个字节就会红。故这棵树用同一份字节喂两个夹具（哈希与体积也照它算）。
 */
let ARC_BYTES = null;
async function fixtureArchive() {
  if (ARC_BYTES) return ARC_BYTES;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-progress-arc-'));
  fs.mkdirSync(path.join(dir, 'top'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'top', 'hello.txt'), contentA);
  const out = path.join(dir, 'a.tar.gz');
  const r = await runAsync('tar', ['-czf', out, '-C', dir, 'top']);
  if (r.code !== 0) throw new Error(`造夹具归档失败（本机需要 tar）：${r.err || r.out}`);
  ARC_BYTES = fs.readFileSync(out);
  fs.rmSync(dir, { recursive: true, force: true });
  return ARC_BYTES;
}

/**
 * 夹具：①带 `extractTo` 的**真实归档** + ②普通权重（带 `linkTo`）。
 *
 * 🔴 ① 不能省：产品的 argv 带 `--extract`，而 runner 在"清单里没有可解包条目"时**直接退出 1**
 *    （`MODEL_NO_EXTRACT_ENTRY`）—— 夹具里不放归档，W2 就永远不可能绿，
 *    而表现为"两边的输出差一行"，很容易被误读成"数据源撒谎"。
 */
async function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-progress-'));
  const arc = await fixtureArchive();
  const manifest = {
    manifestVersion: 1,
    engineCommit: 'deadbeef',
    sets: { visual: { files: ['a', 'b'] } },
    files: [
      {
        id: 'a',
        set: 'visual',
        dest: 'models-store/a.tar.gz',
        sha256: shaBytes(arc),
        sizeBytes: arc.length,
        url: 'https://example.invalid/a',
        extractTo: 'extracted/',
      },
      {
        id: 'b',
        set: 'visual',
        dest: 'models-store/b.bin',
        linkTo: 'models/b.bin',
        sha256: sha(contentB),
        sizeBytes: Buffer.byteLength(contentB),
        url: 'https://example.invalid/b',
      },
    ],
  };
  const mp = path.join(root, 'models.manifest.json');
  fs.writeFileSync(mp, JSON.stringify(manifest, null, 2));
  fs.mkdirSync(path.join(root, 'models-store'), { recursive: true });
  fs.writeFileSync(path.join(root, 'models-store', 'a.tar.gz'), arc);
  fs.writeFileSync(path.join(root, 'models-store', 'b.bin'), contentB);
  return { root, mp };
}

/** 检查侧镜像的 flag 集合（与 `state.rs::spawn_download_round` 逐项对齐，见 W1b） */
const MIRRORED_FLAGS = [
  '--fetch-models',
  '--engine-bootstrap',
  '--extract',
  '--stage',
  '--root',
  '--manifest',
  '--progress-log',
];

/**
 * 服务**真的**会用这套 argv 起下载执行体（`state.rs::spawn_download_round`）。
 *
 * ⚠️ 只写 `--fetch-models --root --manifest` 是**错的**（曾经就是）：产品还会带
 * `--engine-bootstrap`（**只第 1 轮**）、`--extract`、`--stage N`、`--progress-log`，
 * 少任何一项都会让两边输出分叉，而分叉的样子与"数据源编造行"完全同形 ⇒ W1 假红/假绿。
 * `withBootstrap` 这个形参是必要的：第 2 轮产品**不带**该旗标（`spawn_download_round` 的注释：
 * 它会重跑 venv/源码/pip，所以只第 1 轮带）。
 */
const runnerArgs = (root, mp, stage, progressLog, withBootstrap) => [
  '--fetch-models',
  ...(withBootstrap ? ['--engine-bootstrap'] : []),
  '--extract',
  '--stage',
  String(stage),
  '--root',
  root,
  '--manifest',
  mp,
  '--progress-log',
  progressLog,
];

/**
 * 检查侧跑同一条命令时要带的那份 env。
 *
 * 🔴 子进程**继承服务的整份 env**（`spawn` 不另建环境）⇒ 只给 `MIAO_MODEL_ROOT` 是错的：
 * 实测那次 runner 去读了**仓库里那份真清单**并真的装配了 appData 里的运行时（跑 pip、
 * 打印上百行），而产品侧读的是夹具清单 —— 两边输出完全对不上，W1 于是在"比另一条命令"。
 */
const mirrorEnv = (fx) => ({
  MIAO_ENGINE_PROTOCOL: 'mock',
  MIAO_MODEL_MANIFEST: fx.mp,
  MIAO_MODEL_ROOT: fx.root,
});

/** 异步跑一个子进程（本机 `spawnSync` 稳定 EBUSY ⇒ 一律异步）。 */
function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, {
      env: { ...process.env, ...(opts.env || {}) },
      cwd: opts.cwd || REPO_ROOT,
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
    c.on('error', (e) => resolve({ code: -1, out, err: `${err}${e.message}` }));
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

/** 起一个 mangasvc 服务并等 `MIAO_READY`。 */
function startService(extraEnv) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-progress-svc-'));
  const child = spawn(RUST_BIN, [], {
    env: {
      ...process.env,
      MIAO_TOKEN: TOKEN,
      MIAO_ROOT: path.join(tmp, 'library'),
      MIAO_STATE_DIR: path.join(tmp, 'state'),
      MIAO_ENGINE_PROTOCOL: 'mock',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => {
      child.kill();
      reject(new Error('mangasvc 15s 内未就绪'));
    }, 15000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /MIAO_READY (\{.*\})/.exec(buf);
      if (m) {
        clearTimeout(to);
        resolve({ port: JSON.parse(m[1]).port, kill: () => child.kill() });
      }
    });
    child.stderr.on('data', (d) => (buf += d));
    child.on('close', (code) => {
      clearTimeout(to);
      reject(new Error(`mangasvc 退出 ${code}：${buf.slice(0, 500)}`));
    });
  });
}

const api = (port, p) => `http://127.0.0.1:${port}/api/v1${p}`;
const headers = { 'x-box-token': TOKEN, 'content-type': 'application/json' };

/** 一份输出切成"界面会看到的那些行" —— 与 `spawn_tail_reader` 同口径（`\r` 也算分隔符）。 */
const toLines = (s) =>
  s
    .split(/\r\n|\r|\n/)
    .map((x) => x.trim())
    .filter((x) => x !== '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 层一：数据源（真服务）

{
  // 🔴 两边必须**从同一初始状态**起跑：`--link` 是幂等的，若共用一份夹具，
  //    先跑完的那一侧会把"新建 1"变成"已是 1" —— 那点差异与"编造行"长得一样，
  //    会让 W1 变成一条**时红时绿**的断言（比没有更坏）。故造两份内容等价的夹具，
  //    再把两边唯一的变量（临时根目录名）归一化成 `<ROOT>`。
  const ref = await buildFixture();
  const refLog = path.join(ref.root, 'progress.jsonl');
  // 与产品同构：第 1 轮（带 `--engine-bootstrap`）成功才接第 2 轮，**第 2 轮不带那个旗标**。
  const r1 = await runAsync(RUST_BIN, runnerArgs(ref.root, ref.mp, 1, refLog, true), { env: mirrorEnv(ref) });
  const r2 =
    r1.code === 0
      ? await runAsync(RUST_BIN, runnerArgs(ref.root, ref.mp, 2, refLog, false), { env: mirrorEnv(ref) })
      : null;
  // 🔴 期望值 = **最后一轮**的输出：产品的 `spawn_download_round` 每轮开头都 `d.tail = Vec::new()`
  //    （state.rs 的轮次重置块）⇒ 界面看到的永远只是最后那一轮的日志。把两轮拼起来比是错的。
  const last = r2 ?? r1;
  const want = toLines(last.out + last.err).map((l) => l.split(ref.root).join('<ROOT>'));
  fs.rmSync(ref.root, { recursive: true, force: true });

  const { root, mp } = await buildFixture();
  // 产品默认执行体就是 mangasvc 自己；这里**显式**指向它，让"起谁"不依赖宿主 PATH。
  const svc = await startService({
    MIAO_MODEL_MANIFEST: mp,
    MIAO_MODEL_ROOT: root,
    MIAO_MODEL_DOWNLOAD_RUNNER: RUST_BIN,
  });
  let tail = [];
  let dl = {};
  try {
    const start = await fetch(api(svc.port, '/engine/models/download'), { method: 'POST', headers, body: '{}' });
    check('W0 `POST /engine/models/download` 接受并起了一个下载任务', start.status === 200, { status: start.status });

    // 轮询到终态（夹具很快，1 秒级；给足 20 s 余地）
    let st = {};
    for (let i = 0; i < 200; i++) {
      st = await (await fetch(api(svc.port, '/engine/status'), { headers })).json();
      if (st?.modelDownload?.state !== 'running') break;
      await sleep(100);
    }
    dl = st?.modelDownload ?? {};
    tail = (dl.tail ?? []).map((l) => l.split(root).join('<ROOT>'));
  } finally {
    svc.kill();
  }

  check(
    'W1 `modelDownload.tail` **逐行等于**子进程真实 stdout/stderr（顺序也一致）—— 有一行编造的就红',
    tail.length > 0 && tail.join('\n') === want.join('\n'),
    { tail, want, code: last.code },
  );

  // W1b：检查侧镜像的 flag 集合 == 产品构造的 argv 集合。
  // 没有这一条，argv 漂移的表现是"W1 悄悄变成在比另一条命令"——红了不知道，绿了也不算数。
  {
    const src = fs.readFileSync(STATE_RS, 'utf8');
    const fn = src.slice(src.indexOf('fn spawn_download_round'));
    const built = [...new Set([...fn.matchAll(/cmd\.arg\("(--[a-z-]+)"\)/g)].map((m) => m[1]))];
    const onlyBuilt = built.filter((f) => !MIRRORED_FLAGS.includes(f));
    const onlyMirrored = MIRRORED_FLAGS.filter((f) => !built.includes(f));
    check(
      'W1b 检查侧镜像的 argv 与产品构造的 argv **同集**（少一项就红，不让 W1 悄悄比错命令）',
      built.length > 0 && onlyBuilt.length === 0 && onlyMirrored.length === 0,
      { built, onlyBuilt, onlyMirrored },
    );
  }

  check(
    'W2 任务走到终态 `done` / 退出码 0（"真实输出"这件事得在真跑完的前提下说）',
    dl.state === 'done' && dl.exitCode === 0,
    { state: dl.state, exitCode: dl.exitCode },
  );

  check(
    'W3 终态下 `tail` 仍**在**（不是跑完就清空 —— 用户回来看到的最后一行不该被抹掉）',
    tail.length > 0 && typeof dl.finishedAt === 'string',
    { len: tail.length, finishedAt: dl.finishedAt },
  );

  fs.rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------------------------ 层二：前端（行为）

/**
 * 抽出顶层函数的**函数体**并求值 —— 判据作用在真函数上，而不是"读源码相信"。
 *
 * ⚠️ 两个坑，都踩过：
 *  · 切点取**列 0 的收尾大括号**（结构上恒定，反证改不动）；不能用"被测特征"当切点。
 *  · 源码是 **TS**，签名里有类型标注（`log: string[] | undefined): string | null`）⇒
 *    直接 `new Function(src)` 是语法错误。只取 `{...}` 那段函数体，参数名自己给。
 */
function evalFn(text, name, params = ['log']) {
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const braceStart = text.indexOf('{', start);
  const end = braceStart < 0 ? -1 : text.indexOf('\n}', braceStart);
  if (end < 0) return null;
  const inner = text.slice(braceStart, end + 2);
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`return function ${name}(${params.join(', ')}) ${inner}`)();
  } catch {
    return null;
  }
}

{
  const tsx = fs.readFileSync(NOT_READY_TSX, 'utf8');
  const fn = evalFn(tsx, 'lastLogLine');
  const src = fn ? `function lastLogLine ${fn.toString().slice(fn.toString().indexOf('{'))}` : null;

  check('W4 前端：`lastLogLine` 存在且可求值（判据作用在真函数上，不是"读源码相信"）', typeof fn === 'function', {
    found: fn !== null,
  });

  const real = '实测日志末行';
  check(
    'W4b 行为①：末个非空行原样返回（trim 后逐字节），空白行被跳过',
    fn && fn(['旧行', '', '   ', real]) === real && fn([real]) === real && fn(['  ' + real + '  ']) === real,
    fn ? { got: [fn(['旧行', '', '   ', real]), fn([real]), fn(['  ' + real + '  '])] } : null,
  );

  // 🔴 D2 验收②的核心：**没有就不显示，不补一个占位数字**。
  check(
    'W4c 行为②：空数组 / 全空白 / undefined ⇒ `null`（**不许补占位值**）',
    fn && fn([]) === null && fn(['', '   ']) === null && fn(undefined) === null,
    fn ? { empty: fn([]), blank: fn(['', '   ']), undef: fn(undefined) } : null,
  );

  // 结构性事实：体内没有**非空**字符串字面量 ⇒ 没有可编的材料。
  // ⚠️ 判据要放过 `?? ''` 这种空字面量（trim 的默认值），只抓"能显示给用户看的文字"。
  const bodyNoComment = (src ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const hasVisibleLiteral = /['"`][^'"`]+['"`]/.test(bodyNoComment);
  check('W5 `lastLogLine` 函数体内没有非空字符串字面量（有字面量 = 有东西可编）', src !== null && !hasVisibleLiteral, {
    hasVisibleLiteral,
  });

  const diag = fs.readFileSync(ENGINE_DIAG, 'utf8');
  check(
    'W6 `EngineDiag` 的 `DownloadState`：「没有日志就不渲染」（`tail.length > 0` 守卫 + 逐行 `tail.map`）',
    /const tail = view\.tail\.slice\(-6\);/.test(diag) &&
      /\{tail\.length > 0 \? \(/.test(diag) &&
      /\{tail\.map\(\(line, i\) => \(/.test(diag),
    {
      slice: /const tail = view\.tail\.slice\(-6\);/.test(diag),
      guard: /\{tail\.length > 0 \? \(/.test(diag),
      map: /\{tail\.map\(\(line, i\) => \(/.test(diag),
    },
  );

  const timeline = fs.readFileSync(TIMELINE_TSX, 'utf8');
  check(
    'W7 调用点：末行取自**真实日志**（`status?.log`），且渲染处只渲染它本身、无兜底常量',
    /const detail = lastLogLine\(status\?\.log\);/.test(tsx) &&
      /const showDetail = !!detail && \(note === 'active' \|\| note === 'failed'\);/.test(timeline) &&
      /\{showDetail \? <div className="tl-detail">\{detail\}<\/div> : null\}/.test(timeline),
    {
      call: /const detail = lastLogLine\(status\?\.log\);/.test(tsx),
      guard: /const showDetail = !!detail/.test(timeline),
      render: /\{showDetail \? <div className="tl-detail">\{detail\}<\/div> : null\}/.test(timeline),
    },
  );
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

  const runForward = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [SELF], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const redOn = (out) =>
    out
      .split('\n')
      .filter((l) => l.trimStart().startsWith('✗'))
      .map((l) => l.trim().slice(0, 46));

  // ---- M1：数据源开始编造行 ----
  {
    // ⚠️ 编造的内容必须是**常量**：写成 `format!("…{}", d.tail.len())` 会触发
    //    `d.tail` 的借用冲突 ⇒ 编不过 ⇒ `built=false`，那场"变异失败"会被误读成"断言没红"。
    const restore = mutateFile(
      STATE_RS,
      'd.tail.push(t.to_string());',
      'd.tail.push("正在校验模型文件…".to_string());',
    );
    const built = await rebuild();
    const r = await runForward();
    const red = built && r.code !== 0 && hasRed(r.out, 'W1');
    check('M1 `spawn_tail_reader` 推送**编造的行**而不是读到的行 ⇒ W1 红（层一：数据源撒谎）', red, {
      built,
      code: r.code,
      redOn: redOn(r.out),
    });
    restore();
    await rebuild();
  }

  // ---- M2：前端补一个占位值 ----
  {
    const restore = mutateFile(
      NOT_READY_TSX,
      '    if (s) return s;\n  }\n  return null;',
      "    if (s) return s;\n  }\n  return '正在下载 42%';",
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W4c') && hasRed(r.out, 'W5');
    check('M2 `lastLogLine` 加占位兜底 ⇒ W4c/W5 红（层二：没有也编一个）', red, { code: r.code, redOn: redOn(r.out) });
    restore();
  }

  // ---- M3：前端"没有"时改成渲染空壳 ----
  {
    const restore = mutateFile(ENGINE_DIAG, '{tail.length > 0 ? (', '{true ? (');
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W6');
    check('M3 `DownloadState` 去掉「没有就不渲染」的守卫 ⇒ W6 红', red, { code: r.code, redOn: redOn(r.out) });
    restore();
  }

  // 收尾：确认还原到位（源码逐字节）
  {
    const bad = [];
    if (!fs.readFileSync(STATE_RS, 'utf8').includes('d.tail.push(t.to_string());')) bad.push('state.rs 残留 M1');
    const nr = fs.readFileSync(NOT_READY_TSX, 'utf8');
    if (nr.includes('正在下载 42%') || !nr.includes('return null;')) bad.push('NotReadyScreen.tsx 残留 M2');
    if (!fs.readFileSync(ENGINE_DIAG, 'utf8').includes('{tail.length > 0 ? (')) bad.push('EngineDiag.tsx 残留 M3');
    check('R1 变异收尾：三处源码按字节还原', bad.length === 0, bad);
  }
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
