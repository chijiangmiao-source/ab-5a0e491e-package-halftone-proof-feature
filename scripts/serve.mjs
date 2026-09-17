/**
 * 零依赖生产静态服务器：仅用 Node 内置 http/fs，服务 ../dist。
 * 用于容器 web 目标，避免在运行镜像中携带完整构建工具链。
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

if (!existsSync(join(root, 'index.html'))) {
  console.error(`找不到 ${root}/index.html，请先执行 npm run build`);
  process.exit(1);
}

createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  // 词法层面拦截任何向上跳的段（含 %2e%2e 编码、反斜杠变体）
  const segments = urlPath.split(/[/\\]+/).filter(Boolean);
  if (segments.some((s) => s === '..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  let filePath = join(root, ...segments);
  if (!filePath.startsWith(root + sep) && filePath !== root) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // SPA 回退
    filePath = join(root, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
}).listen(port, host, () => {
  console.log(`专色稿静态服务: http://${host}:${port}`);
});
