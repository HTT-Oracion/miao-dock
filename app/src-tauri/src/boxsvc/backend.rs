// 旧后端（Node box-service）—— **反代过渡期**的遗留实现宿主（F1）
//
// 为什么要有它：F1 的形态是「Rust 进程内服务先行，未迁移端点 reqwest 转发给 Node」。
// 独立可执行的 `boxsvc` 要能**自成一套**地跑起来（e2e 只换靶子、不换断言），所以它
// 必须自己把遗留后端拉起来、读出它的端口与令牌，再把请求转过去。
//
// 🔴 F5 完成（全部端点迁完）后，本模块**整体删除**；届时 `boxsvc` 不再依赖 Node。
//    过渡期它的存在是**显式**的：`MIAO_LEGACY_BACKEND=0` 可关掉（供"纯 Rust"路径自检），
//    关掉后未迁移端点统统 502 —— 这正是 F1 反证轮要的那条红线。
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 给遗留后端挑一个**段外**的监听端口。
///
/// 🔴 为什么必须段外（`check:*` 的 A1 用例就是抓这个的）：
///    5180–5190 是**产品契约**里的端口段（契约 §1：客户端据此探测）。遗留后端只是 Rust 外壳
///    在迁移期的内部实现细节 —— 它一旦占用段内端口，「5180 被占 ⇒ 落到 5181」这条语义就错位：
///    实测「测试占 5180、遗留后端占 5181 ⇒ 外壳落到 5182」，A1 立刻变红。
///    真机上更糟：一个用户开两个实例就会比预期更早耗尽端口段。
///
/// 做法：绑 `port 0` 让内核给一个空闲的临时端口，读到号之后**立刻放掉**，把这个号交给子进程。
/// 选号到子进程绑定之间有极小的竞态窗口 —— 由 `spawn` 的最多 `PORT_TRIES` 次重试兜住
/// （每次重新选号），因此不会把「偶发占用」放大成「服务起不来」。
fn free_port_outside_range() -> Option<u16> {
    for _ in 0..8 {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?;
        let port = l.local_addr().ok()?.port();
        drop(l);
        // Windows 的临时端口段（默认 49152+）与产品段不重叠；这里仍显式挡一道，
        // 免得将来有人把系统临时端口段改到 5180 附近。
        if !(crate::boxsvc::PORT_RANGE_START..=crate::boxsvc::PORT_RANGE_END).contains(&port) {
            return Some(port);
        }
    }
    None
}

/// 遗留后端的位置与就绪信息
pub struct LegacyBackend {
    child: Child,
    pub base: String,
    pub token: String,
    pub root_dir: String,
}

/// 选号-绑定竞态的重试次数（见 [`free_port_outside_range`] 的说明）。
const PORT_TRIES: usize = 3;

impl LegacyBackend {
    /// 拉起 Node box-service 并等它的就绪行。
    ///
    /// 就绪行协议与 Rust 侧 `service.rs::wait_ready` **同一套**：stdout 里出现
    /// `MIAO_READY {"port":…,"token":…,"rootDir":…}`。复用同一协议是刻意的 ——
    /// e2e 的夹具正是按它解析的（`/MIAO_READY (\{.*\})/`）。
    pub fn spawn(entry: &PathBuf, timeout: Duration) -> Result<Self, String> {
        let mut last = String::from("未尝试");
        for _ in 0..PORT_TRIES {
            let port = free_port_outside_range()
                .ok_or_else(|| "无法为遗留后端选到空闲端口".to_string())?;
            match Self::spawn_on(entry, timeout, port) {
                Ok(b) => return Ok(b),
                // 只有「没就绪」才值得换端口重试；其它错误（找不到 node、缺就绪行）重试也没用。
                Err(e) => last = e,
            }
        }
        Err(format!("遗留后端 {PORT_TRIES} 次尝试均未就绪。最后错误：{last}"))
    }

    /// 指定端口起一次（`spawn` 的重试单元）。
    fn spawn_on(entry: &PathBuf, timeout: Duration, port: u16) -> Result<Self, String> {
        let mut cmd = Command::new("node");
        cmd.arg(entry)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // 🔴 显式给一个**段外**端口，而不是把 `MIAO_PORT` 剥掉让它自己探测：
        //    剥掉之后它会在 5180–5190 里探测，占用产品端口段（见 `free_port_outside_range`）。
        //    同时也顺手盖掉夹具可能传进来的 `MIAO_PORT`（如 selftest A18 用 5189）——
        //    两边同段会互相抢端口，症状是「服务起不来」而根因在环境变量上。
        cmd.env("MIAO_PORT", port.to_string());
        // 子进程进自己的进程组：回收时对组发信号可连带孙进程
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("无法启动遗留后端 node {}：{e}", entry.display()))?;

        // stderr 逐行转到本进程 stderr（诊断用；不影响就绪行解析）
        if let Some(err) = child.stderr.take() {
            std::thread::spawn(move || {
                let r = BufReader::new(err);
                for line in r.lines().map_while(Result::ok) {
                    eprintln!("[legacy] {line}");
                }
            });
        }

        let stdout = child.stdout.take().ok_or("遗留后端没有 stdout")?;
        let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
        std::thread::spawn(move || {
            let r = BufReader::new(stdout);
            for line in r.lines().map_while(Result::ok) {
                // 🔴 遗留后端自己的 `MIAO_READY` **绝不能**原样转发到本进程 stdout：
                //    e2e 的就绪行正则 `/MIAO_READY (\{.*\})/` 会先命中它，于是拿到的是
                //    **遗留后端的端口**（它监听在另一个端口上）—— 断言会静默打在错靶子上。
                //    故转发时把这一行**改名**（不叫 MIAO_READY）；本进程的就绪行只由我们打印。
                println!("[legacy] {}", line.replace("MIAO_READY", "LEGACY_READY"));
                if let Some(idx) = line.find('{') {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line[idx..]) {
                        let _ = tx.send(v);
                    }
                }
            }
        });

        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                let _ = child.kill();
                return Err(format!("遗留后端 {timeout:?} 内未就绪"));
            }
            match rx.recv_timeout(Duration::from_millis(200).min(remaining)) {
                Ok(v) => {
                    let port = v.get("port").and_then(|x| x.as_u64()).map(|x| x as u16);
                    let token = v.get("token").and_then(|x| x.as_str()).map(str::to_string);
                    let root_dir = v
                        .get("rootDir")
                        .and_then(|x| x.as_str())
                        .map(str::to_string)
                        .unwrap_or_default();
                    match (port, token) {
                        (Some(p), Some(t)) => {
                            return Ok(Self {
                                child,
                                base: format!("http://127.0.0.1:{p}"),
                                token: t,
                                root_dir,
                            })
                        }
                        _ => {
                            let _ = child.kill();
                            return Err(format!("遗留后端就绪行缺 port/token：{v}"));
                        }
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = child.kill();
                    return Err("遗留后端未打印就绪行即退出".into());
                }
            }
        }
    }

    /// 收掉遗留后端（整个进程组）。
    pub fn kill(&mut self) {
        let pid = self.child.id() as i32;
        #[cfg(unix)]
        unsafe {
            // 先礼后兵：SIGTERM 组 → 给 3s → SIGKILL 组
            libc::kill(-pid, libc::SIGTERM);
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
        let _ = self.child.wait();
    }
}

/// 全局持有遗留后端，供进程退出时收尾（`Mutex` 只为满足 `static` 要求）。
pub static LEGACY: Mutex<Option<LegacyBackend>> = Mutex::new(None);

/// 收掉全局遗留后端（信号处理 / 正常退出时调用）。
pub fn shutdown_legacy() {
    if let Ok(mut g) = LEGACY.lock() {
        if let Some(mut b) = g.take() {
            b.kill();
        }
    }
}
