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

/**
 * 跨轮的压缩边界（同一回合内由 AgentLoop 持有）：最早的 compacted 组已经压短过，
 * 下一轮继续按原样压，发出去的前缀就不会每轮都变（利于供应商前缀缓存）。
 */
export interface WindowState {
  compacted: number;
}

/** 需要压缩时压到可用预算的这个比例：留出余量，后面几轮追加工具结果时不必再动前缀 */
const COMPACT_TARGET = 0.9;
/** 被压缩的工具结果保留的 token 数 */
const COMPACTED_RESULT_TOKENS = 1000;

/** 每次请求前执行，不改持久历史；把 schema、消息包装、输出预留一起计入。 */
export function fitContextWindow(input: LLMMessage[], tools: ToolSchema[], total = 60000, taskContent?: string | null, protectedContents: readonly string[] = [], state?: WindowState): LLMMessage[] {
  const available = contextAvailable(total);
  const schemaCost = toolSchemaCost(tools);
  const imageCost = (messages: LLMMessage[]) => messages.reduce((sum, message) => sum + (message.images?.length ?? 0) * IMAGE_CONTEXT_RESERVE, 0);
  const cost = (messages: LLMMessage[]) => schemaCost + estimateTokens(JSON.stringify(messages)) + imageCost(messages);
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
  const notice: LLMMessage = { role: 'assistant', content: NOTICE };
  // 渐进压缩：从最早的组开始压工具大正文与长参数，压到目标就停，不碰用户的任务或系统规则。
  // 最近几次读到的原文往往正是下一步要改的代码，一刀切全压会让模型反复重读、甚至按残缺内容改。
  // 组成本按组分别估（各组之和略高于整体，偏保守），最后再用整体成本核一遍。
  const groupCost = (group: LLMMessage[]) => estimateTokens(JSON.stringify(group)) + imageCost(group);
  const costs = groups.map(groupCost);
  let estimate = schemaCost + groupCost([notice]) + costs.reduce((sum, value) => sum + value, 0);
  const compactAt = (index: number) => {
    if (!compactGroup(groups[index]!)) return;
    const next = groupCost(groups[index]!);
    estimate -= costs[index]! - next;
    costs[index] = next;
  };
  const kept = Math.min(state?.compacted ?? 0, groups.length);
  for (let index = 0; index < kept; index++) compactAt(index);
  let reached = kept;
  if (estimate > available) {
    const target = Math.floor(available * COMPACT_TARGET);
    while (reached < groups.length && estimate > target) compactAt(reached++);
  }
  if (state) state.compacted = reached;
  // 全部压过仍放不下：从最早的非固定组开始整组移出（调用与结果成对移出）
  while (estimate > available) {
    const index = groups.findIndex(group => !pinned(group));
    if (index < 0) break;
    estimate -= costs[index]!;
    groups.splice(index, 1);
    costs.splice(index, 1);
  }
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

/** 压短一组里的工具大正文与写入类长参数（就地改组内副本）；有改动返回 true */
function compactGroup(group: LLMMessage[]): boolean {
  let changed = false;
  for (const message of group) {
    if (message.role === 'tool' && message.content) {
      const shorter = truncateToTokens(message.content, COMPACTED_RESULT_TOKENS);
      if (shorter !== message.content) { message.content = shorter; changed = true; }
    }
    if (message.toolCalls?.some(call => call.arguments.length > 2000)) {
      message.toolCalls = message.toolCalls.map(call => {
        if (call.arguments.length <= 2000) return call;
        let path: string | undefined;
        try { path = JSON.parse(call.arguments).path; } catch { /* 旧的坏参数不能影响恢复 */ }
        return { ...call, arguments: JSON.stringify({ ...(typeof path === 'string' ? { path } : {}), _history_note: '历史调用的长参数已移出上下文；执行结果见对应 tool 消息，必要时重新读取文件' }) };
      });
      changed = true;
    }
  }
  return changed;
}
