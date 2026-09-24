import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AgentRuntime } from '../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, until } from './fakes/test-env.js';
import { defineTool } from '../src/tools/tool.js';

/**
 * 重启不能把新建的智能体变成暂停（bug_trhd1ffe8580）。
 *
 * migrateExistingAgents 的本意是给升级前的旧智能体补 paused 控制条目，
 * 但它每次启动都对「没有控制条目」的智能体下手，而新建同事务必没写过条目
 * ——于是新建并拉进群的同事一重启就在群里静默，用户还以为它坏了。
 */

const TEXT = (text: string) => ({ content: text, toolCalls: [], finishReason: 'stop', usage: null });
const OUT = (text: string) => ({
  content: null,
  toolCalls: [
    { id: `out-${text}`, name: 'SendToUser', arguments: JSON.stringify({ type: 'text', content: text, end_turn: true }) },
  ],
  finishReason: 'tool_calls',
  usage: null,
});

function build(dataDir: string, fake: FakeProvider, tools = []): AgentRuntime {
  return new AgentRuntime({
    tools,
    createProvider: () => fake,
    dataDir,
    defaultModel: 'fake',
    knownModels: ['fake'],
    budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
    memoryExtraction: false,
    seed: [{ name: '甲', color: '#a855f7', instructions: '测试' }],
  });
}

describe('重启后新建智能体的自动激活状态', () => {
  it('新建并从未私聊过的同事，重启后仍是 enabled 且能在群里回应', async () => {
    const env = await tempDataDir('restart-new-agent');
    try {
      const first = build(env.dir, new FakeProvider(), [
        defineTool<{ type: string; content: string; end_turn?: boolean }>({
          name: 'SendToUser',
          description: '测试用统一出口',
          parameters: { type: 'object', properties: { type: { type: 'string' }, content: { type: 'string' }, end_turn: { type: 'boolean' } }, required: ['type', 'content'] },
          ephemeral: true,
          execute: async (args, context) => {
            await context.room?.publish?.(args.content);
            context.room?.posts.push(args.content);
            if (context.turnState && args.end_turn) {
              context.turnState.lastVisibleText = args.content;
              context.turnState.endTurnRequested = true;
            }
            return '已发送';
          },
        }),
      ]);
      await first.ensureDefaultAgent();
      const rookie = await first.createAgent({ name: '丙' });
      // 只有丙的群：这个群里的模型调用只能来自丙，避免把别人的回合当成丙被唤醒
      const room = await first.rooms.create({ name: '有丙的群', memberIds: [rookie.id] });
      assert.equal((await first.controlView(rookie.id)).autoActivation, 'enabled', '新建时应该就是 enabled');
      await first.close();

      // 重启：全新运行时打开同一份数据目录
      const restarted = build(env.dir, new FakeProvider());
      await restarted.migrateExistingAgents();
      assert.equal(
        (await restarted.controlView(rookie.id)).autoActivation,
        'enabled',
        '重启不该把新建的同事判为暂停',
      );

      // 用户在群里 @丙：它必须真的被唤醒（此前 0 次调用、来信全 held）
      const fake = new FakeProvider();
      const live = build(env.dir, fake, [
        defineTool<{ type: string; content: string; end_turn?: boolean }>({
          name: 'SendToUser',
          description: '测试用统一出口',
          parameters: { type: 'object', properties: { type: { type: 'string' }, content: { type: 'string' }, end_turn: { type: 'boolean' } }, required: ['type', 'content'] },
          ephemeral: true,
          execute: async (args, context) => {
            await context.room?.publish?.(args.content);
            context.room?.posts.push(args.content);
            if (context.turnState && args.end_turn) {
              context.turnState.lastVisibleText = args.content;
              context.turnState.endTurnRequested = true;
            }
            return '已发送';
          },
        }),
      ]);
      await live.recover();
      const accepted = await live.acceptRoomMessage(room.id, `@丙 说个事`);
      await accepted.execute();
      void live.drainInbox(rookie.id).catch(() => undefined);
      await until(async () => fake.pendingCount >= 1, '丙被群发言唤醒', 5000);
      assert.ok(fake.calls.length >= 1, '丙应该被调用');
      fake.release(0, OUT('丙在群里回应了'));

      // 用户可见的现象：丙的发言真的落到群时间线上（此前 0 次调用、来信全 held）
      await until(
        async () =>
          (await live.rooms.messages(room.id, 50)).some(
            (message) => message.senderId === rookie.id && message.text.includes('丙在群里回应了'),
          ),
        '丙的发言落进群时间线',
        5000,
      );
      await live.close();
    } finally {
      await env.cleanup();
    }
  });

  it('工作台建的同事同样登记 enabled，重启后不被暂停', async () => {
    const env = await tempDataDir('restart-workbench-agent');
    try {
      const first = build(env.dir, new FakeProvider());
      await first.ensureDefaultAgent();
      const made = await first.workbench.createAgent({ name: '丁' });
      assert.equal((await first.controlView(made.id)).autoActivation, 'enabled', '工作台建的同事应登记 enabled');
      await first.close();

      const restarted = build(env.dir, new FakeProvider());
      await restarted.migrateExistingAgents();
      assert.equal(
        (await restarted.controlView(made.id)).autoActivation,
        'enabled',
        '重启不该把工作台建的同事判为暂停',
      );
      await restarted.close();
    } finally {
      await env.cleanup();
    }
  });

  it('迁移仍然生效：升级前就没有控制条目的旧智能体照旧进入 paused', async () => {
    const env = await tempDataDir('restart-legacy-agent');
    try {
      // 造一个「升级前」的数据目录：注册表里有同事，控制存储却被清空
      const legacy = build(env.dir, new FakeProvider());
      await legacy.ensureDefaultAgent();
      const old = await legacy.registry.create({ name: '老同事' });
      await legacy.control.transact((draft) => {
        draft.agents = {};
        draft.controlSeq = 3;
      });
      await legacy.close();

      const restarted = build(env.dir, new FakeProvider());
      await restarted.migrateExistingAgents();
      const view = await restarted.controlView(old.id);
      assert.equal(view.autoActivation, 'paused', '升级前的旧智能体仍要按设计进入待确认');
      await restarted.close();
    } finally {
      await env.cleanup();
    }
  });
});
