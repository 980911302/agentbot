#!/usr/bin/env node
/**
 * 构建产物清理（E1.3）。
 *
 * 白名单制：只接受下面这几个目标，其余路径一律拒绝。
 * 绝不清用户数据（.agentbot / .env / .commandcode）——它们不属于构建产物。
 */

import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

/** 只能清理这些构建产物目录；键 = 允许的参数，值 = 相对项目根的路径 */
const WHITELIST = {
  dist: 'dist',
  'web/dist': 'web/dist',
  'test-results': 'test-results',
};

/** 无论传什么都不会碰的用户数据与源码 */
const FORBIDDEN = new Set(['.agentbot', '.env', '.commandcode', 'src', 'web/src', 'test', 'docs']);

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('用法：node scripts/clean.mjs <目标...>；允许的目标：' + Object.keys(WHITELIST).join('、'));
  process.exit(1);
}

let failed = false;
for (const arg of args) {
  const relative = WHITELIST[arg];
  if (!relative) {
    console.error(`拒绝清理「${arg}」：不在白名单里。允许的目标：${Object.keys(WHITELIST).join('、')}`);
    failed = true;
    continue;
  }
  const absolute = resolve(PROJECT_ROOT, relative);
  const forbidden = [...FORBIDDEN].some(
    (name) => absolute === resolve(PROJECT_ROOT, name) || absolute.startsWith(resolve(PROJECT_ROOT, name) + '/'),
  );
  if (forbidden) {
    console.error(`拒绝清理「${arg}」：这是用户数据或源码，不是构建产物`);
    failed = true;
    continue;
  }
  rmSync(absolute, { recursive: true, force: true });
  console.log(`已清理 ${relative}/`);
}

process.exit(failed ? 1 : 0);
