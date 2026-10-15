// mangasvc/engine/supervisor.rs —— 引擎③（LLM / llama-server）的生命周期持有者（F4-b2）
//
// 移植自 `service/src/settings/llm-supervisor.mjs`（366 行）。角色/归属理由见该文件头：
//   · 归属 manga-service：Tier1 空闲卸载（空闲 5min → 停 ③）的**判据只存在于队列所在的这一侧**；
//   · E11「不留孤儿」：真档用 `engine/scripts/child-watch.mjs` 把 llama-server 包一层
//     （外部二进制改不了、指望不上它自己看住 ppid）；mock 档替身自带 `parent-watch.mjs`；
//   · 状态机 `stopped → starting → running → unloading → stopped`，异常进 `error`
//     （⚠️ **不是**客户端状态机 —— 只喂 `sidecar.llm.state` 一个诊断字段）。
//
// ## 与 Node 的两处结构性差异（都已论证，不是偷懒）
// ① **串行链**：Node 用 `this._op = _op.then(...)` 把「会改进程状态的操作」串起来，防的是
//    「`_doStop` 的 await 窗口里插进一个 `start`」⇒ 状态被抹、**孤儿进程**（本项目最忌的静默故障）。
//    Rust 用两层锁复刻：`op` 互斥（等价 FIFO，一次只跑一个操作）+ `diag` 互斥（**只存诊断快照**，
//    随时可读）。若把二者合一，`start` 等就绪最长达 180s 会**阻塞 `snapshot()`** ⇒
//    `/engine/status` 整个卡死 —— 那正是「状态说没有、实际有」的另一种面目。
// ② **子进程标准流**：Node `stdio: ['ignore','pipe','pipe']` + 事件回调把 ③ 的日志转进 manga-service
//    stdout。Rust 侧起两个**排空线程**（不能不管：pipe 缓冲写满会让子进程阻塞），同样拼成
//    `[llm] …` / `[llm:err] …` 落进环形日志。
//
// ## 反证钩子（env）—— 全部只用于 `check:llm-supervisor:refute`，生产不设
//   · `MIAO_LLM_NO_WAIT_READY=1` —— 不等就绪探针就置 `running`（「没起也说起了」）
//   · `MIAO_LLM_PROBE_ALWAYS_OK=1` —— 探针恒真（把「端口没开」伪装成「已就绪」）
//   · `MIAO_LLM_NO_KILL=1` —— `stop` 既不终止子进程也不等退出（「我以为它退了」）
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::platform::child_watch::hide_console;
use serde_json::{json, Value};

use super::{env_bool, env_str, resolve_llm_launch, EngineError, LaunchSpec, LlmLaunchOverrides};

/// `sidecar.llm.state` 的取值（沿用 §5.1 `sidecar.state` 的枚举词表）。
pub const LLM_STATES: [&str; 5] = ["stopped", "starting", "running", "unloading", "error"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmState {
    Stopped,
    Starting,
    Running,
    Unloading,
    Error,
}

impl LlmState {
    pub fn as_str(&self) -> &'static str {
        match self {
            LlmState::Stopped => "stopped",
            LlmState::Starting => "starting",
            LlmState::Running => "running",
            LlmState::Unloading => "unloading",
            LlmState::Error => "error",
        }
    }
}

/// 父死看守器的**宿主可执行**（A3c）—— 与 `mangasvc` 同一个二进制。
///
/// 🔴 寻址口径必须与 app 侧 `service.rs::watch_host` **完全一致**
///    （`MIAO_MANGASVC_BIN` → 与本可执行同目录 → 报错），否则会出现"服务起得来
///    但 ③ 拉不起来"的错位 —— 而这在开发态的报错是 `③ 未在 180s 内就绪`，离根因极远。
pub fn watch_host() -> std::path::PathBuf {
    if let Some(p) = env_str("MIAO_CHILD_WATCH_HOST") {
        return std::path::PathBuf::from(p);
    }
    // 宿主就是 mangasvc 自己 ⇒ `current_exe()` 已经是答案（e2e / 打包都成立）。
    // 开发态若只 build 了主 bin（`miao-dock.exe`）而没有 mangasvc，则同目录找不到 ——
    // 那时 `do_start` 的存在性检查会给出可读的错误，而不是让 spawn 报一句含糊的失败。
    std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("mangasvc"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn sleep_ms(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

/// Node `path.basename` 在 Windows 上按 `/` 与 `\` **两种**分隔符切 —— 手工实现以**避开**
/// Rust `Path::file_name` 在 `sakura-mock:tiny` 这类含 `:` 串上的盘符前缀解析差异。
fn basename(p: &str) -> String {
    let trimmed = p.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(trimmed)
        .to_string()
}

fn strip_gguf(s: &str) -> String {
    if s.to_lowercase().ends_with(".gguf") {
        s[..s.len() - 5].to_string()
    } else {
        s.to_string()
    }
}

/// 从配方里取「人可读的模型标识」（`/engine/status` 的 `llm.model` 用它）。
///
/// 优先取配方**显式声明**的 `model`（`resolve_llm_launch` 已算好，含档位信息），其次才从命令行
/// 反解 —— 反解是对**已发生的事**做字符串考古，容易在换参数时失真。
///
/// 🔴 两条分支必须**同形态**：真档的 `launch.model` 是**绝对路径**（`tier_model_path()` 给的是
///    盘上路径），必须 `basename` 之后再用 —— 否则 `/health.sidecar.model` 会把
///    `…/models/sakura/sakura-…-fp16` 整个泄出去（契约 §5.1 的示例是 model id）。
pub fn model_id_of(launch: &LaunchSpec) -> Option<String> {
    if let Some(m) = launch.model.as_ref().filter(|s| !s.is_empty()) {
        return Some(strip_gguf(&basename(m)));
    }
    let cmd = &launch.cmd;
    let file = cmd.iter().position(|x| x == "-m").and_then(|i| cmd.get(i + 1));
    file.map(|f| strip_gguf(&basename(f)))
}

/// 配方里**第一个带整数 `port` 的探针**的端口（就绪探针与端口释放回探都用它）。
pub fn first_probe_port(launch: &LaunchSpec) -> Option<u16> {
    launch
        .probes
        .iter()
        .find_map(|p| p.get("port").and_then(|v| v.as_u64()).map(|n| n as u16))
}

// ================================================================ 探针（同步；Node 侧是 net/http）

fn hook_probe_always_ok() -> bool {
    env_bool("MIAO_LLM_PROBE_ALWAYS_OK", false)
}

/// TCP 可连即「在听」。Node `net.connect` + `setTimeout`。
fn probe_tcp(port: u16, timeout_ms: u64) -> bool {
    if hook_probe_always_ok() {
        return true;
    }
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms)).is_ok()
}

/// 最小 HTTP 状态码探测（Node 侧 `http.request` + `res.statusCode === expect`）。
/// 用裸 `TcpStream` 而非 reqwest：探针只关心**第一行状态码**，且必须与 supervisor 同步风格一致
/// （reqwest::blocking 不能在 tokio 运行期内调用，会把「能不能探测」变成「在哪个线程探测」）。
fn probe_http(port: u16, method: &str, path: &str, expect: u16, timeout_ms: u64) -> bool {
    if hook_probe_always_ok() {
        return true;
    }
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(timeout_ms)));
    let _ = s.set_write_timeout(Some(Duration::from_millis(timeout_ms)));
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let Ok(n) = s.read(&mut buf) else {
        return false;
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    let mut parts = head.split_whitespace();
    let _proto = parts.next();
    match parts.next().and_then(|c| c.parse::<u16>().ok()) {
        Some(code) => code == expect,
        None => false,
    }
}

/// 等进程真的退出（Node `waitExit`）。轮询 `try_wait` 即「听 `exit` 事件」的等价物。
fn wait_exit(child: &mut Child, timeout_ms: u64) -> bool {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return true;
    }
    let until = now_ms() + timeout_ms as i64;
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return true;
        }
        if now_ms() > until {
            return false;
        }
        sleep_ms(50);
    }
}

/// 等端口**真的**释放（内核回收 socket 有窗口）—— 「卸载后立刻重启」必须靠它才不撞车。
fn wait_port_free(port: Option<u16>, timeout_ms: u64) -> bool {
    let Some(port) = port else { return true };
    let until = now_ms() + timeout_ms as i64;
    loop {
        if !probe_tcp(port, 200) {
            return true;
        }
        if now_ms() > until {
            return false;
        }
        sleep_ms(150);
    }
}

// ================================================================ 进程终止

/// 优雅终止：POSIX 发 SIGTERM（Node `child.kill('SIGTERM')` 的对应物）。
/// Windows 没有「优雅」这一档（D-89）：`Child::kill` = `TerminateProcess`，与 Node 的 SIGTERM 落地同。
#[cfg(unix)]
fn terminate(child: &mut Child) {
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
}
#[cfg(not(unix))]
fn terminate(child: &mut Child) {
    let _ = child.kill();
}

// ================================================================ 内部状态

struct Inner {
    launch: LaunchSpec,
    watch: bool,
    model: Option<String>,
    port: Option<u16>,
    child: Option<Child>,
    /// 🔴 **父死通道的写端**（A3c）。`watch` 档下必须**一直攥着**：它是"父进程还活着"
    ///   的唯一证据 —— 一旦 drop，内核关闭最后一个写端 ⇒ 看守器读到 EOF ⇒ 自杀，
    ///   症状是「③ 每次拉起都立刻死」而报错停在「未在 180s 内就绪」，离根因极远。
    _watch_keepalive: Option<std::process::ChildStdin>,
    pid: Option<u32>,
    state: LlmState,
    last_error: Option<String>,
    started_at: Option<i64>,
    /// 空闲卸载后重新拉起的次数（E6 取证用）。
    restarts: u32,
}

/// `/engine/status` 的 `llm` 字段（也喂 `sidecar.llm`）—— 与 Node `snapshot()` 同形。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LlmSnapshot {
    pub state: String,
    pub model: Option<String>,
    /// `state === 'stopped'` ⇒ `null`（不是 0，也不是上次的端口）。
    pub port: Option<u16>,
    pub pid: Option<u32>,
}

impl LlmSnapshot {
    /// 「③ 未持有」时的快照 —— 与 Node `LlmSupervisor.snapshot()` 的初值同形。
    /// 上层（`Shell`）在 supervisor 尚未构造出来时用它，免得 `sidecar.llm` 出现 `null`（契约里它是对象）。
    pub fn stopped() -> Self {
        LlmSnapshot { state: "stopped".to_string(), model: None, port: None, pid: None }
    }
}

/// `stop()` 的返回值（Node：`{stopped:false, why}` | `{stopped:true, exited, portFreed}`）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopResult {
    pub stopped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exited: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port_freed: Option<bool>,
}

fn snapshot_of(inner: &Inner) -> LlmSnapshot {
    LlmSnapshot {
        state: inner.state.as_str().to_string(),
        model: inner.model.clone(),
        port: if inner.state == LlmState::Stopped { None } else { inner.port },
        pid: inner.pid,
    }
}

/// 诊断快照的发布（**不加 op 锁**）—— 复刻「`snapshot()` 不过 `_serial`」。
fn publish(diag: &Mutex<LlmSnapshot>, inner: &Inner) {
    if let Ok(mut d) = diag.lock() {
        *d = snapshot_of(inner);
    }
}

/// 日志汇聚处（Node `opts.log` 回调的对应物）。
///
/// 🔴 `verbose` 是一道**必要的**开关：Node 侧 supervisor 的 `log` 直连 `serverLog`（stdout），
///    而 Rust 侧 `--llm-selftest` 的输出必须**是纯 JSON**（对拍脚本 `JSON.parse(stdout)`）。
///    ⇒ 服务路径（`from_default`）verbose=true（与 Node 同：日志进 stdout）；
///      自证路径（`with_launch`）verbose=false（只进环形缓冲，不污染 stdout）。
#[derive(Default)]
pub struct LogSink {
    pub lines: Vec<String>,
    pub verbose: bool,
}

fn log(logs: &Arc<Mutex<LogSink>>, line: String) {
    if let Ok(mut v) = logs.lock() {
        if v.verbose {
            println!("{line}");
        }
        v.lines.push(line);
    }
}

fn opt_str<T: std::fmt::Display>(o: &Option<T>) -> String {
    match o {
        Some(v) => v.to_string(),
        None => "null".to_string(),
    }
}

// ================================================================ 生命周期操作（自由函数，避免借用冲突）

fn op_start(logs: &Arc<Mutex<LogSink>>, diag: &Mutex<LlmSnapshot>, inner: &mut Inner, timeout_ms: u64) {
    if inner.state == LlmState::Running {
        return;
    }
    match do_start(logs, diag, inner, timeout_ms) {
        Ok(()) => {}
        Err(msg) => {
            inner.state = LlmState::Error;
            inner.last_error = Some(msg.clone());
            publish(diag, inner); // 失败也是一次**状态迁移** ⇒ 同样要落到诊断快照
            log(logs, format!("[manga-service] ③ LLM 拉起失败：{msg}"));
        }
    }
}

fn do_start(
    logs: &Arc<Mutex<LogSink>>,
    diag: &Mutex<LlmSnapshot>,
    inner: &mut Inner,
    timeout_ms: u64,
) -> Result<(), String> {
    inner.state = LlmState::Starting;
    inner.last_error = None;
    // 🔴 状态一改就发布。`do_start` 里有**长等待**（等就绪探针，真档可达分钟级），
    //    只在函数收尾发布的话，这段窗口内诊断快照会停在旧态（例如 `stopped`），
    //    而 `/engine/status` 与 `snapshot()` 都会照着旧态答 —— Node 那边 `state` 是
    //    唯一事实源、改了就可见，不存在这个滞后。见 `do_stop` 的同款注释。
    publish(diag, inner);

    // 🔴 起进程**之前**先确认看护器**宿主**真的在盘上。少了这一步，「路径算错/文件被移走」
    //    的表现是子进程瞬时退出、而 supervisor 只报一句「未在 180s 内就绪」
    //    —— 把「宿主找不到」伪装成「模型加载慢/超时」。
    let host = watch_host();
    if inner.watch && !host.is_file() {
        return Err(format!(
            "③ 看守器宿主不存在：{}（先 cargo build --bin mangasvc，或设 MIAO_CHILD_WATCH_HOST）",
            host.display()
        ));
    }

    let (head, args): (String, Vec<String>) = if inner.watch {
        // A3c：看守器 = `mangasvc --child-watch`，与宿主同一个可执行文件（零新增随包物）
        let mut a = vec!["--child-watch".to_string(), "--".to_string()];
        a.extend(inner.launch.cmd.iter().cloned());
        (host.to_string_lossy().into_owned(), a)
    } else {
        let mut it = inner.launch.cmd.iter().cloned();
        let head = it.next().ok_or_else(|| "配方 cmd 为空".to_string())?;
        (head, it.collect())
    };

    let mut shown = vec![head.clone()];
    shown.extend(args.iter().cloned());
    log(logs, format!("[manga-service] 拉起 ③ LLM：{}", shown.join(" ")));

    let mut cmd = Command::new(&head);
    cmd.args(&args);
    if let Some(cwd) = inner.launch.cwd.as_ref() {
        cmd.current_dir(cwd);
    }
    for (k, v) in &inner.launch.env {
        cmd.env(k, v);
    }
    // 🔴 `watch` 档要留一根**空管道**当父死通道（A3c）：写端由本进程攥住（见 `_watch_keepalive`），
    //    看守器从它的 stdin 读到 EOF ⇒ 判定「父进程已死」⇒ 带走整棵子树。
    //    ⚠️ 这里**不能**给 `Stdio::null()`：那样看守器一起来就 EOF ⇒ 每次拉起都自杀，
    //    症状是「③ 每次拉起都立刻死」而报错停在「未在 180s 内就绪」，离根因极远。
    //    非 watch 档（mock 替身自带父死看管）维持 null。
    if inner.watch {
        cmd.stdin(Stdio::piped());
        // 🔴 **必须同时声明** `MIAO_CHILD_WATCH_PIPE=1`（A3c）：看守器据此认定
        //    「stdin 的 EOF 是父死的权威证据」。缺了它就只剩 ppid 轮询，而 Windows 上
        //    父进程退出后 ppid 冻结、pid 未回收 ⇒ 永远判不出父死 ⇒ ③ 拉起后
        //    manga-service 一死 llama-server 就变孤儿占着 8080（E11 静默失效）。
        cmd.env("MIAO_CHILD_WATCH_PIPE", "1");
    } else {
        cmd.stdin(Stdio::null());
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    // 🔴 ③ `llama-server` / ② `python main.py` 都是**控制台程序**，而父进程（喵坞 /
    //    mangasvc）在 Windows 上没有控制台 ⇒ 不带这个标志会**新开一个黑框**
    //    （"打开喵坞弹两个命令行窗口"的第二个）。
    hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let _watch_keepalive = child.stdin.take();

    if let Some(out) = child.stdout.take() {
        let lg = logs.clone();
        std::thread::spawn(move || relay(BufReader::new(out), lg, ""));
    }
    if let Some(err) = child.stderr.take() {
        let lg = logs.clone();
        std::thread::spawn(move || relay(BufReader::new(err), lg, "err"));
    }

    inner.pid = Some(child.id());
    inner.started_at = Some(now_ms());
    inner.child = Some(child);
    inner._watch_keepalive = _watch_keepalive;

    let ok = wait_ready(logs, inner, timeout_ms);
    if !ok {
        // 起不来不阻断服务本身：没有 LLM 只是翻译阶段会失败（S2 的崩溃分级口径）。
        // ⚠️ 调 `do_stop`（内部实现）而非公开 `stop()` —— 后者会再进一次串行链 = 自己等自己。
        do_stop(logs, diag, inner, "启动超时", 8000);
        return Err(format!(
            "③ LLM 未在 {}s 内就绪",
            (timeout_ms as f64 / 1000.0).round() as i64
        ));
    }
    inner.state = LlmState::Running;
    log(
        logs,
        format!(
            "[manga-service] ③ LLM 就绪：{} @ {}（pid={}）",
            opt_str(&inner.model),
            opt_str(&inner.port),
            opt_str(&inner.pid)
        ),
    );
    Ok(())
}

/// 把子进程的标准流转进环形日志（Node 的 `relay`）。
fn relay(reader: BufReader<impl Read>, logs: Arc<Mutex<LogSink>>, tag: &str) {
    for line in reader.lines().map_while(Result::ok) {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let line = if tag.is_empty() {
            format!("[llm] {t}")
        } else {
            format!("[llm:{tag}] {t}")
        };
        log(&logs, line);
    }
}

fn wait_ready(logs: &Arc<Mutex<LogSink>>, inner: &mut Inner, timeout_ms: u64) -> bool {
    if env_bool("MIAO_LLM_NO_WAIT_READY", false) {
        return true; // 反证：不等就绪就宣布就绪
    }
    let probes: Vec<Value> = if !inner.launch.probes.is_empty() {
        inner.launch.probes.clone()
    } else {
        vec![
            json!({ "kind": "tcp", "port": inner.port }),
            json!({ "kind": "http", "port": inner.port, "method": "GET", "path": "/v1/models", "expect": 200 }),
        ]
    };
    let until = now_ms() + timeout_ms as i64;
    let started = now_ms();
    let mut announced = false;
    loop {
        // 进程已经死了就别再等满超时（否则「端口被占/参数写错」要等 3 分钟才报）
        match inner.child.as_mut() {
            Some(c) => {
                if matches!(c.try_wait(), Ok(Some(_))) {
                    return false;
                }
            }
            None => return false,
        }
        let mut all = true;
        for p in &probes {
            let kind = p.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let port = p.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let ok = if kind == "tcp" {
                probe_tcp(port, 300)
            } else {
                let method = p.get("method").and_then(|v| v.as_str()).unwrap_or("GET");
                let path = p.get("path").and_then(|v| v.as_str()).unwrap_or("/");
                let expect = p.get("expect").and_then(|v| v.as_u64()).unwrap_or(200) as u16;
                probe_http(port, method, path, expect, 300)
            };
            if !ok {
                all = false;
                break;
            }
        }
        if all {
            return true;
        }
        if now_ms() > until {
            return false;
        }
        if !announced && now_ms() - started > 8000 {
            announced = true;
            log(
                logs,
                format!(
                    "[manga-service] ③ LLM 仍在启动（模型加载中）… 已等 {}s",
                    (now_ms() - started) / 1000
                ),
            );
        }
        sleep_ms(250);
    }
}

/// 停 ③ 并**等它真的退出、端口真的释放**。「真的退出」是本模块唯一重要的语义：
/// §9.4 明说「卸载 ≠ 未就绪」，而「我以为它退了」与「它退了」的区别，只有等 `exit` + 回探端口能分开。
fn do_stop(
    logs: &Arc<Mutex<LogSink>>,
    diag: &Mutex<LlmSnapshot>,
    inner: &mut Inner,
    reason: &str,
    grace_ms: u64,
) -> StopResult {
    if inner.child.is_none() {
        inner.state = LlmState::Stopped;
        inner.pid = None;
        publish(diag, inner);
        return StopResult {
            stopped: false,
            why: Some("未在运行".to_string()),
            exited: None,
            port_freed: None,
        };
    }
    inner.state = LlmState::Unloading;
    // 🔴 状态一改就发布（理由同 `do_start`）：从这里到最后那句 `state = Stopped` 之间，
    //    有两段**真实等待**（等子进程退出 + 回探端口释放，本机实测数百 ms）。若只在收尾发布，
    //    这段窗口内诊断快照会**停在 `running`** —— 而"③ 其实正在被拆掉"与"③ 好好跑着"
    //    在外部看起来一模一样，正是本项目最忌讳的静默错报（曾据此误判 §9.3 懒加载无需拉起）。
    publish(diag, inner);
    log(
        logs,
        format!(
            "[manga-service] 停止 ③ LLM{}（pid={}）",
            if reason.is_empty() {
                String::new()
            } else {
                format!("（{reason}）")
            },
            opt_str(&inner.pid)
        ),
    );
    // 先摘引用，让 exit 语义不再改状态（Rust 无 exit 回调，`take()` 即等价物）
    let mut child = inner.child.take().expect("已判非空");
    let pid = inner.pid;

    let (exited, freed) = if env_bool("MIAO_LLM_NO_KILL", false) {
        // 反证：既不终止子进程也不等它退出 —— 「我以为它退了」。
        (false, wait_port_free(inner.port, 300))
    } else {
        terminate(&mut child);
        let mut exited = wait_exit(&mut child, grace_ms);
        if !exited {
            log(
                logs,
                format!("[manga-service] ③ LLM 未在 {grace_ms}ms 内优雅退出 ⇒ SIGKILL"),
            );
            let _ = child.kill();
            exited = wait_exit(&mut child, 3000);
        }
        let freed = wait_port_free(inner.port, 5000);
        (exited, freed)
    };
    inner.pid = None;
    inner.state = LlmState::Stopped;
    // 🔴 父死通道写端在**停止动作完成之后**才清（A3c）。提前清会让看守器读到 EOF、
    //    抢先自杀去杀子树 —— 于是 `child.wait()` 拿到的是**看守器**的退出码而非
    //    llama-server 的，`exited` 语义静默失真（且与 `terminate()` 形成两路竞态）。
    //    停止之后再留着没有意义（下次 start 会覆盖它），清掉是为了不白占一个句柄。
    inner._watch_keepalive = None;
    log(
        logs,
        format!(
            "[manga-service] ③ LLM 已停止（pid={}；优雅退出={exited} 端口 {} 已释放={freed}）",
            opt_str(&pid),
            opt_str(&inner.port)
        ),
    );
    StopResult {
        stopped: true,
        why: None,
        exited: Some(exited),
        port_freed: Some(freed),
    }
}

fn use_tier_inner(logs: &Arc<Mutex<LogSink>>, inner: &mut Inner, tier: &str) -> Result<(), EngineError> {
    if inner.state != LlmState::Stopped {
        return Err(EngineError::new(
            "LLM_NOT_STOPPED",
            format!(
                "换档位必须在 stopped 状态（当前 {}）—— 否则配方换了但进程没换",
                inner.state.as_str()
            ),
        ));
    }
    let o = LlmLaunchOverrides {
        tier: Some(tier.to_string()),
        ..Default::default()
    };
    let launch = resolve_llm_launch(&o)?;
    inner.model = model_id_of(&launch);
    inner.port = first_probe_port(&launch);
    inner.launch = launch;
    log(logs, format!("[manga-service] ③ 配方切到档位 {tier}：{}", opt_str(&inner.model)));
    Ok(())
}

// ================================================================ 公开 API

/// 引擎③ 的生命周期持有者。
pub struct LlmSupervisor {
    /// 串行链：所有「会改进程状态」的操作在此互斥（Node `_serial` 的对应物）。
    op: Mutex<Inner>,
    /// 诊断快照：**不参与串行**，`snapshot()` 随时可读。
    diag: Mutex<LlmSnapshot>,
    /// ③ 的日志（Node `opts.log` 回调收集处）。
    logs: Arc<Mutex<LogSink>>,
}

impl LlmSupervisor {
    /// 用**显式配方**构造（对拍/上层注入用）。日志只进环形缓冲、**不进 stdout**
    /// （对拍脚本要 `JSON.parse(stdout)`，多一行日志就解析失败）。
    pub fn with_launch(launch: LaunchSpec, watch: bool) -> Self {
        Self::with_launch_verbose(launch, watch, false)
    }

    /// 同 [`Self::with_launch`]，但可指定是否把日志同时打进 stdout（服务路径用 `true`）。
    pub fn with_launch_verbose(launch: LaunchSpec, watch: bool, verbose: bool) -> Self {
        let model = model_id_of(&launch);
        let port = first_probe_port(&launch);
        let diag = LlmSnapshot {
            state: "stopped".to_string(),
            model: model.clone(),
            // stopped ⇒ port 为 null（同 Node `snapshot()` 初值，不是配方里的端口）
            port: None,
            pid: None,
        };
        Self {
            op: Mutex::new(Inner {
                launch,
                watch,
                model,
                port,
                child: None,
                _watch_keepalive: None,
                pid: None,
                state: LlmState::Stopped,
                last_error: None,
                started_at: None,
                restarts: 0,
            }),
            diag: Mutex::new(diag),
            logs: Arc::new(Mutex::new(LogSink { lines: Vec::new(), verbose })),
        }
    }

    /// 缺省：配方由 `resolveLlmLaunch()` 给（按协议自动选 real/mock），真档才包 child-watch。
    /// 🔴 `verbose = true`：服务路径下 supervisor 的日志必须与 Node 一样出现在 **stdout**
    ///    —— e5e6 的「③ LLM 就绪（pid=…）」现场凭证就是按 stdout 抓的。
    pub fn from_default() -> Result<Self, EngineError> {
        let launch = resolve_llm_launch(&LlmLaunchOverrides::default())?;
        Ok(Self::with_launch_verbose(launch, !super::is_mock_protocol(), true))
    }

    /// 机器可读快照 —— 直接喂 `sidecar.llm` / `/engine/status` 的 `llm` 字段。
    pub fn snapshot(&self) -> LlmSnapshot {
        self.diag
            .lock()
            .map(|d| d.clone())
            .unwrap_or(LlmSnapshot {
                state: "stopped".to_string(),
                model: None,
                port: None,
                pid: None,
            })
    }

    pub fn is_running(&self) -> bool {
        self.snapshot().state == "running"
    }

    /// 最近一次失败原因（Node `this.lastError`；不进程快照，单独暴露）。
    pub fn last_error(&self) -> Option<String> {
        self.op.lock().ok().and_then(|i| i.last_error.clone())
    }

    pub fn restarts(&self) -> u32 {
        self.op.lock().map(|i| i.restarts).unwrap_or(0)
    }

    /// ③ 的日志行（`[llm] …` / `[llm:err] …` / supervisor 事件）。
    pub fn logs(&self) -> Vec<String> {
        self.logs.lock().map(|v| v.lines.clone()).unwrap_or_default()
    }

    /// 拉起 ③ 并等就绪探针全绿。并发调用由 `op` 锁排队：后一个进入时若前一个已把它拉起
    /// （`state==='running'`），直接复用，不会拉起两个。
    pub fn start(&self, timeout_ms: u64) -> LlmSnapshot {
        let mut inner = self.op.lock().expect("op 锁中毒");
        if inner.state == LlmState::Running {
            return snapshot_of(&inner);
        }
        op_start(&self.logs, &self.diag, &mut inner, timeout_ms);
        publish(&self.diag, &inner);
        snapshot_of(&inner)
    }

    pub fn stop(&self, reason: &str, grace_ms: u64) -> StopResult {
        let mut inner = self.op.lock().expect("op 锁中毒");
        let r = do_stop(&self.logs, &self.diag, &mut inner, reason, grace_ms);
        publish(&self.diag, &inner);
        r
    }

    /// 重新拉起（空闲卸载后的懒加载恢复 §9.3）。`restarts` 计数供 E6 取证。
    pub fn restart(&self, timeout_ms: u64) -> LlmSnapshot {
        let mut inner = self.op.lock().expect("op 锁中毒");
        inner.restarts += 1;
        op_start(&self.logs, &self.diag, &mut inner, timeout_ms);
        publish(&self.diag, &inner);
        snapshot_of(&inner)
    }

    /// 换档位并重启 —— **一次原子操作**（`_doStop → 换配方 → _startInner` 同一串行链）。
    /// 不让调用方自己拼 `stop(); useTier(t); start();`：那三步之间各有 await，任何外来
    /// `start/stop` 插进来都会让「配方的档位」与「实际跑着的权重」分家。
    pub fn switch_tier(&self, tier: &str, timeout_ms: u64) -> Result<LlmSnapshot, EngineError> {
        let mut inner = self.op.lock().expect("op 锁中毒");
        do_stop(&self.logs, &self.diag, &mut inner, &format!("降档到 {tier}"), 5000);
        if let Err(e) = use_tier_inner(&self.logs, &mut inner, tier) {
            publish(&self.diag, &inner);
            return Err(e);
        }
        op_start(&self.logs, &self.diag, &mut inner, timeout_ms);
        publish(&self.diag, &inner);
        Ok(snapshot_of(&inner))
    }

    /// 换档位（只**改配方**，什么时候重启由调用方决定）。
    /// ⚠️ 两个前置条件没有运行时兜底：① 只在 `stopped` 调用（否则抛）；② 只在串行链内调用
    ///    （正常入口是 `switch_tier`）。
    pub fn use_tier(&self, tier: &str) -> Result<(), EngineError> {
        let mut inner = self.op.lock().expect("op 锁中毒");
        let r = use_tier_inner(&self.logs, &mut inner, tier);
        publish(&self.diag, &inner);
        r
    }

    /// 当前配方（诊断/`print-launch-plan` 用）。
    pub fn launch(&self) -> LaunchSpec {
        self.op.lock().map(|i| i.launch.clone()).unwrap_or_else(|_| {
            LaunchSpec {
                label: "llm".to_string(),
                tier: None,
                model: None,
                cmd: Vec::new(),
                cwd: None,
                env: Default::default(),
                executor_port: None,
                probes: Vec::new(),
            }
        })
    }
}

// ================================================================ 自证（--llm-selftest）
//
// 驱动 supervisor **真起一个子进程**（对拍时喂 mock-llm），把可观测行为归一化成一份 JSON。
// 归一化的目的：让 Rust 与 Node 的输出**逐字节可比**，把「端口/pid 这类必然不同的数」换成
// 「是不是整数/是否等于配方里的端口」，只留**行为语义**在同一位面上。

/// 输入：`{ "cases": [ { name, scenario, watch, timeoutMs, spec } ] }`
/// 输出：`{ "results": [ { name, states, model, portMatchesSpec, pidIsInt, stopResult, errorPresent, pidStable } ] }`
pub fn selftest_run(spec: &Value) -> Value {
    let cases = spec
        .get("cases")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let results: Vec<Value> = cases.iter().map(run_case).collect();
    json!({ "results": results })
}

fn run_case(c: &Value) -> Value {
    let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let scenario = c.get("scenario").and_then(|v| v.as_str()).unwrap_or("ready");
    let watch = c.get("watch").and_then(|v| v.as_bool()).unwrap_or(false);
    let timeout = c.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(10_000);

    let launch: LaunchSpec = match c.get("spec") {
        Some(v) => match serde_json::from_value(v.clone()) {
            Ok(l) => l,
            Err(e) => {
                return json!({
                    "name": name,
                    "states": Vec::<String>::new(),
                    "model": Value::Null,
                    "portMatchesSpec": Value::Null,
                    "pidIsInt": Value::Null,
                    "stopResult": Value::Null,
                    "errorPresent": true,
                    "pidStable": Value::Null,
                    "parseError": e.to_string(),
                })
            }
        },
        None => LaunchSpec {
            label: "llm".to_string(),
            tier: None,
            model: None,
            cmd: Vec::new(),
            cwd: None,
            env: Default::default(),
            executor_port: None,
            probes: Vec::new(),
        },
    };

    let expected_port = first_probe_port(&launch);
    let sup = LlmSupervisor::with_launch(launch, watch);
    let mut states = vec![sup.snapshot().state];
    let mut port_matches: Value = Value::Null;
    let mut pid_is_int: Value = Value::Null;
    let mut stop_result: Value = Value::Null;
    let mut pid_stable: Value = Value::Null;
    let mut restarts: Value = Value::Null;
    let mut pid_changed: Value = Value::Null;

    match scenario {
        "ready" => {
            let s1 = sup.start(timeout);
            states.push(s1.state.clone());
            port_matches = Value::Bool(s1.port == expected_port);
            pid_is_int = Value::Bool(s1.pid.is_some());
            let r = sup.stop("", 8000);
            stop_result = serde_json::to_value(&r).unwrap_or(Value::Null);
            states.push(sup.snapshot().state);
        }
        "never-ready" => {
            let s1 = sup.start(timeout);
            states.push(s1.state.clone());
            sup.stop("", 8000); // 收尾
            states.push(sup.snapshot().state);
        }
        "double-start" => {
            let s1 = sup.start(timeout);
            states.push(s1.state.clone());
            port_matches = Value::Bool(s1.port == expected_port);
            pid_is_int = Value::Bool(s1.pid.is_some());
            let s2 = sup.start(timeout);
            states.push(s2.state.clone());
            pid_stable = Value::Bool(s1.pid == s2.pid);
            sup.stop("", 8000);
        }
        "stop-when-stopped" => {
            let r = sup.stop("", 8000);
            stop_result = serde_json::to_value(&r).unwrap_or(Value::Null);
            states.push(sup.snapshot().state);
        }
        // 懒加载恢复（§9.3）：停掉之后必须能**重新真拉起**，且新 pid 与旧的不同。
        // 只报数不真拉起（`restart` 里漏掉 `op_start`）是最容易犯的错，故把 `pidChanged` 一并取证。
        "restart" => {
            let s1 = sup.start(timeout);
            states.push(s1.state.clone());
            port_matches = Value::Bool(s1.port == expected_port);
            pid_is_int = Value::Bool(s1.pid.is_some());
            sup.stop("", 8000);
            states.push(sup.snapshot().state);
            let s2 = sup.restart(timeout);
            states.push(s2.state.clone());
            pid_changed = Value::Bool(match (s1.pid, s2.pid) {
                (Some(a), Some(b)) => a != b,
                _ => false,
            });
            port_matches = Value::Bool(s2.port == expected_port);
            restarts = json!(sup.restarts());
            sup.stop("", 8000);
            states.push(sup.snapshot().state);
        }
        _ => {}
    }

    let mut out = json!({
        "name": name,
        "states": states,
        "model": sup.snapshot().model,
        "portMatchesSpec": port_matches,
        "pidIsInt": pid_is_int,
        "stopResult": stop_result,
        "errorPresent": sup.last_error().is_some(),
        "pidStable": pid_stable,
    });
    // 🔴 只给 `restart` 用例加这两把尺子：给**全部**用例加 Null 会改掉既有 golden 的形状，
    //    让"重启可观测"这条断言顺带把另外四个用例的基线也搅动一遍（改了不该改的东西）。
    if scenario == "restart" {
        out["restarts"] = restarts;
        out["pidChanged"] = pid_changed;
    }
    out
}

// ================================================================ 单测

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(model: Option<&str>, cmd: Vec<&str>, probes: Vec<Value>) -> LaunchSpec {
        LaunchSpec {
            label: "llm".to_string(),
            tier: Some("tiny".to_string()),
            model: model.map(|s| s.to_string()),
            cmd: cmd.into_iter().map(|s| s.to_string()).collect(),
            cwd: None,
            env: Default::default(),
            executor_port: None,
            probes,
        }
    }

    #[test]
    fn model_id_takes_basename_of_explicit_model() {
        // 真档：model 是**绝对路径** ⇒ 必须 basename + 去 .gguf（否则整个路径泄出去）
        let l = spec(
            Some("/runtimes/manga-translator/models/sakura/sakura-1.5b-qwen2.5-v1.0-fp16.gguf"),
            vec!["llama-server", "-m", "/x/y.gguf"],
            vec![],
        );
        assert_eq!(model_id_of(&l).as_deref(), Some("sakura-1.5b-qwen2.5-v1.0-fp16"));
    }

    #[test]
    fn model_id_falls_back_to_cmd_dash_m() {
        let l = spec(None, vec!["/bin/llama-server", "-m", "D:\\m\\sakura-a.gguf", "-c", "4096"], vec![]);
        assert_eq!(model_id_of(&l).as_deref(), Some("sakura-a"));
    }

    #[test]
    fn model_id_none_when_nothing_declared() {
        let l = spec(None, vec!["/bin/llama-server", "--port", "8080"], vec![]);
        assert_eq!(model_id_of(&l), None);
    }

    #[test]
    fn model_id_keeps_colon_form_intact() {
        // mock 档的 `sakura-mock:tiny` 含 `:` —— basename 不得把它当盘符前缀切掉
        let l = spec(Some("sakura-mock:tiny"), vec!["node", "x.mjs"], vec![]);
        assert_eq!(model_id_of(&l).as_deref(), Some("sakura-mock:tiny"));
    }

    #[test]
    fn first_probe_port_picks_first_integer_port() {
        let l = spec(
            None,
            vec![],
            vec![
                json!({ "kind": "tcp", "port": 9001 }),
                json!({ "kind": "http", "port": 9002, "path": "/v1/models" }),
            ],
        );
        assert_eq!(first_probe_port(&l), Some(9001));
        let none = spec(None, vec![], vec![json!({ "kind": "tcp" })]);
        assert_eq!(first_probe_port(&none), None);
    }

    #[test]
    fn fresh_snapshot_is_stopped_with_null_port() {
        let l = spec(Some("sakura-mock:tiny"), vec![], vec![json!({ "kind": "tcp", "port": 9100 })]);
        let s = LlmSupervisor::with_launch(l, false);
        let snap = s.snapshot();
        assert_eq!(snap.state, "stopped");
        // model 已知但 state=stopped ⇒ port 必须 null（不是 9100）
        assert_eq!(snap.model.as_deref(), Some("sakura-mock:tiny"));
        assert_eq!(snap.port, None);
        assert_eq!(snap.pid, None);
        assert!(!s.is_running());
    }

    #[test]
    fn stop_when_not_running_reports_why() {
        let l = spec(None, vec!["node"], vec![]);
        let s = LlmSupervisor::with_launch(l, false);
        let r = s.stop("", 100);
        assert!(!r.stopped);
        assert_eq!(r.why.as_deref(), Some("未在运行"));
        assert_eq!(r.exited, None);
        assert_eq!(r.port_freed, None);
    }

    #[test]
    fn l0_watch_host_is_self_when_not_overridden() {
        // A3c：看守器宿主 = 与 `mangasvc` **同一个可执行文件**（零新增随包物）。
        // 寻址口径必须与 app 侧 `service.rs::watch_host` 一致；口径错了的表现是
        // 「服务起得来但 ③ 拉不起来」，而报错停在「未在 180s 内就绪」，离根因极远。
        if std::env::var("MIAO_CHILD_WATCH_HOST").is_ok() {
            return; // 环境覆盖态由 e2e 取证（env 是进程全局的，单测里不制造竞态）
        }
        let host = watch_host();
        assert_eq!(host, std::env::current_exe().unwrap(), "无覆盖时必须指向自身");
        assert!(host.is_file(), "宿主必须真实存在，否则 `do_start` 的存在性检查形同虚设");
    }

    #[test]
    fn use_tier_rejected_when_not_stopped() {
        let l = spec(Some("sakura-mock:tiny"), vec![], vec![]);
        let s = LlmSupervisor::with_launch(l, false);
        // 伪造「非 stopped」：直接改内部状态（测试专用）
        {
            let mut inner = s.op.lock().unwrap();
            inner.state = LlmState::Running;
        }
        let e = s.use_tier("small").unwrap_err();
        assert_eq!(e.code, "LLM_NOT_STOPPED");
    }

    #[test]
    fn start_reports_error_when_child_never_listens() {
        // 起了个永不监听端口的进程，超时很短 ⇒ 必须进 error 且带 lastError
        let child = if cfg!(windows) { "cmd" } else { "sleep" };
        let cmd = if cfg!(windows) {
            vec![child, "/C", "ping -n 30 127.0.0.1 >NUL"]
        } else {
            vec![child, "30"]
        };
        let l = spec(
            Some("n/a"),
            cmd,
            vec![json!({ "kind": "tcp", "port": 65000 })],
        );
        let s = LlmSupervisor::with_launch(l, false);
        let snap = s.start(600);
        assert_eq!(snap.state, "error");
        assert!(s.last_error().is_some());
    }
}
