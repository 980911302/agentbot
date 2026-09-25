import type { ServerResponse } from 'node:http';
import { isAvatarDataUrl, type AgentProfilePatch } from '../../shared/contracts/agent-profile.js';
import { AgentProfileError } from '../../agent/profile-service.js';
import { json } from '../transport/index.js';

/**
 * 资料请求体的唯一解析器（E5.1）。
 *
 * `/api/agents/:id` 与 `/api/bots/:id` 共用它，字段集合与清空语义因此不可能走样。
 * 头像只接受 data URL（界面选图后读成 base64）或 null（清空）：
 * **不接受本机路径**——否则浏览器就能让服务端读任意本地图片，再从头像资源接口读回来。
 */

export interface ProfileBodyOptions {
  /** bots 接口兼容字段：`role` 是 instructions 的历史别名 */
  legacyRoleAlias?: boolean;
  /** agents 接口历史上还收 toolNames / projectIds */
  toolAndProjectIds?: boolean;
}

function readTextField(value: unknown, key: string, errors: string[]): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null; // 主动清空
  if (typeof value !== 'string') {
    errors.push(`${key} 必须是字符串或 null`);
    return undefined;
  }
  return value;
}

function readStringArray(value: unknown, key: string, errors: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${key} 必须是字符串数组`);
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

export function parseProfileBody(
  body: Record<string, unknown>,
  options: ProfileBodyOptions = {},
): { patch: AgentProfilePatch; errors: string[] } {
  const errors: string[] = [];
  const patch: AgentProfilePatch = {};

  const name = readTextField(body.name, 'name', errors);
  if (name !== undefined) patch.name = name;
  const title = readTextField(body.title, 'title', errors);
  if (title !== undefined) patch.title = title;
  const description = readTextField(body.description, 'description', errors);
  if (description !== undefined) patch.description = description;
  let instructions = readTextField(body.instructions, 'instructions', errors);
  if (instructions === undefined && options.legacyRoleAlias) {
    instructions = readTextField(body.role, 'role', errors);
  }
  if (instructions !== undefined) patch.instructions = instructions;

  const color = readTextField(body.color, 'color', errors);
  if (color !== undefined) patch.color = color;
  const section = readTextField(body.section, 'section', errors);
  if (section !== undefined) patch.section = section;

  if (body.hidden !== undefined) {
    if (typeof body.hidden !== 'boolean') errors.push('hidden 必须是布尔值');
    else patch.hidden = body.hidden;
  }

  if (options.toolAndProjectIds) {
    const toolNames = readStringArray(body.toolNames, 'toolNames', errors);
    if (toolNames !== undefined) patch.toolNames = toolNames;
    const projectIds = readStringArray(body.projectIds, 'projectIds', errors);
    if (projectIds !== undefined) patch.projectIds = projectIds;
  }

  if (body.avatar !== undefined) {
    if (body.avatar === null) {
      patch.avatar = null; // 明确清空：删文件 + 字段置空
    } else if (typeof body.avatar === 'string' && isAvatarDataUrl(body.avatar)) {
      patch.avatar = { dataUrl: body.avatar };
    } else if (typeof body.avatar === 'string') {
      errors.push('avatar 只接受 PNG/JPEG/WebP/GIF 的 data URL，或传 null 清空');
    } else {
      errors.push('avatar 只接受 data URL 字符串或 null');
    }
  }

  return { patch, errors };
}

/** 资料写失败 → 响应；返回 true 表示已经回过响应 */
export function respondProfileError(response: ServerResponse, error: unknown): boolean {
  if (!(error instanceof AgentProfileError)) return false;
  json(response, error.code === 'PROFILE_NOT_FOUND' ? 404 : 400, {
    error: error.message,
    code: error.code,
  });
  return true;
}
