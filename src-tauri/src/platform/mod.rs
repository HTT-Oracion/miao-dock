//! 跨平台底座：路径落点（`paths`）与子进程看守（`child_watch`）。
//!
//! 为什么这两件东西合成一个域：它们的共同点是「**每家平台各有一套规矩**」——
//! Windows 的盘符/反斜杠/`CREATE_NO_WINDOW`/`taskkill`，macOS 的
//! `Contents/Resources`/POSIX 信号/`killpg`。
//!
//! 为什么放在库根这一层：lib 侧（`mangasvc` 服务实现）与 bin 侧（桌面壳）
//! **同时依赖**它们，且它们本身不认识任何业务概念（不认识任务、不认识漫画、
//! 不认识音乐）——按「依赖什么定归属」它们不属于任何一个业务域。
pub mod child_watch;
pub mod paths;
pub mod root_guard;
