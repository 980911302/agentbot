/**
 * HTTP / SSE 线上契约（E1.5）。
 *
 * 这里只放**前后端都要遵守的线上形状**：纯类型 + 纯校验，不引用 Node / React，
 * 也不依赖任何运行模块。后端内部领域类型从本文件 re-export，
 * 前端用 `import type` 引用（类型在编译期擦除，不会把后端模块带进 bundle）。
 * 改任何字段前先想清楚：这是契约，改了就是兼容性问题。
 */

export type MessageRole = 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

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
      /** 可选以兼容旧消息；新执行不再根据 result 的文字前缀判断状态。 */
      outcome?: Omit<import('./tool-result.js').ToolResult, 'content'>;
    };

/** 一条消息的线上形状（后端持久化与 SSE 下发共用） */
export interface Message {
  id: string;
  runId?: string;
  agentId: string;
  role: MessageRole;
  content: MessageContent;
  images?: import('./input-image.js').InputImage[];
  createdAt: number;
  /** 这一轮来自哪个房间；私聊为空 */
  roomId?: string;
  roomName?: string;
  /** 谁说的：用户 / 某个同事 / 自己的主人 */
  speaker?: string;
  /** 这一轮是由什么触发的 */
  source?: 'user' | 'room' | 'agent';
  /** 真实发送者，与模型 role 分离；旧消息缺省按 source 保守展示。 */
  sender?: import('./message-identity.js').MessageActor;
  /** 关联原始来信；UI 使用往来记录，避免将模型输入再显示一次。 */
  correspondenceIds?: string[];
  /** 客户端幂等键（E3.2：重复提交返回原消息） */
  clientMessageId?: string;
}

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

export type MemoryScopeRef = 'self' | 'user' | 'project';

export type InteractionKind = 'choice' | 'secret';

export interface InteractionOption {
  id: string;
  label: string;
  description?: string;
}

/** 问答卡的线上形状：choice=选项卡，secret=遮罩密钥框 */
export interface InteractionRequest {
  id: string;
  kind: InteractionKind;
  question: string;
  detail?: string;
  options?: InteractionOption[];
  /** secret 专用：保存之后用什么名字引用 */
  name?: string;
  agentId: string;
  agentName: string;
  createdAt: number;
  expiresAt: number;
}

export interface MemoryAddedRef {
  entry: { id: string; text: string };
}

/** AgentEvent —— `event: event` 帧的载荷（私聊 + 群回合共用） */
export type AgentEvent =
  | { type: 'correspondence'; transfer: import('./message-identity.js').Correspondence }
  | { type: 'context'; stats: ContextStats }
  | { type: 'interaction'; request: InteractionRequest }
  | { type: 'interaction_closed'; id: string; answered: boolean }
  | { type: 'message'; message: Message }
  | { type: 'delta'; text: string }
  | { type: 'iteration'; index: number }
  | { type: 'compacted'; coversUpTo: number; messageCount: number }
  | { type: 'memory'; added: MemoryAddedRef[]; merged: number }
  | { type: 'final'; content: string };

export type StopReason =
  | 'final_answer'
  | 'max_iterations'
  | 'tool_limit'
  | 'parked'
  /** 主动让位给持久等待（E4.3）：本次执行结束、释放执行位；事件到达后新开一次执行 */
  | 'waiting'
  | 'stopped'
  | 'cancelled'
  | 'duplicate';

/** `event: done` 帧的载荷 */
export interface RunResult {
  content: string;
  iterations: number;
  stopReason: StopReason;
  usedTools?: string[];
  taskId?: string;
}

/** SSE 帧名 */
export type SseFrameName = 'event' | 'room' | 'done' | 'error';

const AGENT_EVENT_TYPES = new Set([
  'correspondence',
  'context',
  'interaction',
  'interaction_closed',
  'message',
  'delta',
  'iteration',
  'compacted',
  'memory',
  'final',
]);

/** 出站防线：不是已知形状的事件不下发（E1.5 运行时校验） */
export function isKnownAgentEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const type = (event as { type?: unknown }).type;
  return typeof type === 'string' && AGENT_EVENT_TYPES.has(type);
}
