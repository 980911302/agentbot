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
import { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/tool.js';

export interface AgentLoopDeps {
  provider: LLMProvider;
  messages: MessageStore;
  maxIterations?: number;
  onEvent?: AgentEventHandler;
  signal?: AbortSignal;
  /** 覆盖这一轮可用的工具（群回合会额外挂 say / stay_silent） */
  toolsOverride?: ToolRegistry;
  /** 工具执行上下文里要带的额外信息 */
  toolContext?: Pick<ToolContext, 'room' | 'agentChainDepth' | 'turnState'>;
  /** 群回合里模型的收尾文本属于内部推理，不写进对话历史 */
  persistAssistantText?: boolean;
  /** 追加到每条持久化消息上的元信息（房间标记等） */
  stamp?: Partial<Pick<Message, 'roomId' | 'roomName' | 'speaker' | 'source'>>;
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
      });

      const text = (response.content ?? '').trim();
      if (text && persistText) {
        const message = await this.persist(agent, 'assistant', { type: 'text', text });
        this.emit({ type: 'message', message });
      }

      if (response.toolCalls.length === 0) {
        this.emit({ type: 'final', content: text });
        return { content: text, iterations: iteration, stopReason: 'final_answer', usedTools };
      }

      const persistent = response.toolCalls.filter((call) => !registry.isEphemeral(call.name));
      if (persistent.length > 0) {
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
        const result = await registry.execute(call, {
          agentId: agent.id,
          projectIds: agent.memory.projectIds,
          signal: this.deps.signal,
          ...(this.deps.toolContext ?? {}),
        });
        const ok = !result.startsWith('Error:');

        if (!registry.isEphemeral(call.name)) {
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
    this.deps.onEvent?.(event);
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
