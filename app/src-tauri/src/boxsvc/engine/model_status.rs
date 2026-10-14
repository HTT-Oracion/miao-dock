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
    /// 安装引导（C1）：按**当前平台**的合计体积 + 分档位细分。
    pub guidance: ModelGuidance,
}

/// 一个档位（`sets` 的一项）在当前平台下的**体积与条数**（C1）。
///
/// 存在的理由：总体积只回答"要留多少盘"，回答不了"**我只想要视觉那部分，是多少**" ——
/// 而后者才是用户在 `--set visual`（≈0.7 GB）与全量（≈6.9 GiB）之间做选择时问的。
/// 数字全部由 `sizeBytes` 求和得出，**不许自估**（估出来的数会在清单更新后开始撒谎）。
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelSetGuide {
    pub id: String,
    /// 该档位在**当前平台**下可见的条目数
    pub entries: usize,
    /// 这些条目的 `sizeBytes` 之和（没声明大小的条目按 0 计入条数、不占字节）
    pub bytes: u64,
}

/// 安装引导（C1）—— 「装之前先说清楚要留多少盘、装到哪」。
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelGuidance {
    /// 当前平台标识（与清单 `platform` 字段同一口径）
    pub platform: String,
    /// 当前平台可见的条目数
    pub entries: usize,
    /// 这些条目的 `sizeBytes` 之和（**逐字节可复算**：与 `files` 里 applicable 求和相等）
    pub total_bytes: u64,
    /// 分档位细分。**恒满足**「各项之和 == `total_bytes`、各项条数之和 == `entries`」——
    /// 不属于任何 `set` 的条目归入 `unassigned`，绝不让它们从表里消失（那样用户会少下一块）。
    pub sets: Vec<ModelSetGuide>,
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
    ///
    /// `guidance` 仍给出**当前平台**：平台是我们自己的事实（不依赖清单），
    /// 体积为 0、档位为空 —— 那不是"没有体积"，是"清单读不到，算不出来"，
    /// 界面据 `totalBytes === 0` 显示"清单读不到"，而不是"0 B"。
    pub fn unknown() -> Self {
        ModelStatus {
            visual_ready: false,
            sakura_ready: false,
            last_verified_at: None,
            files: Vec::new(),
            guidance: ModelGuidance {
                platform: super::model_store::platform_key(),
                entries: 0,
                total_bytes: 0,
                sets: Vec::new(),
            },
        }
    }
}

/// 档位的**人读顺序**：先必须装的、再可选的。
///
/// 清单里 `sets` 的键序不可依赖（`serde_json` 的 `Value::Object` 默认按字母序，
/// 于是真实顺序 `visual/llm/runtime/translation` 会变成 `llm/runtime/translation/visual`，
/// 用户第一眼看到的是"可选的 LLM 排在必需项前面"）。所以顺序在这里显式声明，
/// 但**表外的档位一律追加到末尾**而不是丢掉 —— 清单加分组而界面不显示，
/// 用户就会少下一块资产，且没有任何地方会报错。
const SET_ORDER: &[&str] = &["visual", "translation", "llm", "runtime"];
/// 不属于任何 `set` 的条目归到这里（保证「分档之和 == 总量」恒成立）。
const SET_UNASSIGNED: &str = "unassigned";

/// 按档位聚合体积（C1）。输入是**已经渲染好的逐条清单**，于是"分档"与"逐条"用同一份判据。
///
/// `in_set` 是「set 名 → 该 set 的 id 列表」（清单 `sets.<name>.files`），它是**归属的权威**；
/// 条目自身的 `set` 字段只作补充（清单只写了条目 `set` 而没在 `sets` 里登记 id 时兜住）。
fn guidance_from(files: &[ModelFileStatus], platform: &str, in_set: &dyn Fn(&str) -> Vec<String>) -> ModelGuidance {
    use std::collections::BTreeMap;

    let mine: Vec<&ModelFileStatus> = files.iter().filter(|f| f.applicable).collect();
    let total_bytes: u64 = mine.iter().filter_map(|f| f.size_bytes).sum();

    // id → set 名。先按 `SET_ORDER` 的顺序登记（同一 id 只认第一个命中的 set），
    // 再用条目自身 `set` 兜底。都不命中 ⇒ unassigned。
    let mut by_id: BTreeMap<String, String> = BTreeMap::new();
    for name in SET_ORDER {
        for id in in_set(name) {
            by_id.entry(id).or_insert_with(|| (*name).to_string());
        }
    }
    // 表外档位也要登记（`SET_ORDER` 之外的 set 名，按 set 名排序，稳定可复现）
    let mut extra: Vec<String> = Vec::new();
    for f in &mine {
        if let Some(s) = f.set.as_deref() {
            if !SET_ORDER.contains(&s) && !extra.iter().any(|x| x == s) {
                extra.push(s.to_string());
            }
        }
    }
    extra.sort();
    for name in &extra {
        for id in in_set(name) {
            by_id.entry(id).or_insert_with(|| name.clone());
        }
    }

    let bucket_of = |f: &ModelFileStatus| -> String {
        by_id
            .get(&f.id)
            .cloned()
            .or_else(|| f.set.clone())
            .unwrap_or_else(|| SET_UNASSIGNED.to_string())
    };

    let mut order: Vec<String> = SET_ORDER.iter().map(|s| (*s).to_string()).collect();
    order.extend(extra.iter().cloned());

    // 只保留**真的有条目**的档位（空档位显示出来只会让人以为"这里还有东西要装"）。
    let mut sets: Vec<ModelSetGuide> = Vec::new();
    for name in &order {
        let bucket: Vec<&&ModelFileStatus> = mine.iter().filter(|f| &bucket_of(f) == name).collect();
        if bucket.is_empty() {
            continue;
        }
        sets.push(ModelSetGuide {
            id: name.clone(),
            entries: bucket.len(),
            bytes: bucket.iter().filter_map(|f| f.size_bytes).sum(),
        });
    }
    // 表外条目（既不在 `SET_ORDER`、自身也没有 `set`）—— 凑成 unassigned 一档。
    let unassigned: Vec<&&ModelFileStatus> = mine.iter().filter(|f| bucket_of(f) == SET_UNASSIGNED).collect();
    if !unassigned.is_empty() {
        sets.push(ModelSetGuide {
            id: SET_UNASSIGNED.to_string(),
            entries: unassigned.len(),
            bytes: unassigned.iter().filter_map(|f| f.size_bytes).sum(),
        });
    }

    ModelGuidance { platform: platform.to_string(), entries: mine.len(), total_bytes, sets }
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
    let guidance = guidance_from(&files_out, &key, &in_set);
    ModelStatus {
        visual_ready: all_ready("visual"),
        sakura_ready: all_ready("llm"),
        last_verified_at: marker
            .as_ref()
            .and_then(|m| m.get("verifiedAt"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        files: files_out,
        guidance,
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

    /// C1 验收①：**分档位之和恒等于总量**（不重不漏），且总量与 D1 的 `requiredBytes` 同源。
    #[test]
    fn guidance_sums_match_the_total() {
        let tmp = std::env::temp_dir().join(format!("miao-modelstatus-g1-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let mp = write_fixture(&tmp, &fixture_manifest());
        let s = model_status(&mp, &tmp, None);
        let g = &s.guidance;

        assert!(!g.platform.is_empty(), "平台标识不能是空串（界面上要如实说'你是哪个平台'）");
        assert_eq!(g.entries, s.files.iter().filter(|f| f.applicable).count(), "entries = 本平台可见条数");

        let sum: u64 = s.files.iter().filter(|f| f.applicable).filter_map(|f| f.size_bytes).sum();
        assert_eq!(g.total_bytes, sum, "总量必须逐字节等于逐条里 applicable 的 sizeBytes 之和");
        assert_eq!(g.total_bytes, platform_total_bytes(&mp), "与 D1 的 requiredBytes 必须是同一个数（不是各算一份）");

        let set_bytes: u64 = g.sets.iter().map(|x| x.bytes).sum();
        let set_entries: usize = g.sets.iter().map(|x| x.entries).sum();
        assert_eq!(set_bytes, g.total_bytes, "分档求和必须等于总量（有条目掉出表外就红在这里）");
        assert_eq!(set_entries, g.entries, "分档条数之和必须等于总条数");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// C1：档位顺序是**人读顺序**，且表外档位与"不属于任何 set"的条目都**不许消失**。
    #[test]
    fn guidance_keeps_unknown_sets_and_unassigned_entries() {
        let tmp = std::env::temp_dir().join(format!("miao-modelstatus-g2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let mut m = fixture_manifest();
        // 表外档位（`SET_ORDER` 里没有的名字）—— 必须出现在表里，且排在已知档位之后
        m["files"].as_array_mut().unwrap().push(serde_json::json!({
            "id": "e", "set": "audio", "dest": "models-store/e.bin", "sizeBytes": 7
        }));
        m["sets"]["audio"] = serde_json::json!({ "files": ["e"] });
        // 不属于任何 set 的条目 —— 必须归入 `unassigned`
        m["files"].as_array_mut().unwrap().push(serde_json::json!({
            "id": "f", "dest": "models-store/f.bin", "sizeBytes": 8
        }));

        let mp = write_fixture(&tmp, &m);
        let s = model_status(&mp, &tmp, None);
        let ids: Vec<&str> = s.guidance.sets.iter().map(|x| x.id.as_str()).collect();

        assert!(ids.contains(&"visual") && ids.contains(&"runtime"), "已知档位要在：{ids:?}");
        assert!(ids.contains(&"audio"), "清单里登记过的表外档位必须出现：{ids:?}");
        assert!(ids.contains(&"unassigned"), "不属于任何 set 的条目必须归入 unassigned：{ids:?}");

        let vi = ids.iter().position(|x| *x == "visual").unwrap();
        let ai = ids.iter().position(|x| *x == "audio").unwrap();
        assert!(vi < ai, "必需档位排在前、未知档位追加在后：{ids:?}");

        let set_bytes: u64 = s.guidance.sets.iter().map(|x| x.bytes).sum();
        assert_eq!(set_bytes, s.guidance.total_bytes, "加了两种'边角'条目后仍要分毫不差");
        // 空档位不显示：清单里没有 llm 条目 ⇒ 表里不该出现一个 0 项 0 字节的 llm
        assert!(!ids.contains(&"llm"), "空档位显示出来只会让人以为这里还有东西要装：{ids:?}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// C1：只算**当前平台**可见的条目（另一平台那条的体积不许混进来）。
    #[test]
    fn guidance_filters_by_platform() {
        let tmp = std::env::temp_dir().join(format!("miao-modelstatus-g3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let mp = write_fixture(&tmp, &fixture_manifest());
        let s = model_status(&mp, &tmp, None);

        let all_bytes: u64 = s.files.iter().filter_map(|f| f.size_bytes).sum();
        let other: u64 = s.files.iter().filter(|f| !f.applicable).filter_map(|f| f.size_bytes).sum();
        assert_eq!(s.guidance.total_bytes + other, all_bytes, "全量 = 本平台 + 其他平台（不多不少）");
        if other > 0 {
            assert!(s.guidance.total_bytes < all_bytes, "有另一平台的条目时，总量必须严格小于全量");
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// C1：清单读不到时 `guidance` 要**空而不假**（平台仍答得出，体积为 0 而不是编一个）。
    #[test]
    fn guidance_is_empty_when_manifest_is_missing() {
        let s = model_status(Path::new("/no/such/manifest.json"), Path::new("/no/such/root"), None);
        assert!(s.guidance.sets.is_empty());
        assert_eq!(s.guidance.total_bytes, 0);
        assert_eq!(s.guidance.entries, 0);
        assert_eq!(s.guidance.platform, super::super::model_store::platform_key(), "平台是我们自己的事实，不依赖清单");
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
