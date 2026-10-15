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
    // `--engine-patches`：打印**上游源码补丁表镜像**（B5）后退出，不起服务。
    // 用途：`e2e/engine/engine-patches-check.mjs` 的 A7 拿它与 `setup-engine.mjs` 的
    // `ENGINE_PATCHES`（SSOT）做双靶交叉钉 —— 产品侧这份只读镜像若与 SSOT 漂移
    // （改了 id/mark/落点/描述而另一边没跟），检测就会与装配各说各话。
    if std::env::args().any(|a| a == "--engine-patches") {
        println!("{}", miao_dock::boxsvc::engine::patches::table_json());
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
    // `--check-runtime-gate [real|mock]`：打印 **D6 启动前预检闸门**的判定并退出，不起服务。
    // 用途：`e2e/service/launch-gate-check.mjs` 取证「real 档 + 运行时未装配 ⇒ 被拦且秒级」。
    // 被拦 ⇒ 退出码 1（= "这样起不来"）；放行 ⇒ 0。判据与服务侧 `start_blocking`
    // 调的是同一个 `gate_message()`，故这里绿即那里绿（反过来不成立 —— 那条路径
    // 还需要 `launch-gate-check` 的源码钉保证调用真的接上了，见该脚本 G5）。
    if let Some(i) = std::env::args().position(|a| a == "--check-runtime-gate") {
        let mode = std::env::args().nth(i + 1).unwrap_or_else(|| "real".to_string());
        let probe = miao_dock::boxsvc::engine::runtime_probe::probe();
        let msg = miao_dock::boxsvc::engine::runtime_probe::gate_message_for(&mode, &probe);
        let blocked = msg.is_some();
        let failing: Vec<&str> = probe.items.iter().filter(|i| !i.ok).map(|i| i.id).collect();
        println!(
            "{}",
            serde_json::json!({
                "mode": mode,
                "ready": probe.ready,
                "blocked": blocked,
                "failing": failing,
                "message": msg,
            })
        );
        std::process::exit(if blocked { 1 } else { 0 });
    }
    // `--engine-model-files`：打印**模型引导清单**（D8）后退出，不起服务。
    // 用途：`e2e/service/models-guide-check.mjs` 拿它逐条对拍 —— 每条的目标绝对路径、
    // 平台适用性、就绪判据都必须来自 `models.manifest.json` 本身（改清单一条 `dest`
    // ⇒ 这里跟着变，证明是**渲染**不是写死）。清单与模型根走 `paths` 的接缝
    // （`MIAO_MODEL_MANIFEST` / `MIAO_MODEL_ROOT`），故夹具可以整套搬到临时目录里跑。
    // 清单读不到 ⇒ 仍打印（`files: []` + 三个 false），退出码 0：那也是一种真实状态。
    if std::env::args().any(|a| a == "--engine-model-files") {
        let s = miao_dock::boxsvc::engine::model_status::model_status(
            &miao_dock::paths::model_manifest(),
            &miao_dock::paths::model_root(),
            None,
        );
        println!("{}", serde_json::to_string(&s).unwrap_or_else(|_| "{}".to_string()));
        return;
    }
    // `--engine-crf-plan`：打印 **pydensecrf 的 wheel 选路结论**（B4/G3）后退出，不起服务。
    // 用途：`e2e/engine/pydensecrf-wheel-check.mjs` 取证「命中且哈希对得上 ⇒ 走 wheel /
    // 哈希不符 ⇒ 拒绝并回退 / 文件不在盘 ⇒ 回退 / 只有别的平台条目 ⇒ 回退」这**四态**。
    // 🔴 为什么必须有一个真出口而不是读代码相信：选路逻辑一旦漂移（例如把「包内优先」
    //    写成「本机目录优先」），表现是目标机上静默退回源码编译、装到一半失败 ——
    //    而那台机器通常不是你面前这台。
    // 与 `--print-plan` 同口径：**只读**，非 Windows 下也能跑（macOS 用户同样要能问
    // 「有没有本平台的预编译 wheel」），不做任何平台闸门。
    if std::env::args().any(|a| a == "--engine-crf-plan") {
        let plan = miao_dock::boxsvc::engine::wheels::plan_crf(&miao_dock::paths::model_root());
        println!(
            "{}",
            serde_json::json!({
                "route": match plan.route {
                    miao_dock::boxsvc::engine::wheels::CrfRoute::Wheel => "wheel",
                    miao_dock::boxsvc::engine::wheels::CrfRoute::Source => "source",
                },
                "reason": plan.reason,
                "abs": plan.abs,
                "from": plan.from,
                "platform": plan.key,
                "pythonTag": plan.tag,
            })
        );
        return;
    }
    // `--translate-cases '<json>'`：把一组用例喂给翻译**门面**（text/stream/options/settings/
    // credentials/batch），打印 `{results:[...]}`。用途：`check:translate` 的运行时断言面 ——
    // Node 服务退役后，原先「进程内直调 Node 门面」改由这里驱动 Rust 门面（真发 HTTP 打 Node
    // 侧假上游）。同样不起服务、不绑端口。
    if let Some(i) = std::env::args().position(|a| a == "--translate-cases") {
        let arg = std::env::args().nth(i + 1).unwrap_or_default();
        println!("{}", miao_dock::boxsvc::translate::selftest::cases_report(&arg));
        return;
    }
    // `--translate-selftest`：打印翻译**纯逻辑**报告（统一码表 / 签名 input 截断 / 语言码表 /
    // 上游码映射 / 出网错误族归因 / 可重试判定）。用途：`check:translate` 的冻结 golden 金标
    // —— 这些面不经过路由（注册表是编译期常量、错误族由 reqwest 抛），只能从这里取证。
    if std::env::args().any(|a| a == "--translate-selftest") {
        println!("{}", miao_dock::boxsvc::translate::selftest::pure_report());
        return;
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
