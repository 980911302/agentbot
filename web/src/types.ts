export type BotStatus = 'idle' | 'thinking' | 'working' | 'error';

export interface ToolCallView {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  durationMs?: number;
  status: 'running' | 'ok' | 'error';
}

// 线上契约的唯一来源：src/shared/contracts（纯类型，编译期擦除，不引入后端运行模块）
import type { MessageContent, MessageRole, ToolCall } from '../../src/shared/contracts/sse.js';
import type { AgentEvent as WireAgentEvent } from '../../src/shared/contracts/sse.js';
import type { Message as WireMessageShape } from '../../src/shared/contracts/sse.js';
import type { RunResult as WireRunResult } from '../../src/shared/contracts/sse.js';
import type {
  InteractionKind,
  InteractionOption,
  InteractionRequest,
} from '../../src/shared/contracts/sse.js';
export type { InteractionKind, InteractionOption, InteractionRequest };
import type { RoomFlowView } from '../../src/shared/contracts/room-flow.js';
export type { RoomFlowView };

export type AgentEvent = WireAgentEvent;

export type WireMessage = WireMessageShape;

export type RunResult = WireRunResult;

export interface ArtifactView {
  path: string;
  tool: string;
  createdAt: string;
}

export interface DisplayMessage {
  id: string;
  runId?: string;
  clientMessageId?: string;
  retryClientMessageId?: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCallView[];
  createdAt: string;
  error?: boolean;
  /** 触发这条错误的原话；有它错误气泡才显示「重试」 */
  retryText?: string;
  senderName?: string;
  senderColor?: string;
  senderAvatar?: string;
  source?: WireMessage['source'];
  sender?: import('../../src/shared/contracts/message-identity.js').MessageActor;
  originLabel?: string;
  correspondence?: import('../../src/shared/contracts/message-identity.js').Correspondence;
}

export interface SessionSummary {
  id: string;
  botId: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface BotSummary {
  id: string;
  name: string;
  /** 一行简介 */
  title?: string;
  /** 详细描述 */
  description?: string;
  role: string;
  /** 完整职责文本（进系统提示词的那份）；编辑资料时用 */
  instructions?: string;
  color: string;
  /** 头像：数据目录头像目录的资源引用（`avatars/<文件名>`）；历史数据可能是 emoji */
  avatar?: string;
  /** 头像资源地址（E5.1，带 updatedAt）；没有上传头像时为 null */
  avatarUrl?: string | null;
  section?: string;
  hidden?: boolean;
  status: BotStatus;
  activity: string;
  conversationCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelOption {
  id: string;
  label: string;
  hint: string;
  providerId?: string;
  modelConfigId?: string;
  thinkingEnabled?: boolean;
  thinkingLevel?: 'low' | 'medium' | 'high';
}

export interface ToolInfo {
  name: string;
  description: string;
}

export interface HealthInfo {
  ok: boolean;
  /** 主人显示名（E5.7）：来自后端设置存储，不再是 localStorage */
  ownerName?: string;
  model: string;
  thinkingEnabled?: boolean;
  thinkingLevel?: 'low' | 'medium' | 'high';
  models: ModelOption[];
  tools: ToolInfo[];
}

export type MemoryScope = 'self' | 'user' | 'project';

export type MemoryTier = 'portrait' | 'log' | 'scratch';

export interface MemoryEntryView {
  id: string;
  scope: MemoryScope;
  tier: MemoryTier;
  ownerId: string;
  text: string;
  tags: string[];
  source: 'user' | 'agent' | 'extracted';
  createdAt: number;
  updatedAt: number;
  hits: number;
  inView: boolean;
  reason?: string;
}

export interface MemoryBucket {
  scope: MemoryScope;
  ownerId: string;
  label: string;
  entries: MemoryEntryView[];
}

export interface MemorySnapshot {
  agentId: string;
  buckets: MemoryBucket[];
  counts: {
    portrait: number;
    log: number;
    scratch: number;
    searchable: number;
  };
  updatedAt: number;
}

export type RoundStatus = 'spoke' | 'silent' | 'error';

export interface RoomMember {
  id: string;
  name: string;
  color: string;
}

export interface RoomView {
  id: string;
  name: string;
  memberIds: string[];
  members: RoomMember[];
  messageCount: number;
  lastMessage?: { text: string; senderName: string; createdAt: number };
  createdAt: number;
  updatedAt: number;
}

export interface RoomMessage {
  clientMessageId?: string;
  id: string;
  roomId: string;
  roundId: string;
  senderKind: 'user' | 'agent' | 'system';
  senderId: string;
  senderName: string;
  senderColor?: string;
  text: string;
  mentions: string[];
  everyone: boolean;
  createdAt: number;
}

export interface RoundOutcome {
  roundId: string;
  roomId: string;
  agentId: string;
  agentName: string;
  agentColor?: string;
  status: RoundStatus;
  posts: string[];
  note?: string;
  durationMs: number;
}

export type RoomEvent =
  | { type: 'room_message'; message: RoomMessage }
  | { type: 'round_start'; roundId: string; agentId: string; agentName: string }
  | { type: 'round_end'; outcome: RoundOutcome }
  | { type: 'fanout_done'; roundId: string; spoke: number; silent: number }
  | { type: 'flow_updated'; flow: RoomFlowView };

export interface ContextSectionStat {
  key: string;
  label: string;
  tokens: number;
  limit: number;
  items: number;
  detail: string[];
}

export interface ContextStats {
  sections: ContextSectionStat[];
  totalTokens: number;
  budgetTokens: number;
  generatedAt: number;
}

// AgentEvent 已从契约导入（见文件头）
