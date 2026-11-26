//! Incott 鼠标驱动（Tauri 版）
//!
//! fork 自 HeHaoren/incott-mouse-app（Electron 版，MIT），架构改为：
//!  - Rust：HID 传输（hid.rs）、托盘系统（tray.rs）、设置/系统能力（settings.rs）
//!  - JS（ui/）：协议层 + 业务编排原样保留在浏览器侧（bridge/），渲染层零改动
//!
//! 对应上游 main/index.js 的窗口创建 / close→hide / --background 静默启动。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hid;
mod protocol_const;
mod settings;
mod tray;

use tauri::{Emitter, Manager};

fn main() {
    tauri::Builder::default()
        // 二次启动：聚焦已有主窗口（须最先注册）
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(hid::HidState::default())
        .manage(tray::TrayState::default())
        .invoke_handler(tauri::generate_handler![
            hid::hid_list,
            hid::hid_open,
            hid::hid_close,
            hid::hid_send_feature,
            hid::hid_get_feature,
            hid::hid_write_output,
            settings::settings_get,
            settings::settings_set,
            settings::open_url,
            settings::get_app_info,
            settings::show_about,
            settings::export_file,
            settings::import_file,
            settings::notify,
            tray::tray_set_battery,
            tray::tray_set_status,
            tray::tray_get_status,
            tray::tray_set_lang,
            tray::tray_refresh,
            tray::tray_hide_popover,
            tray::tray_open_main,
        ])
        .setup(|app| {
            tray::init(app.handle())?;
            // 鼠标插线 / 拔线、接收器插拔时，连接跟着鼠标走
            hid::watch_devices(app.handle().clone());

            // 只有开机自启（注册表 Run 带 --background）才静默挂托盘；
            // 手动运行 exe 总是弹窗（窗口在配置里 visible:false，这里再显示，避免闪白）
            let background = std::env::args().any(|a| a == "--background");
            if !background {
                if let Some(win) = app.get_webview_window("main") {
                    win.show()?;
                    win.set_focus()?;
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // 关窗隐藏到托盘，不退出；真正退出走托盘「退出」
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                // 浮层失焦即收起（armed 判定在 tray::on_popover_blur 里）
                tauri::WindowEvent::Focused(false) => {
                    if window.label() == "popover" {
                        tray::on_popover_blur(window.app_handle());
                    }
                }
                // 最大化状态同步给渲染层（自绘标题栏按钮图标要切换）
                tauri::WindowEvent::Resized(_) => {
                    if window.label() == "main" {
                        let _ = window.app_handle().emit_to(
                            "main",
                            "win://maximized",
                            window.is_maximized().unwrap_or(false),
                        );
                    }
                }
                // 系统主题切换（浅色 ↔ 深色）：托盘图标的墨色跟着换
                tauri::WindowEvent::ThemeChanged(_) => tray::theme_changed(window.app_handle()),
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 退出前关闭 HID 句柄（幂等；托盘「退出」路径也已调用过）
            if let tauri::RunEvent::Exit = event {
                hid::shutdown(&app_handle);
            }
        });
}
