//! 托盘系统 —— 对应上游 main/index.js 的托盘部分 + main/tray-popover.js。
//!
//!  - 托盘图标 = 一个只描边的圆角方框，里面一只单色鼠标（按托盘的实际尺寸现画，墨色跟随系统主题）：
//!    未连接 = 鼠标变灰（灯灭），连接后鼠标实心、灯按电量三段变色（>60 绿 / 25~60 黄 / ≤25 红）
//!  - 单击：200ms 延时后弹出信息浮层（再单击收起）；双击：打开主窗口
//!    （Windows 双击序列会先送 click，残尾 click 用时间窗吞掉，避免"弹两下"）
//!  - 浮层贴托盘图标定位：任务栏在下半屏时显示在图标上方，否则下方
//!  - 浮层失焦即收起；刚 show 后 180ms 内的失焦不算（Windows 抢焦点抖动）
//!  - 菜单文案由 JS 推送（i18n 在 JS 侧），语言切换时重建

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

// ── 常量（与上游一致）─────────────────────────────────────
const TRAY_CLICK_DELAY: Duration = Duration::from_millis(200); // 单击延时区分双击
const RESIDUAL_CLICK_WINDOW: Duration = Duration::from_millis(600); // TRAY_CLICK_DELAY + 400
const REOPEN_GUARD: Duration = Duration::from_millis(260); // 失焦收起后不立即重开
const BLUR_ARM_DELAY: Duration = Duration::from_millis(180); // 刚显示时的失焦不算
const SHOW_MAIN_GUARD: Duration = Duration::from_millis(300); // 双击重复派发去重
const EDGE_GAP: f64 = 8.0; // 与托盘图标/屏幕边缘的间距
const DIMMED: f32 = 0.5; // 没连接时托盘图标里鼠标的不透明度

// ── 状态 ───────────────────────────────────────────────────
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Labels {
    pub open: String,
    pub battery_label: String,
    pub quit: String,
    pub not_connected: String,
}

impl Labels {
    fn fallback() -> Self {
        Self {
            open: "打开界面".into(),
            battery_label: "电量".into(),
            quit: "退出".into(),
            not_connected: "未连接设备".into(),
        }
    }
}

#[derive(Default)]
pub struct TrayState {
    tray: Mutex<Option<TrayIcon>>,
    battery: Mutex<Option<u8>>,
    charging: Mutex<bool>,
    /// 是否已连接（取自 JS 推送的浮层状态）。灯灭 = 未连接；连上但电量还没读到时灯是绿的
    connected: Mutex<bool>,
    labels: Mutex<Labels>,
    /// JS 推送的浮层状态缓存（连接/电量/DPI/回报率/配置）
    status: Mutex<serde_json::Value>,
    popover_shown_at: Mutex<Option<Instant>>,
    popover_hidden_at: Mutex<Option<Instant>>,
    last_double_click_at: Mutex<Option<Instant>>,
    /// 单击定时器代号：双击/后续单击时 +1 作废旧的延时任务
    click_gen: Mutex<u64>,
    last_show_main_at: Mutex<Option<Instant>>,
}

// ── 图标 ───────────────────────────────────────────────────
/// 托盘图标的用色。图标中间不填色、直接画在任务栏上，所以墨色跟着任务栏的主题走：
/// 浅色任务栏用深墨，灯色压暗一档才看得清；深色任务栏用浅墨，灯色就是界面里的那三种
struct Palette {
    ink: [u8; 3],
    green: [u8; 3],
    yellow: [u8; 3],
    red: [u8; 3],
}

const LIGHT_TASKBAR: Palette = Palette {
    ink: [0x1b, 0x1b, 0x1e],
    green: [0x16, 0x96, 0x68],
    yellow: [0xbe, 0x7e, 0x16],
    red: [0xd2, 0x40, 0x46],
};

const DARK_TASKBAR: Palette = Palette {
    ink: [0xed, 0xed, 0xee],    // 界面的 --text
    green: [0x46, 0xc9, 0x8c],  // --success
    yellow: [0xf0, 0xb3, 0x4c], // --warning
    red: [0xf0, 0x58, 0x5d],    // --danger
};

/// 任务栏是浅色还是深色：读系统的「Windows 模式」（任务栏和开始菜单跟着它走，和「应用模式」可以不一样）。
/// 读不到（旧系统）按浅色算——那是 Windows 的默认值
#[cfg(windows)]
fn taskbar_is_light() -> bool {
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(
            key: *mut std::ffi::c_void,
            sub_key: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut std::ffi::c_void,
            size: *mut u32,
        ) -> i32;
    }
    const HKEY_CURRENT_USER: *mut std::ffi::c_void = 0x8000_0001usize as *mut std::ffi::c_void;
    const RRF_RT_REG_DWORD: u32 = 0x10;
    let sub_key: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0"
        .encode_utf16()
        .collect();
    let value: Vec<u16> = "SystemUsesLightTheme\0".encode_utf16().collect();
    let mut data = 0u32;
    let mut size = 4u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            sub_key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut data as *mut u32 as *mut std::ffi::c_void,
            &mut size,
        )
    };
    rc != 0 || data != 0
}

#[cfg(not(windows))]
fn taskbar_is_light() -> bool {
    false
}

fn palette() -> &'static Palette {
    if taskbar_is_light() {
        &LIGHT_TASKBAR
    } else {
        &DARK_TASKBAR
    }
}

/// 托盘图标里那盏灯：没连接 = 灯灭（鼠标也画成半透明的）；连上之后按电量分三段。
/// 电量还没读到时给绿灯——那是「已连接」灯（同标题栏），不当成未连接
fn lamp_for(connected: bool, battery: Option<u8>, pal: &Palette) -> Option<[u8; 3]> {
    if !connected {
        None
    } else {
        match battery {
            Some(b) if b > 25 && b <= 60 => Some(pal.yellow),
            Some(b) if b <= 25 => Some(pal.red),
            _ => Some(pal.green),
        }
    }
}

/// 托盘图标应有的边长（像素）：托盘的一个图标位是 16 个逻辑像素，按任务栏所在的主屏缩放换算
/// （100% 是 16，150% 是 24）。尺寸不对系统就会把它缩放，边缘发虚，所以要按实际槽位画。
///
/// 不能用 `GetSystemMetrics(SM_CXSMICON)`：那个指标跟着系统字体走，这台机器 150% 缩放时报的是 33，
/// 画出来再被系统缩到 24——第一版就是这样，图标比设计的细，而且发糊
#[cfg(windows)]
fn tray_icon_size() -> u32 {
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn MonitorFromPoint(pt: Point, flags: u32) -> *mut std::ffi::c_void;
        fn GetDpiForSystem() -> u32;
    }
    #[link(name = "shcore")]
    extern "system" {
        fn GetDpiForMonitor(
            monitor: *mut std::ffi::c_void,
            kind: i32,
            dpi_x: *mut u32,
            dpi_y: *mut u32,
        ) -> i32;
    }
    const MONITOR_DEFAULTTOPRIMARY: u32 = 1;
    const MDT_EFFECTIVE_DPI: i32 = 0;
    let dpi = unsafe {
        let mut dpi_x = 0u32;
        let mut dpi_y = 0u32;
        let primary = MonitorFromPoint(Point { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        if GetDpiForMonitor(primary, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) == 0 && dpi_x > 0 {
            dpi_x
        } else {
            GetDpiForSystem()
        }
    };
    ((16 * dpi + 48) / 96).max(16) // 四舍五入：120 → 20，144 → 24，168 → 28
}

#[cfg(not(windows))]
fn tray_icon_size() -> u32 {
    16
}

// 有向距离函数（像素单位，内部为负）：只用它们在边缘做 1 像素宽的抗锯齿
fn sd_round_box(x: f32, y: f32, hx: f32, hy: f32, r: f32) -> f32 {
    let qx = x.abs() - hx + r;
    let qy = y.abs() - hy + r;
    qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - r
}

/// 椭圆的近似式（Inigo Quilez），边缘附近足够精确
fn sd_ellipse(x: f32, y: f32, rx: f32, ry: f32) -> f32 {
    let k0 = (x / rx).hypot(y / ry);
    let k1 = (x / (rx * rx)).hypot(y / (ry * ry)).max(1e-6);
    k0 * (k0 - 1.0) / k1
}

fn coverage(distance: f32) -> f32 {
    (0.5 - distance).clamp(0.0, 1.0)
}

/// 把 `src`（不透明度 s）叠在 `dst`（不透明度 d）上面，返回合成后的颜色和不透明度
fn over(dst: [f32; 3], d: f32, src: [f32; 3], s: f32) -> ([f32; 3], f32) {
    let a = s + d * (1.0 - s);
    let rgb = std::array::from_fn(|k| {
        if a > 0.0 {
            (src[k] as f32 * s + dst[k] as f32 * d * (1.0 - s)) / a
        } else {
            0.0
        }
    });
    (rgb, a)
}

/// 托盘图标：一个只描边的圆角方框，里面一只单色鼠标，直接画在任务栏上。
///
///  - 连接着：鼠标实心，分键槽留空透出任务栏，身体里一枚灯，颜色 = 电量
///  - 没连接：鼠标只剩一半不透明度（看起来是灰的），没有灯
///
/// 框占满整个图标位，外轮廓于是和旁边那些方形图标一样大。鼠标本身是竖长的，不加框的话再怎么加宽
/// 也只有它们的七成宽（被说成「小」「胖」「瘦」的三版见 design/README.md「托盘图标」）；框中间不填色，
/// 分量才不会回到第一版那种实心底板。没连接不画空心：这么小的鼠标挖空以后，加上分键线和灯座，远看是个感叹号。
/// 各部分用有向距离描述，逐像素算覆盖率，再按图层自下而上合成
fn tray_glyph(lamp: Option<[u8; 3]>, pal: &Palette, size: u32) -> tauri::image::Image<'static> {
    // 比例以「16 逻辑像素的图标位」为单位：150% 缩放下边长 24 像素，1 个单位 = 1.5 像素
    let u = size as f32 / 16.0;
    let half = size as f32 / 2.0;
    // 框：外沿就是图标位的边，圆角量的是旁边那个方形图标（150% 下 5.4 像素，逐行对得上）。
    // 线宽按 4/3 个单位取整到整像素（100% 下 1 像素、150% 下 2 像素）：里外两个沿都落在像素边界上，线才是实的
    let frame_stroke = ((4.0 * u / 3.0).round() as i32).max(1) as f32;
    // 鼠标：顶部圆拱，中间直边，底部收圆。宽 8、高 10⅔ 个单位（150% 下 12×16 像素，宽高比和上一版一样），
    // 离框上下 2 像素、左右 4 像素
    let rx = 4.0 * u;
    let body_h = 32.0 * u / 3.0;
    let top = -body_h / 2.0;
    let dome = 0.78 * rx;
    let bottom_dome = 0.42 * rx;
    let dome_cy = top + dome;
    let bottom_cy = body_h / 2.0 - bottom_dome;
    // 分键线：离顶边一点，通到 40% 的高度（通到顶的话会和上面的框连成一条线）
    let seam_w = u;
    let seam_top = top + 0.8 * u;
    let seam_end = top + 0.4 * body_h;
    // 指示灯
    let lamp_r = 1.2 * u;
    let lamp_cy = 7.0 * u / 3.0;

    let ink = [pal.ink[0] as f32, pal.ink[1] as f32, pal.ink[2] as f32];
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let px = x as f32 + 0.5 - half;
            let py = y as f32 + 0.5 - half;
            let body = sd_ellipse(px, py - dome_cy, rx, dome)
                .min(sd_ellipse(px, py - bottom_cy, rx, bottom_dome))
                .min(sd_round_box(
                    px,
                    py - (dome_cy + bottom_cy) / 2.0,
                    rx,
                    (bottom_cy - dome_cy) / 2.0,
                    0.0,
                ));
            let seam = coverage(sd_round_box(
                px,
                py - (seam_top + seam_end) / 2.0,
                seam_w / 2.0,
                (seam_end - seam_top) / 2.0,
                seam_w / 2.0,
            ));
            // 框 = 落在外沿之内的覆盖率 − 落在内沿之内的覆盖率
            // （两个 coverage 的次序不能反：反过来算出来是负的，框会整个消失）
            let frame_d = sd_round_box(
                px,
                py,
                half - frame_stroke / 2.0,
                half - frame_stroke / 2.0,
                3.6 * u - frame_stroke / 2.0,
            );
            let frame = (coverage(frame_d - frame_stroke / 2.0)
                - coverage(frame_d + frame_stroke / 2.0))
                .max(0.0);
            let mouse = coverage(body) * (1.0 - seam);
            let lamp_a = coverage(px.hypot(py - lamp_cy) - lamp_r);
            let (colour, mouse, lamp_a) = match lamp {
                Some(c) => ([c[0] as f32, c[1] as f32, c[2] as f32], mouse, lamp_a),
                None => (ink, mouse * DIMMED, 0.0),
            };
            // 图层自下而上：鼠标 → 灯 → 框
            let (rgb, a) = [(ink, mouse), (colour, lamp_a), (ink, frame)]
                .into_iter()
                .filter(|(_, s)| *s > 0.0)
                .fold(([0.0f32; 3], 0.0f32), |(dst, d), (src, s)| {
                    over(dst, d, src, s)
                });
            let i = ((y * size + x) * 4) as usize;
            for k in 0..3 {
                rgba[i + k] = rgb[k].round() as u8;
            }
            rgba[i + 3] = (a.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }
    tauri::image::Image::new_owned(rgba, size, size)
}

/// 按当前的连接 / 电量状态（和任务栏的主题）重画托盘图标
fn refresh_tray_icon(st: &TrayState) {
    let pal = palette();
    let lamp = lamp_for(
        *st.connected.lock().unwrap(),
        *st.battery.lock().unwrap(),
        pal,
    );
    let icon = tray_glyph(lamp, pal, tray_icon_size());
    if let Some(tray) = st.tray.lock().unwrap().clone() {
        let _ = tray.set_icon(Some(icon));
    }
}

/// 系统主题变了（浅色 ↔ 深色）：托盘图标的墨色跟着换
pub fn theme_changed(app: &AppHandle) {
    refresh_tray_icon(&app.state::<TrayState>());
}

// ── 菜单 ───────────────────────────────────────────────────
fn battery_text(st: &TrayState) -> String {
    let b = *st.battery.lock().unwrap();
    let charging = *st.charging.lock().unwrap();
    match b {
        Some(level) => format!("{level}%{}", if charging { "⚡" } else { "" }),
        None => st.labels.lock().unwrap().not_connected.clone(),
    }
}

fn rebuild_menu(app: &AppHandle) {
    let st = app.state::<TrayState>();
    let tray = st.tray.lock().unwrap().clone();
    let Some(tray) = tray else { return };
    let labels = st.labels.lock().unwrap().clone();
    let items = (
        MenuItem::with_id(app, "open", labels.open.clone(), true, None::<&str>),
        MenuItem::with_id(
            app,
            "batt",
            format!("{}: {}", labels.battery_label, battery_text(&st)),
            false,
            None::<&str>,
        ),
        PredefinedMenuItem::separator(app),
        MenuItem::with_id(app, "quit", labels.quit.clone(), true, None::<&str>),
    );
    if let (Ok(open), Ok(batt), Ok(sep), Ok(quit)) = items {
        if let Ok(menu) = Menu::with_items(app, &[&open, &batt, &sep, &quit]) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn update_tooltip(app: &AppHandle) {
    let st = app.state::<TrayState>();
    let tray = st.tray.lock().unwrap().clone();
    let Some(tray) = tray else { return };
    let labels = st.labels.lock().unwrap().clone();
    let _ = tray.set_tooltip(Some(format!(
        "Incott Mouse Driver — {} {}",
        labels.battery_label,
        battery_text(&st)
    )));
}

// ── 主窗口 ─────────────────────────────────────────────────
pub fn show_main(app: &AppHandle) {
    hide_popover(app);
    let st = app.state::<TrayState>();
    let now = Instant::now();
    {
        let mut last = st.last_show_main_at.lock().unwrap();
        if let Some(t) = *last {
            if now.duration_since(t) < SHOW_MAIN_GUARD {
                return; // 双击被重复派发时防止 show/focus 两下
            }
        }
        *last = Some(now);
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

// ── 浮层 ───────────────────────────────────────────────────
fn hide_popover(app: &AppHandle) {
    let st = app.state::<TrayState>();
    if let Some(win) = app.get_webview_window("popover") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            *st.popover_hidden_at.lock().unwrap() = Some(Instant::now());
        }
    }
}

/// 浮层失焦：刚显示 180ms 内的失焦不算（Windows show 抢焦点抖动）
pub fn on_popover_blur(app: &AppHandle) {
    let st = app.state::<TrayState>();
    let armed = st
        .popover_shown_at
        .lock()
        .unwrap()
        .map(|t| t.elapsed() >= BLUR_ARM_DELAY)
        .unwrap_or(false);
    if armed {
        hide_popover(app);
    }
}

/// 贴着托盘图标定位：任务栏在屏幕下半部时显示在图标上方，否则显示在下方
fn work_area_of(app: &AppHandle, x: f64, y: f64) -> (f64, f64, f64, f64) {
    match app.monitor_from_point(x, y) {
        Ok(Some(m)) => {
            let wa = m.work_area();
            (
                wa.position.x as f64,
                wa.position.y as f64,
                wa.size.width as f64,
                wa.size.height as f64,
            )
        }
        _ => (0.0, 0.0, 1920.0, 1080.0),
    }
}

#[allow(clippy::too_many_arguments)]
fn show_popover(app: &AppHandle, position: (f64, f64), rect: Option<(f64, f64, f64, f64)>) {
    let Some(win) = app.get_webview_window("popover") else {
        return;
    };
    let st = app.state::<TrayState>();

    // 锚点：托盘图标矩形中心；图标不可见（折叠进溢出区）时用点击坐标
    let (ax, ay) = match rect {
        Some((rx, ry, rw, rh)) if rw > 0.0 && rh > 0.0 => (rx + rw / 2.0, ry + rh / 2.0),
        _ => position,
    };
    let (wx, wy, ww, wh) = work_area_of(app, ax, ay);
    let (sw, sh) = win
        .outer_size()
        .map(|s| (s.width as f64, s.height as f64))
        .unwrap_or((268.0, 180.0));

    let mut x = (ax - sw / 2.0).round();
    x = x.clamp(wx + 4.0, (wx + ww - sw - 4.0).max(wx + 4.0));

    let below = ay < wy + wh / 2.0;
    let mut y = match rect {
        Some((_rx, ry, _rw, rh)) => {
            if below {
                ry + rh + EDGE_GAP
            } else {
                ry - sh - EDGE_GAP
            }
        }
        None => {
            if below {
                ay + EDGE_GAP
            } else {
                ay - sh - EDGE_GAP
            }
        }
    };
    y = y.clamp(wy + 4.0, (wy + wh - sh - 4.0).max(wy + 4.0));

    let _ = win.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
    let _ = win.set_always_on_top(true);
    let _ = win.show();
    let _ = win.set_focus();
    *st.popover_shown_at.lock().unwrap() = Some(Instant::now());

    // 通知浮层播放淡入 + 先渲染缓存状态；主窗口后台补读实时状态
    let status = st.status.lock().unwrap().clone();
    let _ = app.emit_to("popover", "popover://shown", ());
    let _ = app.emit_to("popover", "tray://status", status);
    let _ = app.emit_to("main", "tray://refresh", ());
}

fn toggle_popover(app: &AppHandle, position: (f64, f64), rect: Option<(f64, f64, f64, f64)>) {
    let st = app.state::<TrayState>();
    if let Some(win) = app.get_webview_window("popover") {
        if win.is_visible().unwrap_or(false) {
            hide_popover(app);
            return;
        }
    }
    // 刚因失焦收起时，紧跟着的单击就是关闭动作，不再重开
    if let Some(t) = *st.popover_hidden_at.lock().unwrap() {
        if t.elapsed() < REOPEN_GUARD {
            return;
        }
    }
    show_popover(app, position, rect);
}

// ── 单击 / 双击 ────────────────────────────────────────────
/// Position/Size 枚举 → (x, y) / (w, h)，物理或逻辑都归一成 f64（物理像素）
fn pos_xy(p: tauri::Position) -> (f64, f64) {
    match p {
        tauri::Position::Physical(v) => (v.x as f64, v.y as f64),
        tauri::Position::Logical(v) => (v.x, v.y),
    }
}

fn size_wh(s: tauri::Size) -> (f64, f64) {
    match s {
        tauri::Size::Physical(v) => (v.width as f64, v.height as f64),
        tauri::Size::Logical(v) => (v.width, v.height),
    }
}
fn on_tray_click(app: &AppHandle, position: (f64, f64), rect: Option<(f64, f64, f64, f64)>) {
    let st = app.state::<TrayState>();
    // 双击序列（click → click → double-click [→ click 残尾]）后面那个残尾不处理
    if let Some(t) = *st.last_double_click_at.lock().unwrap() {
        if t.elapsed() < RESIDUAL_CLICK_WINDOW {
            return;
        }
    }
    // 登记代号；200ms 内若来了第二击（单击或双击），本定时器作废
    let gen = {
        let mut g = st.click_gen.lock().unwrap();
        *g += 1;
        *g
    };
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(TRAY_CLICK_DELAY);
        let st = app.state::<TrayState>();
        if *st.click_gen.lock().unwrap() != gen {
            return; // 已被双击/后续单击作废
        }
        toggle_popover(&app, position, rect);
    });
}

fn on_tray_double_click(app: &AppHandle) {
    let st = app.state::<TrayState>();
    *st.last_double_click_at.lock().unwrap() = Some(Instant::now());
    *st.click_gen.lock().unwrap() += 1; // 作废待处理的单击定时器
    show_main(app);
}

// ── 初始化 ─────────────────────────────────────────────────
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    *app.state::<TrayState>().labels.lock().unwrap() = Labels::fallback();

    let menu = {
        let labels = Labels::fallback();
        let open = MenuItem::with_id(app, "open", labels.open.clone(), true, None::<&str>)?;
        let batt = MenuItem::with_id(app, "batt", format!("{}: --", labels.battery_label), false, None::<&str>)?;
        let sep = PredefinedMenuItem::separator(app)?;
        let quit = MenuItem::with_id(app, "quit", labels.quit.clone(), true, None::<&str>)?;
        Menu::with_items(app, &[&open, &batt, &sep, &quit])?
    };

    let tray = TrayIconBuilder::with_id("main-tray")
        .icon(tray_glyph(None, palette(), tray_icon_size()))
        .tooltip("Incott Mouse Driver")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|tray, event| match event.id().as_ref() {
            "open" => show_main(tray.app_handle()),
            "quit" => {
                crate::hid::shutdown(tray.app_handle());
                tray.app_handle().exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                rect,
                ..
            } => {
                // tauri 2.12 的 Click 事件 rect 是必带的（图标不可见时可能为 0 尺寸，
                // show_popover 里的 rw/rh > 0 校验会回退到光标锚点）
                let (rx, ry) = pos_xy(rect.position);
                let (rw, rh) = size_wh(rect.size);
                on_tray_click(tray.app_handle(), (position.x, position.y), Some((rx, ry, rw, rh)));
            }
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => on_tray_double_click(tray.app_handle()),
            _ => {}
        })
        .build(app)?;

    *app.state::<TrayState>().tray.lock().unwrap() = Some(tray);
    update_tooltip(app);
    Ok(())
}

// ── Tauri 命令 ─────────────────────────────────────────────
/// JS 推送电量（推送/轮询/手动刷新都会调）→ 更新图标颜色/tooltip/菜单
#[tauri::command]
pub fn tray_set_battery(app: AppHandle, level: Option<u8>, charging: Option<bool>) {
    let st = app.state::<TrayState>();
    *st.battery.lock().unwrap() = level;
    if let Some(c) = charging {
        *st.charging.lock().unwrap() = c;
    }
    if level.is_none() {
        *st.charging.lock().unwrap() = false;
    }
    refresh_tray_icon(&st);
    rebuild_menu(&app);
    update_tooltip(&app);
}

/// JS 推送浮层状态（缓存在 Rust，浮层可见时转发给它）
#[tauri::command]
pub fn tray_set_status(app: AppHandle, status: serde_json::Value) {
    let st = app.state::<TrayState>();
    // 连接状态决定灯亮不亮；JS 每次推送电量后都会接着推一次状态，所以只需要在它变化时重画
    let connected = status.get("connected").and_then(serde_json::Value::as_bool).unwrap_or(false);
    *st.status.lock().unwrap() = status;
    let was = *st.connected.lock().unwrap();
    *st.connected.lock().unwrap() = connected;
    if was != connected {
        refresh_tray_icon(&st);
    }
    if let Some(w) = app.get_webview_window("popover") {
        if w.is_visible().unwrap_or(false) {
            let snapshot = st.status.lock().unwrap().clone();
            let _ = app.emit_to("popover", "tray://status", snapshot);
        }
    }
}

/// 浮层启动/弹出时取缓存状态
#[tauri::command]
pub fn tray_get_status(app: AppHandle) -> serde_json::Value {
    app.state::<TrayState>().status.lock().unwrap().clone()
}

/// 语言切换：JS 推送菜单文案 → 重建菜单/tooltip
#[tauri::command]
pub fn tray_set_lang(app: AppHandle, labels: Labels) {
    let st = app.state::<TrayState>();
    if !labels.open.is_empty() {
        *st.labels.lock().unwrap() = labels;
    }
    rebuild_menu(&app);
    update_tooltip(&app);
}

/// 浮层请求实时刷新：主窗口 JS 监听 `tray://refresh` 补读设备后回推
#[tauri::command]
pub fn tray_refresh(app: AppHandle) {
    let _ = app.emit_to("main", "tray://refresh", ());
}

#[tauri::command]
pub fn tray_hide_popover(app: AppHandle) {
    hide_popover(&app);
}

#[tauri::command]
pub fn tray_open_main(app: AppHandle) {
    hide_popover(&app);
    show_main(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(img: &tauri::image::Image<'_>, x: u32, y: u32) -> [u8; 4] {
        let rgba = img.rgba();
        let i = ((y * img.width() + x) * 4) as usize;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    }

    fn solid(a: [u8; 4], rgb: [u8; 3], what: &str) {
        for k in 0..3 {
            assert!(a[k].abs_diff(rgb[k]) <= 1, "{what}：{a:?} 不是 {rgb:?}");
        }
        assert_eq!(a[3], 255, "{what}：{a:?} 应该完全不透明");
    }

    fn clear(a: [u8; 4], what: &str) {
        assert_eq!(a[3], 0, "{what}：{a:?} 应该是透明的");
    }

    /// 不透明度过半的像素组成的外框（宽、高）
    fn bounds(img: &tauri::image::Image<'_>) -> (u32, u32) {
        let (mut x0, mut x1, mut y0, mut y1) = (u32::MAX, 0, u32::MAX, 0);
        for (i, p) in img.rgba().chunks_exact(4).enumerate() {
            if p[3] < 128 {
                continue;
            }
            let w = img.width() as usize;
            let (x, y) = ((i % w) as u32, (i / w) as u32);
            x0 = x0.min(x);
            x1 = x1.max(x);
            y0 = y0.min(y);
            y1 = y1.max(y);
        }
        (x1 - x0 + 1, y1 - y0 + 1)
    }

    /// 墨量：不透明度的总和
    fn ink_of(img: &tauri::image::Image<'_>) -> f32 {
        img.rgba().chunks_exact(4).map(|p| p[3] as f32 / 255.0).sum()
    }

    #[test]
    fn lamp_follows_connection_and_battery() {
        let pal = &LIGHT_TASKBAR;
        assert_eq!(lamp_for(false, Some(80), pal), None);
        assert_eq!(lamp_for(true, None, pal), Some(pal.green)); // 连上了但电量还没读到
        assert_eq!(lamp_for(true, Some(94), pal), Some(pal.green));
        assert_eq!(lamp_for(true, Some(60), pal), Some(pal.yellow));
        assert_eq!(lamp_for(true, Some(26), pal), Some(pal.yellow));
        assert_eq!(lamp_for(true, Some(25), pal), Some(pal.red));
        assert_eq!(lamp_for(true, Some(0), pal), Some(pal.red));
    }

    #[test]
    fn connected_is_a_solid_mouse_inside_an_outline_frame() {
        // 150% 缩放：24 像素，1 个单位 = 1.5 像素。框占满 24×24、线宽 2 像素；鼠标 12×16 像素；灯在中心偏下 3.5 像素处
        let img = tray_glyph(Some(LIGHT_TASKBAR.green), &LIGHT_TASKBAR, 24);
        let ink = LIGHT_TASKBAR.ink;
        clear(pixel(&img, 0, 0), "框的圆角之外");
        clear(pixel(&img, 23, 23), "框的圆角之外");
        clear(pixel(&img, 12, 2), "框和鼠标之间"); // 框里不填色
        clear(pixel(&img, 2, 12), "框和鼠标之间");
        solid(pixel(&img, 12, 0), ink, "框的上边");
        solid(pixel(&img, 0, 12), ink, "框的左边");
        solid(pixel(&img, 23, 12), ink, "框的右边");
        solid(pixel(&img, 12, 23), ink, "框的下边");
        solid(pixel(&img, 12, 12), ink, "鼠身");
        solid(pixel(&img, 10, 8), ink, "分键线旁边的鼠身");
        solid(pixel(&img, 12, 15), LIGHT_TASKBAR.green, "指示灯");
        let seam = pixel(&img, 12, 7);
        assert!(seam[3] < 80, "分键线应该留空透出任务栏：{seam:?}");
    }

    #[test]
    fn disconnected_is_a_dimmed_mouse_and_no_lamp() {
        let img = tray_glyph(None, &LIGHT_TASKBAR, 24);
        let ink = LIGHT_TASKBAR.ink;
        solid(pixel(&img, 12, 0), ink, "框不变");
        solid(pixel(&img, 0, 12), ink, "框不变");
        let body = pixel(&img, 12, 12);
        for k in 0..3 {
            assert!(body[k].abs_diff(ink[k]) <= 1, "鼠身：{body:?} 不是 {ink:?}");
        }
        assert_eq!(body[3], 128, "鼠身应该是一半不透明");
        assert_eq!(pixel(&img, 12, 15), body, "灯不亮：灯的位置和鼠身一样");
    }

    #[test]
    fn ink_follows_the_taskbar_theme() {
        let dark = tray_glyph(Some(DARK_TASKBAR.green), &DARK_TASKBAR, 24);
        solid(pixel(&dark, 12, 0), DARK_TASKBAR.ink, "深色任务栏上的框");
        solid(pixel(&dark, 12, 12), DARK_TASKBAR.ink, "深色任务栏上的鼠身");
        solid(pixel(&dark, 12, 15), DARK_TASKBAR.green, "深色任务栏上的灯");
    }

    #[test]
    fn glyph_matches_the_neighbouring_icons_in_size() {
        // 量的是真实托盘里的邻居：它们占满 24×24 像素，单色的那几个墨量（相对任务栏底色的暗度加起来）197~405。
        // 这里的墨量是不透明度加起来，在代码输出上量：连着时 328、没连接时 245；第四版连着时是 293。
        // 鼠标是竖长的，不加框再宽也只有 16×22（用户说太瘦），所以外轮廓由框来撑，占满整个图标位
        let on = tray_glyph(Some(LIGHT_TASKBAR.green), &LIGHT_TASKBAR, 24);
        assert_eq!(bounds(&on), (24, 24), "外框（像素）");
        let ink = ink_of(&on);
        assert!(
            ink > 300.0 && ink < 360.0,
            "墨量 {ink:.0} 应该和第四版（293）相近：连着时是 328"
        );
        // 没连接时鼠标变灰，分量轻一截，外轮廓不变
        let off = tray_glyph(None, &LIGHT_TASKBAR, 24);
        assert_eq!(bounds(&off), (24, 24), "外框（像素）");
        assert!(
            ink_of(&off) < ink - 60.0,
            "没连接的墨量 {} 不应该和连着的时候差不多",
            ink_of(&off)
        );
    }

    #[test]
    fn glyph_is_drawn_at_every_tray_size() {
        for size in [16u32, 20, 24, 28, 32] {
            let img = tray_glyph(Some(LIGHT_TASKBAR.green), &LIGHT_TASKBAR, size);
            let opaque = img.rgba().chunks_exact(4).filter(|p| p[3] == 255).count();
            assert!(
                opaque > (size * size / 4) as usize,
                "{size} 像素下实心的像素太少：{opaque}"
            );
            assert_eq!(bounds(&img), (size, size), "{size} 像素下框应该占满图标位");
            // 灯在正中偏下（中心 + 3.5 像素，按 150% 折算）
            let c = size / 2;
            let lamp_y = c + (3.5 * size as f32 / 24.0).round() as u32;
            solid(
                pixel(&img, c, lamp_y),
                LIGHT_TASKBAR.green,
                &format!("{size} 像素下的指示灯"),
            );
        }
    }
}
