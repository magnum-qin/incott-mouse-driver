//! 托盘系统 —— 对应上游 main/index.js 的托盘部分 + main/tray-popover.js。
//!
//!  - 托盘图标 = 应用图标那只鼠标（按托盘的实际尺寸现画），用指示灯表示状态：
//!    未连接 = 灯灭，连接后按电量三段变色（>60 绿 / 25~60 黄 / ≤25 红）
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
/// 一只鼠标的各部分在画布里的比例，单位是画布边长
#[derive(Clone, Copy)]
struct Shape {
    rx: f32,          // 鼠标半宽
    top: f32,         // 顶边到中心
    bottom: f32,      // 底边到中心
    dome: f32,        // 顶部圆拱的高
    bottom_dome: f32, // 底部收圆的高
    groove_hw: f32,   // 分键槽半宽
    groove_end: f32,  // 分键槽底端到中心
    lamp_r: f32,      // 指示灯半径
    lamp_cy: f32,     // 指示灯中心
    radius: f32,      // 底板圆角
    tile: [u8; 3],    // 底板
    body: [u8; 3],    // 鼠标
}

/// 图标挨着一排别的应用图标时（任务栏、托盘），分量来自反差和占比。大图缩到二十来个像素，
/// 鼠标只剩细细一条，看着比旁边的小一圈——所以小尺寸用这套加粗的比例：底板更黑，鼠标更宽、纯白。
/// design/icon/small-frames.mjs 里有一份同样的实现，给应用图标出小尺寸帧；改这里要同步
const BOLD: Shape = Shape {
    rx: 0.37, // 鼠标宽 74%
    top: 0.35,
    bottom: 0.35,
    dome: 0.27,
    bottom_dome: 0.19,
    groove_hw: 0.05,
    groove_end: -0.10,
    lamp_r: 0.12,
    lamp_cy: 0.10,
    radius: 0.22,
    tile: [0x11, 0x11, 0x13],
    body: [0xff, 0xff, 0xff],
};

/// 应用图标大图的比例，尺寸大了就回到这个修长的样子
const REGULAR: Shape = Shape {
    rx: 0.215, // 鼠标宽 43%
    top: 0.354,
    bottom: 0.355,
    dome: 0.244,
    bottom_dome: 0.172,
    groove_hw: 0.033,
    groove_end: -0.113,
    lamp_r: 0.043,
    lamp_cy: 0.107,
    radius: 0.22,
    tile: [0x23, 0x23, 0x27],
    body: [0xed, 0xed, 0xee],
};

/// 各个边长下取多少 BOLD（1 = 全按 BOLD，0 = 大图的比例），节点之间线性过渡
const BOLD_SHARE: [(u32, f32); 4] = [(24, 1.0), (32, 0.55), (48, 0.4), (64, 0.0)];

const LAMP_OFF: [u8; 3] = [0x3a, 0x3a, 0x40]; // 灯灭时是白色鼠标上的一个深色灯座

/// 托盘图标里那盏灯的颜色，含义和主界面一致：没连接 = 灯灭；连上之后按电量分三段。
/// 电量还没读到时给绿灯——那是「已连接」灯（同标题栏），不当成未连接
fn lamp_for(connected: bool, battery: Option<u8>) -> [u8; 3] {
    if !connected {
        LAMP_OFF
    } else {
        match battery {
            Some(b) if b > 25 && b <= 60 => [0xf0, 0xb3, 0x4c], // 黄（--warning）
            Some(b) if b <= 25 => [0xf0, 0x58, 0x5d],           // 红（--danger）
            _ => [0x46, 0xc9, 0x8c],                            // 绿（--success）
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

/// 边长 size 的图标取多少 BOLD，节点之间线性过渡，两端之外取端点
fn bold_share(size: u32) -> f32 {
    let s = size as f32;
    let (mut x0, mut y0) = BOLD_SHARE[0];
    if s <= x0 as f32 {
        return y0;
    }
    for &(x1, y1) in BOLD_SHARE.iter().skip(1) {
        if s <= x1 as f32 {
            return y0 + (y1 - y0) * (s - x0 as f32) / (x1 - x0) as f32;
        }
        (x0, y0) = (x1, y1);
    }
    y0
}

fn blend(t: f32) -> Shape {
    let m = |a: f32, b: f32| a * t + b * (1.0 - t);
    let c =
        |a: [u8; 3], b: [u8; 3]| std::array::from_fn(|k| m(a[k] as f32, b[k] as f32).round() as u8);
    Shape {
        rx: m(BOLD.rx, REGULAR.rx),
        top: m(BOLD.top, REGULAR.top),
        bottom: m(BOLD.bottom, REGULAR.bottom),
        dome: m(BOLD.dome, REGULAR.dome),
        bottom_dome: m(BOLD.bottom_dome, REGULAR.bottom_dome),
        groove_hw: m(BOLD.groove_hw, REGULAR.groove_hw),
        groove_end: m(BOLD.groove_end, REGULAR.groove_end),
        lamp_r: m(BOLD.lamp_r, REGULAR.lamp_r),
        lamp_cy: m(BOLD.lamp_cy, REGULAR.lamp_cy),
        radius: m(BOLD.radius, REGULAR.radius),
        tile: c(BOLD.tile, REGULAR.tile),
        body: c(BOLD.body, REGULAR.body),
    }
}

/// 托盘图标：和应用图标是同一只鼠标（同一套按尺寸加粗的比例），灯的颜色表示状态。
///
/// 不把大图缩下来，而是按托盘的实际尺寸现画：小尺寸用加粗的比例，尺寸越大越接近大图的修长比例。
/// 各部分用有向距离描述，逐像素算覆盖率再合成；窄于 1.5px 的细节在小尺寸下会被抗锯齿抹掉，给了下限
fn tray_icon(lamp: [u8; 3], size: u32) -> tauri::image::Image<'static> {
    let sh = blend(bold_share(size));
    let s = size as f32;
    let half = s / 2.0;
    // 鼠标：顶部圆拱，中间直边，底部收圆
    let rx = sh.rx * s;
    let top = -sh.top * s;
    let dome = sh.dome * s;
    let bottom_dome = sh.bottom_dome * s;
    let dome_cy = top + dome;
    let bottom_cy = sh.bottom * s - bottom_dome;
    // 分键槽：从顶边通下来
    let groove_hw = (sh.groove_hw * s).max(0.75);
    let groove_top = top - 1.0;
    let groove_end = sh.groove_end * s;
    // 指示灯
    let lamp_r = (sh.lamp_r * s).max(1.6);
    let lamp_cy = sh.lamp_cy * s;
    let radius = sh.radius * s; // 底板圆角

    let mut rgba = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let px = x as f32 + 0.5 - half;
            let py = y as f32 + 0.5 - half;
            let tile = coverage(sd_round_box(px, py, half, half, radius));
            if tile <= 0.0 {
                continue;
            }
            let body = sd_ellipse(px, py - dome_cy, rx, dome)
                .min(sd_ellipse(px, py - bottom_cy, rx, bottom_dome))
                .min(sd_round_box(
                    px,
                    py - (dome_cy + bottom_cy) / 2.0,
                    rx,
                    (bottom_cy - dome_cy) / 2.0,
                    0.0,
                ));
            let body = coverage(body);
            let groove = coverage(sd_round_box(
                px,
                py - (groove_top + groove_end) / 2.0,
                groove_hw,
                (groove_end - groove_top) / 2.0,
                groove_hw,
            )) * body;
            let lit = coverage(px.hypot(py - lamp_cy) - lamp_r) * body;
            // 自下而上合成：底板 → 鼠标 → 分键槽（底色）→ 指示灯。槽和灯不重叠
            let plain = body - groove - lit;
            let i = ((y * size + x) * 4) as usize;
            for k in 0..3 {
                let v = sh.tile[k] as f32 * (1.0 - body)
                    + sh.body[k] as f32 * plain
                    + sh.tile[k] as f32 * groove
                    + lamp[k] as f32 * lit;
                rgba[i + k] = v.round() as u8;
            }
            rgba[i + 3] = (tile * 255.0).round() as u8;
        }
    }
    tauri::image::Image::new_owned(rgba, size, size)
}

/// 按当前的连接 / 电量状态重画托盘图标
fn refresh_tray_icon(st: &TrayState) {
    let lamp = lamp_for(*st.connected.lock().unwrap(), *st.battery.lock().unwrap());
    let icon = tray_icon(lamp, tray_icon_size());
    if let Some(tray) = st.tray.lock().unwrap().clone() {
        let _ = tray.set_icon(Some(icon));
    }
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
        .icon(tray_icon(lamp_for(false, None), tray_icon_size()))
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
