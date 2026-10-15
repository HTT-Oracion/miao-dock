#!/usr/bin/env node
/**
 * S6 · 设置页数据面验收（《02》§5 / 《09》§4.3 / §6.2 / §6.3）
 * =============================================================================
 * S6 交付的是 **Box UI**，但 UI 本身没法在这里验（要真窗口）。所以本脚本验的是
 * **UI 背后的服务端事实** —— 也就是"界面上的每一个控件，服务端到底给不给他数据、
 * 收不收他的输入、改完什么时候生效"。这四件事错一件，UI 就会变成假控件。
 *
 * 四组断言，逐组对应一条纪律：
 *
 * | 组 | 验什么 | 纪律出处 |
 * |---|---|---|
 * | **G** | `GET /engine/options` 的形状与**筛选**（16GB Mac 不出现 Medium / Metal 机不出现 CUDA） | 《02》§5「物理不可行档位不出现」 |
 * | **S** | `POST /engine/settings` 的**拒绝面**（未知键/非法值/不可行项一律 400，不静默丢） | 本项目头号纪律（假绿） |
 * | **R** | 写进去的东西**真能读回来**（重启后生效）+ **env 优先** + 坏文件不阻断启动 | 《04》§7.2 / §8.3 |
 * | **U** | `POST /engine/unload`（真能释放 ③）· `POST /engine/models/verify`（**真算 sha256**） | 《09》§6.2 三个操作 |
 * | **D** | `POST /engine/models/download` 的**任务语义**：启动即返回 / 并发 409 / 终态与 tail / 失败可重试 | 《02》§5「重新下载模型」 |
 *
 * ## 为什么"拒绝面"值得单独一组
 * 设置页最坏的失败形态不是"改不了"，而是**"改了、界面说保存成功、其实什么都没发生"**。
 * 所以每一个**不该被接受**的输入都必须有一条断言盯着它被拒绝，且拒绝理由要指得出
 * 「可选什么」。一组只测 happy path 的断言，恰好对这类缺陷完全无感。
 *
 * ## 关键取证（都不信"自报"）
 *   · **写盘**：断言完响应后**回读那个 JSON 文件**，不比"响应里说了什么"。
 *   · **重启后生效**：另起一个同 state 目录的服务实例，从它嘴里问出 `configured` 与 `source`。
 *   · **拒绝要落到盘上**：被拒的请求之后，设置文件**必须仍然不存在** ——
 *     只断言 400 是不够的（先写盘再报错也满足它）。
 *   · **unload 真释放**：看 `/engine/status` 的 `llm.state` 从 `running` 变 `stopped`，
 *     而不是看 unload 接口自己返回的 `{ok:true}`。
 *   · **verify 真算哈希**：拿一个**空模型根目录**去校验，必须报 `missing = total`；
 *     若它只判"文件在不在"，`total` 都会是 0 而不是"全部缺失"。
 *
 * 用法：
 *   node e2e/service/engine-settings-check.mjs            正向
 *   node e2e/service/engine-settings-check.mjs --refute   反证轮（逃生开关 → 指定断言必须变红）
 *
 * 约束：纯 Node、零第三方依赖；临时目录自建自清；不占 5180–5190（manga-service 的段）。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
// F0：服务入口解析的唯一事实源（MIAO_SERVICE_IMPL=node|rust 切换靶子）
import { killTree, SERVICE_ENTRY, spawnTarget } from './_service-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SELF = path.join(ROOT, 'e2e', 'service', 'engine-settings-check.mjs');
const MOCK_ENGINE = path.join(ROOT, 'engine', 'src', 'server.mjs');
const MOCK_LLM = path.join(ROOT, 'engine', 'src', 'mock-llm.mjs');
const TOKEN = 's'.repeat(64);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-settings-'));
const REFUTE = process.argv.includes('--refute');

const sleep = (ms) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

// ------------------------------------------------------------------ 结果收集

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}
function matchById(list, code) {
  return list.find((r) => r.id === code || r.id.startsWith(`${code} `));
}
function printResults(title) {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n### ${title}`);
  for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.id}${r.detail ? `  ${r.detail}` : ''}`);
  console.log(`[RESULT] ${JSON.stringify({ results, pass, fail: results.length - pass })}`);
  console.log(`\n通过 ${pass} / 失败 ${results.length - pass}`);
  return { pass, fail: results.length - pass };
}

// ------------------------------------------------------------------ HTTP / 端口

function httpReq(port, method, pathname, { headers = {}, body = null, token } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (token) h['X-Box-Token'] = token;
    if (body) h['Content-Length'] = body.length;
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const jsonOf = (res) => {
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    return null;
  }
};

/** 带令牌的 GET */
const get = (port, p) => httpReq(port, 'GET', p, { token: TOKEN });
/** 带令牌的 POST（JSON） */
const post = (port, p, obj) =>
  httpReq(port, 'POST', p, {
    token: TOKEN,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(obj), 'utf8'),
  });

function portOpen(port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        s.destroy();
        resolve(v);
      }
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function findFreePort(start, { need = 1 } = {}) {
  for (let p = start; p < start + 400; p += 1) {
    let ok = true;
    for (let i = 0; i < need; i += 1)
      if (await portOpen(p + i, 80)) {
        ok = false;
        break;
      }
    if (ok) return p;
  }
  throw new Error(`从 ${start} 起找不到 ${need} 个连续空闲端口`);
}
const freePorts = async (start, n = 1) => {
  const p = await findFreePort(start, { need: n });
  return Array.from({ length: n }, (_, i) => p + i);
};

// ------------------------------------------------------------------ 进程夹具

function spawnProc(entry, env, tag, args = []) {
  // entry 是服务 ⇒ 按 MIAO_SERVICE_IMPL 选靶子；是 mock 引擎 ⇒ 原样走 node
  const child = spawnTarget(entry, env, args);
  const st = { child, tag, out: '', err: '', ready: null };
  child.stdout.on('data', (d) => {
    st.out += d.toString();
    const m = /MIAO_READY (\{.*\})/.exec(st.out);
    if (m && !st.ready) {
      try {
        st.ready = JSON.parse(m[1]);
      } catch {
        /* 继续等 */
      }
    }
  });
  child.stderr.on('data', (d) => {
    st.err += d.toString();
  });
  return st;
}

async function waitReady(st, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (!st.ready && Date.now() < until) await sleep(40);
  if (!st.ready) throw new Error(`${st.tag} 未就绪：stdout=${st.out}\nstderr=${st.err}`);
  return st.ready;
}

function killProc(st) {
  // 🔴 杀进程树（不是只杀主进程）：rust 服务派生的引擎②/③ 否则全成孤儿（D-202）
  if (st && st.child.exitCode === null) killTree(st.child);
}

async function waitLlmRunning(port, timeoutMs = 12_000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    const v = jsonOf(await get(port, '/api/v1/engine/status'));
    last = v?.llm?.state ?? null;
    if (last === 'running') return v;
    await sleep(80);
  }
  return { llm: { state: last } };
}

// ------------------------------------------------------------------ 设置文件小工具

const settingsFileOf = (stateDir) => path.join(stateDir, 'engine-settings.json');
/** **回读盘** —— 拒绝面/happy path 都以盘上内容为准，不以响应自报为准 */
function readSettingsFile(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(settingsFileOf(stateDir), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 「假下载器」夹具 —— 走 `MIAO_MODEL_DOWNLOAD_RUNNER` 这个接缝替换掉真执行体。
 *
 * ## 为什么必须替换，而不是真跑一次 `--fetch-models`
 * 真下载要**联网 + 几 GB + 十几分钟**，且不可重放（第二次会因为已就绪而立刻结束，
 * 于是 `running` 那一刻根本观察不到）。而 D 组要验的恰恰是**状态机**：
 * 启动即返回、并发被 409 挡住、终态被记下来、tail 转发的是子进程真输出。
 * 这些与"下载器实现得对不对"无关（那是 S3 的 `check:models` 在管）。
 *
 * ## 🔴 A3d 起夹具从「一个假脚本」改成「**一份夹具清单**」
 * 产品的执行体是 `mangasvc`（一个真 `.exe`），不再隐含解释器。那么"假执行体"就造不出来了：
 * Windows 上 `spawn()` 一个 `.cmd`/`.bat` 会直接 **EINVAL**（Node 22 的安全策略，
 * 无 shell 不允许起批处理），而造一个真 `.exe` 又不现实。
 * ⇒ 改用已有的 `MIAO_MODEL_MANIFEST` 接缝控制行为：**执行体仍是产品那个**，
 *   只是喂给它的清单不同（真清单 = 成功；非法 JSON = 失败）。
 *   顺带的好处是这条组现在量的是**产品真实执行体的状态机**，不再是一个假的替身。
 *
 * ## 为什么要几百毫秒（而不是立刻结束）
 * 太短则第二个请求可能撞在"已经跑完"上 —— 那时 409 与 200 都会出现，
 * 断言就变成**靠运气**（这类"偶尔绿"的断言比红更坏：它会在某次 CI 上静默失效）。
 * 真清单 17 个条目走 cached 复用（读 `.ready` + 逐个 stat）刚好够这个量级。
 */
function writeFakeManifest(base, { fail = false } = {}) {
  const file = `${base}.json`;
  if (fail) {
    // 非法 JSON ⇒ 执行体连清单都读不出来 ⇒ 立刻失败退出（`MODEL_MANIFEST_BAD`）。
    // 这就是"失败夹具"：不需要一个会 exit 3 的假可执行文件 —— 那条路在 Windows 上走不通（见下）。
    fs.writeFileSync(file, '{ this is not json');
    return file;
  }
  // 成功夹具 = **真清单的一份拷贝**：模型都已就位 ⇒ 走 cached 复用，零网络、几百毫秒结束。
  fs.copyFileSync(path.join(ROOT, 'engine', 'models.manifest.json'), file);
  return file;
}

/**
 * D 组的「成功夹具」：**自带一个已就位的微型模型根**。
 *
 * 🔴 B1 起不能只拷真清单了：模型根默认值从「仓库 runtimes/」搬到了 `<appData>/runtimes`
 *    （打包后仓库根必然算错，A1 已论证），而 appData 那份在验收机上**是空的** ——
 *    只拷清单 ⇒ 执行体真去下 294 MB ⇒ D4/D5 轮询超时，而且**往用户真实环境里写数据**。
 *    验收夹具绝不允许碰用户目录（同 `MIAO_ROOT` / `MIAO_STATE_DIR` 一律指 TMP）。
 *
 * 做法：一条 1 字节的条目 + 预先写好且 sha256 正确的文件 ⇒ `ensureModels` 判"存在且哈希对"
 * 就直接复用（不打网络），`--link` 也按 `linkBase` 建链。D 组验的是**状态机**（立即返回 /
 * 409 / 终态 / tail 转发），下载正确性归 S3 的 `check:models` 双靶，故一条足够。
 */
function writeReadyModelRoot(base) {
  const modelsRoot = path.join(base, 'models');
  const destRel = 'fixture/dummy.bin';
  const bytes = Buffer.from('fixture-not-real-weights');
  fs.mkdirSync(path.join(modelsRoot, 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(modelsRoot, destRel), bytes);
  const manifest = {
    manifestVersion: 1,
    files: [
      {
        id: 'fixture_dummy',
        set: 'visual',
        dest: destRel,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        url: 'https://fixture.invalid/dummy.bin',
      },
    ],
  };
  const manifestPath = `${base}.json`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  return { manifestPath, modelsRoot };
}

function baseEnv(svcPort, stateDir, extra = {}) {
  return {
    MIAO_PORT: String(svcPort),
    MIAO_ROOT: path.join(TMP, `root-${svcPort}`),
    MIAO_STATE_DIR: stateDir,
    MIAO_TOKEN: TOKEN,
    // 本脚本关心的是**设置面**，不是三进程生命周期（那有专门的脚本）。
    // 除 U 组那条"真释放 ③"以外，一律不起 ③，免得几个实例互抢端口。
    MIAO_NO_LLM_AUTOSTART: '1',
    ...extra,
  };
}

async function withService(env, tag, fn, { timeoutMs = 15_000 } = {}) {
  const st = spawnProc(SERVICE_ENTRY, env, tag);
  try {
    const info = await waitReady(st, timeoutMs);
    return await fn(info, st);
  } finally {
    killProc(st);
    await sleep(120);
  }
}

// ================================================================ G · options

/** G：`GET /engine/options` 的形状与**筛选** */
async function assertOptions(port, label, { expectTier, expectSource, expectModelDirSource = null } = {}) {
  const noToken = await httpReq(port, 'GET', '/api/v1/engine/options');
  check(
    `G1 /engine/options 无令牌 → 403 PERMISSION_DENIED（Box 专用端点，不是免鉴权例外）（${label}）`,
    noToken.status === 403 && jsonOf(noToken)?.error?.code === 'PERMISSION_DENIED',
    `${noToken.status} ${jsonOf(noToken)?.error?.code}`,
  );

  const res = await get(port, '/api/v1/engine/options');
  const v = jsonOf(res);
  const top = [
    'protocol',
    'hardware',
    'tier',
    'accel',
    'idle',
    'modelDir',
    'models',
    'restartRequiredKeys',
    'settingsFile',
  ];
  check(
    `G2 带令牌 → 200 且顶层 9 键齐（设置页两小节的数据全在这里）（${label}）`,
    res.status === 200 && v && top.every((k) => k in v) && Object.keys(v).length === top.length,
    res.status === 200 ? Object.keys(v || {}).join(',') : `status=${res.status}`,
  );

  // 《02》§5「物理不可行档位不出现」—— 本机 16 GB ⇒ Medium(17.6 GB) 必须**不出现**
  const tiers = (v?.tier?.options ?? []).map((o) => o.tier);
  const ram = v?.hardware?.totalRamGb;
  const mediumFeasible = ram >= 17.6;
  check(
    `G3 档位候选只含**物理可行**档位（《02》§5）：ram=${ram}GB ⇒ ${mediumFeasible ? 'Medium 可出现' : '**不得**出现 Medium'}（${label}）`,
    tiers.includes('tiny') && (mediumFeasible || !tiers.includes('medium')),
    tiers.join(','),
  );

  const top1 = v?.tier?.options?.[0];
  check(
    `G4 每个档位带 peakGb 与 recommended；非推荐档带 warning 文案（《02》§5 强警告的判据来源）（${label}）`,
    top1 &&
      typeof top1.peakGb === 'number' &&
      typeof top1.recommended === 'boolean' &&
      v.tier.options.every((o) => o.recommended === true || (typeof o.warning === 'string' && o.warning.length > 0)) &&
      v.tier.options.some((o) => o.recommended === true),
    JSON.stringify(v?.tier?.options),
  );

  check(
    `G4b 默认（未配置）时 tier.configured=null、source=${expectTier === null ? 'hardware' : '?'}（"没改过"必须能与"改过"区分）（${label}）`,
    expectTier === undefined || (v?.tier?.configured === expectTier && v?.tier?.source === expectSource),
    `configured=${v?.tier?.configured} source=${v?.tier?.source}`,
  );

  // 后端候选同理：Metal 机不得出现 cuda
  const accels = (v?.accel?.options ?? []).map((o) => o.value);
  const hw = v?.accel?.hardwareRecommended;
  check(
    `G5 加速后端候选按硬件筛（《02》§5 同一把尺子）：hw=${hw} ⇒ ${hw === 'cpu' ? '只 auto|cpu' : `不得出现 ${hw === 'mps' ? 'cuda' : 'mps'} 之外的另一家`}（${label}）`,
    accels.includes('auto') &&
      accels.includes('cpu') &&
      (hw === 'cpu' ? accels.length === 2 : accels.includes(hw) && !accels.includes(hw === 'mps' ? 'cuda' : 'mps')),
    accels.join(','),
  );

  check(
    `G5b accel.effective ∈ cuda|mps|cpu（与 /health.sidecar.accel 同源，不会两边各说一套）（${label}）`,
    ['cuda', 'mps', 'cpu'].includes(v?.accel?.effective),
    String(v?.accel?.effective),
  );

  // 《02》§5：空闲卸载是「数字（分钟）」、默认 5 / 30、0 = 从不卸载
  check(
    `G6 空闲卸载默认 5 / 30 min（《02》§5 的出厂值）（${label}）`,
    v?.idle?.llm?.min === 5 && v?.idle?.vision?.min === 30,
    `${v?.idle?.llm?.min} / ${v?.idle?.vision?.min}`,
  );

  check(
    `G6b 空闲阈值同时给**毫秒事实**与**分钟展示**，并标出分钟是否精确（env 能压到秒级 ⇒ 界面不能瞎四舍五入）（${label}）`,
    typeof v?.idle?.llm?.ms === 'number' &&
      typeof v?.idle?.llm?.minIsExact === 'boolean' &&
      v.idle.llm.ms === v.idle.llm.min * 60_000,
    JSON.stringify(v?.idle?.llm),
  );

  check(
    `G7 modelDir 给出 current / defaultDir / exists / source（"恢复默认"要有目标可回）（${label}）`,
    v?.modelDir &&
      typeof v.modelDir.current === 'string' &&
      path.isAbsolute(v.modelDir.current) &&
      typeof v.modelDir.defaultDir === 'string' &&
      typeof v.modelDir.exists === 'boolean' &&
      v.modelDir.source === (expectModelDirSource ?? v.modelDir.source),
    JSON.stringify(v?.modelDir),
  );

  // 《09》§4.3：改档位/后端/模型目录需重启；§6.2 的两个空闲阈值里**只有视觉**跟着引擎走
  const rk = v?.restartRequiredKeys ?? [];
  check(
    `G8 restartRequiredKeys 恰为 [tier, accel, modelDir, idleVisionMin] —— 四个：` +
      'idleLlmMin **不在**其中（③ 归属 manga-service，可即时重建看护）（《09》§4.3 + 《04》§9.1）',
    rk.length === 4 && ['tier', 'accel', 'modelDir', 'idleVisionMin'].every((k) => rk.includes(k)),
    rk.join(','),
  );

  check(
    `G9 settingsFile 报出路径 + 白名单键 + 是否损坏（诊断视图要能指出"坏在哪"）（${label}）`,
    v?.settingsFile &&
      typeof v.settingsFile.path === 'string' &&
      Array.isArray(v.settingsFile.keys) &&
      v.settingsFile.keys.length === 5 &&
      typeof v.settingsFile.corrupt === 'boolean',
    JSON.stringify(v?.settingsFile),
  );
  return v;
}

// ================================================================ 正向

async function runPositive() {
  // ---------------------------------------------------------------- G + S · 主实例（mock 档、不起 ③）
  {
    const [engPort, svcPort] = await freePorts(5700, 2);
    const stateDir = path.join(TMP, `state-${svcPort}`);
    const eng = spawnProc(MOCK_ENGINE, { MIAO_ENGINE_PORT: String(engPort) }, `engine-${engPort}`);
    await sleep(400); // mock 引擎起得很快，但没有就绪行可等 ⇒ 用一次探活代替

    try {
      await withService(
        baseEnv(svcPort, stateDir, {
          MIAO_ENGINE_PROTOCOL: 'mock',
          MIAO_ENGINE_PORT: String(engPort),
        }),
        `service-G-${svcPort}`,
        async (info) => {
          // 引擎在跑 ⇒ `tier.effective` 才非 null（与 sidecar 同口径）
          const v = await assertOptions(info.port, 'G', { expectTier: null, expectSource: 'hardware' });
          check(
            'G0 引擎 running 时 tier.effective 有值（mock 档三档都有"模拟权重"⇒ 取硬件推荐 tiny）',
            v?.tier?.effective === 'tiny',
            String(v?.tier?.effective),
          );
          check(
            'G0b tier.source=hardware —— "这个值谁定的"必须答得出来（否则用户改不动的控件没法解释）',
            v?.tier?.source === 'hardware',
            String(v?.tier?.source),
          );

          /*
           * ---------------- D0 · 「重新下载模型」的**产品接缝** ----------------
           *
           * 这一台实例**不设** `MIAO_MODEL_DOWNLOAD_RUNNER`，所以它量的是产品路径：
           * 执行体是不是真的那个 `mangasvc`（A3d 起模型下载 / 校验都走它，不再有 .mjs 脚本）。
           * 夹具轮（下面的 D 组）会把这条接缝替换掉 —— 于是"夹具生效"与
           * "产品路径正确"必须分开断言，否则替换成功反而会把产品路径写错这件事盖住。
           *
           * ⚠️ 这里**绝不**发起下载：真跑一次要联网 + 几 GB。D0 只读初态。
           */
          const st = jsonOf(await get(info.port, '/api/v1/engine/status'));
          check(
            'D0 /engine/status.modelDownload 初态 idle、running=false，且 runner 指向产品执行体 mangasvc（它真的在盘上）',
            st?.modelDownload?.state === 'idle' &&
              st.modelDownload.running === false &&
              st.modelDownload.runnerExists === true &&
              /mangasvc(\.exe)?$/.test(st.modelDownload.runner ?? ''),
            JSON.stringify({
              state: st?.modelDownload?.state,
              exists: st?.modelDownload?.runnerExists,
              runner: st?.modelDownload?.runner,
            }),
          );
          check(
            'D0b 下载目标目录与设置页显示的 modelDir.current **是同一个**（各拿一份就会"下到别处去"）',
            st?.modelDownload?.rootDir === v?.modelDir?.current,
            `${st?.modelDownload?.rootDir} vs ${v?.modelDir?.current}`,
          );

          // ---------------- S · 拒绝面 ----------------
          const fileBefore = readSettingsFile(stateDir);
          check(
            'S0 前置：此刻设置文件**不存在**（拒绝面断言"拒绝不落盘"的前提）',
            fileBefore === null,
            JSON.stringify(fileBefore),
          );

          // ⚠️ 故意**同时带一个合法键**（idleLlmMin:3）。只发未知键的话，"静默丢弃"与
          //    "空补丁守卫"会**碰巧给出同一个 400** —— 断言仍然绿，但它测的已经不是白名单了。
          //    带上合法键之后：白名单在 ⇒ 整条请求被拒（合法键也**不许被部分应用**）；
          //    白名单不在 ⇒ 200 + 落盘，于是这条断言真的咬住了白名单。
          const r1 = await post(info.port, '/api/v1/engine/settings', { idleLlmMin: 3, idleLlmMinutes: 9 });
          const b1 = jsonOf(r1);
          check(
            'S1 未知键 → 400 INVALID_SETTING（**不是**静默丢弃；拼错一个键就必须当场炸）',
            r1.status === 400 &&
              b1?.error?.code === 'INVALID_SETTING' &&
              b1?.error?.details?.key === 'idleLlmMinutes' &&
              (b1?.error?.details?.allowed ?? []).length === 5,
            `${r1.status} ${b1?.error?.code} ${JSON.stringify(b1?.error?.details)}`,
          );
          check(
            'S1b 被拒之后**盘上仍然没有文件**（只断言 400 不够 —— 先写盘再报错也满足它）',
            readSettingsFile(stateDir) === null,
            JSON.stringify(readSettingsFile(stateDir)),
          );
          check(
            'S1c 请求是**原子**的：同一请求里的合法键 idleLlmMin=3 也**没有被应用**' +
              '（"部分成功"是设置写入最危险的一种结果：界面不知道该显示哪一半）',
            readSettingsFile(stateDir) === null,
            JSON.stringify(readSettingsFile(stateDir)),
          );

          const r2 = await post(info.port, '/api/v1/engine/settings', {});
          check(
            'S2 空补丁 → 400（一个 `POST {}` 若回"已保存"，那是最典型的假绿）',
            r2.status === 400 && jsonOf(r2)?.error?.code === 'INVALID_SETTING',
            `${r2.status} ${jsonOf(r2)?.error?.code}`,
          );

          const r3 = await post(info.port, '/api/v1/engine/settings', { tier: 'large' });
          const b3 = jsonOf(r3);
          check(
            'S3 档位取值非法 → 400，且**报的是取值域**（不是"缺权重"/"内存不够"）（顺序：先格式后能力）',
            r3.status === 400 &&
              b3?.error?.code === 'INVALID_SETTING' &&
              /tiny/.test(b3?.error?.message ?? '') &&
              !/权重/.test(b3?.error?.message ?? ''),
            b3?.error?.message?.slice(0, 90),
          );

          const r4 = await post(info.port, '/api/v1/engine/settings', { tier: 'medium' });
          const b4 = jsonOf(r4);
          check(
            'S4 16GB 机上 Medium 物理不可行 → 400，且理由里带**本机内存与该档峰值**（可核对，不是"不支持"）',
            r4.status === 400 &&
              b4?.error?.code === 'INVALID_SETTING' &&
              /物理不可行/.test(b4?.error?.message ?? '') &&
              /16 GB/.test(b4?.error?.message ?? ''),
            b4?.error?.message?.slice(0, 110),
          );

          const r5 = await post(info.port, '/api/v1/engine/settings', { accel: 'cuda' });
          const b5 = jsonOf(r5);
          check(
            'S5 本机（Metal）不可用的后端 cuda → 400，且列出**可选什么**（只说"不支持"等于把用户留在原地）',
            r5.status === 400 &&
              b5?.error?.code === 'INVALID_SETTING' &&
              /不可用/.test(b5?.error?.message ?? '') &&
              /auto/.test(b5?.error?.message ?? ''),
            b5?.error?.message?.slice(0, 110),
          );

          const r6 = await post(info.port, '/api/v1/engine/settings', { modelDir: '/nonexistent-xyz/deep/models' });
          check(
            'S6 模型目录的**上级都不存在** → 400（不然打错一层路径就会把 5–8 GB 权重下到那儿）',
            r6.status === 400 && jsonOf(r6)?.error?.code === 'INVALID_SETTING',
            jsonOf(r6)?.error?.message?.slice(0, 100),
          );

          const r7 = await post(info.port, '/api/v1/engine/settings', { modelDir: path.join(ROOT, 'package.json') });
          check(
            'S6b 模型目录指向一个**文件** → 400',
            r7.status === 400 && jsonOf(r7)?.error?.code === 'INVALID_SETTING',
            jsonOf(r7)?.error?.message?.slice(0, 100),
          );

          check(
            'S7 上面 7 次拒绝之后，盘上依然没有设置文件（拒绝面整体不落盘）',
            readSettingsFile(stateDir) === null,
            JSON.stringify(readSettingsFile(stateDir)),
          );

          // ---------------- S · 接受面 ----------------
          const ok1 = await post(info.port, '/api/v1/engine/settings', { idleLlmMin: 7 });
          const o1 = jsonOf(ok1);
          check(
            'S8 合法写入 idleLlmMin → 200，changed/restartRequired/appliedNow 三项都在（"保存成功"必须说明改了什么、什么时候生效）',
            ok1.status === 200 &&
              o1?.ok === true &&
              JSON.stringify(o1.changed) === '["idleLlmMin"]' &&
              o1.restartRequired === false &&
              JSON.stringify(o1.appliedNow) === '["idleLlmMin"]',
            JSON.stringify(o1),
          );
          check(
            'S8b **回读盘**：文件里真的有 idleLlmMin=7（不比响应自报）',
            readSettingsFile(stateDir)?.idleLlmMin === 7,
            JSON.stringify(readSettingsFile(stateDir)),
          );

          const ok2 = await post(info.port, '/api/v1/engine/settings', { tier: 'small', idleVisionMin: 45 });
          const o2 = jsonOf(ok2);
          check(
            'S9 改档位 + 视觉空闲 → restartRequired=true，且 restartRequiredKeys **恰为这两个**（不多不少）',
            ok2.status === 200 &&
              o2?.restartRequired === true &&
              JSON.stringify([...o2.restartRequiredKeys].sort()) === '["idleVisionMin","tier"]' &&
              JSON.stringify(o2.appliedNow) === '[]',
            JSON.stringify({ changed: o2?.changed, rk: o2?.restartRequiredKeys, now: o2?.appliedNow }),
          );
          check(
            'S9b 盘上：tier=small、idleVisionMin=45、idleLlmMin 仍是 7（**增量合并**，不是整份替换）',
            JSON.stringify(readSettingsFile(stateDir)) === '{"idleLlmMin":7,"tier":"small","idleVisionMin":45}',
            JSON.stringify(readSettingsFile(stateDir)),
          );

          // 改完之后 options 立刻反映新值（同一进程内不需要重启就能看见）
          const v2 = jsonOf(await get(info.port, '/api/v1/engine/options'));
          check(
            'S10 改完 options 立刻反映：idle.llm.min=7 且 source=file（界面不必重开就能看到自己刚改的值）',
            v2?.idle?.llm?.min === 7 && v2?.idle?.llm?.source === 'file',
            JSON.stringify(v2?.idle?.llm),
          );
          check(
            'S10b 重启前 tier.effective 仍是**旧档**（tier 是"要重启才生效"的那一类，界面据此亮提示条）',
            v2?.tier?.effective === 'tiny' && v2?.tier?.configured === 'small' && v2.tier.source === 'file',
            `effective=${v2?.tier?.effective} configured=${v2?.tier?.configured}`,
          );

          // ---------------- U · unload / verify ----------------
          const un1 = await post(info.port, '/api/v1/engine/unload', {});
          const u1 = jsonOf(un1);
          check(
            'U1 ③ 本来没在跑时 unload → **200 且 unloaded=false**（不是错误：空闲卸载是设计行为，《04》§9.4）',
            un1.status === 200 && u1?.ok === true && u1.unloaded === false && /未在运行/.test(u1.reason ?? ''),
            JSON.stringify(u1),
          );
        },
      );
    } finally {
      killProc(eng);
      await sleep(120);
    }
  }

  // ---------------------------------------------------------------- R · 重启后生效 + env 优先
  {
    const [svcPort] = await freePorts(5760, 1);
    const stateDir = path.join(TMP, `state-restart-${svcPort}`);
    // 预置一份"用户改过"的设置（等价于上一段跑完的结果，但这里显式写上，避免依赖段间耦合）
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(settingsFileOf(stateDir), JSON.stringify({ tier: 'small', idleLlmMin: 9, idleVisionMin: 45 }));
    const [engPort] = await freePorts(5762, 1);
    const eng = spawnProc(MOCK_ENGINE, { MIAO_ENGINE_PORT: String(engPort) }, `engine-r-${engPort}`);
    await sleep(400);
    try {
      await withService(
        baseEnv(svcPort, stateDir, {
          MIAO_ENGINE_PROTOCOL: 'mock',
          MIAO_ENGINE_PORT: String(engPort),
        }),
        `service-R1-${svcPort}`,
        async (info) => {
          const v = jsonOf(await get(info.port, '/api/v1/engine/options'));
          check(
            'R1 **重启后文件里的设置被读回**：tier.configured=small、source=file（写路径与读路径真的接上了）',
            v?.tier?.configured === 'small' && v?.tier?.source === 'file',
            `configured=${v?.tier?.configured} source=${v?.tier?.source}`,
          );
          check(
            'R1b tier.effective=small（重启才生效的那一类，重启后真生效了）',
            v?.tier?.effective === 'small',
            String(v?.tier?.effective),
          );
          check(
            'R1c 空闲阈值也跟着回来了：llm=9min、vision=45min（两档都读文件，不是各自默认）',
            v?.idle?.llm?.min === 9 && v?.idle?.vision?.min === 45,
            `${v?.idle?.llm?.min}/${v?.idle?.vision?.min}`,
          );
        },
      );
    } finally {
      killProc(eng);
      await sleep(120);
    }
  }

  // R2 · env 优先（同一个 state 目录，但给一个不同的 env 值 ⇒ 必须压过文件）
  {
    const [svcPort] = await freePorts(5780, 1);
    const stateDir = path.join(TMP, `state-env-${svcPort}`);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(settingsFileOf(stateDir), JSON.stringify({ tier: 'small' }));
    await withService(
      baseEnv(svcPort, stateDir, {
        MIAO_ENGINE_PROTOCOL: 'mock',
        MIAO_ENGINE_TIER: 'tiny',
        MIAO_IDLE_LLM_MIN: '12',
      }),
      `service-R2-${svcPort}`,
      async (info) => {
        const v = jsonOf(await get(info.port, '/api/v1/engine/options'));
        check(
          'R2 **env 优先**：文件 tier=small 但 MIAO_ENGINE_TIER=tiny ⇒ configured=tiny、source=env',
          v?.tier?.configured === 'tiny' && v?.tier?.source === 'env',
          `configured=${v?.tier?.configured} source=${v?.tier?.source}`,
        );
        check(
          'R2b idleLlmMin 同理：文件没有该键时 env 生效（MIAO_IDLE_LLM_MIN=12 ⇒ 12min、source=env）',
          v?.idle?.llm?.min === 12 && v?.idle?.llm?.source === 'env',
          JSON.stringify(v?.idle?.llm),
        );
      },
    );
  }

  // R3 · 坏设置文件不阻断启动（只喊 + 退回默认，且**原地保留**证据）
  {
    const [svcPort] = await freePorts(5800, 1);
    const stateDir = path.join(TMP, `state-corrupt-${svcPort}`);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(settingsFileOf(stateDir), '{"tier": "small",,}');
    await withService(
      baseEnv(svcPort, stateDir, { MIAO_ENGINE_PROTOCOL: 'mock' }),
      `service-R3-${svcPort}`,
      async (info, st) => {
        const v = jsonOf(await get(info.port, '/api/v1/engine/options'));
        check(
          'R3 坏设置文件**不阻断启动**，且如实上报 corrupt=true + reason（"设置全没了"必须查得出为什么）',
          v?.settingsFile?.corrupt === true &&
            typeof v.settingsFile.reason === 'string' &&
            v.settingsFile.reason.length > 0,
          JSON.stringify(v?.settingsFile?.reason),
        );
        check(
          'R3b 坏文件被**原地保留**（不删不搬：证据比整洁重要），退回默认 tier（configured=null）',
          fs.existsSync(settingsFileOf(stateDir)) && v?.tier?.configured === null,
          `exists=${fs.existsSync(settingsFileOf(stateDir))} configured=${v?.tier?.configured}`,
        );
        // ⚠️ 那句告警走的是 **stderr**（config.mjs 顶层的 console.warn）。只看 stdout 会假红 ——
        //    而"假红"同样有害：它让人去改一句本来是对的代码。
        const both = `${st.out}\n${st.err}`;
        check(
          'R3c 启动日志（stderr）里有那句显眼的告警（用户不该只能靠"设置没了"来发现问题）',
          /引擎设置文件损坏/.test(both),
          both.split('\n').find((l) => /引擎设置文件损坏/.test(l)) || '(无)',
        );
      },
    );
  }

  // ---------------------------------------------------------------- U · 真释放 ③ + verify 真算哈希
  {
    const [svcPort, , llmPort] = await freePorts(5820, 3);
    const stateDir = path.join(TMP, `state-unload-${svcPort}`);
    await withService(
      baseEnv(svcPort, stateDir, {
        MIAO_ENGINE_PROTOCOL: 'mock',
        MIAO_LLM_PORT: String(llmPort),
        MIAO_NO_LLM_AUTOSTART: undefined, // 本段**要**起 ③（mock-llm），否则没东西可释放
      }),
      `service-U-${svcPort}`,
      async (info) => {
        const before = await waitLlmRunning(info.port);
        check(
          'U2 前置：③（mock-llm）已被预拉起（llm.state=running）—— 否则"释放"是空转',
          before?.llm?.state === 'running',
          JSON.stringify(before?.llm),
        );

        const res = await post(info.port, '/api/v1/engine/unload', {});
        const body = jsonOf(res);
        check(
          'U3 强制释放 ③ → 200 且 unloaded=true',
          res.status === 200 && body?.ok === true && body.unloaded === true,
          JSON.stringify(body),
        );

        // 🔴 不信 unload 接口自报：去 `/engine/status` 要 llm.state
        let after = null;
        for (let i = 0; i < 60; i += 1) {
          after = jsonOf(await get(info.port, '/api/v1/engine/status'));
          if (after?.llm?.state === 'stopped') break;
          await sleep(100);
        }
        check(
          'U4 **真释放**：随后 /engine/status 的 llm.state=stopped、llm.port=null（不是"接口说释放了"）',
          after?.llm?.state === 'stopped' && after?.llm?.port === null,
          JSON.stringify(after?.llm),
        );
        check(
          'U5 释放 ③ **不影响 ②**：engine.state 仍如实上报（不再 running 也可以，但必须与释放前同一套口径）',
          typeof after?.engine?.state === 'string' && typeof after?.engine?.version === 'string',
          JSON.stringify(after?.engine),
        );
      },
    );
  }

  {
    // verify：把模型根指到一个**空目录** ⇒ 必须报"全部缺失"。若实现只判"在不在"，
    // total 会是 0；若把它写成"没发现问题 ⇒ 通过"，就会报 ok:true。两种错法都会红。
    const emptyRoot = path.join(TMP, 'empty-models');
    fs.mkdirSync(emptyRoot, { recursive: true });
    const [svcPort] = await freePorts(5860, 1);
    const stateDir = path.join(TMP, `state-verify-${svcPort}`);
    await withService(
      baseEnv(svcPort, stateDir, {
        MIAO_ENGINE_PROTOCOL: 'mock',
        MIAO_MODEL_ROOT: emptyRoot,
      }),
      `service-V-${svcPort}`,
      async (info) => {
        const res = await post(info.port, '/api/v1/engine/models/verify', {});
        const v = jsonOf(res);
        check(
          'U6 校验完整性 → 200（"发现不符"是一次**成功的调用**，不是 4xx/5xx）且 ok=false',
          res.status === 200 && v?.ok === false,
          `${res.status} ok=${v?.ok}`,
        );
        check(
          'U7 空模型根 ⇒ pass=0、bad=0、**missing=total>0**（只判"文件在不在"的实现会给 total=0）',
          v?.pass === 0 && v?.bad === 0 && v?.missing > 0 && v.missing === v.total,
          `pass=${v?.pass} bad=${v?.bad} missing=${v?.missing} total=${v?.total}`,
        );
        check(
          'U7b 三个数**加起来等于 total**（分母写死，不允许"跳过"悄悄不计数）',
          v && v.pass + v.bad + v.missing === v.total,
          JSON.stringify({ p: v?.pass, b: v?.bad, m: v?.missing, t: v?.total }),
        );
        check(
          'U8 返回 rootDir 与 manifest（否则"通过"可能是拿一份被裁过的清单比出来的）',
          v?.rootDir === emptyRoot && typeof v?.manifest === 'string' && v.manifest.endsWith('models.manifest.json'),
          `${v?.rootDir} | ${v?.manifest}`,
        );
        // `problems` 现在是**两节合起来**的清单（缺文件 + HF 缓存布局不可解析）⇒ 分母不再是 missing。
        // 断言的着力点仍是原意：**每一个**缺失条目都单独出现（不是只给一个数字）；
        // 并让 HF 那一节的不可解析数与 `hf.broken` 对上，且它**必须**反映到 `ok`（见 spec-notes D-99）。
        const missLines = (v?.problems ?? []).filter((s) => /：缺失$/.test(s));
        check(
          'U8b 缺失清单逐条带出（用户要知道**缺的是哪一样**，不是只看到一个数字）；HF 布局不可解析项也在同一份 problems 里逐条带出，且计入 ok',
          Array.isArray(v?.problems) &&
            missLines.length === v.missing &&
            missLines.every((s) => /^✗\s+[A-Za-z0-9_]+：缺失$/.test(s)) &&
            v?.hf?.total > 0 &&
            v?.hf?.broken === v.hf.total &&
            v?.ok === false,
          `problems=${v?.problems?.length} 缺失行=${missLines.length} hf=${JSON.stringify(v?.hf)}`,
        );
        check(
          'U9 校验用的模型根 = 设置里的 modelDir（MIAO_MODEL_ROOT ⇒ source=env）',
          v?.rootDir === emptyRoot,
          String(v?.rootDir),
        );
      },
    );
  }

  // ---------------------------------------------------------------- D · 「重新下载模型」状态机
  //
  // 这一组守的是**任务语义**，不是下载正确性（后者归 S3 的 `check:models`）：
  //   · 启动是**立即返回**的（下载十几分钟，HTTP 挂不住）
  //   · 并发被 409 挡住（两个下载互相截断 `.part` ⇒ "下完了但哈希不对"）
  //   · 终态被记下来、tail 转发的是**子进程真输出**
  //   · 失败如实报失败，且失败之后还能重试
  //   · 执行体不在盘上时如实报错 + `runnerExists=false`（界面据此把按钮变灰）
  {
    const dlRoot = writeReadyModelRoot(path.join(TMP, 'dl-ready'));
    const [svcPort] = await freePorts(5060, 2);
    const stateDir = path.join(TMP, `state-dl-${svcPort}`);
    await withService(
      baseEnv(svcPort, stateDir, {
        MIAO_ENGINE_PROTOCOL: 'mock',
        MIAO_MODEL_MANIFEST: dlRoot.manifestPath,
        MIAO_MODEL_ROOT: dlRoot.modelsRoot,
      }),
      `service-D-${svcPort}`,
      async (info) => {
        const noToken = await httpReq(info.port, 'POST', '/api/v1/engine/models/download', {
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from('{}'),
        });
        check(
          'D1 /engine/models/download 无令牌 → 403 PERMISSION_DENIED（Box 专用端点，不是免鉴权例外）',
          noToken.status === 403 && jsonOf(noToken)?.error?.code === 'PERMISSION_DENIED',
          `${noToken.status} ${jsonOf(noToken)?.error?.code}`,
        );

        const started = Date.now();
        const r1 = await post(info.port, '/api/v1/engine/models/download', {});
        const b1 = jsonOf(r1);
        check(
          'D2 启动下载 → 200 且**立即**返回（不等它跑完；夹具清单 17 条走缓存复用，几百毫秒）+ started=true、state=running、startedAt 非空',
          r1.status === 200 &&
            b1?.ok === true &&
            b1?.started === true &&
            b1?.download?.state === 'running' &&
            typeof b1.download.startedAt === 'string' &&
            Date.now() - started < 500,
          `${r1.status} state=${b1?.download?.state} 耗时=${Date.now() - started}ms`,
        );

        const r2 = await post(info.port, '/api/v1/engine/models/download', {});
        const b2 = jsonOf(r2);
        check(
          'D3 同一时刻第二个请求 → **409** DOWNLOAD_IN_PROGRESS（不是 200「已经在下了」——' +
            '那会让界面以为这次点击也生效了），且 details 带出首次启动时刻',
          r2.status === 409 &&
            b2?.error?.code === 'DOWNLOAD_IN_PROGRESS' &&
            typeof b2?.error?.details?.startedAt === 'string',
          `${r2.status} ${b2?.error?.code} ${JSON.stringify(b2?.error?.details?.startedAt)}`,
        );

        let st = null;
        for (let i = 0; i < 80; i += 1) {
          st = jsonOf(await get(info.port, '/api/v1/engine/status'));
          if (st?.modelDownload?.state !== 'running') break;
          await sleep(100);
        }
        check(
          'D4 跑完 ⇒ state=done、exitCode=0、finishedAt 非空（终态被记下来，不会永远停在 running）',
          st?.modelDownload?.state === 'done' &&
            st.modelDownload.exitCode === 0 &&
            typeof st.modelDownload.finishedAt === 'string',
          JSON.stringify({ state: st?.modelDownload?.state, code: st?.modelDownload?.exitCode }),
        );

        const tail = st?.modelDownload?.tail ?? [];
        check(
          'D5 tail 是**子进程真实输出**（含执行体自己打的那两行）—— 转发的是它的 stdout/stderr，不是我们自己编的进度',
          tail.some((l) => l.includes('模型根目录')) && tail.some((l) => l.includes('复用')),
          JSON.stringify(tail),
        );
      },
    );
  }

  // D6/D7：子进程**非 0 退出** ⇒ 如实报 error；且失败之后还能再来一次
  {
    const fakeFail = writeFakeManifest(path.join(TMP, 'fake-dl-fail'), { fail: true });
    const [svcPort] = await freePorts(5080, 2);
    const stateDir = path.join(TMP, `state-dlfail-${svcPort}`);
    await withService(
      baseEnv(svcPort, stateDir, {
        MIAO_ENGINE_PROTOCOL: 'mock',
        MIAO_MODEL_MANIFEST: fakeFail,
      }),
      `service-Dfail-${svcPort}`,
      async (info) => {
        await post(info.port, '/api/v1/engine/models/download', {});
        let st = null;
        for (let i = 0; i < 80; i += 1) {
          st = jsonOf(await get(info.port, '/api/v1/engine/status'));
          if (st?.modelDownload?.state !== 'running') break;
          await sleep(100);
        }
        check(
          'D6 执行体非 0 退出 ⇒ state=error 且 exitCode 如实带出（**不把失败报成成功**），tail 带出那个错误码',
          st?.modelDownload?.state === 'error' &&
            typeof st.modelDownload.exitCode === 'number' &&
            st.modelDownload.exitCode !== 0 &&
            (st.modelDownload.tail ?? []).some((l) => l.includes('MODEL_MANIFEST_BAD')),
          JSON.stringify({
            state: st?.modelDownload?.state,
            code: st?.modelDownload?.exitCode,
            tail: st?.modelDownload?.tail?.slice(-2),
          }),
        );

        const again = await post(info.port, '/api/v1/engine/models/download', {});
        check(
          'D7 失败之后**可以再次启动**（终态不是 running ⇒ 单飞守卫不得把"重试"也一起挡住）',
          again.status === 200 && jsonOf(again)?.download?.state === 'running',
          `${again.status} ${jsonOf(again)?.download?.state}`,
        );
      },
    );
  }

  // D8：执行体不在盘上 ⇒ 明确报错 + `runnerExists=false`（界面据此把按钮变灰）
  {
    const [svcPort] = await freePorts(5100, 2);
    const stateDir = path.join(TMP, `state-dlmiss-${svcPort}`);
    const missing = path.join(TMP, 'no-such-dir', `missing-download${process.platform === 'win32' ? '.cmd' : '.sh'}`);
    await withService(
      baseEnv(svcPort, stateDir, {
        MIAO_ENGINE_PROTOCOL: 'mock',
        MIAO_MODEL_DOWNLOAD_RUNNER: missing,
      }),
      `service-Dmiss-${svcPort}`,
      async (info) => {
        const st = jsonOf(await get(info.port, '/api/v1/engine/status'));
        check(
          'D8 下载执行体不存在 ⇒ runnerExists=false（界面该把按钮**变灰**，而不是让用户点一下换一条报错）',
          st?.modelDownload?.runnerExists === false,
          String(st?.modelDownload?.runnerExists),
        );

        const r = await post(info.port, '/api/v1/engine/models/download', {});
        const b = jsonOf(r);
        check(
          'D8b 此时强行 POST → 500 INTERNAL 且消息指出执行体路径（不静默成功、也不假装"已开始"）',
          r.status === 500 &&
            b?.error?.code === 'INTERNAL' &&
            /不存在/.test(b?.error?.message ?? '') &&
            (b?.error?.details?.runner ?? '').includes('missing-download'),
          `${r.status} ${b?.error?.code} ${b?.error?.message?.slice(0, 60)}`,
        );
      },
    );
  }
}

// ================================================================ 反证

/** 反证子进程只跑这一段：够短、够准，且每条开关的影响面都被独立框住 */
async function runOnePassForRefute() {
  const [svcPort] = await freePorts(5900, 1);
  const stateDir = path.join(TMP, `state-refute-${svcPort}`);
  // D3 要一份夹具清单（不真下 GB），且必须**在 withService 之前**落盘 ——
  // 服务在启动时就把它读进常量了（`MODEL_MANIFEST` 是模块顶层求值）。
  const fakeOk = writeFakeManifest(path.join(TMP, 'fake-dl-refute'));
  await withService(
    baseEnv(svcPort, stateDir, {
      MIAO_ENGINE_PROTOCOL: 'mock',
      MIAO_MODEL_MANIFEST: fakeOk,
    }),
    `refute-${svcPort}`,
    async (info) => {
      const res = await get(info.port, '/api/v1/engine/options');
      const v = jsonOf(res);

      // G3：档位候选不得含物理不可行的 Medium
      const tiers = (v?.tier?.options ?? []).map((o) => o.tier);
      check('G3 档位候选不含物理不可行的 Medium（16GB Mac）', !tiers.includes('medium'), tiers.join(','));

      // G5：后端候选不得含本机没有的 cuda（Metal）
      const accels = (v?.accel?.options ?? []).map((o) => o.value);
      check('G5 加速后端候选不含 cuda（本机 Metal）', !accels.includes('cuda'), accels.join(','));

      // S1：未知键必须被拒（**同时带一个合法键**，否则"空补丁守卫"会替它给出同一个 400），且不落盘
      const r1 = await post(info.port, '/api/v1/engine/settings', { idleLlmMin: 3, idleLlmMinutes: 9 });
      check(
        'S1 未知键 → 400 且盘上无文件',
        r1.status === 400 && jsonOf(r1)?.error?.code === 'INVALID_SETTING' && readSettingsFile(stateDir) === null,
        `${r1.status} file=${JSON.stringify(readSettingsFile(stateDir))}`,
      );

      // S4：物理不可行档位必须被拒
      const r4 = await post(info.port, '/api/v1/engine/settings', { tier: 'medium' });
      check(
        'S4 16GB 机上 Medium → 400',
        r4.status === 400 && jsonOf(r4)?.error?.code === 'INVALID_SETTING',
        `${r4.status} ${jsonOf(r4)?.error?.message?.slice(0, 60)}`,
      );

      // S5：本机不可用后端必须被拒
      const r5 = await post(info.port, '/api/v1/engine/settings', { accel: 'cuda' });
      check(
        'S5 Metal 机上 cuda → 400',
        r5.status === 400 && jsonOf(r5)?.error?.code === 'INVALID_SETTING',
        `${r5.status} ${jsonOf(r5)?.error?.message?.slice(0, 60)}`,
      );

      // D3：下载单飞 —— 第一个请求跑着时，第二个必须 409。
      // 夹具要 700ms，所以这两次请求之间**不会有"它已经跑完"的窗口**（那是"偶尔绿"的来源）。
      await post(info.port, '/api/v1/engine/models/download', {});
      const d3 = await post(info.port, '/api/v1/engine/models/download', {});
      check('D3 下载单飞：第二个请求 → 409 DOWNLOAD_IN_PROGRESS', d3.status === 409, `${d3.status}`);
    },
  );

  // R2：env 优先
  const [svcPort2] = await freePorts(5920, 1);
  const stateDir2 = path.join(TMP, `state-refute-env-${svcPort2}`);
  fs.mkdirSync(stateDir2, { recursive: true });
  fs.writeFileSync(settingsFileOf(stateDir2), JSON.stringify({ tier: 'small' }));
  await withService(
    baseEnv(svcPort2, stateDir2, {
      MIAO_ENGINE_PROTOCOL: 'mock',
      MIAO_ENGINE_TIER: 'tiny',
    }),
    `refute-env-${svcPort2}`,
    async (info) => {
      const v = jsonOf(await get(info.port, '/api/v1/engine/options'));
      check(
        'R2 env 优先：configured=tiny 且 source=env',
        v?.tier?.configured === 'tiny' && v?.tier?.source === 'env',
        `configured=${v?.tier?.configured} source=${v?.tier?.source}`,
      );
    },
  );
}

const SWITCHES = [
  {
    name: 'MIAO_SETTINGS_NO_WHITELIST（未知键被静默丢弃）',
    env: { MIAO_SETTINGS_NO_WHITELIST: '1' },
    expectRed: ['S1'],
  },
  {
    name: 'MIAO_SETTINGS_ACCEL_OPEN（后端候选不按硬件筛）',
    env: { MIAO_SETTINGS_ACCEL_OPEN: '1' },
    expectRed: ['G5', 'S5'],
  },
  {
    name: 'MIAO_SETTINGS_TIER_ALL（档位候选不按内存筛）',
    env: { MIAO_SETTINGS_TIER_ALL: '1' },
    expectRed: ['G3', 'S4'],
  },
  {
    name: 'MIAO_SETTINGS_ENV_LAST（文件压 env ⇒ 优先级失效）',
    env: { MIAO_SETTINGS_ENV_LAST: '1' },
    expectRed: ['R2'],
  },
  {
    name: 'MIAO_SETTINGS_DOWNLOAD_OPEN（下载单飞守卫被摘掉）',
    env: { MIAO_SETTINGS_DOWNLOAD_OPEN: '1' },
    expectRed: ['D3'],
  },
];
const EXPECTED_SWITCHES = 5; // 分母写死

async function runRefute() {
  console.log('S6 设置面 · 反证轮');
  console.log(`逃生开关 → 指定断言必须变红（应执行 ${EXPECTED_SWITCHES} 条）\n`);
  let asExpected = 0;
  const problems = [];

  for (const sw of SWITCHES) {
    // 每个开关独立跑一次：`config.mjs` 在模块顶层读 env ⇒ 进程内无法回滚 ⇒ 另起子进程。
    const child = spawn(process.execPath, [SELF, '--refute-child'], {
      env: { ...process.env, ...sw.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stdout += d.toString();
    });
    await new Promise((resolve) => child.once('exit', resolve));

    const line = stdout.split('\n').find((l) => l.startsWith('[RESULT] '));
    if (!line) {
      problems.push(`${sw.name}：子进程未产出结果行（stdout 尾部：${stdout.slice(-300)}）`);
      console.log(`⚠ ${sw.name}\n    子进程没有结果行`);
      continue;
    }
    const parsed = JSON.parse(line.slice('[RESULT] '.length));
    const redIds = parsed.results.filter((r) => !r.ok).map((r) => r.id);
    console.log(`🔴 ${sw.name}`);
    const missed = [];
    for (const code of sw.expectRed) {
      const hit = matchById(parsed.results, code);
      const red = hit && hit.ok === false;
      console.log(
        `   ${red ? '✓' : '✗'} ${code} ${red ? '按预期变红' : `**没有变红**（${hit ? hit.detail : '缺该条'}）`}`,
      );
      if (!red) missed.push(code);
    }
    // 「只红这些」：多红说明这个开关顺带打坏了别的东西，结论就不能归给这一条机制。
    const extra = redIds.filter((id) => !sw.expectRed.some((c) => id === c || id.startsWith(`${c} `)));
    if (extra.length) {
      console.log(`   ⚠ 额外变红（本开关不该影响）：${extra.join(' | ')}`);
      problems.push(`${sw.name}：额外变红 ${extra.length} 条`);
    }
    if (missed.length === 0) asExpected += 1;
    else problems.push(`${sw.name}：${missed.join(',')} 未变红`);
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`反证：${asExpected} / ${EXPECTED_SWITCHES} 条按预期变红（应执行 ${EXPECTED_SWITCHES}）`);
  if (asExpected !== EXPECTED_SWITCHES) {
    console.log('\n下面是未达预期的条目：');
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exitCode = 1;
  } else if (problems.length) {
    console.log('\n（有附注：）');
    for (const p of problems) console.log(`  ⚠ ${p}`);
  }
}

// ================================================================ 入口

try {
  if (REFUTE && !process.argv.includes('--refute-child')) {
    await runRefute();
  } else if (process.argv.includes('--refute-child')) {
    await runOnePassForRefute();
    printResults('反证子进程（带逃生开关）');
  } else {
    await runPositive();
    const { fail } = printResults(
      '汇总（S6 · 设置页数据面：options 筛选 / settings 拒绝面 / 重启生效 / unload / verify / 模型下载）',
    );
    process.exitCode = fail === 0 ? 0 : 1;
  }
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
