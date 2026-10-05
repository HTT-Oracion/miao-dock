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

const SRC_DIR = import.meta.dirname; // .../service/src
export const PKG_DIR = path.resolve(SRC_DIR, '..'); // .../service

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

export const STATE_DIR = path.resolve(process.env.MIAO_STATE_DIR || defaultStateDir());
export const TASKS_STATE_DIR = path.join(STATE_DIR, 'tasks');
export const IDEMPOTENCY_FILE = path.join(STATE_DIR, 'idempotency.json');
export const TOKEN_FILE = path.join(STATE_DIR, 'token');

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
  engineTimeoutMs: envInt('MIAO_ENGINE_TIMEOUT_MS', ENGINE_PROTOCOL === 'real' ? 600_000 : 60_000),
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
    detector: { detector: process.env.MIAO_ENGINE_DETECTOR || 'default' },
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
  enginePython: process.env.MIAO_ENGINE_PYTHON
    || path.resolve(PKG_DIR, '..', 'runtimes', 'manga-translator', 'venv', 'bin', 'python'),
  engineUseGpu: envBool('MIAO_ENGINE_USE_GPU', true),
  // Tier 2 空闲卸载（《04》§9.1）：引擎自带 `--models-ttl 1800`（30 min）
  engineModelsTtl: envInt('MIAO_ENGINE_MODELS_TTL', 1800),
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
  // 引擎③（Sakura LLM）地址：`translators/keys.py` 的 `SAKURA_API_BASE` 默认值即此
  engineSakuraBase: process.env.SAKURA_API_BASE || 'http://127.0.0.1:8080/v1',
};

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
  return [
    path.parse(path.resolve('/')).root, // '/'（Windows 下为 'C:\\'）
    '/Users',                           // home 的父目录：本身不可作落盘根
    home,                               // 用户主目录本身（§8.2「用户主目录本身」）
    '/private',                         // TMPDIR 的真实父目录，本身不可作落盘根
    '/private/var',
    '/var',                             // → /private/var
  ];
};

const BLACKLIST_PREFIX = () => {
  const home = os.homedir();
  return [
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
