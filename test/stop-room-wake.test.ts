import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AgentRuntime } from '../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, until } from './fakes/test-env.js';
import { defineTool } from '../src/tools/tool.js';

/**
 * 私聊里说一次「停」之后，用户新的群发言必须还能唤醒该智能体（bug_vo3yr2oqk20p）。
 *
 * 设计 docs/执行控制与可靠投递修复设计.md §6.2：用户新的群发言要依据真实用户
 * 事件确定受众，给相关成员签发新命令范围的许可；停止前的旧链来信仍保持 held。
 *
 * 走 HTTP 同一条路径（acceptRoomMessage 只入队，再由收件箱处理器领），
 * 而不是进程内等待式的 postToRoom。为把「甲被唤醒」和「乙本来就没停」区分开，
 * 唤醒用例单独用一个只有甲的群：那个群里任何模型调用只能来自甲。
 */

const TEXT = (text: string) => ({ content: text, toolCalls: [], finishReason: 'stop', usage: null });
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

async function makeRoomRuntime(prefix: string) {
  const env = await tempDataDir(prefix);
  const fake = new FakeProvider();
  const runtime = new AgentRuntime({
    tools: [
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
    ],
    createProvider: () => fake,
    dataDir: env.dir,
    defaultModel: 'fake',
    knownModels: ['fake'],
    budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
    memoryExtraction: false,
    seed: [
      { name: '甲', color: '#a855f7', instructions: '测试' },
      { name: '乙', color: '#38bdf8', instructions: '测试' },
    ],
  });
  await runtime.ensureDefaultAgent();
  const agents = await runtime.registry.list();
  const alpha = agents.find((agent) => agent.name === '甲')!;
  const beta = agents.find((agent) => agent.name === '乙')!;
  // 只有甲的群：这个群里的模型调用只能来自甲，用来精确验证「被停的甲被唤醒」
  const soloRoom = await runtime.rooms.create({ name: '甲的群', memberIds: [alpha.id] });
  return { env, fake, runtime, soloRoom, alpha, beta };
}

/** 私聊里对甲说停止词。停止令不调模型，「在停/停完了」由停止协调器自己写。 */
async function stopInDirectMessage(runtime: AgentRuntime, alphaId: string): Promise<void> {
  await runtime.send(alphaId, '停');
  await until(async () => (await runtime.controlView(alphaId)).autoActivation === 'paused', '甲停下来');
}

describe('停止后的群唤醒（§6.2）', () => {
  it('私聊说「停」后，用户新的群发言仍然唤醒该智能体', async () => {
    const { env, fake, runtime, soloRoom, alpha } = await makeRoomRuntime('stop-room-wake');
    try {
      await stopInDirectMessage(runtime, alpha.id);
      assert.equal(fake.calls.length, 0, '停止回合不调模型');

      // 用户在只有甲的群里发一条新消息：走 HTTP 同一条只入队的路径
      const accepted = await runtime.acceptRoomMessage(soloRoom.id, '还说个事');
      await accepted.execute();

      // 甲的群回合必须真的跑起来（此前它被调用 0 次，来信全 held）
      void runtime.drainInbox(alpha.id).catch(() => undefined);
      await until(async () => fake.pendingCount >= 1, '甲的群回合进入模型');
      assert.equal(fake.calls.length, 1, '这个群里唯一的模型调用必须来自甲');
      fake.release(0, OUT('甲也收到'));
      await until(async () => (await runtime.pendingMail(alpha.id)) === 0, '甲的群投递被确认');
    } finally {
      await runtime.close();
      await env.cleanup();
    }
  });

  it('停止前积压的旧链来信不因新群发言复活，仍保持 held', async () => {
    const { env, fake, runtime, soloRoom, alpha, beta } = await makeRoomRuntime('stop-room-old');
    try {
      // 停止前就到甲收件箱里的旧链来信
      await runtime.inbox.enqueue({
        toAgentId: alpha.id,
        fromAgentId: beta.id,
        fromName: beta.name,
        text: '停止前就在路上的旧信',
        priority: false,
        depth: 0,
      });
      await stopInDirectMessage(runtime, alpha.id);

      // 停止令把积压信件置 held
      const held = (await runtime.inbox.peek(alpha.id)).find((item) => item.text.includes('旧信'));
      assert.equal(held?.disposition, 'held', '停止后积压的旧信应为 held');

      // 用户新的群发言：只为这一轮唤醒甲
      const accepted = await runtime.acceptRoomMessage(soloRoom.id, '新的事情');
      await accepted.execute();
      void runtime.drainInbox(alpha.id).catch(() => undefined);
      await until(async () => fake.pendingCount >= 1, '甲的群回合进入模型');
      fake.release(0, OUT('甲答新的事'));

      // 旧信还在，且仍保持 held（不会被自动执行）
      const still = (await runtime.inbox.peek(alpha.id)).find((item) => item.text.includes('旧信'));
      assert.ok(still, '旧链来信应保留在收件箱里可查');
      assert.equal(still!.disposition, 'held', `旧链来信应保持 held，实际 ${still!.disposition}`);

      // 只跑了一个回合（新群发言），没有为旧信另起回合
      assert.equal(fake.calls.length, 1, `只应为新群发言调用一次模型，实际 ${fake.calls.length} 次`);
    } finally {
      await runtime.close();
      await env.cleanup();
    }
  });
});
