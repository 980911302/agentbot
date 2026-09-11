import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, MissingApiKeyError } from '../config.js';
import { createAgentServer } from './http.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');

const port = Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT;
const webDist = join(packageRoot, 'web', 'dist');
const staticDir = existsSync(join(webDist, 'index.html')) ? webDist : undefined;

let handle;
try {
  handle = await createAgentServer({ port, staticDir, rootDir: packageRoot });
} catch (error) {
  // 配置类错误给出可操作的提示，而不是堆栈
  if (error instanceof MissingApiKeyError) {
    console.error(`\n✗ ${error.message}\n`);
  } else {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  }
  process.exit(1);
}

console.log(`AgentBot server listening on ${handle.url}`);
if (staticDir) {
  console.log(`Serving UI from ${staticDir}`);
} else {
  console.log('UI bundle not found in web/dist. Use the Vite dev server or run `npm run web:build`.');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    handle.close().finally(() => process.exit(0));
  });
}
