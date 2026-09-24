import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createWorkbenchTools } from '../src/tools/builtin/workbench.js';
import { Workbench } from '../src/workbench/service.js';
import { AgentRegistry } from '../src/agent/registry.js';
import { RoomStore } from '../src/room/store.js';
import { MessageStore } from '../src/store/messages.js';
import { tempDataDir } from './fakes/test-env.js';

describe('工作台授权边界', () => {
  it('普通 inbox 授权拒绝所有工作台写工具', async () => {
    const env = await tempDataDir('workbench-inbox-auth');
    try {
      const registry = new AgentRegistry(env.dir, []);
      const rooms = new RoomStore(env.dir);
      const owner = await registry.create({ name: '甲' });
      const target = await registry.create({ name: '乙' });
      const room = await rooms.create({ name: '群', memberIds: [owner.id] });
      const tools = createWorkbenchTools(new Workbench({
        registry,
        rooms,
        messages: new MessageStore(env.dir),
        ownerName: '主人',
        postToRoom: async () => ({ roomName: '群', roundId: 'r' }),
      }));
      const context = {
        agentId: owner.id,
        projectIds: [],
        authorization: {
          ticketId: 't', agentId: owner.id, runId: 'r', taskId: 'task', inputId: 'in', chainId: 'c',
          generation: 0, executionEpoch: 0, processEpoch: 'p', admittedSeq: 1,
          source: 'inbox' as const, state: 'running' as const,
        },
      };
      for (const [name, args] of [
        ['CreateAgent', { name: '不应创建' }],
        ['UpdateAgent', { agent_id: target.id, name: '不应更新' }],
        ['CreateChannel', { name: '不应建群', member_ids: [owner.id] }],
        ['UpdateChannel', { channel_id: room.id, add_member_ids: [target.id] }],
      ] as const) {
        const tool = tools.find((item) => item.name === name)!;
        await assert.rejects(tool.execute(args, context), /普通同事来信/);
      }
    } finally {
      await env.cleanup();
    }
  });
});
