import type { ToolCall, ToolSchema } from '../agent/types.js';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ChatOptions {
  tools?: ToolSchema[];
  temperature?: number;
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly name: string;
  chat(messages: LLMMessage[], options?: ChatOptions): Promise<import('../agent/types.js').LLMResponse>;
}
