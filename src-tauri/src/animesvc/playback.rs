//! 播放内核的**单一契约**（M2 PoC 的落点）。
//!
//! ## 为什么先冻接口再挑内核
//! 本地/BT/媒体库走 libmpv，在线流走 WebView（hls.js + ArtPlayer）—— 两条完全不同的
//! 技术栈。如果先各写一套控制逻辑，控制条 / 续看 / 快捷键 / 跳过 OP-ED 就会长出两个版本，
//! 之后每条修复都要改两遍。所以先把「上层需要什么」钉成 trait，两个后端各自实现，
//! 上层（IPC / 前端控制条）只认这一份。
//!
//! ## 契约里刻意**没有**的东西
//! · 不做解码 / 字幕渲染：那是内核的事（libmpv 的 libass、WebView 的 JASSUB），
//!   本层只转达"要哪条轨"。
//! · 不做播放列表：队列归番剧库（manifest 的集顺序），内核一次只认一个片源。
//! · 不暴露后端类型：调用方不能问"你是 mpv 还是 video"，一问就会写出两套分支。
//!
//! ## 本轮做到哪
//! 契约 + `MockCore` + 自检序列（`--playback-selftest`）。真 libmpv 后端要双平台二进制与
//! 打包验证（PoC 的机器依赖部分），不在本机凭空产出 —— 自检证明的是**接口语义与上层可测**，
//! 不是"能播 mkv"。

use serde_json::{json, Value};

/// 播放器对外暴露的状态快照（前端控制条 / 续看 / 历史共用）。
#[derive(Debug, Clone, PartialEq)]
pub struct PlaybackSnapshot {
    pub position_ms: u64,
    pub duration_ms: u64,
    pub playing: bool,
    pub buffered_ms: u64,
    pub rate: f64,
    /// 当前字幕轨标签（空 = 无字幕）
    pub subtitle: String,
    /// 当前音轨标签
    pub audio_track: String,
}

/// 片源：本地文件 / 磁力（未完成）/ 在线 HLS。
#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    File { path: String },
    Torrent { info_hash: String, file_index: u32 },
    Hls { url: String },
}

/// 轨道种类。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TrackKind {
    Audio,
    Subtitle,
}

/// 两轨共用的播放契约 —— 上层只认这七个动作 + 一个状态。
pub trait PlaybackCore {
    /// 打开片源并进入暂停态（不自动播：一打开就有声音会吓人）。
    fn open(&mut self, source: Source) -> Result<(), String>;
    fn play(&mut self) -> Result<(), String>;
    fn pause(&mut self) -> Result<(), String>;
    /// 跳转（毫秒）；越界夹到 `[0, duration]`，不报错 —— 拖拽常越界，报错等于让控制条自己夹。
    fn seek(&mut self, position_ms: u64) -> Result<(), String>;
    /// 倍速：夹到 `[0.25, 4.0]`（超出是调用方的错，但夹住比 panic 好）。
    fn set_rate(&mut self, rate: f64) -> Result<(), String>;
    fn select_track(&mut self, kind: TrackKind, id: &str) -> Result<(), String>;
    /// 外挂字幕（ass/srt/vtt）；空串 = 关闭字幕。
    fn load_subtitle(&mut self, path: &str) -> Result<(), String>;
    fn snapshot(&self) -> PlaybackSnapshot;
}

/// 自检用的确定性后端：不碰文件、不碰网络，只验证契约语义。
#[derive(Debug, Default)]
pub struct MockCore {
    duration_ms: u64,
    position_ms: u64,
    playing: bool,
    rate: f64,
    subtitle: String,
    audio: String,
    opened: bool,
}

impl MockCore {
    pub fn new(duration_ms: u64) -> Self {
        Self { duration_ms, rate: 1.0, audio: "默认音轨".into(), ..Default::default() }
    }
}

impl PlaybackCore for MockCore {
    fn open(&mut self, _source: Source) -> Result<(), String> {
        self.opened = true;
        self.playing = false;
        self.position_ms = 0;
        Ok(())
    }

    fn play(&mut self) -> Result<(), String> {
        if !self.opened {
            return Err("没有打开片源".into());
        }
        self.playing = true;
        Ok(())
    }

    fn pause(&mut self) -> Result<(), String> {
        self.playing = false;
        Ok(())
    }

    fn seek(&mut self, position_ms: u64) -> Result<(), String> {
        if !self.opened {
            return Err("没有打开片源".into());
        }
        self.position_ms = position_ms.min(self.duration_ms);
        Ok(())
    }

    fn set_rate(&mut self, rate: f64) -> Result<(), String> {
        if !rate.is_finite() {
            return Err("倍速不是有限数".into());
        }
        self.rate = rate.clamp(0.25, 4.0);
        Ok(())
    }

    fn select_track(&mut self, kind: TrackKind, id: &str) -> Result<(), String> {
        match kind {
            TrackKind::Audio => self.audio = id.to_string(),
            TrackKind::Subtitle => self.subtitle = id.to_string(),
        }
        Ok(())
    }

    fn load_subtitle(&mut self, path: &str) -> Result<(), String> {
        self.subtitle = if path.is_empty() { String::new() } else { path.to_string() };
        Ok(())
    }

    fn snapshot(&self) -> PlaybackSnapshot {
        PlaybackSnapshot {
            position_ms: self.position_ms,
            duration_ms: self.duration_ms,
            playing: self.playing,
            buffered_ms: self.position_ms.saturating_add(30_000).min(self.duration_ms),
            rate: self.rate,
            subtitle: self.subtitle.clone(),
            audio_track: self.audio.clone(),
        }
    }
}

/// 契约自检：按脚本跑一遍，返回逐条结果（给 `--playback-selftest` 与将来的 nightly 用）。
pub fn selftest() -> Value {
    let mut cases: Vec<Value> = Vec::new();
    let mut core = MockCore::new(1_440_000);
    let mut ok = true;

    let mut push = |name: &str, cond: bool, detail: &str| {
        if !cond {
            ok = false;
        }
        cases.push(json!({ "name": name, "ok": cond, "detail": detail }));
    };

    push("未开片源时 play 报错", core.play().is_err(), "空内核不该假装在播");
    push("open 后处于暂停态", core.open(Source::File { path: "/tmp/a.mkv".into() }).is_ok() && !core.snapshot().playing, "一打开就有声音会吓人");
    push("play 后 playing=true", core.play().is_ok() && core.snapshot().playing, "");
    push("seek 越界夹到时长", core.seek(9_999_999).is_ok() && core.snapshot().position_ms == 1_440_000, "");
    push("倍速夹到 [0.25,4]", core.set_rate(9.0).is_ok() && core.snapshot().rate == 4.0, "");
    push("倍速下限也夹住", core.set_rate(-1.0).is_ok() && core.snapshot().rate == 0.25, "");
    push(
        "选字幕轨生效",
        core.select_track(TrackKind::Subtitle, "简中").is_ok() && core.snapshot().subtitle == "简中",
        "",
    );
    push("空路径关闭字幕", core.load_subtitle("").is_ok() && core.snapshot().subtitle.is_empty(), "");
    push("pause 后 playing=false", core.pause().is_ok() && !core.snapshot().playing, "");
    push("缓冲不超过时长", core.snapshot().buffered_ms <= core.snapshot().duration_ms, "");

    json!({ "ok": ok, "cases": cases })
}
