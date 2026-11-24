/**
 * 主窗口桥接入口 —— 组装 window.api / window.i18n / window.keynames，
 * 供原版 app.js 零改动运行（它只依赖这三个全局对象，与 Electron preload 等价）。
 *
 * 另外实现顶栏拖拽（等价 -webkit-app-region: drag 的 JS 版本）：
 * 非交互区域按下左键 → startDragging，双击 → 切换最大化。
 */

import * as keynames from '../shared/keynames.js';
import * as i18n from '../shared/i18n.js';
import { api as coreApi, boot } from './core.js';
import { api as miscApi, makeI18nBridge } from './misc.js';

const win = window.__TAURI__.window.getCurrentWindow();

// window.api —— 表面对齐上游 preload（update 系列已按需求移除，恢复时见 README）
window.api = { ...coreApi, ...miscApi };

// window.i18n —— 跨窗口同步 + 托盘菜单文案
window.i18n = makeI18nBridge();

// window.keynames —— 键位显示名
window.keynames = {
  keyLabel: (kind, value) => keynames.keyLabel(kind, value, i18n.getLang()),
};

// 启动时把当前语言的托盘菜单文案推给 Rust（Rust 侧菜单默认是中文占位）
window.i18n._pushTrayLang();

// ── 顶栏拖拽区（对应 style.css 里 -webkit-app-region 的 Electron 行为）────
const DRAG_EXCLUDE = 'button, input, select, a, .battery, .lang-menu, .settings-menu, .settings-item, .device-bar .icon-btn';
const topbar = document.querySelector('.topbar');
if (topbar) {
  topbar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(DRAG_EXCLUDE)) return;
    win.startDragging();
  });
  topbar.addEventListener('dblclick', (e) => {
    if (e.target.closest(DRAG_EXCLUDE)) return;
    win.toggleMaximize();
  });
}

// 桥接核心启动：HID 事件订阅 + 设备预枚举 + 电量轮询
boot();
