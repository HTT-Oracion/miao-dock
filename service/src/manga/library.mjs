// 漫画库「本 → 话 → 页」三层的**落盘原语 + 扫描/视图（数据层）**（契约冻结见 docs/spec-notes.md D-115）。
//
// 为什么单开一个模块：页级扫描、目录命名、manifest 读写与封面落盘这四件事，在
// `server.mjs`（扫描与端点）与将来可能的批量导入之间是**共用的**。写成一份、
// 多调用点，才不会出现「这里校验、那里没校验」的漂移（照抄 `_writeOriginal` 的纪律）。
//
// D-145：库的**扫描与视图**（`scanLibrary`/`buildBookEntry`/`bookMetaView`/`findFile`）
// 也从 `server.mjs` 搬来此处 —— 它们本是数据组装、住在 HTTP 入口会让「库长什么样」
// 只能起服务才验得了。宿主把 `root`/隐藏清单传进来，故它们仍是纯函数。
//
// 本模块是**产品代码**（服务运行期会用到），不是 e2e 夹具，故留在 `service/src/manga/`。
import fs from 'node:fs';
import path from 'node:path';

import {
  CHAPTER_DIR_RE, COVER_RE, MANIFEST_FILE, MAX_CHAPTER_NO, ORIGINAL_SCAN_RE, TRANSLATED_SCAN_RE,
  assertInsideRoot, isValidChapterNo,
} from '../config.mjs';
import { ApiError, permissionDenied, securityLog } from '../errors.mjs';
import { isSafeDirName, normalizeComicName } from './names.mjs';

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
      // 话号合法性只有一份定义（含一位小数，见 config.isValidChapterNo）——
      // 手改 manifest 写进 `14.10` / `0` 这类值时按坏数据处理，回落成空数组
      .filter((e) => e && typeof e === 'object' && isValidChapterNo(e.no) && typeof e.dir === 'string')
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

/**
 * 由**目录**反推要写进 `manifest.json` 的 `episodes[]`。
 *
 * 与 `listChapterDirs` 是同一份事实的两种呈现（这里多一层 `{no, dir}` 投影）。
 * 每次写 manifest 都调它**重建**而不是"读旧数组再合并"：合并会把已被手工删掉的话目录
 * 留在 `episodes[]` 里，而读取端又只认目录 ⇒ 两边永久失配，且没人会发现。
 */
export function episodesFromDirs(bookDir) {
  return listChapterDirs(bookDir).map((c) => ({ no: c.no, dir: c.dirName }));
}

/**
 * 「取第 1 话首图」的选图规则（`POST /library/{book}/meta {coverFromFirstChapter:true}`）。
 *
 * 规则：**最小话号**目录里 —— 优先该话**最小页号的译文**（封面用译文，读者第一眼看到的就是
 * 已译内容），没有译文才退回最小页号的**原图**。返回绝对路径；无可用图片返回 `null`。
 *
 * 📌 这里只负责"选哪张"，**不负责落盘** —— 取字节之后的校验/嗅探/删旧/原子写一律走
 * `writeCover()` 那一个入口。另起一条写路径 = 迟早漂移成"这里校验、那里没校验"（D-115 §7）。
 */
export function pickFirstChapterImage(bookDir) {
  const chapters = listChapterDirs(bookDir); // 已按话号升序 ⇒ [0] 就是最小话号
  if (chapters.length === 0) return null;
  const first = chapters[0].absDir;
  let entries = [];
  try {
    entries = fs.readdirSync(first);
  } catch {
    return null;
  }
  let bestTranslated = null;
  let bestOriginal = null;
  for (const f of entries) {
    let m = TRANSLATED_SCAN_RE.exec(f);
    if (m) {
      const seq = Number(m[1]);
      if (bestTranslated === null || seq < bestTranslated.seq) bestTranslated = { seq, name: f };
      continue;
    }
    m = ORIGINAL_SCAN_RE.exec(f);
    if (m) {
      const seq = Number(m[1]);
      if (bestOriginal === null || seq < bestOriginal.seq) bestOriginal = { seq, name: f };
    }
  }
  const pick = bestTranslated || bestOriginal;
  return pick ? path.join(first, pick.name) : null;
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

// ------------------------------------------------------------------ 扫描与视图（数据层）
//
// 这一组的归属：**数据组装**，不是 HTTP。原先住在 `server.mjs`（HTTP 入口）里，
// 于是「库长什么样」这件事只能起一个服务才验得了（审计 §2.3）。
// 搬来本模块后 `scanLibrary` / `buildBookEntry` / `bookMetaView` / `findFile`
// 都是**纯函数**（宿主把 `root` / 隐藏清单传进来），可以脱开服务单独测。

/**
 * 扫库：一次扫描同时产出 `comics`（向后兼容）/ `books`（大类）/ `others`（未归并单话）。
 *
 * 契约与理由见 docs/spec-notes.md D-115：
 *  · **判据唯一**：顶层目录内有 `manifest.json` ⇒ 大类；没有 ⇒ 未归并单话。
 *  · **`comics` 原样保留**（口径 = 每个顶层目录一条、页级扫描只看该目录自身，与改造前逐字一致），
 *    因为 `DropScreen` 的重名比对、`App` 的库摘要、`selftest` / `e2e` / `lib-manage` 都读它。
 *  · **页级扫描抄一份都不行**：`scanChapterPages` 是「单话目录」与「大类内的话目录」共用的唯一入口。
 *  · **空大类必须出现在 `books` 里**（刚创建、还没归并任何话）—— 否则「新建完看不见」。
 *
 * `hidden` 判据仍是**顶层目录名**（`hideComic(name)` 存的就是它）⇒ 整本隐藏天然兼容。
 *
 * ## 为什么 `root` / `hidden` / `hiddenList` 由调用方传进来
 * 本模块是「本→话→页」的**落盘原语**，不该知道"谁是宿主"。宿主（`server.mjs`）把
 * `store.root` 与 `store.hiddenComics` 传进来 ⇒ 本函数不持有任何服务状态，
 * 于是它是**可单独测的**（正是它从 HTTP 入口搬出来的目的）。
 */
export function scanLibrary({ root, hidden, hiddenList }) {
  const comics = [];
  const books = [];
  const others = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch { /* 根目录不存在 → 空库 */ }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 用户「删除但不删本地文件」⇒ 只隐藏：目录还在，但不再出现在库里。
    // 判定用**原始目录名**（与 `hideComic` 存的名字同一口径）。
    if (hidden.has(entry.name)) continue;
    const dir = path.join(root, entry.name);
    // 顶层页扫描 = `comics` 的口径（G-01：目录内所有文件字节之和）
    const own = scanChapterPages(dir);
    comics.push({ comicName: entry.name, dirName: entry.name, outputDir: dir, ...own });

    if (hasManifest(dir)) books.push(buildBookEntry(entry.name, dir, own));
    else {
      // 未归并单话：`no` 恒为 null（它还没有话号），`mergedTo` 恒为 null（没有归属）——
      // 两个字段一起给出，前端就不必用 `'no' in item` 之类的"字段在不在"来判分支（D-115 §1）。
      others.push({
        no: null, dirName: entry.name, absDir: dir, merged: false, mergedTo: null, ...own,
      });
    }
  }
  const byName = (a, b) => a.dirName.localeCompare(b.dirName, 'zh-Hans-CN');
  comics.sort(byName);
  books.sort(byName);
  others.sort(byName);
  const totalImages = books.reduce((n, b) => n + b.totalPages, 0)
    + others.reduce((n, c) => n + c.imageCount, 0);
  const totalBytes = books.reduce((n, b) => n + b.byteSize, 0)
    + others.reduce((n, c) => n + c.byteSize, 0);
  return {
    root,
    // 「部」数 = 大类 + 未归并单话（单话漫画也是「只有一话的漫画」），与 `comics.length` 恒等
    count: comics.length,
    totalImages,
    totalBytes,
    comics,
    books,
    others,
    // 隐藏清单：既让界面能显示「已隐藏 N 部 · 管理」，也让用户知道库没扫漏。
    hidden: hiddenList,
    hiddenCount: hidden.size,
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/**
 * 大类条目：元信息（`manifest.json` 的 title/author/cover）+ 各话的页级汇总。
 *
 * `byteSize` 沿用 G-01 口径：**各话之和 + 大类目录内的文件**（含 `cover.*` 与 `manifest.json`）
 * —— 不因为多了这两个文件就偷偷改口径（见 D-115 §5）。
 */
export function buildBookEntry(bookName, dir, own) {
  const manifest = readManifest(dir, bookName);
  const chapters = listChapterDirs(dir).map((c) => ({
    no: c.no,
    dirName: c.dirName,
    absDir: c.absDir,
    // 位置即「已归并」（D-115 §1）：能出现在大类目录里，本身就是已归并的证据
    merged: true,
    mergedTo: { bookName, no: c.no },
    ...scanChapterPages(c.absDir),
  }));
  return {
    bookName,
    dirName: bookName,
    outputDir: dir,
    title: manifest.title,
    author: manifest.author,
    // 字段名 `coverPath` 对齐设计稿 11.1 的前端模型；`manifest.json` 里的键仍是 `cover`（D-115 §3）。
    // 两侧名字不同是有意的：json 是**落盘**契约（人可读可改、随目录迁移），这里是**接口**契约。
    coverPath: readCoverName(dir, manifest),
    chapterCount: chapters.length,
    totalPages: chapters.reduce((n, c) => n + c.imageCount, 0),
    byteSize: ownFilesBytes(dir) + chapters.reduce((n, c) => n + c.byteSize, 0),
    modifiedAt: own.modifiedAt,
    chapters,
  };
}

/**
 * 大类元信息视图 = `buildBookEntry` 去掉 `chapters`。
 *
 * `/meta` 与 `/cover` 的响应只需要"改完之后这本长什么样"，不需要把整本的话与逐页集合
 * 再回传一遍（详情页的数据源是 `GET /library`）。同一条 `buildBookEntry` 保证两处口径一致。
 */
export function bookMetaView(bookName, dir) {
  const { chapters, ...meta } = buildBookEntry(bookName, dir, scanChapterPages(dir));
  return { ...meta, chapterCount: chapters.length };
}

/** 在 `dir` 里按序号找出某个变体的文件名（`original` / `translated`）；找不到返回 null */
export function findFile(dir, seq, variant) {
  const wantTranslated = variant === 'translated';
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const f of names) {
    const m = wantTranslated ? TRANSLATED_SCAN_RE.exec(f) : ORIGINAL_SCAN_RE.exec(f);
    if (m && Number(m[1]) === seq) return f;
  }
  return null;
}

// ------------------------------------------------------------------ 寻址（数据层）
//
// 「URL/body 里的原始名 → 库根之下的安全目录」这一层的归属：**寻址**，不是 HTTP。
// 原先住在 `server.mjs`，靠闭包读 `store.root` ⇒ 脱不开服务（审计 §2.3）。
// 搬来本模块后 `root` 由宿主显式传入，全是**纯函数**。
//
// 🔴 **403 与 404 的先后是契约**（§8.2），搬迁时逐条保留：
//    先判「越界」（`isSafeDirName` fail ⇒ 403 `permissionDenied`），再判「格式/存在」（404）。
//    若顺序反了，`../../etc` 这种同样不匹配数字正则的输入会回 404，
//    把「有人试图越界」掩盖成「名字拼错了」。

/** 原始名 → `{name, dir}`；越界一律 403（不泄露是哪一项失败） */
export function resolveComicDir(root, rawName) {
  if (!isSafeDirName(rawName)) {
    securityLog(`拒绝路径越界的漫画名（§8.2 校验点 2）：${JSON.stringify(rawName)}`);
    throw permissionDenied();
  }
  const norm = normalizeComicName(rawName);
  if (!norm.ok) throw new ApiError(norm.code, norm.message, norm.details);
  if (!isSafeDirName(norm.name)) {
    securityLog(`拒绝路径越界的漫画名：${JSON.stringify(rawName)}`);
    throw permissionDenied();
  }
  const dir = path.join(root, norm.name);
  try {
    assertInsideRoot(root, path.join(dir, 'x.png'));
  } catch {
    securityLog(`拼接后前缀校验失败：${dir}（root=${root}）`);
    throw permissionDenied();
  }
  return { name: norm.name, dir };
}

/** 大类（`resolveComicDir` + 「目录在、且有 `manifest.json`」）；不存在 → 404 */
export function resolveBookDir(root, rawName) {
  const { name, dir } = resolveComicDir(root, rawName);
  if (!fs.existsSync(dir) || !hasManifest(dir)) {
    throw new ApiError('TASK_NOT_FOUND', '漫画大类不存在（目录内没有 manifest.json）',
      { bookName: name, outputDir: dir });
  }
  return { name, dir };
}

/** `{book}/${话号}` → 该话的目录信息（`{bookName, bookDir, no, dirName, dir, relDir}`） */
export function resolveChapterDir(root, bookRaw, noRaw) {
  // 话号来自两处：URL 段（永远是字符串）与 merge 的 body（可能是 JSON number）。
  // 统一成字符串再校验 —— 否则 `{no: 2}` 会在 isSafeDirName 的 typeof 断言上被判成"越界"而回 403。
  const noText = String(noRaw ?? '');
  // 🔴 顺序不能反：**先判越界（403），再判格式（404）**。`../../etc` 同样不匹配数字正则，
  //    若先判格式就会回 404 —— 而 §8.2 只允许 403，404 会把"有人试图越界"掩盖成"话号拼错了"
  //    （与 `resolveComicDir` 的处理逐条对齐）。
  if (!isSafeDirName(noText)) {
    securityLog(`拒绝路径越界的话号（§8.2 校验点 2）：${JSON.stringify(noRaw)}`);
    throw permissionDenied();
  }
  // 只认「1–999.9、最多一位小数且小数位非 0」：`'1abc'`、`'01x'`、`''`、`'14.10'`、`'14.0'`
  // 一律拒。parseInt 的"能读几个字符算几个"会让 `/chapters/1xyz/` 静默命中第 1 话
  // —— 那是把拼错的路径当成对的。
  if (!/^\d{1,3}(?:\.[1-9])?$/.test(noText)) {
    throw new ApiError(
      'TASK_NOT_FOUND',
      `话号必须是 1–${MAX_CHAPTER_NO}.9 的数（最多一位小数）`,
      { chapterNo: noRaw },
    );
  }
  const no = Number(noText);
  if (!isValidChapterNo(no)) {
    throw new ApiError(
      'TASK_NOT_FOUND',
      `话号必须是 1–${MAX_CHAPTER_NO}.9 的数（最多一位小数）`,
      { chapterNo: noRaw },
    );
  }
  const { name: bookName, dir: bookDir } = resolveBookDir(root, bookRaw); // 第一段：书（含 §8.2 原始名断言）
  const dirName = chapterDirName(no); // 服务端生成，不由用户输入拼出
  if (!isSafeDirName(dirName)) {
    securityLog(`话目录名未通过安全断言（命名规则可能被改坏）：${JSON.stringify(dirName)}`);
    throw permissionDenied();
  }
  const dir = path.join(bookDir, dirName);
  try {
    assertInsideRoot(root, path.join(dir, 'x.png'));
  } catch {
    securityLog(`话目录拼接后前缀校验失败：${dir}（root=${root}）`);
    throw permissionDenied();
  }
  return { bookName, bookDir, no, dirName, dir, relDir: `${bookName}/${dirName}` };
}

/** `resolveChapterDir` + 「该话目录确实存在」；不存在 → 404 */
export function mustChapterDir(root, bookRaw, noRaw) {
  const info = resolveChapterDir(root, bookRaw, noRaw);
  if (!fs.existsSync(info.dir)) {
    throw new ApiError('TASK_NOT_FOUND', `这本漫画没有第 ${info.no} 话`, {
      bookName: info.bookName, chapterNo: info.no, outputDir: info.dir,
    });
  }
  return info;
}
