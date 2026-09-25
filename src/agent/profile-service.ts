import type { AgentRecord } from './types.js';
import type { AgentPatch, AgentRegistry } from './registry.js';
import {
  isAvatarDataUrl,
  isAvatarRef,
  isProfilePatchEmpty,
  type AgentProfilePatch,
  type AvatarUploadInput,
} from '../shared/contracts/agent-profile.js';
import {
  AvatarError,
  decodeAvatarDataUrl,
  readAvatarSourceFile,
  removeAvatarFile,
  resolveAvatarFile,
  writeAvatarFile,
} from './avatar-store.js';

/**
 * 同事资料的唯一写入口（E5.1）。
 *
 * 界面（`PATCH /api/agents/:id`、`PATCH /api/bots/:id`）与工具（update_state、
 * UpdateAgent / CreateAgent）都必须经过这里，避免「两套逻辑各改各的」：
 *   - 字段语义、清空语义、头像落盘与删除，只在这一处定义；
 *   - 路由与工具只负责把请求解析成 AgentProfilePatch。
 */

/** 资料写失败：面向用户的中文 + 机器可读 code（路由据此回 400/404） */
export class AgentProfileError extends Error {
  constructor(
    message: string,
    readonly code: 'PROFILE_INVALID' | 'PROFILE_NOT_FOUND' | 'AVATAR_INVALID' = 'PROFILE_INVALID',
  ) {
    super(message);
    this.name = 'AgentProfileError';
  }
}

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export class AgentProfileService {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly dataDir: string,
  ) {}

  async get(id: string): Promise<AgentRecord | undefined> {
    return this.registry.get(id);
  }

  /**
   * 按 id 找，找不到再按名字找（工具描述承诺「也可以给一个已存在的名字」；
   * 重名由 CreateAgent 挡住，所以按名字匹配不会歧义）。
   */
  async resolve(idOrName: string): Promise<AgentRecord | undefined> {
    const byId = await this.registry.get(idOrName);
    if (byId) return byId;
    const wanted = idOrName.trim();
    if (!wanted) return undefined;
    const list = await this.registry.list();
    return list.find((record) => record.name === wanted);
  }

  /** 工具与路由都走它；agentId 是自己还是别人由调用方决定 */
  async updateById(id: string, patch: AgentProfilePatch): Promise<AgentRecord> {
    const target = await this.registry.get(id);
    if (!target) throw new AgentProfileError(`找不到 id 为 ${id} 的同事`, 'PROFILE_NOT_FOUND');
    return this.apply(target, patch);
  }

  /** 按 id 或名字更新（工作台的 UpdateAgent 用） */
  async update(idOrName: string, patch: AgentProfilePatch): Promise<AgentRecord> {
    const target = await this.resolve(idOrName);
    if (!target) throw new AgentProfileError(`找不到 id 或名字为 ${idOrName} 的同事`, 'PROFILE_NOT_FOUND');
    return this.apply(target, patch);
  }

  /**
   * 资源接口要用的头像文件：只认记录里合法的 `avatars/<文件名>` 引用，
   * 且真实路径必须在数据目录的头像目录内（avatar-store 里做 realpath 校验）。
   */
  async avatarFile(idOrName: string): Promise<{ path: string; mime: string } | undefined> {
    const target = await this.resolve(idOrName);
    if (!target) return undefined;
    return resolveAvatarFile(this.dataDir, target.avatar);
  }

  private async apply(target: AgentRecord, patch: AgentProfilePatch): Promise<AgentRecord> {
    // 一个字段都没给就直接返回：registry.update 无论有没有改动都会刷 updatedAt，
    // 而列表按 updatedAt 倒序，空调用会静默改动侧栏排序（E5.8 的口径）。
    if (isProfilePatchEmpty(patch)) return target;

    const next: AgentPatch = {};

    if (patch.name !== undefined) {
      if (patch.name === null) throw new AgentProfileError('名字不能清空，只能改成另一个名字');
      const name = patch.name.trim();
      // 空串按历史语义等同「没传」，不把名字抹掉
      if (name) next.name = name;
    }

    // title / description / instructions：null = 主动清空，字符串 = 覆盖（空串按历史语义等同未传）
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.instructions !== undefined) next.instructions = patch.instructions;

    if (patch.color !== undefined) {
      const color = patch.color?.trim() ?? '';
      if (!COLOR_PATTERN.test(color)) {
        throw new AgentProfileError('color 必须是 #rrggbb 形式的十六进制色值');
      }
      next.color = color;
    }

    if (patch.section !== undefined) next.section = patch.section;
    if (patch.hidden !== undefined) next.hidden = patch.hidden;
    if (patch.toolNames !== undefined) next.toolNames = [...patch.toolNames];
    if (patch.projectIds !== undefined) next.projectIds = [...patch.projectIds];

    if (patch.avatar !== undefined) {
      if (patch.avatar === null) {
        // 明确清空：先删文件，再把字段置空
        await removeAvatarFile(this.dataDir, target.avatar);
        next.avatar = null;
      } else {
        const { bytes, extension } = await this.decodeAvatar(patch.avatar);
        next.avatar = await writeAvatarFile(
          this.dataDir,
          bytes,
          extension,
          isAvatarRef(target.avatar) ? target.avatar : undefined,
        );
      }
    }

    const updated = await this.registry.update(target.id, next);
    if (!updated) throw new AgentProfileError(`更新「${target.name}」失败`, 'PROFILE_NOT_FOUND');
    return updated;
  }

  /** 取图片字节：本地路径（工具）或 data URL（界面）二选一 */
  private async decodeAvatar(input: AvatarUploadInput): Promise<{ bytes: Buffer; extension: string }> {
    const path = input.path?.trim();
    const dataUrl = input.dataUrl?.trim();
    if (path && dataUrl) throw new AgentProfileError('头像一次只能给 path 或 dataUrl 之一', 'AVATAR_INVALID');
    try {
      if (dataUrl) {
        if (!isAvatarDataUrl(dataUrl)) {
          throw new AgentProfileError('头像必须是 PNG/JPEG/WebP/GIF 的 data URL', 'AVATAR_INVALID');
        }
        return decodeAvatarDataUrl(dataUrl);
      }
      if (path) return await readAvatarSourceFile(path);
    } catch (error) {
      if (error instanceof AvatarError) throw new AgentProfileError(error.message, 'AVATAR_INVALID');
      throw error;
    }
    throw new AgentProfileError('头像 set 需要 path（本机图片绝对路径）或 dataUrl', 'AVATAR_INVALID');
  }
}
