/**
 * 主题要在第一帧之前定下来。设置本体在 settings.json 里，要等 app.js 读完；
 * 从页面画出来到读完设置之间有一小段，这里先照上次留下的镜像（localStorage）把主题摆好，
 * 免得选了亮色的用户每次启动都先闪一下深色。
 *
 * 这是普通的同步脚本（不是模块）：两个页面的 <head> 里都把它放在样式表后面。
 * 镜像由 ui/shared/theme.js 的 applyTheme 写入。
 */
(function () {
  function mirroredTheme() {
    try {
      return localStorage.getItem('incott-theme') === 'light' ? 'light' : 'dark';
    } catch (_) {
      return 'dark';
    }
  }
  document.documentElement.dataset.mode = mirroredTheme();
  // 浮层窗口常驻在内存里，期间主界面可能换过主题：每次弹出之前再照镜像对一次
  window.applyMirroredTheme = function () {
    document.documentElement.dataset.mode = mirroredTheme();
  };
})();
