import type { AgentEvent, DisplayMessage } from '../../types';
import type { ChannelItem } from '../../components/Sidebar';
import { messageIdentity } from '../../../../src/shared/contracts/message-identity';

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
    content: text,
    toolCalls: [],
    createdAt: now(),
    error: true,
    ...(retryText ? { retryText } : {}),
  };
}

function updateToolCallOwner(
  messages: DisplayMessage[],
  callId: string,
  mutate: (message: DisplayMessage) => void,
): DisplayMessage[] {
  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const candidate = next[index];
    if (!candidate?.toolCalls.some((call) => call.id === callId)) continue;
    const clone: DisplayMessage = {
      ...candidate,
      toolCalls: candidate.toolCalls.map((call) => ({ ...call })),
    };
    mutate(clone);
    next[index] = clone;
    return next;
  }
  return messages;
}

/**
 * 把后端的事件流折成界面消息（纯函数，E2.5 从 App.tsx 抽出）。
 *
 * 后端事件是消息制的：
 *   message(role=user)          → 输入；必须再按真实来源区分用户、同事、群
 *   message(role=assistant,text)      → 一段回复
 *   message(role=assistant,tool_calls)→ 挂到当前这条助手消息上
 *   message(role=tool,tool_result)    → 回填对应工具调用的结果
 */
export function applyEvent(messages: DisplayMessage[], event: AgentEvent): DisplayMessage[] {
  if (event.type === 'correspondence') {
    const id = `correspondence:${event.transfer.id}`;
    if (messages.some(item => item.id === id)) return messages;
    return [...messages, { id, role: 'assistant' as const, content: '', toolCalls: [],
      createdAt: new Date(event.transfer.createdAt).toISOString(), correspondence: event.transfer }]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }
  if (event.type !== 'message') return messages;

  const wire = event.message;
  const identity = messageIdentity(wire);

  if (wire.role === 'user') {
    if (wire.content.type !== 'text') return messages;
    if (wire.correspondenceIds?.length) return messages;
    const text = wire.content.text;
    // E3.2：优先用幂等键定位占位（重复提交时同键不产生第二条）
    const pendingId = wire.clientMessageId ? `pending-${wire.clientMessageId}` : null;
    const index = identity.role !== 'user' ? -1 : pendingId
      ? messages.findIndex((item) => item.id === pendingId)
      : messages.findIndex(
          (item) => item.id.startsWith('pending-') && item.content === text,
        );
    if (index >= 0) {
      const next = [...messages];
      next[index] = { ...next[index]!, id: wire.id, runId: wire.runId, clientMessageId: wire.clientMessageId };
      return next.filter((item, at) => item.id !== wire.id || at === index);
    }
    // 同 id 已存在（服务端重发原消息）→ 不重复渲染
    if (messages.some((item) => item.id === wire.id)) return messages;
    return [...messages, { id: wire.id, runId: wire.runId, clientMessageId: wire.clientMessageId,
      ...identity, content: text, toolCalls: [], createdAt: new Date(wire.createdAt).toISOString() }];
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
          runId: wire.runId,
          ...identity,
          content: text,
          toolCalls: [],
          createdAt: new Date(wire.createdAt).toISOString(),
        },
      ];
    }

    if (wire.content.type === 'tool_calls') {
      const calls = wire.content.calls;
      const existingIndex = messages.findIndex((message) => message.id === wire.id);
      const existing = existingIndex >= 0 ? messages[existingIndex] : undefined;
      const owner: DisplayMessage = existing
        ? { ...existing, toolCalls: existing.toolCalls.map((call) => ({ ...call })) }
        : {
            id: wire.id,
            runId: wire.runId,
            role: 'assistant',
            content: '',
            toolCalls: [],
            createdAt: new Date(wire.createdAt).toISOString(),
          };
      for (const call of calls) {
        if (owner.toolCalls.some((item) => item.id === call.id)) continue;
        owner.toolCalls.push({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            status: 'running',
        });
      }
      if (existingIndex < 0) return [...messages, owner];
      const next = [...messages];
      next[existingIndex] = owner;
      return next;
    }
    return messages;
  }

  // role === 'tool'
  if (wire.content.type === 'tool_result') {
    const { callId, result, durationMs, ok } = wire.content;
    return updateToolCallOwner(messages, callId, (message) => {
      const call = message.toolCalls.find((item) => item.id === callId);
      if (!call) return;
      call.result = result;
      call.durationMs = durationMs;
      call.status = ok ? 'ok' : 'error';
    });
  }
  return messages;
}
