// 漫画库「本 → 话 → 页」三层的**落盘原语**（契约冻结见 docs/spec-notes.md D-115）。
//
// 为什么单开一个模块：页级扫描、目录命名、manifest 读写与封面落盘这四件事，在
// `server.mjs`（扫描与端点）与将来可能的批量导入之间是**共用的**。写成一份、
// 多调用点，才不会出现「这里校验、那里没校验」的漂移（照抄 `_writeOriginal` 的纪律）。
//
// 本模块是**产品代码**（服务运行期会用到），不是 e2e 夹具，故留在 `service/src/manga/`。
import fs from 'node:fs';
import path from 'node:path';

import {
  CHAPTER_DIR_RE, COVER_RE, MANIFEST_FILE, ORIGINAL_SCAN_RE, TRANSLATED_SCAN_RE, assertInsideRoot,
} from '../config.mjs';

/** ISO 秒级时间戳（与全仓 `scanLibrary` / `updatedAt` 口径一致：去掉毫秒） */
function isoOf(ms) {
  return ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

// ------------------------------------------------------------------ 命名

/** 话号 → 目录名：`NN_第N话`（两位零填充 ⇒ 文件系统自然序 == 话序） */
export function chapterDirName(no) {
  return `${String(no).padStart(2, '0')}_第${no}话`;
}

/** 目录名 → 话号；不匹配返回 null（不猜） */
export function chapterNoFromDirName(dirName) {
  const m = CHAPTER_DIR_RE.exec(dirName);
  return m ? Number(m[2]) : null;
}

// ------------------------------------------------------------------ manifest

/** 新建大类时的初始 manifest */
export function defaultManifest(bookName) {
  return { schema: 1, title: bookName, author: '', cover: null, episodes: [] };
}

/** `manifest.json` 是否存在 —— **大类判定的唯一判据**（D-115 §1，看存在性而非可解析性） */
export function hasManifest(bookDir) {
  try {
    return fs.statSync(path.join(bookDir, MANIFEST_FILE)).isFile();
  } catch {
    return false;
  }
}

/**
 * 读 `manifest.json`，**容错**：文件缺失 / 坏 JSON / 形状不对 ⇒ 回落成安全默认值。
 *
 * 坏 JSON 的目录**仍按大类处理**（判据是存在性）—— 否则一个手抖写坏的 manifest
 * 会让整本从 `books` 掉进「其它」，用户看到的是「我的漫画没了」，归因只能靠猜。
 */
export function readManifest(bookDir, bookName = path.basename(bookDir)) {
  const base = defaultManifest(bookName);
  let raw = null;
  try {
    raw = fs.readFileSync(path.join(bookDir, MANIFEST_FILE), 'utf8');
  } catch {
    return base;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return base;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base;
  const episodes = Array.isArray(parsed.episodes)
    ? parsed.episodes
      .filter((e) => e && typeof e === 'object' && Number.isInteger(e.no) && typeof e.dir === 'string')
      .map((e) => ({ no: e.no, dir: e.dir }))
    : [];
  return {
    schema: 1,
    title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title : bookName,
    author: typeof parsed.author === 'string' ? parsed.author : '',
    cover: typeof parsed.cover === 'string' && COVER_RE.test(parsed.cover) ? parsed.cover : null,
    episodes,
  };
}

/**
 * 原子写 manifest：**同目录 tmp + renameSync**。
 *
 * 为什么必须原子：`scanLibrary` 只要读到一次半截 JSON，那一本就会掉进「其它」
 * （见 `readManifest` 的容错说明——虽然现在坏 JSON 仍按大类算，但半截文件同样会让
 * 封面/author 回落到默认值，用户看到的是「刚存的信息没了」）。
 * 同目录 rename 在 POSIX 与 Windows 上都是原子的（Windows 走 MOVEFILE_REPLACE_EXISTING）。
 */
export function writeManifestAtomic(bookDir, manifest) {
  const target = path.join(bookDir, MANIFEST_FILE);
  const tmp = path.join(bookDir, `${MANIFEST_FILE}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return target;
}

// ------------------------------------------------------------------ 话目录

/**
 * 列出大类目录内的话（**以目录为准**，不看 `episodes[]`）。
 *
 * 「目录即索引」要求位置是权威：`episodes[]` 只是随目录一起走的说明文字，
 * 手改或漏改它不该影响「这本有哪些话」这个事实。
 */
export function listChapterDirs(bookDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(bookDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const no = chapterNoFromDirName(e.name);
    if (no === null) continue;
    out.push({ no, dirName: e.name, absDir: path.join(bookDir, e.name) });
  }
  out.sort((a, b) => a.no - b.no);
  return out;
}

// ------------------------------------------------------------------ 页级扫描（唯一入口）

/**
 * 页级扫描：一个「装页的目录」（单话目录 或 大类内的话目录）→ 页级汇总。
 *
 * 🔴 **不得抄第二份**：`scanLibrary` 的「单话」与「大类内的话」两条路共用本函数。
 * 口径沿用 G-01：`byteSize` = 目录内**所有文件**字节之和（含原图、译文与残留临时文件）。
 * 「哪一页已译」给的是**逐页集合**而非张数 —— 缺页落在中间时，张数推出来的结论会整体错位（G-10）。
 */
export function scanChapterPages(dir) {
  const originals = new Set();
  const translated = new Set();
  let byteSize = 0;
  let modifiedMs = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    /* 目录不存在 → 空目录 */
  }
  for (const f of entries) {
    let m = ORIGINAL_SCAN_RE.exec(f);
    if (m) originals.add(Number(m[1]));
    m = TRANSLATED_SCAN_RE.exec(f);
    if (m) translated.add(Number(m[1]));
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.isFile()) byteSize += st.size;
    } catch {
      /* 单个文件读不到则不计入 */
    }
  }
  try {
    modifiedMs = fs.statSync(dir).mtimeMs;
  } catch {
    /* ignore */
  }
  const seqMax = originals.size ? Math.max(...originals) : 0;
  const missingSeqs = [];
  for (let s = 1; s <= seqMax; s += 1) if (!originals.has(s)) missingSeqs.push(s);
  return {
    imageCount: originals.size,
    translatedCount: translated.size,
    byteSize,
    seqMax,
    nextSeq: seqMax + 1,
    translatedSeqs: [...translated].sort((a, b) => a - b),
    missingSeqs,
    modifiedAt: isoOf(modifiedMs),
  };
}

/** 目录内**顶层文件**的字节之和（不含子目录）—— 大类自身的 cover/manifest 计入其容量口径 */
export function ownFilesBytes(dir) {
  let bytes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const st = fs.statSync(path.join(dir, f));
      if (st.isFile()) bytes += st.size;
    }
  } catch {
    /* ignore */
  }
  return bytes;
}

// ------------------------------------------------------------------ 封面

/**
 * 该大类当前生效的封面文件名（相对文件名，非路径）。
 *
 * 📌 读时容错：`manifest.cover` 指向的文件**不存在**时，回退到 `readdir` 里 `COVER_RE`
 * 的第一个命中项。这样「先落文件、后写 json」的顺序即便被中断，也不会出现
 * 「封面文件在、界面却显示无封面」，且下次写 manifest 会自动修正 —— 这才是
 * 「目录即索引」该有的兜底姿态。
 */
export function readCoverName(bookDir, manifest) {
  const declared = manifest && typeof manifest.cover === 'string' ? manifest.cover : null;
  if (declared && COVER_RE.test(declared) && fs.existsSync(path.join(bookDir, declared))) return declared;
  try {
    for (const f of fs.readdirSync(bookDir)) if (COVER_RE.test(f)) return f;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 落封面：**删旧 + tmp + rename**（唯一写入口，同时服务「上传选图」与「取第 1 话首图」）。
 *
 * 「删旧」不是洁癖：扩展名可能从 png 变 jpg，只覆盖同名会留下两份，而扫描按 readdir
 * 顺序认第一个 ⇒ 用户看到「换了封面但还是旧图」。同一个坑 `store.mjs` 的 `item.overwrite`
 * 分支已经踩过一次，不要踩第二遍。
 */
export function writeCover(root, bookDir, bytes, ext) {
  const name = `cover.${ext}`;
  assertInsideRoot(root, path.join(bookDir, name));
  for (const f of fs.readdirSync(bookDir)) {
    if (COVER_RE.test(f) && f !== name) fs.rmSync(path.join(bookDir, f), { force: true });
  }
  const tmp = path.join(bookDir, `${name}.tmp`);
  fs.writeFileSync(tmp, bytes, { mode: 0o600 });
  fs.renameSync(tmp, path.join(bookDir, name));
  return name;
}

/** 移除封面：删掉目录内全部 `cover.*`，返回删除个数 */
export function removeCover(bookDir) {
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(bookDir);
  } catch {
    return 0;
  }
  for (const f of entries) {
    if (!COVER_RE.test(f)) continue;
    try {
      fs.rmSync(path.join(bookDir, f), { force: true });
      removed += 1;
    } catch {
      /* 单个删不掉不阻断其余 */
    }
  }
  return removed;
}

// ------------------------------------------------------------------ 新建大类

/**
 * 建同名大类目录 + 写初始 manifest。
 *
 * 🔴 写序（最容易漏的一处）：`mkdirSync(dir, { recursive: false })` —— `recursive: true`
 * 会把「同名已存在」变成**静默成功**（不报错），于是「新建同名漫画」看起来成功了、
 * 其实什么都没做。`recursive:false` 在已存在时抛 `EEXIST`，由调用方映射成 409。
 *
 * 🔴 失败回滚：目录已建、`manifest.json` 写失败 ⇒ **必须 `rmdirSync` 掉刚建的空目录**。
 * 否则留下一个「无 manifest 的空目录」，按 D-115 §1 的判据它会掉进 `others`
 * ⇒ 用户看到「我新建的漫画跑到『其它』里去了」。
 */
export function createBookDir(root, name) {
  const dir = path.join(root, name);
  assertInsideRoot(root, path.join(dir, 'x.png'));
  const manifest = defaultManifest(name);
  fs.mkdirSync(dir, { recursive: false }); // 已存在 → EEXIST（由调用方映射成 409），绝不静默
  try {
    writeManifestAtomic(dir, manifest);
  } catch (err) {
    try {
      fs.rmdirSync(dir);
    } catch {
      /* 回滚失败也要把**原始**错误抛出去：那才是根因 */
    }
    throw err;
  }
  return { dir, manifest };
}
