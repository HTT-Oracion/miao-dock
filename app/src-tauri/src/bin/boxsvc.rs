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
    // `--check-assets`：打印**随包资产自检**报告并退出（A1/A2）。
    // 用途：e2e 在「模拟打包布局」下取证 —— 资源目录里没有必需资产时，这里必须**报缺失**
    // 而不是静默回退到仓库路径（那样 dev 态永远绿、打包态永远错）。
    // 缺失 ⇒ 退出码 1，且不打印任何"起服务"的迹象（它本来就不起服务）。
    if std::env::args().any(|a| a == "--check-assets") {
        let r = miao_dock::paths::assets_report();
        println!("{r}");
        let ok = r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
        if !ok {
            let missing = r.get("missing").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let names: Vec<String> = missing.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
            eprintln!("✗ [RESOURCE_MISSING] 资源缺失：{}", names.join("、"));
        }
        std::process::exit(if ok { 0 } else { 1 });
    }
    // `--list-routes`：打印**显式路由表**（每条端点的 method/pattern/group/tier）+ 两个计数。
    // 用途：e2e 做「转发分支数 = 0」的验收（F5）—— 不起服务、不拉 node，毫秒级跑完。
    if std::env::args().any(|a| a == "--list-routes") {
        println!("{}", miao_dock::boxsvc::routes::report());
        return;
    }
    // `--print-launch-plan [real|mock]`：打印**引擎栈启动配方**（A3b）。
    // 用途：`check:launch-plan` 断言这份 JSON 的形状（键名/探针/owner/watch/预算）——
    // 它曾是 `service/scripts/print-launch-plan.mjs` 的 Rust 化身；脚本退役后断言改钉这里。
    // 同样**不起服务**（不起 node、不绑端口），毫秒级跑完。
    if let Some(i) = std::env::args().position(|a| a == "--print-launch-plan") {
        let mode = std::env::args().nth(i + 1).unwrap_or_else(|| "real".to_string());
        match miao_dock::boxsvc::engine::build_launch_plan(&mode) {
            Ok(v) => println!("{v}"),
            Err(e) => {
                eprintln!("打印启动配方失败：{e}");
                std::process::exit(1);
            }
        }
        return;
    }
    // `--child-watch-parent <ms> -- <cmd>`：**测试夹具**，扮演父进程起看守器再硬退（A3c）。
    // 用途：`e2e/child-watch-check.mjs` 用它当"会死的父"——必须是 Rust 而不是 node，
    // 因为产品的父就是 Rust（`service.rs` 攥 `ChildStdin`），而 node 父在 Windows 上
    // 不给子进程可用的匿名管道 ⇒ 测出来的结论对产品不成立。详见 `run_as_parent` 的注释。
    if let Some(i) = std::env::args().position(|a| a == "--child-watch-parent") {
        let args: Vec<String> = std::env::args().skip(i + 1).collect();
        std::process::exit(miao_dock::child_watch::run_as_parent(&args));
    }
    // `--child-watch -- <cmd> [args...]`：把命令包一层**父死看守**（A3c）。
    // 用途：真档下 ② `python main.py` / ③ `llama-server` 是**外部二进制**，主进程被
    // SIGKILL 后它们不会自退（E11 要消灭的正是这种孤儿）。它曾是 `engine/scripts/child-watch.mjs`，
    // 而那需要 node 解释器 —— A3「node 随包」已作废 ⇒ 看守器一并 Rust 化。
    //
    // 🔴 为什么挂在 `boxsvc` 而不是新开一个 bin：看守器是**每引擎栈常驻**的子进程，
    //    多一个可执行文件就多一份随包物与一条寻址路径；`boxsvc` 本来就随包（F5 之后
    //    它是服务本体），且 `--print-launch-plan` 等子命令已经证明这条复用路子成立。
    //    代价是「看守器失败」与「服务失败」共用一个 exe —— 但两者不会同时发生
    //    （子命令在起服务之前就 `return` 了）。
    if let Some(i) = std::env::args().position(|a| a == "--child-watch") {
        let args: Vec<String> = std::env::args().skip(i + 1).collect();
        std::process::exit(miao_dock::child_watch::run(&args));
    }
    // `--fetch-models [...]`：S3 模型下载器 / 校验器（A3d）。
    // 用途：`POST /engine/models/verify` 与「重新下载模型」两个**产品运行期**路径都起它 ——
    // 它曾是 `node engine/scripts/fetch-models.mjs`，而 A3「node 随包」已作废。
    // 与 `--child-watch` 同一裁定：挂在 `boxsvc` 上，不新增可执行文件、不改 `bundle.resources`。
    if let Some(i) = std::env::args().position(|a| a == "--fetch-models") {
        let args: Vec<String> = std::env::args().skip(i + 1).collect();
        std::process::exit(miao_dock::boxsvc::engine::fetch_models::run(&args));
    }
    let opts = miao_dock::boxsvc::Options::from_env();
    if let Err(e) = miao_dock::boxsvc::run_blocking(opts) {
        eprintln!("[box-service] boxsvc 启动失败：{e}");
        std::process::exit(1);
    }
}
