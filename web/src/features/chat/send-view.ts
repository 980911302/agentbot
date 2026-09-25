/**
 * 发送与重试的纯前置判定（OPT-04 从 App.tsx 抽出）。
 *
 * 真正的发送（乐观占位、回执、失败行）在 use-chat-stream.ts；这里只回答两个问题：
 * 「这句话该不该发」「重试要不要带上原来的 clientMessageId」。
 * 放在纯模块里是为了让「空文本不发、重试复用原 key」这类判定能被 node:test 盯住。
 */

/** 「重新编辑」事件：Composer 监听它把原文填回输入框（只回填，不改发送逻辑） */
export const EDIT_PROMPT_EVENT = 'agentbot:use_prompt';

export interface OutgoingRequest {
  text: string;
  /** 重试时沿用原 clientMessageId，服务端据此去重；新消息不带，由引擎生成 */
  clientMessageId?: string;
}

/**
 * 发送前置校验：去掉首尾空白后为空就不发（返回 null）；
 * 重试带原 clientMessageId，普通发送不带（引擎自己生成 uuid）。
 */
export function outgoingRequest(text: string, retryClientMessageId?: string): OutgoingRequest | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return retryClientMessageId ? { text: trimmed, clientMessageId: retryClientMessageId } : { text: trimmed };
}