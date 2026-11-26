/**
 * 动效录帧：在真实时间里触发一个动作，把随后几百毫秒内浏览器画出的每一帧录下来，
 * 拼成一张连拍图（strip.ps1）逐帧检查。动画的问题只有看运动的帧才看得出来。
 *
 *   node design/preview/motion.mjs --list                 列出全部场景
 *   node design/preview/motion.mjs page                   录一个场景
 *   node design/preview/motion.mjs --all                  全部场景各录一遍（改了界面后的回归）
 *                                                             默认每个场景各用一个目录；--all 时别再指定 --out，
 *                                                             否则所有场景挤在一个目录里互相覆盖帧
 *   node design/preview/motion.mjs page --crop 0,60,300,200 --every 1   只看某块区域，逐帧
 *   node design/preview/motion.mjs page stage --attach 9333 --out design/shots/motion/live
 *                                                             录「正在运行的真实应用」而不是预览页（见下）
 *
 * 场景 = 预览页的起始状态 + 一串按时间触发的动作（见 SCENARIOS）。也可以不用场景，手动指定：
 *   node design/preview/motion.mjs --out design/shots/motion/x --url "<预览地址>" \
 *        --duration 500 --at 0 "<一段脚本>" [--at 300 "<另一段脚本>"]
 *
 * 其它选项：--every <n> 连拍图隔几帧取一张   --max <n> 最多取几帧   --cols <n> 每行几帧
 *          --width <n> 每帧宽度   --settle <ms> 界面就绪后先等多久   --size <w> <h> 窗口尺寸
 *          --no-gpu             改用软件合成。默认是 GPU 合成（和应用的 WebView2 一致）；
 *                               软件合成偶尔会录到一帧「动画还没生效」的假象
 *          --attach <端口>       不启动无头浏览器，连到带着 --remote-debugging-port 运行的真实应用，
 *                               在它的主窗口里跑场景（最终的裁判）。只能跑不写鼠标的场景
 *          --full               整窗录，不用场景里预设的裁剪框（--attach 时建议带上）
 *          --eval "<脚本>"       录完后在页面里执行并打印结果（量时间线用：脚本自己 rAF 采样存到全局变量，这里取出来）
 *
 * 需要预览服务在跑（node design/preview/serve.mjs）。地址里不要带 still —— 那会关掉动画。
 * 输出在 <输出目录>/：frame-NNN.png、frames.json（每帧相对第一个动作的时间）、strip-*.png。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
const PREVIEW = 'http://127.0.0.1:4173/design/preview/index.html';

const CLICK = (sel) => `document.querySelector(${JSON.stringify(sel)}).click()`;
/** 下拉框改值并触发 change（click() 不会改 select 的值） */
const SET = (sel, value) => `(document.querySelector(${JSON.stringify(sel)}).value = ${JSON.stringify(value)},
  document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new Event('change', { bubbles: true })))`;
/** 模拟鼠标主动上报：切到第 n 档（数据区不含 reportId，与 Rust 侧推来的一致） */
const PUSH = (stage) => `window.__TAURI__.event.emit('hid://data', [72, (${stage} << 4) | 4, 0, 0, 0, 0, 0])`;

/** 每个场景对应「盘点清单」里的一处切换（清单见 design/README.md「动效」） */
const SCENARIOS = {
  page: {
    note: '换页：旧页退出 → 新页进入',
    steps: [{ at: 0, click: '.menu [data-page="performance"]' }],
    duration: 500,
  },
  'page-press': {
    note: '菜单项被真实的鼠标按下 / 松开（能看到按下的行程和点击回执）',
    steps: [{ at: 0, press: '.menu [data-page="performance"]', hold: 140 }],
    duration: 600,
    crop: '0,60,300,130',
    every: 1,
    max: 20,
  },
  'page-rapid': {
    note: '退出途中又点了另一页：退出的节奏不变，退完直接进最新的目标',
    steps: [{ at: 0, click: '.menu [data-page="buttons"]' }, { at: 50, click: '.menu [data-page="macro"]' }],
    duration: 600,
  },
  'page-back': {
    note: '退出途中点回了原来那一页：从当前的样子原路返回',
    steps: [{ at: 0, click: '.menu [data-page="performance"]' }, { at: 60, click: '.menu [data-page="dpi"]' }],
    duration: 500,
  },
  'page-interrupt': {
    note: '新页进入途中又点了另一页：从显示到一半的样子开始退，不先跳成完整的一页',
    steps: [{ at: 0, click: '.menu [data-page="buttons"]' }, { at: 170, click: '.menu [data-page="macro"]' }],
    duration: 650,
  },
  key: {
    note: '单选按键组：选中的灯从旧键灭掉、在新键亮起',
    query: 'tab=performance',
    steps: [{ at: 0, click: '#rateList .key:nth-child(4)' }],
    duration: 450,
    crop: '180,140,640,120',
    every: 1,
    max: 20,
  },
  winctl: {
    note: '窗口控制键（只悬停，不点）：最小化 → 最大化 → 关闭，键面依次亮起',
    steps: [{ at: 0, hover: '#winMin' }, { at: 500, hover: '#winMax' }, { at: 1000, hover: '#winClose' }],
    duration: 1500,
    crop: '958,0,122,48',
    every: 1,
    max: 40,
  },
  'winctl-press': {
    note: '窗口控制键：悬停 → 按下有行程 → 松开键面闪一下。会真的点一下最大化，只在预览里跑',
    previewOnly: true,
    steps: [{ at: 0, hover: '#winMax' }, { at: 500, press: '#winMax', hold: 160 }],
    duration: 1100,
    crop: '958,0,122,48',
    every: 1,
    max: 40,
  },
  'winctl-close': {
    note: '关闭键悬停：红色的键面',
    steps: [{ at: 0, hover: '#winClose' }],
    duration: 400,
    crop: '958,0,122,48',
    every: 1,
    max: 12,
  },
  'key-press': {
    note: '键被真实的鼠标按下 / 松开：外壳下沉、松开后键面闪一下；里面的文字始终不缩放、不变亮',
    query: 'tab=performance',
    steps: [{ at: 0, press: '#rateList .key:nth-child(5)', hold: 160 }],
    duration: 600,
    crop: '632,142,95,32',
    every: 1,
    max: 24,
  },
  toggle: {
    note: '开关拨动',
    query: 'tab=performance',
    steps: [{ at: 0, click: '#motionSync' }],
    duration: 350,
    crop: '180,305,640,55',
    every: 1,
    max: 16,
  },
  'perf-note': {
    note: '回报率 8000→1000→2000：电竞键解禁 / 禁用，注意事项增减',
    query: 'tab=performance',
    steps: [{ at: 0, click: '#rateList .key:nth-child(4)' }, { at: 450, click: '#rateList .key:nth-child(5)' }],
    duration: 900,
    crop: '180,255,640,300',
  },
  stage: {
    note: '当前档转移：白条与序号键的亮灭',
    steps: [{ at: 0, click: '#dpiList .stage:nth-child(4)' }],
    duration: 400,
    crop: '190,130,620,230',
    every: 1,
    max: 20,
  },
  'stage-hover': {
    note: '档位条悬停：深色下面变亮，亮色下面已是白的、由投影抬起（边线和投影都在过渡里）。用 --url 指定 mode=light 看亮色',
    steps: [{ at: 0, hover: '#dpiList .stage:nth-child(3)' }],
    duration: 350,
    crop: '190,120,620,180',
    every: 1,
    max: 16,
  },
  xy: {
    note: 'XY 分离：每行展开第二条轴（行高、序号键、下面的行连续过渡），再拨回去收起。会改本地配置，只在预览里跑',
    previewOnly: true, // 拨这个开关会存进本地配置（同配置键：会污染用户正在编辑的那一份）
    steps: [{ at: 0, click: '#xySplit' }, { at: 700, click: '#xySplit' }],
    duration: 1250,
    crop: '180,70,640,560',
  },
  'stage-remove': {
    note: '删一个档位：残影淡出，其余行滑上来补位',
    steps: [{ at: 0, click: '#dpiList .stage:nth-child(2) .x' }],
    duration: 450,
    crop: '190,130,620,330',
    every: 1,
    max: 20,
  },
  'stage-add': {
    note: '新增档位：新行淡入',
    steps: [{ at: 0, click: '#addDpiBtn' }],
    duration: 400,
    crop: '180,370,640,240',
  },
  menu: {
    note: '设置菜单：打开 → 点别处关闭（进出成对）',
    steps: [{ at: 0, click: '#settingsBtn' }, { at: 500, click: '.page-head h2' }],
    duration: 800,
    crop: '500,0,420,290',
  },
  profile: {
    previewOnly: true, // 切换配置会把正在编辑的内容存进本地配置
    note: '换配置：白灯转移、绿数字留在鼠标正在运行的那一份上',
    steps: [{ at: 0, click: '#profileBar [data-profile="2"]' }],
    duration: 400,
    crop: '0,660,520,60',
    every: 1,
    max: 20,
  },
  apply: {
    note: '有修改后：应用键点亮（从熄灭到点亮的那一下键面闪一下）',
    query: 'tab=performance',
    steps: [{ at: 0, click: '#rateList .key:nth-child(4)' }],
    duration: 450,
    crop: '0,660,1080,60',
    every: 1,
    max: 20,
  },
  'apply-done': {
    previewOnly: true, // 会真的把整套配置写进鼠标
    note: '换配置后点「应用配置」：按钮点亮 → 写入 → 熄灭，绿数字移到新配置上（模拟设备）',
    steps: [{ at: 0, click: '#profileBar [data-profile="2"]' }, { at: 600, click: '#applyBtn' }],
    duration: 14000, // 模拟设备按真实时序逐条写入，整套要十来秒
    every: 24,
    max: 24,
  },
  theme: {
    previewOnly: true, // 会改掉模拟设置里的主题（真机上是 settings.json）
    note: '切换亮色主题：和切换语言一样，整窗快速亮一下，颜色跟着换过去',
    steps: [{ at: 0, click: '#settingsBtn' }, { at: 400, click: '#setLightTheme' }],
    duration: 1500,
    every: 10,
    max: 12,
  },
  reset: {
    previewOnly: true, // 会把当前这份配置在本地存储里换成默认值
    note: '恢复默认：第一下键面转红、状态行换成确认提示；第二下才把各页换成默认值',
    steps: [{ at: 0, click: '#rateList .key:nth-child(4)' }, { at: 500, click: '#resetBtn' }, { at: 1700, click: '#resetBtn' }],
    duration: 2900,
    every: 30,
    max: 12,
  },
  'button-type': {
    note: '按键映射换类型：灯转移，下拉换成新选项后淡入',
    query: 'tab=buttons',
    steps: [{ at: 0, click: '#buttonList .brow:nth-child(1) .seg .key:nth-child(2)' }],
    duration: 400,
    crop: '190,100,620,60',
    every: 1,
    max: 20,
  },
  'macro-slot': {
    note: '换宏槽位：选中灯转移，动作列表换内容',
    query: 'tab=macro',
    steps: [{ at: 0, click: '#macroSlots .key:nth-child(2)' }],
    duration: 400,
    crop: '190,100,620,300',
  },
  'macro-add': {
    note: '添加动作：新行淡入',
    query: 'tab=macro',
    steps: [{ at: 0, click: '#macroAddBtn' }],
    duration: 400,
    crop: '430,150,380,300',
  },
  'macro-remove': {
    note: '删除动作：残影淡出，其余补位',
    query: 'tab=macro',
    steps: [{ at: 0, click: '#macroItems .item:nth-child(2) .x' }],
    duration: 400,
    crop: '430,150,380,300',
  },
  'macro-loop': {
    note: '循环方式换成「循环 N 次」再换回来：「次数」行展开 / 收起',
    query: 'tab=macro',
    steps: [{ at: 0, set: ['#macroLoopType', '2'] }, { at: 450, set: ['#macroLoopType', '0'] }],
    duration: 800,
    crop: '190,150,260,200',
  },
  push: {
    previewOnly: true, // 往应用里注入一条伪造的设备上报
    note: '鼠标主动上报换了档位：读数屏与 DPI 页跟着变（只闪不位移）',
    steps: [{ at: 0, js: PUSH(4) }],
    duration: 450,
  },
  connect: {
    previewOnly: true, // 往预览里注入「接收器出现」的设备事件
    note: '没连上时设备出现 → 自动连接：转圈出现又收起、型号和电量展开、读数屏填上',
    query: 'state=off',
    steps: [{ at: 0, js: 'window.__mock.insertDongle()' }],
    duration: 4600,
    crop: '440,0,640,300',
    every: 6,
    max: 24,
  },
  'dongle-return': {
    previewOnly: true, // 模拟接收器拔了又插
    note: '接收器被拔（回到未连接）→ 插回来后不用点按钮，自动重新连上',
    steps: [{ at: 0, js: 'window.__mock.pullDongle()' }, { at: 2000, js: 'window.__mock.insertDongle()' }],
    duration: 6600,
    crop: '440,0,640,300',
    every: 8,
    max: 24,
  },
  'manual-connect': {
    previewOnly: true, // 会点「断开」和「连接鼠标」，并模拟接收器拔插
    note: '手动断开之后不再自动连：接收器拔了又插回来也不连，点了「连接鼠标」才连',
    steps: [
      { at: 0, click: '#connectBtn' },
      { at: 600, js: 'window.__mock.pullDongle()' },
      { at: 1500, js: 'window.__mock.insertDongle()' },
      { at: 3600, click: '#connectBtn' },
    ],
    duration: 7600,
    crop: '440,0,640,300',
    every: 8,
    max: 24,
  },
  'mouse-wake': {
    previewOnly: true, // 模拟休眠中的鼠标醒来
    note: '休眠中的鼠标醒来：补读配置，回报率按键和读数屏换成鼠标上的值（500 Hz）',
    query: 'asleep=1&tab=performance',
    steps: [{ at: 0, js: 'window.__mock.wake()' }],
    duration: 2800,
    every: 8,
    max: 24,
  },
  disconnect: {
    previewOnly: true, // 会断开设备
    note: '断开：型号和电量收起（左边的状态文字不跳）、读数屏清空',
    steps: [{ at: 0, click: '#connectBtn' }],
    duration: 500,
    crop: '440,0,640,300',
    every: 1,
    max: 24,
  },
  'plug-wired': {
    previewOnly: true, // 往预览里注入「鼠标插上线」的设备事件
    note: '连着接收器时鼠标插上线：连接自动换到有线，标题栏换成「有线」、电量刷新',
    steps: [{ at: 0, js: 'window.__mock.plugWired()' }],
    duration: 3600,
    crop: '440,0,640,300',
    every: 6,
    max: 24,
  },
  'unplug-wired': {
    previewOnly: true, // 往预览里注入「拔线」的设备事件
    query: 'wired=1',
    note: '拔线：连接自动回到接收器，标题栏换回「8K」',
    steps: [{ at: 0, js: 'window.__mock.unplugWired()' }],
    duration: 3600,
    crop: '440,0,640,300',
    every: 6,
    max: 24,
  },
  'pull-dongle': {
    previewOnly: true, // 往预览里注入「拔掉接收器」的设备事件
    note: '拔掉接收器：回到「鼠标已断开」',
    steps: [{ at: 0, js: 'window.__mock.pullDongle()' }],
    duration: 1400,
    crop: '440,0,640,300',
    every: 3,
    max: 24,
  },
  lang: {
    note: '切换语言：整窗快速亮一下',
    steps: [{ at: 0, click: '#langBtn' }, { at: 350, click: '.lang-option[data-lang="en"]' }],
    duration: 750,
    every: 2,
    max: 20,
  },
};

// ── 参数 ───────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = { every: 2, max: 24, cols: 6, width: 360, duration: 600, w: 1080, h: 720, port: 9334, settle: 400, out: '', url: '', query: '', eval: '', gpu: true, attach: false };
const manualSteps = [];
const names = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--list') names.push('--list');
  else if (a === '--all') names.push('--all');
  else if (a === '--url') opt.url = next();
  else if (a === '--out') opt.out = next();
  else if (a === '--duration') opt.duration = Number(next());
  else if (a === '--every') opt.every = Number(next());
  else if (a === '--max') opt.max = Number(next());
  else if (a === '--cols') opt.cols = Number(next());
  else if (a === '--width') opt.width = Number(next());
  else if (a === '--settle') opt.settle = Number(next());
  else if (a === '--port') opt.port = Number(next());
  else if (a === '--size') {
    opt.w = Number(next());
    opt.h = Number(next());
  } else if (a === '--crop') opt.crop = next();
  else if (a === '--eval') opt.eval = next();
  else if (a === '--no-gpu') opt.gpu = false;
  else if (a === '--full') opt.full = true;
  else if (a === '--attach') {
    opt.attach = true;
    opt.port = Number(next());
  }
  else if (a === '--at') manualSteps.push({ at: Number(next()), js: next() });
  else if (!a.startsWith('--')) names.push(a);
}

if (names.includes('--list')) {
  for (const [name, s] of Object.entries(SCENARIOS)) {
    console.log(`${name.padEnd(15)}${s.previewOnly ? '[仅预览] ' : ''}${s.note}`);
  }
  process.exit(0);
}
const unknown = names.filter((n) => n !== '--all' && !SCENARIOS[n]);
if (unknown.length) {
  console.error(`没有这些场景: ${unknown.join(', ')}（--list 看全部）`);
  process.exit(2);
}
// 标了 previewOnly 的场景有副作用（写鼠标、写本地配置、碰设备），在真实应用里一律不跑。
// 靠「记得别跑」不可靠：上一轮就是录 profile 场景时把测试改动存进了用户的本地配置
const previewOnly = Object.keys(SCENARIOS).filter((n) => SCENARIOS[n].previewOnly);
const runAll = names.includes('--all');
if (opt.attach) {
  const banned = runAll ? previewOnly : names.filter((n) => previewOnly.includes(n));
  if (banned.length) {
    console.error(`这些场景有副作用，不能在真实应用里跑：${banned.join('、')}。`);
    console.error('真实应用只跑纯界面、不保存的场景，例如：page key stage macro-add menu winctl');
    process.exit(2);
  }
}
const list = runAll ? Object.keys(SCENARIOS) : names;
const manual = !list.length;
if (!EDGE || (!manual && !list.length) || (manual && !manualSteps.length)) {
  console.error('用法见文件开头的说明');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 进程退出时一定要关掉自己启动的浏览器：中途抛了没接住的异常也不留残留进程占着端口 */
const cleanups = [];
const runCleanups = () => cleanups.splice(0).forEach((fn) => fn());
process.on('exit', runCleanups);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { runCleanups(); process.exit(130); });
// 输出被接到提前关闭的管道（… | head）时别让进程带着浏览器一起「崩掉」
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

/**
 * 关掉这次启动的浏览器。不能靠 ChildProcess：msedge.exe 是个启动器，把真正的浏览器进程
 * （它的子进程）起好之后自己就以 0 退出了，child.kill() 什么也杀不到。
 * 按启动时给的临时目录去找命令行里带着它的进程，全部结束。
 */
function killBrowser(child, profile) {
  if (process.platform !== 'win32') {
    try {
      child?.kill();
    } catch {
      /* 已退出 */
    }
    return;
  }
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' } | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  ], { stdio: 'ignore' });
}

/** 自己启动浏览器时：指定的端口被占（上次没收干净，或别的实例在跑）就往后找空闲的 */
async function freePort(preferred) {
  for (let port = preferred; port < preferred + 20; port++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(400) });
    } catch {
      return port; // 没人应答 = 空闲
    }
  }
  throw new Error(`${preferred} 起的 20 个端口都被占了`);
}

let browser = null; // 本次运行启动的浏览器，整次运行共用一个

/** 启动无头浏览器（只启动一次，之后逐场景在同一个里换页）。进程退出时由 cleanups 关掉 */
async function launchBrowser() {
  if (browser) return browser;
  const port = await freePort(opt.port);
  const profile = mkdtempSync(join(tmpdir(), 'incott-motion-'));
  // GPU 合成和应用的 WebView2 渲染路径一致，所以默认开着。--no-gpu 换成软件合成（更稳，
  // 但偶尔会录到一帧「动画还没生效」的假象——看到突兀的一帧，先用默认模式复核再下结论）
  const edge = spawn(EDGE, [
    '--headless=new', ...(opt.gpu ? [] : ['--disable-gpu']), '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${opt.w},${opt.h}`, 'about:blank',
  ], { stdio: 'ignore' });
  browser = { edge, profile, base: `http://127.0.0.1:${port}` };
  cleanups.push(() => {
    killBrowser(browser.edge, browser.profile);
    try {
      rmSync(browser.profile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    } catch {
      /* profile 还被占用就留在临时目录里 */
    }
  });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await (await fetch(`${browser.base}/json`)).json()).some((t) => t.type === 'page')) return browser;
    } catch {
      /* 调试端口还没起来 */
    }
    await sleep(250);
  }
  throw new Error('无头浏览器没起来');
}

/** 录一个场景；返回连拍图路径 */
async function record(name, spec) {
  const outDir = resolve(opt.out || join('design/shots/motion', name));
  const query = spec.query || '';
  const url = spec.url || opt.url || `${PREVIEW}${query ? `?${query}` : ''}`;
  const steps = spec.steps || manualSteps;
  const duration = spec.duration ?? opt.duration;
  // --full：整窗录。真实应用里的缩放和布局可能和预览不同，场景里按预览坐标写的裁剪框对不上
  const crop = opt.full ? '' : opt.crop || spec.crop || '';
  const every = spec.every ?? opt.every;
  const max = spec.max ?? opt.max;
  // 整次运行共用一个浏览器，逐场景换页；--attach 时连的是外部应用的主窗口
  if (!opt.attach) await launchBrowser();
  const BASE = opt.attach ? `http://127.0.0.1:${opt.port}` : browser.base;

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list_ = await (await fetch(`${BASE}/json`)).json();
      // 真实应用的主窗口地址是 http://tauri.localhost/（不带文件名），托盘浮层是 …/popover.html
      target = opt.attach
        ? list_.find((t) => t.type === 'page' && !/popover\.html/.test(t.url))
        : list_.find((t) => t.type === 'page');
    } catch {
      /* 调试端口还没起来 */
    }
    if (!target) await sleep(250);
  }
  if (!target) {
    throw new Error(opt.attach ? `端口 ${opt.port} 上没找到应用的主窗口` : '无头浏览器没起来');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
  });
  let seq = 0;
  const pending = new Map();
  const frames = [];
  const errors = []; // 场景执行期间的未捕获异常：画面上看不出来，必须单独盯
  let onFrame = null;
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push((d.exception?.description || d.text || '未知异常').split('\n').slice(0, 2).join(' '));
    }
    if (msg.method === 'Page.screencastFrame') {
      if (onFrame) onFrame(msg.params);
      ws.send(JSON.stringify({ id: ++seq, method: 'Page.screencastFrameAck', params: { sessionId: msg.params.sessionId } }));
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  /** 真实的鼠标按下 / 松开（el.click() 不会触发 :active，看不到按下的行程） */
  const press = async (selector, hold) => {
    const c = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const base = { x: c.x, y: c.y, button: 'left', clickCount: 1 };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await sleep(hold ?? 100);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  };
  /** 把鼠标移到元素上但不点（看悬停态） */
  const hover = async (selector) => {
    const c = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
  };

  let t0 = 0;
  try {
    await send('Page.enable');
    await send('Runtime.enable');
    if (opt.attach) {
      // 连的是已经在跑的应用：不导航、不改视口，等界面画好就行
      const ready = `!!document.querySelector('#rateList') && !!document.querySelector('.menu [data-page]')`;
      for (let i = 0; i < 80; i++) {
        try {
          if (await evaluate(ready)) break;
        } catch {
          /* 执行上下文还没好 */
        }
        await sleep(250);
      }
      // 真实应用里状态是跨场景延续的（预览每次都重新加载）：先切到这个场景所在的页面，
      // 否则它点的可能是藏着的页面里的东西
      const page = spec.page || /(?:^|&)tab=(\w+)/.exec(spec.query || '')?.[1] || 'dpi';
      if ((await evaluate(`document.querySelector('.menu [data-page].active')?.dataset.page`)) !== page) {
        await evaluate(CLICK(`.menu [data-page="${page}"]`));
        await sleep(700); // 等换页动画走完
      }
    } else {
      // --window-size 含浏览器边框，页面实际视口会小一圈（1080×720 → 1050×625）。直接锁定视口，
      // 录出来的帧才和应用窗口同尺寸，场景里的裁剪坐标也才对得上
      await send('Emulation.setDeviceMetricsOverride', { width: opt.w, height: opt.h, deviceScaleFactor: 1, mobile: false });
      const nav = await send('Page.navigate', { url });
      let ready = !nav.errorText;
      for (let i = 0; ready && i < 160; i++) {
        await sleep(250);
        try {
          if (await evaluate(`document.documentElement.dataset.ready === '1'`)) break;
        } catch {
          /* 导航中途，执行上下文还没换好 */
        }
      }
      // 没就绪就继续往下跑，后面的步骤会在浏览器的错误页上执行，报出来的错完全对不上原因
      ready = ready && await evaluate(`document.documentElement.dataset.ready === '1' && location.protocol === 'http:'`).catch(() => false);
      if (!ready) {
        throw new Error(`预览页没加载出来${nav.errorText ? `（${nav.errorText}）` : ''}：预览服务在跑吗？node design/preview/serve.mjs`);
      }
    }
    await sleep(spec.settle ?? opt.settle);

    // 清掉上一次的帧，开始录
    mkdirSync(outDir, { recursive: true });
    for (const f of readdirSync(outDir).filter((n) => /^(frame-|strip-)/.test(n) || n === 'frames.json')) {
      rmSync(join(outDir, f));
    }
    // 限定最大尺寸：真实应用在 125% / 150% 缩放的屏幕上是按设备像素出的帧，缩回逻辑尺寸后裁剪坐标才对得上
    onFrame = (p) => frames.push({ data: p.data, t: p.metadata.timestamp * 1000 });
    await send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: opt.w, maxHeight: opt.h });
    await sleep(200); // 录帧通道稳定下来

    t0 = await evaluate('performance.timeOrigin + performance.now()');
    errors.length = 0; // 只算场景开始之后的
    const started = Date.now();
    for (const step of steps) {
      const wait = step.at - (Date.now() - started);
      if (wait > 0) await sleep(wait);
      if (step.click) await evaluate(CLICK(step.click));
      else if (step.press) await press(step.press, step.hold);
      else if (step.hover) await hover(step.hover);
      else if (step.set) await evaluate(SET(...step.set));
      else await evaluate(step.js);
    }
    await sleep(Math.max(0, duration - (Date.now() - started)) + 120);
    await send('Page.stopScreencast');
    onFrame = null;
    if (opt.eval) console.log(await evaluate(opt.eval));
  } finally {
    ws.close();
  }

  const kept = frames.filter((f) => f.t >= t0 - 40);
  const index = kept.map((f, i) => {
    const file = `frame-${String(i).padStart(3, '0')}.png`;
    writeFileSync(join(outDir, file), Buffer.from(f.data, 'base64'));
    return { file, t: Math.round(f.t - t0) };
  });
  writeFileSync(join(outDir, 'frames.json'), JSON.stringify(index));
  if (!index.length) return { frames: 0, span: 0, strip: '(没有录到帧)', errors };
  const stripArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'strip.ps1'),
    '-Dir', outDir, '-Cols', String(opt.cols), '-Width', String(opt.width), '-Every', String(every), '-Max', String(max)];
  if (crop) stripArgs.push('-Crop', crop);
  const r = spawnSync('powershell', stripArgs, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`拼连拍图失败: ${r.stderr || r.stdout}`);
  return { frames: index.length, span: index.length ? index[index.length - 1].t : 0, strip: r.stdout.trim(), errors };
}

let failed = 0;
for (const name of list) {
  try {
    let r = await record(name, SCENARIOS[name]);
    // 偶尔会一帧都没送到（全量跑的时候见过一次，单独重跑正常，原因没查到）：重录一次再下结论
    if (r.frames === 0) {
      console.log(`${name.padEnd(15)} 一帧都没录到，重录一次`);
      r = await record(name, SCENARIOS[name]);
    }
    console.log(`${name.padEnd(15)} ${String(r.frames).padStart(3)} 帧 / ${String(r.span).padStart(4)}ms  ${r.strip}`);
    if (r.frames === 0) {
      // 一帧都没有 = 这个场景什么都没验证到（动作没带来画面变化，或者几个场景挤在同一个输出目录里互相覆盖）
      failed++;
      console.log(`${''.padEnd(15)} ✗ 一帧都没录到：动作没有带来任何画面变化，或者几个场景共用了同一个 --out 目录`);
    } else if (r.errors.length) {
      failed++;
      console.log(`${''.padEnd(15)} ⚠ 页面抛了 ${r.errors.length} 个未捕获异常:`);
      for (const e of r.errors) console.log(`${''.padEnd(17)}${e}`);
    }
  } catch (e) {
    failed++;
    console.log(`${name.padEnd(15)} 失败: ${e.message}`);
  }
}
if (manual) {
  // 手动模式：没有场景名，输出目录由 --out 指定
  try {
    const r = await record('manual', { steps: manualSteps, duration: opt.duration });
    console.log(`${r.frames} 帧 / ${r.span}ms  ${r.strip}`);
  } catch (e) {
    failed++;
    console.log(`失败: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
