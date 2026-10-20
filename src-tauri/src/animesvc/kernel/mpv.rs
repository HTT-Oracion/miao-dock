//! mpv 内核轨的**真后端**（JSON IPC 客户端 + 进程看守）。
//!
//! ## 形态：独立窗口播放
//! mpv 自己开一个窗口放画面，应用只经 IPC 驱动它（播放 / 暂停 / 跳转 / 倍速 / 切轨 / 字幕）。
//! 不做「把画面嵌进 WebView」：Tauri v2 的 WebView 是整窗的，`--wid` 嵌进同一个 HWND 会被
//! WebView 盖住或反过来盖住整个界面。嵌入式要等真正的 libmpv 渲染回调，属 R1 之后的独立一轮。
//! 因此前端会明说「画面在内核窗口」——不假装画面在应用里。
//!
//! ## 二进制从哪来
//! `MIAO_MPV_BIN` → 程序同级 → 随包资源 `mpv/<平台>/` → PATH。
//! 找不到时 `available:false` + 一句人话原因，**不**回一个播不出来的地址。
//!
//! ## 为什么状态是轮询 + 事件双通道
//! mpv 的 `property-change` 是推送的，但进程刚起来、属性还没就绪时不会有事件；
//! `open()` 里先 `observe_property` 再等一个短窗口，之后全靠事件。

use std::collections::HashMap;
use std::io::Write;
#[cfg(not(windows))]
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::ipc::{self, Incoming, Track};
use crate::animesvc::playback::{PlaybackCore, PlaybackSnapshot, Source, TrackKind};

/// 一条命令等回执的上限。mpv 回包是毫秒级；3 秒还没回来说明进程已经不对劲了。
const REPLY_TIMEOUT: Duration = Duration::from_secs(3);
/// 起播后等 `duration` 事件的上限（大文件探测索引要一点时间）。
const OPEN_WAIT: Duration = Duration::from_secs(3);

/// 内核探测结果（给前端与设置页看）。
#[derive(Debug, Clone)]
pub struct KernelInfo {
    pub available: bool,
    pub path: String,
    pub reason: String,
}

/// 内核当前状态（跨线程共享）。
#[derive(Debug, Clone, Default)]
pub struct KernelState {
    pub open: bool,
    pub file: String,
    pub title: String,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub playing: bool,
    pub buffered_ms: u64,
    pub rate: f64,
    pub tracks: Vec<Track>,
    pub ended: bool,
}

impl KernelState {
    fn selected(&self, kind: &str) -> String {
        self.tracks
            .iter()
            .find(|t| t.kind == kind && t.selected)
            .map(|t| t.label.clone())
            .unwrap_or_default()
    }

    fn to_json(&self) -> Value {
        json!({
            "open": self.open,
            "file": self.file,
            "title": self.title,
            "state": {
                "positionMs": self.position_ms,
                "durationMs": self.duration_ms,
                "playing": self.playing,
                "bufferedMs": self.buffered_ms,
                "rate": if self.rate > 0.0 { self.rate } else { 1.0 },
                "subtitle": self.selected("sub"),
                "audioTrack": self.selected("audio"),
            },
            "tracks": self.tracks.iter().map(|t| json!({
                "kind": t.kind,
                "id": t.id,
                "label": t.label,
                "lang": t.lang,
                "selected": t.selected,
            })).collect::<Vec<_>>(),
            "ended": self.ended,
        })
    }
}

/// 与 mpv 的 IPC 连接（Windows 命名管道 / Unix socket）。
#[cfg(windows)]
type Conn = std::fs::File;
#[cfg(not(windows))]
type Conn = std::os::unix::net::UnixStream;

/// 连上 IPC 端点。
///
/// 🔴 Windows 上**不能**用「阻塞读线程 + 同一个句柄写」：`try_clone` 是 DuplicateHandle，
///    两个句柄指向**同一个 file object**，一个挂起的阻塞 `ReadFile` 会把同一对象上的
///    `WriteFile` 一起堵住（实测症状：命令永远发不出去，进程静默挂死）。
///    所以 Windows 侧读端改成 `PeekNamedPipe` 轮询（见 `spawn_reader`），从不挂起。
fn connect(endpoint: &str) -> std::io::Result<(Conn, Conn)> {
    #[cfg(windows)]
    {
        let f = std::fs::OpenOptions::new().read(true).write(true).open(endpoint)?;
        Ok((f.try_clone()?, f))
    }
    #[cfg(not(windows))]
    {
        let s = std::os::unix::net::UnixStream::connect(endpoint)?;
        Ok((s.try_clone()?, s))
    }
}

/// 处理一行 IPC 文本（两个平台的读端共用）。
fn handle_line(line: &str, pending: &Arc<Mutex<HashMap<u64, Sender<Value>>>>, state: &Arc<Mutex<KernelState>>) {
    let Some(msg) = ipc::decode(line) else { return };
    match msg {
        Incoming::Reply { id, error, data } => {
            let tx = pending.lock().ok().and_then(|mut m| m.remove(&id));
            if let Some(tx) = tx {
                let _ = tx.send(json!({ "error": error, "data": data }));
            }
        }
        Incoming::Property { name, data } => {
            if let Ok(mut s) = state.lock() {
                apply_property(&mut s, &name, &data);
            }
        }
        Incoming::Event { name } => {
            if name == "end-file" {
                if let Ok(mut s) = state.lock() {
                    s.ended = true;
                    s.playing = false;
                }
            }
        }
    }
}

#[cfg(windows)]
fn spawn_reader(
    conn: Conn,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    state: Arc<Mutex<KernelState>>,
    closed: Arc<AtomicBool>,
) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::ReadFile;
    use windows_sys::Win32::System::Pipes::PeekNamedPipe;

    std::thread::spawn(move || {
        // 句柄从 `conn` 借出来：`conn` 由闭包持有到循环结束，句柄始终有效
        let handle = conn.as_raw_handle();
        let mut raw: Vec<u8> = Vec::with_capacity(8192);
        loop {
            let mut avail: u32 = 0;
            // PeekNamedPipe 不阻塞：没有数据就返回 0 字节可读
            let ok = unsafe {
                PeekNamedPipe(
                    handle as _,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    &mut avail,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                break; // 对端关了
            }
            if avail == 0 {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            let mut buf = vec![0u8; avail.min(64 * 1024) as usize];
            let mut got: u32 = 0;
            let ok = unsafe {
                ReadFile(handle as _, buf.as_mut_ptr(), buf.len() as u32, &mut got, std::ptr::null_mut())
            };
            if ok == 0 || got == 0 {
                break;
            }
            raw.extend_from_slice(&buf[..got as usize]);
            while let Some(at) = raw.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = raw.drain(..=at).collect();
                handle_line(&String::from_utf8_lossy(&line), &pending, &state);
            }
        }
        closed.store(true, Ordering::SeqCst);
    });
}

#[cfg(not(windows))]
fn spawn_reader(
    conn: Conn,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    state: Arc<Mutex<KernelState>>,
    closed: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut buf = BufReader::new(conn);
        let mut line = String::new();
        loop {
            line.clear();
            match buf.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            handle_line(&line, &pending, &state);
        }
        closed.store(true, Ordering::SeqCst);
    });
}

/// 找 mpv 可执行文件。
///
/// `MIAO_MPV_SCRIPT` 是**测试接缝**：把它设成 `fake-mpv.mjs`、`MIAO_MPV_BIN` 设成 `node`，
/// 就能用夹具跑完整条 IPC 链路（本机没有真 mpv 时这是唯一能证明协议对得上的办法）。
pub fn locate_mpv() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("MIAO_MPV_BIN") {
        if !v.trim().is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    let exe = if cfg!(windows) { "mpv.exe" } else { "mpv" };
    if let Ok(cur) = std::env::current_exe() {
        if let Some(dir) = cur.parent() {
            for p in [dir.join(exe), dir.join("mpv").join(exe)] {
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    let resource = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("mpv")
        .join(platform_tag())
        .join(exe);
    if resource.exists() {
        return Some(resource);
    }
    which(exe)
}

fn platform_tag() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "win32-x64"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "win32-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(target_os = "macos") {
        "darwin-x64"
    } else if cfg!(target_arch = "aarch64") {
        "linux-arm64"
    } else {
        "linux-x64"
    }
}

/// PATH 里找（不引 `which` crate：只做一次目录遍历）。
fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// 探测：有没有可用的 mpv。找不到时给**原因**，调用方据此说人话。
pub fn probe() -> KernelInfo {
    match locate_mpv() {
        Some(p) => KernelInfo {
            available: true,
            path: p.to_string_lossy().into_owned(),
            reason: String::new(),
        },
        None => KernelInfo {
            available: false,
            path: String::new(),
            reason: format!(
                "找不到 mpv（找过 MIAO_MPV_BIN、程序同级、resources/mpv/{}/、PATH）",
                platform_tag()
            ),
        },
    }
}

/// 一个内核会话：子进程 + IPC 客户端 + 共享状态。
pub struct Kernel {
    child: Child,
    writer: Mutex<Conn>,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    state: Arc<Mutex<KernelState>>,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
    pub info: KernelInfo,
}

impl Kernel {
    /// 起 mpv 并接上 IPC。
    ///
    /// `hwdec`：设置页「强制硬件解码」的落点。`auto-safe` 是 mpv 的推荐档
    /// （只开它认为安全的硬解后端），`no` 用于排查花屏 / 绿屏。
    pub fn spawn(hwdec: &str) -> Result<Self, String> {
        Self::spawn_with(hwdec, &[])
    }

    /// 带额外 mpv 参数的版本（自检用：图像片源要 `--image-display-duration` 才有长度）。
    pub fn spawn_with(hwdec: &str, extra: &[String]) -> Result<Self, String> {
        let info = probe();
        let bin = locate_mpv().ok_or_else(|| info.reason.clone())?;
        let endpoint = ipc::endpoint("main");
        let mut cmd = Command::new(&bin);
        if let Ok(script) = std::env::var("MIAO_MPV_SCRIPT") {
            if !script.trim().is_empty() {
                cmd.arg(script);
            }
        }
        cmd.arg(format!("--input-ipc-server={endpoint}"))
            .arg("--idle=yes")
            .arg("--no-terminal")
            .arg("--force-window=yes")
            .arg("--osc=no")
            .arg("--osd-level=0")
            .arg("--keep-open=no")
            .arg("--no-input-default-bindings")
            .arg("--volume=80")
            .arg(format!("--hwdec={hwdec}"));
        for a in extra {
            cmd.arg(a);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| format!("拉起 mpv 失败（{}）：{e}", bin.display()))?;

        // 管道是子进程创建的：给它一点时间，连不上就重试（最多 5s）
        let deadline = Instant::now() + Duration::from_secs(5);
        let (reader, writer) = loop {
            match connect(&endpoint) {
                Ok(v) => break v,
                Err(e) => {
                    if Instant::now() > deadline {
                        let _ = child.kill();
                        return Err(format!("mpv 的 IPC 端点连不上（{endpoint}）：{e}"));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        };

        let pending: Arc<Mutex<HashMap<u64, Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let state = Arc::new(Mutex::new(KernelState { rate: 1.0, ..Default::default() }));
        let closed = Arc::new(AtomicBool::new(false));
        spawn_reader(reader, pending.clone(), state.clone(), closed.clone());

        Ok(Kernel {
            child,
            writer: Mutex::new(writer),
            pending,
            state,
            next_id: AtomicU64::new(1),
            closed,
            info,
        })
    }

    /// 发一条命令并等回执。`data` 是 mpv 回的 `data` 字段（可能没有）。
    fn request(&self, command: Vec<Value>) -> Result<Option<Value>, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("mpv 已经退出".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx): (Sender<Value>, Receiver<Value>) = mpsc::channel();
        if let Ok(mut m) = self.pending.lock() {
            m.insert(id, tx);
        }
        let line = ipc::encode(&command, id);
        {
            let mut w = self.writer.lock().map_err(|e| format!("IPC 写锁被污染：{e}"))?;
            w.write_all(line.as_bytes()).map_err(|e| format!("写 IPC 失败：{e}"))?;
            w.flush().map_err(|e| format!("刷新 IPC 失败：{e}"))?;
        }
        let reply = rx.recv_timeout(REPLY_TIMEOUT).map_err(|_| {
            format!("mpv 没回执（{}s）：{:?}", REPLY_TIMEOUT.as_secs(), command.first())
        })?;
        let error = reply.get("error").and_then(|v| v.as_str()).unwrap_or("success").to_string();
        if error != "success" {
            return Err(format!("mpv 拒绝命令（{error}）"));
        }
        Ok(reply.get("data").cloned().filter(|d| !d.is_null()))
    }

    fn observe(&self, name: &str) -> Result<(), String> {
        // observe_property 的 id 与 request_id 是两套编号：用属性名哈希太脆，直接递增
        let prop_id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.request(vec![json!("observe_property"), json!(prop_id), json!(name)]).map(|_| ())
    }

    fn set(&self, prop: &str, value: Value) -> Result<(), String> {
        self.request(vec![json!("set_property"), json!(prop), value]).map(|_| ())
    }

    fn state(&self) -> KernelState {
        self.state.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// 等到 `duration` 有值（或超时）。起播前 `duration` 是 `null`，此时 seek 会被内核忽略。
    fn wait_duration(&self) {
        let deadline = Instant::now() + OPEN_WAIT;
        while Instant::now() < deadline {
            if self.state().duration_ms > 0 {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// 把一条 `property-change` 写进共享状态。
fn apply_property(s: &mut KernelState, name: &str, data: &Value) {
    match name {
        "pause" => s.playing = !data.as_bool().unwrap_or(false),
        "time-pos" => s.position_ms = ipc::secs_to_ms(Some(data)),
        "duration" => s.duration_ms = ipc::secs_to_ms(Some(data)),
        "speed" => {
            let v = data.as_f64().unwrap_or(1.0);
            if v.is_finite() && v > 0.0 {
                s.rate = v;
            }
        }
        "track-list" => s.tracks = ipc::tracks_of(data),
        "demuxer-cache-state" => {
            // `cache-end` 是"已经能播到的位置"（秒）；没有这个键就保持原值
            let end = data.get("cache-end").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if end > 0.0 {
                s.buffered_ms = (end * 1000.0).round() as u64;
            }
        }
        "eof-reached" => {
            if data.as_bool().unwrap_or(false) {
                s.ended = true;
                s.playing = false;
            }
        }
        _ => {}
    }
}

impl PlaybackCore for Kernel {
    fn open(&mut self, source: Source) -> Result<(), String> {
        let (path, title) = match &source {
            Source::File { path } => (path.clone(), String::new()),
            Source::Torrent { .. } => return Err("BT 边下边播还没接（M5）".into()),
            Source::Hls { url } => (url.clone(), String::new()),
        };
        self.request(vec![json!("loadfile"), json!(path), json!("replace")])?;
        for prop in ["pause", "time-pos", "duration", "speed", "track-list", "demuxer-cache-state", "eof-reached"] {
            self.observe(prop)?;
        }
        self.set("pause", json!(true))?;
        if let Ok(mut s) = self.state.lock() {
            s.open = true;
            s.file = path;
            s.title = title;
            s.ended = false;
            s.position_ms = 0;
        }
        self.wait_duration();
        Ok(())
    }

    fn play(&mut self) -> Result<(), String> {
        self.set("pause", json!(false))
    }

    fn pause(&mut self) -> Result<(), String> {
        self.set("pause", json!(true))
    }

    fn seek(&mut self, position_ms: u64) -> Result<(), String> {
        // 越界夹住：拖拽越界是常态，报错等于让控制条自己夹（契约见 playback.rs）
        let dur = self.state().duration_ms;
        let target = if dur > 0 { position_ms.min(dur) } else { position_ms };
        self.set("time-pos", json!(target as f64 / 1000.0))
    }

    fn set_rate(&mut self, rate: f64) -> Result<(), String> {
        if !rate.is_finite() {
            return Err("倍速不是有限数".into());
        }
        self.set("speed", json!(rate.clamp(0.25, 4.0)))
    }

    fn select_track(&mut self, kind: TrackKind, id: &str) -> Result<(), String> {
        let prop = match kind {
            TrackKind::Audio => "aid",
            TrackKind::Subtitle => "sid",
        };
        // `no` = 关掉这一类轨（与 mpv 自己的写法一致）
        if id.is_empty() || id == "no" {
            return self.set(prop, json!("no"));
        }
        self.set(prop, json!(id))
    }

    fn load_subtitle(&mut self, path: &str) -> Result<(), String> {
        if path.is_empty() {
            return self.set("sid", json!("no"));
        }
        self.request(vec![json!("sub-add"), json!(path), json!("select")]).map(|_| ())
    }

    fn snapshot(&self) -> PlaybackSnapshot {
        let s = self.state();
        PlaybackSnapshot {
            position_ms: s.position_ms,
            duration_ms: s.duration_ms,
            playing: s.playing,
            buffered_ms: s.buffered_ms.max(s.position_ms),
            rate: if s.rate > 0.0 { s.rate } else { 1.0 },
            subtitle: s.selected("sub"),
            audio_track: s.selected("audio"),
        }
    }
}

impl Drop for Kernel {
    fn drop(&mut self) {
        // 先礼后兵：quit 让 mpv 自己收拾窗口，超时再 kill
        let _ = self.request(vec![json!("quit")]);
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------- 进程内单例

static SESSION: OnceLock<Mutex<Option<Kernel>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<Kernel>> {
    SESSION.get_or_init(|| Mutex::new(None))
}

/// 关掉当前会话（幂等）。
pub fn close() {
    if let Ok(mut g) = slot().lock() {
        *g = None;
    }
}

/// 当前状态（没有会话时给 `open:false`）。
pub fn status() -> Value {
    let info = probe();
    let state = slot()
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|k| k.state()))
        .map(|s| s.to_json())
        .unwrap_or_else(|| KernelState::default().to_json());
    json!({
        "available": info.available,
        "path": info.path,
        "reason": info.reason,
        "external": true,
        "session": state,
    })
}

/// 打开一个文件并保持暂停（一打开就有声音会吓人）。
pub fn open_file(path: &str, title: &str, hwdec: &str) -> Result<Value, String> {
    let mut g = slot().lock().map_err(|e| format!("内核槽被污染：{e}"))?;
    *g = None;
    let mut k = Kernel::spawn(hwdec)?;
    k.open(Source::File { path: path.to_string() })?;
    if let Ok(mut s) = k.state.lock() {
        s.title = title.to_string();
    }
    let out = k.state().to_json();
    *g = Some(k);
    Ok(json!({ "ok": true, "external": true, "session": out }))
}

/// 控制动作：`play` / `pause` / `seek` / `rate` / `track` / `subtitle` / `volume` /
/// `fullscreen` / `screenshot`。
///
/// `state_dir` 只给截图用：截图落在 `<state>/screenshots/`，前端不指定磁盘路径。
pub fn ctl(action: &str, value: &Value, state_dir: &str) -> Result<Value, String> {
    let mut g = slot().lock().map_err(|e| format!("内核槽被污染：{e}"))?;
    let k = g.as_mut().ok_or("内核还没打开片源")?;
    match action {
        "play" => k.play()?,
        "pause" => k.pause()?,
        "seek" => k.seek(value.as_u64().unwrap_or(0))?,
        "rate" => k.set_rate(value.as_f64().unwrap_or(1.0))?,
        "volume" => {
            let v = value.as_f64().unwrap_or(80.0).clamp(0.0, 100.0);
            k.set("volume", json!(v))?;
        }
        "fullscreen" => {
            let on = value.as_bool().unwrap_or(true);
            k.set("fullscreen", json!(on))?;
        }
        "screenshot" => {
            let dir = std::path::Path::new(state_dir).join("screenshots");
            std::fs::create_dir_all(&dir).map_err(|e| format!("截图目录建不出来：{e}"))?;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let path = dir.join(format!("anime-{ts}.png"));
            let p = path.to_string_lossy().into_owned();
            // `video` = 只截画面（不含 OSD）；mpv 会把当前帧写成 PNG
            k.request(vec![json!("screenshot-to-file"), json!(p), json!("video")])?;
            return Ok(json!({ "ok": true, "file": p, "session": k.state().to_json() }));
        }
        "track" => {
            let kind = value.get("kind").and_then(|v| v.as_str()).unwrap_or("audio");
            let id = value.get("id").and_then(|v| v.as_str()).unwrap_or("no");
            let kk = if kind == "sub" { TrackKind::Subtitle } else { TrackKind::Audio };
            k.select_track(kk, id)?;
        }
        "subtitle" => {
            let path = value.as_str().unwrap_or("");
            k.load_subtitle(path)?;
        }
        other => return Err(format!("不认识的内核动作：{other}")),
    }
    Ok(json!({ "ok": true, "session": k.state().to_json() }))
}

/// 写一段 1.5 秒静音 WAV 当片源。
///
/// 为什么不用「随便几个字节」：夹具 mpv 不在乎内容，但**真 mpv** 解析不了就会
/// 时长 0、seek 无效、也拿不到音轨 —— 那样自检对真内核等于什么都没验。
fn write_silent_wav(path: &std::path::Path) -> std::io::Result<()> {
    let sr: u32 = 8000;
    let samples: u32 = 12_000; // 1.5s
    let data_len = samples * 2;
    let mut b = Vec::with_capacity(44 + data_len as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data_len).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&1u16.to_le_bytes()); // mono
    b.extend_from_slice(&sr.to_le_bytes());
    b.extend_from_slice(&(sr * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data_len.to_le_bytes());
    b.resize(44 + data_len as usize, 0);
    std::fs::write(path, b)
}

/// 写一张 1×1 PNG 当「图像片源」（真 mpv 会把静态图当视频轨播，可截图）。
fn write_tiny_png(path: &std::path::Path) -> std::io::Result<()> {
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
        0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x18,
        0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];
    std::fs::write(path, PNG)
}

/// 自检：按脚本跑一遍真 IPC 链路（夹具版用 `MIAO_MPV_BIN` + `MIAO_MPV_SCRIPT`）。
///
/// 两段片源：**音频**验时长 / 跳转 / 音轨 / 外挂字幕，**图像**验截图
/// （图像在真 mpv 里是一条视频轨，音频片源没有画面可截）。
pub fn selftest() -> Value {
    let mut cases: Vec<Value> = Vec::new();
    let mut ok = true;
    let mut push = |name: &str, cond: bool, detail: &str| {
        if !cond {
            ok = false;
        }
        cases.push(json!({ "name": name, "ok": cond, "detail": detail }));
    };

    let info = probe();
    push("内核可定位（MIAO_MPV_BIN 或随包路径）", info.available, &info.reason);
    if !info.available {
        return json!({ "ok": false, "cases": cases, "info": { "available": false } });
    }

    let tmp = std::env::temp_dir();
    let wav = tmp.join("miao-anime-kernel-selftest.wav");
    let srt = tmp.join("miao-anime-kernel-selftest.srt");
    let png = tmp.join("miao-anime-kernel-selftest.png");
    let shot = tmp.join("miao-anime-kernel-selftest-shot.png");
    let wav_path = wav.to_string_lossy().into_owned();
    let srt_path = srt.to_string_lossy().into_owned();
    let _ = write_silent_wav(&wav);
    let _ = std::fs::write(&srt, "1\n00:00:00,000 --> 00:00:01,000\nhello\n");
    let _ = write_tiny_png(&png);

    match Kernel::spawn("auto-safe") {
        Ok(mut k) => {
            // 真 mpv 的状态是**事件推回来**的（毫秒级但不保证同拍）：断言前要等一等，
            // 不能假设「发完命令状态立刻变」—— 夹具是同步的，会把这个假设藏起来。
            let wait = |cond: &dyn Fn() -> bool| -> bool {
                for _ in 0..40 {
                    if cond() {
                        return true;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                false
            };
            push("拉起 mpv 并接上 IPC", true, "");
            let opened = k.open(Source::File { path: wav_path.clone() });
            push("open 成功", opened.is_ok(), &opened.err().unwrap_or_default());
            push("open 后能读到时长（事件通道通）", k.snapshot().duration_ms > 0, "");
            push("open 后处于暂停态", wait(&|| !k.snapshot().playing), "一打开就有声音会吓人");
            let played = k.play().is_ok() && wait(&|| k.snapshot().playing);
            push("play 后 playing=true", played, "");
            let seek = k.seek(500);
            push("seek 到 0.5s", seek.is_ok() && wait(&|| k.snapshot().position_ms >= 400), "");
            push("倍速夹到上限 4.0", k.set_rate(9.0).is_ok() && k.snapshot().rate <= 4.0, "");
            push("倍速夹到下限 0.25", k.set_rate(-1.0).is_ok() && k.snapshot().rate >= 0.25, "");
            push("拿到音轨", k.state().tracks.iter().any(|t| t.kind == "audio"), "");
            let sub_ok = k.load_subtitle(&srt_path);
            push("挂外挂字幕", sub_ok.is_ok(), &sub_ok.err().unwrap_or_default());
            push(
                "外挂字幕后出现选中的字幕轨",
                wait(&|| k.state().tracks.iter().any(|t| t.kind == "sub" && t.selected)),
                "",
            );
            push("音量命令被接受", k.set("volume", json!(55)).is_ok(), "");
            push("全屏命令被接受", k.set("fullscreen", json!(true)).is_ok(), "");
            let paused = k.pause().is_ok() && wait(&|| !k.snapshot().playing);
            push("pause 后 playing=false", paused, "");
        }
        Err(e) => push("拉起 mpv 并接上 IPC", false, &e),
    }

    // 第二段：图像片源 → 截图（真 mpv 把静态图当视频轨）
    let png_path = png.to_string_lossy().into_owned();
    let shot_path = shot.to_string_lossy().into_owned();
    let _ = std::fs::remove_file(&shot);
    match Kernel::spawn_with("auto-safe", &["--image-display-duration=5".to_string()]) {
        Ok(mut k) => {
            let opened = k.open(Source::File { path: png_path });
            push("图像片源 open 成功", opened.is_ok(), &opened.err().unwrap_or_default());
            let shot_ok = k.request(vec![json!("screenshot-to-file"), json!(shot_path), json!("video")]).is_ok();
            // 真 mpv 落盘有极短的延迟：等一小会儿再判「文件真的写了」
            for _ in 0..20 {
                if shot.exists() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            push("截图命令被接受", shot_ok && shot.exists(), "");
        }
        Err(e) => {
            push("图像片源 open 成功", false, &e);
            push("截图命令被接受", false, &e);
        }
    }

    for p in [&wav, &srt, &png, &shot] {
        let _ = std::fs::remove_file(p);
    }
    json!({ "ok": ok, "cases": cases, "info": { "available": info.available, "path": info.path } })
}
