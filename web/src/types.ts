export type BotStatus = 'idle' | 'thinking' | 'working' | 'error';

export interface ToolCallView {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  durationMs?: number;
  status: 'running' | 'ok' | 'error';
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type MessageRole = 'user' | 'assistant' | 'tool';

/** 后端 MessageContent：文本 / 一次工具调用 / 一条工具结果 */
export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | {
      type: 'tool_result';
      callId: string;
      name: string;
      result: string;
      durationMs: number;
      ok: boolean;
    };

export interface WireMessage {
  id: string;
  agentId: string;
  role: MessageRole;
  content: MessageContent;
  createdAt: number;
  roomId?: string;
  roomName?: string;
  speaker?: string;
  source?: 'user' | 'room' | 'agent';
}

export interface ArtifactView {
  path: string;
  tool: string;
  createdAt: string;
}

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCallView[];
  createdAt: string;
  error?: boolean;
  senderName?: string;
  senderColor?: string;
  senderAvatar?: string;
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
  role: string;
  color: string;
  avatar?: string;
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
}

export interface ToolInfo {
  name: string;
  description: string;
}

export interface HealthInfo {
  ok: boolean;
  model: string;
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
  | { type: 'fanout_done'; roundId: string; spoke: number; silent: number };

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

export type InteractionKind = 'choice' | 'secret';

export interface InteractionOption {
  id: string;
  label: string;
  description?: string;
}

export interface InteractionRequest {
  id: string;
  kind: InteractionKind;
  question: string;
  detail?: string;
  options?: InteractionOption[];
  name?: string;
  agentId: string;
  agentName: string;
  createdAt: number;
  expiresAt: number;
}

/** 与后端 src/agent/types.ts 的 AgentEvent 保持一致 */
export type AgentEvent =
  | { type: 'context'; stats: ContextStats }
  | { type: 'interaction'; request: InteractionRequest }
  | { type: 'interaction_closed'; id: string; answered: boolean }
  | { type: 'message'; message: WireMessage }
  | { type: 'delta'; text: string }
  | { type: 'iteration'; index: number }
  | { type: 'compacted'; coversUpTo: number; messageCount: number }
  | { type: 'memory'; added: Array<{ entry: { id: string; text: string } }>; merged: number }
  | { type: 'final'; content: string };

export interface RunResult {
  content: string;
  iterations: number;
  stopReason: string;
}
