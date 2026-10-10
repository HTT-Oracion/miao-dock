/**
 * 共享工具函数（纯函数，无副作用、不 import 业务层）—— 与 `components/` 同级。
 *
 * 放这里的判据：**跨屏可复用**且与业务类型解耦；只服务单个屏的逻辑仍留在屏内。
 * 纯函数便于在「规格自检」里单独验证。
 */

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
 * 模糊匹配的**命中下标**（指向**原串**，升序）；不命中返回 `null`；空查询返回 `[]`。
 *
 * 拆出这一条是因为搜索分组要「把匹配片段标成 `is-hit`」（设计稿 §7.2），
 * 而"命中与否"和"命中了哪几个字符"必须是**同一判定** —— 各写一份 `includes`，
 * 迟早出现"整行判为命中、却没有一个字被高亮"的矛盾帧。
 *
 * ## 为什么逐字符折叠大小写、而不是整串 `toLowerCase()`
 * 折叠**不保证长度不变**：`'İ'.toLowerCase()` 是 2 个 code unit。若拿整串折叠后的下标
 * 去切原文，从那个字符起的高亮整体错位 N 位 —— 而且只在含这类字符时出现，
 * 平时测不到。故逐字符折叠并把"折叠后位置 → 原串下标"记下来（`map`），
 * 高亮切分永远落在原串的真实边界上。
 */
export function matchIndices(text: string, query: string): number[] | null {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const map: number[] = [];
  let folded = '';
  for (let i = 0; i < text.length; i++) {
    const lc = text[i]!.toLowerCase();
    for (let k = 0; k < lc.length; k++) map.push(i);
    folded += lc;
  }
  const out: number[] = [];
  let i = 0;
  for (let j = 0; j < folded.length && i < q.length; j++) {
    if (folded[j] === q[i]) {
      out.push(map[j]!);
      i++;
    }
  }
  return i === q.length ? out : null;
}

/**
 * 模糊匹配（不区分大小写），用于漫画库搜索。
 *
 * 判定用**子序列**而不是简单 `includes`：漫画名动辄「第12话 · 学园祭」这种，
 * 用户只记得「12学」也应当能命中。子序列天然覆盖「连续子串」这一情形
 * （`includes` 命中 ⇒ 子序列必命中），所以不必再补测一次。
 *
 * 大小写折叠用 `toLowerCase()` 而非 `toLocaleLowerCase()`：后者在土耳其语等
 * locale 下把 `I` 折成 `ı`，同一份代码在不同机器上结果不同 —— 搜索不该有时区式差异。
 * 中文没有大小写，这一步只服务名字里的拉丁字母／罗马数字。
 *
 * 实现**委托**给 `matchIndices`：命中判定只有一处，不可能与高亮口径漂移。
 */
export function fuzzyMatch(text: string, query: string): boolean {
  return matchIndices(text, query) !== null;
}

/**
 * 仅用于**重名校验**的轻量规范化（防呆比对）。
 *
 * 权威规范化只在服务端执行（契约 §6），客户端**不**用它拼落盘路径 —— 这里只做
 * 「和库里的目录名像不像同一本」的近似比对：NFKC + 剥 Windows 非法字符 + 折叠空白。
 * 与服务端 `normalizeComicName` 同源起手，命中即拦；宁可偶尔多拦一次（提示用户），
 * 也不要因为口径差一点点就漏掉重复提交。
 */
export function dupKey(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 把数组切成定长页，返回第 `page`（1 起）页的内容；越界返回空数组 */
export function pageSlice<T>(items: T[], page: number, size: number): T[] {
  const start = (Math.max(1, page) - 1) * size;
  return items.slice(start, start + size);
}

/** 总页数（至少 1，避免出现「第 1 / 0 页」） */
export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
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

// ------------------------------------------------------------------ 话（本 → 话 → 页）

/**
 * 话目录名 → 话号：`01_第1话` ⇒ `1`；不是话目录则 `null`（**不猜**）。
 *
 * 必须与服务端 `manga/library.mjs` 的 `chapterNoFromDirName()` 同源同口径 ——
 * 前端这里只用于「渲染话号 / 给归并弹窗算默认值」，**权威解析仍在服务端**；
 * 但两侧正则一旦不同，就会出现"前端认得、服务端不认"的目录被判成「其它」。
 */
export function chapterNoOf(dirName: string): number | null {
  const m = /^(\d{2})_第(\d{1,3})话$/.exec(dirName);
  return m ? Number(m[2]) : null;
}

/**
 * 话号 → 目录名前缀：`1` ⇒ `01`（两位零填充）。
 *
 * 零填充不是为了好看：目录按名字排序，`10_第10话` 若不填充就会排在 `2_第2话` 前面。
 * 与服务端 `chapterDirName()` 的填充位数**必须一致**，否则预览的目录名与落盘的目录名不同字。
 */
export function padChapterNo(no: number): string {
  return String(Math.max(0, Math.floor(no))).padStart(2, '0');
}

/**
 * 从封面路径取**文件名**（`cover.png`）。
 *
 * 存在的理由：服务端给的 `coverPath` 是路径（历史实现里是绝对路径，将来可能是相对路径），
 * 而 `manifest.json` 的 `cover` 字段存的是**文件名**（D-115 §3 —— 随目录迁移，
 * 存绝对路径一搬家就失效）。要展示"将写入 cover.png"，就得先剥掉目录部分。
 */
export function coverFileName(p: string | null | undefined): string | null {
  if (!p) return null;
  const base = p.split(/[\\/]/).pop() ?? '';
  return base || null;
}

/**
 * 搜索分组用的「话」最小结构（**结构化传参**）。
 *
 * 为什么在这里重新声明而不 import `@/types` 的 `ChapterEntry`：
 * `tools/` 是共享纯函数层，纪律是**不与业务类型耦合**（AGENTS §1 / project_rules §39）。
 * `ChapterEntry` 与它**结构兼容**，所以调用点直接传即可，两边都不需要断言或转换。
 */
export interface SearchChapter {
  no: number | null;
  dirName: string;
  imageCount: number;
  translatedCount: number;
  seqMax: number;
  translatedSeqs: number[];
  missingSeqs: number[];
}

/** 搜索分组用的「本」最小结构 */
export interface SearchBook<T extends SearchChapter = SearchChapter> {
  bookName: string;
  author: string;
  chapters: T[];
}

/** 搜索结果里的一行 */
export interface SearchRow<T extends SearchChapter = SearchChapter> {
  /** 稳定 key（React key 与「归并」动作的定位都用它） */
  key: string;
  /** 行主文案：已归并 `第 N 话`；未归并 `[单话] <目录名>` */
  label: string;
  /** 话号；未归并单话为 `null` */
  no: number | null;
  /** 点这一行要选中的漫画名（已归并 = 所属大类；未归并 = 它自己） */
  bookName: string;
  /** 行尾是否出现「归并」（仅未归并单话为 `true`） */
  mergeable: boolean;
  /**
   * 这一行代表的对象**本身**（供行尾状态短语复用 `progressLabel`）。
   *
   * 泛型参数 `T` 是有用的：调用方传 `ChapterEntry[]` 时这里就是 `ChapterEntry`，
   * 于是"点归并"能直接把原对象交给弹窗，不必再按目录名回查一次。
   */
  target: T;
  /** 这一行**自身**是否命中；`false` = 因所属大类命中而被整组带出 */
  hit: boolean;
}

/** 搜索结果分组 */
export interface SearchGroup<T extends SearchChapter = SearchChapter> {
  /** 分组键：大类用 `bookName`；「其它」用固定的 `__others__` */
  key: string;
  /** 组标题：大类 `《书名》`；「其它」`其它` */
  title: string;
  /** `true` = 已归并大类分组；`false` = 「其它」聚合分组 */
  merged: boolean;
  rows: SearchRow<T>[];
}

/** 「其它」分组的固定键（**不参与**与书名排序，永远置底） */
const OTHERS_GROUP_KEY = '__others__';

/**
 * 把「大类 + 未归并单话」切成搜索结果分组（设计稿 §7.2 / §8.1）。
 *
 * ## 分组口径
 * - 每个大类一个分组，标题 `《书名》`；全部未归并单话聚成**一个**「其它」分组，**恒置底**；
 * - 一名两义在这里被拆开：大类的「本」是分组标题，组内列的是**话**。
 *
 * ## 命中口径（决定「整组展开」还是「只列命中的话」）
 * - **本命中**（书名或作者）⇒ 该组**全部话**都列出（用户搜的是这一本，他需要看到它有几话）；
 * - **仅话命中**（`第N话` 或目录名）⇒ 只列命中的话；
 * - 两者都不命中 ⇒ 该分组整个不出现。
 *
 * ## 排序
 * 本命中(2) 排在仅话命中(1) 之后？—— 不，**本命中优先**（权重 2 > 1）；
 * 同权重按「命中行数多的在前」，再按书名（`zh-Hans-CN`）升序；「其它」不参与，固定最后一组。
 *
 * `query` 为空串时等价于"全部命中"：所有大类整组展开，与本函数的分组口径保持一致 ——
 * 于是调用方不必为"空搜索"单独写一条渲染分支。
 */
export function groupSearchResults<T extends SearchChapter>(
  books: SearchBook<T>[],
  others: T[],
  query: string,
): SearchGroup<T>[] {
  const q = query.trim();
  const scored: { group: SearchGroup<T>; weight: number; rows: number; name: string }[] = [];

  for (const b of books) {
    const nameHit = fuzzyMatch(b.bookName, q) || fuzzyMatch(b.author ?? '', q);
    const matched = b.chapters.filter((c) => chapterHit(c, q));
    if (!nameHit && matched.length === 0) continue;
    const rows = (nameHit ? b.chapters : matched).map((c) => chapterRow(b.bookName, c, q));
    scored.push({
      group: { key: b.bookName, title: `《${b.bookName}》`, merged: true, rows },
      weight: nameHit ? 2 : 1,
      rows: rows.filter((r) => r.hit).length,
      name: b.bookName,
    });
  }

  scored.sort(
    (a, z) =>
      z.weight - a.weight ||
      z.rows - a.rows ||
      a.name.localeCompare(z.name, 'zh-Hans-CN'),
  );

  const groups = scored.map((s) => s.group);

  const otherRows = others.filter((c) => chapterHit(c, q)).map((c) => chapterRow(c.dirName, c, q));
  if (otherRows.length > 0) {
    groups.push({
      key: OTHERS_GROUP_KEY,
      title: '其它',
      merged: false,
      rows: otherRows,
    });
  }
  return groups;
}

/** 一话是否命中：按 `第N话` 与目录名分别试（未归并单话没有话号，只试目录名） */
function chapterHit(c: SearchChapter, q: string): boolean {
  if (fuzzyMatch(c.dirName, q)) return true;
  return c.no === null ? false : fuzzyMatch(`第${c.no}话`, q);
}

/** 把一话包成一行；`ownerName` 为行尾归属的漫画名（已归并 = 大类名；未归并 = 它自己） */
function chapterRow<T extends SearchChapter>(ownerName: string, c: T, q: string): SearchRow<T> {
  const merged = c.no !== null;
  return {
    key: merged ? `${ownerName}/${c.dirName}` : c.dirName,
    label: merged ? `第 ${c.no} 话` : `[单话] ${c.dirName}`,
    no: c.no,
    bookName: ownerName,
    mergeable: !merged,
    target: c,
    hit: chapterHit(c, q),
  };
}
