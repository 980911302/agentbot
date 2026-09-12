/**
 * 私聊发送契约（E1.5）。
 *
 * `/api/chat` 与 `/api/sessions/:id/messages` 是两个私聊发送入口，
 * 请求解析必须走同一个 parseSendMessageInput，保证别名、裁剪和报错语义一致。
 */

export interface SendMessageInput {
  text: string;
  /** 私聊发送入口可以缺省（会话路由从 URL 取）；缺省时由调用方决定默认对象 */
  botId?: string;
  model?: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function pickString(body: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/**
 * 解析两个私聊发送入口的请求体。
 * 兼容历史别名：message/text 等价，botId/agentId 等价；前后空格裁掉。
 */
export function parseSendMessageInput(body: unknown): ParseResult<SendMessageInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }
  const raw = body as Record<string, unknown>;
  const text = pickString(raw, ['text', 'message'])?.trim();
  if (!text) {
    return { ok: false, error: 'message is required' };
  }
  const botId = pickString(raw, ['botId', 'agentId']);
  const model = pickString(raw, ['model']);
  return {
    ok: true,
    value: {
      text,
      ...(botId !== undefined ? { botId } : {}),
      ...(model !== undefined ? { model } : {}),
    },
  };
}
