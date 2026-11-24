/**
 * 托盘浮层（popover 窗口）桥接入口 —— 只提供 popover.js 需要的 API 子集：
 * 状态读取/订阅/刷新、Esc 收起、打开主窗口。
 *
 * 状态本体在主窗口的 core.js 里维护：本窗口通过 Rust 缓存读取，
 * 刷新请求经 Rust 转发给主窗口补读设备后回推。
 */

import * as i18n from '../shared/i18n.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

window.api = {
  /** 浮层要显示的当前状态（Rust 缓存，主窗口维护） */
  getTrayStatus: () => invoke('tray_get_status'),
  /** 触发一次实时读取：请求主窗口补读，等下一次状态推送（2s 超时回退缓存） */
  refreshTrayStatus: () =>
    new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => finish(invoke('tray_get_status')), 2000);
      listen('tray://status', (ev) => finish(ev.payload)).catch(() => {});
      invoke('tray_refresh').catch(() => finish(invoke('tray_get_status')));
    }),
  /** 订阅浮层状态推送 */
  onTrayStatus: (cb) => {
    listen('tray://status', (ev) => cb(ev.payload));
  },
  /** 浮层每次弹出（用于播放淡入动画） */
  onPopoverShown: (cb) => {
    listen('popover://shown', () => cb());
  },
  /** 收起浮层（Esc） */
  hideTrayPopover: () => invoke('tray_hide_popover'),
  /** 收起浮层并打开主窗口 */
  openMainFromTray: () => invoke('tray_open_main'),
};

window.i18n = {
  t: (key) => i18n.t(key),
  getLang: () => i18n.getLang(),
  setLang: (lang) => i18n.setLang(lang),
  onLangChanged: (cb) => {
    listen('app://lang', (ev) => {
      i18n.setLang(ev.payload);
      cb(ev.payload);
    });
  },
};
