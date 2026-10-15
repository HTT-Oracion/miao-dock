#!/usr/bin/env node
/**
 * G4/G5 · **夹具版真装配**（nightly）—— 让「产品自己装引擎」这条链在本机被真跑一遍
 * =============================================================================
 * `check:engine-bootstrap`（static）钉的是"接线在不在、阶段顺序对不对、文案诚不诚实"。
 * 但那些判据**不起子进程**：`install_deps()` 里两批 pip 的先后、批 B 真的走 wheel、
 * 兼容补丁真的写进 `site-packages`、导入自检真的过、解包真的按 `dest` 找到归档 ——
 * 这些只有跑起来才知道。
 *
 * ## 它真跑的是**产品自己的** `boxsvc --fetch-models --engine-bootstrap --extract`
 * 不是仓库侧那套 Node 脚本（`setup-engine.mjs` / `install-engine-deps.mjs`）——
 * 打包用户机上根本没有 Node，跑的就是这一个二进制。
 *
 * ## 为什么"一半真、一半夹具"
 *   · **运行时用真归档**：`python -m venv` 与 `tar` 解包没法造假（需要真解释器、真源码树）。
 *     Python 运行时（46 MB）从本机真实落点**复制**过来；**上游源码（53 MB）走 mock http**
 *     由产品在第 3 阶段真下一次（见 `sourceEntry` 的说明：预放缓存会把"第 1 阶段越界解包"
 *     盖住，而"干净机器能不能装成"正是这条检查要回答的问题）。于是这一段是真下、真装，
 *     只是不需要外网。
 *   · **模型用夹具清单 + 本地 mock http**：真视觉模型加起来 712 MB、翻译权重 6 GB，
 *     进 nightly 等于每次多等十几分钟，而**没有任何断言需要真权重**。夹具三个条目
 *     （一个平铺文件 + 一个真 tar.gz + 一个 stage2）就能把「下载 → 按 dest 解包 → 建链」
 *     这条路走通。
 *   · **依赖用夹具 requirements**：真清单是 torch 那一百多个包、4–6 GB。夹具换成
 *     `six`（真装，秒级）+ 一行 `pydensecrf@…` 直链（要被剔掉 / 走 wheel）。
 *     ⇒ 两批 pip 的**顺序与各自成功**是真的，只是内容小。
 *
 * ## 验的十一件事
 *   B1 阶段顺序：引擎源码解包 / 补丁 在「批 A」之前（旧顺序 ⇒ 依赖阶段找不到清单）
 *   B2 批 A 真装了（夹具里的 `six` 落在 venv 的 site-packages）
 *   B3 批 B 命中**随包** wheel ⇒ `--no-index --no-deps`，不联网、不编译
 *   B4 旧常量兼容补丁真写进 venv 的 `pydensecrf/__init__.py`（marker 与仓库脚本同字）
 *   B5 自检①**真过**：venv 里 `pydensecrf.densecrf` 可 import 且 `DIAG_KERNEL` 在
 *   B5b 夹具旁路只关掉自检②（引擎级），且日志如实声明
 *   B6 长路径体检写进 `.runtime.ready.json` 的 `longPath` 段
 *   B7 🔴 **解包按 `dest` 找归档**（这一条曾经真错过：下载侧写 `dest`、解包侧按 url 末段
 *      找 ⇒ "下载完成"之后报「待解包归档不存在」）。夹具特意让 `dest` 与 url 末段**不同名**
 *      —— 两处同名的话这条断言根本咬不到东西。
 *   B8 模型侧同一条路走通：夹具归档解到 `bin/fixture/hello.txt`、平铺件按 linkTo 建链
 *   B9 全量跑（不带 `--stage`）时 stage2 的条目也下到
 *   B10 🔴 引擎源码是**产品在第 3 阶段真下**的（mock http → 按 `dest` 落缓存、哈希对得上）。
 *       B7 + B10 合起来才排得掉"预放归档 ⇒ 越界解包被盖住"的假绿：越界时第 1 阶段直接失败，
 *       归档根本下不来，B10 必红。
 *
 * ## 反证轮（--refute）
 *   R1 清单无本平台 wheel **且** requirements 无直链行 ⇒ B3 红（两条路都断，如实报错；
 *     只删直链行**不会**红 —— wheel 路线不读 requirements，这个反证一开始就是这么写错的）
 *   R2 wheel 清单 sha256 改坏 ⇒ B3 红（宁可回退源码编译，也不装没验过的东西）
 *   R3 批 A 装一个不存在的包 ⇒ B2 红（证明 B2 不是"读日志字面量"）
 *   R4 **不设** `MIAO_SKIP_ENGINE_IMPORT` ⇒ 自检② 真失败（闸门确实在，旁路只影响它）
 *
 * ## 三个环境陷阱（都真撞过）
 *   · mock 服务器必须是**独立进程**：`spawnSync` 会阻塞 Node 的事件循环，进程内 server
 *     一个请求都收不到（症状是 `[重试] … 第 4 次中断` 然后整段失败）。
 *     项目内其它检查同样禁用 `spawnSync`。
 *   · **落点必须在系统临时目录**（`mkdtempSync(os.tmpdir())`，与 `e3-real-full-chain-check`
 *     同口径）：这里装的是真 Python 运行时 + venv，上万个文件；删这样一棵树在开发机上会被
 *     安全垫拦下（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，阈值 500）—— 而那会让脚本**在开头就炸**。
 *     `os.tmpdir()` 下的删除不经那道门。仓库内 `.tmp/` 留给"要给人看的产物"，本检查没有产物。
 *   · 夹具缓存**不需要**跨轮复用：落点每轮都是新的（`mkdtemp`），100 MB 的夹具归档照价重放。
 *
 * ## 环境前提（缺任何一项都**非零退出并点名**，不静默跳过）
 *   · 已 `cargo build --bin boxsvc`
 *   · 本机跑过 `npm run task -- setup:engine`（真实落点里有那两个 `.tar.gz`）
 *
 * 用法：node e2e/engine/engine-bootstrap-real-check.mjs [--refute]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REFUTE = process.argv.includes('--refute');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOXSVC = path.join(ROOT, 'src-tauri', 'target', 'debug', 'boxsvc.exe');
const RUNTIME_MANIFEST = path.join(ROOT, 'engine', 'runtime.manifest.json');
const MODELS_MANIFEST = path.join(ROOT, 'engine', 'models.manifest.json');
const WHEELS_MANIFEST = path.join(ROOT, 'engine', 'wheels.manifest.json');

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

// ------------------------------------------------------------------ 硬前置

if (!fs.existsSync(BOXSVC)) {
  console.error(`✗ 找不到 ${BOXSVC}\n  先跑：cd src-tauri && cargo build --bin boxsvc`);
  process.exit(1);
}

/** 真实落点（已被 `setup:engine` 填过的那份缓存）—— 只读，绝不写。 */
const CACHE_SRC =
  process.env.MIAO_BOOTSTRAP_CACHE_SRC ||
  path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
    'runtimes',
    'manga-translator',
    '.download-cache',
  );

/**
 * 落点：**本次专属的系统临时目录**（`mkdtemp`，与 `e3-real-full-chain-check` 同口径）。
 *
 * 🔴 为什么不是仓库内 `.tmp/`（AGENTS §1 的默认口径）：这里装的是**真** Python 运行时 +
 *    venv（上万个文件），而删这样一棵树在开发机上会被安全垫拦下
 *    （`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，阈值 500 个文件）⇒ 脚本会在开头就炸。
 *    `os.tmpdir()` 下的删除不经那道门，而且"从零开始"这件事不必靠删 —— `mkdtemp` 天生是空的。
 *    跑完**故意不清理**：现场（venv / 源码树 / 就绪标记）留着才能在有疑问时直接翻。
 * 🔴 `CACHE_SRC` 只在**只读**侧用；绝不改动用户真实落点里的任何字节。
 */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-bootstrap-real-'));
const RUNTIME_ROOT = path.join(WORK, 'runtime'); // = MIAO_RUNTIME_ROOT
const RT = path.join(RUNTIME_ROOT, 'manga-translator'); // = runtimes_dir()
const MODEL_ROOT = path.join(WORK, 'models');
const STATE = path.join(WORK, 'state');

for (const d of [RT, MODEL_ROOT, STATE, path.join(RT, '.download-cache')]) fs.mkdirSync(d, { recursive: true });

const runtime = JSON.parse(fs.readFileSync(RUNTIME_MANIFEST, 'utf8'));
const runtimeFiles = runtime.files.filter((f) => !f.platform || f.platform === 'win32-x64');

/**
 * 归档文件名一律取 **`dest` 的最后一段** —— 与产品下载侧（`model_store::ensure_models`
 * 落 `root.join(file.dest)`）同口径。url 末段在两份清单里都不是这个名字。
 */
const destName = (f) => f.dest.split('/').pop();

/**
 * 从真实缓存里找一条 runtime 条目的归档。**只读**，绝不改动用户的真实落点。
 *
 * 🔴 为什么要"前缀匹配"这一步：清单的 `dest` 是**权威名**，但本机那份缓存是历史产物
 * —— `setup-engine.mjs` 早先用过自己的命名（`manga-translator-441d07c59a73.tar.gz`，
 * 12 位 sha；而 dest 写的是 `manga-translator-441d07c5.tar.gz`，8 位）。
 * 夹具只需要"能拿到那份字节"，所以按 dest 名（去扩展名）做前缀匹配就够；
 * 而**产品侧不这么做** —— 它必须严格按 `dest` 找（那正是 B7 要咬的判据）。
 */
function findSourceArchive(f) {
  const listed = fs.readdirSync(CACHE_SRC);
  const want = destName(f);
  const stem = want.replace(/\.(tar\.gz|zip)$/i, '');
  const tails = [];
  if (f.url) {
    const t = f.url.split('/').pop();
    tails.push(t, decodeURIComponent(t));
  }
  const cands = [want, ...tails];
  for (const c of cands) {
    if (listed.includes(c)) return path.join(CACHE_SRC, c);
  }
  // 前缀匹配（按 dest 名，再按 url 末段）—— 认历史命名，例如短 sha 与长 sha 之差。
  for (const stem2 of [stem, ...tails.map((t) => t.replace(/\.(tar\.gz|zip)$/i, ''))]) {
    if (!stem2) continue;
    const hit = listed.find((n) => n.startsWith(stem2));
    if (hit) return path.join(CACHE_SRC, hit);
  }
  return null;
}

if (!fs.existsSync(CACHE_SRC)) {
  console.error(`✗ 找不到真实缓存目录：${CACHE_SRC}\n  先跑：npm run task -- setup:engine`);
  process.exit(1);
}

// ------------------------------------------------------------------ 运行时归档（真件，复制）

/**
 * 引擎源码**不预放进夹具缓存**：它必须由产品在**第 3 阶段**从 mock http 下下来。
 *
 * 🔴 为什么不预放（python 就是预放的）：解包曾经是打开**整份**清单去解的 ⇒ 第 1 阶段刚下完
 *    python 就顺手去解还没下载的 `engine_source`，干净机器上直接报「待解包归档不存在」。
 *    预先复制会把这条路**盖住** —— 而"干净机器能不能装成"正是这条检查要回答的问题，
 *    盖住之后它就成了假绿。让它真下一次，第 1 阶段的越界立刻现形（B10）。
 */
const sourceEntry = runtimeFiles.find((f) => f.set === 'source');
const copyFiles = runtimeFiles.filter((f) => f.set !== 'source');

const missing = [];
for (const f of copyFiles) {
  const src = findSourceArchive(f);
  if (!src) {
    missing.push(`${f.id} → 期望文件名 ${destName(f)}`);
    continue;
  }
  fs.copyFileSync(src, path.join(RT, '.download-cache', destName(f)));
}
if (!sourceEntry || !findSourceArchive(sourceEntry)) {
  missing.push(`${sourceEntry ? sourceEntry.id : 'engine_source'} → 真实缓存里找不到上游源码归档`);
}
if (missing.length > 0) {
  console.error(
    `✗ 真实缓存里缺这些归档（目录：${CACHE_SRC}）：\n  · ${missing.join('\n  · ')}\n` +
      '  先跑 npm run task -- setup:engine 把它们下下来。',
  );
  process.exit(1);
}

// ------------------------------------------------------------------ 夹具模型 + mock http

/** 极小的真 tar.gz（顶层目录 `top/` ⇒ extractStrip=1 后内容直接落在目标目录）。 */
const stageTar = path.join(WORK, 'stage');
fs.mkdirSync(path.join(stageTar, 'top'), { recursive: true });
fs.writeFileSync(path.join(stageTar, 'top', 'hello.txt'), 'miao-dock fixture\n');
const FIXTURE_TAR = path.join(WORK, 'fixture-arch.tar.gz');
{
  const r = spawnSync('tar', ['-czf', FIXTURE_TAR, '-C', stageTar, 'top'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`✗ 造夹具归档失败（需要系统 tar）：${r.stderr ?? ''}`);
    process.exit(1);
  }
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const plainA = Buffer.from('fixture model A\n'.repeat(64));
const plainC = Buffer.from('fixture model C (stage2)\n'.repeat(64));
const tarBytes = fs.readFileSync(FIXTURE_TAR);

/**
 * mock 服务器**跑在独立进程里**。
 *
 * 🔴 为什么不能是进程内 `http.createServer`：本脚本用 `spawnSync` 跑 boxsvc，
 *    而 `spawnSync` 会**阻塞 Node 的事件循环** —— 进程内的 server 一个请求都收不到。
 *    真机症状极具误导性：产品日志里是 `[重试] … 第 1/2/3 次中断` → `[源放弃]` → 整段装配失败，
 *    看起来像"网络不通"，而实际上是**我们自己的测试脚本把自己饿死了**。
 */
const PAYLOAD_DIR = path.join(WORK, 'payloads');
fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
fs.writeFileSync(path.join(PAYLOAD_DIR, 'fixture-a.bin'), plainA);
fs.writeFileSync(path.join(PAYLOAD_DIR, 'fixture-c.bin'), plainC);
// 🔴 归档的**请求路径来自 url 末段**（`arch-from-url.tar.gz`），而落点来自 `dest`
//    （`fixture-arch.tar.gz`）—— 两处故意不同名，B7 靠这个差异咬人。
fs.writeFileSync(path.join(PAYLOAD_DIR, 'arch-from-url.tar.gz'), tarBytes);
// 上游源码归档的字节（从本机真实缓存**只读**取出，绝不改用户的落点）—— 由 mock http 下发。
const SOURCE_BYTES = fs.readFileSync(findSourceArchive(sourceEntry));
// 同一条"请求路径 ≠ 落点"的差异也钉在 runtime 侧（`engine-src-from-url.tar.gz` → `dest`）。
fs.writeFileSync(path.join(PAYLOAD_DIR, 'engine-src-from-url.tar.gz'), SOURCE_BYTES);

const MOCK_SCRIPT = path.join(WORK, 'mock-server.mjs');
fs.writeFileSync(
  MOCK_SCRIPT,
  `
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const dir = process.argv[2];
const srv = http.createServer((req, res) => {
  const name = decodeURIComponent(String(req.url ?? '/').replace(/^\\//, ''));
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) { res.writeHead(404, { 'content-length': 0 }); res.end(); return; }
  const body = fs.readFileSync(p);
  const range = /^bytes=(\\d+)-/.exec(String(req.headers.range ?? ''));
  if (range) {
    const from = Number(range[1]);
    res.writeHead(206, { 'content-length': body.length - from, 'content-range': 'bytes ' + from + '-' + (body.length - 1) + '/' + body.length });
    res.end(body.subarray(from));
    return;
  }
  res.writeHead(200, { 'content-length': body.length });
  res.end(body);
});
srv.listen(0, '127.0.0.1', () => console.log('READY ' + srv.address().port));
`,
);

const server = spawn(process.execPath, [MOCK_SCRIPT, PAYLOAD_DIR], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverErr = '';
server.stderr.on('data', (d) => {
  serverErr += String(d);
});
const PORT = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`mock 服务器 5s 未就绪：${serverErr}`)), 5000);
  server.stdout.on('data', (d) => {
    const m = /READY (\d+)/.exec(String(d));
    if (m) {
      clearTimeout(t);
      resolve(Number(m[1]));
    }
  });
}).catch((e) => {
  console.error(`✗ 起 mock 服务器失败：${e.message}`);
  process.exit(1);
});
const base = `http://127.0.0.1:${PORT}`;

/**
 * 夹具运行时清单 = 真清单，**只**把 `engine_source` 一条的下载源改成 mock。
 *
 * `sources` 必须清空：留着真 codeload / ghfast 地址，"不联网也能装成"这句话就是假的
 * （真源可达时它会去连，可达与否会让这条检查时红时绿）。
 */
const FIXTURE_RUNTIME = path.join(WORK, 'fixture-runtime.json');
{
  const m = JSON.parse(fs.readFileSync(RUNTIME_MANIFEST, 'utf8'));
  const e = m.files.find((f) => f.id === sourceEntry.id);
  e.url = `${base}/engine-src-from-url.tar.gz`;
  e.sources = [];
  e.sha256 = sha256(SOURCE_BYTES);
  e.sizeBytes = SOURCE_BYTES.length;
  fs.writeFileSync(FIXTURE_RUNTIME, JSON.stringify(m, null, 2));
}

/**
 * 夹具模型清单。🔴 `fixture_archive` 那条的 `dest`（`fixture-arch.tar.gz`）与 `url` 末段
 * **故意不同名**（url 是 `arch-from-url.tar.gz`）—— 这正是 B7 要咬的那一处：
 * 按 url 找就会落空，按 dest 找才对。
 */
const FIXTURE_MODELS = path.join(WORK, 'fixture-models.json');
const FIXTURE_REQ = path.join(WORK, 'fixture-requirements.txt');
const CRF_LINE = 'pydensecrf@https://github.com/username/pydensecrf/archive/master.zip';

function writeFixtureManifest() {
  fs.writeFileSync(
    FIXTURE_MODELS,
    JSON.stringify(
      {
        manifestVersion: 1,
        engineCommit: runtime.engineCommit,
        sets: {
          visual: { files: ['fixture_plain'] },
          runtime: { files: ['fixture_archive'] },
          llm: { files: ['fixture_llm'] },
        },
        files: [
          {
            id: 'fixture_plain',
            set: 'visual',
            stage: 1,
            dest: 'models-store/fixture/a.bin',
            linkTo: 'models/fixture-a.bin',
            sha256: sha256(plainA),
            sizeBytes: plainA.length,
            url: `${base}/fixture-a.bin`,
          },
          {
            id: 'fixture_archive',
            set: 'runtime',
            stage: 1,
            dest: 'fixture-arch.tar.gz',
            extractTo: 'bin/fixture',
            extractStrip: 1,
            sha256: sha256(tarBytes),
            sizeBytes: tarBytes.length,
            url: `${base}/arch-from-url.tar.gz`,
          },
          {
            id: 'fixture_llm',
            set: 'llm',
            stage: 2,
            dest: 'models-store/fixture/c.bin',
            sha256: sha256(plainC),
            sizeBytes: plainC.length,
            url: `${base}/fixture-c.bin`,
          },
        ],
      },
      null,
      2,
    ),
  );
}
writeFixtureManifest();

/**
 * 夹具 requirements。
 * 🔴 `numpy` 必须真的在（`pydensecrf.utils` 会 `import numpy`）—— 自检①要真跑，就得让它真有依赖。
 * 🔴 注释里那个中文是**故意留的**：它让"pip 按 GBK 解码 UTF-8 清单"那条潜在风险变成
 *    每次跑都真验一遍（中文 Windows 上不设 `PYTHONUTF8` 时，这一行就会让整个装配炸掉）。
 */
function writeFixtureReq(pkg = 'six') {
  fs.writeFileSync(
    FIXTURE_REQ,
    [
      '# 夹具：只验两批的顺序与各自成功，不拉真 torch（这行有中文，顺带咬 GBK 解码那条路）',
      pkg,
      'numpy',
      CRF_LINE,
      '',
    ].join('\n'),
  );
}
writeFixtureReq();

// ------------------------------------------------------------------ 跑一次装配

/**
 * 跑产品的装配入口。
 * `stage === undefined` ⇒ 不带 `--stage`（全量：夹具三条都下）。
 */
function bootstrap({ stage, reqFile = FIXTURE_REQ, manifest = WHEELS_MANIFEST, skipEngineImport = true } = {}) {
  const args = ['--fetch-models', '--engine-bootstrap', '--extract'];
  if (stage !== undefined) args.push('--stage', String(stage));
  args.push('--root', MODEL_ROOT, '--manifest', FIXTURE_MODELS);
  const env = {
    ...process.env,
    MIAO_RUNTIME_ROOT: RUNTIME_ROOT,
    MIAO_MODEL_ROOT: MODEL_ROOT,
    MIAO_STATE_DIR: STATE,
    MIAO_RUNTIME_MANIFEST: FIXTURE_RUNTIME,
    MIAO_WHEELS_MANIFEST: manifest,
    MIAO_REQUIREMENTS: reqFile,
    // 🔴 不用 `MIAO_ASSET_BASE`：产品下载路径目前**不消费**它（`paths::asset_url` 在
    //    Rust 侧是死代码，下载走的是清单里的 `url`/`sources`）。夹具因此把 mock 地址
    //    直接写进清单的 `url` —— 少一层假设，也顺便把"这条路当前的真实行为"固定下来。
    MIAO_ASSET_BASE: '',
  };
  // 自检②（引擎级：torch / torchvision / mask_refinement）在夹具里**必须**被旁路 ——
  // 真 torch 是 4–6 GB，而本脚本验的是装配链本身。旁路只能关这一半：自检①（pydensecrf）
  // 不认这个开关，所以"随包 wheel 装上时真能 import"这条仍然是被真跑的。
  if (skipEngineImport) env.MIAO_SKIP_ENGINE_IMPORT = '1';
  else delete env.MIAO_SKIP_ENGINE_IMPORT;
  const r = spawnSync(BOXSVC, args, { cwd: ROOT, encoding: 'utf8', timeout: 900_000, env });
  return { ...r, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

console.log(`\n夹具版真装配 · 落点 ${WORK}\n  真实缓存 ${CACHE_SRC}\n`);

const res = bootstrap({});
const out = res.out;
if (res.status !== 0) {
  console.log(`  （装配退出码 ${res.status}，末尾输出如下）\n${out.slice(-1800)}\n`);
}

// ---- B1 阶段顺序：源码解包 / 补丁 必须在「批 A」之前 ----
{
  const iSrc = out.indexOf('下载并解包引擎源码');
  const iPatch = out.indexOf('应用引擎源码补丁');
  const iBatchA = out.indexOf('批 A：安装主依赖');
  check(
    'B1 阶段顺序：源码解包与补丁在依赖安装之前（旧顺序 ⇒ 依赖阶段找不到清单）',
    iSrc >= 0 && iPatch >= 0 && iBatchA >= 0 && iSrc < iBatchA && iPatch < iBatchA,
    { iSrc, iPatch, iBatchA },
  );
}

// ---- B2 批 A 真装了 ----
{
  const sitePkgs = path.join(RT, 'venv', 'Lib', 'site-packages');
  const sixOk = fs.existsSync(path.join(sitePkgs, 'six.py')) || fs.existsSync(path.join(sitePkgs, 'six'));
  check(
    'B2 批 A 真装了（夹具里的 six 落在 venv 的 site-packages，不是只看日志）',
    sixOk && out.includes('✓ 批 A 完成'),
    { sitePkgs, sixOk },
  );
}

// ---- B3 批 B 命中随包 wheel，不联网、不编译 ----
check(
  'B3 批 B 命中**随包** wheel（`--no-index --no-deps`，未编译）',
  out.includes('预编译 wheel') && out.includes('✓ 批 B 完成（预编译 wheel，未编译）'),
  { route: /pydensecrf 路线：[^\n]*/.exec(out)?.[0] },
);

// ---- B4 兼容补丁真写进 venv ----
{
  const crfInit = path.join(RT, 'venv', 'Lib', 'site-packages', 'pydensecrf', '__init__.py');
  let t = '';
  try {
    t = fs.readFileSync(crfInit, 'utf8');
  } catch {
    /* 由断言报 */
  }
  check(
    'B4 旧常量兼容补丁写进 venv 的 pydensecrf/__init__.py（marker 与仓库脚本逐字节相同）',
    t.includes('# >>> miao-dock: pydensecrf 旧常量兼容补丁') && t.includes('DIAG_KERNEL'),
    { crfInit, hasMarker: t.includes('# >>> miao-dock: pydensecrf 旧常量兼容补丁') },
  );
}

// ---- B5 导入自检①真过了（pydensecrf 能 import、旧常量在；**不是**只看日志字样）----
//      产品那条命令带 `assert hasattr(d, "DIAG_KERNEL")`：它真跑在 venv 里，过不了就没这行。
check(
  'B5 自检①真过：venv 里 `pydensecrf.densecrf` 可 import 且旧常量在（随包 wheel + 兼容补丁端到端生效）',
  out.includes('✓ 自检①：pydensecrf 可 import，旧常量已回填'),
);

// ---- B5b 夹具旁路只关掉了自检②，且产品**明说**它被跳过了 ----
{
  const skipped = out.includes('已按 MIAO_SKIP_ENGINE_IMPORT=1 跳过自检②');
  const halfOk = out.includes('✓ 自检①：pydensecrf 可 import，旧常量已回填');
  check('B5b 夹具旁路只关掉自检②（引擎级），且日志如实声明被跳过 —— 自检① 仍然真跑', skipped && halfOk, {
    skipped,
    halfOk,
  });
}

// ---- B6 长路径体检落进就绪标记 ----
{
  const markerPath = path.join(RT, '.runtime.ready.json');
  let m = null;
  try {
    m = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    /* 由断言报 */
  }
  check(
    'B6 长路径体检写进 .runtime.ready.json 的 longPath 段（maxChars / limit=260 / margin 齐备）',
    !!m &&
      typeof m.longPath?.maxChars === 'number' &&
      m.longPath?.limit === 260 &&
      typeof m.longPath?.margin === 'number',
    { longPath: m?.longPath },
  );
}

// ---- B7 解包按 dest 找归档（dest 与 url 末段不同名）----
{
  const hello = path.join(MODEL_ROOT, 'bin', 'fixture', 'hello.txt');
  const store = path.join(RT, '.download-cache', destName(runtimeFiles.find((f) => f.id === 'engine_source')));
  const srcTree = path.join(RT, 'src', 'manga_translator');
  check(
    'B7 解包按 `dest` 找归档（夹具里 dest 与 url 末段故意不同名）：运行时源码树与夹具归档都解出来了',
    fs.existsSync(srcTree) && fs.existsSync(hello) && fs.existsSync(store),
    { srcTree, hello, store },
  );
}

// ---- B8 模型侧：平铺件落 store + 按 linkTo 建链 ----
{
  const storeFile = path.join(MODEL_ROOT, 'models-store', 'fixture', 'a.bin');
  const linkFile = path.join(MODEL_ROOT, 'src', 'models', 'fixture-a.bin');
  check(
    'B8 模型侧：平铺件落 store、并按 linkTo 在引擎树里建出链接',
    fs.existsSync(storeFile) && fs.existsSync(linkFile),
    { storeFile, linkFile },
  );
}

// ---- B9 夹具清单里 stage1/stage2 都下到了（全量跑不分阶段）----
check(
  'B9 全量跑（不带 --stage）：stage2 的夹具条目也下到了',
  fs.existsSync(path.join(MODEL_ROOT, 'models-store', 'fixture', 'c.bin')),
);

// ---- B10 引擎源码是**产品自己下**的（第 1 阶段不许去解还没下载的归档）----
//      🔴 照与反照成对：B7 看"解出来了"，B10 看"字节是从 mock 下下来的、哈希对得上" ——
//      两个一起，才排得掉"把归档预放进缓存然后把越界解包盖住"这种假绿。
{
  const cached = path.join(RT, '.download-cache', destName(sourceEntry));
  const got = fs.existsSync(cached) ? sha256(fs.readFileSync(cached)) : null;
  check(
    'B10 引擎源码由产品在**第 3 阶段**从 mock http 下下来（按 `dest` 落缓存、哈希对得上）—— 预放缓存会把"第 1 阶段越界解包"盖住',
    got === sha256(SOURCE_BYTES),
    { cached, gotHash: got ? got.slice(0, 12) : null, wantHash: sha256(SOURCE_BYTES).slice(0, 12) },
  );
}

// ------------------------------------------------------------------ 反证轮

if (REFUTE) {
  console.log('\n── 反证轮（改夹具 ⇒ 指定断言必须红；跑完还原）──\n');

  // R1：**两条路一起掐**（清单里没有本平台 wheel + requirements 里没有直链行）⇒ 立即如实报错。
  //
  // 🔴 为什么必须两条一起掐：单独删掉 requirements 里的直链行**并不会**让 B3 红 ——
  //    wheel 路线根本不读 requirements（它读清单 + 哈希）。第一次写成那样时它确实没红，
  //    这正是"反证轮必须真跑一遍"的价值：一个想当然的反证等于没有反证。
  //    两条都掐掉后落回源码编译，而源码编译需要直链行 ⇒ 确定性失败，且不联网。
  {
    const backup = fs.readFileSync(FIXTURE_REQ, 'utf8');
    const emptyWheels = path.join(WORK, 'empty-wheels.json');
    fs.writeFileSync(emptyWheels, JSON.stringify({ wheels: [] }, null, 2));
    fs.writeFileSync(
      FIXTURE_REQ,
      backup
        .split('\n')
        .filter((l) => !l.startsWith('pydensecrf@'))
        .join('\n'),
    );
    const r = bootstrap({ manifest: emptyWheels });
    const red =
      r.status !== 0 && !r.out.includes('✓ 批 B 完成（预编译 wheel，未编译）') && /没有 pydensecrf 直链行/.test(r.out);
    check('R1 清单无本平台 wheel 且 requirements 无直链行 ⇒ B3 红（两条路都断了，如实报错）', red, {
      code: r.status,
      sawReason: /没有 pydensecrf 直链行/.test(r.out),
    });
    fs.writeFileSync(FIXTURE_REQ, backup);
  }

  // R2：wheel 清单 sha256 改坏 ⇒ 拒绝使用、回退源码编译（无编译器 ⇒ 失败）。
  {
    const backup = fs.readFileSync(WHEELS_MANIFEST, 'utf8');
    const wj = JSON.parse(backup);
    for (const w of wj.wheels) w.sha256 = '0'.repeat(64);
    fs.writeFileSync(WHEELS_MANIFEST, JSON.stringify(wj, null, 2));
    const r = bootstrap({});
    const red =
      r.status !== 0 && !r.out.includes('✓ 批 B 完成（预编译 wheel，未编译）') && r.out.includes('sha256 与清单不符');
    check('R2 wheel 清单 sha256 改坏 ⇒ B3 红（宁可回退源码编译，也不装没验过的东西）', red, {
      code: r.status,
      sawReason: r.out.includes('sha256 与清单不符'),
    });
    fs.writeFileSync(WHEELS_MANIFEST, backup);
  }

  // R3：批 A 装一个不存在的包 ⇒ 批 A 失败（证明 B2 不是"读日志字面量"）。
  {
    writeFixtureReq('this-package-does-not-exist-miao-fixture');
    const r = bootstrap({});
    const red = r.status !== 0 && !r.out.includes('✓ 批 A 完成');
    check('R3 批 A 装一个不存在的包 ⇒ B2 红（三个断言都不是只看日志字样）', red, { code: r.status });
    writeFixtureReq();
  }

  // R4：**不设**旁路 ⇒ 自检② 必须真失败（证明那道闸门存在，且旁路确实只影响它）。
  {
    const r = bootstrap({ skipEngineImport: false });
    const red = r.status !== 0 && /自检②未通过/.test(r.out);
    check('R4 不设 MIAO_SKIP_ENGINE_IMPORT ⇒ 自检② 真失败（夹具没有 torch，闸门确实在）', red, {
      code: r.status,
      saw: /自检②未通过/.test(r.out),
    });
  }

  check(
    'R5 变异收尾：夹具 requirements 与 wheel 清单按字节还原',
    fs.readFileSync(FIXTURE_REQ, 'utf8').includes('pydensecrf@') &&
      JSON.parse(fs.readFileSync(WHEELS_MANIFEST, 'utf8')).wheels[0].sha256 ===
        'f4b5b28d8b5e600adb60b891cdbe3b2540fbe75c2bea4003faa007bbed313cbd',
  );
}

server.kill();
console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
