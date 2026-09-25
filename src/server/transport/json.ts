import type { IncomingMessage, ServerResponse } from 'node:http';

/** 请求体上限：1MB */
export const MAX_BODY_BYTES = 1024 * 1024;

/** 统一 JSON 响应：写头 + content-length + 结束 */
export function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/** 读 JSON 请求体：非对象 / 超限直接抛错（由路由决定状态码） */
export async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return readJsonLimited(request, MAX_BODY_BYTES);
}

/**
 * 带自定义上限的 JSON 读取。
 *
 * 头像上传走 JSON base64（浏览器请求守卫只放行 application/json），
 * 默认 1MiB 上限会把常见手机照片挡在外面，所以头像接口单独放宽到 8MiB。
 */
export async function readJsonLimited(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBytes) throw new Error('request body is too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}
