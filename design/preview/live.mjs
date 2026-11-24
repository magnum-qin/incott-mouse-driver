/**
 * 真机只读检查：通过 WebView2 的本机调试端口驱动**打包后的真实应用**。
 *
 *   1) 启动应用时带调试端口（PowerShell）：
 *        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'
 *        .\src-tauri\target\release\incott-mouse-driver.exe
 *   2) node design/preview/live.mjs            连接鼠标 → 逐页截图 → 打印读到的状态
 *      node design/preview/live.mjs --no-shot  只打印状态
 *      node design/preview/live.mjs --pending  加做「几项未应用」的往返测试（只改界面，不写鼠标）
 *
 * 只读：只点「连接鼠标」和导航，不点「应用到鼠标」「上传到鼠标」，不往鼠标里写任何东西。
 * 截图存到 design/shots/live-<页面>.png，并报告运行期间界面抛出的异常。
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = Number(process.env.LIVE_PORT || 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT = !process.argv.includes('--no-shot');
const PAGES = ['dpi', 'buttons', 'performance', 'macro'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickTarget() {
let lastError = null;
let sawPort = false;
for (let i = 0; i < 40; i++) {
  try {
    // 主窗口的地址是 http://tauri.localhost/（不带文件名），托盘浮层是 …/popover.html
    const list = await (await fetch(`${BASE}/json`)).json();
    sawPort = true;
    const main = list.find((t) => t.type === 'page' && !/popover\.html/.test(t.url));
    if (main) return main;
    lastError = new Error('调试端口通，但没找到主窗口');
  } catch (e) {
    lastError = new Error(`连不上调试端口 ${BASE}：应用没启动，或没带 --remote-debugging-port=${PORT}（${e.message}）`);
  }
  await sleep(250);
}
throw lastError;
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const errors = [];
  let seq = 0;
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description || d.text);
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(msg.params.entry.text);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
  });
  const send = async (method, params = {}) => {
    await ready;
    const id = ++seq;
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  return { send, errors, close: () => ws.close() };
}

const evaluate = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

const STATE = `(async () => {
  const text = (sel) => document.querySelector(sel)?.textContent.trim() ?? null;
  const lit = (sel) => [...document.querySelectorAll(sel)].filter((k) => k.classList.contains('lit')).map((k) => k.textContent);
  // 枚举信息与固件型号信息（型号识别问题靠这两样排查，见 docs/protocol.md §1）
  const devices = (await window.api.listDevices().catch(() => [])).map((d) => ({
    PID: '0x' + d.productId.toString(16), 产品: d.product, 厂商: d.manufacturer, 序列号: d.serialNumber, 无线: d.isWireless,
  }));
  return {
    连接: text('#deviceLabel'), 型号: text('#deviceInfo'), 电量: text('#batteryVal'),
    固件型号信息: (await window.api.getState().catch(() => null))?.modelInfo ?? null,
    设备枚举: devices,
    读数屏: { 设备: text('#screenName'), DPI: text('#screenDpi'), 档位: text('#screenSub'), 回报率: text('#screenRate'), 电量: text('#screenBattery'), 配置: text('#screenProfile') },
    // 提示收起后元素里可能还留着上一条的淡出残影，只报「看得见的」
    底栏: {
      状态: document.querySelector('#applyState').classList.contains('hidden') ? null : text('#applyStateText'),
      应用键可用: !document.querySelector('#applyBtn').disabled,
    },
    DPI: [...document.querySelectorAll('.stage')].map((s) => ({ 值: s.querySelector('.val').value, 当前: s.classList.contains('current') })),
    回报率: lit('#rateList .key'), LOD: lit('#lodList .key'), 性能模式: lit('#modeList .key'),
    修正: ['#motionSync', '#angleSnap', '#ripple'].map((s) => document.querySelector(s).checked),
    按键响应: document.querySelector('#debounce').value, 节能: text('#sleepValue'), 接收器灯: lit('#ledList .key'),
    按键映射: [...document.querySelectorAll('.brow')].map((r) => r.querySelector('.bname').textContent + '=' + r.querySelector('select').selectedOptions[0]?.textContent),
    宏: document.querySelectorAll('.item').length + ' 个动作',
  };
})()`;

const target = await pickTarget();
const cdp = connect(target.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');

// 等界面初始化完（DPI 列表画出来）
for (let i = 0; i < 60; i++) {
  if (await evaluate(cdp, `document.querySelectorAll('#dpiList .stage').length > 0`)) break;
  await sleep(250);
}

// 连接鼠标（只读：读回整套配置，不写）
const wasConnected = await evaluate(cdp, `document.querySelector('#deviceLed').classList.contains('ok')`);
if (!wasConnected) {
  await evaluate(cdp, `document.querySelector('#connectBtn').click()`);
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const done = await evaluate(
      cdp,
      `document.querySelector('#deviceLed').classList.contains('ok') && document.querySelector('#deviceSpinner').classList.contains('hidden')`,
    );
    if (done) break;
  }
  await sleep(300);
}

// --pending：「几项未应用」的往返测试。只改界面上的值再改回去，全程不写入鼠标。
if (process.argv.includes('--pending')) {
  // 等提示的淡出走完再读（收起有 110ms 退场，退场途中元素还在）
  const status = async () => {
    await sleep(250);
    return evaluate(
      cdp,
      `({ 状态: document.querySelector('#applyState').classList.contains('hidden') ? '(无)' : document.querySelector('#applyStateText').textContent,
          应用键可用: !document.querySelector('#applyBtn').disabled,
          灯: document.querySelector('#applyLed').className, 读数屏回报率: document.querySelector('#screenRate').textContent })`,
    );
  };
  const litKey = `[...document.querySelectorAll('#rateList .key')].find((k) => k.classList.contains('lit'))`;
  const clickRate = (label) =>
    evaluate(
      cdp,
      `(() => { const k = [...document.querySelectorAll('#rateList .key')].find((el) => el.textContent === ${JSON.stringify(label)});
         if (!k) throw new Error('没有这个回报率按键: ' + ${JSON.stringify(label)}); k.click(); })()`,
    );
  await evaluate(cdp, `document.querySelector('.menu [data-page="performance"]').click()`);
  await sleep(300);
  const current = await evaluate(cdp, `${litKey}.textContent`);
  const other = await evaluate(
    cdp,
    `(() => { const k = [...document.querySelectorAll('#rateList .key')].find((el) => !el.classList.contains('lit')); return k ? k.textContent : null; })()`,
  );
  console.log('未应用往返测试（不写入鼠标）');
  console.log('  初始           ', JSON.stringify(await status()));
  if (other) {
    await clickRate(other);
    await sleep(250);
    console.log(`  改成 ${other}`.padEnd(20), JSON.stringify(await status()));
    await clickRate(current);
    await sleep(250);
    console.log(`  改回 ${current}`.padEnd(20), JSON.stringify(await status()));
  }
  await evaluate(cdp, `document.querySelector('.menu [data-page="dpi"]').click()`);
  await sleep(200);
}

for (const page of PAGES) {
  await evaluate(cdp, `document.querySelector('.menu [data-page="${page}"]').click()`);
  await sleep(350); // 等切页后的首帧
  if (SHOT) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = resolve(`design/shots/live-${page}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('截图', file);
  }
}
await evaluate(cdp, `document.querySelector('.menu [data-page="dpi"]').click()`);

console.log(JSON.stringify(await evaluate(cdp, STATE), null, 2));
console.log(cdp.errors.length ? `界面异常 ${cdp.errors.length} 条:\n${cdp.errors.join('\n')}` : '界面异常: 无');
cdp.close();

// 托盘浮层拿到的是 Rust 侧的缓存（由主窗口的 bridge 推送），单独走一条通路
const popover = (await (await fetch(`${BASE}/json`)).json()).find((t) => t.type === 'page' && /popover\.html/.test(t.url));
if (popover) {
  const p = connect(popover.webSocketDebuggerUrl);
  await p.send('Runtime.enable');
  await p.send('Log.enable');
  await sleep(150);
  console.log('托盘浮层状态:', JSON.stringify(await evaluate(p, `window.api.getTrayStatus()`)));
  console.log(p.errors.length ? `浮层异常 ${p.errors.length} 条:\n${p.errors.join('\n')}` : '浮层异常: 无');
  p.close();
}
