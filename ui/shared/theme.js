/**
 * 主题只有两种：深色（默认）和亮色。样式表按 <html> 上的 data-mode 换一组取值。
 *
 * 设置本体在 settings.json 里（Rust 那边读）；同时在 localStorage 里留一份镜像，
 * theme-init.js 在页面画出来之前先照着镜像把主题摆好，免得选了亮色的用户每次启动都先闪一下深色。
 * 纯函数，单测覆盖（test/theme.test.js）。
 */
export const THEME_MIRROR = 'incott-theme';

/** 设置里的取值：只有 'light' 算亮色，其余（没存过、旧版本、写坏了）一律是深色 */
export function normalizeTheme(value) {
  return value === 'light' ? 'light' : 'dark';
}

/**
 * 把主题写到页面根上，并更新镜像。返回实际生效的主题。
 * root 是 document.documentElement，store 是 localStorage（测试里可以换成别的）。
 */
export function applyTheme(root, store, value) {
  const mode = normalizeTheme(value);
  root.dataset.mode = mode;
  try {
    store.setItem(THEME_MIRROR, mode);
  } catch (_) {
    /* 存不下镜像：下次启动仍由设置决定，只是可能闪一下 */
  }
  return mode;
}
