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

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::{json, Value};

use super::super::sources::{self, SourceKind};
use super::super::stream::{self, allow_cross_origin};
use super::super::Shell;
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
        id: Some(raw.id.clone()),
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

// ------------------------------------------------------------------ 远程中继

#[derive(Debug, Deserialize)]
pub struct RemoteQuery {
    src: String,
    item: String,
    exp: u64,
    sig: String,
}

/// 远程票据的键：`哪个源的哪一集`。换任一个都验不过（防止拿一张票换着看）。
pub fn ticket_key(source_id: &str, item_id: &str) -> String {
    format!("ms:{source_id}:{item_id}")
}

/// 条目 id 只允许字母数字与 `-` `_`（Jellyfin 的 id 就是这形态）。
///
/// 放行 `/` `.` `%` 就等于给了上游一个路径穿越的口子 —— 这个 id 会拼进上游 URL。
pub fn safe_item_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 上游直路地址。`static=true` = 原片直出；**不要转码**（转码返回的是完整流，
/// Range 语义会变形，播放器一 seek 就对不上）。
pub fn upstream_url(base: &str, item_id: &str) -> String {
    format!("{}/Videos/{item_id}/stream?static=true", base.trim_end_matches('/'))
}

/// `GET /api/v1/anime/mediaserver/stream?src&item&exp&sig`
///
/// 为什么要经过我们中继、而不是把上游地址直接给播放器：
/// ① 上游要带 `api_key`，而**密钥不能进 URL**（会进日志 / 历史 / 报错截图）；
/// ② 只允许访问**已保存且启用**的媒体服务器源 —— 否则这就是一个开放代理。
pub async fn relay(
    State(shell): State<Arc<Shell>>,
    headers: HeaderMap,
    Query(q): Query<RemoteQuery>,
) -> Response {
    if !super::super::authorized(&shell, &headers) {
        return super::super::envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "缺少或错误的 X-Box-Token");
    }
    if !stream::verify(shell.token(), &ticket_key(&q.src, &q.item), q.exp, &q.sig) {
        return super::super::envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "流票据无效或已过期");
    }
    if !safe_item_id(&q.item) {
        return super::super::envelope(StatusCode::BAD_REQUEST, "BAD_REQUEST", "条目 id 不合法");
    }
    let Some(src) = sources::find(Path::new(shell.state_dir()), &q.src) else {
        return super::super::envelope(StatusCode::NOT_FOUND, "NOT_FOUND", "没有这个数据源（或已删除）");
    };
    if !matches!(src.kind, SourceKind::Jellyfin | SourceKind::Emby) {
        return super::super::envelope(StatusCode::NOT_FOUND, "NOT_FOUND", "这个源不是媒体服务器");
    }
    if !src.enabled {
        return super::super::envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "这个源已停用");
    }
    let Some(url) = src.url.as_deref() else {
        return super::super::envelope(StatusCode::BAD_REQUEST, "BAD_REQUEST", "这个源没有地址");
    };
    let (base, key) = match split_source_url(url) {
        Ok(v) => v,
        Err(e) => return super::super::envelope(StatusCode::BAD_REQUEST, "BAD_REQUEST", e),
    };
    let Some(key) = key else {
        return super::super::envelope(StatusCode::BAD_REQUEST, "BAD_REQUEST", "这个源没有 api_key");
    };

    let c = match client() {
        Ok(c) => c,
        Err(e) => return super::super::envelope(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", e),
    };
    let mut req = with_auth(c.get(upstream_url(&base, &q.item)), &key);
    // Range 原样转发：播放器靠它 seek / 拖进度
    if let Some(r) = headers.get(header::RANGE) {
        req = req.header(header::RANGE, r);
    }
    let up = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return super::super::envelope(StatusCode::BAD_GATEWAY, "UPSTREAM", format!("上游没响应：{e}"))
        }
    };
    let status = up.status();
    if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
        return super::super::envelope(StatusCode::BAD_GATEWAY, "UPSTREAM", format!("上游返回 {status}"));
    }

    // 只透传与播放相关的头：上游的 Set-Cookie 之类的一律不带回来。
    // 必须**先取头再建 body**：`bytes_stream()` 会消费掉 Response。
    let mut passthrough: Vec<(HeaderName, HeaderValue)> = Vec::new();
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(v) = up.headers().get(&name) {
            passthrough.push((name, v.clone()));
        }
    }

    let mut resp = Response::new(Body::from_stream(up.bytes_stream()));
    *resp.status_mut() = status;
    for (name, v) in passthrough {
        resp.headers_mut().insert(name, v);
    }
    allow_cross_origin(resp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;
    use axum::{Json, Router};
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// mock 服务器看到的请求头 / 查询参数（用来证明令牌真的走了请求头）
    #[derive(Clone, Default)]
    struct Seen {
        auth: Arc<Mutex<Vec<String>>>,
        query: Arc<Mutex<Vec<String>>>,
    }

    async fn mock_info(State(seen): State<Seen>, headers: HeaderMap) -> Json<Value> {
        let token = headers
            .get("x-emby-token")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        seen.auth.lock().unwrap().push(token);
        Json(json!({ "ServerName": "Nas Jellyfin", "Version": "10.9.0" }))
    }

    async fn mock_items(State(seen): State<Seen>, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
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
    fn ticket_key_binds_source_and_item() {
        // 换源或换集都得换票：不能拿一张票遍历整个库
        assert_eq!(ticket_key("jf1", "ep1"), "ms:jf1:ep1");
        assert_ne!(ticket_key("jf1", "ep1"), ticket_key("jf1", "ep2"));
        assert_ne!(ticket_key("jf1", "ep1"), ticket_key("jf2", "ep1"));
    }

    #[test]
    fn item_id_rejects_path_traversal() {
        // 这个 id 会拼进上游 URL：放行分隔符就等于给了路径穿越的口子
        assert!(safe_item_id("ep1"));
        assert!(safe_item_id("9f2c1b7e-4a11-4c3d-8f5a-2b6c9d0e1f22"));
        assert!(!safe_item_id(""));
        assert!(!safe_item_id("../../etc/passwd"));
        assert!(!safe_item_id("ep 1"));
        assert!(!safe_item_id("ep%2f1"));
        assert!(!safe_item_id(&"x".repeat(65)));
    }

    #[test]
    fn upstream_url_asks_for_the_original_file() {
        assert_eq!(
            upstream_url("http://nas.lan:8096/", "ep1"),
            "http://nas.lan:8096/Videos/ep1/stream?static=true"
        );
        // static=true 必须带上：转码返回完整流，Range 语义会变形
        assert!(upstream_url("http://nas.lan:8096", "ep1").contains("static=true"));
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
