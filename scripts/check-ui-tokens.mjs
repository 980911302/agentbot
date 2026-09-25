#!/usr/bin/env node
/**
 * UI 令牌检查（UI-01）：组件样式只许用语义令牌。
 *
 * 扫描范围：
 *   - web/src/styles/02~09 的样式表（01-tokens.css 是令牌定义本身，不扫；09-ui.css 自本版起纳入）
 *   - web/src 下 tsx/ts 的内联样式（含 style={{ ... }} 与 CSSProperties 对象）
 *
 * 报错规则：
 *   1. 十六进制颜色字面量（#rgb/#rrggbb/#rrggbbaa）
 *   2. rgba()/hsla() 颜色函数字面量
 *   3. 数字 z-index（0/1 是组件内局部堆叠，放行；其余必须用 --z-* 令牌）
 *   5. 字重不在 400 / 500 / 600（规范 §2.1：名字 600，其余 400/500，不用 700 以上）
 *   6. 样式表里 font-size 写死 px（应当用 --fs-*）
 *   7. 样式表里 border-radius 写死 px（应当用 --r-*；0/1px/2px 这种发丝级圆角放行）
 *   4. 已废除的兼容别名（panel / raised / sunken / fg 系列 / line 系列 / bubble 系列 /
 *      composer 系列 / card 系列 / surface / pill-blue / code 系列 等）
 *
 * 白名单：
 *   - 身份色调色板（AVATAR_COLOR_HEX）：规范 §1.1 明确由 LivingAvatar 提供，
 *     只用于头像、名字、群发言者标记，允许十六进制。以下取值是 11 种身份色 +
 *     默认身份色 brown，出现在任何文件都放行；BotFace 是头像插画（固定墨色、不随主题），整文件放行
 *   - z-index: 0 / z-index: 1（局部堆叠，非浮层级）
 *   - 行内写了 `ui-tokens-allow: 理由` 注释的那一行，只对规则 6/7 放行（例外必须写理由）
 *
 * 渐进落地（规则 6/7）：TYPE_WARN_ONLY_FILES 里的样式表（右侧面板、弹窗）还没迁完，
 * 只打印警告和剩余数量、不让 CI 失败；其余样式表已经清零，再写死就报错。
 * 迁完一个文件就把它从名单里删掉，名单清空后规则 6/7 即全量强制。
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

/** 字号/圆角还没迁完、暂时只警告的样式表（见文件头「渐进落地」） */
const TYPE_WARN_ONLY_FILES = ['06-panels.css', '07-dialog.css'].map((name) => join(WEB, 'styles', name));

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const FONT_SIZE_PX = /font-size:\s*[\d.]+px/;
const RADIUS_PX = /border-radius:[^;]*?(?:[3-9]|\d\d+)(?:\.\d+)?px/;
const FONT_WEIGHT = /font-weight:\s*([^;\s]+)/;
const ALLOWED_WEIGHTS = new Set(['400', '500', '600', 'inherit', 'normal']);
const TYPE_ALLOW = /ui-tokens-allow:\s*\S/;
const RGBA = /\b(?:rgba?|hsla?)\(/;
const Z_INDEX = /z-index:\s*([2-9]|\d\d+)/;
const Z_INDEX_JS = /zIndex:\s*([2-9]|\d\d+)/;
const ANY_VAR = /var\((--[\w-]+)/g;

/**
 * 从令牌文件收集全部定义名。规则「任何 var(--x) 无定义即报错」靠它兜底——
 * 枚举别名列表会漏（UI-01 曾漏 --bg-raised/--danger-border/--ease-out 三个名字 8 处引用），
 * 定义差集才是真相。
 */
const DEFINED_TOKENS = new Set(
  [...readFileSync(join(WEB, 'styles/01-tokens.css'), 'utf8').matchAll(/^\s*(--[\w-]+)\s*:/gm)].map(
    (m) => m[1],
  ),
);

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
  .filter((name) => /^0[2-9].*\.css$/.test(name))
  .map((name) => join(WEB, 'styles', name));

const sourceFiles = walk(WEB)
  .filter((file) => /\.(tsx?|jsx?)$/.test(file))
  .filter((file) => !IDENTITY_PALETTE_FILES.includes(file));

/** @type {string[]} */
const problems = [];
/** @type {Map<string, { fontSize: number; radius: number }>} */
const typeWarnings = new Map();
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
    // 无定义令牌（比枚举别名更强的兜底）：本地 var(--x) 注册函数/局部变量除外
    for (const match of line.matchAll(ANY_VAR)) {
      const name = match[1];
      if (!name || DEFINED_TOKENS.has(name)) continue;
      report(file, lineNo, line, `未定义令牌 ${name}`);
    }
  });
};

/**
 * 字号 / 圆角 / 字重（规则 5–7）：只查样式表。
 * @param {string} file
 */
const scanTypography = (file) => {
  const warnOnly = TYPE_WARN_ONLY_FILES.includes(file);
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const weight = FONT_WEIGHT.exec(line)?.[1];
    if (weight && !ALLOWED_WEIGHTS.has(weight)) report(file, lineNo, line, '字重不在 400/500/600');
    if (TYPE_ALLOW.test(line)) return;
    const isFontSize = FONT_SIZE_PX.test(line);
    const isRadius = RADIUS_PX.test(line);
    if (!isFontSize && !isRadius) return;
    if (warnOnly) {
      const key = relative(ROOT, file);
      const count = typeWarnings.get(key) ?? { fontSize: 0, radius: 0 };
      if (isFontSize) count.fontSize += 1;
      if (isRadius) count.radius += 1;
      typeWarnings.set(key, count);
      return;
    }
    if (isFontSize) report(file, lineNo, line, '写死字号（用 --fs-*）');
    if (isRadius) report(file, lineNo, line, '写死圆角（用 --r-*）');
  });
};

for (const file of styleFiles) scan(file, true);
for (const file of styleFiles) scanTypography(file);
for (const file of sourceFiles) scan(file, true);

// 身份色/插画文件：十六进制整文件放行，别名/z-index/未定义令牌仍查
for (const file of IDENTITY_PALETTE_FILES) {
  if (!existsSync(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (ALIASES.some((alias) => line.includes(`var(${alias})`))) {
      report(file, index + 1, line, '兼容别名');
    }
    if (Z_INDEX.test(line) || Z_INDEX_JS.test(line)) report(file, index + 1, line, '数字 z-index');
    for (const match of line.matchAll(ANY_VAR)) {
      const name = match[1];
      if (!name || DEFINED_TOKENS.has(name)) continue;
      report(file, index + 1, line, `未定义令牌 ${name}`);
    }
  });
}

if (typeWarnings.size > 0) {
  let fontSize = 0;
  let radius = 0;
  for (const count of typeWarnings.values()) {
    fontSize += count.fontSize;
    radius += count.radius;
  }
  console.warn(
    `⚠ 字号/圆角还没迁到令牌（只警告，不影响结果）：写死字号 ${fontSize} 处、写死圆角 ${radius} 处`,
  );
  for (const [file, count] of typeWarnings) {
    console.warn(`  ${file}：字号 ${count.fontSize}、圆角 ${count.radius}`);
  }
}

if (problems.length > 0) {
  console.error(`✗ UI 令牌检查未通过（${problems.length} 处）：`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`UI 令牌检查通过（${styleFiles.length} 个样式表 + ${sourceFiles.length} 个源码文件）`);
