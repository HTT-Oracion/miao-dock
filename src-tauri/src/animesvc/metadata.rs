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
//! ## 网络策略（D-246）
//! 海外服务，国内直连常见不通（本机实测 10s 连接超时，社区反代 1.2s 返回 200）。因此：
//! · **镜像列表**：`MIAO_BANGUMI_API` 可给逗号 / 空格分隔的多个根，依次尝试，全失败才报错，
//!   错误里带上试过哪几个（自建镜像排障要用）。不填则官方直连。
//! · **图片镜像**：上游把封面域名写死在 JSON 里，只换 API 根封面照旧取不到，
//!   所以 `MIAO_BANGUMI_IMG` 会在落盘前改写 `lain.bgm.tv`。
//! · **超时分层 + 只重试网络异常**：连接超时与整次请求分开；HTTP 4xx/5xx 不重试
//!   （重试会掩盖「关键词不合法」这类真实错误），只有连接 / 超时 / 请求未发出才重试一次。
//! · **UA**：官方要求非浏览器客户端自报身份（开发者 id / 应用名 / 版本 / 主页），
//!   默认库 UA（`reqwest/…`）会被挡。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use super::manifest::{self, Airing, MetadataPatch};

/// 官方 API 根（`MIAO_BANGUMI_API` 为空时的兜底）。
pub const API_BASE: &str = "https://api.bgm.tv";

/// User Agent 的四段：**开发者 id / 应用名 / 平台 / 主页**。
///
/// 官方格式：`{开发者id}/{应用名}/{版本} (平台) (主页)`；分发形态必须带版本号，
/// 开源项目必须带主页。缺开发者 id（`Bangumi/1.0`）、泛化词（`database`）、
/// 各请求库默认 UA 都在被禁之列。
const UA: (&str, &str, &str, &str) = (
    "HTT-Oracion",
    "miao-dock",
    "Windows",
    "https://github.com/HTT-Oracion/miao-dock",
);

/// 建连超时：DNS + TCP。海外源站 10s 连不上，换根也是白等。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 整次请求超时（含读 body）。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// 网络异常重试的间隔；只重一次。
const RETRY_DELAY: Duration = Duration::from_secs(1);

/// 标签最多留几个：清单是给人看的小文件，不是镜像整份 tag 列表。
const TAG_LIMIT: usize = 12;

/// 官方封面的图片域名（被 `MIAO_BANGUMI_IMG` 替换）。
const IMG_HOST: &str = "lain.bgm.tv";

pub(crate) fn user_agent() -> String {
    let (dev, app, os, home) = UA;
    format!("{dev}/{app}/{} ({os}) ({home})", env!("CARGO_PKG_VERSION"))
}

// ------------------------------------------------------------------ 根与图片域名

/// 解析 API 根列表：逗号 / 空白分隔，去重保序，滤掉非 http 的条目；空则官方直连。
fn parse_bases(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in raw.split([',', ' ', '\n', '\t']) {
        let s = part.trim().trim_end_matches('/');
        if s.is_empty() || !s.starts_with("http") {
            continue;
        }
        if !out.iter().any(|x| x == s) {
            out.push(s.to_string());
        }
    }
    if out.is_empty() {
        out.push(API_BASE.to_string());
    }
    out
}

/// 生效的 API 根列表（`MIAO_BANGUMI_API`）。
pub fn api_bases() -> Vec<String> {
    parse_bases(&std::env::var("MIAO_BANGUMI_API").unwrap_or_default())
}

/// 生效的图片根（`MIAO_BANGUMI_IMG`）；未设置则不改写。
fn image_base() -> Option<String> {
    std::env::var("MIAO_BANGUMI_IMG")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().trim_end_matches('/').to_string())
}

/// 把上游封面域名改写成镜像根（带路径前缀时保留前缀）。
fn rewrite_cover(url: &str, img_base: Option<&str>) -> String {
    let Some(base) = img_base else { return url.to_string() };
    let Ok(src) = url::Url::parse(url) else { return url.to_string() };
    if src.host_str() != Some(IMG_HOST) {
        return url.to_string();
    }
    let Ok(mut out) = url::Url::parse(base) else { return url.to_string() };
    let prefix = out.path().trim_end_matches('/').to_string();
    out.set_path(&format!("{prefix}{}", src.path()));
    out.to_string()
}

// ------------------------------------------------------------------ HTTP 客户端

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(user_agent())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败：{e}"))
}

/// 只有「请求没成功发到对端」的异常才值得重试一次；
/// HTTP 状态码错误（4xx/5xx）不重试 —— 重试只会把真实错误拖慢一倍。
fn is_retryable(e: &reqwest::Error) -> bool {
    e.is_timeout() || e.is_connect() || e.is_request()
}

async fn send_with_retry<F, Fut>(make: F) -> Result<reqwest::Response, reqwest::Error>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<reqwest::Response, reqwest::Error>>,
{
    let mut tried = 0usize;
    loop {
        let res = make().await;
        let again = res.as_ref().err().map_or(false, is_retryable);
        if tried == 0 && again {
            tried += 1;
            tokio::time::sleep(RETRY_DELAY).await;
            continue;
        }
        return res;
    }
}

/// 依次尝试每个根，第一个成功的返回；全失败时错误里列出试过哪些（排障要用）。
///
/// 回调拿**拥有所有权的字符串**（不是 `&str`）：里面的调用是 `async fn`，
/// 返回的 future 会借用 base，借用的东西不能比 `for<'a>` 更长。
async fn try_bases<T, F, Fut>(bases: &[String], f: F) -> Result<T, String>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut last = String::new();
    for base in bases {
        match f(base.clone()).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                if last.is_empty() {
                    last = format!("{base} → {e}");
                } else {
                    last = format!("{last}; {base} → {e}");
                }
            }
        }
    }
    Err(format!("所有 Bangumi 镜像都不可达：{last}"))
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
    /// 全站排名（v0 `rank`；没进榜就是 `None`）
    #[serde(default)]
    rank: Option<u32>,
    /// 收藏人数（v0 `collection_total`）
    #[serde(default)]
    collection_total: Option<u32>,
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

// ------------------------------------------------------------------ 角色 / 制作 / 关联（R2）

/// `/v0/subjects/{id}/characters` 的一条（`actors` 是完整的 Person 对象）。
#[derive(Debug, Deserialize)]
struct RawCharacter {
    id: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    name_cn: String,
    #[serde(default)]
    relation: String,
    #[serde(default)]
    images: Option<RawImages>,
    #[serde(default)]
    actors: Vec<RawActor>,
}

#[derive(Debug, Deserialize)]
struct RawActor {
    id: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    images: Option<RawImages>,
}

/// `/v0/subjects/{id}/persons` 的一条。
#[derive(Debug, Deserialize)]
struct RawPerson {
    id: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    relation: String,
    #[serde(default)]
    career: Vec<String>,
    #[serde(default)]
    images: Option<RawImages>,
}

/// `/v0/subjects/{id}/subjects` 的一条（关联作品）。
#[derive(Debug, Deserialize)]
struct RawRelation {
    id: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    name_cn: String,
    #[serde(default)]
    relation: String,
    #[serde(default)]
    images: Option<RawImages>,
}

#[derive(Debug, Deserialize)]
struct RawSearch {
    #[serde(default)]
    data: Vec<RawSubject>,
}

#[derive(Debug, Deserialize)]
struct RawCalendarDay {
    weekday: RawWeekday,
    /// 时间表条目是**整条 subject**（带名字 / 封面 / 评分），不是只有 id ——
    /// 探索页的「新番周历」要直接展示，不再逐条回访 `/v0/subjects/{id}`。
    #[serde(default)]
    items: Vec<RawSubject>,
}

#[derive(Debug, Deserialize)]
struct RawWeekday {
    id: u32,
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

/// 集数口径：**正片话数优先**，缺失才退回总话数。
/// 真实数据：《冰菓》`eps=22`（正片）/ `total_episodes=26`（含特别篇）——
/// 用 26 会在详情页显示「已看 x / 26」，与「正片集数」口径不符。
fn episodes_of(raw: &RawSubject) -> Option<u32> {
    raw.eps.filter(|v| *v > 0).or(raw.total_episodes.filter(|v| *v > 0))
}

fn cover_of(raw: &RawSubject) -> Option<String> {
    image_of(&raw.images)
}

/// 上游图片对象 → 可用 URL（大图优先，按 `MIAO_BANGUMI_IMG` 改写域名）。
///
/// 上游常用**空串**表示"没有这张图"，所以要按非空挑：直接把 `Some("")` 当有图，
/// 界面会拿到一个 `src=""`（浏览器会重新请求当前页面）。
fn image_of(images: &Option<RawImages>) -> Option<String> {
    let img = images.as_ref()?;
    let pick = |v: &Option<String>| v.clone().filter(|s| !s.trim().is_empty());
    let url = pick(&img.large).or_else(|| pick(&img.common)).or_else(|| pick(&img.medium))?;
    Some(rewrite_cover(&url, image_base().as_deref()))
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
        "provider": "bangumi",
        "externalId": raw.id.to_string(),
        "bgmId": raw.id,
        "name": raw.name,
        "nameCn": raw.name_cn,
        "cover": cover_of(raw),
        "year": year,
        "season": season,
        "rating": rating_of(raw),
        "rank": raw.rank,
        "collectionTotal": raw.collection_total,
        "episodesTotal": episodes_of(raw),
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
        rank: raw.rank,
        collection_total: raw.collection_total,
        episodes_total: episodes_of(raw),
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

async fn get_json(url: String) -> Result<Value, String> {
    // 客户端在闭包**外面**建：闭包的返回类型必须是 reqwest::Error（重试判据要用它），
    // 而 client() 失败是 String，`?` 转换不过去。
    let c = client()?;
    let res = send_with_retry(move || {
        let (c, url) = (c.clone(), url.clone());
        async move { c.get(&url).header("Accept", "application/json").send().await }
    })
    .await
    .map_err(|e| format!("请求 Bangumi 失败：{e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("Bangumi 返回 {status}"));
    }
    res.json::<Value>().await.map_err(|e| format!("Bangumi 响应不是 JSON：{e}"))
}

/// 按关键词检索（只搜动画类型）。
///
/// `base` 是**拥有所有权的字符串**：返回的 future 由调用方（镜像列表回调）持有，
/// 借用参数会让它逃不出闭包（E0515）。
pub async fn search(base: String, q: &str, limit: usize) -> Result<Value, String> {
    search_filtered(base, q, limit, None, None, None, None).await
}

/// 带筛选的检索（R2-6）：年份 / 季度 / 标签 / 排序。
///
/// 季度与年份一起拼成 `air_date` 的两端（Bangumi 的 `air_date` 支持多个条件，AND 关系）；
/// `sort` 只认 `match|heat|rank|score`，别的一律当 `match`（上游会 400）。
pub async fn search_filtered(
    base: String,
    q: &str,
    limit: usize,
    year: Option<u32>,
    quarter: Option<u32>,
    tag: Option<&str>,
    sort: Option<&str>,
) -> Result<Value, String> {
    let url = format!("{}/v0/search/subjects?limit={}", base.trim_end_matches('/'), limit.clamp(1, 20));
    let body = search_body(q, year, quarter, tag, sort);
    let c = client()?;
    let res = send_with_retry(move || {
        let (c, url, body) = (c.clone(), url.clone(), body.clone());
        async move {
            c.post(&url)
                .header("Accept", "application/json")
                .json(&body)
                .send()
                .await
        }
    })
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

/// `(year, quarter)` → `air_date` 的 `[start, end)` 日期串。
///
/// 只有年份时给整年；带季度时给该季度的三个月。季度不在 1–4 按整年算（不猜）。
fn air_date_range(year: Option<u32>, quarter: Option<u32>) -> Option<(String, String)> {
    let y = year?;
    let q = quarter.filter(|q| (1..=4).contains(q));
    let start_month = q.map(|q| 1 + (q - 1) * 3).unwrap_or(1);
    let start = format!("{y}-{start_month:02}-01");
    let end = match q {
        // 第 4 季度与整年都跨到下一年 1 月 1 日
        Some(4) | None => format!("{}-01-01", y + 1),
        Some(q) => format!("{y}-{:02}-01", 1 + (q - 1) * 3 + 3),
    };
    Some((start, end))
}

/// 检索请求体（拆出来单测：筛选条有没有拼对，不该靠真发请求去猜）。
fn search_body(
    q: &str,
    year: Option<u32>,
    quarter: Option<u32>,
    tag: Option<&str>,
    sort: Option<&str>,
) -> Value {
    let mut filter = json!({ "type": [2] });
    if let Some(t) = tag.map(str::trim).filter(|t| !t.is_empty()) {
        filter["tag"] = json!([t]);
    }
    if let Some((start, end)) = air_date_range(year, quarter) {
        filter["air_date"] = json!([format!(">={start}"), format!("<{end}")]);
    }
    let sort = match sort.map(str::trim) {
        Some("heat") => "heat",
        Some("rank") => "rank",
        Some("score") => "score",
        _ => "match",
    };
    json!({ "keyword": q, "sort": sort, "filter": filter })
}

async fn fetch_subject(base: String, bgm_id: u64) -> Result<RawSubject, String> {
    let url = format!("{}/v0/subjects/{bgm_id}", base.trim_end_matches('/'));
    let v = get_json(url).await?;
    serde_json::from_value::<RawSubject>(v).map_err(|e| format!("Bangumi 条目结构不认识：{e}"))
}

/// 本周时间表里该条目的星期；拉不到就给 `None`（由调用方决定不影响主流程）。
async fn calendar_weekday(base: String, bgm_id: u64) -> Result<Option<u32>, String> {
    let url = format!("{}/calendar", base.trim_end_matches('/'));
    let v = get_json(url).await?;
    let days = serde_json::from_value::<Vec<RawCalendarDay>>(v)
        .map_err(|e| format!("Bangumi 时间表结构不认识：{e}"))?;
    Ok(calendar_map(&days).get(&bgm_id).copied())
}

/// 拉详情并写进 `root/<dir>/manifest.json`。
pub async fn apply(base: String, root: &Path, dir: &str, bgm_id: u64) -> Result<Value, String> {
    let raw = fetch_subject(base.clone(), bgm_id).await?;
    // 时间表是锦上添花：失败不能把「补封面/评分」一起拖死
    let weekday = calendar_weekday(base, bgm_id).await.ok().flatten();
    manifest::apply_metadata(root, dir, &patch_of(&raw, weekday))
}

/// 按生效的镜像列表检索（第一个通的用）。
pub async fn search_default(q: &str, limit: usize) -> Result<Value, String> {
    let bases = api_bases();
    try_bases(&bases, |b| search(b, q, limit)).await
}

/// 按生效的镜像列表做带筛选的检索（年份 / 季度 / 标签 / 排序）。
pub async fn search_filtered_default(
    q: &str,
    limit: usize,
    year: Option<u32>,
    quarter: Option<u32>,
    tag: Option<String>,
    sort: Option<String>,
) -> Result<Value, String> {
    let bases = api_bases();
    let q = q.to_string();
    try_bases(&bases, move |b| {
        let (q, tag, sort) = (q.clone(), tag.clone(), sort.clone());
        async move {
            search_filtered(b, &q, limit, year, quarter, tag.as_deref(), sort.as_deref()).await
        }
    })
    .await
}

/// 按生效的镜像列表应用元数据。
pub async fn apply_default(root: &Path, dir: &str, bgm_id: u64) -> Result<Value, String> {
    let bases = api_bases();
    try_bases(&bases, |b| apply(b, root, dir, bgm_id)).await
}

// ------------------------------------------------------------------ 探索页取数（R2）

/// 本周新番时间表（Bangumi `/calendar`）。
///
/// 返回 `{ days: [{ weekday: 0..6, items: [候选] }] }`，`weekday` 与 `WEEKDAYS`
/// 同口径（0=周一）。条目是**整条 subject**，前端不再逐条回访详情。
pub async fn calendar(base: String) -> Result<Value, String> {
    let url = format!("{}/calendar", base.trim_end_matches('/'));
    let v = get_json(url).await?;
    let days = serde_json::from_value::<Vec<RawCalendarDay>>(v)
        .map_err(|e| format!("Bangumi 时间表结构不认识：{e}"))?;
    let mut out: Vec<Value> = days
        .iter()
        .filter_map(|d| zero_based_weekday(d.weekday.id).map(|w| (w, d)))
        .map(|(w, d)| {
            json!({
                "weekday": w,
                "items": d.items.iter().map(candidate).collect::<Vec<_>>(),
            })
        })
        .collect();
    out.sort_by_key(|d| d["weekday"].as_u64().unwrap_or(9));
    Ok(json!({ "ok": true, "days": out }))
}

/// 热度检索：Bangumi 唯一带 `sort: heat` 的端点（无关键词 + 只要动画）。
async fn hot_by_heat(base: String, limit: usize) -> Result<Vec<Value>, String> {
    let url = format!("{}/v0/search/subjects?limit={}", base.trim_end_matches('/'), limit);
    let body = json!({ "keyword": "", "sort": "heat", "filter": { "type": [2] } });
    let c = client()?;
    let res = send_with_retry(move || {
        let (c, url, body) = (c.clone(), url.clone(), body.clone());
        async move {
            c.post(&url)
                .header("Accept", "application/json")
                .json(&body)
                .send()
                .await
        }
    })
    .await
    .map_err(|e| format!("请求 Bangumi 失败：{e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("Bangumi 返回 {status}"));
    }
    let raw = res
        .json::<RawSearch>()
        .await
        .map_err(|e| format!("热度结果不是预期 JSON：{e}"))?;
    Ok(raw.data.iter().map(candidate).collect())
}

/// 排行兜底：`/v0/subjects?sort=rank`（`heat` 不被支持时用，仍是真数据）。
async fn hot_by_rank(base: String, limit: usize) -> Result<Vec<Value>, String> {
    let url = format!(
        "{}/v0/subjects?type=2&sort=rank&limit={limit}",
        base.trim_end_matches('/')
    );
    let v = get_json(url).await?;
    let raw = serde_json::from_value::<RawSearch>(v).map_err(|e| format!("排行结果不认识：{e}"))?;
    Ok(raw.data.iter().map(candidate).collect())
}

/// 探索页「热度推荐」：先走 `heat`，不支持时退回排行 —— **来源写进回执**，
/// 界面据此换文案（不把"排行"说成"热度"）。
pub async fn hot(base: String, limit: usize) -> Result<Value, String> {
    let limit = limit.clamp(1, 20);
    match hot_by_heat(base.clone(), limit).await {
        Ok(list) => Ok(json!({ "ok": true, "source": "heat", "candidates": list })),
        Err(e) => {
            let list = hot_by_rank(base, limit).await?;
            Ok(json!({
                "ok": true,
                "source": "rank",
                "note": format!("热度检索不可用（{e}），已退回排行"),
                "candidates": list,
            }))
        }
    }
}

/// 按生效的镜像列表取时间表。
pub async fn calendar_default() -> Result<Value, String> {
    let bases = api_bases();
    try_bases(&bases, calendar).await
}

/// 按生效的镜像列表取热度 / 排行。
pub async fn hot_default(limit: usize) -> Result<Value, String> {
    let bases = api_bases();
    try_bases(&bases, |b| hot(b, limit)).await
}

/// 把 Bangumi 条目**建成一条新番剧**（只有元数据、没有片源）。
///
/// 这是搜索/探索页的落点：搜到一部库里没有的番，可以「加入追番」先建条目，
/// 之后往目录里放片或接在线源。目录名取中文名（没有则原名），去掉 Windows 非法字符；
/// 同名目录属于别的条目时追加 ` (bgmId)`；同一部重复导入是**幂等**的。
/// 按补丁建一条新番剧（Bangumi 与 AniList 共用：目录净化 / 幂等 / 落 manifest 只有一份实现）。
pub(crate) fn import_with_patch(
    root: &Path,
    name_hint: &str,
    id_tag: u64,
    patch: &MetadataPatch,
) -> Result<Value, String> {
    let dir = pick_dir_by_name(root, name_hint, id_tag);
    let path = root.join(&dir);
    std::fs::create_dir_all(&path).map_err(|e| format!("建目录失败：{e}"))?;
    let mut out = manifest::apply_metadata(root, &dir, patch)?;
    out["path"] = json!(path.to_string_lossy());
    out["dir"] = json!(dir);
    Ok(out)
}

pub async fn import_subject(base: String, root: &Path, bgm_id: u64) -> Result<Value, String> {
    let raw = fetch_subject(base.clone(), bgm_id).await?;
    let weekday = calendar_weekday(base, bgm_id).await.ok().flatten();
    let patch = patch_of(&raw, weekday);
    let dir = pick_dir(root, &raw, bgm_id);
    let path = root.join(&dir);
    std::fs::create_dir_all(&path).map_err(|e| format!("建目录失败：{e}"))?;
    let mut out = manifest::apply_metadata(root, &dir, &patch)?;
    // `apply_metadata` 的 `dir` 是盘上绝对路径；这里补一个**目录名**（身份）与两者并存，
    // 前端要「刷新库后选中哪一条」用的是目录名。
    out["path"] = json!(path.to_string_lossy());
    out["dir"] = json!(dir);
    Ok(out)
}

/// 选一个不冲突的目录名（幂等：同一部就复用已有目录）。
fn pick_dir(root: &Path, raw: &RawSubject, bgm_id: u64) -> String {
    let name = if raw.name_cn.trim().is_empty() {
        raw.name.clone()
    } else {
        raw.name_cn.clone()
    };
    pick_dir_by_name(root, &name, bgm_id)
}

fn pick_dir_by_name(root: &Path, name: &str, bgm_id: u64) -> String {
    let base = name.to_string();
    let base = sanitize_dir(&base);
    let first = if base.is_empty() { format!("bgm-{bgm_id}") } else { base.clone() };
    if !root.join(&first).exists() {
        return first;
    }
    let mut skipped = Vec::new();
    let m = manifest::load(&root.join(&first), &mut skipped);
    if m.subject.bgm_id == Some(bgm_id) {
        return first;
    }
    let second = format!("{base} ({bgm_id})");
    if root.join(&second).exists() {
        return second; // 已导入过同一部：复用，不再叠后缀
    }
    second
}

/// 目录名净化：Windows 非法字符换 `_`，去掉首尾空白与结尾点，限长 80。
fn sanitize_dir(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    trimmed.chars().take(80).collect()
}

/// 按生效的镜像列表把条目建进番剧库。
pub async fn import_default(root: &Path, bgm_id: u64) -> Result<Value, String> {
    let bases = api_bases();
    let root: PathBuf = root.to_path_buf();
    try_bases(&bases, move |b| {
        let root = root.clone();
        async move { import_subject(b, &root, bgm_id).await }
    })
    .await
}

// ------------------------------------------------------------------ 详情页的补充数据（R2）

/// 角色 + 声优（`/v0/subjects/{id}/characters`）。
pub async fn characters(base: String, bgm_id: u64) -> Result<Value, String> {
    let url = format!("{}/v0/subjects/{bgm_id}/characters", base.trim_end_matches('/'));
    let v = get_json(url).await?;
    let list = serde_json::from_value::<Vec<RawCharacter>>(v)
        .map_err(|e| format!("角色列表结构不认识：{e}"))?;
    let out: Vec<Value> = list
        .iter()
        .map(|c| {
            json!({
                "id": c.id,
                "name": c.name,
                "nameCn": c.name_cn,
                "relation": c.relation,
                "image": image_of(&c.images),
                "actors": c.actors.iter().map(|a| json!({
                    "id": a.id,
                    "name": a.name,
                    "image": image_of(&a.images),
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(json!({ "ok": true, "characters": out }))
}

/// 制作人员（`/v0/subjects/{id}/persons`）。
pub async fn staff(base: String, bgm_id: u64) -> Result<Value, String> {
    let url = format!("{}/v0/subjects/{bgm_id}/persons", base.trim_end_matches('/'));
    let v = get_json(url).await?;
    let list =
        serde_json::from_value::<Vec<RawPerson>>(v).map_err(|e| format!("制作人员结构不认识：{e}"))?;
    let out: Vec<Value> = list
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "name": p.name,
                "relation": p.relation,
                "career": p.career,
                "image": image_of(&p.images),
            })
        })
        .collect();
    Ok(json!({ "ok": true, "staff": out }))
}

/// 关联作品（`/v0/subjects/{id}/subjects`）：同系列 / 续作 / 剧场版等。
pub async fn related(base: String, bgm_id: u64) -> Result<Value, String> {
    let url = format!("{}/v0/subjects/{bgm_id}/subjects", base.trim_end_matches('/'));
    let v = get_json(url).await?;
    let list =
        serde_json::from_value::<Vec<RawRelation>>(v).map_err(|e| format!("关联作品结构不认识：{e}"))?;
    let out: Vec<Value> = list
        .iter()
        .map(|r| {
            json!({
                "bgmId": r.id,
                "name": r.name,
                "nameCn": r.name_cn,
                "relation": r.relation,
                "image": image_of(&r.images),
            })
        })
        .collect();
    Ok(json!({ "ok": true, "related": out }))
}

/// 按生效的镜像列表取角色。
pub async fn characters_default(bgm_id: u64) -> Result<Value, String> {
    let bases = api_bases();
    try_bases(&bases, |b| characters(b, bgm_id)).await
}

/// 按生效的镜像列表取制作人员。
pub async fn staff_default(bgm_id: u64) -> Result<Value, String> {
    let bases = api_bases();
    try_bases(&bases, |b| staff(b, bgm_id)).await
}

/// 按生效的镜像列表取关联作品。
pub async fn related_default(bgm_id: u64) -> Result<Value, String> {
    let bases = api_bases();
    try_bases(&bases, |b| related(b, bgm_id)).await
}

// ------------------------------------------------------------------ 粘贴链接 / 手输编号（R2-5）

/// 从用户粘贴的文本里认 Bangumi 条目 id。
///
/// 认这些形态：纯数字 `27364` · `bgm:27364` · `https://bgm.tv/subject/27364` ·
/// `https://bangumi.tv/subject/27364/` · `https://api.bgm.tv/v0/subjects/27364`。
/// 认不出给 `None`（由调用方决定当关键词还是报错，不猜）。
pub fn parse_bgm_ref(input: &str) -> Option<u64> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }
    if s.chars().all(|c| c.is_ascii_digit()) {
        return s.parse().ok();
    }
    let lower = s.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("bgm:") {
        return rest.trim().parse().ok();
    }
    // 只认 `/subject/<数字>` 与 `/subjects/<数字>` 两种路径，别把别的数字当 id
    for marker in ["/subject/", "/subjects/"] {
        if let Some(at) = lower.find(marker) {
            let digits: String = lower[at + marker.len()..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(v) = digits.parse::<u64>() {
                return Some(v);
            }
        }
    }
    None
}

/// 粘贴链接 / 手输编号 → 建库（与 `import_subject` 同一条落盘路径）。
pub async fn import_ref_default(root: &Path, input: &str) -> Result<Value, String> {
    let bgm_id = parse_bgm_ref(input).ok_or("看不懂这个链接或编号：贴 Bangumi 条目链接，或直接填数字 id")?;
    import_default(root, bgm_id).await
}


// ------------------------------------------------------------------ 提供方回退（AniList）

/// 检索：Bangumi 优先，**不可达或无结果时回落 AniList**。
///
/// 为什么需要：`api.bgm.tv` 在部分网络下完全不可达（实测超时），而候选元数据只有它一条来源 ⇒
/// 用户看到空列表。AniList 的 GraphQL POST 实测可达，形状也对得上（见 `anilist::candidate_of`）。
/// 回落时在响应里带 `fallbackFrom`，让界面能如实说明"这批来自 AniList"。
pub async fn search_any(q: &str, limit: usize) -> Result<Value, String> {
    match search_default(q, limit).await {
        Ok(v) => Ok(v),
        Err(bgm_err) => match crate::animesvc::anilist::search(q, limit).await {
            Ok(mut v) => {
                v["fallbackFrom"] = json!(format!("bangumi: {bgm_err}"));
                Ok(v)
            }
            Err(al_err) => Err(format!("Bangumi：{bgm_err}；AniList：{al_err}")),
        },
    }
}

/// 应用元数据：按 `provider` 分派（默认 bangumi）。
pub async fn apply_any(
    root: &Path,
    dir: &str,
    provider: &str,
    external_id: &str,
) -> Result<Value, String> {
    if provider.eq_ignore_ascii_case("anilist") {
        let id: u64 = external_id
            .trim()
            .parse()
            .map_err(|_| "AniList 的条目号不是数字".to_string())?;
        return crate::animesvc::anilist::apply(root, dir, id).await;
    }
    let id: u64 = external_id
        .trim()
        .parse()
        .map_err(|_| "Bangumi 的条目号不是数字".to_string())?;
    apply_default(root, dir, id).await
}

/// 建库：按 `provider` 分派（默认 bangumi）。
pub async fn import_any(root: &Path, provider: &str, external_id: &str) -> Result<Value, String> {
    if provider.eq_ignore_ascii_case("anilist") {
        let id: u64 = external_id
            .trim()
            .parse()
            .map_err(|_| "AniList 的条目号不是数字".to_string())?;
        return crate::animesvc::anilist::import_subject(root, id).await;
    }
    let id: u64 = external_id
        .trim()
        .parse()
        .map_err(|_| "Bangumi 的条目号不是数字".to_string())?;
    import_default(root, id).await
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use std::fs;

    /// 真实条目（《冰菓》27364）—— 用于夹具，覆盖「eps 与 total 不一致」这一真实差异。
    fn subject_json() -> Value {
        json!({
            "id": 27364,
            "name": "氷菓",
            "name_cn": "冰菓",
            "summary": "节能少年与好奇少女的校园推理。",
            "date": "2012-04-22",
            "images": {
                "large": "https://lain.bgm.tv/pic/cover/l/cd/38/27364_1ZFmr.jpg",
                "common": "https://lain.bgm.tv/pic/cover/c/cd/38/27364_1ZFmr.jpg",
                "medium": ""
            },
            "rating": { "score": 8.1 },
            "rank": 123,
            "collection_total": 4567,
            "tags": [
                { "name": "京阿尼", "count": 900 },
                { "name": "校园", "count": 800 },
                { "name": "氷菓", "count": 700 }
            ],
            "eps": 22,
            "total_episodes": 26
        })
    }

    fn raw_of(v: Value) -> RawSubject {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn user_agent_has_all_four_parts() {
        // 官方格式：{开发者id}/{应用名}/{版本} (平台) (主页)；缺一段就可能被整类挡掉
        let ua = user_agent();
        assert_eq!(
            ua,
            format!(
                "HTT-Oracion/miao-dock/{} (Windows) (https://github.com/HTT-Oracion/miao-dock)",
                env!("CARGO_PKG_VERSION")
            )
        );
        assert!(!ua.starts_with("reqwest"));
        assert!(!ua.starts_with("Bangumi/"));
    }

    #[test]
    fn patch_maps_cn_title_and_fields() {
        let raw = raw_of(subject_json());
        let p = patch_of(&raw, Some(5));
        assert_eq!(p.bgm_id, Some(27364));
        assert_eq!(p.title.as_deref(), Some("冰菓"));
        assert_eq!(p.title_original.as_deref(), Some("氷菓"));
        assert_eq!(p.year, Some(2012));
        assert_eq!(p.season.as_deref(), Some("2012-04"));
        assert_eq!(p.rating, Some(8.1));
        assert_eq!(p.tags.as_ref().unwrap().len(), 3);
        let airing = p.airing.unwrap();
        assert_eq!(airing.state, "airing");
        assert_eq!(airing.weekday, Some(5));
    }

    #[test]
    fn episodes_prefers_main_over_total() {
        let raw = raw_of(subject_json());
        // 冰菓：正片 22 / 总 26 —— 界面上的「总集数」应是正片口径
        assert_eq!(episodes_of(&raw), Some(22));
        let mut v = subject_json();
        v["eps"] = json!(0);
        // eps 缺失 / 为 0 时退回总话数
        assert_eq!(episodes_of(&raw_of(v)), Some(26));
        let mut v2 = subject_json();
        v2["eps"] = json!(null);
        v2["total_episodes"] = json!(null);
        assert_eq!(episodes_of(&raw_of(v2)), None);
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

    #[test]
    fn bases_parse_dedupes_and_falls_back() {
        assert_eq!(parse_bases(""), vec!["https://api.bgm.tv".to_string()]);
        assert_eq!(parse_bases("   "), vec!["https://api.bgm.tv".to_string()]);
        assert_eq!(
            parse_bases(" https://a.example/ , https://b.example https://a.example "),
            vec!["https://a.example".to_string(), "https://b.example".to_string()]
        );
        // 非 http 的条目直接丢掉，免得把一堆 404 试一遍
        assert_eq!(parse_bases("not-a-url"), vec!["https://api.bgm.tv".to_string()]);
    }

    #[test]
    fn cover_rewrite_only_touches_official_host() {
        let official = "https://lain.bgm.tv/pic/cover/l/cd/38/27364_1ZFmr.jpg";
        assert_eq!(rewrite_cover(official, None), official);
        assert_eq!(
            rewrite_cover(official, Some("https://bgmimg.anibt.net")),
            "https://bgmimg.anibt.net/pic/cover/l/cd/38/27364_1ZFmr.jpg"
        );
        // 带路径前缀的镜像根要保留前缀
        assert_eq!(
            rewrite_cover(official, Some("https://example.com/bgmimg/")),
            "https://example.com/bgmimg/pic/cover/l/cd/38/27364_1ZFmr.jpg"
        );
        // 已是别的域名（二次改写）不动
        assert_eq!(rewrite_cover("https://bgmimg.anibt.net/x.jpg", Some("https://example.com")), "https://bgmimg.anibt.net/x.jpg");
        // 坏 URL 原样返回，别把数据改坏
        assert_eq!(rewrite_cover("not a url", Some("https://example.com")), "not a url");
    }

    async fn mock_server() -> String {
        async fn search(Json(body): Json<Value>) -> Json<Value> {
            // 回显请求体：筛选条（tag / air_date / sort）有没有真的发出去，靠它取证
            Json(json!({ "data": [subject_json()], "echo": body }))
        }
        async fn subject() -> Json<Value> {
            Json(subject_json())
        }
        /// 排行兜底用的列表端点（`/v0/subjects?sort=rank`）
        async fn list() -> Json<Value> {
            Json(json!({ "data": [subject_json()], "total": 1 }))
        }
        async fn calendar() -> Json<Value> {
            Json(json!([{ "weekday": { "id": 6 }, "items": [subject_json()] }]))
        }
        /// 角色：带一个声优（Person 对象）
        async fn characters() -> Json<Value> {
            Json(json!([{
                "id": 1,
                "name": "千反田える",
                "name_cn": "千反田爱瑠",
                "relation": "主角",
                "images": { "large": "https://lain.bgm.tv/pic/crt/l/1.jpg", "common": "", "medium": "" },
                "actors": [{ "id": 9, "name": "佐藤聡美", "images": { "large": "", "common": "", "medium": "" } }]
            }]))
        }
        /// 制作人员
        async fn persons() -> Json<Value> {
            Json(json!([{
                "id": 2,
                "name": "京都アニメーション",
                "relation": "动画制作",
                "career": ["动画制作"],
                "images": { "large": "", "common": "", "medium": "" }
            }]))
        }
        /// 关联作品
        async fn relations() -> Json<Value> {
            Json(json!([{
                "id": 40000,
                "name": "氷菓 第2期",
                "name_cn": "冰菓 第二季",
                "relation": "续集",
                "images": { "large": "https://lain.bgm.tv/pic/cover/l/2.jpg", "common": "", "medium": "" }
            }]))
        }
        let app = Router::new()
            .route("/v0/search/subjects", post(search))
            .route("/v0/subjects", get(list))
            .route("/v0/subjects/:id", get(subject))
            .route("/v0/subjects/:id/characters", get(characters))
            .route("/v0/subjects/:id/persons", get(persons))
            .route("/v0/subjects/:id/subjects", get(relations))
            .route("/calendar", get(calendar));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}")
    }

    /// 只坏「检索」这一条路由：用来证明热度检索失败时会退回排行。
    async fn mock_server_broken_search() -> String {
        async fn search() -> (axum::http::StatusCode, &'static str) {
            (axum::http::StatusCode::BAD_REQUEST, "no keyword")
        }
        async fn subject() -> Json<Value> {
            Json(subject_json())
        }
        async fn list() -> Json<Value> {
            Json(json!({ "data": [subject_json()], "total": 1 }))
        }
        async fn calendar() -> Json<Value> {
            Json(json!([]))
        }
        let app = Router::new()
            .route("/v0/search/subjects", post(search))
            .route("/v0/subjects", get(list))
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
        let found = search(base.clone(), "冰菓", 5).await.unwrap();
        assert_eq!(found["count"], 1);
        assert_eq!(found["candidates"][0]["bgmId"], 27364);
        assert_eq!(found["candidates"][0]["nameCn"], "冰菓");
        assert_eq!(found["candidates"][0]["episodesTotal"], 22);

        let root = std::env::temp_dir().join(format!("anime-meta-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("冰菓").join("01")).unwrap();
        // 先制造一份用户数据：收藏态不该被元数据覆盖
        manifest::set_collection(&root, "冰菓", Some("doing")).unwrap();

        let out = apply(base, &root, "冰菓", 27364).await.unwrap();
        assert_eq!(out["subject"]["bgmId"], 27364);
        assert_eq!(out["subject"]["title"], "冰菓");
        assert_eq!(out["subject"]["rating"], 8.1);
        assert_eq!(out["subject"]["rank"], 123);
        assert_eq!(out["subject"]["collectionTotal"], 4567);
        assert_eq!(out["subject"]["season"], "2012-04");
        assert_eq!(out["subject"]["episodesTotal"], 22);
        assert_eq!(out["subject"]["collection"], "doing");
        // 时间表命中 ⇒ 周六（0=周一）
        assert_eq!(out["subject"]["airing"]["weekday"], 5);

        // 落盘可回读，且身份仍是目录名
        let mut skipped = Vec::new();
        let m = manifest::load(&root.join("冰菓"), &mut skipped);
        assert_eq!(m.subject.id, "冰菓");
        assert_eq!(m.subject.bgm_id, Some(27364));
        assert!(skipped.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    /// 第一个根不通时按列表继续试 —— 这就是「本机直连官方超时、换镜像就通」的机制。
    ///
/// 用不存在的域名当替身：DNS 立刻失败，不会像连一个被丢弃的端口那样等满连接超时。
    #[tokio::test]
    async fn falls_back_to_next_base_when_first_is_dead() {
        let good = mock_server().await;
        let dead = "http://bgm-mirror-not-exist.invalid".to_string();
        let bases = vec![dead.clone(), good.clone()];
        let found = try_bases(&bases, |b| search(b, "冰菓", 3)).await.unwrap();
        assert_eq!(found["candidates"][0]["bgmId"], 27364);

        // 两个都不通时，错误里要带上试过谁（自建镜像排障要用）
        let none = try_bases(&[dead.clone()], |b| search(b, "x", 3)).await;
        let err = none.err().expect("应当失败");
        assert!(err.contains("bgm-mirror-not-exist.invalid"), "错误未带上根地址：{err}");
    }

    // ── 探索页取数（R2）──────────────────────────────────────────────────────

    #[tokio::test]
    async fn calendar_maps_days_to_zero_based_weekday_and_full_candidates() {
        let base = mock_server().await;
        let out = calendar(base).await.unwrap();
        assert_eq!(out["ok"], true);
        let days = out["days"].as_array().unwrap();
        assert_eq!(days.len(), 1);
        // Bangumi 的 6 = 周六；本仓库口径 5 = 周六
        assert_eq!(days[0]["weekday"], 5);
        let item = &days[0]["items"][0];
        // 时间表条目是整条 subject：名字 / 封面 / 评分都要在，前端不再逐条回访
        assert_eq!(item["bgmId"], 27364);
        assert_eq!(item["nameCn"], "冰菓");
        assert!(item["cover"].as_str().unwrap().contains("27364"));
        assert_eq!(item["rating"], 8.1);
    }

    #[tokio::test]
    async fn hot_prefers_heat_and_reports_its_source() {
        let base = mock_server().await;
        let out = hot(base, 8).await.unwrap();
        assert_eq!(out["ok"], true);
        assert_eq!(out["source"], "heat");
        assert_eq!(out["candidates"][0]["bgmId"], 27364);
    }

    /// `heat` 不被支持（这里用 400 模拟）时退回排行 —— **来源必须如实写出来**，
    /// 否则界面会把"排行"当"热度"展示。
    #[tokio::test]
    async fn hot_falls_back_to_rank_when_heat_is_rejected() {
        let base = mock_server_broken_search().await;
        let out = hot(base, 8).await.unwrap();
        assert_eq!(out["source"], "rank");
        assert_eq!(out["candidates"][0]["bgmId"], 27364);
        assert!(out["note"].as_str().unwrap().contains("热度"));
    }

    // ── 详情页补充数据（R2）──────────────────────────────────────────────────

    #[tokio::test]
    async fn characters_keep_relation_and_actor_names() {
        let base = mock_server().await;
        let out = characters(base, 27364).await.unwrap();
        let c = &out["characters"][0];
        assert_eq!(c["nameCn"], "千反田爱瑠");
        assert_eq!(c["relation"], "主角");
        // 图片走与封面同一套域名改写
        assert!(c["image"].as_str().unwrap().contains("1.jpg"));
        assert_eq!(c["actors"][0]["name"], "佐藤聡美");
        // 声优没有图 ⇒ null，而不是空串（界面据此显示首字色块）
        assert!(c["actors"][0]["image"].is_null());
    }

    #[tokio::test]
    async fn staff_keep_career_and_relation() {
        let base = mock_server().await;
        let out = staff(base, 27364).await.unwrap();
        let p = &out["staff"][0];
        assert_eq!(p["name"], "京都アニメーション");
        assert_eq!(p["relation"], "动画制作");
        assert_eq!(p["career"][0], "动画制作");
    }

    #[tokio::test]
    async fn related_use_bgm_id_field_for_navigation() {
        let base = mock_server().await;
        let out = related(base, 27364).await.unwrap();
        let r = &out["related"][0];
        assert_eq!(r["bgmId"], 40000);
        assert_eq!(r["relation"], "续集");
        assert_eq!(r["nameCn"], "冰菓 第二季");
        assert!(r["image"].as_str().unwrap().contains("2.jpg"));
    }

    // ── 粘贴链接 / 手输编号（R2-5）──────────────────────────────────────────

    #[test]
    fn parse_bgm_ref_accepts_common_shapes() {
        assert_eq!(parse_bgm_ref("27364"), Some(27364));
        assert_eq!(parse_bgm_ref("  bgm:27364 "), Some(27364));
        assert_eq!(parse_bgm_ref("https://bgm.tv/subject/27364"), Some(27364));
        assert_eq!(parse_bgm_ref("https://bangumi.tv/subject/27364/"), Some(27364));
        assert_eq!(parse_bgm_ref("https://api.bgm.tv/v0/subjects/27364"), Some(27364));
        // 认不出就不猜：关键词、人物页、别的站点都不是条目 id
        assert_eq!(parse_bgm_ref("冰菓"), None);
        assert_eq!(parse_bgm_ref("https://bgm.tv/person/27364"), None);
        assert_eq!(parse_bgm_ref(""), None);
    }

    #[tokio::test]
    async fn import_ref_parses_link_and_creates_entry() {
        let base = mock_server().await;
        let root = std::env::temp_dir().join(format!("anime-meta-ref-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // 走与 import_subject 同一条落盘路径，只是入口从 id 换成链接
        let out = import_subject(base, &root, parse_bgm_ref("https://bgm.tv/subject/27364").unwrap())
            .await
            .unwrap();
        assert_eq!(out["dir"], "冰菓");
        assert_eq!(out["subject"]["bgmId"], 27364);
        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn import_ref_rejects_unreadable_input() {
        let root = std::env::temp_dir();
        let err = import_ref_default(&root, "不是链接").await.unwrap_err();
        assert!(err.starts_with("看不懂"), "{err}");
    }

    // ── 检索筛选条（R2-6）──────────────────────────────────────────────────

    #[test]
    fn air_date_range_covers_year_and_quarters() {
        let y = |a: &str, b: &str| Some((a.to_string(), b.to_string()));
        assert_eq!(air_date_range(Some(2024), None), y("2024-01-01", "2025-01-01"));
        assert_eq!(air_date_range(Some(2024), Some(1)), y("2024-01-01", "2024-04-01"));
        assert_eq!(air_date_range(Some(2024), Some(2)), y("2024-04-01", "2024-07-01"));
        assert_eq!(air_date_range(Some(2024), Some(3)), y("2024-07-01", "2024-10-01"));
        // 第 4 季度要跨到下一年，不能拼出 13 月
        assert_eq!(air_date_range(Some(2024), Some(4)), y("2024-10-01", "2025-01-01"));
        // 非法季度按整年算（不猜）
        assert_eq!(air_date_range(Some(2024), Some(9)), y("2024-01-01", "2025-01-01"));
        assert_eq!(air_date_range(None, Some(2)), None);
    }

    #[test]
    fn search_body_carries_filters_and_normalizes_sort() {
        let body = search_body("冰菓", Some(2024), Some(2), Some(" 校园 "), Some("heat"));
        assert_eq!(body["keyword"], "冰菓");
        assert_eq!(body["sort"], "heat");
        assert_eq!(body["filter"]["type"][0], 2);
        assert_eq!(body["filter"]["tag"][0], "校园");
        assert_eq!(body["filter"]["air_date"][0], ">=2024-04-01");
        assert_eq!(body["filter"]["air_date"][1], "<2024-07-01");

        // 空 tag 不发；未知 sort 退回 match
        let plain = search_body("x", None, None, Some("   "), Some("bogus"));
        assert!(plain["filter"].get("tag").is_none());
        assert!(plain["filter"].get("air_date").is_none());
        assert_eq!(plain["sort"], "match");
    }

    #[tokio::test]
    async fn import_subject_creates_entry_and_is_idempotent() {
        let base = mock_server().await;
        let root = std::env::temp_dir().join(format!("anime-meta-import-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let first = import_subject(base.clone(), &root, 27364).await.unwrap();
        assert_eq!(first["dir"], "冰菓");
        assert_eq!(first["subject"]["bgmId"], 27364);
        assert_eq!(first["subject"]["title"], "冰菓");
        assert_eq!(first["subject"]["airing"]["weekday"], 5);
        // 落盘可回读
        let mut skipped = Vec::new();
        let m = manifest::load(&root.join("冰菓"), &mut skipped);
        assert_eq!(m.subject.bgm_id, Some(27364));

        // 再导一次：同一部必须复用目录（幂等），不叠后缀
        let second = import_subject(base.clone(), &root, 27364).await.unwrap();
        assert_eq!(second["dir"], "冰菓");
        let dirs: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(dirs, vec!["冰菓".to_string()]);

        // 同名目录属于别的条目 ⇒ 带 bgmId 后缀，不覆盖别人的数据
        fs::create_dir_all(root.join("别当欧尼酱了")).unwrap();
        let mut other = subject_json();
        other["id"] = json!(999);
        other["name_cn"] = json!("别当欧尼酱了");
        let out = pick_dir(&root, &serde_json::from_value::<RawSubject>(other).unwrap(), 27364);
        assert_eq!(out, "别当欧尼酱了 (27364)");

        let _ = fs::remove_dir_all(&root);
    }
}
