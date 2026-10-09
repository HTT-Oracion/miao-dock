// 运行期配置与安全路径工具
// 仅使用 node:* 内置模块，零第三方依赖。
//
// 来源说明：本文件与同目录其余模块**派生自** `miao-trans/mock-service`（插件端 e2e 的测试替身），
// 与之同源同契约。本目录是**真实服务**：固定令牌 → CSPRNG 落 0600；.runtime 目录 → 契约 §7.1/§7.5
// 规定的用户目录；伪造译文 → 真实调用 sidecar 引擎（见 engine-client.mjs）。
// 配套 e2e 依赖 mock-service 的固定行为，因此那份实现保持原样不动。
//
// 契约依据：§1 服务拓扑、§2.1 鉴权与令牌存储、§7 落盘、§8 安全
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ENGINE_SETTINGS_KEYS, envVisionTtlSec, mergeWithEnv, readEngineSettings,
} from './settings/engine-settings.mjs';

export const SERVICE_NAME = 'box-service';
export const SERVICE_VERSION = '1.2.0';
export const API_VERSION = 'v1';
export const BASE_PATH = '/api/v1';

export const PORT_RANGE_START = 5180;
export const PORT_RANGE_END = 5190;

// 单次提交上限（契约 §3）
export const BATCH_LIMIT = 20;
// 序号上限（契约 §7.2）
export const MAX_SEQ = 999;
// eta 采样窗口：近 N 张已完成 item 的耗时
export const ETA_SAMPLE_WINDOW = 20;

/**
 * 引擎协议（`MIAO_ENGINE_PROTOCOL`，见 config.engineProtocol 处注释）。
 * **默认 `real`** —— 生产走真实引擎；测试显式声明 `mock`。
 */
const ENGINE_PROTOCOLS = new Set(['real', 'mock']);
const ENGINE_PROTOCOL = envEnum('MIAO_ENGINE_PROTOCOL', ENGINE_PROTOCOLS, 'real');

/**
 * 单次引擎请求 / 单项总预算的**共同默认值**（按协议分）。
 * 提成常量而不是写两遍：`engineTimeoutMs` 与 `itemTimeoutMs` 必须是同一个量级，
 * 两处各写一份 `600_000` 迟早会漂移成"预算比单次超时还短"这种自相矛盾的配置。
 */
const ENGINE_TIMEOUT_DEFAULT = ENGINE_PROTOCOL === 'real' ? 600_000 : 60_000;

/**
 * 单张请求超时的**实际值**（默认值 + `MIAO_ENGINE_TIMEOUT_MS` 覆盖）。
 *
 * 🔴 为什么提成常量而不是在 config 对象里写一遍：`itemTimeoutMs` 必须**跟着它走**
 * （见下方 `itemTimeoutMs` 的注释）。两者各写一份默认值会漂移出一种自相矛盾的配置
 * —— A20 用例把单张超时覆盖成 700ms，而单项预算仍是 mock 默认的 60s：
 * 一次「只连不答」就吃掉整个预算的 60s，重试的语义还在，但**最坏静默**从
 * 「一张的量级」悄悄变成「整个预算」，脚本的 60s 等待活不过它。
 * （`envInt` 是函数声明，模块作用域内提升 —— 与上面 `envEnum` 同理。）
 */
const ENGINE_TIMEOUT_MS = envInt('MIAO_ENGINE_TIMEOUT_MS', ENGINE_TIMEOUT_DEFAULT);

const SRC_DIR = import.meta.dirname; // .../service/src
export const PKG_DIR = path.resolve(SRC_DIR, '..'); // .../service

/**
 * 仓库根 —— `engine/` `service/` `app/` 都在它下面。
 *
 * 🔴 由 `config.mjs` 给出**唯一答案**，而不是让各模块各自 `path.resolve(import.meta.dirname, '..', '..')`。
 *    后者把「仓库根」绑在了**调用方自己的层级**上：模块一旦被搬进子目录（ver2.2 的
 *    `service/src/settings/` `manga/` 分区），dots 数不变但根少了一级 —— 症状是「某个子进程
 *    起不来」这类离根因极远的报错（本次 ver2.2 拆分即踩：③ LLM 的 `child-watch` 路径被算成
 *    `service/engine/scripts/…` ⇒ `MODULE_NOT_FOUND` ⇒ 翻译阶段连着 `Connection error`）。
 *    `config.mjs` 是**永不需要搬动**的跨模块底座 ⇒ 把根锚在它身上，搬谁都不会算错。
 */
export const REPO_ROOT = path.resolve(SRC_DIR, '..', '..');

function envInt(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function envBool(name, def = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

/**
 * 「**没设**返回 null」的整数环境变量。
 *
 * 与 `envInt` 的区别是那句"没设"：`envInt` 读不出来就用默认值，于是**无法区分**
 * 「用户没配」与「用户配了但配错了」。而下面这些阈值要做"env → 用户设置文件 → 出厂默认"
 * 的三级回退 —— 若这里也静默回退，`MIAO_ENGINE_MODELS_TTL=abc` 会悄悄落到用户配置上，
 * 表现为"我明明关了空闲卸载，它还是卸"（或反过来）。
 */
function envIntOrNull(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} 取值非法：${JSON.stringify(raw)}（应为 ≥0 的整数）`);
  }
  return n;
}

/**
 * S6 契约面反证开关（与 `contractRefute` 同族，见那处注释）。
 *
 * 🔴 只被 `e2e/service/engine-settings-check.mjs --refute` 设置；产品路径永不设置。
 * 集中一处（不散在用它各自的代码旁）的理由与 S5 那次相同：散着放的下场是
 * 「反证跑绿了，但没人说得清它到底关掉了什么」。
 *
 * ⚠️ 必须在 `readIdleSettings()` **之前**求值：那个函数要用 `envLast`
 *   （否则会出现 "Cannot access 'config' before initialization"）。
 */
const SETTINGS_REFUTE = {
  /** 写路径不再校验白名单 ⇒ 未知键被**静默丢弃**（`S1` 应红） */
  noWhitelist: envBool('MIAO_SETTINGS_NO_WHITELIST'),
  /** 合并优先级倒过来（文件压 env）⇒ 「env 优先」不可见（`R2` 应红） */
  envLast: envBool('MIAO_SETTINGS_ENV_LAST'),
  /** 加速后端候选不再按硬件筛 ⇒ Metal 机上出现 CUDA（`G5`/`S5` 应红） */
  accelOpen: envBool('MIAO_SETTINGS_ACCEL_OPEN'),
  /** 档位候选不再按内存可行性筛 ⇒ 16GB Mac 上出现 Medium（`G3`/`S4` 应红） */
  tierAll: envBool('MIAO_SETTINGS_TIER_ALL'),
  /**
   * 模型下载的**单飞守卫**被摘掉 ⇒ 并发第二个请求不再 409（`D3` 应红）。
   *
   * 为什么这条需要反证：单飞守卫的失效形态是"看起来更宽容了"（第二次点击也返回 200），
   * 不打开这个开关就没法证明 `D3` 咬的确实是守卫本身，而不是"恰好第一次还没进 running"。
   */
  downloadOpen: envBool('MIAO_SETTINGS_DOWNLOAD_OPEN'),
};

/**
 * 枚举型环境变量：**取值非法直接抛错，不静默回退**。
 *
 * 为什么不用 envBool 那套"读不出来就用默认"：协议这种开关一旦静默回退，
 * 「以为在测 mock、其实走了 real」（或反过来）就会变成最难查的假绿
 * —— 断言全绿而测的是另一个东西（AGENTS.md §2-3）。
 */
function envEnum(name, allowed, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const value = String(raw).trim().toLowerCase();
  if (!allowed.has(value)) {
    throw new Error(`${name} 取值非法：${JSON.stringify(raw)}（可选：${[...allowed].join(' | ')}）`);
  }
  return value;
}

/** 解析 MIAO_FAIL_SEQ=3,5 形式的 seq 列表 */
export function parseSeqList(raw) {
  const out = new Set();
  if (!raw) return out;
  for (const piece of String(raw).split(',')) {
    const n = Number.parseInt(piece.trim(), 10);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return out;
}

// ------------------------------------------------------------------ 目录（契约 §2.1 / §7.1 / §7.5）

/**
 * 契约 §7.5 明确「任务清单**不放漫画目录内**」，位置固定为平台应用数据目录。
 * 注：契约原文写的产品目录名是 `Box`；本迭代遵循契约原文不改名（见 docs/spec-notes.md G-04）。
 */
function defaultStateDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Box', 'state');
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'Box', 'state');
  }
  return path.join(os.homedir(), '.local', 'share', 'Box', 'state');
}

/** 契约 §7.1：macOS `~/Pictures/Box 漫画/`；Windows `%USERPROFILE%\Pictures\Box 漫画\` */
function defaultRootDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.USERPROFILE || os.homedir(), 'Pictures', 'Box 漫画');
  }
  return path.join(os.homedir(), 'Pictures', 'Box 漫画');
}

/**
 * 引擎 venv 里的 Python 解释器默认路径。
 *
 * 🔴 **venv 布局按平台分叉**：POSIX 是 `venv/bin/python`，Windows 是 `venv/Scripts/python.exe`。
 *    写死其中一个会让另一平台的引擎**起不来**，而且症状是"python 找不到"这种离根因极远的报错
 *    （`resolveEngineLaunch` 会拼出一条指向不存在文件的命令）。`MIAO_ENGINE_PYTHON` 可覆盖。
 */
function defaultEnginePython() {
  const venv = path.resolve(PKG_DIR, '..', 'runtimes', 'manga-translator', 'venv');
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
}

export const STATE_DIR = path.resolve(process.env.MIAO_STATE_DIR || defaultStateDir());
export const TASKS_STATE_DIR = path.join(STATE_DIR, 'tasks');
export const IDEMPOTENCY_FILE = path.join(STATE_DIR, 'idempotency.json');
export const TOKEN_FILE = path.join(STATE_DIR, 'token');

/**
 * 用户可调引擎设置的落盘位置（`state/engine-settings.json`）。
 *
 * 放 `STATE_DIR` 而不是漫画目录：与 `token` / `idempotency.json` 同一套理由
 * （契约 §7.5 —— 「不放漫画目录内，否则会被库扫描误读为用户内容」）。
 */
export const ENGINE_SETTINGS_FILE = path.join(STATE_DIR, 'engine-settings.json');

/**
 * 「已从漫画库隐藏」的漫画名清单（`state/hidden-comics.json`）。
 *
 * 场景：用户在漫画库删一部漫画时，弹窗里「是否删除本地文件」**不勾选** ⇒ 只把这部
 * 从库里**隐藏**（磁盘文件原样保留），扫描时跳过它；勾选则连目录一起删。
 *
 * 为什么是「额外一份清单」而不是像其它地方那样「目录即索引」：这里要表达的恰恰是
 * **「目录还在、但用户不想看到它」** —— 这件事在文件系统里无法自证，只能记下来。
 * 放 `STATE_DIR` 而不放漫画目录：同 `token` / `idempotency.json` 的理由
 * （契约 §7.5 —— 放进漫画目录会被库扫描误读为用户内容）。
 */
export const HIDDEN_COMICS_FILE = path.join(STATE_DIR, 'hidden-comics.json');

/**
 * 「盘上的用户设置」+「环境变量」合并后的**生效设置**（`engine-settings.mjs` 的唯一调用点）。
 *
 * 🔴 这里是「谁说了算」的**唯一一处**实现。`print-launch-plan.mjs` 通过 import 本文件
 *    自动拿到同一份合并结果 —— 它不需要知道设置文件在哪，也就没有第二处可以走散。
 *
 * ⚠️ 读盘**不写盘**：坏文件只是被标记成 `corrupt`（`readEngineSettings` 里原地保留），
 *    这里的处置是**喊一声然后退回默认**。为什么不"顺手删掉那个坏文件"：
 *    本文件被所有只读脚手架（打印配方、各验收脚本）在模块顶层 import，
 *    在顶层做**破坏性文件操作**会让"跑一条只读命令"变成一次不可预期的数据变更。
 */
const ENGINE_SETTINGS_READ = readEngineSettings({ file: ENGINE_SETTINGS_FILE });
const ENGINE_SETTINGS_MERGED = mergeWithEnv({
  env: process.env,
  fileSettings: ENGINE_SETTINGS_READ.settings,
  envLast: SETTINGS_REFUTE.envLast,
});

/** 生效的引擎设置（已含 env 覆盖） */
export const engineSettings = ENGINE_SETTINGS_MERGED.settings;

/**
 * 生效设置的**来源**（`env` / `file`）—— 给 `/engine/options` 回答"这个值谁定的"。
 * 一个用户改不动的控件，若界面上不说清是谁压着它，用户只会以为坏了。
 */
export const engineSettingSources = ENGINE_SETTINGS_MERGED.sources;

/** 设置文件本身的状态（路径 / 是否坏 / 坏在哪 / 解析时丢弃了什么）—— 诊断视图要显示 */
export const engineSettingsFile = {
  path: ENGINE_SETTINGS_FILE,
  keys: [...ENGINE_SETTINGS_KEYS],
  exists: ENGINE_SETTINGS_READ.exists,
  corrupt: ENGINE_SETTINGS_READ.corrupt,
  reason: ENGINE_SETTINGS_READ.reason,
  ignoredKeys: ENGINE_SETTINGS_READ.unknownKeys,
  invalidValues: ENGINE_SETTINGS_READ.invalid,
};

if (ENGINE_SETTINGS_READ.corrupt) {
  // ⚠️ 只喊不删（理由见上）。这句话必须显眼：否则用户看到的是"我的设置全没了"，却查不出为什么。
  console.warn(`[box-service] ⚠ 引擎设置文件损坏，已退回默认值（文件原地保留）：`
    + `${ENGINE_SETTINGS_FILE} —— ${ENGINE_SETTINGS_READ.reason}`);
}

/**
 * 上传字节的**暂存区**（G-12，用户裁定 B，2026-10-03）。
 *
 * 为什么必须有这么个东西：上传的原图原先只活在服务进程的内存里（`store.blobs`），
 * 进程一崩就全丢 —— 未落盘的页永久不可恢复。而它**不能**放在漫画目录里：
 * 《02》§4.3 + 契约 §4.1 明令「未开始的 item 原图不落盘」（取消不得留下残缺目录）。
 * 于是只剩下「漫画目录之外的某处」，也就是这里 —— 与契约 §7.5 把任务清单
 * 放在 state 区（理由：「不放漫画目录内，否则会被库扫描误读为用户内容」）是同一套道理。
 */
export const PENDING_DIR = path.join(STATE_DIR, 'pending');

/**
 * 落盘根目录（契约 §7.1 默认值，可在设置中修改）。
 * 支持 `MIAO_ROOT` 覆盖——用于验收与自动化测试，避免写用户真实图片目录（见 spec-notes D-10）。
 */
export const ROOT_DIR = path.resolve(process.env.MIAO_ROOT || defaultRootDir());

/** 引擎源码根（`src/`）。`engineServerDir` 由它派生，避免 `MIAO_ENGINE_DIR` 覆盖后两者走散。 */
const ENGINE_DIR = process.env.MIAO_ENGINE_DIR
  || path.resolve(PKG_DIR, '..', 'runtimes', 'manga-translator', 'src');

// ------------------------------------------------------------------ 令牌（契约 §2.1）

/**
 * 令牌：32 字节 CSPRNG 的 hex（共 64 字符），持久化于 `state/token`，权限 0600。
 * 首次启动生成；`MIAO_TOKEN` 可覆盖（验收用固定令牌，省去每次读取）。
 */
export function ensureToken() {
  const override = process.env.MIAO_TOKEN;
  if (override) return override;

  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(existing)) {
      // 权限可能被外部改过，每次启动校正回 0600
      try { fs.chmodSync(TOKEN_FILE, 0o600); } catch { /* ignore */ }
      return existing;
    }
  } catch { /* 首次启动无文件 */ }

  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

/**
 * 两级空闲卸载阈值的**唯一**求解处（可反复调用）。
 *
 * 抽成函数而不是就地在顶层算成两个 const，是因为 S6 起「空闲卸载 LLM」能在设置页改
 * 且**改完立刻生效** ⇒ 写完盘必须能**重算一次**。若顶层是 const、另写一份重算逻辑，
 * 两份逻辑就会走散（改了一处忘另一处），而它们的失败形态尤其恶劣：
 * 界面显示 5 分钟、看护实际按 30 分钟走 —— 两边都不报错。
 *
 * 回退链（三级，env 优先）：
 *   Tier1 `llmMs` ：`MIAO_IDLE_LLM_MS`（毫秒，夹具要秒级短回路）
 *                   → `MIAO_IDLE_LLM_MIN` → 文件 `idleLlmMin` → 出厂 5 min
 *   Tier2 `visionSec`：`MIAO_ENGINE_MODELS_TTL`（**秒**，历史单位）
 *                   → 文件 `idleVisionMin` → 出厂 1800 s（30 min）
 *
 * @returns {{llmMs:number, visionSec:number, settings:object, sources:object}}
 */
export function readIdleSettings() {
  const fresh = readEngineSettings({ file: ENGINE_SETTINGS_FILE });
  const merged = mergeWithEnv({
    env: process.env,
    fileSettings: fresh.settings,
    envLast: SETTINGS_REFUTE.envLast,
  });

  const llmMs = envIntOrNull('MIAO_IDLE_LLM_MS')
    ?? (merged.settings.idleLlmMin === undefined ? 5 * 60_000 : merged.settings.idleLlmMin * 60_000);

  const sec = envVisionTtlSec(process.env);
  const visionSec = sec !== null
    ? sec
    : (merged.settings.idleVisionMin === undefined ? 1800 : merged.settings.idleVisionMin * 60);

  return { llmMs, visionSec, settings: merged.settings, sources: merged.sources };
}

const IDLE = readIdleSettings();

/**
 * Tier2 空闲卸载阈值（**秒**）—— 引擎 `--models-ttl` 与设置页「空闲卸载视觉」**同一个数字**。
 * 抬到对象外，是为了让 `engineModelsTtl`（秒，发给引擎）与 `idleVisionMs`（毫秒，对外展示）
 * 由**同一处**派生，而不是抄两遍（抄两遍就是在等它们走散）。
 */
const ENGINE_MODELS_TTL_SEC = IDLE.visionSec;

/**
 * Tier1 空闲卸载阈值（《04》§9.1：停 ③ Sakura LLM，默认 5 min）。
 * **实现方 = box-service 自己**（③ 不在引擎 TTL 范围内）⇒ 这个阈值只有 box-service 认。
 */
const IDLE_LLM_MS = IDLE.llmMs;

/**
 * 「从不卸载」（《04》§9.3 末句：「用户配置『从不卸载』→ 两级都关闭」）。
 *
 * 🔴 它必须**同时**关掉两级，而不是只关 box-service 那一级：
 *   · Tier1（③ LLM）由 box-service 自己决定，看 `config.unloadNever`；
 *   · Tier2（视觉模型）由**引擎自带**的 `--models-ttl` 决定 —— 所以这里必须把秒数**归零**，
 *     连参数都不发（`resolveEngineLaunch` 对 `modelsTtl > 0` 才 push）。
 *   只关一级的后果很隐蔽：UI 上写着「从不卸载」，引擎却仍会在 30 min 后把模型丢掉。
 *
 * ⚠️ 两个来源取**或**，不是二选一：
 *   · `MIAO_IDLE_LLM_MS=0` —— 《02》§5 把这一项写成**阈值 0**（设置页是「数字（分钟）」，0 = 从不卸载），
 *     这是**产品口径**，S6 的界面走的就是它；
 *   · `MIAO_UNLOAD_NEVER=1` —— 显式开关，给脚本/验收用（"把阈值填 0"在命令行里读起来像笔误）。
 */
const UNLOAD_NEVER = IDLE_LLM_MS === 0 || envBool('MIAO_UNLOAD_NEVER');

export const config = {
  token: ensureToken(),
  // 显式指定端口时不再探测（被占则启动失败）
  explicitPort: process.env.MIAO_PORT ? envInt('MIAO_PORT', PORT_RANGE_START) : null,
  portStart: PORT_RANGE_START,
  portEnd: PORT_RANGE_END,

  // 失败注入：用于覆盖 failed / partial_failed / 重试路径（真实引擎另有自己的注入开关）
  failSeqs: parseSeqList(process.env.MIAO_FAIL_SEQ),
  itemFailRate: Math.max(0, Math.min(1, Number(process.env.MIAO_ITEM_FAIL_RATE || 0) || 0)),
  // 契约 §5.7：服务端不确定时 eta 返回 null（UI 必须显示不定态，不得显示任何数字）
  etaNull: envBool('MIAO_ETA_NULL'),

  // 幂等续做是**标准语义**（§4.2 / §7.4），不是可选开关 → 默认开启。
  // 只有显式 MIAO_SKIP_EXISTING=0 才关闭（关掉后保留旧的 EEXIST 行为，用于反向演练）。
  skipExisting: envBool('MIAO_SKIP_EXISTING', true),
  // 模拟 sidecar 未就绪 → /health 返回 degraded（覆盖画面 X-C3）
  sidecarDown: envBool('MIAO_SIDECAR_DOWN'),
  // 强制落盘失败，用于验证 saved:false / DISK_FULL 路径
  diskFull: envBool('MIAO_DISK_FULL'),

  // ---------------------------------------------------------------- 引擎（sidecar）
  //
  // 协议（docs/spec-notes.md D-62）：
  //   real —— 真实 manga-image-translator（`python main.py`，FastAPI `/translate/image`）
  //   mock —— 仓内模拟引擎（`engine/src/server.mjs`，ver1.0 起沿用的测试替身）
  // **默认 real**：生产必须走真实引擎；测试起的是模拟引擎，就显式声明 mock（诚实标注，
  // 不是"忘记切换"）。适配层内部按此分支，见 engine-client.mjs。
  engineProtocol: ENGINE_PROTOCOL,
  // 引擎端口**按协议分开**（同一个数字套两种引擎是错的）：
  //   mock —— 5003（ver1.0 起的水位，模拟引擎还在此起连续 8 个端口里挑）
  //   real —— 8000（uvicorn 默认水位；执行器固定占 port+1，见 `resolveEngineLaunch`）
  enginePort: envInt('MIAO_ENGINE_PORT', ENGINE_PROTOCOL === 'real' ? 8000 : 5003),
  engineHost: '127.0.0.1',

  // 单张翻译超时。**按协议给不同默认值**（同一个数字套两种引擎是错的）：
  //   real —— 10 min。依据：M1/G1 实测 CPU 单张 1.6 min（模型已加载，`out-first`）；
  //           首张还要叠加模型到设备的加载（《04》§5.3「首图惰性初始化」是常态）。
  //           10 min ≈ 6× 余量；S7 用实测首张耗时校准（未校准前宁可等，不可错杀）。
  //   mock —— 60 s（原值不变；A20 用例注入 700ms 覆盖）。
  engineTimeoutMs: ENGINE_TIMEOUT_MS,
  // **单图总预算（含重试）**。为什么要与上面那个分开：
  //   `engineTimeoutMs` 管的是「一次请求多久算没响应」，而**重试会把静默成倍放大**。
  //   U10② 实测：引擎挂住时 = 600 s（首次超时）+ 600 s（重试）= **20 分钟完全静默**，
  //   而中途不写任何状态、不打任何日志 ⇒ 从外面看与"引擎在慢慢想"完全一样，
  //   连测试脚本的 15 分钟等待都活不过它（`failed:0`、磁盘无变化，看着像任务没跑）。
  // 语义：整项的时间预算，**重试只能吃剩下的时间**（`store._processItem` 的 `deadline`）。
  //   于是单项最坏 = 一次单张超时（而不是它的 N 倍），而「重试 N 次」的语义不变：
  //   只有**快速失败**（几毫秒就回错的引擎错误）才留得下重试的余量。
  // 默认 = `engineTimeoutMs` 的实际值（**含 `MIAO_ENGINE_TIMEOUT_MS` 的覆盖**）：
  //   那个数字的余量论证（6× 单张实测耗时）本来就是按"整项"给的。跟着覆盖走是必须的
  //   —— 测试把单张超时降到 700ms 时，预算要是还停在 60s，用例就得等 60s 才看得到终态。
  itemTimeoutMs: envInt('MIAO_ITEM_TIMEOUT_MS', ENGINE_TIMEOUT_MS),
  // 探测超时（TCP 握手 / HTTP 探测）——**必须与单张超时分开**：探测不能等 10 分钟，
  // 否则每次 /health 都卡死；而单张超时也不能缩到探测量级，否则真推理必被错杀。
  engineProbeMs: envInt('MIAO_ENGINE_PROBE_MS', 800),

  // 每次请求注入给真实引擎的 Config（《04》§4.2「参数基线」）。
  // 🔴 注意：服务端**没有 `--config-file`**（实测 `server/args.py` 无此参数，与《04》§4.2/§4.3 的
  // 示意不符）⇒ 策略改为**按请求**经 `TranslateRequest.config` 注入（`request_extraction.py:18-23`）。
  // 取值 = M1/G1 实测通过的那份（`runtimes/manga-translator/sakura-chs.config.json`），
  // **不写文档示意值**——实测值才是证据（AGENTS.md §2-2）。
  engineConfig: {
    translator: {
      translator: process.env.MIAO_ENGINE_TRANSLATOR || 'sakura',
      target_lang: process.env.MIAO_ENGINE_TARGET_LANG || 'CHS',
    },
    detector: {
      detector: process.env.MIAO_ENGINE_DETECTOR || 'default',
      // 只在**显式配置时**才下发 `detection_size`。
      // 🔴 「不下发」与「下发 2048」不是一回事：前者用引擎自己的默认值（上游改默认时会跟着变），
      //    后者把当前默认值**钉死**在我们的请求体里（上游改了也不知道）。
      //    `/engine/status` 的 `config.detectionSize` 因此要在两种情况下报不同的东西 ——
      //    见 `engine-client.mjs` 的 `engineConfigSnapshot()`。
      ...(process.env.MIAO_ENGINE_DETECTION_SIZE
        ? { detection_size: Number(process.env.MIAO_ENGINE_DETECTION_SIZE) }
        : {}),
    },
    inpainter: { inpainter: process.env.MIAO_ENGINE_INPAINTER || 'lama_large' },
    ocr: { ocr: process.env.MIAO_ENGINE_OCR || '48px' },
  },

  // 启动参数拼装用（S2 的 ServiceManager 消费；S1 只做纯函数 + 断言）。
  // 路径是**开发态布局**（G-13 打包分发未做，见 spec-notes）。可用 env 覆盖。
  engineDir: ENGINE_DIR,
  // 🔴 引擎主进程的 cwd 必须是 `src/server`（不是 `src/`）—— `main.py` 的
  // `if __name__ == '__main__':` 块里是 `from args import parse_arguments`（**平级相对导入**），
  // 只有 `python main.py`（脚本目录进 `sys.path[0]`）才找得到；`python -m server.main`
  // 会以 `ModuleNotFoundError: No module named 'args'` 退出（实测，见台账 D-62）。
  // 上游 README 写的也是 `$ python main.py --use-gpu`。
  engineServerDir: process.env.MIAO_ENGINE_SERVER_DIR || path.join(ENGINE_DIR, 'server'),
  enginePython: process.env.MIAO_ENGINE_PYTHON || defaultEnginePython(),
  // 模型根目录（`models/` 的父目录）。三级回退（S6）：
  //   `MIAO_MODEL_ROOT`（env）→ 设置文件 `modelDir` → 引擎源码树上一级（= `runtimes/manga-translator/`）
  // ⚠️ 与 `engine/scripts/fetch-models.mjs` 的 `ROOT` 必须**同源**：那个脚本自己读
  //    `process.env.MIAO_MODEL_ROOT`，所以下发给它的时候要**显式带 env**（见 server.mjs 的
  //    校验端点），否则会出现"服务读 A 目录、校验脚本读 B 目录"——而两边都会报成功。
  engineModelDir: path.resolve(
    engineSettings.modelDir || path.resolve(ENGINE_DIR, '..'),
  ),
  // Tier 2 空闲卸载（《04》§9.1）：引擎自带 `--models-ttl 1800`（30 min）。
  // 「从不卸载」⇒ 归零，`resolveEngineLaunch` 便不再下发该参数（见 UNLOAD_NEVER 处注释）。
  engineModelsTtl: UNLOAD_NEVER ? 0 : ENGINE_MODELS_TTL_SEC,
  // nonce：用于「引擎主进程 ↔ 执行器」与 `/register` 的鉴权。
  // 🔴 **必须是字符串 `"None"`（默认值）**，不是"没设"：
  //    ① `manga_translator/mode/share.py:52-57` 只在 `params['nonce'] == "None"` 时把它转成
  //       Python `None` ⇒ `if self.nonce:` 为假 ⇒ **跳过校验**；传空串反而会**生成随机 nonce**。
  //    ② 而主进程侧 `server/sent_data_internal.py:24-36` 调执行器时**从不带 `X-Nonce` 头**
  //       ⇒ 只要执行器 nonce 非空，这张图**必然** 401 `Nonce does not match`（实测）。
  //    ⇒ 这版上游里「开启 nonce」与「单图翻译可用」互斥。代价是把引擎的访问控制降级为
  //      **只监听 127.0.0.1**（`--host` 固定本机），不用 nonce 兜底。S2/S4 若要恢复 nonce，
  //      需给上游打补丁或在适配层前加一层仅本机可访问的代理。
  //    ⚠️ 覆盖成别的值 = 功能必坏（保留此开关只为上游修好后复用）。
  engineNonce: process.env.MIAO_ENGINE_NONCE || 'None',
  // ---------------------------------------------------------------- 档位与空闲卸载（S4 / S6）
  //
  // 生效档位（《04》§7.2 / §8.3）。`null` = **按硬件探测推荐**（`engine-profile.mjs` 的
  // `mapTier`），只有用户在设置页显式改过才非 null —— 这样"换了台机器"不会被一份陈旧的
  // 写死值覆盖（§8.3：降档只在本运行期有效，关闭后回到用户配置档位）。
  // 取值非法**启动即抛错**（`mergeWithEnv` 的既定行为，不静默回退）。
  // S6：来源从"MIAO_ENGINE_TIER 一个"扩成"env → 设置文件 → 硬件探测"三级（见 engineSettings）。
  engineTier: engineSettings.tier ?? null,
  // 加速后端（《02》§5：下拉「自动 / CUDA / MPS / CPU」，默认自动）。
  // `auto` = 按《04》§7.4 顺序探测（= `engine-profile.mjs` 的 `detectAccel`）。
  engineAccel: engineSettings.accel ?? 'auto',
  // 这一组里真正被引擎消费的那个布尔量（`resolveEngineLaunch` 按它决定加不加 `--use-gpu`）。
  // 🔴 两个来源取**与**，不是二选一：
  //    · `accel === 'cpu'` —— 用户在界面上明确选了 CPU（设置页）；
  //    · `MIAO_ENGINE_USE_GPU=0` —— S4 起就存在的注入开关，验收用它造"GPU 回退 CPU"现场
  //      （`contract-delta-check` 的实例 D、以及 Rust 侧检测到 GPU 启动失败后的重拉）。
  //    只认其中一边，都会让另一边"设置了却没用"，而那正是最难查的一类。
  engineUseGpu: engineSettings.accel === 'cpu' ? false : envBool('MIAO_ENGINE_USE_GPU', true),
  // Tier1 空闲卸载阈值（定义与「从不卸载」的口径见 `IDLE_LLM_MS` / `UNLOAD_NEVER` 处）
  idleLlmMs: IDLE_LLM_MS,
  // 空闲看护的**巡检周期**（不是策略，是"多久看一眼"）。默认 5s：相对 5 min 的阈值而言
  // 误差可忽略，而对 CPU 完全无感（一次纯判定）。验收夹具把它压到 250ms，好让
  // "到点卸载"落在秒级 —— 与 `MIAO_IDLE_LLM_MS` 一起构成"可反证的短回路"。
  idleTickMs: envInt('MIAO_IDLE_TICK_MS', 5_000),
  // 「任务活动」的**统计范围**（= `idle-policy.mjs` 里 `lastActivityAt()` 的下界）：
  //   'runtime'（默认）—— 只算**本进程**启动之后的活动。盘上恢复的上一轮终态任务不算，
  //     否则重启 Box 后 ③ 刚拉起就会被判"空闲 18 小时"而卸掉（真实现场见 `lastActivityAt()` 注释）。
  //   'all' —— 把历史任务也算进来，**故意的旧行为**。这是反证开关（`MIAO_IDLE_SCOPE=all`），
  //     用来证明"重启后不该卸"那条断言确实作用在这个下界上，而不是碰巧绿。
  idleActivityScope: process.env.MIAO_IDLE_SCOPE === 'all' ? 'all' : 'runtime',
  // Tier2 空闲卸载（默认 30 min）：**实现方是引擎自带的 `--models-ttl`**，box-service 不动作。
  // 从下面同一个数字派生，避免「秒」与「毫秒」两个副本走散。
  idleVisionMs: ENGINE_MODELS_TTL_SEC * 1000,
  // 「从不卸载」的口径见 `UNLOAD_NEVER` 处（两个来源取或：阈值 0 / 显式开关）
  unloadNever: UNLOAD_NEVER,
  // 反证开关（延续本项目 `MIAO_NO_*` 家族）：关掉机制本身，用来证明断言测的**确实是这个机制**，
  // 而不是"碰巧绿"（关掉之后断言必须变红）。见 ~/.workbuddy/skills/falsifiable-verification。
  noIdleUnload: envBool('MIAO_NO_IDLE_UNLOAD'),
  noTierDowngrade: envBool('MIAO_NO_TIER_DOWNGRADE'),
  // ③ 是否在 box-service 启动时**预拉起**（默认 true = 产品行为：《04》§9.1 的 Tier1 归属，
  // 且 E11 的外部观察者要等 8080 起来才判"三进程已拉起"）。
  // 验收夹具若只关心任务/队列契约、又可能与其他实例抢 8080，可置 `MIAO_NO_LLM_AUTOSTART=1` 退出
  // —— 这个开关是**给夹具用的**，不是给产品的；产品路径永远走预拉起。
  llmAutostart: !envBool('MIAO_NO_LLM_AUTOSTART'),

  // ---------------------------------------------------------------- 契约面反证开关（S6）
  //
  // 与 `contractRefute` 同族（见 S5 那一组的注释），只是换成了 S6 的设置面。
  // 只被 `e2e/service/engine-settings-check.mjs --refute` 设置；产品路径永不设置。
  settingsRefute: SETTINGS_REFUTE,

  // ---------------------------------------------------------------- 契约面反证开关（S5）
  //
  // 与上面的 `noIdleUnload` / `noTierDowngrade` 同族，但**专门针对 S5 的契约增量**：
  // 每个开关都把"新契约"退回成"旧契约"、或把"两态"压成一态，用来证明断言测的**确实是
  // 新增的那条规则**，而不是"新增前后都恰好绿"。
  //
  // 🔴 只被 `e2e/service/contract-delta-check.mjs --refute` 设置；产品路径永不设置。
  //    集中放在一处（而不是散在用它各自的代码旁），是为了让"这个仓库里有哪些反证开关"
  //    能一次 grep 到 —— 散着放的下场是：反证跑绿了，但没人说得清它到底关掉了什么。
  contractRefute: {
    /** `ENGINE_NOT_READY` 退回 `UNAVAILABLE`（§2.3 边界消失 ⇒ 「准备中」与「不可用」不可分） */
    notReadyAsUnavailable: envBool('MIAO_NOT_READY_AS_UNAVAILABLE'),
    /** `/health` 的 `sidecar` 退回 ver1.0 的 3 字段（§5.1 扩展面消失） */
    sidecarLegacy3: envBool('MIAO_SIDECAR_LEGACY3'),
    /** `/engine/status` 免除鉴权（§5.2「不是免鉴权例外」被破坏） */
    engineStatusOpen: envBool('MIAO_ENGINE_STATUS_OPEN'),
    /** `warmed` 恒 true（§9.4「卸载 ≠ 未就绪」在字段层面不可见） */
    warmedAlways: envBool('MIAO_WARMED_ALWAYS'),
  },

  // 引擎③（Sakura LLM）地址：`translators/keys.py` 的 `SAKURA_API_BASE` 默认值即此
  engineSakuraBase: process.env.SAKURA_API_BASE || 'http://127.0.0.1:8080/v1',
};

// ------------------------------------------------------------------ 翻译方向（ver2.1 · 英译中）

/**
 * 本版支持的任务语言方向（**短码**）。UI 的「翻译方向」选项、建单白名单、引擎配置合成
 * 三处**共认这一份**，不许各自再抄一遍。
 *
 * 🔴 为什么不是「任意语言随便传」：`buildEngineConfig` 要把短码翻成引擎内部语言码
 *    （`translators/common.py::VALID_LANGUAGES`，如 `en` → `ENG`），而**翻译器是按方向选的**
 *    （见下方 `DIRECTION_TRANSLATOR`）。放开了传，就会出现「传了个我们没验过的方向、
 *    翻译器却仍是 sakura」这种静默产出原文的结果 —— A 组实测：sakura + 英文 = 8/8 行
 *    原文照抄，被下游「identical to original」滤掉，用户看到的是"跑过了但一个字没翻"。
 */
export const TRANSLATE_DIRECTIONS = [
  { from: 'ja', to: 'zh', label: '日译中' },
  { from: 'en', to: 'zh', label: '英译中' },
];

/** 短码 → 引擎内部语言码。键与引擎 `ISO_639_1_TO_VALID_LANGUAGES` 对齐，只取本版用到的。 */
const LANG_SHORT_TO_ENGINE = {
  ja: 'JPN', jpn: 'JPN',
  en: 'ENG', eng: 'ENG',
  zh: 'CHS', chs: 'CHS', 'zh-cn': 'CHS',
};

const ENGINE_LANG_CODES = new Set(Object.values(LANG_SHORT_TO_ENGINE));

/**
 * 语言标识 → 引擎内部语言码；**认不出来返回 `null`（不猜）**。
 * 短码（`en`）、引擎码（`ENG`）都收，大小写不敏感；`auto` 原样保留（显式要引擎自动检测）。
 */
export function engineLangCode(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'auto') return 'auto';
  if (LANG_SHORT_TO_ENGINE[lower]) return LANG_SHORT_TO_ENGINE[lower];
  const upper = raw.toUpperCase();
  return ENGINE_LANG_CODES.has(upper) ? upper : null;
}

/**
 * 方向是否在本版支持范围内（`from` 与 `to` 都要能被认出来且**恰好**是登记过的那一对）。
 *
 * ⚠️ 判的是"这一对"而不是"两个码各自合法"：`zh→ja` 里两个码都合法，但它不在支持表里 ——
 *    按"各自合法"放行，`buildEngineConfig` 就会拿不到翻译器（回落 sakura），
 *    于是中文原样进、中文原样出。方向必须成对校验。
 */
export function isSupportedDirection(lang) {
  const d = normalizeDirection(lang);
  return d !== null && TRANSLATE_DIRECTIONS.some((x) => x.from === d.from && x.to === d.to);
}

/**
 * 把方向规范化成 `{from, to}` 短码小写。**只规范化、不校验合法性**：
 * 校验是调用方的事（`server.mjs` 用它做 400 判据、`store` 用它做落库前的统一形状）。
 * 缺 `from`/`to` 或不是对象时返回 `null`（调用方据此回落到默认方向）。
 */
export function normalizeDirection(lang) {
  if (!lang || typeof lang !== 'object' || Array.isArray(lang)) return null;
  const from = String(lang.from ?? '').trim().toLowerCase();
  const to = String(lang.to ?? '').trim().toLowerCase();
  if (!from || !to) return null;
  return { from, to };
}

/**
 * **方向 → 引擎翻译器**：只在基线翻译器**结构上做不到该方向**时才改写。
 * 今天只有一条：`en>CHS` —— `sakura` 的 system prompt 把源语言硬编码成日文、
 * `_LANGUAGE_CODE_MAP` 只有 `{CHS, JPN}`（A 组实测 8/8 行原文照抄）⇒ 英文必须换 `nllb`
 * （离线权重见 `engine/models.manifest.json` 的 `translation` set）。
 * 其余方向落回 `config.engineConfig.translator.translator`（出厂 `sakura`，可被 env 覆盖）。
 */
const DIRECTION_TRANSLATOR = { 'ENG>CHS': 'nllb' };

/**
 * 按任务方向合成**这一次请求**的引擎配置。
 *
 * 为什么要有它（而不是继续把 `config.engineConfig` 整个发出去）：
 * `from_lang` 是**逐任务**的 —— 同一台机器上既有日译中又有英译中；而 `engineConfig`
 * 是进程级常量。把常量改成可变的，就退化成"哪个任务先跑、谁的设置说了算"。
 * ⇒ `engineConfig` 继续当**不可变基线**，本函数在它之上叠一层方向。
 *
 * @param {{lang?: {from?:string, to?:string}}} [opts]
 * @returns {object} 新的引擎配置（**不改动** `config.engineConfig`）
 */
export function buildEngineConfig({ lang } = {}) {
  const base = config.engineConfig;
  const from = engineLangCode(lang && lang.from);
  const to = engineLangCode(lang && lang.to) ?? base.translator.target_lang;
  const translator = DIRECTION_TRANSLATOR[`${from}>${to}`] || base.translator.translator;
  return {
    ...base,
    translator: {
      ...base.translator,
      translator,
      target_lang: to,
      // 🔴 映射不出引擎码时**不下发** `from_lang`（保持上游 `None` = auto），而不是发个空串。
      //    `TranslatorConfig.from_lang` 的语义是「None = 保持上游 auto」（A2 补丁）；
      //    发空串会被 `_src_lang or 'auto'` 吞掉，看着一样，实则多了一个假值来源。
      ...(from ? { from_lang: from } : {}),
    },
  };
}

// ------------------------------------------------------------------ 路径安全工具（契约 §8.2）

/**
 * 规范化路径：解析已存在部分的符号链接，未存在的部分原样拼接。
 * 用于契约 §8.2 的第 3 次校验（拼接后前缀比对）。
 */
export function canonicalize(p) {
  const abs = path.resolve(p);
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

// 黑名单条目分两种匹配语义（契约 §8.2 校验点 1）：
//  · EXACT  —— 只拒「目录本身」。这些是**容器目录**：其下仍可能是合法落盘位置
//              （如 /Users 下的 ~/Pictures/Box 漫画，见 §7.1；/private/var 下的
//              macOS TMPDIR /private/var/folders/…）。若按前缀拒绝会把合法路径一并挡掉。
//  · PREFIX —— 连子路径一并拒绝。这些是真正的系统目录。
const BLACKLIST_EXACT = () => {
  const home = os.homedir();
  const list = [
    path.parse(path.resolve('/')).root, // '/'（Windows 下为 'C:\\'）
    '/Users',                           // home 的父目录：本身不可作落盘根
    home,                               // 用户主目录本身（§8.2「用户主目录本身」）
    '/private',                         // TMPDIR 的真实父目录，本身不可作落盘根
    '/private/var',
    '/var',                             // → /private/var
  ];
  if (process.platform === 'win32') {
    // Windows：home 的父目录（`C:\Users`）本身不可作落盘根 —— 与 macOS 的 `/Users` 同义。
    // 🔴 必须是 EXACT 而非 PREFIX：`C:\Users` 之下就是各用户目录，前缀拒绝会把
    //    合法的 `C:\Users\<me>\Pictures\Box 漫画` 一并挡掉。
    const homeParent = path.dirname(home);
    if (homeParent && homeParent !== home) list.push(homeParent);
  }
  return list;
};

const BLACKLIST_PREFIX = () => {
  const home = os.homedir();
  const list = [
    '/tmp',                 // → /private/tmp
    '/private/tmp',
    '/private/var/tmp',
    '/private/etc',
    '/etc',
    '/usr',
    '/System',
    '/Library',
    '/Applications',
    '/Volumes',
    '/cores',
    '/opt',
    path.join(home, 'Library'), // 修复原先「home/Library 精确相等」被 ~/Library/Caches/xxx 绕过
  ];
  if (process.platform === 'win32') {
    // 🔴 Windows 系统目录（原来的 Unix 名单在 Windows 上**一条都命中不了**，
    //    等于这道校验在 Windows 下形同虚设 —— 用户可以把落盘根指到 C:\Windows）。
    const sysRoot = `${process.env.SystemDrive || 'C:'}\\`;
    list.push(
      path.join(sysRoot, 'Windows'),
      process.env.ProgramFiles || path.join(sysRoot, 'Program Files'),
      process.env['ProgramFiles(x86)'] || path.join(sysRoot, 'Program Files (x86)'),
      process.env.ProgramData || path.join(sysRoot, 'ProgramData'),
    );
  }
  return list;
};

function blacklistHit(canonicalAbs) {
  for (const raw of BLACKLIST_EXACT()) {
    if (!raw) continue;
    if (canonicalAbs === canonicalize(raw)) return raw;
  }
  for (const raw of BLACKLIST_PREFIX()) {
    if (!raw) continue;
    const cb = canonicalize(raw);
    if (!cb) continue;
    // 根路径（'/'）的 `cb + sep` 为 '//'，天然不会前缀命中任何路径 → 根只做精确匹配
    if (canonicalAbs === cb || canonicalAbs.startsWith(cb + path.sep)) return raw;
  }
  return null;
}

/** 启动时校验一次（契约 §8.2 校验点 1） */
export function validateRoot(rootDir) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) {
    throw new Error(`落盘根目录必须是绝对路径：${rootDir}`);
  }
  const abs = path.resolve(rootDir);
  const canonicalAbs = canonicalize(abs);
  const hit = blacklistHit(canonicalAbs);
  if (hit) {
    throw new Error(`落盘根目录不合法（命中黑名单 ${hit}）：${abs}`);
  }
  // 已存在的目录**不**强制 chmod（否则会抹掉「只读根目录 → 507 DISK_FULL」这类可注入条件）；
  // 新建的目录用 0700；可写性由请求期的 assertRootWritable() 校验（见 server.mjs）。
  fs.mkdirSync(abs, { recursive: true, mode: 0o700 });
  return canonicalize(abs);
}

/**
 * 拼接后前缀校验（契约 §8.2 校验点 3）。
 * target 指向「文件」时，其 parent 即漫画目录，必须位于 root 之内。
 */
export function assertInsideRoot(rootCanonical, target) {
  const parentCanonical = canonicalize(path.dirname(target));
  const ok = parentCanonical === rootCanonical
    ? false
    : parentCanonical.startsWith(rootCanonical + path.sep);
  if (!ok) throw new PathEscapeError(target);
  return true;
}

export class PathEscapeError extends Error {
  constructor(target) {
    super(`路径越界：${target}`);
    this.name = 'PathEscapeError';
  }
}

/** 文件名由服务端生成，正则固定（契约 §8.2 校验点 2） */
export const FILE_NAME_RE = /^\d{3}(_translated)?\.(png|jpg|jpeg|webp)$/;
/** 目录内用于续编号扫描的正则（契约 §7.4） */
export const ORIGINAL_SCAN_RE = /^(\d{3})\.(png|jpg|jpeg|webp)$/;
export const TRANSLATED_SCAN_RE = /^(\d{3})_translated\.(png|jpg|jpeg|webp)$/;

export function seq3(seq) {
  return String(seq).padStart(3, '0');
}
