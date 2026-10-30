//! 内核轨（libmpv 的替身实现：同一个 mpv 二进制 + JSON IPC）。
//!
//! 分层：`ipc` 是纯协议（行格式 / 事件解包 / 轨道表），`mpv` 是进程与客户端。
//! 上层只认 `playback::PlaybackCore` 的七个动作 + 一个快照 —— 与 WebView 轨同一份契约。

pub mod ipc;
pub mod mpv;

pub use mpv::{close, ctl, open_file, probe, selftest, status, KernelInfo, KernelState};
