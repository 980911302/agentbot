#!/usr/bin/env node
/**
 * 安装本地 Git 钩子（ENG-02）：npm install 时经 package.json 的 prepare 自动执行。
 * 只设置当前仓库的 core.hooksPath，不改全局配置；不在 git 仓库里就安静跳过。
 */

import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
  console.log('[install-hooks] 已启用 .githooks（提交前会跑 scripts/verify-staged.mjs + npm run typecheck + npm test）');
} catch {
  console.log('[install-hooks] 不在 Git 仓库里，跳过（需要时手动执行：git config core.hooksPath .githooks）');
}
