//! 协议常量（与 ui/shared/protocol.js 保持一致，Rust 侧只用到传输相关的几个）

pub const VID: u16 = 0x093a; // PixArt 原相
pub const PID_WIRELESS: u16 = 0x522c;
pub const REPORT_ID: u8 = 9;
pub const USAGE_PAGE: u16 = 0xff05;
pub const USAGE: u16 = 0x0001;
