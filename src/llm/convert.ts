import type { Message } from '../agent/types.js';
import { attributedText } from '../shared/contracts/message-identity.js';
import type { LLMMessage } from './provider.js';

export interface ToLLMMessagesOptions {
  /**
   * 是否在来源标签里带上所属工作（E4.6）。
   * 当前这一句的默认传 false：它属于哪件工作由回合 brief 权威说明（带目标、版本、状态），
   * 再在正文前挂一遍 workId 只会重复，还会改变「最后一条就是用户原话」的形状。
   */
  work?: boolean;
}

export function toLLMMessages(messages: Message[], options: ToLLMMessagesOptions = {}): LLMMessage[] {
  const includeWork = options.work !== false;
  const out: LLMMessage[] = [];

  for (const message of messages) {
    const content = message.content;

    if (content.type === 'text') {
      if (message.role === 'assistant') {
        const next = out[out.length - 1];
        if (next && next.role === 'assistant' && next.toolCalls) {
          next.content = next.content ? `${next.content}\n${content.text}` : content.text;
          continue;
        }
      }
      if (!content.text && message.role === 'assistant') continue;
      out.push({ role: message.role, content: attributedText(message, content.text, includeWork),
        ...(message.role === 'user' && message.images?.length ? { images: message.images } : {}) });
      continue;
    }

    if (content.type === 'tool_calls') {
      out.push({
        role: 'assistant',
        content: null,
        toolCalls: content.calls,
      });
      continue;
    }

    out.push({
      role: 'tool',
      content: content.result,
      toolCallId: content.callId,
    });
  }

  return out;
}

export function lastAssistantText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    if (message.content.type === 'text' && message.content.text) return message.content.text;
  }
  return '';
}
