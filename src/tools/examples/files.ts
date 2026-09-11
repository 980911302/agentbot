import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { defineTool } from '../tool.js';

const MAX_READ_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;

function resolveInside(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('path escapes the sandbox root');
  }
  return absolute;
}

export function createReadFileTool(rootDir: string = process.cwd()) {
  const root = resolve(rootDir);

  return defineTool<{ path: string }>({
    name: 'read_file',
    description: `Read a UTF-8 text file. Paths resolve against "${root}" and cannot escape it.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
      },
      required: ['path'],
    },
    async execute({ path }) {
      const buffer = await readFile(resolveInside(root, path));
      if (buffer.byteLength > MAX_READ_BYTES) {
        throw new Error(`file is larger than ${MAX_READ_BYTES} bytes`);
      }
      return buffer.toString('utf8');
    },
  });
}

export function createWriteFileTool(rootDir: string = process.cwd()) {
  const root = resolve(rootDir);

  return defineTool<{ path: string; content: string }>({
    name: 'write_file',
    description: `Create or overwrite a UTF-8 text file. Paths resolve against "${root}" and cannot escape it.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
    async execute({ path, content }) {
      if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
        throw new Error(`content is larger than ${MAX_WRITE_BYTES} bytes`);
      }
      const target = resolveInside(root, path);
      await writeFile(target, content, 'utf8');
      return `wrote ${path} (${Buffer.byteLength(content, 'utf8')} bytes)`;
    },
  });
}

export function createListFilesTool(rootDir: string = process.cwd()) {
  const root = resolve(rootDir);

  return defineTool<{ path?: string }>({
    name: 'list_files',
    description: `List entries of a directory. Paths resolve against "${root}" and cannot escape it.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path, defaults to the root' },
      },
    },
    async execute({ path }) {
      const target = resolveInside(root, path && path.trim() ? path : '.');
      const entries = await readdir(target, { withFileTypes: true });
      const lines: string[] = [];
      for (const entry of entries.slice(0, 200)) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (entry.isDirectory()) {
          lines.push(`${entry.name}/`);
          continue;
        }
        const info = await stat(resolve(target, entry.name)).catch(() => null);
        lines.push(`${entry.name} (${info ? info.size : 0}B)`);
      }
      return lines.length > 0 ? lines.join('\n') : '(empty directory)';
    },
  });
}
