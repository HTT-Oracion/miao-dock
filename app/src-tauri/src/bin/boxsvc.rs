// boxsvc —— 独立可运行的服务靶子（F0）
//
// 用途：给 e2e 一个**能被 spawn 的 Rust 服务**。`MIAO_SERVICE_IMPL=rust` 时，各验收脚本
// 起的是它而不是 `node service/src/server.mjs` —— 同一套断言、两个靶子。
//
// 为什么必须独立成 bin：Rust 服务在 app 进程内时，e2e **无从 spawn**（没有可执行文件给你起）；
// 而"两套实现跑同一套断言"正是 F 组唯一能证明契约等价的机制（见文档 §0）。
fn main() {
    // `--print-paths`：只打印路径快照后退出，**不起服务、不拉遗留后端**。
    // 用途：e2e 做「Rust 与 Node 路径同源」比对（R1 的钉子）—— 必须能在毫秒级跑完，
    // 所以它绝不允许走到 `run_blocking`（那会去绑端口、拉 node）。
    if std::env::args().any(|a| a == "--print-paths") {
        println!("{}", miao_dock::paths::snapshot());
        return;
    }
    // `--store-selftest`：在**固定输入**下打印 store 的纯函数 / serialize / 视图 / 计划 / 原子写产物。
    // 用途：e2e 做「Rust 与 Node 的 store 逐字节同源」比对（F3 的钉子）—— 同样不起服务。
    if std::env::args().any(|a| a == "--store-selftest") {
        println!("{}", miao_dock::boxsvc::store::selftest::report());
        return;
    }
    // `--engine-selftest`：在**固定输入**下打印引擎耦合点的纯函数 / 启动配方 / 参数快照 / 结果流解析。
    // 用途：e2e 做「Rust 与 Node 的 engine-client 同源」比对（F4 的钉子）—— 同样不起服务、不拉 node。
    if std::env::args().any(|a| a == "--engine-selftest") {
        println!("{}", miao_dock::boxsvc::engine::selftest::report());
        return;
    }
    let opts = miao_dock::boxsvc::Options::from_env();
    if let Err(e) = miao_dock::boxsvc::run_blocking(opts) {
        eprintln!("[box-service] boxsvc 启动失败：{e}");
        std::process::exit(1);
    }
}
