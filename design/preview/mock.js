/**
 * 设计预览用的 Tauri 模拟层：没有 Rust 宿主时提供 window.__TAURI__，
 * 用一份模拟的 G24（8K 接收器 + PAW3950）应答 HID 命令，让真实界面离线跑起来。
 *
 * 只被 design/preview/*.html 注入，不参与打包。
 *
 * URL 参数：
 *   state=connected|off   设备是否在线（默认在线，并自动连接）
 *   auto=0                设备在线但不自动连接（录「连接过程」的动效时用）
 *   tab=dpi|buttons|performance|macro|lighting
 *   lang=zh|en            open=settings|lang        打开顶栏菜单
 *   profile=1..5          active=1..5               编辑中的配置 / 鼠标正在运行的配置
 *   battery=0..100        charging=1
 *   macro=0..10           让前 n 个宏槽位带内容
 *   debug                 左上角显示日志（步骤、横向溢出的元素）
 *   push=0..5             连接后模拟鼠标上报「切到第 n 档」（像按了 DPI 键）
 *   click=<选择器>        切页后点一下某个元素，可重复
 *   toast=文字            status=ok:文字|err:文字   底栏状态文字
 *   scale=auto|1|1.1|…    界面缩放
 *   mode=light|dark       明暗（默认跟随系统）
 */
(function () {
  const q = new URLSearchParams(location.search);
  const param = (k, d) => (q.has(k) ? q.get(k) : d);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  document.documentElement.dataset.mode =
    param('mode', '') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  // ── 模拟设备 ──────────────────────────────────────────────
  const ONLINE = param('state', 'connected') !== 'off';
  const D = {
    modelCode: 3, // G24
    receiverType: 2, // 8K 接收器
    sensorByte: 241, // PAW3950
    levels: 6,
    current: 1,
    dpi: [400, 800, 1600, 2400, 3200, 6400],
    rateCode: 4, // 8000Hz
    sensor: { 1: 1, 2: 0, 3: 0, 4: 1, 5: 2 }, // LOD / 波纹 / 直线 / MotionSync / 性能模式
    misc: { 1: 8, 2: [0, 0], 3: 60 }, // 去抖 / 火力键 / 休眠
    keys: [0x00f00001, 0x00f10001, 0x00f20001, 0x00f30001, 0x00f40001, 0x00030007],
    profile: 0,
    led: 0,
    battery: Number(param('battery', 72)),
    charging: param('charging', '0') === '1',
  };

  const LIST = ONLINE
    ? [
        // 枚举顺序与真机一致：Col01 在前、Col02 在后（打开时倒序优先 Col02）
        { vendorId: 0x093a, productId: 0x522c, path: '\\\\?\\hid#vid_093a&pid_522c&mi_00#7&2a1c9e40&0&0000#{c0a30a08-9e4f-4b8a-9f11-6c5a2d3e4f10}', serialNumber: 'A1B2C3D4', manufacturer: 'PixArt', product: 'incott 8K wireless mouse', isWireless: true },
        { vendorId: 0x093a, productId: 0x522c, path: '\\\\?\\hid#vid_093a&pid_522c&mi_01#7&3b2d1f51&0&0000#{c0a30a08-9e4f-4b8a-9f11-6c5a2d3e4f10}', serialNumber: 'A1B2C3D4', manufacturer: 'PixArt', product: 'incott 8K wireless mouse', isWireless: true },
      ]
    : [];

  let last = [0, 0, 0, 0, 0, 0, 0, 0]; // 最近一次写入的 8 字节数据区

  /** 写命令落到模拟设备上（预览里点「应用」后回读能对上） */
  function applyWrite(c) {
    if (c[0] > 0x80) return;
    const u16 = c[2] | (c[3] << 8);
    switch (c[0]) {
      case 1: D.rateCode = c[1]; break;
      case 2: if (D.dpi[c[1]] != null) D.dpi[c[1]] = 50 + u16 * 50; break;
      case 3: D.levels = c[1]; D.current = c[2]; break;
      case 4: D.sensor[c[1]] = c[2]; break;
      case 5: if (c[1] === 1) D.misc[1] = c[2]; else if (c[1] === 3) D.misc[3] = u16; break;
      case 6: if (c[1] === 9) D.profile = c[2]; else if (D.keys[c[1]] != null) D.keys[c[1]] = (c[2] | (c[3] << 8) | (c[4] << 16) | (c[5] << 24)) >>> 0; break;
      case 8: D.led = c[1]; break;
      default: break;
    }
  }

  /** 读命令的应答（8 字节数据区，buf[0] 回显命令码） */
  function answer(c) {
    const b = [0, 0, 0, 0, 0, 0, 0, 0];
    b[0] = c[0];
    switch (c[0]) {
      case 0x81: b[1] = D.rateCode; break;
      case 0x82: b[1] = c[1]; if (D.dpi[c[1]] != null) { const hw = Math.round((D.dpi[c[1]] - 50) / 50); b[2] = hw & 255; b[3] = hw >> 8; } break;
      case 0x83: b[1] = D.levels; b[2] = D.current; break;
      case 0x84: b[1] = c[1]; b[2] = D.sensor[c[1]] ?? 0; break;
      case 0x85:
        b[1] = c[1];
        if (c[1] === 3) { b[2] = D.misc[3] & 255; b[3] = D.misc[3] >> 8; } else b[2] = D.misc[1];
        break;
      case 0x86:
        b[1] = c[1];
        if (c[1] === 9) b[2] = D.profile;
        else { const k = (D.keys[c[1]] || 0) >>> 0; b[2] = k & 255; b[3] = (k >> 8) & 255; b[4] = (k >> 16) & 255; b[5] = (k >> 24) & 255; }
        break;
      case 0x88: b[1] = D.led; break;
      case 0x89: b[1] = D.battery + (D.charging ? 128 : 0); break;
      case 0x8f: b[1] = 1; b[2] = D.modelCode; b[3] = D.receiverType; b[5] = D.sensorByte; break;
      default: return [0, 0, 0, 0, 0, 0, 0, 0]; // 未知命令：设备不回显
    }
    return b;
  }

  // ── 事件总线（对应 Tauri event.listen / emit）────────────
  const listeners = new Map();
  const emit = (name, payload) => {
    for (const fn of [...(listeners.get(name) || [])]) {
      try {
        fn({ event: name, payload, id: 1 });
      } catch (e) {
        console.error(e);
      }
    }
  };
  const listen = (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return Promise.resolve(() => listeners.get(name).delete(fn));
  };

  const TRAY_STATUS = () => ({
    connected: ONLINE,
    name: ONLINE ? 'G24 Pro · 8K' : null, // 真机上来自 0x8F：G24 系列 + PAW3950，带 8K 接收器
    wireless: ONLINE,
    battery: ONLINE ? D.battery : null,
    charging: ONLINE && D.charging,
    dpi: ONLINE ? D.dpi[D.current] : null,
    dpiIndex: ONLINE ? D.current : null,
    levels: ONLINE ? D.levels : null,
    rate: ONLINE ? [1000, 500, 250, 125, 8000, 4000, 2000][D.rateCode] : null,
    profile: ONLINE ? D.profile : null,
    profileCount: 5,
  });

  // ── 命令分发（对应 Tauri core.invoke；失败时与 Rust 一样 reject 成字符串）──
  const invoke = async (cmd, args = {}) => {
    await sleep(3); // 模拟 IPC 往返
    switch (cmd) {
      case 'hid_list': return LIST;
      case 'hid_open':
        if (!ONLINE) throw '未找到 Incott 鼠标（VID 0x093A），请确认已插好或接收器在线';
        return LIST.find((d) => d.path === args.path) || LIST[0];
      case 'hid_close': return null;
      case 'hid_send_feature': last = args.bytes.slice(1); applyWrite(last); return null;
      case 'hid_get_feature': return [9, ...(ONLINE ? answer(last) : [0, 0, 0, 0, 0, 0, 0, 0])];
      case 'hid_write_output': return null;
      case 'settings_get': return { autoLaunch: true, silentStart: false, uiScale: param('scale', 'auto') };
      case 'settings_set': return { autoLaunch: !!args.patch?.autoLaunch, silentStart: !!args.patch?.silentStart, uiScale: args.patch?.uiScale || 'auto' };
      case 'get_app_info': return { version: '1.0.0', homepage: 'https://github.com/magnum-qin/incott-mouse-driver' };
      case 'tray_get_status': return TRAY_STATUS();
      case 'tray_refresh': emit('tray://status', TRAY_STATUS()); return null;
      default: return null; // tray_set_* / notify / show_about / export_file / import_file / open_url…
    }
  };

  const win = {
    minimize: async () => {},
    toggleMaximize: async () => {},
    isMaximized: async () => false,
    close: async () => {},
    show: async () => {},
    setFocus: async () => {},
    startDragging: () => {},
  };
  window.__TAURI__ = {
    core: { invoke },
    event: { listen, emit: async (name, payload) => emit(name, payload) },
    window: { getCurrentWindow: () => win },
  };

  // ── 预置数据：宏槽位 ─────────────────────────────────────
  const macroCount = Number(param('macro', '4'));
  if (Number.isFinite(macroCount)) {
    const K = { A: 0x04, D: 0x07, Q: 0x14, E: 0x08, R: 0x15, Space: 0x2c, LShift: 0xe1, LCtrl: 0xe0, w1: 0x1e, w2: 0x1f, w3: 0x20, w4: 0x21 };
    const lib = [
      { name: '急停跳投', loopType: 0, cycle: 1, items: [[1, K.D, 40], [1, K.Space, 0], [0, K.Space, 30], [0, K.D, 0], [1, K.A, 60], [0, K.A, 0]] },
      { name: '连点', loopType: 0, cycle: 1, items: [[1, K.w1, 35], [0, K.w1, 35]] },
      { name: '买甲 + 雷', loopType: 2, cycle: 1, items: [[1, K.w4, 30], [0, K.w4, 30], [1, K.Q, 30], [0, K.Q, 80], [1, K.E, 30], [0, K.E, 30]] },
      { name: '蹲扫', loopType: 1, cycle: 1, items: [[1, K.LCtrl, 0], [1, K.R, 120], [0, K.R, 0], [0, K.LCtrl, 40]] },
    ];
    const macros = [];
    for (let s = 0; s < 10; s++) {
      const m = s < macroCount ? lib[s % lib.length] : null;
      macros.push(
        m
          ? { slot: s, name: m.name, loopType: m.loopType, cycle: m.cycle, items: m.items.map(([press, keyCode, delay]) => ({ press: !!press, keyCode, delay })) }
          : { slot: s, name: `宏 ${s + 1}`, loopType: 2, cycle: 1, items: [] },
      );
    }
    localStorage.setItem('incott-config', JSON.stringify({ profile: 0, macros, currentMacro: 0 }));
  }

  // ── 预览自动化：把界面摆到参数指定的状态 ─────────────────
  const until = async (fn, ms = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        if (fn()) return true;
      } catch {
        /* 界面还没就绪 */
      }
      await sleep(30);
    }
    return false;
  };
  const click = (sel) => {
    const el = document.querySelector(sel);
    if (el) el.click();
    return !!el;
  };

  const desc = (n) =>
    n instanceof Element
      ? `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''}${
          typeof n.className === 'string' && n.className.trim() ? `.${n.className.trim().split(/\s+/).join('.')}` : ''
        }`
      : String(n);

  // debug：左上角叠一层日志，用来排查「界面停在哪个状态」「内容为什么被截断」
  const dbg = q.has('debug')
    ? (() => {
        const lines = [];
        let box = null;
        const render = () => {
          if (box) box.textContent = lines.slice(-16).join('\n');
        };
        addEventListener('DOMContentLoaded', () => {
          box = document.createElement('pre');
          box.style.cssText =
            'position:fixed;left:4px;top:60px;z-index:99999;max-width:calc(100vw - 8px);padding:6px 8px;' +
            'background:rgba(255,255,0,.92);color:#000;font:11px/1.35 Consolas,monospace;white-space:pre-wrap;' +
            'pointer-events:none;';
          document.body.appendChild(box);
          render();
        });
        return (msg) => {
          lines.push(`${Math.round(performance.now())}ms ${msg}`);
          render();
        };
      })()
    : () => {};

  // still：除了关掉 CSS 过渡与动画（那条规则在 index.html 里），还要让界面走「系统减少了动画」的分支。
  // 换页、补位、显隐用的是 Web Animations API，不受 CSS 规则约束；而截图用的虚拟时间里
  // 动画帧不一定走得到，动画会一直挂在「待开始」，页面停在半路。
  // 顺带的好处：每张静态截图都在验证应用的「减少动画」路径。
  if (q.has('still')) {
    const matchMedia = window.matchMedia.bind(window);
    const never = () => {};
    window.matchMedia = (query) => (/\bprefers-reduced-motion\b/.test(query)
      ? { matches: true, media: query, onchange: false, addListener: never, removeListener: never, addEventListener: never, removeEventListener: never, dispatchEvent: () => false }
      : matchMedia(query));
  }

  // 联系表里多个预览并排时，后打开菜单的 iframe 会抢走前面 iframe 的焦点，
  // 触发它们的 focusout 把菜单收起（界面本身「焦点离开菜单即收起」是对的，真机只有一个窗口）。
  // 预览指定了 open= 就按住菜单不关。
  if (param('open', '')) {
    addEventListener(
      'focusout',
      (e) => {
        if (e.target instanceof Element && e.target.closest('.settings-menu, .lang-menu')) e.stopPropagation();
      },
      true,
    );
  }

  async function run() {
    if (q.get('page') === 'popover') {
      // 托盘浮层页：没有设备连接流程，等首帧画完即可。（本脚本在 head 里就执行，
      // 那时 body 还没解析，不能靠查元素来判断是哪一页）
      await sleep(200);
      // 浮层页没有语言菜单：lang= 走和真机一样的路径——主进程发 app://lang 事件
      const lang = param('lang', 'zh');
      if (lang !== window.i18n.getLang()) emit('app://lang', lang);
      await sleep(60);
      document.documentElement.dataset.ready = '1';
      await reportOverflow();
      return;
    }
    await until(() => document.querySelector('#dpiList')?.children.length > 0);
    const lang = param('lang', 'zh');
    if (lang !== 'zh') click(`.lang-option[data-lang="${lang}"]`);
    await sleep(60);

    if (ONLINE && param('auto', '1') !== '0') {
      click('#connectBtn');
      await until(
        () =>
          document.querySelector('#deviceLed')?.classList.contains('ok') &&
          document.querySelector('#deviceSpinner')?.classList.contains('hidden'),
      );
    }
    await sleep(150);

    const push = param('push', '');
    if (push !== '') {
      const idx = Number(push);
      emit('hid://data', [72, (idx << 4) | D.rateCode, D.profile << 6, 0, 0, 0, 0]); // 不含 reportId（Rust 侧已剥离）
      await sleep(120);
    }

    const profile = Number(param('profile', '0'));
    if (profile > 0) {
      click(`#profileBar [data-profile="${profile - 1}"]`);
      await sleep(260); // 等切换提示淡出
    }

    const tab = param('tab', 'dpi');
    if (tab !== 'dpi') click(`.menu [data-page="${tab}"]`);
    // click=<选择器>：切页后点一下某个元素（拍「有未应用修改」这类状态用）
    for (const sel of q.getAll('click')) {
      click(sel);
      await sleep(60);
    }
    const open = param('open', '');
    if (open === 'settings') click('#settingsBtn');
    if (open === 'lang') click('#langBtn');

    const status = param('status', '');
    if (status) {
      const [kind, ...rest] = status.split(':');
      document.querySelector('#applyState').classList.remove('hidden');
      document.querySelector('#applyLed').className = `led ${kind}`;
      const el = document.querySelector('#applyStateText');
      el.textContent = rest.join(':');
      el.title = el.textContent;
      el.className = `status-text${kind === 'bad' ? ' err' : ''}`;
    }
    // 连接流程收尾时会挂一个「160ms 后隐藏通知条」的定时器（真机里显示通知条会先清掉它），
    // 这里是直接改 class，得等它走完，否则刚显示就被隐藏
    await sleep(220);
    const toast = param('toast', '');
    if (toast) {
      const el = document.querySelector('#toast');
      el.textContent = toast;
      el.classList.remove('hidden');
      el.classList.add('show');
    }
    document.documentElement.dataset.ready = '1';

    await reportOverflow();
  }

  /** debug：列出横向超出窗口的元素（查「内容被截断」这类问题） */
  async function reportOverflow() {
    if (q.has('debug')) {
      await sleep(100);
      const wide = [...document.querySelectorAll('body, body *')]
        .map((n) => [n, n.getBoundingClientRect()])
        .filter(([, r]) => r.right > innerWidth + 0.5 && r.width > 0)
        .slice(0, 8)
        .map(([n, r]) => `${desc(n)} w=${Math.round(r.width)} right=${Math.round(r.right)}`);
      dbg(`viewport=${innerWidth}x${innerHeight} docW=${document.documentElement.scrollWidth} 超宽: ${wide.join(" | ") || "无"}`);
    }
  }

  run().catch((e) => console.error('[preview]', e));
})();
