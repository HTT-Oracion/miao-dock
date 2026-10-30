// 喵坞 MiaoDock · 库根（F0 起）
//
// 为什么要有 lib.rs：Tauri 桌面端是**单目标**（`main.rs`）时，逻辑无法被**另一个可执行**
// 复用 —— 而 F 组要求有一个能独立跑起来的服务靶子（`[[bin]] mangasvc`），好让 e2e 用
// `MIAO_SERVICE_IMPL=node|rust` 打两套实现、跑同一套断言。
//
// 因此本库只放**服务侧**（mangasvc）与**跨端共用**的跨平台底座（platform：paths /
// child_watch）；Tauri 装配仍留在 `main.rs`（它只管进程、窗口、托盘、IPC 命令）。
// 拆出来是**机械搬移**，不改逻辑。
pub mod animesvc;
pub mod mangasvc;
pub mod platform;
