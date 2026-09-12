import type { AgentEvent, DisplayMessage } from '../../types';
import type { ChannelItem } from '../../components/Sidebar';

/** 短 id（本地占位/临时键用） */
export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function now(): string {
  return new Date().toISOString();
}

/** 错误气泡：带触发原话时界面才显示「重试」 */
export function errorMessage(channel: ChannelItem, text: string, retryText?: string): DisplayMessage {
  return {
    id: uid(),
    role: 'assistant',
    senderName: channel.name,
    senderColor: channel.color,
    content: `⚠️ ${text}`,
    toolCalls: [],
    createdAt: now(),
    error: true,
    ...(retryText ? { retryText } : {}),
  };
}

function updateLastAssistant(
  messages: DisplayMessage[],
  mutate: (message: DisplayMessage) => void,
): DisplayMessage[] {
  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const candidate = next[index];
    if (candidate && candidate.role === 'assistant') {
      const clone: DisplayMessage = {
        ...candidate,
        toolCalls: candidate.toolCalls.map((call) => ({ ...call })),
      };
      mutate(clone);
      next[index] = clone;
      return next;
    }
  }
  const created: DisplayMessage = {
    id: uid(),
    role: 'assistant',
    content: '',
    toolCalls: [],
    createdAt: now(),
  };
  mutate(created);
  return [...next, created];
}

/**
 * 把后端的事件流折成界面消息（纯函数，E2.5 从 App.tsx 抽出）。
 *
 * 后端事件是消息制的：
 *   message(role=user)          → 我自己的那条（替换本地占位）
 *   message(role=assistant,text)      → 一段回复
 *   message(role=assistant,tool_calls)→ 挂到当前这条助手消息上
 *   message(role=tool,tool_result)    → 回填对应工具调用的结果
 */
export function applyEvent(messages: DisplayMessage[], event: AgentEvent): DisplayMessage[] {
  if (event.type !== 'message') return messages;

  const wire = event.message;

  if (wire.role === 'user') {
    if (wire.content.type !== 'text') return messages;
    const text = wire.content.text;
    // E3.2：优先用幂等键定位占位（重复提交时同键不产生第二条）
    const pendingId = wire.clientMessageId ? `pending-${wire.clientMessageId}` : null;
    const index = pendingId
      ? messages.findIndex((item) => item.id === pendingId)
      : messages.findIndex(
          (item) => item.id.startsWith('pending-') && item.content === text,
        );
    if (index >= 0) {
      const next = [...messages];
      next[index] = { ...next[index]!, id: wire.id };
      return next;
    }
    // 同 id 已存在（服务端重发原消息）→ 不重复渲染
    if (messages.some((item) => item.id === wire.id)) return messages;
    return messages;
  }

  if (wire.role === 'assistant') {
    if (wire.content.type === 'text') {
      const text = wire.content.text;
      if (!text.trim()) return messages;
      // 幂等：同 id 重发不再追加（E3.2 重复提交返回原消息）
      if (messages.some((item) => item.id === wire.id)) return messages;
      return [
        ...messages,
        {
          id: wire.id,
          role: 'assistant',
          content: text,
          toolCalls: [],
          createdAt: new Date(wire.createdAt).toISOString(),
        },
      ];
    }

    if (wire.content.type === 'tool_calls') {
      const calls = wire.content.calls;
      return updateLastAssistant(messages, (message) => {
        for (const call of calls) {
          if (message.toolCalls.some((item) => item.id === call.id)) continue;
          message.toolCalls.push({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            status: 'running',
          });
        }
      });
    }
    return messages;
  }

  // role === 'tool'
  if (wire.content.type === 'tool_result') {
    const { callId, result, durationMs, ok } = wire.content;
    return updateLastAssistant(messages, (message) => {
      const call = message.toolCalls.find((item) => item.id === callId);
      if (!call) return;
      call.result = result;
      call.durationMs = durationMs;
      call.status = ok ? 'ok' : 'error';
    });
  }
  return messages;
}
