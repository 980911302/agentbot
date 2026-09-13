import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { EventJournal } from '../src/server/events/journal.js';
import { createAgentServer, type AgentServerHandle } from '../src/server/http.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import type { LLMProvider } from '../src/llm/provider.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { sleep, tempDataDir, waitFor } from './fakes/test-env.js';

/**
 * E3.4 第一步：事件日志与独立订阅。
 * 发送与订阅分离——断线只断订阅；客户端凭 seq 补发、去重；游标太旧要求重取快照。
 */

const OUT = (text: string) => ({
  content: null,
  toolCalls: [
    {
      id: `out-${text}`,
      name: 'SendToUser',
      arguments: JSON.stringify({ type: 'text', content: text, end_turn: true }),
    },
  ],
  finishReason: 'tool_calls',
  usage: null,
});
const TEXT = OUT('收到');

describe('EventJournal（E3.4）', () => {
  it('seq 单调递增；since 补发 after 之后的事件', () => {
    const journal = new EventJournal();
    const first = journal.publish({ kind: 'agent', agentId: 'a1', payload: { type: 'delta', text: 'x' } });
    const second = journal.publish({ kind: 'agent', agentId: 'a1', payload: { type: 'delta', text: 'y' } });
    assert.ok(second.seq > first.seq);

    const replay = journal.since(first.seq);
    assert.equal(replay.resync, false);
    assert.deepEqual(replay.entries.map((entry) => entry.seq), [second.seq]);
    assert.equal(replay.latestSeq, second.seq);

    // 同一条事件只补一次：用 latestSeq 再来一次就是空
    assert.deepEqual(journal.since(replay.latestSeq).entries, []);
  });

  it('保留窗口挤出旧事件后要求重新取快照', () => {
    const journal = new EventJournal(3);
    journal.publish({ kind: 'run', agentId: 'a', payload: { phase: 'done' } });
    journal.publish({ kind: 'run', agentId: 'a', payload: { phase: 'done' } });
    journal.publish({ kind: 'run', agentId: 'a', payload: { phase: 'done' } });
    assert.equal(journal.since(0).resync, false);
    journal.publish({ kind: 'run', agentId: 'a', payload: { phase: 'done' } });

    const stale = journal.since(0);
    assert.equal(stale.resync, true, '最早的游标已经被挤出保留窗口');
    assert.deepEqual(stale.entries, []);
  });

  it('游标超过当前 seq（服务端重启过的老游标）也要重新取快照', () => {
    const journal = new EventJournal();
    journal.publish({ kind: 'run', agentId: 'a', payload: { phase: 'done' } });
    assert.equal(journal.since(999).resync, true);
  });

  it('订阅只推新事件，退订后不再推', () => {
    const journal = new EventJournal();
    const seen: number[] = [];
    const off = journal.subscribe((entry) => seen.push(entry.seq));
    journal.publish({ kind: 'agent', agentId: 'a', payload: { type: 'delta' } });
    off();
    journal.publish({ kind: 'agent', agentId: 'a', payload: { type: 'delta' } });
    assert.equal(seen.length, 1);
  });
});

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

interface SseClient {
  frames: SseFrame[];
  close: () => void;
}

/** 读一个 SSE 订阅：收集 ready / entry 帧（测试用，不依赖前端代码） */
async function openSubscription(base: string, after?: number): Promise<SseClient> {
  const suffix = after === undefined ? '' : `?after=${after}`;
  const response = await fetch(`${base}api/events${suffix}`);
  assert.equal(response.status, 200);
  const frames: SseFrame[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          const event = /^event: (.+)$/m.exec(raw)?.[1];
          const data = /^data: (.+)$/m.exec(raw)?.[1];
          if (event && data) frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
        }
      }
    } catch {
      // 客户端主动关闭连接
    }
  })();
  return { frames, close: () => void reader.cancel().catch(() => undefined) };
}

async function until(predicate: () => Promise<boolean>, what: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`超时：${what}`);
    await sleep(20);
  }
}

describe('事件订阅（E3.4 第一步：发送与订阅分离）', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let fake: FakeProvider;
  let server: AgentServerHandle;

  before(async () => {
    // 不依赖真实 Key、不额外调模型
    process.env.AGENT_MEMORY_EXTRACTION = 'off';
    process.env.AGENT_WEB = 'off';
    const env = await tempDataDir('events-http');
    dir = env.dir;
    cleanup = env.cleanup;
    fake = new FakeProvider();
    server = await createAgentServer({
      port: 0,
      dataDir: dir,
      rootDir: process.cwd(),
      createProvider: () => fake,
      allowMissingKey: true,
    });
  });

  after(async () => {
    await server.close();
    await cleanup();
  });

  it('订阅先收 ready；回合事件与完成事件都进日志；断线后凭游标补发', async () => {
    const agentId = (await server.runtime.registry.list())[0]!.id;
    const sub = await openSubscription(server.url, 0);
    await waitFor(() => sub.frames.some((frame) => frame.event === 'ready'), 'ready 帧');
    const ready = sub.frames.find((frame) => frame.event === 'ready')!.data as { latestSeq: number; resync: boolean };
    assert.equal(ready.resync, false);

    // 发一条私聊：202 立刻回执，回合在后台跑，事件走订阅
    const callIndex = fake.calls.length;
    const clientMessageId = 'evt-msg-1';
    const post = await fetch(`${server.url}api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: agentId, message: '你好', clientMessageId }),
    });
    assert.equal(post.status, 202);
    const receipt = (await post.json()) as {
      messageId: string;
      agentId: string;
      receiptSeq: number;
      duplicate: boolean;
    };
    assert.equal(receipt.duplicate, false);
    assert.equal(receipt.agentId, agentId);
    // 先落盘再回执：拿到 messageId 时消息已经在库里
    const persisted = (await server.runtime.messages.list(agentId)).find(
      (message) => message.id === receipt.messageId,
    );
    assert.ok(persisted, '回执里的消息要已经落盘');

    // 重发同一个幂等键：返回原消息，不开新回合
    const again = await fetch(`${server.url}api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: agentId, message: '你好', clientMessageId }),
    });
    const duplicate = (await again.json()) as { messageId: string; duplicate: boolean };
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.messageId, receipt.messageId);

    await waitFor(() => fake.pendingCount > callIndex, '模型调用发生');
    fake.release(callIndex, TEXT);

    const entries = (): Array<Record<string, unknown>> =>
      sub.frames.filter((frame) => frame.event === 'entry').map((frame) => frame.data);
    await waitFor(
      () => entries().some((entry) => (entry.payload as { type?: string })?.type === 'message'),
      '订阅收到 message 事件',
    );
    await waitFor(
      () =>
        entries().some(
          (entry) => entry.kind === 'run' && (entry.payload as { phase?: string })?.phase === 'done',
        ),
      '订阅收到完成事件',
    );
    for (const entry of entries()) {
      assert.equal(entry.agentId, agentId, '事件要带归属，前端才能路由到频道');
      assert.equal(typeof entry.seq, 'number');
    }
    // seq 升序（补发与去重的依据）
    const seqs = entries().map((entry) => entry.seq as number);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));

    // 断线：关掉订阅后发生的回合，重连时凭游标补发
    const cursor = Math.max(...seqs);
    sub.close();
    const callIndex2 = fake.calls.length;
    const post2 = await fetch(`${server.url}api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: agentId, message: '断线期间的这句' }),
    });
    assert.equal(post2.status, 202);
    await waitFor(() => fake.pendingCount > callIndex2, '第二次模型调用');
    fake.release(callIndex2, TEXT);
    await until(
      async () =>
        server.runtime.events
          .since(cursor)
          .entries.some((entry) => entry.kind === 'run' && (entry.payload as { phase?: string }).phase === 'done'),
      '断线期间的回合跑完',
    );

    const resub = await openSubscription(server.url, cursor);
    await waitFor(
      () =>
        resub.frames
          .filter((frame) => frame.event === 'entry')
          .some((frame) => ((frame.data.seq as number) ?? 0) > cursor),
      '重连补发断线期间的事件',
    );
    const replayed = resub.frames
      .filter((frame) => frame.event === 'entry')
      .map((frame) => frame.data);
    assert.ok(
      replayed.some((entry) => entry.kind === 'run' && (entry.payload as { phase?: string }).phase === 'done'),
      '断线期间跑完的回合要能补发出来',
    );
    resub.close();
  });

  it('回合不依赖任何连接：回执发完就断，执行照样跑完并落盘', async () => {
    const agentId = (await server.runtime.registry.list())[0]!.id;
    const callIndex = fake.calls.length;
    const post = await fetch(`${server.url}api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: agentId, message: '说个长的' }),
    });
    assert.equal(post.status, 202);
    await post.json();

    await waitFor(() => fake.pendingCount > callIndex, '模型调用发生');
    fake.release(callIndex, OUT('断线也做完'));

    await until(
      async () =>
        (await server.runtime.messages.list(agentId)).some(
          (message) => message.content.type === 'text' && message.content.text === '断线也做完',
        ),
      '回合在后台跑完并落盘',
    );
    await waitFor(
      () =>
        server.runtime.events
          .since(0)
          .entries.some((entry) => entry.kind === 'run' && (entry.payload as { phase?: string }).phase === 'done'),
      '完成事件仍在日志里',
    );
  });
});

describe('兼容正文兜底（E3.4）', () => {
  it('最终正文可以兜底，但判断出口前不泄露普通正文增量', async () => {
    const env = await tempDataDir('events-delta');
    try {
      const provider: LLMProvider = {
        name: 'delta',
        async chat(_messages, options) {
          options?.onDelta?.('你');
          options?.onDelta?.('好');
          return { content: '你好', toolCalls: [], finishReason: 'stop', usage: null };
        },
      };
      const runtime = new AgentRuntime({
        tools: [],
        createProvider: () => provider,
        dataDir: env.dir,
        defaultModel: 'delta',
        knownModels: ['delta'],
        budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
        memoryExtraction: false,
        seed: [{ name: '测试员', color: '#a855f7', instructions: '测试' }],
      });
      await runtime.ensureDefaultAgent();
      const agentId = (await runtime.registry.list())[0]!.id;
      await runtime.send(agentId, '在吗');

      const deltas = runtime.events
        .since(0)
        .entries.filter((entry) => (entry.payload as { type?: string }).type === 'delta');
      assert.deepEqual(deltas, []);
      const messages = await runtime.messages.list(agentId);
      assert.ok(
        messages.some((message) => message.content.type === 'text' && message.content.text === '你好'),
        '整轮没有调用出口时，最终正文仍要兜底落盘',
      );
    } finally {
      await env.cleanup();
    }
  });
});
