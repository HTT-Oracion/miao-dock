// box-service HTTP 入口（真实服务）
// 契约依据：§1 拓扑与端口、§2 通用约定、§5 端点、§8 安全
// 与 `miao-trans/mock-service` 同源（同契约）：差异集中在「真实化」——
// 令牌 CSPRNG、落盘根目录归位、sidecar 由真实探测（而非计时器模拟）、翻译走引擎。
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  API_VERSION, BASE_PATH, BATCH_LIMIT, COVER_MAX_BYTES, ENGINE_SETTINGS_FILE, MANIFEST_FILE,
  MAX_SEQ, MERGE_ARCHIVE_DIR, REPO_ROOT,
  ROOT_DIR, SERVICE_NAME, SERVICE_VERSION, STATE_DIR, TASKS_STATE_DIR,
  TOKEN_FILE, TRANSLATE_DIRECTIONS, assertInsideRoot, config, engineSettingsFile,
  isSupportedDirection, normalizeDirection,
  readIdleSettings, validateRoot,
} from './config.mjs';
import { ApiError, errorEnvelope, permissionDenied, securityLog } from './errors.mjs';
import {
  ENGINE_VERSION, engineConfigSnapshot, probeEngine, recentStageLog, resolveLlmLaunch,
  availableTiers, TIER_LLM_MODELS,
} from './engine-client.mjs';
import { EngineSettingsError, RESTART_REQUIRED_KEYS, assertPatch, readEngineSettings, writeEngineSettings } from './settings/engine-settings.mjs';
import { ACCEL_LABELS, TIERS as TIERS_ALL, TIER_PEAK_GB, accelOptions, probeHardware, resolveAccel, tierOptions } from './settings/engine-profile.mjs';
import { createIdleWatcher } from './settings/idle-policy.mjs';
import { LlmSupervisor } from './settings/llm-supervisor.mjs';
import { modelStatus } from './settings/model-status.mjs';
import { createTierDowngrade } from './settings/tier-downgrade.mjs';
import { allFieldStrings, firstField, groupParts, parseMultipartEx } from './multipart.mjs';
import {
  bookMetaView, createBookDir, episodesFromDirs, findFile, hasManifest,
  listChapterDirs, mustChapterDir as mustChapterDirAt, pickFirstChapterImage, readCoverName, readManifest,
  removeCover, resolveBookDir as resolveBookDirAt, resolveChapterDir as resolveChapterDirAt,
  resolveComicDir as resolveComicDirAt, scanLibrary, writeCover, writeManifestAtomic,
} from './manga/library.mjs';
import { sniffImageType } from './image.mjs';
import { normalizeComicName, isSafeDirName } from './manga/names.mjs';
import { watchParent } from './parent-watch.mjs';
import { Store } from './manga/store.mjs';
import { HEARTBEAT_MS, SSE_HEADERS, writeComment, writeSseEvent } from './manga/sse.mjs';
import {
  configureTranslate, currentTranslateSource, saveTranslateCredentials, saveTranslateSettings,
  translateApiError, translateOptionsView, translateStream, translateText,
} from './manga/translate/index.mjs';

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
// `securityLog` / 寻址函数（resolveComicDir 等）已下沉数据层/底座（D-147），见下方 import。

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
  || path.join(REPO_ROOT, 'engine', 'models.manifest.json');

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
 * 续传靠 `<dest>.part` 文件。两个下载同时跑会往同一批 `.part`
 * 里写、互相截断；**失败形态是"下完了、哈希不对"**，而它看起来像"网络坏了"。
 * 与其事后归因，不如在入口 409 掉。
 *
 * ## 🔴 A3d：执行体是 `boxsvc --fetch-models`，不再是 `node fetch-models.mjs`
 * A3「node 随包」作废 ⇒ 产品运行期不许 fork 解释器。下载器本体已 Rust 化
 * （`boxsvc::engine::model_store` + `boxsvc --fetch-models`），本文件只是**服务的 Node
 * 对照端**，它调用同一个执行体 —— 否则两靶的 `modelDownload` 视图会各说一套
 * （Rust 报 `runner`、Node 报 `script`），对拍就失去意义。
 *
 * ## 🔴 默认值为什么不是 `current_exe()`（C2）
 * C2 的台账原话是「默认值改为**随包资源路径**（`REPO_ROOT` 仅作 dev 兜底）」。A3d 之后
 * 这件事有了**更强的形态**：**产品侧**（`boxsvc::engine::state`）的默认值就是
 * `std::env::current_exe()` —— `boxsvc` 本来就随包，于是"装完之后这条通道跑得起来"
 * 不依赖任何资源配置、也不依赖解释器（那条路径由 `check:model-runner` 钉住）。
 *
 * 本文件是**服务的 Node 对照端**，而 node 进程的"自己"是 node 解释器 —— 拿它当执行体
 * 毫无意义，所以这里只能落到 **dev 构建产物的落点**上：这一行只在开发机与 e2e 上有意义，
 * 产品永远不会走到它（产品跑的是 Rust 那份）。
 *
 * ## 夹具接缝
 * `MIAO_MODEL_DOWNLOAD_RUNNER` 覆盖执行体 —— 与 `MIAO_MODEL_MANIFEST` 同一手法。
 * 没有它，验收就得**真下几个 GB**（依赖网络、十几分钟、且不可重放）。产品路径不设置它。
 * ⚠️ A3d 起它必须是**可直接 spawn 的可执行文件**（Windows `.cmd`/`.exe`，unix 可执行），
 *    不再隐含"再来一个 node 解释器"。
 */
const MODEL_DOWNLOAD_RUNNER = path.resolve(
  process.env.MIAO_MODEL_DOWNLOAD_RUNNER
  || path.join(REPO_ROOT, 'app', 'src-tauri', 'target', 'debug',
    `boxsvc${process.platform === 'win32' ? '.exe' : ''}`),
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
    /** 执行体（A3d 起是 `boxsvc`，不再是那个 .mjs 脚本） */
    runner: MODEL_DOWNLOAD_RUNNER,
    /**
     * 执行体在不在盘上。界面据此**禁用按钮**（而不是让用户点一下换一条报错）——
     * 与「打开目录」按 `root` 禁用是同一条纪律。
     */
    runnerExists: fs.existsSync(MODEL_DOWNLOAD_RUNNER),
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
  if (!fs.existsSync(MODEL_DOWNLOAD_RUNNER)) {
    throw new ApiError('INTERNAL', `模型下载执行体不存在：${MODEL_DOWNLOAD_RUNNER}`,
      { runner: MODEL_DOWNLOAD_RUNNER });
  }

  modelDownload.state = 'running';
  modelDownload.startedAt = new Date().toISOString();
  modelDownload.finishedAt = null;
  modelDownload.exitCode = null;
  modelDownload.timedOut = false;
  modelDownload.tail = [];
  serverLog(`模型下载已启动：${MODEL_DOWNLOAD_RUNNER} --fetch-models → ${MODEL_ROOT}`);

  const child = spawn(MODEL_DOWNLOAD_RUNNER, [
    '--fetch-models', '--root', MODEL_ROOT, '--manifest', MODEL_MANIFEST,
  ], {
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

/**
 * 读并解析 JSON 请求体，**区分「空体」与「坏 JSON」**。
 *
 * 🔴 为什么不像既有的 `handleDeleteTasks` 那样 `try/catch` 后把解析失败当空体：
 * 那两个 handler 的语义是"空体 = 用默认值"，解析失败当空体不改变行为；而 `create` / `meta`
 * 的语义是"**用户明确给了要写什么**"——把 `{"title":` 这种半截 JSON 静默当成"没给参数"，
 * 就会回 200 而什么都没改，前端弹「已保存」。这正是 §2-4 说的"看起来正常、其实没生效"。
 */
async function readJsonBody(req) {
  const body = await readBody(req);
  if (!body || body.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, value: null };
  }
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
 *    调用 `boxsvc --fetch-models --check`（A3d 之前是 `node fetch-models.mjs --check`），
 *    走的是 `verifyModels()` —— `--check` 分支**不联网、不删任何东西**。
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
    const started = Date.now();
    const { code, stdout, stderr, timeout } = await runVerifyChild(MODEL_DOWNLOAD_RUNNER, {
      MIAO_MODEL_ROOT: MODEL_ROOT,
      // 与 `engine-client.mjs` 无关：清单路径**显式**给（与 Rust 侧同口径）——
      // 靠默认值对齐等于把两处事实源分开维护，搬一次路径就静默错开。
      MIAO_MODEL_MANIFEST: MODEL_MANIFEST,
    }, { manifest: MODEL_MANIFEST });
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
    // HF 缓存布局那一节（只在清单含 `hf` 条目时才有）—— 它才是"文件都在、引擎仍加载不了"的判据，
    // 所以必须**一并计入 ok**：只比文件存在/哈希会给一个"绿着但跑不起来"的假结论（见 spec-notes D-99）。
    const mh = /HF 缓存布局：可解析 (\d+) \/ 不可解析 (\d+)（共 (\d+)）/.exec(text);
    const hfBroken = mh ? Number(mh[2]) : 0;
    const hfTotal = mh ? Number(mh[3]) : 0;
    sendJson(res, 200, {
      ok: bad === 0 && missing === 0 && hfBroken === 0,
      pass, bad, missing, total,
      hf: { resolvable: hfTotal - hfBroken, broken: hfBroken, total: hfTotal },
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
function runVerifyChild(runner, extraEnv, { timeoutMs = 900_000, manifest } = {}) {
  return new Promise((resolve) => {
    const args = ['--fetch-models', '--check'];
    if (manifest) args.push('--manifest', manifest);
    const child = spawn(runner, args, {
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
      // 🔴 消息里必须**带上路径**：执行体不在盘上时，用户（和我们）看到的若只是
      //    「系统找不到指定的文件」这一句，根本不知道它在找谁 —— 而"找的是哪个执行体"
      //    正是 C2 要答的问题。文案与 Rust 版（`handlers.rs::run_verify_child`）**逐字一致**。
      resolve({ code: -1, stdout, stderr: `${stderr}\n无法启动执行体 ${runner}：${err.message}`, timeout: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timeout });
    });
  });
}

/**
 * 从 multipart 的 fields/files 里取出 `payload` JSON。
 *
 * 两处调用：① 本仓的投递建单（`parseUploadRequest`）② 封面落盘（`handleLibraryCover`，见 D-116
 * —— 同一次请求里既传图又传 `author`）。抽成一份，免得两条 multiplart 路径对"`payload` 既可能是
 * 普通字段、也可能是被当文件传"这件事各记一半。
 */
function extractPayloadField(fields, files) {
  let rawPayload = firstField(fields, 'payload');
  // `payload` 既可能是普通字段（推荐），也可能被客户端当文件 part 上传，两者都接受
  if (rawPayload === null) {
    const asFile = files.get('payload');
    if (asFile && asFile.length > 0) rawPayload = asFile[0].data.toString('utf8');
  }
  if (rawPayload === null || rawPayload === undefined || String(rawPayload).trim() === '') return {};
  try {
    const parsed = JSON.parse(rawPayload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * multipart 的**四道公共闸**：Content-Type → Content-Length 一致 → boundary 存在 → 以结束分隔符收尾。
 * 四道全过才返回分好组的 `{ fields, files }`。
 *
 * 抽出来的理由不是"短"，而是这四个错误**必须同口径** —— 少一道闸，就意味着某条上传路径
 * 会**静默少收几张图**（截断的请求体照样能解析出前半段）。上传入口不止一处，
 * 正确性只能靠"两边走的是同一段代码"来保证。
 */
function groupMultipart(req, body) {
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
  return groupParts(parsed.parts);
}

/** 解析 multipart 表单：payload + images[] + imageOrder[] */
function parseUploadRequest(req, body) {
  const { fields, files } = groupMultipart(req, body);
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

  return { payload: extractPayloadField(fields, files), images, imageOrder: allFieldStrings(fields, 'imageOrder') };
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

/**
 * 解析并校验请求里的**翻译方向**（`payload.lang`，ver2.1）。
 *
 * · 没给 ⇒ 返回 `undefined`（`store._newTask` 用默认方向「日译中」，旧客户端零改动）；
 * · 给了但不在 `TRANSLATE_DIRECTIONS` 里 ⇒ **400 `INVALID_TRANSLATE_LANG`**（理由见该码的注释）；
 * · 合法 ⇒ 规范化成小写短码 `{from, to}`。
 */
function resolveTaskLang(payload) {
  if (!payload || payload.lang === undefined || payload.lang === null) return undefined;
  if (!isSupportedDirection(payload.lang)) {
    throw new ApiError('INVALID_TRANSLATE_LANG', '不支持的翻译方向', {
      lang: payload.lang,
      supported: TRANSLATE_DIRECTIONS.map((d) => `${d.from}>${d.to}`),
    });
  }
  return normalizeDirection(payload.lang);
}

function handleCreateTask(req, res, cors) {
  return readBody(req).then(async (body) => {
    await assertSidecarReady();
    const { payload, images, imageOrder } = parseUploadRequest(req, body);
    const lang = resolveTaskLang(payload);
    const norm = normalizeComicName(payload.comicName);
    if (!norm.ok) throw new ApiError(norm.code, norm.message, norm.details);
    // §8.2 校验点 2：请求校验期就断言，绝不等到落盘期才失败
    assertSafeDirName(norm.name);
    assertRootWritable(); // §2.2 DISK_FULL(507)：请求级落盘不可用
    payload.__normalizedName = norm.name;
    payload.lang = lang;

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
    const existing = store.mustTask(taskId).dirName;
    assertSafeDirName(existing);
    // 方向是**任务级**属性（整条任务共用一套翻译器与 from_lang）⇒ 追加批次不能改它。
    // 给了就必须与任务一致：不一致等于"同一任务里后 20 张换个玩法"，而
    // `task.lang` 是唯一的真源、追加批次的 `lang` 会被丢弃 —— 那才是真的静默分歧。
    const lang = resolveTaskLang(payload);
    const current = store.mustTask(taskId).lang;
    if (lang && (lang.from !== current.from || lang.to !== current.to)) {
      throw new ApiError('INVALID_TRANSLATE_LANG', '追加批次的翻译方向必须与任务一致', {
        task: current, incoming: lang,
      });
    }
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

// ------------------------------------------------------------------ 在线翻译（ver2.2 · 方案 §6.3）
//
// 五条路由全部继承 `X-Box-Token` + Origin 校验（createHandler 里统一做，与既有端点同一把尺）。
// 业务全在 `manga/translate/index.mjs`（门面）—— 这里只做搬运：读体、调门面、出信封 / SSE。
// 🔴 门面纪律在路由层同样有效：本文件不出现任何平台字段名（`llm-trans` / `transIncre` …）。

/** 翻译路由的请求体：必须是 JSON 对象（空体按 `{}` 处理，缺字段由门面报 400） */
function translateBodyOf(value) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('TRANSLATE_INVALID_INPUT',
      `请求体必须是 JSON 对象，收到 ${Array.isArray(value) ? 'array' : typeof value}`,
      { received: Array.isArray(value) ? 'array' : typeof value });
  }
  return value;
}

/**
 * `POST /api/v1/translate/text` —— 普通文本翻译（整体）。
 *
 * 200 体只回 `{ text, lines?, langType }`：请求了 splitLines 但上游没给逐行译文时
 * **不带 lines 键**（对齐失败只由"键缺失"表达，方案 §6.2 —— 不硬凑：错位的逐行译文
 * 比没逐行危害大得多）。`details.aligned` 不进 200 体，前端不要求。
 */
async function handleTranslateText(req, res, cors) {
  const { ok, value } = await readJsonBody(req);
  if (!ok) throw new ApiError('TRANSLATE_INVALID_INPUT', '请求体不是合法 JSON', {});
  try {
    const result = await translateText(translateBodyOf(value));
    sendJson(res, 200, {
      text: result.text,
      ...(Array.isArray(result.lines) ? { lines: result.lines } : {}),
      ...(result.langType !== undefined ? { langType: result.langType } : {}),
    }, cors);
  } catch (err) {
    throw translateApiError(err); // 翻译域错误 → 契约信封；其余原样抛（走既有 500）
  }
}

/**
 * `POST /api/v1/translate/stream` —— 大模型翻译（流式，SSE 事件 translate.delta/.done/.error）。
 *
 * 三条硬顺序 / 硬纪律：
 *  ① **先 writeHead 再调门面**：头一旦发出，HTTP 状态就定了 —— 此后一切结果（含校验失败）
 *     都以 translate.* 事件表达，不再可能切换成 4xx。坏 JSON / 非对象体在头之前拦（回 400）。
 *  ② **背压**：`writeSseEvent` 返回 false ⇒ 在 onDelta 里等 'drain'；门面 await onDelta ⇒
 *     "上游读取节奏跟随下游"—— 否则下游慢、上游快会把内存堆成一座山（方案 §6.4）。
 *  ③ **客户端断开必须真断上游**：有道按量计费，客户端关了还继续拉 = 白花钱。
 *
 * ⚠️ 断连监听用 `res.on('close')` 而**不是** `req.on('close')`：本端点是 POST 且请求体
 *    已被 `readBody` 消费完 —— 实测（Node v24，POST+带体+SSE 探针）此时 req 的 'close'
 *    在请求体读完即刻触发（≈+1ms），拿它 abort 会在第一个 delta 之前就掐死每一条流；
 *    res 的 'close' 才严格对应"客户端断开 / 响应结束"（实测：客户端中断时 +335ms 触发）。
 *    （GET 无体的 `handleSse` 用 req.on('close') 是对的 —— 那条路请求体不消费，'close'
 *     即 socket 关闭。两条路形状不同，不能照抄。）
 */
async function handleTranslateStream(req, res, cors) {
  const { ok, value } = await readJsonBody(req);
  if (!ok) throw new ApiError('TRANSLATE_INVALID_INPUT', '请求体不是合法 JSON', {});
  const body = translateBodyOf(value); // 形状校验在写头之前：那时还回得了 400

  res.writeHead(200, { ...cors, ...SSE_HEADERS });
  res.socket?.setNoDelay?.(true);
  res.socket?.setTimeout?.(0); // 长流：关掉 socket 空闲超时（同 handleSse）

  let eventId = 0;
  const nextId = () => { eventId += 1; return eventId; };
  let afterChars = 0; // 已吐给客户端多少字 —— translate.error 的现场证据（方案 §6.1-4）

  const ac = new AbortController();
  res.on('close', () => ac.abort());

  try {
    await translateStream({ ...body, signal: ac.signal }, {
      onDelta: async (delta) => {
        afterChars += delta.length;
        const wrote = writeSseEvent(res, { id: nextId(), event: 'translate.delta', data: { text: delta } });
        // 背压：写不动且连接还活着 ⇒ 等 drain（连接已死时等不到，不等）
        if (!wrote && !res.writableEnded && !res.destroyed) {
          await new Promise((resolve) => { res.once('drain', resolve); });
        }
      },
      onDone: async ({ text, langType }) => {
        writeSseEvent(res, { id: nextId(), event: 'translate.done', data: { text, langType } });
      },
    });
    res.end();
  } catch (err) {
    const e = translateApiError(err);
    // 顺序不能反：**先** translate.error **再** end()。反了浏览器拿到的是"流干净结束"。
    writeSseEvent(res, {
      id: nextId(),
      event: 'translate.error',
      data: {
        code: e instanceof ApiError ? e.code : 'INTERNAL',
        message: e instanceof ApiError ? e.message : '翻译流中途失败',
        afterChars,
      },
    });
    res.end();
  }
}

/**
 * `GET /api/v1/translate/options` —— 设置页 / 翻译面板的取值来源。
 * `settings` + `sources` **现读**（env > 文件 > 默认，逐键标来源）；`credentials` 只回
 * `{ appKey, hasSecret }` —— **secret 永不回显**（方案 §8.3）。
 */
async function handleTranslateOptions(req, res, cors) {
  try {
    sendJson(res, 200, await translateOptionsView(), cors);
  } catch (err) {
    throw translateApiError(err);
  }
}

/**
 * `POST /api/v1/translate/settings` —— 非密钥设置补丁（白名单 strict：未知键/非法值当场 400）。
 * 错误信封走 `INVALID_SETTING`（与 `/engine/settings` 同款，S6 同族）。
 */
async function handleTranslateSettings(req, res, cors) {
  const { ok, value } = await readJsonBody(req);
  if (!ok) throw new ApiError('INVALID_SETTING', '请求体不是合法 JSON', {});
  try {
    // value 为 null（空体）/ 非对象时由 assertTranslatePatch 抛 INVALID_SETTING —— 不静默当空补丁
    const result = saveTranslateSettings(value);
    sendJson(res, 200, { ok: true, changed: result.changed, settings: result.settings }, cors);
  } catch (err) {
    throw translateApiError(err);
  }
}

/**
 * `POST /api/v1/translate/credentials` —— 保存平台密钥（**只写不读**：任何响应都不回显 secret）。
 * 校验（platform / appKey / appSecret 非空、appSecret ≤128）在 `writeCredentials` 内，
 * 失败 → `TRANSLATE_INVALID_INPUT`(400)。
 */
async function handleTranslateCredentials(req, res, cors) {
  const { ok, value } = await readJsonBody(req);
  if (!ok) throw new ApiError('TRANSLATE_INVALID_INPUT', '请求体不是合法 JSON', {});
  try {
    const saved = saveTranslateCredentials(translateBodyOf(value));
    sendJson(res, 200, { ok: true, saved }, cors);
  } catch (err) {
    throw translateApiError(err);
  }
}

// ------------------------------------------------------------------ 库与导出

/**
 * `GET /library` 的响应体：把宿主持有的东西（`store.root` 与隐藏清单）喂给数据层。
 * 数据层（`manga/library.mjs` 的 `scanLibrary`）本身不持有服务状态 —— 宿主负责注入。
 */
function libraryView() {
  return scanLibrary({
    root: store.root,
    hidden: store.hiddenComics,
    hiddenList: store.hiddenComicsView(),
  });
}

/**
 * 寻址薄包装：数据层（`manga/library.mjs`）的寻址函数是**纯函数**，`root` 由宿主注入。
 * 这层只做「注入 `store.root`」一件事 —— 于是调用点（~23 处）零改动（D-147）。
 *
 * 🔴 逻辑与安全顺序（**先判越界 403，再判格式/存在 404**，契约 §8.2）**都在数据层**，
 *    那里有逐条注释，此处不重述 —— 改顺序会改错误码语义，别在这层"顺手"加判断。
 */
const resolveComicDir = (rawName) => resolveComicDirAt(store.root, rawName);
const resolveBookDir = (rawName) => resolveBookDirAt(store.root, rawName);
const resolveChapterDir = (bookRaw, noRaw) => resolveChapterDirAt(store.root, bookRaw, noRaw);
const mustChapterDir = (bookRaw, noRaw) => mustChapterDirAt(store.root, bookRaw, noRaw);

/**
 * 把一个目录内的图片文件按字节发出去（`files/{seq}` 与 `chapters/{no}/files/{seq}` 共用）。
 *
 * 抽出来的理由不是"少写几行"，而是**打开文件前的 TOCTOU 复校验只能有一处**：
 * 两处各写一遍，就会漂移成"这里校验、那里忘了"，而漏掉的那一处就是把任意路径读出去的口子。
 */
async function sendImageBytes(res, cors, dir, name) {
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
  // pipeline 而不是 .pipe()：客户端中止（取消加载/切页）时自动销毁源流、**释放文件句柄** ——
  // 泄漏的读句柄会让该目录的归并 rename 撞 EPERM（D-125）；错误（含客户端提前断开）吞掉不外抛
  await pipeline(fs.createReadStream(file), res).catch(() => {});
}

function handleLibraryFile(req, res, cors, rawName, seqText, url) {
  const { dir } = resolveComicDir(rawName);
  const seq = Number.parseInt(seqText, 10);
  if (!Number.isFinite(seq) || seq < 1 || seq > MAX_SEQ) {
    throw new ApiError('INVALID_IMAGE', `seq 必须是 1–${MAX_SEQ} 的整数`, { seq: seqText });
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
  sendImageBytes(res, cors, dir, name);
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
 * `POST /tasks/delete` —— 队列页多选删除（**契约外增量端点**）。
 *
 * body：`{ "taskIds": ["tsk_…", …] }`。
 * 语义：只删「记录」（内存 + `state/tasks/<id>.json`），**不碰漫画目录** ——
 * 队列删的是"任务"，漫画库删的才是"漫画"。翻译中 / 排队中不可删，逐条回报 `skipped`，
 * 不整批失败（一批多选里混着两种状态是常态，见 `Store.deleteTasks`）。
 */
async function handleDeleteTasks(req, res, cors) {
  const body = await readBody(req);
  let parsed = null;
  try { parsed = body && body.length ? JSON.parse(body.toString('utf8')) : null; } catch { /* 允许空体 → 下面报错 */ }
  const taskIds = parsed?.taskIds;
  if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.some((t) => typeof t !== 'string')) {
    throw new ApiError('INVALID_IMAGE', 'taskIds 必须是非空字符串数组', { taskIds });
  }
  const { deleted, skipped } = store.deleteTasks(taskIds);
  sendJson(res, 200, { deleted, skipped, deletedCount: deleted.length, skippedCount: skipped.length }, cors);
}

/**
 * `POST /library/{comicName}/delete` —— 从漫画库删除一部漫画（**契约外增量端点**）。
 *
 * body：`{ "deleteFiles": boolean }`（缺省按 `false` 处理，即"只隐藏"更安全）：
 *  · `deleteFiles: true`  ⇒ 递归删除该漫画目录（磁盘真删）；
 *  · `deleteFiles: false` ⇒ 只把该漫画**隐藏**（目录与文件原样保留），库里不再显示。
 *
 * 安全：目录名先过 `resolveComicDir`（§8.2 校验点 2 的原始名断言 + 前缀校验），
 * 真删前再断言一次"在根目录内、且不是根目录本身" —— 删除是不可逆动作，守卫不嫌多。
 */
async function handleLibraryDelete(req, res, cors, rawName) {
  const { name, dir } = resolveComicDir(rawName);
  const body = await readBody(req);
  let parsed = null;
  try { parsed = body && body.length ? JSON.parse(body.toString('utf8')) : null; } catch { /* 允许空体 */ }
  const deleteFiles = parsed?.deleteFiles === true;

  if (!deleteFiles) {
    const hidden = store.hideComic(name);
    return sendJson(res, 200, { comicName: name, deletedFiles: false, hidden, hiddenCount: hidden.length }, cors);
  }

  try {
    assertInsideRoot(store.root, path.join(dir, 'x.png'));
  } catch {
    securityLog(`拒绝删除越界的漫画目录：${dir}（root=${store.root}）`);
    throw permissionDenied();
  }
  if (path.resolve(dir) === path.resolve(store.root)) {
    securityLog(`拒绝删除漫画库根目录本身：${dir}`);
    throw permissionDenied();
  }
  if (!fs.existsSync(dir)) {
    // 目录本就不在：顺手清掉可能残留的隐藏记录（否则同名重建会被无声跳过），再如实报 404。
    store.forgetHidden(name);
    throw new ApiError('TASK_NOT_FOUND', '漫画目录不存在', { comicName: name, outputDir: dir });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  // 目录已真删，隐藏记录也就没意义了 —— 不清会让"日后重建的同名漫画"被无声跳过。
  store.forgetHidden(name);
  sendJson(res, 200, { comicName: name, deletedFiles: true, outputDir: dir }, cors);
}

/** `POST /library/{comicName}/unhide` —— 取消隐藏，恢复显示（**契约外增量端点**）。 */
async function handleLibraryUnhide(req, res, cors, rawName) {
  const { name } = resolveComicDir(rawName);
  const hidden = store.unhideComic(name);
  sendJson(res, 200, { comicName: name, hidden, hiddenCount: hidden.length }, cors);
}

// ---------------------------------------------------------------- 大类：新建 / 元信息 / 封面
// 契约见 docs/spec-notes.md D-115 §4 与 D-116。四条端点全是 Box 专用（插件端不认识这些路径）。

/** 标题长度上限。比目录名（64）宽 —— 目录名是文件名，标题只是显示文字 */
const MAX_TITLE_CHARS = 200;
/** 作者长度上限 */
const MAX_AUTHOR_CHARS = 100;

/**
 * `POST /library/create` —— 手动新建一部漫画（大类）。
 *
 * body：`{ name, title?, author? }`。`name` 走 `normalizeComicName`（契约 §6.1，
 * **服务端是唯一权威**，前端只做 `dupKey` 预校验）；同名 → 409 `BOOK_NAME_TAKEN`。
 *
 * 🔴 建完必须 `forgetHidden`：同名目录曾被"删除但不删文件"（= 只隐藏）过、而目录后来又被
 *    手工删掉时，隐藏记录还在盘上；此时新建出的同名大类会被 `scanLibrary` 的
 *    `hiddenComics.has(entry.name)` 直接跳过 ⇒ 用户看到"刚建完就没了"。
 *    这与 `handleLibraryDelete` 里那句 `store.forgetHidden(name)` 是同一个坑的另一面。
 */
async function handleLibraryCreate(req, res, cors) {
  const { ok, value } = await readJsonBody(req);
  if (!ok) {
    throw new ApiError('INVALID_BOOK_META', '请求体不是合法 JSON', { raw: 'unparsable' });
  }
  const rawName = value && typeof value === 'object'
    ? (value.name ?? value.comicName ?? value.title)
    : null;
  const norm = normalizeComicName(rawName);
  if (!norm.ok) throw new ApiError(norm.code, norm.message, norm.details);
  if (!isSafeDirName(norm.name)) {
    securityLog(`拒绝路径越界的新建漫画名（§8.2 校验点 2）：${JSON.stringify(rawName)}`);
    throw permissionDenied();
  }
  const title = value && typeof value.title === 'string' ? value.title.trim() : '';
  if (title.length > MAX_TITLE_CHARS) {
    throw new ApiError('INVALID_BOOK_META', `标题超过 ${MAX_TITLE_CHARS} 个字符`, { limit: MAX_TITLE_CHARS, length: title.length });
  }
  const author = value && typeof value.author === 'string' ? value.author.trim() : '';
  if (author.length > MAX_AUTHOR_CHARS) {
    throw new ApiError('INVALID_BOOK_META', `作者超过 ${MAX_AUTHOR_CHARS} 个字符`, { limit: MAX_AUTHOR_CHARS, length: author.length });
  }

  let created = null;
  try {
    created = createBookDir(store.root, norm.name);
  } catch (err) {
    /**
     * 🔴 判据用 **`fs.existsSync` 复检**，不用 `err.code === 'EEXIST'`。
     *
     * 理由是"错误码不是可观测事实、目录在不在才是"：
     *  · 错误码会被**包装层改写**——实测本机沙箱把 `err.code` 统一换成自己的码，
     *    而 `err.message` 仍是 `EEXIST: file already exists, mkdir '…'`。按 code 判会漏掉，返回 500。
     *  · 目录有没有被建出来是**同一份事实**的两面：`mkdirSync(recursive:false)` 在已存在时抛错、
     *    在存在时 `existsSync` 为真 —— 用后者判定，`recursive:false` 这条纪律才有意义。
     *
     * ⚠️ 因此这里**不**做 `existsSync` 预校验：预校验会把"`recursive:false` 被改成 `true`"这个
     *    缺陷掩盖掉（预校验照样能拦下同名），于是"同名 → 409"这条断言就再也红不了。
     *    让 mkdir 自己去撞、撞完用可观测事实归因，反证才咬得住（见 Step 8 的反证轮）。
     */
    if (fs.existsSync(path.join(store.root, norm.name))) {
      // 同名目录（可能是"隐藏但文件还在"的那本）—— 如实回 409，并带上 `hidden` 让界面能解释
      // "为什么库里看不见它却还说我重名"。
      throw new ApiError('BOOK_NAME_TAKEN', `已存在同名漫画「${norm.name}」`, {
        bookName: norm.name, outputDir: path.join(store.root, norm.name),
        hidden: store.hiddenComics.has(norm.name),
      });
    }
    throw err;
  }
  // 隐藏记录必须清掉，否则新建出来的这本会被扫描跳过（见函数头注释）
  store.forgetHidden(norm.name);
  if (title || author) {
    writeManifestAtomic(created.dir, {
      ...created.manifest, title: title || created.manifest.title, author,
    });
  }
  sendJson(res, 201, bookMetaView(norm.name, created.dir), cors);
}

/**
 * 把 `title` / `author` 两个可选字段合并进 manifest。
 * 返回 `{manifest, touched}`：`touched` 为假表示"这次请求没要求改任何字段"。
 */
function applyMetaFields(manifest, body) {
  const next = { ...manifest };
  let touched = false;
  if (body && Object.prototype.hasOwnProperty.call(body, 'title')) {
    if (typeof body.title !== 'string') {
      throw new ApiError('INVALID_BOOK_META', 'title 必须是字符串', { field: 'title', type: typeof body.title });
    }
    const t = body.title.trim();
    if (t.length === 0) throw new ApiError('INVALID_BOOK_META', '标题不能为空', { field: 'title' });
    if (t.length > MAX_TITLE_CHARS) {
      throw new ApiError('INVALID_BOOK_META', `标题超过 ${MAX_TITLE_CHARS} 个字符`, { limit: MAX_TITLE_CHARS, length: t.length });
    }
    next.title = t;
    touched = true;
  }
  if (body && Object.prototype.hasOwnProperty.call(body, 'author')) {
    if (typeof body.author !== 'string') {
      throw new ApiError('INVALID_BOOK_META', 'author 必须是字符串', { field: 'author', type: typeof body.author });
    }
    const a = body.author.trim();
    // 空串是**合法**输入 = 「清掉署名」（与 title 不同：标题清空了这本就没有名字了）
    if (a.length > MAX_AUTHOR_CHARS) {
      throw new ApiError('INVALID_BOOK_META', `作者超过 ${MAX_AUTHOR_CHARS} 个字符`, { limit: MAX_AUTHOR_CHARS, length: a.length });
    }
    next.author = a;
    touched = true;
  }
  return { manifest: next, touched };
}

/**
 * 把一张**磁盘上已有**的图片落成封面（`coverFromFirstChapter` 路径）。
 *
 * 复用 `writeCover()` 而不是自己 `fs.copyFileSync`：一次性拿到大小校验 / 嗅探 / 删旧 / 原子写
 * 四道保护（D-115 §7 的"单一入口"）。
 */
function coverFromFirstChapter(root, bookDir) {
  const src = pickFirstChapterImage(bookDir);
  if (!src) {
    throw new ApiError('TASK_NOT_FOUND', '这本漫画还没有任何话，取不到首图', { bookDir });
  }
  let data = null;
  try {
    data = fs.readFileSync(src);
  } catch (err) {
    throw new ApiError('INVALID_IMAGE', '读取首图失败', { src, reason: String(err && err.message) });
  }
  if (data.length > COVER_MAX_BYTES) {
    throw new ApiError('COVER_TOO_LARGE',
      `图片不能超过 ${Math.round(COVER_MAX_BYTES / (1024 * 1024))} MB`,
      { limitBytes: COVER_MAX_BYTES, actualBytes: data.length, src });
  }
  const ext = sniffImageType(data);
  if (!ext) {
    throw new ApiError('INVALID_IMAGE', '这个文件不是图片（png / jpg / webp）', { src });
  }
  return writeCover(root, bookDir, data, ext);
}

/** `GET /library/{book}/meta` —— 读元信息（title / author / coverPath / 话页汇总）。 */
function handleLibraryMeta(req, res, cors, rawName) {
  const { name, dir } = resolveBookDir(rawName);
  sendJson(res, 200, bookMetaView(name, dir), cors);
}

/**
 * `POST /library/{book}/meta` —— 写 title / author；`{coverFromFirstChapter:true}` 取第 1 话首图。
 *
 * 三个字段都没有 ⇒ 400 `INVALID_BOOK_META`。静默回 200 会让前端弹「已保存」而磁盘零变化
 *（AGENTS §2-4 的"假绿"）。
 */
async function handleLibraryMetaWrite(req, res, cors, rawName) {
  const { name, dir } = resolveBookDir(rawName);
  const { ok, value } = await readJsonBody(req);
  if (!ok) throw new ApiError('INVALID_BOOK_META', '请求体不是合法 JSON', { raw: 'unparsable' });
  const body = value && typeof value === 'object' ? value : {};
  const { manifest, touched } = applyMetaFields(readManifest(dir, name), body);
  let changed = touched;
  if (body.coverFromFirstChapter === true) {
    manifest.cover = coverFromFirstChapter(store.root, dir);
    changed = true;
  } else if (body.coverFromFirstChapter !== undefined && body.coverFromFirstChapter !== false) {
    throw new ApiError('INVALID_BOOK_META', 'coverFromFirstChapter 只能是布尔 true', {
      field: 'coverFromFirstChapter', type: typeof body.coverFromFirstChapter,
    });
  }
  if (!changed) {
    throw new ApiError('INVALID_BOOK_META',
      '没有需要更新的字段（title / author / coverFromFirstChapter 至少要给一个）', {});
  }
  // `episodes[]` 一律按**目录**重建后回写（D-115 §3「目录即索引」），不做"读旧数组再合并"
  writeManifestAtomic(dir, { ...manifest, episodes: episodesFromDirs(dir) });
  sendJson(res, 200, bookMetaView(name, dir), cors);
}

/**
 * `POST /library/{book}/cover` —— multipart 单文件（字段 `cover`）落封面 + 回写 manifest。
 *
 * 🔴 扩展名**只由字节决定**（`sniffImageType`），不信任 `part.filename` / `part.contentType`
 *    —— 契约 §7.2 同纪律：把 `evil.png`（其实是 exe）放行的代价，是它随后被当成图片渲染/上传。
 *
 * 🔴 顺序是「先落文件、后写 json」：万一在两步之间中断，`readCoverName` 的 readdir 兜底
 *    仍能把封面文件认出来（D-115 §4 的读时容错），而反过来的顺序会留下"manifest 指着一个
 *    不存在的 cover"的空指。
 */
async function handleLibraryCover(req, res, cors, rawName) {
  const { name, dir } = resolveBookDir(rawName);
  const body = await readBody(req);
  const { fields, files } = groupMultipart(req, body);
  const covers = files.get('cover') || [];
  if (covers.length === 0) {
    throw new ApiError('INVALID_IMAGE', '缺少封面分片（字段名 cover）', { submitted: 0 });
  }
  if (covers.length > 1) {
    // 多选一张会造成"用了哪张"不可判定 —— 明确拒绝，别让 readdir/数组顺序替用户做决定
    throw new ApiError('INVALID_IMAGE', '封面只能一次选一张', { submitted: covers.length });
  }
  const data = covers[0].data;
  if (data.length > COVER_MAX_BYTES) {
    throw new ApiError('COVER_TOO_LARGE',
      `图片不能超过 ${Math.round(COVER_MAX_BYTES / (1024 * 1024))} MB`,
      { limitBytes: COVER_MAX_BYTES, actualBytes: data.length });
  }
  const ext = sniffImageType(data);
  if (!ext) {
    throw new ApiError('INVALID_IMAGE', '这个文件不是图片（png / jpg / webp）',
      { filename: covers[0].filename || null, contentType: covers[0].contentType || null });
  }
  const coverName = writeCover(store.root, dir, data, ext);
  // 同一次请求里既传图又传作者（设计稿 11.2 的编辑信息弹窗"确认"按钮走这一条）
  const { manifest } = applyMetaFields(readManifest(dir, name), extractPayloadField(fields, files));
  writeManifestAtomic(dir, { ...manifest, cover: coverName, episodes: episodesFromDirs(dir) });
  sendJson(res, 200, bookMetaView(name, dir), cors);
}

/**
 * `DELETE /library/{book}/cover` —— 移除封面：删盘上 `cover.*` + `manifest.cover = null`。
 *
 * 📌 **保留 `author`**（D-115 §4 明写）：移除封面不是"清空元信息"，把作者一并抹掉是过度删除。
 */
async function handleLibraryCoverDelete(req, res, cors, rawName) {
  const { name, dir } = resolveBookDir(rawName);
  removeCover(dir);
  const manifest = readManifest(dir, name);
  writeManifestAtomic(dir, { ...manifest, cover: null, episodes: episodesFromDirs(dir) });
  sendJson(res, 200, bookMetaView(name, dir), cors);
}

/**
 * `GET /library/{book}/cover` —— 把封面**字节**发给前端（列表缩略图 / 详情页头部用）。
 *
 * 为什么必须有这一条：计划的路由表只列了 `POST` / `DELETE`，但前端拿到 `coverPath`
 * （目录内文件名）之后**没有任何办法把它变成可渲染的东西** —— WebView 不能直接读本地任意路径
 * （那要 asset protocol + scope，属安全面扩张）。而页图早就有一条 `files/{seq}` 在发字节，
 * 封面走一条对称的读端点才是最省事、也最一致的答案（D-116）。
 *
 * 封面是**未受保护的展示素材**（不是页图），仍走完整鉴权 + 前缀校验，只是不做隐藏判定
 * —— 隐藏的是「这本书不列在库里」，不是"它的封面文件成了机密"。
 */
async function handleLibraryCoverFile(req, res, cors, rawName) {
  const { name, dir } = resolveBookDir(rawName);
  const coverName = readCoverName(dir, readManifest(dir, name));
  if (!coverName) {
    throw new ApiError('TASK_NOT_FOUND', '这本漫画还没有封面', { bookName: name, outputDir: dir });
  }
  const file = path.join(dir, coverName);
  try {
    assertInsideRoot(store.root, file); // 打开文件前再校验一次（防 TOCTOU，与 files/{seq} 同）
  } catch {
    securityLog(`封面文件读取越界：${file}`);
    throw permissionDenied();
  }
  const ext = coverName.split('.').pop().toLowerCase();
  const stat = fs.statSync(file);
  res.writeHead(200, {
    ...cors,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    // 封面会被"换封面"改掉，且前端按 URL 缓存成 blob ⇒ 不允许任何一层缓存（含 WebView）
    'Cache-Control': 'no-store',
  });
  // 同 sendImageBytes：pipeline 保证中止时释放句柄（D-125）
  await pipeline(fs.createReadStream(file), res).catch(() => {});
}

// ---------------------------------------------------------------- 大类：归并 + 话级寻址
// 契约见 docs/spec-notes.md D-115 §4 与 D-117（话级寻址为何必须新开一条解析）。

/** 归并归档目录（`state/merge-archive/`），按需创建 */
function mergeArchiveDir() {
  const dir = path.join(STATE_DIR, MERGE_ARCHIVE_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** 归档用的时间戳（文件名安全：冒号与点在 Windows 上都不合法） */
function stampOf() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * `EXDEV`（跨卷 / 网络盘）判定 —— **多信号**，不只看 `err.code`。
 *
 * 为什么三条一起看：`err.code` 是三者里**可移植性最低**的一项（包装层会把它整体换掉，
 * 实测某沙箱把 code 统一改成自己的码而 message 保留原文）；`err.errno === 18` 与 message 里的
 * `EXDEV` 字样是另外两条独立线索。任意一条命中即认定跨卷 —— 判错的代价只是文案（下一条
 * 都是 409），而判漏的代价是把一次可解释的失败变成 500。
 */
function isCrossDeviceError(err) {
  if (!err) return false;
  if (err.code === 'EXDEV' || err.errno === 18) return true; // 18 = EXDEV（Linux/macOS 同值）
  return /EXDEV|cross-device/i.test(String(err.message || ''));
}

/**
 * Windows「句柄占用族」判定 —— `rename` 撞上被打开的文件句柄时抛这几个码。
 *
 * 典型来源（都是**等待可解**的，与 EXDEV 的"永远搬不动"有本质区别）：
 *  · `EPERM`/`EBUSY`：目录内有文件被某进程打开 —— 页面图响应还在传、资源管理器缩略图、
 *    本服务自己泄漏的读取流（见 `sendImageBytes` 改 `pipeline` 的修复，D-125）；
 *  · `EACCES`：杀毒/索引器瞬时独占。
 * message 正则兜底是给包装层留的（理由同 `isCrossDeviceError` 的多信号纪律）。
 * 注意 EXDEV 的 message（"cross-device link not permitted"）**不含**这三个码 ⇒ 不会误判。
 */
function isBusyFsError(err) {
  if (!err) return false;
  if (['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) return true;
  return /EPERM|EBUSY|EACCES|being used by another process/i.test(String(err.message || ''));
}

const RENAME_RETRY = { tries: 5, delayMs: 200 }; // 总等待 ≈ 800ms，瞬时句柄足够释放
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 目录重命名 + 占用退避重试。
 *
 * 为什么重试而不是直接报错：归并入口就挂在详情页/搜索结果上，用户点「归并」时**该话的
 * 缩略图请求极可能还在路上**（环回上高分辨率 webp 传输以秒计），Windows 下目录内有
 * 打开的读句柄 ⇒ `renameSync` 抛 `EPERM`。等几百毫秒句柄就释放了 —— 这是**重试可解**的
 * 瞬态失败，不该把它变成用户可见的报错（D-125）。重试耗尽仍占用才抛，由调用方归因成
 * `MERGE_SOURCE_LOCKED`（409），而不是 500 INTERNAL。
 */
async function renameDirWithRetry(src, dst) {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (err) {
      if (!isBusyFsError(err) || i >= RENAME_RETRY.tries) throw err;
      serverLog(`归并移动被占用（${err.code || 'busy'}，${i}/${RENAME_RETRY.tries - 1} 次重试后放弃）：${path.basename(src)}`);
      await sleepMs(RENAME_RETRY.delayMs);
    }
  }
}

/**
 * 归并移动完成后的不变量校验：**一个大类目录里只能有一份 `manifest.json`**。
 *
 * 正常路径下这里是空操作 —— 前置校验已经卡死了"源必须是 others（无 manifest）"。留着它是为了
 * 覆盖**竞态**：若在那个极短窗口里有人往源目录写进一份 `manifest.json`，移动后大类里就有了两份。
 * 更糟的是 D-115 §1 的判据（"目录里有没有 manifest"）**照样成立** ⇒ 扫描不报错，
 * 只是元信息取到哪一份变成不确定。把多出来的那份挪进归档，让这条不变量无条件成立。
 */
function evictStrayManifest(bookDir, bookName, movedDirName) {
  const stray = path.join(bookDir, movedDirName, MANIFEST_FILE);
  if (!fs.existsSync(stray)) return null;
  const dest = path.join(mergeArchiveDir(), `${stampOf()}-${movedDirName}-stray.json`);
  fs.renameSync(stray, dest);
  console.warn(`[box-service] ⚠ 归并 ${bookName}/${movedDirName} 时发现多出的 manifest.json，已归档到 ${dest}`);
  return dest;
}

/**
 * `POST /library/{name}/merge` —— 把「其它」里的未归并单话**物理移动**进某个大类，成为第 N 话。
 *
 * body：`{ targetBook, no }`。
 *
 * ## 前置校验（缺一即拒，且错误码必须可判定）
 *  ① 源必须存在                                                  → 404 TASK_NOT_FOUND
 *  ② 源必须是 `others`（**目录内无 `manifest.json`**）            → 409 ALREADY_MERGED
 *     这一条同时解决了"移动后大类里出现两份 manifest"这个更根本的问题：源本来就不可能是大类。
 *  ③ 源上不得有未终态任务（翻译中被搬走 = 写向不存在的路径）        → 409 MERGE_SOURCE_BUSY
 *  ④ 目标大类必须存在（有 manifest）                              → 404 TASK_NOT_FOUND
 *  ⑤ 目标话号未被占用（**目录名与 `episodes[].no` 双向都查**）     → 409 CHAPTER_NO_TAKEN
 *
 * ## 移动语义
 *  · **只改位置与名字，不删任何页文件**。`fs.renameSync` 而不是"复制 + 删源"：后者中途失败
 *    会留下半个目录，而源可能已被删 —— 不可逆。
 *  · 跨卷（`EXDEV`）**不做降级拷贝**，直接 409 让用户知道这本不能自动归并。
 *  · 移动前把源目录里的 `cover.*` 删掉：那份封面的语义属于"单话"，升格成整本封面属于语义篡改。
 *  · 移动后按**目录**重建目标大类的 `episodes[]`。
 *
 * ## 归并**不可逆**（本期不做"退回其它"，设计 R-06）
 * 所以前端确认弹窗的文案必须说清，且不做"撤销"承诺 —— 服务端这边也没有反向端点可调。
 */
async function handleLibraryMerge(req, res, cors, rawName) {
  const { name: srcName, dir: srcDir } = resolveComicDir(rawName);
  const { ok, value } = await readJsonBody(req);
  if (!ok) throw new ApiError('INVALID_BOOK_META', '请求体不是合法 JSON', { raw: 'unparsable' });
  const body = value && typeof value === 'object' ? value : {};
  const targetRaw = body.targetBook ?? body.book ?? body.target;
  const { name: targetName, dir: targetDir } = resolveBookDir(targetRaw);
  // 话号复用 `resolveChapterDir` 的同一套校验（那里管的是"寻址"，这里管的是"落位"，
  // 但"什么算合法话号"只能有一份定义，否则两边会漂移出 `/chapters/007/` 能读、归并却拒绝这类怪事）
  const { no, dirName: dstName } = resolveChapterDir(targetName, body.no);

  if (!fs.existsSync(srcDir)) {
    throw new ApiError('TASK_NOT_FOUND', '未归并单话目录不存在', { comicName: srcName, outputDir: srcDir });
  }
  if (hasManifest(srcDir)) {
    throw new ApiError('ALREADY_MERGED', `「${srcName}」已经是一本大类（目录内有 manifest.json），不能再次归并`,
      { comicName: srcName, outputDir: srcDir });
  }
  const busy = store.activeTasksForDir(srcName);
  if (busy.length > 0) {
    throw new ApiError('MERGE_SOURCE_BUSY',
      `「${srcName}」还有 ${busy.length} 个任务在跑（${busy.map((t) => t.status).join('、')}），请等它跑完或先取消`,
      { comicName: srcName, statuses: busy.map((t) => t.status), taskIds: busy.map((t) => t.taskId) });
  }
  const dst = path.join(targetDir, dstName);
  // ⑤ 双向查：目录名（位置）与 episodes[].no（说明文字）都要干净。只查一侧的话，
  //    手改过 episodes 的大类会出现"目录名不冲突、但 json 说这个话号已经有人了"的不一致状态。
  const takenNos = listChapterDirs(targetDir).map((c) => c.no);
  const declaredNos = readManifest(targetDir, targetName).episodes.map((e) => e.no);
  if (fs.existsSync(dst) || takenNos.includes(no) || declaredNos.includes(no)) {
    throw new ApiError('CHAPTER_NO_TAKEN', `《${targetName}》已经有第 ${no} 话了`,
      { targetBook: targetName, chapterNo: no, occupiedBy: fs.existsSync(dst) ? 'dir' : 'episodes' });
  }

  // 移动前清掉源目录里的封面（它属于"单话"，不该升格为整本封面）
  const removedCoverCount = removeCover(srcDir);
  try {
    await renameDirWithRetry(srcDir, dst);
  } catch (err) {
    if (isCrossDeviceError(err)) {
      throw new ApiError('MERGE_CROSS_DEVICE',
        '漫画库与目标目录不在同一个磁盘卷上，无法自动归并（请手动移动该目录）',
        { comicName: srcName, targetBook: targetName, chapterNo: no, reason: String(err.message || err) });
    }
    if (isBusyFsError(err)) {
      // 占用重试已耗尽（约 800ms）：把"500 服务内部错误"归因成用户能行动的 409（D-125）
      throw new ApiError('MERGE_SOURCE_LOCKED',
        `「${srcName}」正被其它程序占用（可能有页面还在预览、或资源管理器/杀毒正在扫描该目录），已自动重试仍失败，请稍候再试`,
        { comicName: srcName, targetBook: targetName, chapterNo: no, reason: String(err.message || err) });
    }
    throw err;
  }
  evictStrayManifest(targetDir, targetName, dstName);
  // 按目录重建 episodes[]（不做"读旧数组再合并"，理由见 library.mjs::episodesFromDirs）
  writeManifestAtomic(targetDir, {
    ...readManifest(targetDir, targetName), episodes: episodesFromDirs(targetDir),
  });
  sendJson(res, 200, {
    ...bookMetaView(targetName, targetDir),
    merged: {
      from: srcName, to: `${targetName}/${dstName}`, no, removedCoverCount,
    },
  }, cors);
}

// ---------------------------------------------------------------- 话级：续做 / 返工 / 取图

/** `GET /library/{book}/chapters/{no}/resume` —— 该话「有原图、缺译文」的页清单 */
function handleChapterResumePlan(req, res, cors, bookRaw, noRaw) {
  const { relDir } = mustChapterDir(bookRaw, noRaw);
  sendJson(res, 200, store.resumePlan(relDir), cors);
}

/** `GET /library/{book}/chapters/{no}/retranslate` —— 该话**所有有原图**的页（不止缺译文的） */
function handleChapterRetranslatePlan(req, res, cors, bookRaw, noRaw) {
  const { relDir } = mustChapterDir(bookRaw, noRaw);
  sendJson(res, 200, store.retranslatePlan(relDir), cors);
}

/**
 * 「再跑一次」族「**建任务**」四个 POST 端点的共用骨架。
 * 四者只差两件事 —— **目录怎么来**（`dirOf`）与**建哪类任务**（`build`）：
 *   · 话级（`POST …/chapters/{no}/resume|retranslate`）持相对路径 `<book>/NN_第N话`；
 *   · 漫画级（`POST /library/{name}/resume|retranslate`）持顶层目录名。
 *
 * 骨架里的顺序是契约的一部分，**不要重排**（换顺序会改错误优先级）：
 *   sidecar 就绪 → 解析目录（可能抛 404/400）→ 读选项 → 落盘可用性 → 建任务 → 201。
 */
function taskLauncher({ dirOf, build }) {
  return (req, res, cors, ...pathArgs) => readBody(req).then(async (body) => {
    await assertSidecarReady();
    const dir = dirOf(...pathArgs);
    const opts = readResumeOptions(body);
    assertRootWritable(); // §2.2 DISK_FULL(507)：请求级落盘不可用（续做/返工都要写盘）
    sendJson(res, 201, build(dir, opts, sourceOf(req)), cors);
  });
}

/** 续做回执：只有任务视图 */
const resumeView = (dir, opts, source) =>
  store.createView(store.createResumeTask(dir, { ...opts, source }).task);

/** 返工回执：任务视图 + 两个计数（"这会覆盖 N 张已有译文"—— 不可逆操作必须告知） */
const retranslateView = (dir, opts, source) => {
  const { task, plan } = store.createRetranslateTask(dir, { ...opts, source });
  return {
    ...store.createView(task),
    overwriteCount: plan.overwriteCount,
    retranslateCount: pickedCount(plan, opts.seqs),
  };
};

/**
 * `POST /library/{book}/chapters/{no}/resume` —— 话级续做，进入**同一条**串行队列。
 *
 * 与漫画级 `POST /library/{name}/resume` 只差"目录怎么来的"：那里是顶层目录名，
 * 这里是 `<book>/NN_第N话` 相对路径。`store.createResumeTask` 内部只做
 * `path.join(this.root, dirName)` ⇒ 传相对路径**一行都不用改**（这正是"dirName 存相对路径"
 * 的设计红利，别顺手改成绝对路径 —— 改了整个任务模型就绑死在当前 root 上）。
 */
const handleChapterResume = taskLauncher({
  dirOf: (bookRaw, noRaw) => mustChapterDir(bookRaw, noRaw).relDir,
  build: resumeView,
});

/** `POST /library/{book}/chapters/{no}/retranslate` —— 话级返工（覆盖该话已有译文） */
const handleChapterRetranslate = taskLauncher({
  dirOf: (bookRaw, noRaw) => mustChapterDir(bookRaw, noRaw).relDir,
  build: retranslateView,
});

/**
 * `POST /library/{book}/chapters/{no}/renumber` —— 编辑已归并话的话号（body: `{ no: 新话号 }`）。
 *
 * 实现 = **话目录改名**：`NN_第N话` → `MM_第M话`，随后 `episodesFromDirs` 按目录重建
 * `episodes[]` —— 目录即索引，改名本身就把 json 带对了，不存在"目录与数组各改各"的
 * 两处同步。话号校验复用 `resolveChapterDir` 的同一套（"什么算合法话号"只有一份定义）。
 *
 * 三道门（与归并同构，缺一道就是数据事故）：
 * ① 旧话必须存在（`mustChapterDir`，含 §8.2 安全校验）；
 * ② 该话没有未终态任务（翻译中改名 = 任务写向不存在的路径 → 409 `CHAPTER_SOURCE_BUSY`）；
 * ③ 新话号未被占用（目录名与 `episodes[].no` 双向查 → 409 `CHAPTER_NO_TAKEN`，同归并）。
 * 目录改名撞上 Windows 句柄占用时与归并同一套退避重试 + 409 `CHAPTER_SOURCE_LOCKED`（D-125）。
 */
async function handleChapterRenumber(req, res, cors, bookRaw, noRaw) {
  const oldInfo = mustChapterDir(bookRaw, noRaw);
  const { ok, value } = await readJsonBody(req);
  if (!ok) throw new ApiError('INVALID_BOOK_META', '请求体不是合法 JSON', { raw: 'unparsable' });
  const body = value && typeof value === 'object' ? value : {};
  const newInfo = resolveChapterDir(oldInfo.bookName, body.no);
  if (newInfo.dirName !== oldInfo.dirName) {
    const busy = store.activeTasksForDir(oldInfo.relDir);
    if (busy.length > 0) {
      throw new ApiError('CHAPTER_SOURCE_BUSY',
        `《${oldInfo.bookName}》第 ${oldInfo.no} 话还有 ${busy.length} 个任务在跑（${busy.map((t) => t.status).join('、')}），请等它跑完或先取消`,
        { bookName: oldInfo.bookName, from: oldInfo.no, to: newInfo.no, statuses: busy.map((t) => t.status), taskIds: busy.map((t) => t.taskId) });
    }
    const dst = path.join(oldInfo.bookDir, newInfo.dirName);
    // ③ 双向查（同归并）：目录名（位置）与 episodes[].no（说明文字）都要干净
    const takenNos = listChapterDirs(oldInfo.bookDir).map((c) => c.no);
    const declaredNos = readManifest(oldInfo.bookDir, oldInfo.bookName).episodes.map((e) => e.no);
    if (fs.existsSync(dst) || takenNos.includes(newInfo.no) || declaredNos.includes(newInfo.no)) {
      throw new ApiError('CHAPTER_NO_TAKEN', `《${oldInfo.bookName}》已经有第 ${newInfo.no} 话了`,
        { bookName: oldInfo.bookName, chapterNo: newInfo.no, occupiedBy: fs.existsSync(dst) ? 'dir' : 'episodes' });
    }
    try {
      await renameDirWithRetry(oldInfo.dir, dst);
    } catch (err) {
      if (isBusyFsError(err)) {
        // 占用重试已耗尽（≈800ms）：归因成用户能行动的 409，不再是 500（D-125 同款）
        throw new ApiError('CHAPTER_SOURCE_LOCKED',
          `《${oldInfo.bookName}》第 ${oldInfo.no} 话的目录正被其它程序占用（可能有页面还在预览、或资源管理器/杀毒正在扫描），已自动重试仍失败，请稍候再试`,
          { bookName: oldInfo.bookName, from: oldInfo.no, to: newInfo.no, reason: String(err.message || err) });
      }
      throw err;
    }
    writeManifestAtomic(oldInfo.bookDir, {
      ...readManifest(oldInfo.bookDir, oldInfo.bookName), episodes: episodesFromDirs(oldInfo.bookDir),
    });
  }
  sendJson(res, 200, {
    ...bookMetaView(oldInfo.bookName, oldInfo.bookDir),
    renumbered: { from: oldInfo.no, to: newInfo.no },
  }, cors);
}

/**
 * `GET /library/{book}/chapters/{no}/files/{seq}` —— 话内取图。
 *
 * `variant` 与漫画级 `files/{seq}` 同款（`translated` 默认 / `original`）。
 * 前端**必须**按「书 + 话 + 页 + variant」做缓存 key —— 只按页号缓存会让《A》第 1 话第 1 页
 * 与《B》第 1 话第 1 页命中同一条（跨书串图，且"看起来正常、内容错了"，最难发现的那类缺陷）。
 */
function handleChapterFile(req, res, cors, bookRaw, noRaw, seqText, url) {
  const info = mustChapterDir(bookRaw, noRaw);
  const seq = Number.parseInt(seqText, 10);
  if (!Number.isFinite(seq) || seq < 1 || seq > MAX_SEQ) {
    throw new ApiError('INVALID_IMAGE', `seq 必须是 1–${MAX_SEQ} 的整数`, { seq: seqText });
  }
  const variant = url.searchParams.get('variant') || 'translated';
  if (!['original', 'translated'].includes(variant)) {
    throw new ApiError('INVALID_IMAGE', 'variant 只能是 original 或 translated', { variant });
  }
  const name = findFile(info.dir, seq, variant);
  if (!name) {
    throw new ApiError('TASK_NOT_FOUND', '该话中找不到这一页', {
      bookName: info.bookName, chapterNo: info.no, seq, variant,
    });
  }
  sendImageBytes(res, cors, info.dir, name);
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
 * 从请求体读出 `{ seqs, lang }` —— `resume` 与 `retranslate`、漫画级与话级，**四条路共用**。
 *
 * 抽出来是因为入参校验必须逐字一致：两边各写一遍，"哪一条能收空数组 / 哪一条会静默吞掉
 * 拼错的 lang" 就会变成随时间漂移的知识，而漂移的那一条恰恰不会被任何断言碰到。
 * 空体与坏 JSON 都按"没给"处理（与既有行为一致：这两个端点本就允许无 body）。
 */
function readResumeOptions(body) {
  const out = { seqs: undefined, lang: undefined };
  if (!body || !body.length) return out;
  let parsedBody = null;
  try { parsedBody = JSON.parse(body.toString('utf8')); } catch { return out; /* 允许空体 */ }
  if (parsedBody && parsedBody.seqs !== undefined) {
    if (!Array.isArray(parsedBody.seqs)) {
      throw new ApiError('INVALID_IMAGE', 'seqs 必须是数组', { seqs: parsedBody.seqs });
    }
    out.seqs = parsedBody.seqs;
  }
  if (parsedBody && parsedBody.lang !== undefined) {
    out.lang = resolveTaskLang({ lang: parsedBody.lang });
  }
  return out;
}

/**
 * `POST /library/{comicName}/resume` —— 为缺译文的页补译文，进入**同一条**串行队列。
 *
 * body（可选）：`{ "seqs": [12, 13], "lang": {"from":"en","to":"zh"} }`；省略则续做全部缺页
 * 并落**默认方向**（日译中）。方向要给：续做是新建任务，没有"上一条任务"可继承
 *（见 `store.createResumeTask` 的注释）。
 * 单次上限沿用契约 §5.2 的 20 —— 续做同样是一次 ≤20 张的提交，只是字节来自磁盘。
 */
const handleResume = taskLauncher({
  dirOf: (rawName) => resolveComicDir(rawName).name,
  build: resumeView,
});

/**
 * `GET /library/{comicName}/retranslate` —— 返工计划：**所有有原图的页**
 * （**契约外增量端点**）。
 *
 * ## 为什么不能复用 `GET .../resume`
 * resume 给的是「有原图、**缺译文**」的页 —— 恰恰把"译错了的那几页"排除在外。
 * 译错的页**已经有译文**了，所以返工要的集合是「有原图」（不论译文在不在）。
 * 两者对同一部漫画给出的答案几乎不重叠，混淆会让返工按钮永远显示"没有可返工的页"。
 *
 * 顺带给 `overwriteCount`：前端要告诉用户"这会覆盖 N 张已有译文"，
 * 这是不可逆操作，不提示就等于替用户做决定。
 */
function handleRetranslatePlan(req, res, cors, rawName) {
  const { name } = resolveComicDir(rawName);
  sendJson(res, 200, store.retranslatePlan(name), cors);
}

/**
 * `POST /library/{comicName}/retranslate` —— 单张漫画**返工重译**（**契约外增量端点**）。
 *
 * body（可选）：`{ "seqs": [3, 7], "lang": {"from":"en","to":"zh"} }`；省略则返工该漫画全部有原图的页，
 * 并落**默认方向**（日译中）。方向要给 —— 返工同样是新建任务（同 resume 的理由）。
 *
 * ## 与 resume / retry 的三分（都叫"再跑一次"，语义各不相同）
 *  · resume     补**缺**的页，遇到已有译文跳过 ⇒ 可反复点，幂等。
 *  · retry      重跑**同一个任务**里**失败**的页，复用同一 taskId（队列行原地复活）。
 *  · retranslate 重跑**已译**的页（译错了要返工），**覆盖**译文，新建 taskId。
 *
 * 覆盖只发生在译文上；原图是用户数据，`_writeOriginal` 的「永不覆盖」原样保留。
 * 页数超 `BATCH_LIMIT` 报 `BATCH_LIMIT_EXCEEDED`（409），前端据此提示分批。
 */
const handleRetranslate = taskLauncher({
  dirOf: (rawName) => resolveComicDir(rawName).name,
  build: retranslateView,
});

/** 本次实际提交的页数（指定 seqs 时只算被选中的，用于回执不谎报） */
function pickedCount(plan, seqs) {
  if (!seqs || !seqs.length) return plan.retranslateCount;
  const want = new Set(seqs.map(Number));
  return plan.candidates.filter((c) => want.has(c.seq)).length;
}

// ------------------------------------------------------------------ 路由

function splitPath(pathname) {
  return pathname.split('/').filter((s) => s.length > 0).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

/**
 * `/library/{name}/{action}` 族的路由表（八条同形，D-159 收敛）。
 *
 * 为什么用**方法名引用**而不是 `run` lambda：这八条的同方法 handler **签名完全一致**
 * （都是 `(req, res, cors, rawName)`），直接引用最省，也不会多包一层闭包。
 * 方法缺席时（如 DELETE 打到 `meta`）由调用方抛 `miss()` —— 与原先"逐条 if + throw miss()"
 * 是同一条语义。
 *
 * 🔴 整族的位置约束（改位置前必读）：族内八条用 `p[2]` 字面量互相区分（**无序依赖**）；
 *    族与 `files`（4 段）/ `chapters`（≥5 段）用 `p.length` 区分。**双重区分 ⇒ 整族可以排在
 *    它们之后**。但必须仍排在 `/library/create`（2 段）之后 —— 那里靠 p.length 区分。
 */
const LIBRARY_NAME_ACTIONS = [
  { key: 'meta', GET: handleLibraryMeta, POST: handleLibraryMetaWrite },
  { key: 'cover', GET: handleLibraryCoverFile, POST: handleLibraryCover, DELETE: handleLibraryCoverDelete },
  { key: 'merge', POST: handleLibraryMerge },
  { key: 'reveal', POST: handleReveal },
  { key: 'delete', POST: handleLibraryDelete },
  { key: 'unhide', POST: handleLibraryUnhide },
  { key: 'retranslate', GET: handleRetranslatePlan, POST: handleRetranslate },
  { key: 'resume', GET: handleResumePlan, POST: handleResume },
];

async function route(req, res, cors, url) {
  const seg = splitPath(url.pathname);
  const method = req.method || 'GET';
  // 未命中端点的统一 404。原先这一行在下面逐字重复 12 次 —— 改一处必漏十一处，
  // 故收成一个具名动作（语义同为"这段路径没有对应端点"）。
  const miss = () => new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });

  // GET /health —— 唯一免鉴权
  if (seg.length === 3 && seg[0] === 'api' && seg[1] === API_VERSION && seg[2] === 'health' && method === 'GET') {
    return sendJson(res, 200, await healthView(), cors);
  }
  // 兼容 /api/v1 之外的健康探测
  if (seg.length === 1 && seg[0] === 'health' && method === 'GET') {
    return sendJson(res, 200, await healthView(), cors);
  }

  if (seg[0] !== 'api' || seg[1] !== API_VERSION) {
    throw miss();
  }
  const p = seg.slice(2);

  // /tasks
  if (p.length === 1 && p[0] === 'tasks') {
    if (method === 'POST') return handleCreateTask(req, res, cors);
    if (method === 'GET') return handleTaskList(req, res, cors, url);
    throw miss();
  }
  // /tasks/{taskId}
  if (p.length === 2 && p[0] === 'tasks') {
    // ⚠️ 必须在把 p[1] 当 taskId 之前拦下 `delete`：taskId 形状是 `tsk_…`，
    // 不会与这个保留字冲突，但顺序上先判更不易被后来的改动带歪。
    if (p[1] === 'delete' && method === 'POST') return handleDeleteTasks(req, res, cors);
    if (method === 'GET') return handleTaskDetail(req, res, cors, p[1], url);
    throw miss();
  }
  // /tasks/{taskId}/batches | events | cancel | retry
  if (p.length === 3 && p[0] === 'tasks') {
    if (p[2] === 'batches' && method === 'POST') return handleAppendBatch(req, res, cors, p[1]);
    if (p[2] === 'events' && method === 'GET') return handleSse(req, res, cors, p[1]);
    if (p[2] === 'cancel' && method === 'POST') return handleCancel(req, res, cors, p[1]);
    if (p[2] === 'retry' && method === 'POST') return handleRetry(req, res, cors, p[1]);
    throw miss();
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

  // /translate/text —— 在线翻译 · 普通文本（整体，方案 §6.3）
  if (p.length === 2 && p[0] === 'translate' && p[1] === 'text' && method === 'POST') {
    return handleTranslateText(req, res, cors);
  }
  // /translate/stream —— 在线翻译 · 大模型流式（POST + SSE 响应体）
  if (p.length === 2 && p[0] === 'translate' && p[1] === 'stream' && method === 'POST') {
    return handleTranslateStream(req, res, cors);
  }
  // /translate/options —— 平台能力 + 生效设置（含来源）+ 脱敏密钥视图
  if (p.length === 2 && p[0] === 'translate' && p[1] === 'options' && method === 'GET') {
    return handleTranslateOptions(req, res, cors);
  }
  // /translate/settings —— 非密钥设置补丁（白名单 strict）
  if (p.length === 2 && p[0] === 'translate' && p[1] === 'settings' && method === 'POST') {
    return handleTranslateSettings(req, res, cors);
  }
  // /translate/credentials —— 平台密钥，只写不读（secret 永不回显）
  if (p.length === 2 && p[0] === 'translate' && p[1] === 'credentials' && method === 'POST') {
    return handleTranslateCredentials(req, res, cors);
  }

  // /library
  if (p.length === 1 && p[0] === 'library' && method === 'GET') {
    return sendJson(res, 200, libraryView(), cors);
  }
  // /library/create —— 手动新建大类（同名 → 409）。⚠️ 与「名为 create 的大类」同形，
  // 但后者仍可经 `/library/create/meta` 等更长路径寻址（p.length 不同），不冲突。
  if (p.length === 2 && p[0] === 'library' && p[1] === 'create' && method === 'POST') {
    return handleLibraryCreate(req, res, cors);
  }
  // （`meta` / `cover` 两条已并入下方的 `LIBRARY_NAME_ACTIONS` 表 —— 与 merge/reveal/… 同形。）
  // /library/{comicName}/files/{seq}
  if (p.length === 4 && p[0] === 'library' && p[2] === 'files' && method === 'GET') {
    return handleLibraryFile(req, res, cors, p[1], p[3], url);
  }
  // /library/{book}/chapters/{no}/{resume|retranslate|files/{seq}} —— 话级寻址（D-117）
  // ⚠️ 必须排在 `/library/{comicName}/{action}` 那批之前吗？不必：批次之间用 p.length 区分
  //（这里最低 5 段，那批恒 3 段）。但三条 `chapters` 路由之间要先长后短，见下。
  if (p.length >= 5 && p[0] === 'library' && p[2] === 'chapters') {
    const bookRaw = p[1];
    const noRaw = p[3];
    if (p.length === 6 && p[4] === 'files' && method === 'GET') {
      return handleChapterFile(req, res, cors, bookRaw, noRaw, p[5], url);
    }
    if (p.length === 5 && p[4] === 'resume') {
      if (method === 'GET') return handleChapterResumePlan(req, res, cors, bookRaw, noRaw);
      if (method === 'POST') return handleChapterResume(req, res, cors, bookRaw, noRaw);
      throw miss();
    }
    if (p.length === 5 && p[4] === 'retranslate') {
      if (method === 'GET') return handleChapterRetranslatePlan(req, res, cors, bookRaw, noRaw);
      if (method === 'POST') return handleChapterRetranslate(req, res, cors, bookRaw, noRaw);
      throw miss();
    }
    if (p.length === 5 && p[4] === 'renumber' && method === 'POST') {
      return handleChapterRenumber(req, res, cors, bookRaw, noRaw);
    }
    throw miss();
  }
  // ── /library/{name}/{action} 族（八条同形，见表 `LIBRARY_NAME_ACTIONS`）────────────────
  // 新增漫画级动作：往表里加一行，**不要**再写一条 `if (p.length === 3 …)`。
  if (p.length === 3 && p[0] === 'library') {
    const row = LIBRARY_NAME_ACTIONS.find((r) => r.key === p[2]);
    if (row) {
      const fn = row[method];
      if (fn) return fn(req, res, cors, p[1]);
      throw miss(); // 路径命中但方法缺席（如 DELETE /library/x/meta）
    }
  }

  throw miss();
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

// 在线翻译门面注入（方案 §8）：两个盘上文件的路径由**本文件**给 —— 门面不 import config.mjs
//（与 engine-settings 同款防 ESM 环的理由，见 translate/settings.mjs 文件头的注释）。
// 注入一次，之后每次翻译调用门面都现读设置与密钥（方案 §8.4：改了下次调用即生效）。
configureTranslate({
  settingsFile: path.join(STATE_DIR, 'translate-settings.json'),
  credentialsFile: path.join(STATE_DIR, 'translate-credentials.json'),
});

// P-D4（ver2.2 已定稿）：翻译来源 = 在线 ⇒ 引擎不随开机拉起。在线用户整条链路走
// openapi.youdao.com，完全不需要 ③ 那份显存/内存；`llmAutostart` 从此只是"本地来源"的开关。
// source **现读**（configureTranslate 之后即可查）：settings 文件不存在 = 首次启动 = 默认
// local ⇒ 与接线前行为完全一致；只有用户显式把来源切成在线时才跳过拉起。
if (config.llmAutostart && currentTranslateSource() !== 'online') {
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
// P-D4 的可见指示：上面那行的 autostart 只是**配置**值；引擎这一程究竟拉没拉，还取决于
// 翻译来源。两行挨着放，"引擎没起"才有处可查（而不是让用户以为开机自启坏了）。
serverLog(`翻译来源   : ${currentTranslateSource()}（online ⇒ 引擎不随开机拉起，P-D4）`);
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

// 主动退出（信号）与被动崩溃（未捕获异常 / 未处理 rejection）**共用同一套收尾**：
// 三者都必须在退自己之前先把 ③ 收掉 —— 否则 8080 会短暂留给孤儿，而 E11 的外部观察者正是去抓它。
let shuttingDown = false;
function shutdown(reason, exitCode) {
  if (shuttingDown) return; // 信号与崩溃可能先后到达，只收尾一次
  shuttingDown = true;
  serverLog(`${reason}，关闭中…`);
  clearInterval(heartbeatTimer);
  idleWatcher?.stop();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    server.close(() => process.exit(exitCode));
    // 兜底：SSE 长连接可能让 close 回调迟迟不触发
    setTimeout(() => process.exit(exitCode), 500).unref();
  };
  // 加 finally 兜底：③ 的收尾失败不该让服务关不掉（Rust 侧超时后会 SIGKILL，反而更难诊断）。
  llm.stop({ reason, graceMs: 3000 }).catch(() => {}).finally(finish);
  // 二次兜底：LLM 收尾本身也可能卡住（进程僵死 → kill 无响应）
  setTimeout(finish, 6000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(`收到 ${sig}`, 0));
}

// 🔴 未捕获异常 / 未处理 rejection 的**顶层兜底**：本进程是 ①②③ 三个子进程的宿主，
//    Node ≥15 下未处理的 rejection 默认直接终止进程 —— 那就把子进程留成孤儿。
//    这里接住 → 记录 → 走同一套收尾 → 以**非零**码退出：既不丢故障（仍以 1 退），也不留孤儿。
process.on('unhandledRejection', (err) => {
  serverLog(`未处理的 Promise rejection（顶层兜底）：${err && err.stack ? err.stack : err}`);
  shutdown('未处理的 Promise rejection', 1);
});
process.on('uncaughtException', (err) => {
  serverLog(`未捕获异常（顶层兜底）：${err && err.stack ? err.stack : err}`);
  shutdown('未捕获异常', 1);
});
