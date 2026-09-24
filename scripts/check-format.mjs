#!/usr/bin/env node
/**
 * 格式检查（E1.4）：只检查 `.prettierfiles` 里登记的受管文件。
 *
 * 为什么用清单而不是 `prettier --check .`：仓库历史文件尚未格式化，
 * 一次性全量 reformat 会把无关 diff 撒进每个提交。约定改为增量——
 * 谁触碰某个文件，谁先格式化它并把路径追加进 `.prettierfiles`。
 * 本脚本守住清单：清单内的文件不合规即失败，清单外不管。
 *
 * 用法：node scripts/check-format.mjs          （依赖 devDependency 的 prettier）
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const MANIFEST = join(ROOT, '.prettierfiles');

const files = readFileSync(MANIFEST, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

if (files.length === 0) {
  console.error('✗ .prettierfiles 为空：没有任何受管文件');
  process.exit(1);
}

const result = spawnSync(
  'node',
  [join(ROOT, 'node_modules/prettier/bin/prettier.cjs'), '--check', ...files],
  { cwd: ROOT, stdio: 'inherit' },
);

if (result.status !== 0) {
  console.error('✗ 格式检查未通过：对上述文件执行 `npx prettier --write <file>` 后重新提交');
  process.exit(result.status ?? 1);
}
