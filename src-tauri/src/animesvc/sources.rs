//! 媒体源契约与落盘（M3 起点）。
//!
//! ## 为什么先立契约再写适配器
//! 在线 Web 源 / RSS / 选择器 / 媒体服务器 / BT 五种来源的**取数方式**完全不同，
//! 但上层（选源屏、自动择优、播放）只关心同一组事实：这是什么源、在哪、开没开、
//! 上次测通没有。所以类型先定死，适配器随后按这个形状接入，不各自发明字段。
//!
//! ## 落点
//! `<animeStateDir>/sources.json`（原子写）。**不放库根内**：库根是用户成果目录，
//! 配置混进去会被 `scan` 当成一部番。

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 源列表文件名（与令牌同目录，但不同文件）。
pub const SOURCES_FILE: &str = "sources.json";

/// 内置本地库的固定 id（不可改、不可删）。
pub const BUILTIN_LOCAL_ID: &str = "builtin-local";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    /// 内置：本机番剧库（服务自己扫的那个根）
    Builtin,
    /// 用户指定的本机目录（导入后成为库的一部分）
    Local,
    Web,
    Rss,
    Selector,
    Jellyfin,
    Emby,
    Bt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSource {
    pub id: String,
    pub name: String,
    pub kind: SourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    /// `untested` / `ok` / `timeout` / `error`；适配器接入后由「测试」按钮回写
    #[serde(default = "default_health")]
    pub health: String,
    #[serde(default)]
    pub updated_at: u64,
}

fn default_health() -> String {
    "untested".into()
}

/// 需要地址的源类型（保存时校验，缺地址等于存了个打不开的源）。
fn needs_url(kind: SourceKind) -> bool {
    matches!(
        kind,
        SourceKind::Web | SourceKind::Rss | SourceKind::Selector | SourceKind::Jellyfin | SourceKind::Emby
    )
}

/// 内置源：恒在、不可删。库根变了它就跟着变（每次列表都现算，不落盘）。
pub fn builtin(root: &Path) -> MediaSource {
    let url = root.to_string_lossy().into_owned();
    let health = if root.is_dir() { "ok" } else { "error" };
    MediaSource {
        id: BUILTIN_LOCAL_ID.to_string(),
        name: "内置源 · 本地番剧库".into(),
        kind: SourceKind::Builtin,
        url: Some(url),
        enabled: true,
        health: health.into(),
        updated_at: 0,
    }
}

fn file_path(state_dir: &Path) -> std::path::PathBuf {
    state_dir.join(SOURCES_FILE)
}

fn load_all(state_dir: &Path) -> Vec<MediaSource> {
    let Ok(raw) = fs::read_to_string(file_path(state_dir)) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<MediaSource>>(&raw).unwrap_or_default()
}

/// 原子写：先 `.tmp` 再 rename（半截文件比没有文件更糟）。
fn write_all(state_dir: &Path, list: &[MediaSource]) -> Result<(), String> {
    fs::create_dir_all(state_dir).map_err(|e| format!("建状态目录失败：{e}"))?;
    let path = file_path(state_dir);
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(list).map_err(|e| format!("序列化失败：{e}"))?;
    fs::write(&tmp, text).map_err(|e| format!("写临时文件失败：{e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("改名失败：{e}"))
}

/// 列表：内置源恒在第一位，其余按用户保存顺序。
pub fn list(state_dir: &Path, root: &Path) -> Result<Value, String> {
    let mut out = vec![builtin(root)];
    out.extend(load_all(state_dir).into_iter().filter(|s| s.id != BUILTIN_LOCAL_ID));
    Ok(json!({ "ok": true, "root": root.to_string_lossy(), "sources": out }))
}

/// 新增 / 更新（按 id 覆盖）。内置源不可改。
pub fn save(state_dir: &Path, body: &Value) -> Result<Value, String> {
    let mut src: MediaSource =
        serde_json::from_value(body.clone()).map_err(|e| format!("源字段不合法：{e}"))?;
    let id = src.id.trim().to_string();
    if id.is_empty() || id == BUILTIN_LOCAL_ID {
        return Err("源 id 不能为空，也不能占用内置源".into());
    }
    if src.name.trim().is_empty() {
        return Err("源名称不能为空".into());
    }
    if needs_url(src.kind) && src.url.as_deref().unwrap_or("").trim().is_empty() {
        return Err("这一类源必须填地址".into());
    }
    if let Some(u) = &src.url {
        if needs_url(src.kind) && !u.starts_with("http") {
            return Err("源地址要 http:// 或 https:// 开头".into());
        }
    }
    src.id = id;
    src.name = src.name.trim().to_string();
    src.updated_at = super::manifest::now_ms();
    // 新源默认 untested；保存不等于测通
    if src.health.is_empty() {
        src.health = default_health();
    }

    let mut list = load_all(state_dir);
    list.retain(|s| s.id != src.id);
    list.push(src.clone());
    write_all(state_dir, &list)?;
    Ok(json!({ "ok": true, "source": src }))
}

/// 删除（内置源拒绝）。
pub fn remove(state_dir: &Path, id: &str) -> Result<Value, String> {
    let id = id.trim();
    if id == BUILTIN_LOCAL_ID {
        return Err("内置源不可删除".into());
    }
    let mut list = load_all(state_dir);
    let before = list.len();
    list.retain(|s| s.id != id);
    if list.len() == before {
        return Err(format!("没有这个源：{id}"));
    }
    write_all(state_dir, &list)?;
    Ok(json!({ "ok": true, "id": id }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("anime-sources-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn builtin_is_always_first_and_not_persisted() {
        let state = tmp_dir("builtin");
        let root = tmp_dir("root");
        let v = list(&state, &root).unwrap();
        let sources = v["sources"].as_array().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0]["id"], BUILTIN_LOCAL_ID);
        assert_eq!(sources[0]["health"], "ok");
        // 内置源只是现算，不写盘
        assert!(!file_path(&state).exists());

        let _ = fs::remove_dir_all(&state);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn save_update_and_remove_roundtrip() {
        let state = tmp_dir("roundtrip");
        let root = tmp_dir("root");
        let body = json!({
            "id": "mikan",
            "name": " Mikan 动漫季 ",
            "kind": "rss",
            "url": "https://mikanani.me/RSS/MyBangumi?type=json",
            "enabled": true,
        });
        let out = save(&state, &body).unwrap();
        assert_eq!(out["source"]["name"], "Mikan 动漫季");
        assert_eq!(out["source"]["health"], "untested");

        // 同 id 再存 = 覆盖
        let body2 = json!({ "id": "mikan", "name": "Mikan", "kind": "rss", "url": "https://mikanani.me/RSS/Other" });
        save(&state, &body2).unwrap();
        let v = list(&state, &root).unwrap();
        let sources = v["sources"].as_array().unwrap();
        assert_eq!(sources.len(), 2); // 内置 + 用户源
        assert_eq!(sources[1]["name"], "Mikan");

        remove(&state, "mikan").unwrap();
        assert_eq!(list(&state, &root).unwrap()["sources"].as_array().unwrap().len(), 1);
        // 删不存在的源要报错，而不是静默 200
        assert!(remove(&state, "mikan").is_err());

        let _ = fs::remove_dir_all(&state);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn save_rejects_bad_shapes() {
        let state = tmp_dir("reject");
        let root = tmp_dir("root");
        // 内置 id
        assert!(save(&state, &json!({ "id": BUILTIN_LOCAL_ID, "name": "x", "kind": "web", "url": "https://a" })).is_err());
        // 缺地址
        assert!(save(&state, &json!({ "id": "a", "name": "x", "kind": "web" })).is_err());
        // 非 http 地址
        assert!(save(&state, &json!({ "id": "a", "name": "x", "kind": "rss", "url": "ftp://a" })).is_err());
        // 空名
        assert!(save(&state, &json!({ "id": "a", "name": "  ", "kind": "local" })).is_err());
        // 坏 JSON 形状
        assert!(save(&state, &json!({ "id": 5, "name": "x", "kind": "local" })).is_err());
        // 内置源删不掉
        assert!(remove(&state, BUILTIN_LOCAL_ID).is_err());

        let _ = fs::remove_dir_all(&state);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn broken_file_falls_back_to_empty() {
        let state = tmp_dir("broken");
        fs::write(file_path(&state), "{ 不是 JSON").unwrap();
        let root = tmp_dir("root");
        // 坏文件不能让列表接口整个 500：退化成「只有内置源」
        let v = list(&state, &root).unwrap();
        assert_eq!(v["sources"].as_array().unwrap().len(), 1);

        let _ = fs::remove_dir_all(&state);
        let _ = fs::remove_dir_all(&root);
    }
}
