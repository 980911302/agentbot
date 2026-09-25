#!/usr/bin/env node
/**
 * 暂存区红线检查（ENG-02）：提交前拦住不该进仓库的东西。
 *
 * 检查项（只看 `git diff --cached` 列出的路径）：
 *   1. `.env` 与 `.env.*`（`.env.example` 放行）——密钥不许进仓库；
 *   2. `.agentbot/`、`.commandcode/`、`*.key`、`*.pem` —— 用户数据与签名密钥；
 *   3. 单个文件 > 1MB —— 二进制/大日志不该靠 git 传。
 *
 * 用法：node scripts/verify-staged.mjs    （pre-commit 钩子会调用）
 * 退出码：0 通过；1 有违规（打印每一处与处理建议）。
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const MAX_BYTES = 1024 * 1024;
const BLOCKED_DIRS = ['.agentbot/', '.commandcode/', 'node_modules/', 'dist/', 'web/dist/'];
const BLOCKED_EXT = ['.key', '.pem', '.p12'];
/** 允许进仓库的模板/示例文件 */
const ALLOWED = new Set(['.env.example']);

function stagedPaths() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { encoding: 'utf8' });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

function stagedSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0; // 已删除或读不到：不按体积拦
  }
}

function violationOf(path) {
  const name = path.split('/').pop() ?? path;
  if (ALLOWED.has(name)) return null;
  if (name === '.env' || name.startsWith('.env.')) return '环境变量文件（可能含密钥）';
  if (BLOCKED_DIRS.some((dir) => path.startsWith(dir) || path.includes(`/${dir}`))) return '用户数据 / 构建产物目录';
  if (BLOCKED_EXT.some((ext) => name.endsWith(ext))) return '密钥或证书文件';
  const size = stagedSize(path);
  if (size > MAX_BYTES) return `文件 ${(size / 1024 / 1024).toFixed(1)}MB 超过 1MB`;
  return null;
}

const files = stagedPaths();
const violations = files.map((path) => ({ path, why: violationOf(path) })).filter((item) => item.why);

if (violations.length === 0) {
  console.log(`[verify-staged] 通过：${files.length} 个暂存文件没有红线项`);
  process.exit(0);
}

console.error('[verify-staged] 暂存区里有不该提交的内容，已阻止本次提交：');
for (const item of violations) console.error(`  - ${item.path}（${item.why}）`);
console.error('处理办法：git restore --staged <文件>；真要提交请先确认内容，再临时用 git commit --no-verify（不推荐）。');
process.exit(1);
