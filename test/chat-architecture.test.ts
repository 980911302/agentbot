import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AgentRuntime } from '../src/server/runtime.js';
import { ChatRunCoordinator } from '../src/server/runtime/chat-run-coordinator.js';
import { EventJournal } from '../src/server/events/journal.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, waitFor } from './fakes/test-env.js';
import { ChatEngine, type Snapshot } from '../web/src/features/chat/chat-engine.ts';
import { EventClient } from '../web/src/features/events/event-client.ts';
import type { ChatRun, JournalEntry } from '../src/shared/contracts/chat-state.js';
import type { DisplayMessage } from '../web/src/types.ts';
import { readSseFrames } from '../web/src/shared/transport.ts';

const run = (id: string, status: ChatRun['status'] = 'running'): ChatRun => ({
  runId: id, taskId: id, channelId: 'a', agentId: 'a', kind: 'agent', source: 'user',
  input: `任务${id}`, clientMessageId: `key-${id}`, status, createdAt: 1, updatedAt: 2,
});
const entry = (seq: number, payload: unknown, kind: JournalEntry['kind'] = 'run'): JournalEntry => ({ epoch: 'e', seq, at: seq, agentId: 'a', kind, payload });
const message = (id: string, content = id): DisplayMessage => ({ id, role: 'assistant', content, toolCalls: [], createdAt: new Date(1).toISOString() });
const snapshot = (seq: number, messages: DisplayMessage[] = [], runs: ChatRun[] = []): Snapshot => ({ cursor: { epoch: 'e', seq }, channels: { a: { messages, artifacts: [] } }, runs });

describe('聊天恢复协议', () => {
  it('ready 的最新序号不跳过尚未消费的补发事件，重复事件只消费一次', async () => {
    const seen: number[] = [];
    const client = new EventClient({ restore: async () => ({ epoch: 'e', seq: 101 }), apply: e => seen.push(e.seq),
      transport: { read: async (handlers, opts) => {
        assert.equal(opts.after, 101);
        handlers.onReady({ epoch: 'e', latestSeq: 105, resync: false });
        for (const seq of [102, 103, 103, 104, 105]) handlers.onEntry(entry(seq, {}));
      } } });
    await client.connect(new AbortController().signal);
    assert.deepEqual(seen, [102, 103, 104, 105]);
    assert.equal(client.cursor?.seq, 105);
  });

  it('服务重启 epoch 变化时丢弃旧游标，用新快照接收低序号事件', async () => {
    let boot = 0;
    const seen: number[] = [];
    const client = new EventClient({ restore: async () => boot++ === 0 ? { epoch: 'old', seq: 106 } : { epoch: 'e', seq: 3 }, apply: e => seen.push(e.seq),
      transport: { read: async h => { h.onReady({ epoch: 'e', latestSeq: 3, resync: true && boot === 1 }); h.onEntry(entry(4, {})); } } });
    await assert.rejects(client.connect(new AbortController().signal), /快照/);
    await client.connect(new AbortController().signal);
    assert.deepEqual(seen, [4]); assert.equal(client.cursor?.seq, 4);
  });

  it('缺口不推进游标；恢复失败不偷偷跳过事件', async () => {
    let attempts = 0, reads = 0;
    const client = new EventClient({ restore: async () => {
      if (attempts++) throw new Error('snapshot failed');
      return { epoch: 'e', seq: 1 };
    }, apply: () => assert.fail('缺口事件不能交付'), transport: { read: async h => { reads++; h.onEntry(entry(3, {})); } } });
    await assert.rejects(client.connect(new AbortController().signal), /缺口/);
    assert.equal(client.cursor, null);
    await assert.rejects(client.connect(new AbortController().signal), /snapshot failed/);
    assert.equal(reads, 1); assert.equal(client.cursor, null);
  });

  it('快照读取跨过一次发布则重读，返回的水位覆盖其内容', async () => {
    const journal = new EventJournal(); let reads = 0;
    const result = await journal.snapshot(async () => {
      if (reads++ === 0) journal.publish({ kind: 'run', payload: {} });
      return { value: reads };
    });
    assert.equal(reads, 2); assert.equal(result.cursor.seq, 1); assert.equal(result.value, 2);
  });

  it('协议处理异常会取消旧 SSE 流，避免重连泄漏', async () => {
    let cancelled = false;
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n')); }, cancel() { cancelled = true; } });
    await assert.rejects(readSseFrames(new Response(body), () => { throw new Error('resync'); }), /resync/);
    assert.equal(cancelled, true);
  });
});

describe('无框架 ChatEngine 时序', () => {
  it('刷新恢复待回答交互，晚到快照不能复活已关闭的卡', () => {
    const engine = new ChatEngine();
    const card = { id: 'ask', kind: 'choice' as const, question: '请选择', agentId: 'a', agentName: '测试', createdAt: 1, expiresAt: 10000 };
    engine.restore({ ...snapshot(1), interactions: [card] });
    assert.equal(engine.interactions.length, 1);
    engine.applyEntry(entry(3, { type: 'interaction_closed', id: 'ask', answered: true }, 'agent'));
    engine.restore({ ...snapshot(2), interactions: [card] });
    assert.equal(engine.interactions.length, 0);
  });
  it('旧运行收尾不清除新运行，错误重试保存自己的原话', () => {
    const engine = new ChatEngine();
    engine.applyEntry(entry(1, { run: run('A') }));
    engine.applyEntry(entry(2, { run: run('B') }));
    engine.applyEntry(entry(3, { run: run('A', 'parked') }));
    assert.equal(engine.busy, true); assert.deepEqual(engine.respondingChannelIds, ['a']);
    engine.applyEntry(entry(4, { run: { ...run('B', 'failed'), error: 'error B' } }));
    assert.equal(engine.busy, false);
    assert.equal(engine.histories.a?.find(m => m.error)?.retryText, '任务B');
  });

  it('终态先到、回执晚到不能复活已完成的运行；finalizing 不补处理气泡', () => {
    const engine = new ChatEngine();
    engine.applyEntry(entry(3, { run: run('A', 'finalizing') }));
    assert.equal(engine.busy, true); assert.deepEqual(engine.respondingChannelIds, []);
    engine.applyEntry(entry(4, { run: run('A', 'succeeded') }));
    engine.acceptReceipt({ receiptSeq: 2, duplicate: false, run: run('A', 'queued') });
    assert.equal(engine.busy, false);
  });

  it('迟到历史不覆盖新回复/工具结果，新权威快照能反映清空历史', () => {
    const engine = new ChatEngine(); engine.restore(snapshot(1, [message('old')]));
    engine.applyEntry(entry(4, { type: 'message', message: { id: 'new', agentId: 'a', role: 'assistant', content: { type: 'text', text: '新回复' }, createdAt: 4 } }, 'agent'));
    engine.restore(snapshot(2, [message('old')]));
    assert.ok(engine.histories.a?.some(m => m.id === 'new'));
    engine.restore(snapshot(5, []));
    assert.deepEqual(engine.histories.a, []);
  });

  it('另一个页面发送的用户消息会进入时间线，重放不会重复', () => {
    const engine = new ChatEngine();
    const e = { type: 'message', message: { id: 'remote', agentId: 'a', role: 'user', content: { type: 'text', text: '别处发的' }, createdAt: 4 } };
    engine.applyEntry(entry(1, e, 'agent')); engine.applyEntry(entry(2, e, 'agent'));
    assert.equal(engine.histories.a?.length, 1); assert.equal(engine.histories.a?.[0]?.role, 'user');
  });

  it('未知受理结果的重试保留原幂等键，确认受理后清掉网络错误', () => {
    const engine = new ChatEngine(); engine.beginSend('a', 'key-A', '任务A', '我');
    engine.sendFailed('key-A', 'network');
    assert.equal(engine.histories.a?.find(m => m.error)?.retryClientMessageId, 'key-A');
    assert.equal(engine.busy, false);
    engine.acceptReceipt({ duplicate: true, receiptSeq: 2, run: { ...run('A'), messageId: 'user-A' } });
    assert.equal(engine.histories.a?.filter(m => m.error).length, 0);
    assert.equal(engine.histories.a?.filter(m => m.role === 'user').length, 1);
  });

  it('只有对应运行的未确认工具卡被收口', () => {
    const engine = new ChatEngine();
    const tool = (id: string) => ({ ...message(id), runId: id, toolCalls: [{ id: `${id}-call`, name: 'Read', arguments: '{}', status: 'running' as const }] });
    engine.restore(snapshot(1, [tool('A'), tool('B')], [run('A'), run('B')]));
    engine.applyEntry(entry(2, { run: run('A', 'cancelled') }));
    assert.equal(engine.histories.a?.find(m => m.id === 'A')?.toolCalls[0]?.status, 'error');
    assert.equal(engine.histories.a?.find(m => m.id === 'B')?.toolCalls[0]?.status, 'running');
  });
});

function runtimeAt(dir: string, provider: FakeProvider) {
  return new AgentRuntime({ dataDir: dir, tools: [], createProvider: () => provider, defaultModel: 'fake', knownModels: ['fake'], budget: DEFAULT_BUDGET, memoryExtraction: false });
}

describe('真实 Runtime 统一运行入口（假模型）', () => {
  it('群内显式私发按持久消息目的地路由，不误投群频道', async () => {
    const tmp = await tempDataDir('chat-private-route');
    try {
      const journal = new EventJournal(); const coordinator = new ChatRunCoordinator(tmp.dir, journal);
      const { run: r } = coordinator.prepare({ channelId: 'room', roomId: 'room', agentId: 'a', kind: 'agent', source: 'room', input: '任务' });
      coordinator.bind(r).onEvent?.({ type: 'message', message: { id: 'private', agentId: 'a', role: 'assistant', content: { type: 'text', text: '私发' }, createdAt: 1 } });
      const event = journal.since(0).entries.find(e => e.kind === 'agent')!;
      assert.equal(event.agentId, 'a'); assert.equal(event.roomId, undefined); assert.equal(event.runId, r.runId);
    } finally { await tmp.cleanup(); }
  });
  it('聊天快照带上智能体暂停控制，停止后 autoActivation=paused', async () => {
    const tmp = await tempDataDir('chat-control-snapshot');
    try {
      const runtime = runtimeAt(tmp.dir, new FakeProvider({ auto: () => FakeProvider.text('好') }));
      const agent = await runtime.registry.create({ name: '控制快照', instructions: '测试' });
      await runtime.send(agent.id, '停');
      const snap = await runtime.chatSnapshot([agent.id]);
      assert.equal(snap.agentControls?.[agent.id]?.autoActivation, 'paused');
      assert.ok((snap.agentControls?.[agent.id]?.generation ?? 0) >= 1);
    } finally { await tmp.cleanup(); }
  });
  it('并发重复发送 + 并发 execute 只产生一条用户消息和一次模型调用', async () => {
    const tmp = await tempDataDir('chat-command');
    try {
      const provider = new FakeProvider({ auto: () => FakeProvider.text('收到') }); const runtime = runtimeAt(tmp.dir, provider);
      const agent = await runtime.registry.create({ name: '测试', instructions: '测试' });
      const accepted = await Promise.all(Array.from({ length: 8 }, () => runtime.acceptMessage(agent.id, '你好', { clientMessageId: 'same' })));
      assert.equal(new Set(accepted.map(a => a.receipt.runId)).size, 1);
      assert.equal(accepted.filter(a => !a.receipt.duplicate).length, 1);
      await Promise.all(accepted.map(a => a.execute()));
      assert.equal(provider.calls.length, 1);
      assert.equal((await runtime.messages.list(agent.id)).filter(m => m.role === 'user').length, 1);
      const id = accepted[0]!.receipt.runId!;
      assert.equal(runtime.chatRuns.get(id)?.status, 'succeeded');
      assert.equal(runtime.events.since(0).entries.filter(e => e.runId === id && (e.payload as any).phase === 'done').length, 1);
      await assert.rejects(runtime.acceptMessage(agent.id, '不同内容', { clientMessageId: 'same' }), /不同请求/);
    } finally { await tmp.cleanup(); }
  });

  it('自动续跑走相同事件出口，三次执行独立身份并关联原任务', async () => {
    const tmp = await tempDataDir('chat-resume');
    try {
      const provider = new FakeProvider(); const runtime = runtimeAt(tmp.dir, provider);
      const agent = await runtime.registry.create({ name: '测试', instructions: '测试' });
      const a = await runtime.acceptMessage(agent.id, '任务A'); const first = a.execute();
      await waitFor(() => provider.calls.length === 1, 'A 开始');
      const b = await runtime.acceptMessage(agent.id, '任务B'); const second = b.execute();
      await waitFor(() => provider.calls.length === 2, 'B 开始');
      provider.releaseText(1, 'B完成'); await second; await first;
      await waitFor(() => provider.calls.length === 3, 'A 自动续跑');
      provider.releaseText(2, 'A续跑完成');
      await waitFor(() => runtime.chatRuns.list().filter(r => r.status === 'succeeded').length === 2, '续跑终态');
      const resumed = runtime.chatRuns.list().find(r => r.source === 'resume')!;
      assert.ok(resumed); assert.equal(resumed.parentRunId, a.receipt.runId); assert.equal(resumed.taskId, a.receipt.taskId);
      const events = runtime.events.since(0).entries;
      assert.ok(events.some(e => e.runId === resumed.runId && (e.payload as any).message?.content?.text === 'A续跑完成'));
      assert.equal(events.filter(e => e.kind === 'run' && (e.payload as any).phase === 'done').length, 3);
      assert.ok(events.every(e => e.runId));
    } finally { await tmp.cleanup(); }
  });

  it('群入站先落盘入队，成员独立运行，相同命令不会重复广播', async () => {
    const tmp = await tempDataDir('chat-room');
    try {
      const provider = new FakeProvider({ auto: () => FakeProvider.text('') }); const runtime = runtimeAt(tmp.dir, provider);
      const agent = await runtime.registry.create({ name: '测试', instructions: '测试' });
      const room = await runtime.rooms.create({ name: '群', memberIds: [agent.id] });
      const [a, b] = await Promise.all([runtime.acceptRoomMessage(room.id, '你好', { clientMessageId: 'room-key' }), runtime.acceptRoomMessage(room.id, '你好', { clientMessageId: 'room-key' })]);
      assert.equal(provider.calls.length, 0);
      assert.equal((await runtime.inbox.peek(agent.id)).length, 1);
      await Promise.all([a.execute(), b.execute()]);
      await runtime.drainInbox(agent.id);
      assert.equal(provider.calls.length, 1);
      assert.equal((await runtime.rooms.messages(room.id)).filter(m => m.senderKind === 'user').length, 1);
      const child = runtime.chatRuns.list().find(r => r.kind === 'agent')!;
      assert.notEqual(child.parentRunId, a.receipt.runId); assert.notEqual(child.taskId, a.receipt.taskId);
      assert.ok(runtime.events.since(0).entries.every(e => e.runId));
      await runtime.close();
    } finally { await tmp.cleanup(); }
  });

  it('私聊空回复明确失败，不能当作已完成；群聊空回复仍允许沉默', async () => {
    const tmp = await tempDataDir('chat-empty');
    try {
      const runtime = runtimeAt(tmp.dir, new FakeProvider({ auto: () => FakeProvider.text('') }));
      const agent = await runtime.registry.create({ name: '测试', instructions: '测试' });
      const accepted = await runtime.acceptMessage(agent.id, '你好');
      await assert.rejects(accepted.execute(), /空回复/);
      assert.equal(runtime.chatRuns.get(accepted.receipt.runId!)?.status, 'failed');
      const state = await runtime.chatSnapshot([agent.id]);
      assert.equal(state.runs[0]?.status, 'failed'); assert.equal(state.channels[agent.id]?.messages.length, 1);
    } finally { await tmp.cleanup(); }
  });

  it('进程重建把未完成运行标记 interrupted，不自动重复工具；幂等键仍有效', async () => {
    const tmp = await tempDataDir('chat-restart');
    try {
      const first = new ChatRunCoordinator(tmp.dir, new EventJournal());
      const accepted = first.prepare({ channelId: 'a', agentId: 'a', kind: 'agent', source: 'user', input: '任务', clientMessageId: 'key' });
      const second = new ChatRunCoordinator(tmp.dir, new EventJournal());
      assert.equal(second.get(accepted.run.runId)?.status, 'interrupted');
      const duplicate = second.prepare({ channelId: 'a', agentId: 'a', kind: 'agent', source: 'user', input: '任务', clientMessageId: 'key' });
      assert.equal(duplicate.duplicate, true); assert.equal(duplicate.run.runId, accepted.run.runId);
    } finally { await tmp.cleanup(); }
  });

  it('事件观察者抛错不改变执行结果', async () => {
    const tmp = await tempDataDir('chat-observer');
    try {
      const journal = new EventJournal(); journal.subscribe(() => { throw new Error('socket closed'); });
      const coordinator = new ChatRunCoordinator(tmp.dir, journal);
      const { run: r } = coordinator.prepare({ channelId: 'a', kind: 'agent', source: 'user', input: '任务' });
      const options = coordinator.bind(r, { onEvent: () => { throw new Error('UI error'); } });
      await coordinator.execute(r.runId, async () => { options.onEvent?.({ type: 'final', content: '完成' }); return {}; }, () => ({}));
      assert.equal(coordinator.get(r.runId)?.status, 'succeeded');
    } finally { await tmp.cleanup(); }
  });
});
