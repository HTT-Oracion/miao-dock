// 原子写 JSON —— 跨模块底座（manga / settings / translate 共用）。
//
// 🔴 为什么必须有它：`rename` 在 POSIX 与 Windows（MOVEFILE_REPLACE_EXISTING）上都是**原子**的，
//    而 `writeFileSync` 不是 —— 崩在中间会留下**半截 JSON**，下次启动就读成损坏，
//    于是"刚存的东西没了"且**在正常退出路径下永远测不到**。
//    本仓曾出现「设置原子写、任务状态却裸写」的不一致（见 D-139），故收口到一处。
//
// 临时文件名带 pid + 时间戳：两个进程同时写（理论上不该发生）也不会互相踩；
// 且与 `e2e/service/translate-check.mjs` 的残留扫描口径（`.tmp-`）一致。
import fs from 'node:fs';
import path from 'node:path';

/**
 * 原子写 JSON：同目录 tmp → fsync → rename 覆盖。
 * @param {string} file      目标文件（绝对路径）
 * @param {object} value     可 JSON 序列化的值
 * @param {{mode?:number, indent?:number}} [opts] mode 默认 0600；indent 默认 2
 * @returns {string} file
 */
export function atomicWriteJson(file, value, opts = {}) {
  const mode = opts.mode === undefined ? 0o600 : opts.mode;
  const indent = opts.indent === undefined ? 2 : opts.indent;
  return atomicWriteText(file, `${JSON.stringify(value, null, indent)}\n`, { mode });
}

/**
 * 原子写任意文本（JSON 之外的字节内容用调用方自己拼）。
 * 失败时**尽力清理 tmp 后原样抛出** —— 不掩盖原始错误。
 */
export function atomicWriteText(file, text, opts = {}) {
  const mode = opts.mode === undefined ? 0o600 : opts.mode;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 尽力清理，不掩盖原始错误 */ }
    throw err;
  }
  return file;
}
