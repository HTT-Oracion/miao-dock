// 模型就绪态 —— `GET /engine/status` 的 `models` 块（《03》§5.2）
// =============================================================================
// 移植自 `service/src/settings/model-status.mjs`（84 行）。
//
// 回答两个问题：① 现在能不能真翻译（`visualReady` / `sakuraReady`）；② 盘上这些文件
// **上一次被完整校验**是什么时候（`lastVerifiedAt`）。
//
// 🔴 为什么这里只做 `stat`、不做哈希：视觉 4 件 + Sakura 权重合计 ≈ 4 GB。诊断视图是
//    **可以被反复打开**的界面元素，每次打开都重算 3.3 GB 的 sha256 会让"看一眼状态"
//    变成分钟级操作。故判据是 **在位 + 大小与清单一致**，而 `lastVerifiedAt` 专门用来把
//    「刚才 stat 过」和「上次完整校验过」这两件事分开报 —— 不把前者说成后者。
//
// ⚠️ 路径按**谁真会去开它**来选，不是按"清单里写的是哪个"：
//    · 声明了 `linkTo` 的文件 → 引擎实际打开的是 `<rootDir>/src/<linkTo>`（硬链接）；
//    · 没声明 `linkTo` 的（Sakura 权重 / llama 归档）→ 就地读 `<rootDir>/<dest>`。
//    只看 `dest` 会漏掉「store 里有、但没链进引擎树」这一种**真的跑不起来**的状态。
use std::path::{Path, PathBuf};

use serde_json::Value;

/// `modelStatus()` 的产出：三个聚合布尔 + **逐条清单**（D8）。
///
/// ## 为什么在三个布尔之外还要 `files`
/// 三个布尔回答"现在能不能翻译"，却回答不了"**还缺哪一个文件**"—— 而后者才是用户在点
/// 「重新下载模型」之前真正要问的。早先界面只能拿 `POST /models/verify` 的 `problems`
/// 文本行凑，那还要先跑一次几分钟的 SHA256 校验；诊断视图自己答不出来。
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub visual_ready: bool,
    pub sakura_ready: bool,
    pub last_verified_at: Option<String>,
    /// 清单逐条渲染（**顺序与 `files` 一致**）。清单读不到 ⇒ 空数组（仍可回 `unknown` 三键）。
    pub files: Vec<ModelFileStatus>,
}

/// 清单里的一条：**渲染出来**（不是写死在界面里）的下载引导行。
///
/// 字段取自 `models.manifest.json` 本身 ⇒ 改清单条目，引导跟着变（D8 验收②）。
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelFileStatus {
    pub id: String,
    /// 所属分组（`visual` / `llm` / `runtime` / `translation`）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set: Option<String>,
    /// 清单里的落点（相对模型根）
    pub dest: String,
    /// 引擎实际打开的那个（相对 `<root>/src`；无 ⇒ 省略键）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_to: Option<String>,
    /// 下载地址（界面把"从哪来"也说出来）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    /// 平台限定（`win32-x64` / `darwin-arm64`；省略 = 平台无关）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    /// 是否适用于**当前平台** ⇒ 界面据此决定要不要把它算进"你还缺什么"
    pub applicable: bool,
    /// 就绪判据：在位且大小与清单一致
    pub ready: bool,
    /// **判据真正作用的那一个绝对路径**（D8 验收①：每条都带目标绝对路径）
    pub path: String,
}

impl ModelStatus {
    /// 清单读不到时的保守结论 —— **不再抛错**（否则一个缺清单的机器连诊断视图都打不开）。
    pub fn unknown() -> Self {
        ModelStatus { visual_ready: false, sakura_ready: false, last_verified_at: None, files: Vec::new() }
    }
}

/// 读取 `.ready` 标记（S3 写入；不存在 ⇒ `None`，不报错）。
pub fn read_ready_marker(root_dir: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(root_dir.join(".models.ready.json")).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    if parsed.is_object() {
        Some(parsed)
    } else {
        None
    }
}

/// `fs.statSync(p)` 的 `isFile() ? size : null`。
fn size_at(p: &Path) -> Option<u64> {
    let md = std::fs::metadata(p).ok()?;
    if md.is_file() {
        Some(md.len())
    } else {
        None
    }
}

/// 把 `join` 留下的**混合分隔符**规范化成平台形态。
///
/// 🔴 为什么必须做：`Path::join("models/x.bin")` 在 Windows 上**保留正斜杠**（Rust 不做
///    规范化，只有交给 OS 时才无关紧要）⇒ 得到 `C:\root\src/models/x.bin` 这种混排。
///    这个路径要进界面、还要与安装引导文档里那条全反斜杠的落点对照 ——
///    混着两种斜杠会让人以为"说的不是同一个地方"，也会让 e2e 的两侧算不到一起。
fn normalize(p: PathBuf) -> PathBuf {
    p.components().collect()
}

/// 一条清单条目**实际会被打开**的绝对路径。
///
/// 判据与渲染**共用这一个函数**：两处各算一遍，迟早出现「清单说这个路径、判据说那个路径」
/// —— 而那种偏差在界面上只表现为"文件明明在，却显示缺失"。
fn abs_for(f: &Value, root_dir: &Path, base: &Path) -> PathBuf {
    let link_to = f.get("linkTo").and_then(|v| v.as_str()).unwrap_or("");
    let p = if !link_to.is_empty() {
        if Path::new(link_to).is_absolute() {
            PathBuf::from(link_to)
        } else {
            base.join(link_to)
        }
    } else {
        root_dir.join(f.get("dest").and_then(|v| v.as_str()).unwrap_or(""))
    };
    normalize(p)
}

/// 「在位且大小与清单一致」—— 清单没写 `sizeBytes` 时退化为"存在即就绪"（不假装校验过大小）。
fn ready_at(abs: &Path, f: &Value) -> bool {
    let Some(got) = size_at(abs) else { return false };
    match f.get("sizeBytes").and_then(|v| v.as_u64()) {
        Some(want) => got == want,
        None => true,
    }
}

fn str_at(f: &Value, key: &str) -> Option<String> {
    f.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string)
}

/// 模型就绪态。`link_base` 缺省 `<root_dir>/src`。
pub fn model_status(manifest_path: &Path, root_dir: &Path, link_base: Option<&Path>) -> ModelStatus {
    let base: PathBuf = link_base.map(Path::to_path_buf).unwrap_or_else(|| root_dir.join("src"));

    let manifest: Value = match std::fs::read_to_string(manifest_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
    {
        Some(v) => v,
        None => return ModelStatus::unknown(),
    };

    let files: Vec<&Value> = manifest.get("files").and_then(|f| f.as_array()).map(|a| a.iter().collect()).unwrap_or_default();

    let in_set = |set_name: &str| -> Vec<String> {
        manifest
            .get("sets")
            .and_then(|s| s.get(set_name))
            .and_then(|s| s.get("files"))
            .and_then(|f| f.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    };

    let all_ready = |set_name: &str| -> bool {
        let ids = in_set(set_name);
        let picked: Vec<&Value> = files
            .iter()
            .filter(|f| f.get("id").and_then(|v| v.as_str()).map(|id| ids.iter().any(|x| x == id)).unwrap_or(false))
            .copied()
            .collect();
        // 空集合 ⇒ **不是**"就绪"：清单里一个文件都没声明时，说什么都不该是"能翻译"。
        !picked.is_empty() && picked.iter().all(|f| ready_at(&abs_for(f, root_dir, &base), f))
    };

    // 逐条渲染（D8）。平台判据走 `model_store::platform_matches` —— 与"下哪些"同一个实现。
    let key = super::model_store::platform_key();
    let files_out: Vec<ModelFileStatus> = files
        .iter()
        .map(|f| {
            let abs = abs_for(f, root_dir, &base);
            let platform = str_at(f, "platform");
            ModelFileStatus {
                id: f.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                set: str_at(f, "set"),
                dest: f.get("dest").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                link_to: str_at(f, "linkTo"),
                url: str_at(f, "url"),
                size_bytes: f.get("sizeBytes").and_then(|v| v.as_u64()),
                applicable: super::model_store::platform_matches(platform.as_deref(), &key),
                ready: ready_at(&abs, f),
                path: abs.to_string_lossy().into_owned(),
                platform,
            }
        })
        .collect();

    let marker = read_ready_marker(root_dir);
    ModelStatus {
        visual_ready: all_ready("visual"),
        sakura_ready: all_ready("llm"),
        last_verified_at: marker
            .as_ref()
            .and_then(|m| m.get("verifiedAt"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        files: files_out,
    }
}

/// 当前平台**会去下**的那些条目的字节和（D1 的"约 X GB"取这个数）。
///
/// 🔴 它**只算模型资产**，不含用户自己的 Python / torch —— 后者体积由用户环境决定，
///    我们算不出来；把它算进去就是编数字。故文案说"模型资产"，不说"安装总量"。
/// 口径与 `select_files()` 全量档一致（同一份 `platform_matches`），读不到清单 ⇒ 0。
pub fn platform_total_bytes(manifest_path: &Path) -> u64 {
    let Ok(text) = std::fs::read_to_string(manifest_path) else { return 0 };
    let Ok(m) = serde_json::from_str::<Value>(&text) else { return 0 };
    let key = super::model_store::platform_key();
    m.get("files")
        .and_then(|f| f.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|f| super::model_store::platform_matches(str_at(f, "platform").as_deref(), &key))
                .filter_map(|f| f.get("sizeBytes").and_then(|v| v.as_u64()))
                .sum()
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_manifest_is_all_false() {
        let s = model_status(Path::new("/no/such/manifest.json"), Path::new("/no/such/root"), None);
        assert_eq!(s, ModelStatus::unknown());
        assert!(s.files.is_empty(), "清单读不到 ⇒ 逐条清单也是空的，不能凭空造条目");
    }

    /// 造一份「四条 + 两个 set」的夹具清单（含 `linkTo` / `platform` / `sizeBytes` 三种形态）。
    fn fixture_manifest() -> Value {
        serde_json::json!({
            "files": [
                { "id": "a", "set": "visual", "dest": "models-store/a.bin", "sizeBytes": 3 },
                { "id": "b", "set": "visual", "dest": "models-store/b.bin", "linkTo": "models/b.bin", "sizeBytes": 4 },
                { "id": "c", "set": "runtime", "dest": "bin/c.exe", "platform": "win32-x64", "sizeBytes": 5,
                  "url": "https://example.invalid/c", "linkTo": "bin/c.exe" },
                { "id": "d", "set": "runtime", "dest": "bin/d", "platform": "darwin-arm64", "sizeBytes": 6 }
            ],
            "sets": { "visual": { "files": ["a", "b"] }, "runtime": { "files": ["c", "d"] } }
        })
    }

    fn write_fixture(dir: &Path, manifest: &Value) -> PathBuf {
        let p = dir.join("models.manifest.json");
        std::fs::write(&p, serde_json::to_string(manifest).unwrap()).unwrap();
        p
    }

    /// D8 验收①：每条都带**目标绝对路径**，且路径口径按"谁真会去开它"选。
    #[test]
    fn files_are_rendered_with_absolute_paths_and_readiness() {
        let tmp = std::env::temp_dir().join(format!("miao-modelstatus-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("models-store")).unwrap();
        std::fs::create_dir_all(tmp.join("src").join("models")).unwrap();
        // a：按 dest 就地读（相对模型根）—— 大小与清单一致 ⇒ 就绪
        std::fs::write(tmp.join("models-store").join("a.bin"), b"abc").unwrap();
        // b：有 linkTo ⇒ 引擎实际打开的是 <root>/src/models/b.bin（写去别处应判"没就绪"）
        std::fs::write(tmp.join("src").join("models").join("b.bin"), b"abcd").unwrap();

        let mp = write_fixture(&tmp, &fixture_manifest());
        let s = model_status(&mp, &tmp, None);

        assert_eq!(s.files.len(), 4, "逐条清单必须与清单条目一一对应");
        let by = |id: &str| s.files.iter().find(|f| f.id == id).unwrap().clone();

        for f in &s.files {
            assert!(Path::new(&f.path).is_absolute(), "{} 的目标路径不是绝对路径：{}", f.id, f.path);
        }
        assert_eq!(Path::new(&by("a").path), tmp.join("models-store").join("a.bin"), "无 linkTo ⇒ <root>/<dest>");
        assert_eq!(
            Path::new(&by("b").path),
            tmp.join("src").join("models").join("b.bin"),
            "相对 linkTo ⇒ <root>/src/<linkTo>（只看 dest 会漏掉「没链进引擎树」）"
        );

        assert!(by("a").ready && by("b").ready, "在位且大小一致必须判就绪");
        assert!(!by("c").ready, "文件不在 ⇒ 未就绪");
        assert_eq!(by("a").set.as_deref(), Some("visual"));
        assert_eq!(by("c").url.as_deref(), Some("https://example.invalid/c"), "URL 也要吐出来（从哪来）");
        assert!(by("d").link_to.is_none(), "没有 linkTo 的条目不该凭空长出一个");

        // 聚合布尔必须与逐条一致（同一份判据，不是两套）
        assert!(s.visual_ready, "a/b 都就绪 ⇒ visualReady");
        assert!(!s.sakura_ready, "清单里没有 llm set ⇒ 空集合不算就绪");

        // 大小不符 ⇒ 该条未就绪（不是"存在就算好"）
        std::fs::write(tmp.join("models-store").join("a.bin"), b"abcdef").unwrap();
        let s2 = model_status(&mp, &tmp, None);
        assert!(!s2.files.iter().find(|f| f.id == "a").unwrap().ready, "大小与清单不符必须判未就绪");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 平台判据必须与**下载器**同源（否则界面说 4 条待下、下载器只下 3 条）。
    #[test]
    fn platform_filter_matches_the_downloader() {
        let tmp = std::env::temp_dir().join(format!("miao-modelstatus-plat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let mp = write_fixture(&tmp, &fixture_manifest());
        let s = model_status(&mp, &tmp, None);
        let by = |id: &str| s.files.iter().find(|f| f.id == id).unwrap().clone();

        assert!(by("a").applicable, "无 platform ⇒ 平台无关，恒适用");
        let key = super::super::model_store::platform_key();
        assert_eq!(by("c").applicable, key == "win32-x64", "c 只在 win32-x64 适用");
        assert_eq!(by("d").applicable, key == "darwin-arm64", "d 只在 darwin-arm64 适用");
        assert_eq!(by("c").platform.as_deref(), Some("win32-x64"), "platform 字段原样吐出");

        // 字节和：口径 = 当前平台可见条目（与 select_files 全量档同一个判据）
        let sum: u64 = s.files.iter().filter(|f| f.applicable).filter_map(|f| f.size_bytes).sum();
        assert_eq!(platform_total_bytes(&mp), sum, "platform_total_bytes 必须等于逐条里 applicable 的和");
        assert!(platform_total_bytes(&tmp.join("no-such.json")) == 0, "清单读不到 ⇒ 0，不是编一个数");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// D8 的「渲染而非编写」：改清单一条 `dest` ⇒ 渲染出来的路径跟着变。
    /// （e2e 的 M1 变异用的就是这条性质；此处先钉在纯函数层。）
    #[test]
    fn rendered_paths_track_the_manifest_not_the_code() {
        let tmp = std::env::temp_dir().join(format!("miao-modelstatus-drift-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let mp = write_fixture(&tmp, &fixture_manifest());
        let before = model_status(&mp, &tmp, None).files.iter().find(|f| f.id == "a").unwrap().path.clone();

        let mut m = fixture_manifest();
        m["files"][0]["dest"] = serde_json::json!("models-store/moved-a.bin");
        let mp2 = write_fixture(&tmp, &m);
        let after = model_status(&mp2, &tmp, None).files.iter().find(|f| f.id == "a").unwrap().path.clone();

        assert_ne!(before, after, "改了清单 dest，渲染出的路径必须跟着变（否则就是写死的）");
        assert!(after.ends_with("moved-a.bin"), "新路径应来自清单：{after}");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
