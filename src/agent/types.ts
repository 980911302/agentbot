import type { Tool } from '../tools/tool.js';
import type { MemoryEntry, MemoryScope } from '../memory/types.js';
import type { InteractionRequest } from '../interaction/types.js';

// 线上契约（消息/事件/结果）的唯一来源在 shared/contracts；这里按原名 re-export，
// 后端内部代码继续从这里 import，避免逐个文件改 import 路径。
import type {
  ToolCall,
  MessageRole,
  MessageContent,
  Message,
  StopReason,
  RunResult,
} from '../shared/contracts/sse.js';
export type { ToolCall, MessageRole, MessageContent, Message, StopReason, RunResult };

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
  /** 显式工具清单（含空清单）不得在启动时重新授权。 */
  toolPolicy?: 'default' | 'explicit';
  color: string;
  /**
   * 头像（E5.1）：上传的图片存成数据目录头像目录的资源引用 `avatars/<文件名>`，
   * 界面经 `GET /api/agents/:id/avatar` 读；历史数据里可能是 emoji / 绝对路径，原样保留。
   * 空串是「明确清空」的结果，与 undefined（从未设置）不同。
   */
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
