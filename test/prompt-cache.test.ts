import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Agent, MemoryRef, Message } from '../src/agent/types.js';
import type { LLMMessage } from '../src/llm/provider.js';
import { ContextBuilder } from '../src/context/builder.js';
import { DEFAULT_BUDGET, estimateTokens, memoryPartBudgets } from '../src/context/budget.js';
import { MEMORY_PARTS, promptHash, sealSnapshot } from '../src/context/system-snapshot.js';
import { fitContextWindow, RESPONSE_RESERVE } from '../src/context/window.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { defineTool } from '../src/tools/tool.js';
import { TaskProgressStore } from '../src/storage/task-progress.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, until, waitFor } from './fakes/test-env.js';

const task = (text = '优化网页'): Message => ({ id: randomUUID(), agentId: 'a', role: 'user', content: { type: 'text', text }, createdAt: 1 });
function ref(id: string, tier: MemoryRef['entry']['tier'] = 'portrait', text = `记忆 ${id}`): MemoryRef {
  return { scope: 'self', ownerId: 'a', entry: { id, scope: 'self', ownerId: 'a', tier, text, key: id, tags: [], source: 'user',
    createdAt: 1, updatedAt: 1, hits: 0, lastSurfacedAt: null } };
}
function agent(refs = [ref('base')]): Agent {
  return { id: 'a', name: '测试', title: '', description: '', instructions: '固定职责', tools: [], toolNames: [],
    memory: { refs, compaction: null, projectIds: [] }, color: '', createdAt: 1, updatedAt: 1 };
}
const builder = () => new ContextBuilder({ recent: async () => [] } as never, DEFAULT_BUDGET);
const prefix = (messages: LLMMessage[]) => messages.slice(0, 2);
const tool = (name: string) => defineTool({ name, description: `工具 ${name}`, parameters: { type: 'object', properties: {} }, execute: () => 'ok' });

it('动态 brief、检索、摘要和文件不插入规则/记忆前缀；最新用户句在最后', async () => {
  const a = agent(Array.from({ length: 13 }, (_, index) => ref(String(index).padStart(2, '0'), 'portrait', `网页导航资料 ${index}`)));
  const history: Message[] = [
    { ...task(), role: 'assistant', content: { type: 'tool_calls', calls: [{ id: 'read', name: 'Read', arguments: '{"path":"page.html"}' }] } },
    { ...task(), role: 'tool', content: { type: 'tool_result', callId: 'read', name: 'Read', result: '<html/>', ok: true } },
  ];
  a.memory.compaction = { summary: '之前做过导航', coversUpTo: 1, messageCount: 10, updatedAt: 1 };
  const b = new ContextBuilder({ recent: async () => history } as never, DEFAULT_BUDGET);
  const first = await b.build(a, task('网页导航'), { turnBrief: '群 A：当前只能发言，不准写文件' });
  const second = await b.build(a, task('最新要求：只读检查'), { turnBrief: '群 B：本轮停止旧任务' });
  assert.equal(promptHash(prefix(first.messages)), promptHash(prefix(second.messages)));
  assert.ok(!JSON.stringify(prefix(first.messages)).includes('群 A'));
  for (const marker of ['更早的对话摘要', '本轮参考资料']) {
    const message = first.messages.find(item => item.content?.includes(marker));
    assert.equal(message?.role, 'user');
  }
  assert.match(first.messages.find(item => item.content?.includes('本轮参考资料'))!.content!, /page\.html/);
  assert.equal(second.messages.at(-2)?.role, 'system');
  assert.equal(second.messages.at(-1)?.content, '最新要求：只读检查');
});

it('同一份记忆在长短任务/历史下切片和哈希一致，固定预算不借用剩余空间', async () => {
  let history: Message[] = [];
  const b = new ContextBuilder({ recent: async () => history } as never, DEFAULT_BUDGET);
  const refs = ['portrait', 'log', 'scratch'].flatMap(tier => Array.from({ length: 12 }, (_, i) => ref(`${tier}-${i}`, tier as 'portrait', '内容'.repeat(3000))));
  const a = agent(refs);
  const first = await b.build(a, task('短任务'));
  history = Array.from({ length: 30 }, () => task('历史'.repeat(1500)));
  const second = await b.build(a, task('长任务'.repeat(15000)));
  assert.equal(promptHash(prefix(first.messages)), promptHash(prefix(second.messages)));
  const limits = memoryPartBudgets(DEFAULT_BUDGET);
  for (const part of MEMORY_PARTS) assert.ok(estimateTokens(first.systemSnapshot!.memory[part]) <= limits[part]);
});

it('记忆同时间戳时按 owner/id 稳定排序，不依赖存储遍历顺序', async () => {
  const refs = Array.from({ length: 20 }, (_, i) => ref(`id-${i}`, 'log'));
  const b = builder();
  const first = await b.build(agent(refs), task());
  const second = await b.build(agent([...refs].reverse()), task());
  assert.equal(promptHash(first.systemSnapshot), promptHash(second.systemSnapshot));
});

it('同任务恢复复用原前缀；新增记忆和读取统计不重写，普通新任务看到新记忆', async () => {
  const a = agent(), b = builder();
  const first = await b.build(a, task());
  a.memory.refs[0]!.entry.hits++;
  a.memory.refs[0]!.entry.lastSurfacedAt = Date.now();
  a.memory.refs.push(ref('new', 'log', '刚刚记下的新事实'));
  const resumed = await b.build(a, task('继续，只验证不写文件'), { systemSnapshot: first.systemSnapshot });
  assert.equal(resumed.snapshotReused, true);
  assert.equal(promptHash(prefix(first.messages)), promptHash(prefix(resumed.messages)));
  assert.ok(!resumed.systemSnapshot!.memory.log.includes('新事实'));
  assert.equal(resumed.messages.at(-1)?.content, '继续，只验证不写文件');
  const fresh = await b.build(a, task('新任务'));
  assert.equal(fresh.snapshotReused, false);
  assert.match(fresh.systemSnapshot!.memory.log, /新事实/);
});

it('修改/删除已注入记忆会使恢复快照失效，不能复活被用户删除的内容', async () => {
  const a = agent(), b = builder(), first = await b.build(a, task());
  a.memory.refs[0]!.entry.text = '用户修正后的事实';
  const edited = await b.build(a, task('继续'), { systemSnapshot: first.systemSnapshot });
  assert.equal(edited.snapshotReused, false);
  assert.match(edited.systemSnapshot!.memory.portrait, /修正/);
  a.memory.refs = [];
  const removed = await b.build(a, task('继续'), { systemSnapshot: first.systemSnapshot });
  assert.equal(removed.snapshotReused, false);
  assert.equal(removed.systemSnapshot!.memory.portrait, '');
});

it('身份/职责、工具、项目范围、模型、预算、摘要、会话作用域变更都重建快照', async () => {
  const a = agent(), b = builder(), first = await b.build(a, task(), { model: 'm1' });
  const changes: Array<(a: Agent) => void> = [
    a => { a.instructions = '新职责：只读'; }, a => { a.name = '新名字'; },
    a => { a.tools = [tool('Read')]; }, a => { a.memory.projectIds = ['new-project']; },
    a => { a.memory.compaction = { summary: '新摘要', coversUpTo: 1, messageCount: 1, updatedAt: 1 }; },
  ];
  for (const change of changes) {
    const changed = agent(); change(changed);
    assert.equal((await b.build(changed, task(), { model: 'm1', systemSnapshot: first.systemSnapshot })).snapshotReused, false);
  }
  for (const options of [{ model: 'm2' }, { model: 'm1', scope: 'room:other' }]) {
    assert.equal((await b.build(a, task(), { ...options, systemSnapshot: first.systemSnapshot })).snapshotReused, false);
  }
  const small = new ContextBuilder({ recent: async () => [] } as never, { ...DEFAULT_BUDGET, total: 30000 });
  assert.equal((await small.build(a, task(), { model: 'm1', systemSnapshot: first.systemSnapshot })).snapshotReused, false);
});

it('工具注册顺序不改变 schema 序列化和快照有效性', async () => {
  const tools = [tool('Write'), tool('Read')], a = agent(), b = builder();
  a.tools = tools;
  const first = await b.build(a, task());
  a.tools = [...tools].reverse();
  assert.equal(promptHash(ToolRegistry.from(tools).getSchemas()), promptHash(ToolRegistry.from(a.tools).getSchemas()));
  assert.equal((await b.build(a, task(), { systemSnapshot: first.systemSnapshot })).snapshotReused, true);
});

it('上下文满时保留快照和后置群纪律，仍预留输出空间且不篡改输入', async () => {
  const built = await builder().build(agent(), task('只读检查'), { turnBrief: '群纪律：禁止外发' });
  const input = [...built.messages, ...Array.from({ length: 30 }, () => ({ role: 'assistant' as const, content: '旧结果'.repeat(3000) }))];
  const before = JSON.stringify(input);
  const result = fitContextWindow(input, [], 20000, '只读检查');
  assert.equal(promptHash(prefix(result)), promptHash(prefix(built.messages)));
  assert.ok(result.some(item => item.content === '群纪律：禁止外发'));
  assert.ok(result.some(item => item.content === '只读检查'));
  assert.ok(estimateTokens(JSON.stringify(result)) + estimateTokens('[]') + 128 <= 20000 * 0.85 - RESPONSE_RESERVE);
  assert.equal(JSON.stringify(input), before);
});

it('短历史也计入包装开销，不会只剩回答而丢掉用户的问题', async () => {
  const history = [task('问题'), { ...task('答案'), role: 'assistant' as const }];
  const b = new ContextBuilder({ recent: async () => history } as never, DEFAULT_BUDGET);
  const built = await b.build(agent(), task('继续'));
  assert.equal(built.droppedRecent, 0);
  assert.ok(built.messages.some(message => message.content === '问题'));
  assert.ok(built.messages.some(message => message.content === '答案'));
});

it('自动续跑时最新用户要求即使不在最近窗口内也会补回，后续工具挤满窗口仍保留', async () => {
  const latest = task('新要求：只检查导航，禁止写文件');
  const built = await builder().build(agent(), task('（续）原任务'), { latestUserMessage: latest });
  const input = [...built.messages, ...Array.from({ length: 30 }, () => ({ role: 'assistant' as const, content: '旧工具结果'.repeat(2000) }))];
  const request = fitContextWindow(input, [], 20000, '（续）原任务', built.protectedContents);
  assert.ok(request.some(message => message.role === 'user' && message.content === '新要求：只检查导航，禁止写文件'));
  assert.ok(request.some(message => message.content === '（续）原任务'));
});

it('快照独立限量落盘、隔离 agent/scope、重启可读；损坏快照安全退回重建', async () => {
  const env = await tempDataDir('prompt-snapshot');
  try {
    const store = new TaskProgressStore(env.dir), id = randomUUID();
    const snapshot = (await builder().build(agent(), task())).systemSnapshot!;
    store.begin(id, 'a', '任务'); store.saveSystemSnapshot(id, snapshot);
    const path = join(env.dir, 'tasks', 'prompts', `${id}.json`);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(store.get(id, 'a')).includes('固定职责'), '公开任务记录不含提示词');
    assert.equal(promptHash(new TaskProgressStore(env.dir).getSystemSnapshot(id, 'a')), promptHash(snapshot));
    assert.equal(store.getSystemSnapshot(id, 'other'), undefined);
    const { digest, ...body } = snapshot;
    assert.throws(() => store.saveSystemSnapshot(id, sealSnapshot({ ...body, scope: 'room:other' })), /快照无效/);
    assert.throws(() => store.saveSystemSnapshot(id, sealSnapshot({ ...body, rules: 'x'.repeat(300000) })), /快照无效/);
    const child = randomUUID(); store.begin(child, 'a', '继续', 'dm', id);
    assert.equal(promptHash(store.getSystemSnapshot(child, 'a')), promptHash(snapshot), '在保存新快照前中断也可沿父链恢复');
    await writeFile(path, '{broken');
    assert.equal(store.getSystemSnapshot(id, 'a'), undefined);
    await writeFile(path, JSON.stringify({ ...snapshot, rules: '被篡改' }));
    assert.equal(store.getSystemSnapshot(id, 'a'), undefined);
    const old = randomUUID(); store.begin(old, 'a', '旧版本没有快照');
    assert.equal(store.getSystemSnapshot(old, 'a'), undefined);
  } finally { await env.cleanup(); }
});

const runtimeOptions = (dir: string) => ({ tools: [], dataDir: dir, defaultModel: 'fake', knownModels: ['fake'],
  budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 }, memoryExtraction: false,
  seed: [{ name: '测试员', color: '', instructions: '原职责' }],
});

it('运行时重启后明确继续复用落盘快照，普通新任务重建；后续职责/工具撤销生效', async () => {
  const env = await tempDataDir('prompt-runtime');
  try {
    const options = runtimeOptions(env.dir);
    const runtime = new AgentRuntime({ ...options, createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('阶段记录') }) });
    await runtime.ensureDefaultAgent(); const a = (await runtime.registry.list())[0]!;
    await runtime.memory.write({ scope: 'self', ownerId: a.id, tier: 'portrait', text: '原有偏好：暗色页面' });
    const first = await runtime.send(a.id, '完成网页');
    runtime.taskProgress.finish(first.taskId!, 'incomplete', 'max_iterations');
    await runtime.memory.write({ scope: 'self', ownerId: a.id, tier: 'log', text: '新增事实：导航已完成' });
    const provider = new FakeProvider({ auto: () => FakeProvider.text('仅检查，不写文件') });
    const reopened = new AgentRuntime({ ...options, createProvider: () => provider });
    const resumed = await reopened.send(a.id, '继续，只检查，不修改', { resumeTaskId: first.taskId });
    assert.equal(resumed.context.snapshotReused, true);
    assert.equal(promptHash(prefix(first.context.messages)), promptHash(prefix(provider.calls[0]!)));
    assert.equal(provider.calls[0]!.at(-1)?.content, '继续，只检查，不修改');
    assert.ok(provider.calls[0]!.some(item => item.content?.startsWith('任务恢复快照')));
    const fresh = await reopened.send(a.id, '新的任务');
    assert.equal(fresh.context.snapshotReused, false);
    assert.match(fresh.context.systemSnapshot!.memory.log, /导航已完成/);
    await reopened.registry.update(a.id, { instructions: '新职责：不能修改文件', toolNames: [] });
    const changed = await reopened.send(a.id, '只读继续', { resumeTaskId: first.taskId });
    assert.equal(changed.context.snapshotReused, false);
    assert.match(changed.context.systemSnapshot!.rules, /新职责/);
    assert.equal((await reopened.buildAgent((await reopened.registry.get(a.id))!)).tools.length, 0);
    const restarted = new AgentRuntime({ ...options, createProvider: () => provider });
    await restarted.ensureDefaultAgent();
    assert.deepEqual((await restarted.registry.get(a.id))!.toolNames, [], '启动升级不能悄悄补回已撤销工具');
  } finally { await env.cleanup(); }
});

it('默认工具集仍可升级；旧版本显式工具清单和主动选择的子集不被补回', async () => {
  const env = await tempDataDir('prompt-permissions');
  try {
    const options = runtimeOptions(env.dir);
    const runtime = new AgentRuntime({ ...options, createProvider: () => new FakeProvider() });
    await runtime.ensureDefaultAgent(); const defaultAgent = (await runtime.registry.list())[0]!;
    const explicit = await runtime.registry.create({ name: '显式权限', toolNames: ['ReadToolOutput'] });
    const upgraded = new AgentRuntime({ ...options, tools: [tool('NewTool')], createProvider: () => new FakeProvider() });
    await upgraded.ensureDefaultAgent();
    assert.ok((await upgraded.registry.get(defaultAgent.id))!.toolNames.includes('NewTool'));
    assert.deepEqual((await upgraded.registry.get(explicit.id))!.toolNames, ['ReadToolOutput']);
    const legacy = { ...(await upgraded.registry.get(explicit.id))! }; delete legacy.toolPolicy;
    await writeFile(join(env.dir, 'agents.json'), JSON.stringify([legacy]));
    const old = new AgentRuntime({ ...options, seed: [], createProvider: () => new FakeProvider() });
    await old.ensureDefaultAgent();
    assert.deepEqual((await old.registry.get(explicit.id))!.toolNames, ['ReadToolOutput']);
  } finally { await env.cleanup(); }
});

it('实际插话自动补跑复用原任务前缀，不拿插话任务的新记忆替换', async () => {
  const env = await tempDataDir('prompt-preempt');
  try {
    const fake = new FakeProvider(), runtime = new AgentRuntime({ ...runtimeOptions(env.dir), createProvider: () => fake });
    await runtime.ensureDefaultAgent(); const a = (await runtime.registry.list())[0]!;
    await runtime.memory.write({ scope: 'self', ownerId: a.id, tier: 'portrait', text: '原有页面偏好' });
    const first = runtime.send(a.id, '实现导航');
    await waitFor(() => fake.calls.length === 1, '原任务已请求模型');
    await runtime.memory.write({ scope: 'self', ownerId: a.id, tier: 'log', text: '插话前刚写的新事实' });
    const interrupt = runtime.send(a.id, '先回答这个问题');
    await waitFor(() => fake.calls.length === 2, '插话已请求模型');
    assert.notEqual(promptHash(prefix(fake.calls[0]!)), promptHash(prefix(fake.calls[1]!)));
    fake.releaseText(1, '回答完了'); await interrupt;
    await waitFor(() => fake.calls.length === 3, '自动恢复原任务');
    assert.equal(promptHash(prefix(fake.calls[0]!)), promptHash(prefix(fake.calls[2]!)));
    assert.match(JSON.stringify(fake.calls[2]), /先回答这个问题/);
    fake.releaseText(2, '导航处理完成'); await first;
    await until(async () => runtime.taskProgress.list(a.id).every(item => item.status !== 'running'), '补跑已收尾');
  } finally { await env.cleanup(); }
});

it('同一次工具循环 remember 后规则和记忆前缀不变，工具结果仍可见', async () => {
  const env = await tempDataDir('prompt-remember');
  try {
    let runtime: AgentRuntime, calls = 0;
    const remember = defineTool({ name: 'RememberTest', description: '写记忆', parameters: { type: 'object', properties: {} },
      execute: async (_args, context) => {
        await runtime.memory.write({ scope: 'self', ownerId: context.agentId, tier: 'log', text: '工具刚记下的新事实' });
        return '已记住：工具刚记下的新事实';
      },
    });
    const fake = new FakeProvider({ auto: () => ++calls === 1 ? FakeProvider.toolCalls([{ id: 'r', name: remember.name, arguments: '{}' }]) : FakeProvider.text('记住了') });
    runtime = new AgentRuntime({ ...runtimeOptions(env.dir), tools: [remember], createProvider: () => fake });
    await runtime.ensureDefaultAgent(); const a = (await runtime.registry.list())[0]!;
    await runtime.memory.write({ scope: 'self', ownerId: a.id, tier: 'portrait', text: '原有记忆' });
    await runtime.send(a.id, '记下事实');
    assert.equal(calls, 2);
    assert.equal(promptHash(prefix(fake.calls[0]!)), promptHash(prefix(fake.calls[1]!)));
    assert.ok(fake.calls[1]!.some(item => item.role === 'tool' && item.content?.includes('工具刚记下的新事实')));
  } finally { await env.cleanup(); }
});
