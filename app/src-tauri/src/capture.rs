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

/// 点侧栏 / 视图 Tab / 设置小节里的某个可点项：**先轮询等它出现，再点**。
///
/// 🔴 这道「轮询」不是保险，是必需的。原先几处 JS 是"`querySelector` 一次，拿到就点"：
/// 目标那一刻还没挂上 DOM 时取到 `null`、`click()` 静默落空 —— 截出来的还是上一屏，
/// **而文件名却在说谎**（`04-settings-dark.png` 那张浅色图就是这么来的，见本文件头）。
///
/// 🔴 另一个坑是**选择器**本身：ver2.0 的 IA 改版把两处入口都换了样子 ——
///    · 设置入口从"带文字的项"变成**纯图标**（C8b：`globalHasText=false`）⇒ 按文字找不到它；
///    · 视图从侧栏项变成独立的 Tab 栏（`.viewtab`，不再是 `.nav-item`）。
/// 两者叠加的后果是**整段取证 JS 静默失效**，而且失效得很像"截图权限坏了"：
/// 五张图全是同一张、主题恒为 light。好在「取证图必须自证主题」那道闸把它整批拒收，
/// 仓里没被污染 —— 这次才查得出是选择器陈旧，而不是屏幕锁了。
/// 轮询上限（次 × 50ms = 8s）。**给足** —— 这是被实测打过的：
///
/// 原先是 40 次（= 2s）。在**冷启动**（vite 首次按需编译这个模块图）+ 服务刚起来那一轮里，
/// 设置页可能 2s 内还没挂上 DOM ⇒ 轮询提前放弃 ⇒ 深色开关没点上 ⇒
/// `04-settings-dark.png` 主题读回 `light` 被判 ✗，**整批不入库**。
/// 那次失败是**好的失败**（闸门拦住了名不副实的图）；但取证随之变成看运气，所以要给足预算。
/// 8s 只是一个上界：目标一出现就立刻停手，正常路径仍然是几十毫秒。
const POLL_TRIES: u32 = 160;

fn click_when_ready(sel: &str, text: Option<&str>) -> String {
    let filter = match text {
        Some(t) => format!(".filter(function(b){{return (b.textContent||'').indexOf('{t}')>=0;}})[0]"),
        // 纯图标入口没有文字可匹配 —— 只能取第一个
        None => "[0]".to_string(),
    };
    format!(
        "(function(){{var n=0;var t=setInterval(function(){{n++;\
         var el=Array.prototype.slice.call(document.querySelectorAll('{sel}')){filter};\
         if(el){{clearInterval(t);el.click();return;}}if(n>={POLL_TRIES})clearInterval(t);}},50);}})()"
    )
}

const COMPARE_JS: &str = "var c=document.querySelector('.grid-card');if(c)c.click();";

/// 切到设置页并把深色打开。
///
/// 切完要回读主题自证（见 `read_theme`）；只有 `is-on` 才停手，
/// 因此重复调用是幂等的 —— 万一启动时本来就是深色，也不会被这次点击反而切回浅色。
fn toggle_dark_js() -> String {
    format!(
        "{};(function(){{var n=0;var t=setInterval(function(){{n++;\
         var s=document.querySelector('.switch');\
         if(s){{clearInterval(t);if(!s.classList.contains('is-on'))s.click();return;}}\
         if(n>={POLL_TRIES})clearInterval(t);}},50);}})()",
        click_when_ready(".nav-item.is-global", None)
    )
}

/// 切到设置页 → ②翻译服务组（S6 的唯一出口那一屏）。
fn settings_engine_js() -> String {
    format!(
        "{};{}",
        click_when_ready(".nav-item.is-global", None),
        click_when_ready(".set-nav-item", Some("翻译服务"))
    )
}

/// ②翻译服务 → **滚到底**（「模型管理」+「引擎诊断」两块在长页的最下面，默认不在视口里）。
///
/// 🔴 滚动容器是 **`.content`**，不是 `.settings-main`。DOM 是
/// `.content > .settings > .settings-main`：`.content`（app.scss）才是
/// `flex:1; min-height:0; overflow:auto` 的那个；`.settings` 只有
/// `min-height:100%`、`.settings-main` 只有 `flex:1; min-width:0`，两者**都没有 overflow**。
/// 早先写 `.settings-main` 时 `scrollHeight > clientHeight` 恒不成立 ⇒ 轮询一直空转到
/// `POLL_TRIES` 上限、一次都没滚过，截出来的 06 与 05 逐字节相同（534224 B），
/// 由"互不相同"校验拦下（这正是它存在的意义）。
///
/// 仍走"轮询等出现再动"：容器那一刻还没挂上时 `scrollTop = 1e6` 会**静默无效**。
/// 轮询条件同时要求 `.set-diag` 已在 DOM 里（②翻译服务确实渲染完了），
/// 否则 `.content` 从上一个视图起就是可滚的 ⇒ 会在切屏途中就把滚动用掉、白滚一次。
fn settings_diag_js() -> String {
    format!(
        "{};(function(){{var n=0;var t=setInterval(function(){{n++;\
         var d=document.querySelector('.set-diag');\
         var m=document.querySelector('.content');\
         if(d&&m&&m.scrollHeight>m.clientHeight){{clearInterval(t);m.scrollTop=m.scrollHeight;return;}}\
         if(n>={POLL_TRIES})clearInterval(t);}},50);}})()",
        settings_engine_js()
    )
}

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

        // 先把主题钉回浅色再重载 —— 让这几张图与「上一轮存了什么主题」无关
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.eval(FORCE_LIGHT_JS);
        }
        std::thread::sleep(RELOAD_WAIT);

        // 每步都带上**预期主题**：截完立刻回读自证，不符就判 ✗（整批不入库，见 capture.mjs）
        let steps: [(&str, Option<String>, u64, &str, &str); 6] = [
            // 🔴 默认视图是「投放」，不是队列 —— 直接截会得到投放页（上一版就这么静静错了）
            (
                "01-queue.png",
                Some(click_when_ready(".viewtab", Some("队列"))),
                400,
                "任务队列",
                "light",
            ),
            (
                "02-library.png",
                Some(click_when_ready(".viewtab", Some("漫画库"))),
                1500,
                "本地漫画库（真实数据：上一轮 D 组端到端跑出来的落盘产物）",
                "light",
            ),
            (
                "03-compare.png",
                Some(COMPARE_JS.to_string()),
                2200,
                "原译对照（等图片解码完再截）",
                "light",
            ),
            (
                "04-settings-dark.png",
                Some(toggle_dark_js()),
                2000,
                "设置页（深色模式）",
                "dark",
            ),
            (
                // 跟在 04 之后 ⇒ 主题已是深色（`toggle_dark_js` 幂等）。等待要更长：
                // 这一屏挂载后还要 `/engine/options` + `/engine/status` 两个请求回来才有内容。
                "05-settings-engine.png",
                Some(settings_engine_js()),
                3600,
                "设置 ②翻译服务（S6：服务与配对 / 推理引擎 / 模型与诊断 / 引擎诊断）",
                "dark",
            ),
            (
                "06-settings-diag.png",
                Some(settings_diag_js()),
                1500,
                "设置 ②翻译服务 · 滚到底（「模型管理」与「引擎诊断」面板：进程状态 / 生效配置 / 模型状态 / 阶段日志 / 三个操作）",
                "dark",
            ),
        ];

        let mut lines: Vec<String> = Vec::new();
        for (file, js, wait_ms, label, want_theme) in steps {
            if let Some(js) = js {
                drive(&app, &js);
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
