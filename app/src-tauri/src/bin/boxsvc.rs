// boxsvc —— 独立可运行的服务靶子（F0）
//
// 用途：给 e2e 一个**能被 spawn 的 Rust 服务**。`MIAO_SERVICE_IMPL=rust` 时，各验收脚本
// 起的是它而不是 `node service/src/server.mjs` —— 同一套断言、两个靶子。
//
// 为什么必须独立成 bin：Rust 服务在 app 进程内时，e2e **无从 spawn**（没有可执行文件给你起）；
// 而"两套实现跑同一套断言"正是 F 组唯一能证明契约等价的机制（见文档 §0）。
fn main() {
    // `--print-paths`：只打印路径快照后退出，**不起服务**。
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
    // `--store-exec-selftest`：跑 store 的**执行态**场景（建单/排队/单图处理/取消/重试/删除），
    // 打印 `{scenarios:[{...输入..., report:{...}}]}`。用途：e2e 做「Rust 与 Node 的 store 执行态
    // 同源」比对（F3-b 的钉子）—— 翻译走进程内脚本引擎，不起服务、不打网络。
    if std::env::args().any(|a| a == "--store-exec-selftest") {
        println!("{}", miao_dock::boxsvc::store::exec_selftest::report());
        return;
    }
    // `--engine-selftest`：在**固定输入**下打印引擎耦合点的纯函数 / 启动配方 / 参数快照 / 结果流解析。
    // 用途：e2e 做「Rust 与 Node 的 engine-client 同源」比对（F4 的钉子）—— 同样不起服务、不拉 node。
    if std::env::args().any(|a| a == "--engine-selftest") {
        println!("{}", miao_dock::boxsvc::engine::selftest::report());
        return;
    }
    // `--engine-http-selftest '<json>'`：跑一批「对拍用例」（translate/probe 打**伪引擎**服务器），
    // 打印 `{results:[...]}`。用途：e2e 做「Rust 与 Node 的 engine HTTP **运行期**同源」比对
    // （F4-b 的钉子）—— 同样不起服务、不拉 node 后端。
    if let Some(i) = std::env::args().position(|a| a == "--engine-http-selftest") {
        let arg = std::env::args().nth(i + 1).unwrap_or_default();
        println!("{}", miao_dock::boxsvc::engine::client::http_selftest(&arg));
        return;
    }
    // `--llm-selftest '<json>'`：驱动引擎③ supervisor **真起子进程**（对拍时喂 mock-llm），
    // 打印归一化的状态机/快照/停止结果 `{results:[...]}`。用途：e2e 做「Rust 与 Node 的
    // llm-supervisor 行为同源」比对（F4-b2 的钉子）—— 不起服务、不拉 node 后端。
    if let Some(i) = std::env::args().position(|a| a == "--llm-selftest") {
        let arg = std::env::args().nth(i + 1).unwrap_or_default();
        let spec: serde_json::Value = serde_json::from_str(&arg).unwrap_or(serde_json::json!({}));
        println!("{}", miao_dock::boxsvc::engine::supervisor::selftest_run(&spec));
        return;
    }
    // `--list-routes`：打印**显式路由表**（每条端点的 method/pattern/group/tier）+ 两个计数。
    // 用途：e2e 做「转发分支数 = 0」的验收（F5）—— 不起服务、不拉 node，毫秒级跑完。
    if std::env::args().any(|a| a == "--list-routes") {
        println!("{}", miao_dock::boxsvc::routes::report());
        return;
    }
    let opts = miao_dock::boxsvc::Options::from_env();
    if let Err(e) = miao_dock::boxsvc::run_blocking(opts) {
        eprintln!("[box-service] boxsvc 启动失败：{e}");
        std::process::exit(1);
    }
}
