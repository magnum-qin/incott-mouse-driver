/**
 * 桥接层杂项 —— 设置 / 应用信息 / 窗口控制 / 导入导出 / i18n 胶水。
 *
 * 对应上游 preload/index.js 里除 mouse:* 与 tray:* 之外的 API。
 * 窗口控制走 Tauri window API；导入导出的 .ict/.icm 编解码在 JS 侧
 * （shared/config-format.js），Rust 只负责文件对话框和读写。
 */

import * as i18n from '../shared/i18n.js';
import * as fmt from '../shared/config-format.js';

const { invoke } = window.__TAURI__.core;
const { listen, emit } = window.__TAURI__.event;

const win = window.__TAURI__.window.getCurrentWindow();

// ── 设置 ───────────────────────────────────────────────────
const api = {
  getSettings: () => invoke('settings_get'),
  setSettings: (patch) => invoke('settings_set', { patch: patch || {} }),

  // ── 应用信息 / 外链 ────────────────────────────────────────
  getAppInfo: () => invoke('get_app_info'),
  openExternal: async (url) => {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
      throw new Error('只允许打开 https 链接');
    }
    return invoke('open_url', { url });
  },
  showAbout: async () => {
    const info = await invoke('get_app_info').catch(() => null);
    const version = info && info.version ? `v${info.version}` : '';
    const homepage = (info && info.homepage) || 'https://github.com/magnum-qin/incott-mouse-driver';
    return invoke('show_about', {
      title: i18n.t('menuAbout'),
      body: `Incott Mouse Driver ${version}\n\n${i18n.t('aboutText')}\n\n${homepage}`,
    });
  },

  // ── 窗口控制（自绘标题栏）─────────────────────────────────
  minimizeWindow: () => win.minimize(),
  toggleMaximizeWindow: async () => {
    await win.toggleMaximize();
    return win.isMaximized();
  },
  closeWindow: () => win.close(), // Rust 拦截为隐藏到托盘
  isMaximized: () => win.isMaximized(),
  onMaximizedChange: (cb) => {
    listen('win://maximized', (ev) => cb(ev.payload));
  },

  // ── 配置 / 宏 导入导出（官方 .ict / .icm 格式）─────────────
  exportProfile: async (profileData) => {
    const path = await invoke('export_file', {
      defaultName: 'incott-profile.ict',
      filterName: 'Incott Profile',
      filterExt: 'ict',
      contents: fmt.exportProfile(profileData),
    });
    return path == null ? { canceled: true } : { canceled: false, filePath: path };
  },
  importProfile: async () => {
    const text = await invoke('import_file', {
      filterName: 'Incott Profile',
      filterExt: 'ict',
    });
    if (text == null) return { canceled: true };
    // importProfile 已把 <50 的 DPI（含 0/负数）统一按 50 归一
    const profile = fmt.importProfile(text);
    if (!profile) throw new Error('不是有效的 .ict 配置文件（magic 校验失败）');
    return { canceled: false, profile };
  },
  exportMacros: async (macros) => {
    const text = fmt.exportMacros(macros);
    if (!text) throw new Error('没有可导出的宏（所有槽位均为空）');
    const path = await invoke('export_file', {
      defaultName: 'incott-macros.icm',
      filterName: 'Incott Macro',
      filterExt: 'icm',
      contents: text,
    });
    return path == null ? { canceled: true } : { canceled: false, filePath: path };
  },
  importMacros: async () => {
    const text = await invoke('import_file', {
      filterName: 'Incott Macro',
      filterExt: 'icm',
    });
    if (text == null) return { canceled: true };
    const macros = fmt.importMacros(text);
    if (!macros.length) throw new Error('文件中没有有效的宏（magic 校验失败）');
    return { canceled: false, macros };
  },
};

export { api };

// ── i18n 胶水：跨窗口同步 + 托盘菜单文案推送 ────────────────
export function makeI18nBridge() {
  const pushTrayLang = () => {
    invoke('tray_set_lang', {
      labels: {
        open: i18n.t('trayOpen'),
        batteryLabel: i18n.t('batteryLabel'),
        quit: i18n.t('menuQuit'),
        notConnected: i18n.t('notConnected'),
      },
    }).catch(() => {});
  };
  return {
    t: (key, vars) => i18n.t(key, vars),
    getLang: () => i18n.getLang(),
    setLang: (lang) => {
      const l = i18n.setLang(lang);
      emit('app://lang', l); // 广播给浮层等其它窗口
      pushTrayLang(); // 同步托盘菜单
      return l;
    },
    onLangChanged: (cb) => {
      listen('app://lang', (ev) => {
        i18n.setLang(ev.payload);
        cb(ev.payload);
      });
    },
    _pushTrayLang: pushTrayLang,
  };
}
