import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, opendir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { defineTool } from '../tool.js';
import {
  assertNotSensitivePath,
  isSensitivePath,
  mightBeSensitiveName,
  sensitivePaths,
  type SensitivePaths,
} from '../sensitive-paths.js';
import { globMatcher } from '../glob.js';

const SCAN_BYTES = 32 * 1024 * 1024;
const FILE_BYTES = 2 * 1024 * 1024;
const READ_CHARS = 12000;
const LINE_CHARS = 2000;
/** column 的上限：续读提示必须落在 schema 允许的范围内 */
const MAX_COLUMN = 1000000;
const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.agentbot',
  '.next',
  'coverage',
  '__pycache__',
  'venv',
]);

/** 逐块读，不把大文件或单行压缩文件整体装进内存。扫描量也有硬上限。 */
export async function* textLines(path: string, signal?: AbortSignal, column = 1, maxBytes = SCAN_BYTES) {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 16384, signal });
  let bytes = 0,
    line = 1,
    length = 0,
    preview = '';
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
        length = 0;
        preview = '';
        start = newline + 1;
      }
    }
    yield { line, text: preview.replace(/\r$/, ''), truncated: length > column - 1 + LINE_CHARS };
  } finally {
    stream.destroy();
  }
}

export function createReadTool(rootDir = process.cwd(), paths: SensitivePaths = sensitivePaths(rootDir)) {
  return defineTool<{ path: string; offset?: number; limit?: number; column?: number }>({
    name: 'Read',
    description:
      '分段读取本机文本，默认 200 行，最多 500 行/12000 字符；相对路径基于工作区。offset 从 1 起，负数读末尾（最多 500 行）。长行每次最多 2000 字符，可用 column 从指定列续读；最多扫描 32MiB，不支持二进制。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: -500, maximum: 10000000 },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
        column: { type: 'integer', minimum: 1, maximum: MAX_COLUMN, default: 1 },
      },
      required: ['path'],
    },
    async execute({ path, offset = 1, limit = 200, column = 1 }, context) {
      if (!path.trim() || offset === 0) throw new Error('path 不能为空，offset 不能为 0');
      const absolute = resolve(rootDir, path.trim());
      // 密钥文件默认不读（OPT-07）：按真实路径判断，软链也挡
      await assertNotSensitivePath(absolute, paths);
      if (!(await stat(absolute)).isFile()) throw new Error('path 必须是文件');
      const budget = Math.min(READ_CHARS, 14000 - absolute.length - 512);
      const renderRow = (row: { line: number; text: string; truncated: boolean }) => {
        // column 有上限：到顶时明说读不到了，别给出一个 schema 会拒绝的续读值
        const next = column + LINE_CHARS;
        const hint =
          next <= MAX_COLUMN
            ? ` …[长行截断；column=${next} 续读本行]`
            : ' …[长行已到 column 上限，本行剩余内容读不到]';
        return row.line + ': ' + row.text + (row.truncated ? hint : '');
      };
      let rows: Array<{ line: number; text: string; truncated: boolean }> = [];
      let chars = 0,
        more = false;
      for await (const row of textLines(absolute, context.signal, column)) {
        if (offset < 0) {
          rows.push(row);
          if (rows.length > -offset) rows.shift();
          continue;
        }
        if (row.line < offset) continue;
        const size = renderRow(row).length + (rows.length ? 1 : 0);
        if (rows.length >= limit || chars + size > budget) {
          more = true;
          break;
        }
        rows.push(row);
        chars += size;
      }
      if (offset < 0) {
        const tail = rows;
        rows = [];
        chars = 0;
        for (const row of tail) {
          const size = renderRow(row).length + (rows.length ? 1 : 0);
          if (rows.length >= limit || chars + size > budget) {
            more = true;
            break;
          }
          rows.push(row);
          chars += size;
        }
      }
      const body = rows.map(renderRow).join('\n');
      return (
        absolute +
        '\n' +
        (body || '（范围内没有内容）') +
        (more ? '\n[本页已满，next_offset=' + ((rows.at(-1)?.line ?? offset) + 1) + ']' : '\n[已到文件末尾]')
      );
    },
  });
}

/** 目录枚举上限：目录项与目录数（再大的仓库请缩小 path 或用 glob） */
const SCAN_ENTRIES = 20000;
const SCAN_DIRS = 5000;
/** SearchFiles：单文件上限、单次总扫描量与耗时预算 */
const SEARCH_FILE_BYTES = 1024 * 1024;
const SEARCH_TOTAL_BYTES = 64 * 1024 * 1024;
const SEARCH_MS = 15_000;

async function scanFiles(root: string, signal: AbortSignal | undefined, paths: SensitivePaths) {
  const files: string[] = [],
    queue = [root];
  let visited = 0,
    capped = false;
  scan: for (let i = 0; i < queue.length; i++) {
    signal?.throwIfAborted();
    let dir: Awaited<ReturnType<typeof opendir>>;
    try {
      dir = await opendir(queue[i]!);
    } catch (error) {
      if (i === 0) throw error;
      continue; // 没权限读的子目录跳过，不让整次扫描失败
    }
    for await (const entry of dir) {
      signal?.throwIfAborted();
      if (++visited > SCAN_ENTRIES) {
        capped = true;
        break scan;
      }
      if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
      const path = join(queue[i]!, entry.name);
      if (entry.isDirectory()) {
        if (queue.length < SCAN_DIRS) queue.push(path);
        else capped = true;
      } else if (entry.isFile()) {
        // 密钥文件不进列表、不进搜索（数据目录名可配置，不能只靠隐藏目录过滤）；
        // 只有同名的才逐个核对真实路径，大仓库不必为每个文件做 realpath
        if (mightBeSensitiveName(entry.name) && (await isSensitivePath(path, paths))) continue;
        files.push(path);
      }
    }
  }
  return { files: files.sort(), capped };
}

/** 按 glob 过滤扫描结果（相对搜索根比较，统一用 / 分隔） */
function filterByGlob(files: string[], root: string, glob: string | undefined): string[] {
  if (!glob?.trim()) return files;
  const match = globMatcher(glob);
  return files.filter((file) => match(relative(root, file).split(sep).join('/')));
}

/** 读出可搜索的文本：超过单文件上限、二进制或读不了的返回 null */
async function searchableText(
  file: string,
  signal?: AbortSignal,
): Promise<{ text: string; bytes: number } | null> {
  const entry = await stat(file).catch(() => null);
  if (!entry?.isFile() || entry.size > SEARCH_FILE_BYTES) return null;
  try {
    const text = await readFile(file, { encoding: 'utf8', signal });
    return text.includes('\0') ? null : { text, bytes: entry.size };
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

/** 命中位置（原文下标）；不区分大小写时把折叠后的下标映射回原文 */
function locate(line: string, needle: string, caseSensitive: boolean): number {
  if (caseSensitive) return line.indexOf(needle);
  const lowered = line.toLowerCase();
  const at = lowered.indexOf(needle);
  if (at < 0 || lowered.length === line.length) return at;
  // toLowerCase 可能改变长度（如 İ→i̇）：逐字映射回原文下标，否则预览会错位
  let position = 0;
  let loweredSoFar = 0;
  while (loweredSoFar < at && position < line.length) {
    loweredSoFar += line[position]!.toLowerCase().length;
    position += 1;
  }
  return position;
}

export function createFileTools(rootDir = process.cwd(), paths: SensitivePaths = sensitivePaths(rootDir)) {
  const list = defineTool<{ path?: string; glob?: string; offset?: number; limit?: number }>({
    name: 'ListFiles',
    description:
      '递归列出文件路径，不读取内容；glob 可按文件名/路径过滤（如 *.ts、src/**/*.tsx、**/*.test.ts），用来按模式找文件。跳过隐藏目录（要看 .github 这类请直接写进 path）、依赖/构建目录及符号链接；最多枚举 20000 个目录项，默认返回 50 条，offset 从 0 起。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        glob: { type: 'string', description: '文件名或相对路径模式：*.ts、src/**/*.tsx、*.{js,ts}' },
        offset: { type: 'integer', minimum: 0, maximum: SCAN_ENTRIES },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    async execute({ path = '.', glob, offset = 0, limit = 50 }, context) {
      const root = resolve(rootDir, path);
      // 与 SearchFiles 一致：直接指过来的路径也要过密钥名单，并且给出面向用户的错误
      await assertNotSensitivePath(root, paths);
      const info = await stat(root).catch(() => null);
      if (!info) throw new Error(`路径不存在：${root}`);
      if (!info.isDirectory())
        throw new Error(`ListFiles 需要目录，收到的是文件：${root}（读文件请用 Read）`);
      const scan = await scanFiles(root, context.signal, paths);
      const files = filterByGlob(scan.files, root, glob);
      let next = offset,
        size = 0;
      const rows: string[] = [];
      for (const file of files.slice(offset, offset + limit)) {
        const row = relative(root, file);
        if (size + row.length + 1 > Math.min(10000, 12000 - root.length - 512)) break;
        rows.push(row);
        size += row.length + 1;
        next++;
      }
      return (
        root +
        '\n' +
        (rows.join('\n') || '（无）') +
        '\n' +
        (next < files.length
          ? `next_offset=${next}（共 ${files.length} 个）`
          : `本次扫描已列完（共 ${files.length} 个）`) +
        (scan.capped ? '；扫描达到上限，请缩小 path 或加 glob（这不是完整目录）' : '')
      );
    },
  });
  const search = defineTool<{
    query: string;
    path?: string;
    glob?: string;
    case_sensitive?: boolean;
    limit?: number;
    offset?: number;
  }>({
    name: 'SearchFiles',
    description:
      '在文件内容里搜字面文本（不是正则；默认忽略大小写，case_sensitive=true 区分），返回「路径:行号: 片段」；也可直接指定单个文件。glob 限定文件范围（如 *.ts、src/**/*.tsx）。单次最多搜 64MiB、单文件 ≤1MiB，默认 30 条命中，命中多时按 next_offset 翻页。跳过隐藏/依赖/构建目录；需要正则时用 Shell 跑 rg 或 grep -E。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        path: { type: 'string' },
        glob: { type: 'string', description: '只搜匹配的文件：*.ts、src/**/*.tsx、*.{js,ts}' },
        case_sensitive: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        offset: { type: 'integer', minimum: 0, maximum: 5000 },
      },
      required: ['query'],
    },
    async execute({ query, path = '.', glob, case_sensitive = false, limit = 30, offset = 0 }, context) {
      if (!query.trim()) throw new Error('query 不能为空');
      const root = resolve(rootDir, path);
      const info = await stat(root).catch(() => null);
      if (!info) throw new Error(`路径不存在：${root}`);
      // 直接指到某个文件时要单独过一遍密钥名单（目录扫描已跳过）
      if (info.isFile()) await assertNotSensitivePath(root, paths);
      const scan = info.isFile()
        ? { files: [root], capped: false }
        : await scanFiles(root, context.signal, paths);
      const files = info.isFile() ? scan.files : filterByGlob(scan.files, root, glob);
      const needle = case_sensitive ? query : query.toLowerCase();
      const rows: string[] = [];
      const deadline = Date.now() + SEARCH_MS;
      let hits = 0,
        size = 0,
        bytes = 0,
        searched = 0,
        skipped = 0,
        full = false,
        unsearched = -1;
      outer: for (let index = 0; index < files.length; index++) {
        context.signal?.throwIfAborted();
        if (bytes >= SEARCH_TOTAL_BYTES || Date.now() > deadline) {
          unsearched = index;
          break;
        }
        const file = files[index]!;
        const loaded = await searchableText(file, context.signal);
        if (!loaded) {
          skipped++;
          continue;
        }
        bytes += loaded.bytes;
        searched++;
        // 整个文件先粗筛一遍，绝大多数不含命中的文件不必逐行拆分
        if (!(case_sensitive ? loaded.text : loaded.text.toLowerCase()).includes(needle)) continue;
        const label = info.isFile() ? file : relative(root, file);
        const lines = loaded.text.split('\n');
        for (let line = 0; line < lines.length; line++) {
          const raw = lines[line]!;
          const at = locate(raw, needle, case_sensitive);
          if (at < 0 || hits++ < offset) continue;
          const row = `${label}:${line + 1}: ${raw.slice(Math.max(0, at - 80), at + 200).replace(/\r$/, '')}`;
          if (rows.length >= limit || size + row.length > 10000) {
            full = true;
            break outer;
          }
          rows.push(row);
          size += row.length + 1;
        }
      }
      const notes: string[] = [];
      if (full)
        notes.push(
          `命中较多，本页 ${rows.length} 条；next_offset=${offset + rows.length} 继续翻页，或加 glob / 缩小 path`,
        );
      if (unsearched >= 0)
        notes.push(
          `未搜完：已搜 ${searched} 个文件，${relative(root, files[unsearched]!)} 起还有 ${files.length - unsearched} 个没搜；请缩小 path 或加 glob`,
        );
      if (scan.capped) notes.push(`目录过大，只枚举了前 ${SCAN_ENTRIES} 个目录项，结果不完整；请缩小 path`);
      if (!notes.length) notes.push(`扫描完成：共搜索 ${searched} 个文件`);
      return (
        (rows.join('\n') || '本次范围内没有命中') +
        '\n[' +
        notes.join('；') +
        ']' +
        (skipped ? '（跳过 ' + skipped + ' 个超过 1MiB/二进制/不可读的文件）' : '')
      );
    },
  });
  const write = defineTool<{ path: string; content: string; overwrite?: boolean; append?: boolean }>({
    name: 'Write',
    description:
      '写文本文件，每次最多 32000 字符，产物最多 2MiB。不回显全文。默认只新建；覆盖已有文件必须 overwrite=true；可 append=true 分块追加，不能同时 overwrite。大修改用 Edit。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        content: { type: 'string' },
        overwrite: { type: 'boolean' },
        append: { type: 'boolean' },
      },
      required: ['path', 'content'],
    },
    async execute(args, context) {
      const path = resolve(rootDir, args.path);
      // 密钥文件不允许由工具改写（写坏密钥会让用户彻底连不上模型）
      await assertNotSensitivePath(path, paths);
      return withFileLock(path, async () => {
        if (args.append && args.overwrite) throw new Error('append 和 overwrite 不能同时启用');
        const current = await writableText(path, context.signal);
        if (current !== null && !args.append && !args.overwrite)
          throw new Error('文件已存在；请先 Read，再 Edit 或显式 overwrite=true');
        const text = args.append ? (current ?? '') + args.content : args.content;
        await saveText(path, text, current, context.signal);
        return `已${args.append ? '追加' : '写入'} ${path}（${lineCount(text)} 行，${Buffer.byteLength(text)} 字节；sha256=${hash(text)}）`;
      });
    },
  });
  const edit = defineTool<{
    path: string;
    old_text: string;
    new_text: string;
    replace_all?: boolean;
    expected_sha256?: string;
  }>({
    name: 'Edit',
    description:
      '精确替换文本：old_text 默认必须恰好命中一次（避免误改），replace_all=true 时替换全部命中（如改名）；每段最多 16000 字符，文件最多 2MiB。old_text 按文件原文写，不要带 Read 的行号前缀；CRLF 文件可直接用换行写。可传 expected_sha256 防止覆盖别人的新改动。成功后回显改动处附近几行（带行号）；没命中会指出最接近的位置。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        old_text: { type: 'string', minLength: 1 },
        new_text: { type: 'string' },
        replace_all: { type: 'boolean', description: 'true = 替换全部命中；默认只允许恰好一处' },
        expected_sha256: { type: 'string', minLength: 64, maxLength: 64 },
      },
      required: ['path', 'old_text', 'new_text'],
    },
    async execute(args, context) {
      const path = resolve(rootDir, args.path);
      await assertNotSensitivePath(path, paths);
      return withFileLock(path, async () => {
        const current = await writableText(path, context.signal);
        if (current === null) throw new Error('文件不存在');
        if (args.expected_sha256 && hash(current) !== args.expected_sha256)
          throw new Error('文件已改变，请重新读取');
        const plan = planEdit(current, args.old_text, args.new_text, args.replace_all === true);
        await saveText(path, plan.next, current, context.signal);
        const where =
          plan.lines.length > 1
            ? `替换 ${plan.lines.length} 处（第 ${listLines(plan.lines)} 行），首处${lineRange(plan.start, plan.end)}`
            : lineRange(plan.start, plan.end);
        return `已修改 ${path}（${where}；${Buffer.byteLength(plan.next)} 字节；sha256=${hash(plan.next)}）\n${snippet(plan.next, plan.start, plan.end)}`;
      });
    },
  });
  return [createReadTool(rootDir, paths), list, search, write, edit];
}

interface EditPlan {
  next: string;
  /** 每处替换在新文本里的起始行 */
  lines: number[];
  /** 首处替换在新文本里的行范围（回显用） */
  start: number;
  end: number;
}

/**
 * 算出替换后的全文；old_text 没命中/命中多处时抛出带定位信息的错误（文件不动）。
 * CRLF 文件：Read 显示的行已去掉 \r，模型按 LF 写的 old_text 在这里按 CRLF 再找一次，写回也保持 CRLF。
 */
export function planEdit(current: string, oldText: string, newText: string, replaceAll: boolean): EditPlan {
  let find = oldText,
    replace = newText;
  let positions = occurrences(current, find);
  if (!positions.length && current.includes('\r\n') && oldText.includes('\n') && !oldText.includes('\r')) {
    const crlf = oldText.replace(/\n/g, '\r\n');
    const found = occurrences(current, crlf);
    if (found.length) {
      find = crlf;
      replace = newText.replace(/\r?\n/g, '\r\n');
      positions = found;
    }
  }
  if (!positions.length) throw new Error(missHint(current, oldText));
  if (positions.length > 1 && !replaceAll) {
    const lines = [...new Set(lineNumbers(current, positions))];
    throw new Error(
      `old_text 命中 ${positions.length} 处（第 ${listLines(lines)} 行），必须恰好命中一次：补充上下文让它唯一，或设 replace_all=true 全部替换`,
    );
  }
  // 重叠命中只取不重叠的那些（replace_all 从左到右替换）
  const targets: number[] = [];
  for (const at of positions) if (!targets.length || at >= targets.at(-1)! + find.length) targets.push(at);
  let next = '',
    last = 0;
  const starts: number[] = [];
  for (const at of targets) {
    next += current.slice(last, at);
    starts.push(next.length);
    next += replace;
    last = at + find.length;
  }
  next += current.slice(last);
  const lines = lineNumbers(next, starts);
  const start = lines[0]!;
  const end = start + Math.max(0, replace.replace(/\r?\n$/, '').split('\n').length - 1);
  return { next, lines, start, end };
}

/** 所有命中位置（含重叠命中：「aa」在「aaa」里算两处，单处替换时视为有歧义） */
function occurrences(text: string, find: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(find); at >= 0 && found.length < 10000; at = text.indexOf(find, at + 1))
    found.push(at);
  return found;
}

/** 递增的下标 → 所在行号（1 起），一次扫描算完 */
function lineNumbers(text: string, positions: number[]): number[] {
  const lines: number[] = [];
  let line = 1,
    newline = text.indexOf('\n');
  for (const at of positions) {
    while (newline >= 0 && newline < at) {
      line++;
      newline = text.indexOf('\n', newline + 1);
    }
    lines.push(line);
  }
  return lines;
}

function listLines(lines: number[]): string {
  return lines.slice(0, 10).join('、') + (lines.length > 10 ? ' 等' : '');
}

function lineRange(start: number, end: number): string {
  return start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`;
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** 改动处前后各 2 行（带行号，格式同 Read），最多 14 行 / 1200 字符 */
function snippet(text: string, start: number, end: number): string {
  const lines = text.split('\n');
  const from = Math.max(1, start - 2);
  const to = Math.min(lines.length, end + 2, from + 13);
  const rows: string[] = [];
  let size = 0;
  for (let line = from; line <= to; line++) {
    const body = lines[line - 1]!.replace(/\r$/, '');
    const row = `${line}: ${body.length > 200 ? body.slice(0, 200) + '…' : body}`;
    if (size + row.length > 1200) {
      rows.push('…');
      break;
    }
    rows.push(row);
    size += row.length + 1;
  }
  return rows.join('\n');
}

/** old_text 没命中时，尽量指出原因和最接近的位置，让下一次改动一次成功 */
function missHint(current: string, oldText: string): string {
  const base = 'old_text 在文件里没有找到';
  const oldLines = oldText.split('\n').map((line) => line.replace(/\r$/, ''));
  const meaningful = oldLines.filter((line) => line.trim());
  if (meaningful.length && meaningful.every((line) => /^\s*\d+: /.test(line))) {
    return `${base}：old_text 每行都带着 Read 输出的行号前缀（如「12: 」），那不是文件内容；去掉前缀按原文再试`;
  }
  const normalize = (line: string) => line.trim().replace(/\s+/g, ' ');
  const fileLines = current.split('\n').map((line) => line.replace(/\r$/, ''));
  let first = 0,
    last = oldLines.length;
  while (first < last && !oldLines[first]!.trim()) first++;
  while (last > first && !oldLines[last - 1]!.trim()) last--;
  const wanted = oldLines.slice(first, last).map(normalize);
  if (wanted.length) {
    const candidates: number[] = [];
    for (let line = 0; line + wanted.length <= fileLines.length && candidates.length < 3; line++) {
      if (wanted.every((text, offset) => normalize(fileLines[line + offset]!) === text))
        candidates.push(line);
    }
    if (candidates.length) {
      const at = candidates[0]!;
      const original = fileLines.slice(at, at + wanted.length).join('\n');
      const more = candidates.length > 1 ? `（另有 ${candidates.length - 1} 处相似）` : '';
      return `${base}，但${lineRange(at + 1, at + wanted.length)}只差空白/缩进${more}。文件里的原文是：\n${original.length > 800 ? original.slice(0, 800) + '…' : original}\n请按原文（含缩进）重写 old_text`;
    }
    const anchor = wanted[0]!;
    let lines = fileLines.flatMap((line, index) => (normalize(line) === anchor ? [index + 1] : []));
    if (!lines.length && anchor.length >= 8)
      lines = fileLines.flatMap((line, index) => (normalize(line).includes(anchor) ? [index + 1] : []));
    if (lines.length) {
      return `${base}：它的第一行出现在第 ${listLines(lines.slice(0, 3))} 行，但后面的内容对不上（文件可能已被改过）；请先 Read 那一段（如 offset=${Math.max(1, lines[0]! - 3)}）再按原文改`;
    }
  }
  return `${base}（文件可能已被改过）；请先 Read 目标位置，按当前原文重写 old_text`;
}

const locks = new Set<string>();
async function withFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  if (locks.has(path)) throw new Error('文件正在被另一个工具修改，请稍后重试');
  locks.add(path);
  try {
    return await work();
  } finally {
    locks.delete(path);
  }
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function writableText(path: string, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > FILE_BYTES)
    throw new Error('仅可修改 ≤2MiB 的普通文本文件，不允许符号链接');
  const text = await readFile(path, { encoding: 'utf8', signal });
  if (Buffer.byteLength(text) > FILE_BYTES || text.includes('\0') || text.includes('\ufffd'))
    throw new Error('文件超限或不是有效 UTF-8 文本');
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
    if ((await writableText(path, signal)) !== previous)
      throw new Error('写入期间文件发生变化，请重新读取后重试');
    signal?.throwIfAborted();
    if (previous === null) await link(temp, path);
    else await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
