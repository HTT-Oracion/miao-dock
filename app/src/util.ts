/** 展示层的小工具。纯函数，无副作用 —— 便于在「规格自检」里单独验证。 */

/** 人类可读容量。X-D1 副标题的「占 X GB」与左栏容量都走这里，保证两处口径一致 */
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

/** 「12 / 20」型计数：《02》§5.8 要求拆两个文本节点（数字 Inter Medium、斜杠与中文 Noto） */
export function formatCount(parts: (string | number)[]): string {
  return parts.join(' ');
}

/** `第12话 · 学园祭` 这类名字在本应用里是**原样显示**的（服务端已规范化） */
export function shortPath(p: string, max = 52): string {
  if (p.length <= max) return p;
  const head = p.slice(0, Math.ceil(max / 2) - 2);
  const tail = p.slice(-(Math.floor(max / 2) - 1));
  return `${head}…${tail}`;
}

/** 相对时间（「3 分钟前」），用于任务行的副标题 */
export function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  const s = Math.floor(diff / 1000);
  if (s < 60) return '刚刚';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 根据当前总张数给出分批建议（单次上限 20，契约 §5.2） */
export function splitBatches(files: string[], limit = 20): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < files.length; i += limit) out.push(files.slice(i, i + limit));
  return out;
}

/**
 * UUIDv4。
 *
 * 契约 §5.2 要求 `idempotencyKey` 是 UUIDv4。`crypto.randomUUID()` 只在安全上下文可用，
 * 而 WebView 的协议在不同平台/构建模式下不保证被判定为安全上下文，故这里带一条
 * 基于 `getRandomValues` 的兜底 —— 幂等键不能因为运行环境而拿不到。
 */
export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 从字节嗅探图片 MIME。
 *
 * 服务端返回的是**原始字节**（Rust 侧的二进制 IPC 通道不给 content-type），而 `<img src=blob:…>`
 * 在 blob 无类型时行为不稳定，故前端自己也嗅一次 —— 与契约 §8「嗅探 magic number」同一思路，
 * 只是这里的目的不是安全，而是让浏览器正确解码。
 */
export function sniffMime(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return 'application/octet-stream';
}
