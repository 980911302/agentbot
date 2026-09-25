import type { LLMMessage } from '../llm/provider.js';
import type { ToolSchema } from '../agent/types.js';
import { estimateTokens, truncateToTokens } from './budget.js';
import { IMAGE_CONTEXT_RESERVE } from '../shared/contracts/input-image.js';

export const RESPONSE_RESERVE = 8192;
/** 工具 schema 最多占可用输入预算的比例：schema 再大也不能把任务和原文挤光。 */
export const SCHEMA_BUDGET_SHARE = 0.25;
const NOTICE = '[较早的工具记录已按上下文预算缩短/移出；原文件和持久消息仍保留。不要把未显示内容当成不存在，需要时定点重读。]';

/**
 * 可用输入预算：留 15% 波动余量，再扣掉输出预留（E4.6）。
 * builder 的分配器与这里共用同一个算法，避免两处各留一套安全余量、互相打架。
 */
export function contextAvailable(total: number): number {
  return Math.floor(total * 0.85) - RESPONSE_RESERVE;
}

/** 工具 schema 的估算成本（含请求包装开销），与消息成本同口径。 */
export function toolSchemaCost(tools: ToolSchema[]): number {
  return estimateTokens(JSON.stringify(tools)) + 128;
}

/**
 * 工具 schema 降级（E4.6）：身份、工具、工作、记忆、原文、输出预留共用一份预算。
 *
 * schema 描述是**说明文字**，超出份额时按比例截断不会改变任务意思；
 * 工具名、参数结构、类型与枚举一律保留（截掉的只有 description/title 这类文字）。
 * 降级后仍放不下时，由 fitContextWindow 明确报错，绝不静默发出超限请求。
 */
export function fitToolSchemas(tools: ToolSchema[], total = 60000): ToolSchema[] {
  if (!tools.length) return tools;
  const cap = Math.max(512, Math.floor(contextAvailable(total) * SCHEMA_BUDGET_SHARE));
  if (toolSchemaCost(tools) <= cap) return tools;
  const perTool = Math.max(64, Math.floor((cap - 128) / tools.length));
  let credits = 1;
  let shrunk = tools.map((tool) => shrinkSchema(tool, perTool));
  while (toolSchemaCost(shrunk) > cap && credits > 1 / 64) {
    credits /= 2;
    shrunk = tools.map((tool) => shrinkSchema(tool, Math.max(16, Math.floor(perTool * credits))));
  }
  return shrunk;
}

/** 只截描述性文字；type/required/enum/属性名是结构，动它就等于改契约。 */
function shrinkSchema(tool: ToolSchema, tokens: number): ToolSchema {
  const textShare = Math.max(8, Math.floor(tokens / 8));
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          key === 'description' || key === 'title'
            ? truncateToTokens(typeof item === 'string' ? item : String(item), textShare)
            : walk(item),
        ]),
      );
    }
    return value;
  };
  return {
    ...tool,
    description: truncateToTokens(tool.description, tokens),
    parameters: walk(tool.parameters) as ToolSchema['parameters'],
  };
}

/** 每次请求前执行，不改持久历史；把 schema、消息包装、输出预留一起计入。 */
export function fitContextWindow(input: LLMMessage[], tools: ToolSchema[], total = 60000, taskContent?: string | null, protectedContents: readonly string[] = []): LLMMessage[] {
  const available = contextAvailable(total);
  const schemaCost = toolSchemaCost(tools);
  const cost = (messages: LLMMessage[]) => schemaCost + estimateTokens(JSON.stringify(messages))
    + messages.reduce((sum, message) => sum + (message.images?.length ?? 0) * IMAGE_CONTEXT_RESERVE, 0);
  const groups: LLMMessage[][] = [];
  for (let index = 0; index < input.length; index++) {
    const message = input[index]!;
    if (message.role === 'tool') continue;
    const group: LLMMessage[] = [{ ...message }];
    if (message.toolCalls?.length) {
      const results = new Map<string, LLMMessage>();
      while (input[index + 1]?.role === 'tool') {
        const result = input[++index]!;
        if (result.toolCallId) results.set(result.toolCallId, result);
      }
      const calls = message.toolCalls.filter(call => results.has(call.id));
      if (!calls.length) continue;
      group[0] = { ...message, toolCalls: calls };
      group.push(...calls.map(call => ({ ...results.get(call.id)! })));
    }
    groups.push(group);
  }
  const task = taskContent === undefined ? input.findLast(item => item.role === 'user')?.content : taskContent;
  const pinned = (group: LLMMessage[]) => group[0]?.role === 'system' || (group[0]?.role === 'user' && (group[0]?.content === task || protectedContents.includes(group[0]?.content ?? '')));
  let current = groups.flat();
  if (cost(current) <= available) return current;
  // 先压缩工具大正文与写入参数，不碰用户的任务或系统规则。
  for (const group of groups) {
    for (const message of group) {
      if (message.role === 'tool' && message.content) message.content = truncateToTokens(message.content, 1000);
      if (message.toolCalls) message.toolCalls = message.toolCalls.map(call => {
        if (call.arguments.length <= 2000) return call;
        let path: string | undefined;
        try { path = JSON.parse(call.arguments).path; } catch { /* 旧的坏参数不能影响恢复 */ }
        return { ...call, arguments: JSON.stringify({ ...(typeof path === 'string' ? { path } : {}), _history_note: '历史调用的长参数已移出上下文；执行结果见对应 tool 消息，必要时重新读取文件' }) };
      });
    }
  }
  const notice: LLMMessage = { role: 'assistant', content: NOTICE };
  while (cost([...groups.flat(), notice]) > available) {
    const index = groups.findIndex(group => !pinned(group));
    if (index < 0) throw new Error('系统规则或本次任务本身超过上下文预算，请缩短提示词/分批提交；尚未继续执行工具');
    groups.splice(index, 1);
  }
  // 提示放在稳定 system 前缀之后，不改变前缀内容。
  current = groups.flat();
  const afterSystem = current.findIndex(message => message.role !== 'system');
  current.splice(afterSystem < 0 ? current.length : afterSystem, 0, notice);
  return current;
}
