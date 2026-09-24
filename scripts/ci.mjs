#!/usr/bin/env node
/**
 * CI 门禁（E1.6）：双端类型 → 单测 → 双端构建 → 文档检查。
 * 不读取、不依赖任何真实 API Key；失败即非零退出。
 * （静态检查属于 E1.4，落地后在此追加。）
 */

import { spawnSync } from 'node:child_process';

const steps = [
  ['双端类型检查', ['npm', 'run', 'typecheck']],
  ['单元测试', ['npm', 'test']],
  ['双端构建', ['npm', 'run', 'build:all']],
  ['文档检查', ['node', 'scripts/check-docs.mjs']],
  ['UI 令牌检查', ['node', 'scripts/check-ui-tokens.mjs']],
];

for (const [name, command] of steps) {
  console.log(`\n== ${name} ==`);
  const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`\n✗ ${name} 失败（exit ${result.status ?? '?'}）`);
    process.exit(result.status ?? 1);
  }
}

console.log('\n✓ CI 全部通过');
