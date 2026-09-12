import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AgentRuntime } from '../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, until, waitFor } from './fakes/test-env.js';

/**
 * E3.7 群可靠投递：
 *   点名按完整成员快照解析（忙不忙不影响谁被点到）；
 *   忙碌成员不再被跳过丢信，而是排队（写进收件箱），空下来补上；
 *   离群/群没了以后，排队的投递在领取时撤销。
 */

const TEXT = (text: string) => ({ content: text, toolCalls: [], finishReason: 'stop', usage: null });

async function makeRoomRuntime(prefix: string) {
  const env = await tempDataDir(prefix);
  const fake = new FakeProvider();
  const runtime = new AgentRuntime({
    tools: [],
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
  const room = await runtime.rooms.create({
    name: '测试群',
    memberIds: agents.map((agent) => agent.id),
  });
  // 注册表的顺序不保证等于播种顺序：按名字定位
  const alpha = agents.find((agent) => agent.name === '甲')!;
  const beta = agents.find((agent) => agent.name === '乙')!;
  return { env, fake, runtime, room, alpha, beta };
}

describe('群可靠投递（E3.7）', () => {
  it('忙碌成员排队不漏信：被点名的忙碌成员空下来后补上这一轮', async () => {
    const { env, fake, runtime, room, alpha, beta } = await makeRoomRuntime('room-queue');
    try {
      const busy = runtime.send(beta.id, '长活');
      await waitFor(() => fake.pendingCount >= 1, '乙的忙回合开始');

      const round = runtime.postToRoom(room.id, `@甲 @乙 说个事`);
      await waitFor(() => fake.pendingCount >= 2, '甲进入回合');
      fake.release(1, TEXT('甲收到'));

      const summary = await round;
      assert.deepEqual(
        summary.queued,
        [beta.name],
        '忙碌成员要排队，不是跳过丢信',
      );
      assert.deepEqual(
        summary.outcomes.map((outcome) => outcome.agentName),
        [alpha.name],
        '空闲成员照常进入这一轮',
      );

      // 排队的投递带全量快照解析出来的点名
      const queued = (await runtime.inbox.peek(beta.id)).filter((item) => item.kind === 'room');
      assert.equal(queued.length, 1);
      assert.equal(queued[0]!.room?.roundId, summary.roundId);
      assert.equal(queued[0]!.room?.summoned, true, '忙碌不影响点名解析');
      assert.equal(queued[0]!.room?.speaker, '主人');
      assert.ok(queued[0]!.text.includes('说个事'));

      // 乙的忙回合收尾后，自己接手排队的群消息
      fake.release(0, TEXT('长活做完了'));
      await busy;
      await waitFor(() => fake.pendingCount >= 3, '乙处理排队的群消息');
      fake.release(2, TEXT('乙也收到'));
      await until(async () => (await runtime.pendingMail(beta.id)) === 0, '排队的投递被确认');
      await until(
        async () => (await runtime.inbox.peek(beta.id)).every((item) => item.kind !== 'room'),
        '队列里不再有群消息',
      );

      // 群里要能看到乙补上的发言（同一条 roundId）
      const timeline = await runtime.rooms.messages(room.id, 50);
      const betaPost = timeline.find(
        (message) => message.senderId === beta.id && message.text.includes('乙也收到'),
      );
      assert.ok(betaPost, '忙完之后发言要落回群里');
      assert.equal(betaPost.roundId, summary.roundId);
    } finally {
      await env.cleanup();
    }
  });

  it('全员都忙：不报错，全部排队等空下来', async () => {
    const { env, fake, runtime, room, alpha, beta } = await makeRoomRuntime('room-all-busy');
    try {
      const turns = [runtime.send(alpha.id, '忙一'), runtime.send(beta.id, '忙二')];
      await waitFor(() => fake.pendingCount >= 2, '两个成员都在忙');

      const summary = await runtime.postToRoom(room.id, '大家看看这个');
      assert.deepEqual(summary.outcomes, []);
      assert.deepEqual(summary.queued.sort(), [alpha.name, beta.name].sort());

      for (const record of [alpha, beta]) {
        const queued = (await runtime.inbox.peek(record.id)).filter((item) => item.kind === 'room');
        assert.equal(queued.length, 1, `${record.name} 应当拿到排队的群消息`);
      }

      fake.release(0, TEXT('忙一完了'));
      fake.release(1, TEXT('忙二完了'));
      await Promise.all(turns);
    } finally {
      await env.cleanup();
    }
  });

  it('离群/群没了：排队的投递在领取时撤销，不跑模型', async () => {
    const { env, fake, runtime, room, alpha, beta } = await makeRoomRuntime('room-left');
    try {
      await runtime.inbox.enqueue({
        toAgentId: alpha.id,
        fromAgentId: 'owner',
        fromName: '主人',
        text: '这条消息已经过时了',
        priority: false,
        depth: 0,
        kind: 'room',
        room: {
          roomId: room.id,
          roomName: room.name,
          roundId: 'round-gone',
          speaker: '主人',
          summoned: true,
        },
      });

      // 甲退出这个群
      await runtime.rooms.setMembers(room.id, [beta.id]);
      const callsBefore = fake.calls.length;
      const result = await runtime.drainInbox(alpha.id);

      assert.equal(result, null, '撤销的投递不产生回合');
      assert.equal(fake.calls.length, callsBefore, '撤销的投递不许跑模型');
      assert.equal(await runtime.pendingMail(alpha.id), 0, '撤销后要确认掉，不留悬挂投递');
      const timeline = await runtime.rooms.messages(room.id, 50);
      assert.ok(
        !timeline.some((message) => message.senderId === alpha.id && message.text.includes('过时')),
        '撤销的投递不能进群时间线',
      );
    } finally {
      await env.cleanup();
    }
  });

  it('同事发言 @ 到的人：转成新的排队投递（受每轮叫醒上限约束）', async () => {
    const { env, fake, runtime, room, alpha, beta } = await makeRoomRuntime('room-mention');
    try {
      // 只让甲在场（乙忙）：甲发言里 @ 乙 → 乙应当拿到排队的投递
      const busy = runtime.send(beta.id, '忙');
      await waitFor(() => fake.pendingCount >= 1, '乙在忙');

      const round = runtime.postToRoom(room.id, '@甲 你安排一下');
      await waitFor(() => fake.pendingCount >= 2, '甲进入回合');
      fake.release(1, TEXT(`好的 @${beta.name} 你来跟进`));
      const summary = await round;
      await waitFor(
        () =>
          runtime.inbox
            .peek(beta.id)
            .then((items) => items.some((item) => item.kind === 'room' && item.room?.speaker === alpha.name)),
        '被同事点名的人排进队',
      );

      fake.release(0, TEXT('忙完了'));
      await busy;
      const queued = (await runtime.inbox.peek(beta.id)).filter((item) => item.kind === 'room');
      // 上限内（两个来源：主人点名 + 同事点名），但不会无限堆积
      assert.ok(queued.length >= 1 && queued.length <= 2, `队列长度 ${queued.length}`);
      assert.equal(summary.roundId, queued[0]!.room?.roundId);
    } finally {
      await env.cleanup();
    }
  });
});
