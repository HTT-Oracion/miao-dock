//! 媒体服务器适配器（M3）：Jellyfin / Emby。
//!
//! ## 为什么它是第一个「真能播」的在线源
//! RSS 给的多半是 BT 种子（下载归 M5），在线网页源要反爬；而 Jellyfin / Emby 是用户
//! **自己的**服务器：有 API key、有稳定的 JSON、每集都有可直接喂播放器的流地址。
//! 所以它排在适配器队列的第二位（RSS 之后）。
//!
//! ## 令牌纪律
//! `api_key` 只走**请求头**，且**绝不出现在回给前端的地址里** —— 回传的是
//! `/Videos/{id}/stream` 这样的相对路径。原因：带 key 的 URL 会进日志、报错截图、
//! 播放器历史，等于把家里 NAS 的钥匙撒出去。
//! （播放接入时再由服务侧补上头，或走我们自己的签名层。）
//!
//! ## 地址形态
//! 用户通常直接粘 Web UI 地址（`http://nas:8096/web/index.html#!/details?id=…`）。
//! 这里只取 **origin** 当 API 根，`?api_key=` 当密钥；路径 / 哈希全部忽略。

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use super::{item_json, DataSourceItem, ItemKind};

/// 建连超时：NAS 多在内网，10s 连不上基本是地址 / 防火墙问题。
const CONNECT_TIMEOUT_SECS: u64 = 10;
/// 整次请求超时（含读 body）。
const TIMEOUT_SECS: u64 = 12;

/// Jellyfin / Emby 的 `System/Info`（探活 + 自报身份）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct SystemInfo {
    #[serde(default)]
    server_name: String,
    #[serde(default)]
    version: String,
}

/// `Items` 分页响应（只取我们要的字段）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ItemsPage {
    #[serde(default)]
    items: Vec<RawItem>,
}

/// 一条媒体库条目（这里只关心**剧集**）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawItem {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    series_name: Option<String>,
    #[serde(default)]
    parent_index_number: Option<u32>,
    #[serde(default)]
    index_number: Option<u32>,
}

/// 把用户粘的地址拆成 `(API 根, api_key)`。
///
/// 纯函数：拆错了要在**发请求之前**就告诉用户，而不是等一个 404。
///
/// `api_key` 在**查询串和哈希里都认**：Jellyfin 的 Web UI 把参数放在 `#` 后面，
/// 用户照着粘过来的地址常常是 `…#!/…?api_key=…`。
pub fn split_source_url(url: &str) -> Result<(String, Option<String>), String> {
    let u = url::Url::parse(url.trim()).map_err(|_| "源地址不是合法 URL".to_string())?;
    let mut pairs: Vec<(String, String)> = u
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if let Some(frag) = u.fragment() {
        for (k, v) in url::form_urlencoded::parse(frag.as_bytes()) {
            pairs.push((k.into_owned(), v.into_owned()));
        }
    }
    let key = pairs
        .into_iter()
        .find(|(k, _)| k == "api_key")
        .map(|(_, v)| v)
        .filter(|s| !s.is_empty());
    // 只要 origin：路径与哈希对 API 调用没有意义
    Ok((format!("{}://{}", u.scheme(), u.authority()), key))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(super::super::metadata::user_agent())
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败：{e}"))
}

/// 认证头：Jellyfin 与 Emby 同源不同名，两个头都发，兼容性最好。
fn with_auth(req: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder {
    req.header("X-Emby-Token", key).header("X-MediaBrowser-Token", key)
}

/// 媒体库条目 → 契约条目。剧集优先按 `剧名 S季E集` 命名（自动择优要按集号比）。
fn to_item(raw: &RawItem) -> Option<DataSourceItem> {
    if raw.id.is_empty() || raw.name.is_empty() {
        return None;
    }
    let title = match (raw.series_name.as_deref(), raw.parent_index_number, raw.index_number) {
        (Some(series), Some(season), Some(ep)) => format!("{series} S{season:02}E{ep:02}"),
        (Some(series), _, Some(ep)) => format!("{series} E{ep:02}"),
        _ => raw.name.clone(),
    };
    Some(DataSourceItem {
        title,
        index: raw.index_number.map(|v| v as f64),
        link: None,
        // 相对路径：**不带 api_key**（见模块文档的令牌纪律）
        enclosure: Some(format!("/Videos/{}/stream", raw.id)),
        kind: ItemKind::Video,
        published: None,
    })
}

/// 探一个媒体服务器：先 `/System/Info` 确认能连上且认证通过，再取最近的剧集。
pub async fn probe(base: &str, api_key: Option<&str>, kind: &str, limit: usize) -> Result<Value, String> {
    let key = api_key
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .ok_or("媒体服务器源要带 api_key（地址后面加 ?api_key=…）")?;
    let base = base.trim_end_matches('/');

    let info = with_auth(client()?.get(format!("{base}/System/Info")), key)
        .send()
        .await
        .map_err(|e| format!("连不上媒体服务器：{e}"))?;
    match info.status().as_u16() {
        401 | 403 => return Err("认证失败：api_key 不对，或该密钥没有访问权限".into()),
        s if !(200..300).contains(&s) => return Err(format!("服务器返回 {s}")),
        _ => {}
    }
    let server: SystemInfo = info
        .json()
        .await
        .map_err(|e| format!("System/Info 不是预期 JSON：{e}"))?;

    // 只取剧集：电影 / 音乐 / 照片对「按集追番」是噪音
    // limit 先绑成字符串：`.query()` 是泛型，混用 `&str` 与 `&String` 推不出数组类型
    let limit_q = limit.clamp(1, 50).to_string();
    let page = with_auth(
        client()?
            .get(format!("{base}/Items"))
            .query(&[
                ("IncludeItemTypes", "Episode"),
                ("Recursive", "true"),
                ("SortBy", "DateCreated"),
                ("SortOrder", "Descending"),
                ("Fields", "ParentIndexNumber,IndexNumber,SeriesName"),
                ("Limit", limit_q.as_str()),
            ]),
        key,
    )
    .send()
    .await
    .map_err(|e| format!("取媒体库失败：{e}"))?;
    if !page.status().is_success() {
        return Err(format!("取媒体库失败：服务器返回 {}", page.status()));
    }
    let page: ItemsPage = page
        .json()
        .await
        .map_err(|e| format!("Items 不是预期 JSON：{e}"))?;
    let items: Vec<DataSourceItem> = page.items.iter().filter_map(to_item).take(limit).collect();

    Ok(json!({
        "ok": true,
        "kind": kind,
        "server": { "name": server.server_name, "version": server.version },
        "count": items.len(),
        "items": items.iter().map(item_json).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Query, State as AxState};
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::get;
    use axum::{Json, Router};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    /// mock 服务器看到的请求头 / 查询参数（用来证明令牌真的走了请求头）
    #[derive(Clone, Default)]
    struct Seen {
        auth: Arc<Mutex<Vec<String>>>,
        query: Arc<Mutex<Vec<String>>>,
    }

    async fn mock_info(AxState(seen): AxState<Seen>, headers: HeaderMap) -> Json<Value> {
        let token = headers
            .get("x-emby-token")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        seen.auth.lock().unwrap().push(token);
        Json(json!({ "ServerName": "Nas Jellyfin", "Version": "10.9.0" }))
    }

    async fn mock_items(AxState(seen): AxState<Seen>, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
        seen.query.lock().unwrap().push(format!("{q:?}"));
        Json(json!({
            "Items": [
                { "Id": "abc1", "Name": "第 12 话", "SeriesName": "孤独摇滚", "ParentIndexNumber": 1, "IndexNumber": 12 },
                { "Id": "abc2", "Name": "第 03 话", "SeriesName": "冰菓", "ParentIndexNumber": 1, "IndexNumber": 3 },
                { "Id": "", "Name": "坏条目" }
            ],
            "TotalRecordCount": 3
        }))
    }

    async fn mock_unauthorized() -> (StatusCode, &'static str) {
        (StatusCode::UNAUTHORIZED, "nope")
    }

    async fn mock_server(authorized: bool) -> (String, Seen) {
        let seen = Seen::default();
        let app = if authorized {
            Router::new()
                .route("/System/Info", get(mock_info))
                .route("/Items", get(mock_items))
                .with_state(seen.clone())
        } else {
            Router::new()
                .route("/System/Info", get(mock_unauthorized))
                .route("/Items", get(mock_items))
                .with_state(seen.clone())
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), seen)
    }

    #[tokio::test]
    async fn probe_maps_episodes_and_never_leaks_the_key() {
        let (base, seen) = mock_server(true).await;
        let out = probe(&base, Some("secret-key"), "jellyfin", 10).await.unwrap();

        assert_eq!(out["server"]["name"], "Nas Jellyfin");
        assert_eq!(out["server"]["version"], "10.9.0");
        assert_eq!(out["kind"], "jellyfin");
        // 没有 Id 的坏条目被丢掉，不硬凑
        assert_eq!(out["count"], 2);
        assert_eq!(out["items"][0]["title"], "孤独摇滚 S01E12");
        // 集号是 f64：与 JSON 里的整数比会因 int/float 不同而假红，必须显式比小数
        assert_eq!(out["items"][0]["index"], 12.0);
        assert_eq!(out["items"][1]["title"], "冰菓 S01E03");

        // 地址是相对路径，且整个响应里找不到密钥
        assert_eq!(out["items"][0]["enclosure"], "/Videos/abc1/stream");
        assert!(!out.to_string().contains("secret-key"));
        // 令牌确实通过请求头送到了上游（而不是被悄悄丢掉）
        assert_eq!(seen.auth.lock().unwrap().len(), 1);
        assert_eq!(seen.auth.lock().unwrap()[0], "secret-key");
    }

    #[tokio::test]
    async fn split_source_url_takes_origin_and_key() {
        // 用户常直接粘 Web UI 地址：路径与哈希都要忽略，只留 origin + api_key
        let (base, key) =
            split_source_url("http://nas.lan:8096/web/index.html#!/details?id=1&api_key=abc").unwrap();
        assert_eq!(base, "http://nas.lan:8096");
        assert_eq!(key.as_deref(), Some("abc"));

        let (base2, key2) = split_source_url("http://nas.lan:8096").unwrap();
        assert_eq!(base2, "http://nas.lan:8096");
        assert!(key2.is_none());

        // 普通查询串也要认（有人就是手拼 `?api_key=`）
        let (base3, key3) = split_source_url("http://nas.lan:8096/web/?api_key=xyz&foo=1").unwrap();
        assert_eq!(base3, "http://nas.lan:8096");
        assert_eq!(key3.as_deref(), Some("xyz"));

        assert!(split_source_url("not a url").is_err());
    }

    #[tokio::test]
    async fn missing_key_is_rejected_before_any_request() {
        // 没密钥时不该真去连：连上了也只会 401，白等一个超时
        assert!(probe("http://127.0.0.1:1", None, "jellyfin", 5).await.is_err());
        assert!(probe("http://127.0.0.1:1", Some("  "), "emby", 5).await.is_err());
    }

    #[tokio::test]
    async fn unauthorized_maps_to_clear_error() {
        let (base, _seen) = mock_server(false).await;
        let err = probe(&base, Some("wrong"), "jellyfin", 5).await.err().expect("应当失败");
        assert!(err.contains("认证失败"), "错误没说清是认证问题：{err}");
    }

    #[tokio::test]
    async fn limit_is_passed_upstream() {
        let (base, seen) = mock_server(true).await;
        let out = probe(&base, Some("k"), "jellyfin", 1).await.unwrap();
        assert_eq!(out["count"], 1);
        // limit 真的传给了上游：不让服务端把整个媒体库都吐回来
        assert!(seen.query.lock().unwrap()[0].contains("Limit"));
    }

    #[test]
    fn item_without_series_falls_back_to_name() {
        let raw = RawItem {
            id: "x".into(),
            name: "剧场版".into(),
            series_name: None,
            parent_index_number: None,
            index_number: None,
        };
        let item = to_item(&raw).unwrap();
        assert_eq!(item.title, "剧场版");
        assert!(item.index.is_none());
        assert_eq!(item.enclosure.as_deref(), Some("/Videos/x/stream"));
        assert_eq!(item.kind, ItemKind::Video);
    }
}
