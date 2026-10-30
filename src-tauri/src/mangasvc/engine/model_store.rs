// mangasvc/engine/model_store.rs —— S3 模型管理内核（A3d）
//
// 移植自 `engine/model-store.mjs`（603 行）。职责不变：把 `engine/models.manifest.json` 里
// 声明的外部资产（视觉模型 / LLM 权重 / 外部二进制）拉到模型根目录，并保住 E7 的三件事：
// **断点续传** · **逐文件 SHA256** · **篡改一字节 ⇒ 自动重下**。
//
// ## 为什么必须移植（与 A3b / A3c 同一条理由）
// A3「node 随包」作废后，产品运行期不允许依赖 node 解释器。而本模块是**产品运行期**被
// fork 的：`POST /engine/models/verify`（`handlers.rs`）与「重新下载模型」（`state.rs`）
// 都要跑它 —— A3b 清掉了启动配方、A3c 清掉了父死看守，这里是**最后两处**。
//
// ## 与 Node 版的关系
// `engine/model-store.mjs` **保留**（`engine/scripts/fetch-models.mjs` 仍在 import 它），
// 与 A3c 保留 `child-watch.mjs` 同一处置：它是**对照端**，不是死代码。删前必须 grep。
//
// 🔴 三个"看起来能用、其实会静默出错"的点，与 Node 版逐条对齐：
//   ① **Range 请求的服务器可能不支持** —— 我们发 `Range` 而对方回 **200（全量）**是合法行为，
//      此时**必须截断进度重新计**，否则会把整包追加到 `.part` 后面，得到一个"大小对不上、
//      哈希必然不符"的文件。判 206 与 200 是两件事，不能只看状态码成功。
//   ② **`Content-Length` 在续传时是"剩余长度"不是"总长度"** —— 进度要用 `Content-Range` 的
//      total（`bytes a-b/total`），否则进度条走到 100% 却只下了半截。
//   ③ **校验失败必须重下，但只许一次** —— 无限重试会在"源本身是坏的"时变成不报错的死循环。
//
// 🔴 与 Node 版的**唯一有意差异**：Node 版给 `ensureModels` 传 `AbortSignal` 做"可暂停"，
//    本模块**不实现** signal —— Rust 侧没有任何调用方持有 signal（产品只跑 CLI），
//    而"暂停"在产品里的真实形态就是**杀掉进程**（`.part` 留下即是断点）。
//    故 e2e 的 F 组两靶统一改为"外部 kill 子进程"取证，不再走进程内 abort。

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use sha2::{Digest, Sha256};

// ------------------------------------------------------------------ 常量

/// `.ready` 标记文件名（放在模型根目录下）。
pub const READY_MARKER: &str = ".models.ready.json";
/// 未完成下载的临时文件后缀。它就是"断点"本体 —— 存在即有进度。
pub const PART_SUFFIX: &str = ".part";
/// 校验失败后允许的**自动重下**次数（1 = 重下一次；再失败就报错，不静默）。
pub const REDOWNLOAD_LIMIT: usize = 1;
/// 单个源在一次**流中断**后的重试次数（与 `REDOWNLOAD_LIMIT` 是两件事，别合并）。
pub const RETRY_PER_SOURCE: usize = 3;

// ------------------------------------------------------------------ 数据结构

/// 带错误码的失败。调用方据此区分"网络问题"与"内容坏了"。
#[derive(Debug, Clone)]
pub struct ModelStoreError {
    pub code: String,
    pub message: String,
    pub detail: Option<Value>,
}

impl ModelStoreError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into(), detail: None }
    }
    pub fn with_detail(code: &str, message: impl Into<String>, detail: Value) -> Self {
        Self { code: code.to_string(), message: message.into(), detail: Some(detail) }
    }
}

impl std::fmt::Display for ModelStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileEntry {
    pub id: String,
    #[serde(default)]
    pub set: Option<String>,
    pub dest: String,
    #[serde(default, rename = "linkTo")]
    pub link_to: Option<String>,
    #[serde(default)]
    pub hf: Option<HfInfo>,
    #[serde(default)]
    pub platform: Option<String>,
    /// G4：装配阶段。`1` = 先可用（Python 运行时 / 源码 / 视觉模型，约 1 GB），
    /// `2` = 后完整（翻译权重 / llama.cpp 等）。**缺省 = 1** ——
    /// 既有清单（`models.manifest.json`）一条没写，行为必须与今天逐字节相同。
    #[serde(default)]
    pub stage: Option<u8>,
    #[serde(default)]
    pub sha256: String,
    #[serde(default, rename = "sizeBytes")]
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub sources: Vec<String>,
    /// 解包目标目录（只有 runtime 类条目有；解包是 CLI 的 `--extract` 干的）。
    #[serde(default, rename = "extractTo")]
    pub extract_to: Option<String>,
    #[serde(default, rename = "extractStrip")]
    pub extract_strip: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HfInfo {
    #[serde(default)]
    pub revision: String,
    #[serde(default)]
    pub filename: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestSet {
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    #[serde(default, rename = "manifestVersion")]
    pub manifest_version: Value,
    #[serde(default, rename = "engineCommit")]
    pub engine_commit: String,
    #[serde(default)]
    pub sets: BTreeMap<String, ManifestSet>,
    #[serde(default)]
    pub files: Vec<FileEntry>,
}

/// 归一化后的 stat（`ino`/`dev` 用来判"这两个路径是不是同一份"）。
#[derive(Debug, Clone, Copy)]
pub struct Stat {
    pub size: u64,
    pub mtime_ms: f64,
    pub ino: u64,
    pub dev: u64,
    pub is_symbolic_link: bool,
}

/// 进度事件（owned，便于跨回调边界；字段与 Node 版逐字对齐）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressEvent {
    pub id: String,
    pub phase: String,
    pub received: u64,
    pub total: Option<u64>,
    pub url: Option<String>,
    pub resumed: bool,
    /// 阶段标记事件的人类可读描述（「安装引擎依赖」「下载并解包引擎源码」等）；
    /// downloading / verifying 事件为 None —— 那些阶段的文件名本身就是描述。
    ///
    /// 🔴 `#[serde(default)]` **不能省**：旧的 `--progress-log` 行没有这个键，
    ///    少了它反序列化会整行失败 ⇒ 进度全丢，且 `check:progress-truth` 会假红。
    #[serde(default)]
    pub msg: Option<String>,
}

/// `.ready` 里的一条记录。字段**声明序**即 JSON 输出序（与 Node 版一致）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerRecord {
    pub dest: String,
    pub sha256: Option<String>,
    pub size_bytes: u64,
    pub mtime_ms: serde_json::Number,
}

// ------------------------------------------------------------------ 基础工具

fn log(logger: Option<&dyn Fn(&str)>, msg: &str) {
    if let Some(f) = logger {
        f(msg);
    }
}

pub fn size_of(p: &Path) -> u64 {
    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

pub fn stat_safe(p: &Path) -> Option<Stat> {
    let m = fs::metadata(p).ok()?;
    Some(stat_from(p, &m, false))
}

/// 同 `stat_safe`，但**不跟随**符号链接（`symlink_metadata`）。
///
/// 为什么必须另有一个：HuggingFace 下载器在 `snapshots/` 下留的是**相对符号链接**，
/// 而 `metadata` 会跟随它。若只判 `stat`，"链接目标被搬走（悬空链接）"会表现为"这里什么都没有"
/// —— 于是建链时会往同一个路径再 `hard_link` 一次，拿到 `AlreadyExists`，接着退化成 `copy`：
/// 而 `copy` 写的是**符号链接的目标**，不是在替换这个链接。结果既没修好、也没报错。
/// ⇒ 判断"这个路径上有没有东西"一律用 `lstat_safe`。
pub fn lstat_safe(p: &Path) -> Option<Stat> {
    let m = fs::symlink_metadata(p).ok()?;
    Some(stat_from(p, &m, true))
}

fn stat_from(p: &Path, m: &fs::Metadata, lstat: bool) -> Stat {
    let mtime_ms = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    let (dev, ino) = file_id(p, m);
    Stat {
        size: m.len(),
        mtime_ms,
        ino,
        dev,
        is_symbolic_link: lstat && m.file_type().is_symlink(),
    }
}

/// 文件身份 `(dev, ino)` —— 判"这两个路径是不是同一份"的唯一可靠依据。
///
/// 🔴 Windows 上不能用 `std::os::windows::fs::MetadataExt::file_index()`：
///    它挂在未稳定的 `windows_by_handle` feature 下（rust#63010），stable 工具链编译不过。
///    改走 `GetFileInformationByHandle`（`windows-sys`，A3c 已引入同样的依赖）。
#[cfg(unix)]
fn file_id(_p: &Path, m: &fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (m.dev(), m.ino())
}

#[cfg(windows)]
fn file_id(p: &Path, _m: &fs::Metadata) -> (u64, u64) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
    let f = match File::open(p) {
        Ok(f) => f,
        Err(_) => return (0, 0),
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetFileInformationByHandle(f.as_raw_handle() as HANDLE, &mut info) };
    if ok == 0 {
        return (0, 0);
    }
    let idx = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
    (info.dwVolumeSerialNumber as u64, idx)
}

/// 流式算 sha256（不把文件读进内存 —— Sakura 权重有 3.3 GB）。
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let f = File::open(path)?;
    let mut h = Sha256::new();
    let mut r = BufReader::with_capacity(1024 * 1024, f);
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = r.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

// ------------------------------------------------------------------ 反证开关

pub struct RefuteFlags {
    /// 关掉 SHA256 校验
    pub no_verify: bool,
    /// 关掉断点续传（每次从 0 重来）
    pub no_resume: bool,
    /// 关掉 `.ready` 幂等标记
    pub no_ready: bool,
    /// 关掉"把 store 链进引擎树"这一步
    pub no_link: bool,
    /// 关掉「**清单原 `url` 优先**」⇒ 只试 `sources`（2026-10-16 之前的旧行为）。
    ///
    /// 旧行为本身就是个缺陷（`sources` 一非空就把 `url` 丢掉，见 `source_candidates`），
    /// 留这个开关是为了让"原 `url` 真的参与了候选"这件事**可反证** —— 关掉它，
    /// `check:models` 的 H2 断言必须变红。
    pub no_url_first: bool,
    /// 夹具：**在同盘上强制走"跨卷"分支**（C2）。
    ///
    /// 真跨卷要两个卷才造得出来（e2e 里不能要求跑测机器有两块盘），而"跨卷时说跨卷"
    /// 正是 C2 的验收③ —— 没有这个开关，那条话术就只能靠读代码相信。
    pub force_crossdev: bool,
}

/// 反证开关（**只给测试用**；产品路径不得设置这些变量）。
/// 每个开关都对应断言里的一条"这个机制真的在起作用" —— 关掉它，那条断言必须变红。
pub fn refute_flags() -> RefuteFlags {
    let one = |k: &str| std::env::var(k).ok().as_deref() == Some("1");
    RefuteFlags {
        no_verify: one("MIAO_NO_MODEL_VERIFY"),
        no_resume: one("MIAO_NO_RESUME"),
        no_ready: one("MIAO_NO_READY"),
        no_link: one("MIAO_NO_LINK"),
        no_url_first: one("MIAO_NO_URL_FIRST"),
        force_crossdev: one("MIAO_LINK_FORCE_CROSSDEV"),
    }
}

// ------------------------------------------------------------------ 选择与平台

/// 选中要处理的文件：`ids` 优先，其次 `set`，都没有则全量。
pub fn select_files(manifest: &Manifest, ids: Option<&[String]>, set: Option<&str>) -> Result<Vec<FileEntry>, ModelStoreError> {
    let all = &manifest.files;
    if let Some(ids) = ids.filter(|v| !v.is_empty()) {
        // 显式点名 id ⇒ **不做平台过滤**：跨平台取证（例如在 Mac 上验 Windows 条目的下载）需要它。
        let mut picked = Vec::new();
        let mut missing: Vec<String> = Vec::new();
        for id in ids {
            match all.iter().find(|f| f.id == *id) {
                Some(f) => picked.push(f.clone()),
                None => missing.push(id.clone()),
            }
        }
        if !missing.is_empty() {
            return Err(ModelStoreError::with_detail(
                "MODEL_UNKNOWN_ID",
                format!("清单里没有这些 id：{}", missing.join(", ")),
                json!({ "missing": missing }),
            ));
        }
        return Ok(picked);
    }
    // `set` / 全量：**按当前平台过滤** —— 否则在 Windows 上会去下 macos-arm64 的 llama.cpp。
    let key = platform_key();
    if let Some(s) = set {
        let entry = manifest.sets.get(s).ok_or_else(|| {
            ModelStoreError::with_detail("MODEL_UNKNOWN_SET", format!("清单里没有 set「{s}」"), json!({ "set": s }))
        })?;
        let want: Vec<&String> = entry.files.iter().collect();
        return Ok(all
            .iter()
            .filter(|f| want.iter().any(|w| **w == f.id) && matches_platform(f, &key))
            .cloned()
            .collect());
    }
    Ok(all.iter().filter(|f| matches_platform(f, &key)).cloned().collect())
}

/// 条目的装配阶段（**缺省 1** —— 既有清单一条没写 `stage`，行为必须与今天一致）。
pub fn stage_of(f: &FileEntry) -> u8 {
    f.stage.unwrap_or(1)
}

/// G4：按阶段筛选（`max_stage` = 要跑到第几阶段；`None` = 不筛，行为与 [`select_files`] 一致）。
///
/// 🔴 为什么不把它加进 [`select_files`] 的参数里：那个函数有四个调用点
/// （`ensure_models` / `verify_models` / `link_models` / CLI），改签名等于让
/// 「默认行为」变成「每个调用点各自记得传 `None`」—— 而漏传一个 `None` 的后果是
/// **静默下了另一阶段的东西**（或漏下），两者都不报错。分阶段是 G4 才有的需求，
/// 单独一个函数更诚实。
pub fn select_files_staged(
    manifest: &Manifest,
    ids: Option<&[String]>,
    set: Option<&str>,
    max_stage: Option<u8>,
) -> Result<Vec<FileEntry>, ModelStoreError> {
    let picked = select_files(manifest, ids, set)?;
    let Some(max) = max_stage else { return Ok(picked) };
    Ok(picked.into_iter().filter(|f| stage_of(f) <= max).collect())
}

/// 当前平台标识，形如 `win32-x64` / `darwin-arm64` —— 与 manifest 条目的 `platform` 字段对齐。
///
/// `MIAO_PLATFORM` 是**取证专用**接缝（C3）：「Windows 上只引导 win32-x64 条目」这类结论
/// 在一台机器上只能验到一半 —— 不支持它的那一半（「darwin-arm64 下只引导 mac 条目」）
/// 要么去借机器，要么永远只是"读代码相信"。有了它，两侧镜像能在同一台机器上都验到。
/// ⚠️ 产品路径**不得**设置它；设错的表现是去下另一个平台的二进制。
pub fn platform_key() -> String {
    if let Some(v) = std::env::var("MIAO_PLATFORM").ok().filter(|s| !s.trim().is_empty()) {
        return v.trim().to_string();
    }
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        o => o,
    };
    // 只区分 arm64 与 x64（其余架构原样透传，避免把未知架构误当成 x64）。
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        a => a,
    };
    format!("{os}-{arch}")
}

/// 平台判据的**唯一实现**（无 `platform` 字段 = 平台无关，恒适用）。
///
/// 🔴 收在这里而不是各处自己写一遍：`select_files()`（下哪些）、`model_status()`（D8 渲染
/// 哪几条是"当前平台的"）必须给同一个答案 —— 两处各写一遍，必然有一天出现
/// 「界面说有 4 条待下、下载器只下 3 条」这种只有用户能发现的偏差。
pub fn platform_matches(platform: Option<&str>, key: &str) -> bool {
    match platform {
        None => true,
        Some(p) => p == key,
    }
}

/// 条目是否适用于给定平台。
pub fn matches_platform(file: &FileEntry, key: &str) -> bool {
    platform_matches(file.platform.as_deref(), key)
}

// ------------------------------------------------------------------ HuggingFace 缓存布局

#[derive(Debug, Clone)]
pub struct HfLayout {
    pub cache_dir: PathBuf,
    pub blob_from: PathBuf,
    pub snapshot_to: PathBuf,
    pub refs_to: PathBuf,
    pub refs_content: String,
}

/// 带 `hf` 的条目在 **HuggingFace 缓存布局**下的落点（纯函数，便于断言）。
///
/// 为什么需要它（见 docs/internal/spec-notes.md D-99）：英译中的离线档走 `huggingface_hub`，
/// 而 HF 的缓存不是"一个目录里平铺文件"：`try_to_load_from_cache()` 解析的是
///   `<cache>/models--<org>--<name>/snapshots/<revision>/<filename>`
/// 而该路径通常只是指向 `<cache>/models--<org>--<name>/blobs/<blob>` 的链接，
/// `<revision>` 又要从 `refs/main` 里读出来。
/// ⇒ 「把权重放进 `src/models/`」如果只平铺文件，HF **看不见**它 —— 于是照样联网重下。
/// 这一层就是"看得见"与"看不见"的分界。
///
/// 约定（可断言，不猜）：带 `hf` 的条目其 `linkTo` **必须**形如 `<cache>/blobs/<blob>`
/// ⇒ `<cache>` = 去掉最后两段。不满足就抛错：猜错的表现是「链接建好了、权重还是不被认」，
/// 症状与根因离得极远。
pub fn hf_layout(file: &FileEntry, root_dir: &Path, link_base: &Path) -> Result<Option<HfLayout>, ModelStoreError> {
    if file.hf.is_none() {
        return Ok(None);
    }
    let hf = file.hf.as_ref().unwrap();
    let link_to = file.link_to.as_deref().ok_or_else(|| {
        ModelStoreError::new("MODEL_HF_NO_LINK", format!("{}：带 hf 的条目必须有 linkTo", file.id))
    })?;
    let segs: Vec<&str> = link_to.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() < 3 || segs[segs.len() - 2] != "blobs" {
        return Err(ModelStoreError::with_detail(
            "MODEL_HF_BAD_LINK",
            format!("{}：带 hf 的条目其 linkTo 必须形如 <缓存>/blobs/<blob>，收到「{link_to}」", file.id),
            json!({ "id": file.id, "linkTo": link_to }),
        ));
    }
    let cache_dir = segs[..segs.len() - 2].iter().fold(link_base.to_path_buf(), |acc, s| acc.join(s));
    Ok(Some(HfLayout {
        snapshot_to: cache_dir.join("snapshots").join(&hf.revision).join(&hf.filename),
        refs_to: cache_dir.join("refs").join("main"),
        refs_content: hf.revision.clone(), // HF 写的是**裸** commit（无换行），照抄
        cache_dir,
        blob_from: root_dir.join(&file.dest),
    }))
}

// ------------------------------------------------------------------ .ready 标记

pub fn read_marker(root_dir: &Path) -> Option<Value> {
    let p = root_dir.join(READY_MARKER);
    let s = fs::read_to_string(p).ok()?;
    serde_json::from_str::<Value>(&s).ok()
}

pub fn write_marker(
    root_dir: &Path,
    manifest: &Manifest,
    records: &BTreeMap<String, MarkerRecord>,
) -> std::io::Result<Value> {
    let payload = json!({
        "manifestVersion": manifest.manifest_version,
        "engineCommit": manifest.engine_commit,
        "verifiedAt": now_iso(),
        "files": records,
    });
    let p = root_dir.join(READY_MARKER);
    let tmp = p.with_extension("json.tmp");
    let text = format!("{}\n", serde_json::to_string_pretty(&payload)?);
    fs::write(&tmp, text)?;
    fs::rename(&tmp, &p)?; // 原子替换：半截的 .ready 比没有更危险
    Ok(payload)
}

/// 标记里的记录能否代表**盘上当前这个文件**？
/// 判据 = dest / sha256 / 大小 / mtime 四件全等。
/// ⚠️ mtime 进判据是**故意的**：单靠大小挡不住"篡改一字节"（大小不变），
///    而每次启动都重算 3.3 GB 的哈希也不可接受。mtime 变了就退回真哈希。
///    代价：若有人篡改后**把 mtime 改回去**，快速路径会漏 —— 所以
///    `integrity:'hash'` 始终可达，且诊断/验收路径走的就是它（见 D-72）。
pub fn marker_matches(rec: Option<&Value>, dest: &str, st: &Stat, sha256: &str) -> bool {
    match rec {
        None => false,
        Some(r) => {
            r.get("dest").and_then(|v| v.as_str()) == Some(dest)
                && r.get("sha256").and_then(|v| v.as_str()) == Some(sha256)
                && r.get("sizeBytes").and_then(|v| v.as_u64()) == Some(st.size)
                && r.get("mtimeMs").and_then(|v| v.as_f64()) == Some(st.mtime_ms)
        }
    }
}

/// `toISOString()` 形态的 UTC 时间戳（不引第三方 crate）。
pub fn now_iso() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let millis = d.subsec_millis();
    let secs = d.as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, day) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        m,
        day,
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60,
        millis
    )
}

/// 毫秒时间戳 → `toISOString()` 形态（`disk.assembledAt` 用）。
///
/// 🔴 与 [`now_iso`] 共用同一套日历算法，**不引第三方 crate**；两处若各写一遍，
///    迟早出现"同一个时刻在界面上差一天"这种没人查得出的偏差。
pub fn iso_from_ms(ms: f64) -> String {
    let secs = (ms / 1000.0).floor() as i64;
    let millis = ((ms - (secs as f64) * 1000.0).round().clamp(0.0, 999.0)) as u64;
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, day) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        m,
        day,
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60,
        millis
    )
}

/// days since epoch → (year, month, day)（Howard Hinnant 的 civil_from_days）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ------------------------------------------------------------------ 单文件取回

/// 解析 `Content-Range: bytes 100-999/1000` 的总长。
fn total_from_content_range(v: Option<&str>) -> Option<u64> {
    let s = v?;
    let idx = s.rfind('/')?;
    s[idx + 1..].trim().parse::<u64>().ok()
}

struct Fetched {
    /// 最终成功那个源。**留着是为了诊断**（"到底走的哪个源"），主流程暂未消费。
    #[allow(dead_code)]
    url: String,
    resumed_from: u64,
    restarted: bool,
    bytes: u64,
}

/// 下载候选源：**清单原 `url` 优先，然后才是 `sources` 镜像**（去重、跳空）。
///
/// 顺序与 Node 侧 `asset-source.mjs::mirrorUrls()` 注释里那条**逐字一致**
/// （通道前缀 → 原 `url` → 镜像）。两侧一致不是审美问题：`check:models` 拿同一份用例跑双靶，
/// 顺序一散，同一个清单在两套实现上会表现得像两个下载器。
///
/// 🔴 旧实现是 `if file.sources.is_empty() { vec![url] } else { sources.clone() }` ——
///    `sources` 一非空，清单原 `url` 就被**整个丢掉**。于是"备用镜像"变成了"唯一来源"：
///    镜像一挂，即使原 `url` 好好的也永远试不到。2026-10-16 真跑装配就是这么整段失败的
///    （`[ENGINE_BOOTSTRAP_FAILED] [source] HTTP 403 Forbidden`），而日志里每条源都如实报了错，
///    离根因（镜像形态不被支持 + 原 `url` 被丢）极远。见 D-217。
///
/// `flags.no_url_first`（`MIAO_NO_URL_FIRST=1`）= **反证态**：退回"只试 `sources`"，
/// 让 `check:models` 的 H2（原 `url` 可用 + 镜像全挂 ⇒ 仍要下成）变红。
fn source_candidates(file: &FileEntry, flags: &RefuteFlags) -> Vec<String> {
    let raw: Vec<&String> = if flags.no_url_first {
        file.sources.iter().collect()
    } else {
        std::iter::once(&file.url).chain(file.sources.iter()).collect()
    };
    let mut out: Vec<String> = Vec::with_capacity(raw.len());
    for u in raw {
        let t = u.trim();
        if t.is_empty() || out.iter().any(|x| x == t) {
            continue;
        }
        out.push(t.to_string());
    }
    out
}

/// 把内容落到 `.part`（支持续传）。**不做哈希校验** —— 那是调用方的事。
///
/// 🔴 每次尝试都**重新量一次盘上 `.part` 的大小**，而不是沿用入参：
///    上一轮（或上一次调用、或本函数的上一次重试）可能已经写下了一部分字节。
///    用旧值会算出错的 Range 起点 —— 症状是"续传成功但文件哈希永远不对"。
/// 🔴 候选源由**调用方一处**（`source_candidates`）构造后传进来，本函数不再自己拼 ——
///    拼在两层里，就会重演"一侧按 `sources`、一侧按 `url`"的分叉。
fn fetch_to_part(
    part_abs: &Path,
    file: &FileEntry,
    candidates: &[String],
    allow_resume: bool,
    client: &reqwest::blocking::Client,
    on_progress: &mut Option<&mut dyn FnMut(ProgressEvent)>,
    logger: Option<&dyn Fn(&str)>,
) -> Result<Fetched, ModelStoreError> {
    let mut last_err: Option<ModelStoreError> = None;

    for url in candidates {
        for attempt in 0..=RETRY_PER_SOURCE {
            // allow_resume=false 是**反证态**（MIAO_NO_RESUME=1）：连重试都不许从断点接，
            // 必须每次从 0 全量下 —— 否则"关掉续传"这个反证根本咬不到东西（见 D-72）。
            let offset = if allow_resume { size_of(part_abs) } else { 0 };
            match try_once(part_abs, file, url, offset, client, on_progress) {
                Ok(f) => return Ok(f),
                Err(e) => {
                    if attempt >= RETRY_PER_SOURCE {
                        log(logger, &format!("  [源放弃] {url} —— 连试 {} 次仍失败：{}", attempt + 1, e));
                    } else {
                        log(logger, &format!("  [重试] {url} 第 {} 次中断（{}）⇒ 从断点接着下", attempt + 1, e));
                    }
                    last_err = Some(e);
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| ModelStoreError::new("MODEL_NO_SOURCE", format!("没有可用源：{}", file.id))))
}

fn try_once(
    part_abs: &Path,
    file: &FileEntry,
    url: &str,
    offset: u64,
    client: &reqwest::blocking::Client,
    on_progress: &mut Option<&mut dyn FnMut(ProgressEvent)>,
) -> Result<Fetched, ModelStoreError> {
    let mut req = client.get(url);
    if offset > 0 {
        req = req.header("Range", format!("bytes={offset}-"));
    }
    let resp = req.send().map_err(|e| {
        ModelStoreError::with_detail("MODEL_HTTP_ERROR", format!("请求失败：{e}"), json!({ "url": url }))
    })?;
    if !resp.status().is_success() {
        return Err(ModelStoreError::with_detail(
            "MODEL_HTTP_ERROR",
            format!("HTTP {}：{url}", resp.status()),
            json!({ "url": url, "status": resp.status().as_u16() }),
        ));
    }

    // 🔴 关键分流：发了 Range 但对方回 200 ⇒ 它给的是**全量**，必须从 0 重新计。
    let accepts_range = resp.status().as_u16() == 206;
    let from = if offset > 0 && accepts_range { offset } else { 0 };
    let restarted = offset > 0 && !accepts_range;

    let total = if accepts_range {
        total_from_content_range(resp.headers().get("content-range").and_then(|v| v.to_str().ok()))
    } else {
        resp.headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
    };

    write_body(part_abs, file, url, from, total, restarted, resp, on_progress)
}

fn write_body(
    part_abs: &Path,
    file: &FileEntry,
    url: &str,
    from: u64,
    total: Option<u64>,
    restarted: bool,
    resp: reqwest::blocking::Response,
    on_progress: &mut Option<&mut dyn FnMut(ProgressEvent)>,
) -> Result<Fetched, ModelStoreError> {
    let mut opt = OpenOptions::new();
    opt.create(true);
    if from > 0 {
        opt.append(true);
    } else {
        opt.write(true).truncate(true);
    }
    let mut f = opt.open(part_abs).map_err(|e| {
        ModelStoreError::with_detail(
            "MODEL_IO_ERROR",
            format!("无法写断点文件：{e}"),
            json!({ "path": part_abs.display().to_string() }),
        )
    })?;
    let emit = |received: u64, p: &mut Option<&mut dyn FnMut(ProgressEvent)>| {
        if let Some(cb) = p {
            cb(ProgressEvent {
                id: file.id.clone(),
                phase: "downloading".to_string(),
                received,
                total,
                url: Some(url.to_string()),
                resumed: from > 0,
                msg: None,
            });
        }
    };

    let mut received = from;
    emit(received, on_progress);

    let mut resp = resp;
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = resp.read(&mut buf).map_err(|e| {
            ModelStoreError::with_detail("MODEL_HTTP_ERROR", format!("读取响应中断：{e}"), json!({ "url": url }))
        })?;
        if n == 0 {
            break;
        }
        f.write_all(&buf[..n]).map_err(|e| {
            ModelStoreError::with_detail("MODEL_IO_ERROR", format!("写盘失败：{e}"), json!({ "url": url }))
        })?;
        received += n as u64;
        emit(received, on_progress);
    }
    f.flush().ok();
    drop(f);

    Ok(Fetched { url: url.to_string(), resumed_from: from, restarted, bytes: received })
}

// ------------------------------------------------------------------ 主流程

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureResult {
    pub total: usize,
    pub reused: Vec<String>,
    pub downloaded: Vec<String>,
    pub redownloaded: Vec<String>,
    pub resume_from: BTreeMap<String, u64>,
    pub bytes: u64,
}

/// 确保清单里的文件都就位且校验通过。
///
/// `integrity`:
///   'hash'   = **每个文件都重新算 SHA256**（诊断 / 验收口径，慢但不容错）
///   'cached' = 若 `.ready` 记录的 (sha256,size,mtime) 与盘上一致则跳过哈希（应用启动口径）
pub fn ensure_models(
    manifest: &Manifest,
    root_dir: &Path,
    ids: Option<&[String]>,
    set: Option<&str>,
    integrity: &str,
    logger: Option<&dyn Fn(&str)>,
    mut on_progress: Option<&mut dyn FnMut(ProgressEvent)>,
) -> Result<EnsureResult, ModelStoreError> {
    let flags = refute_flags();
    if integrity != "hash" && integrity != "cached" {
        return Err(ModelStoreError::new(
            "MODEL_BAD_INTEGRITY",
            format!("integrity 只能是 hash | cached，收到「{integrity}」"),
        ));
    }

    let files = select_files(manifest, ids, set)?;
    let prev = if flags.no_ready { None } else { read_marker(root_dir) };
    let mut records: BTreeMap<String, MarkerRecord> = BTreeMap::new();
    if let Some(p) = &prev {
        if let Some(obj) = p.get("files").and_then(|v| v.as_object()) {
            for (k, v) in obj {
                if let Ok(r) = serde_json::from_value::<MarkerRecord>(v.clone()) {
                    records.insert(k.clone(), r);
                }
            }
        }
    }

    let mut result = EnsureResult {
        total: files.len(),
        reused: Vec::new(),
        downloaded: Vec::new(),
        redownloaded: Vec::new(),
        resume_from: BTreeMap::new(),
        bytes: 0,
    };

    let client = reqwest::blocking::Client::new();

    for file in &files {
        let dest_rel = file.dest.clone();
        let dest_abs = root_dir.join(&dest_rel);
        let part_abs = PathBuf::from(format!("{}{}", dest_abs.display(), PART_SUFFIX));
        if let Some(parent) = dest_abs.parent() {
            fs::create_dir_all(parent).ok();
        }

        let st = stat_safe(&dest_abs);
        let mut need_download = st.is_none();

        if let Some(st) = st {
            if flags.no_verify {
                // 反证态（MIAO_NO_MODEL_VERIFY=1）：**存在即复用**，完全不看内容。
                // ⚠️ 这一支必须在最前面：否则 integrity:'hash' 会绕开开关去算哈希，反证轮就咬不到东西了。
                result.reused.push(file.id.clone());
                records.insert(file.id.clone(), marker_record(&dest_rel, None, &st));
                log(logger, &format!("  [复用] {}（⚠️ 未校验）", file.id));
                // 复用即"这条已满"：不发事件它就不会进账本（见 emit_reused 的说明）
                emit_reused(file, st.size, &mut on_progress);
                continue;
            }
            if integrity == "cached" && marker_matches(prev.as_ref().and_then(|p| p.get("files")?.get(&file.id)), &dest_rel, &st, &file.sha256) {
                result.reused.push(file.id.clone());
                log(logger, &format!("  [复用] {}（.ready 记录与盘上大小/mtime 一致）", file.id));
                emit_reused(file, st.size, &mut on_progress);
                continue;
            }
            emit_verifying(file, st.size, &mut on_progress);
            let got = sha256_file(&dest_abs).map_err(|e| {
                ModelStoreError::with_detail("MODEL_IO_ERROR", format!("读取 {} 失败：{e}", file.id), json!({ "id": file.id }))
            })?;
            if got == file.sha256 {
                result.reused.push(file.id.clone());
                records.insert(file.id.clone(), marker_record(&dest_rel, Some(got), &st));
                log(logger, &format!("  [复用] {}（sha256 校验通过）", file.id));
                emit_reused(file, st.size, &mut on_progress);
                continue;
            }
            log(
                logger,
                &format!(
                    "  [重下] {} 哈希不符：盘上 {}… ≠ 清单 {}…",
                    file.id,
                    &got[..12],
                    &file.sha256[..12]
                ),
            );
            need_download = true;
            result.redownloaded.push(file.id.clone());
            // 盘上那份是坏的 ⇒ 先清掉，别让续传把好字节接在坏字节后面
            fs::remove_file(&dest_abs).ok();
            fs::remove_file(&part_abs).ok();
        }

        if !need_download {
            continue;
        }

        // —— 下载 + 校验，失败自动重下（上限 REDOWNLOAD_LIMIT 次）
        let mut attempt = 0usize;
        loop {
            let partial = size_of(&part_abs);
            if partial > 0 {
                log(logger, &format!("  [续传] {} 从 {:.1} MB 接着下", file.id, partial as f64 / 1_048_576.0));
            }
            let candidates = source_candidates(file, &flags);
            let fetched = fetch_to_part(&part_abs, file, &candidates, !flags.no_resume, &client, &mut on_progress, logger)?;
            result.resume_from.insert(file.id.clone(), fetched.resumed_from);
            result.bytes += fetched.bytes;
            if fetched.restarted && partial > 0 {
                log(logger, &format!("  [注意] {} 的源不支持 Range ⇒ 退回全量重下（不是错误，是它的合法选择）", file.id));
            }

            // —— 落位 + 校验
            if let Some(parent) = dest_abs.parent() {
                fs::create_dir_all(parent).ok();
            }
            fs::rename(&part_abs, &dest_abs).map_err(|e| {
                ModelStoreError::with_detail("MODEL_IO_ERROR", format!("落位失败：{e}"), json!({ "id": file.id }))
            })?;
            let st2 = stat_safe(&dest_abs).ok_or_else(|| {
                ModelStoreError::new("MODEL_IO_ERROR", format!("落位后找不到文件：{}", dest_abs.display()))
            })?;

            if flags.no_verify {
                // 反证态：不校验。downloaded 照记，但坏内容会被当成好的。
                result.downloaded.push(file.id.clone());
                records.insert(file.id.clone(), marker_record(&dest_rel, None, &st2));
                log(logger, &format!("  [完成] {}（⚠️ 未校验）", file.id));
                break;
            }

            emit_verifying(file, st2.size, &mut on_progress);
            let got = sha256_file(&dest_abs).map_err(|e| {
                ModelStoreError::with_detail("MODEL_IO_ERROR", format!("读取 {} 失败：{e}", file.id), json!({ "id": file.id }))
            })?;
            if got == file.sha256 {
                result.downloaded.push(file.id.clone());
                records.insert(file.id.clone(), marker_record(&dest_rel, Some(got), &st2));
                log(logger, &format!("  [完成] {}（sha256 校验通过）", file.id));
                break;
            }

            fs::remove_file(&dest_abs).ok();
            if attempt >= REDOWNLOAD_LIMIT {
                // 🔴 不静默：源本身坏了就必须炸出来，否则后面会以"模型加载失败"的面目出现
                return Err(ModelStoreError::with_detail(
                    "MODEL_SHA256_MISMATCH",
                    format!(
                        "{} 重下 {} 次后 sha256 仍不符（期望 {}…，实际 {}…）——源内容有问题，不再重试",
                        file.id,
                        attempt + 1,
                        &file.sha256[..12],
                        &got[..12]
                    ),
                    json!({ "id": file.id, "expected": file.sha256, "actual": got, "attempts": attempt + 1 }),
                ));
            }
            attempt += 1;
            log(logger, &format!("  [重下] {} 校验失败，自动重下第 {} 次", file.id, attempt));
        }
    }

    if !flags.no_ready {
        write_marker(root_dir, manifest, &records).ok();
    }
    Ok(result)
}

fn marker_record(dest: &str, sha256: Option<String>, st: &Stat) -> MarkerRecord {
    MarkerRecord {
        dest: dest.to_string(),
        sha256,
        size_bytes: st.size,
        mtime_ms: serde_json::Number::from(st.mtime_ms.round() as u64),
    }
}

/// 复用某条已就绪的文件时补发的事件：**received == total**（"这条已满"）。
///
/// 🔴 为什么必须发：`ingest` 只认事件。不发的条目对账本**完全不可见** ——
///    分母里没有它、分子里也没有它，于是 `percent` 永远算不到 100%。
///    真机症状：下载显示完成、进度却停在 45%（用户 2026-10-25 报）。
///    发 `received: 0` 更糟：它占着分母却不贡献分子，等于把"已完成"记成"零字节"。
fn emit_reused(file: &FileEntry, total: u64, on_progress: &mut Option<&mut dyn FnMut(ProgressEvent)>) {
    if let Some(cb) = on_progress {
        cb(ProgressEvent {
            id: file.id.clone(),
            phase: "reused".to_string(),
            received: total,
            total: Some(total),
            url: None,
            resumed: false,
            msg: None,
        });
    }
}

/// 校验一条**已存在**的文件时发的事件。
///
/// 🔴 `received` 必须是 `total` 而不是 0：校验的对象是**盘上那份完整的文件**，
///    不是"从 0 开始下"。发 0 会把它记成"零字节"，占着分母不贡献分子 ——
///    那就是"下载完成、进度不到 100%"的直接成因（2026-10-25）。
fn emit_verifying(file: &FileEntry, total: u64, on_progress: &mut Option<&mut dyn FnMut(ProgressEvent)>) {
    if let Some(cb) = on_progress {
        cb(ProgressEvent {
            id: file.id.clone(),
            phase: "verifying".to_string(),
            received: total,
            total: Some(total),
            url: None,
            resumed: false,
            msg: None,
        });
    }
}

// ------------------------------------------------------------------ 纯校验

#[derive(Debug, Clone, Serialize)]
pub struct BadFile {
    pub id: String,
    pub expected: String,
    pub actual: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct VerifyResult {
    pub total: usize,
    pub ok: Vec<String>,
    pub bad: Vec<BadFile>,
    pub missing: Vec<String>,
}

/// 纯校验（不联网）：逐文件比对 sha256。
/// 给诊断视图与验收用 —— 它能在"只看盘上字节"的前提下回答"模型是不是好的"。
pub fn verify_models(
    manifest: &Manifest,
    root_dir: &Path,
    ids: Option<&[String]>,
    set: Option<&str>,
    mut on_progress: Option<&mut dyn FnMut(ProgressEvent)>,
) -> Result<VerifyResult, ModelStoreError> {
    let files = select_files(manifest, ids, set)?;
    let mut out = VerifyResult { total: files.len(), ok: Vec::new(), bad: Vec::new(), missing: Vec::new() };
    for file in &files {
        let dest_abs = root_dir.join(&file.dest);
        let st = match stat_safe(&dest_abs) {
            Some(s) => s,
            None => {
                out.missing.push(file.id.clone());
                continue;
            }
        };
        emit_verifying(file, st.size, &mut on_progress);
        let got = sha256_file(&dest_abs).map_err(|e| {
            ModelStoreError::with_detail("MODEL_IO_ERROR", format!("读取 {} 失败：{e}", file.id), json!({ "id": file.id }))
        })?;
        if got == file.sha256 {
            out.ok.push(file.id.clone());
        } else {
            out.bad.push(BadFile { id: file.id.clone(), expected: file.sha256.clone(), actual: got });
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ 建链

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HfLink {
    pub id: String,
    pub snapshot: String,
    pub refs: String,
    pub how: String,
    pub refs_written: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LinkResult {
    pub total: usize,
    pub base: String,
    pub linked: Vec<String>,
    pub already: Vec<String>,
    pub copied: Vec<String>,
    pub skipped: Vec<String>,
    pub hf: Vec<HfLink>,
    /// **因跨卷而降级为复制**的条目 id（C2）。
    ///
    /// 为什么单独立一列而不是只写日志：跨卷是**唯一**一种"链接没建成但我们认为可以接受"的
    /// 情况（退化复制，原样可用，只是多占一份盘）。它与"硬链接真失败"混在同一句日志里时，
    /// 用户与我们都分不清"该不该管它" —— 而界面/脚本需要一个**可判定的**信号。
    pub cross_device: Vec<String>,
}

/// 这个 IO 错误是不是"跨卷/跨设备"（硬链接建不了，只能退化成复制）？
///
/// 🔴 两个平台恰好**同一个号 17**：POSIX 是 `EXDEV`，Windows 是 `ERROR_NOT_SAME_DEVICE`。
///    于是不必分平台写两套判断（那样必然有一边没人测）。
pub fn is_cross_device(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(17)
}

/// 把 store 里的权威副本**硬链接**进引擎源码树（`linkTo`）。
/// =============================================================================
/// 为什么需要这一步：引擎把模型路径硬编码在源码树里
/// （`utils/inference.py:94` `_MODEL_DIR = join(BASE_PATH,'models')`），
/// 而 `server/args.py` **没有** `--model-dir` ⇒ 视觉模型必须出现在 `src/models/<子目录>/`。
/// 于是"引擎换版本"（删除 `src/` 后重新解包）会把模型一起带走。
///
/// 解法：权威副本只存一份在 store（manifest 的 `dest`），引擎树里那份是**硬链接**。
///   · 硬链接不额外占盘、读写路径完全透明（引擎看到的就是普通文件）；
///   · 换版本后只需重跑这一步（毫秒级、**零网络**），不必重下几个 GB；
///   · 首选硬链接而非符号链接：Python 侧对符号链接的处理（realpath / replace / 写入跟随）
///     会带来多余的不确定性，而硬链接在文件系统层面就是一个普通文件。
///   · 跨设备/不支持硬链接时退化为**复制**（并如实记账，不假装是链接）。
///
/// ⚠️ 已知边界：若引擎在"文件已存在"的前提下仍去写这个路径（本项目的预置策略使它不会），
///    由于共享 inode，写入会同时改到 store 里的权威副本。故 `verify_models()` 是这套设计的安全网。
pub fn link_models(
    manifest: &Manifest,
    root_dir: &Path,
    link_base: Option<&Path>,
    ids: Option<&[String]>,
    set: Option<&str>,
    logger: Option<&dyn Fn(&str)>,
) -> Result<LinkResult, ModelStoreError> {
    let flags = refute_flags();
    let selected = select_files(manifest, ids, set)?;
    let files: Vec<FileEntry> = selected.into_iter().filter(|f| f.link_to.is_some()).collect();
    let base: PathBuf = match link_base {
        Some(b) => b.to_path_buf(),
        None => root_dir.join("src"),
    };
    let mut out = LinkResult {
        total: files.len(),
        base: base.display().to_string(),
        linked: Vec::new(),
        already: Vec::new(),
        copied: Vec::new(),
        skipped: Vec::new(),
        hf: Vec::new(),
        cross_device: Vec::new(),
    };

    if flags.no_link {
        out.skipped = files.iter().map(|f| f.id.clone()).collect();
        log(logger, "  [跳过] 全部（⚠️ 反证态：链接步骤被关闭）");
        return Ok(out);
    }

    for file in &files {
        let from = root_dir.join(&file.dest);
        let st_from = match stat_safe(&from) {
            Some(s) => s,
            None => {
                out.skipped.push(file.id.clone());
                log(logger, &format!("  [跳过] {}：store 里没有它（先跑下载）", file.id));
                continue;
            }
        };
        let to = match &file.link_to {
            Some(l) => base.join(l),
            None => continue,
        };
        let (how, cross) = link_one(&file.id, &from, &to, &base, st_from, logger)?;
        if cross {
            out.cross_device.push(file.id.clone());
        }
        match how {
            LinkHow::Linked => out.linked.push(file.id.clone()),
            LinkHow::Already => out.already.push(file.id.clone()),
            LinkHow::Copied => out.copied.push(file.id.clone()),
        }

        // —— HuggingFace 缓存布局：blob 之外还要有 snapshots/<rev>/<file> 与 refs/main，
        //    否则引擎用 huggingface_hub 判"权重在不在"时会**看不见**这份权重（见 `hf_layout`）。
        if let Some(hf) = hf_layout(file, root_dir, &base)? {
            // snapshot 那一条是同一个 blob 的**第二个落点**：同一个卷上，跨不跨卷与主落点一致，
            // 故不重复记账（否则同一条目会在 cross_device 里出现两次，计数就说不清了）。
            let (how, _cross) = link_one(&format!("{}#snapshot", file.id), &from, &hf.snapshot_to, &base, st_from, logger)?;
            let refs_written = write_refs_if_changed(&hf.refs_to, &hf.refs_content)?;
            out.hf.push(HfLink {
                id: file.id.clone(),
                snapshot: hf.snapshot_to.display().to_string(),
                refs: hf.refs_to.display().to_string(),
                how: how.as_str().to_string(),
                refs_written,
            });
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinkHow {
    Linked,
    Already,
    Copied,
}

impl LinkHow {
    fn as_str(self) -> &'static str {
        match self {
            LinkHow::Linked => "linked",
            LinkHow::Already => "already",
            LinkHow::Copied => "copied",
        }
    }
}

/// 把 `from` 落到 `to`（硬链接优先，跨设备退化复制）。
///
/// 🔴 判"路径上有没有东西"用 `lstat_safe` 而非 `stat_safe`：HF 在 `snapshots/` 下留的是
///    相对符号链接，`metadata` 会跟随它 —— 链接悬空时返回 null，于是这里会以为
///    "路径是空的"而直接 `hard_link` 拿到 `AlreadyExists`，再退化成 `copy`，
///    而 `copy` 写的是**链接指向的目标**、并不是替换这个链接本身。既没修好也不报错。
/// 返回 `(怎么落的, 是不是因跨卷降级)` —— 第二项给 `LinkResult.cross_device` 用。
fn link_one(
    label: &str,
    from: &Path,
    to: &Path,
    base: &Path,
    st_from: Stat,
    logger: Option<&dyn Fn(&str)>,
) -> Result<(LinkHow, bool), ModelStoreError> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).ok();
    }
    if lstat_safe(to).is_some() {
        if let Some(st_to) = stat_safe(to) {
            if st_to.ino != 0 && st_to.ino == st_from.ino && st_to.dev == st_from.dev {
                return Ok((LinkHow::Already, false));
            }
        }
        // 悬空链接 / 上一版本留下的旧文件
        fs::remove_file(to).ok();
    }

    // 夹具（`MIAO_LINK_FORCE_CROSSDEV=1`）：同盘上复现跨卷那条分支。见 `RefuteFlags::force_crossdev`。
    let hard = if refute_flags().force_crossdev {
        Err(std::io::Error::from_raw_os_error(17))
    } else {
        fs::hard_link(from, to)
    };

    match hard {
        Ok(()) => {
            let rel = to.strip_prefix(base).unwrap_or(to);
            log(logger, &format!("  [链接] {label} → {}", rel.display()));
            Ok((LinkHow::Linked, false))
        }
        Err(e) => {
            // 跨卷（或跨设备）：退化为复制，但**如实记账** —— 说的是"跨卷"，
            // 不是笼统一句"硬链接失败"。其他失败（权限、配额、路径过长）继续报原始错误。
            let cross = is_cross_device(&e);
            fs::copy(from, to).map_err(|ce| {
                ModelStoreError::with_detail(
                    "MODEL_IO_ERROR",
                    if cross {
                        format!(
                            "跨卷（{} → {} 不在同一个盘）且复制也失败：{ce}",
                            from.display(),
                            to.display()
                        )
                    } else {
                        format!("硬链接与复制都失败：{e} / {ce}")
                    },
                    json!({
                        "from": from.display().to_string(),
                        "to": to.display().to_string(),
                        "crossDevice": cross,
                    }),
                )
            })?;
            log(
                logger,
                &format!(
                    "  [复制] {label}（{}）",
                    if cross { "跨卷：与权威副本不在同一个盘，已改为复制".to_string() } else { format!("硬链接不可用：{e}") }
                ),
            );
            Ok((LinkHow::Copied, cross))
        }
    }
}

/// 写 `refs/main`（内容 = 裸 commit）。**内容一致就不动它** —— 避免每次装配都刷新 mtime，
/// 那会让"这次装配真的改了什么"变得看不出来。
fn write_refs_if_changed(refs_to: &Path, content: &str) -> Result<bool, ModelStoreError> {
    if let Some(parent) = refs_to.parent() {
        fs::create_dir_all(parent).ok();
    }
    if let Ok(cur) = fs::read_to_string(refs_to) {
        if cur == content {
            return Ok(false);
        }
    }
    fs::write(refs_to, content).map_err(|e| {
        ModelStoreError::with_detail(
            "MODEL_IO_ERROR",
            format!("写 refs/main 失败：{e}"),
            json!({ "path": refs_to.display().to_string() }),
        )
    })?;
    Ok(true)
}

// ------------------------------------------------------------------ HF 可解析性

#[derive(Debug, Clone, Serialize)]
pub struct HfMissing {
    pub id: String,
    pub snapshot: bool,
    pub store: bool,
    pub refs: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HfVerifyResult {
    pub total: usize,
    pub ok: Vec<String>,
    pub missing: Vec<HfMissing>,
}

/// 纯校验（不联网）：带 `hf` 的条目在引擎树里**是否真的能被 HF 解析到**。
/// =============================================================================
/// 判据三条，缺一不可（任何一条缺了，`try_to_load_from_cache()` 就会返回 None，
/// 引擎随即联网重下 —— 在本机表现为 `ProxyError 502`）：
///   ① `snapshots/<revision>/<filename>` 存在（HF 认的是这个路径，不是 blobs 那个）
///   ② `refs/main` 的内容 = `revision`（HF 靠它把 "main" 解析成 commit）
///   ③ 权威副本（store 的 `dest`）在
/// 这是「链接建完了但权重仍然不被认」这一整类问题的**唯一**承担者。
pub fn verify_hf_cache(
    manifest: &Manifest,
    root_dir: &Path,
    link_base: Option<&Path>,
    ids: Option<&[String]>,
    set: Option<&str>,
) -> Result<HfVerifyResult, ModelStoreError> {
    let base: PathBuf = match link_base {
        Some(b) => b.to_path_buf(),
        None => root_dir.join("src"),
    };
    let selected = select_files(manifest, ids, set)?;
    let files: Vec<FileEntry> = selected.into_iter().filter(|f| f.hf.is_some()).collect();
    let mut out = HfVerifyResult { total: files.len(), ok: Vec::new(), missing: Vec::new() };
    for file in &files {
        let l = match hf_layout(file, root_dir, &base)? {
            Some(l) => l,
            None => continue,
        };
        let snap = stat_safe(&l.snapshot_to).is_some();
        let store = stat_safe(&l.blob_from).is_some();
        let ref_ok = fs::read_to_string(&l.refs_to).map(|s| s.trim() == l.refs_content.trim()).unwrap_or(false);
        if snap && store && ref_ok {
            out.ok.push(file.id.clone());
        } else {
            out.missing.push(HfMissing { id: file.id.clone(), snapshot: snap, store, refs: ref_ok });
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ 单测

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, dest: &str) -> FileEntry {
        FileEntry {
            id: id.to_string(),
            set: Some("all".to_string()),
            dest: dest.to_string(),
            link_to: None,
            hf: None,
            platform: None,
            sha256: "a".repeat(64),
            size_bytes: Some(10),
            url: "http://x/y".to_string(),
            sources: vec![],
            extract_to: None,
            extract_strip: None,
            stage: None,
        }
    }

    /// 全 false 的反证开关：**显式构造，不读 env** —— 单测是多线程的，
    /// 读环境变量会串到别的用例（同 `cross_device_is_os_error_17_only` 的注释）。
    fn no_flags() -> RefuteFlags {
        RefuteFlags {
            no_verify: false,
            no_resume: false,
            no_ready: false,
            no_link: false,
            no_url_first: false,
            force_crossdev: false,
        }
    }

    fn manifest(files: Vec<FileEntry>) -> Manifest {
        Manifest {
            manifest_version: json!(1),
            engine_commit: "abc".to_string(),
            sets: BTreeMap::new(),
            files,
        }
    }

    #[test]
    fn platform_key_shape() {
        // 形如 `win32-x64` / `darwin-arm64`：只认这两种形态，别把未知架构误当 x64。
        let k = platform_key();
        assert!(k.contains('-'));
        let (os, arch) = k.split_once('-').unwrap();
        assert!(matches!(os, "win32" | "darwin" | "linux"));
        assert!(matches!(arch, "x64" | "arm64") || !arch.is_empty());
    }

    #[test]
    fn matches_platform_rules() {
        let mut f = entry("a", "a.bin");
        assert!(matches_platform(&f, "win32-x64")); // 无 platform = 平台无关
        f.platform = Some("win32-x64".to_string());
        assert!(matches_platform(&f, "win32-x64"));
        assert!(!matches_platform(&f, "darwin-arm64"));
    }

    #[test]
    fn select_files_unknown_id_errors() {
        let m = manifest(vec![entry("alpha", "alpha.bin")]);
        let ids = vec!["nope".to_string()];
        let e = select_files(&m, Some(&ids), None).unwrap_err();
        assert_eq!(e.code, "MODEL_UNKNOWN_ID");
    }

    #[test]
    fn select_files_unknown_set_errors() {
        let m = manifest(vec![entry("alpha", "alpha.bin")]);
        let e = select_files(&m, None, Some("nosuch")).unwrap_err();
        assert_eq!(e.code, "MODEL_UNKNOWN_SET");
    }

    #[test]
    fn select_files_ids_skip_platform_filter() {
        // 显式点名 id ⇒ 不做平台过滤（跨平台取证需要它）。
        let mut f = entry("w", "w.bin");
        f.platform = Some("win32-x64".to_string());
        let m = manifest(vec![f]);
        let ids = vec!["w".to_string()];
        assert_eq!(select_files(&m, Some(&ids), None).unwrap().len(), 1);
    }

    #[test]
    fn hf_layout_requires_blobs_link() {
        let mut f = entry("x", "store/b.bin");
        f.hf = Some(HfInfo { revision: "rev".to_string(), filename: "config.json".to_string() });
        f.link_to = Some("models/files/config.json".to_string());
        let e = hf_layout(&f, Path::new("/root"), Path::new("/base")).unwrap_err();
        assert_eq!(e.code, "MODEL_HF_BAD_LINK");
    }

    #[test]
    fn hf_layout_missing_link_to_errors() {
        let mut f = entry("x", "store/b.bin");
        f.hf = Some(HfInfo { revision: "rev".to_string(), filename: "config.json".to_string() });
        let e = hf_layout(&f, Path::new("/root"), Path::new("/base")).unwrap_err();
        assert_eq!(e.code, "MODEL_HF_NO_LINK");
    }

    #[test]
    fn hf_layout_paths() {
        let mut f = entry("x", "store/b.bin");
        f.hf = Some(HfInfo { revision: "rev1".to_string(), filename: "config.json".to_string() });
        f.link_to = Some("models/c/blobs/BLOB".to_string());
        let l = hf_layout(&f, Path::new("/root"), Path::new("/base")).unwrap().unwrap();
        assert!(l.snapshot_to.to_string_lossy().replace('\\', "/").ends_with("models/c/snapshots/rev1/config.json"));
        assert!(l.refs_to.to_string_lossy().replace('\\', "/").ends_with("models/c/refs/main"));
        assert_eq!(l.refs_content, "rev1");
    }

    #[test]
    fn marker_matches_all_four_fields() {
        let st = Stat { size: 10, mtime_ms: 1.0, ino: 1, dev: 1, is_symbolic_link: false };
        let rec = json!({ "dest": "a.bin", "sha256": "x", "sizeBytes": 10, "mtimeMs": 1 });
        assert!(marker_matches(Some(&rec), "a.bin", &st, "x"));
        assert!(!marker_matches(Some(&rec), "b.bin", &st, "x"));
        assert!(!marker_matches(Some(&rec), "a.bin", &st, "y"));
        assert!(!marker_matches(None, "a.bin", &st, "x"));
    }

    #[test]
    fn total_from_content_range_parses() {
        assert_eq!(total_from_content_range(Some("bytes 100-999/1000")), Some(1000));
        assert_eq!(total_from_content_range(Some("bytes 0-0/1")), Some(1));
        assert_eq!(total_from_content_range(None), None);
        assert_eq!(total_from_content_range(Some("garbage")), None);
    }

    #[test]
    fn now_iso_shape() {
        let s = now_iso();
        assert!(s.ends_with('Z'), "{s}");
        assert_eq!(s.len(), 24, "{s}");
    }

    #[test]
    fn integrity_values_are_closed() {
        let m = manifest(vec![]);
        let e = ensure_models(&m, Path::new("/nonexistent-root"), None, None, "sloppy", None, None).unwrap_err();
        assert_eq!(e.code, "MODEL_BAD_INTEGRITY");
    }

    /// 候选源的**顺序**：清单原 `url` 在最前，`sources` 照原样跟在后面。
    /// 🔴 这条单测咬的就是 D-217（旧行为："`sources` 一非空就把原 `url` 丢掉"）——
    ///    在单测这一层就该红，不必等到真机跑一次装配才发现"备用镜像成了唯一来源"。
    #[test]
    fn source_candidates_keeps_url_first() {
        let mut f = entry("a", "a.bin");
        f.url = "https://canonical/a".to_string();
        f.sources = vec!["https://mirror/a".to_string(), "https://mirror2/a".to_string()];
        assert_eq!(
            source_candidates(&f, &no_flags()),
            vec!["https://canonical/a", "https://mirror/a", "https://mirror2/a"],
        );
    }

    /// 去重 + 跳空：清单里 `sources` 常把原 `url` 又写一遍（各自手写，早晚写重复），
    /// 重复项会让**同一个坏源被试两遍**（每遍 `RETRY_PER_SOURCE` 次重试）。
    #[test]
    fn source_candidates_dedups_and_skips_blank() {
        let mut f = entry("a", "a.bin");
        f.url = "https://canonical/a".to_string();
        f.sources = vec![
            String::new(),
            "   ".to_string(),
            "https://canonical/a".to_string(),
            " https://mirror/a ".to_string(),
        ];
        assert_eq!(
            source_candidates(&f, &no_flags()),
            vec!["https://canonical/a", "https://mirror/a"],
        );
    }

    /// 反证态**语义本身**：`MIAO_NO_URL_FIRST=1` ⇒ 只剩 `sources`（即 2026-10-16 前的旧行为）。
    /// 这条不是"验开关有用"，而是把"旧行为长什么样"钉下来：`check:models` 的 H2
    /// 靠它把 H1 的假阳性（`url` 被丢掉却依然全绿）翻出来。
    #[test]
    fn source_candidates_refute_state_drops_url() {
        let mut f = entry("a", "a.bin");
        f.url = "https://canonical/a".to_string();
        f.sources = vec!["https://mirror/a".to_string()];
        let mut flags = no_flags();
        flags.no_url_first = true;
        assert_eq!(source_candidates(&f, &flags), vec!["https://mirror/a"]);
    }

    /// 什么都不声明 ⇒ 空候选：调用方据此报 `MODEL_NO_SOURCE`，
    /// 而不是拿一个空串去发请求（那会得到一个"HTTP error"型的、离根因很远的报错）。
    #[test]
    fn source_candidates_empty_when_nothing_declared() {
        let mut f = entry("a", "a.bin");
        f.url = String::new();
        f.sources = vec![];
        assert!(source_candidates(&f, &no_flags()).is_empty());
    }

    /// C2：跨卷判定认的是 **os error 17**（POSIX `EXDEV` / Windows `ERROR_NOT_SAME_DEVICE` 同号）。
    ///
    /// 🔴 不能"凡失败都算跨卷"：那会把权限/配额/路径过长一起说成"跨卷，没事"。
    ///    行为层（跨卷 ⇒ 复制 ⇒ 记进 `cross_device`）由 `check:model-runner` 在子进程里验
    ///    —— 那条路径需要一个 env 夹具开关，而单测是**多线程**的，设全局 env 会串到别的用例。
    #[test]
    fn cross_device_is_os_error_17_only() {
        assert!(is_cross_device(&std::io::Error::from_raw_os_error(17)), "17 = EXDEV / ERROR_NOT_SAME_DEVICE");
        assert!(!is_cross_device(&std::io::Error::from_raw_os_error(2)), "2 = 文件不在，不是跨卷");
        assert!(!is_cross_device(&std::io::Error::from_raw_os_error(13)), "13 = 权限不足，不是跨卷");
        let other = std::io::Error::new(std::io::ErrorKind::Other, "no raw os error");
        assert!(!is_cross_device(&other), "没有 raw os error 的错误不许被猜成跨卷");
    }
}
