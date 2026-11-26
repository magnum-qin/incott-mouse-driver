/**
 * 连接跟随：鼠标在接收器和线缆之间移动时，应用连着的那条路该怎么换。纯函数，单测覆盖。
 *
 * 背景（2026-11-25 在 G24 Pro 上实测，见 docs/protocol.md §4）：
 *  - 进了软件就自动连接；没连上的时候设备出现（接收器插回来）也自动连。用户点过「断开」之后不再自动连
 *  - 应用一次只连一个接口。鼠标插上线后，系统里多出「有线鼠标」这台设备；接收器虽然还插着，
 *    却不应答读命令、也不再上报——连着它等于连着一个空壳。
 *  - 拔线后有线接口消失，鼠标回到接收器上。
 *
 * list 的每一项是 hid_list 的条目：{ path, isWireless, … }
 */

/**
 * 连接该怎么动：
 *   'stay'     不用动
 *   'connect'  还没连上，但已经有可以连的接口 → 连它（刚进软件、或者没连上的时候设备出现了）
 *   'toWired'  连着接收器，鼠标插上了线 → 换到有线
 *   'gone'     连着的接口不见了（拔线 / 接收器被拔）→ 试剩下的接口
 */
export function linkAction(current, list) {
  if (!current) return list.length ? 'connect' : 'stay';
  if (!list.some((d) => d.path === current.path)) return 'gone';
  if (current.isWireless && list.some((d) => !d.isWireless)) return 'toWired';
  return 'stay';
}

/**
 * 打开顺序：枚举靠后的先试。有线鼠标有 Col01 / Col02 两个接口，只有靠后的 Col02 能通信
 * （Col01 发 Feature Report 会失败）。
 */
export function openOrder(list, keep = () => true) {
  return [...list].reverse().filter(keep);
}

/**
 * 读配置的结果里，设备到底应答了没有。读配置是「单项失败留空」，接收器在鼠标休眠时照样收下命令、
 * 只是读回来一整份空快照——这时界面显示的是本地保存的值，不是鼠标上的，得等设备醒了补读
 */
export function deviceAnswered(snap) {
  return !!(snap && (snap.rate != null || snap.levels != null || (snap.slots && snap.slots.length > 0)));
}
