//! ServiceManager —— box-service 与 sidecar 引擎栈的**三进程**生命周期管理
//!
//! 契约依据：
//!   · 《02》§2.1「**服务生命周期 = Box 进程的生命周期，与窗口可见性解耦**」
//!   · 《04》§2 三层进程 / §14.2 E1（可拉起 + 日志打印生效参数快照）、E11（三进程树回收）
//!
//! ## 进程形状（比"服务 + 引擎"深一层）
//! ```text
//!   miao-dock(Rust)
//!     ├── ① box-service        node service/src/server.mjs        （动态端口 5180–5190）
//!     ├── ② 引擎               node engine/src/server.mjs(替身)    或 python main.py(真)
//!     │     └── （真）执行器   python -m manga_translator          （port+1）
//!     └── ③ LLM                node engine/src/mock-llm.mjs(替身)  或 llama-server(真)
//! ```
//! ⚠️ **② 与 ③ 是"按进程类型分派 spawn"的落点**：Node 可执行 / Python 可执行 / llama-server 三种形态
//! 都要能起 —— 这是 S2 相对 ver1.0「两子进程」的实质增量，也是 E11 之所以按"三进程树"写的原因。
//!
//! ## 三处刻意的设计
//! 1. **就绪 = 三重判定**（进程存活 + 端口监听 + HTTP 应答），**不是**"读 stdout 就绪行"。
//!    stdout 那行仍然要读，但它只是**数据通道**（服务端口是动态的、令牌只在那行里），
//!    它**不构成就绪判据** —— 否则「日志打出来了、其实还没能干活」会被当成 running。
//!    探针列表由**本进程内**的启动配方给出（A3b 起不再问 JS：`boxsvc::engine::resolve_engine_launch`
//!    与 `resolve_llm_launch_for` 是唯一来源，见 `load_plan`）。
//! 2. **五态机** `stopped → starting(L1/L2/L3) → running → stopping → stopped`。
//!    L1 环境就绪（三进程都起得来）/ L2 模型就绪（各端口在听）/ L3 预热（HTTP 真应答）。
//!    `L4 首图惰性初始化` **不在这里**：它发生在首次翻译请求时、由引擎侧表达，
//!    Box 侧不新增客户端状态机节点（《03》§4.5）。见 docs/spec-notes.md D-64。
//! 3. **跨端进程树回收**：unix 把每个子进程放进**自己的进程组**，退出时对组发
//!    SIGTERM→（超时）SIGKILL，连带清掉孙进程（真引擎的执行器就是这么漏出来的）；
//!    Windows 走 `taskkill /T /F`。⚠️ Windows 分支**本机无法验证**，标 `unverified`（G2 ④）。
use std::collections::{BTreeMap, VecDeque};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// 状态变化事件名（前端订阅）
pub const STATE_EVENT: &str = "miao://service-state";
const LOG_CAPACITY: usize = 400;
/// 单个探针的默认预算（可被配方覆盖）。**与单张翻译超时无关**，别混。
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// 服务就绪行预算（动态端口 + 令牌都在那行里）
const SERVICE_READY_TIMEOUT: Duration = Duration::from_secs(30);
/// 停止时先礼后兵：SIGTERM 之后等这么久，没走就 SIGKILL
const STOP_GRACE: Duration = Duration::from_secs(3);
/// 收尸（`try_wait` 确认退出）的上界。见 `reap()` 第 ④ 段：**这里必须有上界**。
const REAP_GRACE: Duration = Duration::from_secs(2);

// ------------------------------------------------------------------ 对外视图

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceState {
    Stopped,
    Starting,
    Running,
    /// 正在回收子进程树（S2 新增；前端可据此显示"正在停止"）
    Stopping,
    Error,
}

#[derive(Clone, Serialize)]
pub struct ChildView {
    /// `service` / `engine` / `llm`
    pub name: String,
    pub pid: Option<u32>,
    pub alive: bool,
}

#[derive(Clone, Serialize)]
pub struct StatusView {
    pub state: ServiceState,
    /// box-service 实际监听端口（5180–5190 内探测得出）
    pub port: Option<u16>,
    /// 配对令牌；由 Rust 持有并下发给 UI（WebView 不直连服务）
    pub token: Option<String>,
    pub root_dir: Option<String>,
    /// ② 引擎的实际端口
    pub sidecar_port: Option<u16>,
    /// ③ LLM 的实际端口（S2 新增）
    pub llm_port: Option<u16>,
    /// `real` | `mock` —— **必须显式暴露**：否则"以为在跑真引擎、其实跑的替身"最难查
    pub mode: String,
    /// `L1` / `L2` / `L3`；不在启动期时为 None
    pub phase: Option<String>,
    /// ② 或 ③ 挂了但 ① 还在 ⇒ degraded（任务会失败，但服务本身仍可应答，见崩溃分级）
    pub degraded: bool,
    pub children: Vec<ChildView>,
    /// 状态机实际走过的轨迹（自检断言用；正常是 starting→L1→L2→L3→running）
    pub transitions: Vec<String>,
    pub log: Vec<String>,
    pub last_error: Option<String>,
}

/// 由内部状态构造对外视图（`status()` 与崩溃看护线程共用一份，避免两处写法走散）
fn view_of(g: &Inner) -> StatusView {
    // 先把日志快照出来再构造返回值：否则 MutexGuard 的临时值会活得比 `g` 长
    let log: Vec<String> = g.log.lock().unwrap().iter().cloned().collect();
    StatusView {
        state: g.state,
        port: g.port,
        token: g.token.clone(),
        root_dir: g.root_dir.clone(),
        sidecar_port: g.sidecar_port,
        llm_port: g.llm_port,
        mode: g.mode.clone(),
        phase: g.phase.clone(),
        degraded: g.degraded,
        children: g.children.view(),
        transitions: g.transitions.clone(),
        log,
        last_error: g.last_error.clone(),
    }
}

// ------------------------------------------------------------------ 启动配方（由 JS 给出）

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Probe {
    Tcp {
        port: u16,
    },
    Http {
        port: u16,
        #[serde(default = "default_method")]
        method: String,
        path: String,
        expect: u16,
        /// 探针要带的鉴权头（服务侧的 `/health` 需要 `X-Box-Token`）
        #[serde(default)]
        token: Option<String>,
    },
}

fn default_method() -> String {
    "GET".into()
}

#[derive(Clone, Debug, Deserialize)]
struct LaunchSpec {
    #[serde(default)]
    label: Option<String>,
    cmd: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    probes: Vec<Probe>,
    #[serde(default)]
    probe_timeout_ms: Option<u64>,
    /// 是否用 `engine/scripts/child-watch.mjs` 包一层起。
    /// 外部二进制（python / llama-server）**必须**包：它们不会在主进程被 SIGKILL 后自退（E11）。
    /// 我们自己的 Node 子进程（服务 / mock 替身）内部已装父死看管，无需再包（会多一层进程）。
    #[serde(default)]
    watch: bool,
    /// **归属方**（S4 起新增）。`None` / `"manager"` ⇒ 本 Manager 负责 spawn（沿 S2 行为）；
    /// `"service"` ⇒ 由 **box-service** 自己拉起，本 Manager **只打印不 spawn**。
    ///
    /// 为什么需要它：《04》§9.1 规定 Tier1 空闲卸载（停 ③ Sakura LLM）的实现方是 box-service
    /// （③ 不在引擎 TTL 范围内）。若 Rust 照旧 spawn，就会与 box-service spawn 的那个
    /// **抢同一个 8080** —— 而"两个 llama-server 互相踩"的报错离根因极远。
    /// 保留这条 spec 而不是直接给 `llm: null`，是为了 E1 的「生效参数快照」仍然逐条列出
    /// **真正会被执行的东西**（包括 ③ 的完整命令行）；删掉它等于让快照悄悄少一块。
    #[serde(default)]
    owner: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct LaunchPlan {
    mode: String,
    #[serde(default)]
    llm: Option<LaunchSpec>,
    engine: LaunchSpec,
    #[serde(default)]
    service_env: BTreeMap<String, String>,
}

// ------------------------------------------------------------------ 内部状态

struct Proc {
    label: &'static str,
    handle: Child,
    /// unix：spawn 时 `process_group(0)` ⇒ 进程组 id == 子进程 pid；windows：即 pid
    pgid: u32,
    probes: Vec<Probe>,
    probe_timeout: Duration,
}

struct Children {
    service: Option<Proc>,
    engine: Option<Proc>,
    llm: Option<Proc>,
}

impl Children {
    fn iter_mut(&mut self) -> impl Iterator<Item = &mut Proc> {
        [self.service.as_mut(), self.engine.as_mut(), self.llm.as_mut()]
            .into_iter()
            .flatten()
    }
    fn take_all(&mut self) -> Vec<Proc> {
        [self.service.take(), self.engine.take(), self.llm.take()]
            .into_iter()
            .flatten()
            .collect()
    }
    fn view(&self) -> Vec<ChildView> {
        [("service", &self.service), ("engine", &self.engine), ("llm", &self.llm)]
            .into_iter()
            .map(|(name, p)| ChildView {
                name: name.into(),
                pid: p.as_ref().map(|p| p.handle.id()),
                alive: p.is_some(),
            })
            .collect()
    }
}

struct Inner {
    state: ServiceState,
    phase: Option<String>,
    transitions: Vec<String>,
    port: Option<u16>,
    token: Option<String>,
    root_dir: Option<String>,
    sidecar_port: Option<u16>,
    llm_port: Option<u16>,
    mode: String,
    degraded: bool,
    last_error: Option<String>,
    log: Arc<Mutex<VecDeque<String>>>,
    children: Children,
    monitor_running: bool,
}

pub struct ServiceManager {
    inner: Arc<Mutex<Inner>>,
}

impl ServiceManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                state: ServiceState::Stopped,
                phase: None,
                transitions: Vec::new(),
                port: None,
                token: None,
                root_dir: None,
                sidecar_port: None,
                llm_port: None,
                mode: resolve_mode().unwrap_or_else(|_| "real".into()),
                degraded: false,
                last_error: None,
                log: Arc::new(Mutex::new(VecDeque::with_capacity(LOG_CAPACITY))),
                children: Children { service: None, engine: None, llm: None },
                monitor_running: false,
            })),
        }
    }

    pub fn status(&self) -> StatusView {
        view_of(&self.inner.lock().unwrap())
    }

    /// 服务基址（供各命令构造请求）；未就绪时返回 None
    pub fn base_url(&self) -> Option<String> {
        let g = self.inner.lock().unwrap();
        if g.state != ServiceState::Running {
            return None;
        }
        g.port.map(|p| format!("http://127.0.0.1:{p}/api/v1"))
    }

    pub fn token(&self) -> Option<String> {
        self.inner.lock().unwrap().token.clone()
    }

    /// 取某个子进程的 pid（`service` / `engine` / `llm`）。
    /// 诊断与自检都要用它：**从外面**给进程发信号、再回读状态，才是"崩溃分级"这类
    /// 机制断言的正确取证方式（应用自己"报告我准备好了"不算证据）。
    pub fn child_pid(&self, name: &str) -> Option<u32> {
        let g = self.inner.lock().unwrap();
        let p = match name {
            "service" => g.children.service.as_ref(),
            "engine" => g.children.engine.as_ref(),
            "llm" => g.children.llm.as_ref(),
            _ => None,
        };
        p.map(|p| p.handle.id())
    }

    fn log(&self) -> Arc<Mutex<VecDeque<String>>> {
        self.inner.lock().unwrap().log.clone()
    }

    fn mark(&self, app: &AppHandle, key: &str) {
        {
            let mut g = self.inner.lock().unwrap();
            g.transitions.push(key.to_string());
        }
        self.emit(app);
    }

    fn set_phase(&self, app: &AppHandle, phase: Option<&str>) {
        {
            let mut g = self.inner.lock().unwrap();
            g.phase = phase.map(str::to_string);
            if let Some(k) = phase {
                g.transitions.push(k.to_string());
            }
        }
        self.emit(app);
    }

    fn fail(&self, app: &AppHandle, phase: Option<&str>, err: String) {
        {
            let mut g = self.inner.lock().unwrap();
            g.state = ServiceState::Error;
            g.phase = phase.map(str::to_string);
            g.last_error = Some(err.clone());
            g.degraded = false;
        }
        push_log(&self.log(), &format!("[miao-dock] ✗ {err}"));
        // 起不来就别把半拉进程树留在那儿
        self.reap();
        self.emit(app);
    }

    pub fn emit(&self, app: &AppHandle) {
        let _ = app.emit(STATE_EVENT, self.status());
    }

    // -------------------------------------------------------------- 启动

    /// 启动引擎栈：**③ LLM → ② 引擎 → ① 服务**（后者依赖前者的端口）。
    ///
    /// 放到后台线程里跑：真引擎首启要加载模型（分钟级），阻塞 setup 会把窗口冻住。
    /// 状态与轨迹都经 `emit` 推给前端，所以异步不影响可观察性。
    pub fn start(&self, app: &AppHandle) {
        let app = app.clone();
        let inner = self.inner.clone();
        thread::spawn(move || {
            let mgr = ServiceManager { inner };
            mgr.start_blocking(&app);
        });
    }

    /// **幂等**启动：已在「启动中 / 运行中 / 正在停止」就直接返回，不重复拉起。
    ///
    /// ## 为什么不让调用方自己「先 `status()` 再决定」
    /// 那是**两次加锁、两段临界区**：`读状态 → 判定 → 启动` 之间存在窗口期。
    /// 有三条路径会在这个窗口里撞上：设置页的开关、进入翻译模块的自动启动、
    /// 用户连点两下。两条启动线程各自起一套三进程树，会抢同一批端口
    /// （① 的 5180–5190、② 的 8000/8001、③ 的 8080）—— 而"两个进程抢同一个端口"
    /// 的报错离根因极远，现场看是乱七八糟的启动失败。
    /// 所以「判定 + 置位」必须压在**同一把锁**内完成。
    ///
    /// 同步把状态落成 `Starting` 还有第二个好处：UI 立刻显示「启动中」，
    /// 而不是在后台线程跑起来之前先愣一下（那一愣正好是要堵的窗口）。
    ///
    /// 返回 `true` 表示**本次真的发起了启动**。
    pub fn start_once(&self, app: &AppHandle) -> bool {
        {
            let mut g = self.inner.lock().unwrap();
            if matches!(
                g.state,
                ServiceState::Starting | ServiceState::Running | ServiceState::Stopping
            ) {
                return false;
            }
            g.state = ServiceState::Starting;
            g.phase = None;
            g.degraded = false;
        }
        self.emit(app);
        self.start(app);
        true
    }

    fn start_blocking(&self, app: &AppHandle) {
        {
            let mut g = self.inner.lock().unwrap();
            g.state = ServiceState::Starting;
            g.phase = None;
            g.transitions.clear();
            g.degraded = false;
            g.last_error = None;
            g.port = None;
            g.token = None;
            g.root_dir = None;
            g.sidecar_port = None;
            g.llm_port = None;
            g.children = Children { service: None, engine: None, llm: None };
        }
        self.mark(app, "starting");

        let log = self.log();

        // ---- 0) 取启动配方（引擎侧细节的唯一来源；A3b 起在本进程内算，见 `load_plan`）----
        let mode = match resolve_mode() {
            Ok(m) => m,
            Err(e) => return self.fail(app, None, e),
        };
        self.inner.lock().unwrap().mode = mode.clone();

        let plan = match load_plan(&mode) {
            Ok(p) => p,
            Err(e) => return self.fail(app, None, e),
        };
        push_log(&log, &format!("[miao-dock] 启动配方 mode={} …", plan.mode));
        // E1：**日志打印生效参数快照** —— 逐条列出真正会被执行的东西（不是"配置里写的"）。
        // 走 `say`（环 + stdout 双写），让应用之外也能取证。
        say(&log, &format!("MIAO_LAUNCH_PLAN mode={}", plan.mode));
        say(&log, "──────────── 生效参数快照（E1）────────────");
        if let Some(llm) = &plan.llm {
            // S4：③ 的归属权可以是 box-service（`owner == "service"`）。快照照常打出**完整命令**，
            // 并注明执行者 —— 不然读日志的人会以为 Rust 该为 8080 负责（它不再负责了）。
            let by = match llm.owner.as_deref() {
                Some("service") => "（由 box-service 拉起，见《04》§9.1 Tier1）",
                _ => "",
            };
            say(&log, &format!("[miao-dock] ③ llm    : {}{}", cmd_line(&llm.cmd), by));
        } else {
            say(&log, "[miao-dock] ③ llm    : （本模式无独立 LLM 进程）");
        }
        say(
            &log,
            &format!(
                "[miao-dock] ② engine : {}{}",
                cmd_line(&plan.engine.cmd),
                if plan.engine.watch { "（经 child-watch 看守）" } else { "" }
            ),
        );
        if let Some(cwd) = &plan.engine.cwd {
            say(&log, &format!("[miao-dock] ② engine.cwd : {cwd}"));
        }
        say(
            &log,
            &format!(
                "[miao-dock] ① service: node service/src/server.mjs  env={}",
                fmt_env(&plan.service_env)
            ),
        );
        say(&log, "──────────────────────────────────────────");

        // ---- 1) 拉起 ③ ② ① ----
        let mut spawn_errs: Vec<String> = Vec::new();
        // ③ 的归属方可能是 **box-service**（S4 起，见 `LaunchSpec.owner` 注释）：那种情况下
        // 本 Manager **只打印不 spawn**，否则两个 llama-server 会抢同一个 8080。
        let llm_owned_by_service = plan
            .llm
            .as_ref()
            .and_then(|s| s.owner.as_deref())
            .map(|o| o == "service")
            .unwrap_or(false);
        if llm_owned_by_service {
            say(&log, "[miao-dock] ③ LLM 归属 box-service —— 本进程不 spawn（8080 由它负责）");
        } else if let Some(spec) = &plan.llm {
            match spawn_spec(spec, &log) {
                Ok(p) => {
                    let port = first_port(&p.probes);
                    self.inner.lock().unwrap().llm_port = port;
                    self.inner.lock().unwrap().children.llm = Some(p);
                }
                // ③ 起不来**不阻断**：没有 LLM 只是翻译阶段会失败（崩溃分级）
                Err(e) => spawn_errs.push(format!("LLM 启动失败（降级继续）：{e}")),
            }
        }

        match spawn_spec(&plan.engine, &log) {
            Ok(p) => {
                let port = first_port(&p.probes);
                self.inner.lock().unwrap().sidecar_port = port;
                self.inner.lock().unwrap().children.engine = Some(p);
            }
            // ② 起不来也继续：服务 `/health` 会报 degraded（画面 X-C3）
            Err(e) => spawn_errs.push(format!("引擎启动失败（降级继续）：{e}")),
        }

        let service_cmd = match resolve_service_cmd() {
            Ok(c) => c,
            Err(e) => return self.fail(app, None, e),
        };
        let service_spec = LaunchSpec {
            label: Some("service".into()),
            cmd: service_cmd,
            cwd: None,
            env: plan.service_env.clone(),
            probes: Vec::new(),
            probe_timeout_ms: None,
            watch: false,
            // ① 由本 Manager 亲自拉起（它是"最后一道防线"，不能交给别人）
            owner: None,
        };
        match spawn_spec_with_ready(&service_spec, &log) {
            Ok((p, rx)) => {
                self.inner.lock().unwrap().children.service = Some(p);
                // 就绪行只是**数据通道**（端口动态 + 令牌只在这行里），不是就绪判据
                match wait_ready(&rx, SERVICE_READY_TIMEOUT) {
                    Ok(v) => {
                        let port = v.get("port").and_then(|x| x.as_u64()).map(|x| x as u16);
                        let token = v.get("token").and_then(|x| x.as_str()).map(str::to_string);
                        let root_dir = v.get("rootDir").and_then(|x| x.as_str()).map(str::to_string);
                        let mut g = self.inner.lock().unwrap();
                        g.port = port;
                        g.token = token.clone();
                        g.root_dir = root_dir;
                        // 服务的**三重判定**探针只能在这时补齐：端口是动态的（5180–5190 里挑），
                        // 令牌也只在就绪行里 ⇒ 拿不到这两样就没法构造探针。
                        // ⚠️ 就绪行是**数据通道**，不是就绪判据：拿到端口 ≠ 服务能干活。
                        if let (Some(p), Some(port)) = (g.children.service.as_mut(), port) {
                            p.probes = vec![
                                Probe::Tcp { port },
                                Probe::Http {
                                    port,
                                    method: "GET".into(),
                                    path: "/health".into(),
                                    expect: 200,
                                    token,
                                },
                            ];
                        }
                    }
                    Err(e) => return self.fail(app, Some("L1"), format!("服务未就绪：{e}")),
                }
            }
            Err(e) => return self.fail(app, Some("L1"), format!("服务启动失败：{e}")),
        }
        for line in &spawn_errs {
            push_log(&log, &format!("[miao-dock] ! {line}"));
        }

        // ---- 2) L1 环境就绪：三个进程都活着 ----
        if let Err(e) = self.all_alive("L1 环境就绪") {
            return self.fail(app, Some("L1"), e);
        }
        self.set_phase(app, Some("L1"));

        // ---- 3) L2 模型就绪：所有 TCP 探针在听 ----
        if let Err(e) = self.wait_probes(|p| matches!(p, Probe::Tcp { .. })) {
            return self.fail(app, Some("L2"), e);
        }
        self.set_phase(app, Some("L2"));

        // ---- 4) L3 预热：所有 HTTP 探针真应答 ----
        if let Err(e) = self.wait_probes(|p| matches!(p, Probe::Http { .. })) {
            return self.fail(app, Some("L3"), e);
        }
        self.set_phase(app, Some("L3"));

        // ---- 5) running ----
        {
            let mut g = self.inner.lock().unwrap();
            g.state = ServiceState::Running;
            g.phase = None;
            g.degraded = !spawn_errs.is_empty();
        }
        self.mark(app, "running");
        push_log(&log, "[miao-dock] 服务与引擎栈就绪（三重判定通过：进程存活 + 端口 + HTTP）");
        self.spawn_monitor(app);
    }

    /// 三个进程（在位的那些）是否都还活着
    fn all_alive(&self, what: &str) -> Result<(), String> {
        let mut g = self.inner.lock().unwrap();
        for p in g.children.iter_mut() {
            match p.handle.try_wait() {
                Ok(None) => {}
                Ok(Some(st)) => {
                    return Err(format!("{what} 失败：{} 进程已退出（{st}）", p.label))
                }
                Err(e) => return Err(format!("{what} 失败：探测 {} 失败（{e}）", p.label)),
            }
        }
        Ok(())
    }

    /// 对所有匹配的探针做**各自独立超时**的等待（三重判定的 L2/L3 两层）
    fn wait_probes(&self, want: fn(&Probe) -> bool) -> Result<(), String> {
        // 先把 (label, probe, timeout) 快照出来，避免持锁做网络 IO
        let list: Vec<(&'static str, Probe, Duration)> = {
            let g = self.inner.lock().unwrap();
            let mut v = Vec::new();
            for p in [&g.children.llm, &g.children.engine, &g.children.service]
                .into_iter()
                .flatten()
            {
                for probe in p.probes.iter().filter(|x| want(x)) {
                    v.push((p.label, probe.clone(), p.probe_timeout));
                }
            }
            v
        };
        for (label, probe, timeout) in list {
            wait_probe(label, &probe, timeout).map_err(|e| {
                push_log(&self.log(), &format!("[miao-dock] ✗ {e}"));
                e
            })?;
        }
        Ok(())
    }

    // -------------------------------------------------------------- 停止

    /// 回收**整棵子进程树**（不只是直接子进程）。
    ///
    /// 为什么不能只 `Child::kill()`：真引擎会自己再拉起执行器子进程（`main.py:244`），
    /// 直接 SIGKILL 引擎主进程 ⇒ 执行器被 reparent 到 launchd、继续占住 port+1（E11 的孤儿）。
    /// 所以：每个子进程 spawn 时进自己的**进程组**，这里对**组**发信号。
    fn reap(&self) {
        let mut procs = {
            let mut g = self.inner.lock().unwrap();
            g.children.take_all()
        };
        if procs.is_empty() {
            return;
        }
        let log = self.log();
        let refute = no_tree_kill();
        if refute {
            push_log(&log, "[miao-dock] ⚠ MIAO_NO_TREE_KILL=1 —— 只杀直接子进程（反证用）");
        }
        // ① 先礼：SIGTERM 整组（真引擎能借信号处理器清掉自己的执行器）
        for p in procs.iter_mut() {
            push_log(&log, &format!("[miao-dock] 停止 {}（pid={}）", p.label, p.handle.id()));
            if refute {
                let _ = p.handle.kill();
            } else {
                signal_tree(p.pgid, false);
            }
        }
        // ② 等优雅退出
        let deadline = Instant::now() + STOP_GRACE;
        let mut pending: Vec<usize> = (0..procs.len()).collect();
        while !pending.is_empty() && Instant::now() < deadline {
            pending.retain(|&i| !matches!(procs[i].handle.try_wait(), Ok(Some(_))));
            if !pending.is_empty() {
                thread::sleep(Duration::from_millis(80));
            }
        }
        // ③ 后兵：整组 SIGKILL + reap 僵尸
        for &i in &pending {
            push_log(&log, &format!("[miao-dock] 强制结束 {}（SIGKILL 整组）", procs[i].label));
            if refute {
                let _ = procs[i].handle.kill();
            } else {
                signal_tree(procs[i].pgid, true);
            }
        }
        // ④ 收尸 —— 🔴 **必须有上界**。
        //
        // 这一段原来是**无界**的 `handle.wait()`。它看着无害，实则正是
        // 「点退出没反应」的**第二个**可能成因：`taskkill /T /F` 万一没能带走某个子进程
        //（权限不足、PID 已被复用、进程正卡在不可中断的系统调用里），`wait()` 就**永远
        // 不返回** —— 调用它的那条线程连同整个退出流程一起挂死。旧版 `quit_app` 是同步
        // 命令（跑在主线程），于是表现就是**窗口活着、进程活着、点什么都没反应**。
        //
        // 两害相权：收尸失败最多留一个孤儿进程（`child-watch` / `parent-watch` 还有一层
        // 兜底，见 D-12），而**退不掉**是用户直接看得见、且自己解决不了的故障。
        // 所以这里宁可放过孤儿，也绝不允许无限等。
        let reap_deadline = Instant::now() + REAP_GRACE;
        for p in procs.iter_mut() {
            loop {
                match p.handle.try_wait() {
                    Ok(Some(_)) => break, // 正常：已退出（try_wait 顺带完成 wait，收掉僵尸）
                    Ok(None) => {
                        if Instant::now() >= reap_deadline {
                            push_log(
                                &log,
                                &format!(
                                    "[miao-dock] ⚠ {}（pid={}）在 {}s 内未确认退出 —— 不再等，继续退出",
                                    p.label,
                                    p.handle.id(),
                                    REAP_GRACE.as_secs()
                                ),
                            );
                            break;
                        }
                        thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => break, // 探测本身失败：没有更有意义的动作可做
                }
            }
        }
    }

    /// 停止全部子进程并等待退出（对外语义与 ver1.0 一致，内部升级为"整棵树"）。
    /// 状态机上先落 `stopping` 再落 `stopped` —— 五态机里的 `stopping` 是**真的会被走到**的，
    /// 不是画在文档里的装饰（它同时让"正在回收"这件事在 UI 上可观察）。
    pub fn stop(&self) {
        {
            let mut g = self.inner.lock().unwrap();
            if g.state != ServiceState::Stopped {
                g.state = ServiceState::Stopping;
                g.transitions.push("stopping".into());
            }
        }
        self.reap();
        let mut g = self.inner.lock().unwrap();
        g.transitions.push("stopped".into());
        g.state = ServiceState::Stopped;
        g.phase = None;
        g.port = None;
        g.token = None;
        g.sidecar_port = None;
        g.llm_port = None;
        g.degraded = false;
        g.last_error = None;
    }

    // -------------------------------------------------------------- 崩溃分级

    /// 后台看护：②③ 掉了 ⇒ `degraded`（任务会失败，但 ① 还在、仍能应答 = 分级而非整体崩）；
    /// ① 掉了 ⇒ 整体 `error`。**不静默**：两条路都写日志。
    fn spawn_monitor(&self, app: &AppHandle) {
        // 反证开关：关掉看护后，②③ 挂掉时 `degraded` 不会翻转 ⇒ S2 的崩溃分级断言必须变红。
        if std::env::var("MIAO_NO_CRASH_MONITOR").map(|v| v == "1").unwrap_or(false) {
            push_log(&self.log(), "[miao-dock] ⚠ MIAO_NO_CRASH_MONITOR=1 —— 崩溃分级看护未启动（反证用）");
            return;
        }
        {
            let mut g = self.inner.lock().unwrap();
            if g.monitor_running {
                return;
            }
            g.monitor_running = true;
        }
        let inner = self.inner.clone();
        let app = app.clone();
        thread::spawn(move || {
            // 已经报过的进程名：`try_wait()` 会**缓存**已回收的状态，不记一份就会每秒重复报警
            let mut reported: Vec<&'static str> = Vec::new();
            loop {
                thread::sleep(Duration::from_millis(1000));
                let mut notes: Vec<String> = Vec::new();
                let mut service_dead = false;
                {
                    let mut g = match inner.lock() {
                        Ok(g) => g,
                        Err(_) => return,
                    };
                    if g.state != ServiceState::Running {
                        g.monitor_running = false;
                        return;
                    }
                    let log = g.log.clone();
                    let mut dead: Vec<(&'static str, String)> = Vec::new();
                    for p in g.children.iter_mut() {
                        if reported.contains(&p.label) {
                            continue;
                        }
                        if let Ok(Some(st)) = p.handle.try_wait() {
                            dead.push((p.label, format!("{}", st)));
                        }
                    }
                    for (label, st) in &dead {
                        reported.push(label);
                        notes.push(format!("{label} 进程已退出（{st}）"));
                        if *label == "service" {
                            service_dead = true;
                        }
                    }
                    for n in &notes {
                        push_log(&log, &format!("[miao-dock] ! {n}"));
                    }
                    if !dead.is_empty() {
                        if service_dead {
                            g.state = ServiceState::Error;
                            g.last_error = Some(notes.join("；"));
                            g.monitor_running = false;
                        } else {
                            // ②③ 挂 = 降级：翻译会失败，但 box-service 本身仍活着（分级，不是整体崩）
                            g.degraded = true;
                        }
                    }
                }
                if notes.is_empty() {
                    continue;
                }
                match inner.lock() {
                    Ok(g) => {
                        let _ = app.emit(STATE_EVENT, view_of(&g));
                    }
                    Err(_) => return,
                }
            }
        });
    }
}

// ------------------------------------------------------------------ 子进程工具

fn cmd_line(cmd: &[String]) -> String {
    cmd.iter()
        .map(|a| if a.contains(' ') { format!("{a:?}") } else { a.clone() })
        .collect::<Vec<_>>()
        .join(" ")
}

fn fmt_env(env: &BTreeMap<String, String>) -> String {
    if env.is_empty() {
        return "（无）".into();
    }
    env.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(" ")
}

fn first_port(probes: &[Probe]) -> Option<u16> {
    probes.first().map(|p| match p {
        Probe::Tcp { port } => *port,
        Probe::Http { port, .. } => *port,
    })
}

/// 引擎栈模式开关。**取值非法直接报错，不静默回退**（静默回退正是"以为在测 mock、其实走了 real"的温床）。
fn resolve_mode() -> Result<String, String> {
    let raw = std::env::var("MIAO_ENGINE_PROTOCOL").unwrap_or_default();
    let v = if raw.trim().is_empty() { "real".to_string() } else { raw.trim().to_lowercase() };
    match v.as_str() {
        "real" | "mock" => Ok(v),
        other => Err(format!("MIAO_ENGINE_PROTOCOL 取值非法：{other:?}（可选：real | mock）")),
    }
}

/// 取一次启动配方（**引擎侧细节的唯一来源**，A3b 起在本进程内算）。
///
/// 🔴 为什么 formerly 要起 node：S2 时「怎么拼命令」住在 `service/src/engine-client.mjs`，
///    Rust 去问它。本函数是那条唯一的跨语言依赖 —— 而它带来的代价是**打包后必然失败**
///    （A3「node 随包」已作废），报错还停在 `无法执行 node 打印启动配方` 这种
///    离根因很远的地方。
///    现在配方逻辑已 Rust 化（`boxsvc::engine::{resolve_engine_launch, resolve_llm_launch}`，
///    F4 移植时逐字对齐过），于是**不再需要任何子进程**。
///
/// ⚠️ 协议由入参决定（`mode`），不读环境 —— 环境的读法在 `resolve_mode()` 已收口。
fn load_plan(mode: &str) -> Result<LaunchPlan, String> {
    let value = boxsvc::engine::build_launch_plan(mode)?;
    // 解析失败要**说清是形状不对**而不是把 serde 的行号倒给用户：这份 JSON 由本进程刚生成，
    // 解析失败等于"我们自己的输出坏了"，那是要立刻定位的实现缺陷，不是用户能修的。
    serde_json::from_value::<LaunchPlan>(value).map_err(|e| {
        format!(
            "启动配方形状非法（这是实现缺陷，不是配置问题）：{e}；mode={mode}"
        )
    })
}

/// 写进**日志环**（UI 诊断视图读它）**并且**打到 stdout。
///
/// 两条路都要：环里的东西只有**进程内**自检读得到；而 E1 的判据是「**日志打印**生效参数快照」，
/// "打印出来了"这件事必须能被**应用之外**的观察者看到（否则只能自证）。
fn say(log: &Arc<Mutex<VecDeque<String>>>, line: &str) {
    println!("{line}");
    push_log(log, line);
}

fn push_log(log: &Arc<Mutex<VecDeque<String>>>, line: &str) {
    let mut l = log.lock().unwrap();
    if l.len() >= LOG_CAPACITY {
        l.pop_front();
    }
    l.push_back(line.to_string());
}

/// 逐行转发子进程输出 —— 🔴 **绝不因为"这一行不是合法 UTF-8"而停读**（见 spec-notes D-88）。
///
/// ## 为什么不能用 `BufReader::new(out).lines().map_while(Result::ok)`
/// 那个写法看着无害，实则把「**子进程输出的编码**」与「**父进程能不能继续读**」耦在了一起，
/// 而 Windows 上它们本来是分离的两件事：
///
/// 1. `lines()` 内部是 `read_line`，要求**合法 UTF-8**；不合法时返回 `Err(InvalidData)`。
/// 2. `map_while(Result::ok)` 遇到第一个 `Err` 就**结束迭代**，`BufReader`（连同 `ChildStdout`
///    / `ChildStderr`）随即被丢弃 ⇒ **这一端的管道读句柄被关闭**。
/// 3. 此后子进程**再往这个流里写任何东西都会失败**。Windows 上的报错是
///    `OSError: [Errno 22] Invalid argument`（**不是** Linux 那种 `Broken pipe`），
///    而且它会**伪装成一个与该流毫不相干的错误**出现在别处 —— 实测是引擎里 `tqdm`
///    初始化时那句 `sys.stderr.flush()`（`tqdm/std.py:446`），整张图因此在「掩码细化」处失败。
///
/// 触发条件在本机是**必然**的：中文 Windows 上 Python 子进程的 stdio 默认按 ANSI 代码页
/// （GBK/cp936）编码，而真引擎会把**日文**原文/译文写进日志（`utils/log.py` 的
/// `logging.basicConfig` 把 root handler 接到了 **stderr**）⇒ 第一行日文日志就把读者打死。
/// （另见 `engine-client.mjs` 里给引擎注入 `PYTHONIOENCODING=utf-8` 的那一半修复。）
///
/// ## 现在的语义
/// 按**字节**读、以 `b'\n'` 切行、用 `String::from_utf8_lossy` 解码 ⇒ 非法字节退化为 `�`，
/// **但读者永远不会放弃**，管道也不会被提前关掉。日志面板因此最多是"某几个字是问号"，
/// 而不会变成"从某一行起什么都没有 + 引擎随后报一个莫名其妙的错"。
/// 行尾的 `\r` 顺手去掉（Windows 子进程写 `\r\n`）。
fn relay_lines<R: Read>(mut r: R, mut on_line: impl FnMut(String)) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match r.read(&mut chunk) {
            Ok(0) => break, // EOF：子进程退出、管道结束
            Ok(n) => {
                for &b in &chunk[..n] {
                    if b == b'\n' {
                        let mut line = std::mem::take(&mut buf);
                        if line.last() == Some(&b'\r') {
                            line.pop();
                        }
                        on_line(String::from_utf8_lossy(&line).into_owned());
                    } else {
                        buf.push(b);
                    }
                }
            }
            // 读错误（管道被对端关闭等）：**结束这一条流**，但不影响其它子进程与主流程。
            Err(_) => break,
        }
    }
    // 结尾可能有一行没有换行符
    if !buf.is_empty() {
        on_line(String::from_utf8_lossy(&buf).into_owned());
    }
}

/// 服务实现的**靶子**：`MIAO_SERVICE_IMPL=rust|boxsvc` ⇒ `boxsvc`；`=node` ⇒ Node
/// `service/src/server.mjs`；**未设 ⇒ 默认 `boxsvc`（F5.8 起）**。
///
/// 🔴 **默认已翻转**：F1 过渡期默认 node（"打包把 boxsvc 放进安装包之前，产品路径一律不动"），
///    而 F5 已把**全部** 44 条端点迁进 Rust（`routes::forwarded_count() == 0`，由
///    `check:routes --final` 的完成门盯着）。此时默认仍是 node，等于"摘除 Node"只写在文档里
///    —— 产品照旧起一份 Node 服务，正是计划文档 R3 说的那个形态。与 e2e 共用同一个
///    `MIAO_SERVICE_IMPL` 名字是**刻意的**：app 与验收脚本切的是同一个东西。
///
/// 三档的分歧点在于**找不到 boxsvc 时怎么办**，两档刻意不同：
///   · `=rust`（显式）⇒ **硬失败**。说了算数：显式切了却没生效、还悄悄换回 Node，
///     会让"切实现"这件事彻底失去可观测性（`harness-check` 的 H5 钉的是同一条）。
///   · 未设（默认）⇒ **退回 Node 并打印可见警告**。开发态 `cargo run --bin miao-dock`
///     只构建了主 bin，`target/debug/` 里没有 `boxsvc` —— 这时硬失败会把
///     "跑起来看看界面"变成"先读一篇构建说明"。⚠️ 但退回**绝不静默**：Node 是过渡依赖、
///     将来从包里删掉，警告必须让人看得见"Rust 没生效以及为什么"。
fn resolve_service_cmd() -> Result<Vec<String>, String> {
    let impl_ = std::env::var("MIAO_SERVICE_IMPL").unwrap_or_default();
    let impl_ = impl_.trim().to_ascii_lowercase();
    match impl_.as_str() {
        "rust" | "boxsvc" => Ok(vec![resolve_boxsvc()?.to_string_lossy().into_owned()]),
        "node" => node_service_cmd(),
        // 未设（或无法识别的值）⇒ 默认 Rust；拿不到 boxsvc 才退回 Node（可见警告）。
        _ => match resolve_boxsvc() {
            Ok(bin) => Ok(vec![bin.to_string_lossy().into_owned()]),
            Err(e) => {
                // ⚠️ 退回**绝不静默**：Node 是过渡依赖、将来要从包里删掉，这条警告是人唯一
                //    看得见"Rust 没生效、以及为什么"的地方（静默退回 = R3 的形态）。
                eprintln!("[miao-dock] ⚠ 默认档应为 Rust boxsvc，但{e}；本次退回 Node。想让默认档跑起来：cargo build --bin boxsvc");
                node_service_cmd()
            }
        },
    }
}

/// Node 服务入口（**过渡 / 对拍**用，非默认档）。
fn node_service_cmd() -> Result<Vec<String>, String> {
    let entry = resolve_entry("service/src/server.mjs", "MIAO_SERVICE_ENTRY")?;
    Ok(vec!["node".into(), entry.to_string_lossy().into_owned()])
}

/// 定位 `boxsvc` 可执行：`MIAO_BOXSVC_BIN` 优先，其次与 `miao-dock` 可执行**同目录**
/// （开发态二者同在 `app/src-tauri/target/{debug,release}/`）。
fn resolve_boxsvc() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("MIAO_BOXSVC_BIN") {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return Ok(pb);
        }
        return Err(format!("MIAO_BOXSVC_BIN 指向的文件不存在：{p}"));
    }
    let name = if cfg!(windows) { "boxsvc.exe" } else { "boxsvc" };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let cand = dir.join(name);
            if cand.is_file() {
                return Ok(cand);
            }
        }
    }
    Err(format!(
        "找不到 {name}（Rust 服务实现需要它）：先在 app/src-tauri 执行 `cargo build --bin boxsvc`，或设 MIAO_BOXSVC_BIN"
    ))
}

/// 定位入口脚本：环境变量优先，其次从可执行文件/工作目录向上找（开发期在 src-tauri 下运行）
fn resolve_entry(rel: &str, env_key: &str) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var(env_key) {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return Ok(pb);
        }
        return Err(format!("{env_key} 指向的文件不存在：{p}"));
    }
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            bases.push(dir.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        bases.push(cwd);
    }
    for base in bases {
        let mut cur = base;
        for _ in 0..6 {
            let cand = cur.join(rel);
            if cand.is_file() {
                return Ok(cand);
            }
            match cur.parent() {
                Some(p) => cur = p.to_path_buf(),
                None => break,
            }
        }
    }
    Err(format!("找不到 {rel}（可用环境变量 {env_key} 指定绝对路径）"))
}

type ReadyRx = mpsc::Receiver<serde_json::Value>;

/// 起一个子进程（**进自己的进程组**），把 stdout/stderr 收进日志。
fn spawn_spec(spec: &LaunchSpec, log: &Arc<Mutex<VecDeque<String>>>) -> Result<Proc, String> {
    let (proc, _rx) = spawn_inner(spec, log, false)?;
    Ok(proc)
}

/// 同上，但把 stdout 里**含 `{…}` 的行**当就绪数据回传（box-service 用它带出端口与令牌）
fn spawn_spec_with_ready(
    spec: &LaunchSpec,
    log: &Arc<Mutex<VecDeque<String>>>,
) -> Result<(Proc, ReadyRx), String> {
    let (proc, rx) = spawn_inner(spec, log, true)?;
    Ok((proc, rx.expect("collect_ready=true 必有 receiver")))
}

fn spawn_inner(
    spec: &LaunchSpec,
    log: &Arc<Mutex<VecDeque<String>>>,
    collect_ready: bool,
) -> Result<(Proc, Option<ReadyRx>), String> {
    if spec.cmd.is_empty() {
        return Err("启动配方里的 cmd 是空的".into());
    }
    // 外部二进制（python / llama-server）包一层父死看守 —— 见 `watch` 字段注释。
    // ⚠️ 包一层之后 Rust 持有的直接子进程是"看守"，真正的引擎/LLM 是它的子进程；
    // 所以回收才必须走**进程组**（`signal_tree`）而不是 `Child::kill()`。
    let (head, args): (String, Vec<String>) = if spec.watch {
        let watch = resolve_entry("engine/scripts/child-watch.mjs", "MIAO_CHILD_WATCH_ENTRY")?;
        let mut a = vec![watch.to_string_lossy().into_owned(), "--".into()];
        a.extend(spec.cmd.iter().cloned());
        ("node".to_string(), a)
    } else {
        (spec.cmd[0].clone(), spec.cmd[1..].to_vec())
    };

    let mut cmd = Command::new(&head);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    if let Some(cwd) = &spec.cwd {
        cmd.current_dir(cwd);
    }
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    // 让子进程进**自己的进程组**：回收时对组发信号即可连带孙进程（见 reap）
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    // Windows 上把子进程也挂进新进程组（taskkill /T 才有意义）
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法执行 {}：{e}", spec.cmd[0]))?;
    let pid = child.id();
    let label: &'static str = match spec.label.as_deref() {
        Some("service") => "service",
        Some("engine") => "engine",
        Some("llm") => "llm",
        _ => "child",
    };

    let (tx, rx) = mpsc::channel::<serde_json::Value>();
    if let Some(out) = child.stdout.take() {
        let log = log.clone();
        let tx = tx.clone();
        thread::spawn(move || {
            // ⚠️ 走 `relay_lines`（按字节 + lossy），**不是** `.lines().map_while(Result::ok)`：
            //    后者一遇到非法 UTF-8 就停读并关掉管道，会让子进程后续写 stderr 直接报
            //    `[Errno 22] Invalid argument`。见 `relay_lines` 的注释与 spec-notes D-88。
            relay_lines(out, |line| {
                if collect_ready {
                    if let Some(idx) = line.find('{') {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line[idx..]) {
                            let _ = tx.send(v);
                        }
                    }
                }
                push_log(&log, &line);
            });
        });
    }
    if let Some(err) = child.stderr.take() {
        let log = log.clone();
        thread::spawn(move || {
            relay_lines(err, |line| push_log(&log, &format!("[stderr] {line}")));
        });
    }

    Ok((
        Proc {
            label,
            handle: child,
            pgid: pid,
            probes: spec.probes.clone(),
            probe_timeout: spec
                .probe_timeout_ms
                .map(Duration::from_millis)
                .unwrap_or(PROBE_TIMEOUT),
        },
        if collect_ready { Some(rx) } else { None },
    ))
}

fn wait_ready(rx: &ReadyRx, timeout: Duration) -> Result<serde_json::Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(format!("等待就绪行超时（{}s）", timeout.as_secs()));
        }
        match rx.recv_timeout(left) {
            Ok(v) => return Ok(v),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(format!("等待就绪行超时（{}s）", timeout.as_secs()))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("子进程在就绪前退出（请查看日志）".into())
            }
        }
    }
}

// ------------------------------------------------------------------ 就绪探针

fn wait_probe(label: &str, probe: &Probe, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if run_probe(probe).is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "{label} 探针超时（{}s）：{}",
                timeout.as_secs(),
                describe_probe(probe)
            ));
        }
        thread::sleep(Duration::from_millis(150));
    }
}

fn describe_probe(probe: &Probe) -> String {
    match probe {
        Probe::Tcp { port } => format!("TCP 127.0.0.1:{port} 未在监听"),
        Probe::Http { method, path, port, expect, .. } => {
            format!("{method} http://127.0.0.1:{port}{path} 未返回 {expect}")
        }
    }
}

fn run_probe(probe: &Probe) -> Result<(), String> {
    match probe {
        Probe::Tcp { port } => {
            let addr: std::net::SocketAddr = ([127, 0, 0, 1], *port).into();
            std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(600))
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        Probe::Http { port, method, path, expect, token } => {
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_millis(1200))
                .build()
                .map_err(|e| e.to_string())?;
            let url = format!("http://127.0.0.1:{port}{path}");
            let mut req = if method.eq_ignore_ascii_case("POST") {
                client.post(&url)
            } else {
                client.get(&url)
            };
            if let Some(t) = token {
                req = req.header("X-Box-Token", t);
            }
            let res = req.send().map_err(|e| e.to_string())?;
            let code = res.status().as_u16();
            if code == *expect {
                Ok(())
            } else {
                Err(format!("HTTP {code}（期望 {expect}）"))
            }
        }
    }
}

// ------------------------------------------------------------------ 进程树信号（跨端）

/// 对**整个进程组**发信号。
///
/// - unix：`kill(-pgid, sig)`；子进程 spawn 时 `process_group(0)` ⇒ 组内还有真引擎的执行器。
/// - Windows：`taskkill /PID <pid> /T [/F]`（`/T` 连子树）。
///   ⚠️ **本机无法验证 Windows 分支**（G2 ④）：代码写在这里、注释标清楚，但不得计入"已验"。
#[cfg(unix)]
fn signal_tree(pgid: u32, force: bool) {
    let sig = if force { libc::SIGKILL } else { libc::SIGTERM };
    // 组 id 取负：`kill(-pgid, …)` 是 POSIX 的"发给整组"
    unsafe {
        libc::kill(-(pgid as i32), sig);
    }
}

#[cfg(windows)]
fn signal_tree(pgid: u32, force: bool) {
    use std::os::windows::process::CommandExt;
    // `CREATE_NO_WINDOW`：不给子进程分配控制台窗口。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut c = Command::new("taskkill");
    c.args(["/PID", &pgid.to_string(), "/T"]);
    // 🔴 Windows 上「先礼」（不带 `/F`）对**控制台进程无效**（D-89）：
    //
    // 实测（2026-10-07）：`taskkill /PID <pid> /T` 不带 `/F` 时，对 node 返回 255、
    // 对 Python 返回 128，目标进程**一个都不死**。`taskkill` 不带 `/F` 发的是
    // `WM_CLOSE`/`CTRL_BREAK`，而 node / python 这类控制台进程**默认不响应**——
    // 于是「先礼后兵」里的「先礼」在 Windows 上名存实亡，白白空等 STOP_GRACE，
    // 还给了孙进程（执行器）被 reparent 的窗口。
    //
    // 平台事实决定了没有「优雅」这一档：`force=false` 与 `force=true` 都必须走 `/F`。
    // 代价是跳过引擎 `main.py` 里 `handle_exit_signals` 的 `proc.terminate()` 优雅路径
    // —— 但那条路径在 Windows 上本来就**不会被触发**（收不到 SIGTERM），所以没有损失。
    c.arg("/F");
    // 应用本体是 `windows_subsystem = "windows"`（**没有**控制台），此时 spawn 一个
    // 控制台程序，Windows 会**新开一个黑框**闪一下。纯观感问题，但「点退出时蹦出一个
    // cmd 黑框」很容易被当成"是不是中毒了"，成本一行，消掉它。
    c.creation_flags(CREATE_NO_WINDOW);
    let _ = c.stdout(Stdio::null()).stderr(Stdio::null()).status();
    let _ = force; // 语义保留：unix 分支靠它区分 SIGTERM/SIGKILL；Windows 分支两档等价
}

/// **反证开关**：跳过整棵树的回收，只做直接子进程的 `kill()`。
///
/// 用来证明 E11 那组断言真的作用在"整棵树"上 —— 关掉之后，真引擎的执行器/孙进程
/// 会变成占住 port+1 的孤儿，断言必须变红。见 ~/.workbuddy/skills/falsifiable-verification。
pub fn no_tree_kill() -> bool {
    std::env::var("MIAO_NO_TREE_KILL")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}
