import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  messageIdentity,
  type Correspondence,
  type MessageActor,
} from '../src/shared/contracts/message-identity.js';
import type { Message } from '../src/shared/contracts/sse.js';
import {
  privateConversationMessages,
  toDisplayMessages,
  toCorrespondenceView,
} from '../src/server/presenters.js';
import { applyEvent } from '../web/src/features/chat/message-reducer.js';
import { chatRows, transferLabel, transferPeers } from '../web/src/features/chat/correspondence.js';
import { ChatEngine } from '../web/src/features/chat/chat-engine.js';
import { toLLMMessages } from '../src/llm/convert.js';
import { renderMessages } from '../src/context/history-selector.js';
import { CorrespondenceStore } from '../src/storage/correspondence-store.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { RoomDispatcher } from '../src/server/runtime/room-dispatcher.js';
import { createAgentServer } from '../src/server/http.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir } from './fakes/test-env.js';

const a: MessageActor = { kind: 'agent', id: 'a', name: '幕僚', color: '#8b5cf6' };
const b: MessageActor = { kind: 'agent', id: 'b', name: '测试工程师', color: '#38bdf8' };
const transfer = (id: string, from = a, to = b): Correspondence => ({
  id,
  from,
  to,
  text: `消息${id}`,
  createdAt: Number(id) || 1,
});
const input = (patch: Partial<Message> = {}): Message => ({
  id: 'msg',
  agentId: 'b',
  role: 'user',
  content: { type: 'text', text: '你好' },
  createdAt: 1,
  ...patch,
});
const runtimeAt = (dir: string) =>
  new AgentRuntime({
    dataDir: dir,
    tools: [],
    createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('收到') }),
    defaultModel: 'fake',
    knownModels: ['fake'],
    budget: DEFAULT_BUDGET,
    memoryExtraction: false,
  });

describe('模型角色与真实消息身份分离', () => {
  it('真实用户才显示右侧气泡；旧的同事来信保留来源而非冒充用户', () => {
    assert.equal(messageIdentity(input()).role, 'user');
    const old = messageIdentity(input({ source: 'agent', speaker: '架构师' }));
    assert.equal(old.role, 'assistant');
    assert.equal(old.senderName, '架构师');
    assert.equal(old.originLabel, '消息来自 架构师');
    const unknown = messageIdentity(input({ source: 'agent' }));
    assert.equal(unknown.role, 'assistant');
    assert.match(unknown.originLabel!, /来源未记录/);
  });
  it('群里的用户发言也必须标群来源，不伪装成当前私聊输入', () => {
    const identity = messageIdentity(
      input({ source: 'room', roomId: 'r', roomName: '开发组', speaker: '主人' }),
    );
    assert.equal(identity.role, 'assistant');
    assert.match(identity.originLabel!, /开发组.*主人/);
  });
  it('新消息按稳定发送者身份，旧群 assistant 不继承入站 speaker 冒充同事', () => {
    assert.equal(
      messageIdentity(input({ source: 'agent', sender: a, speaker: '错误的旧名字' })).senderName,
      a.name,
    );
    const old = messageIdentity(
      input({ role: 'assistant', source: 'room', speaker: '错误的入站作者', roomName: '群' }),
    );
    assert.equal(old.senderName, undefined);
    assert.equal(old.originLabel, '发言于「群」');
  });
  it('同事/群来信与待发文本相同，也不能替换本地用户占位', () => {
    const pending = {
      id: 'pending-key',
      role: 'user' as const,
      content: '你好',
      toolCalls: [],
      createdAt: new Date(0).toISOString(),
    };
    for (const source of ['agent', 'room'] as const) {
      const next = applyEvent([pending], { type: 'message', message: input({ source, speaker: a.name }) });
      assert.equal(next.length, 2);
      assert.equal(next[0]!.id, 'pending-key');
      assert.equal(next[1]!.role, 'assistant');
    }
  });
  it('历史快照与实时事件使用相同来源映射', () => {
    for (const message of [
      input(),
      input({ source: 'agent', sender: a }),
      input({ source: 'room', sender: b, roomName: '群' }),
    ]) {
      assert.deepEqual(applyEvent([], { type: 'message', message }), toDisplayMessages([message]));
    }
  });
  it('私聊投影排除群经历，同时兼容旧数据缺少一个来源字段', () => {
    const direct = input({ id: 'direct' });
    const byRoomId = input({ id: 'room-id-only', roomId: 'r' });
    const bySource = input({ id: 'room-source-only', source: 'room' });
    assert.deepEqual(
      privateConversationMessages([direct, byRoomId, bySource]).map((message) => message.id),
      ['direct'],
    );
  });
  it('模型历史和摘要保留作者/群来源，而不是只修气泡颜色', () => {
    const messages = [
      input({ source: 'agent', sender: a }),
      input({ id: 'room', source: 'room', roomName: '开发群', sender: b }),
    ];
    const llm = toLLMMessages(messages);
    assert.equal(llm[0]!.role, 'user');
    assert.match(llm[0]!.content!, /消息来自 幕僚/);
    assert.match(llm[1]!.content!, /开发群.*测试工程师/);
    assert.match(renderMessages(messages), /消息来自 幕僚/);
  });
  it('合批输入不重复显示；往来事件可重放且计数基于投递 id', () => {
    const task = input({ source: 'agent', correspondenceIds: ['1', '2'] });
    assert.equal(toDisplayMessages([task]).length, 0);
    assert.equal(applyEvent([], { type: 'message', message: task }).length, 0);
    const event = { type: 'correspondence' as const, transfer: transfer('1') };
    const shown = applyEvent(applyEvent([], event), event);
    assert.equal(shown.length, 1);
    const rows = chatRows([...shown, toCorrespondenceView(transfer('2', b, a)), ...shown]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, 'correspondence');
    if (rows[0]!.kind !== 'correspondence') return;
    assert.equal(rows[0]!.transfers.length, 2);
    assert.equal(transferLabel('a', rows[0]!.transfers), '2 条消息往来');
    assert.deepEqual(
      transferPeers('a', rows[0]!.transfers).map((peer) => peer.id),
      ['b'],
    );
    assert.equal(chatRows([...shown, ...toDisplayMessages([input()]), ...shown]).length, 2);
  });
});

describe('可追溯的智能体往来档案', () => {
  it('同一投递幂等归档，重启与分页只返回双方消息', async () => {
    const tmp = await tempDataDir('correspondence-store');
    try {
      const store = new CorrespondenceStore(tmp.dir);
      await Promise.all([store.record(transfer('1')), store.record(transfer('1'))]);
      for (const id of ['2', '3', '4']) await store.record(transfer(id, b, a));
      await store.record(transfer('5', b, { ...a, id: 'third', name: '第三方' }));
      const reopened = new CorrespondenceStore(tmp.dir);
      const page = await reopened.page('a', 'b', undefined, 2);
      assert.deepEqual(
        page.messages.map((m) => m.id),
        ['3', '4'],
      );
      assert.equal(page.nextBefore, '3');
      assert.deepEqual(
        (await reopened.page('a', 'b', page.nextBefore!, 2)).messages.map((m) => m.id),
        ['1', '2'],
      );
      assert.deepEqual(await reopened.list('outsider', 'b'), []);
      await assert.rejects(reopened.page('a', 'b', 'missing'), /游标/);
    } finally {
      await tmp.cleanup();
    }
  });
  it('SendToAgent 真实投递双向可见，消费后不丢档案，改名不改历史身份', async () => {
    const tmp = await tempDataDir('correspondence-runtime');
    const runtime = runtimeAt(tmp.dir);
    try {
      const sender = await runtime.registry.create({ name: a.name });
      const receiver = await runtime.registry.create({ name: b.name });
      const send = runtime.tools.find((tool) => tool.name === 'SendToAgent')!;
      const context = (id: string) => ({ agentId: id, memory: runtime.memory, projectIds: [] });
      await send.execute({ target_id: receiver.id, message: '请核对测试结果' }, context(sender.id));
      const entries = await runtime.correspondence.list(sender.id);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.from.id, sender.id);
      assert.equal(entries[0]!.to.id, receiver.id);
      await runtime.registry.update(sender.id, { name: '新名字' });
      await runtime.drainInbox(receiver.id);
      await send.execute({ target_id: sender.id, message: '测试已完成' }, context(receiver.id));
      const before = runtime.events.since(0).entries;
      const engine = new ChatEngine();
      for (const entry of before) engine.applyEntry(entry);
      assert.equal(engine.histories[sender.id]!.filter((m) => m.correspondence).length, 2);
      const snapshot = await runtime.chatSnapshot([sender.id, receiver.id]);
      engine.restore(snapshot);
      assert.equal(engine.histories[sender.id]!.filter((m) => m.correspondence).length, 2);
      assert.equal((await runtime.correspondence.list(receiver.id))[0]!.from.name, a.name);
      const raw = await runtime.messages.list(receiver.id);
      assert.ok(raw.some((m) => m.correspondenceIds?.includes(entries[0]!.id)));
      assert.ok(!toDisplayMessages(raw).some((m) => m.role === 'user'));
    } finally {
      await runtime.close();
      await tmp.cleanup();
    }
  });
  it('多个同事逐封处理时保留每封原始信和各自发送者', async () => {
    const tmp = await tempDataDir('correspondence-batch');
    const runtime = runtimeAt(tmp.dir);
    try {
      const receiver = await runtime.registry.create({ name: '收件人' });
      for (const actor of [a, b])
        await runtime.inbox.enqueue({
          toAgentId: receiver.id,
          fromAgentId: actor.id,
          fromName: actor.name,
          fromActor: actor,
          text: `${actor.name}的结果`,
          priority: false,
          depth: 1,
        });
      await runtime.drainInbox(receiver.id);
      await runtime.drainInbox(receiver.id);
      const snapshot = await runtime.displayMessages(receiver.id);
      assert.equal(snapshot.filter((m) => m.correspondence).length, 2);
      assert.deepEqual(
        snapshot.flatMap((m) => (m.correspondence ? [m.correspondence.from.id] : [])),
        ['a', 'b'],
      );
      assert.ok(!snapshot.some((m) => m.role === 'user'));
    } finally {
      await runtime.close();
      await tmp.cleanup();
    }
  });
  it('入队后未归档就中断，启动恢复补档且不重复', async () => {
    const tmp = await tempDataDir('correspondence-recover');
    const runtime = runtimeAt(tmp.dir);
    let reopened: AgentRuntime | undefined;
    try {
      const receiver = await runtime.registry.create({ name: '收件人' });
      const item = await runtime.inbox.enqueue({
        toAgentId: receiver.id,
        fromAgentId: 'a',
        fromName: a.name,
        fromActor: a,
        text: '已受理但未归档',
        priority: false,
        depth: 1,
      });
      await runtime.close();
      reopened = runtimeAt(tmp.dir);
      await reopened.recover();
      assert.equal(
        (await reopened.correspondence.list(receiver.id)).filter((m) => m.id === item.id).length,
        1,
      );
    } finally {
      await reopened?.close();
      await runtime.close();
      await tmp.cleanup();
    }
  });
  it('群代发的真实作者贯穿群时间线、成员经历与排队恢复', async () => {
    const tmp = await tempDataDir('correspondence-room');
    const runtime = runtimeAt(tmp.dir);
    try {
      const sender = await runtime.registry.create({ name: '幕僚' });
      const receiver = await runtime.registry.create({ name: '测试' });
      const room = await runtime.rooms.create({ name: '开发群', memberIds: [sender.id, receiver.id] });
      await runtime.workbench.postToRoom(sender.id, room.id, '请检查代码');
      const posted = (await runtime.rooms.messages(room.id))[0]!;
      assert.equal(posted.senderKind, 'agent');
      assert.equal(posted.senderId, sender.id);
      assert.equal(posted.senderName, sender.name);
      const raw = (await runtime.messages.list(receiver.id)).find((m) => m.role === 'user')!;
      assert.equal(raw.sender?.id, sender.id);
      assert.equal(messageIdentity(raw).role, 'assistant');
      assert.ok(!(await runtime.displayMessages(receiver.id)).some((m) => m.content === '请检查代码'));
      assert.ok(
        !(await runtime.chatSnapshot([receiver.id])).channels[receiver.id]!.messages.some(
          (m) => m.content === '请检查代码',
        ),
      );
      const tasks: Message[] = [];
      const locks = new Set([receiver.id]);
      const dispatcher = new RoomDispatcher({
        registry: runtime.registry,
        rooms: runtime.rooms,
        messages: runtime.messages,
        inbox: runtime.inbox,
        locks,
        membersOf: async () => ({ room, members: [sender, receiver] }),
        ownerNameFallback: () => '主人',
        stopWords: [],
        runTurn: async (_id, task) => {
          tasks.push(task);
          return { content: '' };
        },
      });
      await dispatcher.postToRoom(room.id, '请接收延迟消息', {
        roomSenderId: sender.id,
        excludeAgentIds: [sender.id],
      });
      const item = (await runtime.inbox.peek(receiver.id))[0]!;
      assert.equal(item.fromActor?.id, sender.id);
      locks.clear();
      await dispatcher.deliverQueued(item);
      assert.equal(tasks[0]!.sender?.id, sender.id);
      assert.equal(tasks[0]!.sender?.kind, 'agent');
    } finally {
      await runtime.close();
      await tmp.cleanup();
    }
  });
  it('往来详情 API 只读、限制分页，不暴露第三方私聊', async () => {
    const tmp = await tempDataDir('correspondence-http');
    const server = await createAgentServer({
      port: 0,
      rootDir: tmp.dir,
      dataDir: tmp.dir,
      allowMissingKey: true,
      createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('[]') }),
    });
    try {
      const actor = await server.runtime.registry.create({ name: '查看方' });
      await server.runtime.correspondence.record(transfer('1', { ...a, id: actor.id }, b));
      await server.runtime.correspondence.record(transfer('2', b, { ...a, id: 'third' }));
      const url = `${server.url}api/agents/${actor.id}/correspondence/b`;
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.deepEqual(
        (await response.json()).messages.map((m: Correspondence) => m.id),
        ['1'],
      );
      assert.equal((await fetch(`${url}?limit=500`)).status, 400);
      assert.equal((await fetch(url, { method: 'POST' })).status, 404);
    } finally {
      await server.close();
      await tmp.cleanup();
    }
  });
});
