/**
 * 人类可读容量 —— **副本**，与主工程 `src/tools/index.ts` 的 `formatBytes` 同口径。
 *
 * 为什么复制：卸载页是独立程序，不 import 主工程；而"体积"这件事
 * （三类数据的行尾大小、完成页的汇总）必须在**同一个换算规则**下显示，
 * 否则两处对同一个数字给出不同位数，用户会以为是两个不同的量。
 */

/** 字节数 → `312 MB` / `1.20 GB`；非正数与 NaN 一律 `0 B` */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}
