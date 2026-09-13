import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TaskProgressStore } from '../src/storage/task-progress.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { createFileTools } from '../src/tools/builtin/files.js';
import { WorkerManager } from '../src/tools/services/worker-manager.js';
import { MessageStore } from '../src/store/messages.js';
import { JsonToolInvocationLedger } from '../src/storage/tool-ledger.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, waitFor } from './fakes/test-env.js';
import { createAgentServer } from '../src/server/http.js';
import { parseSendMessageInput } from '../src/shared/contracts/chat.js';

it('检查点在工具执行前记意图、之后记结果，强退不丢未知操作和已改文件', async () => {
  const env = await tempDataDir('progress-store');
  try {
    const store = new TaskProgressStore(env.dir), id = randomUUID();
    store.begin(id, 'a', '优化网页，保留全部内容');
    const write = { id: 'c1', name: 'Edit', arguments: '{"path":"page.html"}' };
    store.startCall(id, write); store.result(id, write, { status: 'ok', content: '已修改' });
    store.startCall(id, { id: 'c2', name: 'Shell', arguments: '{"command":"npm test"}' });
    const reopened = new TaskProgressStore(env.dir), record = reopened.get(id, 'a')!;
    assert.equal(record.status, 'interrupted'); assert.deepEqual(record.modifiedFiles, ['page.html']);
    assert.equal(record.pending[0]?.tool, 'Shell'); assert.equal(record.pending[0]?.policy, 'manual');
    assert.equal(reopened.get(id, 'other'), undefined);
    const next = randomUUID(); reopened.begin(next, 'a', '继续', 'dm', id);
    // 模型新轮次可能复用 call id；不能覆盖从旧运行继承的未决调用。
    reopened.startCall(next, { id: 'c2', name: 'Read', arguments: '{"path":"page.html"}' });
    reopened.result(next, { id: 'c2', name: 'Read', arguments: '{"path":"page.html"}' }, { status: 'ok', content: '当前内容' });
    assert.equal(reopened.get(next, 'a')!.pending.length, 1);
    assert.match(reopened.brief(next, 'a'), /不盲目重放/);
    assert.match(reopened.brief(next, 'a'), /保留全部内容/);
  } finally { await env.cleanup(); }
});

it('运行达到轮数上限标记 incomplete；重启后明确继续带回证据，不重复写文件', async () => {
  const env = await tempDataDir('runtime-progress');
  try {
    let requests = 0;
    const path = join(env.dir, 'page.html');
    const firstProvider = new FakeProvider({ auto: () => ++requests === 1
      ? FakeProvider.toolCalls([{ id: 'write', name: 'Write', arguments: JSON.stringify({ path, content: '<main>保留内容</main>' }) }])
      : FakeProvider.text('已写入 page.html，尚未验证手机布局，下一步检查页面。') });
    const options = { tools: createFileTools(env.dir), dataDir: env.dir, defaultModel: 'fake', knownModels: ['fake'], budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 }, memoryExtraction: false, maxIterations: 1 };
    const runtime = new AgentRuntime({ ...options, createProvider: () => firstProvider });
    await runtime.ensureDefaultAgent(); const agent = (await runtime.registry.list())[0]!;
    const result = await runtime.send(agent.id, '优化网页，保留全部内容');
    assert.equal(result.stopReason, 'max_iterations'); assert.ok(result.taskId);
    assert.equal(runtime.taskProgress.get(result.taskId!, agent.id)?.status, 'incomplete');
    const before = await readFile(path, 'utf8');
    const ledger = JSON.parse(await readFile(join(env.dir, 'runs', 'ledger.json'), 'utf8'));
    assert.equal(ledger.turns.find((turn: any) => turn.id === result.taskId).status, 'incomplete');
    assert.equal(ledger.trees[0].status, 'incomplete');
    let resumedRequests = 0;
    const resumed = new AgentRuntime({ ...options, createProvider: () => new FakeProvider({ auto: messages => {
      resumedRequests++;
      const recovery = messages.find(item => item.content?.startsWith('任务恢复快照'));
      assert.equal(recovery?.role, 'user');
      assert.match(recovery!.content!, /优化网页，保留全部内容/);
      assert.match(recovery!.content!, /page.html/); assert.match(recovery!.content!, /尚未验证手机布局/);
      assert.equal(messages.findLast(message => message.role === 'user')?.content, '继续');
      return FakeProvider.text('已接回任务，先检查当前产物。');
    } }) });
    assert.equal(resumedRequests, 0, '不自动绕过轮数上限续跑');
    const next = await resumed.send(agent.id, '继续');
    assert.equal(resumedRequests, 1);
    assert.equal(resumed.taskProgress.get(next.taskId!, agent.id)?.parentTaskId, result.taskId);
    assert.equal(resumed.taskProgress.get(next.taskId!, agent.id)?.status, 'answered');
    assert.equal(await readFile(path, 'utf8'), before);
  } finally { await env.cleanup(); }
});

it('普通新任务不续接旧目标；显式恢复拒绝其他智能体的检查点', async () => {
  const env = await tempDataDir('progress-isolation');
  try {
    const fake = new FakeProvider({ auto: messages => { assert.ok(!messages.some(item => item.content?.startsWith('任务恢复快照'))); return FakeProvider.text('你好'); } });
    const runtime = new AgentRuntime({ tools: [], dataDir: env.dir, defaultModel: 'fake', knownModels: ['fake'], budget: DEFAULT_BUDGET, memoryExtraction: false, createProvider: () => fake });
    await runtime.ensureDefaultAgent(); const agent = (await runtime.registry.list())[0]!;
    const old = randomUUID(); runtime.taskProgress.begin(old, agent.id, '旧网页任务'); runtime.taskProgress.finish(old, 'incomplete', 'max_iterations');
    await runtime.send(agent.id, '讲个笑话');
    const other = randomUUID(); runtime.taskProgress.begin(other, 'other', '私有任务'); runtime.taskProgress.finish(other, 'incomplete', 'max_iterations');
    await assert.rejects(() => runtime.acceptMessage(agent.id, '继续', { resumeTaskId: other }), /找不到/);
  } finally { await env.cleanup(); }
});

it('模型请求失败的主回合落为 failed，而不是 done', async () => {
  const env = await tempDataDir('progress-failed');
  try {
    const runtime = new AgentRuntime({ tools: [], dataDir: env.dir, defaultModel: 'fake', knownModels: ['fake'], budget: DEFAULT_BUDGET, memoryExtraction: false, createProvider: () => ({ name: 'fake', chat: async () => { throw new Error('provider offline'); } }) });
    await runtime.ensureDefaultAgent(); const agent = (await runtime.registry.list())[0]!;
    await assert.rejects(() => runtime.send(agent.id, '做任务'), /provider offline/);
    assert.equal(runtime.taskProgress.list(agent.id)[0]?.status, 'failed');
    const ledger = JSON.parse(await readFile(join(env.dir, 'runs', 'ledger.json'), 'utf8'));
    assert.equal(ledger.turns[0].status, 'failed'); assert.equal(ledger.trees[0].status, 'failed');
  } finally { await env.cleanup(); }
});

it('后台工人达到轮数上限为 incomplete，显式 Message 续跑带回已修改证据', async () => {
  const env = await tempDataDir('worker-progress');
  try {
    const path = join(env.dir, 'worker.html'); let count = 0;
    const manager = new WorkerManager({ dataDir: env.dir, messages: new MessageStore(env.dir), maxIterations: 1, workerTools: () => createFileTools(env.dir), provider: new FakeProvider({ auto: messages => {
      count++;
      if (count === 1) return FakeProvider.toolCalls([{ id: 'w', name: 'Write', arguments: JSON.stringify({ path, content: 'original' }) }]);
      if (count === 2) return FakeProvider.text('已修改 worker.html，尚未验证');
      assert.ok(messages.some(message => message.content?.startsWith('任务恢复快照') && message.content.includes('worker.html')));
      return FakeProvider.text('已接回检查');
    } }) });
    const worker = manager.spawn('写网页', '写 worker.html 并验收', 'a', { toolNames: ['Write'], projectIds: [] }); await manager.drive(worker);
    assert.equal(worker.status, 'incomplete'); assert.equal(worker.stopReason, 'max_iterations');
    assert.equal(count, 2);
    manager.pushMessage(worker.id, '继续验证，不要重写'); await manager.drive(worker);
    assert.equal(worker.status, 'done'); assert.equal(count, 3); assert.equal(await readFile(path, 'utf8'), 'original');
    manager.kill(worker.id); assert.equal(worker.status, 'done', '过期停止句柄不能改写已完成状态');
  } finally { await env.cleanup(); }
});

it('后台工人异常、超时、主动取消是不同状态', async () => {
  const env = await tempDataDir('worker-statuses');
  try {
    const messages = new MessageStore(env.dir);
    const broken = new WorkerManager({ messages, workerTools: () => [], provider: { name: 'fake', chat: async () => { throw new Error('bad provider'); } } });
    const worker = broken.spawn('异常', '模拟失败'); await broken.drive(worker);
    assert.equal(worker.status, 'failed'); assert.equal(worker.stopReason, 'failed');
    const hanging = { name: 'fake', chat: async (_messages: unknown, options: any) => new Promise<never>((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); }) };
    const timeout = new WorkerManager({ messages, workerTools: () => [], provider: hanging, maxRuntimeMs: 30 });
    const timed = timeout.spawn('超时', '模拟超时'); await timeout.drive(timed);
    assert.equal(timed.status, 'timed_out'); assert.equal(timed.stopReason, 'timed_out');
    const cancel = new WorkerManager({ messages, workerTools: () => [], provider: hanging });
    const cancelled = cancel.spawn('取消', '模拟取消'); const driving = cancel.drive(cancelled);
    await waitFor(() => cancel.isRunning(cancelled.id), '工人开跑');
    // 等模型请求真正开始，确保测试的是运行期取消。
    await new Promise(resolve => setTimeout(resolve, 20)); cancel.stop(cancelled.id); await driving;
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.stopReason, 'cancelled');
  } finally { await env.cleanup(); }
});

it('工具账本裁剪始终保留 unknown；未决记录超出容量时不误留所有已结束记录', async () => {
  const env = await tempDataDir('ledger-unknown');
  try {
    const ledger = new JsonToolInvocationLedger(env.dir, { limit: 1 });
    const unknown = await ledger.start({ agentId: 'a', tool: 'Shell', operationKey: '1', replayPolicy: 'manual' });
    await ledger.finish(unknown.id, { status: 'unknown' });
    const started = await ledger.start({ agentId: 'a', tool: 'Shell', operationKey: '2', replayPolicy: 'manual' });
    assert.deepEqual((await ledger.unfinished()).map(record => record.id).sort(), [unknown.id, started.id].sort());
  } finally { await env.cleanup(); }
});

it('HTTP 任务摘要/详情与显式恢复接线正确，跨智能体恢复返回 400', async () => {
  const env = await tempDataDir('progress-http');
  const fake = new FakeProvider({ auto: () => FakeProvider.text('已接回任务') });
  const server = await createAgentServer({ port: 0, rootDir: env.dir, dataDir: env.dir, allowMissingKey: true, createProvider: () => fake });
  try {
    const agent = (await server.runtime.registry.list())[0]!;
    const id = randomUUID(); server.runtime.taskProgress.begin(id, agent.id, '保留内容，检查网页'); server.runtime.taskProgress.finish(id, 'incomplete', 'max_iterations', '已写入，待验证');
    const list = await (await fetch(`${server.url}api/agents/${agent.id}/tasks`)).json() as any;
    assert.ok(Array.isArray(list.tasks), JSON.stringify(list));
    assert.equal(list.tasks[0].id, id); assert.equal(list.tasks[0].status, 'incomplete');
    const detail = await (await fetch(`${server.url}api/agents/${agent.id}/tasks/${id}`)).json() as any;
    assert.equal(detail.task.handoff, '已写入，待验证');
    assert.equal(parseSendMessageInput({ text: '继续', resumeTaskId: '../bad' }).ok, false);
    const foreign = randomUUID(); server.runtime.taskProgress.begin(foreign, 'other', '别人的任务'); server.runtime.taskProgress.finish(foreign, 'incomplete', 'max_iterations');
    const denied = await fetch(`${server.url}api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '继续', botId: agent.id, resumeTaskId: foreign }) });
    assert.equal(denied.status, 400);
    const accepted = await fetch(`${server.url}api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '继续检查', botId: agent.id, resumeTaskId: id }) });
    assert.equal(accepted.status, 202);
    await waitFor(() => server.runtime.taskProgress.list(agent.id).some(task => task.parentTaskId === id && task.status === 'answered'), '恢复任务完成');
    assert.ok(fake.calls.some(messages => messages.some(message => message.content?.startsWith('任务恢复快照'))));
  } finally { await server.close(); await env.cleanup(); }
});
