import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentServer } from '../src/server/http.js';
import { AgentRegistry } from '../src/agent/registry.js';
import { assembleAgent } from '../src/agent/assemble.js';
import { ToolRegistry } from '../src/tools/registry.js';
import {
  REQUIRED_TOOL_NAMES,
  effectiveToolNames,
  isRequiredTool,
  optionalToolNames,
} from '../src/tools/capabilities.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir } from './fakes/test-env.js';

/**
 * E5.3：工具装卸 —— 必需能力与可选工具分开，卸载持久生效。
 *
 * `AgentRecord.toolNames` 只存「用户给这位同事勾了哪些**可选**工具」（允许空集合）；
 * 必需能力（capabilities.ts）在装配时恒定叠加，所以卸不掉；可选工具一旦被卸，
 * 启动迁移（syncDefaultTools 只补 toolPolicy=default 的记录）不会再补回。
 */

type Server = Awaited<ReturnType<typeof createAgentServer>>;

/** 用例失败时断言会抛异常；不在这里兜底关闭，挂着的 HTTP 服务会让测试进程不退出 */
const openServers = new Set<Server>();

async function bootServer(dataDir: string): Promise<Server> {
  const server = await createAgentServer({
    port: 0,
    dataDir,
    rootDir: process.cwd(),
    createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('收到') }),
    allowMissingKey: true,
  });
  openServers.add(server);
  return server;
}

async function closeServer(server: Server): Promise<void> {
  openServers.delete(server);
  await server.close();
}

after(async () => {
  for (const server of [...openServers]) await closeServer(server).catch(() => undefined);
});

/** 这位同事此刻真正进模型上下文的工具 schema（与 ContextBuilder 同源：assembleAgent → getSchemas） */
async function schemaOf(server: Server, agentId: string): Promise<string[]> {
  const record = await server.runtime.registry.get(agentId);
  assert.ok(record, '同事应该存在');
  const agent = assembleAgent({
    record,
    memory: { refs: [], compaction: null, projectIds: [] },
    tools: server.runtime.tools,
  });
  return ToolRegistry.from(agent.tools)
    .getSchemas()
    .map((schema) => schema.name);
}

describe('卸载可选工具后持久生效（E5.3 验收 1）', () => {
  it('去掉 WebSearch 后该同事的 schema 里没有它，真重启后仍没有', async () => {
    const env = await tempDataDir('capability-uninstall');
    try {
      const first = await bootServer(env.dir);
      const agent = await first.runtime.createAgent({ name: '卸载同事' });
      const before = await schemaOf(first, agent.id);
      assert.ok(before.includes('WebSearch'), `新建同事默认应有 WebSearch：${before.join(',')}`);

      const kept = (await first.runtime.registry.get(agent.id))!.toolNames.filter(
        (name) => name !== 'WebSearch',
      );
      await first.runtime.registry.update(agent.id, { toolNames: kept });
      const uninstalled = await schemaOf(first, agent.id);
      assert.ok(
        !uninstalled.includes('WebSearch'),
        `卸载后 schema 不该有 WebSearch：${uninstalled.join(',')}`,
      );
      assert.ok(uninstalled.includes('WebFetch'), '只该卸掉这一个，同族其他工具要保留');
      await closeServer(first);

      // 真重启：新 registry 从磁盘读回，并走一遍 http.ts 的启动迁移（syncDefaultTools 等）
      const restarted = await bootServer(env.dir);
      const afterRestart = await schemaOf(restarted, agent.id);
      assert.ok(
        !afterRestart.includes('WebSearch'),
        `重启不该把已卸载的 WebSearch 补回：${afterRestart.join(',')}`,
      );
      assert.deepEqual(afterRestart, uninstalled, '重启前后这个同事的工具面应当一致');
      const record = await restarted.runtime.registry.get(agent.id);
      assert.equal(record?.toolPolicy, 'explicit', '卸载会把工具策略落成显式清单');
      await closeServer(restarted);
    } finally {
      await env.cleanup();
    }
  });

  it('可选工具全部卸成空集合也能保存，真重启后仍是空集合', async () => {
    const env = await tempDataDir('capability-empty');
    try {
      const first = await bootServer(env.dir);
      const agent = await first.runtime.createAgent({ name: '空集合同事' });
      await first.runtime.registry.update(agent.id, { toolNames: [] });

      const empty = await first.runtime.registry.get(agent.id);
      assert.deepEqual(empty?.toolNames, [], '空集合必须原样落盘，不能被补齐默认工具');
      assert.equal(empty?.toolPolicy, 'explicit', '空集合是「主动设置」，不是「未配置」');
      await closeServer(first);

      const restarted = await bootServer(env.dir);
      const afterRestart = await restarted.runtime.registry.get(agent.id);
      assert.deepEqual(afterRestart?.toolNames, [], '重启后仍必须是空集合');
      assert.equal(afterRestart?.toolPolicy, 'explicit');
      // 可选工具一个不剩，剩下的只有恒定叠加的必需能力
      assert.deepEqual(
        [...(await schemaOf(restarted, agent.id))].sort(),
        [...REQUIRED_TOOL_NAMES].sort(),
        '空集合时 schema 里只该剩必需能力',
      );
      await closeServer(restarted);
    } finally {
      await env.cleanup();
    }
  });

  it('必需能力不可卸载：显式清单里没勾，装配后依然在 schema 里', async () => {
    const env = await tempDataDir('capability-required');
    try {
      const server = await bootServer(env.dir);
      const agent = await server.runtime.createAgent({ name: '必需能力同事' });
      // 用户只勾两个可选工具，一个必需能力都没勾
      await server.runtime.registry.update(agent.id, { toolNames: ['Read', 'WebSearch'] });

      const record = await server.runtime.registry.get(agent.id);
      assert.deepEqual(record?.toolNames, ['Read', 'WebSearch'], 'toolNames 只记录用户勾选的可选工具');
      const schema = await schemaOf(server, agent.id);
      for (const required of REQUIRED_TOOL_NAMES) {
        assert.ok(schema.includes(required), `必需能力 ${required} 不该被卸掉：${schema.join(',')}`);
        assert.ok(isRequiredTool(required));
      }
      assert.deepEqual(
        effectiveToolNames(record!.toolNames).filter((name) => isRequiredTool(name)),
        [...REQUIRED_TOOL_NAMES],
        '装配用的有效清单恒定包含必需能力',
      );
      assert.ok(!optionalToolNames(REQUIRED_TOOL_NAMES).length, '必需清单里不应混入可选工具');
      await closeServer(server);
    } finally {
      await env.cleanup();
    }
  });

  it('旧续跑快照里没有必需能力时，续跑这一回合也不会把同事弄哑', async () => {
    const env = await tempDataDir('capability-resume');
    try {
      const first = await bootServer(env.dir);
      const agent = await first.runtime.createAgent({ name: '续跑同事' });
      const run = await first.runtime.send(agent.id, '先做一半');
      await closeServer(first);

      // 模拟 E5.3 之前写下的旧账本：续跑快照的授权里根本没有必需能力
      const ledgerPath = join(env.dir, 'runs', 'ledger.json');
      const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
        turns?: Array<{ id: string; continuation?: { authority?: { toolNames?: string[] } } }>;
      };
      let patched = 0;
      for (const turn of ledger.turns ?? []) {
        const names = turn.continuation?.authority?.toolNames;
        if (!Array.isArray(names)) continue;
        for (const required of REQUIRED_TOOL_NAMES)
          assert.ok(names.includes(required), '正常快照应当含必需能力');
        turn.continuation!.authority!.toolNames = names.filter((name) => !isRequiredTool(name));
        patched += 1;
      }
      assert.ok(patched > 0, '应该至少有一条带授权的续跑快照可改');
      await writeFile(ledgerPath, JSON.stringify(ledger), 'utf8');

      const provider = new FakeProvider({ auto: () => FakeProvider.text('接着做完了') });
      const restarted = await createAgentServer({
        port: 0,
        dataDir: env.dir,
        rootDir: process.cwd(),
        createProvider: () => provider,
        allowMissingKey: true,
      });
      openServers.add(restarted);
      await restarted.runtime.send(agent.id, '接着做', { resumeTaskId: run.taskId });
      const offered = provider.offeredTools.at(-1) ?? [];
      for (const required of REQUIRED_TOOL_NAMES) {
        assert.ok(offered.includes(required), `续跑快照再旧也不能让 ${required} 消失：${offered.join(',')}`);
      }
      await closeServer(restarted);
    } finally {
      await env.cleanup();
    }
  });
});

describe('启动迁移口径：未配置 vs 主动设置（E5.3）', () => {
  it('default 记录补新增默认值；显式清单（含空集合）不被补回；老记录按有没有 toolNames 判定', async () => {
    const env = await tempDataDir('capability-migrate');
    try {
      const old = new AgentRegistry(env.dir, ['Read', 'WebSearch']);
      const byDefault = await old.create({ name: '跟随默认' });
      const explicit = await old.create({ name: '显式子集', toolNames: ['Read'] });
      const empty = await old.create({ name: '主动空集合', toolNames: [] });
      // 老版本记录：没有 toolNames 字段 → 视为「未配置」，跟随默认
      const existing = JSON.parse(await readFile(join(env.dir, 'agents.json'), 'utf8')) as unknown[];
      await writeFile(
        join(env.dir, 'agents.json'),
        JSON.stringify([
          ...existing,
          { id: 'legacy-unset', name: '老同事未配置', createdAt: 1, updatedAt: 1 },
          { id: 'legacy-explicit', name: '老同事显式', toolNames: ['Read'], createdAt: 1, updatedAt: 1 },
        ]),
        'utf8',
      );

      // 升级：默认工具集新增一个 NewTool
      const upgraded = new AgentRegistry(env.dir, ['Read', 'WebSearch', 'NewTool']);
      await upgraded.syncDefaultTools();

      assert.deepEqual((await upgraded.get(byDefault.id))?.toolNames, ['Read', 'WebSearch', 'NewTool']);
      assert.deepEqual((await upgraded.get(explicit.id))?.toolNames, ['Read'], '显式子集不该被补回');
      assert.deepEqual((await upgraded.get(empty.id))?.toolNames, [], '主动空集合不该被补回');
      assert.deepEqual((await upgraded.get('legacy-unset'))?.toolNames, ['Read', 'WebSearch', 'NewTool']);
      assert.deepEqual(
        (await upgraded.get('legacy-explicit'))?.toolNames,
        ['Read'],
        '显式清单的老记录也不补',
      );
    } finally {
      await env.cleanup();
    }
  });
});
