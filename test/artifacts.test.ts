import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Message } from '../src/agent/types.js';
import { collectArtifacts } from '../src/server/presenters.js';
import { artifactFromEvent } from '../web/src/features/chat/artifacts.js';

describe('产物识别', () => {
  it('Read 过的源码不是产物', () => {
    const messages = [
      {
        id: 'call-1',
        agentId: 'a1',
        role: 'assistant',
        content: {
          type: 'tool_calls',
          calls: [{ id: 'read-1', name: 'Read', arguments: '{"path":"/workspace/runtime.ts"}' }],
        },
        createdAt: 1,
      },
    ] as Message[];

    assert.deepEqual(collectArtifacts(messages), []);
  });

  it('只收集 SendToUser 真正交付的文件', () => {
    const message = {
      id: 'answer-1',
      agentId: 'a1',
      role: 'assistant',
      content: { type: 'text', text: '📎 已交付文件：/Users/me/Downloads/report.html' },
      createdAt: 1_000,
    } as Message;

    assert.deepEqual(collectArtifacts([message]), [
      {
        path: '/Users/me/Downloads/report.html',
        tool: '文件',
        createdAt: new Date(1_000).toISOString(),
      },
    ]);

    assert.deepEqual(
      artifactFromEvent({ type: 'message', message }),
      {
        path: '/Users/me/Downloads/report.html',
        tool: '文件',
        createdAt: new Date(1_000).toISOString(),
      },
    );
  });
});
