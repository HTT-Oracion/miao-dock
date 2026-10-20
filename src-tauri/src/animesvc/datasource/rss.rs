//! RSS 2.0 / Atom 1.0 适配器（M3 第一个真实取数器）。
//!
//! ## 为什么自己解析而不引 `rss` crate
//! 我们只要 title / link / enclosure / pubDate 四样，且要**如实分类**附件
//! （视频直链 vs BT 种子）。整份 RSS 数据结构（channel / image / cloud …）对我们是噪音。
//! 用 `quick-xml` 的流式读取自己抽这四样，形状由本模块的契约定，测试也能钉死。
//!
//! ## 集号解析
//! 从标题里找第一段数字（`[Ncop] 标题 - 12 [1080p]` → 12；`第 3 话` → 3）。
//! 认不出给 `None`：**不猜**，猜错会让自动择优把 PV 当正片。

use std::time::Duration;

use quick_xml::events::Event;
use quick_xml::Reader;

use super::{DataSourceItem, ItemKind};

/// 请求超时：与元数据同一量级（用户点一下「测试」在等）。
const TIMEOUT_SECS: u64 = 12;

const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "webm", "mov", "mkv", "avi", "flv", "ts", "m2ts"];

/// 拉取并解析一个 RSS / Atom 源，取前 `limit` 条（源通常是新的在前）。
pub async fn fetch(url: &str, limit: usize) -> Result<Vec<DataSourceItem>, String> {
    let res = reqwest::Client::builder()
        .user_agent(super::super::metadata::user_agent())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败：{e}"))?
        .get(url)
        .header("Accept", "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8")
        .send()
        .await
        .map_err(|e| format!("请求源失败：{e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("源返回 {status}"));
    }
    let text = res
        .text()
        .await
        .map_err(|e| format!("源响应读不出来：{e}"))?;
    Ok(parse(&text, limit))
}

/// 标题 → 集号：第一段数字（允许一位小数）。认不出返回 `None`。
pub fn episode_index(title: &str) -> Option<f64> {
    let mut digits = String::new();
    let mut seen_dot = false;
    for c in title.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
            continue;
        }
        if c == '.' && !digits.is_empty() && !seen_dot {
            digits.push(c);
            seen_dot = true;
            continue;
        }
        if !digits.is_empty() {
            break;
        }
    }
    let trimmed = digits.trim_end_matches('.');
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<f64>().ok()
}

/// 按附件类型 / 地址后缀分类。
pub fn classify(enclosure_type: Option<&str>, url: Option<&str>) -> ItemKind {
    if let Some(t) = enclosure_type {
        let t = t.to_ascii_lowercase();
        if t.contains("bittorrent") || t.contains("magnet") {
            return ItemKind::Torrent;
        }
        if t.starts_with("video/") {
            return ItemKind::Video;
        }
    }
    if let Some(u) = url {
        let u = u.to_ascii_lowercase();
        if u.starts_with("magnet:") {
            return ItemKind::Torrent;
        }
        let ext = u.rsplit('.').next().unwrap_or("");
        if VIDEO_EXTS.contains(&ext) {
            return ItemKind::Video;
        }
    }
    ItemKind::Page
}

/// 解析 RSS 2.0 / Atom 1.0 的 XML 文本（纯函数，测试直接喂字符串）。
///
/// 兼容两种标签形态：`<link>文本</link>`（RSS）与自闭合的 `<link href="…"/>`、
/// `<enclosure …/>`（Atom / RSS 附件）。**截断的 XML 也会把已读到的条目吐出来** ——
/// 源被 CDN 掐断是常态，整体失败等于「明明有数据却报测试不通」。
pub fn parse(xml: &str, limit: usize) -> Vec<DataSourceItem> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut out: Vec<DataSourceItem> = Vec::new();

    // 当前 item 的字段
    let mut title: Option<String> = None;
    let mut link: Option<String> = None;
    let mut enclosure: Option<String> = None;
    let mut enclosure_type: Option<String> = None;
    let mut published: Option<String> = None;
    let mut in_item = false;
    let mut text_tag: Option<String> = None;

    // 把当前 item 收尾入列并清空字段（End 与 Eof 共用：截断的源也要吐出已读部分）
    let flush = |out: &mut Vec<DataSourceItem>,
                 title: &mut Option<String>,
                 link: &mut Option<String>,
                 enclosure: &mut Option<String>,
                 enclosure_type: &mut Option<String>,
                 published: &mut Option<String>| {
        if let Some(t) = title.clone().filter(|s| !s.is_empty()) {
            let kind = classify(enclosure_type.as_deref(), enclosure.as_deref());
            let index = episode_index(&t);
            out.push(DataSourceItem {
                id: None,
                title: t,
                index,
                link: link.clone(),
                enclosure: enclosure.clone(),
                kind,
                published: published.clone(),
            });
        }
        *title = None;
        *link = None;
        *enclosure = None;
        *enclosure_type = None;
        *published = None;
    };

    loop {
        if limit > 0 && out.len() >= limit {
            break;
        }
        match reader.read_event() {
            // 自闭合标签（`<enclosure …/>` / `<link href="…"/>`）走的是 Empty 而不是 Start
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_ascii_lowercase();
                match name.as_str() {
                    "item" | "entry" => {
                        flush(
                            &mut out,
                            &mut title,
                            &mut link,
                            &mut enclosure,
                            &mut enclosure_type,
                            &mut published,
                        );
                        in_item = true;
                        text_tag = None;
                    }
                    "enclosure" if in_item => {
                        // RSS：<enclosure url="..." type="application/x-bittorrent"/>
                        for a in e.attributes().flatten() {
                            let k = String::from_utf8_lossy(a.key.as_ref()).to_ascii_lowercase();
                            let v = a.unescape_value().unwrap_or_default().to_string();
                            if k == "url" {
                                enclosure = Some(v);
                            } else if k == "type" {
                                enclosure_type = Some(v);
                            }
                        }
                    }
                    "link" if in_item => {
                        // Atom：<link href="..." rel="alternate"/>；RSS：<link>文本</link>
                        let mut href: Option<String> = None;
                        for a in e.attributes().flatten() {
                            if a.key.as_ref() == b"href" {
                                href = Some(a.unescape_value().unwrap_or_default().to_string());
                            }
                        }
                        if let Some(h) = href {
                            link = Some(h);
                            text_tag = None;
                        } else {
                            text_tag = Some("link".into());
                        }
                    }
                    "title" | "pubdate" | "published" | "torrent" if in_item => {
                        text_tag = Some(name.clone());
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                let Some(tag) = text_tag.clone() else { continue };
                let text = e.unescape().unwrap_or_default().trim().to_string();
                if text.is_empty() {
                    continue;
                }
                match tag.as_str() {
                    "title" => title = Some(text),
                    "link" => link = Some(text),
                    "pubdate" | "published" => published = Some(text),
                    // Mikan 风格：<torrent>磁力或种子地址</torrent>
                    "torrent" => enclosure = Some(text),
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_ascii_lowercase();
                if name == "item" || name == "entry" {
                    flush(
                        &mut out,
                        &mut title,
                        &mut link,
                        &mut enclosure,
                        &mut enclosure_type,
                        &mut published,
                    );
                    in_item = false;
                    text_tag = None;
                } else if text_tag.as_deref() == Some(name.as_str()) {
                    text_tag = None;
                }
            }
            Ok(Event::Eof) => {
                // 截断的源：把还没等到闭合标签的条目吐出来
                flush(
                    &mut out,
                    &mut title,
                    &mut link,
                    &mut enclosure,
                    &mut enclosure_type,
                    &mut published,
                );
                break;
            }
            Err(_) => break,
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSS_FIXTURE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Mikan</title>
    <item>
      <title>[Lilith-Raws] 孤独摇滚 第 12 话 [1080p][简中]</title>
      <link>https://mikanani.me/Home/Episode/aaa</link>
      <enclosure url="https://mikanani.me/Download/1.torrent" type="application/x-bittorrent"/>
      <pubDate>Sat, 03 Jan 2026 09:00:00 +0800</pubDate>
    </item>
    <item>
      <title>[Sub] 冰菓 - 03 [WebRip 1080p]</title>
      <link>https://example.test/detail/3</link>
      <enclosure url="https://example.test/video/03.mp4" type="video/mp4"/>
      <pubDate>Fri, 02 Jan 2026 09:00:00 +0800</pubDate>
    </item>
    <item>
      <title>冰菓 预告 PV</title>
      <link>https://example.test/detail/pv</link>
    </item>
  </channel>
</rss>"#;

    const ATOM_FIXTURE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>某站更新</title>
  <entry>
    <title>葬送的芙莉莲 第 09 话</title>
    <link href="https://example.test/9" rel="alternate"/>
    <published>2026-01-03T09:00:00Z</published>
  </entry>
  <entry>
    <title>无职转生 第二季 12.5 特别篇</title>
    <updated>2026-01-02T09:00:00Z</updated>
  </entry>
</feed>"#;

    #[test]
    fn parses_rss_items_with_kinds() {
        let items = parse(RSS_FIXTURE, 10);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].title, "[Lilith-Raws] 孤独摇滚 第 12 话 [1080p][简中]");
        assert_eq!(items[0].index, Some(12.0));
        assert_eq!(items[0].kind, ItemKind::Torrent);
        assert_eq!(items[0].link.as_deref(), Some("https://mikanani.me/Home/Episode/aaa"));
        assert!(items[0].published.is_some());

        assert_eq!(items[1].index, Some(3.0));
        assert_eq!(items[1].kind, ItemKind::Video);
        assert_eq!(items[1].enclosure.as_deref(), Some("https://example.test/video/03.mp4"));

        // 没有附件 ⇒ 只是网页，不冒充可播
        assert_eq!(items[2].kind, ItemKind::Page);
        assert!(items[2].enclosure.is_none());
    }

    #[test]
    fn parses_atom_entries_and_limit() {
        let items = parse(ATOM_FIXTURE, 10);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].index, Some(9.0));
        assert_eq!(items[0].link.as_deref(), Some("https://example.test/9"));
        assert_eq!(items[0].published.as_deref(), Some("2026-01-03T09:00:00Z"));
        // 特别篇的一位小数集号
        assert_eq!(items[1].index, Some(12.5));

        assert_eq!(parse(ATOM_FIXTURE, 1).len(), 1);
    }

    #[test]
    fn episode_index_reads_first_number_only() {
        assert_eq!(episode_index("[Ncop] 标题 - 12 [1080p]"), Some(12.0));
        assert_eq!(episode_index("第 3 话"), Some(3.0));
        assert_eq!(episode_index("S02E07"), Some(2.0));
        assert_eq!(episode_index("剧场版"), None);
        assert_eq!(episode_index(""), None);
    }

    #[test]
    fn classify_by_type_then_url() {
        assert_eq!(classify(Some("application/x-bittorrent"), None), ItemKind::Torrent);
        assert_eq!(classify(Some("video/webm"), None), ItemKind::Video);
        assert_eq!(classify(None, Some("magnet:?xt=urn:btih:abc")), ItemKind::Torrent);
        assert_eq!(classify(None, Some("https://x.test/a.MKV")), ItemKind::Video);
        assert_eq!(classify(None, Some("https://x.test/page")), ItemKind::Page);
        assert_eq!(classify(None, None), ItemKind::Page);
    }

    #[test]
    fn broken_xml_returns_what_it_got() {
        // 截断的 XML：已读到的条目照常返回，不整体失败（源常常被 CDN 掐断）
        let items = parse(&RSS_FIXTURE[..RSS_FIXTURE.find("</item>").unwrap()], 10);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].index, Some(12.0));
    }
}
