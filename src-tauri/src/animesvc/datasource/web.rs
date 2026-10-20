//! 通用网页源（R2）：**选择器驱动**的取数层。
//!
//! 不内置任何具体站点：用户给「列表 → 链接 → 标题」三条 CSS 选择器，详情页再给一条
//! 「视频地址」选择器。产品只负责抓取与解析，站点选择与规则维护留给用户配置。
//!
//! ## 三个必须处理的现实问题
//! · **相对地址**：列表页给的多半是 `/play/123`，必须按页面 URL 解析成绝对地址，
//!   否则播放器拿到的是一个本机路径。
//! · **编码**：中文站点常见 GBK/GB18030，按 UTF-8 硬解会得到乱码标题。这里按
//!   `Content-Type` 与 `<meta charset>` 判断，必要时用 `encoding_rs` 解码。
//! · **选择器语法**：解析失败要说清是哪一条，不能把 scraper 的报错原样丢给用户。

use std::time::Duration;

use scraper::{ElementRef, Html, Selector};

use super::super::metadata;
use super::super::sources::SourceRules;
use super::{DataSourceItem, ItemKind};

const TIMEOUT_SECS: u64 = 20;
const MAX_BYTES: usize = 8 * 1024 * 1024;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(metadata::user_agent())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败：{e}"))
}

/// 抓一个网页并解码成字符串（先看响应头，再看 `<meta charset>`，都没有按 UTF-8）。
///
/// `cookies` 是**验证码窗口**里拿到的会话 cookie：有些站点只在带 cookie 时才给 HTML，
/// 不带就返回挑战页。空数组 = 不带 Cookie 头。
async fn fetch_html(url: &str, cookies: &[(String, String)]) -> Result<String, String> {
    let mut req = client()?
        .get(url)
        .header("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8");
    if let Some(c) = cookie_header(cookies) {
        req = req.header(reqwest::header::COOKIE, c);
    }
    let res = req
        .send()
        .await
        .map_err(|e| format!("请求上游失败：{e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("上游返回 {status}"));
    }
    let header_charset = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(charset_of_content_type);
    let bytes = res.bytes().await.map_err(|e| format!("读上游响应失败：{e}"))?;
    if bytes.len() > MAX_BYTES {
        return Err(format!("页面太大（{} MB），超出通用源的抓取上限", bytes.len() / 1024 / 1024));
    }
    let charset = header_charset.or_else(|| charset_of_meta(&bytes)).unwrap_or_else(|| "utf-8".into());
    Ok(decode(&bytes, &charset))
}

fn charset_of_content_type(v: &str) -> Option<String> {
    let lower = v.to_ascii_lowercase();
    let at = lower.find("charset=")?;
    let rest = &v[at + 8..];
    let name = rest.split(';').next()?.trim().trim_matches('"');
    if name.is_empty() {
        None
    } else {
        Some(name.to_ascii_lowercase())
    }
}

/// `<meta charset="gbk">` / `<meta http-equiv=... content="text/html; charset=gbk">`
fn charset_of_meta(bytes: &[u8]) -> Option<String> {
    let head = &bytes[..bytes.len().min(4096)];
    let text = String::from_utf8_lossy(head).to_ascii_lowercase();
    if let Some(at) = text.find("charset=") {
        // 两种写法都常见：`charset="gbk"` 与 `content="text/html; charset=gbk"`
        let rest = text[at + 8..].trim_start_matches(|c: char| c == '"' || c == '\'' || c.is_whitespace());
        let name: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if !name.is_empty() {
            return Some(name);
        }
    }
    None
}

fn decode(bytes: &[u8], charset: &str) -> String {
    let enc = match charset {
        "gbk" | "gb2312" | "gb18030" => encoding_rs::GBK,
        _ => encoding_rs::UTF_8,
    };
    let (text, _, _) = enc.decode(bytes);
    text.into_owned()
}

/// 相对地址 → 绝对地址（解析不了就返回原串，让上层按"打不开"处理）。
fn absolute(base: &str, href: &str) -> String {
    let href = href.trim();
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    match url::Url::parse(base).and_then(|b| b.join(href)) {
        Ok(u) => u.to_string(),
        Err(_) => href.to_string(),
    }
}

/// 元素文本：折叠空白（HTML 里的换行与缩进不该进标题）。
fn text_of(el: &ElementRef) -> String {
    el.text().collect::<Vec<_>>().join(" ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 从标题里认集号（`第 3 话` / `EP03` / `S01E03`）；认不出给 `None`，不猜。
fn index_of(title: &str) -> Option<f64> {
    let lower = title.to_ascii_lowercase();
    for pat in ["第", "ep", "e"] {
        if let Some(at) = lower.find(pat) {
            let rest = &lower[at + pat.len()..];
            let digits: String = rest
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            if let Ok(v) = digits.parse::<f64>() {
                return Some(v);
            }
        }
    }
    None
}

/// 解析列表页：每条结果给「标题 + 详情页绝对地址」。
pub async fn fetch(
    url: &str,
    rules: &SourceRules,
    limit: usize,
    cookies: &[(String, String)],
) -> Result<Vec<DataSourceItem>, String> {
    if rules.list.trim().is_empty() {
        return Err("这个源没有配「列表选择器」".into());
    }
    let html = fetch_html(url, cookies).await?;
    parse_list(&html, url, rules, limit)
}

/// `[(name, value)]` → `Cookie` 头；空集合返回 `None`（不要发一个空的 Cookie 头）。
fn cookie_header(cookies: &[(String, String)]) -> Option<String> {
    let parts: Vec<String> = cookies
        .iter()
        .filter(|(n, _)| !n.trim().is_empty())
        .map(|(n, v)| format!("{}={}", n.trim(), v))
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("; "))
    }
}

/// 纯解析（可单测）：HTML + 规则 → 条目。
pub fn parse_list(html: &str, base: &str, rules: &SourceRules, limit: usize) -> Result<Vec<DataSourceItem>, String> {
    let doc = Html::parse_document(html);
    let list_sel = Selector::parse(&rules.list).map_err(|e| format!("列表选择器语法不对：{e}"))?;
    let link_sel = rules
        .link
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(Selector::parse)
        .transpose()
        .map_err(|e| format!("链接选择器语法不对：{e}"))?;
    let title_sel = rules
        .title
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(Selector::parse)
        .transpose()
        .map_err(|e| format!("标题选择器语法不对：{e}"))?;
    let any_anchor = Selector::parse("a").expect("a 选择器恒可解析");

    let mut out: Vec<DataSourceItem> = Vec::new();
    for el in doc.select(&list_sel) {
        if out.len() >= limit.clamp(1, 50) {
            break;
        }
        let link_el = link_sel.as_ref().and_then(|s| el.select(s).next());
        let href = link_el
            .and_then(|e| e.value().attr("href"))
            .or_else(|| el.value().attr("href"))
            .or_else(|| el.select(&any_anchor).next().and_then(|a| a.value().attr("href")));
        let Some(href) = href else { continue };
        let title = match &title_sel {
            Some(s) => el.select(s).next().map(|e| text_of(&e)).unwrap_or_default(),
            None => text_of(&el),
        };
        let title = title.trim().to_string();
        if title.is_empty() {
            continue;
        }
        out.push(DataSourceItem {
            id: None,
            index: index_of(&title),
            title,
            link: Some(absolute(base, href)),
            enclosure: None,
            kind: ItemKind::Page,
            published: None,
        });
    }
    if out.is_empty() {
        return Err("列表选择器没选中任何条目（检查选择器是否与页面结构一致）".into());
    }
    Ok(out)
}

/// 详情页 → 视频地址（`video[src]` / `source[src]` / `a[href]` 都认）。
pub async fn resolve_video(
    url: &str,
    rules: &SourceRules,
    cookies: &[(String, String)],
) -> Result<String, String> {
    let sel = rules
        .video
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or("这个源没有配「视频地址选择器」，播不了")?;
    let html = fetch_html(url, cookies).await?;
    resolve_video_in(&html, url, sel)
}

/// 纯解析（可单测）。
pub fn resolve_video_in(html: &str, base: &str, selector: &str) -> Result<String, String> {
    let doc = Html::parse_document(html);
    let sel = Selector::parse(selector).map_err(|e| format!("视频选择器语法不对：{e}"))?;
    let Some(el) = doc.select(&sel).next() else {
        return Err("详情页里没找到视频地址（检查「视频地址选择器」）".into());
    };
    let raw = el
        .value()
        .attr("src")
        .or_else(|| el.value().attr("data-src"))
        .or_else(|| el.value().attr("href"))
        .ok_or("选中的元素没有 src / data-src / href 属性")?;
    Ok(absolute(base, raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(list: &str, link: Option<&str>, title: Option<&str>, video: Option<&str>) -> SourceRules {
        SourceRules {
            list: list.into(),
            link: link.map(Into::into),
            title: title.map(Into::into),
            video: video.map(Into::into),
        }
    }

    #[test]
    fn list_parses_titles_links_and_relative_urls() {
        let html = r#"
          <ul>
            <li class="item"><a href="/play/1"><span class="t">第 1 话 冰菓</span></a></li>
            <li class="item"><a href="/play/2"><span class="t">第 2 话 冰菓</span></a></li>
          </ul>"#;
        let r = rules(".item", None, Some(".t"), None);
        let items = parse_list(html, "https://example.com/list?page=2", &r, 10).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "第 1 话 冰菓");
        // 相对地址按列表页解析成绝对地址
        assert_eq!(items[0].link.as_deref(), Some("https://example.com/play/1"));
        assert_eq!(items[0].index, Some(1.0));
        assert_eq!(items[1].index, Some(2.0));
        assert_eq!(items[0].kind, ItemKind::Page);
    }

    #[test]
    fn list_respects_limit_and_skips_items_without_links() {
        let html = r#"
          <div class="item"><a href="/a">A</a></div>
          <div class="item">没有链接</div>
          <div class="item"><a href="/c">C</a></div>"#;
        let items = parse_list(html, "https://example.com/", &rules(".item", None, None, None), 1).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "A");
    }

    #[test]
    fn list_reports_empty_result_instead_of_pretending_success() {
        let err = parse_list("<html></html>", "https://example.com/", &rules(".nope", None, None, None), 5)
            .unwrap_err();
        assert!(err.contains("没选中任何条目"), "{err}");
    }

    #[test]
    fn bad_selector_names_the_field() {
        let err = parse_list("<html></html>", "https://e/", &rules("a[", None, None, None), 5).unwrap_err();
        assert!(err.starts_with("列表选择器语法不对"), "{err}");
    }

    #[test]
    fn resolve_video_reads_src_and_href_and_resolves_relative() {
        let html = r#"<div><video src="/v/1.mp4"></video></div>"#;
        assert_eq!(
            resolve_video_in(html, "https://example.com/play/1", "video").unwrap(),
            "https://example.com/v/1.mp4"
        );
        let html = r#"<a class="dl" href="ep2.m3u8">下载</a>"#;
        assert_eq!(
            resolve_video_in(html, "https://example.com/play/2/", "a.dl").unwrap(),
            "https://example.com/play/2/ep2.m3u8"
        );
        let html = r#"<source data-src="//cdn.example.com/a.m3u8">"#;
        assert_eq!(
            resolve_video_in(html, "https://example.com/x", "source").unwrap(),
            "https://cdn.example.com/a.m3u8"
        );
    }

    #[test]
    fn resolve_video_says_what_is_missing() {
        let err = resolve_video_in("<html></html>", "https://e/", "video").unwrap_err();
        assert!(err.contains("没找到视频地址"), "{err}");
        let err = resolve_video_in("<video></video>", "https://e/", "video").unwrap_err();
        assert!(err.contains("没有 src"), "{err}");
    }

    #[test]
    fn charset_is_detected_from_meta_and_content_type() {
        assert_eq!(charset_of_content_type("text/html; charset=GBK"), Some("gbk".into()));
        assert_eq!(charset_of_content_type("text/html"), None);
        let gbk_meta = b"<html><head><meta charset=\"gb2312\"></head></html>";
        assert_eq!(charset_of_meta(gbk_meta), Some("gb2312".into()));
        // GBK 的「中文」两个字节序列，按 GBK 解要能还原
        let bytes = [0xD6, 0xD0, 0xCE, 0xC4];
        assert_eq!(decode(&bytes, "gbk"), "中文");
        assert_ne!(decode(&bytes, "utf-8"), "中文");
    }

    #[test]
    fn index_is_parsed_only_when_present() {
        assert_eq!(index_of("第 12 话"), Some(12.0));
        assert_eq!(index_of("EP03 预告"), Some(3.0));
        assert_eq!(index_of("冰菓 PV"), None);
    }
}
