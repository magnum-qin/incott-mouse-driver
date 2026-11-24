//! 设置与系统能力：settings.json 持久化、开机自启（注册表 Run 项）、
//! 外链打开、文件导入导出对话框、关于对话框。
//!
//! 对应上游 main/index.js 的 settingsFile/getSettings/setSettings 与
//! config:export*/import* IPC（文件对话框 + 编解码在 JS 侧完成，这里只管选路径和读写）。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// ── settings.json ──────────────────────────────────────────
#[derive(Default, Serialize, Deserialize)]
struct StoredSettings {
    #[serde(default)]
    silent_start: Option<bool>,
    /// 旧键（0.2.1 及更早），迁移用
    #[serde(default)]
    start_minimized: Option<bool>,
    #[serde(default)]
    ui_scale: Option<String>,
}

fn settings_file(app: &AppHandle) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir.join("settings.json")
}

fn load_stored(app: &AppHandle) -> StoredSettings {
    std::fs::read_to_string(settings_file(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_stored(app: &AppHandle, s: &StoredSettings) {
    let _ = std::fs::write(settings_file(app), serde_json::to_string_pretty(s).unwrap_or_default());
}

// ── 开机自启（注册表 Run 项，等价于 Electron 的 setLoginItemSettings）────
#[cfg(windows)]
const RUN_VALUE_NAME: &str = "IncottMouseDriver";

#[cfg(windows)]
fn autostart_enabled() -> bool {
    use winreg::enums::*;
    winreg::RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
        .and_then(|k| k.get_value::<String, _>(RUN_VALUE_NAME))
        .is_ok()
}

#[cfg(windows)]
fn autostart_apply(enable: bool, silent: bool) {
    use winreg::enums::*;
    // create_subkey = 打开或创建，返回 (key, 是否新建)
    let Ok((key, _)) = winreg::RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
    else {
        return;
    };
    if enable {
        let exe = std::env::current_exe().unwrap_or_default();
        let mut cmd = format!("\"{}\"", exe.display());
        if silent {
            cmd.push_str(" --background");
        }
        let _ = key.set_value(RUN_VALUE_NAME, &cmd);
    } else {
        let _ = key.delete_value(RUN_VALUE_NAME);
    }
}

#[cfg(not(windows))]
fn autostart_enabled() -> bool {
    false
}
#[cfg(not(windows))]
fn autostart_apply(_enable: bool, _silent: bool) {}

/// 读取设置（autoLaunch 来自注册表实况，与上游语义一致）
#[tauri::command]
pub fn settings_get(app: AppHandle) -> serde_json::Value {
    let s = load_stored(&app);
    serde_json::json!({
        "autoLaunch": autostart_enabled(),
        // 兼容旧键 startMinimized
        "silentStart": s.silent_start.or(s.start_minimized).unwrap_or(false),
        "uiScale": s.ui_scale.filter(|v| !v.is_empty()).unwrap_or_else(|| "auto".into()),
    })
}

/// 更新设置并统一同步自启注册项（两个开关都会影响自启参数）
#[tauri::command]
pub fn settings_set(app: AppHandle, patch: serde_json::Value) -> serde_json::Value {
    let mut s = load_stored(&app);
    if let Some(v) = patch.get("silentStart").and_then(|v| v.as_bool()) {
        s.silent_start = Some(v);
    }
    if let Some(v) = patch.get("uiScale") {
        s.ui_scale = v.as_str().map(String::from);
    }
    if let Some(v) = patch.get("autoLaunch").and_then(|v| v.as_bool()) {
        let silent = s.silent_start.or(s.start_minimized).unwrap_or(false);
        autostart_apply(v, silent);
    } else if autostart_enabled() {
        // silentStart 变化也要刷新自启参数（--background）
        let silent = s.silent_start.or(s.start_minimized).unwrap_or(false);
        autostart_apply(true, silent);
    }
    save_stored(&app, &s);
    settings_get(app)
}

// ── 外链 / 应用信息 / 关于 ──────────────────────────────────
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    // 仅允许 https（双保险，JS 侧已校验过一次）
    if !url.starts_with("https://") {
        return Err("只允许打开 https 链接".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
        .map(|_| ())
}

#[tauri::command]
pub fn get_app_info() -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "homepage": "https://github.com/magnum-qin/incott-mouse-driver",
    })
}

#[tauri::command]
pub fn show_about(app: AppHandle, title: String, body: String) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    app.dialog()
        .message(body)
        .title(title)
        .kind(MessageDialogKind::Info)
        .blocking_show();
}

// ── 配置 / 宏 导入导出（对话框 + 文本读写；.ict/.icm 编解码在 JS 侧）────
#[tauri::command]
pub fn export_file(
    app: AppHandle,
    default_name: String,
    filter_name: String,
    filter_ext: String,
    contents: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .set_file_name(default_name)
        .add_filter(filter_name, &[filter_ext.as_str()])
        .blocking_save_file();
    match path {
        Some(p) => {
            let p = p.as_path().ok_or("非法路径")?.to_path_buf();
            std::fs::write(&p, contents).map_err(|e| e.to_string())?;
            Ok(Some(p.to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn import_file(
    app: AppHandle,
    filter_name: String,
    filter_ext: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .add_filter(filter_name, &[filter_ext.as_str()])
        .blocking_pick_file();
    match path {
        Some(p) => {
            let p = p.as_path().ok_or("非法路径")?.to_path_buf();
            let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
            Ok(Some(text))
        }
        None => Ok(None),
    }
}

// ── 托盘通知（DPI 键切换提示，主窗口不可见时走系统通知）────────────────
#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    // 通知服务被关闭时静默失败（与上游 balloon 行为一致）
    let _ = app.notification().builder().title(title).body(body).show();
}
