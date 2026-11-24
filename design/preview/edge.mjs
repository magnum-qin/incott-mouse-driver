/**
 * 无头 Edge 的启动与收尾，shot.mjs 和 motion.mjs 共用。
 *
 * 这台机器上的 msedge.exe 是个启动器：把真正的浏览器进程（它的子进程）起好之后，
 * 自己立刻以 0 退出。所以——
 *  - spawn 拿到的那个进程退出 ≠ 浏览器退出，不能靠它判断「截完了」「录完了」；
 *  - child.kill()、taskkill /T <启动器 pid> 都什么也杀不到，得按启动时给的临时目录
 *    去找命令行里带着它的进程再关（残留的浏览器会一直占着调试端口和磁盘）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p)) || null;

/** 每次启动用一个全新的临时目录当用户数据，互不干扰 */
export function newProfile(prefix) {
  return mkdtempSync(join(tmpdir(), `incott-${prefix}-`));
}

/** 关掉命令行里带着这个目录的全部 Edge 进程（Windows；其它平台没有这个问题，不需要） */
export function killBrowser(profile) {
  if (process.platform !== 'win32') return;
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' } | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  ], { stdio: 'ignore' });
}

export function removeProfile(profile) {
  try {
    // 进程刚结束时文件还被占用着，重试几秒
    rmSync(profile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  } catch {
    /* 还被占用就留在临时目录里 */
  }
}

export function disposeProfile(profile) {
  killBrowser(profile);
  removeProfile(profile);
}
