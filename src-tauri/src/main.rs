// 喵坞 MiaoDock —— Box 桌面端（漫画翻译）
//
// 进程模型（契约《02》§2.1 的落地）：
//   · box-service 与 sidecar 引擎是**本进程的子进程**，生命周期 = 喵坞进程的生命周期
//   · 窗口关闭仅 `hide()`，服务照跑 —— 因为「用户在浏览器里翻译时 Box 窗口没开」是常态
//   · 托盘常驻；「退出喵坞」需二次确认（确认文案由前端给出，见 §2.1）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod commands;
mod lyrics_window;
mod music;
mod selftest;
mod service;

// 🔴 `boxsvc` 住在 **lib crate**（`miao_dock`）里，不在本 bin 的模块树里 —— 独立
//    `[[bin]] boxsvc`（e2e 的 Rust 靶子）要复用同一份实现（见 lib.rs 文件头）。
//    故这里必须 `use miao_dock::…` 而**不是** `mod boxsvc;`：后者会把同一份源码再编译一份，
//    bin 与 lib 各有一套类型（`Shell` / `Paths` 互不连通），且两份实现会各自漂移。
//    ⚠️ 必须是 `pub(crate) use`：私有 `use` 建立的绑定**不能**被子模块用 `crate::boxsvc` 访问
//    （Rust 2018 起 use 绑定默认私有）⇒ 那正是"加了 import 还是找不到模块"的成因。
//    ⚠️ 漏掉这一行，`miao-dock` bin 从 A3b 起就编不过（`service.rs` 用 `boxsvc::engine::…`），
//    而 `cargo build --bin boxsvc` / `cargo test --lib` 都不覆盖它 ⇒ 一直没暴露。
pub(crate) use miao_dock::boxsvc;

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
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(ServiceManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::service_status,
            commands::service_start,
            commands::service_stop,
            commands::service_restart,
            commands::quit_app,
            // ── 桌面歌词（独立窗口）──
            lyrics_window::open_lyrics_window,
            lyrics_window::close_lyrics_window,
            lyrics_window::lyrics_window_open,
            lyrics_window::save_lyrics_window_state,
            lyrics_window::lyrics_push,
            lyrics_window::get_lyrics_state,
            lyrics_window::lyrics_control,
            lyrics_window::resize_lyrics_window,
            commands::hide_window,
            commands::show_window,
            commands::set_theme,
            commands::api_get,
            commands::api_post,
            commands::api_post_multipart,
            commands::api_bytes,
            commands::api_delete,
            commands::open_path,
            commands::expand_paths,
            commands::write_text_file,
            // ── 音乐模块（网易云）──
            music::music_search,
            music::music_song_url,
            music::music_login_qr_key,
            music::music_login_qr_create,
            music::music_login_qr_check,
            music::music_login_status,
            music::music_login_cookie,
            music::music_logout,
            music::music_user_playlist,
            music::music_playlist_tracks,
            music::music_playlist_tracks_range,
            music::music_playlist_info_with_track_ids,
            music::music_playlist_detail,
            music::music_likelist,
            music::music_like,
            music::music_playlist_subscribe,
            music::music_lyric,
            music::music_song_comments,
            music::music_send_comment,
            music::music_personalized,
            music::music_recommend_songs,
            music::music_recommend_resource,
            music::music_simi_song,
            music::music_intelligence_list,
            music::music_artist_search,
            music::music_playlist_search,
            music::music_artist_songs,
            music::music_artist_detail,
            music::music_artist_albums,
            music::music_artist_mvs,
            music::music_album_detail,
            music::music_mv_url,
            // ── 音乐模块（酷狗）──
            music::kugou_search,
            music::kugou_artist_search,
            music::kugou_playlist_search,
            music::kugou_artist_songs,
            music::kugou_song_url,
            music::kugou_lyric,
            music::kugou_login_status,
            music::kugou_login_cookie,
            music::kugou_logout,
            music::kugou_user_playlists,
            music::kugou_playlist_tracks,
            music::kugou_playlist_tracks_range,
            music::kugou_guess_like,
            music::kugou_rank_list,
            music::kugou_rank_songs,
            music::kugou_like_toggle,
            music::kugou_liked_hashes,
            // ── 音乐模块（QQ）──
            music::qq_search,
            music::qq_song_url,
            music::qq_lyric,
            music::qq_login_status,
            music::qq_login_cookie,
            music::qq_logout,
            music::qq_user_playlists,
            music::qq_playlist_tracks,
            music::qq_playlist_tracks_range,
            music::qq_artist_search,
            music::qq_artist_songs,
            music::qq_playlist_search,
            music::qq_rank_list,
            music::qq_rank_songs,
            music::music_qq_recommend_playlists,
            music::qq_liked_hashes,
            music::qq_like_toggle,
            // ── 音乐模块（咪咕）──
            music::migu_search,
            music::migu_playlist_search,
            music::migu_artist_search,
            music::migu_artist_songs,
            music::migu_song_url,
            music::migu_lyric,
            music::migu_login_status,
            music::migu_logout,
            music::migu_user_playlists,
            music::migu_playlist_tracks,
            music::migu_playlist_tracks_range,
            music::migu_rank_list,
            music::migu_rank_songs,
            music::migu_recommend_playlists,
            // ── 音乐模块（多平台管理）──
            music::music_get_login_statuses,
            music::music_switch_provider,
            music::music_get_playback_source,
            music::music_open_login_window,
            // ── 音乐模块（本地）──
            music::local::get_music_files,
            music::local::import_local_music,
            music::local::import_local_music_folder,
            music::local::get_local_lyric,
            music::local::verify_local_covers,
            music::local::delete_cover_cache_files,
            // ── 音乐模块（音频代理）──
            music::audio_proxy::cmd_get_proxy_port,
            // ── 音乐模块（缓存：歌词/音频共用内核）──
            // 歌词缓存不暴露命令：它在四个聚合歌词命令内部生效，前端零改动。
            music::audio_cache::music_audio_cached,
            music::audio_cache::music_cache_download,
            music::audio_cache::music_cache_stats,
            music::audio_cache::music_cache_clear,
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

            // ---- 自动启动翻译服务（**由前端决定**，见下） ----
            //
            // 偏好住在 `app/src/shell-prefs.ts`（「设置 → 翻译服务 → 服务与配对 →
            // 自动启动翻译服务」，**默认开**）。为什么不在 Rust 侧读它：它落在 **localStorage**，
            // 而 localStorage 只有 WebView 读得到 —— Rust 读不到，除非把偏好再抄一份到 tauri-store。
            // 抄一份就是"同一事实两处来源"，两处必然漂移。
            //
            // 所以这里**不再无条件启动**：默认开时的观感与旧版一致（应用一打开、初始屏就是
            // 漫画翻译，前端挂载后立刻拉起）。关掉之后，应用不会碰服务，
            // 用户改从「设置 → 翻译服务 → 服务与配对」或未就绪屏上的「启动本地服务」手动拉起。
            //
            // ⚠️ 自检 / 截图取证两条通道**例外，必须在这里直接拉起**：
            //   · `selftest.rs` 的 S2 组断言**五态轨迹**（starting→L1→L2→L3→running）与
            //     E1 生效参数快照，它只 `mgr.status()` 读结果、**不会自己去启动** ——
            //     不在这里拉起，整组恒红，而且红的原因看着像"状态机坏了"。
            //   · `capture.rs` 截的是真实界面；服务没起来时翻译三屏全落在"未就绪"，
            //     截出来的不是要取证的那一屏。
            // 两者都由环境变量开启（`MIAO_SELFTEST` / `MIAO_CAPTURE_DIR`），属测试通道，
            // 与用户偏好无关 —— 见 `e2e/lifespan-selftest.mjs` 与 `e2e/capture.mjs`。
            if selftest::enabled() || capture::enabled() {
                let handle = app.handle().clone();
                app.state::<ServiceManager>().start(&handle);
            }

            // ---- 音乐模块：初始化 cookie 缓存 + 启动音频代理（Range/206）----
            // 音频代理是独立的本地 HTTP 服务（127.0.0.1 随机端口），在线音源播放/封面
            // 都经它透传（加 Referer/CORS/流式）。启动失败不阻断主流程，只影响在线播放。
            let music_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                music::init_cookie_cache(&music_handle).await;
                if let Err(e) = music::audio_proxy::start_audio_proxy().await {
                    log::warn!("[Music] 音频代理启动失败: {e}");
                }
            });

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
