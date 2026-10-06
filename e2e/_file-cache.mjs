/**
 * 反证轮增量化 —— 源文件内容的内存缓存 + 临时覆盖层。
 *
 * ## 为什么需要它（自测慢的根因）
 * 三个检查脚本的反证轮（--refute）主循环是「每条破坏 → 全量重读所有源文件 →
 * 全量重跑所有断言」，但每条破坏其实只验证它 `expect` 的那 1~2 条断言。
 * 实测：music 反证轮 167 条花了 83s，其中 readFileSync 递归读 `app/src` 数百文件
 * 是最大头（单次 walk ≈ 123ms × 167 条 ≈ 20s+，叠加多次 walk 与写盘还原）。
 *
 * ## 本模块怎么做
 * ① 缓存：所有读文件（单文件 / 目录遍历 / 样式分片）先查内存，miss 才落盘读一次。
 * ② 覆盖层：反证轮的「破坏」不再 writeFileSync 磁盘，而是往 override 表写一份
 *    「破坏后的内容」；断言读文件时 override 优先命中，读到破坏态。跑完清除覆盖。
 *
 * 于是反证轮**全程不写磁盘**、**每条只重读被破坏的那一个文件**，其余全命中缓存。
 * 语义不变：反证验证的是「断言能否捕捉到源代码内容的改变」，而不是「磁盘写入是否
 * 成功」—— 前者才是反证轮的目的，后者只会带来「没还原干净」的额外风险。
 *
 * ## 必须守住的前提（否则会假阴性）
 * 断言读取的所有路径都必须走本模块（readText / readBytes）。若某条断言直接
 * `readFileSync` 绕过缓存，override 破坏对它不可见，反证就会「该红不红」。
 * 改完脚本必须重跑一次 --refute 确认「全部按预期变红」—— 那是这条前提的守门员。
 */
import { readFileSync, existsSync } from 'node:fs';

/** 绝对路径 → 文本（缺文件存 ''） */
const textCache = new Map();
/** 绝对路径 → Buffer（缺文件不缓存，每次返回 null） */
const bytesCache = new Map();
/** 反证轮临时覆盖层：绝对路径 → { text, bytes }（优先于上面两个缓存命中） */
const overrides = new Map();

/** 读文本：覆盖层 → 缓存 → 磁盘 */
export function cachedReadText(p) {
  if (overrides.has(p)) return overrides.get(p).text;
  if (textCache.has(p)) return textCache.get(p);
  const v = existsSync(p) ? readFileSync(p, 'utf8') : '';
  textCache.set(p, v);
  return v;
}

/** 读字节：覆盖层 → 缓存 → 磁盘（缺文件返回 null） */
export function cachedReadBytes(p) {
  if (overrides.has(p)) return overrides.get(p).bytes;
  if (bytesCache.has(p)) return bytesCache.get(p);
  const v = existsSync(p) ? readFileSync(p) : null;
  if (v != null) bytesCache.set(p, v);
  return v;
}

/** 反证轮：临时覆盖某文件内容（内存态，不写磁盘）。text 传 null 清除单个覆盖。 */
export function overrideFile(p, text) {
  if (text == null) {
    overrides.delete(p);
    return;
  }
  overrides.set(p, { text, bytes: Buffer.from(text, 'utf8') });
}

/** 反证轮收尾：清空全部覆盖（回到磁盘真实内容） */
export function clearOverrides() {
  overrides.clear();
}
