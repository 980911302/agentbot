#!/usr/bin/env node
/**
 * 跨层 import 约束（E1.4）：把「契约与现实冲突」变成 CI 红。
 *
 * 四条规则（对应工程契约 §2 架构契约）：
 *   R1 src/shared/contracts/**   不得引用 Node 内置、外部包、或契约层之外的任何模块
 *      （契约 = 纯类型 + 纯校验，是前后端唯一线上契约来源）
 *   R2 web/src/**                不得「值导入」后端；唯一例外是 src/shared/contracts 内的
 *      纯模块（只含类型与纯函数，由 R1 保证零 Node 依赖，vite 可直接打包）
 *   R3 src/server/routes/**      不得直接 import src/storage/**（路由只经 runtime 门面）
 *   R4 src/tools/builtin/**      不得 import src/server/runtime.ts 门面（工具拿不到整个 Runtime）
 *
 * 判定口径：
 *   - `import type ...` / `export type ... from ...` 视为类型引用（除 R1 外不拦）；
 *   - `import(...)`、副作用 import、具名/默认值导入都视为值引用；
 *   - 解析器只做路径映射（.js→.ts、目录→index），不解析 node_modules。
 *
 * 用法：node scripts/check-imports.mjs [rootDir]   （零依赖；rootDir 供测试指向临时夹具）
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)));
const CONTRACTS_DIR = join(ROOT, 'src/shared/contracts');
const RUNTIME_FACADE = join(ROOT, 'src/server/runtime.ts');

const SCAN_DIRS = ['src', 'web/src'];
const SOURCE_EXT = /\.(tsx?|mjs|js)$/;

/** @param {string} dir @param {string[]} out @returns {string[]} */
function walk(dir, out = []) {
  /** @type {string[]} */
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // 目录不存在（测试夹具只搭一半树）时按空处理
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * 把 import 说明符解析成磁盘路径；外部包/node: 返回 null。
 * 仓库用 ESM 约定写 `from './x.js'`，磁盘上是 x.ts——必须做扩展名互换，
 * 否则所有 .js 后缀导入都解析不到（规则会形同虚设）。
 */
/** @param {string} specifier @param {string} fromFile @returns {string | null} */
function resolveSpecifier(specifier, fromFile) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  const withoutExt = base.replace(/\.[cm]?js$/, '');
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${withoutExt}.ts`,
    `${withoutExt}.tsx`,
    `${withoutExt}.mts`,
    `${withoutExt}.js`,
    `${withoutExt}.mjs`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  return (
    candidates.find((candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) ?? null
  );
}

/**
 * 抽出文件里的模块引用：{ specifier, typeOnly, line }
 * 只认三种真实形态，避免把 `export type X = 'a' | 'b'` 误判成模块引用：
 *   1. import/export ... from '...'（可跨行，中段不允许出现分号——import 语句里没有分号）
 *   2. import '...'（副作用导入）
 *   3. import('...')（动态导入，视为值引用）
 * typeOnly 只认 `import type` / `export type` 整句形式（行内 { type X } 混用按值引用算，
 * 宁可误报也不放过「值导入」——误报可以改写法，漏报会腐蚀边界）。
 *
 * @param {string} source
 * @returns {{ specifier: string; typeOnly: boolean; line: number }[]}
 */
function extractImports(source) {
  const found = [];
  const withFrom = /(?:^|\n)\s*(import|export)\s+([^;]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  let match = withFrom.exec(source);
  while (match !== null) {
    const [text, keyword] = match;
    const specifier = match[3];
    if (!specifier) continue;
    const typeOnly = new RegExp(`${keyword}\\s+type\\b`).test(text);
    const line = source.slice(0, match.index).split('\n').length;
    found.push({ specifier, typeOnly, line });
    match = withFrom.exec(source);
  }
  for (const sideEffect of source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
    const specifier = sideEffect[1];
    if (!specifier) continue;
    found.push({ specifier, typeOnly: false, line: source.slice(0, sideEffect.index).split('\n').length });
  }
  for (const dynamic of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier = dynamic[1];
    if (!specifier) continue;
    found.push({ specifier, typeOnly: false, line: 0 });
  }
  return found;
}

/** @type {string[]} */
const violations = [];
/** @param {string} file @param {{ specifier: string; line: number }} entry @param {string} rule */
const report = (file, entry, rule) => {
  const where = entry.line > 0 ? `:${entry.line}` : '';
  violations.push(`${relative(ROOT, file)}${where} [${rule}] '${entry.specifier}'`);
};

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const imports = extractImports(readFileSync(file, 'utf8'));
    const underContracts = file.startsWith(`${CONTRACTS_DIR}/`);
    const underWeb = file.startsWith(`${join(ROOT, 'web/src')}/`);
    const underRoutes = file.startsWith(`${join(ROOT, 'src/server/routes')}/`);
    const underBuiltin = file.startsWith(`${join(ROOT, 'src/tools/builtin')}/`);

    for (const entry of imports) {
      const external = !entry.specifier.startsWith('.');
      const resolved = external ? null : resolveSpecifier(entry.specifier, file);
      // 只有解析进后端源码树才算「后端导入」；web 内部相对导入不拦
      const fromBackend = resolved !== null && resolved.startsWith(`${join(ROOT, 'src')}/`);

      if (
        underContracts &&
        (entry.specifier.startsWith('node:') || (external && !entry.specifier.startsWith('.')))
      ) {
        report(file, entry, 'R1 契约层禁止引用 Node/外部模块');
        continue;
      }
      if (underContracts && resolved && !resolved.startsWith(`${CONTRACTS_DIR}/`)) {
        report(file, entry, 'R1 契约层禁止引用契约之外的模块');
        continue;
      }
      if (underWeb && entry.specifier.startsWith('node:')) {
        report(file, entry, 'R2 前端禁止引用 Node 内置');
        continue;
      }
      if (underWeb && fromBackend && !entry.typeOnly && !resolved.startsWith(`${CONTRACTS_DIR}/`)) {
        report(file, entry, 'R2 前端只允许 import type 后端（例外：contracts 纯模块）');
        continue;
      }
      if (underRoutes && fromBackend && resolved.startsWith(`${join(ROOT, 'src/storage')}/`)) {
        report(file, entry, 'R3 路由不得直接 import storage');
        continue;
      }
      if (underBuiltin && resolved === RUNTIME_FACADE) {
        report(file, entry, 'R4 工具不得 import runtime 门面');
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`✗ 跨层 import 检查未通过（${violations.length} 处）：`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log(
  '跨层 import 检查通过（R1 契约纯净 / R2 前端只类型导入 / R3 路由不碰 storage / R4 工具不碰门面）',
);
