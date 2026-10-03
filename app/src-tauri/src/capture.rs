//! M5 的「截图取证」通道。
//!
//! 为什么由应用自己截：本机**有**屏幕录制权限，但拿不到窗口位置 ——
//! `osascript` 被 TCC 以 -10004 拒绝（辅助功能/自动化未授权），系统 `python3` 也没有
//! pyobjc；`screencapture` 的 `-R` 需要坐标，而坐标恰好是应用自己最清楚的东西
//! （`outer_position()` / `outer_size()`）。所以让应用自己算好区域、调 `screencapture -R`，
//! 只截自己那一块，不碰桌面上其它内容。
//!
//! 用法：`MIAO_CAPTURE_DIR=<绝对目录> miao-dock`
//! 它会依次：切到漫画库 → 打开对照页 → 切到设置页并开深色 → 每步截一张，然后退出。
//!
//! 注意 Retina：`outer_position()` 给的是**物理像素**，而 `screencapture -R` 要的是
//! **逻辑点**，所以要先除以 `scale_factor()`。不换算的话，截出来的会是左下角一块错位区域。
//!
//! 另一个环境陷阱（吃过一次）：**显示器睡眠时 `-R` 直接失败**（`could not create image
//! from display with rect`），而同期的 `-x`（全屏）会「成功」但截出一张**纯黑图** ——
//! 后者是静默失败，四张全黑的「取证图」照样能进仓、没人看得出。所以这里做空屏检测，
//! 并且调用方（`scripts/capture.mjs`）在拉起应用前先 `caffeinate` 把显示器顶住。
//!
//! 第三个陷阱，同样是「图是真的、但内容不是它声称的那个」：**主题会串轮次**。
//! 主题持久化在前端 `localStorage`，于是上一轮把深色存下来、这一轮 01–03 就跟着变深色，
//! 而第 4 步那次点击反而把深色切回浅色 —— 产出的 `04-settings-dark.png` 是浅色的。
//! 两道处置：① 开跑先钉回浅色并重载，四个屏都从已知状态出发；
//! ② 每张截完**回读主题自证**，与文件名不符即判 ✗（`capture.mjs` 会因此整批不入库）。
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::selftest::on_main;
use crate::service::ServiceManager;

const CAPTURE_DIR_ENV: &str = "MIAO_CAPTURE_DIR";

/// 真实界面截图的下限（1180×781 @2x ≈ 10 万字节）；纯黑/空屏是 1–2 KB 级别。
/// 取 8 KB 是留足余量又不至于把正常的深色屏误判掉。
const MIN_PLAUSIBLE_BYTES: u64 = 8_000;

/// 等服务起来、前端挂上、漫画库拿到数据（应用启动 + 探端口段 + 一次库扫描）
const BOOT_WAIT: Duration = Duration::from_secs(9);

/// 强制回浅色并重载（重载本身也要时间）。
///
/// 主题是**持久化**的（前端 `localStorage: miao.theme`），所以「上一次跑到哪儿」会决定
/// 「这一次拍到什么」：若上一轮把 `dark` 存了下来，这一轮 01–03 会全是深色，
/// 而第 4 步那次点击反把它切回浅色（于是 `04-settings-dark.png` 是浅的）。
/// 取证必须与上一轮无关 —— 所以先钉回浅色再重载，让四个屏都从已知状态出发。
const FORCE_LIGHT_JS: &str =
    "try{localStorage.setItem('miao.theme','light');}catch(e){};location.reload();";
const RELOAD_WAIT: Duration = Duration::from_secs(2);

/// 把当前主题经 `document.title` 与 `location.hash` **两条通道**回传
/// （与 `selftest.rs` 同一套机制：这两条在不同平台上可靠性不同，双发才稳）。
const PROBE_THEME_JS: &str = "var __m=document.documentElement.dataset.theme||'?';\
     document.title='MIAOCAP:'+__m;\
     location.hash='miaocap='+__m;";
/// 回读完成后把标题还原，免得探针的字样留在窗口标题里影响后续截图
const RESTORE_TITLE_JS: &str = "document.title='喵坞 MiaoDock';";

const LIBRARY_NAV_JS: &str =
    "var n=[].slice.call(document.querySelectorAll('.nav-item')).filter(function(b){return (b.textContent||'').indexOf('漫画库')>=0;})[0];if(n)n.click();";

const COMPARE_JS: &str = "var c=document.querySelector('.grid-card');if(c)c.click();";

/// 切到设置页并把深色打开。
///
/// **不能「点一次就走」**：原先固定等 350ms 就 `querySelector('.switch')`，
/// 若设置页那一刻还没挂上 DOM，取到 null、点击静默落空 —— 截出来的
/// `04-settings-dark.png` 仍是浅色，**文件名却在说谎**。现在先轮询等 `.switch` 真的出现
/// 再点，并且切完还要回读主题自证（见 `read_theme`）；只有 `is-on` 才停手，
/// 因此重复调用是幂等的 —— 万一启动时本来就是深色，也不会被这次点击反而切回浅色。
const TOGGLE_DARK_JS: &str = "(function(){\
     var nav=Array.prototype.slice.call(document.querySelectorAll('.nav-item')).filter(function(b){return (b.textContent||'').indexOf('设置')>=0;})[0];\
     if(nav)nav.click();\
     var n=0;var t=setInterval(function(){\
     n++;var s=document.querySelector('.switch');\
     if(s){clearInterval(t);if(!s.classList.contains('is-on'))s.click();return;}\
     if(n>=40)clearInterval(t);\
     },50);\
     })()";

pub fn dir() -> Option<PathBuf> {
    std::env::var(CAPTURE_DIR_ENV).ok().filter(|s| !s.trim().is_empty()).map(PathBuf::from)
}

pub fn enabled() -> bool {
    dir().is_some()
}

/// 切屏/点击都靠 `eval` 驱动**真实界面**，不另做一套渲染 —— 截到的就是用户会看到的。
fn drive(app: &AppHandle, js: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
        let _ = w.eval(js);
    }
}

fn shoot(app: &AppHandle, out: &Path) -> Result<String, String> {
    let (region, logical) = on_main(app, |a| {
        let Some(w) = a.get_webview_window("main") else {
            return Err("找不到 main 窗口".to_string());
        };
        let _ = w.set_focus();
        let pos = w.outer_position().map_err(|e| e.to_string())?;
        let size = w.outer_size().map_err(|e| e.to_string())?;
        let scale = w.scale_factor().unwrap_or(1.0);
        let (x, y) = (pos.x as f64 / scale, pos.y as f64 / scale);
        let (cw, ch) = (size.width as f64 / scale, size.height as f64 / scale);
        // 向内收 1px：把窗口自带的描边/圆角裁掉，避免截图带上一圈杂色
        let region = format!(
            "{},{},{},{}",
            (x + 1.0).round(),
            (y + 1.0).round(),
            (cw - 2.0).round(),
            (ch - 2.0).round()
        );
        Ok((region, format!("{}×{} @{scale}x", cw.round(), ch.round())))
    })
    .ok_or_else(|| {
        // 两条路都通向这里：`run_on_main_thread` 报错，或闭包 10s 内没跑上主线程。
        // 后者在**锁屏/显示器睡眠**时是常态 —— 窗口被 AppKit 挂在后台，run loop 不再轮转。
        "主线程 10 秒内没响应（窗口被系统挂起了？锁屏或显示器睡眠会导致这个）".to_string()
    })??;

    let output = std::process::Command::new("screencapture")
        .args(["-x", "-R", &region, out.to_str().unwrap_or("")])
        .output()
        .map_err(|e| format!("无法执行 screencapture：{e}"))?;
    if !output.status.success() {
        // 把 screencapture 自己的话带上 —— 它区分得了「区域非法」与「显示器睡了」：
        // 前者是 `invalid rectangle`，后者是 `could not create image from display with rect`。
        let err = String::from_utf8_lossy(&output.stderr);
        let err = err.trim();
        return Err(format!(
            "screencapture 失败（区域 {region}）：{}",
            if err.is_empty() { format!("退出码 {}", output.status) } else { err.to_string() }
        ));
    }
    let bytes = std::fs::metadata(out).map(|m| m.len()).unwrap_or(0);
    if bytes == 0 {
        return Err(format!("截图文件为空（区域 {region}；屏幕录制权限？）"));
    }
    if bytes < MIN_PLAUSIBLE_BYTES {
        return Err(format!(
            "截图疑似空屏（区域 {region}，仅 {bytes} 字节）—— 显示器是不是睡着了？"
        ));
    }
    Ok(format!("{}（{logical}，{bytes} 字节）", out.display()))
}

/// 读回当前主题（`document.documentElement.dataset.theme`），经标题与 hash 两条通道。
///
/// 这是「让这张图自证」的那一步：`04-settings-dark.png` 声称深色，就必须真的是深色。
/// 否则一次「点击落空」会安静地产出一张**名不副实的证据**（正是踩过的坑）。
fn read_theme(app: &AppHandle) -> Option<String> {
    let w = app.get_webview_window("main")?;
    let _ = w.eval(PROBE_THEME_JS);
    std::thread::sleep(Duration::from_millis(400));

    let (title, frag) = on_main(app, |a| {
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

    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(RESTORE_TITLE_JS);
    }

    let from_title = title.strip_prefix("MIAOCAP:").unwrap_or("").to_string();
    let from_hash = frag.strip_prefix("miaocap=").unwrap_or("").to_string();
    let got = if !from_title.is_empty() { from_title } else { from_hash };
    (!got.is_empty()).then_some(got)
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(dir) = dir() else { return };
        let _ = std::fs::create_dir_all(&dir);
        std::thread::sleep(BOOT_WAIT);

        // 先把主题钉回浅色再重载 —— 让这四张图与「上一轮存了什么主题」无关
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.eval(FORCE_LIGHT_JS);
        }
        std::thread::sleep(RELOAD_WAIT);

        // 每步都带上**预期主题**：截完立刻回读自证，不符就判 ✗（整批不入库，见 capture.mjs）
        let steps: [(&str, Option<&str>, u64, &str, &str); 4] = [
            // 队列屏是启动默认屏，直接截
            ("01-queue.png", None, 400, "任务队列", "light"),
            (
                "02-library.png",
                Some(LIBRARY_NAV_JS),
                1500,
                "本地漫画库（真实数据：上一轮 D 组端到端跑出来的落盘产物）",
                "light",
            ),
            (
                "03-compare.png",
                Some(COMPARE_JS),
                2200,
                "原译对照（等图片解码完再截）",
                "light",
            ),
            (
                "04-settings-dark.png",
                Some(TOGGLE_DARK_JS),
                1600,
                "设置页（深色模式）",
                "dark",
            ),
        ];

        let mut lines: Vec<String> = Vec::new();
        for (file, js, wait_ms, label, want_theme) in steps {
            if let Some(js) = js {
                drive(&app, js);
            }
            std::thread::sleep(Duration::from_millis(wait_ms));
            let out = dir.join(file);
            let res: Result<String, String> = shoot(&app, &out).and_then(|detail| {
                match read_theme(&app) {
                    Some(got) if got == want_theme => Ok(format!("{detail}；主题={got}")),
                    other => Err(format!(
                        "主题应为 {want_theme}，实际读到「{}」—— 这张图与文件名不符，拒收（{detail}）",
                        other.unwrap_or_else(|| "读不到".into())
                    )),
                }
            });
            match res {
                Ok(detail) => lines.push(format!("✓ {file} — {label}；{detail}")),
                Err(e) => lines.push(format!("✗ {file} — {label}；{e}")),
            }
        }

        println!("MIAO_CAPTURE_DONE");
        for l in &lines {
            println!("{l}");
        }

        let _ = on_main(&app, |a| {
            a.state::<ServiceManager>().stop();
        });
        let _ = on_main(&app, |a| {
            a.exit(0);
        });
    });
}
