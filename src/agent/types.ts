import type { Tool } from '../tools/tool.js';
import type { MemoryEntry, MemoryScope } from '../memory/types.js';
import type { InteractionRequest } from '../interaction/types.js';

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
    };

export interface Message {
  id: string;
  agentId: string;
  role: MessageRole;
  content: MessageContent;
  createdAt: number;
  /** 这一轮来自哪个房间；私聊为空 */
  roomId?: string;
  roomName?: string;
  /** 谁说的：用户 / 某个同事 / 自己的主人 */
  speaker?: string;
  /** 这一轮是由什么触发的 */
  source?: 'user' | 'room' | 'agent';
}

export interface MemoryRef {
  entry: MemoryEntry;
  scope: MemoryScope;
  ownerId: string;
}

export type MemoryKind = 'fact' | 'summary';

export interface CompactionState {
  summary: string;
  coversUpTo: number;
  messageCount: number;
  updatedAt: number;
}

/** 某个智能体此刻能看到的全部记忆（自己的 + 共用的 + 参与项目的） */
export interface AgentMemory {
  refs: MemoryRef[];
  compaction: CompactionState | null;
  projectIds: string[];
}

export interface AgentRecord {
  id: string;
  name: string;
  /** 一行简介，侧边栏与群成员列表展示用 */
  title: string;
  /** 详细描述 */
  description: string;
  instructions: string;
  toolNames: string[];
  color: string;
  /** 头像；一期只支持 emoji / 短字符 */
  avatar?: string;
  /** 侧边栏分组 id */
  section?: string;
  /** 是否从侧边栏隐藏 */
  hidden?: boolean;
  /** 这个智能体参与的项目；决定它能读到哪些项目笔记 */
  projectIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Agent {
  id: string;
  name: string;
  /** 一行简介 */
  title: string;
  /** 详细描述 */
  description: string;
  instructions: string;
  tools: Tool<any>[];
  memory: AgentMemory;
  toolNames: string[];
  color: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkingFile {
  path: string;
  tool: string;
  at: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: TokenUsage | null;
}

export interface JSONSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JSONSchema;
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

export type AgentEvent =
  | { type: 'context'; stats: ContextStats }
  | { type: 'interaction'; request: InteractionRequest }
  | { type: 'interaction_closed'; id: string; answered: boolean }
  | { type: 'message'; message: Message }
  | { type: 'delta'; text: string }
  | { type: 'iteration'; index: number }
  | { type: 'compacted'; coversUpTo: number; messageCount: number }
  | { type: 'memory'; added: MemoryRef[]; merged: number }
  | { type: 'final'; content: string };

export type AgentEventHandler = (event: AgentEvent) => void;

/**
 * 回合怎么收的场：
 * parked = 被用户新句插队挂起（旧树仍 open 欠着）；
 * stopped = 被停止令作废；
 * cancelled = 连接断开等外部中止。
 */
export type StopReason = 'final_answer' | 'max_iterations' | 'parked' | 'stopped' | 'cancelled';

export interface RunResult {
  content: string;
  iterations: number;
  stopReason: StopReason;
  usedTools?: string[];
}

export function messageText(message: Message): string {
  const content = message.content;
  if (content.type === 'text') return content.text;
  if (content.type === 'tool_calls') {
    return content.calls.map((call) => `${call.name}(${call.arguments})`).join('\n');
  }
  return content.result;
}

export function isErrorResult(message: Message): boolean {
  return message.content.type === 'tool_result' && !message.content.ok;
}
