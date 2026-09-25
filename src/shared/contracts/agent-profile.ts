/**
 * 同事资料的线上契约（E5.1）。
 *
 * 四个文本字段各管一件事，界面与工具改的是同一份：
 *   name 显示名 / title 一句话头衔 / description 详细描述 / instructions 进系统提示词的职责。
 * 头像字段有三种意图，必须能区分：
 *   键不存在 = 未传（保持原值）；null = 主动清空（删文件 + 字段置空）；给图片 = 落盘到数据目录的头像目录。
 *
 * 纯类型 + 纯校验：不引用 Node/React，前端只能 import type 或这里的纯函数。
 */

export const AGENT_PROFILE_TEXT_FIELDS = ['name', 'title', 'description', 'instructions'] as const;
export type AgentProfileTextField = (typeof AGENT_PROFILE_TEXT_FIELDS)[number];

/** 头像目录（数据目录内）与记录里存资源引用用的前缀 */
export const AVATAR_DIR_NAME = 'avatars';
export const AVATAR_REF_PREFIX = `${AVATAR_DIR_NAME}/`;

/** 资源引用的形状：`avatars/<文件名>`，文件名不允许分隔符与 `..`，因此引用本身不能逃出目录 */
const AVATAR_REF = /^avatars\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

/** 头像只收这四种图片；大小上限与 update_state 的既有口径一致 */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** 浏览器上传走 JSON data URL：只认这四种图片的 base64 */
const AVATAR_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;

/** 记录里的 avatar 是不是「数据目录头像目录」下的资源引用 */
export function isAvatarRef(value: unknown): value is string {
  return typeof value === 'string' && AVATAR_REF.test(value);
}

/** 引用里的文件名；不是合法引用时返回 undefined */
export function avatarFileNameOf(ref: string): string | undefined {
  return AVATAR_REF.exec(ref)?.[1];
}

/** 文件名的图片类型；非图片扩展名返回 undefined */
export function avatarMimeOfExtension(extension: string): string | undefined {
  return AVATAR_MIME_BY_EXTENSION[extension.toLowerCase()];
}

export function isAvatarDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8 * 1024 * 1024 && AVATAR_DATA_URL.test(value);
}

/** 给图片设置用：本地绝对路径或 data URL 二选一 */
export interface AvatarUploadInput {
  /** 本机已有图片的绝对路径（update_state 用） */
  path?: string;
  /** 界面选图后的 data URL */
  dataUrl?: string;
}

/**
 * 资料补丁。
 *
 * 文本字段：undefined = 未传（保持原值），null = 主动清空，字符串 = 覆盖（空串等同未传，兼容历史语义）。
 * avatar：undefined = 未传，null = 清空，{path|dataUrl} = 设置。
 */
export interface AgentProfilePatch {
  name?: string | null;
  title?: string | null;
  description?: string | null;
  instructions?: string | null;
  color?: string | null;
  section?: string | null;
  hidden?: boolean;
  toolNames?: string[];
  projectIds?: string[];
  avatar?: AvatarUploadInput | null;
}

/** 一个字段都没给：调用方据此跳过落盘（registry.update 无论有无改动都会刷 updatedAt） */
export function isProfilePatchEmpty(patch: AgentProfilePatch): boolean {
  return Object.values(patch).every((value) => value === undefined);
}
