import type { LLMResponse, TokenUsage, ToolCall, ToolSchema } from '../agent/types.js';
import type { ChatOptions, LLMMessage, LLMProvider } from './provider.js';

export interface OpenAIProviderConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  temperature?: number;
  timeoutMs?: number;
  /** 流式空闲超时：连续这么久没有字节视为停滞（默认 60s，单测可调短） */
  streamIdleTimeoutMs?: number;
  /** 是否开启思考模式（默认开启） */
  thinkingEnabled?: boolean;
  /** 思考等级 / 推理深度（low | medium | high，默认 medium） */
  thinkingLevel?: 'low' | 'medium' | 'high';
}

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: string;
  content: string | null | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
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
  error?: { message: string };
}

interface StreamDelta {
  content?: string | null;
  tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
}

interface StreamChunk {
  choices?: Array<{ delta?: StreamDelta; finish_reason?: string | null }>;
  usage?: WireResponse['usage'];
  error?: { message: string };
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_TIMEOUT_MS = 180_000;
/** 流式途中连续这么久没有收到任何字节，视为流已停滞：报错优于无限挂起 */
const STREAM_IDLE_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;

async function readResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.length;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('模型响应超过 512KiB，已停止读取，请拆分任务');
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai-compatible';

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly temperature: number | undefined;
  private readonly timeoutMs: number;
  private readonly streamIdleMs: number;
  private readonly thinkingEnabled: boolean;
  private readonly thinkingLevel: 'low' | 'medium' | 'high';

  constructor(config: OpenAIProviderConfig) {
    if (!config.apiKey) throw new Error('OpenAIProvider: apiKey is required');
    if (!config.model) throw new Error('OpenAIProvider: model is required');
    this.apiKey = config.apiKey;
    this.baseURL = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = config.model;
    this.temperature = config.temperature;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.streamIdleMs = config.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
    this.thinkingEnabled = config.thinkingEnabled !== false;
    this.thinkingLevel = config.thinkingLevel ?? 'medium';
  }

  async chat(messages: LLMMessage[], options: ChatOptions = {}): Promise<LLMResponse> {
    if (options.onDelta) return this.chatStream(messages, options);

    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(toWireMessage),
    };

    if (this.thinkingEnabled) {
      body.reasoning_effort = this.thinkingLevel;
      const budget = this.thinkingLevel === 'low' ? 2048 : this.thinkingLevel === 'high' ? 24576 : 8192;
      body.thinking = { type: 'enabled', budget_tokens: budget };
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(toWireTool);
      body.tool_choice = 'auto';
    }

    const isReasoningModel = /^(o1|o3)/i.test(this.model);
    const temperature = options.temperature ?? this.temperature;
    if (temperature !== undefined && !isReasoningModel) body.temperature = temperature;

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
      const detail = await readResponseText(response).catch(() => '');
      throw new Error(
        `LLM request failed with ${response.status} ${response.statusText}` +
          (detail ? `: ${detail.slice(0, 500)}` : ''),
      );
    }

    const data = JSON.parse(await readResponseText(response)) as WireResponse;
    if (data.error?.message) {
      throw new Error(`LLM returned an error: ${data.error.message}`);
    }

    const choice = data.choices?.[0];
    if (!choice) throw new Error('LLM response contained no choices');

    const rawMsg = choice.message as any;
    // 思维链（reasoning_content）不并进对话正文：聊天里不展示思考过程，
    // 正文只保留回复本身，避免把推理文本当成助理消息存下来、复制和外发。
    const messageContent = rawMsg?.content ?? null;

    return {
      content: messageContent,
      toolCalls: (choice.message?.tool_calls ?? []).map(toToolCall),
      finishReason: choice.finish_reason ?? null,
      usage: toUsage(data.usage),
    };
  }

  /** 流式路径：SSE 逐段解析，增量文本回调 onDelta，tool_calls 分片按 index 拼装 */
  private async chatStream(messages: LLMMessage[], options: ChatOptions): Promise<LLMResponse> {
    const onDelta = options.onDelta!;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(toWireMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (this.thinkingEnabled) {
      body.reasoning_effort = this.thinkingLevel;
      const budget = this.thinkingLevel === 'low' ? 2048 : this.thinkingLevel === 'high' ? 24576 : 8192;
      body.thinking = { type: 'enabled', budget_tokens: budget };
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(toWireTool);
      body.tool_choice = 'auto';
    }
    const isReasoningModel = /^(o1|o3)/i.test(this.model);
    const temperature = options.temperature ?? this.temperature;
    if (temperature !== undefined && !isReasoningModel) body.temperature = temperature;

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const outer = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    // 空闲看门狗：总超时管「整个请求太久」，这条管「流中途断气」——
    // 停滞的连接既不吐字也不结束，60 秒就该放弃并让上层走重试。
    const idleController = new AbortController();
    const signal = AbortSignal.any([outer, idleController.signal]);
    let idleTimer: NodeJS.Timeout | null = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idleController.abort(), this.streamIdleMs);
    };
    armIdle();

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    }).catch(error => { if (idleTimer) clearTimeout(idleTimer); throw error; });

    if (!response.ok) {
      if (idleTimer) clearTimeout(idleTimer);
      const detail = await readResponseText(response).catch(() => '');
      throw new Error(
        `LLM request failed with ${response.status} ${response.statusText}` +
          (detail ? `: ${detail.slice(0, 500)}` : ''),
      );
    }
    if (!response.body) { if (idleTimer) clearTimeout(idleTimer); throw new Error('LLM streaming response contained no body'); }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let bytes = 0;
    let finishReason: string | null = null;
    let usage: TokenUsage | null = null;
    const calls = new Map<number, { id: string; name: string; arguments: string }>();

    const handleLine = (rawLine: string): void => {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(payload) as StreamChunk;
      } catch {
        throw new Error('模型 SSE 返回了不完整或非法 JSON，未执行本批工具');
      }
      if (chunk.error?.message) throw new Error(`LLM returned an error: ${chunk.error.message}`);
      if (chunk.usage) usage = toUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      // 思维链增量只用于模型侧观测，不进正文、不上屏、不入库
      if ((choice.delta as any)?.reasoning_content) {
        // 忽略：reasoning_content 与 content 同一 delta 到达时，下面的分支仍会处理正文
      } else if (choice.delta?.content) {
        content += choice.delta.content;
        if (content.length > 64000) throw new Error('模型正文超过 64000 字符，请拆分任务');
        onDelta(choice.delta.content);
      }
      for (const piece of choice.delta?.tool_calls ?? []) {
        if (!Number.isSafeInteger(piece.index) || piece.index < 0 || piece.index >= 128) throw new Error('模型工具索引/数量超限');
        const slot = calls.get(piece.index) ?? { id: '', name: '', arguments: '' };
        if (piece.id) slot.id = piece.id;
        if (piece.function?.name) slot.name = piece.function.name;
        if (piece.function?.arguments) slot.arguments += piece.function.arguments;
        if (slot.arguments.length > 64000 || slot.name.length > 200 || slot.id.length > 200) throw new Error('模型工具参数超过安全缓冲上限，请分块写入');
        calls.set(piece.index, slot);
      }
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MAX_STREAM_BYTES) throw new Error('模型流超过 2MiB，已停止读取');
        armIdle();
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_RESPONSE_BYTES) throw new Error('模型单条流事件超过 512Ki 字符');
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          handleLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }
      if (buffer.trim()) handleLine(buffer);
      if (!finishReason) throw new Error('模型流在结束标记前断开；未执行本批工具，请重试');
    } catch (error) {
      if (idleController.signal.aborted) {
        throw new Error(
          `LLM 流空闲超过 ${Math.round(this.streamIdleMs / 1000)} 秒，已中断（可直接重试）`,
        );
      }
      throw error;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, slot]) => ({
        id: slot.id || `call_${slot.name}`,
        name: slot.name,
        arguments: slot.arguments || '{}',
      }));
    return { content: content || null, toolCalls, finishReason, usage };
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

  if (message.images?.length) {
    if (message.role !== 'user') throw new Error('图片只能附在入站 user 消息中');
    return { role: 'user', content: [
      { type: 'text', text: message.content ?? '' },
      ...message.images.flatMap(image => [
        ...(image.alt ? [{ type: 'text' as const, text: `图片说明（发送者提供）：${image.alt}` }] : []),
        { type: 'image_url' as const, image_url: { url: image.url } },
      ]),
    ] };
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
