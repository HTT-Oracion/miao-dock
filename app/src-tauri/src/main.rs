// 喵坞 MiaoDock —— Box 桌面端（漫画翻译）
//
// 进程模型（契约《02》§2.1 的落地）：
//   · box-service 与 sidecar 引擎是**本进程的子进程**，生命周期 = 喵坞进程的生命周期
//   · 窗口关闭仅 `hide()`，服务照跑 —— 因为「用户在浏览器里翻译时 Box 窗口没开」是常态
//   · 托盘常驻；「退出喵坞」需二次确认（确认文案由前端给出，见 §2.1）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod commands;
mod selftest;
mod service;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use service::ServiceManager;

/// 托盘请求退出 —— 前端弹二次确认（文案见契约 §2.1）
const QUIT_REQUESTED_EVENT: &str = "miao://quit-requested";

/// 托盘菜单项的 `id=文本` 快照，供自检读取。
///
/// 为什么要有它：Tauri 的 `TrayIcon` 只有 `set_menu`、**没有**读取菜单的 getter，
/// 自检无法在事后回头看托盘上到底挂了什么。这里在 `TrayIconBuilder::build()` **成功之后**
/// 紧贴着存一份快照 —— 构建失败就不会填值，所以「快照存在」本身就蕴含「托盘建起来了」。
pub(crate) static TRAY_MENU_SNAPSHOT: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();

/// 托盘菜单的行为。
///
/// 抽成独立函数是为了让自检能调到**同一个**实现（而不是另写一份仿的）——
/// 自检与真实点击走同一条路径，断言才算数。
pub(crate) fn tray_action(app: &AppHandle, id: &str) {
    let mgr = app.state::<ServiceManager>();
    match id {
        "show" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        "restart" => {
            mgr.stop();
            mgr.start(app);
        }
        "quit" => {
            // 二次确认由前端弹层给出（主文案 = 契约 §2.1 的字面量，见 components/QuitConfirm.tsx）
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
            let _ = app.emit(QUIT_REQUESTED_EVENT, ());
        }
        _ => {}
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ServiceManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::service_status,
            commands::service_restart,
            commands::quit_app,
            commands::hide_window,
            commands::show_window,
            commands::set_theme,
            commands::api_get,
            commands::api_post,
            commands::api_post_multipart,
            commands::api_bytes,
            commands::open_path,
            commands::expand_paths,
        ])
        .setup(|app| {
            // ---- 托盘：常驻 + 状态点由前端窗口承载（托盘菜单反映服务状态文案） ----
            let show = MenuItem::with_id(app, "show", "显示喵坞", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "重启本地服务", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出喵坞…", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show, &sep1, &restart, &sep2, &quit])?;

            TrayIconBuilder::with_id("main")
                .menu(&menu)
                .tooltip("喵坞 · 本地翻译服务常驻中")
                .icon(app.default_window_icon().cloned().ok_or("缺少应用图标")?)
                .on_menu_event(|app, event| {
                    tray_action(app, event.id.as_ref());
                })
                .build(app)?;

            let _ = TRAY_MENU_SNAPSHOT.set(vec![
                format!("{}={}", show.id().as_ref(), show.text().unwrap_or_default()),
                format!("{}={}", restart.id().as_ref(), restart.text().unwrap_or_default()),
                format!("{}={}", quit.id().as_ref(), quit.text().unwrap_or_default()),
            ]);

            // ---- 启动服务（先引擎后服务） ----
            let handle = app.handle().clone();
            let mgr = app.state::<ServiceManager>();
            mgr.start(&handle);

            // ---- M3 生命周期验收（B1–B3）：程序化跑，不需要人点 ----
            if selftest::enabled() {
                selftest::spawn(app.handle().clone());
            }
            // ---- M5 截图取证：依次切屏并各截一张 ----
            if capture::enabled() {
                capture::spawn(app.handle().clone());
            }
            Ok(())
        })
        // 关闭窗口 = 仅隐藏，**不退出进程**（契约 §2.1）
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 反证开关：让关窗真的退进程。若这组断言在此时仍全绿，说明它没测到该测的东西。
                if selftest::close_quits() {
                    std::process::exit(0);
                }
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("喵坞启动失败")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // 真正退出（托盘「退出喵坞」确认后 / Cmd+Q）：杀子进程，确保端口释放
                let mgr = app.state::<ServiceManager>();
                mgr.stop();
            }
        });
}
