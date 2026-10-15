//! M3 生命周期验收（B1–B3）的**程序化**跑法。
//!
//! 为什么需要这个：B1–B3 原本只能靠人点（关窗、看托盘、点退出菜单），而本机没有授予
//! 「自动化」权限 —— 连 `osascript` 都被 TCC 以 `-10004` 拒绝，非沙箱模式同样如此。
//! 于是这三条验收会永远悬着，「未验证」和「已验证」在台账上就只能靠一句主观描述区分。
//!
//! 这里的做法是**程序化触发同一条代码路径**，而不是模拟：
//!   · `window.close()` 触发的正是点关闭按钮所走的 `WindowEvent::CloseRequested`
//!   · 托盘菜单走的是同一个 `tray_action()` 函数，只是调用方从事件回调换成自检
//! 断言取的都是**运行时可观测量** —— 窗口是否可见、服务端口是否仍有人监听、
//! `/health` 是否仍返回 200、进程有没有走到最后一步 —— 不是回头读一遍自己的源码。
//!
//! 用法：
//!   `MIAO_SELFTEST=1 miao-dock`  → 跑一遍，把结果打成一行 JSON 后退出
//!   `MIAO_CLOSE_QUITS=1`         → **反证开关**：关窗即退进程
//!
//! 关于反证开关：跑了绿不等于测对了。若把「关窗」换成真退出后这组断言**仍然全绿**，
//! 那它测的就不是「关窗仅隐藏」。所以这个开关是刻意留的，配合脚本做双向验证
//! （见 ~/.workbuddy/skills/falsifiable-verification）。
pub mod capture;

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::service::ServiceManager;

const SELFTEST_ENV: &str = "MIAO_SELFTEST";
const CLOSE_QUITS_ENV: &str = "MIAO_CLOSE_QUITS";

/// B1 后半条要用的样张：40×60 真 PNG（生成脚本 `e2e/make-probe-png.mjs`）。
/// 必须是**真的** PNG —— 服务端有魔数嗅探（契约 §8.2），塞假字节只会得到 INVALID_IMAGE，
/// 那样验出来的只是「校验还在」，不是「关窗后还能干活」。
static PROBE_PNG: &[u8] = include_bytes!("../../testdata/probe.png");

/// 等服务起来、前端也挂上（首次启动要探端口段 + 拉引擎）
const BOOT_WAIT: Duration = Duration::from_secs(7);
/// close() 之后给事件循环一点时间把 CloseRequested 跑完
const AFTER_CLOSE: Duration = Duration::from_millis(900);
/// 托盘 quit → 前端弹确认层 → 渲染完成
const AFTER_QUIT: Duration = Duration::from_millis(900);

fn flag(key: &str) -> bool {
    std::env::var(key)
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

pub fn enabled() -> bool {
    flag(SELFTEST_ENV)
}

/// 关窗即退进程（仅用于反证断言有效性；契约 §2.1 要求的是「仅隐藏」）
pub fn close_quits() -> bool {
    flag(CLOSE_QUITS_ENV)
}

// ------------------------------------------------------------------ 结果收集

#[derive(Default)]
struct Checks {
    items: Vec<(String, bool, String)>,
}

impl Checks {
    fn add(&mut self, id: &str, ok: bool, detail: impl Into<String>) {
        self.items.push((id.into(), ok, detail.into()));
    }
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn report(items: &[(String, bool, String)]) {
    let passed = items.iter().filter(|(_, ok, _)| *ok).count();
    let rows: Vec<String> = items
        .iter()
        .map(|(id, ok, d)| format!("{{\"id\":{},\"ok\":{},\"detail\":{}}}", json_str(id), ok, json_str(d)))
        .collect();
    println!(
        "MIAO_SELFTEST_RESULT {{\"passed\":{},\"total\":{},\"checks\":[{}]}}",
        passed,
        items.len(),
        rows.join(",")
    );
}

// ------------------------------------------------------------------ 主线程调度

/// 在主线程跑一段闭包并把结果拿回来（窗口 API 必须在主线程调用）
pub(crate) fn on_main<T, F>(app: &AppHandle, f: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce(&AppHandle) -> T + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    if app
        .run_on_main_thread(move || {
            let _ = tx.send(f(&handle));
        })
        .is_err()
    {
        return None;
    }
    rx.recv_timeout(Duration::from_secs(10)).ok()
}

fn port_open(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(800)).is_ok()
}

/// 从**外部**给子进程发 SIGTERM —— 用来制造「② 挂了」这个事件。
///
/// 为什么要自己发信号、而不是让被测进程"报告自己挂了"：后者是被测方自证，不构成证据。
/// 「外部制造事件 → 回读状态」才是崩溃分级这类**机制类**断言的正确取证方式。
/// ⚠️ Windows 分支本机无法验证（G2 ④）⇒ 返回 false 让该条判红，**不假装通过**。
fn kill_child(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, libc::SIGTERM) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// 关窗后**真的提交一次翻译任务**并等它跑完。
///
/// 这是 B1 的后半条：契约判据写的是「窗口隐藏；进程存活；**此时用插件/curl 提交任务仍成功执行**」。
/// 只打 `/health` 200 是不够的 —— 那只说明服务还在应答，不说明它还能干活
/// （比如 worker 被关窗顺手停掉了，/health 照样是绿的）。
fn submit_and_wait(base: &str, token: &str) -> (bool, String) {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
    {
        Ok(c) => c,
        Err(e) => return (false, format!("客户端构建失败：{e}")),
    };
    let key = format!("selftest-{}", std::process::id());
    let payload = format!("{{\"comicName\":\"B1 关窗后提交\",\"idempotencyKey\":\"{key}\"}}");
    let part = match reqwest::blocking::multipart::Part::bytes(PROBE_PNG.to_vec())
        .file_name("001.png")
        .mime_str("image/png")
    {
        Ok(p) => p,
        Err(e) => return (false, format!("构造上传部件失败：{e}")),
    };
    let form = reqwest::blocking::multipart::Form::new()
        .text("payload", payload)
        .part("images", part);

    let created = match client
        .post(format!("{base}/tasks"))
        .header("X-Box-Token", token)
        .multipart(form)
        .send()
    {
        Ok(r) => r,
        Err(e) => return (false, format!("提交失败：{e}")),
    };
    let code = created.status().as_u16();
    let body = created.text().unwrap_or_default();
    if !(200..300).contains(&code) {
        return (false, format!("提交返回 HTTP {code}：{}", body.chars().take(160).collect::<String>()));
    }
    let task_id = match serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("taskId").and_then(|t| t.as_str()).map(str::to_string))
    {
        Some(id) => id,
        None => return (false, format!("响应无 taskId：{}", body.chars().take(160).collect::<String>())),
    };

    // 等它跑到终态（1 张图，正常几百毫秒内）
    let until = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        match client
            .get(format!("{base}/tasks/{task_id}"))
            .header("X-Box-Token", token)
            .send()
        {
            Ok(r) => {
                let text = r.text().unwrap_or_default();
                let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
                let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
                if matches!(status, "done" | "partial_failed" | "failed" | "canceled") {
                    return (
                        status == "done",
                        format!("关窗后提交 {task_id} 并跑到 {status}"),
                    );
                }
            }
            Err(e) => return (false, format!("轮询失败：{e}")),
        }
        if std::time::Instant::now() > until {
            return (false, format!("{task_id} 30s 内未到终态"));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// 驱动设置页的「规格自检」跑一遍，把结果经 `location.hash` 回传。
///
/// 设置页里那份自检（C1–C7 与 B2d / B3a–c）本来要人点一下才跑。既然这里已经能 eval，
/// 就顺手把它也带进自动化 —— 否则「界面与方案文档对得上」在回归里仍然是一条主观描述。
/// 走的是**真实界面**：切到设置页 → 点那个按钮 → 读渲染出来的结果行，不是复算一遍公式。
const SPEC_DRIVER_JS: &str = r#"
(async function () {
  function put(v) { location.hash = 'miaospec=' + encodeURIComponent(v); }
  function nameOf(b) {
    // 可访问名称：aria-label 优先，其次可见文字，最后 title。
    // ver2.0 把设置入口改成**纯图标**（无可见文字），所以只认 textContent 会找不到它
    // —— 那不是实现坏了，是断言的定位方式跟不上设计。所以这里三种都认。
    return (b.getAttribute('aria-label') || b.textContent || b.getAttribute('title') || '').trim();
  }
  try {
    var nav = Array.prototype.slice.call(document.querySelectorAll('.nav-item'))
      .filter(function (b) { return nameOf(b).indexOf('设置') >= 0; })[0];
    if (!nav) { put('NO_SETTINGS_NAV'); return; }
    nav.click();
    await new Promise(function (r) { setTimeout(r, 400); });

    // 规格自检在①通用组里。ver2.0 起设置页是两栏壳 + 5 分组，当前分组由
    // 深链 ?section= 决定 —— 若上一步把分组停在别的组上，「运行自检」就不在屏上。
    // 这里显式回到①通用组，避免「断言因分组不对而误报」。
    var general = Array.prototype.slice.call(document.querySelectorAll('.set-nav-item'))
      .filter(function (b) { return nameOf(b).indexOf('通用') >= 0; })[0];
    if (general) { general.click(); await new Promise(function (r) { setTimeout(r, 400); }); }

    var btn = Array.prototype.slice.call(document.querySelectorAll('button'))
      .filter(function (b) { return (b.textContent || '').trim() === '运行自检'; })[0];
    if (!btn) { put('NO_SELFTEST_BUTTON'); return; }
    btn.click();
    await new Promise(function (r) { setTimeout(r, 2200); });

    var rows = Array.prototype.slice.call(document.querySelectorAll('.spec-row'));
    var bad = rows.filter(function (r) { r.classList.contains('is-bad'); })
      .map(function (r) { return (r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70); });
    put('SPEC total=' + rows.length + ' failed=' + bad.length + (bad.length ? ' | ' + bad.join(' ; ') : ''));
  } catch (e) { put('EXC ' + String(e)); }
})();
"#;

/// 从 `http://127.0.0.1:5180/api/v1` 里取出端口。
/// 注意别写成「`rsplit(':')` 取最后一段」—— base 结尾带 `/api/v1`，那样取到的是 `5180/api/v1`。
fn port_from_base(base: &str) -> u16 {
    base.split("//")
        .nth(1)
        .and_then(|s| s.split(':').nth(1))
        .and_then(|s| s.split('/').next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// `%E9%80%80...` → 原文。只处理 `%XX`，其余原样透传。
fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 直接打一次 `/health`（证明服务不只是「端口有人监听」，而是真的在正常应答）。
///
/// 注意 `base` 已经含 `/api/v1`（见 `ServiceManager::base_url`），所以这里只能拼 `/health`。
fn health_ok(base: &str, token: &str) -> (bool, String) {
    let client = match reqwest::blocking::Client::builder().timeout(Duration::from_secs(5)).build() {
        Ok(c) => c,
        Err(e) => return (false, format!("客户端构建失败：{e}")),
    };
    match client
        .get(format!("{base}/health"))
        .header("X-Box-Token", token)
        .send()
    {
        Ok(r) => {
            let code = r.status().as_u16();
            (code == 200, format!("GET {base}/health → HTTP {code}"))
        }
        Err(e) => (false, format!("请求失败：{e}")),
    }
}

// ------------------------------------------------------------------ 自检流程

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut all: Vec<(String, bool, String)> = Vec::new();
        std::thread::sleep(BOOT_WAIT);

        // ---- 第 1 步：托盘是否就位；然后 close() 触发关窗 ----
        let step1 = on_main(&app, |a| {
            let mut c = Checks::default();

            // B2：托盘常驻 + 菜单项齐全（「退出喵坞…」的存在是 B3 的前提）
            c.add(
                "B2a",
                a.tray_by_id("main").is_some(),
                "托盘图标已创建（托盘常驻 = 关窗后应用仍在）",
            );

            let entries = crate::TRAY_MENU_SNAPSHOT.get().cloned().unwrap_or_default();
            let has = |id: &str| entries.iter().any(|e| e.starts_with(&format!("{id}=")));
            c.add(
                "B2b",
                has("show") && has("restart") && has("quit"),
                format!("菜单项：{}", entries.join(" / ")),
            );
            c.add(
                "B2c",
                entries.iter().any(|e| e == "quit=退出喵坞…"),
                entries
                    .iter()
                    .find(|e| e.starts_with("quit="))
                    .cloned()
                    .unwrap_or_else(|| "无 quit 项".into()),
            );

            // B1 前置：窗口此刻可见
            match a.get_webview_window("main") {
                Some(w) => {
                    c.add("B1a", w.is_visible().unwrap_or(false), "自检开始时窗口可见");
                    // 触发的就是点关闭按钮那条路径
                    let _ = w.close();
                }
                None => {
                    c.add("B1a", false, "找不到 main 窗口");
                    c.add("B1b", false, "找不到 main 窗口");
                }
            }

            // ---- S2：三进程生命周期（五态机 / E1 生效参数快照 / 三重就绪）----
            // 取的都是**运行时可观测量**：状态机真实轨迹、日志里真的打出来的参数快照、
            // 三个子进程的真实 pid —— 不是回头读一遍自己的源码（那只能证明"写了"）。
            let mgr = a.state::<ServiceManager>();
            let st = mgr.status();
            let has = |k: &str| st.transitions.iter().any(|t| t == k);
            c.add(
                "S2a",
                has("starting") && has("L1") && has("L2") && has("L3") && has("running"),
                format!("五态机轨迹：{}", st.transitions.join("→")),
            );
            let snap: Vec<String> = st
                .log
                .iter()
                .filter(|l| l.contains("② engine") || l.contains("③ llm") || l.contains("① service"))
                .cloned()
                .collect();
            c.add(
                "S2b",
                st.log.iter().any(|l| l.contains("生效参数快照")) && snap.len() == 3,
                format!("E1 生效参数快照 {} 行：{}", snap.len(), snap.join(" ／ ")),
            );
            let pids: Vec<String> = st
                .children
                .iter()
                .map(|x| format!("{}={:?}", x.name, x.pid))
                .collect();
            // S4：③ 的归属权移交 manga-service（《04》§9.1）⇒ 本 Manager 直接持有的子进程
            // 从 3 个变成 **2 个**（① service + ② engine）。
            //
            // ⚠️ 断言必须**按名字点名**，两个错法都不能用：
            //   · 数 `children.len()` —— `Children::view()` 是**固定三行的视图**（缺席的那项
            //     `pid = None`），长度恒为 3 ⇒ 写成 `== 2` 会**恒红**。实测它红了一段时间没人发现，
            //     因为 S7 只跑 `--e11` 子集，默认的 B/S 组没进 S7 的门。
            //   · 只数"pid 非空"的个数 —— 会退化成"少一个就红"的一半：① 与 ② 混在一起数，
            //     "少起 ① + 多起 ③"也能凑够 2。所以**逐个点名**。
            //   · 也**不能**放宽成 `>= 2`：那样"少起了一个进程"就永远看不见了，
            //     而这条断言的全部价值就在于"少一个就红"。
            //
            // ③ 是否活着**不在这条断言的范围内**（它已归 manga-service，是本进程的孙进程）——
            // 由 `/health.sidecar.llm` 那条链路负责（`check:contract` / `check:engine-settings` /
            // E11 的 `selftest:app:e11:real`）。这里反过来**钉住"③ 不在本进程"**：
            // 哪天 ③ 又被本进程拉起来，它会红 —— 那不是噪音，是契约变更的信号。
            let held = |name: &str| st.children.iter().find(|x| x.name == name);
            let svc_ok = held("service").is_some_and(|x| x.pid.is_some() && x.alive);
            let eng_ok = held("engine").is_some_and(|x| x.pid.is_some() && x.alive);
            let llm_not_held = held("llm").is_some_and(|x| x.pid.is_none());
            c.add(
                "S2c",
                svc_ok && eng_ok && llm_not_held,
                format!(
                    "mode={} 本进程持有的子进程（应为 ① service + ② engine；③ 归 manga-service）：{}",
                    st.mode,
                    pids.join(" ")
                ),
            );

            // 供后台线程做 HTTP 探活
            (c.items, mgr.base_url(), mgr.token())
        });

        let Some((items1, base, token)) = step1 else {
            println!("MIAO_SELFTEST_RESULT {{\"passed\":0,\"total\":1,\"checks\":[{{\"id\":\"boot\",\"ok\":false,\"detail\":\"主线程调度失败\"}}]}}");
            return;
        };
        let base_port = base.as_deref().map(port_from_base).unwrap_or(0);
        all.extend(items1);

        std::thread::sleep(AFTER_CLOSE);

        // ---- 第 2 步：关窗后 —— 窗口应隐藏、服务应还活着 ----
        let step2 = on_main(&app, move |a| {
            let mut c = Checks::default();

            match a.get_webview_window("main") {
                Some(w) => {
                    let vis = w.is_visible().unwrap_or(true);
                    c.add(
                        "B1b",
                        !vis,
                        format!("close() 之后 is_visible={vis}（期望 false —— 仅隐藏）"),
                    );
                }
                None => c.add("B1b", false, "窗口已不存在（说明被真的关闭了，与「仅隐藏」不符）"),
            }

            // 服务进程是否仍活着：端口是否仍有人监听
            c.add(
                "B1c",
                base_port != 0 && port_open(base_port),
                format!("关窗后 manga-service 端口 {base_port} 仍监听"),
            );

            // B3 前置：把窗口收起来，验证「托盘退出会把窗口唤回来让你确认」
            if let Some(w) = a.get_webview_window("main") {
                let _ = w.hide();
            }
            crate::tray_action(a, "quit");
            c
        });
        let Some(c2) = step2 else {
            all.push(("step2".into(), false, "主线程调度失败".into()));
            report(&all);
            return;
        };
        all.extend(c2.items);

        std::thread::sleep(AFTER_QUIT);

        // ---- 第 3 步：托盘 quit 之后 —— 窗口被唤出、进程仍在（走的是确认路径） ----
        let step3 = on_main(&app, |a| {
            let mut c = Checks::default();

            let vis = a
                .get_webview_window("main")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            c.add(
                "B3d",
                vis,
                format!("托盘「退出喵坞…」之后窗口被唤出（is_visible={vis}）—— 让你看清确认文案再决定"),
            );
            c.add(
                "B3e",
                true,
                "自检走到了这一步 = 托盘退出**没有**直接杀进程，走的是二次确认路径",
            );

            // 前端确认层是否真的渲染出来了：把 DOM 文本回传。
            // 走**两条通道**（document.title 与 location.hash），因为这两条在不同平台上
            // 可靠性不同 —— 两条都不通就说明 eval 压根没执行，那是另一类故障，不该被混为一谈。
            // 无论哪条，读的都是**真实运行中的 WebView** 渲染结果，不是回头复查源码。
            if let Some(w) = a.get_webview_window("main") {
                let _ = w.eval(
                    "var __t=((document.querySelector('.modal-body')||{}).textContent||'NONE').replace(/\\s+/g,' ').trim();\
                     document.title='MIAOPROBE:'+__t;\
                     location.hash='miaoprobe='+encodeURIComponent(__t);",
                );
            }
            c
        });
        if let Some(c3) = step3 {
            all.extend(c3.items);
        }

        // 回传需要一点点时间
        std::thread::sleep(Duration::from_millis(400));
        let (title, frag) = on_main(&app, |a| {
            let w = a.get_webview_window("main");
            let title = w.as_ref().and_then(|w| w.title().ok()).unwrap_or_default();
            let frag = w
                .as_ref()
                .and_then(|w| w.url().ok())
                .and_then(|u| u.fragment().map(str::to_string))
                .unwrap_or_default();
            (title, frag)
        })
        .unwrap_or_default();

        let from_title = title.strip_prefix("MIAOPROBE:").unwrap_or("");
        let from_hash = frag.strip_prefix("miaoprobe=").map(pct_decode).unwrap_or_default();
        let shown = if !from_title.is_empty() { from_title.to_string() } else { from_hash };
        all.push((
            "B3f".into(),
            shown.contains("退出后浏览器插件将无法提交翻译任务"),
            if shown.is_empty() {
                "两条回传通道都没拿到文本（eval 未生效或窗口不可读）".into()
            } else {
                format!("确认层文本：{shown}")
            },
        ));

        // ---- 规格自检（C1–C7 / B2d / B3a–c）：驱动界面真的跑一遍，把结果读回来 ----
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.eval(SPEC_DRIVER_JS);
        }
        std::thread::sleep(Duration::from_millis(3400));
        let spec_raw = on_main(&app, |a| {
            a.get_webview_window("main")
                .and_then(|w| w.url().ok())
                .and_then(|u| u.fragment().map(pct_decode))
                .unwrap_or_default()
        })
        .unwrap_or_default();
        let spec = spec_raw.strip_prefix("miaospec=").unwrap_or(&spec_raw).to_string();
        {
            // 只看 `failed=0` 是不够的：一行都没渲染出来时 total=0、failed 也是 0，
            // 那会变成一个「什么都没测 = 通过」的假绿。所以两个数都要看。
            let total: usize = spec
                .split("total=")
                .nth(1)
                .and_then(|s| s.split(' ').next())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let failed: usize = spec
                .split("failed=")
                .nth(1)
                .and_then(|s| s.split([' ', '|']).next())
                .and_then(|s| s.parse().ok())
                .unwrap_or(usize::MAX);
            all.push((
                "S1".into(),
                total > 0 && failed == 0,
                if spec.is_empty() { "未取到规格自检结果".into() } else { spec },
            ));
        }

        // 后台线程做 HTTP 探活与真提交（主线程不适合阻塞在网络上，更不该在这里跑 30s 轮询）
        match (&base, &token) {
            (Some(base), Some(token)) => {
                let (ok, detail) = health_ok(base, token);
                all.push(("B1d".into(), ok, format!("关窗后 /health 应答：{detail}")));

                let (ok, detail) = submit_and_wait(base, token);
                all.push(("B1e".into(), ok, detail));
            }
            _ => {
                all.push(("B1d".into(), false, "服务未启动，取不到 base/token".into()));
                all.push(("B1e".into(), false, "服务未启动，无法提交".into()));
            }
        }

        // ---- S2d 崩溃分级：从**外面**杀掉 ② engine ----
        // 判据是「① 仍 running（服务没跟着塌）+ degraded 翻真（不静默）」。
        // 反证开关 `MIAO_NO_CRASH_MONITOR=1` 关掉看护后，degraded 不会翻转 ⇒ 这条必红。
        // ⚠️ S4 起改杀 ② 而不是 ③：③ 的归属权已移交 manga-service，本 Manager 的 `children`
        //    里根本没有它（`child_pid("llm")` 恒为 None ⇒ 断言会**恒红**，看着像"机制坏了"
        //    实则判据失效）。机制本身没变 —— 仍是"外部杀掉一个非 ① 的子进程 ⇒ 分级为
        //    degraded 而非整体 error"。③ 挂掉的降级路径改由 manga-service 的 `/health` 表达（S5）。
        {
            let pid = on_main(&app, |a| a.state::<ServiceManager>().child_pid("engine")).flatten();
            let killed = pid.map(kill_child).unwrap_or(false);
            std::thread::sleep(Duration::from_millis(2600)); // 看护每 1s 巡一次，留两轮余量
            let (state, degraded, err) = on_main(&app, |a| {
                let st = a.state::<ServiceManager>().status();
                (
                    format!("{:?}", st.state).to_lowercase(),
                    st.degraded,
                    st.last_error.clone().unwrap_or_default(),
                )
            })
            .unwrap_or_else(|| ("?".into(), false, "主线程调度失败".into()));
            all.push((
                "S2d".into(),
                killed && state == "running" && degraded,
                format!("外部杀掉 ②(pid={pid:?}) 后 state={state} degraded={degraded} {err}"),
            ));
        }

        // 退出前把子进程收干净，免得留下孤儿占端口
        let _ = on_main(&app, |a| {
            a.state::<ServiceManager>().stop();
        });

        report(&all);
        let _ = on_main(&app, |a| {
            a.exit(0);
        });
    });
}
