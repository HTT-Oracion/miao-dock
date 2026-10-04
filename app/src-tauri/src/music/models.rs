use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// 统一歌曲结构
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Song {
    pub provider: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_mid: Option<String>,
    pub name: String,
    pub artist: String,
    pub artists: Vec<Artist>,
    pub album: String,
    pub cover: String,
    /// 歌曲时长，**单位毫秒**（全链路统一契约，前端不得再换算）。
    ///
    /// 为什么特意写明：四个平台的原始字段单位并不一致 —— 网易云 `dt` 是毫秒、
    /// 酷狗 `Duration` 是秒（取用时 `* 1000`）、QQ `interval` 是秒（取用时 `* 1000`）、
    /// 咪咕给的就是毫秒。上游把「归一成毫秒」这件事做在了各平台取用处，
    /// 于是这个结构体字段本身没有单位标注，下游很容易再乘一次 1000（曾因此把
    /// 4:29 显示成 4483:20，详见 docs/spec-notes.md D-33）。
    pub duration: u64,
    pub fee: i32,
    pub playable: bool,
    #[serde(default)]
    pub language: i32,
    // === 酷狗扩展字段 ===
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub album_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub album_audio_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub hq_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sq_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub res_hash: Option<String>,
    // === QQ 音乐扩展字段 ===
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub qq_song_id: Option<i64>,
    // === 咪咕扩展字段 (id 存 copyrightId，播放用 contentId) ===
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub content_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Artist {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mid: Option<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pic_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub music_size: Option<i64>,
}

/// 专辑
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Album {
    pub id: String,
    pub name: String,
    pub cover: String,
    pub publish_time: i64,
    pub song_count: u32,
    pub artist_name: String,
}

/// 歌手 MV
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Mv {
    pub id: String,
    pub name: String,
    pub cover: String,
    pub duration: u64,
    pub play_count: i64,
    pub artist_name: String,
}

/// 歌手简介
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ArtistDetail {
    pub id: String,
    pub name: String,
    pub brief_desc: String,
}

/// 歌单
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Playlist {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub cover: String,
    pub track_count: u32,
    pub creator: String,
    #[serde(default)]
    pub subscribed: bool,
}

/// 播放地址结果
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SongUrlResult {
    pub url: Option<String>,
    pub playable: bool,
    pub trial: bool,
    pub level: String,
    pub quality: String,
    pub br: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee: Option<i32>,
}

/// 登录信息
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LoginInfo {
    pub provider: String,
    pub logged_in: bool,
    pub user_id: String,
    pub nickname: String,
    pub avatar: String,
    pub vip_type: i32,
    pub vip_level: String,
    pub is_vip: bool,
    pub is_svip: bool,
}

/// 歌词
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Lyrics {
    pub lyric: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roma: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yrc: Option<String>,
}

/// 单个平台的缓存占用
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CacheProviderStat {
    /// 歌词部分字节数
    pub lyric_bytes: u64,
    /// 音频部分字节数
    pub audio_bytes: u64,
}

/// 音乐缓存总体统计
///
/// `providers` 的键恒定为 `netease` / `qqmusic` / `kugou` / `migu` 四个，
/// 无缓存的平台值为 0 而不是缺键 —— 前端可以省掉判空。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CacheStats {
    /// 全部平台合计字节数
    pub total: u64,
    /// 歌词合计字节数
    pub lyric_bytes: u64,
    /// 音频合计字节数
    pub audio_bytes: u64,
    /// 缓存根目录绝对路径（拿不到时为空串，前端据此禁用「打开目录」）
    pub root: String,
    /// 歌词容量上限字节数
    pub limit_lyric: u64,
    /// 音频容量上限字节数
    pub limit_audio: u64,
    /// 按平台的占用明细
    pub providers: HashMap<String, CacheProviderStat>,
}

/// 评论
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Comment {
    pub comment_id: i64,
    pub content: String,
    pub time: i64,
    pub liked_count: i64,
    pub liked: bool,
    pub user_id: i64,
    pub nickname: String,
    pub avatar: String,
}

/// 评论分页结果
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CommentPage {
    pub total: i64,
    pub has_more: bool,
    pub comments: Vec<Comment>,
    pub hot_comments: Vec<Comment>,
}

/// 二维码检查结果
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QrCheckResult {
    /// 801=等待扫码, 802=待确认, 803=成功, 800=过期
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cookie: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
}

/// 音质候选
#[derive(Debug, Clone)]
pub struct QualityCandidate {
    pub level: String,
    pub label: String,
}

pub fn netease_quality_candidates() -> Vec<QualityCandidate> {
    vec![
        QualityCandidate { level: "jymaster".into(), label: "超清母带".into() },
        QualityCandidate { level: "hires".into(),    label: "高清臻音".into() },
        QualityCandidate { level: "lossless".into(), label: "无损".into()    },
        QualityCandidate { level: "exhigh".into(),   label: "极高".into()    },
        QualityCandidate { level: "standard".into(), label: "标准".into()    },
    ]
}

pub fn normalize_quality(value: &str) -> String {
    let raw = value.to_lowercase();
    match raw.as_str() {
        "jymaster" | "master" | "studio" | "svip" => "jymaster".into(),
        "hires" | "hi-res" | "highres" | "zhenyin" | "spatial" => "hires".into(),
        "lossless" | "flac" | "sq" => "lossless".into(),
        "exhigh" | "high" | "320" | "320k" | "hq" => "exhigh".into(),
        "standard" | "normal" | "128" | "128k" | "std" => "standard".into(),
        _ => "hires".into(),
    }
}

pub fn quality_candidates_from(target: &str) -> Vec<QualityCandidate> {
    let normalized = normalize_quality(target);
    let all = netease_quality_candidates();
    let start = all.iter().position(|c| c.level == normalized).unwrap_or(0);
    all[start..].to_vec()
}

/// 酷狗音质候选
#[allow(dead_code)]
pub fn kugou_quality_candidates() -> Vec<QualityCandidate> {
    vec![
        QualityCandidate { level: "jymaster".into(), label: "超清母带".into() },
        QualityCandidate { level: "hires".into(),    label: "Hi-Res".into()    },
        QualityCandidate { level: "lossless".into(), label: "无损".into()    },
        QualityCandidate { level: "exhigh".into(),   label: "极高".into()    },
        QualityCandidate { level: "standard".into(), label: "标准".into()    },
    ]
}

/// QQ 音乐音质模板 (对照 Mineradio QQ_QUALITY_CANDIDATE_TEMPLATES)
/// (prefix, ext, level, label)
pub const QQ_QUALITY_TEMPLATES: &[(&str, &str, &str, &str)] = &[
    ("RS01", ".flac", "hires",    "Hi-Res FLAC"),
    ("F000", ".flac", "lossless", "无损 FLAC"),
    ("M800", ".mp3",  "exhigh",   "320k MP3"),
    ("M500", ".mp3",  "standard", "128k MP3"),
    ("C400", ".m4a",  "aac",      "AAC/M4A"),
];

/// QQ 音乐音质候选列表
#[allow(dead_code)]
pub fn qq_quality_candidates() -> Vec<QualityCandidate> {
    vec![
        QualityCandidate { level: "hires".into(),    label: "Hi-Res".into()    },
        QualityCandidate { level: "lossless".into(), label: "无损".into()    },
        QualityCandidate { level: "exhigh".into(),   label: "极高".into()    },
        QualityCandidate { level: "standard".into(), label: "标准".into()    },
    ]
}
