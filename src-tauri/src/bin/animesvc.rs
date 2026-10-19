// animesvc —— 动漫域的服务进程（D-242）
//
// 与 `mangasvc` 同构但不共享任何东西：自己的 state / 令牌 / 库根 / 运行时根，
// 端口在 5180–5190 内"先探测再绑定" ⇒ 两个 exe 能同时正常运行。
fn main() {
    // `--print-paths`：只打印**动漫侧**路径快照后退出，不起服务。
    // 用途：`check:anime` 断言落点形状与三个 env 覆盖语义（毫秒级）。
    // 🔴 单独一份快照，不并进 mangasvc 的 `snapshot()` —— 后者是 `check:paths` 的
    //    golden 断言对象，混进动漫键会让两条金标互相掩盖。
    if std::env::args().any(|a| a == "--print-paths") {
        println!("{}", miao_dock::platform::paths::anime_snapshot());
        return;
    }
    // `--playback-selftest`：跑播放契约的自检序列后退出（M2 PoC 的可执行底座）。
    // 真 libmpv 后端要双平台二进制，本机没有时这条仍能证明"接口语义与上层可测"。
    if std::env::args().any(|a| a == "--playback-selftest") {
        println!("{}", miao_dock::animesvc::playback::selftest());
        return;
    }
    let opts = miao_dock::animesvc::Options::from_env();
    if let Err(e) = miao_dock::animesvc::run_blocking(opts) {
        eprintln!("[anime-service] animesvc 启动失败：{e}");
        std::process::exit(1);
    }
}
