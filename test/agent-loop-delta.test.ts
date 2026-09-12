import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentLoop } from '../src/agent/agent-loop.js';
import type { Agent } from '../src/agent/types.js';
import type { BuiltContext } from '../src/context/builder.js';
import type { ChatOptions, LLMMessage, LLMResponse } from '../src/llm/provider.js';
import { MessageStore } from '../src/store/messages.js';

/** delta 事件必须先于持久化的 message 事件，前端才能「增量追加 → 收到全文即替换」 */
describe('AgentLoop 流式 delta', () => {
  it('delta 先于 message 到达，且聚合文本一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbot-loop-delta-'));
    const provider = {
      name: 'fake',
      async chat(_messages: LLMMessage[], options: ChatOptions = {}): Promise<LLMResponse> {
        options.onDelta?.('你');
        options.onDelta?.('好');
        return { content: '你好', toolCalls: [], finishReason: 'stop', usage: null };
      },
    };
    const events: string[] = [];
    const loop = new AgentLoop({
      provider,
      messages: new MessageStore(dir),
      onEvent: (event) => events.push(event.type),
      onDelta: (text) => events.push(`delta:${text}`),
    });
    const agent = { id: 'a1', name: '测试', tools: [] } as unknown as Agent;
    const built = { messages: [] } as unknown as BuiltContext;

    await loop.run(agent, built);

    const deltaIndex = events.indexOf('delta:你');
    const messageIndex = events.indexOf('message');
    assert.ok(deltaIndex >= 0, `应有 delta 事件，实际：${events.join(',')}`);
    assert.ok(messageIndex > deltaIndex, 'message 必须在 delta 之后');
    assert.ok(events.includes('final'));
  });
});
