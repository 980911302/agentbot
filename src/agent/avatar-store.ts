import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  AVATAR_DIR_NAME,
  AVATAR_MAX_BYTES,
  avatarFileNameOf,
  avatarMimeOfExtension,
  isAvatarRef,
} from '../shared/contracts/agent-profile.js';

/**
 * 头像落盘与读取（E5.1）。
 *
 * 安全边界（对照 bug_yc9t7bf99uf1 的教训）：头像文件只能在数据目录的 `avatars/` 下，
 * 资源引用必须是 `avatars/<文件名>` 这一形状；读取时对「头像目录」和「目标文件」
 * 两侧都做 realpath，目录里有软链指向外面（或引用里塞 ../）一律当作没有。
 * 因此新增的资源接口不会变成任意文件读取。
 */

export class AvatarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AvatarError';
  }
}

export function avatarDir(dataDir: string): string {
  return join(resolve(dataDir), AVATAR_DIR_NAME);
}

/** 只允许这几种图片（与 update_state 的历史口径一致） */
export function avatarExtensionOf(nameOrPath: string): string | undefined {
  const extension = extname(nameOrPath).toLowerCase();
  return avatarMimeOfExtension(extension) ? extension : undefined;
}

/** 把界面传来的 data URL 解成字节；格式/大小不合规直接抛（面向用户的中文） */
export function decodeAvatarDataUrl(dataUrl: string): { bytes: Buffer; extension: string } {
  const match = /^data:image\/(png|jpeg|webp|gif);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new AvatarError('头像只支持 PNG/JPEG/WebP/GIF 的 base64 图片');
  const extension = match[1] === 'jpeg' ? '.jpg' : `.${match[1]}`;
  const bytes = Buffer.from((match[2] ?? '').replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0) throw new AvatarError('头像内容为空，请重新选一张图片');
  if (bytes.length > AVATAR_MAX_BYTES) {
    throw new AvatarError(`头像必须小于 ${Math.floor(AVATAR_MAX_BYTES / 1024 / 1024)}MB`);
  }
  return { bytes, extension };
}

/** 目标必须真的落在头像目录里（两侧 realpath，防软链逃逸） */
async function insideAvatarDir(dir: string, candidate: string): Promise<string | undefined> {
  const realDir = await realpath(dir).catch(() => null);
  if (!realDir) return undefined;
  const realFile = await realpath(candidate).catch(() => null);
  if (!realFile) return undefined;
  const rel = relative(realDir, realFile);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return realFile;
}

/**
 * 把记录里的头像引用解成磁盘文件；引用不合法 / 文件不在头像目录 / 不是图片都返回 undefined。
 * 调用方（资源接口）据此回 404，绝不回退到「按路径直读」。
 */
export async function resolveAvatarFile(
  dataDir: string,
  ref: unknown,
): Promise<{ path: string; mime: string } | undefined> {
  if (!isAvatarRef(ref)) return undefined;
  const name = avatarFileNameOf(ref);
  if (!name) return undefined;
  const mime = avatarMimeOfExtension(extname(name));
  if (!mime) return undefined;
  const dir = avatarDir(dataDir);
  const real = await insideAvatarDir(dir, join(dir, name));
  if (!real) return undefined;
  const info = await stat(real).catch(() => null);
  if (!info?.isFile() || info.size === 0) return undefined;
  return { path: real, mime };
}

/** 读本机图片（update_state 的 path 入口）：扩展名与大小在这里把关 */
export async function readAvatarSourceFile(path: string): Promise<{ bytes: Buffer; extension: string }> {
  if (!isAbsolute(path)) throw new AvatarError('头像 set 需要图片的绝对路径');
  const extension = avatarExtensionOf(path);
  if (!extension) throw new AvatarError('头像只支持 PNG/JPEG/WebP/GIF');
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new AvatarError(`找不到图片：${path}`);
  if (info.size > AVATAR_MAX_BYTES) {
    throw new AvatarError(`头像必须小于 ${Math.floor(AVATAR_MAX_BYTES / 1024 / 1024)}MB`);
  }
  return { bytes: await readFile(path), extension };
}

/**
 * 写入头像并返回新的资源引用。
 *
 * 文件名用随机 id（不拿 agentId 拼，避免自定义 id 里的字符跑进路径）；
 * 先写临时文件再改名，最后删掉旧引用指向的文件——同一时刻磁盘上只留最新一张。
 */
export async function writeAvatarFile(
  dataDir: string,
  bytes: Buffer,
  extension: string,
  previousRef?: string,
): Promise<string> {
  const dir = avatarDir(dataDir);
  await mkdir(dir, { recursive: true });
  const name = `${randomUUID()}${extension}`;
  const target = join(dir, name);
  const temp = `${target}.tmp`;
  await writeFile(temp, bytes);
  await rename(temp, target);
  if (previousRef && previousRef !== `${AVATAR_DIR_NAME}/${name}`) {
    await removeAvatarFile(dataDir, previousRef);
  }
  return `${AVATAR_DIR_NAME}/${name}`;
}

/** 删除引用指向的文件；引用不合法或文件不在头像目录时什么也不做（返回 false） */
export async function removeAvatarFile(dataDir: string, ref: unknown): Promise<boolean> {
  if (!isAvatarRef(ref)) return false;
  const name = avatarFileNameOf(ref);
  if (!name) return false;
  const dir = avatarDir(dataDir);
  const real = await insideAvatarDir(dir, join(dir, name));
  if (!real) return false;
  await unlink(real).catch(() => undefined);
  return true;
}
