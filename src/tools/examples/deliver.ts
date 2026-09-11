import { copyFile, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { defineTool } from '../tool.js';

/**
 * 把文件投递到用户磁盘。
 *
 * 对应《工具与能力.md》第 7 节：「把做好的 md 放到用户磁盘」可以留——
 * 这是文件投递，不是远程桌面。
 *
 * 安全边界：只允许写进白名单目录（下载 / 桌面 / 文档），
 * 且最终路径必须落在该目录内，防止 ../ 逃逸。
 */

export const DEFAULT_DELIVER_DIRS = ['Downloads', 'Desktop', 'Documents'];

export function deliverRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const custom = (env.AGENT_DELIVER_DIRS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (custom.length > 0) return custom.map((item) => resolve(item));
  return DEFAULT_DELIVER_DIRS.map((name) => join(homedir(), name));
}

export class DeliverPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliverPathError';
  }
}

/** 解析投递目标；拒绝白名单之外的路径 */
export function resolveDeliverPath(
  fileName: string,
  targetDir: string | undefined,
  roots: string[],
): { path: string; root: string } {
  const name = basename(fileName.trim());
  if (!name || name === '.' || name === '..') {
    throw new DeliverPathError('文件名不合法');
  }

  let chosen: string;
  if (targetDir && targetDir.trim()) {
    const wanted = isAbsolute(targetDir) ? resolve(targetDir) : resolve(homedir(), targetDir);
    const matches = roots.find((root) => {
      const rel = relative(root, wanted);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
    if (!matches) {
      throw new DeliverPathError(
        `只允许投递到这些目录：${roots.join('、')}。收到的是 ${wanted}`,
      );
    }
    chosen = wanted;
  } else {
    chosen = roots[0] ?? homedir();
  }

  const finalPath = join(chosen, name);
  const root = roots.find((candidate) => {
    const rel = relative(candidate, finalPath);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
  if (!root) throw new DeliverPathError(`目标路径超出允许范围：${finalPath}`);

  return { path: finalPath, root };
}

export function createDeliverTool(sandboxRoot: string) {
  const root = resolve(sandboxRoot);

  return defineTool<{ path: string; fileName?: string; targetDir?: string }>({
    name: 'deliver_file',
    description: [
      '把你工作区里的文件放到用户的磁盘上（默认「下载」目录），这样用户能直接打开。',
      'path 是工作区内的相对路径；fileName 可以改名。',
      '只能投递到下载 / 桌面 / 文档这几个目录，不能写到别处。',
      '适合「把结果写成文件给用户」，不要用它当通用写文件工具。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的文件路径' },
        fileName: { type: 'string', description: '投递后的文件名（默认用原文件名）' },
        targetDir: { type: 'string', description: '目标目录，默认下载' },
      },
      required: ['path'],
    },
    async execute(args) {
      const source = resolve(root, args.path);
      const rel = relative(root, source);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error('path 超出了工作区范围');
      }

      const info = await stat(source).catch(() => null);
      if (!info?.isFile()) throw new Error(`工作区里没有这个文件：${args.path}`);

      const roots = deliverRoots();
      const target = resolveDeliverPath(args.fileName ?? basename(source), args.targetDir, roots);

      await mkdir(dirname(target.path), { recursive: true });
      await copyFile(source, target.path);

      return `已投递到 ${target.path}（${info.size} 字节）。用户可以直接打开这个文件。`;
    },
  });
}
