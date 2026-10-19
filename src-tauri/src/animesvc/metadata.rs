//! Bangumi 元数据客户端（M1）。
//!
//! ## 边界
//! 只做两件事：**按关键词检索候选**、**按 Bangumi id 拉详情并落进 manifest**。
//! 它不碰收藏态 / 进度 / 剧集列表 —— 那些是用户数据与盘上事实，元数据只能补空字段。
//!
//! ## 为什么在 animesvc 而不是壳层
//! 元数据最终写进 manifest，而 manifest 的读写、目录扫描都在 animesvc。放到壳层会变成
//! 第二条「写清单」的路径（CLI / e2e 用不到、两处格式必然漂移）。壳层只做命令转发。
//!
//! ## 网络与失败
//! 外网可能不可达（本机 `api.bgm.tv` 实测超时）。因此：
//! · 超时 12s、错误带状态码，**不吞**；
//! · 日历（周几）失败**不阻断**主流程 —— 它只影响「新番时间表」，不是元数据本体；
//! · 可用 `MIAO_BANGUMI_API` 指向本地镜像 / 夹具，便于离线验证。

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use super::manifest::{self, Airing, MetadataPatch};

/// 官方 API 根（可被 `MIAO_BANGUMI_API` 覆盖）。
pub const API_BASE: &str = "https://api.bgm.tv";

/// 标签最多留几个：清单是给人看的小文件，不是镜像整份 tag 列表。
const TAG_LIMIT: usize = 12;

pub fn api_base() -> String {
    std::env::var("MIAO_BANGUMI_API")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| API_BASE.to_string())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!("MiaoDock/{} (anime metadata client)", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败：{e}"))
}

// ------------------------------------------------------------------ 上游 JSON

#[derive(Debug, Clone, Deserialize)]
struct RawSubject {
    id: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    name_cn: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    date: String,
    #[serde(default)]
    images: Option<RawImages>,
    #[serde(default)]
    rating: Option<RawRating>,
    #[serde(default)]
    tags: Vec<RawTag>,
    #[serde(default)]
    eps: Option<u32>,
    #[serde(default)]
    total_episodes: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawImages {
    #[serde(default)]
    large: Option<String>,
    #[serde(default)]
    common: Option<String>,
    #[serde(default)]
    medium: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawRating {
    #[serde(default)]
    score: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawTag {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize)]
struct RawSearch {
    #[serde(default)]
    data: Vec<RawSubject>,
}

#[derive(Debug, Deserialize)]
struct RawCalendarDay {
    weekday: RawWeekday,
    #[serde(default)]
    items: Vec<RawCalendarItem>,
}

#[derive(Debug, Deserialize)]
struct RawWeekday {
    id: u32,
}

#[derive(Debug, Deserialize)]
struct RawCalendarItem {
    id: u64,
}

// ------------------------------------------------------------------ 映射

/// `YYYY-MM-DD` → `(年, 季度)`；认不出给 `(None, None)`，不编造。
fn season_of(date: &str) -> (Option<u32>, Option<String>) {
    let d = date.trim();
    if d.len() < 7 {
        return (None, None);
    }
    let (y, rest) = d.split_at(4);
    let year = y.parse::<u32>().ok();
    let month = &rest[1..3];
    let season = if month.chars().all(|c| c.is_ascii_digit()) {
        Some(format!("{y}-{month}"))
    } else {
        None
    };
    (year, season)
}

fn cover_of(raw: &RawSubject) -> Option<String> {
    let img = raw.images.as_ref()?;
    img.large.clone().or_else(|| img.common.clone()).or_else(|| img.medium.clone())
}

fn rating_of(raw: &RawSubject) -> Option<f64> {
    let score = raw.rating.as_ref()?.score?;
    if score.is_finite() && score > 0.0 {
        Some(score)
    } else {
        None
    }
}

fn tags_of(raw: &RawSubject) -> Vec<String> {
    raw.tags
        .iter()
        .map(|t| t.name.trim().to_string())
        .filter(|t| !t.is_empty())
        .take(TAG_LIMIT)
        .collect()
}

/// 一条候选（检索结果 / 应用回执共用同一形状）。
fn candidate(raw: &RawSubject) -> Value {
    let (year, season) = season_of(&raw.date);
    json!({
        "bgmId": raw.id,
        "name": raw.name,
        "nameCn": raw.name_cn,
        "cover": cover_of(raw),
        "year": year,
        "season": season,
        "rating": rating_of(raw),
        "episodesTotal": raw.total_episodes.or(raw.eps),
        "summary": raw.summary,
        "tags": tags_of(raw),
    })
}

/// 上游详情 → manifest 补丁。`weekday` 是 0=周一…6=周日（本仓库口径）。
fn patch_of(raw: &RawSubject, weekday: Option<u32>) -> MetadataPatch {

    let (year, season) = season_of(&raw.date);
    let title = if raw.name_cn.trim().is_empty() {
        raw.name.clone()
    } else {
        raw.name_cn.clone()
    };
    MetadataPatch {
        bgm_id: Some(raw.id),
        title: Some(title),
        title_original: Some(raw.name.clone()),
        cover: cover_of(raw),
        year,
        season,
        summary: Some(raw.summary.clone()),
        tags: Some(tags_of(raw)),
        rating: rating_of(raw),
        episodes_total: raw.total_episodes.or(raw.eps),
        // 只有「出现在本周时间表」才敢说在连载；找不到就保持原状，不猜「已完结」
        airing: weekday.map(|w| Airing { state: "airing".into(), latest: None, weekday: Some(w) }),
    }
}

/// Bangumi 的星期是 1=周一…7=周日；转成本仓库的 0…6。
fn zero_based_weekday(id: u32) -> Option<u32> {
    if (1..=7).contains(&id) {
        Some(id - 1)
    } else {
        None
    }
}

fn calendar_map(days: &[RawCalendarDay]) -> HashMap<u64, u32> {
    let mut out = HashMap::new();
    for d in days {
        if let Some(w) = zero_based_weekday(d.weekday.id) {
            for item in &d.items {
                out.insert(item.id, w);
            }
        }
    }
    out
}

// ------------------------------------------------------------------ HTTP

async fn get_json(url: &str) -> Result<Value, String> {
    let res = client()?
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("请求 Bangumi 失败：{e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("Bangumi 返回 {status}"));
    }
    res.json::<Value>().await.map_err(|e| format!("Bangumi 响应不是 JSON：{e}"))
}

/// 按关键词检索（只搜动画类型）。
pub async fn search(base: &str, q: &str, limit: usize) -> Result<Value, String> {
    let url = format!(
        "{}/v0/search/subjects?limit={}",
        base.trim_end_matches('/'),
        limit.clamp(1, 20)
    );
    let res = client()?
        .post(&url)
        .header("Accept", "application/json")
        .json(&json!({ "keyword": q, "filter": { "type": [2] } }))
        .send()
        .await
        .map_err(|e| format!("请求 Bangumi 失败：{e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("Bangumi 返回 {status}"));
    }
    let raw = res
        .json::<RawSearch>()
        .await
        .map_err(|e| format!("Bangumi 检索结果不是预期 JSON：{e}"))?;
    let candidates: Vec<Value> = raw.data.iter().map(candidate).collect();
    Ok(json!({ "ok": true, "count": candidates.len(), "candidates": candidates }))
}

async fn fetch_subject(base: &str, bgm_id: u64) -> Result<RawSubject, String> {
    let url = format!("{}/v0/subjects/{bgm_id}", base.trim_end_matches('/'));
    let v = get_json(&url).await?;
    serde_json::from_value::<RawSubject>(v).map_err(|e| format!("Bangumi 条目结构不认识：{e}"))
}

/// 本周时间表里该条目的星期；拉不到就给 `None`（由调用方决定不影响主流程）。
async fn calendar_weekday(base: &str, bgm_id: u64) -> Result<Option<u32>, String> {
    let url = format!("{}/calendar", base.trim_end_matches('/'));
    let v = get_json(&url).await?;
    let days = serde_json::from_value::<Vec<RawCalendarDay>>(v)
        .map_err(|e| format!("Bangumi 时间表结构不认识：{e}"))?;
    Ok(calendar_map(&days).get(&bgm_id).copied())
}

/// 拉详情并写进 `root/<dir>/manifest.json`。
pub async fn apply(base: &str, root: &Path, dir: &str, bgm_id: u64) -> Result<Value, String> {
    let raw = fetch_subject(base, bgm_id).await?;
    // 时间表是锦上添花：失败不能把「补封面/评分」一起拖死
    let weekday = calendar_weekday(base, bgm_id).await.ok().flatten();
    manifest::apply_metadata(root, dir, &patch_of(&raw, weekday))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use std::fs;

    fn subject_json() -> Value {
        json!({
            "id": 3628,
            "name": "氷菓",
            "name_cn": "冰菓",
            "summary": "节能少年与好奇少女的校园推理。",
            "date": "2012-04-22",
            "images": {
                "large": "https://lain.bgm.tv/pic/cover/l/aa/hyouka.jpg",
                "common": "https://lain.bgm.tv/pic/cover/c/aa/hyouka.jpg",
                "medium": ""
            },
            "rating": { "score": 8.6 },
            "tags": [
                { "name": "推理", "count": 900 },
                { "name": "校园", "count": 800 },
                { "name": "京都动画", "count": 700 }
            ],
            "eps": 22,
            "total_episodes": 22
        })
    }

    fn raw_of(v: Value) -> RawSubject {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn patch_maps_cn_title_and_fields() {
        let raw = raw_of(subject_json());
        let p = patch_of(&raw, Some(5));
        assert_eq!(p.bgm_id, Some(3628));
        assert_eq!(p.title.as_deref(), Some("冰菓"));
        assert_eq!(p.title_original.as_deref(), Some("氷菓"));
        assert_eq!(p.cover.as_deref(), Some("https://lain.bgm.tv/pic/cover/l/aa/hyouka.jpg"));
        assert_eq!(p.year, Some(2012));
        assert_eq!(p.season.as_deref(), Some("2012-04"));
        assert_eq!(p.rating, Some(8.6));
        assert_eq!(p.episodes_total, Some(22));
        assert_eq!(p.tags.as_ref().unwrap().len(), 3);
        let airing = p.airing.unwrap();
        assert_eq!(airing.state, "airing");
        assert_eq!(airing.weekday, Some(5));
    }

    #[test]
    fn patch_falls_back_to_original_name() {
        let mut v = subject_json();
        v["name_cn"] = json!("");
        let p = patch_of(&raw_of(v), None);
        assert_eq!(p.title.as_deref(), Some("氷菓"));
        // 拉不到时间表就保持原状，不猜「已完结」
        assert!(p.airing.is_none());
    }

    #[test]
    fn season_parsing_is_tolerant() {
        assert_eq!(season_of("2012-04-22"), (Some(2012), Some("2012-04".into())));
        assert_eq!(season_of(""), (None, None));
        assert_eq!(season_of("2012"), (None, None));
        assert_eq!(season_of("abcd-04-22"), (None, Some("abcd-04".into())));
    }

    #[test]
    fn weekday_is_zero_based_and_bounded() {
        assert_eq!(zero_based_weekday(1), Some(0));
        assert_eq!(zero_based_weekday(7), Some(6));
        assert_eq!(zero_based_weekday(0), None);
        assert_eq!(zero_based_weekday(8), None);
    }

    #[test]
    fn tags_are_capped() {
        let mut v = subject_json();
        v["tags"] = json!((0..20).map(|i| json!({ "name": format!("t{i}") })).collect::<Vec<_>>());
        let p = patch_of(&raw_of(v), None);
        assert_eq!(p.tags.unwrap().len(), TAG_LIMIT);
    }

    async fn mock_server() -> String {
        async fn search() -> Json<Value> {
            Json(json!({ "data": [subject_json()] }))
        }
        async fn subject() -> Json<Value> {
            Json(subject_json())
        }
        async fn calendar() -> Json<Value> {
            Json(json!([{ "weekday": { "id": 6 }, "items": [{ "id": 3628 }] }]))
        }
        let app = Router::new()
            .route("/v0/search/subjects", post(search))
            .route("/v0/subjects/:id", get(subject))
            .route("/calendar", get(calendar));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn search_and_apply_against_mock_server() {
        let base = mock_server().await;
        let found = search(&base, "冰菓", 5).await.unwrap();
        assert_eq!(found["count"], 1);
        assert_eq!(found["candidates"][0]["bgmId"], 3628);
        assert_eq!(found["candidates"][0]["nameCn"], "冰菓");

        let root = std::env::temp_dir().join(format!("anime-meta-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("冰菓").join("01")).unwrap();
        // 先制造一份用户数据：收藏态不该被元数据覆盖
        manifest::set_collection(&root, "冰菓", Some("doing")).unwrap();

        let out = apply(&base, &root, "冰菓", 3628).await.unwrap();
        assert_eq!(out["subject"]["bgmId"], 3628);
        assert_eq!(out["subject"]["title"], "冰菓");
        assert_eq!(out["subject"]["rating"], 8.6);
        assert_eq!(out["subject"]["season"], "2012-04");
        assert_eq!(out["subject"]["collection"], "doing");
        // 时间表命中 ⇒ 周六（0=周一）
        assert_eq!(out["subject"]["airing"]["weekday"], 5);

        // 落盘可回读，且身份仍是目录名
        let mut skipped = Vec::new();
        let m = manifest::load(&root.join("冰菓"), &mut skipped);
        assert_eq!(m.subject.id, "冰菓");
        assert_eq!(m.subject.bgm_id, Some(3628));
        assert!(skipped.is_empty());

        let _ = fs::remove_dir_all(&root);
    }
}
