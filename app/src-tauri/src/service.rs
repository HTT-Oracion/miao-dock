//! ServiceManager —— box-service 与 sidecar 引擎的生命周期管理
//!
//! 契约依据：《02》§2.1「**服务生命周期 = Box 进程的生命周期，与窗口可见性解耦**」
//! 实现方式：Rust 主进程持有两个子进程的句柄；窗口 `hide()` 不触发任何清理，
//! 只有应用真正退出时才杀掉子进程并等待端口释放 —— 让「服务常驻」成为结构性事实，
//! 而不是靠约定。四态机：`stopped → starting → running → (error | stopped)`。
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 状态变化事件名（前端订阅）
pub const STATE_EVENT: &str = "miao://service-state";
const LOG_CAPACITY: usize = 400;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceState {
    Stopped,
    Starting,
    Running,
    Error,
}

#[derive(Clone, Serialize)]
pub struct StatusView {
    pub state: ServiceState,
    /// box-service 实际监听端口（5180–5190 内探测得出）
    pub port: Option<u16>,
    /// 配对令牌；由 Rust 持有并下发给 UI（WebView 不直连服务）
    pub token: Option<String>,
    pub root_dir: Option<String>,
    /// sidecar 引擎的实际端口
    pub sidecar_port: Option<u16>,
    pub log: Vec<String>,
    pub last_error: Option<String>,
}

struct Children {
    service: Option<Child>,
    engine: Option<Child>,
}

struct Inner {
    state: ServiceState,
    port: Option<u16>,
    token: Option<String>,
    root_dir: Option<String>,
    sidecar_port: Option<u16>,
    last_error: Option<String>,
    log: Arc<Mutex<VecDeque<String>>>,
    children: Children,
}

pub struct ServiceManager {
    inner: Mutex<Inner>,
}

impl ServiceManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                state: ServiceState::Stopped,
                port: None,
                token: None,
                root_dir: None,
                sidecar_port: None,
                last_error: None,
                log: Arc::new(Mutex::new(VecDeque::with_capacity(LOG_CAPACITY))),
                children: Children { service: None, engine: None },
            }),
        }
    }

    pub fn status(&self) -> StatusView {
        let g = self.inner.lock().unwrap();
        // 先把日志快照出来再构造返回值：否则 MutexGuard 的临时值会活得比 `g` 长
        let log: Vec<String> = g.log.lock().unwrap().iter().cloned().collect();
        StatusView {
            state: g.state,
            port: g.port,
            token: g.token.clone(),
            root_dir: g.root_dir.clone(),
            sidecar_port: g.sidecar_port,
            log,
            last_error: g.last_error.clone(),
        }
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

    fn set_state(&self, app: &AppHandle, next: ServiceState, err: Option<String>) {
        {
            let mut g = self.inner.lock().unwrap();
            g.state = next;
            if let Some(e) = err {
                g.last_error = Some(e);
            }
        }
        self.emit(app);
    }

    pub fn emit(&self, app: &AppHandle) {
        let _ = app.emit(STATE_EVENT, self.status());
    }

    /// 启动两个子进程：**先引擎后服务**（服务需要知道引擎实际端口）
    pub fn start(&self, app: &AppHandle) {
        self.set_state(app, ServiceState::Starting, None);

        let log = { self.inner.lock().unwrap().log.clone() };
        let mut report: Vec<String> = Vec::new();

        // ① 引擎（sidecar）
        let engine_entry = match resolve_entry("engine/src/server.mjs", "MIAO_ENGINE_ENTRY") {
            Ok(p) => p,
            Err(e) => {
                self.set_state(app, ServiceState::Error, Some(e));
                return;
            }
        };
        let engine = match spawn_node(&engine_entry, &[], &log) {
            Ok(handle) => Some(handle),
            Err(e) => {
                // 引擎起不来不阻断服务启动：服务的 /health 会返回 degraded，UI 走 X-C3
                report.push(format!("引擎启动失败：{e}"));
                None
            }
        };

        let sidecar_port = match engine {
            Some((child, ready_rx)) => match wait_ready(&ready_rx, Duration::from_secs(12)) {
                Ok(v) => {
                    let p = v.get("port").and_then(|x| x.as_u64()).map(|x| x as u16);
                    report.push(format!("引擎就绪：port={p:?}"));
                    self.inner.lock().unwrap().children.engine = Some(child);
                    p
                }
                Err(e) => {
                    let mut child = child;
                    let _ = child.kill();
                    report.push(format!("引擎未就绪：{e}"));
                    None
                }
            },
            None => None,
        };

        // ② box-service
        let service_entry = match resolve_entry("service/src/server.mjs", "MIAO_SERVICE_ENTRY") {
            Ok(p) => p,
            Err(e) => {
                self.set_state(app, ServiceState::Error, Some(e));
                return;
            }
        };
        let mut envs: Vec<(String, String)> = Vec::new();
        if let Some(p) = sidecar_port {
            envs.push(("MIAO_ENGINE_PORT".into(), p.to_string()));
        }
        // 🔴 上面起的是**模拟引擎**（`engine/src/server.mjs`，ver1.0 自定义协议），而
        // `service/src/config.mjs` 的默认协议是 `real`（真实 manga-image-translator）。
        // 起的是替身就必须显式声明 —— 否则适配层会拿真实协议去打模拟引擎，探测恒 `starting`、
        // 提交恒 503，且**看不出根因**。
        // ⚠️ S2（三进程生命周期）改为起真实引擎时，**必须删掉这一行**（`real` 才是生产默认）。
        envs.push(("MIAO_ENGINE_PROTOCOL".into(), "mock".into()));
        let (child, ready_rx) = match spawn_node(&service_entry, &envs, &log) {
            Ok(v) => v,
            Err(e) => {
                self.set_state(app, ServiceState::Error, Some(format!("服务启动失败：{e}")));
                return;
            }
        };

        match wait_ready(&ready_rx, Duration::from_secs(20)) {
            Ok(v) => {
                let port = v.get("port").and_then(|x| x.as_u64()).map(|x| x as u16);
                let token = v.get("token").and_then(|x| x.as_str()).map(|s| s.to_string());
                let root_dir = v.get("rootDir").and_then(|x| x.as_str()).map(|s| s.to_string());
                {
                    let mut g = self.inner.lock().unwrap();
                    g.children.service = Some(child);
                    g.port = port;
                    g.token = token;
                    g.root_dir = root_dir;
                    g.sidecar_port = sidecar_port;
                    g.last_error = None;
                    for line in &report {
                        push_log(&g.log, &format!("[miao-dock] {line}"));
                    }
                }
                self.set_state(app, ServiceState::Running, None);
            }
            Err(e) => {
                let mut child = child;
                let _ = child.kill();
                self.set_state(app, ServiceState::Error, Some(format!("服务未就绪：{e}")));
            }
        }
    }

    /// 停止两个子进程并等待退出（SIGTERM 不行则 SIGKILL）
    pub fn stop(&self) {
        let (mut service, mut engine) = {
            let mut g = self.inner.lock().unwrap();
            (g.children.service.take(), g.children.engine.take())
        };
        for child in [service.as_mut(), engine.as_mut()].into_iter().flatten() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let mut g = self.inner.lock().unwrap();
        g.state = ServiceState::Stopped;
        g.port = None;
        g.token = None;
        g.sidecar_port = None;
        g.last_error = None;
    }
}

// ------------------------------------------------------------------ 子进程工具

fn push_log(log: &Arc<Mutex<VecDeque<String>>>, line: &str) {
    let mut l = log.lock().unwrap();
    if l.len() >= LOG_CAPACITY {
        l.pop_front();
    }
    l.push_back(line.to_string());
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
type Spawned = (Child, ReadyRx);

/// 拉起 `node <entry>`，持续把 stdout/stderr 收进日志；就绪行（含 `{...}` 的那行）经 channel 回传
fn spawn_node(
    entry: &PathBuf,
    envs: &[(String, String)],
    log: &Arc<Mutex<VecDeque<String>>>,
) -> Result<Spawned, String> {
    let (tx, rx) = mpsc::channel::<serde_json::Value>();
    let mut cmd = Command::new("node");
    cmd.arg(entry)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法执行 node（PATH 中未找到？）：{e}"))?;

    if let Some(out) = child.stdout.take() {
        let log = log.clone();
        let tx = tx.clone();
        thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Some(idx) = line.find('{') {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line[idx..]) {
                        let _ = tx.send(v);
                    }
                }
                push_log(&log, &line);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let log = log.clone();
        thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                push_log(&log, &format!("[stderr] {line}"));
            }
        });
    }
    Ok((child, rx))
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
