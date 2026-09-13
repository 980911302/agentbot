import type { LLMMessage } from '../llm/provider.js';
import type { ToolSchema } from '../agent/types.js';
import { estimateTokens, truncateToTokens } from './budget.js';
import { IMAGE_CONTEXT_RESERVE } from '../shared/contracts/input-image.js';

export const RESPONSE_RESERVE = 8192;
const NOTICE = '[较早的工具记录已按上下文预算缩短/移出；原文件和持久消息仍保留。不要把未显示内容当成不存在，需要时定点重读。]';

/** 每次请求前执行，不改持久历史；把 schema、消息包装、输出预留一起计入。 */
export function fitContextWindow(input: LLMMessage[], tools: ToolSchema[], total = 60000, taskContent?: string | null, protectedContents: readonly string[] = []): LLMMessage[] {
  const available = Math.floor(total * 0.85) - RESPONSE_RESERVE;
  const schemaCost = estimateTokens(JSON.stringify(tools)) + 128;
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
