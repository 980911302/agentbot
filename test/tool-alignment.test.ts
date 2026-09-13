import { strict as assert } from 'node:assert';
import { FakeProvider } from './fakes/fake-provider.js';
import { ArtifactService } from '../src/tools/services/artifact-service.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { InteractionBroker } from '../src/interaction/broker.js';
import { MemoryStore } from '../src/memory/store.js';
import { createSendToUserTool } from '../src/tools/builtin/send-to-user.js';
import { createShellTools } from '../src/tools/builtin/shell.js';
import { createTaskTools, type TodoItem } from '../src/tools/builtin/task.js';
import { createUpdateStateTools } from '../src/tools/builtin/update-state.js';
import { createWorkbenchTools } from '../src/tools/builtin/workbench.js';
import type { Tool, ToolContext } from '../src/tools/tool.js';
import type { LLMMessage, LLMProvider } from '../src/llm/provider.js';

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'a1',
    projectIds: [],
    turnState: {
      workbench: { agentsCreated: 0, roomsCreated: 0 },
      persistOutgoing: async () => undefined,
    },
    ...overrides,
  };
}

async function runTool(tool: Tool<any>, args: unknown, context: ToolContext): Promise<string> {
  return tool.execute(args as never, context) as Promise<string>;
}

describe('SendToUser（见 docs/工具参考.md）', () => {
  let dir: string;
  let broker: InteractionBroker;
  let tool: Tool<any>;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'send-to-user-'));
    broker = new InteractionBroker();
    tool = createSendToUserTool({
      rootDir: dir,
      broker,
      secrets: {
        put: async (name, value) => {
          await writeFile(join(dir, `${name}.secret`), value, 'utf8');
        },
        names: async () => [],
        get: async () => undefined,
      } as never,
      agentName: async () => '测试员',
      artifacts: new ArtifactService(),
    });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('私聊 text → persistOutgoing', async () => {
    const sent: string[] = [];
    const reply = await runTool(tool, { type: 'text', content: '进展：一半了' }, context({
      turnState: {
        workbench: { agentsCreated: 0, roomsCreated: 0 },
        persistOutgoing: async (text) => {
          sent.push(text);
        },
      },
    }));
    assert.equal(reply, '已发给主人');
    assert.deepEqual(sent, ['进展：一半了']);
  });

  it('群回合默认进群（room.posts），to:"dm" 走私发', async () => {
    const posts: string[] = [];
    const sent: string[] = [];
    const room = { roomId: 'r1', roomName: '群', posts, limit: 3 };
    await runTool(tool, { type: 'text', content: '群里的发言' }, context({ room }));
    assert.deepEqual(posts, ['群里的发言']);

    await runTool(tool, { type: 'text', content: '私下说一句', to: 'dm' }, context({ room, turnState: {
      workbench: { agentsCreated: 0, roomsCreated: 0 },
      persistOutgoing: async (text) => {
        sent.push(text);
      },
    } }));
    assert.deepEqual(sent, ['私下说一句']);
    assert.equal(posts.length, 1, 'dm 不该进群时间线');
  });

  it('widget 弹选项卡并拿回选择', async () => {
    const pending = runTool(
      tool,
      { type: 'widget', widget: { prompt: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] } },
      context(),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const request = broker.list({ agentId: 'a1' }).at(-1);
    assert.ok(request, '卡片应已登记');
    broker.resolve(request!.id, { value: request!.options![0]!.id });
    const reply = await pending;
    assert.match(reply, /用户选了：A/);
  });

  it('secret-request 值进密钥库、不回模型', async () => {
    const pending = runTool(
      tool,
      { type: 'secret-request', secret: { label: '给个 token', name: 'test_token' } },
      context(),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const request = broker.list({ agentId: 'a1' }).at(-1);
    assert.ok(request);
    broker.resolve(request!.id, { secret: 'sk-abc' });
    const reply = await pending;
    assert.match(reply, /看不到明文/);
    const stored = await readFile(join(dir, 'test_token.secret'), 'utf8');
    assert.equal(stored, 'sk-abc');
  });

  it('attachment：工作区文件交付到用户目录', async () => {
    await writeFile(join(dir, 'result.txt'), '交付内容', 'utf8');
    const sent: string[] = [];
    const reply = await runTool(tool, { type: 'attachment', url: 'result.txt' }, context({
      turnState: {
        workbench: { agentsCreated: 0, roomsCreated: 0 },
        persistOutgoing: async (text) => {
          sent.push(text);
        },
      },
    }));
    assert.match(reply, /已交付到/);
    assert.match(sent[0] ?? '', /📎 已交付文件/);
  });
});

describe('update_state（1.5 子集）', () => {
  let dir: string;
  let memory: MemoryStore;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'update-state-'));
    memory = new MemoryStore(dir);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('memory write / forget（原文精确匹配）', async () => {
    const [tool] = createUpdateStateTools({
      memory,
      updateAgent: async () => undefined,
    });
    const reply = await runTool(
      tool,
      { target: 'memory', action: 'write', fact: '主人喜欢简洁的回复', tier: 'profile', scope: 'agent' },
      context(),
    );
    assert.match(reply, /已记下|已合并/);

    const forgotten = await runTool(
      tool,
      { target: 'memory', action: 'forget', fact: '主人喜欢简洁的回复', scope: 'agent' },
      context(),
    );
    assert.match(forgotten, /已忘记 1 条/);
    await assert.rejects(() =>
      runTool(tool, { target: 'memory', action: 'forget', fact: '不存在的一句话', scope: 'agent' }, context()),
    );
  });

  it('profile set 走 registry 更新；routine 明确不支持', async () => {
    const patches: Array<Record<string, unknown>> = [];
    const [tool] = createUpdateStateTools({
      memory,
      updateAgent: async (_agentId, patch) => {
        patches.push(patch);
        return undefined;
      },
    });
    const reply = await runTool(
      tool,
      { target: 'profile', action: 'set', name: '新名字', description: '新职责' },
      context(),
    );
    assert.match(reply, /资料已更新/);
    assert.deepEqual(patches[0], { name: '新名字', instructions: '新职责' });

    await assert.rejects(() =>
      runTool(tool, { target: 'routine', action: 'create' }, context()),
      /暂不支持/,
    );
  });
});

describe('Shell / AwaitShell（1.6 / H）', () => {
  let dir: string;
  let shell: Tool<any>;
  let awaitShell: Tool<any>;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shell-'));
    [shell, awaitShell] = createShellTools();
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('同步执行并拿回输出', async () => {
    const reply = await runTool(shell, { command: 'echo hello-agentbot', description: '回声测试' }, context());
    assert.match(reply, /hello-agentbot/);
    assert.match(reply, /已结束/);
  });

  it('block_until_ms=0 转后台，AwaitShell 等到结果', async () => {
    const started = await runTool(
      shell,
      { command: 'sleep 0.4 && echo background-done', block_until_ms: 0 },
      context(),
    );
    const shellId = /shell_id: (\S+)/.exec(started)?.[1];
    assert.ok(shellId, '应返回 shell_id');

    const reply = await runTool(awaitShell, { shell_id: shellId, block_until_ms: 5000 }, context());
    assert.match(reply, /background-done/);
  });

  it('停止令能杀掉后台进程（registerJob）', async () => {
    const jobs: Array<{ abort: () => void; label: string }> = [];
    await runTool(shell, { command: 'sleep 5', block_until_ms: 0 }, context({
      turnState: {
        workbench: { agentsCreated: 0, roomsCreated: 0 },
        registerJob: (abort, label) => jobs.push({ abort, label }),
      },
    }));
    assert.equal(jobs.length, 1);
    assert.match(jobs[0]!.label, /^shell:/);
    jobs[0]!.abort();
  });
});

describe('Task 工人族（H 组）', () => {
  function makeTools() {
    const provider = new FakeProvider({ auto: () => FakeProvider.text('工人干完了') });
    return createTaskTools({
      provider: provider as never,
      messages: { append: async () => undefined } as never,
      workerTools: () => [],
      maxIterations: 4,
    });
  }

  it('前台 Task：收尾文本就是交付结果', async () => {
    const [task] = makeTools();
    const reply = await runTool(
      task,
      { description: '加一遍', prompt: '把 2 和 3 加起来', subagent_type: 'executor' },
      context(),
    );
    assert.match(reply, /工人干完了/);
  });

  it('后台 Task：Check 看进度，Stop 杀工人', async () => {
    const tools = makeTools();
    const [task, check, , stop] = tools;
    const started = await runTool(
      task!,
      { description: '长活', prompt: '慢慢干', subagent_type: 'executor', run_in_background: true },
      context(),
    );
    const workerId = /worker_id: (\S+)/.exec(started)?.[1];
    assert.ok(workerId);
    assert.match(started, /已开工/);

    const listed = await runTool(check!, {}, context());
    assert.match(listed, /\[running\]|\[done\]/);

    const stopped = await runTool(stop!, { subagent_id: workerId }, context());
    assert.match(stopped, /已停止/);
  });

  it('subagent_type 只支持 executor', async () => {
    const [task] = makeTools();
    await assert.rejects(
      () => runTool(task!, { description: 'x', prompt: 'y', subagent_type: 'computerUse' }, context()),
      /只支持 executor/,
    );
  });
});

describe('TodoWrite（H 组）', () => {
  it('合并与重写，至少 2 条', async () => {
    const tools = createTaskTools({
      provider: new FakeProvider({ auto: () => FakeProvider.text('') }) as never,
      messages: { append: async () => undefined } as never,
      workerTools: () => [],
    });
    const todoWrite = tools[4]!;
    const first = await runTool(
      todoWrite,
      {
        todos: [
          { id: 't1', content: '查资料', status: 'completed' },
          { id: 't2', content: '写报告', status: 'pending' },
        ],
        merge: false,
      },
      context(),
    );
    assert.match(first, /查资料/);
    const second = await runTool(
      todoWrite,
      {
        todos: [
          { id: 't2', content: '写报告', status: 'in_progress' },
          { id: 't3', content: '交付', status: 'pending' },
        ],
        merge: true,
      },
      context(),
    );
    assert.match(second, /in_progress\] 写报告/);
    assert.match(second, /completed\] 查资料/);
    await assert.rejects(() => runTool(todoWrite, { todos: [{ id: 'a', content: '一条', status: 'pending' }], merge: false }, context()));
  });
});

describe('工作台改名（A 组）', () => {
  function fakeWorkbench() {
    return {
      listSections: async () => ['核心组'],
      listAgents: async () => [
        { id: 'a1', name: '测试员', hidden: false, title: '', section: '', color: '#fff' },
        { id: 'a2', name: '乙', hidden: false, title: '', section: '', color: '#fff' },
      ],
      createAgent: async (input: { name: string }) => ({ id: 'new-1', name: input.name, color: '#000' }),
      updateAgent: async (id: string) => ({ id, name: '乙', title: '新简介' }),
      listRooms: async () => [{ id: 'room-1', name: '联调群', memberIds: ['a1', 'a2'] }],
      createRoom: async (_caller: string, input: { name: string; memberIds: string[] }) => ({
        room: { id: 'room-2', name: input.name, memberIds: input.memberIds },
        callerIncluded: true,
      }),
      updateRoom: async (_caller: string, _roomId: string, patch: { memberIds?: string[] }) => ({
        id: 'room-1',
        name: '联调群',
        memberIds: patch.memberIds ?? [],
      }),
      memberNames: async (ids: string[]) => ids,
    } as never;
  }

  it('ListSections / CreateAgent / UpdateAgent / CreateChannel / UpdateChannel 全链', async () => {
    const [listSections, createAgent, updateAgent, createChannel, updateChannel] = createWorkbenchTools(
      fakeWorkbench(),
    );

    assert.match(await runTool(listSections!, {}, context()), /核心组/);

    const created = await runTool(createAgent!, { name: '新同事', description: '干活的' }, context());
    assert.match(created, /id=new-1/);

    const updated = await runTool(updateAgent!, { agent_id: 'a2', name: '乙', description: '新职责' }, context());
    assert.match(updated, /职责已更新/);

    const room = await runTool(
      createChannel!,
      { name: '新群', member_ids: ['a1', 'a2'] },
      context(),
    );
    assert.match(room, /id=room-2/);

    const changed = await runTool(
      updateChannel!,
      { channel_id: 'room-1', add_member_ids: '["a3"]', remove_member_ids: '["a2"]' },
      context(),
    );
    assert.match(changed, /a1、a3/);
  });
});

describe('SendToAgent 记账与名字回退（A 组）', () => {
  it('resolveTarget 命中后只投递，不把同事登记为子任务', async () => {
    const { createSendToAgentTool } = await import('../src/tools/builtin/room.js');
    const dispatched: Array<{ targetId: string; kind: string; text: string }> = [];
    const children: Array<{ agentId: string; via: string }> = [];
    const tool = createSendToAgentTool({
      maxDepth: 3,
      resolveTarget: async (wanted) =>
        wanted === '乙' ? { kind: 'agent', id: 'a2', name: '乙' } : undefined,
      dispatch: async (input) => {
        dispatched.push(input);
        return '已投递';
      },
    });
    const reply = await runTool(
      tool,
      { target_id: '乙', message: '把这事办了' },
      context({
        turnState: {
          workbench: { agentsCreated: 0, roomsCreated: 0 },
          registerChild: (child) => children.push(child),
        },
      }),
    );
    assert.match(reply, /已投递/);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.targetId, 'a2');
    assert.equal(dispatched[0]!.kind, 'agent');
    assert.equal(dispatched[0]!.text, '把这事办了');
    assert.equal(children.length, 0);
  });
});
