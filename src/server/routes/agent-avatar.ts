import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AVATAR_MAX_BYTES, isAvatarDataUrl } from '../../shared/contracts/agent-profile.js';
import { isAllowedOrigin } from '../transport/request-guard.js';
import { json, readJsonLimited } from '../transport/index.js';
import { avatarUrlOf } from '../presenters.js';
import { respondProfileError } from './profile-payload.js';
import { messageOf, type RouteContext } from './context.js';

/**
 * 头像资源接口（E5.1）：GET / POST / DELETE /api/agents/:id/avatar
 *
 * 来源校验（对照 bug_yc9t7bf99uf1 的教训）：资源接口是**读**接口，请求守卫只拦写操作，
 * 所以这里自己再拦一层——`Sec-Fetch-Site: cross-site` 或外站 Origin 一律 403，
 * 并回 `Cross-Origin-Resource-Policy: same-origin`，别让外站页面把头像嵌走。
 * 路径校验在 avatar-store：引用必须是 `avatars/<文件名>`，真实路径必须在数据目录的
 * 头像目录内，因此这里读不到任意文件。
 */

/** 头像上传的请求体上限：base64 后约 8MiB（图片本身另有 5MB 上限） */
const AVATAR_BODY_LIMIT = 8 * 1024 * 1024 + 1024 * 1024;

interface Refusal {
  status: number;
  error: string;
  code: string;
}

/** 外站来源一律拒绝（浏览器发 img/script 请求会带 Sec-Fetch-*，跨站时是 cross-site） */
export function crossSiteRefusal(request: IncomingMessage): Refusal | null {
  const site = request.headers['sec-fetch-site'];
  const value = Array.isArray(site) ? site[0] : site;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'cross-site') {
    return { status: 403, error: '来源不被允许：头像资源只给本应用页面读取', code: 'FORBIDDEN_ORIGIN' };
  }
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin.length > 0 && !isAllowedOrigin(origin)) {
    return { status: 403, error: '来源不被允许：头像资源只给本应用页面读取', code: 'FORBIDDEN_ORIGIN' };
  }
  return null;
}

/** GET：把头像字节读回来；没有头像 / 引用不合法一律 404，不回退到按路径直读 */
export async function serveAgentAvatar(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  agentId: string,
): Promise<void> {
  const refusal = crossSiteRefusal(request);
  if (refusal) {
    json(response, refusal.status, { error: refusal.error, code: refusal.code });
    return;
  }

  const file = await context.runtime.profiles.avatarFile(agentId);
  if (!file) {
    json(response, 404, { error: '这位同事还没有上传头像', code: 'AVATAR_NOT_FOUND' });
    return;
  }
  const bytes = await readFile(file.path);
  response.writeHead(200, {
    'content-type': file.mime,
    'content-length': bytes.length,
    // 引用随每次上传换新文件名，URL 里再带 updatedAt，可以放心缓存一小会儿
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "default-src 'none'; sandbox",
  });
  response.end(bytes);
}

/**
 * POST（`{dataUrl}` 或 `{clear:true}`）/ DELETE（清空）。
 * 两者都走资料服务，因此「换头像」「清头像」与界面改名字是同一份逻辑。
 */
export async function handleAgentAvatarWrite(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  agentId: string,
  method: string,
): Promise<void> {
  const clearing = method === 'DELETE';
  let dataUrl: string | undefined;
  if (!clearing) {
    let body: Record<string, unknown>;
    try {
      body = await readJsonLimited(request, AVATAR_BODY_LIMIT);
    } catch (error) {
      json(response, 400, { error: `头像请求体读不了：${messageOf(error)}` });
      return;
    }
    if (body.clear === true) {
      // POST 也接受显式清空：与 PATCH 的 avatar=null 是同一个语义
      await writeAvatar(context, response, agentId, null);
      return;
    }
    if (typeof body.dataUrl !== 'string' || !isAvatarDataUrl(body.dataUrl)) {
      json(response, 400, {
        error: `头像必须是 PNG/JPEG/WebP/GIF 的 data URL（图片小于 ${Math.floor(AVATAR_MAX_BYTES / 1024 / 1024)}MB），要清空请用 clear=true 或 DELETE`,
        code: 'AVATAR_INVALID',
      });
      return;
    }
    dataUrl = body.dataUrl;
  }
  await writeAvatar(context, response, agentId, dataUrl ? { dataUrl } : null);
}

async function writeAvatar(
  context: RouteContext,
  response: ServerResponse,
  agentId: string,
  avatar: { dataUrl: string } | null,
): Promise<void> {
  try {
    const updated = await context.runtime.profiles.updateById(agentId, { avatar });
    json(response, 200, { agent: updated, avatarUrl: avatarUrlOf(updated) });
  } catch (error) {
    if (respondProfileError(response, error)) return;
    throw error;
  }
}
