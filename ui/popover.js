/**
 * 托盘信息弹窗的渲染逻辑。
 *
 * 只做三件事：把主进程推来的状态画到界面上、按 i18n 切换文案、把点击转成主进程动作。
 * 状态结构见主进程 trayStatus()：
 *   { connected, name, link, wireless, battery, charging, dpi, dpiIndex, levels, rate, profile, profileCount }
 * link 是连接方式代码（'8k' = 8K 接收器，'wired' = 有线，null = 不标），文案在这里按当前语言拼
 */

'use strict';

// 注意：不能写成 `const api = window.api`——contextBridge 会在全局定义不可配置的 `api`，
// 顶层 const 同名会直接 SyntaxError（Identifier 'api' has already been declared）。
const bridge = window.api;
const t = (key) => window.i18n.t(key);

const el = {
  dot: document.getElementById('pvDot'),
  name: document.getElementById('pvName'),
  state: document.getElementById('pvState'),
  battery: document.getElementById('pvBattery'),
  charging: document.getElementById('pvCharging'),
  fill: document.getElementById('pvFill'),
  dpi: document.getElementById('pvDpi'),
  rate: document.getElementById('pvRate'),
  profile: document.getElementById('pvProfile'),
  foot: document.getElementById('pvFoot'),
};

let lastStatus = null;
let renderedLang = null;

/** 静态文案走 data-i18n（与主界面同一套约定） */
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  renderedLang = window.i18n.getLang();
}

/**
 * 写一格读数：值或附属内容变了才重写，并短促亮一下（数字本身不滚动）——与主界面读数屏是同一套做法。
 * unit 是跟在后面的单位 / 总数（<small>），和数值一起算进「变没变」的判断：它只在重写的那一次
 * 追加。value 为 null 表示读不到，显示 -- 并变暗。
 */
function put(node, value, unit = '') {
  const key = value == null ? '--' : `${value}|${unit}`;
  if (node.dataset.v === key) return;
  node.dataset.v = key;
  node.textContent = value == null ? '--' : String(value);
  if (value != null && unit) node.append(small(unit));
  node.classList.toggle('dim', value == null);
  if (value != null && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    node.classList.remove('value-flash');
    void node.offsetWidth; // 强制重排，让动画能重复触发
    node.classList.add('value-flash');
  }
}

const small = (text) => Object.assign(document.createElement('small'), { textContent: text });

function render(status) {
  if (!status) return;
  lastStatus = status;
  // 主进程可能在面板隐藏期间切了语言，重绘前先对齐文案
  if (renderedLang !== window.i18n.getLang()) applyI18n();

  el.dot.classList.toggle('on', !!status.connected);
  const link = status.link === '8k' ? '8K' : status.link === 'wired' ? t('linkWired') : '';
  put(el.name, status.connected ? [status.name || 'Incott', link].filter(Boolean).join(' · ') : 'Incott');

  if (!status.connected) {
    put(el.state, t('notConnected'));
  } else if (status.levels && status.dpiIndex != null) {
    put(el.state, t('trayLevelOf').replace('{n}', status.dpiIndex + 1).replace('{m}', status.levels));
  } else {
    put(el.state, '');
  }

  // 电量：null 表示未连接/未读到（设备休眠时读到 0 也算无效，主进程已过滤）
  const level = status.battery;
  put(el.battery, level);
  el.charging.classList.toggle('gone', !(status.charging && level != null));
  const pct = level == null ? 0 : Math.min(Math.max(level, 0), 100);
  el.fill.style.width = `${pct}%`;
  el.fill.className = 'pv-fill';
  if (level == null) el.fill.classList.add('off');
  else if (level <= 25) el.fill.classList.add('low');
  else if (level <= 60) el.fill.classList.add('mid');

  put(el.dpi, status.dpi);
  put(el.rate, status.rate, 'Hz');
  // 绿字 = 鼠标正在运行的那一份配置（与底栏配置键、读数屏的含义一致）
  put(el.profile, status.profile == null ? null : status.profile + 1, `/ ${status.profileCount || 5}`);
  el.profile.classList.toggle('run', status.profile != null);
}

function openMain() {
  bridge.openMainFromTray();
}

el.foot.addEventListener('click', openMain);
el.foot.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openMain();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') bridge.hideTrayPopover();
});

async function boot() {
  applyI18n();
  try {
    render(await bridge.getTrayStatus());
  } catch (_) {
    /* 主进程尚未就绪时留空面板，稍后推送会补上 */
  }
  bridge.onTrayStatus(render);
  // 每次弹出播放一次淡入（窗口常驻，隐藏再从左上角"跳"出来会显得生硬）
  bridge.onPopoverShown(() => {
    window.applyMirroredTheme(); // 这个窗口常驻内存，期间主界面可能换过主题
    document.body.classList.remove('pv-in');
    void document.body.offsetWidth; // 强制重排，让动画能重复触发
    document.body.classList.add('pv-in');
  });
  // 打开面板时补一次实时读取（缓存值先显示，读到再刷新），失败沿用缓存
  bridge.refreshTrayStatus().then(render).catch(() => {});
  window.i18n.onLangChanged(() => {
    applyI18n();
    if (lastStatus) render(lastStatus);
  });
}

boot();
