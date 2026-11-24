/**
 * UI/UX 样稿的静态内容（纯模板 + 轻交互，不连设备）。
 * 三个布局方案共用这一份：menu.html（左菜单）/ tabs.html（顶部页签）/ single.html（单屏双页）。
 */
const ICONS = {
  min: '<svg viewBox="0 0 12 12"><path d="M3 6h6"/></svg>',
  max: '<svg viewBox="0 0 12 12"><rect x="3" y="3" width="6" height="6" rx="1"/></svg>',
  close: '<svg viewBox="0 0 12 12"><path d="M3.4 3.4l5.2 5.2M8.6 3.4L3.4 8.6"/></svg>',
  sliders:
    '<svg class="ico" viewBox="0 0 20 20"><path d="M3.4 6.2h13.2M3.4 13.8h13.2"/><circle cx="7.6" cy="6.2" r="2.1"/><circle cx="12.9" cy="13.8" r="2.1"/></svg>',
  globe:
    '<svg class="ico" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.2"/><path d="M2.8 10h14.4M10 2.8c1.9 2 2.9 4.5 2.9 7.2S11.9 15.2 10 17.2C8.1 15.2 7.1 12.7 7.1 10S8.1 4.8 10 2.8z"/></svg>',
  github:
    '<svg class="ico" viewBox="0 0 20 20" style="fill:currentColor;stroke:none"><path d="M10 1.9a8.1 8.1 0 0 0-2.6 15.8c.4.1.6-.2.6-.4v-1.5c-2.3.5-2.8-1.1-2.8-1.1-.4-1-.9-1.2-.9-1.2-.8-.5.1-.5.1-.5.8.1 1.3.9 1.3.9.7 1.3 1.9 1 2.4.7.1-.5.3-1 .5-1.2-1.8-.2-3.7-.9-3.7-4.1 0-.9.3-1.6.8-2.2-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.5 7.5 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.5 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.2 0 3.2-1.9 3.9-3.7 4.1.3.3.6.8.6 1.6v2.4c0 .2.2.5.6.4A8.1 8.1 0 0 0 10 1.9z"/></svg>',
};

const MOUSE =
  '<svg viewBox="0 0 120 168"><ellipse class="mouse-shadow" cx="60" cy="158" rx="30" ry="5"/>' +
  '<path class="mouse-outline" d="M60 6c19 0 34 16 34 40v56c0 26-13 40-34 40S26 128 26 102V46C26 22 41 6 60 6z"/>' +
  '<path class="mouse-seamL" d="M60 6.5V56M60 56c-8.5 0-14-5-14-11.5"/><path class="mouse-seamR" d="M60 56c8.5 0 14-5 14-11.5"/>' +
  '<rect class="mouse-wheel" x="56" y="30" width="8" height="18" rx="4"/><circle class="mouse-led" cx="60" cy="96" r="7"/></svg>';

// ── 小零件 ────────────────────────────────────────────────
const key = (label, cls = '') => `<button type="button" class="key${cls ? ` ${cls}` : ''}">${label}</button>`;
const keys = (items) => items.map(([label, cls]) => key(label, cls)).join('');
const seg = (items, extra = '') => `<div class="seg${extra ? ` ${extra}` : ''}">${keys(items)}</div>`;
const tog = (on) => `<span class="tog${on ? ' on' : ''}"></span>`;
const togl = (label, on) => `<span class="togl">${tog(on)}${label}</span>`;
const stepper = (v, unit) =>
  `<span class="stepper">${key('−', 'sq')}<span class="sval">${v}</span><span class="unit">${unit}</span>${key('+', 'sq')}</span>`;
const cta = (label, lit) => `<button type="button" class="cta${lit ? '' : ' idle'}">${label}</button>`;

// ── 数据（写死）──────────────────────────────────────────
const MAX_DPI = 45000;
const STAGES = [
  [400, '#ff0000'], [800, '#0000ff'], [1600, '#00ff00'], [2400, '#ffff00'], [3200, '#00ffff'], [6400, '#ff00ff'],
];
const NAV = [
  ['01', 'DPI'], ['02', '按键'], ['03', '性能'], ['04', '宏'],
];
const fillOf = (v) => `${((v - 50) / (MAX_DPI - 50) * 100).toFixed(2)}%`;

const fader = (v, color) => `<div class="fader" style="--fill:${fillOf(v)};--sw:${color}"><i class="cap"></i></div>`;

/** 档位通道条；compact = 单屏方案里的窄版（数值靠右，删除键悬停才出现） */
const stage = ([v, color], i, cur, compact) =>
  `<div class="stage${i === cur ? ' current' : ''}${compact ? ' compact' : ''}" style="--sw:${color}" data-v="${v}">` +
  `<span class="idx">${i + 1}</span>${compact ? '' : `<span class="val mono">${v}</span>`}${fader(v, color)}` +
  `${compact ? `<span class="val mono">${v}</span>` : ''}<span class="lamp"></span>` +
  `<button type="button" class="x" title="删除档位">✕</button></div>`;

const stages = (cur, compact) =>
  `<div class="stages">${STAGES.map((s, i) => stage(s, i, cur, compact)).join('')}</div>`;

// ── 页面 ──────────────────────────────────────────────────
const pageDpi = (cur, compact) => `
  <div class="page-head">
    <h2><span class="no">01</span>DPI 档位</h2>
    ${compact ? '' : '<label class="xy"><span class="tog"></span>XY 轴单独调节</label>'}
  </div>
  ${compact ? '' : '<p class="page-hint">拖动推子或直接输入，数值是 50 的倍数；鼠标上的 DPI 键在各档位间切换。</p>'}
  ${stages(cur, compact)}
  <div class="stage-foot">${key('+ 新增档位', 'ui strong')}<span class="note">档位灯的颜色只用于区分档位。</span></div>`;

const perf = (compact) => {
  const led = compact
    ? [['回报率', 'ui lit'], ['电池', 'ui'], ['低电量', 'ui']]
    : [['连接状态和回报率', 'ui lit'], ['电池状态', 'ui'], ['仅警告电池', 'ui']];
  return `
  <div class="panel">
    <h3>参数</h3>
    <div class="prow"><span class="no">01</span><span class="plabel">回报率</span><div class="ctl gap6 group rate">${keys([
      ...(compact ? ['125', '250', '500', '1000', '2000', '4000'] : ['125 Hz', '250 Hz', '500 Hz', '1000 Hz', '2000 Hz', '4000 Hz']).map((k) => [k]),
      [compact ? '8000' : '8000 Hz', 'lit'],
    ])}${compact ? '<span class="unit">Hz</span>' : ''}</div></div>
    <div class="prow"><span class="no">02</span><span class="plabel">LOD</span><div class="ctl gap6 group">${keys([
      [compact ? '0.7' : '0.7 mm'], [compact ? '1' : '1 mm'], [compact ? '2' : '2 mm', 'lit'],
    ])}${compact ? '<span class="unit">mm</span>' : ''}</div></div>
    <div class="prow"><span class="no">03</span><span class="plabel">性能模式</span><div class="ctl gap6 group">${keys([
      ['电竞', 'ui is-off'], ['标准', 'ui lit'], ['节能', 'ui'],
    ])}</div></div>
    <div class="prow"><span class="no">04</span><span class="plabel">传感器修正</span><div class="ctl">${togl('运动同步', true)}${togl('直线修正', false)}${togl('波纹修正', false)}</div></div>
    <div class="prow"><span class="no">05</span><span class="plabel">按键响应</span><div class="ctl">${stepper('8', 'ms')}</div></div>
    <div class="prow"><span class="no">06</span><span class="plabel">节能</span><div class="ctl">${stepper('60', 's')}</div></div>
    <div class="prow"><span class="no">07</span><span class="plabel">接收器灯</span><div class="ctl gap6 group">${keys(led)}</div></div>
    <div class="pnote">2000 Hz 以上不可开电竞模式；直线修正和波纹修正在游戏里建议关闭。</div>
  </div>`;
};

const pagePerf = (compact) => `
  <div class="page-head"><h2><span class="no">03</span>性能参数</h2></div>
  ${perf(!!compact)}`;

const BTYPE = ['系统', '键盘', '多媒体', '宏'];
const BROWS = [
  ['左键', '左键'], ['右键', '右键'], ['中键', '中键'], ['后退', '后退'], ['前进', '前进'], ['DPI 键', 'DPI 循环'],
];
const buttons = () =>
  `<div class="blist">${BROWS.map(([name, val], i) => `
    <div class="brow"><span class="no">0${i + 1}</span><span class="bname">${name}</span>` +
    seg(BTYPE.map((t) => [t, `ui${t === '系统' ? ' lit' : ''}`]), 'group') +
    `<div class="grow">${key(val, 'sel')}</div></div>`).join('')}</div>`;

const pageButtons = (no = '02') => `
  <div class="page-head"><h2><span class="no">${no}</span>按键映射</h2></div>
  ${buttons()}`;

const ITEMS = [
  ['down', 'D', 40], ['down', '空格', 0], ['up', '空格', 30], ['up', 'D', 0], ['down', 'A', 60], ['up', 'A', 0],
];
const macro = (no, narrow) => `
  <div class="page-head"><h2><span class="no">${no}</span>宏</h2></div>
  <div class="slots">${Array.from({ length: 10 }, (_, i) => key(String(i + 1), i < 4 ? `has${i === 0 ? ' lit' : ''}` : '')).join('')}</div>
  <div class="macro-grid${narrow ? ' narrow' : ''}">
    <div class="stack">
      <div class="panel">
        <h3>循环</h3>
        <div class="frow"><span class="flabel">方式</span><div class="grow">${key('按住循环', 'sel')}</div></div>
        <div class="frow"><span class="flabel">次数</span><div class="grow">${stepper('1', '次')}</div></div>
      </div>
      <div class="panel">
        <h3>添加动作</h3>
        <div class="frow"><span class="flabel">按键</span><div class="grow">${key('A', 'sel')}</div></div>
        <div class="frow"><span class="flabel">方向</span><div class="grow">${seg([['按下', 'ui lit'], ['释放', 'ui']], 'group')}</div></div>
        <div class="frow"><span class="flabel">延迟</span><div class="grow">${stepper('50', 'ms')}</div></div>
        <div class="frow">${key('+ 添加', 'ui strong grow')}</div>
      </div>
    </div>
    <div class="panel">
      <h3>动作<span class="mono" style="float:right;font-weight:400;color:var(--text-muted)">6 / 70</span></h3>
      <div class="items">${ITEMS.map(([dir, k, d], i) => `
        <div class="item"><span class="no">${i + 1}</span><span class="dir ${dir}">${dir === 'down' ? '↓ 按下' : '↑ 释放'}</span>` +
        `<span class="cap">${k}</span><span class="dly">${d}<small>ms</small></span><button type="button" class="x">✕</button></div>`).join('')}
      </div>
    </div>
  </div>
  <div class="macro-foot">${key('导入宏', 'ui strong')}${key('导出宏', 'ui strong')}<span class="spacer"></span>${cta('上传到鼠标', true)}</div>`;

const pageMacro = () => macro('04', false);

// ── 外框：标题栏 / 读数屏 / 底栏 ───────────────────────────
const titlebar = (extra = '') => `
  <header class="titlebar">
    <div class="brand"><span class="led"></span><span class="brand-name">INCOTT</span><span class="brand-sub">鼠标驱动</span></div>
    ${extra}
    <div class="status">
      <span class="link"><span class="led round ok"></span>已连接</span>
      <span class="model">G24 · PAW3950 · 8K</span>
      <span class="batt"><span class="cell"></span>72%</span>
      ${key(ICONS.sliders, 'icon')}${key(ICONS.globe, 'icon')}${key('断开', 'ui strong')}
    </div>
    <div class="winctl"><button type="button">${ICONS.min}</button><button type="button">${ICONS.max}</button><button type="button" class="close">${ICONS.close}</button></div>
  </header>`;

const screen = (cur) => `
  <div class="screen">
    <div class="screen-head"><span class="led round ok"></span><span class="lbl">设备</span><span class="name">G24 · 8K</span></div>
    <div class="art" style="--sw:${STAGES[cur][1]}">${MOUSE}</div>
    <div class="hero mono">${STAGES[cur][0]}</div>
    <div class="sub">DPI · 第 ${cur + 1} 档 / 共 ${STAGES.length} 档</div>
    <div class="rows">
      <div class="srow"><span class="k">回报率</span><span class="v">8000<small>Hz</small></span></div>
      <div class="srow"><span class="k">电量</span><span class="v ok">72<small>%</small></span></div>
      <div class="srow"><span class="k">配置</span><span class="v">1<small>/ 5</small></span></div>
    </div>
  </div>`;
const readout = (cur) => `<aside class="readout">${screen(cur)}</aside>`;

/** 编辑中的配置 = 2（白灯），鼠标正在运行的是 1（绿灯），有 3 项修改未应用 */
const bottombar = () => `
  <footer class="bottombar">
    <span class="lbl">配置</span>
    <div class="profiles">${[1, 2, 3, 4, 5].map((n) => key(String(n), n === 2 ? 'lit' : n === 1 ? 'inuse' : '')).join('')}</div>
    <span class="pending"><span class="led"></span>3 项未应用</span>
    <span class="spacer"></span>
    ${key('导入', 'ui strong')}${key('导出', 'ui strong')}
    ${cta('应用到鼠标', true)}
  </footer>`;

const navButtons = (active, cls) =>
  NAV.map(([no, label], i) => `<button type="button" class="${cls}${i === active ? 'active' : ''}" data-page="${i}"><span class="no">${no}</span>${label}</button>`).join('');

const pageShell = (i, active, inner) => `<section class="page${i === active ? ' active' : ''}" data-page="${i}">${inner}</section>`;

// ── 三个方案的装配 ────────────────────────────────────────
const SCHEMES = {
  /** 方案一：左侧编号菜单 */
  menu: () => `
    ${titlebar()}
    <div class="work">
      <nav class="menu">${navButtons(0, '')}<div class="ver"><span>v1.2.7</span>${ICONS.github}</div></nav>
      <main class="main">${[pageDpi(1), pageButtons(), pagePerf(), pageMacro()].map((inner, i) => pageShell(i, 0, inner)).join('')}</main>
      ${readout(1)}
    </div>
    ${bottombar()}`,
  /** 方案二：顶部页签 */
  tabs: () => `
    ${titlebar()}
    <nav class="tabs">${navButtons(0, '')}</nav>
    <div class="work">
      <main class="main">${[pageDpi(1), pageButtons(), pagePerf(), pageMacro()].map((inner, i) => pageShell(i, 0, inner)).join('')}</main>
      ${readout(1)}
    </div>
    ${bottombar()}`,
  /** 方案三：单屏双页（调校 / 按键与宏）*/
  single: () => `
    ${titlebar(
      `<div class="modes seg"><button type="button" class="key ui lit" data-page="0">调校</button><button type="button" class="key ui" data-page="1">按键与宏</button></div>`,
    )}
    <div class="work"><main class="main">
      ${pageShell(0, 0, `<div class="console"><div>${pageDpi(1, true)}</div><div>${pagePerf(true)}</div><div class="readout flush">${screen(1)}</div></div>`)}
      ${pageShell(1, 0, `<div class="duo"><div>${pageButtons('03')}</div><div>${macro('04', true)}</div></div>`)}
    </main></div>
    ${bottombar()}`,
};

// ── 轻交互：只求「点得动」，数据不保存 ────────────────────
function wire() {
  const q = (s, r = document) => [...r.querySelectorAll(s)];

  // 切页：导航按钮与页面按 data-page 对应（按键式导航点亮用 lit，菜单/页签用 active）
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('.menu [data-page], .tabs [data-page], .modes [data-page]');
    if (!nav) return;
    const id = nav.dataset.page;
    q('.menu [data-page], .tabs [data-page], .modes [data-page]').forEach((el) => {
      el.classList.toggle(el.classList.contains('key') ? 'lit' : 'active', el.dataset.page === id);
    });
    q('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === id));
  });

  // 单选按键组：点亮点击的那个，熄灭同组其它
  document.addEventListener('click', (e) => {
    const k = e.target.closest('.group .key:not(.is-off)');
    if (!k || k.classList.contains('sel')) return;
    q('.key', k.closest('.group')).forEach((el) => el.classList.remove('lit'));
    k.classList.add('lit');
  });

  // 开关
  document.addEventListener('click', (e) => {
    const t = e.target.closest('.tog, .togl');
    if (t) t.classList.toggle('on');
  });

  // 步进：只支持 ±1 的整数演示
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.stepper .key');
    if (!b) return;
    const v = b.closest('.stepper').querySelector('.sval');
    v.textContent = String(Math.max(0, parseInt(v.textContent, 10) + (b.textContent === '+' ? 1 : -1)));
  });

  // 点档位条 = 切到该档（读数屏的大数字跟着变）
  const syncHero = () => {
    const cur = document.querySelector('.stage.current');
    if (!cur) return;
    const scr = document.querySelector('.screen');
    scr.querySelector('.hero').textContent = cur.dataset.v;
    scr.querySelector('.art').style.setProperty('--sw', cur.style.getPropertyValue('--sw'));
    scr.querySelector('.sub').textContent = `DPI · 第 ${[...cur.parentNode.children].indexOf(cur) + 1} 档 / 共 ${STAGES.length} 档`;
  };
  document.addEventListener('click', (e) => {
    const s = e.target.closest('.stage');
    if (!s || e.target.closest('.fader, .val, .x')) return;
    q('.stage', s.parentNode).forEach((el) => el.classList.remove('current'));
    s.classList.add('current');
    syncHero();
  });

  // 推子：按住拖动，吸附到 50 的倍数
  const drag = (f, clientX) => {
    const r = f.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - r.left - 5) / (r.width - 10)));
    const v = 50 + Math.round((pct * (MAX_DPI - 50)) / 50) * 50;
    f.style.setProperty('--fill', fillOf(v));
    const stage = f.closest('.stage');
    stage.dataset.v = v;
    stage.querySelector('.val').textContent = v;
    if (stage.classList.contains('current')) syncHero();
  };
  document.addEventListener('pointerdown', (e) => {
    const f = e.target.closest('.fader');
    if (!f) return;
    drag(f, e.clientX);
    const move = (ev) => drag(f, ev.clientX);
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });

  // URL 锚点 = 初始页（menu.html#2），方便逐页截图；要在监听注册完之后再触发
  const page = location.hash.slice(1);
  if (page) document.querySelector(`.menu [data-page="${page}"], .tabs [data-page="${page}"], .modes [data-page="${page}"]`)?.click();
}