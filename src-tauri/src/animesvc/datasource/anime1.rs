//! Anime1.me 在线源（M3 的**内置**适配器）。
//!
//! ## 为什么内置而不是让用户配选择器
//! 它的取数链路不是「列表页 → 详情页 → `<video src>`」这种静态结构，而是：
//!
//! 1. 单集页里藏一个 `data-apireq`（`{c, e, t, p, s}`，`t` 是时间戳、`s` 是签名）
//! 2. 拿它 POST `v.anime1.me/api`，响应是 **`Set-Cookie` × 3 + `{s:[{src}]}`**
//! 3. **mp4 直链必须带那 3 个 Cookie 才放行**（不带 ⇒ 403 空响应）
//! 4. 域名每次变（saki / chihaya / towa…），必须每次问 api 拿
//!
//! 这套流程没法用「三条 CSS 选择器」描述，所以做成内置适配器；
//! 站点选择仍由用户在数据源屏显式添加 / 启停（与其它源同一套开关）。
//!
//! ## 诚实边界
//! · 只报**这一集此刻取到的直链**：链接会过期（cookie 8 小时、`t` 也有有效期），
//!   所以本模块**不缓存地址**，每次播放都重新走一遍链。
//! · 不抓上传者 / 字幕组信息（上游页面没有结构化字段），不猜。

use std::time::Duration;

use serde_json::Value;

use super::{DataSourceItem, ItemKind};

const SITE: &str = "https://anime1.me";
const API: &str = "https://v.anime1.me/api";
const TIMEOUT_SECS: u64 = 25;

/// 浏览器 UA：上游对非浏览器 UA 直接 403（实测）。
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(UA)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败：{e}"))
}

/// 一条直链 + 取它时要带的 Cookie（**必须一起用**，否则 403）。
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub url: String,
    pub mime: String,
    /// 形如 `e=…; p=…; h=…`；播放器 / 中继要原样带上
    pub cookie: String,
    /// 上游报的文件总大小（有则给，没有则 0）
    pub size_bytes: u64,
}

/// 从单集页 HTML 里取 `data-apireq`（URL 解码后的 JSON 串）。
pub fn parse_apireq(html: &str) -> Result<String, String> {
    let at = html
        .find("data-apireq=\"")
        .ok_or("这一页没有 data-apireq（可能已下线或页面结构变了）")?;
    let rest = &html[at + "data-apireq=\"".len()..];
    let end = rest
        .find('"')
        .ok_or("data-apireq 属性没有闭合引号")?;
    let raw = &rest[..end];
    // 属性值是 URL 编码的 JSON
    let decoded = urlencoding::decode(raw).map_err(|e| format!("data-apireq 解不开：{e}"))?;
    let v: Value = serde_json::from_str(&decoded).map_err(|e| format!("data-apireq 不是 JSON：{e}"))?;
    if v.get("c").is_none() || v.get("e").is_none() {
        return Err("data-apireq 缺 c / e 字段".into());
    }
    Ok(decoded.into_owned())
}

/// 多条 `Set-Cookie` → 一条 `Cookie` 头。
///
/// 🔴 只按 `;` 切第一段，**不按逗号拆**：`expires=Wed, 21 Oct 2026 …` 里自带逗号，
/// 按逗号拆会把一个 cookie 劈成两半（实测踩过：拼出来 `e=179;  21 Oct 2026 …` 这种）。
/// 调用方给的是 reqwest `get_all(SET_COOKIE)` 的**逐条**值，本就不该再拆。
pub fn join_set_cookies<'a>(values: impl IntoIterator<Item = &'a str>) -> String {
    values
        .into_iter()
        .filter_map(|v| v.split(';').next())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("; ")
}

/// 单集页 URL → 真直链 + Cookie（完整走一遍链）。
pub async fn resolve_episode(episode_url: &str) -> Result<Resolved, String> {
    let url = episode_url.trim();
    if !url.starts_with("http") {
        return Err("单集地址要 http:// 或 https:// 开头".into());
    }
    let apireq = {
        let html = client()?
            .get(url)
            .header("Accept", "text/html,*/*;q=0.8")
            .header("Referer", SITE)
            .send()
            .await
            .map_err(|e| format!("打不开单集页：{e}"))?
            .text()
            .await
            .map_err(|e| format!("读单集页失败：{e}"))?;
        parse_apireq(&html)?
    };
    resolve_with_apireq(&apireq, url).await
}

/// 已知 `apireq` 时拿直链（拆出来便于单测：注入假 apireq + 本地夹具服务）。
pub async fn resolve_with_apireq(apireq: &str, referer: &str) -> Result<Resolved, String> {
    let res = client()?
        .post(API)
        .header("Accept", "application/json, text/plain, */*")
        .header("Referer", referer)
        .header("Origin", "https://anime1.me")
        // 上游要 **form-urlencoded**：用 `body(String)` 时 reqwest 不会自己加
        // Content-Type，得手动补 —— 少了它上游回 403（实测踩过）。
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!("d={}", urlencoding::encode(apireq)))
        .send()
        .await
        .map_err(|e| format!("问上游取片址失败：{e}"))?;
    if !res.status().is_success() {
        return Err(format!("上游取片址返回 {}", res.status()));
    }
    // 3 个 Cookie 决定片址放不放行：原样拼成 Cookie 头
    let cookie = join_set_cookies(
        res.headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok()),
    );
    let body: Value = res
        .json()
        .await
        .map_err(|e| format!("上游响应不是 JSON：{e}"))?;
    let first = body
        .get("s")
        .and_then(|s| s.as_array())
        .and_then(|a| a.first())
        .ok_or("上游没给片址（可能这一集还没上）")?;
    let src = first
        .get("src")
        .and_then(|v| v.as_str())
        .ok_or("上游给的片址不是字符串")?;
    let url = if src.starts_with("//") {
        format!("https:{src}")
    } else {
        src.to_string()
    };
    let mime = first
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("video/mp4")
        .to_string();
    if cookie.is_empty() {
        // 没有 Cookie 的片址播不了：如实说，别给一个 403 的地址让人猜
        return Err("上游没给 Cookie，这个片址取不到字节".into());
    }
    Ok(Resolved { url, mime, cookie, size_bytes: 0 })
}

/// 拿片址的前若干字节，用来**证明它真能播**（探测用，不落盘）。
///
/// 返回字节数；`ftyp` 通过说明是完整的 mp4 起始（不是错误页）。
pub async fn probe_bytes(r: &Resolved, want: usize) -> Result<usize, String> {
    let want = want.clamp(1, 64 * 1024);
    let res = client()?
        .get(&r.url)
        .header("Referer", SITE)
        .header("Cookie", &r.cookie)
        .header("Range", format!("bytes=0-{}", want - 1))
        .send()
        .await
        .map_err(|e| format!("取片址字节失败：{e}"))?;
    let status = res.status();
    if !status.is_success() && status.as_u16() != 206 {
        return Err(format!("片址返回 {status}（Cookie 过期或地址失效）"));
    }
    let size = res
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit('/').next())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("读片址字节失败：{e}"))?;
    if bytes.len() >= 8 && &bytes[4..8] != b"ftyp" {
        return Err("片址返回的内容不是 mp4".into());
    }
    let _ = size;
    Ok(bytes.len())
}

/// 站内搜索 → 单集页条目（数据源屏的「测试」用）。
///
/// 入参 `q` 既可以是**关键词**（`葬送的芙莉蓮`），也可以是**带 `?s=` 的完整地址**
/// （`https://anime1.me/?s=…`）—— 数据源屏的「测试」按钮只会把源的 URL 传进来，
/// 而 anime1 这一类的"URL"本来就是站点根，真正要搜的词由用户另填，所以两种都认。
///
/// 上游只有 WordPress 的 `?s=` 搜索，返回的是**单集**（标题形如 `葬送的芙莉蓮 第二季 [37]`）。
/// 集号从标题末尾的 `[nn]` 解；解不出给 `None`（不猜）。
pub async fn search(q: &str, limit: usize) -> Result<Vec<DataSourceItem>, String> {
    let raw = q.trim();
    // 完整地址 ⇒ 取它的查询串当关键词（`?s=` 里的值）
    let keyword = if raw.starts_with("http") {
        let after = raw.split_once('?').map(|(_, v)| v).unwrap_or("");
        let mut kw = String::new();
        for pair in after.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if k == "s" {
                    kw = urlencoding::decode(v).map(|v| v.into_owned()).unwrap_or_else(|_| v.to_string());
                }
            }
        }
        kw
    } else {
        raw.to_string()
    };
    let keyword = keyword.trim();
    if keyword.is_empty() {
        return Err("检索关键词是空的（地址要带 `?s=关键词`）".into());
    }
    let url = format!("{SITE}/?s={}", urlencoding::encode(keyword));
    let html = client()?
        .get(&url)
        .header("Accept", "text/html,*/*;q=0.8")
        .send()
        .await
        .map_err(|e| format!("搜索上游失败：{e}"))?
        .text()
        .await
        .map_err(|e| format!("读搜索结果失败：{e}"))?;
    Ok(parse_search(&html, limit))
}

/// 纯解析（可单测）：从搜索结果 HTML 里挑单集链接。
pub fn parse_search(html: &str, limit: usize) -> Vec<DataSourceItem> {
    let limit = limit.clamp(1, 50);
    let mut out: Vec<DataSourceItem> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    // 只取 /<数字> 形态的单集页链接；顺带去掉站点导航里的非内容链接
    for cap in html.split("href=\"").skip(1) {
        let Some(rest) = cap.strip_prefix(SITE) else { continue };
        let Some(end) = rest.find('"') else { continue };
        let path = &rest[..end];
        let Some(id) = path.strip_prefix('/').filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())) else {
            continue;
        };
        if seen.iter().any(|s| s == id) {
            continue;
        }
        // 链接文本在 `>` 之后、`<` 之前
        let text_start = cap[end..].find('>').map(|i| end + i + 1).unwrap_or(cap.len());
        let text_end = cap[text_start..].find('<').map(|i| text_start + i).unwrap_or(cap.len());
        let title = decode_entities(cap[text_start..text_end].trim());
        if title.is_empty() || title.starts_with('[') {
            continue;
        }
        let index = bracket_index(&title);
        seen.push(id.to_string());
        out.push(DataSourceItem {
            id: Some(id.to_string()),
            title: title.clone(),
            index,
            link: Some(format!("{SITE}/{id}")),
            // 这一集有片址，但要现取（带 Cookie）⇒ 报 Page，让上层来问
            enclosure: None,
            kind: ItemKind::Page,
            published: None,
        });
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// `… [37]` → `Some(37.0)`；没有方括号数字给 `None`。
pub fn bracket_index(title: &str) -> Option<f64> {
    let at = title.rfind('[')?;
    let end = title[at + 1..].find(']')? + at + 1;
    title[at + 1..end].trim().parse::<f64>().ok()
}

/// 最小 HTML 实体还原（标题里常见的 `&#8211;` / `&amp;`）。
pub fn decode_entities(s: &str) -> String {
    s.replace("&#8211;", "–")
        .replace("&#8217;", "’")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"
      <a href="https://anime1.me/28370" rel="bookmark">葬送的芙莉蓮 第二季 [37]</a>
      <a href="https://anime1.me/28307">葬送的芙莉蓮 第二季 [36]</a>
      <a href="https://anime1.me/">動畫列表</a>
      <a href="https://anime1.me/2026%e5%b9%b4">2026年夏季新番</a>
      <a href="https://anime1.me/notify/">訂閱通知</a>
    "#;

    #[test]
    fn search_picks_only_numeric_episode_pages() {
        let items = parse_search(FIXTURE, 10);
        assert_eq!(items.len(), 2, "只该认出两个单集页：{:?}", items.iter().map(|i| i.title.clone()).collect::<Vec<_>>());
        assert_eq!(items[0].id.as_deref(), Some("28370"));
        assert_eq!(items[0].index, Some(37.0));
        assert_eq!(items[0].link.as_deref(), Some("https://anime1.me/28370"));
        // 片址要现取（带 Cookie），所以契约类型是 Page 而不是 Video
        assert_eq!(items[0].kind, ItemKind::Page);
        assert_eq!(items[1].index, Some(36.0));
    }

    #[test]
    fn bracket_index_reads_trailing_number() {
        assert_eq!(bracket_index("葬送的芙莉蓮 第二季 [37]"), Some(37.0));
        assert_eq!(bracket_index("某番 [07]"), Some(7.0));
        assert_eq!(bracket_index("没有集号"), None);
        assert_eq!(bracket_index("方括号里不是数字 [abc]"), None);
    }

    #[test]
    fn apireq_parses_and_validates_shape() {
        let html = r#"<video id="vjs" data-apireq="%7B%22c%22%3A%221833%22%2C%22e%22%3A%2237%22%7D"></video>"#;
        let got = parse_apireq(html).expect("该解出来");
        assert_eq!(got, r#"{"c":"1833","e":"37"}"#);
        assert!(parse_apireq("<video></video>").is_err(), "没有该属性要报错");
        assert!(parse_apireq(r##"<video data-apireq="%7B%22x%22%3A1%7D"></video>"##).is_err(), "缺 c/e 要报错");
    }

    #[test]
    fn cookie_header_keeps_expires_commas_intact() {
        // reqwest 的 get_all(SET_COOKIE) 给的是**逐条**值；expires 里自带逗号，
        // 谁再按逗号拆就会把一个 cookie 劈成两半（本轮实测踩过）。
        let values = [
            "e=1792544987; expires=Wed, 21 Oct 2026 01:09:47 GMT; Max-Age=28798; path=/1764/15b.mp4; domain=.v.anime1.me; secure; HttpOnly",
            "p=eyJhbGciOi.x.y; expires=Wed, 21 Oct 2026 01:09:47 GMT; path=/1764/15b.mp4; HttpOnly",
            "h=I2gEX1M9MJQMy1xtdra3WA; expires=Wed, 21 Oct 2026 01:09:47 GMT; path=/1764/15b.mp4; HttpOnly",
        ];
        assert_eq!(
            join_set_cookies(values),
            "e=1792544987; p=eyJhbGciOi.x.y; h=I2gEX1M9MJQMy1xtdra3WA"
        );
    }

    #[test]
    fn cookie_header_skips_empty_values() {
        assert_eq!(join_set_cookies(["a=1", "", "  "]), "a=1");
        assert_eq!(join_set_cookies(Vec::<&str>::new()), "");
    }
}
