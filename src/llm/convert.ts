import type { Message } from '../agent/types.js';
import type { LLMMessage } from './provider.js';

export function toLLMMessages(messages: Message[]): LLMMessage[] {
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
      out.push({ role: message.role, content: content.text });
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
