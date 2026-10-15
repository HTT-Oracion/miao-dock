// 通用子进程看守（E11）的 **Rust 化身**（A3c）—— 移植 `engine/scripts/child-watch.mjs`。
//
// # 为什么需要它（以及为什么不能用别的东西）
//
// 真模式下 ② 是 `python main.py`、③ 是 `llama-server` —— **外部二进制**，改不了，
// 也指望不上它们自己看住 ppid。主进程被 SIGKILL 后它们会被 reparent 到 init
// 并继续占着 8000 / 8001 / 8080，正是 E11 要消灭的孤儿。
// ⇒ 用这个薄看守包一层：看守盯父进程，被看守进程放进**独立进程组**，父死时整组带走。
//
// 为什么不靠 Rust 主进程侧的进程组：主进程被 SIGKILL 时**没有任何代码会执行**，
// 它对进程组做的任何事都不会发生。能自救的只有还活着的进程。
//
// # 🔴 父死检测：**双通道**，不是"二选一"（这是 A3c 最贵的一课）
//
// 最初的实现只有「stdin 管道」一条：父进程用 `Stdio::piped()` 起看守器并攥住
// `ChildStdin`，父死 ⇒ 内核关写端 ⇒ 看守器读到 EOF。本机 Windows 上实测**这条不够**：
// 父进程若是 node（`process.exit()` 直接退），它 spawn 的子进程那条 stdin 写端
// **不会**随父进程一起消失 ⇒ 看守器永远等不到 EOF ⇒ **整棵子树变成孤儿，且完全静默**
// （看守器连日志都不打，因为它压根没收到事件）。
//
// 而同一场景下 JS 版（ppid 轮询）是成功的 —— 对照实验见 `e2e/child-watch-check.mjs`。
//
// 于是定为两条通道**并行**，任一判定父死即触发：
//   ① **stdin 管道**（主）：父进程是 Rust（产品的真实情形）时可靠且**立刻**送达 ——
//      ppid 轮询在父进程被 SIGKILL 后还要等最多 1s。管道是内核事件。
//   ② **ppid 轮询**（兜底）：Windows 上父进程是 node / 任何非 Rust 宿主时唯一有效的通道；
//      且它与 ① **语义正交** —— 一个依赖"父侧攥住句柄"，一个依赖"向操作系统问爹还在吗"。
//
// 🔴 只留①的失效形态是**静默的**：子树被留下、端口被占满、日志里一行都没有。
//    这类"两个方向都绿"的假绿正是本项目最忌讳的形态，所以宁可两条冗余通道。
//
// # 「出生即孤儿」窗口
//
// JS 版专门写了一条兜底分支（`bootPpid <= 1` ⇒ 立刻自杀，见 D-68：spawn 与 exec 之间
// 父进程死掉的窗口真实存在，而旧写法在这里**静默地不装看守**）。本版由 ② 的**启动时**
// 快照承担同一职责 —— 装看守那一刻 ppid 已经 ≤1 就是出生即孤儿。
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

// `creation_flags` 是 `CommandExt` 上的方法：`WinFlags::apply()` / `kill_tree` 都要它，
// 提到模块级（各函数里再 `use` 一遍会变成重复 import）。
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 主循环巡检节奏。JS 版是 1000ms（因为它只能轮询 ppid）；本版读的是内核事件，
/// 巡检只是为了**发现标志位**，可以很快。
const POLL_MS: u64 = 50;

/// 父死 ⇒ 先礼（SIGTERM 整组）后兵（SIGKILL 整组）的等待窗口。
///
/// 🔴 不能是 0：`kill(-pgid, SIGTERM)` 之后立刻 SIGKILL 有个真实竞态 ——
///    真引擎 `main.py` 的 `handle_exit_signals` 收到 SIGTERM 后要跑
///    `proc.terminate()` 清掉自己 fork 的执行器；立即 SIGKILL 会把这个窗口掐掉，
///    而 D-89 记录的正是"执行器被 reparent 成孤儿占着 port+1"这类故障。
/// 取 JS 版三档（600 / 1200 / 1500ms）里最长的那个。
const SHUTDOWN_GRACE_MS: u64 = 1500;

/// ppid 轮询间隔（同 JS 版）。兜底通道专用 —— 管道通道不需要它。
const PPID_POLL_MS: u64 = 1000;

/// 「父进程通道在启动后这么快就闭合 ⇒ 大概率是父进程接线错了」的阈值。
/// 真实父进程至少活过这一会儿；启动即闭合只可能来自 `Stdio::null()`/误关。
const EARLY_CLOSE_MS: u64 = 300;

// ------------------------------------------------------------------ Windows：别弹黑框

/// Windows 创建标志：**不给子进程分配控制台窗口**。
///
/// 🔴 本仓桌面端是 `windows_subsystem = "windows"`（**没有控制台**）。这种父进程 spawn 一个
///    **控制台程序**时，Windows 会为子进程**新开一个控制台窗口** —— std 不代劳。症状就是
///    「打开喵坞弹出两个黑框」：一个是 ① `boxsvc`，一个是 ③ `llama-server`
///    （`service.rs::spawn_inner` 与 `supervisor.rs` 两处都没带这个标志）。
///    另几处同理会闪框：`pip` / `python -m venv` / `tar` / `nvidia-smi` / `boxsvc --fetch-models`。
///
/// ⚠️ `child_watch.rs` 与 `service.rs` 原先各自在 `taskkill` 处带了这个标志，
///    但**真正 spawn 业务子进程的那几处全漏了** —— 这正是"只给收尾路径加、不给启动路径加"
///    的典型漏法（收尾时闪一下没人注意，启动时闪两个黑框立刻被发现）。
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Windows 创建标志：新进程组（`taskkill /T` / POSIX 进程组语义的落点）。
#[cfg(windows)]
pub const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// 累积的 Windows 创建标志，**一次 `apply()` 生效**。
///
/// 🔴 为什么要这个壳：std 的 `Command::creation_flags()` 是**覆盖**语义，而 `Command`
///    **没有**读取已设标志的 getter ⇒ 一处 spawn 需要两个标志时（起 ① 既要
///    `CREATE_NEW_PROCESS_GROUP` 又要 `CREATE_NO_WINDOW`），连写两次 `creation_flags()`
///    会让前一个被后一个**静默冲掉**（症状是"明明加了隐藏黑框、却还在弹"，或反之
///    "进程组没了、`taskkill /T` 收不干净"）。在本仓记一份、最后一次合并写入。
#[derive(Clone, Copy, Default)]
pub struct WinFlags(u32);

impl WinFlags {
    pub const fn new() -> Self {
        Self(0)
    }
    pub const fn or(mut self, f: u32) -> Self {
        self.0 |= f;
        self
    }
    /// 写入 `Command`（非 Windows 平台是空操作）。
    pub fn apply(&self, cmd: &mut Command) {
        #[cfg(windows)]
        cmd.creation_flags(self.0);
        #[cfg(not(windows))]
        let _ = cmd;
    }
}

/// 最常用的一档：**隐藏控制台窗口**（非 Windows 平台空操作）。
///
/// 凡是产品 spawn 一个**可能是控制台程序**的子进程（`boxsvc` / `llama-server` / `python` /
/// `pip` / `tar` / `nvidia-smi` / `taskkill` …），spawn 前都要调它一次。
pub fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    WinFlags::new().or(CREATE_NO_WINDOW).apply(cmd);
    #[cfg(not(windows))]
    let _ = cmd;
}

/// 看守自身被要求停 / 父进程已死的标志（信号处理器里只能改这个）。
/// 0=无事，1=父进程已死，2=收到 SIGINT，3=收到 SIGTERM。
static SHUTDOWN: AtomicU8 = AtomicU8::new(0);

/// 父死通道 ① 的**候选**标志：stdin 读到 EOF。见 `watch_parent_stdin` 的注释 ——
/// EOF 需由 ② 复核才能升级为 `SHUTDOWN`，否则接线错误会误杀引擎。
static PIPE_EOF: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 跑起来：把 `--` 之后的命令包起来看住。`args` 是**不含程序名**的 argv。
pub fn run(args: &[String]) -> i32 {
    let sep = args.iter().position(|a| a == "--");
    let cmd: Vec<String> = match sep {
        Some(i) => args[i + 1..].to_vec(),
        None => Vec::new(),
    };
    if cmd.is_empty() {
        eprintln!("用法：boxsvc --child-watch -- <cmd> [args...]");
        return 2;
    }

    let watch_enabled = watch_enabled_now();
    let cwd = std::env::var("MIAO_CHILD_CWD").ok().filter(|s| !s.is_empty());

    // 🔴 「出生即孤儿」判定必须在**装任何看守之前**做（JS 版同款，见 D-68）：
    //    此刻 ppid 已经 ≤1 说明父进程在 spawn 与 exec 之间就死了。
    //    判据取在起 child **之前**：先记下"我爹是谁"，否则 child 起来后 ppid 已经变了。
    let boot_ppid = parent_pid();
    // 🔴 Windows 上必须**同时**记下父进程的创建时间：pid 会复用，只记 pid 不足以认人。
    remember_boot_identity(boot_ppid);

    // ② 自己被要求停：把信号转给子树（否则只有看守退、被看守进程变孤儿）。
    // 🔴 **必须在起 child 之前装**：父进程若恰在 spawn 与装 handler 之间发 SIGTERM，
    //    默认动作会当场终止看守 ⇒ 被看守进程成孤儿，而这正是 E11 要消灭的东西。
    install_signal_forward();

    let mut child = match spawn_watched(&cmd, cwd.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[child-watch] 无法启动 {}：{e}", cmd[0]);
            return 1;
        }
    };
    let pid = child.id();

    // 父死通道 ①：起一个线程读**自己的 stdin**，读到 EOF 就置标志。
    // ⚠️ 与主循环的 `try_wait` 是并发的（一个阻塞在 read、一个轮询子进程状态），互不干扰。
    if watch_enabled {
        watch_parent_stdin();
    }

    let mut term_deadline: Option<Instant> = None;
    let mut term_sent = false;

    // 出生即孤儿：连 child 都不该起（起了就得立刻杀，不如不起）。
    if watch_enabled && boot_ppid.map(|p| p <= 1).unwrap_or(false) {
        kill_tree(pid, true);
        println!("[child-watch] 启动时父进程已不在（出生即孤儿）⇒ 带走子树 {}", cmd[0]);
        return 0;
    }

    let mut last_poll = Instant::now();
    loop {
        // ① 被看守进程自己退了 ⇒ 按它的结局给退出码（看守不吞错）
        match child.try_wait() {
            Ok(Some(status)) => return exit_code_of(&status),
            Ok(None) => {}
            Err(e) => {
                eprintln!("[child-watch] 等待 {} 失败：{e}", cmd[0]);
                return 1;
            }
        }

        // ② 父死通道 ①（管道）：EOF 的可信度取决于 **stdin 是不是父进程给的管道**。
        //
        //    🔴 这是本模块最容易写错的一处，判错的后果还是**静默**的：
        //    管道 EOF 的真实语义只是"没有写端了"，而"没有写端"有两种成因 ——
        //      (a) 父进程死了（要杀子树）；
        //      (b) 父进程**根本没给管道**（stdin=null，压根不是管道 ⇒ EOF 是常量，
        //          一起来就有）⇒ 若照直觉自杀，引擎/LLM **一起来就没了**，
        //          而报错停在几层之外（"未在 180s 内就绪"）。
        //    二者的字节流完全一样，只能靠"stdin 是不是管道"区分：
        //      · 是管道 ⇒ 父进程必然攥着写端（这是本项目的接线约定，见 `service.rs`
        //        与 `supervisor.rs` 的 `_watch_keepalive`）⇒ EOF **权威**，直接采信。
        //      · 不是管道 ⇒ EOF 无信息量，必须交给 ② 复核。
        if watch_enabled && PIPE_EOF.load(Ordering::SeqCst) && SHUTDOWN.load(Ordering::SeqCst) == 0
        {
            if parent_holds_stdin_pipe() || parent_gone_strict(boot_ppid) {
                SHUTDOWN.store(1, Ordering::SeqCst);
            }
        }

        // ③ 父死通道 ②（兜底）：ppid 变了 / 变成 1 / 探活失败。
        //    与 ① 语义正交：一个依赖父侧攥住句柄，一个依赖向 OS 问"我爹还在吗"。
        //    这条是 Windows 上父进程为非 Rust 宿主时**唯一**有效的通道。
        if watch_enabled && last_poll.elapsed() >= Duration::from_millis(PPID_POLL_MS) {
            last_poll = Instant::now();
            if parent_gone_strict(boot_ppid) {
                SHUTDOWN.store(1, Ordering::SeqCst);
            }
        }

        // ④ 父死 / 收到信号 ⇒ 先礼后兵，然后自己退（exit 0，同 JS 版）
        let code = SHUTDOWN.load(Ordering::SeqCst);
        if code != 0 && !term_sent {
            term_sent = true;
            println!(
                "[child-watch] {} ⇒ 带走子树 {}",
                describe_reason(code),
                cmd[0]
            );
            kill_tree(pid, false);
            term_deadline = Some(Instant::now() + Duration::from_millis(SHUTDOWN_GRACE_MS));
        }
        if let Some(deadline) = term_deadline {
            if Instant::now() >= deadline {
                kill_tree(pid, true);
                return 0;
            }
        }

        std::thread::sleep(Duration::from_millis(POLL_MS));
    }
}

/// 本进程的父进程 pid。
#[cfg(unix)]
fn parent_pid() -> Option<u32> {
    let p = unsafe { libc::getppid() };
    if p > 0 {
        Some(p as u32)
    } else {
        None
    }
}

/// 本进程的父进程 pid（Windows）。
///
/// 🔴 Windows 没有 reparent 概念：父进程死后 `th32ParentProcessID` 会**冻结在旧值**上
///    （不像 unix 会变成 1），所以"ppid == 1"这条判据在 Windows 上**永远为假**。
///    这正是 Windows 必须配 `parent_alive()`（探活）而不能只比 ppid 的原因。
///
/// 用 ToolHelp32 快照枚举（**全表扫描**）而非 `NtQueryInformationProcess`：后者是
/// ntdll 的未文档化导出，windows-sys 也不导出它；快照虽是 O(进程数)，但看守器每秒
/// 才调一次，而它的**探活**判据（`parent_alive`）才是正确性的主要保障。
#[cfg(windows)]
fn parent_pid() -> Option<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let me = std::process::id();
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = None;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                if entry.th32ProcessID == me {
                    found = Some(entry.th32ParentProcessID);
                    break;
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        found.filter(|p| *p > 0)
    }
}

/// 父进程是否还在（探活）。
///
/// 🔴 与 `parent_pid()` **配对使用**：Windows 上 ppid 会冻结，所以"ppid 没变"**不能**
///    推出"父进程还活着" —— 必须真的探一次。unix 上父死会 reparent 到 1，
///    ppid 比对已经足够，但探活作为**第二判据**同样保留（同 JS 版 `kill(ppid,0)`）。
#[cfg_attr(windows, allow(dead_code))]
fn parent_alive(ppid: u32) -> bool {
    if ppid <= 1 {
        return false;
    }
    #[cfg(unix)]
    {
        // `kill(pid, 0)`：不发信号，只查存在性与权限。返回 -1 且 errno==EPERM
        // 表示**存在但无权发信号** —— 父进程换个用户跑时属正常，仍算活着。
        let rc = unsafe { libc::kill(ppid as i32, 0) };
        if rc == 0 {
            return true;
        }
        return std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, ppid);
            if h.is_null() || h == INVALID_HANDLE_VALUE {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(h, &mut code) != 0;
            CloseHandle(h);
            // 🔴 必须判 `STILL_ACTIVE` 而不只是"句柄打得开"：进程刚退出时句柄仍可开，
            //    但 `GetExitCodeProcess` 已返回真实退出码 —— 只判句柄会把已死的父进程
            //    当成活着，于是看守器**永远不自杀**（失效方向是留孤儿）。
            ok && code == STILL_ACTIVE as u32
        }
    }
}

/// 🔴 pid 复用防护：给 `ppid` 记一份**进程身份**，而不只是数字。
///
/// ## 为什么必须做（本轮实测踩到）
///
/// Windows 上父进程退出后，若它的 pid **尚未被回收**，那么：
///   · `th32ParentProcessID` **冻结**在旧值（不像 unix 会 reparent 到 1）；
///   · `OpenProcess(pid)` **仍能成功**，且 `GetExitCodeProcess` 仍给 `STILL_ACTIVE`
///     （实测 pid 37960 连续 3 轮都返回 `code=259`）。
/// ⇒ 只靠"ppid 没变 + 探活成功"**永远判不出父死**，看守器就一直不自杀 ⇒ 真档留孤儿。
///
/// 而 pid 在 Windows 上**会被复用**：pid 回收后若有新进程占了这个号，
/// `OpenProcess` 就指向了**别人**—— 此时"父还活着"是彻底的误判。
///
/// 身份 = `(pid, 创建时间)`。创建时间来自 `GetProcessTimes`（进程启动的绝对时刻）。
/// pid 复用时新进程的创建时间必然不同 ⇒ 一次比较就足以把两者分开。
///
/// unix 上不需要这层：ppid 变化（reparent 到 1）本身就是权威信号。
#[cfg(windows)]
#[derive(Clone, Copy, PartialEq, Eq)]
struct ProcIdentity {
    pid: u32,
    creation_time: u64,
}

#[cfg(windows)]
fn proc_identity(pid: u32) -> Option<ProcIdentity> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() || h == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut c: windows_sys::Win32::Foundation::FILETIME = std::mem::zeroed();
        let mut e = c;
        let mut k = c;
        let mut u = c;
        let ok = GetProcessTimes(
            h,
            &mut c,
            &mut e,
            &mut k,
            &mut u,
        ) != 0;
        CloseHandle(h);
        if !ok {
            return None;
        }
        // FILETIME 是 100ns 单位的计数，取低 64 位即可（高 32 位在实践中恒 0）。
        let creation = ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64;
        Some(ProcIdentity { pid, creation_time: creation })
    }
}

/// 父进程是否已消失。
///
/// 🔴 返回 `Option<bool>` 而不是 `bool`：**`None` = 判不出来**，与 `Some(true)`（父死）
///    必须是两回事。ToolHelp32 快照在某些环境（权限不足、进程数逼近上限）会**失败**，
///    此时若把它当成"父死"⇒ 会**杀掉一个好好活着的引擎** —— 失效方向最坏的一种
///    （把"看不见"读成"死了"）。所以：拿不到 ppid 时退而用探活，探活也拿不到才判"未知"。
fn parent_gone(boot_ppid: Option<u32>) -> Option<bool> {
    let boot = match boot_ppid {
        Some(p) if p > 1 => p,
        // 装看守时就已经是孤儿 ⇒ 算父死（出生即孤儿，见 run() 的专门分支）
        Some(_) => return Some(true),
        // 🔴 连"我爹是谁"都取不到：**不能**据此判死。交给探活兜底。
        None => return None,
    };

    // ── unix：ppid 变化本身就是权威信号 ──
    #[cfg(unix)]
    {
        return Some(match parent_pid() {
            // 父死 ⇒ reparent 到 1（init）
            Some(1) => true,
            // 换了爹 ⇒ 原父已死
            Some(cur) => cur != boot,
            // 取不到 ⇒ 用探活（独立于 ppid 的第二个判据）
            None => !parent_alive(boot),
        });
    }

    // ── Windows：ppid 冻结 + 探活对未回收 pid 仍报 alive ⇒ 只能用**进程身份** ──
    #[cfg(windows)]
    {
        // 本轮实测：父退出后 pid 尚未回收时，`th32ParentProcessID` 冻结在旧值、
        // `OpenProcess` 仍成功、`GetExitCodeProcess` 连续 3 轮都返回 `code=259`
        // （STILL_ACTIVE）。⇒「ppid 没变 + 探活成功」永远判不出父死。
        // 唯一可靠判据是 `(pid, 创建时间)`：
        //   · 身份取不到 ⇒ 父已退出且 pid 已回收 ⇒ **父死**；
        //   · 身份在但创建时间变了 ⇒ pid 被复用 ⇒ 原父已死；
        //   · 身份不变 ⇒ 父健在。
        match proc_identity(boot) {
            Some(now) => Some(now.creation_time != BOOT_CREATION.load(Ordering::SeqCst)),
            // 取不到身份：可能是没权限，也可能是父已死。
            // 🔴 偏保守：判"父死"。理由是本分支的失效方向必须一致 ——
            //    这里判"健在"的话，Windows 上 E11 就彻底静默失效了（实测已确认）。
            //    而 `parent_holds_stdin_pipe()` 为真时管道通道会在同一轮给出权威判据，
            //    两处一致 ⇒ 不会误杀。
            None => Some(true),
        }
    }
}

/// 装看守那一刻父进程的**创建时间**（Windows 专用；unix 不需要）。
#[cfg(windows)]
static BOOT_CREATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 记录装看守那一刻父进程的身份（须在起child **之前**调用）。
#[cfg(windows)]
fn remember_boot_identity(ppid: Option<u32>) {
    if let Some(p) = ppid.filter(|p| *p > 1) {
        if let Some(id) = proc_identity(p) {
            BOOT_CREATION.store(id.creation_time, Ordering::SeqCst);
        }
    }
}

#[cfg(not(windows))]
fn remember_boot_identity(_ppid: Option<u32>) {}

/// `parent_gone` 的便捷版：**只在明确判死时**才返回 `true`，未知一律按"父健在"处理。
///
/// 🔴 这个"未知即健在"的缺省是刻意的：E11 关心的是"别留孤儿"，而误杀的代价
///    （引擎一起来就没了、报错停在几层之外）比多留 1 秒孤儿的代价更大；
///    且真留孤儿时 ② 的轮询下一秒就会再判一次，不会永久漏判。
fn parent_gone_strict(boot_ppid: Option<u32>) -> bool {
    parent_gone(boot_ppid).unwrap_or(false)
}

/// 起被看守进程。
///
/// 🔴 stdio 三条各有讲究，改任何一条前先读上面的「父进程那一侧的配套改动」：
///   · **stdin = null**：看守器自己的 stdin 是父死通道（管道读端），不能给引擎 ——
///     父进程原本给整条链的就是 null，引擎（`python main.py` / `llama-server`）从不读 stdin
///     （输入走 HTTP），所以这里**与改动前逐字一致**，不引入任何新行为。
///   · **stdout/stderr = inherit**：这是 JS 版 `stdio: 'inherit'` 的等价物 ——
///     引擎的日志必须顺着看守器的管道回到父进程，否则引擎/LLM 的日志会**整段消失**
///     （`Supervisor` 的 `wait_ready` 与就绪行解析都靠它）。
fn spawn_watched(cmd: &[String], cwd: Option<&str>) -> std::result::Result<Child, std::io::Error> {
    let mut c = Command::new(&cmd[0]);
    c.args(&cmd[1..]);
    // 🔴 透传**整个环境**（同 JS 版 `env: process.env`）：引擎要读 PYTHONPATH /
    //    HF_HOME / PATH 等，只挑几个键会让「检测说环境就绪、真机起不来」。
    //    （与 `engine.rs::env_diff()` 的差别：那处管的是**差量注入**，这里是默认继承。）
    c.stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    if let Some(dir) = cwd {
        c.current_dir(dir);
    }
    // POSIX：新进程组 ⇒ `kill(-pid)` 能带走整棵子树（含 llama-server 自己 fork 的东西）。
    // Windows 不设 `CREATE_NEW_PROCESS_GROUP`：那样会把引擎从控制台 Ctrl+C 的广播里
    // 摘出去，而父进程收尾靠的是 `taskkill /T /F`（整树，不看进程组）—— 两边一致。
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    // 🔴 但 `CREATE_NO_WINDOW` 必须给：父进程（喵坞本体）是 `windows_subsystem="windows"`
    //    的无控制台进程，不带这个标志 spawn 控制台程序会**新开一个黑框**。
    hide_console(&mut c);
    c.spawn()
}

/// 父死通道 ①：读自己的 stdin 直到 EOF。
///
/// 🔴🔴 **EOF 只是"候选"，不直接自杀** —— 这是本模块最容易写错的一处。
///
/// 管道 EOF 的真实语义是"**所有写端**都关了"，而"没有写端"有两种完全不同的成因：
///   (a) 父进程死了（我们想要这个）；
///   (b) 父进程**从来没攥住**那个写端，或中途关掉了它（接线错误）。
/// 二者产生的字节流**完全一样**（都是立刻 EOF），但处置相反：(a) 要杀子树，(b) 不能杀。
/// 若照直觉"读到 EOF 就自杀"，症状是**引擎/LLM 一起来就没了**（(b) 情形），
/// 而错误信息停在几层之外（"未在 180s 内就绪"），极难回溯。
///
/// 判别办法：**让 ppid 通道（②）复核**。它问的是"操作系统视角下我爹还在吗"，
/// 与句柄无关。(b) 情形下父进程明明活着 ⇒ 复核为"父仍健在" ⇒ 管道判据作废。
/// 于是管道通道只置 `PIPE_EOF` 这个**候选标志**，由主循环做复核。
fn watch_parent_stdin() {
    std::thread::spawn(|| {
        let started = Instant::now();
        let mut sink = Vec::new();
        let mut stdin = std::io::stdin();
        loop {
            match stdin.read(&mut sink) {
                Ok(0) => break, // EOF：可能是父死，也可能是接线错误 → 交由主循环复核
                Ok(_) => sink.clear(),
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        if started.elapsed() < Duration::from_millis(EARLY_CLOSE_MS) {
            eprintln!(
                "[child-watch] ⚠ 父进程通道在启动后 {}ms 内就闭合了 —— \
                 若父进程随后仍健在，说明它没攥住这条通道（接线错误，已忽略该判据）",
                started.elapsed().as_millis()
            );
        }
        PIPE_EOF.store(true, Ordering::SeqCst);
    });
}

/// 装信号转发：SIGINT / SIGTERM ⇒ 置 `SHUTDOWN`（由主循环去做清理）。
#[cfg(unix)]
fn install_signal_forward() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        libc::signal(libc::SIGINT, handle_signal as libc::sighandler_t);
        libc::signal(libc::SIGTERM, handle_signal as libc::sighandler_t);
    });
}

#[cfg(unix)]
extern "C" fn handle_signal(sig: libc::c_int) {
    // 🔴 异步信号上下文里**只能**做 async-signal-safe 的事；`AtomicU8::store` 是纯内存
    //    操作（无锁），而 `format!`/IO/log 都可能死锁。真正的清理在主循环里做。
    let code = if sig == libc::SIGINT { 2 } else { 3 };
    SHUTDOWN.store(code, Ordering::SeqCst);
}

/// Windows 上没有 SIGINT/SIGTERM 概念，控制台 Ctrl+C/关闭走 `SetConsoleCtrlHandler`。
///
/// 🔴 为什么 Windows 上**也要**装：应用虽是 `windows_subsystem="windows"`（无控制台），
///    但 `cargo run` / e2e 从控制台起时是**有**控制台的 —— 此时 Ctrl+C 若无 handler，
///    看守器会被直接终止，而被看守的 llama-server 留在原地占着 8080。
#[cfg(windows)]
fn install_signal_forward() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(console_handler), 1);
    });
}

#[cfg(windows)]
unsafe extern "system" fn console_handler(ctrl_type: u32) -> i32 {
    use windows_sys::Win32::System::Console::{
        CTRL_BREAK_EVENT, CTRL_C_EVENT, CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT,
    };
    match ctrl_type {
        CTRL_C_EVENT | CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT
        | CTRL_SHUTDOWN_EVENT => {
            // 🔴 用独立的码 4，**不能**复用 1（=父进程已死）：两者处置完全一样
            //    （带走子树 + 自己退），但日志里那句话是排障的**唯一**线索 ——
            //    写错会让"用户关了控制台窗口"被读成"主进程崩了"，方向全错。
            SHUTDOWN.store(4, Ordering::SeqCst);
            1 // TRUE：已处理
        }
        _ => 0,
    }
}

/// 父进程是否**显式声明**它攥住了 stdin 管道的写端（`MIAO_CHILD_WATCH_PIPE=1`）。
///
/// 🔴🔴 为什么必须是**显式声明**而不是"探测 stdin 是不是管道"：
///    本机 Windows 实测 `GetFileType(stdin) == FILE_TYPE_PIPE` 对 Rust `Stdio::piped()`
///    起的子进程返回 **false** —— std 在 Windows 上并非把裸管道直接交给子进程，
///    所以"探测"这条路在 Windows 上恒为假。
///    🔴 而"恒为假"的失效方向极其恶劣：管道判据被永久作废 ⇒ 只剩 ppid 通道 ⇒ 而 Windows 上
///    父进程退出后 `th32ParentProcessID` **冻结**、`OpenProcess` 对未回收的 pid 仍返回
///    `STILL_ACTIVE` ⇒ 看守器**永远判不出父死** ⇒ E11 在真档上彻底失效、且**完全静默**。
///
///    声明式契约把这条知识放在**唯一能保证它正确的地方**（父进程 spawn 那一侧，
///    见 `service.rs::spawn_inner` 与 `supervisor.rs::do_start` 的 `_watch_keepalive`）：
///    父进程知道自己攥住了写端，就由它来说。声明缺失 ⇒ 管道判据作废、只走 ②。
fn parent_holds_stdin_pipe() -> bool {
    std::env::var("MIAO_CHILD_WATCH_PIPE").ok().as_deref() == Some("1")
}

/// 把标志位翻译成日志里那句话（沿用 JS 版的措辞，便于两边日志对照）。
fn describe_reason(code: u8) -> &'static str {
    match code {
        1 => "父进程已消失",
        2 => "收到 SIGINT",
        3 => "收到 SIGTERM",
        4 => "收到控制台关闭事件",
        _ => "未知原因",
    }
}

/// 带走整棵子树。Windows 用 `taskkill /T /F`；POSIX 用对进程组发信号。
fn kill_tree(pid: u32, force: bool) {
    if pid <= 1 {
        return;
    }
    #[cfg(windows)]
    {
        // 🔴 Windows 上「先礼」（不带 /F）对**控制台进程无效**（D-89）：`taskkill /T` 不带
        // /F 对 node 返回 255、对 Python 返回 128，目标进程一个不死。所以 Windows 上无论
        // 先礼后兵都直接 /F —— 平台没有「优雅」这一档，硬保留先礼只会空等、
        // 还给孙进程（执行器）被 reparent 成孤儿占着 port+1 的窗口。
        let mut c = Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]);
        // `CREATE_NO_WINDOW`：taskkill 也是控制台程序，父进程（GUI）没控制台 ⇒ 会闪黑框。
        hide_console(&mut c);
        let _ = c.stdout(Stdio::null()).stderr(Stdio::null()).status();
        let _ = force; // 语义保留：unix 分支靠它区分 SIGTERM/SIGKILL；Windows 分支两档等价
    }
    #[cfg(unix)]
    {
        let sig = if force { libc::SIGKILL } else { libc::SIGTERM };
        unsafe {
            // 组 id 取负：`kill(-pid, …)` 是 POSIX 的"发给整组"（含被看守进程自己 fork 的孙进程）
            if libc::kill(-(pid as i32), sig) != 0 {
                // 拿不到进程组（理论上不该发生：spawn 时已 `process_group(0)`）⇒ 退回单进程
                libc::kill(pid as i32, sig);
            }
        }
    }
}

/// 被看守进程的退出码：正常退出给原值；被信号杀死给 `128 + signal`。
fn exit_code_of(status: &std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return 128 + sig;
        }
    }
    // Windows：被 `taskkill /F` 收掉时 `code()` 给 `Some(nonzero)`，正常走不到这里。
    1
}

/// `MIAO_NO_PARENT_WATCH=1` 才关看守；其它任何值（含未设、空串）都开着。
fn watch_enabled_now() -> bool {
    std::env::var("MIAO_NO_PARENT_WATCH").ok().as_deref() != Some("1")
}

// ------------------------------------------------------------------ 测试夹具：「Rust 父」

/// e2e 的**产品同源**夹具：扮演父进程，按 `service.rs::spawn_inner` 的**完全相同**接线
/// 起一个看守器，活 `alive_ms` 后**硬退**（`process::exit`，等价被 SIGKILL 后的效果：
/// 所有句柄由 OS 关闭、写端随之消失）。
///
/// ## 为什么必须有这个夹具（而不是让 e2e 用 node 当父）
///
/// 本轮实测踩到的坑：`e2e` 若用 **node** 当父进程，管道通道在 Windows 上**不可靠** ——
/// node `spawn` 时给子进程 stdio 的管道并非裸匿名管道，`process.exit()` 后那个写端
/// **不会**让子进程读到 EOF；此时看守器只能退回 ppid 通道，而 Windows 上父退出后
/// `th32ParentProcessID` **冻结**、`OpenProcess` 对未回收的 pid 仍返回 `STILL_ACTIVE`
/// ⇒ **永远判不出父死** ⇒ 孤儿留存、且日志里一行都没有。
///
/// 而产品的父是 **Rust**（`service.rs` / `supervisor.rs`）：它们攥着 `ChildStdin`，
/// 进程一死句柄即由 OS 关闭 ⇒ 管道通道可靠、且是内核事件（立刻送达）。
///
/// 🔴 所以「e2e 用 node 当父」测的是**一个产品里不存在的场景**。用它当判据会得出
///    「Rust 版 E11 失效」这个**错误结论**（本轮真的差点据此改坏产品）。
///    正确做法：父也用 Rust，与产品同源。
///
/// 用法：`boxsvc --child-watch-parent <alive_ms> -- <cmd> [args...]`
pub fn run_as_parent(args: &[String]) -> i32 {
    let sep = args.iter().position(|a| a == "--");
    let (alive_ms, cmd): (u64, Vec<String>) = match sep {
        Some(i) => (
            args.first()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(1000),
            args[i + 1..].to_vec(),
        ),
        None => (1000, Vec::new()),
    };
    if cmd.is_empty() {
        eprintln!("用法：boxsvc --child-watch-parent <alive_ms> -- <cmd> [args...]");
        return 2;
    }

    let watcher = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("boxsvc"));
    let mut c = Command::new(&watcher);
    c.arg("--child-watch")
        .arg("--")
        .args(&cmd);
    // 🔴 与 `service.rs::spawn_inner` 逐字一致的两条接线：管道 + 声明。
    //    少任何一条，看守器都拿不到权威的父死证据（见 `parent_holds_stdin_pipe`）。
    let mut child = match {
        c.stdin(Stdio::piped());
        c.env("MIAO_CHILD_WATCH_PIPE", "1");
        // 看守器是控制台程序：父进程（这个夹具）可能是 GUI 宿主 ⇒ 不隐藏就会闪黑框。
        hide_console(&mut c);
        c.spawn()
    } {
        Ok(ch) => ch,
        Err(e) => {
            // ⚠️ `Stdio::piped()` 在**句柄耗尽**的机器上会返回
            //    `ERROR_NO_SYSTEM_RESOURCES`(231)。那是环境问题、不是接线问题。
            //    此时**显式**声明没有管道（`=0`），让看守器只靠进程身份通道判定 ——
            //    宁可慢最多 `PPID_POLL_MS`，也**不能悄悄降级**：悄悄降级会让
            //    E11 静默失效（这正是本轮修掉的缺陷 ①）。
            eprintln!("[child-watch-parent] ⚠ 建管道失败（{e}）⇒ 显式降级为「仅进程身份」判定");
            let mut c2 = Command::new(&watcher);
            c2.arg("--child-watch").arg("--").args(&cmd);
            c2.stdin(Stdio::null());
            c2.env("MIAO_CHILD_WATCH_PIPE", "0");
            hide_console(&mut c2);
            match c2.spawn() {
                Ok(ch) => ch,
                Err(e2) => {
                    eprintln!("[child-watch-parent] 无法起看守器：{e2}");
                    return 1;
                }
            }
        }
    };

    // 🔴 **攥住写端**并显式不 drop：这一句是整个夹具的意义所在。
    //    它随 `self` 活到本函数结尾，父"死亡"时由 OS 关闭 ⇒ 看守器读到 EOF。
    let _keepalive = child.stdin.take();

    eprintln!("[child-watch-parent] 看守器 pid={}，{}ms 后硬退", child.id(), alive_ms);
    std::thread::sleep(Duration::from_millis(alive_ms));
    // 模拟"父被 SIGKILL"：不做任何清理、不 kill 子进程，直接走 —— 句柄由 OS 回收。
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argvec(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// 造一个已知退出码的 `ExitStatus`（走真实进程，跨平台）。
    fn exit_status_of(code: i32) -> std::process::ExitStatus {
        #[cfg(windows)]
        let out = {
            let mut c = Command::new("cmd");
            c.args(["/C", &format!("exit {code}")]);
            c.spawn().unwrap().wait().unwrap()
        };
        #[cfg(not(windows))]
        let out = Command::new("sh")
            .arg("-c")
            .arg(format!("exit {code}"))
            .status()
            .unwrap();
        out
    }

    #[test]
    fn missing_separator_is_usage_error() {
        assert_eq!(run(&argvec(&["python", "main.py"])), 2);
    }

    #[test]
    fn empty_command_after_separator_is_usage_error() {
        assert_eq!(run(&argvec(&["--"])), 2);
    }

    #[test]
    fn nonexistent_command_exits_one_without_panicking() {
        // 🔴 反证：不能是 2（那是「参数没 `--`」的用法错），也不能是 0（会被上层
        //    当成「引擎正常退出」⇒ 症状是"服务起来了但翻译一直失败"）。
        assert_eq!(run(&argvec(&["--", "miao-no-such-binary-xyz"])), 1);
    }

    #[test]
    fn exit_code_passes_through_child_status() {
        // 🔴 反证：不能是「恒 0」或「恒 1」—— 契约要求看守**不吞**被看守进程的退出码，
        //    否则 ServiceManager 会把「引擎挂了」看成「正常退出」。
        assert_eq!(exit_code_of(&exit_status_of(0)), 0);
        assert_eq!(exit_code_of(&exit_status_of(7)), 7);
    }

    #[test]
    fn no_parent_watch_only_disables_on_exact_one() {
        // 判据：只有 `MIAO_NO_PARENT_WATCH=1` 关看守；未设/空串/其它值都开着。
        // 🔴 反证：写成「只要设了这个变量就关」会让 E11 的反证开关在某些写法下失效，
        //    而失效方向是**静默**的（看守悄悄不装了 ⇒ 真模式留孤儿）。
        let prev = std::env::var("MIAO_NO_PARENT_WATCH").ok();
        let restore = || match prev.clone() {
            Some(v) => std::env::set_var("MIAO_NO_PARENT_WATCH", v),
            None => std::env::remove_var("MIAO_NO_PARENT_WATCH"),
        };
        std::env::remove_var("MIAO_NO_PARENT_WATCH");
        assert!(watch_enabled_now());
        std::env::set_var("MIAO_NO_PARENT_WATCH", "");
        assert!(watch_enabled_now());
        std::env::set_var("MIAO_NO_PARENT_WATCH", "0");
        assert!(watch_enabled_now());
        std::env::set_var("MIAO_NO_PARENT_WATCH", "1");
        assert!(!watch_enabled_now());
        restore();
    }

    #[test]
    fn shutdown_grace_is_long_enough_and_not_absurd() {
        // 🔴 反证：调到 0 会让「先礼后兵」退化成「立即 SIGKILL」，掐掉引擎
        //    `proc.terminate()` 的清理窗口 ⇒ 执行器成孤儿（D-89 同款故障）。
        assert!(SHUTDOWN_GRACE_MS >= 1000, "先礼后兵窗口过短：{SHUTDOWN_GRACE_MS}ms");
        assert!(SHUTDOWN_GRACE_MS <= 10_000, "窗口过长拖慢每次停止：{SHUTDOWN_GRACE_MS}ms");
    }

    #[test]
    fn reason_wording_matches_js_version() {
        // 日志措辞与 JS 版一致（两边日志放一起看时不串味）；少一条就是"改了文案"。
        assert_eq!(describe_reason(1), "父进程已消失");
        assert_eq!(describe_reason(2), "收到 SIGINT");
        assert_eq!(describe_reason(3), "收到 SIGTERM");
    }

    #[test]
    fn console_close_is_not_reported_as_parent_death() {
        // 🔴 反证：Windows 控制台事件曾复用码 1（＝父进程已消失）。两者**处置**相同，
        //    所以行为测试抓不到，只有直接查文案才能钉住 —— 而文案错的方向性很强：
        //    "用户关了控制台窗口"被读成"主进程崩了"，会把排障引到完全错误的方向。
        assert_eq!(describe_reason(4), "收到控制台关闭事件");
        assert_ne!(describe_reason(4), describe_reason(1));
    }

    #[test]
    fn pipe_declaration_is_exactly_one() {
        // 判据：`MIAO_CHILD_WATCH_PIPE` 只有精确等于 "1" 才算「父攥住了写端」。
        // 🔴 反证：写成「只要设了这个变量就算」⇒ 夹具在管道创建失败时显式降级注入
        //    `=0` 也会被判成"父攥住了" ⇒ 那条通道会给出**错误的权威判据**。
        let prev = std::env::var("MIAO_CHILD_WATCH_PIPE").ok();
        std::env::remove_var("MIAO_CHILD_WATCH_PIPE");
        assert!(!parent_holds_stdin_pipe());
        std::env::set_var("MIAO_CHILD_WATCH_PIPE", "0");
        assert!(!parent_holds_stdin_pipe());
        std::env::set_var("MIAO_CHILD_WATCH_PIPE", "");
        assert!(!parent_holds_stdin_pipe());
        std::env::set_var("MIAO_CHILD_WATCH_PIPE", "1");
        assert!(parent_holds_stdin_pipe());
        match prev {
            Some(v) => std::env::set_var("MIAO_CHILD_WATCH_PIPE", v),
            None => std::env::remove_var("MIAO_CHILD_WATCH_PIPE"),
        }
    }

    #[test]
    fn unknown_parent_state_is_not_treated_as_dead() {
        // 🔴 本模块最重要的一条语义：`None`（判不出来）**不等于** `Some(true)`（父死）。
        //    ToolHelp32 快照在权限不足/进程数逼近上限时会失败；把它当"父死"会
        //    **杀掉一个好好活着的引擎** —— 这是最坏的失效方向（误杀 > 多留 1 秒孤儿）。
        assert_eq!(parent_gone(None), None);
        assert!(!parent_gone_strict(None), "未知必须按「父健在」处理");
    }
}