import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { RoomStore } from '../src/room/store.js';
import { CorrespondenceStore } from '../src/storage/correspondence-store.js';
import { AgentInbox } from '../src/agent/inbox.js';
import { tempDataDir } from './fakes/test-env.js';

describe('幂等投影', () => {
  it('inbox 同 ID 重放返回原文，不同 payload 报冲突', async () => {
    const env = await tempDataDir('proj-inbox');
    try {
      const inbox = new AgentInbox(env.dir);
      const first = await inbox.enqueue({
        id: 'd1',
        toAgentId: 'a',
        fromAgentId: 'b',
        fromName: '乙',
        text: '你好',
        priority: false,
        depth: 0,
      });
      const again = await inbox.enqueue({
        id: 'd1',
        toAgentId: 'a',
        fromAgentId: 'b',
        fromName: '乙',
        text: '你好',
        priority: false,
        depth: 0,
      });
      assert.equal(first.id, again.id);
      await assert.rejects(
        () =>
          inbox.enqueue({
            id: 'd1',
            toAgentId: 'a',
            fromAgentId: 'b',
            fromName: '乙',
            text: '另一句',
            priority: false,
            depth: 0,
          }),
        /INBOX_ID_CONFLICT/,
      );
    } finally {
      await env.cleanup();
    }
  });

  it('群时间线同 ID 不重复追加，不同正文冲突', async () => {
    const env = await tempDataDir('proj-room');
    try {
      const rooms = new RoomStore(env.dir);
      const room = await rooms.create({ name: '牌局', memberIds: ['a'] });
      const message = {
        id: 'm1',
        roomId: room.id,
        roundId: 'r1',
        senderKind: 'agent' as const,
        senderId: 'a',
        senderName: '甲',
        text: '开局',
        mentions: [],
        everyone: false,
        createdAt: 1,
      };
      await rooms.appendIfAbsent(message);
      await rooms.appendIfAbsent(message);
      assert.equal((await rooms.messages(room.id)).length, 1);
      await assert.rejects(
        () => rooms.appendIfAbsent({ ...message, text: '另一句' }),
        /TIMELINE_ID_CONFLICT/,
      );
    } finally {
      await env.cleanup();
    }
  });

  it('往来同 ID 不同 payload 报冲突', async () => {
    const env = await tempDataDir('proj-corr');
    try {
      const store = new CorrespondenceStore(env.dir);
      const transfer = {
        id: 'c1',
        from: { kind: 'agent' as const, id: 'a', name: '甲' },
        to: { kind: 'agent' as const, id: 'b', name: '乙' },
        text: 'hi',
        createdAt: 1,
      };
      assert.equal(await store.record(transfer), true);
      assert.equal(await store.record(transfer), false);
      await assert.rejects(() => store.record({ ...transfer, text: 'bye' }), /CORRESPONDENCE_ID_CONFLICT/);
    } finally {
      await env.cleanup();
    }
  });
});
