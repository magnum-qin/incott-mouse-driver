/**
 * 桥接层核心 —— 设备生命周期 + HID 协议编排。
 *
 * 平移自上游 src/main/index.js（IPC handlers、EXEC/READ 分发表、托盘状态机）
 * 与 src/main/hid.js（两轮打开重试、断连分发）。差异只有两点：
 *  - HID 读写走 Tauri invoke（Rust hidapi），字节布局完全一致
 *  - 主进程推送（webContents.send）改为本地订阅（本模块就运行在主窗口里）
 */

import * as P from '../shared/protocol.js';
import * as i18n from '../shared/i18n.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 全局状态（对应上游 main/index.js 顶部）─────────────────
let device = null; // 当前设备（Rust 持有真实句柄）：{ path, productId, product, isWireless }
let deviceInfo = null; // 0x8F 型号信息（parseModelInfo 结果）
let batteryLevel = null; // 最近一次读到的电量（托盘显示）
let batteryCharging = false;
let lastPushDpi = null; // 上一次推送的 DPI 索引（检测鼠标 DPI 键切换）
let lastPushProfile = null; // 上一次推送的配置序号（检测鼠标上的配置切换键）
let writing = false; // 写操作进行中（电量轮询跳过，避免打断 apply/宏上传序列）
let batteryTimer = null;

// 本地订阅（替代 webContents.send）
const subs = { battery: [], toast: [], profile: [], disconnected: [] };
const emitSub = (name, arg) => {
  for (const cb of subs[name]) {
    try {
      cb(arg);
    } catch (_) {
      /* 回调异常不影响其它监听者 */
    }
  }
};

// ── 枚举缓存（TTL 10s；保留上游两轮重试的结构）──────────────
let deviceCache = null;
let cacheAt = 0;
let enumeratePromise = null;
const CACHE_TTL_MS = 10000;

function invalidateCache() {
  deviceCache = null;
  cacheAt = 0;
  enumeratePromise = null;
}

async function listDevicesAsync(force = false) {
  if (force) invalidateCache();
  if (deviceCache && Date.now() - cacheAt < CACHE_TTL_MS) return deviceCache;
  if (enumeratePromise) return enumeratePromise;
  enumeratePromise = invoke('hid_list')
    .then((list) => {
      deviceCache = list;
      cacheAt = Date.now();
      enumeratePromise = null;
      return list;
    })
    .catch((e) => {
      enumeratePromise = null;
      throw e;
    });
  return enumeratePromise;
}

// ── 设备操作原语（对应上游 MouseDevice 的三个方法）──────────
function devOps() {
  return {
    /** 发送 Feature Report（8 字节数据区 + reportId=9） */
    sendFeatureReport: (data) => invoke('hid_send_feature', { bytes: [P.REPORT_ID, ...data] }),
    /** 读取 Feature Report（返回已剥离 reportId 的数据区） */
    getFeatureReport: async (len = P.REPORT_DATA_LEN) => {
      const raw = await invoke('hid_get_feature', { len });
      return new Uint8Array(raw).slice(1);
    },
    /** 发送 Output Report（宏分块上传等） */
    sendReport: (data) => invoke('hid_write_output', { bytes: [P.REPORT_ID, ...data] }),
  };
}

// ── HID 串行队列（上游 withIo：feature 读写共用通道，并发会互相顶掉响应）──
let ioQueue = Promise.resolve();
function withIo(fn) {
  const run = ioQueue.then(fn, fn); // 前一次失败也要继续，否则队列会永久卡死
  ioQueue = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** node-hid / hidapi 在设备拔出时的错误特征 */
function isDeviceGoneError(e) {
  const m = String((e && e.message) || e || '');
  return /hid_read_timeout|GetOverlappedResult|0x0000048F|0x48F|not connected|device not found|cannot open device|0x00000002|HidD_|IO 线程已退出|Windows error/i.test(m);
}

async function withDevice(fn) {
  if (!device) throw new Error('设备未连接，请先连接鼠标');
  return withIo(async () => {
    if (!device) throw new Error('设备未连接，请先连接鼠标');
    try {
      return await fn(devOps());
    } catch (e) {
      if (isDeviceGoneError(e)) {
        handleDeviceGone(e);
        throw new Error('鼠标已断开（被拔出或接收器掉线），请重新连接');
      }
      throw e;
    }
  });
}

/** 设备拔出/掉线：清理状态、托盘复位、通知界面回到未连接 */
function handleDeviceGone(err, fromPath) {
  if (!device) return; // 已处理过，避免重复
  // 旧连接的迟到错误不能误伤新连接（Rust 事件带 path）
  if (fromPath && fromPath !== device.path) return;
  console.warn('[hid] 设备已断开:', String((err && err.message) || err || ''));
  device = null;
  deviceInfo = null;
  lastPushDpi = null;
  lastPushProfile = null;
  invalidateCache(); // 重新插上后接口路径可能变化
  invoke('hid_close').catch(() => {}); // 清掉 Rust 侧残余状态（IO 线程可能已退出）
  resetQuickStatus();
  updateTrayBattery(null);
  emitSub('disconnected', undefined);
}

// ── 操作分发表：action → 命令构造器（上游原样平移）──────────
const EXEC_ACTIONS = {
  // 非 8K 接收器/有线时 2000Hz+ 会被硬件钳制为 1000Hz（实机验证），提前在应用层钳制
  setRate: (hz) => P.buildSetRate(P.clampRate(hz, deviceInfo ? deviceInfo.is8KReceiver : null)),
  setDpi: (index, dpi, flag, color) => P.buildSetResolution(index, P.dpiToHw(dpi), flag || 0, color),
  setDpiLevel: (levels, curIndex) => P.buildSetDpiLevel(levels, curIndex),
  // PAW3950 的 LOD 需按官方 apply 流程做 UI→硬件码旋转（0→2, 1→0, 2→1）
  setLod: (hw) => P.buildSetLod(P.lodToHw(hw, deviceInfo ? deviceInfo.sensor : null)),
  setRipple: (on) => P.buildSetRipple(on),
  setAngleSnap: (on) => P.buildSetAngleSnap(on),
  setMotionSync: (on) => P.buildSetMotionSync(on),
  setSensorMode: (mode) => P.buildSetSensorMode(mode),
  setDebounce: (t) => P.buildSetDebounce(t),
  setFireKey: (loop, interval) => P.buildSetFireKey(loop, interval),
  setSleepTime: (t) => P.buildSetSleepTime(t),
  setKey: (index, keyType, keyValue) => {
    let code;
    switch (keyType) {
      case 'mouse':
        code = P.encodeMouseKey(keyValue);
        break;
      case 'keyboard': {
        const hidCode = P.HID_KEY_CODES[keyValue];
        if (hidCode == null) throw new Error(`未知键盘键: ${keyValue}`);
        code = P.encodeKeyboardKey(hidCode, 0);
        break;
      }
      case 'media':
        code = P.encodeMediaKey(keyValue);
        break;
      case 'macro':
        code = P.encodeMacroKey(parseInt(keyValue, 10));
        break;
      default:
        throw new Error(`未知按键类型: ${keyType}`);
    }
    return P.buildSetKey(index, code);
  },
  // 原样写回 32 位键码（读设备时反解不出来的自定义键）
  setKeyRaw: (index, code32) => P.buildSetKey(index, code32 >>> 0),
  setProfile: (index) => P.buildSetProfile(index),
  setReceiverLed: (mode) => P.buildSetReceiverLed(mode),
};

// ── 读取分发表：readType → { builder, parse }（上游原样平移）──
const READ_ACTIONS = {
  rate: {
    build: () => P.buildReadRate(),
    parse: (buf) => {
      const entry = P.RATE_TABLE.find((r) => r.code === buf[1]);
      return entry ? entry.hz : null;
    },
  },
  resolution: {
    build: (slot) => P.buildReadResolution(slot),
    parse: (buf) => ({
      dpi: P.hwToDpi(buf[2] | (buf[3] << 8)),
      color: P.bytesToColor(buf),
    }),
  },
  dpiLevel: {
    build: () => P.buildReadDpiLevel(),
    parse: (buf) => ({ levels: buf[1], current: buf[2] }),
  },
  sensor: {
    build: (sub) => P.buildReadSensor(sub),
    parse: (buf) => buf[2],
  },
  misc: {
    build: (sub) => P.buildReadMisc(sub),
    parse: (buf, sub) => {
      if (sub === 2) return { loops: buf[2], interval: buf[3] };
      if (sub === 3) return buf[2] | (buf[3] << 8);
      return buf[2];
    },
  },
  receiverLed: {
    build: () => P.buildReadReceiverLed(),
    parse: (buf) => buf[1],
  },
  // 0x86,9：当前配置序号在 buf[2]
  profileIndex: {
    build: () => P.buildReadKey(9),
    parse: (buf) => buf[2],
  },
  modelInfo: {
    build: () => P.buildReadModelInfo(),
    parse: (buf) => {
      const info = P.parseModelInfo(buf, device ? device.isWireless : false);
      if (!info) throw new Error('型号信息解析失败');
      return info;
    },
  },
  battery: {
    build: () => P.buildReadBattery(),
    parse: (buf) => {
      const raw = buf[1];
      return raw > 100 ? raw - 128 : raw;
    },
  },
  key: {
    build: (index) => P.buildReadKey(index),
    parse: (buf) => (buf[5] << 24) | (buf[4] << 16) | (buf[3] << 8) | buf[2],
  },
  matchInfo: {
    build: () => P.buildReadMatchInfo(),
    parse: (buf) => ({ online: buf[6] === 1 }),
  },
};

// ── 读取序列（上游时序原样保留）────────────────────────────
async function readBatteryValue() {
  if (!device) return null;
  const dev = devOps();
  await dev.sendFeatureReport(P.buildReadBattery());
  await sleep(50);
  const buf = await dev.getFeatureReport(P.REPORT_DATA_LEN);
  if (buf[0] !== 0x89) return null;
  const raw = buf[1];
  const charging = raw > 100;
  const level = charging ? raw - 128 : raw;
  if (level < 0 || level > 100) return null;
  // 设备休眠时可能回显 0x89 但数据区全 0 —— 真实电量 0% 已关机，视为无效读取
  if (level === 0) return null;
  return { level, charging };
}

async function readDeviceInfo() {
  if (!device) return null;
  try {
    const dev = devOps();
    await dev.sendFeatureReport(P.buildReadModelInfo());
    await sleep(50);
    const buf = await dev.getFeatureReport(P.REPORT_DATA_LEN);
    return P.parseModelInfo(buf, device.isWireless);
  } catch (_) {
    return null;
  }
}

/** 一次读出整套配置（连接时对齐 UI；单项失败置 null 不影响整体） */
async function readConfigSnapshot() {
  const dev = devOps();
  const read = async (bytes, wait = 45) => {
    await dev.sendFeatureReport(bytes);
    await sleep(wait);
    return dev.getFeatureReport(P.REPORT_DATA_LEN);
  };
  const opt = async (bytes, fn, wait) => {
    try {
      const buf = await read(bytes, wait);
      return buf[0] === bytes[0] ? fn(buf) : null;
    } catch (_) {
      return null;
    }
  };

  const sensor = deviceInfo ? deviceInfo.sensor : null;
  const snap = {
    profileIndex: null,
    levels: null,
    current: null,
    slots: [],
    rate: null,
    lod: null,
    ripple: null,
    angleSnap: null,
    motionSync: null,
    sensorMode: null,
    debounce: null,
    sleepTime: null,
    buttons: [],
    receiverLed: null,
  };

  snap.profileIndex = await opt(P.buildReadKey(9), (b) => b[2]);

  const dpiLevel = await opt(P.buildReadDpiLevel(), (b) => ({ levels: b[1], current: b[2] }));
  if (dpiLevel) {
    snap.levels = Math.min(Math.max(dpiLevel.levels, 1), 6);
    snap.current = Math.min(Math.max(dpiLevel.current, 0), snap.levels - 1);
  }
  // 档位数读不到时按 6 档探一遍（0x82 对任意 slot 都会回值）
  for (let i = 0; i < (snap.levels || 6); i++) {
    const slot = await opt(P.buildReadResolution(i), (b) => ({
      dpi: P.hwToDpi(b[2] | (b[3] << 8)),
      color: P.bytesToColor(b),
    }));
    if (slot) snap.slots.push(slot);
  }

  snap.rate = await opt(P.buildReadRate(), (b) => {
    const entry = P.RATE_TABLE.find((r) => r.code === b[1]);
    return entry ? entry.hz : null;
  });
  const lodHw = await opt(P.buildReadSensor(1), (b) => b[2]);
  snap.lod = lodHw == null ? null : P.lodFromHw(lodHw, sensor);
  snap.ripple = await opt(P.buildReadSensor(2), (b) => b[2] === 1);
  snap.angleSnap = await opt(P.buildReadSensor(3), (b) => b[2] === 1);
  snap.motionSync = await opt(P.buildReadSensor(4), (b) => b[2] === 1);
  snap.sensorMode = await opt(P.buildReadSensor(5), (b) => b[2]);
  snap.debounce = await opt(P.buildReadMisc(1), (b) => b[2]);
  snap.sleepTime = await opt(P.buildReadMisc(3), (b) => P.nearestSleepStep(b[2] | (b[3] << 8)));

  for (let i = 0; i < 6; i++) {
    const code = await opt(P.buildReadKey(i), (b) => ((b[5] << 24) | (b[4] << 16) | (b[3] << 8) | b[2]) >>> 0);
    if (code != null) snap.buttons.push(code);
  }

  if (deviceInfo && deviceInfo.is8KReceiver) {
    snap.receiverLed = await opt(P.buildReadReceiverLed(), (b) => b[1]);
  }
  return snap;
}

function deviceState() {
  return device
    ? {
        opened: true,
        productId: device.productId,
        isWireless: device.isWireless,
        path: device.path,
        modelInfo: deviceInfo,
      }
    : { opened: false };
}

function getConstants() {
  return {
    rateTable: P.RATE_TABLE,
    lodTable: P.LOD_TABLE,
    ledModeTable: P.LED_MODE_TABLE,
    sleepSteps: P.SLEEP_STEPS,
    profileCount: P.PROFILE_COUNT,
    mouseKeys: Object.keys(P.MOUSE_KEYS),
    mediaKeys: Object.keys(P.MEDIA_KEYS),
    mouseKeyCodes: P.MOUSE_KEYS,
    mediaKeyCodes: P.MEDIA_KEYS,
    modifiers: P.MODIFIERS,
    hidKeyCodes: P.HID_KEY_CODES,
    keyMatrix: P.KEY_MATRIX,
    sensors: {
      PAW3395: { id: P.SENSOR.PAW3395, maxDpi: P.maxDpiForSensor(P.SENSOR.PAW3395) },
      PAW3950: { id: P.SENSOR.PAW3950, maxDpi: P.maxDpiForSensor(P.SENSOR.PAW3950) },
    },
    dpiStep: 50,
    dpiMin: 50,
  };
}

// ── 设备打开（两轮重试：缓存倒序 Col02 优先 → 强制重新枚举）──
async function attemptOpen(list) {
  let lastErr = null;
  for (const d of list) {
    try {
      const entry = await invoke('hid_open', { path: d.path });
      return { entry, err: null };
    } catch (e) {
      lastErr = e;
    }
  }
  return { entry: null, err: lastErr };
}

async function openDevice(pathArg) {
  // 打开也进队列：设备切换期间不能让轮询/浮层读插进来
  const opened = await withIo(async () => {
    if (device) {
      try {
        await invoke('hid_close');
      } catch (_) {
        /* 句柄可能已失效 */
      }
    }
    const cached = deviceCache || [];
    let first = pathArg ? cached.filter((d) => d.path === pathArg) : [...cached].reverse();
    if (pathArg && first.length === 0) first = [{ path: pathArg }]; // 指定 path 但不在缓存里，直接试
    if (first.length) {
      const r1 = await attemptOpen(first);
      if (r1.entry) return r1.entry;
    }
    // 第二轮：缓存可能已过期（设备切换 8K/有线无线模式后会重新枚举，旧路径失效）
    invalidateCache();
    const fresh = await listDevicesAsync(true);
    if (fresh.length === 0) {
      throw new Error('未找到 Incott 鼠标（VID 0x093A），请确认已插好或接收器在线');
    }
    const second = pathArg ? fresh.filter((d) => d.path === pathArg) : [...fresh].reverse();
    const r2 = await attemptOpen(second.length ? second : [...fresh].reverse());
    if (r2.entry) return r2.entry;
    throw new Error(
      `无法打开鼠标${r2.err ? `（${String(r2.err.message || r2.err).slice(0, 120)}）` : ''}——设备可能刚切换模式仍在重新枚举，请稍等 2 秒重试`,
    );
  });
  device = opened;
  deviceInfo = await withIo(() => readDeviceInfo()); // 连接即识别型号/传感器/8K 接收器（失败为 null）
  lastPushDpi = null; // 新连接重新建立推送基线
  lastPushProfile = null;
  pollBattery(); // 连接后立即读一次电量更新托盘
  refreshQuickStatus(); // 浮层用的 DPI/回报率/配置（后台补读，不阻塞连接返回）
  return deviceState();
}

// ── api 方法（对应 mouse:* IPC）────────────────────────────
async function exec(action, ...args) {
  const builder = EXEC_ACTIONS[action];
  if (!builder) throw new Error(`未知操作: ${action}`);
  const cmdBytes = builder(...args);
  writing = true;
  try {
    return await withDevice((dev) => dev.sendFeatureReport(cmdBytes).then(() => true));
  } finally {
    writing = false;
  }
}

async function read(readType, ...args) {
  if (readType === 'battery') {
    const val = await withDevice(() => readBatteryValue());
    if (val == null) throw new Error('设备未响应（可能处于休眠状态）');
    updateTrayBattery(val.level, val.charging); // 手动刷新同步托盘
    return val;
  }
  const def = READ_ACTIONS[readType];
  if (!def) throw new Error(`未知读取: ${readType}`);
  const cmdBytes = def.build(...args);
  return withDevice(async (dev) => {
    await dev.sendFeatureReport(cmdBytes);
    await sleep(50);
    const buf = await dev.getFeatureReport(P.REPORT_DATA_LEN);
    // 设备休眠/无响应时返回全 0（无命令回显），视为无效读取
    if (buf[0] !== cmdBytes[0]) {
      throw new Error('设备未响应（可能处于休眠状态）');
    }
    return def.parse(buf, ...args);
  });
}

async function readConfig() {
  const snap = await withDevice(() => readConfigSnapshot());
  // 顺带把配置序号同步给托盘浮层
  if (snap && snap.profileIndex != null) {
    quick.profile = snap.profileIndex;
    broadcastTrayStatus();
  }
  return snap;
}

async function apply(ops) {
  writing = true;
  try {
    return await withDevice(async (dev) => {
      for (const op of ops) {
        const { action, args = [] } = op;
        const builder = EXEC_ACTIONS[action];
        if (!builder) throw new Error(`未知操作: ${action}`);
        await dev.sendFeatureReport(builder(...args));
        await sleep(op.delay ?? 200);
      }
      return true;
    });
  } finally {
    writing = false;
  }
}

async function uploadMacro(macro) {
  if (macro == null || typeof macro.slot !== 'number') {
    throw new Error('宏数据无效');
  }
  if (macro.uid == null) macro.uid = Date.now() >>> 0;
  const bytes = P.encodeMacro(macro);
  const slot = macro.slot & 0xff;
  writing = true;
  try {
    return await withDevice(async (dev) => {
      for (let i = 0; i < 10; i++) {
        await dev.sendFeatureReport(P.buildMacroBlock(10, i, slot));
        await sleep(80);
        await dev.sendReport(bytes.slice(i * 32, i * 32 + 32));
        await sleep(80);
      }
      return true;
    });
  } finally {
    writing = false;
  }
}

// ── 托盘状态机（对应上游 quick / refreshQuickStatus / trayStatus）──
const quick = { dpi: null, dpiIndex: null, levels: null, rate: null, profile: null };
let refreshingQuick = false;

function resetQuickStatus() {
  quick.dpi = null;
  quick.dpiIndex = null;
  quick.levels = null;
  quick.rate = null;
  quick.profile = null;
}

function trayStatus() {
  return {
    connected: !!device,
    name: deviceInfo
      ? [deviceInfo.model, deviceInfo.is8KReceiver ? '8K' : ''].filter(Boolean).join(' ')
      : null,
    wireless: device ? !!device.isWireless : false,
    battery: batteryLevel,
    charging: batteryCharging,
    dpi: quick.dpi,
    dpiIndex: quick.dpiIndex,
    levels: quick.levels,
    rate: quick.rate,
    profile: quick.profile,
    profileCount: P.PROFILE_COUNT,
  };
}

/** 状态推送（Rust 缓存，浮层可见时才转发给它） */
function broadcastTrayStatus() {
  invoke('tray_set_status', { status: trayStatus() }).catch(() => {});
}

/** 读一次 DPI 档位、当前档 DPI、回报率（3 条命令，约 150ms）；单项失败保持旧值 */
async function refreshQuickStatus() {
  if (!device || writing || refreshingQuick) return;
  refreshingQuick = true;
  try {
    await withIo(async () => {
      if (!device) return;
      const dev = devOps();
      const read = async (bytes) => {
        await dev.sendFeatureReport(bytes);
        await sleep(45);
        return dev.getFeatureReport(P.REPORT_DATA_LEN);
      };
      const lv = await read(P.buildReadDpiLevel());
      if (lv[0] === 0x83) {
        quick.levels = Math.min(Math.max(lv[1], 1), 6);
        quick.dpiIndex = Math.min(Math.max(lv[2], 0), quick.levels - 1);
      }
      const res = await read(P.buildReadResolution(quick.dpiIndex == null ? 0 : quick.dpiIndex));
      if (res[0] === 0x02) quick.dpi = P.hwToDpi(res[2] | (res[3] << 8));
      const rate = await read(P.buildReadRate());
      if (rate[0] === 0x01) {
        const entry = P.RATE_TABLE.find((r) => r.code === rate[1]);
        if (entry) quick.rate = entry.hz;
      }
    });
  } catch (e) {
    if (isDeviceGoneError(e)) handleDeviceGone(e);
    return;
  } finally {
    refreshingQuick = false;
  }
  broadcastTrayStatus();
}

function updateTrayBattery(battery, charging) {
  batteryLevel = battery;
  if (charging != null) batteryCharging = charging;
  if (battery == null) batteryCharging = false;
  invoke('tray_set_battery', { level: battery, charging: batteryCharging }).catch(() => {});
  broadcastTrayStatus();
}

async function pollBattery() {
  if (!device || writing) return; // 未连接或正在写，跳过本次
  try {
    const val = await withIo(() => readBatteryValue());
    if (val != null) updateTrayBattery(val.level, val.charging);
  } catch (e) {
    if (isDeviceGoneError(e)) handleDeviceGone(e);
  }
}

/** DPI 键切换提示：窗口可见时发 toast，否则走系统通知 */
function notifyDpiSwitch(s) {
  const parts = [i18n.t('dpiSwitchToast').replace('{n}', s.dpiIndex + 1)];
  if (s.rate) parts.push(`${s.rate}Hz`);
  parts.push(`${i18n.t('batteryLabel')} ${s.power}%${s.charging ? '⚡' : ''}`);
  const text = parts.join(' · ');
  if (document.visibilityState === 'visible' && !document.hidden) {
    emitSub('toast', text);
  } else {
    invoke('notify', { title: 'Incott Mouse Driver', body: text }).catch(() => {});
  }
}

// ── 设备主动上报（Input Report：电量/DPI/回报率/配置变化）────
function onData(buf) {
  if (!device) return;
  const s = P.parseStatusPush(buf);
  if (!s) return;
  if (s.power !== batteryLevel || s.charging !== batteryCharging) {
    updateTrayBattery(s.power, s.charging);
  }
  emitSub('battery', { level: s.power, charging: s.charging });
  // 浮层的 DPI/回报率/配置跟着推送走；换了档位要补读该档的 DPI 数值
  if (s.dpiIndex !== quick.dpiIndex) {
    quick.dpiIndex = s.dpiIndex;
    refreshQuickStatus();
  }
  if (s.rate != null) quick.rate = s.rate;
  quick.profile = s.profileIndex;
  broadcastTrayStatus();
  if (lastPushDpi != null && s.dpiIndex !== lastPushDpi) {
    notifyDpiSwitch(s);
  }
  lastPushDpi = s.dpiIndex;
  // 鼠标上的配置切换键：硬件只改序号标记，真正的配置由界面把预设灌进去
  if (s.profileIndex !== lastPushProfile) {
    const changed = lastPushProfile != null;
    lastPushProfile = s.profileIndex;
    if (changed) emitSub('profile', s.profileIndex);
  }
}

// ── 导出给 preload-shim 组装 window.api ────────────────────
export const api = {
  listDevices: () => listDevicesAsync(),
  openDevice: (path) => openDevice(path),
  closeDevice: () =>
    withIo(async () => {
      if (device) {
        try {
          await invoke('hid_close');
        } catch (_) {
          /* 已关闭 */
        }
      }
      device = null;
      deviceInfo = null;
      lastPushDpi = null;
      lastPushProfile = null;
      invalidateCache();
      resetQuickStatus();
      updateTrayBattery(null); // 托盘电量归零为「未连接」
      return deviceState();
    }),
  getState: () => Promise.resolve(deviceState()),
  getConstants: () => Promise.resolve(getConstants()),
  exec,
  read,
  readConfig,
  apply,
  uploadMacro,
  onProfile: (cb) => subs.profile.push(cb),
  onBattery: (cb) => subs.battery.push(cb),
  onToast: (cb) => subs.toast.push(cb),
  onDisconnected: (cb) => subs.disconnected.push(cb),
};

/** 启动：事件订阅 + 预枚举 + 电量轮询（对应上游 whenReady 里的初始化） */
export async function boot() {
  await listen('hid://data', (ev) => {
    onData(new Uint8Array(ev.payload));
  });
  await listen('hid://error', (ev) => {
    const p = ev.payload || {};
    handleDeviceGone(new Error(p.message || 'hid error'), p.path);
  });
  // 浮层弹出/请求刷新时补读实时状态
  await listen('tray://refresh', () => {
    refreshQuickStatus();
  });
  listDevicesAsync().catch(() => {}); // 后台预枚举（连接时秒开）
  if (!batteryTimer) {
    batteryTimer = setInterval(pollBattery, 60000);
  }
}
