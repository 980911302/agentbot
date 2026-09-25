import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createAgentServer } from '../src/server/http.js';
import { JsonWorkRepository } from '../src/work/store.js';
import { WorkService } from '../src/work/service.js';
import { classifyUserMessage, pickOpenWork, titleFrom } from '../src/work/item.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir } from './fakes/test-env.js';

/** E4.1：WorkItem/WorkStep 成为持久事实；闲聊不建工作；隔天继续能接上 */
const dm = (id: string) => ({ kind: 'dm' as const, id });

describe('任务 / 闲聊判定（E4.1）', () => {
  it('托付一件事判为 work', () => {
    for (const text of [
      '帮我把可靠投递的设计整理成一份文档',
      '先修投递缺陷，再补测试',
      '调研一下 SQLite 迁移的代价',
      '把设置页的 Key 状态显示修一下',
    ]) {
      assert.equal(classifyUserMessage(text), 'work', text);
    }
  });

  it('问候、道谢、应答、情绪判为 chat', () => {
    for (const text of ['你好', '在吗？', '谢谢！', '好的', '嗯嗯', '收到', '哈哈哈', 'ok']) {
      assert.equal(classifyUserMessage(text), 'chat', text);
    }
  });

  it('纯提问（无任务落点）与过短内容判为 chat', () => {
    assert.equal(classifyUserMessage('今天星期几？'), 'chat');
    assert.equal(classifyUserMessage('这是谁？'), 'chat');
    assert.equal(classifyUserMessage('看看'), 'chat');
    assert.equal(classifyUserMessage('   '), 'chat');
  });

  it('标题取第一句并截断', () => {
    assert.equal(titleFrom('先修投递缺陷。再补测试'), '先修投递缺陷');
    assert.equal(titleFrom('x'.repeat(100)).length, 60);
  });
});

describe('JsonWorkRepository（E4.1）', () => {
  it('落盘后可重开读回；步骤按工作归集', async () => {
    const env = await tempDataDir('work-store');
    try {
      const service = new WorkService({ repository: new JsonWorkRepository(env.dir) });
      const accepted = await service.acceptUserMessage({
        agentId: 'a1',
        channel: dm('a1'),
        messageId: 'm1',
        text: '帮我整理一份发版检查清单',
        now: 1000,
      });
      assert.ok(accepted);
      await service.appendStep({
        workId: accepted.work.id,
        title: '列出检查项',
        status: 'in_progress',
        now: 1001,
      });

      // 重新打开（模拟重启）：同一数据目录读回
      const reopened = new WorkService({ repository: new JsonWorkRepository(env.dir) });
      const work = await reopened.get(accepted.work.id);
      assert.equal(work?.title, '帮我整理一份发版检查清单');
      assert.equal(work?.status, 'active');
      assert.equal((await reopened.listSteps(accepted.work.id)).length, 1);
    } finally {
      await env.cleanup();
    }
  });

  it('revision 条件更新：版本对不上就拒绝', async () => {
    const env = await tempDataDir('work-revision');
    try {
      const repository = new JsonWorkRepository(env.dir);
      const service = new WorkService({ repository });
      const accepted = await service.acceptUserMessage({
        agentId: 'a1',
        channel: dm('a1'),
        messageId: 'm1',
        text: '写一份接口文档',
      });
      const work = accepted!.work;
      assert.equal(
        await repository.update({ ...work, revision: 2 }, work.revision - 1),
        false,
        '旧版本号必须被拒',
      );
      assert.equal(await repository.update({ ...work, revision: 2 }, work.revision), true);
      assert.equal((await repository.get(work.id))?.revision, 2);
    } finally {
      await env.cleanup();
    }
  });
});

describe('WorkService（E4.1 验收标准 1、2）', () => {
  it('私聊布置任务后生成 WorkItem（验收 1 前半）', async () => {
    const env = await tempDataDir('work-accept');
    try {
      const service = new WorkService({ repository: new JsonWorkRepository(env.dir) });
      const accepted = await service.acceptUserMessage({
        agentId: 'a1',
        channel: dm('a1'),
        messageId: 'm1',
        text: '帮我核对一下工具限额表',
      });
      assert.ok(accepted);
      assert.equal(accepted.kind, 'new');
      assert.equal(accepted.work.status, 'active');
      assert.equal(accepted.work.objective, '帮我核对一下工具限额表');
      assert.equal(accepted.work.revision, 1);
      assert.equal(accepted.work.originMessageId, 'm1');
      assert.deepEqual(accepted.work.originChannel, { kind: 'dm', id: 'a1' });
    } finally {
      await env.cleanup();
    }
  });

  it('闲聊不生成 WorkItem（验收 2）', async () => {
    const env = await tempDataDir('work-chitchat');
    try {
      const service = new WorkService({ repository: new JsonWorkRepository(env.dir) });
      for (const text of ['你好', '谢谢', '今天星期几？', '好的']) {
        assert.equal(
          await service.acceptUserMessage({ agentId: 'a1', channel: dm('a1'), messageId: 'm', text }),
          null,
          text,
        );
      }
      assert.deepEqual(await service.list('a1'), []);
    } finally {
      await env.cleanup();
    }
  });

  it('隔天继续同一工作：接上同一件、目标不变、进度推进（验收 1 后半）', async () => {
    const env = await tempDataDir('work-continue');
    try {
      const service = new WorkService({ repository: new JsonWorkRepository(env.dir) });
      const day1 = 1_700_000_000_000;
      const first = await service.acceptUserMessage({
        agentId: 'a1',
        channel: dm('a1'),
        messageId: 'm1',
        text: '帮我跟进这次发测',
        now: day1,
      });
      assert.equal(first?.kind, 'new');
      await service.appendStep({
        workId: first!.work.id,
        title: '联系运维排期',
        status: 'in_progress',
        now: day1 + 1000,
      });

      // 隔天（+26 小时）用户继续同一件事
      const day2 = day1 + 26 * 60 * 60 * 1000;
      const second = await service.acceptUserMessage({
        agentId: 'a1',
        channel: dm('a1'),
        messageId: 'm2',
        text: '发测范围先只测登录',
        now: day2,
      });
      assert.equal(second?.kind, 'continued', '隔天继续要接到同一件工作');
      assert.equal(second?.work.id, first!.work.id, '不能新建第二件');
      assert.equal(second?.work.objective, '帮我跟进这次发测', '原目标不被覆盖');
      assert.equal(second?.work.progressSummary, '发测范围先只测登录', '进度记下新要求');
      assert.equal(second?.work.updatedAt, day2);
      assert.equal(second?.work.revision, 2, '版本推进');
      assert.equal(await service.list('a1').then((items) => items.length), 1);
      // 步骤两个都在（原有的 + 新要求的）
      assert.equal((await service.listSteps(first!.work.id)).length, 2);
    } finally {
      await env.cleanup();
    }
  });

  it('有多个同事时互不串味；已结束的工作不会被接上', async () => {
    const env = await tempDataDir('work-isolation');
    try {
      const service = new WorkService({ repository: new JsonWorkRepository(env.dir) });
      const a = await service.acceptUserMessage({
        agentId: 'a1',
        channel: dm('a1'),
        messageId: 'm1',
        text: '帮我写一份部署脚本',
      });
      await service.acceptUserMessage({
        agentId: 'a2',
        channel: dm('a2'),
        messageId: 'm2',
        text: '帮我写一份回滚脚本',
      });
      assert.equal((await service.list('a1')).length, 1);
      assert.equal((await service.list('a2')).length, 1);

      await service.complete(a!.work.id, { summary: '脚本已交付' });
      // 完成后再来一条任务是新建，不是接上已结束的那件
      const again = await service.acceptUserMessage({
        agentId: 'a1',
        channel: dm('a1'),
        messageId: 'm3',
        text: '再帮我加一个健康检查',
      });
      assert.equal(again?.kind, 'new');
      assert.equal((await service.list('a1')).length, 2);
    } finally {
      await env.cleanup();
    }
  });

  it('收尾要求交付说明或产物；waiting/paused 不许直接完成', async () => {
    const env = await tempDataDir('work-complete');
    try {
      const service = new WorkService({ repository: new JsonWorkRepository(env.dir) });
      const accepted = await service.acceptUserMessage({
        agentId: 'a1',
        channel: dm('a1'),
        messageId: 'm1',
        text: '帮我整理发版检查清单',
      });
      const workId = accepted!.work.id;

      await assert.rejects(() => service.complete(workId, { summary: '  ' }), /交付说明/);
      await service.update(workId, { status: 'waiting' });
      await assert.rejects(() => service.complete(workId, { summary: '做完了' }), /先把等待/);
      await service.update(workId, { status: 'active' });
      const done = await service.complete(workId, { summary: '清单已交付', artifactIds: ['att_1'] });
      assert.equal(done.status, 'completed');
      assert.equal(done.artifactIds[0], 'att_1');
      assert.ok(done.completedAt);
      // 终态不回退、不重复完成
      await assert.rejects(() => service.update(workId, { status: 'active' }), /不静默复活/);
      await assert.rejects(() => service.complete(workId, { summary: '再来一次' }), /重复完成/);
    } finally {
      await env.cleanup();
    }
  });

  it('pickOpenWork 只挑未结束的，且最近更新的优先', () => {
    const items = [
      { status: 'completed' as const, updatedAt: 5 },
      { status: 'active' as const, updatedAt: 1 },
      { status: 'waiting' as const, updatedAt: 9 },
    ];
    assert.equal(pickOpenWork(items)?.updatedAt, 9);
    assert.equal(pickOpenWork([{ status: 'failed' as const, updatedAt: 1 }]), undefined);
  });
});

describe('工作 HTTP 接口（E4.1 验收标准 3）', () => {
  it('GET /work 列表与过滤、GET /work/:id 带步骤、别的同事读不到', async () => {
    const env = await tempDataDir('work-http');
    try {
      const server = await createAgentServer({
        port: 0,
        dataDir: env.dir,
        rootDir: process.cwd(),
        allowMissingKey: true,
        createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('好') }),
      });
      const base = server.url.replace(/\/$/, '');
      try {
        const agent = await server.runtime.registry.create({ name: '工作的同事', instructions: '测试' });
        // 布置任务（走真实受理路径）与一句闲聊
        const accepted = await server.runtime.acceptMessage(agent.id, '帮我把发版检查清单整理出来');
        await accepted.execute().catch(() => undefined);
        await server.runtime
          .acceptMessage(agent.id, '你好呀')
          .then((r) => r.execute().catch(() => undefined));

        const list = (await (await fetch(`${base}/api/agents/${agent.id}/work`)).json()) as {
          works: Array<{ id: string; title: string; status: string }>;
        };
        assert.equal(list.works.length, 1, '只应有任务这一件，闲聊不建工作');
        const workId = list.works[0]!.id;
        assert.equal(list.works[0]!.status, 'active');

        const filtered = (await (
          await fetch(`${base}/api/agents/${agent.id}/work?status=completed`)
        ).json()) as { works: unknown[] };
        assert.equal(filtered.works.length, 0);

        const detail = (await (await fetch(`${base}/api/agents/${agent.id}/work/${workId}`)).json()) as {
          work: { id: string };
          steps: unknown[];
        };
        assert.equal(detail.work.id, workId);
        assert.ok(Array.isArray(detail.steps));

        // 换一个同事读同一件工作：应当是 404（工作属于别人）
        const other = await server.runtime.registry.create({ name: '别的同事', instructions: '测试' });
        const foreign = await fetch(`${base}/api/agents/${other.id}/work/${workId}`);
        assert.equal(foreign.status, 404);
        const missing = await fetch(`${base}/api/agents/${agent.id}/work/not-a-work`);
        assert.equal(missing.status, 404);
      } finally {
        await server.close();
      }
    } finally {
      await env.cleanup();
    }
  });

  it('TodoWrite 落步到当前工作（E4.1：TodoWrite 关联 WorkItem）', async () => {
    const env = await tempDataDir('work-todo');
    try {
      const server = await createAgentServer({
        port: 0,
        dataDir: env.dir,
        rootDir: process.cwd(),
        allowMissingKey: true,
        createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('好') }),
      });
      try {
        const agent = await server.runtime.registry.create({ name: '待办同事', instructions: '测试' });
        const accepted = await server.runtime.acceptMessage(agent.id, '帮我把发布流程梳理成步骤');
        await accepted.execute().catch(() => undefined);
        const work = await server.runtime.works.openWorkOf(agent.id);
        assert.ok(work, '应有正在进行的工作');

        const todo = server.runtime.tools.find((tool) => tool.name === 'TodoWrite')!;
        await todo.execute(
          {
            merge: false,
            todos: [
              { id: 's1', content: '列出发布步骤', status: 'completed' },
              { id: 's2', content: '补齐回滚步骤', status: 'in_progress' },
            ],
          },
          {
            agentId: agent.id,
            projectIds: [],
            turnState: { workbench: { agentsCreated: 0, roomsCreated: 0 } },
          } as never,
        );
        // 回写是异步的：等一下再断言
        const deadline = Date.now() + 2000;
        let steps = await server.runtime.works.listSteps(work!.id);
        while (steps.length < 2 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          steps = await server.runtime.works.listSteps(work!.id);
        }
        assert.equal(steps.length, 2, 'TodoWrite 的两条应落成两个步骤');
        assert.deepEqual(steps.map((step) => `${step.id}:${step.status}`).sort(), [
          's1:completed',
          's2:in_progress',
        ]);
      } finally {
        await server.close();
      }
    } finally {
      await env.cleanup();
    }
  });
});
