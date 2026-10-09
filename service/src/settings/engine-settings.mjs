// 引擎可调设置的**持久化层** —— 设置页「推理引擎 / 模型与诊断」两小节的落盘真相
// =============================================================================
// 契约依据：
//   《09》§4.3 ② 翻译服务 10 项（三小节）· §6.2 引擎诊断视图 · §6.3 内存预算
//   《02》§5   逐项控件形态（档位单选 / 后端下拉含「自动」/ 空闲卸载是**数字（分钟）**，
//             0 = 从不卸载；模型目录 = 路径）
//   《04》§7.2/§7.3 档位映射与加速后端 · §9.1 两级空闲卸载
//
// ## 为什么单独成文件（而不是塞进 config.mjs）
// `config.mjs` 是**环境变量 → 运行期常量**的单向翻译层：它读 `process.env`，产出不可变常量。
// 而这里要处理的是「**用户**在界面上改过的值」，它有三个 config 没有的性质：
//   ① 会**写盘**（用户点一下就要留下痕迹）；② 会被**并发读**（`/health` 与 `/engine/options`
//      都要读它）；③ 输入**不可信**（用户/别的版本写进来的键可能是拼错的）。
// 把它并进 config.mjs，那条"顶层只有常量"的性质就没了，而 config.mjs 被所有验收脚本
// 在模块顶层 import —— 一个会写盘的顶层层级是没法在只读脚本里安全复用的
// （`print-launch-plan.mjs` 的文件头就明写了"打印配方是只读操作，不该有落盘副作用"）。
//
// ## 🔴 本模块**不 import `config.mjs`**（有意为之）
// `config.mjs` 需要 import 本模块来合并"用户设置 + 环境变量"；若本模块反过来 import 它，
// 就形成 ESM 循环。循环在这里**不是理论风险**：`STATE_DIR` 是 config 顶层的 const，
// 一旦求值顺序变成"engine-settings 先求值"，拿到的就是 TDZ 里的未初始化绑定。
// ⇒ 路径由调用方传进来（`{ file }`），本模块对所有输入都是**纯参数**。
//   唯一调用方是 `config.mjs`（以及验收脚本传自己的临时文件），所以"同源"依然成立：
//   「谁说了算」这件事只有一处实现，只是把路径的**来源**留给了调用方。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 允许持久化的键（**白名单**）。
 *
 * 🔴 白名单的意义不是"防注入"，而是**防拼错**：`idleLlmMinutes`（多写 utes）、
 *    `idle_llm_min`（snake_case）、`tier2` 这类键如果被**静默丢弃**，用户看到的是
 *    「设置保存成功」，而实际什么都没变 —— 这正是本项目最反对的那类假绿
 *    （界面说改了、事实没改，且**没有任何一处会报错**）。
 *    ⇒ 写路径上一律**拒绝**（见 `assertPatch`），不静默丢。
 *    ⇒ 读路径（盘上的文件）相反：见 `parseEngineSettings` 的注释。
 */
export const ENGINE_SETTINGS_KEYS = new Set([
  'tier', 'accel', 'idleLlmMin', 'idleVisionMin', 'modelDir',
]);

/** 档位取值（与 `engine-profile.mjs` 的 `TIERS` 同集合；此处重复一遍是为了不让本模块依赖那个文件） */
export const ENGINE_TIER_VALUES = ['tiny', 'small', 'medium'];
/** 加速后端取值：`auto` = 按《04》§7.4 顺序探测，其余为**用户指定** */
export const ENGINE_ACCEL_VALUES = ['auto', 'cuda', 'mps', 'cpu'];
/** 空闲卸载阈值的上限（分钟）。24h —— 再大就不像"空闲卸载"而像"忘关了"，多半是输错了 */
export const IDLE_MIN_MAX = 1440;

/**
 * 改完**必须重启引擎**才生效的键（《09》§4.3 末句：「改档位/后端/模型目录需重启引擎，
 * 小节下方给提示条」）。界面据此决定要不要亮那条提示；服务端据此算 `restartRequired`。
 *
 * 🔴 两个空闲卸载阈值**待遇不同**，这不是随手定的：
 *   · `idleLlmMin` —— **不在**这一组。Tier1（③ LLM）的归属方就是 box-service 自己
 *     （《04》§9.1），阈值由空闲看护每 tick 现读 ⇒ 保存后**重建看护即立刻生效**，
 *     让用户为一个纯策略数字等一次几十秒的引擎冷启动，纯属自找。
 *   · `idleVisionMin` —— **在**这一组。Tier2（视觉模型）的执行方是**引擎自己**
 *     （它自带的 `--models-ttl`），那个数字在**拉开进程的那一刻**就固化了。
 *     不重启就生效是不可能的；不告诉用户，他看到的就是"改了没反应"。
 *   ⇒ 结论：同一小节里的两个数字，一个即时、一个要重启。把它们一视同仁地
 *     要么都即时、要么都重启，两边都会出错（前者是假控件，后者是无谓的等待）。
 */
export const RESTART_REQUIRED_KEYS = new Set(['tier', 'accel', 'modelDir', 'idleVisionMin']);

export class EngineSettingsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EngineSettingsError';
    this.code = code;
    this.details = details;
  }
}

// ------------------------------------------------------------------ 取值校验

/** 绝对路径、非根、非用户主目录本身 —— 三样都是"往这里放 5 GB 权重"的实际护栏 */
function isUsableModelDir(v) {
  if (typeof v !== 'string' || v.trim() === '') return false;
  if (!path.isAbsolute(v)) return false;
  const abs = path.resolve(v);
  if (abs === path.parse(abs).root) return false; // '/' 或 'C:\'
  if (abs === path.resolve(os.homedir())) return false;
  return true;
}

const VALIDATORS = {
  tier: {
    hint: `可选：${ENGINE_TIER_VALUES.join(' | ')}`,
    check: (v) => ENGINE_TIER_VALUES.includes(v),
  },
  accel: {
    hint: `可选：${ENGINE_ACCEL_VALUES.join(' | ')}（auto = 按硬件探测）`,
    check: (v) => ENGINE_ACCEL_VALUES.includes(v),
  },
  idleLlmMin: {
    hint: `0–${IDLE_MIN_MAX} 的整数（分钟），0 = 从不卸载`,
    check: (v) => Number.isInteger(v) && v >= 0 && v <= IDLE_MIN_MAX,
  },
  idleVisionMin: {
    hint: `0–${IDLE_MIN_MAX} 的整数（分钟），0 = 从不卸载`,
    check: (v) => Number.isInteger(v) && v >= 0 && v <= IDLE_MIN_MAX,
  },
  modelDir: {
    hint: '绝对路径（不能是文件系统根目录，也不能是用户主目录本身）',
    check: isUsableModelDir,
  },
};

/** 单个键的规范化（只做取值层面的整形，不做业务加工） */
function normalizeValue(key, v) {
  if (key === 'modelDir') return path.resolve(String(v).trim());
  return v;
}

/**
 * 解析一份设置对象。
 *
 * ## 🔴 两个方向的**不对称**是刻意的
 * | 来源 | 未知键 | 非法值 | 理由 |
 * |---|---|---|---|
 * | **补丁**（`strict: true`，来自 HTTP 请求体） | **抛错** | **抛错** | 它是**契约输入**。客户端发错键 = 客户端 bug，必须当场炸 |
 * | **文件**（`strict: false`，盘上那份 JSON） | 丢弃 + 上报 | 丢弃 + 上报 | 它是**持久化数据**。可能是别的版本或手工改的；为一个多余的键让整份设置失效，代价远大于收益 |
 *
 * 注意"丢弃 + 上报"**不是**静默：`unknownKeys` / `invalid` 会一路带到 `/engine/options`
 * 与启动日志，用户与诊断视图都看得见。
 *
 * @returns {{settings:object, unknownKeys:string[], invalid:Array<{key:string,must:string}>}}
 */
export function parseEngineSettings(raw, { strict = false, allowUnknown = false } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    const msg = `设置必须是一个 JSON 对象，收到 ${Array.isArray(raw) ? 'array' : typeof raw}`;
    if (strict) throw new EngineSettingsError('INVALID_SETTING', msg, { received: raw });
    return { settings: {}, unknownKeys: [], invalid: [{ key: '(root)', must: '对象' }] };
  }

  const settings = {};
  const unknownKeys = [];
  const invalid = [];

  for (const [key, value] of Object.entries(raw)) {
    if (!ENGINE_SETTINGS_KEYS.has(key)) {
      if (strict && !allowUnknown) {
        throw new EngineSettingsError('INVALID_SETTING',
          `未知设置项 ${JSON.stringify(key)} —— 不在白名单内（允许：${[...ENGINE_SETTINGS_KEYS].join(', ')}）`,
          { key, allowed: [...ENGINE_SETTINGS_KEYS] });
      }
      unknownKeys.push(key);
      continue;
    }
    if (!VALIDATORS[key].check(value)) {
      if (strict) {
        throw new EngineSettingsError('INVALID_SETTING',
          `设置项 ${key} 取值非法（须为 ${VALIDATORS[key].hint}）`, { key, value });
      }
      invalid.push({ key, must: VALIDATORS[key].hint });
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
export function assertPatch(patch, { allowUnknown = false } = {}) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new EngineSettingsError('INVALID_SETTING',
      `请求体必须是对象，收到 ${Array.isArray(patch) ? 'array' : typeof patch}`, { received: patch });
  }
  if (Object.keys(patch).length === 0) {
    throw new EngineSettingsError('INVALID_SETTING', '请求体为空，没有任何设置项', {});
  }
  return parseEngineSettings(patch, { strict: true, allowUnknown }).settings;
}

// ------------------------------------------------------------------ 读 / 写

/**
 * 读盘上那份设置。
 *
 * 文件不存在 = **正常的首次启动**（返回 `{}`，不是错误）；只有"存在但读不成"才是 `corrupt`。
 * 坏文件**原地保留、不搬走、不重命名**：证据比整洁重要，而这里的"修复"动作
 * （下一次保存）本来就会覆盖它。调用方据 `corrupt` 决定怎么喊。
 */
export function readEngineSettings({ file }) {
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

  const parsed = parseEngineSettings(raw, { strict: false });
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
export function writeEngineSettings({ file }, patch, { allowUnknown = false } = {}) {
  const clean = assertPatch(patch, { allowUnknown });

  const current = readEngineSettings({ file });
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

  const changed = Object.keys(clean);
  return {
    settings: merged,
    changed,
    restartRequired: changed.some((k) => RESTART_REQUIRED_KEYS.has(k)),
  };
}

/**
 * 把"盘上设置"与"环境变量"合并成**一份生效值**，并**逐个键记下来源**。
 *
 * ## 🔴 优先级：`env` > 文件 > 默认（由调用方给）
 * 为什么 env 在最上面：环境变量在本项目里的角色是**验收与排障的强制覆盖**
 * （`MIAO_ENGINE_TIER=small` 让 e5e6 那条"降档有空间可降"的回路可跑）。
 * 若文件优先，本机跑过一次设置页之后，所有夹具都会**被用户偏好悄悄改写** ——
 * 那种失败极难归因（夹具自己没改任何东西，行为却变了）。
 * 反过来，用户不会去设环境变量，所以 env 优先不会干扰产品路径。
 *
 * ⚠️ **"来源"必须能被看见**：`/engine/options` 要回答"这个值谁定的"。
 *    一个只在日志里、界面上看不到的优先级，等于让用户对着一个他改不动的控件使劲点。
 *
 * @param {object} p
 * @param {{[k:string]: string|undefined}} p.env
 * @param {object} p.fileSettings  `readEngineSettings().settings`
 * @returns {{settings:object, sources:object}}
 */
/**
 * 环境变量 → 设置键的映射（**单位与文件一致**，不加换算）。
 *
 * ⚠️ `idleVisionMin` **刻意不在表里**：它的环境变量是 `MIAO_ENGINE_MODELS_TTL`，
 *    单位是**秒**（见 `envVisionTtlSec`）。把两种单位的同名语义塞进一张表，
 *    就是给"1800 秒 vs 1800 分钟"这类事故留门。
 */
const ENV_KEYS = {
  MIAO_ENGINE_TIER: 'tier',
  MIAO_ENGINE_ACCEL: 'accel',
  MIAO_IDLE_LLM_MIN: 'idleLlmMin',
  MIAO_MODEL_ROOT: 'modelDir',
};

export function mergeWithEnv({ env = {}, fileSettings = {}, envLast = false } = {}) {
  const sources = {};
  const settings = {};

  // 先只解析 env（校验也在这一步：非法值当场抛，不静默回退到文件）
  const fromEnv = {};
  for (const [name, key] of Object.entries(ENV_KEYS)) {
    const raw = env[name];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = key === 'idleLlmMin' ? Number.parseInt(String(raw), 10) : raw;
    const rule = VALIDATORS[key];
    if (!rule.check(value)) {
      throw new EngineSettingsError('INVALID_SETTING',
        `环境变量 ${name} 取值非法（须为 ${rule.hint}）：${JSON.stringify(raw)}`, { key, env: name, value: raw });
    }
    fromEnv[key] = normalizeValue(key, value);
  }

  const apply = (bag, source) => {
    for (const [key, value] of Object.entries(bag)) {
      settings[key] = value;
      sources[key] = source;
    }
  };

  // 正常顺序：文件先铺、env 后盖（env 优先）。
  // `envLast` 把两者倒过来 —— 这是**反证开关**，用来证明「env 优先」这条断言
  // 咬的确实是优先级本身，而不是"恰好两边同值"（见 config.settingsRefute.envLast）。
  if (envLast) {
    apply(fromEnv, 'env');
    apply(fileSettings, 'file');
  } else {
    apply(fileSettings, 'file');
    apply(fromEnv, 'env');
  }

  return { settings, sources };
}

/**
 * 环境变量里的**秒** → 分钟（`MIAO_ENGINE_MODELS_TTL`，视觉档空闲卸载）。
 *
 * 🔴 单独一支而不是塞进 `mergeWithEnv`：它的单位是**秒**、且历史上就是秒
 *   （`resolveEngineLaunch` 对 `modelsTtl` 的 push 就是秒）。硬把它按分钟解析，
 *   会让 `MIAO_ENGINE_MODELS_TTL=1800` 从「30 分钟」变成「1800 分钟 = 30 小时」——
 *   一个**看起来还在跑、实际再也不卸载**的静默故障。
 * @returns {number|null} 秒；未设置返回 null
 */
export function envVisionTtlSec(env = {}) {
  const raw = env.MIAO_ENGINE_MODELS_TTL;
  if (raw === undefined || raw === '') return null;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new EngineSettingsError('INVALID_SETTING',
      `MIAO_ENGINE_MODELS_TTL 取值非法：${JSON.stringify(raw)}（应为 ≥0 的整数秒）`, { value: raw });
  }
  return n;
}
