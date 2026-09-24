#!/usr/bin/env node
/**
 * UI 令牌检查（UI-01）：组件样式只许用语义令牌。
 *
 * 扫描范围：
 *   - web/src/styles/02~08 的样式表（01-tokens.css 是令牌定义本身，不扫）
 *   - web/src 下 tsx/ts 的内联样式（含 style={{ ... }} 与 CSSProperties 对象）
 *
 * 报错规则：
 *   1. 十六进制颜色字面量（#rgb/#rrggbb/#rrggbbaa）
 *   2. rgba()/hsla() 颜色函数字面量
 *   3. 数字 z-index（0/1 是组件内局部堆叠，放行；其余必须用 --z-* 令牌）
 *   4. 已废除的兼容别名（panel / raised / sunken / fg 系列 / line 系列 / bubble 系列 /
 *      composer 系列 / card 系列 / surface / pill-blue / code 系列 等）
 *
 * 白名单：
 *   - 身份色调色板（AVATAR_COLOR_HEX）：规范 §1.1 明确由 LivingAvatar 提供，
 *     只用于头像、名字、群发言者标记，允许十六进制。以下取值是 11 种身份色 +
 *     默认身份色 brown，出现在任何文件都放行；BotFace 是头像插画（固定墨色、不随主题），整文件放行
 *   - z-index: 0 / z-index: 1（局部堆叠，非浮层级）
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const WEB = join(ROOT, 'web/src');

const IDENTITY_PALETTE_FILES = [
  'components/LivingAvatar.tsx',
  'components/BotProfileDialog.tsx',
  'components/BotProfileDrawer.tsx',
  'components/BotFace.tsx',
].map((file) => join(WEB, file));

/** 身份色取值（AVATAR_COLOR_HEX 的 11 色 + 默认身份色）：任何文件出现都放行 */
const IDENTITY_HEX = new Set([
  '#1b1d22',
  '#b89b6a',
  '#e24b4b',
  '#f08a2c',
  '#e6c041',
  '#3cb86c',
  '#39c1c8',
  '#3b82f6',
  '#8b5cf6',
  '#d946a6',
  '#8b93a7',
]);

const ALIASES = [
  '--panel',
  '--raised',
  '--sunken',
  '--hover',
  '--active',
  '--fg',
  '--fg-muted',
  '--fg-faint',
  '--line',
  '--line-strong',
  '--bubble-user',
  '--bubble-assistant',
  '--composer-bg',
  '--composer-border',
  '--composer-fade',
  '--card',
  '--card-bg',
  '--card-border',
  '--surface',
  '--pill-blue',
  '--code-bg',
  '--code-border',
  '--code-inline-bg',
  '--code-inline-fg',
  '--code-inline-border',
  '--text-muted',
  '--bad',
  '--error',
  '--sidebar-border',
];

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const RGBA = /\b(?:rgba?|hsla?)\(/;
const Z_INDEX = /z-index:\s*([2-9]|\d\d+)/;
const Z_INDEX_JS = /zIndex:\s*([2-9]|\d\d+)/;

/** @param {string} dir @param {string[]} out @returns {string[]} */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const styleFiles = readdirSync(join(WEB, 'styles'))
  .filter((name) => /^0[2-8].*\.css$/.test(name))
  .map((name) => join(WEB, 'styles', name));

const sourceFiles = walk(WEB)
  .filter((file) => /\.(tsx?|jsx?)$/.test(file))
  .filter((file) => !IDENTITY_PALETTE_FILES.includes(file));

/** @type {string[]} */
const problems = [];
/** @param {string} file @param {number} lineNo @param {string} line @param {string} rule */
const report = (file, lineNo, line, rule) =>
  problems.push(`${relative(ROOT, file)}:${lineNo} [${rule}] ${line.trim()}`);

/** @param {string} file @param {boolean} withAlias */
const scan = (file, withAlias) => {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    // 身份色是规范认可的例外：先把这些取值从行里剔掉再查字面量
    let semanticLine = line;
    for (const hex of IDENTITY_HEX) semanticLine = semanticLine.replaceAll(hex, '');
    if (HEX.test(semanticLine)) report(file, lineNo, line, '十六进制颜色');
    if (RGBA.test(semanticLine)) report(file, lineNo, line, 'rgba/hsla 字面量');
    if (Z_INDEX.test(line)) report(file, lineNo, line, '数字 z-index');
    if (Z_INDEX_JS.test(line)) report(file, lineNo, line, '数字 zIndex');
    if (withAlias && ALIASES.some((alias) => line.includes(`var(${alias})`))) {
      report(file, lineNo, line, '兼容别名');
    }
  });
};

for (const file of styleFiles) scan(file, true);
for (const file of sourceFiles) scan(file, true);

// 身份色/插画文件：十六进制整文件放行，别名与 z-index 仍查
for (const file of IDENTITY_PALETTE_FILES) {
  if (!existsSync(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (ALIASES.some((alias) => line.includes(`var(${alias})`))) {
      report(file, index + 1, line, '兼容别名');
    }
    if (Z_INDEX.test(line) || Z_INDEX_JS.test(line)) report(file, index + 1, line, '数字 z-index');
  });
}

if (problems.length > 0) {
  console.error(`✗ UI 令牌检查未通过（${problems.length} 处）：`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`UI 令牌检查通过（${styleFiles.length} 个样式表 + ${sourceFiles.length} 个源码文件）`);
