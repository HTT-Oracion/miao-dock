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

  // sidecar（引擎）地址：契约 §1「端口自动探测，默认 5003」
  enginePort: envInt('MIAO_ENGINE_PORT', 5003),
  engineHost: '127.0.0.1',
  // 单张翻译超时（引擎无响应时按失败处理，避免任务卡死）
  engineTimeoutMs: envInt('MIAO_ENGINE_TIMEOUT_MS', 60_000),
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
