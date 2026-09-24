#!/usr/bin/env node
/**
 * CI 门禁（E1.6）：双端类型 → 单测 → 双端构建 → 文档检查。
 * E1.4 追加：UI 令牌 → 格式（受管清单）→ 静态检查（scoped tsc 等）→ 跨层 import。
 * 不读取、不依赖任何真实 API Key；失败即非零退出。
 */

import { spawnSync } from 'node:child_process';

const steps = [
  ['双端类型检查', ['npm', 'run', 'typecheck']],
  ['单元测试', ['npm', 'test']],
  ['双端构建', ['npm', 'run', 'build:all']],
  ['文档检查', ['node', 'scripts/check-docs.mjs']],
  ['UI 令牌检查', ['node', 'scripts/check-ui-tokens.mjs']],
  ['格式检查', ['node', 'scripts/check-format.mjs']],
  ['静态检查', ['node', 'scripts/check-lint.mjs']],
  ['跨层 import 检查', ['node', 'scripts/check-imports.mjs']],
];

for (const [name, command] of steps) {
  const [bin, ...args] = command ?? [];
  if (!bin) {
    console.error(`\n✗ ${name} 配置缺失命令`);
    process.exit(1);
  }
  console.log(`\n== ${name} ==`);
  const result = spawnSync(bin, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`\n✗ ${name} 失败（exit ${result.status ?? '?'}）`);
    process.exit(result.status ?? 1);
  }
}

console.log('\n✓ CI 全部通过');
