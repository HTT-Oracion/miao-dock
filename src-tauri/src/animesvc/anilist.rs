//! AniList 元数据提供方 —— Bangumi 不可达时的**真实数据来源**。
//!
//! ## 为什么要有这一层
//! `api.bgm.tv` 在部分网络下**完全不可达**（本机实测：HEAD/GET 一律超时，`bgm.tv` 同样），
//! 而探索页与「候选元数据」全靠它 ⇒ 用户看到的是空列表，只能去点「载入示例数据」。
//! 实测 `https://graphql.anilist.co` 的 **POST** 可达（返回真实条目），所以把它做成第二个提供方。
//!
//! ## 形状
//! 候选与 Bangumi 那条**同一形状**（`candidate()` 的键一致），额外两个键说明来源：
//! `provider: "anilist"` 与 `externalId`（AniList 的数字 id，字符串形态）。
//! `bgmId` 为 `null` —— 它不是 Bangumi 的 id，不能冒充。
//!
//! ## 可测性
//! 端点走 `MIAO_ANILIST_URL`（默认官方地址），单测拿**固定 JSON** 打纯函数，不联网。

use serde_json::{json, Value};

use crate::animesvc::manifest::{self, MetadataPatch};
use std::path::Path;

/// GraphQL 端点（测试可用 `MIAO_ANILIST_URL` 指向本地夹具）。
pub fn endpoint() -> String {
    std::env::var("MIAO_ANILIST_URL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "https://graphql.anilist.co".to_string())
}

const MEDIA_FIELDS: &str = r#"
  id
  title { romaji native english }
  episodes
  averageScore
  seasonYear
  season
  description
  genres
  coverImage { large }
"#;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("MiaoDock/2.3 (anime metadata; anilist)")
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| format!("HTTP 客户端建不起来：{e}"))
}

async fn post(query: &str, variables: Value) -> Result<Value, String> {
    let body = json!({ "query": query, "variables": variables });
    let resp = client()?
        .post(endpoint())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("AniList 连不上：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("AniList 返回 {}", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| format!("AniList 响应不是 JSON：{e}"))?;
    if let Some(errors) = v.get("errors") {
        return Err(format!("AniList 报错：{errors}"));
    }
    Ok(v)
}

/// 一条 AniList 媒体节点 → 与 Bangumi 候选**同形**的候选。
pub fn candidate_of(media: &Value) -> Value {
    let title = media.get("title").cloned().unwrap_or(Value::Null);
    let native = title.get("native").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let romaji = title.get("romaji").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    // `name` 与 Bangumi 口径对齐：那里 `name` 是**原名**（日文），`nameCn` 是中文名。
    // AniList 没有中文名 ⇒ `nameCn` 留空，由 `patch_of` 回落用 `name`。
    let name = if native.is_empty() { romaji.clone() } else { native };
    let id = media.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
    let year = media.get("seasonYear").and_then(|v| v.as_i64()).map(|v| v as u32);
    let season = media
        .get("season")
        .and_then(|v| v.as_str())
        .and_then(|s| match s {
            "WINTER" => Some("冬"),
            "SPRING" => Some("春"),
            "SUMMER" => Some("夏"),
            "FALL" => Some("秋"),
            _ => None,
        })
        .map(|s| s.to_string());
    // AniList 的 averageScore 是 0–100；Bangumi 口径是 0–10
    let rating = media
        .get("averageScore")
        .and_then(|v| v.as_f64())
        .map(|v| (v / 10.0 * 10.0).round() / 10.0);
    let cover = media
        .get("coverImage")
        .and_then(|c| c.get("large"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let tags: Vec<String> = media
        .get("genres")
        .and_then(|g| g.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    json!({
        "provider": "anilist",
        "externalId": id.to_string(),
        "bgmId": Value::Null,
        "name": name,
        "nameCn": "",
        "cover": cover,
        "year": year,
        "season": season,
        "rating": rating,
        "rank": Value::Null,
        "collectionTotal": Value::Null,
        "episodesTotal": media.get("episodes").and_then(|v| v.as_u64()),
        "summary": media.get("description").and_then(|v| v.as_str()).unwrap_or(""),
        "tags": tags,
    })
}

/// 检索响应 → `{ count, candidates }`（纯函数：单测直接喂固定 JSON）。
pub fn parse_search(v: &Value) -> Value {
    let list = v
        .get("data")
        .and_then(|d| d.get("Page"))
        .and_then(|p| p.get("media"))
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default();
    let candidates: Vec<Value> = list.iter().map(candidate_of).collect();
    json!({ "count": candidates.len(), "candidates": candidates, "provider": "anilist" })
}

/// 按关键词检索。
pub async fn search(q: &str, limit: usize) -> Result<Value, String> {
    let query = format!(
        "query($q:String,$n:Int){{ Page(perPage:$n){{ media(search:$q,type:ANIME,sort:SEARCH_MATCH){{ {MEDIA_FIELDS} }} }} }}"
    );
    let v = post(&query, json!({ "q": q, "n": limit.max(1).min(20) })).await?;
    let out = parse_search(&v);
    if out["count"].as_u64() == Some(0) {
        return Err("AniList 没有匹配的条目".into());
    }
    Ok(out)
}

/// 详情 → manifest 补丁（与 Bangumi 那条同一套字段）。
fn patch_of(media: &Value) -> MetadataPatch {
    let c = candidate_of(media);
    let summary = c["summary"].as_str().unwrap_or("").to_string();
    MetadataPatch {
        bgm_id: None, // 不是 Bangumi 的 id，不写进 manifest 的 bgmId 字段
        title: c["nameCn"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| c["name"].as_str())
            .map(|s| s.to_string()),
        title_original: c["name"].as_str().map(|s| s.to_string()),
        cover: c["cover"].as_str().map(|s| s.to_string()),
        year: c["year"].as_u64().map(|v| v as u32),
        season: c["season"].as_str().map(|s| s.to_string()),
        summary: Some(summary),
        tags: Some(
            c["tags"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default(),
        ),
        rating: c["rating"].as_f64(),
        rank: None,
        collection_total: None,
        episodes_total: c["episodesTotal"].as_u64().map(|v| v as u32),
        airing: None,
    }
}

/// 拉详情并写进 `root/<dir>/manifest.json`。
pub async fn apply(root: &Path, dir: &str, id: u64) -> Result<Value, String> {
    let query = format!("query($id:Int){{ Media(id:$id,type:ANIME){{ {MEDIA_FIELDS} }} }}");
    let v = post(&query, json!({ "id": id })).await?;
    let media = v
        .get("data")
        .and_then(|d| d.get("Media"))
        .ok_or("AniList 没有这个条目")?;
    manifest::apply_metadata(root, dir, &patch_of(media))
}

/// 用 AniList 条目建一条新番剧（只有元数据、没有片源）。目录净化与幂等复用 `metadata` 那一份实现。
pub async fn import_subject(root: &Path, id: u64) -> Result<Value, String> {
    let query = format!("query($id:Int){{ Media(id:$id,type:ANIME){{ {MEDIA_FIELDS} }} }}");
    let v = post(&query, json!({ "id": id })).await?;
    let media = v
        .get("data")
        .and_then(|d| d.get("Media"))
        .ok_or("AniList 没有这个条目")?;
    let patch = patch_of(media);
    let c = candidate_of(media);
    let name = c["nameCn"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| c["name"].as_str())
        .unwrap_or("")
        .to_string();
    crate::animesvc::metadata::import_with_patch(root, &name, id, &patch)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        json!({
            "data": { "Page": { "media": [
                {
                    "id": 154587,
                    "title": { "romaji": "Sousou no Frieren", "native": "葬送のフリーレン", "english": "Frieren" },
                    "episodes": 28,
                    "averageScore": 91,
                    "seasonYear": 2023,
                    "season": "FALL",
                    "description": "魔王を倒した後の物語。",
                    "genres": ["Adventure", "Drama"],
                    "coverImage": { "large": "https://s4.anilist.co/x.jpg" }
                }
            ] } }
        })
    }

    #[test]
    fn parse_search_normalizes_to_bangumi_shape() {
        let out = parse_search(&fixture());
        assert_eq!(out["count"], 1);
        let c = &out["candidates"][0];
        assert_eq!(c["provider"], "anilist");
        assert_eq!(c["externalId"], "154587");
        assert!(c["bgmId"].is_null(), "不能冒充 Bangumi 的 id");
        assert_eq!(c["name"], "葬送のフリーレン");
        assert_eq!(c["nameCn"], "");
        assert_eq!(c["episodesTotal"], 28);
        // 0–100 → 0–10
        assert_eq!(c["rating"], 9.1);
        assert_eq!(c["year"], 2023);
        assert_eq!(c["season"], "秋");
        assert_eq!(c["cover"], "https://s4.anilist.co/x.jpg");
        assert_eq!(c["tags"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn patch_uses_native_title_and_keeps_bgm_id_empty() {
        let media = &fixture()["data"]["Page"]["media"][0];
        let p = patch_of(media);
        assert!(p.bgm_id.is_none(), "AniList 条目不该写 bgmId");
        assert_eq!(p.title.as_deref(), Some("葬送のフリーレン"));
        assert_eq!(p.title_original.as_deref(), Some("葬送のフリーレン"));
        assert_eq!(p.episodes_total, Some(28));
        assert_eq!(p.rating, Some(9.1));
        assert_eq!(p.season.as_deref(), Some("秋"));
    }

    #[test]
    fn empty_page_is_reported_as_no_match() {
        let out = parse_search(&json!({ "data": { "Page": { "media": [] } } }));
        assert_eq!(out["count"], 0);
    }
}
