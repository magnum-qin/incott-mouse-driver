//! HID 传输层 —— hidapi 封装，对齐上游 node-hid 的语义。
//!
//! 架构（对应上游 src/main/hid.js）：
//!  - 枚举：过滤 VID 0x093A + usagePage 0xFF05 + usage 1，不限 PID（多型号兼容）
//!  - 打开：按路径打开 + 探测写（Col01 发 Feature Report 会失败，必须用 Col02）
//!  - IO：单个线程持有 HidDevice，命令走 mpsc 通道串行执行；
//!    读循环用 read_timeout(5ms) 穿插命令处理 → 与 node-hid 的串行语义一致
//!    （上游 withIo 队列存在的原因：feature report 读写共用通道，并发会互相顶掉响应）
//!  - 输入报文推送 → `hid://data` 事件；断连 → `hid://error` 事件
//!
//! 字节布局（与上游一致）：
//!  - Feature Report：report ID 9 + 8 字节数据区；get 返回含 reportId 首字节
//!  - Output Report（宏分块）：JS 侧前置 reportId 后整体传入

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

use hidapi::HidApi;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::protocol_const;

// ── 命令通道 ───────────────────────────────────────────────
enum IoCmd {
    /// 写 Feature Report（bytes 已含 reportId 前缀）
    WriteFeature(Vec<u8>, Sender<Result<(), String>>),
    /// 读 Feature Report：len 为数据区长度，返回 len+1 字节（含 reportId）
    GetFeature(usize, Sender<Result<Vec<u8>, String>>),
    /// 写 Output Report（bytes 已含 reportId 前缀）
    WriteOutput(Vec<u8>, Sender<Result<(), String>>),
    /// 关闭设备
    Close(Sender<Result<(), String>>),
}

#[derive(Default)]
pub struct HidState {
    cmd_tx: Mutex<Option<Sender<IoCmd>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    pub vendor_id: u16,
    pub product_id: u16,
    pub path: String,
    pub serial_number: Option<String>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub is_wireless: bool,
}

fn is_wireless_device(pid: u16, product: &str) -> bool {
    if pid == protocol_const::PID_WIRELESS {
        return true;
    }
    let name = product.to_lowercase();
    name.contains("wireless") || name.contains("无线")
}

/// 枚举匹配的 Incott 配置接口（在 Tauri 线程池里同步执行）
fn enumerate() -> Result<Vec<DeviceEntry>, String> {
    let api = HidApi::new().map_err(|e| format!("hidapi init: {e}"))?;
    Ok(api
        .device_list()
        .filter(|d| {
            d.vendor_id() == protocol_const::VID
                && d.usage_page() == protocol_const::USAGE_PAGE
                && d.usage() == protocol_const::USAGE
        })
        .map(|d| DeviceEntry {
            vendor_id: d.vendor_id(),
            product_id: d.product_id(),
            path: d.path().to_string_lossy().into_owned(),
            serial_number: d.serial_number().map(|s| s.to_string()),
            manufacturer: d.manufacturer_string().map(|s| s.to_string()),
            product: d.product_string().map(|s| s.to_string()),
            is_wireless: is_wireless_device(
                d.product_id(),
                d.product_string().unwrap_or_default(),
            ),
        })
        .collect())
}

/// IO 线程主体：串行处理命令 + 轮询输入报文
fn io_loop(app: AppHandle, dev: hidapi::HidDevice, rx: Receiver<IoCmd>, path: String) {
    let mut buf = [0u8; 256];
    loop {
        // 先清空命令队列（每个命令同步回执）
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                IoCmd::WriteFeature(data, tx) => {
                    let r = dev
                        .send_feature_report(&data)
                        .map(|_| ())
                        .map_err(hid_err("hid_write_feature"));
                    let _ = tx.send(r);
                }
                IoCmd::GetFeature(len, tx) => {
                    let mut fb = vec![0u8; len + 1]; // +1 = reportId（hidapi 约定首字节填 reportId）
                    fb[0] = protocol_const::REPORT_ID as u8;
                    let r = dev
                        .get_feature_report(&mut fb)
                        .map(|_| fb)
                        .map_err(hid_err("hid_get_feature_report"));
                    let _ = tx.send(r);
                }
                IoCmd::WriteOutput(data, tx) => {
                    let r = dev
                        .write(&data)
                        .map(|_| ())
                        .map_err(hid_err("hid_write_output"));
                    let _ = tx.send(r);
                }
                IoCmd::Close(tx) => {
                    let _ = tx.send(Ok(()));
                    return; // drop(dev) 关闭句柄
                }
            }
        }
        match dev.read_timeout(&mut buf, 5) {
            Ok(0) => {} // 超时，继续轮询命令
            Ok(n) => {
                if n >= 2 {
                    // 剥离 reportId 后推送（与上游 hid.js onData 一致）
                    let payload: Vec<u8> = buf[1..n].to_vec();
                    let _ = app.emit("hid://data", payload);
                }
            }
            Err(e) => {
                // 设备拔出/接收器掉线：通知 JS 清理状态（带 path，防旧连接迟到错误误伤新连接）
                let _ = app.emit(
                    "hid://error",
                    serde_json::json!({ "path": path, "message": e.to_string() }),
                );
                return;
            }
        }
    }
}

fn hid_err(op: &'static str) -> impl Fn(hidapi::HidError) -> String {
    move |e| format!("{op}: {e}")
}

/// 通知 IO 线程关闭并等待退出（最多 500ms，超时则丢弃句柄）
fn close_device(state: &HidState) {
    let tx = state.cmd_tx.lock().unwrap().take();
    if let Some(tx) = tx {
        let (ack_tx, ack_rx) = channel();
        if tx.send(IoCmd::Close(ack_tx)).is_ok() {
            let _ = ack_rx.recv_timeout(Duration::from_millis(500));
        }
    }
}

/// 应用退出时清理（幂等）
pub fn shutdown(app: &AppHandle) {
    let st = app.state::<HidState>();
    close_device(&st);
}

// ── Tauri 命令 ─────────────────────────────────────────────
#[tauri::command]
pub async fn hid_list() -> Result<Vec<DeviceEntry>, String> {
    tauri::async_runtime::spawn_blocking(enumerate)
        .await
        .map_err(|e| e.to_string())?
}

/// 打开设备：按 path 打开 + 探测写（写不进的接口直接失败，JS 换下一个重试）。
/// JS 侧负责两轮重试（缓存倒序 Col02 优先 → 重新枚举）。
#[tauri::command]
pub async fn hid_open(
    app: AppHandle,
    state: State<'_, HidState>,
    path: String,
) -> Result<DeviceEntry, String> {
    // 打开前先关掉旧连接（保持单连接语义，避免两个 IO 线程抢同一设备）
    close_device(&state);

    let (dev, entry) = tauri::async_runtime::spawn_blocking(move || {
        open_and_probe(&path)
    })
    .await
    .map_err(|e| e.to_string())?
    ?;

    let (tx, rx) = channel::<IoCmd>();
    *state.cmd_tx.lock().unwrap() = Some(tx);
    let io_path = entry.path.clone();
    tauri::async_runtime::spawn_blocking(move || io_loop(app, dev, rx, io_path));
    Ok(entry)
}

fn open_and_probe(path: &str) -> Result<(hidapi::HidDevice, DeviceEntry), String> {
    let api = HidApi::new().map_err(|e| format!("hidapi init: {e}"))?;
    // hidapi 2.x 的 open_path 收 &CStr（Windows 侧由库内部转宽字符）
    let c_path = std::ffi::CString::new(path.to_string())
        .map_err(|e| format!("path 含非法字符: {e}"))?;
    let dev = api
        .open_path(&c_path)
        .map_err(|e| format!("cannot open device: {e}"))?;

    // 用同一次枚举补全设备描述（pid/product/序列号）
    let info = api.device_list().find(|d| d.path().to_string_lossy() == path);
    let (pid, product) = match &info {
        Some(d) => (
            d.product_id(),
            d.product_string().unwrap_or_default().to_string(),
        ),
        None => (0, String::new()),
    };

    // 探测通信：Col01 在此失败（HidD_SetFeature 报错），上游用同样的探测方式
    let probe = [protocol_const::REPORT_ID as u8, 0x89, 0, 0, 0, 0, 0, 0, 0];
    if let Err(e) = dev.send_feature_report(&probe) {
        return Err(format!("probe failed: {e}"));
    }

    let entry = DeviceEntry {
        vendor_id: protocol_const::VID,
        product_id: pid,
        path: path.to_string(),
        serial_number: info.and_then(|d| d.serial_number().map(|s| s.to_string())),
        manufacturer: info.and_then(|d| d.manufacturer_string().map(|s| s.to_string())),
        product: Some(product.clone()),
        is_wireless: is_wireless_device(pid, &product),
    };
    Ok((dev, entry))
}

#[tauri::command]
pub async fn hid_send_feature(state: State<'_, HidState>, bytes: Vec<u8>) -> Result<(), String> {
    let tx = state.cmd_tx.lock().unwrap().clone();
    let Some(tx) = tx else {
        return Err("设备未连接".into());
    };
    let (ack_tx, ack_rx) = channel();
    tx.send(IoCmd::WriteFeature(bytes, ack_tx))
        .map_err(|_| "设备 IO 线程已退出（可能已断开）".to_string())?;
    ack_rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "设备响应超时".to_string())?
}

#[tauri::command]
pub async fn hid_get_feature(state: State<'_, HidState>, len: usize) -> Result<Vec<u8>, String> {
    let tx = state.cmd_tx.lock().unwrap().clone();
    let Some(tx) = tx else {
        return Err("设备未连接".into());
    };
    let (ack_tx, ack_rx) = channel();
    tx.send(IoCmd::GetFeature(len, ack_tx))
        .map_err(|_| "设备 IO 线程已退出（可能已断开）".to_string())?;
    ack_rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "设备响应超时".to_string())?
}

#[tauri::command]
pub async fn hid_write_output(state: State<'_, HidState>, bytes: Vec<u8>) -> Result<(), String> {
    let tx = state.cmd_tx.lock().unwrap().clone();
    let Some(tx) = tx else {
        return Err("设备未连接".into());
    };
    let (ack_tx, ack_rx) = channel();
    tx.send(IoCmd::WriteOutput(bytes, ack_tx))
        .map_err(|_| "设备 IO 线程已退出（可能已断开）".to_string())?;
    ack_rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "设备响应超时".to_string())?
}

#[tauri::command]
pub async fn hid_close(app: AppHandle) -> Result<(), String> {
    let st = app.state::<HidState>();
    close_device(&st);
    Ok(())
}
