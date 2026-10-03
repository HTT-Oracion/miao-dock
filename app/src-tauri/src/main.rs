// 喵坞 MiaoDock —— Box 桌面端（漫画翻译）
//
// 进程模型（契约《02》§2.1 的落地）：
//   · box-service 与 sidecar 引擎是**本进程的子进程**，生命周期 = 喵坞进程的生命周期
//   · 窗口关闭仅 `hide()`，服务照跑 —— 因为「用户在浏览器里翻译时 Box 窗口没开」是常态
//   · 托盘常驻；「退出喵坞」需二次确认（确认文案由前端给出，见 §2.1）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod service;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WindowEvent};

use service::ServiceManager;

/// 托盘请求退出 —— 前端弹二次确认（文案见契约 §2.1）
const QUIT_REQUESTED_EVENT: &str = "miao://quit-requested";

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
                    let mgr = app.state::<ServiceManager>();
                    match event.id.as_ref() {
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
                            // 二次确认由前端弹层给出（文案需含「退出后浏览器插件将无法提交翻译任务」）
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            let _ = app.emit(QUIT_REQUESTED_EVENT, ());
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // ---- 启动服务（先引擎后服务） ----
            let handle = app.handle().clone();
            let mgr = app.state::<ServiceManager>();
            mgr.start(&handle);
            Ok(())
        })
        // 关闭窗口 = 仅隐藏，**不退出进程**（契约 §2.1）
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
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
