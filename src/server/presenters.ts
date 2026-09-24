import type { AgentRecord, Message } from '../agent/types.js';
import { messageIdentity, type MessageIdentity, type Correspondence } from '../shared/contracts/message-identity.js';

/**
 * Presenters（E2.1）：把领域对象折成 HTTP 响应的视图形状。
 *
 * 只做转换，不做 IO——状态与计数由路由从运行时取好后传入，
 * 因此这里不依赖 AgentRuntime，单测不需要起新的运行时。
 */

export interface BotViewSource {
  /** 该智能体当前是否在跑回合 */
  busy: boolean;
  /** 对话线上的消息条数 */
  conversationCount: number;
}

/** 智能体的界面视图：状态与计数一律来自真实数据源，不放假数 */
export function toBotView(record: AgentRecord, source: BotViewSource) {
  return {
    id: record.id,
    name: record.name,
    title: record.title,
    description: record.description,
    role: record.title || record.instructions.slice(0, 30),
    /** 完整职责文本，资料编辑要用；role 只是展示截断 */
    instructions: record.instructions,
    color: record.color,
    avatar: record.avatar,
    section: record.section,
    hidden: record.hidden,
    status: source.busy ? 'working' : 'idle',
    activity: '',
    conversationCount: source.conversationCount,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

export interface DisplayMessageView extends MessageIdentity {
  id: string;
  runId?: string;
  clientMessageId?: string;
  role: 'user' | 'assistant';
  content: string;
  senderName?: string;
  senderColor?: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
    result?: string;
    durationMs?: number;
    status: 'running' | 'ok' | 'error';
  }>;
  createdAt: string;
  error?: boolean;
  correspondence?: Correspondence;
}

export function toCorrespondenceView(transfer: Correspondence): DisplayMessageView {
  return { id: `correspondence:${transfer.id}`, role: 'assistant', content: '', toolCalls: [],
    createdAt: new Date(transfer.createdAt).toISOString(), correspondence: transfer };
}

/**
 * 私聊界面的读模型。
 *
 * 群消息会写入每位成员的 MessageStore，供该智能体后续理解群上下文；它们不是
 * 主人与该智能体的私聊消息，不能因为共用一份内部存储就被投影到私聊时间线。
 * 同时检查 roomId 与 source，兼容只写入其中一个来源字段的旧数据。
 */
export function privateConversationMessages(raw: Message[]): Message[] {
  return raw.filter((message) => !message.roomId && message.source !== 'room');
}

/**
 * 把存下来的消息折成界面用的形状。
 * 一次工具调用 + 它的结果是两条消息，这里合并回一张卡片。
 */
export function toDisplayMessages(raw: Message[]): DisplayMessageView[] {
  const out: DisplayMessageView[] = [];

  for (const message of raw) {
    const content = message.content;

    if (content.type === 'text') {
      if (message.role === 'user' && message.correspondenceIds?.length) continue;
      const text = content.text.trim();
      if (!text) continue;
      out.push({
        id: message.id,
        runId: message.runId,
        clientMessageId: message.clientMessageId,
        ...messageIdentity(message),
        content: text,
        toolCalls: [],
        createdAt: new Date(message.createdAt).toISOString(),
      });
      continue;
    }

    if (content.type === 'tool_calls') {
      out.push({
        id: message.id,
        runId: message.runId,
        role: 'assistant',
        content: '',
        toolCalls: content.calls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          status: 'running' as const,
        })),
        createdAt: new Date(message.createdAt).toISOString(),
      });
      continue;
    }

    // tool_result → 回填到对应卡片
    for (let index = out.length - 1; index >= 0; index -= 1) {
      const target = out[index];
      const call = target?.toolCalls.find((item) => item.id === content.callId);
      if (!call) continue;
      call.result = content.result;
      call.durationMs = content.durationMs;
      call.status = content.ok ? 'ok' : 'error';
      break;
    }
  }

  return out;
}

export interface ArtifactChip {
  path: string;
  tool: string;
  createdAt: string;
}

const DELIVERED_FILE_PREFIX = '📎 已交付文件：';

/** Read 的 path 是输入；只有 SendToUser 已交付的路径才是用户产物。 */
export function deliveredFilePath(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(DELIVERED_FILE_PREFIX)) continue;
    const path = trimmed.slice(DELIVERED_FILE_PREFIX.length).trim();
    if (path) return path;
  }
  return undefined;
}

/** 从对话里抽出真正已交付的文件，不把 Read 过的源码当产物。 */
export function collectArtifacts(raw: Message[]): ArtifactChip[] {
  const seen = new Map<string, ArtifactChip>();
  for (const message of raw) {
    const content = message.content;
    if (message.role !== 'assistant' || content.type !== 'text') continue;
    const path = deliveredFilePath(content.text);
    if (!path || seen.has(path)) continue;
    seen.set(path, {
      path,
      tool: '文件',
      createdAt: new Date(message.createdAt).toISOString(),
    });
  }
  return [...seen.values()];
}
import type { RoomFlow, RoomFlowView } from '../shared/contracts/room-flow.js';
export type { RoomFlowView };


export function toRoomFlowView(flow: import('../shared/contracts/room-flow.js').RoomFlow): RoomFlowView {
  return {
    id: flow.id,
    roomId: flow.roomId,
    coordinatorId: flow.coordinatorId,
    protocol: flow.protocol,
    status: flow.status,
    phase: flow.phase,
    version: flow.version,
    currentActors: flow.currentActors,
    transitionCount: flow.transitionCount,
    maxTransitions: flow.maxTransitions,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
  };
}
