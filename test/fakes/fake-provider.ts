import type { LLMMessage, LLMResponse } from '../../src/llm/provider.js';

/**
 * 共享测试夹具（E1.6）：可编程的假模型 Provider。
 *
 * 两种用法：
 *   1. 自动应答：new FakeProvider({ auto: (messages) => ({...}) }) —— 每次调用立即返回
 *      （也可以返回 Promise，用来构造模型「忙住」的时序，见 UI-07 的忙碌态验收）
 *   2. 手动放行：new FakeProvider() 后用 pending/release 精确控制时序；abort 会拒绝
 *
 * 只为本进程服务；不访问网络、不依赖真实 API Key。
 */

export interface FakeProviderOptions {
  auto?: (messages: LLMMessage[], opts: { signal?: AbortSignal; onDelta?: (text: string) => void }) => LLMResponse | Promise<LLMResponse>;
  /** 默认 true：abort 时 chat() 拒绝 */
  rejectOnAbort?: boolean;
}

const TEXT = (text: string) => ({
  content: text,
  toolCalls: [],
  finishReason: 'stop',
  usage: null,
});

export class FakeProvider {
  readonly name = 'fake';
  readonly calls: LLMMessage[][] = [];
  /** 每次调用时模型请求里带的工具名（E5.3：断言同事/工人实际拿到的工具面） */
  readonly offeredTools: string[][] = [];
  private readonly options: FakeProviderOptions;
  private readonly pending: Array<{
    resolve: (response: LLMResponse) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(options: FakeProviderOptions = {}) {
    this.options = { rejectOnAbort: true, ...options };
  }

  chat(
    messages: LLMMessage[],
    opts: { signal?: AbortSignal; tools?: Array<{ name: string }> } = {},
  ): Promise<LLMResponse> {
    this.calls.push(messages.map((message) => ({ ...message })));
    this.offeredTools.push((opts.tools ?? []).map((tool) => tool.name));
    if (this.options.auto) {
      if (opts.signal?.aborted) {
        return Promise.reject(new Error('aborted'));
      }
      return Promise.resolve(this.options.auto(messages, { signal: opts.signal, onDelta: opts.onDelta }));
    }
    return new Promise<LLMResponse>((resolve, reject) => {
      const entry: {
        resolve: (response: LLMResponse) => void;
        reject: (error: Error) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject, signal: opts.signal };
      if (this.options.rejectOnAbort && opts.signal) {
        entry.onAbort = () => reject(new Error('aborted'));
        opts.signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.pending.push(entry);
    });
  }

  /** 当前还没放行的调用数 */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** 按调用序号放行（finishReason=stop 的纯文本应答） */
  releaseText(index: number, text: string): void {
    this.release(index, TEXT(text));
  }

  /** 按调用序号放行任意应答 */
  release(index: number, response: LLMResponse): void {
    const entry = this.pending[index];
    if (!entry) throw new Error(`FakeProvider: 第 ${index + 1} 次调用还没有发生`);
    entry.resolve(response);
  }

  /** 最近一次调用的全文（断言简报/上下文内容用） */
  lastCallText(): string {
    return JSON.stringify(this.calls[this.calls.length - 1] ?? []);
  }

  static text(text: string) {
    return TEXT(text);
  }

  static toolCalls(calls: Array<{ id: string; name: string; arguments: string }>) {
    return { content: null, toolCalls: calls, finishReason: 'tool_calls' as const, usage: null };
  }
}

const TEXTResponse = TEXT;
export { TEXTResponse as textResponse };
