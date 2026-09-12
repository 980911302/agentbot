import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { OpenAIProvider } from '../src/llm/openai-provider.js';
import type { AddressInfo } from 'node:net';

/** 流式解析：分块 SSE 的增量文本、tool_calls 分片、usage 尾块都要拼对 */
describe('OpenAIProvider 流式（onDelta）', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl = '';

  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"web_search","arguments":"{\\"q\\""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"测试\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n',
    'data: [DONE]\n\n',
  ];

  before(async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of chunks) response.write(chunk);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => server.close());

  it('增量回调顺序正确，最终响应聚合完整', async () => {
    const provider = new OpenAIProvider({ apiKey: 'k', model: 'm', baseURL: baseUrl });
    const deltas: string[] = [];
    const result = await provider.chat([{ role: 'user', content: 'hi' }], {
      onDelta: (text) => deltas.push(text),
    });

    assert.deepEqual(deltas, ['Hel', 'lo']);
    assert.equal(result.content, 'Hello');
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]?.id, 'c1');
    assert.equal(result.toolCalls[0]?.name, 'web_search');
    assert.equal(result.toolCalls[0]?.arguments, '{"q":"测试"}');
    assert.equal(result.usage?.totalTokens, 18);
  });
});
