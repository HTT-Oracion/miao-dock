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
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::service::ServiceManager;

const SELFTEST_ENV: &str = "MIAO_SELFTEST";
const CLOSE_QUITS_ENV: &str = "MIAO_CLOSE_QUITS";

/// B1 后半条要用的样张：40×60 真 PNG（生成脚本 `scripts/make-probe-png.mjs`）。
/// 必须是**真的** PNG —— 服务端有魔数嗅探（契约 §8.2），塞假字节只会得到 INVALID_IMAGE，
/// 那样验出来的只是「校验还在」，不是「关窗后还能干活」。
static PROBE_PNG: &[u8] = include_bytes!("../testdata/probe.png");

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
  try {
    var nav = Array.prototype.slice.call(document.querySelectorAll('.nav-item'))
      .filter(function (b) { return (b.textContent || '').indexOf('设置') >= 0; })[0];
    if (!nav) { put('NO_SETTINGS_NAV'); return; }
    nav.click();
    await new Promise(function (r) { setTimeout(r, 400); });

    var btn = Array.prototype.slice.call(document.querySelectorAll('button'))
      .filter(function (b) { return (b.textContent || '').trim() === '运行自检'; })[0];
    if (!btn) { put('NO_SELFTEST_BUTTON'); return; }
    btn.click();
    await new Promise(function (r) { setTimeout(r, 2200); });

    var rows = Array.prototype.slice.call(document.querySelectorAll('.spec-row'));
    var bad = rows.filter(function (r) { return r.classList.contains('is-bad'); })
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

            // 供后台线程做 HTTP 探活
            let mgr = a.state::<ServiceManager>();
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
                format!("关窗后 box-service 端口 {base_port} 仍监听"),
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
