/**
 * 电量防抖：把设备的原始读数变成给人看的稳定值。纯函数状态机，单测覆盖。
 *
 * 有线时鼠标每 3 秒上报一次电量，接近满电时读数在相邻两个值之间来回跳（实测 96 / 97，
 * 同一个值最多连续 5 次）。直接显示的话数字每几秒闪一下。
 *
 * 规则：和当前显示值相差 2 以上才换，只差 1 的保持不动——±1 的抖动完全看不出来，
 * 显示值始终和真实值相差不到 2。充到 100% 时直接采纳，免得满电了还停在 99。
 */
export function createSteadyBattery() {
  let shown = null;
  return {
    /** 喂一个原始读数，返回现在该显示的值 */
    push(level) {
      if (shown == null || level === 100 || Math.abs(level - shown) >= 2) shown = level;
      return shown;
    },
    /** 换了一条连接（上报来源变了）：下一个读数直接采纳 */
    reset() {
      shown = null;
    },
  };
}

/**
 * 上一次知道的电量，存成一行 JSON（localStorage 里的 `incott-battery-memory`）。
 *
 * 无线（8K 接收器）时读命令不带电量，电量只能等鼠标上报；鼠标睡着以后既不应答读命令也不上报
 * （docs/protocol.md §4）。所以刚启动、刚换路、刚重连的那一会儿，手里可能什么读数都没有。
 * 这时先把上一次知道的电量拿出来显示（界面上注明是上一次的），等鼠标上报了再换掉。
 *
 * 这里的 parseBatteryMemory 是纯函数：怎么存取由桥接层做，单测只测这一段。
 */
export function parseBatteryMemory(raw) {
  if (!raw) return null;
  let m;
  try {
    m = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const { level, charging, at } = m;
  if (!Number.isInteger(level) || level < 0 || level > 100) return null;
  if (typeof charging !== 'boolean' || !Number.isFinite(at)) return null;
  return { level, charging, at };
}
