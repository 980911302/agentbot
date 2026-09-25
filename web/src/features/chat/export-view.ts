import type { DisplayMessage } from '../../types.js';
import { stripThinkingBlocks } from './thinking.js';

/**
 * 「导出会话」的纯函数：把当前频道的消息整理成 Markdown（发送者、时间、正文），
 * 由 ChatView 顶栏按钮复制到剪贴板。不碰 DOM 与 React，供 node:test 单测。
 *
 * 取舍：思考块（<think>…</think>）不导出；工具过程只列一行调用名，不带参数与结果
 * （参数里可能有路径与密钥类内容，导出物是给人看的对话，不是执行日志）。
 */

export interface ConversationExportInput {
  /** 频道标题：同事名或群名 */
  title: string;
  isGroup: boolean;
  /** 主人显示名：用户消息没带 senderName 时用它 */
  ownerName: string;
  /** 私聊对象名：智能体消息没带 senderName 时用它 */
  botName?: string;
  messages: DisplayMessage[];
  /** 导出时刻（毫秒），测试注入；默认当前时间 */
  now?: number;
}

/** 本地时间 YYYY-MM-DD HH:mm；解析不了给空串 */
export function exportTimestamp(value: string | number): string {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function senderOf(message: DisplayMessage, input: ConversationExportInput): string {
  if (message.role === 'user') return message.senderName || message.sender?.name || input.ownerName || '我';
  return message.senderName || message.sender?.name || input.botName || '助手';
}

/** 单条消息的 Markdown 段；没有可导出内容（空正文且无工具、无往来）返回 null */
function messageSection(message: DisplayMessage, input: ConversationExportInput): string | null {
  const time = exportTimestamp(message.createdAt);
  if (message.correspondence) {
    const transfer = message.correspondence;
    const head = `**${transfer.from.name} → ${transfer.to.name}**（同事往来）${time ? ` · ${time}` : ''}`;
    const body = transfer.text
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    return `${head}\n\n${body || '>'}`;
  }
  const text = stripThinkingBlocks(message.content);
  const tools = message.toolCalls.map((call) => call.name);
  if (!text && tools.length === 0) return null;
  const tags = [message.error ? '（出错）' : '', message.originLabel ? `（${message.originLabel}）` : ''].join('');
  const head = `**${senderOf(message, input)}**${tags}${time ? ` · ${time}` : ''}`;
  const parts = [head];
  if (text) parts.push(text);
  if (tools.length > 0) parts.push(`_执行过程：${tools.length} 次调用（${tools.join('、')}）_`);
  return parts.join('\n\n');
}

export interface ConversationExport {
  markdown: string;
  /** 实际导出的消息条数（空消息不算） */
  count: number;
}

/** 整段会话 → Markdown：标题、导出时间，每条消息之间用水平线隔开 */
export function conversationMarkdown(input: ConversationExportInput): ConversationExport {
  const sections = input.messages
    .map((message) => messageSection(message, input))
    .filter((section): section is string => section !== null);
  const kind = input.isGroup ? '群聊' : '私聊';
  const header = [`# ${input.title}（${kind}）`, '', `导出于 ${exportTimestamp(input.now ?? Date.now())} · 共 ${sections.length} 条消息`];
  const markdown = [header.join('\n'), ...sections].join('\n\n---\n\n') + '\n';
  return { markdown, count: sections.length };
}
