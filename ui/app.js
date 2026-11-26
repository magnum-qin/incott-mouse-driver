/**
 * 界面逻辑（渲染层）。
 *
 * 通过 window.api（bridge 暴露）与设备通信。四页：DPI 档位 / 按键映射 / 性能参数 / 宏，
 * 右侧常驻读数屏，底栏是配置键与应用。
 *
 * 两份状态，别混：
 *  - state     正在编辑的值（界面上的按键、推子、输入框都指向它）
 *  - baseline  鼠标当前实际生效的值（连接时读回、应用成功后、设备主动变更时更新）
 * 两者有差异时「应用配置」键才点亮；读数屏显示的是 baseline，不是 state。
 */

'use strict';

const state = {
  connected: false,
  isWireless: false,
  modelInfo: null, // 0x8F 型号信息 { model, modelCode, is8KReceiver, sensor }
  battery: null,
  batteryCharging: false,
  batteryRemembered: false, // 电量不是刚读到的，是上一次知道的（无线时等鼠标上报）
  constants: null,
  maxDpi: 32000,
  dpiLevels: [], // [{ x, y, color }]
  currentDpi: 0,
  xySplit: false,
  rate: 1000,
  lod: 0,
  ripple: false,
  angleSnap: false,
  motionSync: false,
  debounce: 8,
  sensorMode: 2, // 性能模式：3=电竞 2=标准 1=节能（0x84 sub5 回读，G24 实测 2）
  sleepTime: 60, // 节能调节（秒），官方档位 10~900
  receiverLed: 0, // 接收器指示灯模式 0=回报率 1=电量 2=仅低电量
  profile: 0, // 编辑中的配置序号 0..4
  activeProfile: 0, // 鼠标正在运行的配置（应用成功 / 设备读回时更新）
  profiles: [], // 5 份配置预设（硬件只有 1 份，见 protocol.js PROFILE_COUNT）
  switching: false, // 鼠标上的配置切换键触发的整套写入进行中
  buttons: [], // [{ type: 'mouse'|'keyboard'|'media'|'macro', value }]
  macros: [], // [{ slot, name, loopType, cycle, items: [{press, keyCode, delay}] }]
  currentMacro: 0,
};

let baseline = null; // 鼠标当前实际生效的值；未连接时为 null
let applying = false; // 整套写入进行中
let applyPhase = 'idle'; // 底栏状态灯：idle | busy | ok | bad
let applyMsg = ''; // ok / bad 时显示的文字
let applyTimer = null; // ok 提示 4 秒后收起
let lastWriteAt = 0; // 最近一次「整套写入鼠标」的时间：用于忽略自身写入引起的配置序号回显
let resetArmed = false; // 「恢复默认」已经被点了一下，等第二下确认
let resetTimer = null;
const RESET_ARM_MS = 6000; // 等第二下的时间，过了就当作取消

import { applyTheme } from './shared/theme.js';
import { mouseArtFor, artLayout } from './shared/mouse-art.js';

const $ = (sel) => document.querySelector(sel);
const t = (key, vars) => window.i18n.t(key, vars);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const keyLabel = (kind, value) => (window.keynames ? window.keynames.keyLabel(kind, value) : value);

/** 建元素：h('button', { class: 'key', type: 'button' }, '125 Hz')；子节点可以是字符串或节点 */
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'value' || k === 'checked') node[k] = v;
    else if (k === 'disabled') node.disabled = true;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  node.append(...children.flat(Infinity).filter((c) => c != null));
  return node;
}

/** 去掉 Tauri / IPC 的包装前缀，只显示真正的原因 */
function errMsg(e) {
  return String(e && e.message ? e.message : e)
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '');
}

// ── 动效小工具 ─────────────────────────────────────────────
// 原则见 design/README.md「动效」：按键有行程、灯有亮灭、读数不变；换页先出后进；
// 列表先消失再补位；进出成对。
// 时长和缓动只在 style.css 开头的令牌里定义一次；用 Web Animations API 的几处
// （换页、补位）引用不到 CSS 变量，启动时读一份。
const rootStyle = getComputedStyle(document.documentElement);
const cssVar = (name) => rootStyle.getPropertyValue(name).trim();
const T = Object.fromEntries(['press', 'fast', 'exit', 'base', 'settle'].map((k) => [k, parseFloat(cssVar(`--t-${k}`))]));
const EASE = { out: cssVar('--ease-out'), in: cssVar('--ease-in') };
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 重新播放元素上的一个 CSS 动画类（class → animation） */
function replay(node, cls) {
  if (!node || reducedMotion()) return;
  node.classList.remove(cls);
  void node.offsetWidth; // 强制重排，否则连续两次同样的类变化不会重新播放
  node.classList.add(cls);
}

/** 读数类文字：内容变了就更新并短促亮一下；数字本身不滚动 */
function putText(node, text) {
  const next = String(text);
  if (node.textContent === next) return;
  node.textContent = next;
  replay(node, 'value-flash');
}

const active = new WeakMap(); // 正在播显隐动画的元素 → { anims, exiting }

/**
 * 显隐成对：隐藏不是瞬间消失，而是先快速退场，走完再 display:none；退场途中又要显示，
 * 就从当前看到的样子进场。状态在调用的一瞬间就改，不等动画。
 * collapse：连宽度一起收（标题栏的型号、电量这类——右边的东西是固定的，瞬间显隐会让
 * 左边的状态文字横向跳一下）。先淡出、宽度随后收完——文字是看不见之后才被裁掉的；
 * 收起时顺带抵消它在弹性布局里占的那一格间距。
 * afterHide：藏好之后的事——比如清掉里面过时的文字，免得藏着的元素里留着一个不再成立的状态。
 */
function toggleShown(node, visible, { collapse = false, afterHide = null } = {}) {
  const wasShown = !node.classList.contains('hidden');
  const running = active.get(node);
  if (visible === wasShown && !(visible && running?.exiting)) return;
  const st = getComputedStyle(node); // 现在看到的样子（退到一半时是中途值）
  for (const a of running?.anims || []) a.cancel();
  active.delete(node);
  if (reducedMotion()) {
    node.classList.toggle('hidden', !visible);
    if (!visible) afterHide?.();
    return;
  }
  node.classList.remove('hidden');
  const from = wasShown ? st.opacity : 0; // 藏着的元素读不到真正的透明度，按 0 算
  const out = { duration: visible ? T.base : T.exit, easing: visible ? EASE.out : EASE.in, fill: visible ? 'none' : 'forwards' };

  if (!collapse) {
    const fade = node.animate([{ opacity: from }, { opacity: visible ? 1 : 0 }], out);
    if (visible) {
      active.set(node, { anims: [fade], exiting: false });
      return;
    }
    const done = () => {
      fade.cancel();
      active.delete(node);
      node.classList.add('hidden');
      afterHide?.();
    };
    fade.onfinish = () => {
      if (active.get(node)?.anims[0] === fade) done();
    };
    active.set(node, { anims: [fade], exiting: true });
    return;
  }

  const width = node.getBoundingClientRect().width; // 没有动画时的宽度
  const n = getComputedStyle(node); // 没有动画时的样子
  const gap = parseFloat(getComputedStyle(node.parentElement).columnGap) || 0;
  const natural = { maxWidth: `${width}px`, marginRight: '0px', paddingLeft: n.paddingLeft, paddingRight: n.paddingRight };
  const closed = { maxWidth: '0px', marginRight: `${-gap}px`, paddingLeft: '0px', paddingRight: '0px' };
  // 原本藏着的从收起的状态出发；已经显示着的（可能在退场途中）从它现在的样子出发
  const cur = wasShown
    ? {
      maxWidth: `${st.maxWidth === 'none' ? width : parseFloat(st.maxWidth)}px`,
      marginRight: st.marginRight,
      paddingLeft: st.paddingLeft,
      paddingRight: st.paddingRight,
    }
    : closed;
  node.style.overflow = 'hidden';
  // anims[0] 是最长的那段：它走完才算完
  const anims = visible
    ? [
      node.animate([cur, natural], { duration: T.base, easing: EASE.out }),
      node.animate([{ opacity: from }, { opacity: 1 }], { duration: T.fast, easing: EASE.out }),
    ]
    : [
      node.animate([cur, closed], out),
      node.animate([{ opacity: from }, { opacity: 0 }], { duration: T.press, easing: EASE.in, fill: 'forwards' }),
    ];
  active.set(node, { anims, exiting: !visible });
  anims[0].onfinish = () => {
    if (active.get(node)?.anims !== anims) return; // 期间又变了，交给新的那段收尾
    for (const a of anims) a.cancel();
    active.delete(node);
    node.style.overflow = '';
    if (!visible) {
      node.classList.add('hidden');
      afterHide?.();
    }
  };
}

/**
 * 按键组的原地更新：标签没变就复用原来的按钮，只改状态类。
 * 灯的亮灭、启用 / 禁用都靠 CSS 过渡表达——重建元素的话这些过渡就没了，
 * 点击回执也会在重绘的那一瞬间被抹掉。
 * defs: [{ label, lit, off, disabled, title, ui, cls, onClick }]
 */
function syncKeys(container, defs) {
  defs.forEach((d, i) => {
    let k = container.children[i];
    const reusable = k && k.dataset.label === d.label && k.classList.contains('ui') === !!d.ui;
    if (!reusable) {
      const fresh = h('button', { type: 'button' });
      fresh.addEventListener('click', () => fresh.onClick());
      if (k) k.replaceWith(fresh);
      else container.appendChild(fresh);
      k = fresh;
    }
    const flash = k.classList.contains('flash'); // 别把正在播的点击回执抹掉
    k.className = `key${d.ui ? ' ui' : ''}${d.lit ? ' lit' : ''}${d.off ? ' is-off' : ''}` +
      `${d.cls ? ` ${d.cls}` : ''}${flash ? ' flash' : ''}`;
    k.dataset.label = d.label;
    k.textContent = d.label;
    k.disabled = !!d.disabled;
    if (d.title) k.title = d.title;
    else k.removeAttribute('title');
    for (const [a, v] of Object.entries(d.attrs || {})) k.setAttribute(a, v);
    k.onClick = d.onClick;
  });
  [...container.children].slice(defs.length).forEach((extra) => extra.remove());
}

/** 列表重排之后：还在的行从原来的位置滑到现在的位置。oldTop(新序号) 返回它重排前的 top，新行返回 undefined */
function flipRows(list, oldTop) {
  if (reducedMotion()) return;
  [...list.children].forEach((el, i) => {
    const prev = oldTop(i);
    if (prev == null) return; // 新出现的行：由 .enter 的进场动画负责
    const dy = prev - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) return;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: T.settle, easing: EASE.out });
  });
}

const rowTops = (list) => [...list.children].map((el) => el.getBoundingClientRect().top);

/**
 * 列表的高度变了（增删了一行）：让高度从原来的过渡到现在的，下面的内容和卡片底边跟着一起走，
 * 而不是瞬间跳到位。clip = 动画期间裁掉溢出的部分（新增时新行是从列表里「展开」出来的）。
 */
function resizeList(list, oldHeight, clip = false) {
  if (reducedMotion() || list.offsetHeight === oldHeight) return;
  if (clip) list.style.overflow = 'hidden';
  const anim = list.animate(
    [{ height: `${oldHeight}px` }, { height: `${list.offsetHeight}px` }],
    { duration: clip ? T.base : T.settle, easing: EASE.out }
  );
  anim.onfinish = () => {
    if (clip) list.style.overflow = '';
  };
}

/**
 * 从列表里删掉一行：这一行留一个不占布局的残影原地淡出（画在行的下面，补位的行上来时会把它盖掉），
 * 其余行同时滑上来补位，列表的高度收到新的高度。
 * 状态在调用的一瞬间就改（mutate），不等动画——动画期间界面显示的依然是对的。
 */
function removeRow(row, mutate) {
  const list = row.parentElement;
  const k = [...list.children].indexOf(row);
  const tops = rowTops(list);
  const height = row.offsetHeight;
  const oldHeight = list.offsetHeight;
  mutate();
  if (reducedMotion() || k < 0) return;
  const ghost = row.cloneNode(true);
  ghost.classList.add('ghost');
  ghost.style.top = `${tops[k] - list.getBoundingClientRect().top}px`;
  ghost.style.height = `${height}px`;
  list.appendChild(ghost);
  resizeList(list, oldHeight);
  flipRows(list, (i) => tops[i < k ? i : i + 1]);
  ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: T.fast, easing: EASE.in, fill: 'forwards' })
    .onfinish = () => ghost.remove();
}

/**
 * 档位颜色：固定为官方默认六色（红/蓝/绿/黄/青/品红），界面与 .ict 存档都用这套，
 * 不给用户改的入口。鼠标指示灯的颜色由固件按「回报率 / 电量」决定（官方手册 §5.4），
 * 命令 2 的 buf[4..6] 虽然能写能回读，但固件只存不用 —— 开放改色只会误导。
 */
const DPI_LEVEL_COLORS = ['#ff0000', '#0000ff', '#00ff00', '#ffff00', '#00ffff', '#ff00ff'];
const dpiColorAt = (i) => DPI_LEVEL_COLORS[i % DPI_LEVEL_COLORS.length];

// ── i18n / 菜单 / 设置 ─────────────────────────────────────
/** 应用 i18n：替换所有带 data-i18n（文字）/ data-i18n-title（悬停提示）的静态文案 */
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((node) => {
    node.title = t(node.dataset.i18nTitle);
  });
  const lang = window.i18n.getLang();
  document.querySelectorAll('.lang-option').forEach((opt) => {
    opt.classList.toggle('active', opt.dataset.lang === lang);
  });
}

// ── 弹出菜单：进出成对。打开立刻播进场；收起先播退场，播完才真正隐藏 ──
const menuOpen = (menu) => menu && !menu.classList.contains('hidden') && !menu.classList.contains('closing');

function openMenu(menu) {
  clearTimeout(menu._closeTimer);
  menu.classList.remove('hidden', 'closing');
}

function closeMenu(menu) {
  if (!menuOpen(menu)) return;
  if (reducedMotion()) {
    menu.classList.add('hidden');
    return;
  }
  menu.classList.add('closing');
  clearTimeout(menu._closeTimer);
  menu._closeTimer = setTimeout(() => {
    if (menu.classList.contains('closing')) menu.classList.add('hidden');
  }, 110);
}

function toggleLangMenu() {
  const opening = !menuOpen($('#langMenu'));
  if (opening) closeMenu($('#settingsMenu'));
  if (opening) openMenu($('#langMenu'));
  else closeMenu($('#langMenu'));
}

function toggleSettingsMenu() {
  const opening = !menuOpen($('#settingsMenu'));
  if (opening) closeMenu($('#langMenu'));
  if (opening) openMenu($('#settingsMenu'));
  else closeMenu($('#settingsMenu'));
}

/**
 * 保存一项设置（开机自启 / 静默启动 / 界面缩放）。开关自己翻过去就是反馈，不另弹提示；
 * 存不进去才在这一行下面标出来，并把控件退回到实际保存着的值（revert）
 */
async function saveSetting(input, patch, revert) {
  clearSettingError(input);
  try {
    await window.api.setSettings(patch);
  } catch (_) {
    revert();
    showSettingError(input, t('settingSaveFailed'));
  }
  syncSilentAvailability();
}

/** 这一行设置的说明文字换成错误信息（红字），直到下一次保存 */
function showSettingError(input, message) {
  const desc = input.closest('.settings-item')?.querySelector('.settings-desc');
  if (!desc) return;
  desc.textContent = message;
  desc.classList.add('bad');
}

function clearSettingError(input) {
  const desc = input.closest('.settings-item')?.querySelector('.settings-desc');
  if (!desc || !desc.classList.contains('bad')) return;
  desc.textContent = t(desc.dataset.i18n);
  desc.classList.remove('bad');
}

/** 静默启动只在开机自启开启时才有意义，未开自启时置灰 */
function syncSilentAvailability() {
  const auto = $('#setAutoLaunch').checked;
  $('#setSilentStart').disabled = !auto;
  $('#setSilentItem').classList.toggle('is-off', !auto);
}

/** 界面缩放：'auto' 按屏幕可用尺寸推算，否则用固定倍率 */
function resolveUiScale(pref) {
  if (pref && pref !== 'auto') {
    const n = parseFloat(pref);
    if (isFinite(n) && n >= 0.85 && n <= 2) return n;
  }
  const w = window.screen.availWidth || 1920;
  const hgt = window.screen.availHeight || 1080;
  const raw = Math.max(w / 1920, hgt / 1080);
  // 1.00–1.30，按 0.05 台阶取整
  return Math.min(1.3, Math.max(1, Math.round(raw * 20) / 20));
}

let uiScale = 1; // 当前生效的界面缩放倍率
let uiScalePref = 'auto'; // 设置里的缩放偏好：auto / 1 / 1.1 / 1.25 / 1.5

function applyUiScale(pref) {
  uiScalePref = pref; // 设置里保存着的缩放偏好（auto / 1 / 1.1 / …）
  uiScale = resolveUiScale(pref);
  document.documentElement.style.setProperty('--ui-scale', String(uiScale));
  syncCompactLayout();
}

/**
 * 宏页左右两栏需要的宽度 = 左栏（随字号缩放）+ 间距 + 动作列表（列宽是固定的）。
 * 内容区不够宽（窗口窄，或界面放大）就改成上下排，见 style.css 的 .compact-main。
 */
function syncCompactLayout() {
  const main = $('.main');
  if (!main) return;
  const pad = parseFloat(getComputedStyle(main).paddingLeft) + parseFloat(getComputedStyle(main).paddingRight);
  const need = 20.6 * 12.5 * uiScale + 12 + 316;
  document.body.classList.toggle('compact-main', main.clientWidth - pad < need);
}

/** 读取设置并回填开关 */
async function loadSettings() {
  try {
    const s = await window.api.getSettings();
    $('#setAutoLaunch').checked = !!s.autoLaunch;
    $('#setSilentStart').checked = !!s.silentStart;
    // 主题：页面开头先照上次的镜像摆过一次，这里按真正的设置再对一遍
    $('#setLightTheme').checked = applyTheme(document.documentElement, localStorage, s.theme) === 'light';
    const sel = $('#setUiScale');
    const allowed = ['auto', '1', '1.1', '1.25', '1.5'];
    sel.value = allowed.includes(s.uiScale) ? s.uiScale : 'auto';
    applyUiScale(sel.value);
    syncSilentAvailability();
  } catch (_) {
    /* 读设置失败静默 */
  }
}

/** 选择语言：全文瞬间换掉太生硬，整窗快速亮一下表示「换过了」 */
function selectLang(lang) {
  closeMenu($('#langMenu'));
  $('#langBtn').focus();
  if (lang === window.i18n.getLang()) return;
  window.i18n.setLang(lang);
  applyI18n();
  renderAll(); // 重新渲染动态文案
  replay(document.body, 'lang-switched');
}

// ── 初始化 ────────────────────────────────────────────────
async function init() {
  applyI18n();
  bindEvents();
  loadAppInfo();
  try {
    state.constants = await window.api.getConstants();
    state.maxDpi = state.constants.sensors.PAW3395.maxDpi;
  } catch (e) {
    state.constants = null;
  }
  loadLocalConfig();
  await loadSettings();
  startBatteryAutoRefresh();
  renderAll();
  refreshDeviceState();
  addEventListener('resize', syncCompactLayout);
  autoConnect(); // 进了软件就自己检测鼠标并连上（有线还是无线由桥接层判断）
}

/** 侧栏底部：版本号（兼「关于」入口）+ 仓库链接 */
async function loadAppInfo() {
  let info = null;
  try {
    info = await window.api.getAppInfo();
  } catch (_) {
    /* 忽略 */
  }
  const ver = $('#appVersion');
  ver.textContent = info && info.version ? `v${info.version}` : '';
  ver.addEventListener('click', () => window.api.showAbout());
  const homepage = (info && info.homepage) || 'https://github.com/magnum-qin/incott-mouse-driver';
  $('#repoLink').addEventListener('click', () => window.api.openExternal(homepage));
}

/** 自绘标题栏：最大化状态与按钮图标同步 */
function applyMaximized(max) {
  document.body.classList.toggle('maximized', !!max);
  const icon = $('#winMaxIcon');
  if (icon) {
    icon.innerHTML = max
      ? '<rect x="3.4" y="4.6" width="4.6" height="4.6" rx="1"/><path d="M5.4 4.6V3.4h3.2v3.2"/>'
      : '<rect x="3" y="3" width="6" height="6" rx="1"/>';
  }
  const btn = $('#winMax');
  btn.title = max ? '还原' : '最大化';
  btn.setAttribute('aria-label', btn.title);
}

// ── 换页 ───────────────────────────────────────────────────
/**
 * 换页 = 换屏：旧页先退出，退完新页再进入（先出后进，两页不重叠）。
 * 时序走 Web Animations API 而不是「CSS 类 + 定时器」，为的是中途再点别处时接得上：
 *  - 退出途中改目标：退出按原来的节奏走完，退完进的是最新的目标（不重新计时）
 *  - 退出途中点回当前页：从当前看到的样子原路返回
 *  - 进入途中再点别处：从当前看到的样子（可能只显了一半）开始退出，不会先跳成完整的一页
 */
let pageAnim = null; // 正在播放的换页动画
let pagePhase = ''; // 'exit' | 'enter'：pageAnim 在退还是在进；'' 表示稳态或「原路返回」中

/** 动画播完且没被后来者取代时收尾（被取代说明用户又点了别处，交给新的那段负责） */
function whenDone(anim, finish) {
  anim.finished.then(() => {
    if (pageAnim === anim) finish();
  }, () => {});
}

/** 从元素当前看到的样子播放到 to（被上一段动画打断时不会跳回起点） */
function playFrom(el, to, options) {
  const st = getComputedStyle(el);
  const dx = st.transform === 'none' ? 0 : new DOMMatrixReadOnly(st.transform).m41;
  const from = { opacity: st.opacity, transform: `translateX(${dx}px)` };
  pageAnim?.cancel();
  pageAnim = el.animate([from, to], { fill: 'forwards', ...options });
  return pageAnim;
}

const menuTarget = () => document.querySelector('.menu [data-page].active')?.dataset.page;

/** 切到某一页：next 显示、其余隐藏；animate 时新页从右侧进来 */
function showPage(next, animate) {
  const cur = document.querySelector('.page.active');
  pageAnim?.cancel(); // 退到一半的那一页：撤掉它的动画再隐藏
  pageAnim = null;
  pagePhase = '';
  if (cur && cur !== next) cur.classList.remove('active');
  next.classList.add('active');
  $('.main').scrollTop = 0; // 内容区是共用的滚动容器，换页要回到顶部
  if (!animate || reducedMotion()) return;
  pagePhase = 'enter';
  const anim = next.animate(
    [{ opacity: 0, transform: 'translateX(8px)' }, { opacity: 1, transform: 'translateX(0)' }],
    { duration: T.base, easing: EASE.out }
  );
  pageAnim = anim;
  whenDone(anim, () => {
    anim.cancel();
    pageAnim = null;
    pagePhase = '';
  });
}

function switchPage(name) {
  const next = document.querySelector(`.page[data-page="${name}"]`);
  const cur = document.querySelector('.page.active');
  if (!next) return;
  document.querySelectorAll('.menu [data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  if (next === cur) {
    if (pagePhase === 'exit') { // 退出途中点回了这一页：原路返回
      pagePhase = '';
      whenDone(playFrom(cur, { opacity: 1, transform: 'translateX(0)' }, { duration: T.base, easing: EASE.out }),
        () => {
          pageAnim.cancel();
          pageAnim = null;
        });
    }
    return;
  }
  if (!cur || reducedMotion()) {
    showPage(next, false);
    return;
  }
  if (pagePhase === 'exit') return; // 正在退出：不动它的节奏，退完进的是菜单上最新的目标
  pagePhase = 'exit';
  whenDone(
    playFrom(cur, { opacity: 0, transform: 'translateX(-6px)' }, { duration: T.exit, easing: EASE.in }),
    () => showPage(document.querySelector(`.page[data-page="${menuTarget()}"]`), true)
  );
}

function bindEvents() {
  // 自绘窗口按钮
  $('#winMin').addEventListener('click', () => window.api.minimizeWindow());
  $('#winMax').addEventListener('click', () => window.api.toggleMaximizeWindow());
  $('#winClose').addEventListener('click', () => window.api.closeWindow());
  if (window.api.onMaximizedChange) window.api.onMaximizedChange(applyMaximized);
  window.api.isMaximized().then(applyMaximized);

  // 导航
  document.querySelectorAll('.menu [data-page]').forEach((btn) => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });

  // 语言 / 设置菜单
  $('#langBtn').addEventListener('click', toggleLangMenu);
  document.querySelectorAll('.lang-option').forEach((opt) => {
    opt.addEventListener('click', () => selectLang(opt.dataset.lang));
  });
  $('#settingsBtn').addEventListener('click', toggleSettingsMenu);
  $('#setAutoLaunch').addEventListener('change', (e) =>
    saveSetting(e.target, { autoLaunch: e.target.checked }, () => { e.target.checked = !e.target.checked; }));
  $('#setSilentStart').addEventListener('change', (e) =>
    saveSetting(e.target, { silentStart: e.target.checked }, () => { e.target.checked = !e.target.checked; }));
  // 亮色主题：立即换过来并存下；存不回去就换回原样
  $('#setLightTheme').addEventListener('change', (e) => {
    const set = (light) => {
      e.target.checked = light;
      applyTheme(document.documentElement, localStorage, light ? 'light' : 'dark');
    };
    set(e.target.checked);
    replay(document.body, 'theme-switched'); // 和切换语言一样：整窗快速亮一下，表示换过了
    saveSetting(e.target, { theme: e.target.checked ? 'light' : 'dark' }, () => set(!e.target.checked));
  });
  // 界面缩放：立即生效并落盘；存不回去就缩回原样
  $('#setUiScale').addEventListener('change', (e) => {
    const before = uiScalePref;
    applyUiScale(e.target.value);
    saveSetting(e.target, { uiScale: e.target.value }, () => { e.target.value = before; applyUiScale(before); });
  });
  // 点击别处收起菜单
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.lang-wrap')) closeMenu($('#langMenu'));
    if (!e.target.closest('.settings-wrap')) closeMenu($('#settingsMenu'));
    if (!e.target.closest('#resetBtn')) disarmReset(); // 「恢复默认」等确认的时候点了别处：取消
  });
  // Esc 关闭菜单并归还焦点
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    disarmReset();
    if (menuOpen($('#langMenu'))) {
      closeMenu($('#langMenu'));
      $('#langBtn').focus();
    } else if (menuOpen($('#settingsMenu'))) {
      closeMenu($('#settingsMenu'));
      $('#settingsBtn').focus();
    }
  });
  // 焦点移出菜单区就收起（Tab 走出菜单时不会留一个悬空的弹层）。
  // 但「焦点去了 body」不一定是你离开了菜单：开关藏在 label 里，点到的拨杆和文字都不能获得焦点，
  // 浏览器会把焦点从上一个开关挪到 body 上。所以先记下这一下按在哪里——按在同一个菜单区里的不算离开。
  // （以前没分这一步：点完一个开关再点别的，菜单就收起了，那一下点击还落在正在退场的菜单外面，等于白点）
  let pressedIn = null; // 最近一次按下鼠标时所在的菜单区（.lang-wrap / .settings-wrap），按在别处是 null
  document.addEventListener('pointerdown', (e) => {
    pressedIn = e.target instanceof Element ? e.target.closest('.lang-wrap, .settings-wrap') : null;
  }, true);
  document.addEventListener('focusout', (e) => {
    const to = e.relatedTarget;
    const pressed = pressedIn; // 只管紧跟着这次按下的那一次焦点变化
    pressedIn = null;
    [['#langMenu', '.lang-wrap'], ['#settingsMenu', '.settings-wrap']].forEach(([menuSel, wrapSel]) => {
      const menu = $(menuSel);
      if (!menuOpen(menu) || !e.target.closest(menuSel)) return;
      // 焦点还在菜单区里，或者只是按在了菜单区里不能获得焦点的地方：都不收
      const stays = to instanceof Element ? !!to.closest(wrapSel) : !!pressed && pressed.matches(wrapSel);
      if (!stays) closeMenu(menu);
    });
  });
  if (window.i18n.onLangChanged) {
    window.i18n.onLangChanged(() => {
      applyI18n();
      renderAll();
    });
  }

  // 点击回执：按下的「行程」由 :active 负责，这里管松开之后——被点的那一下键面（外壳）短促地亮一下，
  // 里面的文字和图标不动。挂在 document 上统一处理，所以只点一下就重绘的按键组（走 syncKeys 原地更新）也能看到。
  // 版本号那种纯文字的可点元素不在列：它没有外壳，闪就只剩文字在闪。
  const PRESSABLE = '.key, .cta, .menu button, .stage .x, .item .x';
  document.addEventListener('click', (e) => {
    const el = e.target.closest(PRESSABLE);
    if (!el || el.disabled) return;
    replay(el, 'flash');
  });
  document.addEventListener('animationend', (e) => {
    if (e.animationName === 'overlay-flash') e.target.classList.remove('flash');
    if (e.animationName === 'key-flash') e.target.classList.remove('flash', 'ignite');
    // 「当前档」标记亮完就把 current-in 摘掉（白条的事件派发在行上，序号键的在 .idx 上）
    if (e.animationName === 'fade-in' && (e.pseudoElement === '::before' || e.target.classList?.contains('idx'))) {
      e.target.closest('.current-in')?.classList.remove('current-in');
    }
  });

  // 连接 / 电量
  $('#connectBtn').addEventListener('click', onConnect);
  $('#battery').addEventListener('click', onBatteryClick);
  window.api.onBattery(({ level, charging }) => {
    state.battery = level;
    state.batteryCharging = charging;
    state.batteryRemembered = false; // 鼠标报了：这是当下的
    renderTitle();
  });
  // 断开：标题栏那句话变红、灯灭，就是提示（不再弹通知条）
  window.api.onDisconnected(() => {
    if (!state.connected) return;
    resetDevice();
    setDeviceLabel(t('deviceDisconnected'), true);
  });
  // 鼠标主动上报的状态变化（DPI 键切换档位等）：没有待应用的修改时，界面跟着鼠标走
  if (window.api.onStatus) {
    window.api.onStatus(onDeviceStatus);
  }
  // 没连上的时候设备出现了（比如接收器插回来）：自动连。用户点过「断开」的话桥接层不会发这个信号
  if (window.api.onDeviceArrived) {
    window.api.onDeviceArrived(() => autoConnect());
  }
  // 鼠标在接收器和线缆之间移动：桥接层已经把连接换好，界面跟着换型号信息和连接方式
  if (window.api.onDeviceChanged) {
    window.api.onDeviceChanged(async ({ reason, state: st }) => {
      if (!state.connected || !st.opened) return;
      state.isWireless = st.isWireless;
      applyModelInfo(st.modelInfo, false);
      await refreshBattery(); // 新连接上的电量（有线时读命令就带电量）
      renderAll(); // 标题栏的「有线 / 8K」和读数屏自己会变，不再弹通知条
    });
  }

  // DPI 页
  $('#xySplit').addEventListener('change', (e) => {
    state.xySplit = e.target.checked;
    if (state.xySplit) {
      // 开启 XY 轴单独调节时，Y 轴先同步成 X 轴的当前值，避免残留不一致
      state.dpiLevels.forEach((lv) => {
        lv.y = lv.x;
      });
    }
    // 行不重建：Y 轴平时就收在每一行里，这里只换 .split，行高、序号键、下面的行由 CSS 连续带着走。
    // （以前是整表重建再让行滑回去：行是新元素，里面的序号键只能直接跳到新的位置上）
    document.querySelectorAll('#dpiList .stage').forEach((row, i) => {
      setSplit(row, state.xySplit);
      row.setLaneY(state.dpiLevels[i].y, true); // 刚展开的那条轴里可能还是上次收起时的旧值：让推子帽滑到 X 的位置上
    });
    scheduleSave();
  });
  $('#addDpiBtn').addEventListener('click', onAddDpi);

  // 性能参数
  ['#motionSync', '#angleSnap', '#ripple'].forEach((sel) => {
    $(sel).addEventListener('change', (e) => {
      state[sel.slice(1)] = e.target.checked;
      markDirty();
    });
  });
  $('#debounce').addEventListener('change', (e) => {
    state.debounce = clamp(parseInt(e.target.value, 10) || 0, 0, 30);
    e.target.value = state.debounce;
    markDirty();
  });
  $('#debounceDown').addEventListener('click', () => stepDebounce(-1));
  $('#debounceUp').addEventListener('click', () => stepDebounce(1));
  // 节能调节：官方是 ± 逐档切换固定档位（10..900s）
  $('#sleepDown').addEventListener('click', () => stepSleep(-1));
  $('#sleepUp').addEventListener('click', () => stepSleep(1));

  // 底栏：配置 / 导入导出 / 应用
  $('#importBtn').addEventListener('click', onImportProfile);
  $('#exportBtn').addEventListener('click', onExportProfile);
  $('#applyBtn').addEventListener('click', onApply);
  $('#resetBtn').addEventListener('click', onResetProfile);
  // 鼠标上的配置切换键：硬件只改序号，界面把对应预设立即整套灌入
  if (window.api.onProfile) {
    window.api.onProfile((idx) => {
      if (!state.connected || state.switching) return;
      // 自己写入后设备也会回显序号，2 位字段还会把第 5 个配置回显成 0，2.5s 内一律忽略
      if (Date.now() - lastWriteAt < 2500) return;
      if (idx === state.profile) return;
      switchProfile(idx);
      applyCurrentProfile();
    });
  }

  // 宏编辑器
  $('#macroLoopType').addEventListener('change', (e) => {
    state.macros[state.currentMacro].loopType = parseInt(e.target.value, 10);
    renderMacro();
  });
  $('#macroCycle').addEventListener('change', (e) => {
    const m = state.macros[state.currentMacro];
    m.cycle = Math.max(1, parseInt(e.target.value, 10) || 1);
    e.target.value = m.cycle;
  });
  document.querySelectorAll('#macroPressSeg .key').forEach((btn) => {
    btn.addEventListener('click', () => setMacroPress(btn.dataset.press === '1'));
  });
  $('#macroDelayDown').addEventListener('click', () => stepMacroDelay(-10));
  $('#macroDelayUp').addEventListener('click', () => stepMacroDelay(10));
  $('#macroAddBtn').addEventListener('click', onMacroAddItem);
  $('#macroImportBtn').addEventListener('click', onMacroImport);
  $('#macroExportBtn').addEventListener('click', onMacroExport);
  $('#macroUploadBtn').addEventListener('click', onMacroUpload);
}

// ── 连接 ──────────────────────────────────────────────────
let connecting = false; // 连接流程进行中：启动时的自动连接和「设备出现了」可能前后脚到，只走一遍
let configPending = false; // 连上了但设备没应答（休眠中）：它一上报就补读一遍配置

async function onConnect() {
  if (state.connected) {
    await window.api.closeDevice();
    resetDevice();
    setDeviceLabel(t('notConnected'));
    return;
  }
  if (connecting) return;
  connecting = true;
  try {
    await connectFlow();
  } finally {
    connecting = false;
  }
}

/**
 * 自动连接：刚进软件时，以及还没连上的时候设备出现了（比如接收器插回来）。
 * 和点「连接鼠标」走同一条流程；没有鼠标就安静地停在「未连接设备」，不报错。
 * 用户点过「断开」之后桥接层不会再发「设备出现了」，所以不会违背他的意思又连回去
 */
async function autoConnect() {
  if (state.connected || connecting) return;
  let list;
  try {
    list = await window.api.listDevices();
  } catch (_) {
    return; // 枚举失败：等下一次设备变化
  }
  if (list.length === 0) return;
  await onConnect();
}

/** 连接流程本体：转圈 → 搜索 → 连接 → 读配置 → 以此为基线（没有未应用的修改） */
async function connectFlow() {
  showSpinner();
  setDeviceLabel(t('searching'));
  try {
    const list = await window.api.listDevices();
    if (list.length === 0) {
      hideSpinner();
      setDeviceLabel(t('deviceNotFound'), true);
      return;
    }
    setDeviceLabel(t('connecting'));
    // 不传 path：让桥接层自动选可通信的 Col02 接口（插线时存在 Col01/Col02 两个接口）；
    // 有线和接收器都在时也是它挑——枚举靠后的先试，于是连到有线
    const st = await window.api.openDevice();
    state.connected = st.opened;
    state.isWireless = st.isWireless;
    applyModelInfo(st.modelInfo);
    setDeviceLabel(t('readingConfig'));
    renderAll();

    // 一次性读回整套配置（配置序号 / DPI 档位 / 回报率 / LOD / 按键 / 节能时间）
    let snap = null;
    try {
      snap = await window.api.readConfig();
      applyDeviceSnapshot(snap);
    } catch (e) {
      // 老固件不支持整套读取时退回逐条读（DPI 档位数）
      try {
        const dpi = await window.api.read('dpiLevel');
        if (dpi && dpi.levels > 0) syncDpiLevels(dpi.levels, dpi.current);
      } catch (_) {
        /* 读档位失败不阻塞连接 */
      }
    }
    // 设备没应答（多半是无线鼠标在休眠，一进软件就自动连时会碰到）：读回来的是空快照，
    // 界面此刻显示的是本地保存的值。等它第一次上报（说明醒了）再补读，见 onDeviceStatus
    configPending = !(snap && snap.answered);
    // 界面此刻与鼠标对齐：以此为基线，没有未应用的修改
    baseline = snapshotOf();
    // 读电量不阻塞连接：G24 Pro + 8K 接收器上这条命令回显正确但电量字节恒为 0（2026-11-23 实测，
    // 见 docs/protocol.md §4），读不到就算了，电量由设备的主动上报送来（onBattery）；
    // 支持这条命令的机型（含有线）则立刻能读到
    refreshBattery();
    setDeviceLabel(t('connected'));
    hideSpinner();
    renderAll();
  } catch (e) {
    hideSpinner();
    setDeviceLabel(t('connectFailed') + errMsg(e), true);
  }
}

/**
 * 应用 0x8F 型号信息：决定 DPI 上限（按传感器）与回报率可选范围（按 8K 接收器）。
 * clampRate：非 8K 时把超范围的回报率落回 1000。连接自动切换（鼠标插线 / 拔线）时传 false——
 * 用户还没应用的修改不能因此被抹掉，鼠标当前的回报率随后由状态推送带过来
 */
function applyModelInfo(info, clampRate = true) {
  state.modelInfo = info || null;
  if (info) setMouseArt(info.modelCode);
  if (info && state.constants) {
    state.maxDpi = info.sensor === state.constants.sensors.PAW3950.id
      ? state.constants.sensors.PAW3950.maxDpi
      : state.constants.sensors.PAW3395.maxDpi;
  } else if (state.isWireless && state.constants) {
    // 读不到型号信息时回退旧行为（无线按 PAW3950 上限）
    state.maxDpi = state.constants.sensors.PAW3950.maxDpi;
  }
  // 非 8K 接收器时高回报率不可选，当前值超限则回落
  if (clampRate && info && !info.is8KReceiver && state.rate > 1000) state.rate = 1000;
}

/** 建 SVG 元素（h() 建的是 HTML 元素，这里要带命名空间） */
function svgEl(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * 读数屏里的线稿换成这个型号的（用户提供的那几张，见 shared/mouse-art.js）：
 * 一条轮廓 + 一颗档位色的小灯 + 底下的影子。用的还是通用那张的类名，颜色、过渡、连上时的亮都跟着样式表走。
 * 型号没有对应的线稿就不动，界面留着原来那张通用的；同一个型号不重画（灯的过渡、换档时亮一下都在这个元素上）
 */
function setMouseArt(modelCode) {
  const art = mouseArtFor(modelCode);
  const box = $('#screenArt');
  if (!art || !box || box.dataset.art === String(modelCode)) return;
  const { led, shadow } = artLayout(art);
  const svg = svgEl('svg', { viewBox: art.viewBox });
  svg.classList.add('art-mouse');
  svg.append(
    svgEl('ellipse', { class: 'mouse-shadow', cx: shadow.cx, cy: shadow.cy, rx: shadow.rx, ry: shadow.ry }),
    svgEl('path', { class: 'mouse-outline', d: art.d }),
    svgEl('circle', { class: 'mouse-led', cx: led.cx, cy: led.cy, r: led.r }),
  );
  box.replaceChildren(svg);
  box.dataset.art = String(modelCode);
}

/** 断开后回到「未连接」：没有基线了，也就没有未应用的修改 */
function resetDevice() {
  state.connected = false;
  state.modelInfo = null;
  state.battery = null;
  state.batteryCharging = false;
  state.batteryRemembered = false;
  baseline = null;
  configPending = false;
  renderAll();
}

async function refreshDeviceState() {
  try {
    const st = await window.api.getState();
    if (st.opened) {
      state.connected = true;
      state.isWireless = st.isWireless;
      applyModelInfo(st.modelInfo);
      renderTitle();
    }
  } catch (_) {
    /* 未连接 */
  }
}

const TITLE_BAR = { collapse: true }; // 标题栏里的东西：显隐连宽度一起走，左边的状态文字才不会横跳

function showSpinner() {
  toggleShown($('#deviceSpinner'), true, TITLE_BAR);
  $('#connectBtn').disabled = true;
}

function hideSpinner() {
  toggleShown($('#deviceSpinner'), false, TITLE_BAR);
  $('#connectBtn').disabled = false;
}

function setDeviceLabel(text, isErr = false) {
  const label = $('#deviceLabel');
  putText(label, text);
  label.title = text;
  $('#deviceLink').classList.toggle('bad', isErr);
}

/**
 * 鼠标主动上报的状态变化（按了 DPI 键等）。
 * 只在「设备上的值确实变了」时跟进；用户改了还没应用的值不被顶掉。
 */
function onDeviceStatus(s) {
  if (!state.connected || !baseline) return;
  if (configPending) {
    // 连上时设备没应答（休眠中），现在它上报了、说明醒了：补读一遍配置，界面以鼠标为准。
    // 用户这期间改过东西的话就不去动他改的
    configPending = false;
    if (pendingCount() === 0 && !applying) syncFromDevice();
    return;
  }
  let changed = false;
  if (s.rate != null && s.rate !== baseline.rate) {
    const hadEdit = state.rate !== baseline.rate;
    baseline.rate = s.rate;
    if (!hadEdit) state.rate = s.rate;
    changed = true;
  }
  if (s.dpiIndex != null && s.dpiIndex < baseline.dpiValues.length && s.dpiIndex !== baseline.currentDpi) {
    const hadEdit = state.currentDpi !== baseline.currentDpi;
    baseline.currentDpi = s.dpiIndex;
    if (!hadEdit) state.currentDpi = s.dpiIndex;
    changed = true;
  }
  if (changed) renderAll();
}

/**
 * 设备醒着的时候重新读一遍配置，界面以鼠标为准（只在用户没有未应用的修改时才会被调用）。
 * 读的过程中用户改了东西、或者开始应用了，读回来的就作废——不动他的
 */
async function syncFromDevice() {
  if (!state.connected) return;
  try {
    const snap = await window.api.readConfig();
    if (!state.connected || applying || pendingCount() !== 0) return;
    applyDeviceSnapshot(snap);
    baseline = snapshotOf();
    renderAll();
  } catch (_) {
    /* 读失败：保持现状 */
  }
}

// ── 标题栏 / 读数屏 ───────────────────────────────────────
/** 传感器名（标题栏用） */
const sensorNameOf = (info) => (info.sensor === state.constants.sensors.PAW3950.id ? 'PAW3950' : 'PAW3395');

/**
 * 连接方式标签：8K 接收器 → '8K'，有线 → 「有线」，别的接收器不标。
 * 鼠标插上线充电时，标题栏和读数屏从这里看出连接换了路
 */
function linkTag() {
  const info = state.modelInfo;
  if (!info) return '';
  if (info.is8KReceiver) return '8K';
  return state.isWireless ? '' : t('linkWired');
}

/** 标题栏的连接状态与电量（连接状态文字由连接流程自己写，这里只管灯、型号、电量） */
function renderTitle() {
  const info = state.modelInfo;
  const known = state.connected && !!info && !!state.constants;
  $('#deviceLed').className = `led round ${state.connected ? 'ok' : 'off'}`;
  const model = $('#deviceInfo');
  toggleShown(model, known, TITLE_BAR);
  if (known) {
    putText(model, `${info.name || info.model} · ${sensorNameOf(info)}${linkTag() ? ` · ${linkTag()}` : ''}`);
  }
  $('#connectBtn').textContent = state.connected ? t('disconnect') : t('connect');

  const batt = $('#battery');
  const showBatt = state.connected && state.battery != null;
  toggleShown(batt, showBatt, TITLE_BAR);
  if (showBatt) {
    const lv = state.battery;
    putText($('#batteryVal'), lv);
    batt.classList.toggle('mid', !state.batteryCharging && lv <= 60 && lv > 25);
    batt.classList.toggle('low', !state.batteryCharging && lv <= 25);
    batt.style.setProperty('--lvl', String(clamp(lv, 0, 100) / 100));
    const notes = [];
    if (state.batteryCharging) notes.push(t('chargingTag'));
    if (state.batteryRemembered) notes.push(t('batteryWaiting'));
    batt.title = `${t('batteryLabel')} ${lv}%${notes.length ? ` · ${notes.join(' · ')}` : ''}`;
  }
  renderScreen();
}

/**
 * 读数屏上的一格：值变了才重写，并短促亮一下（数字不滚动）。
 * tone = ok / warn / bad / run（绿字：鼠标正在运行的配置）
 */
function setScreenValue(sel, value, unit, tone = '') {
  const node = $(sel);
  const key = value == null ? '—' : `${value}|${unit || ''}|${tone}`;
  if (node.dataset.v === key) return;
  node.dataset.v = key;
  node.className = `v${value == null ? ' off' : tone ? ` ${tone}` : ''}`;
  node.textContent = value == null ? '—' : String(value);
  if (value != null && unit) node.append(h('small', null, unit));
  replay(node, 'value-flash');
}

/** 读数屏：反映鼠标当前的实际状态（baseline），不是编辑中的值 */
function renderScreen() {
  const on = state.connected && !!baseline;
  $('#screen').classList.toggle('connected', on);
  $('#screenLed').className = `led round ${on ? 'ok' : 'off'}`;
  const info = state.modelInfo;
  putText($('#screenName'), on && info
    ? [info.name || info.model, linkTag()].filter(Boolean).join(' · ')
    : '—');

  const idx = on ? clamp(baseline.currentDpi, 0, baseline.dpiValues.length - 1) : -1;
  const hero = $('#screenDpi');
  putText(hero, idx >= 0 ? String(baseline.dpiValues[idx].x) : '—');
  hero.classList.toggle('off', idx < 0);
  putText($('#screenSub'), idx >= 0 ? t('dpiStageOf', { n: idx + 1, m: baseline.dpiValues.length }) : '\u00a0');
  $('#screenArt').style.setProperty('--sw', idx >= 0 ? dpiColorAt(idx) : 'transparent');

  setScreenValue('#screenRate', on && baseline.rate ? baseline.rate : null, 'Hz');
  if (on && state.battery != null) {
    const tone = state.batteryCharging || state.battery > 60 ? 'ok' : state.battery <= 25 ? 'bad' : 'warn';
    setScreenValue('#screenBattery', state.battery, '%', tone);
  } else {
    setScreenValue('#screenBattery', null);
  }
  setScreenValue('#screenProfile', on ? state.activeProfile + 1 : null, `/ ${profileCount()}`, 'run');
}

// ── 电量 ──────────────────────────────────────────────────
let batteryRefreshTimer = null;

/** 启动电量定时自动刷新（每 60s，仅在连接时读取） */
function startBatteryAutoRefresh() {
  if (batteryRefreshTimer) return;
  batteryRefreshTimer = setInterval(() => {
    if (state.connected) refreshBattery();
  }, 60000);
}

async function refreshBattery() {
  if (!state.connected) return;
  try {
    const val = await window.api.read('battery'); // { level, charging, remembered }
    state.battery = val.level;
    state.batteryCharging = val.charging;
    state.batteryRemembered = !!val.remembered;
    renderTitle();
  } catch (_) {
    /* 读电量失败静默（保留上次值） */
  }
}

/** 点击电量图标：读一次电量。不弹提示——数字就在图标旁边，提示条只会挡住底栏 */
async function onBatteryClick() {
  await refreshBattery();
}

// ── DPI：档位通道条 ───────────────────────────────────────
function onAddDpi() {
  const last = state.dpiLevels[state.dpiLevels.length - 1];
  const v = last ? last.x : 800;
  state.dpiLevels.push({ x: v, y: v, color: '#4da3ff' });
  markDirty();
  renderDpi({ enterRow: state.dpiLevels.length - 1 }); // 新增的那一行淡入
}

function onRemoveDpi(i) {
  if (state.dpiLevels.length <= 1) return;
  const row = $('#dpiList').children[i];
  if (!row) return;
  const wasCurrent = i === state.currentDpi;
  // 这一行留个残影原地淡出，其余行滑上来补位；状态立刻就改，不等动画
  removeRow(row, () => {
    state.dpiLevels.splice(i, 1);
    // 删掉的在当前档前面：当前档跟着往前挪一位，仍然是同一档（序号变了、DPI 没变）。
    // 以前没有这一步，删掉前面任意一档，「当前」都会悄悄跳到下一档上
    if (i < state.currentDpi) state.currentDpi -= 1;
    if (state.currentDpi >= state.dpiLevels.length) state.currentDpi = state.dpiLevels.length - 1;
    markDirty();
    renderDpi({ currentIn: wasCurrent });
  });
}

/**
 * 点档位条 = 把它设为「应用后生效的当前档位」。
 * 原地改类名而不重绘：白条的伸缩、序号键的反色才能走 CSS 过渡（旧档收回去、新档亮起来）。
 */
function setCurrentDpi(i) {
  if (state.currentDpi === i) return;
  state.currentDpi = i;
  markDirty();
  document.querySelectorAll('#dpiList .stage').forEach((row, idx) => {
    const on = idx === i;
    row.classList.toggle('current', on);
    row.setAttribute('aria-pressed', String(on));
  });
  renderScreen();
}

/**
 * @param opts.enterRow 新出现的行序号（淡入）
 * @param opts.currentIn 删掉了当前档：标记亮在接替的那一行上（行是重建的，让它淡入而不是突然出现）
 */
function renderDpi(opts = {}) {
  const list = $('#dpiList');
  const oldHeight = list.offsetHeight;
  list.replaceChildren(...state.dpiLevels.map((lv, i) => stageRow(lv, i, opts)));
  if (opts.enterRow != null) resizeList(list, oldHeight, true); // 新的那一行是从列表里展开出来的
  // 开关跟着状态走。xySplit 不只由这个开关改：载入某份配置、导入配置时也会变，
  // 以前不同步，出现过「开关是关的、每一档却分成 X / Y 两行」
  $('#xySplit').checked = state.xySplit;
  renderScreen();
  scheduleSave();
}

function stageRow(lv, i, opts = {}) {
  const current = i === state.currentDpi;
  const color = dpiColorAt(i);
  // 两条轴都建出来：Y 轴平时收着（.lane2），拨 XY 开关时只是把它展开
  const x = lane('X', i, 'x');
  const y = lane('Y', i, 'y');
  const row = h(
    'div',
    {
      class: `stage${state.xySplit ? ' split' : ''}${current ? ' current' : ''}${current && opts.currentIn ? ' current-in' : ''}` +
        `${opts.enterRow === i ? ' enter' : ''}`,
      tabindex: '0',
      role: 'button',
      'aria-pressed': String(current),
      title: t('dpiSetCurrent'),
    },
    h('span', { class: 'idx', 'aria-hidden': 'true' }, String(i + 1)),
    h('div', { class: 'lanes' }, x.el, h('div', { class: 'lane2', inert: !state.xySplit }, h('div', { class: 'clip' }, y.el))),
    h('span', { class: 'lamp', title: t('dpiColorNote') }),
    h('button', { class: 'x', type: 'button', title: t('removeDpi'), 'aria-label': t('removeDpi') }, '✕'),
  );
  row.setLaneY = y.set;
  row.style.setProperty('--sw', color);
  // 点在输入框 / 推子 / 删除键上不算「选中这一档」
  row.addEventListener('click', (e) => {
    if (e.target.closest('input, button')) return;
    setCurrentDpi(i);
  });
  row.addEventListener('keydown', (e) => {
    if (e.target !== row) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setCurrentDpi(i);
    }
  });
  row.querySelector('.x').addEventListener('click', () => onRemoveDpi(i));
  return row;
}

/** XY 开关拨过之后：把一行从「一条轴」换成「两条轴」（或反过来）。只换类名，元素不重建，过渡才接得上 */
function setSplit(row, on) {
  row.classList.toggle('split', on);
  row.querySelector('.lane2').inert = !on; // 收着的那条轴看不见，也不能被 Tab 键进去
}

/**
 * 一条轴：轴名 + 数值框 + 推子（XY 分离时一档两条）。不分离时轴名由 CSS 收起。
 * 推子看得见的三样（槽、亮段、推子帽）是垫在原生 range 下面的独立元素，位置写在 --p 上（见 style.css 的「推子」）。
 * set(v, glide)：原地换一个值。glide = 让推子帽滑过去（数值框里敲的数、拨 XY 开关时的 Y 轴）；
 * 拖动和方向键走的是 range 自己的 input 事件，必须即时，不带 glide
 */
function lane(label, dpiIndex, axis) {
  const value = state.dpiLevels[dpiIndex][axis];
  const input = h('input', {
    type: 'number', class: 'val', min: 50, max: state.maxDpi, step: 50, title: t('dpiInputHint'),
  });
  input.value = value;
  const slider = h('input', { type: 'range', class: 'fader', min: 50, max: state.maxDpi, step: 50 });
  slider.value = value;
  const wrap = h('span', { class: 'slider' },
    h('span', { class: 'slider-slot', 'aria-hidden': 'true' }),
    h('span', { class: 'slider-fill', 'aria-hidden': 'true' }),
    h('span', { class: 'slider-cap', 'aria-hidden': 'true' }),
    slider);
  const syncPos = () => {
    const p = (Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min));
    wrap.style.setProperty('--p', String(p));
  };
  const set = (v, glide = false) => {
    slider.value = v;
    input.value = v;
    wrap.classList.toggle('gliding', glide);
    syncPos();
  };
  const commit = (v, glide = false) => {
    state.dpiLevels[dpiIndex][axis] = v;
    set(v, glide);
    markDirty();
  };
  input.addEventListener('change', () => {
    let v = parseInt(input.value, 10);
    if (isNaN(v)) v = state.dpiLevels[dpiIndex][axis]; // 非法输入回退原值
    commit(snapDpi(v), true);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur(); // 触发 change
    }
  });
  slider.addEventListener('input', () => commit(snapDpi(parseInt(slider.value, 10))));
  syncPos();
  return {
    el: h('div', { class: 'lane' }, h('span', { class: 'axis' }, label), input, wrap),
    set,
  };
}

function snapDpi(v) {
  return clamp(Math.round(v / 50) * 50, 50, state.maxDpi);
}

/**
 * DPI 下限归一：小于 50（含 0、负数、非数字）一律按 50 处理。
 * 协议最小 DPI 是 50（硬件值 0）：0 会让 dpiToHw 返回 -1，整次 apply 抛 RangeError。
 */
function dpiFloor(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n < 50 ? 50 : n;
}

/** 将 UI 档位数量对齐到鼠标实际档位数（截断或补齐），并同步当前档位 */
function syncDpiLevels(levels, current) {
  const last = state.dpiLevels[state.dpiLevels.length - 1] || { x: 800, y: 800, color: '#4da3ff' };
  while (state.dpiLevels.length < levels) {
    state.dpiLevels.push({ x: last.x, y: last.y, color: dpiColorAt(state.dpiLevels.length) });
  }
  if (state.dpiLevels.length > levels) state.dpiLevels.length = levels;
  if (current >= 0 && current < state.dpiLevels.length) state.currentDpi = current;
}

// ── 性能：参数表 ──────────────────────────────────────────
// 性能模式：官方 UI 顺序 电竞|标准|节能，协议值 3/2/1（0x84 sub5）
const SENSOR_MODES = [
  { value: 3, key: 'modeEsports', descKey: 'modeEsportsDesc' },
  { value: 2, key: 'modeStandard', descKey: 'modeStandardDesc' },
  { value: 1, key: 'modeEco', descKey: 'modeEcoDesc' },
];
const LED_DESC_KEYS = { 0: 'ledRateDesc', 1: 'ledBatteryDesc', 2: 'ledLowDesc' };

const is8K = () => !!(state.modelInfo && state.modelInfo.is8KReceiver);

function renderPerformance() {
  if (!state.constants) return;
  const C = state.constants;
  // 回报率：非 8K 接收器（含有线）只提供 ≤1000Hz（硬件会钳制，实机验证）
  const gateHighRates = !!state.modelInfo && !state.modelInfo.is8KReceiver;
  const rates = (gateHighRates ? C.rateTable.filter((r) => r.hz <= 1000) : C.rateTable)
    .slice()
    .sort((a, b) => a.hz - b.hz);
  // 四个按键组都走 syncKeys 原地更新：选中的灯从旧键灭掉、在新键亮起来
  syncKeys($('#rateList'), rates.map((r) => ({
    label: `${r.hz} Hz`,
    lit: r.hz === state.rate,
    onClick: () => {
      state.rate = r.hz;
      markDirty();
      renderPerformance();
    },
  })));

  syncKeys($('#lodList'), C.lodTable.map((v, i) => ({
    label: `${v} mm`,
    lit: i === state.lod,
    onClick: () => {
      state.lod = i;
      markDirty();
      renderPerformance();
    },
  })));

  // 官方：8K/2000Hz+ 已是最佳性能，不能开电竞
  const esportsBlocked = state.rate > 1000;
  syncKeys($('#modeList'), SENSOR_MODES.map((m) => {
    const off = m.value === 3 && esportsBlocked;
    return {
      label: t(m.key),
      ui: true, // 中文标签用界面字体
      lit: m.value === state.sensorMode,
      off,
      disabled: off,
      title: off ? t('mode8kNote') : t(m.descKey),
      onClick: () => {
        if (off) return;
        state.sensorMode = m.value;
        markDirty();
        renderPerformance();
      },
    };
  }));

  $('#motionSync').checked = state.motionSync;
  $('#angleSnap').checked = state.angleSnap;
  $('#ripple').checked = state.ripple;
  $('#debounce').value = state.debounce;
  renderSleep();
  renderLed();
  renderPerfNote(gateHighRates, esportsBlocked);
  renderApply();
  scheduleSave();
}

function renderSleep() {
  const steps = sleepSteps();
  const i = steps.indexOf(state.sleepTime);
  $('#sleepValue').textContent = String(state.sleepTime);
  const down = $('#sleepDown');
  const up = $('#sleepUp');
  down.disabled = i <= 0;
  up.disabled = i < 0 || i >= steps.length - 1;
  down.title = t('sleepLess');
  up.title = t('sleepMore');
}

function stepSleep(dir) {
  const steps = sleepSteps();
  let i = steps.indexOf(state.sleepTime);
  if (i < 0) i = steps.reduce((a, b, idx) => (Math.abs(b - state.sleepTime) < Math.abs(steps[a] - state.sleepTime) ? idx : a), 0);
  const next = clamp(i + dir, 0, steps.length - 1);
  if (next === i) return;
  state.sleepTime = steps[next];
  markDirty();
  renderSleep();
}

function stepDebounce(dir) {
  state.debounce = clamp(state.debounce + dir, 0, 30);
  $('#debounce').value = state.debounce;
  markDirty();
}

/** 接收器灯：只有 8K 接收器能设；其余时候按键熄灭，但仍标出当前值 */
function renderLed() {
  if (!state.constants || !state.constants.ledModeTable) return;
  const supported = is8K();
  syncKeys($('#ledList'), state.constants.ledModeTable.map((m) => ({
    label: t(m.key),
    ui: true,
    lit: m.value === state.receiverLed,
    off: !supported,
    disabled: !supported,
    title: t(LED_DESC_KEYS[m.value]),
    onClick: () => {
      if (!supported) return;
      state.receiverLed = m.value;
      markDirty();
      renderLed();
    },
  })));
}

/** 参数表下方的注意事项：只列当前用得上的那几条；内容变了整块淡入 */
function renderPerfNote(gateHighRates, esportsBlocked) {
  const notes = [];
  if (gateHighRates) notes.push(t('rate8kOnly'));
  if (esportsBlocked) notes.push(t('perfNoteEsports'));
  notes.push(t('perfNoteGame'));
  if (!is8K()) notes.push(t(state.connected ? 'ledNeed8K' : 'ledNeedConnect'));
  const node = $('#perfNote');
  const text = notes.join('\n');
  if (node.dataset.notes === text) return;
  node.dataset.notes = text;
  node.replaceChildren(...notes.map((n) => h('span', null, n)));
  replay(node, 'fade-in');
}

function sleepSteps() {
  return (state.constants && state.constants.sleepSteps)
    || [10, 20, 30, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900];
}

/** 任意秒数吸附到最近的官方档位（导入配置 / 读回设备时用） */
function nearestSleepStep(sec) {
  const steps = sleepSteps();
  const n = Number(sec);
  if (!Number.isFinite(n)) return steps[0];
  return steps.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
}

// ── 板载配置（5 份 PC 端预设）──────────────────────────────
// 实测（2026-11-15，G24 有线）：把 [6,9,idx] 依次写到 0..5 再回读，DPI / 键位 /
// 回报率 / 节能时间完全一致，只有序号标记变化 —— 硬件只有 1 份配置。
// 所以「切换配置」只是换一份预设来编辑，点「应用配置」才整套写入。
const DEFAULT_DPI_LEVELS = [
  { x: 400, y: 400, color: dpiColorAt(0) },
  { x: 800, y: 800, color: dpiColorAt(1) },
  { x: 1600, y: 1600, color: dpiColorAt(2) },
  { x: 2400, y: 2400, color: dpiColorAt(3) },
  { x: 3200, y: 3200, color: dpiColorAt(4) },
  { x: 6400, y: 6400, color: dpiColorAt(5) },
];

const DEFAULT_BUTTONS = [
  { type: 'mouse', value: 'LEFT' },
  { type: 'mouse', value: 'RIGHT' },
  { type: 'mouse', value: 'MIDDLE' },
  { type: 'mouse', value: 'BACK' },
  { type: 'mouse', value: 'FORWARD' },
  { type: 'mouse', value: 'DPI_LOOP' },
];

function profileCount() {
  return state.constants && state.constants.profileCount ? state.constants.profileCount : 5;
}

/** 一份未改动过的配置：默认 DPI 档位与颜色（用户没改过时界面就显示这些） */
function defaultProfile() {
  return {
    dpiLevels: DEFAULT_DPI_LEVELS.map((lv) => ({ ...lv })),
    currentDpi: 0,
    xySplit: false,
    rate: 1000,
    lod: 0,
    ripple: false,
    angleSnap: false,
    motionSync: true,
    debounce: 8,
    sensorMode: 2,
    sleepTime: 60,
    receiverLed: 0,
    buttons: DEFAULT_BUTTONS.map((b) => ({ ...b })),
  };
}

/** 把界面上的当前编辑状态存回当前配置槽 */
function captureProfile() {
  const p = state.profiles[state.profile];
  if (!p) return;
  p.dpiLevels = state.dpiLevels.map((lv) => ({ ...lv }));
  p.currentDpi = state.currentDpi;
  p.xySplit = state.xySplit;
  p.rate = state.rate;
  p.lod = state.lod;
  p.ripple = state.ripple;
  p.angleSnap = state.angleSnap;
  p.motionSync = state.motionSync;
  p.debounce = state.debounce;
  p.sensorMode = state.sensorMode;
  p.sleepTime = state.sleepTime;
  p.receiverLed = state.receiverLed;
  p.buttons = state.buttons.map((b) => ({ ...b }));
}

/** 把某份配置载入界面状态 */
function loadProfileData(p) {
  if (!p) return;
  if (Array.isArray(p.dpiLevels) && p.dpiLevels.length) {
    state.dpiLevels = p.dpiLevels.map((lv) => ({ ...lv }));
  }
  state.currentDpi = clamp(p.currentDpi ?? 0, 0, Math.max(state.dpiLevels.length - 1, 0));
  state.xySplit = !!p.xySplit;
  if (p.rate) state.rate = p.rate;
  if (p.lod != null) state.lod = clamp(p.lod, 0, 2);
  state.ripple = !!p.ripple;
  state.angleSnap = !!p.angleSnap;
  state.motionSync = !!p.motionSync;
  if (p.sensorMode != null) state.sensorMode = clamp(p.sensorMode, 1, 3);
  if (p.debounce != null) state.debounce = clamp(p.debounce, 0, 30);
  if (p.sleepTime != null) state.sleepTime = p.sleepTime;
  if (p.receiverLed != null) state.receiverLed = clamp(p.receiverLed, 0, 2);
  state.buttons = (p.buttons || DEFAULT_BUTTONS).map((b) => ({ ...b }));
}

/** 补齐 5 个配置槽（旧版本只有单份配置时迁移到第 1 槽） */
function ensureProfiles() {
  const n = profileCount();
  if (!Array.isArray(state.profiles)) state.profiles = [];
  while (state.profiles.length < n) state.profiles.push(defaultProfile());
  if (state.profiles.length > n) state.profiles.length = n;
  state.profile = clamp(state.profile || 0, 0, n - 1);
}

/** 换一份预设来编辑；不写鼠标（读数屏显示的仍是鼠标上的值，「应用配置」键因为两者有差异而点亮） */
function switchProfile(index) {
  if (state.switching) return;
  const i = clamp(index, 0, profileCount() - 1);
  if (i === state.profile) return;
  disarmReset(); // 换了一份来编辑，刚才那一下「恢复默认」不算了
  captureProfile();
  state.profile = i;
  loadProfileData(state.profiles[i]);
  applyPhase = 'idle';
  renderAll();
  saveLocalConfig();
}

/** 把当前编辑中的配置整套写入鼠标（鼠标物理配置键专用；界面上的「应用配置」走 onApply） */
async function applyCurrentProfile() {
  if (!state.connected) return;
  state.switching = true;
  applying = true;
  applyPhase = 'busy';
  lastWriteAt = Date.now(); // 写入回显的配置序号要忽略（见 onProfile）
  renderAll();
  try {
    await window.api.apply(buildApplyOps());
    finishApply(t('applied'));
  } catch (e) {
    applyPhase = 'bad';
    applyMsg = t('applyFailed') + errMsg(e);
  } finally {
    applying = false;
    state.switching = false;
    renderAll();
  }
}

function renderProfiles() {
  const n = profileCount();
  syncKeys($('#profileBar'), Array.from({ length: n }, (_, i) => {
    const inuse = i === state.activeProfile && state.connected; // 鼠标正在运行的那一份：数字标绿
    return {
      label: String(i + 1),
      lit: i === state.profile,
      cls: inuse ? 'inuse' : '',
      disabled: state.switching,
      title: t('profileName', { n: i + 1 }) + (inuse ? ` · ${t('profileInUseTag')}` : ''),
      attrs: { 'data-profile': String(i), 'aria-pressed': String(i === state.profile) },
      onClick: () => switchProfile(i),
    };
  }));
}

// ── 键码反解（读设备配置时把 32 位键码还原成界面选项）──────
function hidNameFor(hidCode) {
  if (!state.constants) return null;
  for (const [name, code] of Object.entries(state.constants.hidKeyCodes)) {
    if (code === hidCode) return name;
  }
  return null;
}

/**
 * 32 位键码 → { type, value }。
 * 反解不出来时返回 null，调用方保留默认值并记下 raw，应用时原样写回（避免抹掉用户自定义的键）。
 */
function decodeKeyCode(code32) {
  const C = state.constants;
  if (!C) return null;
  const code = code32 >>> 0;
  for (const [name, val] of Object.entries(C.mouseKeyCodes || {})) {
    if ((val >>> 0) === code) return { type: 'mouse', value: name };
  }
  for (const [name, val] of Object.entries(C.mediaKeyCodes || {})) {
    if ((val >>> 0) === code) return { type: 'media', value: name };
  }
  if ((code & 0xff) === 9) return { type: 'macro', value: String(code >>> 16) };
  if ((code & 0xff) === 0x80) {
    // 普通键盘键：(hidCode << 8) | 0x80
    const name = hidNameFor((code >> 8) & 0xff);
    if (name) return { type: 'keyboard', value: name };
  }
  if ((code & 0xff) === 0) {
    // 带修饰键：(hidCode << 16) | (modifier << 8)，界面只显示主键
    const name = hidNameFor((code >> 16) & 0xff);
    if (name) return { type: 'keyboard', value: name };
  }
  return null;
}

/** 把设备读回的 6 个键码写到 state.buttons（反解不了的保留默认 + raw） */
function applyButtonCodes(codes) {
  if (!Array.isArray(codes) || !codes.length) return;
  codes.forEach((code, i) => {
    if (i >= state.buttons.length) return;
    const decoded = decodeKeyCode(code);
    state.buttons[i] = decoded
      ? { ...decoded, raw: undefined }
      : { ...DEFAULT_BUTTONS[i], raw: code >>> 0 };
  });
}

/**
 * 把 readConfig 的快照写进当前使用的配置槽并载入界面。
 * 颜色为 #000000 表示该档没存过颜色（固件默认），此时保留预设里的颜色。
 */
function applyDeviceSnapshot(snap) {
  if (!snap) return;
  const slot = clamp(typeof snap.profileIndex === 'number' ? snap.profileIndex : 0, 0, profileCount() - 1);
  state.profile = slot;
  state.activeProfile = slot; // 硬件读回的序号就是正在运行的配置
  const p = state.profiles[slot] || defaultProfile();

  if (Array.isArray(snap.slots) && snap.slots.length) {
    // 0x82 读命令只有 slot、没有轴参数，回读不出 Y 轴（官方驱动同样只写不读 Y）。
    // 因此这里只认设备回读的 X：若它和本地记录一致，说明 Y 没被外部改过，保留本地 Y；
    // 若 X 变了（在别的驱动/机器上改过），两轴按一致处理，避免保留过期的 Y。
    p.dpiLevels = snap.slots.map((s, i) => {
      const prev = p.dpiLevels[i];
      const y = prev && prev.x === s.dpi ? prev.y : s.dpi;
      return { x: s.dpi, y, color: dpiColorAt(i) }; // 颜色固定，忽略设备里存的旧字节
    });
  }
  if (snap.current != null) p.currentDpi = snap.current;
  if (snap.rate) p.rate = snap.rate;
  if (snap.lod != null) p.lod = snap.lod;
  if (snap.ripple != null) p.ripple = snap.ripple;
  if (snap.angleSnap != null) p.angleSnap = snap.angleSnap;
  if (snap.motionSync != null) p.motionSync = snap.motionSync;
  if (snap.sensorMode != null) p.sensorMode = clamp(snap.sensorMode, 1, 3);
  if (snap.debounce != null) p.debounce = snap.debounce;
  if (snap.sleepTime != null) p.sleepTime = snap.sleepTime;
  if (snap.receiverLed != null) p.receiverLed = snap.receiverLed;

  state.profiles[slot] = p;
  loadProfileData(p);
  applyButtonCodes(snap.buttons);
}

// ── 按键映射 ──────────────────────────────────────────────
const BUTTON_NAMES_KEYS = ['btnLeft', 'btnRight', 'btnMiddle', 'btnBack', 'btnForward', 'btnDpi'];
const BUTTON_TYPES = [
  { id: 'mouse', labelKey: 'typeSystem' },
  { id: 'keyboard', labelKey: 'typeKeyboard' },
  { id: 'media', labelKey: 'typeMedia' },
  { id: 'macro', labelKey: 'typeMacro' },
];

function renderButtons() {
  if (!state.constants) return;
  $('#buttonList').replaceChildren(...state.buttons.map((btn, i) => {
    // 值：下拉
    const valueSel = h('select', { class: 'key sel' });
    valueSel.append(buildButtonOptions(btn.type, btn.value));
    valueSel.addEventListener('change', () => {
      state.buttons[i].value = valueSel.value;
      state.buttons[i].raw = undefined; // 用户改过就不再原样写回
      markDirty();
    });
    // 类型：四个联排按键。换类型时只动这一行——灯原地转移，下拉换成新类型的选项后淡入
    const typeSeg = h('span', { class: 'seg' });
    const syncType = () => syncKeys(typeSeg, BUTTON_TYPES.map((tt) => ({
      label: t(tt.labelKey),
      ui: true,
      lit: state.buttons[i].type === tt.id,
      onClick: () => {
        state.buttons[i] = { type: tt.id, value: defaultForType(tt.id) };
        markDirty();
        syncType();
        valueSel.replaceChildren(buildButtonOptions(tt.id, state.buttons[i].value));
        valueSel.value = state.buttons[i].value;
        replay(valueSel, 'fade-in');
      },
    })));
    syncType();
    return h('div', { class: 'brow' },
      h('span', { class: 'no' }, String(i + 1).padStart(2, '0')),
      h('span', { class: 'bname' }, t(BUTTON_NAMES_KEYS[i])),
      typeSeg,
      h('div', { class: 'grow' }, valueSel));
  }));
  scheduleSave();
}

function defaultForType(type) {
  if (type === 'mouse') return 'LEFT';
  if (type === 'keyboard') return 'KeyA';
  if (type === 'media') return 'PLAY_PAUSE';
  return '0';
}

function buildButtonOptions(type, selectedValue) {
  const frag = document.createDocumentFragment();
  const add = (value, text) => {
    const opt = h('option', { value }, text);
    if (value === selectedValue) opt.selected = true;
    frag.appendChild(opt);
  };
  if (type === 'mouse') {
    state.constants.mouseKeys.forEach((k) => add(k, keyLabel(type, k)));
  } else if (type === 'keyboard') {
    Object.keys(state.constants.hidKeyCodes).forEach((k) => add(k, keyLabel(type, k)));
  } else if (type === 'media') {
    state.constants.mediaKeys.forEach((k) => add(k, keyLabel(type, k)));
  } else if (type === 'macro') {
    for (let m = 0; m < 10; m++) add(String(m), t('macroPrefix') + (m + 1));
  }
  return frag;
}

// ── 宏 ────────────────────────────────────────────────────
let macroKeySelectInited = false;
let macroPress = true; // 「添加动作」里选的方向
let macroStatusTimer = null;

function initMacroKeySelect() {
  if (!state.constants) return;
  const sel = $('#macroKeySel');
  const prev = sel.value;
  if (!macroKeySelectInited) {
    Object.entries(state.constants.hidKeyCodes).forEach(([name, code]) => {
      sel.append(h('option', { value: String(code) }, keyLabel('keyboard', name)));
    });
    macroKeySelectInited = true;
  } else {
    // 语言切换后要重排文案
    [...sel.options].forEach((opt, idx) => {
      const name = Object.keys(state.constants.hidKeyCodes)[idx];
      opt.textContent = keyLabel('keyboard', name);
    });
  }
  if (prev) sel.value = prev;
}

function setMacroPress(press) {
  macroPress = press;
  document.querySelectorAll('#macroPressSeg .key').forEach((btn) => {
    btn.classList.toggle('lit', (btn.dataset.press === '1') === press);
  });
}

/**
 * @param opts.switched 换了槽位：动作列表整块淡入
 * @param opts.enterRow 新添加的动作序号（淡入）
 */
function renderMacro(opts = {}) {
  syncKeys($('#macroSlots'), state.macros.map((m, i) => ({
    label: String(i + 1),
    lit: i === state.currentMacro,
    cls: m.items.length ? 'has' : '', // 左上角小白灯 = 槽里有内容
    title: m.items.length ? `${m.name}（${m.items.length} ${t('itemUnit')}）` : m.name,
    onClick: () => {
      state.currentMacro = i;
      renderMacro({ switched: true });
    },
  })));

  const m = state.macros[state.currentMacro];
  $('#macroLoopType').value = String(m.loopType);
  $('#macroCycle').value = m.cycle;
  // 「次数」这一行靠网格行高在 0fr ↔ 1fr 之间过渡来展开 / 收起（不用 .hidden，那样是硬切）
  $('#macroCycleRow').classList.toggle('collapsed', m.loopType !== 2);
  putText($('#macroCount'), `${m.items.length} / 70`);
  renderMacroItems(m, opts);

  const upload = $('#macroUploadBtn');
  upload.classList.toggle('idle', !state.connected);
  upload.disabled = !state.connected;
  scheduleSave();
}

function renderMacroItems(m, opts = {}) {
  const list = $('#macroItems');
  const oldHeight = list.offsetHeight;
  list.replaceChildren();
  list.classList.toggle('empty', m.items.length === 0);
  if (m.items.length === 0) {
    list.textContent = t('macroEmpty');
  } else {
    m.items.forEach((it, i) => {
      const delay = h('input', { type: 'number', class: 'dly', min: 0, max: 60000, title: t('delayMs') });
      delay.value = it.delay;
      delay.addEventListener('change', () => {
        it.delay = Math.max(0, parseInt(delay.value, 10) || 0);
        delay.value = it.delay;
      });
      const rawName = codeToKeyName(it.keyCode);
      const rm = h('button', { class: 'x', type: 'button', title: t('removeAction') }, '✕');
      rm.addEventListener('click', () => {
        // 这一行留个残影淡出，其余动作滑上来补位
        removeRow(rm.closest('.item'), () => {
          m.items.splice(i, 1);
          renderMacro();
        });
      });
      list.append(h('div', { class: `item${opts.enterRow === i ? ' enter' : ''}` },
        h('span', { class: 'no' }, String(i + 1)),
        h('span', { class: `dir ${it.press ? 'down' : 'up'}` }, it.press ? t('pressDir') : t('releaseDir')),
        h('span', { class: 'cap', title: rawName }, keyLabel('keyboard', rawName)),
        delay,
        rm));
    });
  }
  if (opts.switched) replay(list, 'refresh');
  if (opts.enterRow != null) resizeList(list, oldHeight, true); // 新的那一行是从列表里展开出来的
}

function codeToKeyName(code) {
  for (const [name, c] of Object.entries(state.constants.hidKeyCodes)) {
    if (c === code) return name;
  }
  return '0x' + code.toString(16);
}

function stepMacroDelay(step) {
  const input = $('#macroDelay');
  input.value = clamp((parseInt(input.value, 10) || 0) + step, 0, 60000);
}

function onMacroAddItem() {
  const keyCode = parseInt($('#macroKeySel').value, 10);
  if (isNaN(keyCode)) return;
  const delay = Math.max(0, parseInt($('#macroDelay').value, 10) || 0);
  const m = state.macros[state.currentMacro];
  if (m.items.length >= 70) {
    flashMacroStatus(t('macroFull'), true);
    return;
  }
  m.items.push({ press: macroPress, keyCode, delay });
  renderMacro({ enterRow: m.items.length - 1 }); // 新添加的那一行淡入
}

async function onMacroUpload() {
  if (!state.connected) {
    flashMacroStatus(t('pleaseConnect'), true);
    return;
  }
  const btn = $('#macroUploadBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  const m = state.macros[state.currentMacro];
  setMacroStatus(t('uploading'), '');
  try {
    await window.api.uploadMacro({
      slot: m.slot,
      loopType: m.loopType,
      cycle: m.cycle,
      items: m.items.map((it) => ({ press: it.press, keyCode: it.keyCode, delay: it.delay })),
    });
    setMacroStatus(t('uploaded'), 'ok');
    clearTimeout(macroStatusTimer);
    macroStatusTimer = setTimeout(() => setMacroStatus('', ''), 4000);
    saveLocalConfig();
  } catch (e) {
    setMacroStatus(t('uploadFailed') + errMsg(e), 'err');
  } finally {
    btn.disabled = !state.connected;
  }
}

function setMacroStatus(text, kind) {
  const s = $('#macroStatus');
  s.title = text;
  s.className = `status-text${kind ? ` ${kind}` : ''}`;
  putText(s, text);
}

/** 一次性提示（如动作数已满），失败的红字不自动消失 */
function flashMacroStatus(text, isErr) {
  clearTimeout(macroStatusTimer);
  setMacroStatus(text, isErr ? 'err' : 'ok');
  if (!isErr) {
    macroStatusTimer = setTimeout(() => setMacroStatus('', ''), 4000);
  }
}

// ── 应用 ─────────────────────────────────────
function snapshotOf() {
  return {
    buttons: JSON.stringify(state.buttons.map((b) => [b.type, b.value, b.raw ?? null])),
    dpiValues: state.dpiLevels.map((lv) => ({ x: lv.x, y: lv.y })),
    currentDpi: state.currentDpi,
    rate: state.rate,
    lod: state.lod,
    sensorMode: state.sensorMode,
    motionSync: state.motionSync,
    angleSnap: state.angleSnap,
    ripple: state.ripple,
    debounce: state.debounce,
    sleepTime: state.sleepTime,
    receiverLed: state.receiverLed,
  };
}

/** 与鼠标不一致的参数有几项（按键映射算一项，三个传感器修正合计一项……） */
function pendingCount() {
  if (!baseline) return 0;
  const s = snapshotOf();
  let n = 0;
  if (s.buttons !== baseline.buttons) n++;
  if (JSON.stringify(s.dpiValues) !== JSON.stringify(baseline.dpiValues)) n++;
  if (s.currentDpi !== baseline.currentDpi) n++;
  if (s.rate !== baseline.rate) n++;
  if (s.lod !== baseline.lod) n++;
  if (s.sensorMode !== baseline.sensorMode) n++;
  if (s.motionSync !== baseline.motionSync || s.angleSnap !== baseline.angleSnap || s.ripple !== baseline.ripple) n++;
  if (s.debounce !== baseline.debounce) n++;
  if (s.sleepTime !== baseline.sleepTime) n++;
  if (is8K() && s.receiverLed !== baseline.receiverLed) n++; // 接收器灯只有 8K 接收器写得进去
  if (state.profile !== state.activeProfile) n++;
  return n;
}

/** 有修改：清掉上一条「已应用 / 失败」 */
function markDirty() {
  if (applyPhase !== 'busy') applyPhase = 'idle';
  renderApply();
}

function renderApply() {
  const n = pendingCount();
  const canApply = state.connected && n > 0 && !state.switching;
  const btn = $('#applyBtn');
  const wasIdle = btn.classList.contains('idle');
  btn.classList.toggle('idle', !canApply);
  btn.disabled = !canApply || applyPhase === 'busy';
  if (wasIdle && canApply) replay(btn, 'ignite'); // 从熄灭到点亮的那一下：键面闪一下

  let kind = null;
  let text = '';
  if (applyPhase === 'busy') {
    kind = 'busy';
    text = t('applying');
  } else if (resetArmed) {
    kind = 'confirm'; // 「恢复默认」在等第二下：状态行换成确认提示
    text = t('resetConfirmText');
  } else if (applyPhase === 'ok' || applyPhase === 'bad') {
    kind = applyPhase;
    text = applyMsg;
  }
  // 有未应用的差异时不另出提示：那份差异由亮着的「应用配置」键表达（这里原来报「N 项未应用」，
  // 用户切到另一份配置时看到「5 项未应用」，问是什么意思，随后说不需要这个提示）
  $('#applyLed').className = `led${kind === 'ok' ? ' ok' : kind === 'bad' ? ' bad' : kind === 'busy' ? ' busy' : ''}`;
  const txt = $('#applyStateText');
  txt.className = `status-text${kind === 'bad' ? ' err' : ''}`;
  // 收起时不清文字：让它跟着整块一起淡出（先清掉的话，淡出的就只剩那盏灯，文字是瞬间没的）；
  // 藏好了再清，免得藏着的元素里留着一条已经不成立的提示
  if (kind) putText(txt, text);
  txt.title = text;
  toggleShown($('#applyState'), !!kind, { afterHide: () => { txt.textContent = ''; } });
  $('#profileBar').querySelectorAll('button').forEach((b) => {
    b.disabled = state.switching;
  });
  const reset = $('#resetBtn');
  reset.classList.toggle('armed', resetArmed);
  reset.disabled = state.switching;
  reset.title = t(resetArmed ? 'resetArmedTitle' : 'resetTitle');
}

/** 写入成功后的收尾：界面此刻与鼠标一致，以此为新的基线 */
function finishApply(text) {
  baseline = snapshotOf();
  state.activeProfile = state.profile;
  saveLocalConfig();
  flashOk(text);
}

async function onApply() {
  if (applying || !state.connected || pendingCount() === 0) return;
  disarmReset();
  applying = true;
  applyPhase = 'busy';
  lastWriteAt = Date.now(); // 写入回显的配置序号要忽略（见 onProfile）
  renderApply();
  try {
    await window.api.apply(buildApplyOps());
    finishApply(t('applied'));
  } catch (e) {
    applyPhase = 'bad';
    applyMsg = t('applyFailed') + errMsg(e);
  } finally {
    applying = false;
    renderAll();
  }
}

/**
 * 恢复默认：把当前选中的这份配置的全部参数换回默认值。只改电脑上的这份，点「应用配置」才写进鼠标；宏不动。
 * 会被换掉的参数不少，所以要点两下：第一下只是把键点亮成红色、在状态行里说明，第二下才动手
 */
function onResetProfile() {
  if (state.switching) return;
  if (!resetArmed) {
    resetArmed = true;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(disarmReset, RESET_ARM_MS);
    renderApply();
    return;
  }
  disarmReset();
  state.profiles[state.profile] = defaultProfile();
  loadProfileData(state.profiles[state.profile]);
  applyPhase = 'idle';
  renderAll(); // 各页的编辑值换成默认值，「应用配置」键亮着等写入
  saveLocalConfig();
}

/** 取消那一下等待：键恢复原样，状态行收起 */
function disarmReset() {
  if (!resetArmed) return;
  resetArmed = false;
  clearTimeout(resetTimer);
  renderApply();
}

function buildApplyOps() {
  const ops = [];

  // 按键映射（按矩阵位置 index）
  state.buttons.forEach((btn, i) => {
    // 读设备时反解不出来的键码原样写回，避免把用户自定义的键抹成默认值
    if (btn.raw != null) {
      ops.push({ action: 'setKeyRaw', args: [i, btn.raw] });
      return;
    }
    ops.push({ action: 'setKey', args: [i, btn.type, btn.value] });
  });

  // DPI 档位值（传实际 DPI，桥接层内部转硬件值）
  // 每档的灯色也走同一条命令的 buf[4..6]，官方驱动恒填 0（这就是"改灯色不生效"的原因）
  state.dpiLevels.forEach((lv, i) => {
    const color = dpiColorAt(i);
    // 下发前再兜一次底：低于 50 的 DPI 一律按 50，绝不让 0 进命令
    const x = dpiFloor(lv.x, 800);
    const y = dpiFloor(lv.y, x);
    if (state.xySplit && x !== y) {
      ops.push({ action: 'setDpi', args: [i, x, 1, color] }); // X 轴
      ops.push({ action: 'setDpi', args: [i, y, 2, color] }); // Y 轴
    } else {
      ops.push({ action: 'setDpi', args: [i, x, 0, color] });
    }
  });

  ops.push({ action: 'setDpiLevel', args: [state.dpiLevels.length, state.currentDpi] });
  ops.push({ action: 'setRate', args: [state.rate] });
  // 性能模式（协议 apply 顺序：回报率之后）
  ops.push({ action: 'setSensorMode', args: [state.sensorMode] });
  ops.push({ action: 'setRipple', args: [state.ripple] });
  ops.push({ action: 'setAngleSnap', args: [state.angleSnap] });
  ops.push({ action: 'setMotionSync', args: [state.motionSync] });
  ops.push({ action: 'setLod', args: [state.lod] });
  ops.push({ action: 'setDebounce', args: [state.debounce] });
  ops.push({ action: 'setSleepTime', args: [state.sleepTime] });
  ops.push({ action: 'setProfile', args: [state.profile] });
  // 接收器指示灯（仅 8K 接收器）
  if (is8K()) ops.push({ action: 'setReceiverLed', args: [state.receiverLed] });

  return ops;
}

// ── 配置导入导出（.ict，兼容官方网页驱动格式）────────────────
function buildProfileExport() {
  return {
    name: t('profileName', { n: state.profile + 1 }),
    sensor: state.modelInfo ? state.modelInfo.sensor : undefined,
    rate: state.rate,
    lod: state.lod,
    sensorMode: state.sensorMode,
    angleSnap: state.angleSnap,
    ripple: state.ripple,
    motionSync: state.motionSync,
    debounce: state.debounce,
    sleepTime: state.sleepTime,
    receiverLed: state.receiverLed,
    currentDpi: state.currentDpi,
    dpiLevels: state.dpiLevels.map((lv, i) => ({ ...lv, color: dpiColorAt(i) })),
    buttons: state.buttons,
  };
}

async function onExportProfile() {
  try {
    const res = await window.api.exportProfile(buildProfileExport());
    if (!res.canceled) flashOk(t('configExported'));
  } catch (e) {
    setFailure(t('exportFailed') + errMsg(e));
  }
}

async function onImportProfile() {
  try {
    const res = await window.api.importProfile();
    if (res.canceled) return;
    applyImportedProfile(res.profile);
    renderAll(); // 导入的配置进入当前槽；与鼠标有差异时「应用配置」键点亮
    saveLocalConfig();
    flashOk(t('configImported'));
  } catch (e) {
    setFailure(t('importFailed') + errMsg(e));
  }
}

/** 用底栏的状态灯报一次性结果（绿：成功；4 秒后收起） */
function flashOk(text) {
  applyPhase = 'ok';
  applyMsg = text;
  renderApply();
  clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    applyPhase = 'idle';
    renderApply();
  }, 4000);
}

/** 用底栏的状态灯报失败（红；一直留到下一次操作） */
function setFailure(text) {
  applyPhase = 'bad';
  applyMsg = text;
  renderApply();
}

function applyImportedProfile(p) {
  if (Array.isArray(p.dpiLevels) && p.dpiLevels.length) {
    // 低于 50 的 DPI 统一按 50 处理（importProfile 已归一，这里再兜一次底）
    state.dpiLevels = p.dpiLevels.map((lv, i) => {
      const x = dpiFloor(lv.x, 800);
      return { x, y: dpiFloor(lv.y, x), color: dpiColorAt(i) };
    });
    // X/Y 不一致时自动打开 XY 分离显示（用归一后的值判断）
    state.xySplit = state.dpiLevels.some((lv) => lv.x !== lv.y);
  }
  state.currentDpi = clamp(p.currentDpi ?? 0, 0, state.dpiLevels.length - 1);
  if (p.rate) state.rate = p.rate;
  if (p.lod != null) state.lod = clamp(p.lod, 0, 2);
  state.angleSnap = !!p.angleSnap;
  state.ripple = !!p.ripple;
  state.motionSync = !!p.motionSync;
  if (p.sensorMode != null) state.sensorMode = clamp(p.sensorMode, 1, 3);
  if (p.debounce != null) state.debounce = clamp(p.debounce, 0, 30);
  // 节能调节只有固定档位，吸附到最近的官方值
  if (p.sleepTime != null) state.sleepTime = nearestSleepStep(p.sleepTime);
  if (Array.isArray(p.buttons) && p.buttons.length === 6) state.buttons = p.buttons;
  if (p.receiverLed != null) state.receiverLed = clamp(p.receiverLed, 0, 2);
  // 非 8K 接收器回落超范围回报率
  if (state.modelInfo && !state.modelInfo.is8KReceiver && state.rate > 1000) state.rate = 1000;
}

// ── 宏库导入导出（.icm，兼容官方网页驱动格式）────────────────
async function onMacroExport() {
  try {
    const res = await window.api.exportMacros(state.macros);
    if (!res.canceled) flashMacroStatus(t('macrosExported'), false);
  } catch (e) {
    flashMacroStatus(t('exportFailed') + errMsg(e), true);
  }
}

async function onMacroImport() {
  try {
    const res = await window.api.importMacros();
    if (res.canceled) return;
    // 导入的宏按顺序占用槽位 0..n-1，其余槽位重置为空（与官方宏库替换语义一致）
    const imported = res.macros.slice(0, 10);
    state.macros = [];
    for (let s = 0; s < 10; s++) {
      const m = imported[s];
      state.macros.push(m
        ? { slot: s, name: m.name || t('macroPrefix') + (s + 1), loopType: m.loopType, cycle: m.cycle, items: m.items }
        : { slot: s, name: t('macroPrefix') + (s + 1), loopType: 2, cycle: 1, items: [] });
    }
    state.currentMacro = 0;
    renderMacro();
    saveLocalConfig();
    flashMacroStatus(t('macrosImported') + imported.length + t('macroUnit'), false);
  } catch (e) {
    flashMacroStatus(t('importFailed') + errMsg(e), true);
  }
}

// ── 本地配置持久化 ─────────────────────────────────────────
/** 旧格式（单份配置）→ 一份完整预设，缺的字段用默认值补齐 */
function normalizeProfile(p) {
  const base = defaultProfile();
  if (!p || typeof p !== 'object') return base;
  const out = { ...base };
  if (Array.isArray(p.dpiLevels) && p.dpiLevels.length) {
    // 旧存档里低于 50 的 DPI（含 0/负数）统一按 50 处理
    out.dpiLevels = p.dpiLevels.map((lv, i) => {
      const x = dpiFloor(lv.x, base.dpiLevels[0].x);
      return {
        x,
        y: dpiFloor(lv.y, x),
        color: dpiColorAt(i), // 颜色固定为官方六色，不受旧存档影响
      };
    });
  }
  if (p.currentDpi != null) out.currentDpi = clamp(p.currentDpi, 0, out.dpiLevels.length - 1);
  ['xySplit', 'ripple', 'angleSnap', 'motionSync'].forEach((k) => {
    if (p[k] != null) out[k] = !!p[k];
  });
  if (p.rate) out.rate = p.rate;
  if (p.lod != null) out.lod = clamp(p.lod, 0, 2);
  if (p.debounce != null) out.debounce = clamp(p.debounce, 0, 30);
  if (p.sensorMode != null) out.sensorMode = clamp(p.sensorMode, 1, 3);
  if (p.sleepTime != null) out.sleepTime = p.sleepTime;
  if (p.receiverLed != null) out.receiverLed = clamp(p.receiverLed, 0, 2);
  if (Array.isArray(p.buttons) && p.buttons.length === 6) out.buttons = p.buttons.map((b) => ({ ...b }));
  return out;
}

function loadLocalConfig() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem('incott-config'));
  } catch (_) {
    /* 忽略 */
  }

  if (saved) {
    if (Array.isArray(saved.profiles) && saved.profiles.length) {
      state.profiles = saved.profiles.map(normalizeProfile);
      if (saved.profile != null) state.profile = saved.profile;
    } else {
      // 0.4 及更早只存了一份配置 —— 迁移到第 1 槽，其余槽位保持官方默认
      state.profiles = [normalizeProfile(saved)];
    }
    if (Array.isArray(saved.macros)) state.macros = saved.macros;
    if (saved.currentMacro != null) state.currentMacro = saved.currentMacro;
  }

  ensureProfiles();
  loadProfileData(state.profiles[state.profile]);
  state.buttons = state.buttons.length ? state.buttons : DEFAULT_BUTTONS.map((b) => ({ ...b }));

  if (state.macros.length === 0) {
    state.macros = [];
    for (let s = 0; s < 10; s++) {
      state.macros.push({ slot: s, name: t('macroPrefix') + (s + 1), loopType: 2, cycle: 1, items: [] });
    }
  }
}

function configJson() {
  return JSON.stringify({
    profiles: state.profiles,
    profile: state.profile,
    macros: state.macros,
    currentMacro: state.currentMacro,
  });
}

function saveLocalConfig() {
  captureProfile(); // 界面上的改动先落回当前槽，否则切配置会丢
  lastSavedJson = configJson();
  localStorage.setItem('incott-config', lastSavedJson);
}

let saveTimer = null;
let lastSavedJson = null; // 上一次写进本地存储的内容，用来跳过没变化的保存

/**
 * 改动随手存进本地。以前只在切换配置、应用成功、导入、上传宏的时候才存，改完直接关掉软件就丢了
 * （上游也是这样）。各页重画之后调一次：等界面安静 300ms 再写——拖推子时会连续触发；内容没变就不写
 */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!state.profiles || state.profiles.length !== profileCount()) return; // 本地配置还没载入完
    captureProfile();
    const json = configJson();
    if (json === lastSavedJson) return;
    localStorage.setItem('incott-config', json);
    lastSavedJson = json;
  }, 300);
}

// 关窗口 / 退出时还有一笔没到时间的保存：立刻写
window.addEventListener('pagehide', () => {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (state.profiles && state.profiles.length === profileCount()) saveLocalConfig();
});

function renderAll() {
  renderTitle();
  renderDpi();
  renderPerformance();
  renderProfiles();
  renderButtons();
  initMacroKeySelect();
  renderMacro();
  renderApply();
}

// 首帧先按自动值缩放，避免读完设置才跳一下
applyUiScale('auto');
init();
