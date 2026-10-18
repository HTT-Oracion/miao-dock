// mangasvc —— 服务运行时的 Rust 实现（F 组主线）
//
// ## 形态（F5：纯 Rust，不再有遗留后端）
// 本进程在 127.0.0.1:5180–5190 起一个 axum 服务，**保留 Node manga-service 的 HTTP 契约不变**
// （同一套路径、同一套错误信封、同一套鉴权）。F1 过渡期的「未迁移端点用 `reqwest` 转发给
// Node」已在 F5.8 **全部摘除**：`routes.rs` 里 44 条端点全部 `Tier::Migrated`，
// `routes::forwarded_count()` 恒为 0 ⇒ 本进程不再需要、也不再拉起 Node。
// ⇒ 前端与 e2e **都不换靶子**：换的只是「谁在监听这个端口」。
//
//   · 本模块自带：端口探测、就绪行、CORS/Origin 白名单、令牌校验（`ensure_token`）、
//     落盘根校验（`validate_root`）、错误信封、`/health`
//   · 端点：**全部**由 `handlers.rs` 本地应答 —— `routes.rs` 的显式表是唯一事实源
//
// 🔴 「摘除 Node」不是"删几个文件"那么主观的事，它有**可观测的判据**：`forwarded_count()`
//    归零，由 `check:routes` 的完成门盯着。少了这个数，「迁没迁完」永远只是一句话 ——
//    功能照常、e2e 全绿，而包里永久躺一份没人调的 Node 服务（计划文档 R3）。
//
// 仍然保留的那条 502 分支（`should_forward()`）：它只会因**反证钩子** `MIAO_ROUTE_REFUTE`
//    而为真。留着是为了让「声明已迁移、其实没实现」当场可观测（回 502），而不是静默本地应答。
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;

pub mod drain;
pub mod engine;
pub mod events;
pub mod handlers;
pub mod library;
pub mod multipart;
pub mod names;
pub mod routes;
pub mod sidecar;
pub mod store;
pub mod translate;

use engine::supervisor::{LlmSnapshot, LlmSupervisor};
use store::Store;

/// 服务名 / 版本 —— 与 `service/src/config.mjs` 的 `SERVICE_NAME` / `SERVICE_VERSION` 对齐
pub const SERVICE_NAME: &str = "manga-service";
pub const SERVICE_VERSION: &str = "1.2.0";
pub const API_VERSION: &str = "v1";

pub(crate) const PORT_RANGE_START: u16 = 5180;
pub(crate) const PORT_RANGE_END: u16 = 5190;

/// SSE 心跳间隔 —— 与 `service/src/manga/sse.mjs` 的 `HEARTBEAT_MS` 一致。
const HEARTBEAT_MS: u64 = 15_000;

/// 共享状态：令牌 + 任务库 + 引擎③。
#[derive(Clone)]
pub struct Shell {
    token: Option<String>,
    root_dir: String,
    /// 任务库（**F5.8 起是**全进程唯一那份 —— 不再有遗留后端持有第二份）。
    pub store: Arc<Mutex<Store>>,
    /// 引擎③ 的生命周期持有者。
    llm: Option<Arc<LlmSupervisor>>,
    /// 引擎组的服务级状态（设置 / 硬件 / 档位降档 / 模型下载）—— F5.6。
    pub engine: Arc<engine::state::EngineState>,
    /// 空闲看护（《04》§9.1 Tier1）。**可重建**：设置页改「空闲卸载 LLM」要立刻生效，
    /// 而 `idle_ms` 是构造参数 ⇒ 停掉旧的、起一个新的（`restart_idle_watcher`）。
    idle: Arc<Mutex<Option<engine::idle_policy::IdleWatcher>>>,
    /// 队列驱动器（`drain` 跑在独立线程上 —— 见 `drain.rs`）。
    drain: drain::DrainHandle,
}

impl Shell {
    /// ③ 的机器可读快照；未构造 supervisor 时给 Node 同形的 `stopped`。
    pub fn llm_snapshot(&self) -> LlmSnapshot {
        self.llm.as_ref().map(|l| l.snapshot()).unwrap_or_else(LlmSnapshot::stopped)
    }

    /// ③ 的 supervisor（`unload` / 降档 / 空闲卸载都要它）。
    pub fn llm_supervisor(&self) -> Option<Arc<LlmSupervisor>> {
        self.llm.clone()
    }

    /// 队列有新活 ⇒ 叫醒 `drain` 线程。
    pub fn notify_drain(&self) {
        self.drain.notify();
    }

    /// 落盘根目录（已规范化）—— 取自已初始化的 `Store`（与 `assertInsideRoot` 同一份事实源）。
    pub fn store_root(&self) -> PathBuf {
        lock_store(&self.store).root.clone()
    }
}

/// 重建空闲看护（`restartIdleWatcher`）。
///
/// 🔴 S6 起它必须是**可重建的**：设置页改「空闲卸载 LLM」要立刻生效，而 `idle_ms` 是构造参数。
///    写成"起一次就不管"就只剩"重启服务"一条路 —— 那会让一个纯策略数字需要一次几十秒的
///    引擎冷启动，用户看到的是"改了没反应"。
///    重建而不是"加一个可变引用"：看护内部没有任何持有旧阈值的异步任务（`tick()` 是纯同步判定），
///    所以停掉旧的、起一个新的，**不存在**两个看护同时在跑或"旧阈值还在途"的窗口。
pub fn restart_idle_watcher(shell: &Shell) {
    let es = &shell.engine;
    let mut slot = match shell.idle.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    *slot = None; // Drop 会 stop + join 旧看护
    let never_unload = es.saved_idle().settings.get("idleLlmMin").and_then(|v| v.as_i64()) == Some(0) || es.unload_never;
    if never_unload || es.no_idle_unload {
        println!(
            "[manga-service] 空闲卸载：{}",
            if never_unload { "用户选择「从不卸载」（两级都关）" } else { "被 MIAO_NO_IDLE_UNLOAD=1 关掉（反证用）" }
        );
        return;
    }
    let cfg = engine::idle_policy::IdleCfg {
        idle_ms: es.saved_idle().llm_ms,
        interval_ms: es.idle_tick_ms,
        never_unload: false,
        disabled: false,
        activity_scope: es.idle_activity_scope.clone(),
    };
    println!(
        "[manga-service] 空闲卸载：LLM 空闲 {} min 后释放（Tier1）／视觉 {} min（Tier2，由引擎 --models-ttl={}s 执行）",
        (cfg.idle_ms as f64 / 60_000.0).round() as i64,
        (es.saved_idle().vision_sec as f64 / 60.0).round() as i64,
        es.engine_models_ttl
    );
    let store = shell.store.clone();
    let llm = shell.llm.clone();
    let watcher = engine::idle_policy::start_idle_watcher(cfg, store, move || {
        if let Some(l) = &llm {
            l.stop("空闲卸载", 8000);
        }
    });
    *slot = Some(watcher);
}

/// 取 store 锁（**容忍中毒**）：store 的每次状态变更都由代码自己收尾，中毒后继续用比把服务
/// 变成"一切 500"更接近 Node 的行为。
pub fn lock_store<'a>(store: &'a Arc<Mutex<Store>>) -> MutexGuard<'a, Store> {
    match store.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

/// 启动参数（环境变量驱动；独立 bin 与 Tauri 内嵌都走它）
pub struct Options {
    /// 显式端口（`MIAO_PORT`）；`None` 时在 5180–5190 探测
    pub explicit_port: Option<u16>,
}

impl Options {
    pub fn from_env() -> Self {
        let explicit_port = std::env::var("MIAO_PORT")
            .ok()
            .filter(|s| !s.is_empty())
            .and_then(|s| s.parse::<u16>().ok());
        Options { explicit_port }
    }
}

/// 取服务令牌：`MIAO_TOKEN` 优先；否则 `state/token`（在盘的 64 位 hex 直接复用并把权限
/// 校正回 0600；没有或不合规就 32 字节 CSPRNG 生成后落盘）。逐条复刻 `config.mjs` 的
/// `ensureToken()`。
///
/// 🔴 这条路径在 F5.8 之前是**备用**的（遗留后端在场时它自己会 `ensureToken()` 并把令牌
///    从就绪行交过来），摘除 Node 之后它是**唯一**来源。少了它，服务会以**空令牌**启动
///    —— 而且**完全静默**：`MIAO_READY` 照常打印（`token` 是空串）、监听照常成功，
///    只有每一个带令牌的请求变成 403。实测症状是 `check:retry` / `check:lib-manage`
///    在 rust 靶子上全挂，而报告只说"拿不到 taskId"。
fn ensure_token() -> Option<String> {
    if let Ok(v) = std::env::var("MIAO_TOKEN") {
        if !v.is_empty() {
            return Some(v);
        }
    }
    let file = crate::platform::paths::token_file();
    if let Ok(raw) = std::fs::read_to_string(&file) {
        let t = raw.trim();
        if t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit()) {
            chmod_private(&file); // 权限可能被外部改过：每次启动校正回 0600
            return Some(t.to_string());
        }
    }
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    let token = hex::encode(bytes);
    // 写不下去也不能"静默无令牌"：如实报错比给一个每个请求都被拒的服务强。
    if let Err(e) = write_private(&file, &token) {
        eprintln!(
            "[manga-service] ⚠ 令牌落盘失败（{}）：本次运行改用内存令牌，重启后会变",
            e
        );
    }
    Some(token)
}

/// 以 0600 落盘（POSIX）。Windows 没有 POSIX 权限位 ⇒ 与 Node `mode: 0o600` 一样被忽略。
fn write_private(file: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(file)?;
    f.write_all(text.as_bytes())
}

fn chmod_private(file: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = file;
    }
}

/// 落盘根目录校验（契约 §8.2 校验点 1）—— 逐条复刻 `config.mjs` 的
/// `BLACKLIST_EXACT` / `BLACKLIST_PREFIX` / `blacklistHit` / `validateRoot`。
///
/// 🔴 两种匹配语义**不能合并成一条 prefix 判据**：
///   · **EXACT**——只拒「目录本身」。这些是**容器目录**：其下仍可能是合法落盘位置
///     （`C:\Users` 之下是各用户目录、macOS 的 `/private/var` 之下是 TMPDIR）。
///     按前缀拒会把合法的 `C:\Users\<me>\Pictures\Box 漫画` 一并挡掉。
///   · **PREFIX**——连子路径一并拒。这些才是真正的系统目录。
/// 🔴 Windows 的系统目录**必须单列**：原来那份 Unix 名单在 Windows 上**一条都命中不了**，
///    等于这道校验在 Windows 下形同虚设 —— 用户可以把落盘根指到 `C:\Windows`。
///
/// 顺带把「启动即建目录」也放在这里（Node `validateRoot` 末尾的 `mkdirSync(recursive, 0700)`）：
/// 校验与建目录是同一件事的两半，分开放会出现「校验过了但目录没建」的中间态。
pub fn validate_root(root: &str) -> Result<PathBuf, String> {
    // ⚠️ **不**用 `Path::is_absolute()` 做前置判据：Windows 上 `/tmp` 只有根、没有盘符，
    //    Rust 判它「不是绝对路径」而 Node 的 `path.isAbsolute('/tmp')` 判**是**
    //    —— 两边会在同一个输入上给出不同的失败理由（Node 走到黑名单，Rust 走到这里）。
    //    空串按 Node 的口径报「必须是绝对路径」；其余一律交给 `resolve_abs`（等价 `path.resolve`）。
    if root.trim().is_empty() {
        return Err(format!("落盘根目录必须是绝对路径：{root}"));
    }
    let abs = crate::platform::paths::resolve_abs(Path::new(root));
    let canon = crate::platform::paths::canonicalize(&abs);
    if let Some(hit) = blacklist_hit(&canon) {
        return Err(format!("落盘根目录不合法（命中黑名单 {hit}）：{}", abs.display()));
    }
    std::fs::create_dir_all(&abs)
        .map_err(|e| format!("落盘根目录不可用（{}）：{e}", abs.display()))?;
    Ok(crate::platform::paths::canonicalize(&abs))
}

/// 命中返回**名单里那一条原文**（不是规范化后的路径）—— 报给用户的是"撞上了哪一条规则"，
/// 打印一个 `\\?\C:\...` 对他没有任何帮助。
fn blacklist_hit(canon: &Path) -> Option<String> {
    let s = canon.to_string_lossy().into_owned();
    for raw in blacklist_exact() {
        if s == crate::platform::paths::canonicalize(Path::new(&raw)).to_string_lossy() {
            return Some(raw);
        }
    }
    for raw in blacklist_prefix() {
        let cb = crate::platform::paths::canonicalize(Path::new(&raw)).to_string_lossy().into_owned();
        // 与 Node 逐字同构：`canonicalAbs === cb || canonicalAbs.startsWith(cb + sep)`。
        // 🔴 用 `startsWith(cb + sep)` 而**不是** `Path::strip_prefix`：后者按**组件**比，
        //    会把 `C:\` 当成 `C:\Windows` 的前缀而命中；Node 那边 `'C:\\' + '\\'` 永不前缀命中，
        //    根路径只走 EXACT。两者在这一个输入上会分叉。
        let with_sep = format!("{cb}{}", std::path::MAIN_SEPARATOR);
        if s == cb || s.starts_with(&with_sep) {
            return Some(raw);
        }
    }
    None
}

fn blacklist_exact() -> Vec<String> {
    let home = dirs::home_dir().unwrap_or_default();
    let home_s = home.to_string_lossy().into_owned();
    let mut list = vec![
        // `path.parse(path.resolve('/')).root` —— Windows 下即当前盘的 `C:\`
        crate::platform::paths::resolve_abs(Path::new("/")).to_string_lossy().into_owned(),
        "/Users".to_string(),
        home_s.clone(),
        "/private".to_string(),
        "/private/var".to_string(),
        "/var".to_string(),
    ];
    if cfg!(windows) {
        // Windows：home 的父目录（`C:\Users`）本身不可作落盘根 —— 与 macOS 的 `/Users` 同义。
        if let Some(parent) = home.parent() {
            let ps = parent.to_string_lossy().into_owned();
            if !ps.is_empty() && ps != home_s {
                list.push(ps);
            }
        }
    }
    list
}

fn blacklist_prefix() -> Vec<String> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut list = vec![
        "/tmp".to_string(),
        "/private/tmp".to_string(),
        "/private/var/tmp".to_string(),
        "/private/etc".to_string(),
        "/etc".to_string(),
        "/usr".to_string(),
        "/System".to_string(),
        "/Library".to_string(),
        "/Applications".to_string(),
        "/Volumes".to_string(),
        "/cores".to_string(),
        "/opt".to_string(),
        home.join("Library").to_string_lossy().into_owned(),
    ];
    if cfg!(windows) {
        let sys_root = std::env::var("SystemDrive").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "C:".to_string());
        let sys_root = format!("{sys_root}\\");
        let join = |base: &str, leaf: &str| {
            Path::new(base).join(leaf).to_string_lossy().into_owned()
        };
        list.push(join(&sys_root, "Windows"));
        list.push(std::env::var("ProgramFiles").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| join(&sys_root, "Program Files")));
        list.push(std::env::var("ProgramFiles(x86)").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| join(&sys_root, "Program Files (x86)")));
        list.push(std::env::var("ProgramData").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| join(&sys_root, "ProgramData")));
    }
    list
}

/// 以 **阻塞** 方式跑起来（供独立 `mangasvc` bin；Tauri 侧可另起线程调用）。
///
/// 返回 `Ok(())` 表示服务已正常关闭。
pub fn run_blocking(opts: Options) -> Result<(), String> {
    // 0) tokio 运行时**先**建：`Shell` 要持有它的 `Handle`（`drain` 线程靠它 block_on 引擎调用），
    //    心跳任务也要挂在它上面。
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("无法创建 tokio 运行时：{e}"))?;

    // 1) 令牌 + 落盘根 —— F5.8 摘除 Node 之后**没有遗留后端**可继承这两样，本进程自造
    //    （`ensureToken()` / `config.rootDir` 的对应物，同一份 `state/` 与同一份 env 事实源）。
    let token = ensure_token();
    let root_dir = crate::platform::paths::root_dir().to_string_lossy().into_owned();
    // 契约 §8.2 校验点 1：根目录不撞黑名单；顺带"启动即建目录"。
    // 🔴 取**校验后的规范化结果**作为后续一切路径拼接的基准（Node 的 `config.rootDir` 亦然）：
    //    否则 `MIAO_ROOT=C:/x/y` 这类写法会让"上报的根"与"实际落盘的根"是两个字符串。
    let root_dir = validate_root(&root_dir)?.to_string_lossy().into_owned();

    // 2) 任务库 + 启动恢复（`init()`：读幂等表 / 隐藏清单 / 恢复任务清单，非终态一律收尾）。
    let store = Arc::new(Mutex::new(Store::new(Path::new(&root_dir))));
    let init_report = lock_store(&store).init();
    println!(
        "[manga-service] store 就绪：恢复 {} 条任务（其中 {} 条非终态已收尾为 failed）、清扫 {} 个空暂存目录",
        init_report.restored, init_report.aborted, init_report.swept
    );

    // 3) 引擎组状态（F5.6）：硬件画像 ⊕ 用户设置 ⊕ env —— **取值非法直接失败**（不静默回退）。
    let engine = Arc::new(engine::state::EngineState::from_env()?);

    // 3a) real 档下把「引擎运行时未就绪」逐项喊出来（B1 验收② / B2）。
    //     没有它，用户看到的是白等 240 s 后一句 Connection error —— 不告诉他缺什么、怎么装。
    engine::runtime_probe::warn_unready_if_real(engine::is_mock_protocol());

    // 3b) 引擎③ supervisor：配方按**生效档位**给（配置的档位若没权重会被夹回可用档）。
    //     ⚠️ 与 Node 同：`③ 的归属方是 manga-service`（《04》§9.1），所以它由**本进程**拉起。
    let llm = Arc::new(LlmSupervisor::with_launch_verbose(
        engine::resolve_llm_launch(&engine::LlmLaunchOverrides {
            tier: Some(engine.effective_tier.clone()),
            ..Default::default()
        })
        .map_err(|e| format!("③ LLM 配方解析失败：{}", e.message))?,
        !engine::is_mock_protocol(),
        true,
    ));

    // 4) 队列驱动线程（独立线程跑 `drain` ⇒ `POST /tasks` 立即返回）+ 引擎③ 的懒加载/降档注入。
    let drain = drain::spawn(
        store.clone(),
        rt.handle().clone(),
        engine::client::EngineCfg::from_env(),
        Some(llm.clone()),
        engine.tier_ctl.clone(),
    );

    let shell = Arc::new(Shell {
        token,
        root_dir,
        store,
        llm: Some(llm.clone()),
        engine: engine.clone(),
        idle: Arc::new(Mutex::new(None)),
        drain,
    });

    // 4b) 空闲看护（《04》§9.1 Tier1）：③ 空闲达阈值 ⇒ 释放。
    restart_idle_watcher(&shell);

    // 4c) 预拉起 ③（《04》§9.1 的 Tier1 归属 + E11 的外部观察者要等它起来）。
    //     ⚠️ **不 await**：真档下 llama-server 要读几 GB 权重，等它就绪会把服务的就绪行推迟到
    //     分钟级 —— 而 Rust 侧等这行是有超时的（会把"服务起不来"报成真正的启动失败）。
    //     ③ 晚到不要紧：它在**翻译那一刻**才被用到，而那条路有懒加载兜底。
    //     P-D4：翻译来源 = 在线 ⇒ 引擎不随开机拉起（在线链路完全不需要 ③ 那份显存）。
    let translate_source = engine::state::translate_source();
    if engine.llm_autostart && translate_source != "online" {
        let l = llm.clone();
        std::thread::spawn(move || {
            let snap = l.start(180_000);
            if snap.state != "running" {
                println!("[manga-service] ③ LLM 启动失败（不阻断服务）：state={}", snap.state);
            }
        });
    }

    // 5) SSE 心跳（契约 §5.5：15s 一条，只发给有订阅者的任务）
    spawn_heartbeat(&rt, shell.clone());

    // 6) 绑定端口（显式优先，否则在段内探测 —— 与 Node 版 `listenWithProbe` 同语义）
    let (port, listener) = bind_with_probe(opts.explicit_port)?;

    // 7) 打印**本进程**的就绪行（e2e / Rust ServiceManager 都据此拿端口与令牌）
    let ready = serde_json::json!({
        "port": port,
        "token": shell.token.clone().unwrap_or_default(),
        "rootDir": shell.root_dir,
    });
    println!("[manga-service] MIAO_READY {ready}");
    // 🔴 只报监听地址 —— 曾经的「（纯 Rust：N 条端点本地实现，未迁移 N 条）」是给迁移期看的
    //    内部统计，经 stdout → 服务日志 → 前端日志区，会原样漏给用户（且迁移早已收口）。
    println!("[manga-service] mangasvc 监听 127.0.0.1:{port}");

    // 8) 跑 axum（阻塞）
    let app = router(shell);
    rt.block_on(async move {
        let std_listener = listener;
        std_listener
            .set_nonblocking(true)
            .map_err(|e| format!("set_nonblocking 失败：{e}"))?;
        let l = tokio::net::TcpListener::from_std(std_listener)
            .map_err(|e| format!("转 tokio listener 失败：{e}"))?;
        let server = axum::serve(l, app).with_graceful_shutdown(shutdown_signal());
        server.await.map_err(|e| format!("axum 服务退出异常：{e}"))
    })?;
    Ok(())
}

/// SSE 心跳：每 `HEARTBEAT_MS` 给**有订阅者**的任务推一条 `heartbeat`。
///
/// 🔴 心跳**不进** `task.events`：它只是"连接还活着"的信号（契约 §5.5）。进日志会把 2 万条
///    上限撑爆，并把 Last-Event-ID 的可见窗口挤没。id 仍取全局 `eventSeq`（保证单调）。
fn spawn_heartbeat(rt: &tokio::runtime::Runtime, shell: Arc<Shell>) {
    rt.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(HEARTBEAT_MS));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await; // 首个 tick 立即返回 —— 吃掉它（否则一启动就发）
        loop {
            tick.tick().await;
            for id in events::active_channels() {
                let seq = lock_store(&shell.store).bump_event_seq();
                events::publish(
                    &id,
                    (seq, "heartbeat".to_string(), serde_json::json!({ "ts": store::model::now_iso() })),
                );
            }
        }
    });
}

/// 显式端口优先；否则在 5180–5190 内「先探测再绑定」。
/// 🔴 段内全被占 ⇒ **明确失败**，不静默换到段外（与 Node 版同）。
fn bind_with_probe(explicit: Option<u16>) -> Result<(u16, TcpListener), String> {
    let candidates: Vec<u16> = match explicit {
        Some(p) => vec![p],
        None => (PORT_RANGE_START..=PORT_RANGE_END).collect(),
    };
    let mut last = String::new();
    for port in candidates {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => return Ok((port, l)),
            Err(e) => {
                last = format!("{port}: {e}");
                continue;
            }
        }
    }
    let range = match explicit {
        Some(p) => format!("{p}（MIAO_PORT 指定）"),
        None => format!("{PORT_RANGE_START}–{PORT_RANGE_END}"),
    };
    Err(format!("端口 {range} 全部被占用，mangasvc 启动失败（不静默换到段外）。最后错误：{last}"))
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut s) = signal(SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
}

fn router(shell: Arc<Shell>) -> Router {
    Router::new().fallback(handler).with_state(shell)
}

/// 全部请求的入口。**所有**出口都经此附加 CORS（与 Node `sendJson(res, …, cors)` 同：
/// 成功体、错误体、SSE 响应头都带那套 CORS；只有"Origin 被拒"时不带 allow-origin）。
async fn handler(
    State(shell): State<Arc<Shell>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let allow = origin_allow(headers.get("origin").and_then(|v| v.to_str().ok()));
    let mut resp = dispatch_request(shell, method, uri, headers, body).await;
    apply_cors(resp.headers_mut(), allow.as_deref());
    resp
}

async fn dispatch_request(
    shell: Arc<Shell>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    // 1) Origin 白名单（含 Origin 才校验）—— 契约 §2.1
    if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) {
        if !origin_allowed(origin) {
            eprintln!("[manga-service][security] Origin 拒绝：{origin}；{method} {uri}");
            return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "鉴权失败或来源不被允许", serde_json::json!({}));
        }
    }
    // 2) CORS 预检
    if method == Method::OPTIONS {
        return StatusCode::NO_CONTENT.into_response();
    }

    let path = uri.path();

    // 3) 鉴权（/health 豁免）—— 契约 §2.1
    //    🔴 反证开关 `MIAO_ENGINE_STATUS_OPEN=1`：让 `/engine/status` 免鉴权，用来证明
    //    「§5.2 不是免鉴权例外」这条断言咬的确实是鉴权本身（`S5.6` 应红）。
    //    🔴 反证开关 `MIAO_TOKEN_ALWAYS_OK=1`：令牌校验恒通过，用来证明 `E10.7`
    //       「无令牌 → 403」咬的是鉴权本身（应红），而不是路由恰好不存在。
    let is_health = path == "/health" || path == format!("/api/{API_VERSION}/health");
    let status_open = path == format!("/api/{API_VERSION}/engine/status")
        && shell.engine.contract_refutes.engine_status_open;
    if !is_health && !status_open && !shell.engine.contract_refutes.token_always_ok {
        let provided = headers.get("x-box-token").and_then(|v| v.to_str().ok());
        if !token_matches(shell.token.as_deref(), provided) {
            eprintln!("[manga-service][security] 令牌校验失败：{method} {uri}");
            return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "鉴权失败或来源不被允许", serde_json::json!({}));
        }
    }

    // 4) 路由表查找（F5）：**显式白名单**，不再 catch-all。
    //    查不到 ⇒ 与 Node 的 `miss()` 同一信封（404 TASK_NOT_FOUND）—— 于是「表漏了一条」
    //    当场可观测，而不是被 catch-all 静默转发掉（那正是 R3 要防的"漏摘转发分支"）。
    let segs = routes::split_path(path);
    let Some(m) = routes::match_route(method.as_str(), &segs) else {
        return envelope(
            StatusCode::NOT_FOUND,
            "TASK_NOT_FOUND",
            &format!("未知端点：{method} {path}"),
            serde_json::json!({ "path": path }),
        );
    };

    // 5) 端点 → 本进程处理。F5.8 摘除 Node 后这里**恒**为真（全表 `Migrated`）。
    if !routes::should_forward(m.def) {
        return handlers::dispatch(shell, m, uri, headers, body).await;
    }

    // 6) 「声明应转发」只剩一条来路：反证钩子 `MIAO_ROUTE_REFUTE` 把某条端点拉回转发态。
    //    🔴 F5.8 已无遗留后端可转 ⇒ 直接 502。这条分支**必须留着**：它是 F1 反证红线的
    //    延续 —— 证明"转发分支"是真的存在且真的会挡请求，而不是 Rust 悄悄自己实现了。
    envelope(
        StatusCode::BAD_GATEWAY,
        "INTERNAL",
        "该端点被判定为「尚未迁移」，但 F5.8 已摘除遗留后端，无处可转",
        serde_json::json!({ "path": path, "route": m.def.id }),
    )
}

/// Origin 白名单：`chrome-extension://*` 或字面量 `null`（Box 桌面端）。
fn origin_allowed(origin: &str) -> bool {
    let o = origin.trim();
    if o.is_empty() || o == "null" {
        return true;
    }
    if let Some(rest) = o.strip_prefix("chrome-extension://") {
        return !rest.is_empty()
            && rest.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    }
    false
}

/// 请求该回显的 `Access-Control-Allow-Origin` 值。
///
/// 三种情况都是 `None`（**不带**该头）：无 Origin / Origin 为空 / Origin 被拒。
/// 🔴 "被拒也回显"是个真实的口子：浏览器只认自己发出的 Origin，回显它等于把白名单让给攻击者。
fn origin_allow(origin: Option<&str>) -> Option<String> {
    let o = origin?.trim();
    if o.is_empty() || !origin_allowed(o) {
        return None;
    }
    Some(o.to_string())
}

/// Node `corsHeaders(allow)` 的四个固定头 + 条件性的 allow-origin。
pub fn apply_cors(h: &mut HeaderMap, allow: Option<&str>) {
    h.insert("vary", axum::http::HeaderValue::from_static("Origin"));
    h.insert(
        "access-control-allow-headers",
        axum::http::HeaderValue::from_static("X-Box-Token, X-Box-Client"),
    );
    h.insert(
        "access-control-allow-methods",
        axum::http::HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    h.insert("access-control-max-age", axum::http::HeaderValue::from_static("600"));
    // 绝不返回 `*`
    if let Some(v) = allow {
        if let Ok(val) = axum::http::HeaderValue::from_bytes(v.as_bytes()) {
            h.insert("access-control-allow-origin", val);
        }
    }
}

/// 定长比较（避免时序侧信道）—— 与 Node 版 `timingSafeEqual` 同语义。
fn token_matches(expected: Option<&str>, provided: Option<&str>) -> bool {
    let (Some(exp), Some(prov)) = (expected, provided) else {
        return false;
    };
    if prov.is_empty() || exp.len() != prov.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in exp.bytes().zip(prov.bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn envelope(status: StatusCode, code: &str, message: &str, details: serde_json::Value) -> Response {
    let body = serde_json::json!({ "error": { "code": code, "message": message, "details": details } });
    let mut resp = (status, axum::Json(body)).into_response();
    resp.headers_mut().insert(
        "content-type",
        axum::http::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    resp
}

/// 已迁移端点的公共工具 —— 供 `handlers.rs` 复用（错误信封 / JSON 体 / 文件流）。
pub mod http {
    use super::*;

    /// `serde_json::Value` 化（视图结构体 ⇒ 响应体）。
    pub fn to_value<T: serde::Serialize>(v: &T) -> serde_json::Value {
        serde_json::to_value(v).unwrap_or(serde_json::Value::Null)
    }

    /// Node `sendJson(res, status, body, cors)` 的对应物。
    pub fn json_body(status: u16, body: &serde_json::Value) -> Response {
        let st = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let mut resp = (st, axum::Json(body.clone())).into_response();
        resp.headers_mut().insert(
            "content-type",
            axum::http::HeaderValue::from_static("application/json; charset=utf-8"),
        );
        resp
    }

    /// `StoreError` → 契约 §2.2 的错误信封（`errors.mjs::errorEnvelope` 的对应物）。
    pub fn store_err(e: &store::StoreError) -> Response {
        let body = serde_json::json!({
            "error": { "code": e.code, "message": e.message, "details": e.details }
        });
        json_body(e.status(), &body)
    }

    /// Node `sendImageBytes` / 封面读端点的对应物：先做**打开前**的越界复校验（防 TOCTOU），
    /// 再回 `inline` 附件。
    pub fn image_response(root: &Path, file: &Path, name: &str, disposition: bool) -> Response {
        if crate::platform::paths::assert_inside_root(root, file).is_err() {
            eprintln!("[manga-service][security] 文件读取越界：{}", file.display());
            return store_err(&store::StoreError::new(
                "PERMISSION_DENIED",
                "鉴权失败或来源不被允许",
                serde_json::json!({}),
            ));
        }
        let bytes = match std::fs::read(file) {
            Ok(b) => b,
            Err(e) => {
                return store_err(&store::StoreError::new(
                    "TASK_NOT_FOUND",
                    "漫画库中找不到该文件",
                    serde_json::json!({ "file": file.to_string_lossy(), "reason": e.to_string() }),
                ))
            }
        };
        let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            _ => "application/octet-stream",
        };
        let mut resp = Response::new(Body::from(bytes));
        let h = resp.headers_mut();
        h.insert("content-type", axum::http::HeaderValue::from_static(mime));
        if disposition {
            if let Ok(v) = axum::http::HeaderValue::from_bytes(format!("inline; filename=\"{name}\"").as_bytes()) {
                h.insert("content-disposition", v);
            }
        }
        h.insert("cache-control", axum::http::HeaderValue::from_static("no-store"));
        resp
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_allow_matrix() {
        assert_eq!(origin_allow(None), None);
        assert_eq!(origin_allow(Some("")), None);
        assert_eq!(origin_allow(Some("null")), Some("null".to_string()));
        assert_eq!(origin_allow(Some(" chrome-extension://abc ")), Some("chrome-extension://abc".to_string()));
        // 被拒的 Origin **不回显**（回显等于把白名单让给攻击者）
        assert_eq!(origin_allow(Some("https://evil.example")), None);
        assert_eq!(origin_allow(Some("chrome-extension://a/b")), None);
    }

    #[test]
    fn token_compare_is_length_safe() {
        assert!(token_matches(Some("abc"), Some("abc")));
        assert!(!token_matches(Some("abc"), Some("abd")));
        assert!(!token_matches(Some("abc"), Some("abcd")));
        assert!(!token_matches(None, Some("abc")));
        assert!(!token_matches(Some("abc"), None));
    }
}
