import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, opendir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { defineTool } from '../tool.js';
import { assertNotSensitivePath, isSensitivePath, sensitivePaths, type SensitivePaths } from '../sensitive-paths.js';

const SCAN_BYTES = 32 * 1024 * 1024;
const FILE_BYTES = 2 * 1024 * 1024;
const READ_CHARS = 12000;
const LINE_CHARS = 2000;
const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.agentbot', '.next']);

/** 逐块读，不把大文件或单行压缩文件整体装进内存。扫描量也有硬上限。 */
export async function* textLines(path: string, signal?: AbortSignal, column = 1, maxBytes = SCAN_BYTES) {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 16384, signal });
  let bytes = 0, line = 1, length = 0, preview = '';
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const text = String(chunk);
      bytes += Buffer.byteLength(text);
      if (bytes > maxBytes) throw new Error('扫描达到 ' + maxBytes + ' 字节上限，请缩小文件/搜索范围');
      if (text.includes('\0')) throw new Error('不支持二进制文件，请使用文本文件');
      let start = 0;
      while (start < text.length) {
        const newline = text.indexOf('\n', start);
        const end = newline < 0 ? text.length : newline;
        const part = text.slice(start, end);
        const from = Math.max(0, column - 1 - length);
        const to = Math.max(0, Math.min(part.length, column - 1 + LINE_CHARS - length));
        if (to > from) preview += part.slice(from, to);
        length += part.length;
        if (newline < 0) break;
        yield { line: line++, text: preview.replace(/\r$/, ''), truncated: length > column - 1 + LINE_CHARS };
        length = 0; preview = ''; start = newline + 1;
      }
    }
    yield { line, text: preview.replace(/\r$/, ''), truncated: length > column - 1 + LINE_CHARS };
  } finally { stream.destroy(); }
}

export function createReadTool(rootDir = process.cwd(), paths: SensitivePaths = sensitivePaths(rootDir)) {
  return defineTool<{ path: string; offset?: number; limit?: number; column?: number }>({
    name: 'Read',
    description: '分段读取本机文本，默认 200 行，最多 500 行/12000 字符；相对路径基于工作区。offset 从 1 起，负数读末尾（最多 500 行）。长行每次最多 2000 字符，可用 column 从指定列续读；最多扫描 32MiB，不支持二进制。',
    parameters: {
      type: 'object', properties: {
        path: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: -500, maximum: 10000000 },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
        column: { type: 'integer', minimum: 1, maximum: 1000000, default: 1 },
      }, required: ['path'],
    },
    async execute({ path, offset = 1, limit = 200, column = 1 }, context) {
      if (!path.trim() || offset === 0) throw new Error('path 不能为空，offset 不能为 0');
      const absolute = resolve(rootDir, path.trim());
      // 密钥文件默认不读（OPT-07）：按真实路径判断，软链也挡
      await assertNotSensitivePath(absolute, paths);
      if (!(await stat(absolute)).isFile()) throw new Error('path 必须是文件');
      const budget = Math.min(READ_CHARS, 14000 - absolute.length - 512);
      const renderRow = (row: { line: number; text: string; truncated: boolean }) => row.line + ': ' + row.text + (row.truncated ? ' …[长行截断；column=' + (column + LINE_CHARS) + ' 续读本行]' : '');
      let rows: Array<{ line: number; text: string; truncated: boolean }> = [];
      let chars = 0, more = false;
      for await (const row of textLines(absolute, context.signal, column)) {
        if (offset < 0) {
          rows.push(row);
          if (rows.length > -offset) rows.shift();
          continue;
        }
        if (row.line < offset) continue;
        const size = renderRow(row).length + (rows.length ? 1 : 0);
        if (rows.length >= limit || chars + size > budget) { more = true; break; }
        rows.push(row); chars += size;
      }
      if (offset < 0) {
        const tail = rows; rows = []; chars = 0;
        for (const row of tail) {
          const size = renderRow(row).length + (rows.length ? 1 : 0);
          if (rows.length >= limit || chars + size > budget) { more = true; break; }
          rows.push(row); chars += size;
        }
      }
      const body = rows.map(renderRow).join('\n');
      return absolute + '\n' + (body || '（范围内没有内容）') + (more ? '\n[本页已满，next_offset=' + ((rows.at(-1)?.line ?? offset) + 1) + ']' : '\n[已到文件末尾]');
    },
  });
}

async function scanFiles(root: string, signal: AbortSignal | undefined, paths: SensitivePaths) {
  const files: string[] = [], queue = [root];
  let visited = 0;
  for (let i = 0; i < queue.length; i++) {
    signal?.throwIfAborted();
    const dir = await opendir(queue[i]!);
    for await (const entry of dir) {
      signal?.throwIfAborted();
      if (++visited > 5000) return { files: files.sort(), capped: true };
      if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
      const path = join(queue[i]!, entry.name);
      // 密钥文件不进列表、不进搜索（数据目录名可配置，不能只靠隐藏目录过滤）
      if (await isSensitivePath(path, paths)) continue;
      if (entry.isDirectory() && queue.length < 500) queue.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return { files: files.sort(), capped: queue.length >= 500 };
}

export function createFileTools(rootDir = process.cwd(), paths: SensitivePaths = sensitivePaths(rootDir)) {
  const list = defineTool<{ path?: string; offset?: number; limit?: number }>({
    name: 'ListFiles', description: '递归列出文件路径，不读取内容。跳过隐藏/依赖/构建目录及符号链接；最多扫描 5000 条目录项/500 个目录，默认返回 50 条；大目录请缩小 path。offset 从 0 起。',
    parameters: { type: 'object', properties: {
      path: { type: 'string' }, offset: { type: 'integer', minimum: 0, maximum: 5000 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    } },
    async execute({ path = '.', offset = 0, limit = 50 }, context) {
      const root = resolve(rootDir, path);
      const scan = await scanFiles(root, context.signal, paths);
      let next = offset, size = 0;
      const rows: string[] = [];
      for (const file of scan.files.slice(offset, offset + limit)) {
        const row = relative(root, file);
        if (size + row.length + 1 > Math.min(10000, 12000 - root.length - 512)) break;
        rows.push(row); size += row.length + 1; next++;
      }
      return root + '\n' + (rows.join('\n') || '（无）') + '\n' + (next < scan.files.length ? 'next_offset=' + next : '本次扫描已列完') + (scan.capped ? '；扫描达到上限，请缩小 path（这不是完整目录）' : '');
    },
  });
  const search = defineTool<{ query: string; path?: string; limit?: number; offset?: number }>({
    name: 'SearchFiles', description: '搜索文本字面量（忽略大小写，不是正则）。最多扫描 100 个文件/总计 8MiB，单文件 ≤1MiB；默认 30 条命中，含路径/行号/短预览。长行仅搜索前 2000 字符；大仓库先 ListFiles，再缩小 path。也可直接指定文件。',
    parameters: { type: 'object', properties: {
      query: { type: 'string', minLength: 1 }, path: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, offset: { type: 'integer', minimum: 0, maximum: 5000 },
    }, required: ['query'] },
    async execute({ query, path = '.', limit = 30, offset = 0 }, context) {
      if (!query.trim()) throw new Error('query 不能为空');
      const root = resolve(rootDir, path), info = await stat(root);
      // 直接指到某个文件时要单独过一遍密钥名单（目录扫描已跳过）
      if (info.isFile()) await assertNotSensitivePath(root, paths);
      const scan = info.isFile() ? { files: [root], capped: false } : await scanFiles(root, context.signal, paths);
      let bytes = 0, count = 0, hits = 0, size = 0, capped = scan.capped, skipped = 0;
      const rows: string[] = [];
      outer: for (const file of scan.files) {
        const entry = await stat(file).catch(() => null);
        if (!entry || entry.size > 1024 * 1024) { skipped++; continue; }
        if (++count > 100 || bytes + entry.size > 8 * 1024 * 1024) { capped = true; break; }
        bytes += entry.size;
        try {
          for await (const row of textLines(file, context.signal, 1, 1024 * 1024)) {
            if (row.truncated) capped = true;
            const position = row.text.toLowerCase().indexOf(query.toLowerCase());
            if (position < 0 || hits++ < offset) continue;
            const result = (info.isFile() ? file : relative(root, file)) + ':' + row.line + ': ' + row.text.slice(Math.max(0, position - 80), position + 200);
            if (rows.length >= limit || size + result.length > 10000) { capped = true; break outer; }
            rows.push(result); size += result.length + 1;
          }
        } catch { context.signal?.throwIfAborted(); skipped++; }
      }
      return (rows.join('\n') || '本次范围内没有命中') + '\n' + (capped ? '[结果不完整；next_offset=' + (offset + rows.length) + '，或缩小 path 后重查]' : '[扫描完成]') + (skipped ? '（跳过 ' + skipped + ' 个超限/二进制/不可读文件）' : '');
    },
  });
  const write = defineTool<{ path: string; content: string; overwrite?: boolean; append?: boolean }>({
    name: 'Write', description: '写文本文件，每次最多 32000 字符，产物最多 2MiB。不回显全文。默认只新建；覆盖已有文件必须 overwrite=true；可 append=true 分块追加，不能同时 overwrite。大修改用 Edit。',
    parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' }, overwrite: { type: 'boolean' }, append: { type: 'boolean' } }, required: ['path', 'content'] },
    async execute(args, context) {
      const path = resolve(rootDir, args.path);
      // 密钥文件不允许由工具改写（写坏密钥会让用户彻底连不上模型）
      await assertNotSensitivePath(path, paths);
      return withFileLock(path, async () => {
        if (args.append && args.overwrite) throw new Error('append 和 overwrite 不能同时启用');
        const current = await writableText(path, context.signal);
        if (current !== null && !args.append && !args.overwrite) throw new Error('文件已存在；请先 Read，再 Edit 或显式 overwrite=true');
        const text = args.append ? (current ?? '') + args.content : args.content;
        await saveText(path, text, current, context.signal);
        return '已' + (args.append ? '追加' : '写入') + ' ' + path + '（' + Buffer.byteLength(text) + ' 字节；sha256=' + hash(text) + '）';
      });
    },
  });
  const edit = defineTool<{ path: string; old_text: string; new_text: string; expected_sha256?: string }>({
    name: 'Edit', description: '精确替换文本，old_text 必须恰好匹配一次，避免误改；每段最多 16000 字符，文件最多 2MiB。可传 expected_sha256 防止覆盖其它人新改动。结果不回显文件。',
    parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, old_text: { type: 'string', minLength: 1 }, new_text: { type: 'string' }, expected_sha256: { type: 'string', maxLength: 64 } }, required: ['path', 'old_text', 'new_text'] },
    async execute(args, context) {
      const path = resolve(rootDir, args.path);
      await assertNotSensitivePath(path, paths);
      return withFileLock(path, async () => {
        const current = await writableText(path, context.signal);
        if (current === null) throw new Error('文件不存在');
        if (args.expected_sha256 && hash(current) !== args.expected_sha256) throw new Error('文件已改变，请重新读取');
        const index = current.indexOf(args.old_text);
        if (index < 0 || current.indexOf(args.old_text, index + 1) >= 0) throw new Error('old_text 必须恰好命中一次，请补充上下文');
        const next = current.slice(0, index) + args.new_text + current.slice(index + args.old_text.length);
        await saveText(path, next, current, context.signal);
        return '已修改 ' + path + '（' + Buffer.byteLength(next) + ' 字节；sha256=' + hash(next) + '）';
      });
    },
  });
  return [createReadTool(rootDir, paths), list, search, write, edit];
}

const locks = new Set<string>();
async function withFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  if (locks.has(path)) throw new Error('文件正在被另一个工具修改，请稍后重试');
  locks.add(path);
  try { return await work(); } finally { locks.delete(path); }
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function writableText(path: string, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > FILE_BYTES) throw new Error('仅可修改 ≤2MiB 的普通文本文件，不允许符号链接');
  const text = await readFile(path, { encoding: 'utf8', signal });
  if (Buffer.byteLength(text) > FILE_BYTES || text.includes('\0') || text.includes('\ufffd')) throw new Error('文件超限或不是有效 UTF-8 文本');
  return text;
}
async function saveText(path: string, text: string, previous: string | null, signal?: AbortSignal) {
  if (Buffer.byteLength(text) > FILE_BYTES) throw new Error('写入后文件超过 2MiB，请拆分文件');
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    const mode = previous === null ? undefined : (await stat(path)).mode;
    await writeFile(temp, text, { flag: 'wx', encoding: 'utf8', signal, mode });
    if (await writableText(path, signal) !== previous) throw new Error('写入期间文件发生变化，请重新读取后重试');
    signal?.throwIfAborted();
    if (previous === null) await link(temp, path);
    else await rename(temp, path);
  } finally { await unlink(temp).catch(() => undefined); }
}
