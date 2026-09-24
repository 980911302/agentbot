#!/usr/bin/env node
/**
 * 静态检查（E1.4）：盯住 `.prettierfiles` 受管文件里的三类问题——
 *   1. 未使用的变量/导入（tsc --noUnusedLocals --noUnusedParameters，scoped 到受管文件）
 *   2. 显式 any 注解（`: any` / `as any` / `<any>`）
 *   3. 裸 Promise（调用已知异步 API 却不 await/void/catch）：
 *      - `*Async` 后缀函数（命名约定即异步）
 *      - writeJsonAtomic（存储层统一原子写）
 *
 * 为什么用 tsc 而不是 ESLint：仓库已有 TypeScript，零新增依赖；
 * TS7 没有编译 API，因此走 CLI + 生成临时 tsconfig（extends 基础配置，
 * 诊断按受管文件清单过滤——引入链上的其他文件不算违规）。
 *
 * 用法：node scripts/check-lint.mjs            （零新增依赖）
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const MANIFEST = join(ROOT, '.prettierfiles');

const files = readFileSync(MANIFEST, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((file) => join(ROOT, file));

const problems = [];

// ── 1) tsc：未使用声明 / 隐式 any（scoped） ────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'agentbot-lint-'));
const generated = join(tmp, 'tsconfig.json');
writeFileSync(
  generated,
  JSON.stringify(
    {
      extends: join(ROOT, 'tsconfig.json'),
      compilerOptions: {
        rootDir: '/',
        typeRoots: [join(ROOT, 'node_modules/@types')],
        allowJs: true,
        checkJs: true,
        noEmit: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
      },
      include: files,
    },
    null,
    2,
  ),
);

const tsc = spawnSync(
  'node',
  [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', generated, '--pretty', 'false'],
  {
    cwd: ROOT,
    encoding: 'utf8',
  },
);
rmSync(tmp, { recursive: true, force: true });

for (const line of `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`.split('\n')) {
  const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/.exec(line.trim());
  if (!match) continue;
  const [, reported, lineNo, , code, message] = match;
  // tsc 输出的路径可能是相对的（相对于 cwd）；归一化成绝对路径再与清单比对
  const absolute = resolve(ROOT, reported ?? '');
  if (files.includes(absolute))
    problems.push(`${absolute.replace(`${ROOT}/`, '')}:${lineNo} [${code}] ${message}`);
}

/**
 * 剥掉注释再扫描：否则注释里提到的模式（含本文件自己的说明）会误报。
 * 必须先整文件剥离块注释再逐行扫——逐行剥不掉跨行注释中间的行。
 *
 * @param {string} source
 * @returns {string}
 */
const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((text) => text.replace(/\/\/.*$/, ''))
    .join('\n');

/** 显式 any 的匹配模式。用字符串拼接构造：源码里不出现 `any` 字样，
 *  免得扫描本文件时把自己的模式定义当成违规。 */
const ANY_PATTERN = new RegExp(`:\\s*an${'y'}\\b|\\bas\\s+an${'y'}\\b|<an${'y'}>`);

// ── 2) 显式 any ────────────────────────────────────────────────────────
for (const file of files) {
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
  /** @param {string} text @param {number} index */
  lines.forEach((text, index) => {
    if (ANY_PATTERN.test(text)) {
      problems.push(`${file.replace(`${ROOT}/`, '')}:${index + 1} [显式 any] ${text.trim()}`);
    }
  });
}

// ── 3) 裸 Promise ──────────────────────────────────────────────────────
const ASYNC_CALL = /\b(?:\w+Async|writeJsonAtomic)\s*\(/;
for (const file of files) {
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
  /** @param {string} text @param {number} index */
  lines.forEach((text, index) => {
    const code = text;
    if (!ASYNC_CALL.test(code)) return;
    if (/\b(await|void|return|new|=>)\b/.test(code)) return;
    if (/\.(catch|then|finally)\s*\(/.test(code)) return;
    if (/^\s*[A-Za-z_$][\w$]*\s*=[^=]/.test(code)) return; // 赋值/声明不算裸调用
    problems.push(`${file.replace(`${ROOT}/`, '')}:${index + 1} [裸 Promise] ${text.trim()}`);
  });
}

if (problems.length > 0) {
  console.error(`✗ 静态检查未通过（${problems.length} 处）：`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`静态检查通过（${files.length} 个受管文件：无未使用声明 / 无显式 any / 无裸 Promise）`);
