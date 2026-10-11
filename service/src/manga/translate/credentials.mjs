// 翻译平台**密钥**层（`state/translate-credentials.json`，权限 0600）
// =============================================================================
// 依据：在线翻译服务设计方案 §8.3（密钥隔离）· §6.3（`POST /translate/credentials` 只写不读）。
//
// 三条硬纪律：
//   ① **独立文件**（不与 translate-settings.json 合并）：那份会被只读脚手架在模块顶层读，
//      密钥没有理由进那个读路径。分成两份，代价是一次 readFileSync，收益是传播面物理上更小。
//   ② **只写不读回显**：HTTP 面只回 `{ appKey, hasSecret }`，`credentialsView()` 永不吐 secret。
//   ③ 诊断脱敏：`details` 里出现密钥一律 `maskSecret()`（`sk-****` 形态，不泄露长度与内容）。
// 与 settings.mjs 同样**不 import config.mjs**（防 ESM 循环，路径由调用方传 `{ file }`）。

import fs from 'node:fs';
import path from 'node:path';

import { TranslateError } from './errors.mjs';
import { REFUTE } from './refute.mjs';

/** appSecret 长度上限（有道侧限制） */
const APP_SECRET_MAX = 128;

/** 盘上形状：`{ platforms: { <id>: { appKey, appSecret } } }` */
function emptyDoc() {
  return { platforms: {} };
}

/**
 * 读密钥文件。
 *
 * 文件不存在 = **正常的首次启动**（返回空 `{platforms:{}}`，不是错误）。
 * 🔴 本函数**会**带回 appSecret（签名要用它）—— "只写不读"约束的是**对外回显**面
 *    （`credentialsView`），不是内部签名路径。
 * @returns {{platforms:object, exists:boolean, corrupt:boolean, reason:string|null}}
 */
export function readCredentials({ file }) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ...emptyDoc(), exists: false, corrupt: false, reason: null };
    }
    return { ...emptyDoc(), exists: true, corrupt: true, reason: `${(err && err.code) || 'ERROR'}: ${err.message}` };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ...emptyDoc(), exists: true, corrupt: true, reason: `JSON 解析失败：${err.message}` };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
      || raw.platforms === null || typeof raw.platforms !== 'object' || Array.isArray(raw.platforms)) {
    return { ...emptyDoc(), exists: true, corrupt: true, reason: '顶层应为 { platforms: {...} } 形状' };
  }
  return { platforms: raw.platforms, exists: true, corrupt: false, reason: null };
}

/**
 * 写（合并）一个平台的密钥。原子写 0600。
 *
 * @param {object} p
 * @param {string} p.file
 * @param {object} patch
 * @param {string} patch.platform  平台 id（'youdao' …）
 * @param {string} patch.appKey    应用 ID（非密钥，可回显）
 * @param {string} patch.appSecret 应用密钥
 * @returns {{platform:string, view:object}} `view` 是**脱敏后**的全量视图（无 secret）
 */
export function writeCredentials({ file }, { platform, appKey, appSecret }) {
  if (typeof platform !== 'string' || platform.trim() === '') {
    throw new TranslateError('TRANSLATE_INVALID_INPUT', 'platform 不能为空', { field: 'platform' });
  }
  const key = typeof appKey === 'string' ? appKey.trim() : '';
  if (key === '') {
    throw new TranslateError('TRANSLATE_INVALID_INPUT', 'appKey 不能为空', { field: 'appKey' });
  }
  const secret = typeof appSecret === 'string' ? appSecret.trim() : '';
  if (secret === '') {
    throw new TranslateError('TRANSLATE_INVALID_INPUT', 'appSecret 不能为空', { field: 'appSecret' });
  }
  if (secret.length > APP_SECRET_MAX) {
    throw new TranslateError('TRANSLATE_INVALID_INPUT',
      `appSecret 超长（≤${APP_SECRET_MAX} 字符，收到 ${secret.length}）`, { field: 'appSecret' });
  }

  const current = readCredentials({ file });
  const merged = { platforms: { ...current.platforms, [platform.trim()]: { appKey: key, appSecret: secret } } };

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

  return { platform: platform.trim(), view: viewOf(merged.platforms) };
}

/**
 * 脱敏视图：`{ <id>: { appKey, hasSecret } }`。
 * 🔴 **永不回显 appSecret** —— 任何 GET / 响应 / 日志都走这里，没有第二个出口。
 * （`REFUTE.echoSecret` 是验收用的**逃生开关**：只在 `--refute` 子进程里置位，
 *   产品路径永不置位 —— 见 refute.mjs 头注。）
 */
export function credentialsView({ file }) {
  const doc = readCredentials({ file });
  return viewOf(doc.platforms);
}

function viewOf(platforms) {
  const view = {};
  for (const [id, entry] of Object.entries(platforms || {})) {
    const appKey = entry && typeof entry.appKey === 'string' ? entry.appKey : '';
    const hasSecret = !!(entry && typeof entry.appSecret === 'string' && entry.appSecret !== '');
    view[id] = REFUTE.echoSecret ? { appKey, hasSecret, appSecret: entry?.appSecret } : { appKey, hasSecret };
  }
  return view;
}

/**
 * 密钥脱敏：任何非空 secret 一律输出定长 `sk-****`。
 * 刻意**不**保留首尾字符：那等于把"前 2 位是什么"泄露出去，而定长形态对
 * 「日志里认出这里本该是密钥、但看不出是哪一把」已经够了。
 */
export function maskSecret(s) {
  return typeof s === 'string' && s !== '' ? 'sk-****' : '';
}
