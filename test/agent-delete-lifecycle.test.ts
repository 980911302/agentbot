import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAgentServer, type AgentServerHandle } from '../src/server/http.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, until } from './fakes/test-env.js';
import { defineTool } from '../src/tools/tool.js';

/**
 * 删除同事要走同一条生命周期，删完不留悬挂数据（bug_x3wyowcuabut）。
 *
 * 此前两个接口各做一半：/api/agents/:id 不查忙碌、不清记忆；/api/bots/:id
 * 查忙碌并清记忆，但两者都不清收件箱、不移出群成员表、不清控制条目与待答卡。
 * 于是已删 id 仍留在群 memberIds 里，点名解析与扇出继续指向不存在的同事。
 */

async function startServer(prefix: string) {
  const env = await tempDataDir(prefix);
  const fake = new FakeProvider();
  const server: AgentServerHandle = await createAgentServer({
    port: 0,
    dataDir: env.dir,
    rootDir: process.cwd(),
    createProvider: () => fake,
    allowMissingKey: true,
  });
  return { env, fake, server, close: async () => { await server.close(); await env.cleanup(); } };
}

async function createAgent(server: AgentServerHandle, name: string) {
  const res = await fetch(`${server.url}api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { agent: { id: string } }).agent;
}

describe('删除同事的生命周期一致性', () => {
  it('删除后从所有群的成员表移出，不留下悬挂 id', async () => {
    const { server, close } = await startServer('delete-agent-rooms');
    try {
      const keeper = await createAgent(server, '留守者');
      const victim = await createAgent(server, '将删者');
      const roomRes = await fetch(`${server.url}api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '测试群', memberIds: [keeper.id, victim.id] }),
      });
      assert.equal(roomRes.status, 201);
      const room = ((await roomRes.json()) as { room: { id: string } }).room;

      const del = await fetch(`${server.url}api/agents/${victim.id}`, { method: 'DELETE' });
      assert.equal(del.status, 200);

      const rooms = await (await fetch(`${server.url}api/rooms`)).json() as { rooms: Array<{ id: string; memberIds: string[] }> };
      const found = rooms.rooms.find((item) => item.id === room.id)!;
      assert.ok(!found.memberIds.includes(victim.id), '已删同事不该留在群成员表里');
      assert.ok(found.memberIds.includes(keeper.id), '别的成员不该被牵连');
    } finally {
      await close();
    }
  });

  it('/api/agents 与 /api/bots 两条删除路径清一样的东西', async () => {
    const { server, close } = await startServer('delete-agent-parity');
    try {
      const viaAgents = await createAgent(server, '甲路径');
      const viaBots = await createAgent(server, '乙路径');

      const delAgents = await fetch(`${server.url}api/agents/${viaAgents.id}`, { method: 'DELETE' });
      assert.equal(delAgents.status, 200);
      const delBots = await fetch(`${server.url}api/bots/${viaBots.id}`, { method: 'DELETE' });
      assert.equal(delBots.status, 200);

      // 两条路径都不该再列出这个同事
      const list = await (await fetch(`${server.url}api/agents`)).json() as { agents: Array<{ id: string }> };
      assert.ok(!list.agents.some((item) => item.id === viaAgents.id), '/api/agents 删除后不该还在列表');
      assert.ok(!list.agents.some((item) => item.id === viaBots.id), '/api/bots 删除后不该还在列表');
      const bots = await (await fetch(`${server.url}api/bots`)).json() as { bots: Array<{ id: string }> };
      assert.ok(!bots.bots.some((item) => item.id === viaBots.id), '/api/bots 删除后不该还在 bots 视图');

      // 控制条目也要清掉：留着会让准入与迁移看到不存在的同事
      const snapshot = server.runtime.activationSnapshot();
      for (const id of [viaAgents.id, viaBots.id]) {
        assert.equal(snapshot.agents[id], undefined, `删除后控制存储不该留着 ${id} 的条目`);
      }
    } finally {
      await close();
    }
  });

  it('正在跑任务的同事删除时返回 409，两条路径一致', async () => {
    const { server, fake, close } = await startServer('delete-agent-busy');
    try {
      const busy = await createAgent(server, '忙者');
      // 让这个同事实打实跑起来（假模型不自动应答，回合会挂着）
      void fetch(`${server.url}api/agents/${busy.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '干个长活' }),
      }).catch(() => undefined);
      await until(async () => fake.pendingCount >= 1, '忙者进入回合', 5000);

      const delAgents = await fetch(`${server.url}api/agents/${busy.id}`, { method: 'DELETE' });
      assert.equal(delAgents.status, 409, '/api/agents 删除忙碌同事也该 409');
      const delBots = await fetch(`${server.url}api/bots/${busy.id}`, { method: 'DELETE' });
      assert.equal(delBots.status, 409, '/api/bots 删除忙碌同事同样 409');

      // 拒绝删除后同事还在，没有被误删
      const list = await (await fetch(`${server.url}api/agents`)).json() as { agents: Array<{ id: string }> };
      assert.ok(list.agents.some((item) => item.id === busy.id), '忙碌时拒绝删除，同事不该消失');
    } finally {
      await close();
    }
  });

  it('删除后收件箱里的积压来信一并清掉', async () => {
    const { server, close } = await startServer('delete-agent-inbox');
    try {
      const victim = await createAgent(server, '有信者');
      // 直接往它的收件箱塞一封同事来信
      const runtime = server.runtime;
      await runtime.inbox.enqueue({
        toAgentId: victim.id,
        fromAgentId: 'someone',
        fromName: '别人',
        text: '删除前就到了的信',
        priority: false,
        depth: 0,
      });
      assert.ok((await runtime.inbox.peek(victim.id)).length > 0, '先确认有积压');

      const del = await fetch(`${server.url}api/agents/${victim.id}`, { method: 'DELETE' });
      assert.equal(del.status, 200);
      assert.equal((await runtime.inbox.peek(victim.id)).length, 0, '删除后收件箱不该留下积压来信');
    } finally {
      await close();
    }
  });
});
