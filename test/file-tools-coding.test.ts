import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileTools } from '../src/tools/builtin/files.js';
import { globMatcher } from '../src/tools/glob.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/tool.js';

const context = (): ToolContext => ({
  agentId: 'a1',
  projectIds: [],
  turnState: { workbench: { agentsCreated: 0, roomsCreated: 0 } },
});

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentbot-file-tools-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tools = (root = dir) => {
  const registry = ToolRegistry.from(createFileTools(root));
  return (name: string, args: unknown) =>
    registry.execute({ id: 'call', name, arguments: JSON.stringify(args) }, context());
};

describe('glob 过滤', () => {
  it('不含 / 的模式按文件名匹配，含 / 的按相对路径匹配', () => {
    const ts = globMatcher('*.ts');
    assert.ok(ts('a.ts'));
    assert.ok(ts('src/deep/b.ts'));
    assert.ok(!ts('a.tsx'));
    assert.ok(!ts('a.ts.bak'));
    const deep = globMatcher('src/**/*.ts');
    assert.ok(deep('src/a.ts'));
    assert.ok(deep('src/x/y/z.ts'));
    assert.ok(!deep('lib/a.ts'));
    assert.ok(!deep('src/a.tsx'));
    const tests = globMatcher('**/*.test.ts');
    assert.ok(tests('a.test.ts'));
    assert.ok(tests('test/x/a.test.ts'));
    assert.ok(!tests('a.spec.ts'));
    const one = globMatcher('src/*.ts');
    assert.ok(one('src/a.ts'));
    assert.ok(!one('src/x/a.ts'));
    const either = globMatcher('*.{ts,tsx}');
    assert.ok(either('a.ts'));
    assert.ok(either('b.tsx'));
    assert.ok(!either('c.js'));
    assert.ok(globMatcher('?.md')('a.md'));
    assert.ok(!globMatcher('?.md')('ab.md'));
    assert.ok(globMatcher('[ab].txt')('a.txt'));
    assert.ok(!globMatcher('[ab].txt')('c.txt'));
    assert.ok(globMatcher('[!ab].txt')('c.txt'));
    assert.ok(!globMatcher('[!ab].txt')('a.txt'));
    assert.ok(globMatcher('a+b(1).ts')('a+b(1).ts'), '正则特殊字符按字面匹配');
    assert.ok(globMatcher('./src/*.ts')('src/a.ts'), '开头的 ./ 忽略');
    assert.ok(globMatcher('docs/**')('docs/a/b.md'));
  });
});

describe('SearchFiles：完整覆盖、过滤与翻页', () => {
  it('第 100 个文件之后的内容也能搜到（旧实现只扫排序后的前 100 个）', async () => {
    const root = join(dir, 'many');
    await mkdir(root, { recursive: true });
    for (let index = 0; index < 160; index++) {
      await writeFile(
        join(root, `f${String(index).padStart(3, '0')}.ts`),
        index === 141 ? 'export class ToolRegistry {}\n' : `export const v${index} = ${index};\n`,
      );
    }
    const run = tools(root);
    const found = await run('SearchFiles', { query: 'class ToolRegistry' });
    assert.match(found, /f141\.ts:1: export class ToolRegistry/);
    assert.match(found, /扫描完成/);
  });

  it('翻页按命中推进，跨很多文件也能一直往后翻，直到搜完', async () => {
    const root = join(dir, 'paging');
    await mkdir(root, { recursive: true });
    for (let index = 0; index < 150; index++)
      await writeFile(join(root, `p${String(index).padStart(3, '0')}.txt`), `needle ${index}\n`);
    const run = tools(root);
    const seen = new Set<string>();
    let offset = 0,
      pages = 0;
    for (;;) {
      const page = await run('SearchFiles', { query: 'needle', limit: 50, offset });
      for (const match of page.matchAll(/^(p\d+\.txt):1:/gm)) seen.add(match[1]!);
      const next = /next_offset=(\d+)/.exec(page);
      if (!next) break;
      assert.ok(Number(next[1]) > offset, '翻页必须前进');
      offset = Number(next[1]);
      assert.ok(++pages < 10);
    }
    assert.equal(seen.size, 150);
  });

  it('glob 过滤文件，case_sensitive 区分大小写', async () => {
    const root = join(dir, 'filter');
    await mkdir(join(root, 'src', 'ui'), { recursive: true });
    await writeFile(join(root, 'src', 'ui', 'Button.tsx'), 'export function Button() {}\n');
    await writeFile(join(root, 'src', 'button.css'), '.button {}\n');
    await writeFile(join(root, 'README.md'), 'Button 文档\n');
    const run = tools(root);
    const tsx = await run('SearchFiles', { query: 'button', glob: '*.tsx' });
    assert.match(tsx, /Button\.tsx:1/);
    assert.ok(!tsx.includes('button.css'));
    assert.ok(!tsx.includes('README'));
    const exact = await run('SearchFiles', { query: 'Button', case_sensitive: true });
    assert.match(exact, /Button\.tsx/);
    assert.match(exact, /README\.md/);
    assert.ok(!exact.includes('button.css'));
    const scoped = await run('SearchFiles', { query: 'button', glob: 'src/**/*.css' });
    assert.match(scoped, /src\/button\.css:1/);
    assert.ok(!scoped.includes('Button.tsx'));
  });

  it('长行（压缩文件）也能命中行尾的内容，预览只截命中附近', async () => {
    const root = join(dir, 'minified');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'bundle.js'), 'x'.repeat(50_000) + 'NEEDLE_AT_END' + 'y'.repeat(100));
    const result = await tools(root)('SearchFiles', { query: 'needle_at_end' });
    assert.match(result, /bundle\.js:1: .*NEEDLE_AT_END/);
    assert.ok(result.length < 1000);
  });
});

describe('ListFiles：glob 当作找文件工具', () => {
  it('按模式列出匹配文件并给出总数', async () => {
    const root = join(dir, 'list');
    await mkdir(join(root, 'test', 'unit'), { recursive: true });
    await writeFile(join(root, 'test', 'unit', 'a.test.ts'), '');
    await writeFile(join(root, 'test', 'b.test.ts'), '');
    await writeFile(join(root, 'test', 'helper.ts'), '');
    const run = tools(root);
    const listed = await run('ListFiles', { glob: '**/*.test.ts' });
    assert.match(listed, /test\/b\.test\.ts/);
    assert.match(listed, /test\/unit\/a\.test\.ts/);
    assert.ok(!listed.includes('helper.ts'));
    assert.match(listed, /共 2 个/);
  });
});

describe('Edit：替换全部、诊断与 CRLF', () => {
  it('replace_all 替换所有命中并报告处数与行号', async () => {
    const path = join(dir, 'rename.ts');
    await writeFile(path, 'const oldName = 1;\nconsole.log(oldName);\nexport { oldName };\n');
    const result = await tools()('Edit', {
      path,
      old_text: 'oldName',
      new_text: 'newName',
      replace_all: true,
    });
    assert.match(result, /替换 3 处/);
    assert.equal(
      await readFile(path, 'utf8'),
      'const newName = 1;\nconsole.log(newName);\nexport { newName };\n',
    );
  });

  it('多处命中且没开 replace_all：报出处数与行号，文件不变', async () => {
    const path = join(dir, 'dup.ts');
    const body = 'a();\nb();\na();\n';
    await writeFile(path, body);
    const result = await tools()('Edit', { path, old_text: 'a();', new_text: 'c();' });
    assert.match(result, /^Error:/);
    assert.match(result, /命中 2 处/);
    assert.match(result, /第 1、3 行/);
    assert.match(result, /恰好命中一次/);
    assert.match(result, /replace_all/);
    assert.equal(await readFile(path, 'utf8'), body);
  });

  it('old_text 带着 Read 的行号前缀：明确提示去掉前缀', async () => {
    const path = join(dir, 'prefixed.ts');
    await writeFile(path, 'function a() {\n  return 1;\n}\n');
    const result = await tools()('Edit', {
      path,
      old_text: '1: function a() {\n2:   return 1;',
      new_text: 'x',
    });
    assert.match(result, /行号前缀/);
  });

  it('只差缩进/空白：指出最接近的行并给出原文', async () => {
    const path = join(dir, 'indent.ts');
    await writeFile(path, 'if (ok) {\n    run();\n    done();\n}\n');
    const result = await tools()('Edit', { path, old_text: '  run();\n  done();', new_text: '  go();' });
    assert.match(result, /第 2–3 行/);
    assert.match(result, /空白|缩进/);
    assert.match(result, / {4}run\(\);/);
  });

  it('第一行对得上但后面对不上：提示去 Read 那一段', async () => {
    const path = join(dir, 'drift.ts');
    await writeFile(path, 'start();\nmiddle();\nend();\n');
    const result = await tools()('Edit', { path, old_text: 'start();\nsomething_else();', new_text: 'x' });
    assert.match(result, /第 1 行/);
    assert.match(result, /Read/);
  });

  it('CRLF 文件：用 LF 写的 old_text 也能改，写回保持 CRLF', async () => {
    const path = join(dir, 'windows.txt');
    await writeFile(path, 'line1\r\nline2\r\nline3\r\n');
    const result = await tools()('Edit', { path, old_text: 'line1\nline2', new_text: 'first\nsecond' });
    assert.match(result, /已修改/);
    assert.equal(await readFile(path, 'utf8'), 'first\r\nsecond\r\nline3\r\n');
  });

  it('成功后回显改动处附近几行（带行号），不回显整个文件', async () => {
    const path = join(dir, 'snippet.ts');
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
    await writeFile(path, lines.join('\n'));
    const result = await tools()('Edit', {
      path,
      old_text: 'line 100\n',
      new_text: 'line 100 changed\nline 100b\n',
    });
    assert.match(result, /第 100–101 行/);
    assert.match(result, /^100: line 100 changed$/m);
    assert.match(result, /^101: line 100b$/m);
    assert.match(result, /^99: line 99$/m);
    assert.ok(!result.includes('line 150'));
  });

  it('Write 报告行数', async () => {
    const result = await tools()('Write', { path: join(dir, 'new.ts'), content: 'a\nb\nc\n' });
    assert.match(result, /3 行/);
  });
});
