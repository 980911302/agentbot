import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AgentInbox } from '../src/agent/inbox.js';
import { CorrespondenceStore } from '../src/storage/correspondence-store.js';
import { RoomStore } from '../src/room/store.js';
import { RuntimeControlStore } from '../src/storage/runtime-control-store.js';
import { DeliveryService } from '../src/server/runtime/delivery-service.js';
import { OutboxProjector } from '../src/server/runtime/outbox-projector.js';
import { tempDataDir } from './fakes/test-env.js';

describe('OutboxProjector', () => {
  it('提交后投影失败再重试：返回原回执，不新建信', async () => {
    const env = await tempDataDir('outbox-retry');
    try {
      const store = await RuntimeControlStore.open(env.dir);
      const service = new DeliveryService(store);
      const inbox = new AgentInbox(env.dir);
      const correspondence = new CorrespondenceStore(env.dir);
      const submitted = await service.submit({
        actorId: 'a1',
        inputId: 'in-1',
        chainId: 'ch-1',
        target: { kind: 'agent', id: 'b1', nameAtSend: '乙' },
        payload: '你好',
      });
      assert.equal(submitted.kind, 'accepted');
      if (submitted.kind !== 'accepted') return;

      const projector = new OutboxProjector({ store, inbox, correspondence });
      await projector.project(submitted.receipt.actionId, {
        from: { kind: 'agent', id: 'a1', name: '甲' },
        to: { kind: 'agent', id: 'b1', name: '乙' },
      });
      const firstCount = (await inbox.peek('b1')).length;
      await projector.project(submitted.receipt.actionId, {
        from: { kind: 'agent', id: 'a1', name: '甲' },
        to: { kind: 'agent', id: 'b1', name: '乙' },
      });
      const second = await inbox.peek('b1');
      assert.equal(second.length, firstCount);
      assert.equal(second[0]?.id, submitted.receipt.deliveryId);
      const again = await service.submit({
        actorId: 'a1',
        inputId: 'in-1',
        chainId: 'ch-1',
        target: { kind: 'agent', id: 'b1', nameAtSend: '乙' },
        payload: '你好',
      });
      assert.equal(again.kind, 'accepted');
      if (again.kind === 'accepted') assert.equal(again.receipt.actionId, submitted.receipt.actionId);
    } finally {
      await env.cleanup();
    }
  });

  it('启动时补齐已提交但未投影的 outbox', async () => {
    const env = await tempDataDir('outbox-recover');
    try {
      const store = await RuntimeControlStore.open(env.dir);
      const service = new DeliveryService(store);
      const submitted = await service.submit({
        actorId: 'a1',
        inputId: 'in-2',
        chainId: 'ch-2',
        target: { kind: 'agent', id: 'b1', nameAtSend: '乙' },
        payload: '补投影',
      });
      assert.equal(submitted.kind, 'accepted');
      const inbox = new AgentInbox(env.dir);
      const correspondence = new CorrespondenceStore(env.dir);
      const projector = new OutboxProjector({ store, inbox, correspondence });
      await projector.recover({
        from: { kind: 'agent', id: 'a1', name: '甲' },
        to: { kind: 'agent', id: 'b1', name: '乙' },
      });
      const items = await inbox.peek('b1');
      assert.equal(items.length, 1);
      assert.equal(items[0]?.text, '补投影');
    } finally {
      await env.cleanup();
    }
  });
});

describe('群投递的广播窗口', () => {
  it('projectRoom 用随投递带入的 roundId，而不是另起一个 actionId', async () => {
    const env = await tempDataDir('outbox-round');
    try {
      const store = await RuntimeControlStore.open(env.dir);
      const service = new DeliveryService(store);
      const inbox = new AgentInbox(env.dir);
      const correspondence = new CorrespondenceStore(env.dir);
      const rooms = new RoomStore(env.dir);
      const room = await rooms.create({ name: '牌局', memberIds: ['a1', 'b1'] });

      const submitted = await service.submit({
        actorId: 'a1',
        inputId: 'in-round-1',
        chainId: 'ch-round-1',
        target: { kind: 'room', id: room.id, nameAtSend: '牌局' },
        payload: '轮到我发言',
        sender: { kind: 'agent', id: 'a1', name: '甲' },
        roomRecipients: [{ id: 'b1', name: '乙', summoned: true }],
        recipientAgentIds: ['b1'],
        recipientCount: 1,
        roundId: 'round-from-user-message',
      });
      assert.equal(submitted.kind, 'accepted');
      if (submitted.kind !== 'accepted') return;

      const projector = new OutboxProjector({ store, inbox, correspondence, rooms });
      await projector.projectRoom(submitted.receipt.actionId);

      // 时间线消息与收件信箱都挂在用户那条消息的窗口上，配额和复盘才能同组
      const timeline = await rooms.messages(room.id);
      assert.equal(timeline.length, 1);
      assert.equal(timeline[0]?.roundId, 'round-from-user-message');
      const letters = await inbox.peek('b1');
      assert.equal(letters.length, 1);
      assert.equal(letters[0]?.room?.roundId, 'round-from-user-message');
      assert.notEqual(timeline[0]?.roundId, submitted.receipt.actionId);
    } finally {
      await env.cleanup();
    }
  });

  it('没有 roundId 的历史记录仍回退到 actionId', async () => {
    const env = await tempDataDir('outbox-round-legacy');
    try {
      const store = await RuntimeControlStore.open(env.dir);
      const service = new DeliveryService(store);
      const inbox = new AgentInbox(env.dir);
      const correspondence = new CorrespondenceStore(env.dir);
      const rooms = new RoomStore(env.dir);
      const room = await rooms.create({ name: '牌局', memberIds: ['a1', 'b1'] });

      const submitted = await service.submit({
        actorId: 'a1',
        inputId: 'in-round-2',
        chainId: 'ch-round-2',
        target: { kind: 'room', id: room.id, nameAtSend: '牌局' },
        payload: '旧记录',
        sender: { kind: 'agent', id: 'a1', name: '甲' },
        roomRecipients: [{ id: 'b1', name: '乙', summoned: true }],
        recipientAgentIds: ['b1'],
        recipientCount: 1,
      });
      assert.equal(submitted.kind, 'accepted');
      if (submitted.kind !== 'accepted') return;

      const projector = new OutboxProjector({ store, inbox, correspondence, rooms });
      await projector.projectRoom(submitted.receipt.actionId);
      const timeline = await rooms.messages(room.id);
      assert.equal(timeline[0]?.roundId, submitted.receipt.actionId);
    } finally {
      await env.cleanup();
    }
  });
});
