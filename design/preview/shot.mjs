/**
 * 无头 Edge 截图（设计预览用）。
 *
 *   node design/preview/shot.mjs <url> <out.png> [--w 1080] [--h 720] [--scale 1] [--wait 4000]
 *
 * 用虚拟时间快进界面里的异步流程（连接、读配置的 sleep），保证每次截图状态一致。
 * msedge.exe 是个启动器，把浏览器起好就返回了（见 edge.mjs），所以这里要等输出文件真的写完才算数。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { EDGE, disposeProfile, newProfile } from './edge.mjs';

const [url, out, ...rest] = process.argv.slice(2);
if (!url || !out) {
  console.error('用法: node design/preview/shot.mjs <url> <out.png> [--w 1080] [--h 720] [--scale 1] [--wait 4000]');
  process.exit(2);
}
const opt = { w: 1080, h: 720, scale: 1, wait: 4000 };
rest.forEach((a, i) => {
  if (a.startsWith('--')) opt[a.slice(2)] = rest[i + 1];
});
if (!EDGE) {
  console.error('找不到 msedge.exe');
  process.exit(1);
}

const outPath = resolve(out);
mkdirSync(dirname(outPath), { recursive: true });
rmSync(outPath, { force: true }); // 不留旧的：免得这次没截成，却被旧文件当成成功

const profile = newProfile('shot');
const r = spawnSync(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${profile}`,
  `--window-size=${opt.w},${opt.h}`,
  `--force-device-scale-factor=${opt.scale}`,
  `--virtual-time-budget=${opt.wait}`,
  `--screenshot=${outPath}`,
  url,
], { stdio: 'ignore', timeout: 90000 });

// 启动器已经返回，浏览器还在后面截图：等文件出现，并且大小稳定下来
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let ok = false;
for (let i = 0, last = -1, since = Date.now(); i < 360; i++) {
  await sleep(500);
  let size = -1;
  try {
    size = statSync(outPath).size;
  } catch {
    /* 还没写出来 */
  }
  if (size <= 0) continue;
  if (size !== last) {
    last = size;
    since = Date.now();
  } else if (Date.now() - since >= 1000) {
    ok = true;
    break;
  }
}
disposeProfile(profile); // 截完把浏览器和临时目录收掉（以前从不收，Temp 里会越堆越多）
if (!ok) {
  console.error(`截图失败（启动器 exit ${r.status}，等了 3 分钟没等到输出文件）`);
  process.exit(1);
}
console.log(outPath);
