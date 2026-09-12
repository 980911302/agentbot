import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ServerResponse } from 'node:http';
import { json } from './json.js';

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 静态托管 web/dist：未知路径回退 index.html（SPA 路由）。
 * 路径越界（../ 逃逸）一律回退 index.html，不报错。
 */
export function serveStatic(
  response: ServerResponse,
  pathname: string,
  headOnly: boolean,
  staticDir?: string,
): void {
  if (!staticDir) {
    json(response, 404, {
      error: 'UI bundle not found. Run `npm run web:build`, or use the Vite dev server on :5173.',
    });
    return;
  }

  const indexFile = join(staticDir, 'index.html');
  if (!existsSync(indexFile)) {
    json(response, 404, { error: 'web/dist/index.html is missing. Run `npm run web:build`.' });
    return;
  }

  const target = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  const candidate = resolve(staticDir, target);
  const rel = relative(staticDir, candidate);
  const insideRoot = !rel.startsWith('..') && !isAbsolute(rel);
  const file =
    insideRoot && existsSync(candidate) && statSync(candidate).isFile() ? candidate : indexFile;
  const type = STATIC_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';

  response.writeHead(200, {
    'content-type': type,
    'cache-control': file === indexFile ? 'no-cache' : 'public, max-age=3600',
  });
  if (headOnly) {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
}
