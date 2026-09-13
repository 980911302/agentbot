import { copyFile, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * ArtifactService（E2.3）：产物/附件的落盘交付。
 *
 * 安全边界：只允许写进白名单目录（下载 / 桌面 / 文档，或 AGENT_DELIVER_DIRS 覆盖），
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

export class ArtifactService {
  private readonly roots: string[];

  constructor(options: { roots?: string[] } = {}) {
    this.roots = options.roots ?? deliverRoots();
  }

  /** 把工作区内的文件原样交付到用户可达目录；返回最终路径与字节数 */
  async deliverFromWorkspace(
    workspaceRoot: string,
    path: string,
    fileName?: string,
  ): Promise<{ path: string; bytes: number }> {
    const root = await realpath(workspaceRoot);
    const source = await realpath(resolve(root, path));
    const inside = (base: string, file: string) => { const rel = relative(base, file); return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)); };
    const userRoots = (await Promise.all(this.roots.map(root => realpath(root).catch(() => null)))).filter((root): root is string => root !== null);
    const alreadyAccessible = userRoots.some(root => inside(root, source));
    if (!inside(root, source) && !alreadyAccessible) throw new DeliverPathError(`path 超出了工作区和交付目录范围：${path}`);
    const info = await stat(source).catch(() => null);
    if (!info?.isFile()) throw new DeliverPathError(`工作区里没有这个文件：${path}`);
    if (info.size > 50 * 1024 * 1024) throw new DeliverPathError('附件超过 50MiB，请拆分或提供文件路径');
    if (alreadyAccessible && !inside(root, source) && !fileName) return { path: source, bytes: info.size };

    const target = resolveDeliverPath(fileName ?? basename(source), undefined, this.roots);
    await mkdir(dirname(target.path), { recursive: true });
    const parent = await realpath(dirname(target.path));
    const allowedRoot = await realpath(target.root);
    if (!inside(allowedRoot, parent)) throw new DeliverPathError('目标目录的符号链接超出交付范围');
    let destination = join(parent, basename(target.path));
    if (destination === source) return { path: source, bytes: info.size };
    try { await copyFile(source, destination, constants.COPYFILE_EXCL); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      destination = join(parent, `${randomUUID().slice(0, 8)}-${basename(target.path)}`);
      await copyFile(source, destination, constants.COPYFILE_EXCL);
    }
    return { path: destination, bytes: info.size };
  }
}
