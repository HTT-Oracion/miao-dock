/**
 * 样式源读取 —— 三个检查脚本统一从这里拿「样式全文」。
 *
 * ## 为什么不能继续直接读 app.css
 * `app.css` 已按模块拆成 `base / app / manga / settings / components / music` 六个分片，
 * 顺序由 `index.scss` 的 `@use` 决定（**顺序即层叠**，规则见《09》§2.4）。
 * 断言若写死读单个文件，拆分后会集体变红 —— 那是「读不到文件」，**不是真回归**。
 *
 * 本模块按 `index.scss` 的声明顺序拼接全部分片，产出与拆分前**等价**的单一文本，
 * 于是 20+ 处判据（`match` / `includes` / `stripComments`）**一行都不用改**。
 *
 * ## 拼接顺序为什么必须读 index.scss 而不能按文件名排
 * CSS 同特异性下靠后定义者胜，分片顺序就是层叠顺序。
 * 拼接顺序若与 `index.scss` 不一致，判据就可能在"错误的规则"上取块。
 * 所以唯一事实源是 `index.scss`，本模块只忠实执行它的声明顺序。
 *
 * ## 缺文件时为什么不抛错（这一条改过一次，别改回去）
 * 初版对「分片缺失」直接抛错，理由是"空串会被误读成产品缺陷"。**错的** ——
 * 抛错有两个实际后果：① 诊断信息被抹掉，明明 `STYLE.shardsRegistered` 能精确报出
 * 「index.scss @use 了 'base.css'，但 styles/ 下没有 base.css」，却只剩一句
 * 文件不存在；② 反证轮会**整体崩溃**（`STYLE.entryIsScss` 那条反证就是故意把
 * 入口指回 .css 来验证它会变红，抛错直接让 refute 轮带着 Exception 收场，
 * 分母都没机会被核对）。
 * 所以：**入口缺失才抛错**（那是环境没配好，断言无意义），**分片缺失只留哨兵**
 * （哨兵是注释，stripComments 后不留痕迹，不会让别的断言误判），
 * 真正的诊断交给 `STYLE.shardsRegistered`。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { cachedReadText } from './_file-cache.mjs';

/** styles 目录（三个脚本各自的路径不同，故由调用方传入） */
export const STYLES_DIR = path.join('app', 'src', 'styles');

/** 入口文件名 —— 顺序即层叠 */
export const ENTRY = 'index.scss';

/**
 * 从 index.scss 里按声明顺序取出 @use 的目标文件名。
 * 只取 `@use 'xxx'`（相对路径、同一目录）；忽略 @use 的命名空间写法（本项目不写）。
 */
export function styleEntryOrder(stylesDir) {
  const entry = path.join(stylesDir, ENTRY);
  if (!existsSync(entry)) {
    throw new Error(
      `样式入口不存在：${entry}\n`
      + '样式只经 index.scss 一个入口（见《09》§2.4）。若确实要改入口文件名，'
      + '请同步改本模块的 ENTRY 与三个检查脚本的引用。',
    );
  }
  const src = cachedReadText(entry);
  // 剥注释，避免注释里举例用的 @use 被当成真声明
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  for (const m of code.matchAll(/@use\s+['"]([^'"]+)['"]/g)) {
    out.push(m[1]);
  }
  if (out.length === 0) {
    throw new Error(`${entry} 里没有任何 @use 声明 —— 样式入口失效，断言会读到空串。`);
  }
  return out;
}

/**
 * 按 index.scss 声明顺序拼接全部样式分片，返回单一文本。
 *
 * 缺的分片用**哨兵注释**占位而不是抛错（理由见文件头）：哨兵会被判据的
 * stripComments 剥掉，不会让无关断言误判；真正该报红的是 STYLE.shardsRegistered。
 *
 * @param {string} stylesDir 绝对路径，例：`<repo>/app/src/styles`
 * @returns {string} 拼接结果；各分片之间以换行分隔（避免末行注释粘连到下一段选择器）
 */
export function readStyleSource(stylesDir) {
  const parts = [];
  for (const rel of styleEntryOrder(stylesDir)) {
    const file = path.join(stylesDir, rel);
    if (!existsSync(file)) {
      parts.push(`/* __MISSING_SHARD__ ${rel} —— 由 STYLE.shardsRegistered 报红 */`);
      continue;
    }
    parts.push(cachedReadText(file));
  }
  return parts.join('\n');
}
