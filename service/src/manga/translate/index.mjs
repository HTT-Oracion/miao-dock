// 在线翻译门面 —— 本模块**唯一的对外入口**（路由层只 import 本文件）
// =============================================================================
// 依据：在线翻译服务设计方案 §3（模块职责表）/ §6（调用流程）/ §7（错误与重试）/ §8（配置）。
//
// 门面只做「编排」，不认平台：
//   入参校验 · 能力协商（registry）· 语言码归一（adapter.langCode）· 限流（limiter）
//   · 密钥现读注入 ctx · 错误归一 · 按 §7.3 重试
// 🔴 纪律：**不碰任何平台字段名** —— 本文件不知道 `llm-trans` / `transIncre` /
//    `errorCode` / `handleOption` 这些词（它们全在 `platforms/youdao.mjs`）。
//    新增平台 = 一个适配器文件 + 注册表一行，本文件一个字都不用改（方案 §9）。
//
// 🔴 与 engine-settings 同款的理由，本模块**不 import `config.mjs`**：两个盘上文件的
//    路径由调用方（server.mjs 启动时）经 `configureTranslate()` 注入，本模块对所有
//    输入都是纯参数。反过来 import 会形成 ESM 环，而 `STATE_DIR` 是 config 顶层的
//    const —— 一旦求值顺序变成"本模块先求值"，拿到的就是 TDZ 里的未初始化绑定。

import { ApiError } from '../../errors.mjs';
import { postForm, postStream } from './http.mjs';
import { getAdapter, listPlatforms } from './registry.mjs';
import { createLimiter } from './limiter.mjs';
import { TranslateError, mapUpstreamError, translateErrorFrom } from './errors.mjs';
import { TranslateSettingsError, mergeWithEnv, readTranslateSettings, writeTranslateSettings } from './settings.mjs';
import { credentialsView, readCredentials, writeCredentials } from './credentials.mjs';
import { REFUTE } from './refute.mjs';

/** 文本长度上限（有道两接口一致：`q`/`i` ≤5000 字符，方案 §5.2/§5.3）。
 *  按 UTF-16 码元数（`String.length`）—— 与适配器签名用的 `q.length` 同一把尺。 */
const TEXT_MAX_CHARS = 5000;
/** 提示词上限（有道 llm：≤1200 字符 / ≤400 词，方案 §5.2） */
const PROMPT_MAX_CHARS = 1200;
const PROMPT_MAX_WORDS = 400;

/** text 整体 · 可重试错最多重试 2 次，退避 300ms → 900ms（方案 §7.3） */
const TEXT_MAX_RETRIES = 2;
/** llm 流式 · **首块之前**失败才重试，且最多 1 次；首块之后绝不重试（方案 §7.3） */
const STREAM_MAX_RETRIES = 1;
/** 退避序列（毫秒）：与上两条预算一一对应 */
const RETRY_BACKOFF_MS = [300, 900];

/**
 * 每平台令牌桶（方案 §7.4）：速率 = 该平台最小 QPS，并发上限默认 3。
 * 速率/并发取 §7.4 的**默认值**（10 QPS / 并发 3）—— 平台差异化配额需要契约先扩
 * （现契约没有限额字段），门面不猜、也不碰平台细节。
 */
const limiters = new Map();

/** 盘上文件路径（`configureTranslate` 注入；未注入 = 接线漏了，直接抛） */
let files = null;

/**
 * 注入两个盘上文件的路径。**server 启动时调一次**。
 *
 * 为什么不 import config.mjs 自己算 `STATE_DIR`：见文件头（ESM 环 + TDZ）。
 * 路径由调用方给，与 `engine-settings.mjs` 的 `{ file }` 同款姿态。
 */
export function configureTranslate({ settingsFile, credentialsFile } = {}) {
  if (typeof settingsFile !== 'string' || settingsFile.trim() === '') {
    throw new Error('configureTranslate 需要非空的 settingsFile（非密钥设置文件路径）');
  }
  if (typeof credentialsFile !== 'string' || credentialsFile.trim() === '') {
    throw new Error('configureTranslate 需要非空的 credentialsFile（密钥文件路径）');
  }
  files = { settingsFile, credentialsFile };
}

function ensureConfigured() {
  if (!files) {
    throw new Error('翻译门面尚未 configureTranslate：服务启动时必须注入 settingsFile / credentialsFile');
  }
}

// ------------------------------------------------------------------ 现读（方案 §8.4）

/**
 * 合并生效设置（env > 盘上文件 > 出厂默认）。
 * 🔴 **每次调用都现读**：用户改完设置/密钥，下一次调用即生效 —— 适配器不缓存密钥，
 *    否则"改了密钥不生效"，而用户看到的是"我明明填了新的，还是签名失败"。
 */
function currentMerged() {
  ensureConfigured();
  const read = readTranslateSettings({ file: files.settingsFile });
  const merged = mergeWithEnv({ env: process.env, fileSettings: read.settings });
  // 连盘上文件的**问题**一起带回（exists/corrupt/reason/unknownKeys/invalid）——
  // settings.mjs 读路径纪律承诺"丢弃 + 上报"，上报的出口就在这里（见 translateOptionsView）。
  return { ...merged, read };
}

/** 每平台一个桶（进程内懒建；限流不是计账，重启即清零，方案 §7.4） */
function limiterOf(platformId) {
  let limiter = limiters.get(platformId);
  if (!limiter) {
    limiter = createLimiter({ qps: 10, concurrency: 3 });
    limiters.set(platformId, limiter);
  }
  return limiter;
}

/**
 * 取一个平台适配器 + 能力协商（方案 §4.2）。
 * 🔴 能力不符**在这里就挡下**：不落到适配器、不发出任何网络请求 ——
 *    假平台反证（方案 §9/§10）靠的正是这条。
 */
async function adapterFor(platformId, mode) {
  const adapter = await getAdapter(platformId);
  if (!adapter.capabilities.has(mode)) {
    throw new TranslateError('TRANSLATE_CAPABILITY_UNSUPPORTED',
      `平台 ${adapter.id}（${adapter.label}）不支持 ${mode === 'llm' ? '大模型流式' : '普通文本'}翻译`,
      { platform: adapter.id, mode, capabilities: [...adapter.capabilities] });
  }
  return adapter;
}

// ------------------------------------------------------------------ 入参校验（方案 §6.1/§6.2 的 ②③ 步）

function assertText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new TranslateError('TRANSLATE_INVALID_INPUT',
      'text 必须是非空字符串', { received: text === undefined ? null : typeof text });
  }
  if (text.length > TEXT_MAX_CHARS) {
    throw new TranslateError('TRANSLATE_TEXT_TOO_LONG',
      `待翻译文本超过 ${TEXT_MAX_CHARS} 字符上限（收到 ${text.length}）`,
      { length: text.length, limit: TEXT_MAX_CHARS });
  }
}

function assertDirection(from, to) {
  for (const [field, value] of [['from', from], ['to', to]]) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TranslateError('TRANSLATE_INVALID_INPUT',
        `${field} 必须是非空字符串（语言短码，如 'ja' | 'en' | 'zh' | 'auto'）`,
        { field, received: value === undefined ? null : typeof value });
    }
  }
}

/** 提示词（仅 llm）：≤1200 字符且 ≤400 词（方案 §5.2）。没给 = 用平台默认，不校验 */
function assertPrompt(prompt) {
  if (prompt === undefined || prompt === null || prompt === '') return;
  if (typeof prompt !== 'string') {
    throw new TranslateError('TRANSLATE_INVALID_INPUT',
      `prompt 必须是字符串，收到 ${typeof prompt}`, { received: typeof prompt });
  }
  if (prompt.length > PROMPT_MAX_CHARS) {
    throw new TranslateError('TRANSLATE_INVALID_INPUT',
      `提示词超过 ${PROMPT_MAX_CHARS} 字符上限（收到 ${prompt.length}）`,
      { length: prompt.length, limit: PROMPT_MAX_CHARS });
  }
  const words = prompt.trim().split(/\s+/).filter((w) => w !== '').length;
  if (words > PROMPT_MAX_WORDS) {
    throw new TranslateError('TRANSLATE_INVALID_INPUT',
      `提示词超过 ${PROMPT_MAX_WORDS} 词上限（收到 ${words}）`, { words, limit: PROMPT_MAX_WORDS });
  }
}

/**
 * 语言码归一：认不出当场 400（方案 §4.3）。
 * 🔴 **不猜**：猜错的代价是"把日文当英文送"，而送错方向的产物往往又长又像样，最难发现。
 *    映射表在适配器里（`langCode`），门面只负责"提前问一次、认不出就拒"。
 */
function normalizeLangs(adapter, from, to, api) {
  const fromCode = adapter.langCode(from, api);
  const toCode = adapter.langCode(to, api);
  if (fromCode === null || toCode === null) {
    throw new TranslateError('TRANSLATE_INVALID_INPUT',
      `不支持的翻译方向：${JSON.stringify(from)} → ${JSON.stringify(to)}（平台 ${adapter.id}）`,
      { platform: adapter.id, api, from, to, langs: Array.isArray(adapter.langs) ? [...adapter.langs] : [] });
  }
}

/** 平台缺省走**设置里的** platform（P-D1：平台是服务的设置，不是请求的属性）；
 *  设置里也没有时落 `DEFAULT_SETTINGS.platform`（'youdao'）。 */
function resolvePlatform(platform, settings) {
  if (platform === undefined || platform === null) return settings.platform;
  if (typeof platform !== 'string' || platform.trim() === '') {
    throw new TranslateError('TRANSLATE_INVALID_INPUT',
      `platform 必须是非空字符串，收到 ${JSON.stringify(platform)}`, { platform });
  }
  return platform.trim();
}

/** 总超时预算：请求可覆盖；没给/不合法时用设置里的 `timeoutMs`。
 *  🔴 非法值**当场抛**而不是静默回落：静默回落的 timeoutMs 是一个用户改不动的参数。 */
function resolveTimeout(timeoutMs, fallback) {
  if (timeoutMs === undefined || timeoutMs === null) return fallback;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TranslateError('TRANSLATE_INVALID_INPUT',
      `timeoutMs 必须是正数（毫秒），收到 ${JSON.stringify(timeoutMs)}`, { timeoutMs });
  }
  return timeoutMs;
}

// ------------------------------------------------------------------ 限流 / 错误归一 / 重试（方案 §7）

/**
 * 过一遍令牌桶再执行 `fn`（QPS + 并发双重闸门）。
 * 等待上限随本次调用的总超时 `totalMs`（方案 §7.4）。
 */
async function withLimiter(platformId, totalMs, fn) {
  let release;
  try {
    release = await limiterOf(platformId).acquire(totalMs);
  } catch (err) {
    // 等不到额度 = 我们自己的闸门满了。归 429 而不是 504：用户该做的动作是
    // "等一会儿再点"，而"本层超时"会把人引向反复重试（只会更堵）。
    if (err && err.code === 'LIMITER_TIMEOUT') {
      throw new TranslateError('TRANSLATE_RATE_LIMITED',
        `翻译请求排队超时（${totalMs}ms 内未获得平台 ${platformId} 的额度），请稍后再试`,
        { platform: platformId, stage: 'limiter', timeoutMs: totalMs });
    }
    throw err;
  }
  try {
    return await fn();
  } finally {
    release(); // 幂等：重复释放不会把并发额扣穿（limiter.mjs 保证）
  }
}

/**
 * 错误归一：`TranslateError` 直接冒泡（已带 code/status）；
 * 其余（node 网络错等）经 `mapUpstreamError` 归一 —— 重试判定要用归一后的码。
 */
function normalizeError(err, platformId, api) {
  if (err instanceof TranslateError) return err;
  if (err instanceof Error) return translateErrorFrom(mapUpstreamError(platformId, api, err));
  return new TranslateError('TRANSLATE_UPSTREAM_ERROR',
    `调用翻译平台 ${platformId} 失败：${String(err)}`, { platform: platformId, api });
}

/**
 * 可重试判定（方案 §7.3）：
 *   · `UPSTREAM_UNREACHABLE` / `TIMEOUT` —— 链路与超时问题，重试可能好；
 *   · `UPSTREAM_ERROR` **仅限** 5xx 与上游 `303`（服务端异常一族）；
 *   · 其余（AUTH_FAILED / INVALID_INPUT / RATE_LIMITED / QUOTA / CAPABILITY …）**不重试** ——
 *     重试只会再错一遍，还多花额度。
 */
function isRetryable(err) {
  if (!(err instanceof TranslateError)) return false;
  if (err.code === 'TRANSLATE_UPSTREAM_UNREACHABLE' || err.code === 'TRANSLATE_TIMEOUT') return true;
  if (err.code === 'TRANSLATE_UPSTREAM_ERROR') {
    const d = err.details || {};
    if (Number.isInteger(d.httpStatus) && d.httpStatus >= 500) return true;
    return d.upstreamCode === '303';
  }
  return false;
}

/** 退避等待。客户端已断开时不睡也不重试（按量计费，不给已离开的用户花额度） */
async function backoff(ms, signal) {
  if (signal && signal.aborted) return;
  await new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 每次尝试都**现读密钥**并现攒 ctx（方案 §8.4：适配器不缓存密钥）。
 * `ctx.limiter` 按契约透传；闸门由门面持有（`withLimiter` 已 acquire），
 * 适配器不应再自取 —— 双闸等于把额度砍半。
 */
function buildCtx(platformId, totalMs, signal) {
  const entry = readCredentials({ file: files.credentialsFile }).platforms[platformId] || {};
  return {
    http: { postForm, postStream },
    limiter: limiterOf(platformId),
    credentials: { appKey: entry.appKey ?? '', appSecret: entry.appSecret ?? '' },
    timeoutMs: totalMs,
    signal,
  };
}

// ------------------------------------------------------------------ 对外：整体翻译（方案 §6.2）

/**
 * 普通文本翻译（**整体**返回）。
 *
 * @param {object}  req
 * @param {string} [req.platform] 平台 id；缺省取设置里的 `platform`（默认 'youdao'）
 * @param {string} [req.mode]    必为 `'text'`（走错入口 = 入参错误，不是能力错误）
 * @param {string}  req.text     待翻译文本（非空，≤5000 字符）
 * @param {string}  req.from     源语言短码
 * @param {string}  req.to       目标语言短码
 * @param {boolean}[req.splitLines] 按行对齐（仅 text 能力有意义）
 * @param {string} [req.domain]  领域（仅 text 能力透传）
 * @param {string} [req.vocabId] 术语表 ID（仅 text 能力透传）
 * @param {number} [req.timeoutMs] 覆盖总超时
 * @param {AbortSignal} [req.signal] 外部取消（客户端断开时由路由层传入）
 * @returns {Promise<import('./contract.mjs').TranslateResult>} `{ text, lines?, langType }`
 */
export async function translateText({
  platform, mode = 'text', text, from, to, splitLines, domain, vocabId, timeoutMs, signal,
} = {}) {
  const merged = currentMerged();
  const platformId = resolvePlatform(platform, merged.settings);
  if (mode !== 'text') {
    throw new TranslateError('TRANSLATE_INVALID_INPUT',
      `translateText 只接受 mode:'text'，收到 ${JSON.stringify(mode)}`, { mode });
  }
  assertText(text);
  assertDirection(from, to);
  const adapter = await adapterFor(platformId, 'text');
  const fromS = from.trim();
  const toS = to.trim();
  normalizeLangs(adapter, fromS, toS, 'text');
  const totalMs = resolveTimeout(timeoutMs, merged.settings.timeoutMs);

  // 只带本能力用得上的字段（适配器还会再裁一遍，方案 §5.4）
  const adapterReq = {
    text, from: fromS, to: toS, splitLines: !!splitLines, domain, vocabId, timeoutMs: totalMs, signal,
  };

  let attempt = 0;
  for (;;) {
    try {
      return await withLimiter(platformId, totalMs, async () => {
        const ctx = buildCtx(platformId, totalMs, signal);
        return await adapter.translateText(adapterReq, ctx);
      });
    } catch (err) {
      const e = normalizeError(err, platformId, 'text');
      if (attempt >= TEXT_MAX_RETRIES || !isRetryable(e)) throw e;
      await backoff(RETRY_BACKOFF_MS[attempt], signal);
      if (signal && signal.aborted) throw e;
      attempt += 1;
    }
  }
}

// ------------------------------------------------------------------ 对外：流式翻译（方案 §6.1）

/**
 * 大模型翻译（**流式**）：每收到增量调一次 `onDelta`，完成调 `onDone`。
 *
 * @param {object} req
 * @param {string} [req.platform] 平台 id；缺省取设置里的 `platform`
 * @param {string} [req.mode]    必为 `'llm'`
 * @param {string}  req.text     待翻译文本（非空，≤5000 字符）
 * @param {string}  req.from     源语言短码
 * @param {string}  req.to       目标语言短码
 * @param {string} [req.prompt]  提示词（≤1200 字符 / ≤400 词）
 * @param {string} [req.model]   'pro' | 'lite'（仅 llm 能力透传）
 * @param {number} [req.timeoutMs] 覆盖总超时
 * @param {AbortSignal} [req.signal] 外部取消
 * @param {object} [hooks]
 * @param {(delta:string)=>void|Promise<void>} [hooks.onDelta] 增量回调，**允许 async** ——
 *        路由层背压（下游 write 返回 false 时等 'drain'）靠它把节奏传导回上游
 * @param {({text:string, langType?:string})=>void|Promise<void>} [hooks.onDone] 完成回调（累计全文）
 * @returns {Promise<void>} 中途失败**抛给路由层**（由它写 translate.error 事件）
 */
export async function translateStream({
  platform, mode = 'llm', text, from, to, prompt, model, timeoutMs, signal,
} = {}, { onDelta, onDone } = {}) {
  const merged = currentMerged();
  const platformId = resolvePlatform(platform, merged.settings);
  if (mode !== 'llm') {
    throw new TranslateError('TRANSLATE_INVALID_INPUT',
      `translateStream 只接受 mode:'llm'，收到 ${JSON.stringify(mode)}`, { mode });
  }
  assertText(text);
  assertDirection(from, to);
  assertPrompt(prompt);
  const adapter = await adapterFor(platformId, 'llm');
  const fromS = from.trim();
  const toS = to.trim();
  normalizeLangs(adapter, fromS, toS, 'llm');
  const totalMs = resolveTimeout(timeoutMs, merged.settings.timeoutMs);

  const adapterReq = { text, from: fromS, to: toS, prompt, model, timeoutMs: totalMs, signal };

  // 首块锁定：onDelta 被调用过 = 译文已吐给用户，此后失败绝不重试（方案 §7.3 ——
  // 重来会重复/覆盖前面的内容）。标志在**交出增量之前**置位：交出去了就没有回头路。
  let firstBlockOut = false;
  const emit = async (delta) => {
    firstBlockOut = true;
    if (typeof onDelta === 'function') await onDelta(delta);
  };

  let attempt = 0;
  for (;;) {
    try {
      const result = await withLimiter(platformId, totalMs, async () => {
        const ctx = buildCtx(platformId, totalMs, signal);
        return await adapter.translateStream(adapterReq, emit, ctx);
      });
      if (typeof onDone === 'function') {
        await onDone({ text: result.text, langType: result.langType });
      }
      return;
    } catch (err) {
      const e = normalizeError(err, platformId, 'llm');
      // 反证开关：忽略首块锁定 ⇒ 首块之后也重试（已吐给用户的增量被重复/覆盖；
      // check 的 S5/T2 应变红：假上游收到的请求数从 1 变 2）
      const locked = REFUTE.streamRetryAfterFirst ? false : firstBlockOut;
      if (locked || attempt >= STREAM_MAX_RETRIES || !isRetryable(e)) throw e;
      await backoff(RETRY_BACKOFF_MS[attempt], signal);
      if (signal && signal.aborted) throw e;
      attempt += 1;
    }
  }
}

// ------------------------------------------------------------------ 对外：设置 / 密钥 / 选项视图（方案 §6.3 的数据源）

/**
 * 当前翻译来源（'local' | 'online'）—— P-D4 的判据。
 *
 * 🔴 读失败时回 `'local'`：这个函数是**开机闸门**（决定引擎随不随开机拉起）的输入，
 *    它没有理由有能力把服务启动搞崩；坏设置会在第一次翻译调用时以 INVALID_SETTING
 *    响亮地报出来。文件不存在 = 首次启动 = 默认 local ⇒ 行为与接线前完全一致。
 */
export function currentTranslateSource() {
  try {
    return currentMerged().settings.source;
  } catch {
    return 'local';
  }
}

/**
 * `GET /translate/options` 的视图：平台能力 + 生效设置（含来源追踪）+ 脱敏密钥视图。
 * 🔴 `credentials` 只回 `{ appKey, hasSecret }` —— **secret 永不回显**（方案 §8.3）。
 */
export async function translateOptionsView() {
  ensureConfigured();
  const platforms = await listPlatforms();
  const merged = currentMerged();
  const credentials = credentialsView({ file: files.credentialsFile });
  const read = merged.read;
  return {
    platforms,
    settings: merged.settings,
    sources: merged.sources,
    credentials,
    // 🔴 盘上文件的**问题必须 surfaced，不静默**（settings.mjs 读路径纪律）：
    //    未知键 / 非法值 / 损坏如果只在日志里，设置页就会呈现"保存成功但其实什么都没变"
    //    的那类假绿，且用户与诊断视图都无从归因。
    fileIssues: {
      exists: read.exists,
      corrupt: read.corrupt,
      reason: read.reason,
      unknownKeys: read.unknownKeys,
      invalid: read.invalid,
    },
  };
}

/** 保存非密钥设置补丁（白名单 strict 校验 + 原子写）。返回 `{ settings, changed }` */
export function saveTranslateSettings(patch) {
  ensureConfigured();
  return writeTranslateSettings({ file: files.settingsFile }, patch);
}

/**
 * 保存一个平台的密钥（原子写 0600，**只写不读回显**）。
 * 校验（platform/appKey/appSecret 非空、appSecret ≤128）在 `writeCredentials` 内。
 * @returns {{platform:string, appKey:string}} 只回平台 id 与 appKey，**不含 secret**
 */
export function saveTranslateCredentials({ platform, appKey, appSecret } = {}) {
  ensureConfigured();
  const saved = writeCredentials({ file: files.credentialsFile }, { platform, appKey, appSecret });
  return { platform: saved.platform, appKey: saved.view[saved.platform]?.appKey ?? '' };
}

/**
 * 翻译域错误 → 契约 `ApiError`（路由层的统一出口）。
 *
 * 为什么转换发生在门面而不是各路由：`translate/errors.mjs` 明写"最终由**门面**翻译成
 * ApiError 出信封"—— 域内错误归域内闭环，跨出边界只此一处。`TranslateError` 自带
 * status（域内码表给出），`TranslateSettingsError` → `INVALID_SETTING`(400)。
 * @returns {ApiError|Error} 翻译域错误 → ApiError；非翻译域错误（bug）**原样返回**，
 *          交给既有 `sendError` 走 500 + console.error（不把内部异常洗成翻译错误）
 */
export function translateApiError(err) {
  if (err instanceof TranslateError) {
    return new ApiError(err.code, err.message, err.details);
  }
  if (err instanceof TranslateSettingsError) {
    return new ApiError('INVALID_SETTING', err.message, err.details);
  }
  return err;
}
