import { randomUUID } from 'node:crypto';
import type {
  Agent,
  AgentEvent,
  AgentEventHandler,
  LLMResponse,
  Message,
  RunResult,
  ToolCall,
} from './types.js';
import type { BuiltContext } from '../context/builder.js';
import type { LLMProvider } from '../llm/provider.js';
import type { LLMMessage } from '../llm/provider.js';
import type { MessageStore } from '../store/messages.js';
import type { ToolInvocationPort, ToolInvocationRecord } from '../storage/ports.js';
import { ToolRegistry } from '../tools/registry.js';
import { operationKeyOf, replayPolicyOf } from '../tools/policy.js';
import type { ToolContext } from '../tools/tool.js';

export interface AgentLoopDeps {
  provider: LLMProvider;
  messages: MessageStore;
  maxIterations?: number;
  onEvent?: AgentEventHandler;
  /** 私聊流式：模型每吐一段增量文本就回调一次（群回合不传） */
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  /** 覆盖这一轮可用的工具（群回合会额外挂 say / stay_silent） */
  toolsOverride?: ToolRegistry;
  /** 工具执行上下文里要带的额外信息 */
  toolContext?: Pick<ToolContext, 'room' | 'agentChainDepth' | 'turnState' | 'emit'>;
  /** 群回合里模型的收尾文本属于内部推理，不写进对话历史 */
  persistAssistantText?: boolean;
  /** 追加到每条持久化消息上的元信息（房间标记等） */
  stamp?: Partial<Pick<Message, 'roomId' | 'roomName' | 'speaker' | 'source'>>;
  /** 工具执行账本（E3.5）：先记意图 → 执行 → 记结果；不传则不记账 */
  invocations?: ToolInvocationPort;
  /** 记账归属：哪次回合（Run） */
  runId?: string;
  treeId?: string;
  /**
   * 执行位检查（E3.6）：被抢占的旧执行返回 false。
   * 迟到写入不再进对话线、不再发事件；工具结果仍然回填账本，供恢复核对。
   */
  isCurrent?: () => boolean;
}

const DEFAULT_MAX_ITERATIONS = 12;

export class AgentLoop {
  constructor(private readonly deps: AgentLoopDeps) {}

  async run(agent: Agent, built: BuiltContext): Promise<RunResult> {
    const maxIterations = this.deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const registry = this.deps.toolsOverride ?? ToolRegistry.from(agent.tools);
    const persistText = this.deps.persistAssistantText !== false;
    const conversation: LLMMessage[] = [...built.messages];
    const usedTools: string[] = [];

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      this.emit({ type: 'iteration', index: iteration });

      const response = await this.deps.provider.chat(conversation, {
        tools: registry.getSchemas(),
        signal: this.deps.signal,
        onDelta: this.deps.onDelta,
      });

      const text = (response.content ?? '').trim();
      // E3.6：被抢占的旧执行不再写对话线（迟到结果只留在工具账本里供核对）
      if (text && persistText && !this.stale()) {
        const message = await this.persist(agent, 'assistant', { type: 'text', text });
        this.emit({ type: 'message', message });
      }

      if (response.toolCalls.length === 0) {
        this.emit({ type: 'final', content: text });
        return { content: text, iterations: iteration, stopReason: 'final_answer', usedTools };
      }

      const persistent = response.toolCalls.filter((call) => !registry.isEphemeral(call.name));
      if (persistent.length > 0 && !this.stale()) {
        const callMessage = await this.persist(agent, 'assistant', {
          type: 'tool_calls',
          calls: persistent,
        });
        this.emit({ type: 'message', message: callMessage });
      }
      conversation.push(...toWireAssistant(response));

      for (const call of response.toolCalls) {
        usedTools.push(call.name);
        const startedAt = Date.now();
        // E3.5：先记意图再执行——中断后才有核对依据（「有意图没结果」）
        const invocation = await this.startInvocation(agent, call);
        let result: string;
        try {
          result = await registry.execute(call, {
            agentId: agent.id,
            projectIds: agent.memory.projectIds,
            signal: this.deps.signal,
            ...(this.deps.toolContext ?? {}),
          });
        } catch (error) {
          await this.finishInvocation(invocation, 'unknown', undefined, error);
          throw error;
        }
        const ok = !result.startsWith('Error:');
        await this.finishInvocation(
          invocation,
          ok ? 'ok' : 'error',
          ok ? result : undefined,
          ok ? undefined : result,
          Date.now() - startedAt,
        );

        if (!registry.isEphemeral(call.name) && !this.stale()) {
          const resultMessage = await this.persist(agent, 'tool', {
            type: 'tool_result',
            callId: call.id,
            name: call.name,
            result,
            durationMs: Date.now() - startedAt,
            ok,
          });
          this.emit({ type: 'message', message: resultMessage });
        }

        conversation.push({ role: 'tool', content: result, toolCallId: call.id });
      }
    }

    const content = `已达到 ${maxIterations} 轮上限，未得到最终答复。`;
    this.emit({ type: 'final', content });
    return { content, iterations: maxIterations, stopReason: 'max_iterations', usedTools };
  }

  private async persist(
    agent: Agent,
    role: Message['role'],
    content: Message['content'],
  ): Promise<Message> {
    const message: Message = {
      id: randomUUID(),
      agentId: agent.id,
      role,
      content,
      createdAt: Date.now(),
      ...(this.deps.stamp ?? {}),
    };
    await this.deps.messages.append(message);
    return message;
  }

  private emit(event: AgentEvent): void {
    if (this.stale()) return;
    this.deps.onEvent?.(event);
  }

  /** 执行位还在自己手里吗（E3.6）：被抢占后不再对外写、不再发事件 */
  private stale(): boolean {
    return this.deps.isCurrent ? !this.deps.isCurrent() : false;
  }

  /** 执行前先落一条意图；账本故障不能拖垮回合（这次调用就没有核对依据） */
  private async startInvocation(agent: Agent, call: ToolCall): Promise<ToolInvocationRecord | undefined> {
    const ledger = this.deps.invocations;
    if (!ledger) return undefined;
    try {
      return await ledger.start({
        agentId: agent.id,
        runId: this.deps.runId,
        treeId: this.deps.treeId,
        tool: call.name,
        operationKey: operationKeyOf({ agentId: agent.id, tool: call.name, args: call.arguments }),
        args: call.arguments,
        replayPolicy: replayPolicyOf(call.name),
      });
    } catch {
      return undefined;
    }
  }

  private async finishInvocation(
    invocation: ToolInvocationRecord | undefined,
    status: 'ok' | 'error' | 'unknown',
    summary?: string,
    error?: unknown,
    durationMs?: number,
  ): Promise<void> {
    if (!invocation) return;
    await this.deps.invocations
      ?.finish(invocation.id, {
        status,
        ...(summary ? { summary } : {}),
        ...(error !== undefined
          ? { error: error instanceof Error ? error.message : String(error) }
          : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      })
      .catch(() => undefined);
  }
}

function toWireAssistant(response: LLMResponse): LLMMessage[] {
  const text = (response.content ?? '').trim();
  if (text) {
    return [{ role: 'assistant', content: text, toolCalls: response.toolCalls }];
  }
  return [{ role: 'assistant', content: null, toolCalls: response.toolCalls }];
}

export function toolCallNames(calls: ToolCall[]): string {
  return calls.map((call) => call.name).join(', ');
}
