/**
 * 设计预览用的零依赖静态服务器（只监听本机回环）。
 *
 *   node design/preview/serve.mjs [port=4173]
 *
 * 根目录 = 仓库根：/ui/ 与 /design/ 同源访问（ES 模块必须跑在 http 源上，file:// 会被拦）。
 * 预览入口见 design/preview/index.html。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const port = Number(process.argv[2] || 4173);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const file = resolve(root, `.${rel}`);
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    if (res.destroyed) return; // 等文件的时候对端已经走了
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    // 对端中途断开（比如录帧用的浏览器被关掉）时连接已经没了，这时再往回写会抛错。
    // 以前这里没有判断，一次断连就把整个服务带崩了
    if (!res.destroyed && !res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
    }
  }
});
// 连接层面的错误（对端断开、残缺的请求）只影响那一个连接，不该让进程退出
server.on('clientError', (err, socket) => {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});
server.listen(port, '127.0.0.1', () => {
  console.log(`preview server: http://127.0.0.1:${port}/design/`);
});
