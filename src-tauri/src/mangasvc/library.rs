// 漫画库「本 → 话 → 页」三层的**落盘原语 + 扫描/视图 + 寻址** —— 移植 `service/src/manga/library.mjs`。
//
// 归属：这是**数据层**（不是 HTTP）。宿主（handler）把 `root` / 隐藏清单传进来，故本模块不持有
// 任何服务状态 —— 于是它可被单独测，且「库长什么样」不必起服务就能验（审计 §2.3 / D-145）。
//
// 🔴 **403 与 404 的先后是契约**（§8.2），搬迁时逐条保留：先判「越界」（`is_safe_dir_name`
//    fail ⇒ 403 `PERMISSION_DENIED`），再判「格式/存在」（404）。若顺序反了，`../../etc`
//    这种同样不匹配数字正则的输入会回 404，把「有人试图越界」掩盖成「名字拼错了」。
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::mangasvc::names::normalize_comic_name;
use crate::mangasvc::store::pure::{is_safe_dir_name, match_original, match_translated, sniff_image_type};
use crate::mangasvc::store::StoreError;
use crate::platform::paths;

const MANIFEST_FILE: &str = "manifest.json";
const MAX_CHAPTER_NO: i64 = 999;
const COVER_MAX_BYTES: usize = 10 * 1024 * 1024;
const MERGE_ARCHIVE_DIR: &str = "merge-archive";

type LibResult<T> = Result<T, StoreError>;

fn perm_denied() -> StoreError {
    StoreError::new("PERMISSION_DENIED", "鉴权失败或来源不被允许", serde_json::json!({}))
}

fn security_log(msg: &str) {
    eprintln!("[manga-service][security] {msg}");
}

/// ISO 秒级时间戳（与全仓 `updatedAt` 口径一致：去掉毫秒）。
fn iso_of(ms: Option<i64>) -> Option<String> {
    let ms = ms?;
    if ms == 0 {
        return None;
    }
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms).map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

fn iso_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

// ------------------------------------------------------------------ 命名

/// 话号 → 目录名：`NN_第N话`（两位零填充 ⇒ 文件系统自然序 == 话序）。
pub fn chapter_dir_name(no: f64) -> String {
    let s = js_num_str(no);
    let padded = if s.len() < 2 { format!("0{s}") } else { s };
    format!("{padded}_第{}话", js_num_str(no))
}

/// JS `String(number)`：整数不带小数点，`14.9` 原样。
fn js_num_str(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// 目录名 → 话号；不匹配返回 `None`（不猜）。
pub fn chapter_no_from_dir_name(dir_name: &str) -> Option<f64> {
    // `^(\d{1,3}(?:\.[1-9])?)_第(\d{1,3}(?:\.[1-9])?)话$`
    let re = regex::Regex::new(r"^(\d{1,3}(?:\.[1-9])?)_第(\d{1,3}(?:\.[1-9])?)话$").ok()?;
    let caps = re.captures(dir_name)?;
    caps.get(2).and_then(|m| m.as_str().parse::<f64>().ok())
}

/// `isValidChapterNo`。
pub fn is_valid_chapter_no(v: f64) -> bool {
    if !v.is_finite() || v < 1.0 || v > MAX_CHAPTER_NO as f64 + 0.9 {
        return false;
    }
    if v.fract() == 0.0 {
        return true;
    }
    let s = format!("{v}");
    regex::Regex::new(r"^\d{1,3}\.[1-9]$").map(|re| re.is_match(&s)).unwrap_or(false)
}

// ------------------------------------------------------------------ manifest

/// 序刻意为 `schema, title, author, cover, episodes` —— 与 Node 对象字面量的键序一致
/// （`writeManifestAtomic` 的落盘字节因此可逐字节比对）。
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct Episode {
    pub no: f64,
    pub dir: String,
}

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct Manifest {
    pub schema: i64,
    pub title: String,
    pub author: String,
    pub cover: Option<String>,
    pub episodes: Vec<Episode>,
}

pub fn default_manifest(book_name: &str) -> Manifest {
    Manifest { schema: 1, title: book_name.to_string(), author: String::new(), cover: None, episodes: Vec::new() }
}

fn cover_re_match(name: &str) -> bool {
    regex::Regex::new(r"^cover\.(png|jpg|jpeg|webp)$").map(|re| re.is_match(name)).unwrap_or(false)
}

/// `hasManifest`：**大类判定的唯一判据**（D-115 §1，看存在性而非可解析性）。
pub fn has_manifest(book_dir: &Path) -> bool {
    std::fs::metadata(book_dir.join(MANIFEST_FILE)).map(|m| m.is_file()).unwrap_or(false)
}

/// `readManifest`：**容错** —— 缺失 / 坏 JSON / 形状不对 ⇒ 回落成安全默认值。
pub fn read_manifest(book_dir: &Path, book_name: &str) -> Manifest {
    let base = default_manifest(book_name);
    let Ok(raw) = std::fs::read_to_string(book_dir.join(MANIFEST_FILE)) else { return base };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else { return base };
    let Some(obj) = parsed.as_object() else { return base };
    let episodes = obj
        .get("episodes")
        .and_then(|e| e.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    let no = e.get("no").and_then(|x| x.as_f64())?;
                    let dir = e.get("dir").and_then(|x| x.as_str())?;
                    if is_valid_chapter_no(no) {
                        Some(Episode { no, dir: dir.to_string() })
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let title = obj
        .get("title")
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| book_name.to_string());
    let author = obj.get("author").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let cover = obj
        .get("cover")
        .and_then(|x| x.as_str())
        .filter(|s| cover_re_match(s))
        .map(str::to_string);
    Manifest { schema: 1, title, author, cover, episodes }
}

/// `writeManifestAtomic`：同目录 tmp + rename。
pub fn write_manifest_atomic(book_dir: &Path, manifest: &Manifest) -> std::io::Result<PathBuf> {
    let target = book_dir.join(MANIFEST_FILE);
    let tmp = book_dir.join(format!("{MANIFEST_FILE}.tmp"));
    let text = format!("{}\n", serde_json::to_string_pretty(manifest).unwrap_or_default());
    std::fs::write(&tmp, text.as_bytes())?;
    std::fs::rename(&tmp, &target)?;
    Ok(target)
}

// ------------------------------------------------------------------ 话目录

#[derive(Clone, Debug)]
pub struct ChapterDir {
    pub no: f64,
    pub dir_name: String,
    pub abs_dir: PathBuf,
}

/// `listChapterDirs`：**以目录为准**，不看 `episodes[]`。
pub fn list_chapter_dirs(book_dir: &Path) -> Vec<ChapterDir> {
    let Ok(rd) = std::fs::read_dir(book_dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in rd.filter_map(|e| e.ok()) {
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(no) = chapter_no_from_dir_name(&name) else { continue };
        out.push(ChapterDir { no, dir_name: name.clone(), abs_dir: book_dir.join(&name) });
    }
    out.sort_by(|a, b| a.no.partial_cmp(&b.no).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// `episodesFromDirs`：由**目录**反推要写进 manifest 的 `episodes[]`（每次重建，不合并旧数组）。
pub fn episodes_from_dirs(book_dir: &Path) -> Vec<Episode> {
    list_chapter_dirs(book_dir).into_iter().map(|c| Episode { no: c.no, dir: c.dir_name }).collect()
}

/// `pickFirstChapterImage`：最小话号目录里，优先最小页号的译文，其次最小页号原图。
pub fn pick_first_chapter_image(book_dir: &Path) -> Option<PathBuf> {
    let chapters = list_chapter_dirs(book_dir);
    let first = chapters.first()?.abs_dir.clone();
    let entries = std::fs::read_dir(&first).ok()?;
    let mut best_translated: Option<(i64, String)> = None;
    let mut best_original: Option<(i64, String)> = None;
    for e in entries.filter_map(|e| e.ok()) {
        let f = e.file_name().to_string_lossy().into_owned();
        if let Some(seq) = match_translated(&f) {
            if best_translated.as_ref().map(|(s, _)| seq < *s).unwrap_or(true) {
                best_translated = Some((seq, f));
            }
            continue;
        }
        if let Some(seq) = match_original(&f) {
            if best_original.as_ref().map(|(s, _)| seq < *s).unwrap_or(true) {
                best_original = Some((seq, f));
            }
        }
    }
    let pick = best_translated.or(best_original)?;
    Some(first.join(pick.1))
}

// ------------------------------------------------------------------ 页级扫描

/// 页级汇总。字段序 = Node 的 `{ imageCount, translatedCount, byteSize, seqMax, nextSeq,
/// translatedSeqs, missingSeqs, modifiedAt }`（spread 进上层条目后仍保持这个顺序）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageScan {
    pub image_count: usize,
    pub translated_count: usize,
    pub byte_size: u64,
    pub seq_max: i64,
    pub next_seq: i64,
    pub translated_seqs: Vec<i64>,
    pub missing_seqs: Vec<i64>,
    pub modified_at: Option<String>,
}

/// `scanChapterPages`：一个「装页的目录」→ 页级汇总。**唯一入口**（单话与大类内话共用）。
pub fn scan_chapter_pages(dir: &Path) -> PageScan {
    let mut originals: std::collections::BTreeSet<i64> = std::collections::BTreeSet::new();
    let mut translated: std::collections::BTreeSet<i64> = std::collections::BTreeSet::new();
    let mut byte_size = 0u64;
    let mut modified_ms = 0i64;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let f = e.file_name().to_string_lossy().into_owned();
            if let Some(seq) = match_original(&f) {
                originals.insert(seq);
            }
            if let Some(seq) = match_translated(&f) {
                translated.insert(seq);
            }
            if let Ok(md) = e.metadata() {
                if md.is_file() {
                    byte_size += md.len();
                }
            }
        }
    }
    if let Ok(md) = std::fs::metadata(dir) {
        if let Ok(t) = md.modified() {
            if let Ok(d) = t.duration_since(std::time::UNIX_EPOCH) {
                modified_ms = d.as_millis() as i64;
            }
        }
    }
    let seq_max = originals.iter().copied().max().unwrap_or(0);
    let mut missing_seqs = Vec::new();
    for s in 1..=seq_max {
        if !originals.contains(&s) {
            missing_seqs.push(s);
        }
    }
    PageScan {
        image_count: originals.len(),
        translated_count: translated.len(),
        byte_size,
        seq_max,
        next_seq: seq_max + 1,
        translated_seqs: translated.into_iter().collect(),
        missing_seqs,
        modified_at: iso_of(Some(modified_ms)),
    }
}

/// `ownFilesBytes`：目录内**顶层文件**字节之和（不含子目录）。
pub fn own_files_bytes(dir: &Path) -> u64 {
    let mut bytes = 0u64;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) {
            if let Ok(md) = e.metadata() {
                if md.is_file() {
                    bytes += md.len();
                }
            }
        }
    }
    bytes
}

// ------------------------------------------------------------------ 封面

/// `readCoverName`：manifest.cover 指向的文件不存在时，回退到 readdir 里第一个 `cover.*`。
pub fn read_cover_name(book_dir: &Path, manifest: &Manifest) -> Option<String> {
    if let Some(declared) = manifest.cover.as_deref() {
        if cover_re_match(declared) && book_dir.join(declared).exists() {
            return Some(declared.to_string());
        }
    }
    if let Ok(rd) = std::fs::read_dir(book_dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let f = e.file_name().to_string_lossy().into_owned();
            if cover_re_match(&f) {
                return Some(f);
            }
        }
    }
    None
}

/// `writeCover`：**删旧 + tmp + rename**（唯一写入口）。
pub fn write_cover(root: &Path, book_dir: &Path, bytes: &[u8], ext: &str) -> Result<String, StoreError> {
    let name = format!("cover.{ext}");
    paths::assert_inside_root(root, &book_dir.join(&name)).map_err(|_| perm_denied())?;
    if let Ok(rd) = std::fs::read_dir(book_dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let f = e.file_name().to_string_lossy().into_owned();
            if cover_re_match(&f) && f != name {
                let _ = std::fs::remove_file(book_dir.join(&f));
            }
        }
    }
    let tmp = book_dir.join(format!("{name}.tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| StoreError::new("INVALID_IMAGE", format!("封面写入失败：{e}"), serde_json::json!({})))?;
    std::fs::rename(&tmp, book_dir.join(&name)).map_err(|e| StoreError::new("INVALID_IMAGE", format!("封面改名失败：{e}"), serde_json::json!({})))?;
    Ok(name)
}

/// `removeCover`：删掉目录内全部 `cover.*`，返回删除个数。
pub fn remove_cover(book_dir: &Path) -> usize {
    let mut removed = 0;
    if let Ok(rd) = std::fs::read_dir(book_dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let f = e.file_name().to_string_lossy().into_owned();
            if !cover_re_match(&f) {
                continue;
            }
            if std::fs::remove_file(book_dir.join(&f)).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

// ------------------------------------------------------------------ 新建大类

/// `createBookDir`：建目录 + 写初始 manifest。
///
/// 🔴 `create_dir`（非递归）—— 已存在时抛错（不静默成功）。失败时回滚掉刚建的空目录。
pub fn create_book_dir(root: &Path, name: &str) -> Result<(PathBuf, Manifest), StoreError> {
    let dir = root.join(name);
    paths::assert_inside_root(root, &dir.join("x.png")).map_err(|_| perm_denied())?;
    let manifest = default_manifest(name);
    std::fs::create_dir(&dir).map_err(|e| StoreError::new("_MKDIR", format!("{e}"), serde_json::json!({})))?;
    if let Err(e) = write_manifest_atomic(&dir, &manifest) {
        let _ = std::fs::remove_dir(&dir);
        return Err(StoreError::new("_MKMANIFEST", format!("{e}"), serde_json::json!({})));
    }
    Ok((dir, manifest))
}

// ------------------------------------------------------------------ 扫描与视图

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicEntry {
    pub comic_name: String,
    pub dir_name: String,
    pub output_dir: String,
    #[serde(flatten)]
    pub page: PageScan,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterEntry {
    pub no: f64,
    pub dir_name: String,
    pub abs_dir: String,
    pub merged: bool,
    pub merged_to: serde_json::Value,
    #[serde(flatten)]
    pub page: PageScan,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookEntry {
    pub book_name: String,
    pub dir_name: String,
    pub output_dir: String,
    pub title: String,
    pub author: String,
    pub cover_path: Option<String>,
    pub chapter_count: usize,
    pub total_pages: usize,
    pub byte_size: u64,
    pub modified_at: Option<String>,
    pub chapters: Vec<ChapterEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtherEntry {
    pub no: Option<f64>,
    pub dir_name: String,
    pub abs_dir: String,
    pub merged: bool,
    pub merged_to: Option<String>,
    #[serde(flatten)]
    pub page: PageScan,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryView {
    pub root: String,
    pub count: usize,
    pub total_images: usize,
    pub total_bytes: u64,
    pub comics: Vec<ComicEntry>,
    pub books: Vec<BookEntry>,
    pub others: Vec<OtherEntry>,
    pub hidden: Vec<String>,
    pub hidden_count: usize,
    pub updated_at: String,
}

/// `buildBookEntry`。
pub fn build_book_entry(book_name: &str, dir: &Path, own: &PageScan) -> BookEntry {
    let manifest = read_manifest(dir, book_name);
    let chapters: Vec<ChapterEntry> = list_chapter_dirs(dir)
        .into_iter()
        .map(|c| {
            let merged_to = serde_json::json!({ "bookName": book_name, "no": c.no });
            ChapterEntry {
                no: c.no,
                dir_name: c.dir_name.clone(),
                abs_dir: c.abs_dir.to_string_lossy().into_owned(),
                merged: true,
                merged_to,
                page: scan_chapter_pages(&c.abs_dir),
            }
        })
        .collect();
    let total_pages = chapters.iter().map(|c| c.page.image_count).sum();
    let chapters_bytes: u64 = chapters.iter().map(|c| c.page.byte_size).sum();
    BookEntry {
        book_name: book_name.to_string(),
        dir_name: book_name.to_string(),
        output_dir: dir.to_string_lossy().into_owned(),
        title: manifest.title.clone(),
        author: manifest.author.clone(),
        cover_path: read_cover_name(dir, &manifest),
        chapter_count: chapters.len(),
        total_pages,
        byte_size: own_files_bytes(dir) + chapters_bytes,
        modified_at: own.modified_at.clone(),
        chapters,
    }
}

/// `bookMetaView` = `buildBookEntry` 去掉 `chapters`（但保留 `chapterCount`）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookMetaView {
    pub book_name: String,
    pub dir_name: String,
    pub output_dir: String,
    pub title: String,
    pub author: String,
    pub cover_path: Option<String>,
    pub chapter_count: usize,
    pub total_pages: usize,
    pub byte_size: u64,
    pub modified_at: Option<String>,
}

pub fn book_meta_view(book_name: &str, dir: &Path) -> BookMetaView {
    let e = build_book_entry(book_name, dir, &scan_chapter_pages(dir));
    BookMetaView {
        book_name: e.book_name,
        dir_name: e.dir_name,
        output_dir: e.output_dir,
        title: e.title,
        author: e.author,
        cover_path: e.cover_path,
        chapter_count: e.chapter_count,
        total_pages: e.total_pages,
        byte_size: e.byte_size,
        modified_at: e.modified_at,
    }
}

/// `findFile`：在 `dir` 里按序号找出某个变体的文件名（original / translated）。
pub fn find_file(dir: &Path, seq: i64, variant: &str) -> Option<String> {
    let want_translated = variant == "translated";
    let rd = std::fs::read_dir(dir).ok()?;
    for e in rd.filter_map(|e| e.ok()) {
        let f = e.file_name().to_string_lossy().into_owned();
        let m = if want_translated { match_translated(&f) } else { match_original(&f) };
        if m == Some(seq) {
            return Some(f);
        }
    }
    None
}

/// `scanLibrary`。
///
/// ⚠️ **已知偏离**：排序用**码点序**，未复刻 Node 的 `localeCompare(..., 'zh-Hans-CN')`
/// （后者仅影响中文名的显示顺序；ASCII 名一致）。
pub fn scan_library(root: &Path, hidden: &HashSet<String>, hidden_list: Vec<String>) -> LibraryView {
    let mut comics = Vec::new();
    let mut books = Vec::new();
    let mut others = Vec::new();
    if let Ok(rd) = std::fs::read_dir(root) {
        for entry in rd.filter_map(|e| e.ok()) {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if hidden.contains(&name) {
                continue;
            }
            let dir = root.join(&name);
            let own = scan_chapter_pages(&dir);
            comics.push(ComicEntry {
                comic_name: name.clone(),
                dir_name: name.clone(),
                output_dir: dir.to_string_lossy().into_owned(),
                page: own.clone(),
            });
            if has_manifest(&dir) {
                books.push(build_book_entry(&name, &dir, &own));
            } else {
                others.push(OtherEntry {
                    no: None,
                    dir_name: name.clone(),
                    abs_dir: dir.to_string_lossy().into_owned(),
                    merged: false,
                    merged_to: None,
                    page: own,
                });
            }
        }
    }
    comics.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    books.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    others.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    let total_images = books.iter().map(|b| b.total_pages).sum::<usize>()
        + others.iter().map(|c| c.page.image_count).sum::<usize>();
    let total_bytes = books.iter().map(|b| b.byte_size).sum::<u64>()
        + others.iter().map(|c| c.page.byte_size).sum::<u64>();
    LibraryView {
        root: root.to_string_lossy().into_owned(),
        count: comics.len(),
        total_images,
        total_bytes,
        comics,
        books,
        others,
        hidden: hidden_list,
        hidden_count: hidden.len(),
        updated_at: iso_now(),
    }
}

// ------------------------------------------------------------------ 寻址

/// 原始名 → `{name, dir}`；越界一律 403。
pub fn resolve_comic_dir(root: &Path, raw_name: &str) -> LibResult<(String, PathBuf)> {
    if !is_safe_dir_name(raw_name) {
        security_log(&format!("拒绝路径越界的漫画名（§8.2 校验点 2）：{:?}", raw_name));
        return Err(perm_denied());
    }
    let norm = normalize_comic_name(&serde_json::Value::String(raw_name.to_string()))?;
    if !is_safe_dir_name(&norm) {
        security_log(&format!("拒绝路径越界的漫画名：{:?}", raw_name));
        return Err(perm_denied());
    }
    let dir = root.join(&norm);
    if paths::assert_inside_root(root, &dir.join("x.png")).is_err() {
        security_log(&format!("拼接后前缀校验失败：{}（root={}）", dir.display(), root.display()));
        return Err(perm_denied());
    }
    Ok((norm, dir))
}

/// 大类（`resolve_comic_dir` + 「目录在、且有 manifest」）；不存在 → 404。
pub fn resolve_book_dir(root: &Path, raw_name: &str) -> LibResult<(String, PathBuf)> {
    let (name, dir) = resolve_comic_dir(root, raw_name)?;
    if !dir.exists() || !has_manifest(&dir) {
        return Err(StoreError::new(
            "TASK_NOT_FOUND",
            "漫画大类不存在（目录内没有 manifest.json）",
            serde_json::json!({ "bookName": name, "outputDir": dir.to_string_lossy() }),
        ));
    }
    Ok((name, dir))
}

#[derive(Clone, Debug)]
pub struct ChapterInfo {
    pub book_name: String,
    pub book_dir: PathBuf,
    pub no: f64,
    pub dir_name: String,
    pub dir: PathBuf,
    pub rel_dir: String,
}

/// `resolveChapterDir`。
pub fn resolve_chapter_dir(root: &Path, book_raw: &str, no_raw: &str) -> LibResult<ChapterInfo> {
    let no_text = no_raw.to_string();
    if !is_safe_dir_name(&no_text) {
        security_log(&format!("拒绝路径越界的话号（§8.2 校验点 2）：{:?}", no_raw));
        return Err(perm_denied());
    }
    let re = regex::Regex::new(r"^\d{1,3}(?:\.[1-9])?$").map_err(|_| perm_denied())?;
    if !re.is_match(&no_text) {
        return Err(StoreError::new(
            "TASK_NOT_FOUND",
            format!("话号必须是 1–{MAX_CHAPTER_NO}.9 的数（最多一位小数）"),
            serde_json::json!({ "chapterNo": no_raw }),
        ));
    }
    let no: f64 = no_text.parse().map_err(|_| perm_denied())?;
    if !is_valid_chapter_no(no) {
        return Err(StoreError::new(
            "TASK_NOT_FOUND",
            format!("话号必须是 1–{MAX_CHAPTER_NO}.9 的数（最多一位小数）"),
            serde_json::json!({ "chapterNo": no_raw }),
        ));
    }
    let (book_name, book_dir) = resolve_book_dir(root, book_raw)?;
    let dir_name = chapter_dir_name(no);
    if !is_safe_dir_name(&dir_name) {
        security_log(&format!("话目录名未通过安全断言：{:?}", dir_name));
        return Err(perm_denied());
    }
    let dir = book_dir.join(&dir_name);
    if paths::assert_inside_root(root, &dir.join("x.png")).is_err() {
        security_log(&format!("话目录拼接后前缀校验失败：{}（root={}）", dir.display(), root.display()));
        return Err(perm_denied());
    }
    let rel_dir = format!("{book_name}/{dir_name}");
    Ok(ChapterInfo { book_name, book_dir, no, dir_name, dir, rel_dir })
}

/// `mustChapterDir`。
pub fn must_chapter_dir(root: &Path, book_raw: &str, no_raw: &str) -> LibResult<ChapterInfo> {
    let info = resolve_chapter_dir(root, book_raw, no_raw)?;
    if !info.dir.exists() {
        return Err(StoreError::new(
            "TASK_NOT_FOUND",
            format!("这本漫画没有第 {} 话", js_num_str(info.no)),
            serde_json::json!({ "bookName": info.book_name, "chapterNo": info.no, "outputDir": info.dir.to_string_lossy() }),
        ));
    }
    Ok(info)
}

// ------------------------------------------------------------------ 归并/改号辅助

/// 归并归档目录（`state/merge-archive/`），按需创建。
pub fn merge_archive_dir() -> PathBuf {
    let dir = paths::state_dir().join(MERGE_ARCHIVE_DIR);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// 归档用时间戳（文件名安全：冒号与点在 Windows 上都不合法）。
///
/// 🔴 尾部的 `Z` 不能省：Node 是 `new Date().toISOString().replace(/[:.]/g,'-')` ——
///    `toISOString()` 带 `Z`，替换的只是 `:` 与 `.`。少了它，归档文件名与 Node 差一个字符。
pub fn stamp_of() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S-%3fZ").to_string().replace('.', "-")
}

/// 封面大小上限。
pub fn cover_max_bytes() -> usize {
    COVER_MAX_BYTES
}

/// `sniffImageType` 的再导出（封面嗅探用）。
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    sniff_image_type(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chapter_dir_name_matches_node() {
        assert_eq!(chapter_dir_name(2.0), "02_第2话");
        assert_eq!(chapter_dir_name(14.0), "14_第14话");
        // `String(14.9).padStart(2,'0')` = "14.9"（已 ≥2 位，不补零）—— 逐字复刻 JS 语义。
        assert_eq!(chapter_dir_name(14.9), "14.9_第14.9话");
        assert_eq!(chapter_no_from_dir_name("02_第2话"), Some(2.0));
        assert_eq!(chapter_no_from_dir_name("14.9_第14.9话"), Some(14.9));
        assert_eq!(chapter_no_from_dir_name("xx"), None);
    }

    #[test]
    fn valid_chapter_no_matches_node() {
        assert!(is_valid_chapter_no(1.0));
        assert!(is_valid_chapter_no(14.0)); // 整数合规
        assert!(is_valid_chapter_no(999.9));
        assert!(!is_valid_chapter_no(14.55)); // 只认一位小数
        assert!(is_valid_chapter_no(14.5));
        assert!(!is_valid_chapter_no(0.0));
        assert!(!is_valid_chapter_no(1000.0));
    }

    #[test]
    fn manifest_roundtrip_is_stable() {
        let tmp = std::env::temp_dir().join(format!("miao-lib-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let m = default_manifest("书名");
        write_manifest_atomic(&tmp, &m).unwrap();
        let got = read_manifest(&tmp, "fallback");
        assert_eq!(got.title, "书名");
        assert!(got.episodes.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
