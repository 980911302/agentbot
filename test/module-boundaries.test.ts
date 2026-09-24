import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MessageStore } from '../src/store/messages.js';
import { RoomStore } from '../src/room/store.js';
import { JsonlLog } from '../src/storage/jsonl-log.js';
import { AgentInbox, DeliveryLeaseLostError, leaseOf } from '../src/agent/inbox.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { defineTool } from '../src/tools/tool.js';
import { WorkerManager } from '../src/tools/services/worker-manager.js';
import { createSendToUserTool } from '../src/tools/builtin/send-to-user.js';
import { InteractionBroker } from '../src/interaction/broker.js';
import { SecretStore } from '../src/secret/store.js';
import { ArtifactService } from '../src/tools/services/artifact-service.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, until, waitFor, sleep } from './fakes/test-env.js';
import type { LLMProvider } from '../src/llm/provider.js';
import type { AgentRuntimeOptions } from '../src/server/runtime/types.js';

function runtimeAt(dir: string, provider: LLMProvider, options: Partial<AgentRuntimeOptions> = {}) {
  return new AgentRuntime({ dataDir: dir, tools: [], createProvider: () => provider, defaultModel: 'fake', knownModels: ['fake'],
    budget: DEFAULT_BUDGET, memoryExtraction: false, ...options });
}
const letter = (toAgentId: string) => ({ toAgentId, fromAgentId: 'sender', fromName: '同事', text: '检查项目', priority: false, depth: 1 });

describe('共用 JSONL 日志恢复', () => {
  for (const room of [false, true]) {
    it(`${room ? '群' : '私聊'}撕裂尾部先备份，后续追加再重启仍能读取`, async () => {
      const tmp = await tempDataDir('boundary-jsonl');
      try {
        const dir = join(tmp.dir, room ? 'rooms' : 'messages'); await mkdir(dir);
        const tail = Buffer.from('{"id":"半截'); await writeFile(join(dir, 'a.jsonl'), tail);
        const store = room ? new RoomStore(tmp.dir) : new MessageStore(tmp.dir);
        const list = (s: typeof store) => room ? (s as RoomStore).messages('a') : (s as MessageStore).list('a');
        assert.equal((await list(store)).length, 0);
        for (const id of ['1', '2']) await store.append(room ? { id, roomId: 'a', text: '正常' } as never
          : { id, agentId: 'a', role: 'user', content: { type: 'text', text: '正常' }, createdAt: 1 } as never);
        const reopened = room ? new RoomStore(tmp.dir) : new MessageStore(tmp.dir);
        assert.deepEqual((await list(reopened)).map(m => m.id), ['1', '2']);
        const backup = (await readdir(dir)).find(name => name.includes('.corrupt-'))!;
        assert.ok(backup); assert.deepEqual(await readFile(join(dir, backup)), tail);
      } finally { await tmp.cleanup(); }
    });
  }
  it('完整末行缺换行不粘连；空白行不产生假消息', async () => {
    const tmp = await tempDataDir('boundary-newline');
    try {
      await writeFile(join(tmp.dir, 'a.jsonl'), '\n{"id":1}');
      const log = new JsonlLog<{ id: number }>(tmp.dir);
      await log.append('a', { id: 2 });
      assert.deepEqual(await new JsonlLog(tmp.dir).list('a'), [{ id: 1 }, { id: 2 }]);
    } finally { await tmp.cleanup(); }
  });
  it('中间损坏拒绝追加，不把原文覆盖掉', async () => {
    const tmp = await tempDataDir('boundary-mid-corrupt');
    try {
      const raw = '{"id":1}\n坏记录\n{"id":2}\n'; await writeFile(join(tmp.dir, 'a.jsonl'), raw);
      await assert.rejects(new JsonlLog(tmp.dir).append('a', { id: 3 }));
      assert.equal(await readFile(join(tmp.dir, 'a.jsonl'), 'utf8'), raw);
    } finally { await tmp.cleanup(); }
  });
  it('首次修复与并发追加共用锁，只隔离一次损坏尾部', async () => {
    const tmp = await tempDataDir('boundary-concurrent-log');
    try {
      await writeFile(join(tmp.dir, 'a.jsonl'), '{"id":');
      const log = new JsonlLog(tmp.dir);
      await Promise.all(Array.from({ length: 20 }, (_, id) => log.append('a', { id })));
      assert.equal((await new JsonlLog(tmp.dir).list('a')).length, 20);
      assert.equal((await readdir(tmp.dir)).filter(name => name.includes('.corrupt-')).length, 1);
      await Promise.all([log.clear('a'), log.append('a', { id: 100 })]);
      assert.deepEqual(await new JsonlLog(tmp.dir).list('a'), [{ id: 100 }]);
    } finally { await tmp.cleanup(); }
  });
});

describe('后台工人权限继承', () => {
  it('工人继承本轮选中的模型与项目范围，不偷换为默认模型', async () => {
    const tmp = await tempDataDir('boundary-worker-model'); const models: string[] = []; const projects: string[][] = [];
    const read = defineTool({ name: 'Read', description: '读取审查信息', parameters: { type: 'object', properties: {} },
      execute: (_args, context) => { projects.push(context.projectIds); return 'ok'; } });
    const factory = (model: string): LLMProvider => ({ name: model, async chat(messages, options) {
      models.push(model); const names = options?.tools?.map(tool => tool.name) ?? [];
      if (!messages.some(message => message.role === 'tool')) {
        if (names.includes('Task')) return FakeProvider.toolCalls([{ id: 't', name: 'Task', arguments: JSON.stringify({ description: '检查', prompt: '读取审查信息', subagent_type: 'executor' }) }]);
        if (names.includes('Read')) return FakeProvider.toolCalls([{ id: 'r', name: 'Read', arguments: '{}' }]);
      }
      return FakeProvider.text('完成');
    } });
    const runtime = runtimeAt(tmp.dir, factory('default'), { defaultModel: 'default', knownModels: ['default', 'selected'], createProvider: factory, tools: [read] });
    try {
      const agent = await runtime.registry.create({ name: '测试', toolNames: ['Task', 'Read'], projectIds: ['project-a'] });
      await runtime.send(agent.id, '检查', { model: 'selected' });
      assert.ok(models.length >= 4); assert.ok(models.every(model => model === 'selected')); assert.deepEqual(projects, [['project-a']]);
    } finally { await runtime.close(); await tmp.cleanup(); }
  });
  it('只有 Task 的父智能体不能借工人调用全局工具', async () => {
    const tmp = await tempDataDir('boundary-worker-authority'); let executed = 0;
    const sentinel = defineTool({ name: 'AuditForbidden', description: '无副作用哨兵', parameters: { type: 'object', properties: {} }, execute: () => { executed++; return 'ok'; } });
    const schemas: string[][] = [];
    const provider: LLMProvider = { name: 'fake', async chat(messages, options) {
      const names = options?.tools?.map(t => t.name) ?? []; schemas.push(names);
      if (names.includes('Task') && !messages.some(m => m.role === 'tool')) return FakeProvider.toolCalls([{ id: 'task', name: 'Task', arguments: JSON.stringify({ description: '检查权限', prompt: '检查权限', subagent_type: 'executor' }) }]);
      if (names.includes('AuditForbidden')) return FakeProvider.toolCalls([{ id: 'bad', name: 'AuditForbidden', arguments: '{}' }]);
      return FakeProvider.text('结束');
    } };
    const runtime = runtimeAt(tmp.dir, provider, { tools: [sentinel] });
    try {
      const agent = await runtime.registry.create({ name: '受限', toolNames: ['Task'] });
      await runtime.send(agent.id, '执行检查');
      assert.equal(executed, 0); assert.ok(schemas.length >= 3);
      assert.ok(schemas.every(names => !names.includes('AuditForbidden')));
    } finally { await runtime.close(); await tmp.cleanup(); }
  });
  it('续跑不能获得新工具，撤销的父权限立即在下次 drive 生效', async () => {
    const tmp = await tempDataDir('boundary-worker-resume'); const schemas: string[][] = [];
    const tool = (name: string) => defineTool({ name, description: name, parameters: { type: 'object', properties: {} }, execute: () => 'ok' });
    let current = [tool('Read'), tool('Write')];
    const manager = new WorkerManager({ dataDir: tmp.dir, messages: new MessageStore(tmp.dir), workerTools: () => current,
      provider: { name: 'fake', async chat(_messages, options) { schemas.push(options?.tools?.map(t => t.name) ?? []); return FakeProvider.text('完成'); } } });
    try {
      const authority = { toolNames: ['Read'], projectIds: [] };
      const worker = manager.spawn('检查', '只读检查', 'a', authority);
      authority.toolNames.push('Write'); // 外部对象修改不能改变已保存授权。
      await manager.drive(worker); assert.deepEqual(schemas[0], ['Read']);
      current = [tool('Write')]; manager.pushMessage(worker.id, '继续'); await manager.drive(worker);
      assert.deepEqual(schemas[1], []);
      const reopened = new WorkerManager({ dataDir: tmp.dir, messages: new MessageStore(tmp.dir), workerTools: () => current, provider: new FakeProvider() });
      assert.deepEqual(reopened.get(worker.id)?.authority?.toolNames, ['Read']);
    } finally { await tmp.cleanup(); }
  });
  it('没有授权快照的旧工人默认不授予工具', async () => {
    const tmp = await tempDataDir('boundary-worker-legacy');
    try {
      let seen = -1;
      const manager = new WorkerManager({ messages: new MessageStore(tmp.dir), workerTools: () => [{ name: 'Read' } as never],
        provider: { name: 'fake', async chat(_m, opts) { seen = opts?.tools?.length ?? 0; return FakeProvider.text('结束'); } } });
      await manager.drive(manager.spawn('旧工人', '检查')); assert.equal(seen, 0);
    } finally { await tmp.cleanup(); }
  });
});

describe('续跑目的地和记忆后处理', () => {
  it('压缩期间被抢占同样挂起，迟到摘要不能覆盖新摘要', async () => {
    const tmp = await tempDataDir('boundary-compact-cancel'); const fake = new FakeProvider({ rejectOnAbort: false });
    const runtime = runtimeAt(tmp.dir, fake, { budget: { ...DEFAULT_BUDGET, compactionTrigger: 2, reserveRecent: 0 } });
    try {
      const agent = await runtime.registry.create({ name: '测试' });
      for (let i = 1; i <= 2; i++) await runtime.messages.append({ id: `old-${i}`, agentId: agent.id, role: 'user', content: { type: 'text', text: '旧历史' }, createdAt: i });
      const first = runtime.send(agent.id, '任务A'); await waitFor(() => fake.calls.length === 1, 'A压缩');
      const second = runtime.send(agent.id, '任务B'); await waitFor(() => fake.calls.length === 2, 'B压缩');
      assert.equal((await first).stopReason, 'parked');
      fake.releaseText(1, '新的有效摘要'); await waitFor(() => fake.calls.length === 3, 'B模型');
      fake.releaseText(2, '任务B完成'); await second;
      await waitFor(() => fake.calls.length === 4, 'A恢复'); fake.releaseText(3, '任务A完成');
      await waitFor(() => runtime.chatRuns.list().some(run => run.source === 'resume' && run.status === 'succeeded'), 'A完成');
      fake.releaseText(0, '迟到的旧摘要'); await sleep(20);
      assert.equal((await runtime.compaction.get(agent.id))?.summary, '新的有效摘要');
    } finally { await runtime.close(); await tmp.cleanup(); }
  });
  it('群任务被私聊打断，续跑仍通过群出口交付', async () => {
    const tmp = await tempDataDir('boundary-group-resume'); const provider = new FakeProvider();
    const send = createSendToUserTool({ rootDir: tmp.dir, broker: new InteractionBroker(), secrets: new SecretStore(tmp.dir),
      agentName: async () => '测试', artifacts: new ArtifactService({ roots: [tmp.dir] }) });
    const runtime = runtimeAt(tmp.dir, provider, { tools: [send] });
    try {
      const agent = await runtime.registry.create({ name: '测试' });
      const room = await runtime.rooms.create({ name: '群', memberIds: [agent.id] });
      const a = await runtime.acceptRoomMessage(room.id, '群任务'); const first = a.execute();
      await waitFor(() => provider.calls.length === 1, '群开始');
      const second = runtime.send(agent.id, '先处理私聊');
      await waitFor(() => provider.calls.length === 2, '私聊开始'); provider.releaseText(1, '私聊完成'); await second; await first;
      await waitFor(() => provider.calls.length === 3, '群自动恢复');
      const resumed = runtime.chatRuns.list().find(run => run.source === 'resume')!;
      assert.equal(resumed.channelId, room.id);
      provider.release(2, FakeProvider.toolCalls([{ id: 'out', name: 'SendToUser', arguments: JSON.stringify({ type: 'text', content: '群任务完成', to: 'room', end_turn: true }) }]));
      await waitFor(() => runtime.chatRuns.get(resumed.runId)?.status === 'succeeded', '续跑交付完成');
      assert.equal((await runtime.rooms.messages(room.id)).filter(m => m.text === '群任务完成').length, 1);
      const message = (await runtime.messages.list(agent.id)).find(m => m.content.type === 'text' && m.content.text === '群任务完成')!;
      assert.equal(message.roomId, room.id);
      assert.ok(runtime.events.since(0).entries.some(e => e.roomId === room.id && (e.payload as any)?.message?.text === '群任务完成'));
    } finally { await runtime.close(); await tmp.cleanup(); }
  });
  it('离群后不把旧群任务降级成私聊执行', async () => {
    const tmp = await tempDataDir('boundary-group-removed'); const provider = new FakeProvider(); const runtime = runtimeAt(tmp.dir, provider);
    try {
      const a = await runtime.registry.create({ name: '测试' }); const room = await runtime.rooms.create({ name: '群', memberIds: [a.id] });
      const accepted = await runtime.acceptRoomMessage(room.id, '群任务'); const first = accepted.execute();
      await waitFor(() => provider.calls.length === 1, '群开始');
      const second = runtime.send(a.id, '私聊'); await waitFor(() => provider.calls.length === 2, '私聊开始');
      await runtime.rooms.remove(room.id); provider.releaseText(1, '完成'); await second; await first; await sleep(30);
      assert.equal(provider.calls.length, 2);
    } finally { await runtime.close(); await tmp.cleanup(); }
  });
  it('记忆不占聊天执行位；忽略取消的旧模型结果也不能迟到写入', async () => {
    const tmp = await tempDataDir('boundary-memory-cancel'); const fake = new FakeProvider({ rejectOnAbort: false }); const signals: Array<AbortSignal | undefined> = [];
    const provider: LLMProvider = { name: 'fake', chat(messages, opts) { signals.push(opts?.signal); return fake.chat(messages, opts); } };
    const runtime = runtimeAt(tmp.dir, provider, { memoryExtraction: true });
    try {
      const agent = await runtime.registry.create({ name: '记忆测试' });
      const first = runtime.send(agent.id, '整理旧结论。'.repeat(20));
      await waitFor(() => fake.calls.length === 1, '旧任务'); fake.releaseText(0, '已回复旧任务'); await first;
      await waitFor(() => fake.calls.length === 2, '旧记忆请求'); assert.equal(runtime.isBusy(agent.id), false);
      const second = runtime.send(agent.id, '旧结论不要记住，请处理新的需求。'.repeat(8));
      await waitFor(() => fake.calls.length === 3, '新任务'); assert.equal(signals[1]?.aborted, true);
      fake.releaseText(1, '[{"text":"不应保存的旧结论","scope":"self","tier":"log","tags":[]}]'); await sleep(20);
      assert.equal((await runtime.memory.list('self', agent.id)).length, 0);
      fake.releaseText(2, '新任务完成'); await second;
      await waitFor(() => fake.calls.length === 4, '新记忆请求'); fake.releaseText(3, '[{"text":"新的有效结论","scope":"self","tier":"log","tags":[]}]');
      await until(async () => (await runtime.memory.list('self', agent.id)).length === 1, '新记忆提交');
    } finally { await runtime.close(); await tmp.cleanup(); }
  });
});

describe('收件箱租约与到期调度', () => {
  it('群投递失败也能安全自动重试，但产生副作用后不重放', async () => {
    for (const sideEffect of [false, true]) {
      const tmp = await tempDataDir('boundary-room-retry'); let calls = 0, effects = 0;
      const write = defineTool({ name: 'WriteSentinel', description: '模拟写入', parameters: { type: 'object', properties: {} }, execute: () => { effects++; return 'ok'; } });
      const provider: LLMProvider = { name: 'fake', async chat() {
        calls++;
        if (sideEffect && calls === 1) return FakeProvider.toolCalls([{ id: 'w', name: 'WriteSentinel', arguments: '{}' }]);
        if ((!sideEffect && calls === 1) || (sideEffect && calls === 2)) throw new Error('临时失败');
        return FakeProvider.text('');
      } };
      const runtime = runtimeAt(tmp.dir, provider, { tools: [write], deliveryBaseDelayMs: 30 });
      try {
        const agent = await runtime.registry.create({ name: '测试' }); const room = await runtime.rooms.create({ name: '群', memberIds: [agent.id] });
        await runtime.inbox.enqueue({ ...letter(agent.id), kind: 'room', room: { roomId: room.id, roomName: room.name, roundId: 'original', speaker: '主人', summoned: true } });
        await runtime.drainInbox(agent.id);
        if (sideEffect) { await sleep(100); assert.equal(calls, 2); assert.equal(effects, 1); assert.equal(await runtime.failedMail(agent.id), 1); }
        else await until(async () => calls === 2 && await runtime.pendingMail(agent.id) === 0, '群重试完成');
      } finally { await runtime.close(); await tmp.cleanup(); }
    }
  });
  it('关服取消不响应 AbortSignal 的模型请求，不让执行位一直挂住', async () => {
    const tmp = await tempDataDir('boundary-close-active'); const fake = new FakeProvider({ rejectOnAbort: false }); const runtime = runtimeAt(tmp.dir, fake);
    try {
      const agent = await runtime.registry.create({ name: '测试' }); const running = runtime.send(agent.id, '任务');
      await waitFor(() => fake.calls.length === 1, '模型挂起'); await runtime.close();
      assert.equal((await running).stopReason, 'cancelled'); assert.equal(runtime.isBusy(agent.id), false);
      fake.releaseText(0, '迟到结果'); await sleep(10);
      assert.equal((await runtime.messages.list(agent.id)).filter(message => message.role === 'assistant').length, 0);
    } finally { await runtime.close(); await tmp.cleanup(); }
  });
  it('换手后旧 ack/nack/release/checkpoint/renew 全部拒绝，旧领取快照不变', async () => {
    const tmp = await tempDataDir('boundary-lease');
    try {
      const inbox = new AgentInbox(tmp.dir); const item = await inbox.enqueue(letter('a')); const now = Date.now();
      const old = await inbox.claim('a', { owner: 'old', leaseMs: 100, maxAttempts: 3, now });
      const fresh = await inbox.claim('a', { owner: 'new', leaseMs: 1000, maxAttempts: 3, now: now + 101 });
      assert.equal(old[0]?.leaseOwner, 'old'); const lease = { ...leaseOf(old[0]!), now: now + 102 };
      await assert.rejects(inbox.ack('a', [item.id], lease), DeliveryLeaseLostError);
      await assert.rejects(inbox.release('a', [item.id], lease), DeliveryLeaseLostError);
      await assert.rejects(inbox.nack('a', [item.id], 'late', { maxAttempts: 3, baseDelayMs: 10, now: now + 102 }, lease), DeliveryLeaseLostError);
      await assert.rejects(inbox.checkpoint('a', [item.id], { messageId: 'bad' }, lease), DeliveryLeaseLostError);
      await assert.rejects(inbox.renew('a', [item.id], lease, 1000), DeliveryLeaseLostError);
      assert.equal((await inbox.peek('a'))[0]?.leaseOwner, 'new');
      await inbox.ack('a', [item.id], { ...leaseOf(fresh[0]!), now: now + 102 }); assert.equal(await inbox.count('a'), 0);
    } finally { await tmp.cleanup(); }
  });
  it('过期但尚未换手也不能确认；有效续租跨重开保留', async () => {
    const tmp = await tempDataDir('boundary-renew');
    try {
      const inbox = new AgentInbox(tmp.dir); const item = await inbox.enqueue(letter('a')); const now = Date.now();
      const [claimed] = await inbox.claim('a', { owner: 'r', leaseMs: 100, maxAttempts: 3, now });
      await inbox.renew('a', [item.id], { ...leaseOf(claimed!), now: now + 20 }, 200);
      const reopened = new AgentInbox(tmp.dir);
      assert.equal((await reopened.peek('a'))[0]?.leaseUntil, now + 220);
      await assert.rejects(reopened.ack('a', [item.id], { ...leaseOf(claimed!), now: now + 221 }), DeliveryLeaseLostError);
    } finally { await tmp.cleanup(); }
  });
  it('长任务持续续租，重复 drain 合并成一次处理', async () => {
    const tmp = await tempDataDir('boundary-heartbeat'); const fake = new FakeProvider();
    const runtime = runtimeAt(tmp.dir, fake, { deliveryLeaseMs: 300 });
    try {
      const agent = await runtime.registry.create({ name: '测试' }); await runtime.inbox.enqueue(letter(agent.id));
      const a = runtime.drainInbox(agent.id), b = runtime.drainInbox(agent.id);
      await waitFor(() => fake.calls.length === 1, '收到信'); await sleep(450);
      assert.equal((await runtime.inbox.claim(agent.id, { owner: 'other', leaseMs: 300, maxAttempts: 3 })).length, 0);
      fake.releaseText(0, '收到'); await a; await b;
      assert.equal(fake.calls.length, 1); assert.equal(await runtime.pendingMail(agent.id), 0);
    } finally { await runtime.close(); await tmp.cleanup(); }
  });
  it('失败自动退避重试，不需要新消息或手动 drain', async () => {
    const tmp = await tempDataDir('boundary-auto-retry'); let calls = 0;
    const provider: LLMProvider = { name: 'fake', async chat() { if (++calls === 1) throw new Error('temporary'); return FakeProvider.text('完成'); } };
    const runtime = runtimeAt(tmp.dir, provider, { deliveryBaseDelayMs: 30 });
    try {
      const agent = await runtime.registry.create({ name: '测试' }); await runtime.inbox.enqueue(letter(agent.id));
      await assert.rejects(runtime.drainInbox(agent.id), /temporary/);
      await until(async () => calls === 2 && await runtime.pendingMail(agent.id) === 0, '自动重试成功');
    } finally { await runtime.close(); await tmp.cleanup(); }
  });
  it('重启时还没到期的退避任务，到期也会唤醒', async () => {
    const tmp = await tempDataDir('boundary-retry-restart'); const inbox = new AgentInbox(tmp.dir);
    const fake = new FakeProvider({ auto: () => FakeProvider.text('完成') }); const runtime = runtimeAt(tmp.dir, fake);
    try {
      const agent = await runtime.registry.create({ name: '测试' }); const item = await inbox.enqueue(letter(agent.id));
      const [claim] = await inbox.claim(agent.id, { owner: 'old', leaseMs: 1000, maxAttempts: 3 });
      await inbox.nack(agent.id, [item.id], 'temporary', { maxAttempts: 3, baseDelayMs: 100 }, leaseOf(claim!));
      await runtime.recover();
      await until(async () => fake.calls.length === 1 && await runtime.pendingMail(agent.id) === 0, '恢复到期唤醒');
    } finally { await runtime.close(); await tmp.cleanup(); }
  });
  it('可能已有副作用的失败任务不自动重放', async () => {
    const tmp = await tempDataDir('boundary-retry-effects'); let calls = 0, effects = 0;
    const tool = defineTool({ name: 'WriteSentinel', description: '测试副作用', parameters: { type: 'object', properties: {} }, execute: () => { effects++; return 'done'; } });
    const provider: LLMProvider = { name: 'fake', async chat() {
      if (++calls === 1) return FakeProvider.toolCalls([{ id: 'write', name: tool.name, arguments: '{}' }]);
      throw new Error('写入之后模型失败');
    } };
    const runtime = runtimeAt(tmp.dir, provider, { tools: [tool], deliveryBaseDelayMs: 20 });
    try {
      const agent = await runtime.registry.create({ name: '测试' }); await runtime.inbox.enqueue(letter(agent.id));
      await assert.rejects(runtime.drainInbox(agent.id), /模型失败/); await sleep(100);
      assert.equal(effects, 1); assert.equal(calls, 2); assert.equal(await runtime.failedMail(agent.id), 1);
    } finally { await runtime.close(); await tmp.cleanup(); }
  });
  it('关闭运行时取消已安排重试，不产生后台幽灵任务', async () => {
    const tmp = await tempDataDir('boundary-scheduler-close'); let calls = 0;
    const runtime = runtimeAt(tmp.dir, { name: 'fake', async chat() { calls++; throw new Error('temporary'); } }, { deliveryBaseDelayMs: 80 });
    try {
      const agent = await runtime.registry.create({ name: '测试' }); await runtime.inbox.enqueue(letter(agent.id));
      await assert.rejects(runtime.drainInbox(agent.id)); await runtime.close(); await sleep(130);
      assert.equal(calls, 1);
    } finally { await runtime.close(); await tmp.cleanup(); }
  });
});
