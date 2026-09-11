import type { LLMResponse, TokenUsage, ToolCall, ToolSchema } from '../agent/types.js';
import type { ChatOptions, LLMMessage, LLMProvider } from './provider.js';

export interface OpenAIProviderConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  temperature?: number;
  timeoutMs?: number;
}

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

interface WireChoice {
  message?: { content?: string | null; tool_calls?: WireToolCall[] };
  finish_reason?: string | null;
}

interface WireResponse {
  choices?: WireChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_TIMEOUT_MS = 180_000;

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai-compatible';

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly temperature: number | undefined;
  private readonly timeoutMs: number;

  constructor(config: OpenAIProviderConfig) {
    if (!config.apiKey) throw new Error('OpenAIProvider: apiKey is required');
    if (!config.model) throw new Error('OpenAIProvider: model is required');
    this.apiKey = config.apiKey;
    this.baseURL = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = config.model;
    this.temperature = config.temperature;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async chat(messages: LLMMessage[], options: ChatOptions = {}): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(toWireMessage),
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(toWireTool);
      body.tool_choice = 'auto';
    }

    const temperature = options.temperature ?? this.temperature;
    if (temperature !== undefined) body.temperature = temperature;

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `LLM request failed with ${response.status} ${response.statusText}` +
          (detail ? `: ${detail.slice(0, 500)}` : ''),
      );
    }

    const data = (await response.json()) as WireResponse;
    if (data.error?.message) {
      throw new Error(`LLM returned an error: ${data.error.message}`);
    }

    const choice = data.choices?.[0];
    if (!choice) throw new Error('LLM response contained no choices');

    return {
      content: choice.message?.content ?? null,
      toolCalls: (choice.message?.tool_calls ?? []).map(toToolCall),
      finishReason: choice.finish_reason ?? null,
      usage: toUsage(data.usage),
    };
  }
}

function toWireMessage(message: LLMMessage): WireMessage {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content ?? '',
      tool_call_id: message.toolCallId,
    };
  }

  if (message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content ?? '',
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }

  return { role: message.role, content: message.content ?? '' };
}

function toWireTool(tool: ToolSchema) {
  return {
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toToolCall(raw: WireToolCall): ToolCall {
  return {
    id: raw.id,
    name: raw.function.name,
    arguments: raw.function.arguments || '{}',
  };
}

function toUsage(raw: WireResponse['usage']): TokenUsage | null {
  if (!raw) return null;
  return {
    promptTokens: raw.prompt_tokens ?? 0,
    completionTokens: raw.completion_tokens ?? 0,
    totalTokens: raw.total_tokens ?? 0,
  };
}
