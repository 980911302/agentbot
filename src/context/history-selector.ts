import type { Message, WorkingFile } from '../agent/types.js';
import { messageText } from '../agent/types.js';
import { estimateTokens } from './budget.js';

/**
 * history-selector（E2.4）：最近原文的挑选与度量。
 *
 * 原子组裁剪是关键：一条 tool_calls + 它对应的 tool 结果必须同进同出，
 * 否则会出现「只有 tool 消息、没有对应 tool_calls」的非法请求（DeepSeek 直接 400）。
 * 孤立的 tool 结果直接丢弃。
 */

export interface MessageGroup {
  messages: Message[];
  tokens: number;
}

export function groupMessages(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const pending = new Map<string, MessageGroup>();

  for (const message of messages) {
    if (message.content.type === 'tool_calls') {
      const group: MessageGroup = { messages: [message], tokens: cost(message) };
      for (const call of message.content.calls) pending.set(call.id, group);
      groups.push(group);
      continue;
    }

    if (message.content.type === 'tool_result') {
      const group = pending.get(message.content.callId);
      if (!group) continue; // 找不到父亲，丢弃
      group.messages.push(message);
      group.tokens += cost(message);
      continue;
    }

    groups.push({ messages: [message], tokens: cost(message) });
  }

  // 补齐：有些 tool_calls 可能没等到结果（比如被中断），保留其调用记录即可
  return groups;
}

export function trimRecentGroups(
  messages: Message[],
  maxTokens: number,
): { messages: Message[]; tokens: number; droppedGroups: number } {
  const groups = groupMessages(messages);
  const kept: MessageGroup[] = [];
  let tokens = 0;
  let droppedGroups = 0;

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (!group) continue;
    if (kept.length > 0 && tokens + group.tokens > maxTokens) break;
    kept.unshift(group);
    tokens += group.tokens;
  }
  droppedGroups = groups.length - kept.length;

  return { messages: kept.flatMap((group) => group.messages), tokens, droppedGroups };
}

function cost(message: Message): number {
  return estimateTokens(messageText(message)) + 8;
}

/** 从最近消息的 tool_calls 参数里提取工作文件（最近 12 个） */
export function collectWorkingFiles(messages: Message[]): WorkingFile[] {
  const seen = new Map<string, WorkingFile>();
  for (const message of messages) {
    if (message.content.type !== 'tool_calls') continue;
    for (const call of message.content.calls) {
      let path: unknown;
      try {
        path = (JSON.parse(call.arguments || '{}') as { path?: unknown }).path;
      } catch {
        continue;
      }
      if (typeof path !== 'string' || !path) continue;
      seen.set(path, { path, tool: call.name, at: message.createdAt });
    }
  }
  return [...seen.values()].slice(-12);
}

export function renderMessages(messages: Message[]): string {
  return messages.map(renderMessage).join('\n');
}

/**
 * 私聊回合和它参加过的每个群回合，都在它自己的同一条对话里，
 * 用「这是哪个房间」标一下（文档第 2 节）。
 */
function renderMessage(message: Message): string {
  const text = messageText(message);
  if (!message.roomName) return text;
  const who = message.speaker ? `${message.speaker} 在「${message.roomName}」` : `「${message.roomName}」`;
  return `[${who}] ${text}`;
}
