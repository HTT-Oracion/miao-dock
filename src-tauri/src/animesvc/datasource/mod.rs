//! 数据源取数层（M3）：**契约 + 适配器**都住这里。
//!
//! ## 为什么契约单独一层
//! RSS / 在线网页 / 选择器 / 媒体服务器 / BT 五种来源的取数方式完全不同，但上层
//! （选源屏的「测试」、自动择优、将来的播放接入）只关心同一组事实：这一集叫什么、
//! 第几集、地址是什么、那个地址是能直链播放还是得走 BT。所以类型先定死，
//! 适配器各自实现 `fetch`，返回同一形状。
//!
//! ## 诚实边界
//! `torrent` 类的附件地址**不在本层消费**：下载与边下边播归 M5（librqbit）。
//! 这里只负责「把源里有什么如实报出来」，播不播由上层按类型决定。

pub mod mediaserver;
pub mod rss;

use serde_json::{json, Value};

/// 一条取数结果。
#[derive(Debug, Clone, PartialEq)]
pub struct DataSourceItem {
    /// 源内部的稳定 id（媒体服务器的条目 id）。RSS 这类没有 id 的源给 `None`。
    ///
    /// 为什么单独留一个字段：播放 / 二次取详情都要按 id 回访上游，
    /// 从标题里反解 id 是不可靠的（同名、改名都会错）。
    pub id: Option<String>,
    /// 原始标题（含字幕组 / 分辨率，原样保留，不做美化）
    pub title: String,
    /// 从标题解析出的集号；认不出给 `None`（不猜）
    pub index: Option<f64>,
    /// 详情页 / 直链
    pub link: Option<String>,
    /// 附件地址（视频直链 / 种子 / 磁力）
    pub enclosure: Option<String>,
    /// 附件性质
    pub kind: ItemKind,
    /// 发布时间原文（不猜时区，原样回给上层）
    pub published: Option<String>,
}

/// 附件性质：决定上层能拿它干什么。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    /// 视频直链：可直接喂播放器
    Video,
    /// BT 种子 / 磁力：要走 M5 的下载链路
    Torrent,
    /// 只是网页（没有可直接播放的地址）
    Page,
}

impl ItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemKind::Video => "video",
            ItemKind::Torrent => "torrent",
            ItemKind::Page => "page",
        }
    }
}

pub fn item_json(i: &DataSourceItem) -> Value {
    json!({
        "id": i.id,
        "title": i.title,
        "index": i.index,
        "link": i.link,
        "enclosure": i.enclosure,
        "kind": i.kind.as_str(),
        "published": i.published,
    })
}

/// 测试一个源：RSS 与媒体服务器已接；其余类型**明确回未接入**，不假装测通。
pub async fn test(kind: &str, url: &str, limit: usize) -> Result<Value, String> {
    let url = url.trim();
    if !url.starts_with("http") {
        return Err("源地址要 http:// 或 https:// 开头".into());
    }
    match kind.trim() {
        "rss" => {
            let items = rss::fetch(url, limit).await?;
            Ok(json!({
                "ok": true,
                "kind": "rss",
                "count": items.len(),
                "items": items.iter().map(item_json).collect::<Vec<_>>(),
            }))
        }
        // 媒体服务器：地址里带 `?api_key=…`，只取 origin 当 API 根
        "jellyfin" | "emby" => {
            let (base, key) = mediaserver::split_source_url(url)?;
            mediaserver::probe(&base, key.as_deref(), kind, limit).await
        }
        other => Err(format!("{other} 适配器尚未接入（M3 主体）")),
    }
}
