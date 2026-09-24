import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AgentRuntime } from '../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, until, waitFor } from './fakes/test-env.js';
import { MemoryStore } from '../src/memory/store.js';
import { InteractionBroker } from '../src/interaction/broker.js';
import { SecretStore } from '../src/secret/store.js';
import { createAgentTools } from '../src/server/tools.js';
import { RoomFlowStore } from '../src/storage/room-flow-store.js';
import { RoomFlowService } from '../src/server/runtime/room-flow-service.js';
import { ProtocolRegistry, SequentialTurnProtocol } from '../src/server/runtime/room-flow-protocols.js';
import { renderFlowBrief } from '../src/context/flow-brief.js';

const OUT_ROOM = (text: string) => ({
  content: null,
  toolCalls: [
    {
      id: `call-${Date.now()}-${Math.random()}`,
      name: 'SendToUser',
      arguments: JSON.stringify({ type: 'text', content: text, to: 'room', end_turn: true }),
    },
  ],
  finishReason: 'tool_calls' as const,
  usage: null,
});

async function makeTestRoomRuntime(prefix: string) {
  const env = await tempDataDir(prefix);
  const fake = new FakeProvider();
  const memory = new MemoryStore(env.dir);
  const broker = new InteractionBroker();
  const secrets = new SecretStore(env.dir);
  const { tools, bind } = createAgentTools({
    rootDir: env.dir,
    memory,
    secrets,
    broker,
    web: false,
  });

  const runtime = new AgentRuntime({
    tools,
    createProvider: () => fake,
    dataDir: env.dir,
    defaultModel: 'fake',
    knownModels: ['fake'],
    budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
    memoryExtraction: false,
    memoryStore: memory,
    broker,
    secrets,
    seed: [
      { name: '协调者', color: '#6366f1', instructions: '负责组织协调' },
      { name: '智能体甲', color: '#a855f7', instructions: '负责第一阶段分析' },
      { name: '智能体乙', color: '#38bdf8', instructions: '负责第二阶段复核' },
    ],
  });

  bind({
    agentName: async (agentId) => (await runtime.registry.get(agentId))?.name ?? agentId,
    updateAgent: (agentId, patch) => runtime.registry.update(agentId, patch),
    finalizeReply: async () => ({ kind: 'ok', verifiedWholeText: false, statusLines: [] }),
  });

  await runtime.ensureDefaultAgent();
  const agents = await runtime.registry.list();
  const coord = agents.find((a) => a.name === '协调者')!;
  const alpha = agents.find((a) => a.name === '智能体甲')!;
  const beta = agents.find((a) => a.name === '智能体乙')!;

  const room = await runtime.rooms.create({
    name: '项目研发群',
    memberIds: [coord.id, alpha.id, beta.id],
  });

  return { env, fake, runtime, room, coord, alpha, beta, agents };
}

describe('受控群流程与行动权验收测试（Section 21）', () => {
  it('1. 兼容 open 群：未开启受控流程时行为完全向后兼容', async () => {
    const { env, fake, runtime, alpha, beta } = await makeTestRoomRuntime('flow-open-compat');
    try {
      const openRoom = await runtime.rooms.create({
        name: '普通讨论群',
        memberIds: [alpha.id, beta.id],
      });

      // 默认群模式为 open
      const r = await runtime.rooms.get(openRoom.id);
      assert.equal(r?.mode ?? 'open', 'open');
      assert.equal(r?.activeFlowId, undefined);

      // 发送普通群消息带 @点名
      const round = runtime.postToRoom(openRoom.id, `@智能体甲 @智能体乙 开个晨会`);
      await waitFor(() => fake.pendingCount >= 1, '甲被唤醒进入回合');
      fake.release(0, OUT_ROOM('甲已就位'));

      await waitFor(() => fake.pendingCount >= 2, '乙被唤醒进入回合');
      fake.release(1, OUT_ROOM('乙已就位'));

      const summary = await round;
      assert.equal(summary.outcomes.length, 2);

      // 验证群消息记录
      const messages = await runtime.rooms.messages(openRoom.id, 10);
      assert.ok(messages.some((m) => m.text.includes('甲已就位')));
      assert.ok(messages.some((m) => m.text.includes('乙已就位')));
    } finally {
      await runtime.close();
      await env.cleanup();
    }
  });

  it('2. 受控流程启动：群进入 managed 模式，普通消息不再扇出，首个行动者获得 grant 与隔离简报', async () => {
    const { env, fake, runtime, room, coord, alpha, beta } = await makeTestRoomRuntime('flow-start-managed');
    try {
      // 启动受控流程
      const startResult = await runtime.roomFlowService.startFlow({
        roomId: room.id,
        coordinatorId: coord.id,
        protocol: 'sequential-turn',
        participants: [
          { kind: 'agent', id: alpha.id },
          { kind: 'agent', id: beta.id },
        ],
        maxTransitions: 10,
        options: { maxRounds: 2 },
      });

      assert.equal(startResult.status, 'active');
      const flowId = startResult.id;

      // 验证群状态已切换为 managed
      const updatedRoom = await runtime.rooms.get(room.id);
      assert.equal(updatedRoom?.mode, 'managed');
      assert.equal(updatedRoom?.activeFlowId, flowId);

      // 验证普通用户消息在 managed 模式下被 router 接管，不再 open 扇出唤醒全员
      const beforePending = fake.pendingCount;
      await runtime.postToRoom(room.id, '大家注意一下群规');
      assert.equal(fake.pendingCount, beforePending, '受控模式下普通非 await 消息不会直接扇出唤醒全员');

      // 验证第一个行动者 (alpha) 收到带有 replyRoute 的 grant 信件
      const alphaMail = await runtime.inbox.peek(alpha.id);
      const flowLetter = alphaMail.find((m) => m.flowId === flowId);
      assert.ok(flowLetter, '智能体甲的收件箱应有受控流程信件');
      assert.ok(flowLetter.replyRoute, '信件必须带有 signed replyRoute');
      assert.equal(flowLetter.replyRoute.flowId, flowId);
      assert.equal(flowLetter.replyRoute.roomId, room.id);

      // 验证上下文简报 (getBriefForActor)
      const brief = await runtime.roomFlowService.getBriefForActor(flowId, {
        kind: 'agent',
        id: alpha.id,
      });
      assert.ok(brief, '必须能够生成行动者简报');
      const briefText = renderFlowBrief(brief);
      assert.ok(briefText.includes('受控群流程上下文'));
      assert.ok(briefText.includes('顺序轮转协作协议'));
      assert.ok(briefText.includes('SendToUser'));
    } finally {
      await runtime.close();
      await env.cleanup();
    }
  });

  it('3. 独立 Turn 自动续接：Agent A 提交 proposal 后裁决通过，自动唤醒 Agent B 无需人类干预', async () => {
    const { env, fake, runtime, room, coord, alpha, beta } = await makeTestRoomRuntime('flow-auto-handoff');
    try {
      const startResult = await runtime.roomFlowService.startFlow({
        roomId: room.id,
        coordinatorId: coord.id,
        protocol: 'sequential-turn',
        participants: [
          { kind: 'agent', id: alpha.id },
          { kind: 'agent', id: beta.id },
        ],
        maxTransitions: 10,
        options: { maxRounds: 1 },
      });

      const flowId = startResult.id;

      // 让 Agent A 处理收件箱中的 flow 任务
      const drainA = runtime.drainInbox(alpha.id);
      await waitFor(() => fake.pendingCount >= 1, '智能体甲开始回合', 15_000);
      fake.release(0, OUT_ROOM('甲：第一阶段需求分析完成'));
      await drainA;

      // 调度器自动派发下一授权并自动唤醒 Agent B
      // 全量并发跑时 CPU 抢占会让调度链路超过默认 3s，这里显式放宽
      await waitFor(() => fake.pendingCount >= 2, '智能体乙自动进入回合', 15_000);
      fake.release(1, OUT_ROOM('乙：第二阶段复核无误，方案通过'));

      // 验证流程顺利完成（maxRounds=1 已跑完全部参与者）
      await until(async () => {
        const flowRecord = await runtime.roomFlowStore.loadFlow(flowId);
        return flowRecord?.status === 'completed';
      }, '流程状态变为 completed', 15_000);

      // 验证两方发言均写入群时间线：受控房间里发言经投影异步落盘，
      // 比流程 completed 更晚，要显式等而不是读完就断言
      await until(async () => {
        const msgs = await runtime.rooms.messages(room.id, 20);
        return msgs.some((m) => m.text.includes('甲：第一阶段需求分析完成'));
      }, '甲的发言写入群时间线', 15_000);
      await until(async () => {
        const msgs = await runtime.rooms.messages(room.id, 20);
        return msgs.some((m) => m.text.includes('乙：第二阶段复核无误'));
      }, '乙的发言写入群时间线', 15_000);
    } finally {
      await runtime.close();
      await env.cleanup();
    }
  });

  it('4. 人类审批与续接：流程流转至 user 时挂起为 awaiting_user，用户发言后自动唤醒后续执行者', async () => {
    const { env, fake, runtime, room, coord, alpha, beta } = await makeTestRoomRuntime('flow-await-user');
    try {
      // 流程参与者包含用户：Alpha -> User -> Beta
      const startResult = await runtime.roomFlowService.startFlow({
        roomId: room.id,
        coordinatorId: coord.id,
        protocol: 'sequential-turn',
        participants: [
          { kind: 'agent', id: alpha.id },
          { kind: 'user', id: 'user' },
          { kind: 'agent', id: beta.id },
        ],
        maxTransitions: 10,
        options: { maxRounds: 1 },
      });

      const flowId = startResult.id;

      // 甲执行 turn 并提交 proposal
      const drainA = runtime.drainInbox(alpha.id);
      await waitFor(() => fake.pendingCount >= 1, '甲开始');
      fake.release(0, OUT_ROOM('甲的初稿'));
      await drainA;

      // 验证流程当前进入 awaiting_user 状态
      await until(async () => {
        const flow = await runtime.roomFlowStore.loadFlow(flowId);
        return flow?.status === 'awaiting_user';
      }, '流程状态变为 awaiting_user');

      // 用户在群中发言批准
      await runtime.postToRoom(room.id, '主人：方案审批通过，请乙继续执行', {
        senderKind: 'user',
        senderId: 'owner',
      });

      // 验证审批通过后，调度器自动唤醒智能体乙
      await waitFor(() => fake.pendingCount >= 2, '乙在用户审批后自动进入回合');
      fake.release(1, OUT_ROOM('乙：已根据主人审批落实部署'));

      await until(async () => {
        const flow = await runtime.roomFlowStore.loadFlow(flowId);
        return flow?.status === 'completed';
      }, '流程最终 completed');
    } finally {
      await runtime.close();
      await env.cleanup();
    }
  });

  it('5. 单次 Grant 与过期防护：重复提交、篡改/过期 Grant 或版本不匹配均被拒绝', async () => {
    const { env, runtime, room, coord, alpha } = await makeTestRoomRuntime('flow-grant-fencing');
    try {
      const startResult = await runtime.roomFlowService.startFlow({
        roomId: room.id,
        coordinatorId: coord.id,
        protocol: 'sequential-turn',
        participants: [{ kind: 'agent', id: alpha.id }],
        maxTransitions: 10,
        options: { maxRounds: 2 },
      });

      const flowId = startResult.id;
      const grants = await runtime.roomFlowStore.listGrants(flowId);
      const activeGrant = grants.find((g) => g.state === 'active');
      assert.ok(activeGrant, '应生成有效 grant');

      // 正常第一次提交
      const firstSubmit = await runtime.roomFlowService.submitProposal({
        flowId,
        grantId: activeGrant.id,
        actor: { kind: 'agent', id: alpha.id },
        clientActionId: 'act-1',
        content: { text: '正常第一次提交' },
        expectedVersion: activeGrant.expectedVersion,
      });
      assert.equal(firstSubmit.status, 'accepted');

      // 重复使用同一个 grant 提交（单次使用原则）
      const secondSubmit = await runtime.roomFlowService.submitProposal({
        flowId,
        grantId: activeGrant.id,
        actor: { kind: 'agent', id: alpha.id },
        clientActionId: 'act-2',
        content: { text: '第二次提交同一 grant' },
        expectedVersion: firstSubmit.flow.version,
      });
      assert.equal(secondSubmit.status, 'rejected');
      assert.ok(secondSubmit.reason?.includes('not active') || secondSubmit.reason?.includes('失效'));

      // 使用旧版本 expectedVersion 提交（并发冲突 CAS 防护）
      const newGrants = await runtime.roomFlowStore.listGrants(flowId);
      const newGrant = newGrants.find((g) => g.state === 'active');
      assert.ok(newGrant, '应生成下一轮 grant');

      const staleSubmit = await runtime.roomFlowService.submitProposal({
        flowId,
        grantId: newGrant.id,
        actor: { kind: 'agent', id: alpha.id },
        clientActionId: 'act-stale',
        content: { text: '基于旧版本号的提交' },
        expectedVersion: 1, // 已经升到更高版本
      });
      assert.equal(staleSubmit.status, 'stale');

      // 签名校验测试
      const tamperedRoute = { ...newGrant.replyRoute, signature: 'bad-signature' };
      assert.equal(runtime.roomFlowService.verifyReplyRoute(tamperedRoute), false);
    } finally {
      await runtime.close();
      await env.cleanup();
    }
  });

  it('6. Stop 穿透与围栏：暂停/取消流程后撤销 active grants，迟到的 proposal 被围栏拒绝写入群', async () => {
    const { env, runtime, room, coord, alpha } = await makeTestRoomRuntime('flow-stop-fencing');
    try {
      const startResult = await runtime.roomFlowService.startFlow({
        roomId: room.id,
        coordinatorId: coord.id,
        protocol: 'sequential-turn',
        participants: [{ kind: 'agent', id: alpha.id }],
        maxTransitions: 10,
        options: { maxRounds: 2 },
      });

      const flowId = startResult.id;
      const grants = await runtime.roomFlowStore.listGrants(flowId);
      const grant = grants.find((g) => g.state === 'active')!;

      // 暂停流程
      await runtime.roomFlowService.pauseFlow(flowId, '管理员指令暂停');
      const flowAfterPause = await runtime.roomFlowStore.loadFlow(flowId);
      assert.equal(flowAfterPause?.status, 'paused');

      // 验证 active grant 已被撤销
      const grantAfterPause = await runtime.roomFlowStore.getGrant(flowId, grant.id);
      assert.equal(grantAfterPause?.state, 'revoked');

      // 迟到的 proposal 被拒绝
      const lateSubmit = await runtime.roomFlowService.submitProposal({
        flowId,
        grantId: grant.id,
        actor: { kind: 'agent', id: alpha.id },
        clientActionId: 'act-late',
        content: { text: '迟到的产出' },
        publicText: '迟到的产出',
        expectedVersion: grant.expectedVersion,
      });
      assert.equal(lateSubmit.status, 'rejected');

      // 验证群消息没有被迟到的产出污染
      const messages = await runtime.rooms.messages(room.id, 10);
      assert.ok(!messages.some((m) => m.text.includes('迟到的产出')));
    } finally {
      await runtime.close();
      await env.cleanup();
    }
  });

  it('7. 崩溃与重启恢复：模拟服务重启，从 .agentbot/room-flows/<flowId> 恢复状态机与事件日志', async () => {
    const { env, fake, runtime, room, coord, alpha, beta } = await makeTestRoomRuntime('flow-crash-recovery');
    let flowId = '';
    try {
      const startResult = await runtime.roomFlowService.startFlow({
        roomId: room.id,
        coordinatorId: coord.id,
        protocol: 'sequential-turn',
        participants: [
          { kind: 'agent', id: alpha.id },
          { kind: 'agent', id: beta.id },
        ],
        maxTransitions: 10,
        options: { maxRounds: 2 },
      });
      flowId = startResult.id;

      // 推进第一步
      const grants = await runtime.roomFlowStore.listGrants(flowId);
      const g1 = grants.find((g) => g.state === 'active')!;
      await runtime.roomFlowService.submitProposal({
        flowId,
        grantId: g1.id,
        actor: { kind: 'agent', id: alpha.id },
        clientActionId: 'c1',
        content: { text: '重启前第一步' },
        expectedVersion: g1.expectedVersion,
      });

      const flowBeforeClose = await runtime.roomFlowStore.loadFlow(flowId);
      assert.ok(flowBeforeClose);
      assert.equal(flowBeforeClose.version, 2);

      // 关闭 runtime
      await runtime.close();

      // 重新实例化独立的 FlowStore 与 FlowService
      const restoredStore = new RoomFlowStore(env.dir);
      const registry = new ProtocolRegistry();
      registry.register('sequential-turn', new SequentialTurnProtocol());
      const restoredService = new RoomFlowService({
        store: restoredStore,
        rooms: new (await import('../src/room/store.js')).RoomStore(env.dir),
        protocols: registry,
        signingSecret: 'flow-secret-for-test',
      });

      // 从磁盘恢复
      const restoredFlow = await restoredService.getActiveFlowForRoom(room.id);
      assert.ok(restoredFlow, '重启后必须能查到当前活跃流程');
      assert.equal(restoredFlow.id, flowId);
      assert.equal(restoredFlow.version, 2, '版本号必须与重启前一致');
      assert.equal(restoredFlow.protocol, 'sequential-turn');

      // 验证事件完整性
      const events = await restoredStore.readEvents(flowId);
      assert.ok(events.length >= 3, '包含 flow_started, grant_issued, action_committed 等事件');
      assert.equal(events[0]?.type, 'flow_started');
      assert.ok(events.some((e) => e.type === 'action_committed'));

      // 重启后继续执行下一轮
      const pendingGrants = await restoredStore.listGrants(flowId);
      const nextGrant = pendingGrants.find((g) => g.state === 'active')!;
      assert.ok(nextGrant, '必须包含已就绪的下一轮 grant');

      const nextSubmit = await restoredService.submitProposal({
        flowId,
        grantId: nextGrant.id,
        actor: { kind: 'agent', id: beta.id },
        clientActionId: 'c2',
        content: { text: '重启后第二步' },
        expectedVersion: nextGrant.expectedVersion,
      });
      assert.equal(nextSubmit.status, 'accepted');
      assert.equal(nextSubmit.flow.version, 3);
    } finally {
      await env.cleanup();
    }
  });

  it('8. 阻断问题 1 验证：流程正常结束或预算超限后房间恢复为 open，路由器自愈消息黑洞', async () => {
    const { env, fake, runtime, alpha, beta, coord, room } = await makeTestRoomRuntime('flow-blocker-1');
    try {
      const flow = await runtime.roomFlowService.startFlow({
        roomId: room.id,
        coordinatorId: coord.id,
        protocol: 'sequential-turn',
        actors: [
          { kind: 'agent', id: alpha.id },
          { kind: 'agent', id: beta.id },
        ],
        maxTransitions: 2,
        options: { maxRounds: 1 },
      });

      // 房间当前为 managed
      let r = await runtime.rooms.get(room.id);
      assert.equal(r?.mode, 'managed');

      // 推进 2 步达到预算上限
      const g1 = (await runtime.roomFlowStore.listGrants(flow.id)).find((g) => g.state === 'active')!;
      await runtime.roomFlowService.submitProposal({
        flowId: flow.id,
        grantId: g1.id,
        actor: { kind: 'agent', id: alpha.id },
        clientActionId: 'b1-action-1',
        content: { text: '第一步' },
        expectedVersion: g1.expectedVersion,
      });

      const g2 = (await runtime.roomFlowStore.listGrants(flow.id)).find((g) => g.state === 'active')!;
      const res2 = await runtime.roomFlowService.submitProposal({
        flowId: flow.id,
        grantId: g2.id,
        actor: { kind: 'agent', id: beta.id },
        clientActionId: 'b1-action-2',
        content: { text: '第二步' },
        expectedVersion: g2.expectedVersion,
      });

      assert.equal(res2.flow.status, 'completed');

      // 验证房间模式已被自动恢复为 open，不再是 managed
      r = await runtime.rooms.get(room.id);
      assert.equal(r?.mode, 'open', '流程完成后房间模式必须自动恢复为 open');

      // 验证自愈机制：如果房间由于异常残留为 managed 但无活动流程，路由器自动自愈为 open
      await runtime.rooms.setMode(room.id, 'managed', 'stale-flow-id');
      const routeRes = await runtime.roomFlowRouter.route({
        id: 'msg-heal',
        roomId: room.id,
        roundId: 'rnd-heal',
        senderKind: 'user',
        senderId: 'owner',
        senderName: '主人',
        text: '有人在吗？',
        mentions: [],
        everyone: false,
        createdAt: Date.now(),
      });
      assert.equal(routeRes.managed, false, '无活动流程时自愈为非受控');
      assert.equal(routeRes.wakePolicy.kind, 'open_fanout');
      r = await runtime.rooms.get(room.id);
      assert.equal(r?.mode, 'open', '路由器必须将房间自愈重置为 open');
    } finally {
      await env.cleanup();
    }
  });

  it('9. 阻断问题 2 验证：用户在 awaiting_user 状态发言，时间线只写入一次消息，杜绝重复落盘', async () => {
    const { env, fake, runtime, alpha, beta, coord, room } = await makeTestRoomRuntime('flow-blocker-2');
    try {
      // 注册一个包含 await_user 步骤的测试协议
      class AwaitUserProtocol extends SequentialTurnProtocol {
        override next(state: any) {
          if (state.turnIndex === 0) {
            return { kind: 'continue' as const, actors: [{ kind: 'agent' as const, id: alpha.id }], purpose: 'act' as const };
          }
          if (state.turnIndex === 1) {
            return { kind: 'await_user' as const, prompt: '请主人确认' };
          }
          return { kind: 'completed' as const, summary: '已完成' };
        }
      }
      runtime.protocolRegistry.register('test-await-user', new AwaitUserProtocol());

      const flow = await runtime.roomFlowService.startFlow({
        roomId: room.id,
        coordinatorId: coord.id,
        protocol: 'test-await-user',
        actors: [{ kind: 'agent', id: alpha.id }],
      });

      // Agent alpha 提交行动
      const g1 = (await runtime.roomFlowStore.listGrants(flow.id)).find((g) => g.state === 'active')!;
      await runtime.roomFlowService.submitProposal({
        flowId: flow.id,
        grantId: g1.id,
        actor: { kind: 'agent', id: alpha.id },
        clientActionId: 'act-alpha',
        content: { text: '申请执行下一步' },
        expectedVersion: g1.expectedVersion,
      });

      const updatedFlow = await runtime.roomFlowStore.loadFlow(flow.id);
      assert.equal(updatedFlow?.status, 'awaiting_user');

      // 用户发言
      await runtime.roomDispatcher.enqueueMessage(room.id, '批准执行', {
        ownerName: '主人',
      });

      // 查询群消息时间线
      const msgs = await runtime.rooms.messages(room.id, 20);
      const approveMsgs = msgs.filter((m) => m.text === '批准执行');
      assert.equal(approveMsgs.length, 1, '用户发言在群时间线中必须只出现 1 次，不得重复落盘');
    } finally {
      await env.cleanup();
    }
  });

  it('10. 阻断问题 3 验证：ticket 完整持久化 flowId，使流程停止/取消能够按 flowId 穿透杀停执行者', async () => {
    const { env, fake, runtime, alpha, beta, coord, room } = await makeTestRoomRuntime('flow-blocker-3');
    try {
      const flow = await runtime.roomFlowService.startFlow({
        roomId: room.id,
        coordinatorId: coord.id,
        protocol: 'sequential-turn',
        actors: [{ kind: 'agent', id: alpha.id }],
      });

      // 调度后，alpha 的收件箱有一封受控任务信
      const items = await runtime.inbox.peek(alpha.id);
      assert.equal(items.length, 1);
      assert.equal(items[0].flowId, flow.id);
      assert.ok(items[0].grantId);
      assert.ok(items[0].replyRoute);

      // 模拟 processor 准入信件获取 ticket
      const decision = await runtime.activation.tryActivate({
        agentId: alpha.id,
        runId: items[0].id,
        taskId: items[0].id,
        inputId: items[0].id,
        chainId: items[0].chainId ?? flow.chainId,
        source: 'inbox',
        flowId: items[0].flowId,
        flowGrantId: items[0].grantId,
        replyRoute: items[0].replyRoute,
      });

      assert.equal(decision.kind, 'admitted');
      const ticket = decision.ticket;
      assert.equal(ticket.flowId, flow.id, 'ticket 必须包含 flowId');
      assert.equal(ticket.flowGrantId, items[0].grantId, 'ticket 必须包含 flowGrantId');

      // 标记为 running
      await runtime.activation.markRunning(ticket);

      // 查询 active tickets：调度器的自动准入和这里的手动准入都可能已经发生，
      // 以「这个流程、这个智能体名下、带着 flowId 的 ticket」为准，不假设只有一个
      const ticketsByFlow = Object.values(runtime.control.snapshot().tickets).filter(
        (t) => t.flowId === flow.id && t.agentId === alpha.id,
      );
      assert.ok(ticketsByFlow.length >= 1, '该流程至少要有一个 ticket');
      assert.ok(
        ticketsByFlow.some((t) => t.ticketId === ticket.ticketId),
        '手动准入拿到的 ticket 必须带着 flowId 落在流程名下',
      );

      // 按 flowId 作用域停止：撤销的必须正好是这个流程正在执行的 ticket
      const stopOp = await runtime.control.commitStop({
        commandId: 'cmd-stop-flow',
        requestedBy: { kind: 'user', id: 'owner' },
        scope: { kind: 'room_flow', flowId: flow.id },
      });
      const expectedIds = new Set(ticketsByFlow.map((t) => t.ticketId));
      assert.ok(stopOp.targetTicketIds.length >= 1, '必须通过 flowId 撤销正在执行的 ticket');
      for (const id of stopOp.targetTicketIds) {
        assert.ok(expectedIds.has(id), '撤销目标必须属于这个流程');
      }
      assert.ok(stopOp.targetTicketIds.includes(ticket.ticketId), '本 ticket 必须被撤销');
    } finally {
      await env.cleanup();
    }
  });

  it('11. 阻断问题 4 验证：Outbox 事务一致性，状态落盘后异步派发消息与调度，并在服务重启时自动恢复', async () => {
    const { env, fake, runtime, alpha, beta, coord, room } = await makeTestRoomRuntime('flow-blocker-4');
    try {
      const store = runtime.roomFlowStore;
      const flow = await runtime.roomFlowService.startFlow({
        roomId: room.id,
        coordinatorId: coord.id,
        protocol: 'sequential-turn',
        actors: [{ kind: 'agent', id: alpha.id }],
      });

      // transact 中 enqueueOutbox 会被可靠持久化到 <flowId>/outbox.jsonl
      await store.transact(flow.id, (context) => {
        context.enqueueOutbox({
          flowId: flow.id,
          kind: 'timeline_message',
          payload: {
            roomId: room.id,
            messageId: 'outbox-msg-1',
            roundId: 'rnd-1',
            senderKind: 'agent',
            senderId: alpha.id,
            senderName: '智能体甲',
            text: '未派发的 Outbox 消息',
          },
        });
      });

      // 检查待派发列表
      const pendingBefore = await store.listPendingOutbox(flow.id);
      assert.ok(pendingBefore.some((item) => item.kind === 'timeline_message' && item.payload.messageId === 'outbox-msg-1'));

      // 调用 recoverOutbox 触发派发
      let delivered = false;
      runtime.roomFlowService['deps'].publishTimelineMessage = async (msg) => {
        if (msg.id === 'outbox-msg-1') delivered = true;
      };
      await runtime.roomFlowService.recoverOutbox();

      assert.equal(delivered, true, '服务恢复时必须补发 pending outbox');
      const pendingAfter = await store.listPendingOutbox(flow.id);
      assert.equal(pendingAfter.filter((item) => item.payload && (item.payload as any).messageId === 'outbox-msg-1').length, 0, '已派发项不再处于 pending');
    } finally {
      await env.cleanup();
    }
  });

  it('12. 阻断问题 5 验证：未显式指定 signingSecret 时自动落盘持久化密钥，重启后 pre-restart replyRoute HMAC 依然有效', async () => {
    const env = await tempDataDir('flow-secret-persist');
    try {
      const store1 = new RoomFlowStore(env.dir);
      const secret1 = store1.getOrCreateSigningSecretSync();
      assert.ok(secret1 && secret1.length >= 32, '必须生成高强度密钥');

      const service1 = new RoomFlowService({
        store: store1,
        rooms: new (await import('../src/room/store.js')).RoomStore(env.dir),
        protocols: new ProtocolRegistry(),
      });

      const route = (await import('../src/shared/contracts/room-flow.js')).createSignedReplyRoute(secret1, {
        kind: 'room_flow',
        roomId: 'r1',
        flowId: 'f1',
        grantId: 'g1',
        mode: 'proposal',
      });
      assert.equal(service1.verifyReplyRoute(route), true);

      // 重新实例化，不传入 signingSecret
      const store2 = new RoomFlowStore(env.dir);
      const secret2 = store2.getOrCreateSigningSecretSync();
      assert.equal(secret2, secret1, '重启后读取的密钥必须与重启前完全一致');

      const service2 = new RoomFlowService({
        store: store2,
        rooms: new (await import('../src/room/store.js')).RoomStore(env.dir),
        protocols: new ProtocolRegistry(),
      });

      // 重启后的 service 依然能验证重启前签署的 route
      assert.equal(service2.verifyReplyRoute(route), true, '重启后 pre-restart route 签名必须有效');
    } finally {
      await env.cleanup();
    }
  });

  it('13. 间隙验证：grant.expiresAt 过期校验与 clientActionId 幂等性支持', async () => {
    const { env, fake, runtime, alpha, coord, room } = await makeTestRoomRuntime('flow-gaps-1');
    try {
      const flow = await runtime.roomFlowService.startFlow({
        roomId: room.id,
        coordinatorId: coord.id,
        protocol: 'sequential-turn',
        actors: [{ kind: 'agent', id: alpha.id }],
      });

      // 1. 幂等性测试
      const g1 = (await runtime.roomFlowStore.listGrants(flow.id)).find((g) => g.state === 'active')!;
      const res1 = await runtime.roomFlowService.submitProposal({
        flowId: flow.id,
        grantId: g1.id,
        actor: { kind: 'agent', id: alpha.id },
        clientActionId: 'unique-idempotent-action',
        content: { text: '行动内容' },
        expectedVersion: g1.expectedVersion,
      });
      assert.equal(res1.status, 'accepted');
      assert.equal(res1.duplicated, undefined);

      // 再次以相同 clientActionId 提交
      const res2 = await runtime.roomFlowService.submitProposal({
        flowId: flow.id,
        grantId: g1.id,
        actor: { kind: 'agent', id: alpha.id },
        clientActionId: 'unique-idempotent-action',
        content: { text: '行动内容' },
        expectedVersion: g1.expectedVersion,
      });
      assert.equal(res2.status, 'accepted', '相同 clientActionId 幂等命中');
      assert.equal(res2.duplicated, true, '标记为 duplicated');
      assert.equal(res2.committedMessageId, res1.committedMessageId);

      // 2. 过期测试：伪造一个已过期的 grant
      const expiredGrantId = 'expired-grant';
      await runtime.roomFlowStore.transact(flow.id, (context) => {
        context.issueGrant({
          id: expiredGrantId,
          flowId: flow.id,
          roomId: room.id,
          actor: { kind: 'agent', id: alpha.id },
          issuedBy: coord.id,
          expectedVersion: context.flow.version,
          purpose: 'act',
          replyRoute: { kind: 'room_flow', roomId: room.id, flowId: flow.id, grantId: expiredGrantId, mode: 'proposal', signature: 's' },
          publishPolicy: 'proposal',
          state: 'active',
          expiresAt: new Date(Date.now() - 1000).toISOString(), // 已过期
        });
      });

      const expRes = await runtime.roomFlowService.submitProposal({
        flowId: flow.id,
        grantId: expiredGrantId,
        actor: { kind: 'agent', id: alpha.id },
        clientActionId: 'expired-action',
        content: { text: '迟到的行动' },
        expectedVersion: (await runtime.roomFlowStore.loadFlow(flow.id))!.version,
      });
      assert.equal(expRes.status, 'rejected');
      assert.ok(expRes.reason?.includes('过期'), '必须被过期校验拒绝');
    } finally {
      await env.cleanup();
    }
  });

  it('14. 间隙验证：startFlow 校验协调者与参与者必须在房间成员列表中', async () => {
    const { env, fake, runtime, alpha, beta, coord, room } = await makeTestRoomRuntime('flow-gaps-2');
    try {
      // 协调者不在房间
      await assert.rejects(
        () => runtime.roomFlowService.startFlow({
          roomId: room.id,
          coordinatorId: 'outsider-coordinator',
          protocol: 'sequential-turn',
          actors: [{ kind: 'agent', id: alpha.id }],
        }),
        (err: any) => err.code === 'COORDINATOR_NOT_IN_ROOM' && err.message.includes('协调者'),
      );

      // 参与者智能体不在房间
      await assert.rejects(
        () => runtime.roomFlowService.startFlow({
          roomId: room.id,
          coordinatorId: coord.id,
          protocol: 'sequential-turn',
          actors: [{ kind: 'agent', id: 'outsider-agent' }],
        }),
        (err: any) => err.code === 'ACTOR_NOT_IN_ROOM' && err.message.includes('参与者'),
      );
    } finally {
      await env.cleanup();
    }
  });

  it('15. 停止令与恢复指令：用户在受控房间说“停”自动暂停流程并杀停任务，说“继续”自动恢复', async () => {
    const { env, fake, runtime, alpha, beta, coord, room } = await makeTestRoomRuntime('flow-stop-resume');
    try {
      const flow = await runtime.roomFlowService.startFlow({
        roomId: room.id,
        coordinatorId: coord.id,
        protocol: 'sequential-turn',
        actors: [
          { kind: 'agent', id: alpha.id },
          { kind: 'agent', id: beta.id },
        ],
      });

      assert.equal(flow.status, 'active');

      // 模拟正在执行并存在关联 ticket
      const act = await runtime.activation.tryActivate({
        agentId: alpha.id,
        runId: 'alpha-run-stop-test',
        taskId: 'task-1',
        inputId: 'input-1',
        chainId: flow.chainId,
        source: 'room',
        flowId: flow.id,
      });
      assert.equal(act.kind, 'admitted');
      if (act.kind === 'admitted') {
        await runtime.activation.markRunning(act.ticket);
      }

      // 用户在群里发停止令
      await runtime.roomDispatcher.enqueueMessage(room.id, '停');

      // 验证流程被持久化为 paused
      const pausedFlow = await runtime.roomFlowStore.loadFlow(flow.id);
      assert.equal(pausedFlow?.status, 'paused');

      // 验证 ticket 被撤销
      if (act.kind === 'admitted') {
        const liveTicket = runtime.activation.getTicket(act.ticket.ticketId);
        assert.equal(liveTicket?.state, 'revoked');
      }

      // 验证所有 grant 均被 revoke
      const grants = await runtime.roomFlowStore.listGrants(flow.id);
      assert.ok(grants.every((g) => g.state === 'revoked'));

      // 用户在群里说“继续”
      await runtime.roomDispatcher.enqueueMessage(room.id, '继续');

      // 验证流程已恢复为 active 并签发了新版本和新授权
      const resumedFlow = await runtime.roomFlowStore.loadFlow(flow.id);
      assert.equal(resumedFlow?.status, 'active');
      assert.ok(resumedFlow!.version > pausedFlow!.version);

      const newGrants = await runtime.roomFlowStore.listGrants(flow.id);
      assert.ok(newGrants.some((g) => g.state === 'active'));
    } finally {
      await env.cleanup();
    }
  });
});
