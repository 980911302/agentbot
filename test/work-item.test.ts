import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createAgentServer } from '../src/server/http.js';
import { JsonWorkRepository } from '../src/work/store.js';
import { WorkService, type AcceptResult, type ClarifyResult } from '../src/work/service.js';
import { classifyUserMessage, linkUserMessage, pickOpenWork, titleFrom } from '../src/work/item.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, until } from './fakes/test-env.js';

/** E4.1：WorkItem/WorkStep 成为持久事实；闲聊不建工作；隔天继续能接上 */
const dm = (id: string) => ({ kind: 'dm' as const, id });

/**
 * 断言这次受理拿到的是「工作结果」而不是含糊结果，并收窄类型。
 * 比到处写 `!` 强断言安全：含糊时会在断言处直接失败，而不是后面对 undefined 取值。
 */
function asWork(result: AcceptResult | ClarifyResult | null): AcceptResult {
  assert.ok(result, '这里应当拿到工作结果，实际是 null（被当成闲聊了）');
  assert.notEqual((result as { kind?: string }).kind, 'clarify', '这里不应当是含糊结果');
  return result as AcceptResult;
}

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
      await service.appendStep({
        workId: asWork(accepted).work.id,
        title: '列出检查项',
        status: 'in_progress',
        now: 1001,
      });

      // 重新打开（模拟重启）：同一数据目录读回
      const reopened = new WorkService({ repository: new JsonWorkRepository(env.dir) });
      const work = await reopened.get(asWork(accepted).work.id);
      assert.equal(work?.title, '帮我整理一份发版检查清单');
      assert.equal(work?.status, 'active');
      assert.equal((await reopened.listSteps(asWork(accepted).work.id)).length, 1);
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
      const work = asWork(accepted).work;
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
      assert.equal(asWork(accepted).work.status, 'active');
      assert.equal(asWork(accepted).work.objective, '帮我核对一下工具限额表');
      assert.equal(asWork(accepted).work.revision, 1);
      assert.equal(asWork(accepted).work.originMessageId, 'm1');
      assert.deepEqual(asWork(accepted).work.originChannel, { kind: 'dm', id: 'a1' });
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

      // 隔天（+26 小时）用户继续同一件事。
      // 注意措辞：这句必须是「继续」而不是「修订」——「先只测登录」在 E4.2 里按设计
      // 判为修订（会改写目标），所以那一条另有用例覆盖（见 E4.2 一节）。
      const day2 = day1 + 26 * 60 * 60 * 1000;
      const second = await service.acceptUserMessage({
        agentId: 'a1',
        channel: dm('a1'),
        messageId: 'm2',
        text: '接着把发测的检查项补完',
        now: day2,
      });
      assert.equal(second?.kind, 'continued', '隔天继续要接到同一件工作');
      assert.equal(second?.work.id, first!.work.id, '不能新建第二件');
      assert.equal(second?.work.objective, '帮我跟进这次发测', '原目标不被覆盖');
      assert.equal(second?.work.progressSummary, '接着把发测的检查项补完', '进度记下新要求');
      assert.equal(second?.relation, 'continue', '这句是接着做，不是改范围');
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

      await service.complete(asWork(a).work.id, { summary: '脚本已交付' });
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
      const workId = asWork(accepted).work.id;

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

describe('E4.2 新消息关联到正确的工作', () => {
  it('linkUserMessage：五类关系与含糊不猜', () => {
    const works = [
      { id: 'w1', title: '发测跟进', updatedAt: 10 },
      { id: 'w2', title: '写文档', updatedAt: 20 },
    ];
    // 闲聊
    assert.equal(linkUserMessage('谢谢！', works).relation, 'chat');
    // 没有未完成工作 → 新工作
    assert.equal(linkUserMessage('帮我把发布清单整理一下', []).relation, 'new_work');
    // 明确另一件事
    assert.equal(linkUserMessage('另外帮我把周报也写一下', works).relation, 'new_work');
    // 继续（只说接着做，但有两件且用了「那个」→ 含糊）
    assert.equal(linkUserMessage('继续弄那个', works).relation, 'ambiguous');
    // 只有一件时继续不歧义
    const single = [{ id: 'w1', title: '发测跟进', updatedAt: 10 }];
    assert.deepEqual(linkUserMessage('继续推进', single), {
      relation: 'continue',
      workId: 'w1',
      reason: '接着已有工作说',
    });
    // 修订：收窄范围
    const revised = linkUserMessage('范围改成只测登录', works);
    assert.equal(revised.relation, 'revise');
    assert.equal(revised.workId, 'w2', '只有一件候选指向不明时才含糊；这里用了「范围改成」，按最近一件');
    // 多件 + 含糊指代 + 修订意图 → 交给用户
    assert.equal(linkUserMessage('把它改成只测登录', works).relation, 'ambiguous');
    // 有多件但完全没线索 → 也不猜
    assert.equal(linkUserMessage('把回滚步骤也测一下', works).relation, 'ambiguous');
  });

  it('修订只测登录后：目标被改写、版本 +1，旧版本的执行不能再恢复旧目标（验收 1）', async () => {
    const env = await tempDataDir('work-revise');
    try {
      const service = new WorkService({ repository: new JsonWorkRepository(env.dir) });
      // 1) 先布置「跑全量测试」
      const first = await service.acceptUserMessage({
        agentId: 'a1',
        channel: dm('a1'),
        messageId: 'm1',
        text: '帮我跑一遍全量测试',
        now: 1000,
      });
      assert.equal(first?.kind, 'new');
      const workId = first!.work.id;
      assert.equal(first!.work.objective, '帮我跑一遍全量测试');
      assert.equal(first!.work.revision, 1);

      // 2) 用户改口：「先只测登录」——这是修订（设计 §5 的原文例子）
      const revised = await service.acceptUserMessage({
        agentId: 'a1',
        channel: dm('a1'),
        messageId: 'm2',
        text: '修订：先只测登录',
        now: 2000,
      });
      assert.equal(revised?.kind, 'continued', '修订是接到同一件工作');
      assert.equal((revised as { relation?: string })?.relation, 'revise');
      const work = (revised as { work: { id: string; objective: string; revision: number } }).work;
      assert.equal(work.id, workId, '还是同一件工作');
      assert.equal(work.objective, '修订：先只测登录', '目标被改写');
      assert.equal(work.revision, 2, '版本 +1');
      assert.equal(
        (revised as { revisedFrom?: string }).revisedFrom,
        '帮我跑一遍全量测试',
        '原目标留在 revisedFrom 供复盘',
      );

      // 3) 「旧版本的执行不能恢复旧目标」：拿旧 revision 提交一律被拒
      const stale = await service.get(workId);
      await assert.rejects(
        () => service.update(workId, { progressSummary: '全量测试跑完了' }, { expectedRevision: 1 }),
        /已被其他执行改动/,
      );
      assert.notEqual(
        (await service.get(workId))?.progressSummary,
        '全量测试跑完了',
        '被拒的写回不能落到工作里',
      );
      // 用当前版本才能提交，且写的是新范围
      const ok = await service.update(
        workId,
        { progressSummary: '只测登录：已通过' },
        { expectedRevision: stale!.revision },
      );
      assert.equal(ok.progressSummary, '只测登录：已通过');
      // 步骤里能看到「修订目标（原：…）」这条留痕
      const steps = await service.listSteps(workId);
      assert.ok(steps.some((step) => step.note?.includes('修订目标')));
    } finally {
      await env.cleanup();
    }
  });

  it('闲聊不丢旧任务；含糊时返回候选与建议问句而不改动工作（验收 2）', async () => {
    const env = await tempDataDir('work-chat-keep');
    try {
      const service = new WorkService({ repository: new JsonWorkRepository(env.dir) });
      const first = await service.acceptUserMessage({
        agentId: 'a1',
        channel: dm('a1'),
        messageId: 'm1',
        text: '帮我跟进发测这件事',
        now: 1,
      });
      const second = await service.acceptUserMessage({
        agentId: 'a1',
        channel: dm('a1'),
        messageId: 'm2',
        text: '另外帮我把周报写了',
        now: 2,
      });
      assert.equal((await service.list('a1')).length, 2);

      // 闲聊：返回 null，且两件工作都还在、一个字都没改
      const before = await service.list('a1');
      assert.equal(
        await service.acceptUserMessage({
          agentId: 'a1',
          channel: dm('a1'),
          messageId: 'm3',
          text: '今天天气不错，谢谢你',
          now: 3,
        }),
        null,
      );
      assert.deepEqual(
        (await service.list('a1')).map((item) => item.revision),
        before.map((item) => item.revision),
      );

      // 含糊：返回 clarify + 两个候选，工作仍未被改动
      const vague = await service.acceptUserMessage({
        agentId: 'a1',
        channel: dm('a1'),
        messageId: 'm4',
        text: '把它改成只测登录',
        now: 4,
      });
      assert.equal((vague as { kind?: string })?.kind, 'clarify');
      const clarify = vague as {
        kind: string;
        candidates: Array<{ id: string; title: string }>;
        question: string;
      };
      assert.equal(clarify.candidates.length, 2, '候选要列全，用户才好选');
      assert.match(clarify.question, /SendToUser/, '问句要指明用哪个出口短问');
      assert.match(clarify.question, /别自己猜/);
      assert.deepEqual(
        (await service.list('a1')).map((item) => item.revision),
        before.map((item) => item.revision),
        '含糊期间不改动任何工作',
      );
      assert.notEqual(asWork(first).work.id, asWork(second).work.id, '两件事必须是两件工作');
    } finally {
      await env.cleanup();
    }
  });
});

describe('E4.2 接进真实运行时（假模型）', () => {
  async function startServer(dataDir: string, provider: FakeProvider) {
    const server = await createAgentServer({
      port: 0,
      dataDir,
      rootDir: process.cwd(),
      allowMissingKey: true,
      createProvider: () => provider,
    });
    return { ...server, base: server.url.replace(/\/$/, '') };
  }

  it('brief 带上当前工作；修订后 brief 说的是新目标（验收 1 的链路侧）', async () => {
    const env = await tempDataDir('work-brief');
    try {
      const provider = new FakeProvider({ auto: () => FakeProvider.text('收到') });
      const server = await startServer(env.dir, provider);
      try {
        const agent = await server.runtime.registry.create({ name: '接活的同事', instructions: '测试' });
        await server.runtime.send(agent.id, '帮我跑一遍全量测试');
        let work = await server.runtime.works.openWorkOf(agent.id);
        assert.ok(work, '布置任务后应有工作');

        // 看一眼模型真正收到的 brief（FakeProvider 记录了每次调用）
        const briefOfLastCall = () => {
          const call = provider.calls.at(-1)!;
          const briefMessage = call.find(
            (message) => typeof message.content === 'string' && message.content.includes('【当前工作】'),
          );
          return typeof briefMessage?.content === 'string' ? briefMessage.content : '';
        };
        assert.match(briefOfLastCall(), /【当前工作】/, 'brief 要把当前工作带给模型');
        assert.match(briefOfLastCall(), /帮我跑一遍全量测试/);

        // 用户改口：修订
        await server.runtime.send(agent.id, '先只测登录');
        const revised = await server.runtime.works.openWorkOf(agent.id);
        assert.equal(revised?.id, work!.id, '还是同一件工作');
        assert.equal(revised?.objective, '先只测登录');
        // revision 计数：建（1）→ 首回合写回（2）→ 修订受理（3）→ 本回合写回（4）
        assert.equal(revised?.revision, 4);
        assert.match(briefOfLastCall(), /修订/, 'brief 要说明这是修订');
        assert.match(briefOfLastCall(), /旧目标的执行不再有效/);
      } finally {
        await server.close();
      }
    } finally {
      await env.cleanup();
    }
  });

  it('回合运行中收到修订：旧回合被 park、不会把旧进度写回来（验收 1 的运行时侧）', async () => {
    const env = await tempDataDir('work-stale-write');
    try {
      // 第一次模型调用卡住不放（auto 可以返回 Promise，UI-07 起支持），
      // 好在这一回合跑到一半时插入一次「修订」；之后的调用立即返回。
      let releaseFirst: (() => void) | undefined;
      let callCount = 0;
      const provider = new FakeProvider({
        auto: async () => {
          callCount += 1;
          if (callCount === 1) {
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
            // 第一回合跑的是旧目标，它的结论是这句
            return FakeProvider.text('全量测试已跑完，全部通过');
          }
          // 之后的回合（修订后的新范围）
          return FakeProvider.text('按新范围只测了登录，通过');
        },
      });
      const server = await startServer(env.dir, provider);
      try {
        const agent = await server.runtime.registry.create({ name: '慢同事', instructions: '测试' });
        const first = server.runtime.send(agent.id, '帮我跑一遍全量测试');
        // 等第一回合真的进了模型调用
        await until(async () => callCount === 1, '第一回合进入模型调用');
        const work = await server.runtime.works.openWorkOf(agent.id);
        assert.ok(work);
        assert.equal(work!.revision, 1, '刚受理');

        // 第一回合还卡着，用户改口：revision 推进到 2
        await server.runtime.send(agent.id, '先只测登录');
        const afterRevise = await server.runtime.works.openWorkOf(agent.id);
        // 计数：建（1）→ 修订受理（2）→ 第二回合自己的写回（3）。
        // 第一回合还卡着、拿的是 revision 1，所以它的写回注定被拒。
        assert.equal(afterRevise!.revision, 3);
        assert.equal(afterRevise!.objective, '先只测登录');

        // 放行第一回合：它拿的是「全量测试」那版，写回时必须被拒（让出）
        releaseFirst?.();
        const firstResult = await first.catch((error: unknown) => ({
          content: `ERR ${String(error)}`,
          stopReason: 'error',
        }));
        await new Promise((resolve) => setTimeout(resolve, 50));

        const finalWork = await server.runtime.works.get(work!.id);
        assert.equal(finalWork?.objective, '先只测登录', '新目标不能被旧执行覆盖');
        assert.match(finalWork?.progressSummary ?? '', /只测了登录/, '写回的应是新范围的进度');
        assert.doesNotMatch(
          finalWork?.progressSummary ?? '',
          /全量测试已跑完/,
          '旧 Run 的进度不能写进已修订的工作',
        );
        // 机制说明：旧回合是被执行控制层「停让」的（stopReason=parked、content 为空），
        // 所以它连写回的机会都没有——这是第一道防线；第二道是下面的版本检查用例。
        assert.equal(firstResult.stopReason, 'parked');
        assert.equal((firstResult.content ?? '').trim(), '');
      } finally {
        await server.close();
      }
    } finally {
      await env.cleanup();
    }
  });

  it('含糊消息不进工作：brief 里是短问指令，工作一个都没被改（验收 2 的链路侧）', async () => {
    const env = await tempDataDir('work-ambiguous');
    try {
      const provider = new FakeProvider({ auto: () => FakeProvider.text('好') });
      const server = await startServer(env.dir, provider);
      try {
        const agent = await server.runtime.registry.create({ name: '多活的同事', instructions: '测试' });
        await server.runtime.send(agent.id, '帮我跟进发测这件事');
        await server.runtime.send(agent.id, '另外帮我把周报写了');
        const before = await server.runtime.works.list(agent.id);
        assert.equal(before.length, 2);

        await server.runtime.send(agent.id, '把它改成只测登录');
        const after = await server.runtime.works.list(agent.id);
        assert.deepEqual(
          after.map((item) => item.revision).sort(),
          before.map((item) => item.revision).sort(),
          '含糊时不得改动任何工作',
        );
        const call = provider.calls.at(-1)!;
        const brief = call
          .map((message) => (typeof message.content === 'string' ? message.content : ''))
          .join('\n');
        assert.match(brief, /这条是接着哪件/, 'brief 里要有短问指令');
        assert.match(brief, /SendToUser/, '要指明用哪个出口问');
        assert.doesNotMatch(brief, /【当前工作】/, '含糊时不说「当前工作」，免得模型误以为要直接干');
      } finally {
        await server.close();
      }
    } finally {
      await env.cleanup();
    }
  });
});

describe('E4.2 版本检查本身（第二道防线）', () => {
  it('拿旧 revision 写回进度会被拒；用当前 revision 才能写（旧执行必须让出）', async () => {
    const env = await tempDataDir('work-stale-guard');
    try {
      const service = new WorkService({ repository: new JsonWorkRepository(env.dir) });
      const accepted = await service.acceptUserMessage({
        agentId: 'a1',
        channel: dm('a1'),
        messageId: 'm1',
        text: '帮我跑一遍全量测试',
        now: 1,
      });
      const workId = asWork(accepted).work.id;
      const staleRevision = asWork(accepted).work.revision; // 旧执行手里那版

      // 中途修订：revision 推进
      await service.acceptUserMessage({
        agentId: 'a1',
        channel: dm('a1'),
        messageId: 'm2',
        text: '先只测登录',
        now: 2,
      });
      const now = await service.get(workId);
      assert.notEqual(now!.revision, staleRevision, '修订后版本必须推进');

      // 旧执行带旧版本提交 → 拒绝（这就是「旧 Run 的状态提交必须检查版本」）
      await assert.rejects(
        () =>
          service.update(workId, { progressSummary: '全量测试已跑完' }, { expectedRevision: staleRevision }),
        /已被其他执行改动/,
      );
      assert.notEqual((await service.get(workId))!.progressSummary, '全量测试已跑完');

      // 用当前版本提交才通过
      const ok = await service.update(
        workId,
        { progressSummary: '只测登录：通过' },
        { expectedRevision: now!.revision },
      );
      assert.equal(ok.progressSummary, '只测登录：通过');
    } finally {
      await env.cleanup();
    }
  });

  it('recordWorkProgress 带的是受理时的 revision，冲突时只告警不覆盖', async () => {
    const env = await tempDataDir('work-progress-guard');
    try {
      const server = await createAgentServer({
        port: 0,
        dataDir: env.dir,
        rootDir: process.cwd(),
        allowMissingKey: true,
        createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('好了') }),
      });
      try {
        const agent = await server.runtime.registry.create({ name: '同事', instructions: '测试' });
        const accepted = await server.runtime.works.acceptUserMessage({
          agentId: agent.id,
          channel: { kind: 'dm', id: agent.id },
          messageId: 'm1',
          text: '帮我整理发版清单',
          now: 1,
        });
        const workId = (accepted as { work: { id: string } }).work.id;
        // 造一次「别人改过」：版本推进
        await server.runtime.works.update(workId, { progressSummary: '已被新要求改写' });

        // 用旧快照调写回（等价于一个还在跑的旧回合收尾时的行为）
        const staleLink = {
          kind: 'continued',
          relation: 'continue',
          work: { id: workId, revision: 1 },
        };
        await (
          server.runtime as unknown as {
            recordWorkProgress: (link: unknown, result: { content?: string }) => Promise<void>;
          }
        ).recordWorkProgress(staleLink, { content: '旧回合的结论' });

        const after = await server.runtime.works.get(workId);
        assert.equal(after?.progressSummary, '已被新要求改写', '旧回合的结论不能覆盖新进度');
      } finally {
        await server.close();
      }
    } finally {
      await env.cleanup();
    }
  });
});
