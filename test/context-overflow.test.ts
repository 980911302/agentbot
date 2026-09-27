import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { contextOverflowOf } from '../src/llm/context-overflow.js';
import { AgentLoop } from '../src/agent/agent-loop.js';
import { estimateTokens } from '../src/context/budget.js';
import { defineTool } from '../src/tools/tool.js';
import { FakeProvider } from './fakes/fake-provider.js';

describe('识别「上下文超长」错误', () => {
  it('能从各家报错里读出模型上限', () => {
    const cases: Array<[string, number]> = [
      [
        'LLM request failed with 400 Bad Request: {"error":{"message":"This model\'s maximum context length is 131072 tokens. However, you requested 140000 tokens."}}',
        131_072,
      ],
      [
        'LLM request failed with 400 Bad Request: prompt is too long: 205000 tokens > 200000 maximum',
        200_000,
      ],
      ['LLM returned an error: maximum context length is 32,768 tokens', 32_768],
      ['LLM request failed with 400 Bad Request: input exceeds the context length of 65536', 65_536],
    ];
    for (const [message, limit] of cases)
      assert.deepEqual(contextOverflowOf(new Error(message)), { limit }, message);
  });

  it('只有错误码没有数字时也认得出，但不给上限', () => {
    for (const message of [
      'LLM request failed with 400 Bad Request: {"error":{"code":"context_length_exceeded"}}',
      'LLM request failed with 413 Payload Too Large: request too large',
      'LLM returned an error: 输入内容超出模型上下文长度上限',
    ]) {
      assert.deepEqual(contextOverflowOf(new Error(message)), {}, message);
    }
  });

  it('限流、鉴权、网络错误不算超长', () => {
    for (const message of [
      'LLM request failed with 429 Too Many Requests: Rate limit reached: too many tokens per minute (TPM)',
      'LLM request failed with 401 Unauthorized: invalid api key',
      'fetch failed',
      'LLM 流空闲超过 60 秒，已中断（可直接重试）',
    ]) {
      assert.equal(contextOverflowOf(new Error(message)), null, message);
    }
    assert.equal(contextOverflowOf('not an error'), null);
  });
});

describe('模型报超长时按它的上限压缩后重试', () => {
  const bigRead = () =>
    defineTool({
      name: 'Read',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: () => 'x'.repeat(14_000),
    });

  it('学到上限后压缩重试，回合照常完成，并把上限报给调用方', async () => {
    const learned: number[] = [];
    const sizes: number[] = [];
    let reads = 0;
    const provider = new FakeProvider({
      auto: (messages) => {
        const size = estimateTokens(JSON.stringify(messages));
        sizes.push(size);
        if (size > 20_000)
          throw new Error(
            "LLM request failed with 400 Bad Request: This model's maximum context length is 20000 tokens.",
          );
        return reads++ < 8
          ? FakeProvider.toolCalls([{ id: `r${reads}`, name: 'Read', arguments: '{}' }])
          : FakeProvider.text('完成');
      },
    });
    const loop = new AgentLoop({
      provider,
      messages: { append: async () => undefined } as never,
      onContextLimit: (tokens) => learned.push(tokens),
    });
    const result = await loop.run(
      { id: 'a', tools: [bigRead()], memory: { projectIds: [] } } as never,
      { messages: [{ role: 'user', content: '读文件' }], stats: { budgetTokens: 1_000_000 } } as never,
    );
    assert.equal(result.content, '完成');
    assert.deepEqual(learned, [20_000]);
    const afterRetry = sizes.slice(sizes.findIndex((size) => size > 20_000) + 1);
    assert.ok(
      afterRetry.length > 0 && afterRetry.every((size) => size <= 20_000),
      '重试之后的请求都压在上限内',
    );
  });

  it('不是超长的错误原样抛出，不重试', async () => {
    let calls = 0;
    const provider = new FakeProvider({
      auto: () => {
        calls++;
        throw new Error('LLM request failed with 401 Unauthorized: invalid api key');
      },
    });
    const loop = new AgentLoop({ provider, messages: { append: async () => undefined } as never });
    await assert.rejects(
      () =>
        loop.run(
          { id: 'a', tools: [], memory: { projectIds: [] } } as never,
          { messages: [{ role: 'user', content: 'hi' }] } as never,
        ),
      /401/,
    );
    assert.equal(calls, 1);
  });

  it('压到下限还超长就放弃，报原始错误', async () => {
    let calls = 0;
    const provider = new FakeProvider({
      auto: () => {
        calls++;
        throw new Error('LLM request failed with 400 Bad Request: context_length_exceeded');
      },
    });
    const loop = new AgentLoop({ provider, messages: { append: async () => undefined } as never });
    await assert.rejects(
      () =>
        loop.run(
          { id: 'a', tools: [], memory: { projectIds: [] } } as never,
          {
            messages: [{ role: 'user', content: 'hi' }],
            stats: { budgetTokens: 1_000_000 },
          } as never,
        ),
      /context_length_exceeded/,
    );
    assert.equal(calls, 3, '最多重试两次');
  });
});
