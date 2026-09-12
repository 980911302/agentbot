#!/usr/bin/env node
/**
 * 文档检查（E1.6）：相对链接必须存在、代码围栏必须成对。
 * 范围：根 README.md 与 docs/*.md。链接锚点不做校验。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const files = ['README.md', ...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];

let failed = false;
for (const file of files) {
  const absolute = resolve(ROOT, file);
  const content = readFileSync(absolute, 'utf8');

  const fences = (content.match(/^```/gm) ?? []).length;
  if (fences % 2 !== 0) {
    console.error(`${file}: 代码围栏不成对（${fences} 个 \`\`\`）`);
    failed = true;
  }

  const links = [...content.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]);
  for (const link of links) {
    if (/^(https?:|#|mailto:)/.test(link)) continue;
    const clean = decodeURIComponent(link.split('#')[0]);
    if (!clean) continue;
    const target = isAbsolute(clean) ? clean : resolve(dirname(absolute), clean);
    if (!existsSync(target)) {
      console.error(`${file}: 相对链接失效 -> ${link}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log(`文档检查通过（${files.length} 个文件）`);
