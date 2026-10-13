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

/// `modelStatus()` 的产出（三键，与 Node 同形）。
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub visual_ready: bool,
    pub sakura_ready: bool,
    pub last_verified_at: Option<String>,
}

impl ModelStatus {
    /// 清单读不到时的保守结论 —— **不再抛错**（否则一个缺清单的机器连诊断视图都打不开）。
    pub fn unknown() -> Self {
        ModelStatus { visual_ready: false, sakura_ready: false, last_verified_at: None }
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

    // 该文件是否"在位且大小与清单一致"。
    let is_ready = |f: &Value| -> bool {
        let link_to = f.get("linkTo").and_then(|v| v.as_str()).unwrap_or("");
        let dest = f.get("dest").and_then(|v| v.as_str()).unwrap_or("");
        let abs: PathBuf = if !link_to.is_empty() && Path::new(link_to).is_absolute() {
            PathBuf::from(link_to)
        } else if !link_to.is_empty() {
            base.join(link_to)
        } else {
            root_dir.join(dest)
        };
        let Some(got) = size_at(&abs) else { return false };
        // 清单没写 sizeBytes 时退化为"存在即就绪"（不假装校验过大小）。
        match f.get("sizeBytes").and_then(|v| v.as_u64()) {
            Some(want) => got == want,
            None => true,
        }
    };

    let all_ready = |set_name: &str| -> bool {
        let ids = in_set(set_name);
        let picked: Vec<&Value> = files
            .iter()
            .filter(|f| f.get("id").and_then(|v| v.as_str()).map(|id| ids.iter().any(|x| x == id)).unwrap_or(false))
            .copied()
            .collect();
        // 空集合 ⇒ **不是**"就绪"：清单里一个文件都没声明时，说什么都不该是"能翻译"。
        !picked.is_empty() && picked.iter().all(|f| is_ready(f))
    };

    let marker = read_ready_marker(root_dir);
    ModelStatus {
        visual_ready: all_ready("visual"),
        sakura_ready: all_ready("llm"),
        last_verified_at: marker
            .as_ref()
            .and_then(|m| m.get("verifiedAt"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_manifest_is_all_false() {
        let s = model_status(Path::new("/no/such/manifest.json"), Path::new("/no/such/root"), None);
        assert_eq!(s, ModelStatus::unknown());
    }
}
