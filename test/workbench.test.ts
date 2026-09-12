import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AgentRegistry } from '../src/agent/registry.js';
import { RoomStore } from '../src/room/store.js';
import { MessageStore } from '../src/store/messages.js';
import { ROOM_MEMBER_LIMIT } from '../src/room/types.js';
import { Workbench, WorkbenchError } from '../src/workbench/service.js';

/** 覆盖 docs/工具参考.md 中的权限与写入规则 */
describe('工作台写操作', () => {
  let dir: string;
  let registry: AgentRegistry;
  let rooms: RoomStore;
  let workbench: Workbench;
  let caller: { id: string; name: string };
  let other: { id: string; name: string };
  let posted: Array<{ roomId: string; text: string; exclude: string[] }>;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workbench-'));
    registry = new AgentRegistry(dir, ['calculator', 'remember']);
    rooms = new RoomStore(dir);
    const messages = new MessageStore(dir);
    posted = [];

    workbench = new Workbench({
      registry,
      rooms,
      messages,
      ownerName: '主人',
      postToRoom: async (roomId, text, excludeAgentIds) => {
        posted.push({ roomId, text, exclude: excludeAgentIds });
        return { roomName: '测试群', called: 2, spoke: 1, silent: 1, skipped: [] };
      },
    });

    caller = await registry.create({ name: '测试运维' });
    other = await registry.create({ name: '知识库服务' });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('新建同事', () => {
    it('建完真的进注册表', async () => {
      const created = await workbench.createAgent({ name: '新建验证员', title: '验证用', color: '#30d158' });
      const found = await registry.get(created.id);
      assert.equal(found?.name, '新建验证员');
      assert.equal(found?.title, '验证用');
      assert.equal(found?.color, '#30d158');
    });

    it('拒绝重名（要求改用 update_agent）', async () => {
      await assert.rejects(
        () => workbench.createAgent({ name: '测试运维' }),
        (error: unknown) => error instanceof WorkbenchError && /已经有一个叫/.test(error.message),
      );
    });

    it('拒绝空名字', async () => {
      await assert.rejects(() => workbench.createAgent({ name: '   ' }), WorkbenchError);
    });

    it('拒绝非法色值', async () => {
      await assert.rejects(
        () => workbench.createAgent({ name: '色值验证员', color: 'green' }),
        (error: unknown) => error instanceof WorkbenchError && /#rrggbb/.test(error.message),
      );
    });

    it('新同事默认继承全套工具', async () => {
      const created = await workbench.createAgent({ name: '工具继承验证员' });
      assert.deepEqual(created.toolNames, ['calculator', 'remember']);
    });
  });

  describe('改资料：合并写入，禁止空覆盖', () => {
    it('只改传了的字段', async () => {
      const before = await registry.get(other.id);
      const updated = await workbench.updateAgent(other.id, { title: '只改简介' });
      assert.equal(updated.title, '只改简介');
      assert.equal(updated.name, before?.name, '名字不该被动');
      assert.equal(updated.instructions, before?.instructions, '职责不该被动');
    });

    it('传空字符串等于没传，不会把资料抹空', async () => {
      await workbench.updateAgent(other.id, { title: '有内容的简介' });
      const updated = await workbench.updateAgent(other.id, { title: '   ', name: '' });
      assert.equal(updated.title, '有内容的简介', '空字符串不该覆盖');
      assert.equal(updated.name, '知识库服务');
    });

    it('可以改同事的名字', async () => {
      const target = await workbench.createAgent({ name: '待改名' });
      const updated = await workbench.updateAgent(target.id, { name: '改过名了' });
      assert.equal(updated.name, '改过名了');
    });

    it('改不存在的同事会报错', async () => {
      await assert.rejects(() => workbench.updateAgent('not-exist', { title: 'x' }), WorkbenchError);
    });

    it('可以改自己的资料', async () => {
      const updated = await workbench.updateAgent(caller.id, { avatar: '🛠' });
      assert.equal(updated.avatar, '🛠');
    });
  });

  describe('建群', () => {
    it('建完真的进房间表', async () => {
      const { room } = await workbench.createRoom(caller.id, {
        name: '新建验证群',
        memberIds: [caller.id, other.id],
      });
      const found = await rooms.get(room.id);
      assert.equal(found?.name, '新建验证群');
      assert.equal(found?.memberIds.length, 2);
    });

    it('拒绝重名群（要求改用 update_room）', async () => {
      await assert.rejects(
        () => workbench.createRoom(caller.id, { name: '新建验证群', memberIds: [caller.id] }),
        (error: unknown) => error instanceof WorkbenchError && /已经有一个叫/.test(error.message),
      );
    });

    it('拒绝空成员群', async () => {
      await assert.rejects(
        () => workbench.createRoom(caller.id, { name: '空群', memberIds: [] }),
        (error: unknown) => error instanceof WorkbenchError && /至少要有 1 个成员/.test(error.message),
      );
    });

    it('超过成员上限被拒', async () => {
      const ids = await Promise.all(
        Array.from({ length: ROOM_MEMBER_LIMIT + 2 }, (_, index) =>
          registry.create({ name: `批量验证员${index}` }).then((r) => r.id),
        ),
      );
      await assert.rejects(
        () => workbench.createRoom(caller.id, { name: '超员群', memberIds: ids }),
        (error: unknown) => error instanceof WorkbenchError && /最多/.test(error.message),
      );
    });

    it('不存在的成员 id 被拒', async () => {
      await assert.rejects(
        () => workbench.createRoom(caller.id, { name: '幽灵群', memberIds: ['ghost-id'] }),
        (error: unknown) => error instanceof WorkbenchError && /找不到对应同事/.test(error.message),
      );
    });

    it('调用者不在群里时会明确提示', async () => {
      const { callerIncluded } = await workbench.createRoom(caller.id, {
        name: '别人家的群',
        memberIds: [other.id],
      });
      assert.equal(callerIncluded, false);
    });
  });

  describe('改群：调用者必须已在群里', () => {
    let roomId: string;

    before(async () => {
      const { room } = await workbench.createRoom(caller.id, {
        name: '权限验证群',
        memberIds: [caller.id],
      });
      roomId = room.id;
    });

    it('成员可以加人', async () => {
      const updated = await workbench.updateRoom(caller.id, roomId, {
        memberIds: [caller.id, other.id],
      });
      assert.equal(updated.memberIds.length, 2);
    });

    it('非成员不能改（选人也不能）', async () => {
      const outsider = await registry.create({ name: '局外人' });
      await assert.rejects(
        () => workbench.updateRoom(outsider.id, roomId, { name: '我想改名' }),
        (error: unknown) => error instanceof WorkbenchError && /只有自己也在群里/.test(error.message),
      );
    });

    it('不能把成员删空（解散群只有用户能做）', async () => {
      await assert.rejects(
        () => workbench.updateRoom(caller.id, roomId, { memberIds: [] }),
        (error: unknown) => error instanceof WorkbenchError && /不能把成员删空/.test(error.message),
      );
    });

    it('可以改名', async () => {
      const updated = await workbench.updateRoom(caller.id, roomId, { name: '改过名的群' });
      assert.equal(updated.name, '改过名的群');
    });

    it('改不存在的群会报错', async () => {
      await assert.rejects(() => workbench.updateRoom(caller.id, 'ghost-room', {}), WorkbenchError);
    });
  });

  describe('代群发言（post_to_room）', () => {
    it('非成员不能代群发言', async () => {
      const { room } = await workbench.createRoom(caller.id, {
        name: '外人勿入群',
        memberIds: [other.id],
      });
      await assert.rejects(
        () => workbench.postToRoom(caller.id, room.id, '我要插一句'),
        (error: unknown) => error instanceof WorkbenchError && /你不在这个群里/.test(error.message),
      );
    });

    it('成员发言会扇出，并把自己排除（不能自己叫自己）', async () => {
      const { room } = await workbench.createRoom(caller.id, {
        name: '扇出验证群',
        memberIds: [caller.id, other.id],
      });
      posted.length = 0;
      const result = await workbench.postToRoom(caller.id, room.id, '同步一下状态');
      assert.equal(posted.length, 1);
      assert.deepEqual(posted[0]?.exclude, [caller.id], '应排除调用者自己');
      assert.equal(result.called, 2);
    });

    it('空内容被拒', async () => {
      const { room } = await workbench.createRoom(caller.id, {
        name: '空内容验证群',
        memberIds: [caller.id],
      });
      await assert.rejects(() => workbench.postToRoom(caller.id, room.id, '  '), WorkbenchError);
    });
  });

  describe('权限边界：没有删除入口', () => {
    it('工作台不暴露删除同事 / 解散群的方法', () => {
      const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(workbench));
      assert.ok(!surface.includes('deleteAgent'), '不该有 deleteAgent');
      assert.ok(!surface.includes('removeAgent'), '不该有 removeAgent');
      assert.ok(!surface.includes('deleteRoom'), '不该有 deleteRoom');
      assert.ok(!surface.includes('removeRoom'), '不该有 removeRoom');
    });
  });
});
