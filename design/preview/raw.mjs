/**
 * 真机协议探针：对**真实设备**发一条读命令，取回原始字节。
 *
 *   1) 先按 live.mjs 的说明带调试端口启动应用，并在界面里连上鼠标
 *   2) node design/preview/raw.mjs                 跑内置的几条读命令
 *      node design/preview/raw.mjs 0x89 0 60       指定：命令码（带 0x）[参数] [等多少 ms 再取]
 *
 * 只发读命令（0x81~0x8F），写命令一律拒绝——这个工具不会改动鼠标里的任何设置。
 * 输出的是 Feature Report 的原始字节（含首字节 reportId=9），用来核对协议文档
 * （比如 2026-11-23 就是这样发现 G24 Pro 无线模式下 0x89 不带电量，见 docs/protocol.md §4）。
 */

const PORT = Number(process.env.LIVE_PORT || 9333);
const BASE = `http://127.0.0.1:${PORT}`;

const list = await (await fetch(`${BASE}/json`)).json();
const main = list.find((t) => t.type === 'page' && !/popover\.html/.test(t.url));
if (!main) throw new Error(`没找到主窗口：应用没启动，或没带 --remote-debugging-port=${PORT}`);

const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
});
const evaluate = (expression) =>
  new Promise((res, rej) => {
    const id = Math.floor(Math.random() * 1e6);
    const onMessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (m.error || m.result.exceptionDetails) {
        rej(new Error(m.error?.message || m.result.exceptionDetails.exception?.description));
      } else {
        res(m.result.result.value);
      }
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });

const connected = await evaluate(`document.querySelector('#deviceLed').classList.contains('ok')`);
if (!connected) throw new Error('鼠标还没连接：先在界面里点「连接鼠标」');

const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');

/** 绕过界面的串行队列直接发一条读命令；只在没有其它读写进行时调用 */
const readRaw = async (cmd, arg = 0, wait = 60) => {
  if (!(cmd >= 0x81 && cmd <= 0x8f)) throw new Error(`只允许读命令（0x81~0x8F），收到 0x${cmd.toString(16)}`);
  return evaluate(`(async () => {
    const { invoke } = window.__TAURI__.core;
    await invoke('hid_send_feature', { bytes: [9, ${cmd}, ${arg}, 0, 0, 0, 0, 0, 0] });
    await new Promise((r) => setTimeout(r, ${wait}));
    return invoke('hid_get_feature', { len: 8 });
  })()`);
};

const args = process.argv.slice(2);
const runs = args.length
  ? [[args[0], Number(args[0]), Number(args[1] ?? 0), Number(args[2] ?? 60)]]
  : [
      ['回报率', 0x81, 0, 60],
      ['档位数及当前档', 0x83, 0, 60],
      ['单档 DPI（第 3 档）', 0x82, 2, 60],
      ['LOD', 0x84, 1, 60],
      ['按键映射（第 1 键）', 0x86, 0, 60],
      ['接收器灯', 0x88, 0, 60],
      ['电量 / 完整状态', 0x89, 0, 60],
      ['配对信息', 0x8e, 1, 60],
      ['型号信息', 0x8f, 0, 60],
    ];

console.log('设备:', await evaluate(`document.querySelector('#deviceInfo').textContent`));
for (const [name, cmd, arg, wait] of runs) {
  console.log(`${cmd.toString(16).padStart(2, '0')}${arg ? `,${arg}` : ''}  ${name}  等 ${wait}ms → ${hex(await readRaw(cmd, arg, wait))}`);
}
ws.close();
