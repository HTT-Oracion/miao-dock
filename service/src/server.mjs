// box-service HTTP 入口（真实服务）
// 契约依据：§1 拓扑与端口、§2 通用约定、§5 端点、§8 安全
// 与 `miao-trans/mock-service` 同源（同契约）：差异集中在「真实化」——
// 令牌 CSPRNG、落盘根目录归位、sidecar 由真实探测（而非计时器模拟）、翻译走引擎。
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  API_VERSION, BASE_PATH, BATCH_LIMIT, ENGINE_SETTINGS_FILE, ORIGINAL_SCAN_RE, ROOT_DIR,
  SERVICE_NAME, SERVICE_VERSION, STATE_DIR, TASKS_STATE_DIR, TRANSLATED_SCAN_RE,
  TOKEN_FILE, assertInsideRoot, config, engineSettingsFile,
  readIdleSettings, validateRoot,
} from './config.mjs';
import { ApiError, errorEnvelope, permissionDenied } from './errors.mjs';
import {
  ENGINE_VERSION, engineConfigSnapshot, probeEngine, recentStageLog, resolveLlmLaunch,
  availableTiers, TIER_LLM_MODELS,
} from './engine-client.mjs';
import { EngineSettingsError, RESTART_REQUIRED_KEYS, assertPatch, readEngineSettings, writeEngineSettings } from './engine-settings.mjs';
import { ACCEL_LABELS, TIERS as TIERS_ALL, TIER_PEAK_GB, accelOptions, probeHardware, resolveAccel, tierOptions } from './engine-profile.mjs';
import { createIdleWatcher } from './idle-policy.mjs';
import { LlmSupervisor } from './llm-supervisor.mjs';
import { modelStatus } from './model-status.mjs';
import { createTierDowngrade } from './tier-downgrade.mjs';
import { allFieldStrings, firstField, groupParts, parseMultipartEx } from './multipart.mjs';
import { normalizeComicName, isSafeDirName } from './names.mjs';
import { watchParent } from './parent-watch.mjs';
import { Store } from './store.mjs';
import { HEARTBEAT_MS, SSE_HEADERS, writeComment } from './sse.mjs';

const MAX_BODY = 256 * 1024 * 1024; // 20 张高分辨率原图的宽松上限
const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

// ------------------------------------------------------------------ 启动准备

// 落盘根目录：启动时校验一次（契约 §8.2 校验点 1）
const rootCanonical = validateRoot(ROOT_DIR);
const store = new Store(rootCanonical);
const restore = store.init();
store.startedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const bootedAt = Date.now();

// sidecar（引擎）状态 —— **真实探测**，不再是计时器模拟
//
// 🔴 分两层，别合并（S5 的关键结构）：
//   ① `probeEngineCached()` —— **只**缓存"不必 2 秒内再和引擎握一次手"。插件端口探测
//      （5180→5190）会高频打 `/health`，每次握手都要 TCP + HTTP + 执行器端口三连。
//   ② `composeSidecar()` —— 把 5 个**服务级**字段（tier/accel/warmed/llm/model）当场合成。
//      这 5 个**绝不能跟着缓存**：③ 被空闲卸载后，若 `/health` 拿的是 2 秒前的快照，
//      就会出现「说 ③ 在跑、其实刚停」的假象 —— 而 §9.4（卸载 ≠ 未就绪）要的恰恰是
//      在这一刻分得清。缓存"引擎握手"是省开销，缓存"③ 的进程态"是说谎。
const SIDECAR_CACHE_MS = 2000;
let sidecarProbe = { at: 0, value: null };

async function probeEngineCached() {
  // ⚠️`config.sidecarDown` 不再在这里短路：`probeEngine()` 内部已处理，且它会返回
  //   `stopped`（§5.1 枚举内的值）。原先这里返回的 `'down'` **不在枚举里** ——
  //   一个只在"注入故障"时才出现、且契约里查不到的状态值，是给下游埋雷。
  const now = Date.now();
  if (sidecarProbe.value && now - sidecarProbe.at < SIDECAR_CACHE_MS) return sidecarProbe.value;
  const value = await probeEngine();
  sidecarProbe = { at: now, value };
  return value;
}

/**
 * 合成 `sidecar` 的 9 个契约字段（《03》§5.1 / §5.2）。
 *
 * 这是**唯一**一处把「引擎侧事实」与「服务级事实」拼在一起的地方 —— 两侧各自的
 * 权威分别在 `probeEngine()` 与 (`llm` / `hardware` / `tierCtl`)，谁都不去改对方的状态。
 */
function composeSidecar(probe) {
  const snap = llm.snapshot();
  // §7.4-3：指定了 GPU 后端却**实际跑在 CPU 上** ⇒ 状态升级为 `degraded`（"不静默"）。
  // 判据两边都在本进程可观测（硬件推荐什么 / 我们实际让引擎用了什么），
  // 不需要谁额外来通知我们"刚才回退了"——这正是把回退**做成可由 env 驱动**的好处：
  // Rust 侧一旦检测到 GPU 启动失败并改用 `MIAO_ENGINE_USE_GPU=0` 重拉，这里自动就报 degraded。
  //
  // S6：后端从"硬件探测的产物"升级为"用户选择 ⊕ 硬件事实"的合成结果（`resolveAccel`）。
  // 合成放在这里而不是启动时算一次，是因为 `/health` 每条都要它 —— 而它是一次纯计算，
  // 比"记住一个可能过期的模块级变量"更不易错（`/engine/options` 用的是同一个函数，两边不可能分叉）。
  const accelEff = resolveAccel({
    choice: config.engineAccel,
    hardwareAccel,
    useGpu: config.engineUseGpu,
  });
  const accelDegraded = accelEff.degraded;
  const state = accelDegraded && probe.state === 'running' ? 'degraded' : probe.state;
  const up = state !== 'stopped' && state !== 'error' && state !== 'downloading';
  // ⚠️ `currentTier` 是**取值函数**（`tier-downgrade.mjs` 暴露的是 `currentTier: () => current`），
  //    少写这对括号不会报错 —— 只是把一个函数塞进 JSON，`JSON.stringify` 静默丢掉该键，
  //    于是 `/health.sidecar` 与 `/engine/status` 都**少一个 `tier` 键**。
  //    这类"键少了但没人喊"的缺陷正是 9 键形状断言的存在理由。
  const tier = tierCtl.currentTier();
  return {
    state,
    port: probe.port,
    engine: probe.engine,
    engineVersion: probe.engineVersion ?? null,
    // 档位 / 模型是**引擎侧才有的概念**：引擎都不在时报一个档位只会误导
    //（用户会以为"跑着的引擎是 tiny"，而事实是"没有引擎在跑"）。
    tier: up ? tier : null,
    model: up ? (snap.model ?? TIER_LLM_MODELS[tier] ?? null) : null,
    // 实际生效的后端（§7.4-3 的"记录实际生效后端"）。GPU 被关掉时报 `cpu`，
    // **不报"本该是什么"** —— `/engine/status` 的用途就是拿界面和事实对账。
    accel: accelEff.accel,
    // 🔴 `warmed` = 「现在提交任务能不能全速开工」= 引擎② 三重就绪 **且** ③ 在跑。
    //    它与 `state` **不冗余**，正是 §9.4「卸载 ≠ 未就绪」在字段层面的体现：
    //    ③ 被空闲卸载后 `state` 仍是 `running`（进程在），但 `warmed` 转 false ⇒
    //    客户端据此提示「首张稍慢」（实测重新拉起 1.0–2.8s），而不是提示「引擎没起来」。
    warmed: config.contractRefute.warmedAlways
      ? true
      : (probe.state === 'running' && snap.state === 'running'),
    // `llm.port` 的 null 口径由 `LlmSupervisor.snapshot()` 统一决定（stopped ⇒ null），不在这里二次加工
    llm: { state: snap.state, port: snap.port },
  };
}

/** 完整 sidecar 视图（9 键）。`/health` 与 `/engine/status` 共用 */
async function sidecarState() {
  return composeSidecar(await probeEngineCached());
}

const serverLog = (msg) => console.log(`[box-service] ${msg}`);
const securityLog = (msg) => console.warn(`[box-service][security] ${msg}`);

/**
 * §8.2 校验点 2：`normalizedComicName` 不含 `/ \ ..`（再断言一次，不信任上游）。
 * 命中 → 403 PERMISSION_DENIED + 安全日志（这是**安全拒绝**，不是「落盘失败」，
 * 因此不适用 §4.2 的 `saved:false` 降级路径）。
 */
function assertSafeDirName(name) {
  if (!isSafeDirName(name)) {
    securityLog(`拒绝路径越界的漫画名（§8.2 校验点 2）：${JSON.stringify(name)}`);
    throw permissionDenied();
  }
}

/**
 * F-3 / §2.2 `DISK_FULL(507)`：创建任务前探测一次落盘根目录**可写性**。
 * 请求级落盘不可用 → 507；item 级落盘失败仍走 §4.2 的 `saved:false`（任务继续）。
 */
function assertRootWritable() {
  const probe = path.join(store.root, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
  } catch (err) {
    try { fs.unlinkSync(probe); } catch { /* 尽力清理 */ }
    // `err.code` 不足以定位问题：**不是所有错误都带 errno**（调用参数类型错、或被运行时
    // 策略层拦下时抛出的包装错误都没有），只报 code 会得到一句「（undefined）」，无从下手。
    // 两样都带上，代价只是一个字符串。
    const why = (err && err.code) || (err && err.message) || String(err);
    // 只有**文件系统类**错误才是「落盘不可用」（§2.2 要的就是这个）。没有 errno 的错误
    // 来自别处 —— 把它报成 507「磁盘满或权限不足」是**把一句假话讲给用户听**：用户会去清磁盘，
    // 而问题根本不在磁盘（本项目实测踩过一次：被运行时的删除守卫拦下，磁盘明明还剩 58 GB）。
    // 这类错误照常向上抛，由兜底变成 500 INTERNAL、并把原因留在 details.reason 里，便于查。
    if (!(err && err.code)) throw err;
    securityLog(`落盘根目录不可写（DISK_FULL）：${store.root}（${why}）`);
    throw new ApiError('DISK_FULL', '落盘根目录不可写（磁盘满或权限不足），无法创建任务',
      { root: store.root, reason: why });
  }
}

/**
 * `sidecar.state` 里表示「引擎正在准备」的取值（《03》§2.3 / §10.3）。
 * 这三个的共同点是：**用户只需等待**，不需要做任何操作。
 */
const PREPARING_STATES = new Set(['starting', 'prewarming', 'downloading']);

/** 可翻译的状态：`running` 之外，`degraded`（GPU 回退 CPU，§7.4-3）**依然能跑**，只是慢 */
const AVAILABLE_STATES = new Set(['running', 'degraded']);

/**
 * 模型根目录 / 清单 —— 与 `engine/scripts/fetch-models.mjs` 用**同一套取值规则**。
 *
 * S6 起由 `config.engineModelDir` 唯一给出（env `MIAO_MODEL_ROOT` → 设置文件 `modelDir`
 * → 引擎源码树上一级）。这里**不再自己拼一份**：以前是本文件内联
 * `process.env.MIAO_MODEL_ROOT || path.resolve(config.engineDir, '..')`，
 * 一旦设置页可改模型目录，那份内联就会和 config 各说各话（服务读 A、诊断显示 B）。
 */
const MODEL_ROOT = config.engineModelDir;
// `MIAO_MODEL_MANIFEST` 是**验收夹具的接缝**：不改清单内容就没法在"模型齐 / 模型缺"两种
// 盘况之间切换，而这两条分支各对应一个不同的 503 错误码（要分别断言）。
// ⚠️ 与 `MIAO_MODEL_ROOT` 成对使用；产品路径不设置它（清单永远是入库的那一份）。
const MODEL_MANIFEST = process.env.MIAO_MODEL_MANIFEST
  || path.join(path.resolve(import.meta.dirname, '..', '..'), 'engine', 'models.manifest.json');

/**
 * 「重新下载模型」的执行体（《02》§5 模型管理的两个动作之一）。
 *
 * ## 为什么必须是一条**真的**任务，而不是一个"点了就转圈"的按钮
 * `POST /engine/models/verify` 几分钟就能回来（读完 5–8 GB 的哈希），但**下载**动辄
 * 十几分钟到几十分钟 —— 让 HTTP 请求一直挂着有三个后果：代理/客户端先超时、
 * 界面无法显示进度、服务端无法回答"它还在跑吗"。所以这里做成
 * **一次性启动 + 状态可查**：POST 立即返回，进度从 `/engine/status.modelDownload` 读。
 *
 * ## 为什么单飞（同一时刻只允许一个）
 * `model-store.mjs` 的续传靠 `<dest>.part` 文件。两个下载同时跑会往同一批 `.part`
 * 里写、互相截断；**失败形态是"下完了、哈希不对"**，而它看起来像"网络坏了"。
 * 与其事后归因，不如在入口 409 掉。
 *
 * ## 夹具接缝
 * `MIAO_MODEL_DOWNLOAD_SCRIPT` 覆盖被执行的脚本 —— 与 `MIAO_MODEL_MANIFEST` 同一手法。
 * 没有它，验收就得**真下几个 GB**（依赖网络、十几分钟、且不可重放）。产品路径不设置它。
 */
const MODEL_DOWNLOAD_SCRIPT = path.resolve(
  process.env.MIAO_MODEL_DOWNLOAD_SCRIPT
  || path.join(import.meta.dirname, '..', '..', 'engine', 'scripts', 'fetch-models.mjs'),
);
/** 输出尾巴保留多少行 —— 够看清"卡在哪一步/报了什么错"，又不至于把内存当日志盘 */
const MODEL_DOWNLOAD_TAIL_MAX = 40;
/** 整任务上限。真算 5–8 GB 在慢盘上可以很久，但**必须有个头**，否则界面永远转圈且无人知道 */
const MODEL_DOWNLOAD_TIMEOUT_MS = 60 * 60_000;

const modelDownload = {
  state: 'idle', // idle | running | done | error
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  timedOut: false,
  /** 子进程输出（stdout + stderr 合流，按行）。**进度行也在里面**，不另做结构化解析 */
  tail: [],
};
let modelDownloadChild = null;
let modelDownloadTimer = null;

function modelDownloadView() {
  return {
    state: modelDownload.state,
    running: modelDownload.state === 'running',
    startedAt: modelDownload.startedAt,
    finishedAt: modelDownload.finishedAt,
    exitCode: modelDownload.exitCode,
    timedOut: modelDownload.timedOut,
    tail: [...modelDownload.tail],
    rootDir: MODEL_ROOT,
    manifest: MODEL_MANIFEST,
    script: MODEL_DOWNLOAD_SCRIPT,
    /**
     * 脚本在不在盘上。界面据此**禁用按钮**（而不是让用户点一下换一条报错）——
     * 与「打开目录」按 `root` 禁用是同一条纪律。
     */
    scriptExists: fs.existsSync(MODEL_DOWNLOAD_SCRIPT),
  };
}

/**
 * 启动「重新下载模型」。返回后任务在后台跑，进度看 `modelDownloadView()`。
 *
 * 为什么走 `fetch-models.mjs` 而**不**自己实现下载：那个脚本是 S3 的交付物
 * （断点续传 + 逐文件 SHA256 + `.ready` 幂等 + 校验不符自动重下 + 建链），
 * 在这里复制一份等于让"下载"这件事有两处实现。
 * 它默认 `--integrity cached`：已就绪的文件按 (sha256,size,mtime) 复用，
 * **不会**把 8 GB 重新下一遍 —— 这正是「重新下载」应有的语义（补齐坏的、不折腾好的）。
 */
function startModelDownload() {
  if (modelDownload.state === 'running' && !config.settingsRefute.downloadOpen) {
    throw new ApiError('DOWNLOAD_IN_PROGRESS',
      '模型下载已在进行中 —— 同一时刻只允许一个下载任务（并发会互相截断续传文件）',
      { startedAt: modelDownload.startedAt, tail: modelDownload.tail.slice(-5) });
  }
  if (!fs.existsSync(MODEL_DOWNLOAD_SCRIPT)) {
    throw new ApiError('INTERNAL', `模型下载脚本不存在：${MODEL_DOWNLOAD_SCRIPT}`,
      { script: MODEL_DOWNLOAD_SCRIPT });
  }

  modelDownload.state = 'running';
  modelDownload.startedAt = new Date().toISOString();
  modelDownload.finishedAt = null;
  modelDownload.exitCode = null;
  modelDownload.timedOut = false;
  modelDownload.tail = [];
  serverLog(`模型下载已启动：${MODEL_DOWNLOAD_SCRIPT} → ${MODEL_ROOT}`);

  const child = spawn(process.execPath, [MODEL_DOWNLOAD_SCRIPT], {
    env: { ...process.env, MIAO_MODEL_ROOT: MODEL_ROOT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  modelDownloadChild = child;

  const push = (chunk) => {
    // 按行拆（`fetch-models` 的进度用的是 `\r` 覆盖式输出，故三种换行都算分隔符），
    // 空行丢弃 —— 尾巴里最有价值的是**有内容的那几行**，不是进度刷屏的残渣。
    for (const line of chunk.toString('utf8').split(/\r\n|\r|\n/)) {
      const t = line.trim();
      if (!t) continue;
      modelDownload.tail.push(t);
      if (modelDownload.tail.length > MODEL_DOWNLOAD_TAIL_MAX) modelDownload.tail.shift();
    }
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);

  const settle = (code, { timedOut = false } = {}) => {
    clearTimeout(modelDownloadTimer);
    modelDownloadTimer = null;
    modelDownloadChild = null;
    modelDownload.exitCode = code;
    modelDownload.timedOut = timedOut;
    modelDownload.finishedAt = new Date().toISOString();
    modelDownload.state = code === 0 && !timedOut ? 'done' : 'error';
    serverLog(`模型下载结束：state=${modelDownload.state} exitCode=${code}${timedOut ? '（超时被杀）' : ''}`);
  };

  child.on('error', (err) => {
    modelDownload.tail.push(`✗ 无法启动下载进程：${err.message}`);
    settle(-1);
  });
  child.on('close', (code, signal) => {
    if (modelDownload.state === 'running') settle(code === null ? -1 : code, { timedOut: signal === 'SIGKILL' });
  });

  modelDownloadTimer = setTimeout(() => {
    // 超时**必须真杀**：只改状态不杀的话，那个进程会一直在后台写盘，
    // 而界面上写着"已失败"——用户下次点重下就会和它撞在一起。
    try { child.kill('SIGKILL'); } catch { /* 已在退出 */ }
    modelDownload.tail.push(`✗ 下载超时（${Math.round(MODEL_DOWNLOAD_TIMEOUT_MS / 60_000)} min），已终止`);
  }, MODEL_DOWNLOAD_TIMEOUT_MS);

  return modelDownloadView();
}

/**
 * sidecar 未就绪 → 503（契约 §2.2 `UNAVAILABLE` / §2.3 `ENGINE_NOT_READY` / `MODEL_DOWNLOAD_FAILED`）。
 *
 * 🔴 三条分支**必须分开**，因为「用户该做什么」不同（§2.3 的「边界」原文）：
 *   · `ENGINE_NOT_READY`      进程在、正在准备 ⇒ **等待**（面板切「准备中」，不排队、不缓存）
 *   · `UNAVAILABLE`           进程不在         ⇒ **启动 Box**
 *   · `MODEL_DOWNLOAD_FAILED` 模型不在盘上     ⇒ **重新下载模型**
 * 把它们合成一句「服务未就绪」= 把人的动作引向重启，而重启恰好修不好后两种。
 *
 * ⚠️ 判定顺序是**有意的**（先说"还在准备"、再说"没有引擎"、最后说"模型没了"）：
 *    引擎在 `downloading/starting/prewarming` 时模型**本来就还没齐**，此时报
 *    `MODEL_DOWNLOAD_FAILED` 会把"正在下"说成"下坏了" —— 让用户去点一个毫无用处的重下按钮。
 */
async function assertSidecarReady() {
  const sc = await sidecarState();
  if (AVAILABLE_STATES.has(sc.state)) return;

  if (PREPARING_STATES.has(sc.state) && !config.contractRefute.notReadyAsUnavailable) {
    throw new ApiError('ENGINE_NOT_READY',
      `翻译引擎正在准备（state=${sc.state}），请稍候 —— 任务未创建，无需重试`,
      { sidecar: { state: sc.state, port: sc.port } });
  }

  // 到这里 = 引擎没在跑。区分「进程不在」与「模型不在」——后者重下模型才有用。
  // ⚠️ 只在 real 协议下做这个诊断：模型是**真引擎**的概念，替身没有模型需求。
  //    不加这道门槛的话，任何一台没装过 runtimes/ 的机器跑 mock 档都会得到
  //    `MODEL_DOWNLOAD_FAILED`，而它其实只是"引擎没起来"。
  if (config.engineProtocol === 'real') {
    const m = await modelStatus({ manifestPath: MODEL_MANIFEST, rootDir: MODEL_ROOT });
    if (!m.visualReady || !m.sakuraReady) {
      throw new ApiError('MODEL_DOWNLOAD_FAILED',
        `翻译模型不完整（视觉就绪=${m.visualReady} / Sakura 就绪=${m.sakuraReady}）——请重新下载模型`,
        { models: m, modelRoot: MODEL_ROOT, sidecar: { state: sc.state } });
    }
  }

  throw new ApiError('UNAVAILABLE', `翻译引擎（sidecar）不可用：state=${sc.state}`,
    { sidecar: { state: sc.state, port: sc.port } });
}

/**
 * `/health` 顶层 `status`（§5.1：`ok` | `degraded` | `starting`）。
 *
 * 🔴 「③ 没在跑」**不等于** `degraded`：§9.4 明说"卸载 ≠ 未就绪"，而空闲卸载是**设计行为**
 *    （实测重新拉起 1.0–2.8s）。若把它报成 degraded，Box 会在用户啥也没干的时候亮一个告警点
 *    —— 那不是"如实上报"，是**把正常态报成异常态**。
 *    所以只有两种情况算 degraded：① 引擎回退到 CPU（§7.4-3）；② ③ 真的 `error`。
 *    而"③ 现在没在跑"这件事由 `sidecar.warmed === false` 表达：粒度更准 ——
 *    它答的是"这张要不要等"，不是"系统坏没坏"。
 */
function healthStatus(sc) {
  if (PREPARING_STATES.has(sc.state)) return 'starting';
  if (sc.state === 'degraded') return 'degraded';
  if (sc.state === 'running') return sc.llm.state === 'error' ? 'degraded' : 'ok';
  return 'degraded'; // stopped / error / 其它：确实不可用
}

// ------------------------------------------------------------------ CORS / 鉴权

/**
 * Origin 白名单：chrome-extension://* 或 null（Box 桌面端）
 * @returns {{ok:boolean, allow:string|null}}
 */
function checkOrigin(originHeader) {
  if (originHeader === undefined || originHeader === null || String(originHeader).trim() === '') {
    return { ok: true, allow: null };
  }
  const o = String(originHeader).trim();
  if (o === 'null') return { ok: true, allow: 'null' };
  if (/^chrome-extension:\/\/[A-Za-z0-9._-]+$/.test(o)) return { ok: true, allow: o };
  return { ok: false, allow: null };
}

function corsHeaders(allow) {
  const h = {
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'X-Box-Token, X-Box-Client',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
  };
  // 绝不返回 `*`；无 Origin 时不带此头
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

function tokenMatches(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(config.token, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, body, cors) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    ...cors,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

function sendError(res, err, cors) {
  const { status, body } = errorEnvelope(err);
  if (!(err instanceof ApiError)) {
    console.error('[box-service] 未预期错误：', err);
  }
  sendJson(res, status, body, cors);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      throw new ApiError('INVALID_IMAGE', '请求体过大', { limitBytes: MAX_BODY });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ 端点实现

async function healthView() {
  const sidecar = await sidecarState();
  return {
    status: healthStatus(sidecar),
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    apiVersion: API_VERSION,
    // `sidecar` 9 键（§5.1）。**向后兼容**：插件端口探测只认 `service === "box-service"`，
    // 不依赖任何新增字段（§5.1 明写）。反证开关可把它退回 ver1.0 的 3 键，
    // 用来证明"9 键"这条断言咬的确实是新增的那 6 个字段（见 config.contractRefute.sidecarLegacy3）。
    sidecar: config.contractRefute.sidecarLegacy3
      ? { state: sidecar.state, port: sidecar.port, engine: sidecar.engine }
      : sidecar,
    rootDir: store.root,
    startedAt: store.startedAt,
  };
}

/**
 * `GET /engine/status` —— Box 的「引擎诊断视图」数据源（§5.2，**Box 专用、需鉴权**）。
 *
 * 与 `/health` 的分工：`/health` 是**心跳**（高频、字段少、免鉴权），这里是**体检报告**
 * （低频、字段多、要令牌）。所以这里可以放心做几件"不适合放进心跳"的事：
 *   · 现读盘上的模型就绪态（几次 `stat`）
 *   · 带上 `config` 生效参数快照与 `recentStageLog` 阶段日志
 * 🔴 `recentStageLog` **不进插件契约**（《00》分歧 2）—— 它是给 Box 诊断用的原始阶段名
 *    （引擎 `_report_progress` 的原话，如 `detection` / `inpainting`），不做任何改名映射。
 */
async function engineStatusView() {
  const sc = await sidecarState();
  const models = await modelStatus({ manifestPath: MODEL_MANIFEST, rootDir: MODEL_ROOT });
  return {
    engine: {
      state: sc.state,
      // 报的是**安装版本**（我们接的是哪一版），与 `state` 无关 —— 引擎没起来时也得答得出来
      version: ENGINE_VERSION,
      port: sc.port,
      // 🔴 `pid` 恒为 `null`，**不是没实现，是归属使然**：引擎② 由 Rust 的 `ServiceManager`
      //    spawn（S2），box-service 是它的**兄弟进程**、拿不到它的 pid。三处可选做法都不如 null：
      //      ① 用 `lsof`/`ps` 反查监听端口的进程 —— 平台相关（Windows 上 `lsof` 不存在），
      //         且"查到的那个"未必是我们这条链路里的那个（端口可以被别人占）；
      //      ② 编一个（比如报自己的 pid）—— 那是谎；
      //      ③ 报 null，让 Box 用它**自己**已经持有的进程表填（Rust 侧 `ChildView` 里就有）。
      //    ⇒ 用 ③。Box 的引擎诊断视图把这一格显示为「—（由 Box 壳持有）」。
      pid: null,
    },
    llm: {
      state: sc.llm.state,
      model: sc.model,
      port: sc.llm.port,
      // ③ 的归属方就是本进程（《04》§9.1），所以这个 pid 我们**真的有**
      pid: llm.pid ?? null,
    },
    tier: sc.tier,
    accel: sc.accel,
    warmed: sc.warmed,
    // 🔴 形状与 §5.2 的 JSON 示例**逐字一致**（camelCase）。发给引擎的那份是 snake_case
    //    （`config.engineConfig`）—— 两个形状由 `engineConfigSnapshot()` 一处派生，见那里的注释。
    config: engineConfigSnapshot(),
    models,
    recentStageLog: recentStageLog(20),
    /**
     * 「重新下载模型」的**任务实况**（S6 新增第 9 键）。
     *
     * 🔴 为什么它属于 `/engine/status` 而不是 `/engine/options`：`options` 是**选项清单**
     *    （用户能选什么），而这是一段**正在发生的进程状态** —— 与 `llm.state` 同类。
     *    诊断视图（也是「模型管理」那一项）要回答的是"它还在跑吗、跑到哪了"，
     *    这正是体检报告该答的问题。
     * ⚠️ 它与 `models`（几秒前的磁盘就绪态）**不是一回事**：下载跑着的时候
     *    `models.sakuraReady` 仍是 false，把两者混起来看会以为"点了没反应"。
     */
    modelDownload: modelDownloadView(),
  };
}

// ================================================================ S6 · 设置页数据源
//
// 这四个端点都是 **Box 专用**（不在插件契约里，`GET /engine/status` 同理）：
// 它们是"设置页要显示什么、能改什么"的**唯一服务端事实**。放在同一个文件、挨着写，
// 是因为它们共享同一份"硬件 ⊕ 用户设置 ⊕ 进程实况"的合成 —— 拆开就会各拼一遍。
//
// 🔴 一条贯穿的纪律：**绝不摆一个点了不会有作用的控件**。
//    所以「候选」与「能不能选」是两件事，服务端两个都要给：
//      · `options` —— 可选清单（含"为什么不推荐"）
//      · `blockedReason` / 写路径的**拒绝** —— 不可选的项，点了必须报错而不是静默无效
//    《02》§5「物理不可行档位不出现」是这条纪律在档位上的具体化；
//    加速后端、模型目录是同一把尺子。

/** 空闲阈值视图：毫秒是事实，分钟是界面单位 —— 两者都给，并标出"分钟是四舍五入来的" */
function idleView(ms) {
  const exact = ms % 60_000 === 0;
  return { ms, min: Math.round(ms / 60_000), minIsExact: exact };
}

/**
 * 「已配置 vs 已生效」这一对，是 `/engine/options` 存在的理由。
 *
 * 🔴 `/engine/options` 不能直接用 `config.engineTier` / `config.idleLlmMs` —— 那些是
 *    **进程启动那一刻**冻住的常量。用户刚在设置页保存了"空闲 7 分钟"，而 options 还回 5 分钟，
 *    界面会立刻显示回旧值，用户只能得出"没保存上"的结论。
 *    （这正是"界面与事实不一致、且谁也不报错"的典型形态。）
 * ⇒ 分工：**"生效中"**（引擎此刻在跑的档位 / 后端 / 模型目录）从 `config` 与引擎实况读；
 *    **"已配置"**（保存后要等重启的那一类）从盘上现读 —— 用 `readIdleSettings()`，
 *    也就是顶层那两个阈值常量用的**同一个函数**（不存在第二份回退逻辑）。
 */

/**
 * `GET /engine/options` —— 设置页「推理引擎 / 模型与诊断」两小节的**全部取值来源**。
 *
 * 与 `/engine/status` 的分工：那个是**体检报告**（引擎现在怎么样），这个是**选项清单**
 * （用户能选什么、选完会发生什么）。两者都读同一份 `resolveAccel()` / `tierOptions()`，
 * 所以不可能出现"诊断说 mps、设置页说 cuda"。
 */
/**
 * `/health` 之外的引擎读取入口**不在这里**：那是 `probeEngineCached()` 的活。
 * 本函数只做一件事：把"设置页要显示什么"合成出来。
 */
async function engineOptionsView() {
  const sc = await sidecarState();
  const models = await modelStatus({ manifestPath: MODEL_MANIFEST, rootDir: MODEL_ROOT });
  const weightsAvailable = availableTiers();
  const accelEff = resolveAccel({
    choice: config.engineAccel, hardwareAccel, useGpu: config.engineUseGpu,
  });

  // 档位候选：先按**硬件可行性**筛（《02》§5「物理不可行档位不出现」），
  // 再叠加**权重在不在**（那是另一回事：硬件吃得住 ≠ 我们手上有那份权重）。
  // 两者混为一谈会出现"界面上 Small 可点、点了之后被静默夹回 tiny"——最坏的一种失败。
  //
  // 反证开关 `tierAll` 去掉硬件可行性筛选（`G3` 应红：16GB Mac 上冒出 Medium）。
  const feasibleList = config.settingsRefute.tierAll
    ? TIERS_ALL.map((tier) => ({
        tier, peakGb: tierOptions(hardware).find((o) => o.tier === tier)?.peakGb ?? null,
        recommended: tier === hardware.recommendedTier, warning: null,
      }))
    : tierOptions(hardware);
  const tierList = feasibleList.map((o) => {
    const ready = weightsAvailable.includes(o.tier);
    return {
      ...o,
      weightsReady: ready,
      blockedReason: ready
        ? null
        : `该档位的权重尚未纳入 models.manifest.json（当前可下载：${weightsAvailable.join(' / ') || '无'}）`,
    };
  });

  // 空闲阈值：**现读盘现算**，而不是用启动时冻住的那两个常量。
  //
  // 🔴 S6 修正：`config.idleLlmMs` 是进程启动那一刻的值。用户刚保存 7 分钟，
  //    options 若还回 5 分钟，界面会立刻跳回旧值 —— 用户只能得出"没保存上"。
  //    `readIdleSettings()` 就是顶层那两个常量用的**同一个函数**（cfg 里 `IDLE.*`），
  //    所以这里不存在"另一份回退逻辑"（那种第二份实现正是走散的起点）。
  const savedIdle = readIdleSettings();
  const llmIdle = idleView(savedIdle.llmMs);
  const visionIdle = idleView(savedIdle.visionSec * 1000);
  // 与 `config` 同一次合并的口径：`settings` / `sources` 都是"盘上那份 + env 覆盖"的现读结果
  const saved = savedIdle;
  const fileState = readEngineSettings({ file: ENGINE_SETTINGS_FILE });

  return {
    protocol: config.engineProtocol,
    hardware: {
      platform: hardware.platform,
      arch: hardware.arch,
      totalRamGb: hardware.totalRamGb,
      gpuKind: hardware.gpu.kind,
      gpuName: hardware.gpu.name,
      accel: hardware.accel,
    },
    tier: {
      /** 当前**实际生效**档位（引擎不在时是 null —— 与 `sidecar.tier` 同口径） */
      effective: sc.tier,
      /**
       * **已配置**的档位（盘上那份，现读）；null = 未指定（按硬件推荐）。
       * 🔴 与 `effective` 分开是这一格的要点：改档位要重启才生效，所以
       *    「保存成功」与「已经用上」是两个时刻。只给一个字段的话，界面只能二选一：
       *    要么显示旧档（用户以为没保存上），要么显示新档（用户以为已经在跑 7B 了）。
       */
      configured: saved.settings.tier ?? null,
      /** 这个值谁定的（`env` / `file` / `hardware`）—— 用户改不动的控件必须说清是谁压着它 */
      source: saved.sources.tier ?? 'hardware',
      hardwareRecommended: hardware.recommendedTier,
      weightsAvailable,
      options: tierList,
    },
    accel: {
      /** 实际生效（`sidecar.accel` 同源） */
      effective: accelEff.accel,
      /** 已配置的选择（盘上那份，现读；`auto` = 按硬件探测） */
      choice: saved.settings.accel ?? config.engineAccel,
      source: saved.sources.accel ?? 'default',
      hardwareRecommended: hardware.accel,
      /** 用户指定了本机没有的后端时非 null —— 界面要把它显示出来，不能装作已生效 */
      mismatch: accelEff.mismatch,
      reason: accelEff.reason,
      // 反证开关 `accelOpen` 让候选不再按硬件筛（`G5` 应红：Metal 机上出现 CUDA）
      options: accelOptions(hardware.accel, { all: config.settingsRefute.accelOpen }),
    },
    idle: {
      // Tier1（③ LLM）由本进程自持 ⇒ 保存后重建看护即**立刻生效**（`appliesAfterRestart:false`）。
      // Tier2（视觉模型）由引擎自带的 `--models-ttl` 执行，那个数字在拉进程时就固化了
      // ⇒ **必须重启**（`appliesAfterRestart:true`）。同一小节的两个数字待遇不同，
      //   界面据此分别给"已生效"/"重启后生效"（《09》§4.3 末句的提示条）。
      llm: {
        ...llmIdle,
        appliesAfterRestart: false,
        source: saved.sources.idleLlmMin ?? (process.env.MIAO_IDLE_LLM_MS ? 'env' : 'default'),
      },
      vision: {
        ...visionIdle,
        appliesAfterRestart: true,
        source: saved.sources.idleVisionMin ?? (process.env.MIAO_ENGINE_MODELS_TTL ? 'env' : 'default'),
      },
      neverUnload: saved.settings.idleLlmMin === 0 || config.unloadNever,
    },
    modelDir: {
      /** 服务**当前正在用**的目录（进程启动时定，改了要重启） */
      current: MODEL_ROOT,
      /** 已配置的值（盘上那份，现读）；null = 未指定（用 defaultDir） */
      configured: saved.settings.modelDir ?? null,
      /** 未配置时会落到哪（给"恢复默认"用，也让用户看清默认是哪里） */
      defaultDir: path.resolve(config.engineDir, '..'),
      source: saved.sources.modelDir ?? 'default',
      exists: fs.existsSync(MODEL_ROOT),
    },
    models,
    /** 哪些键改完要重启引擎（《09》§4.3）。界面据它决定亮不亮那条提示条 */
    restartRequiredKeys: [...RESTART_REQUIRED_KEYS],
    /**
     * 设置文件状态 —— **现读**，不用启动时那份快照。
     * 文件可能在服务活着的时候被手工改坏（或另一个版本写进来），诊断视图要看到的是**现在**。
     */
    settingsFile: {
      path: ENGINE_SETTINGS_FILE,
      keys: engineSettingsFile.keys,
      exists: fileState.exists,
      corrupt: fileState.corrupt,
      reason: fileState.reason,
      ignoredKeys: fileState.unknownKeys,
      invalidValues: fileState.invalid,
    },
  };
}

/**
 * 写设置前的**能力裁决** —— 这是本端点最有价值的一段。
 *
 * 为什么不在 `engine-settings.mjs` 里做：那个模块是"取值合不合法"（纯语法/单位），
 * 对硬件与权重一无所知。把硬件判据塞进去，它就得 import 引擎层 —— 一个纯粹为了
 * 持久化而存在的模块忽然要认识 GPU，之后就没人敢复用它了。
 * ⇒ 分工：**格式**归 `engine-settings`，**能力**归这里。
 *
 * 每条拒绝都必须给出「**可选什么**」—— 只说"不支持"等于把用户留在原地。
 */
function guardEngineSettings(patch) {
  const reject = (message, details) => {
    throw new ApiError('INVALID_SETTING', message, details);
  };

  if (patch.tier !== undefined) {
    const weights = availableTiers();
    if (!weights.includes(patch.tier)) {
      reject(`档位 ${patch.tier} 的权重尚未纳入 models.manifest.json（当前可用：${weights.join(' / ') || '无'}）`
        + ' —— 先在「模型管理」里补齐权重，或改选可用档位', { key: 'tier', value: patch.tier, available: weights });
    }
    // 反证开关 `tierAll` 去掉这条可行性裁决（`S4` 应红：Medium 被接受）
    if (!config.settingsRefute.tierAll) {
      const opt = tierOptions(hardware);
      if (!opt.some((o) => o.tier === patch.tier)) {
        // ⚠️ 峰值取 `TIER_PEAK_GB`（全表），**不是**从 `opt` 里找 —— `opt` 只含**可行**档位，
        //    而被拒的这个档位按定义不在里面，从它那里取会得到 `?`。
        //    一句「该档预估峰值 ? GB」比不写更糟：它看起来像"算不出来"，而其实我们算得出来。
        reject(`档位 ${patch.tier} 在本机物理不可行（本机内存 ${hardware.totalRamGb} GB，`
          + `该档预估峰值 ${TIER_PEAK_GB[patch.tier] ?? '?'} GB）`
          + `—— 可选：${opt.map((o) => o.tier).join(' / ')}`,
        { key: 'tier', value: patch.tier, totalRamGb: hardware.totalRamGb });
      }
    }
  }

  if (patch.accel !== undefined) {
    // 与 `engineOptionsView()` 用**同一个** `accelOptions()`：两处若各筛一遍，
    // 就会出现"界面不列 CUDA、但接口收 CUDA"——一个只能通过手写请求撞见的漏洞。
    const allowed = accelOptions(hardware.accel, { all: config.settingsRefute.accelOpen }).map((o) => o.value);
    if (!allowed.includes(patch.accel)) {
      reject(`加速后端 ${patch.accel} 在本机不可用（硬件探测为 ${ACCEL_LABELS[hardware.accel] || hardware.accel}）`
        + `—— 可选：${allowed.join(' / ')}`, { key: 'accel', value: patch.accel, allowed });
    }
  }

  if (patch.modelDir !== undefined) {
    let st = null;
    try { st = fs.statSync(patch.modelDir); } catch { st = null; }
    if (st && !st.isDirectory()) {
      reject(`模型目录 ${patch.modelDir} 是一个文件，不是目录`, { key: 'modelDir', value: patch.modelDir });
    }
    if (!st) {
      // 允许"新建一个叶子目录"（父目录得在）—— 否则打错一层路径就会静默建出一棵深树，
      // 而权重会真的下到那里（5–8 GB），等到发现时已经写下去了。
      const parent = path.dirname(patch.modelDir);
      if (!fs.existsSync(parent)) {
        reject(`模型目录 ${patch.modelDir} 不存在，且其上级 ${parent} 也不存在 —— 请先创建上级目录`,
          { key: 'modelDir', value: patch.modelDir, parent });
      }
    }
  }
}

/**
 * `POST /engine/settings` —— 保存设置（白名单校验 → 写盘 → 报"要不要重启"）。
 *
 * 返回里三项都要有，缺一项界面就没法诚实：
 *   · `changed`         —— 这次真改了哪几个键（"保存成功"不该是一个不说明改了什么的消息）
 *   · `restartRequired` —— 改了要重启才生效的键 ⇒ 界面亮提示条（《09》§4.3）
 *   · `appliedNow`      —— 改完**立刻**生效的键（只有空闲卸载 LLM 属此列，见 RESTART_REQUIRED_KEYS）
 */
function handleEngineSettings(req, res, cors) {
  return readBody(req).then((body) => {
    let patch;
    try {
      patch = body.length ? JSON.parse(body.toString('utf8')) : {};
    } catch (err) {
      throw new ApiError('INVALID_SETTING', `请求体不是合法 JSON：${err.message}`, { bytes: body.length });
    }

    // 🔴 **先格式、后能力**，顺序不能反。
    //    反了的话，`{"tier":"large"}` 会先撞上能力裁决，得到一句
    //    「档位 large 的权重尚未纳入 models.manifest.json」—— 一个把**拼错的值**
    //    说成"缺权重"的错误提示，用户会跑去点「校验完整性」，而真正该做的是改掉这个值。
    //    `assertPatch` 是唯一做取值域校验的地方（白名单 + 每键取值规则），放最前面。
    let clean;
    try {
      clean = assertPatch(patch, { allowUnknown: config.settingsRefute.noWhitelist });
    } catch (err) {
      if (err instanceof EngineSettingsError) throw new ApiError('INVALID_SETTING', err.message, err.details);
      throw err;
    }

    guardEngineSettings(clean); // 能力裁决（抛 ApiError 400）

    let result;
    try {
      result = writeEngineSettings({ file: ENGINE_SETTINGS_FILE }, clean,
        { allowUnknown: config.settingsRefute.noWhitelist });
    } catch (err) {
      // 把持久化层的错误码翻译成契约错误信封；**不吞**其它异常（那是 500）
      if (err instanceof EngineSettingsError) {
        throw new ApiError('INVALID_SETTING', err.message, err.details);
      }
      throw err;
    }

    // 🔴 即时生效的那一档：**重建空闲看护**（`idleMs` 是构造参数，改不了就换一个）。
    //    为什么值得专门写这几行：不重建的话，界面上「空闲卸载 LLM」改完显示新值、
    //    看护仍按旧值走 —— 一个界面上完全看不出来的偏差。视觉那一档不在此列（见 RESTART_REQUIRED_KEYS）。
    const appliedNow = [];
    if (result.changed.includes('idleLlmMin')) {
      const next = readIdleSettings();
      idleWatcher.stop();
      restartIdleWatcher(next.llmMs, next.settings.idleLlmMin === 0 || config.unloadNever);
      appliedNow.push('idleLlmMin');
      serverLog(`空闲卸载 LLM 阈值已更新为 ${Math.round(next.llmMs / 60_000)} min（看护已重建，即时生效）`);
    }

    sendJson(res, 200, {
      ok: true,
      settings: result.settings,
      changed: result.changed,
      restartRequired: result.restartRequired,
      restartRequiredKeys: result.changed.filter((k) => RESTART_REQUIRED_KEYS.has(k)),
      appliedNow,
    }, cors);
  });
}

/**
 * `POST /engine/unload` —— 强制释放 ③ LLM（《09》§6.2 的三个操作之一）。
 *
 * ⚠️ 它**不是**"重启"也不是"停止服务"：③ 的归属方是 box-service（《04》§9.1），
 *    所以这件事我们真的做得到、也真的只影响 ③。② 与 ① 一根毫毛都不动
 *    —— 这正是它能在翻译中途之外随时点、且不该有二次确认的原因。
 * ③ 本来就没在跑 ⇒ **不是错误**（§9.4 空闲卸载是设计行为），如实报 `unloaded:false` + 原因。
 */
function handleEngineUnload(req, res, cors) {
  return (async () => {
    const before = llm.snapshot();
    if (before.state !== 'running') {
      return sendJson(res, 200, {
        ok: true, unloaded: false, reason: `③ 当前未在运行（state=${before.state}），无需释放`, state: before.state,
      }, cors);
    }
    await llm.stop({ reason: '用户在诊断视图里强制释放' });
    const after = llm.snapshot();
    sendJson(res, 200, { ok: true, unloaded: after.state !== 'running', state: after.state }, cors);
  })();
}

/**
 * `POST /engine/models/verify` —— 「校验完整性」（《02》§5 模型管理的两个动作之一）。
 *
 * 🔴 它做的是**真算 sha256**，不是"看一眼文件在不在"：
 *    调用 `engine/scripts/fetch-models.mjs --check`，那个脚本走 `verifyModels()`
 *    —— `--check` 分支**不联网、不删任何东西**（见该脚本的用法注释）。
 *    这是"校验完整性"唯一诚实的实现：一个只判存在的校验会给用户"没问题"的假结论，
 *    而模型恰好是"存在但坏掉"最常见的一类资产（下到一半、被同步盘截断）。
 *
 * ⚠️ 为什么另开一个端点而不是复用 `/engine/status` 的 `models`：
 *    那段只做 `stat`（在位 + 大小对得上），是**心跳级**开销。哈希要读完整的 5–8 GB，
 *    必须由用户显式触发（一次几分钟），绝不能挂在任何一个会被轮询的端点上。
 *
 * 返回 `{ ok:false, ... }` 而非 HTTP 错误：**"校验完成，发现不符"是一次成功调用**，
 * 用 4xx/5xx 表达会让界面把它显示成"操作失败"，而用户真正需要看到的是那份不符清单。
 */
function handleModelsVerify(req, res, cors) {
  return readBody(req).then(async () => {
    const script = path.resolve(import.meta.dirname, '..', '..', 'engine', 'scripts', 'fetch-models.mjs');
    const started = Date.now();
    const { code, stdout, stderr, timeout } = await runVerifyChild(script, {
      MIAO_MODEL_ROOT: MODEL_ROOT,
      // 与 `engine-client.mjs` 无关：这个脚本自己读清单路径，固定为仓内那份
    });
    const text = `${stdout}\n${stderr}`;
    const m = /校验：通过 (\d+) \/ 不符 (\d+) \/ 缺失 (\d+)（共 (\d+)）/.exec(text);
    const problems = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('✗'));

    if (!m) {
      // 连那句汇总都没打出来 ⇒ 脚本没跑到校验段（解释器错、脚本被改、路径不对……）
      // 这时**绝不能**报"通过 0/不符 0/缺失 0 ⇒ 一切正常"。如实报"没跑起来"。
      throw new ApiError('INTERNAL', '模型校验脚本未产出结果（可能是脚本缺失或运行环境异常）',
        { exitCode: code, timeout, tail: text.split('\n').slice(-8).join('\n') });
    }
    const [pass, bad, missing, total] = [m[1], m[2], m[3], m[4]].map(Number);
    sendJson(res, 200, {
      ok: bad === 0 && missing === 0,
      pass, bad, missing, total,
      problems,
      rootDir: MODEL_ROOT,
      exitCode: code,
      timeout,
      elapsedMs: Date.now() - started,
      /** 校验用的到底是哪份清单 —— 不报这一行的话，"通过"可能是拿一份被裁过的清单比出来的 */
      manifest: MODEL_MANIFEST,
    }, cors);
  });
}

/**
 * `POST /engine/models/download` —— 「重新下载模型」（《02》§5 模型管理的另一个动作）。
 *
 * 语义是**启动**而非**等待**：立即返回 `{ ok, download }`，进度看 `/engine/status`。
 * 为什么这样做见 `MODEL_DOWNLOAD_SCRIPT` 上方的注释（下载要十几分钟，HTTP 挂不住）。
 *
 * 🔴 已经在跑 ⇒ **409**（`DOWNLOAD_IN_PROGRESS`），不返回 200「已经在下了」：
 *    后者让界面以为这次点击生效了，而用户真正需要知道的是"我这次什么都没触发"。
 */
function handleModelsDownload(req, res, cors) {
  return readBody(req).then(() => {
    const view = startModelDownload();
    sendJson(res, 200, { ok: true, started: true, download: view }, cors);
  });
}

/**
 * 跑 `fetch-models --check` 子进程。
 *
 * `maxBuffer` 用**行收集**而不是 `execFile` 的默认 1 MB：模型清单里有几十项，
 * 全不符时会打几十行 —— 撞上 maxBuffer 的失败形态是 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`，
 * 一个与"模型坏了"毫无关系、却同样表现为"校验失败"的错误。手写收集就没有这个上限。
 * `timeoutMs` 给 15 min：真算 5–8 GB 的 sha256 在机械盘上可以很慢，但它**必须有个头**，
 * 否则界面会永远转圈（且没有任何东西会告诉用户它卡住了）。
 */
function runVerifyChild(script, extraEnv, { timeoutMs = 900_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, '--check'], {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timeout = false;
    const timer = setTimeout(() => {
      timeout = true;
      try { child.kill('SIGKILL'); } catch { /* 已在退出 */ }
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, timeout: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timeout });
    });
  });
}

/** 解析 multipart 表单：payload + images[] + imageOrder[] */
function parseUploadRequest(req, body) {
  const ct = req.headers['content-type'] || '';
  if (!/multipart\/form-data/i.test(ct)) {
    throw new ApiError('INVALID_IMAGE', 'Content-Type 必须是 multipart/form-data', { contentType: ct });
  }
  // Content-Length 与解析出的字节数一致性（能加则加；chunked 无此头时跳过）
  const declaredLen = Number.parseInt(req.headers['content-length'] ?? '', 10);
  if (Number.isFinite(declaredLen) && declaredLen !== body.length) {
    throw new ApiError('INVALID_IMAGE', 'Content-Length 与实际请求体字节数不一致',
      { contentLength: declaredLen, actualBytes: body.length });
  }
  const parsed = parseMultipartEx(body, ct);
  if (parsed === null) {
    throw new ApiError('INVALID_IMAGE', 'multipart 缺少 boundary', {});
  }
  if (!parsed.complete) {
    // 未以 `--boundary--` 收尾：请求体被截断，宁可报错也不要静默少收几张图
    throw new ApiError('INVALID_IMAGE', 'multipart 请求体被截断（缺少结束分隔符）',
      { bytes: body.length });
  }
  const { fields, files } = groupParts(parsed.parts);
  const images = (files.get('images') || []).map((p) => ({
    filename: p.filename,
    contentType: p.contentType,
    data: p.data,
  }));

  if (images.length === 0) {
    throw new ApiError('INVALID_IMAGE', 'images[] 缺失或为空（至少需要 1 张图片）', { submitted: 0 });
  }
  if (images.length > BATCH_LIMIT) {
    throw new ApiError('BATCH_LIMIT_EXCEEDED',
      `单次最多提交 ${BATCH_LIMIT} 张，当前 ${images.length} 张`,
      { limit: BATCH_LIMIT, submitted: images.length });
  }

  let payload = {};
  // `payload` 既可能是普通字段（推荐），也可能被客户端当文件 part 上传，两者都接受
  let rawPayload = firstField(fields, 'payload');
  if (rawPayload === null) {
    const asFile = files.get('payload');
    if (asFile && asFile.length > 0) rawPayload = asFile[0].data.toString('utf8');
  }
  if (rawPayload !== null && rawPayload !== undefined && rawPayload.trim() !== '') {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      payload = {};
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
  return { payload, images, imageOrder: allFieldStrings(fields, 'imageOrder') };
}

/**
 * 「来源」归因。
 *
 * 契约 §2 把 `X-Box-Client` 定义为**可选头，用于日志归因**，而 X-C1 队列页有一列「来源」
 * （示例值「来自浏览器插件」），但契约请求体里没有该字段、也不该为它新增字段。
 * 于是复用这个既有可选头做归因：插件端本就发 `extension/x.y.z`，桌面端发
 * `box-desktop/x.y.z`。**请求体零改动、契约零改动**，只是把它同时用于列表视图。
 * 未带该头（或值不认识）的任务归为 `unknown`——不猜，宁可显示「—」。
 */
function sourceOf(req) {
  const c = String(req.headers['x-box-client'] || '').toLowerCase();
  if (c.startsWith('extension/')) return 'extension';
  if (c.startsWith('box-desktop/')) return 'desktop';
  return 'unknown';
}

function handleCreateTask(req, res, cors) {
  return readBody(req).then(async (body) => {
    await assertSidecarReady();
    const { payload, images, imageOrder } = parseUploadRequest(req, body);
    const norm = normalizeComicName(payload.comicName);
    if (!norm.ok) throw new ApiError(norm.code, norm.message, norm.details);
    // §8.2 校验点 2：请求校验期就断言，绝不等到落盘期才失败
    assertSafeDirName(norm.name);
    assertRootWritable(); // §2.2 DISK_FULL(507)：请求级落盘不可用
    payload.__normalizedName = norm.name;

    const { task, replay } = store.createTask({
      payload, images, imageOrder, source: sourceOf(req),
    });
    const view = store.createView(task);
    // IDEMPOTENT_REPLAY：HTTP 200（重放）vs 201（新建），响应体不做任何额外标注
    sendJson(res, replay ? 200 : 201, view, cors);
  });
}

function handleAppendBatch(req, res, cors, taskId) {
  return readBody(req).then(async (body) => {
    await assertSidecarReady();
    const { payload, images, imageOrder } = parseUploadRequest(req, body);
    // §8.2 校验点 2：不带 comicName，用任务上已存的归一化名再断言一次
    assertSafeDirName(store.mustTask(taskId).dirName);
    const { task } = store.appendBatch(taskId, { payload, images, imageOrder });
    const view = store.createView(task);
    sendJson(res, 200, view, cors);
  });
}

function handleTaskDetail(req, res, cors, taskId, url) {
  const task = store.mustTask(taskId);
  const from = url.searchParams.get('itemsFrom');
  const to = url.searchParams.get('itemsTo');
  const opts = {};
  if (from !== null) opts.itemsFrom = Number.parseInt(from, 10);
  if (to !== null) opts.itemsTo = Number.parseInt(to, 10);
  sendJson(res, 200, store.detailView(task, opts), cors);
}

function handleSse(req, res, cors, taskId) {
  store.mustTask(taskId); // 先抛 404，再升级为事件流
  const headerId = req.headers['last-event-id'];
  const url = new URL(req.url, 'http://127.0.0.1');
  const rawId = headerId !== undefined ? headerId : url.searchParams.get('lastEventId');
  const lastEventId = rawId === null || rawId === undefined ? -1 : Number.parseInt(String(rawId), 10);

  res.writeHead(200, { ...cors, ...SSE_HEADERS });
  res.socket?.setNoDelay?.(true);
  res.socket?.setTimeout?.(0);
  writeComment(res, 'connected');
  const unsubscribe = store.subscribe(taskId, res, Number.isFinite(lastEventId) ? lastEventId : -1);

  const cleanup = () => unsubscribe();
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

async function handleCancel(req, res, cors, taskId) {
  const result = await store.cancelTask(taskId);
  sendJson(res, 200, result, cors);
}

/**
 * `POST /tasks/{taskId}/retry` —— **重跑这一个任务**（契约外增量端点，见 spec-notes D-87）。
 *
 * 与 `POST /library/{comicName}/resume` 的分工，别混：
 *  · resume = 漫画库 X-D1 的「继续翻译」：按**目录**找「有原图、缺译文」的页，**新建 taskId**；
 *  · retry  = 队列页那一行的「重试」：把**这一条任务**的失败页复位重跑，**taskId 不变** ——
 *    所以队列行直接变回「翻译中」，而不会在历史里多冒出一行。
 * 两者都进同一条串行队列，也都不重传原图（字节来源见 `Store.retryTask` 的注释）。
 *
 * 返回 200（复用既有任务，不是 201 新建）；响应体沿用 `createView`，前端拿到的就是
 * 那一行的新状态。队列忙时 status 为 `queued`（队尾），闲时为 `running`。
 */
async function handleRetry(req, res, cors, taskId) {
  await assertSidecarReady();
  assertRootWritable(); // §2.2 DISK_FULL(507)：重跑同样要落盘
  const { task } = store.retryTask(taskId);
  sendJson(res, 200, store.createView(task), cors);
}

function handleQueue(req, res, cors) {
  sendJson(res, 200, store.queueSnapshot(), cors);
}

/**
 * `GET /tasks` —— 队列页的列表数据源（**契约外增量端点**，见 docs/spec-notes.md G-04）。
 *
 * 契约 §5.7 的 `/queue` 只覆盖 running + queued，而 X-C1 的表格要同时渲染
 * 「已完成 / 部分失败 / 失败 / 已取消」的历史行。为不动契约已有端点的语义，
 * 这里**新增**一个只读端点，不改 `/queue` 一个字。
 *
 * 查询参数：`status`（默认 `all`，可逗号分隔多个）、`limit`（正整数）。
 */
function handleTaskList(req, res, cors, url) {
  const status = url.searchParams.get('status') || 'all';
  const limitText = url.searchParams.get('limit');
  let limit;
  if (limitText !== null) {
    limit = Number.parseInt(limitText, 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new ApiError('INVALID_IMAGE', 'limit 必须是正整数', { limit: limitText });
    }
  }
  sendJson(res, 200, store.taskListView({ status, limit }), cors);
}

// ------------------------------------------------------------------ 库与导出

function scanLibrary() {
  const root = store.root;
  const comics = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch { /* 根目录不存在 → 空库 */ }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const originals = new Set();
    const translated = new Set();
    let modifiedMs = 0;
    // G-01 口径：容量 = 该漫画目录内**所有文件**字节数之和（含原图、译文与残留的临时文件），
    // 不含子目录递归 —— 落盘结构是单层目录（契约 §7.1），递归只会把异常结构悄悄算进来。
    let byteSize = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        let m = ORIGINAL_SCAN_RE.exec(f);
        if (m) originals.add(Number(m[1]));
        m = TRANSLATED_SCAN_RE.exec(f);
        if (m) translated.add(Number(m[1]));
        try {
          const st = fs.statSync(path.join(dir, f));
          if (st.isFile()) byteSize += st.size;
        } catch { /* 单个文件读不到则不计入 */ }
      }
      modifiedMs = fs.statSync(dir).mtimeMs;
    } catch { /* ignore */ }
    const seqMax = originals.size ? Math.max(...originals) : 0;
    // 「哪一页已译」必须**逐页**给出，不能只给张数。
    // 只给 translatedCount 时，客户端只能拿 `seq <= count` 当代理指标 —— 缺页一旦落在
    // 中间（例如 seq=3 的译文失败），代理指标就会把后面每一页的判定整体前移一位，
    // 于是「没有译文的页」被标成「已译」，而真正有译文的尾页被标成「待译」。
    // 扫描时本来就有这个集合，之前没暴露出去，客户端只好退而求其次。
    const translatedSeqs = [...translated].sort((a, b) => a - b);
    // 编号段内有原图缺失的页（正常情况为空数组）。单独给「洞」而不是给完整的原图集合，
    // 是因为前者通常为空、几乎不占体积，而原图集合是 1..seqMax 的等长副本。
    const missingSeqs = [];
    for (let s = 1; s <= seqMax; s += 1) if (!originals.has(s)) missingSeqs.push(s);
    comics.push({
      comicName: entry.name,
      dirName: entry.name,
      outputDir: dir,
      imageCount: originals.size,
      translatedCount: translated.size,
      byteSize,
      seqMax,
      nextSeq: seqMax + 1,
      translatedSeqs,
      missingSeqs,
      modifiedAt: modifiedMs ? new Date(modifiedMs).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    });
  }
  comics.sort((a, b) => a.comicName.localeCompare(b.comicName, 'zh-Hans-CN'));
  return {
    root,
    count: comics.length,
    totalImages: comics.reduce((n, c) => n + c.imageCount, 0),
    totalBytes: comics.reduce((n, c) => n + c.byteSize, 0),
    comics,
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/**
 * 解析并校验漫画目录（路径穿越 → 403 + 安全日志，契约 §8.2）。
 * 注意：这里的 comicName 直接来自 URL，**先对原始名做 §8.2 校验点 2 的断言**——
 * 归一化会把 `/ \ :` 剥离掉，若只断言归一化结果，`../../etc` 会退化成合法的 `....etc`
 * 而返回 404，掩盖了越界意图。§8.2 只允许 403。
 */
function resolveComicDir(rawName) {
  if (!isSafeDirName(rawName)) {
    securityLog(`拒绝路径越界的漫画名（§8.2 校验点 2）：${JSON.stringify(rawName)}`);
    throw permissionDenied();
  }
  const norm = normalizeComicName(rawName);
  if (!norm.ok) throw new ApiError(norm.code, norm.message, norm.details);
  if (!isSafeDirName(norm.name)) {
    securityLog(`拒绝路径越界的漫画名：${JSON.stringify(rawName)}`);
    throw permissionDenied();
  }
  const dir = path.join(store.root, norm.name);
  try {
    assertInsideRoot(store.root, path.join(dir, 'x.png'));
  } catch {
    securityLog(`拼接后前缀校验失败：${dir}（root=${store.root}）`);
    throw permissionDenied();
  }
  return { name: norm.name, dir };
}

function findFile(dir, seq, variant) {
  const wantTranslated = variant === 'translated';
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const f of names) {
    const m = wantTranslated ? TRANSLATED_SCAN_RE.exec(f) : ORIGINAL_SCAN_RE.exec(f);
    if (m && Number(m[1]) === seq) return f;
  }
  return null;
}

function handleLibraryFile(req, res, cors, rawName, seqText, url) {
  const { dir } = resolveComicDir(rawName);
  const seq = Number.parseInt(seqText, 10);
  if (!Number.isFinite(seq) || seq < 1 || seq > 999) {
    throw new ApiError('INVALID_IMAGE', 'seq 必须是 1–999 的整数', { seq: seqText });
  }
  const variant = url.searchParams.get('variant') || 'translated';
  if (!['original', 'translated'].includes(variant)) {
    throw new ApiError('INVALID_IMAGE', 'variant 只能是 original 或 translated', { variant });
  }
  const name = findFile(dir, seq, variant);
  if (!name) {
    throw new ApiError('TASK_NOT_FOUND', '漫画库中找不到该文件', {
      comicName: path.basename(dir), seq, variant, root: store.root,
    });
  }
  const file = path.join(dir, name);
  try {
    assertInsideRoot(store.root, file); // 打开文件前再校验一次（防 TOCTOU）
  } catch {
    securityLog(`文件读取越界：${file}`);
    throw permissionDenied();
  }
  const ext = name.split('.').pop().toLowerCase();
  const stat = fs.statSync(file);
  res.writeHead(200, {
    ...cors,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `inline; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

function handleReveal(req, res, cors, rawName) {
  const { dir, name } = resolveComicDir(rawName);
  if (!fs.existsSync(dir)) {
    throw new ApiError('TASK_NOT_FOUND', '漫画目录不存在', { comicName: name, outputDir: dir });
  }
  // mock 不真的打开系统文件管理器，但必须完成路径校验
  sendJson(res, 200, { ok: true, path: dir, comicName: name }, cors);
}

/**
 * `GET /library/{comicName}/resume` —— 该漫画「有原图、缺译文」的页清单
 * （**契约外增量端点**，见 docs/spec-notes.md G-07）。
 *
 * X-D1 的「继续翻译」按钮需要知道还有几页没翻，以及没有可续做的页时不该让按钮可点。
 * 契约 §5.8 只给了张数汇总，故这里补一个只读的清单端点；不维护第二份索引，
 * 直接读目录 —— 落盘仍是唯一真源。
 */
function handleResumePlan(req, res, cors, rawName) {
  const { name } = resolveComicDir(rawName);
  sendJson(res, 200, store.resumePlan(name), cors);
}

/**
 * `POST /library/{comicName}/resume` —— 为缺译文的页补译文，进入**同一条**串行队列。
 *
 * body（可选）：`{ "seqs": [12, 13] }`；省略则续做全部缺页。
 * 单次上限沿用契约 §5.2 的 20 —— 续做同样是一次 ≤20 张的提交，只是字节来自磁盘。
 */
function handleResume(req, res, cors, rawName) {
  return readBody(req).then(async (body) => {
    await assertSidecarReady();
    const { name } = resolveComicDir(rawName);
    let seqs;
    if (body && body.length) {
      let parsedBody = null;
      try { parsedBody = JSON.parse(body.toString('utf8')); } catch { /* 允许空体 */ }
      if (parsedBody && parsedBody.seqs !== undefined) {
        if (!Array.isArray(parsedBody.seqs)) {
          throw new ApiError('INVALID_IMAGE', 'seqs 必须是数组', { seqs: parsedBody.seqs });
        }
        seqs = parsedBody.seqs;
      }
    }
    assertRootWritable(); // §2.2 DISK_FULL(507)：请求级落盘不可用
    const { task } = store.createResumeTask(name, { seqs, source: sourceOf(req) });
    sendJson(res, 201, store.createView(task), cors);
  });
}

// ------------------------------------------------------------------ 路由

function splitPath(pathname) {
  return pathname.split('/').filter((s) => s.length > 0).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

async function route(req, res, cors, url) {
  const seg = splitPath(url.pathname);
  const method = req.method || 'GET';

  // GET /health —— 唯一免鉴权
  if (seg.length === 3 && seg[0] === 'api' && seg[1] === API_VERSION && seg[2] === 'health' && method === 'GET') {
    return sendJson(res, 200, await healthView(), cors);
  }
  // 兼容 /api/v1 之外的健康探测
  if (seg.length === 1 && seg[0] === 'health' && method === 'GET') {
    return sendJson(res, 200, await healthView(), cors);
  }

  if (seg[0] !== 'api' || seg[1] !== API_VERSION) {
    throw new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });
  }
  const p = seg.slice(2);

  // /tasks
  if (p.length === 1 && p[0] === 'tasks') {
    if (method === 'POST') return handleCreateTask(req, res, cors);
    if (method === 'GET') return handleTaskList(req, res, cors, url);
    throw new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });
  }
  // /tasks/{taskId}
  if (p.length === 2 && p[0] === 'tasks') {
    if (method === 'GET') return handleTaskDetail(req, res, cors, p[1], url);
    throw new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });
  }
  // /tasks/{taskId}/batches | events | cancel | retry
  if (p.length === 3 && p[0] === 'tasks') {
    if (p[2] === 'batches' && method === 'POST') return handleAppendBatch(req, res, cors, p[1]);
    if (p[2] === 'events' && method === 'GET') return handleSse(req, res, cors, p[1]);
    if (p[2] === 'cancel' && method === 'POST') return handleCancel(req, res, cors, p[1]);
    if (p[2] === 'retry' && method === 'POST') return handleRetry(req, res, cors, p[1]);
    throw new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });
  }

  // /queue
  if (p.length === 1 && p[0] === 'queue' && method === 'GET') {
    return handleQueue(req, res, cors);
  }

  // /engine/status —— Box 诊断视图（§5.2）。**受 X-Box-Token 保护，不是免鉴权例外**
  if (p.length === 2 && p[0] === 'engine' && p[1] === 'status' && method === 'GET') {
    return sendJson(res, 200, await engineStatusView(), cors);
  }
  // /engine/options —— 设置页的取值来源（S6）。与 status 一样属**Box 专用**，同样要令牌。
  if (p.length === 2 && p[0] === 'engine' && p[1] === 'options' && method === 'GET') {
    return sendJson(res, 200, await engineOptionsView(), cors);
  }
  // /engine/settings —— 保存设置（S6）
  if (p.length === 2 && p[0] === 'engine' && p[1] === 'settings' && method === 'POST') {
    return handleEngineSettings(req, res, cors);
  }
  // /engine/unload —— 强制释放 ③（S6，诊断视图操作之一）
  if (p.length === 2 && p[0] === 'engine' && p[1] === 'unload' && method === 'POST') {
    return handleEngineUnload(req, res, cors);
  }
  // /engine/models/verify —— 校验完整性：真算 sha256（S6，诊断视图操作之一）
  if (p.length === 3 && p[0] === 'engine' && p[1] === 'models' && p[2] === 'verify' && method === 'POST') {
    return handleModelsVerify(req, res, cors);
  }
  // /engine/models/download —— 重新下载模型：起一个后台任务，立即返回（S6，模型管理 + 诊断视图）
  if (p.length === 3 && p[0] === 'engine' && p[1] === 'models' && p[2] === 'download' && method === 'POST') {
    return handleModelsDownload(req, res, cors);
  }

  // /library
  if (p.length === 1 && p[0] === 'library' && method === 'GET') {
    return sendJson(res, 200, scanLibrary(), cors);
  }
  // /library/{comicName}/files/{seq}
  if (p.length === 4 && p[0] === 'library' && p[2] === 'files' && method === 'GET') {
    return handleLibraryFile(req, res, cors, p[1], p[3], url);
  }
  // /library/{comicName}/reveal
  if (p.length === 3 && p[0] === 'library' && p[2] === 'reveal' && method === 'POST') {
    return handleReveal(req, res, cors, p[1]);
  }
  // /library/{comicName}/resume
  if (p.length === 3 && p[0] === 'library' && p[2] === 'resume') {
    if (method === 'GET') return handleResumePlan(req, res, cors, p[1]);
    if (method === 'POST') return handleResume(req, res, cors, p[1]);
    throw new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });
  }

  throw new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });
}

// ------------------------------------------------------------------ 请求入口

function createHandler() {
  return async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const origin = checkOrigin(req.headers.origin);
    const cors = corsHeaders(origin.allow);
    const client = req.headers['x-box-client'] || '-';
    const isHealth = /^\/(api\/v1\/)?health$/.test(url.pathname);
    // 🔴 反证开关：`MIAO_ENGINE_STATUS_OPEN=1` 让 `/engine/status` 也免鉴权。
    //    只为了让「无令牌 → 403」这条断言**咬得住**（证明它测的确实是鉴权，
    //    而不是"这个端点在别处本来就通"）。产品路径绝不设置它。
    const refuteOpen = config.contractRefute.engineStatusOpen && /\/engine\/status$/.test(url.pathname);

    try {
      // 1) Origin 校验（含 Origin 才校验）
      if (!origin.ok) {
        securityLog(`Origin 拒绝：${req.headers.origin}；${req.method} ${url.pathname}；client=${client}`);
        throw permissionDenied();
      }
      // 2) CORS 预检：multipart/form-data 属简单请求不触发预检，预检不作为安全边界
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }
      // 3) 鉴权（/health 豁免）
      if (!isHealth && !refuteOpen && !tokenMatches(req.headers['x-box-token'])) {
        securityLog(`令牌校验失败：${req.method} ${url.pathname}；client=${client}`);
        throw permissionDenied();
      }
      return await route(req, res, cors, url);
    } catch (err) {
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        console.error('[box-service] 响应已开始后出错：', err);
        return;
      }
      return sendError(res, err, cors);
    }
  };
}

// ------------------------------------------------------------------ 监听

function listenOnce(handler, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    // 本地服务的长连接策略：Node 默认 keepAliveTimeout=5s，而客户端（浏览器 fetch / 插件）
    // 会复用空闲连接——当两端对「空闲多久算超时」的预期不一致时，就会出现
    // 「服务端已关闭、客户端仍复用该 socket」的 ECONNRESET 竞态。
    // 把服务端超时抬到 65s（远大于任何客户端的空闲预期），从根上避免这一类随机失败。
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

/** §1：默认 5180；被占时在 5180–5190 内探测；全段被占则启动失败 */
async function listenWithProbe(handler) {
  const candidates = config.explicitPort !== null
    ? [config.explicitPort]
    : Array.from({ length: config.portEnd - config.portStart + 1 }, (_, i) => config.portStart + i);

  let lastErr = null;
  for (const port of candidates) {
    try {
      const server = await listenOnce(handler, port);
      return { server, port };
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        serverLog(`端口 ${port} 被占用，尝试下一个…`);
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  const range = config.explicitPort !== null
    ? `${config.explicitPort}（MIAO_PORT 指定）`
    : `${config.portStart}–${config.portEnd}`;
  throw new Error(
    `端口 ${range} 全部被占用，box-service 启动失败（不静默换到段外）。最后错误：${lastErr && lastErr.message}`);
}

// 父进程（Box 壳）若崩溃 / 被强杀，本进程自行退出，避免孤儿占住端口（契约 B4）
watchParent();

// ---------------------------------------------------------------- 档位与引擎③的生命周期
//
// ③ 的归属权在 S4 从 Rust 的 `ServiceManager` 移交到这里（《04》§9.1：Tier1 空闲卸载的实现方是
// box-service）。**配方**仍由 `engine-client.mjs` 的 `resolveLlmLaunch()` 唯一给出，
// 这里只是"按配方拉起 / 按策略停下 / 按 §8 降档"。详见 `llm-supervisor.mjs` 文件头。

/** 档位由低到高（与 `engine-profile.mjs` 的 TIERS 同序） */
const TIER_ORDER = ['tiny', 'small', 'medium'];

/**
 * 把"期望档位"夹到**实际具备权重的档位**上（只往低夹，从不往高抬）。
 *
 * 为什么要夹：档位映射（《04》§7.2）给的是"硬件能吃哪一档"，而能不能真跑还取决于
 * **权重在不在**（`models.manifest.json` 目前只固化了 Tiny）。这两件事必须分开、
 * 而且要**响**（夹取会打日志）—— 悄悄跑在低档上会让用户以为自己在跑 7B。
 */
function clampTierToAvailable(desired) {
  const avail = availableTiers();
  const idx = TIER_ORDER.indexOf(desired);
  for (let i = idx; i >= 0; i -= 1) if (avail.includes(TIER_ORDER[i])) return TIER_ORDER[i];
  return avail[0] || 'tiny';
}

const hardware = probeHardware();
/**
 * 硬件**推荐**的加速后端（§7.4-1 的探测顺序产物）。
 * ⚠️ 与"实际生效"分开：`composeSidecar()` 用 `config.engineUseGpu` 判断实际是不是 CPU。
 *    两者合成一处（不在各处各自判断）是因为「推荐 mps / 实际 cpu」这个组合必须**能被看见** ——
 *    它正是 §7.4-3 的 `degraded`，也是"设置页说 MPS、日志说 CPU"这类矛盾唯一的源头。
 */
const hardwareAccel = hardware.accel;
const desiredTier = config.engineTier || hardware.recommendedTier;
const effectiveTier = clampTierToAvailable(desiredTier);

const llm = new LlmSupervisor({
  launch: resolveLlmLaunch({ tier: effectiveTier }),
  log: (m) => serverLog(m),
});

if (config.llmAutostart) {
  // ⚠️ **不 await**：真档下 llama-server 要读几 GB 权重，等它就绪会把服务自身的
  // `MIAO_READY` 行推迟到分钟级 —— 而 Rust 侧等这行是有超时的（会把"服务起不来"报成
  // 真正的启动失败）。③ 晚到不要紧：它在**翻译那一刻**才被用到，而那条路有懒加载兜底。
  llm.start().catch((err) => serverLog(`③ LLM 启动失败（不阻断服务）：${err.message}`));
  // 《04》§9.3 懒加载恢复：③ 被空闲卸载后再来任务 → 先拉起再继续（对用户表现为"这张稍慢"）。
  store.ensureLlm = () => llm.start({ timeoutMs: 180_000 });
}

// 档位降档控制器（《04》§8）。**进程级单例 ⇒ 天然是"服务级"作用域**（§8.2：降档后
// 后续所有 item 都用新档，不逐图降）。
const tierCtl = createTierDowngrade({
  tier: effectiveTier,
  disabled: config.noTierDowngrade,
  log: (m) => serverLog(m),
  modelOf: (t) => TIER_LLM_MODELS[t],
  apply: async (t) => {
    // 降档落到引擎 = **停 ③ → 换配方 → 重新拉起**，三步是一次原子操作（`switchTier`）。
    // ② 不依赖档位（策略参数是服务级、与档位无关），无需跟着重启 —— 少一次分钟级的 python 冷启动。
    const snap = await llm.switchTier(t, { timeoutMs: 180_000 });
    if (snap.state !== 'running') throw new Error(`降档后 ③ 未就绪（state=${snap.state}）`);
  },
});
store.tierDowngrade = tierCtl;

// 空闲卸载看护（《04》§9.1 Tier1）。Tier2（视觉模型 30 min）由**引擎自带**的
// `--models-ttl` 负责，box-service 不动作 —— 这里只把阈值留在同一处展示（见 config）。
//
// 🔴 S6 起它必须是**可重建的**：设置页改「空闲卸载 LLM」要立刻生效，而 `idleMs` 是构造参数。
//    写成 `const idleWatcher = …` 就只剩"重启服务"一条路 —— 那会让一个纯策略数字
//    需要一次几十秒的引擎冷启动，用户看到的是"改了没反应"。
//    重建而不是"加一个可变引用"：看护内部没有任何持有旧阈值的异步任务（`tick()` 是纯同步判定），
//    所以停掉旧的、起一个新的，**不存在**两个看护同时在跑或"旧阈值还在途"的窗口。
let idleWatcher = null;

function restartIdleWatcher(idleMs, neverUnload) {
  if (idleWatcher) idleWatcher.stop();
  idleWatcher = createIdleWatcher({
    store,
    supervisor: llm,
    log: (m) => serverLog(m),
    idleMs,
    intervalMs: config.idleTickMs,
    neverUnload,
    disabled: config.noIdleUnload,
    activityScope: config.idleActivityScope,
  });
  if (neverUnload || config.noIdleUnload) {
    serverLog(`空闲卸载：${neverUnload ? '用户选择「从不卸载」（两级都关）' : '被 MIAO_NO_IDLE_UNLOAD=1 关掉（反证用）'}`);
  } else {
    serverLog(`空闲卸载：LLM 空闲 ${Math.round(idleMs / 60_000)} min 后释放（Tier1）`
      + `／视觉 ${Math.round(config.idleVisionMs / 60_000)} min（Tier2，由引擎 --models-ttl=${config.engineModelsTtl}s 执行）`);
    idleWatcher.start();
  }
  return idleWatcher;
}

restartIdleWatcher(config.idleLlmMs, config.unloadNever);

// 🔴 **监听放在最后**：`http.createServer` 一旦开始接客，任何一个请求都可能打到
//    `/health` → `sidecarState()` → `composeSidecar()`，而它要读 `llm` 与 `tierCtl`。
//    在此之前开门，撞上的就是 TDZ `ReferenceError`（"Cannot access 'llm' before initialization"）
//    —— 一个只在**启动那一瞬**偶发、且表现为 500 的错误，是最难复盘的一类。
//    移到这里的实际收益：`server` 开始监听之前，所有依赖都已建好，**结构上不可能有这个窗口**。
const { server, port } = await listenWithProbe(createHandler());
store.port = port;

const heartbeatTimer = setInterval(() => store.broadcastHeartbeat(), HEARTBEAT_MS);
heartbeatTimer.unref?.();

const sidecar = await sidecarState();

serverLog('================ 喵坞 box-service 已启动 ================');
serverLog(`监听地址   : http://127.0.0.1:${port}${BASE_PATH}`);
serverLog(`令牌       : ${config.token}`);
serverLog(`令牌文件   : ${TOKEN_FILE}`);
serverLog(`落盘根目录 : ${store.root}`);
serverLog(`状态目录   : ${STATE_DIR}`);
serverLog(`sidecar    : ${sidecar.state} port=${sidecar.port ?? '-'} engine=${sidecar.engine ?? '-'} `
  + `protocol=${config.engineProtocol}`);
// ③ 的归属方是**本进程**（不是 Rust）—— 这句日志是"谁该为 8080 负责"的现场凭证。
serverLog(`引擎③ LLM : 归属=box-service model=${llm.model ?? '-'} port=${llm.port ?? '-'} `
  + `autostart=${config.llmAutostart} 空闲卸载=${config.unloadNever ? '从不' : `${Math.round(config.idleLlmMs / 60_000)}min`}`);
// 档位：把"硬件推荐 / 用户配置 / 实际可用"三者摊开写，夹取发生时一眼能看见（§7.2 + §8）
serverLog(`档位       : 生效=${effectiveTier}（硬件推荐=${hardware.recommendedTier} `
  + `配置=${config.engineTier ?? '未指定'} 可用权重档=${availableTiers().join('/') || '无'}）`
  + `${effectiveTier === desiredTier ? '' : ' ⚠ 已夹取'}`);
serverLog(`加速后端   : ${hardwareAccel === 'cpu' || config.engineUseGpu ? hardwareAccel : 'cpu'}`
  + `（推荐=${hardwareAccel} gpu=${hardware.gpu.kind} ram=${hardware.totalRamGb}GB`
  + `${hardwareAccel !== 'cpu' && !config.engineUseGpu ? ' ⚠ 已回退 CPU ⇒ sidecar.state=degraded' : ''}）`
  + ` 降档=${config.noTierDowngrade ? '关闭（反证开关）' : '启用（仅一次，服务级）'}`);
serverLog(`失败注入   : FAIL_SEQ=[${[...config.failSeqs].join(',')}] ITEM_FAIL_RATE=${config.itemFailRate} `
  + `DISK_FULL=${config.diskFull} SIDECAR_DOWN=${config.sidecarDown} SKIP_EXISTING=${config.skipExisting}`);
if (restore.restored > 0) {
  // G-12：中断的任务仍以 failed 收尾，但**它们未落盘的原图会先被搬回漫画目录**，
  // 于是在库里显示「待译」、可经「继续翻译」补译文 —— 所以这里不能再只说「已按 failed 收尾」。
  serverLog(`任务清单恢复：${restore.restored} 个（其中 ${restore.aborted} 个非终态任务已收尾；`
    + `其未落盘的原图已搬回漫画目录，可在「继续翻译」里补译文）`);
}
if (restore.swept > 0) serverLog(`暂存区清扫：删除 ${restore.swept} 个空目录`);
// 机器可读的就绪行：桌面端 Rust 层据此拿到端口与令牌，不必去猜端口段或读文件
serverLog(`MIAO_READY ${JSON.stringify({ port, token: config.token, rootDir: store.root })}`);
serverLog('=========================================================');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    serverLog(`收到 ${sig}，关闭中…`);
    clearInterval(heartbeatTimer);
    idleWatcher?.stop();
    // 先等 ③ 真的退出再退自己 —— 否则 8080 会短暂留给孤儿，而 E11 的外部观察者正是去抓它。
    // 加 finally 兜底：③ 的收尾失败不该让服务关不掉（Rust 侧超时后会 SIGKILL，反而更难诊断）。
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      server.close(() => process.exit(0));
      // 兜底：SSE 长连接可能让 close 回调迟迟不触发
      setTimeout(() => process.exit(0), 500).unref();
    };
    llm.stop({ reason: `服务收到 ${sig}`, graceMs: 3000 }).catch(() => {}).finally(finish);
    // 二次兜底：LLM 收尾本身也可能卡住（进程僵死 → kill 无响应）
    setTimeout(finish, 6000).unref();
  });
}
