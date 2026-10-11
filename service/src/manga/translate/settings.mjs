// 在线翻译**非密钥设置**的持久化层（`state/translate-settings.json`）
// =============================================================================
// 契约依据：在线翻译服务设计方案 §8（三层来源 / 白名单 / 原子写）。
// 范式来源：`settings/engine-settings.mjs`（白名单 + 双向不对称校验 + 原子写 + mergeWithEnv）。
// 密钥**不在本文件**（见 `credentials.mjs`，方案 §8.3：密钥的传播面物理上更小）。
//
// ## 🔴 本模块**不 import `config.mjs`**（与 engine-settings 同一条理由）
// `config.mjs` 需要 import 本模块来合并「用户设置 + 环境变量」；本模块反过来 import 它
// 就形成 ESM 循环 —— 而循环在这里不是理论风险：`STATE_DIR` 是 config 顶层的 const，
// 一旦求值顺序变成"本模块先求值"，拿到的就是 TDZ 里的未初始化绑定。
// ⇒ 落盘路径由调用方传进来（`{ file }`），本模块对所有输入都是**纯参数**。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 允许持久化的键（**白名单**）。
 *
 * 🔴 白名单的意义不是"防注入"，而是**防拼错**：`youdao.llmmodel`（大小写）、
 *    `youdao_llm_model`（下划线）这类键如果被**静默丢弃**，用户看到的是
 *    「设置保存成功」而实际什么都没变 —— 这正是本项目最反对的那类假绿。
 *    ⇒ 写路径上一律**拒绝**（见 `assertTranslatePatch`），不静默丢。
 *    ⇒ 读路径（盘上的文件）相反：见 `parseTranslateSettings` 的注释。
 */
export const TRANSLATE_SETTINGS_KEYS = new Set([
  'platform', 'source', 'youdao.llmModel', 'youdao.textDomain', 'youdao.vocabId', 'timeoutMs',
]);

/** 翻译来源：本地引擎 / 在线 API（方案 P-D1：来源是**服务的设置**，不是任务的属性） */
export const TRANSLATE_SOURCE_VALUES = ['local', 'online'];
/** 大模型档位：pro = 子曰 14B（handleOption 0）· lite = 1.5B（handleOption 3） */
export const YOUDAO_LLM_MODEL_VALUES = ['pro', 'lite'];
/** 文本翻译领域（有道 `domain`；非通用领域仅中英互译） */
export const YOUDAO_TEXT_DOMAIN_VALUES = ['general', 'computers', 'medicine', 'finance', 'game'];
/** 总超时上下限（毫秒）：1s ~ 10min。再大不像"翻译超时"而像"忘关了"，多半是输错了 */
export const TRANSLATE_TIMEOUT_MIN = 1000;
export const TRANSLATE_TIMEOUT_MAX = 600000;
/** 术语表 ID 长度上限（有道侧限制） */
export const VOCAB_ID_MAX = 64;

/** 出厂默认（代码常量层，方案 §8.1 的最底层） */
export const DEFAULT_SETTINGS = Object.freeze({
  platform: 'youdao',
  source: 'local',
  'youdao.llmModel': 'pro',
  'youdao.textDomain': 'general',
  'youdao.vocabId': '',
  timeoutMs: 30000,
});

/**
 * 注册表 id 集（`platform` 的合法取值）。
 * 默认 `{'youdao'}`；由 `registry.mjs` 在加载时注入真实集合 —— 本模块刻意
 * **不 import registry**（那样 settings ↔ registry 成环），用注入保持单向依赖。
 */
let PLATFORM_IDS = new Set(['youdao']);

/** 注入注册表 id 集（重复调用以最后一次为准） */
export function setPlatformIds(ids) {
  PLATFORM_IDS = new Set(ids);
}

/** 当前登记的注册表 id（诊断/提示用） */
export function platformIds() {
  return [...PLATFORM_IDS];
}

export class TranslateSettingsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TranslateSettingsError';
    this.code = code;
    this.details = details;
  }
}

// ------------------------------------------------------------------ 取值校验

const VALIDATORS = {
  // 🔴 `platform` 必须**严格校验存在性**（strict 与非 strict 都拒非法值，只对"未知键"放行）：
  //    它是**路由到哪张适配器**的开关。写错一个字母若静默回落到默认 'youdao'，
  //    用户会以为"选了百度、其实还在用有道"——而这种错在界面上毫无痕迹。
  platform: {
    // hint 是函数：注册表 id 集由 `setPlatformIds` 注入，加载后才可知（惰性求值，别固化）
    hint: () => `可选：${platformIds().join(' | ')}`,
    check: (v) => typeof v === 'string' && PLATFORM_IDS.has(v),
  },
  source: {
    hint: `可选：${TRANSLATE_SOURCE_VALUES.join(' | ')}`,
    check: (v) => TRANSLATE_SOURCE_VALUES.includes(v),
  },
  'youdao.llmModel': {
    hint: `可选：${YOUDAO_LLM_MODEL_VALUES.join(' | ')}`,
    check: (v) => YOUDAO_LLM_MODEL_VALUES.includes(v),
  },
  'youdao.textDomain': {
    hint: `可选：${YOUDAO_TEXT_DOMAIN_VALUES.join(' | ')}`,
    check: (v) => YOUDAO_TEXT_DOMAIN_VALUES.includes(v),
  },
  'youdao.vocabId': {
    hint: `字符串，≤${VOCAB_ID_MAX} 字符（空串 = 不使用术语表）`,
    check: (v) => typeof v === 'string' && v.length <= VOCAB_ID_MAX,
  },
  timeoutMs: {
    hint: `${TRANSLATE_TIMEOUT_MIN}–${TRANSLATE_TIMEOUT_MAX} 的整数（毫秒）`,
    check: (v) => Number.isInteger(v) && v >= TRANSLATE_TIMEOUT_MIN && v <= TRANSLATE_TIMEOUT_MAX,
  },
};

/** 单个键的规范化（只做取值层面的整形，不做业务加工） */
function normalizeValue(key, v) {
  return typeof v === 'string' ? v.trim() : v;
}

/** 取值提示（`platform` 的是函数：注册表 id 注入后才可知，见 VALIDATORS） */
function hintOf(key) {
  const hint = VALIDATORS[key].hint;
  return typeof hint === 'function' ? hint() : hint;
}

/**
 * 解析一份设置对象。
 *
 * ## 🔴 两个方向的**不对称**是刻意的（与 engine-settings 同一判据）
 * | 来源 | 未知键 | 非法值 | 理由 |
 * |---|---|---|---|
 * | **补丁**（`strict: true`，来自 HTTP 请求体） | **抛错** | **抛错** | 它是**契约输入**。客户端发错键 = 客户端 bug，必须当场炸 |
 * | **文件**（`strict: false`，盘上那份 JSON） | 丢弃 + 上报 | 丢弃 + 上报 | 它是**持久化数据**。可能是别的版本或手工改的；为一个多余的键让整份设置失效，代价远大于收益 |
 *
 * 注意"丢弃 + 上报"**不是**静默：`unknownKeys` / `invalid` 会一路带到 `/translate/options`
 * 与启动日志，用户与诊断视图都看得见。
 *
 * @returns {{settings:object, unknownKeys:string[], invalid:Array<{key:string,must:string}>}}
 */
export function parseTranslateSettings(raw, { strict = false } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    const msg = `设置必须是一个 JSON 对象，收到 ${Array.isArray(raw) ? 'array' : typeof raw}`;
    if (strict) throw new TranslateSettingsError('INVALID_SETTING', msg, { received: raw });
    return { settings: {}, unknownKeys: [], invalid: [{ key: '(root)', must: '对象' }] };
  }

  const settings = {};
  const unknownKeys = [];
  const invalid = [];

  for (const [key, value] of Object.entries(raw)) {
    if (!TRANSLATE_SETTINGS_KEYS.has(key)) {
      if (strict) {
        throw new TranslateSettingsError('INVALID_SETTING',
          `未知设置项 ${JSON.stringify(key)} —— 不在白名单内（允许：${[...TRANSLATE_SETTINGS_KEYS].join(', ')}）`,
          { key, allowed: [...TRANSLATE_SETTINGS_KEYS] });
      }
      unknownKeys.push(key);
      continue;
    }
    if (!VALIDATORS[key].check(value)) {
      if (strict) {
        throw new TranslateSettingsError('INVALID_SETTING',
          `设置项 ${key} 取值非法（须为 ${hintOf(key)}）`, { key, value });
      }
      invalid.push({ key, must: hintOf(key) });
      continue;
    }
    settings[key] = normalizeValue(key, value);
  }

  return { settings, unknownKeys, invalid };
}

/**
 * 校验一个**补丁**（HTTP 请求体）。空补丁抛错 ——
 * 一个 `POST {}` 若返回 200「已保存」，那是最典型的假绿：什么都没写，却报"保存成功"。
 */
export function assertTranslatePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TranslateSettingsError('INVALID_SETTING',
      `请求体必须是对象，收到 ${Array.isArray(patch) ? 'array' : typeof patch}`, { received: patch });
  }
  if (Object.keys(patch).length === 0) {
    throw new TranslateSettingsError('INVALID_SETTING', '请求体为空，没有任何设置项', {});
  }
  return parseTranslateSettings(patch, { strict: true }).settings;
}

// ------------------------------------------------------------------ 读 / 写

/**
 * 读盘上那份设置。
 *
 * 文件不存在 = **正常的首次启动**（返回 `{}`，不是错误）；只有"存在但读不成"才是 `corrupt`。
 * 坏文件**原地保留、不搬走、不重命名**：证据比整洁重要，而这里的"修复"动作
 * （下一次保存）本来就会覆盖它。
 */
export function readTranslateSettings({ file }) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { settings: {}, exists: false, corrupt: false, reason: null, unknownKeys: [], invalid: [] };
    }
    return {
      settings: {}, exists: true, corrupt: true,
      reason: `${(err && err.code) || 'ERROR'}: ${err.message}`,
      unknownKeys: [], invalid: [],
    };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      settings: {}, exists: true, corrupt: true, reason: `JSON 解析失败：${err.message}`,
      unknownKeys: [], invalid: [],
    };
  }

  // 顶层形状不对（数组 / 字符串）也算坏文件 —— 但它能被"读懂"，所以 reason 要说清是哪一种
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      settings: {}, exists: true, corrupt: true,
      reason: `顶层应为 JSON 对象，实为 ${Array.isArray(raw) ? 'array' : typeof raw}`,
      unknownKeys: [], invalid: [],
    };
  }

  const parsed = parseTranslateSettings(raw, { strict: false });
  return { ...parsed, exists: true, corrupt: false, reason: null };
}

/**
 * 原子写：先写同目录下的临时文件、`fsync`、再 `rename` 覆盖。
 *
 * 🔴 为什么不能直接 `writeFileSync(file, …)`：`rename` 在 POSIX 上是**原子**的，
 *    而 `writeFileSync` 不是 —— 崩在中间会留下**半截 JSON**，下次启动就读成 `corrupt`，
 *    于是用户改了半天的设置被静默回退成默认值（而这条路径在正常退出下**永远测不到**）。
 * 临时文件名带 pid + 时间戳：两个进程同时写（理论上不该发生）也不会互相踩。
 * 权限 0600：设置里虽没有密钥，但"用户的本地偏好"也该只有本人可读。
 */
export function writeTranslateSettings({ file }, patch) {
  const clean = assertTranslatePatch(patch);

  const current = readTranslateSettings({ file });
  const merged = { ...current.settings, ...clean };

  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const body = `${JSON.stringify(merged, null, 2)}\n`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 尽力清理，不掩盖原始错误 */ }
    throw err;
  }

  return { settings: merged, changed: Object.keys(clean) };
}

/**
 * 环境变量 → 设置键的映射（**单位与文件一致**，不加换算）。
 *
 * 注意 `MIAO_YOUDAO_APP_KEY` / `MIAO_YOUDAO_APP_SECRET` **不在这张表里**：
 * 它们是密钥，走 `credentials.mjs`（方案 §8.3），没有理由进非密钥设置的读路径。
 */
const ENV_KEYS = {
  MIAO_TRANSLATE_PLATFORM: 'platform',
  MIAO_TRANSLATE_SOURCE: 'source',
  MIAO_TRANSLATE_TIMEOUT_MS: 'timeoutMs',
  MIAO_YOUDAO_LLM_MODEL: 'youdao.llmModel',
  MIAO_YOUDAO_TEXT_DOMAIN: 'youdao.textDomain',
  MIAO_YOUDAO_VOCAB_ID: 'youdao.vocabId',
};

/**
 * 把「出厂默认 + 盘上文件 + 环境变量」合并成**一份生效值**，并**逐个键记下来源**。
 *
 * ## 🔴 优先级：`env` > 文件 > 默认
 * 为什么 env 在最上面：环境变量在本项目里的角色是**验收与排障的强制覆盖**。
 * 若文件优先，本机跑过一次设置页之后，所有夹具都会**被用户偏好悄悄改写** ——
 * 那种失败极难归因（夹具自己没改任何东西，行为却变了）。反过来，用户不会去设
 * 环境变量，所以 env 优先不会干扰产品路径。
 *
 * ⚠️ **"来源"必须能被看见**：`/translate/options` 要回答"这个值谁定的"。
 *    一个只在日志里、界面上看不到的优先级，等于让用户对着一个他改不动的控件使劲点。
 *
 * @param {object} p
 * @param {{[k:string]: string|undefined}} p.env
 * @param {object} p.fileSettings  `readTranslateSettings().settings`
 * @returns {{settings:object, sources:object}}
 */
export function mergeWithEnv({ env = {}, fileSettings = {} } = {}) {
  const sources = {};
  const settings = {};

  // 先只解析 env（校验也在这一步：非法值当场抛，不静默回退到文件）
  const fromEnv = {};
  for (const [name, key] of Object.entries(ENV_KEYS)) {
    const raw = env[name];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = key === 'timeoutMs' ? Number.parseInt(String(raw), 10) : raw;
    if (!VALIDATORS[key].check(value)) {
      throw new TranslateSettingsError('INVALID_SETTING',
        `环境变量 ${name} 取值非法（须为 ${hintOf(key)}）：${JSON.stringify(raw)}`,
        { key, env: name, value: raw });
    }
    fromEnv[key] = normalizeValue(key, value);
  }

  const apply = (bag, source) => {
    for (const [key, value] of Object.entries(bag)) {
      settings[key] = value;
      sources[key] = source;
    }
  };

  apply(DEFAULT_SETTINGS, 'default');
  apply(fileSettings, 'file');
  apply(fromEnv, 'env');

  return { settings, sources };
}
