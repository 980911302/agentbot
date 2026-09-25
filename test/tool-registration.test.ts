import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createAgentServer } from '../src/server/http.js';
import { TOOL_LIMITS, limitsFor } from '../src/tools/limits.js';
import { declaredReplayPolicyOf, replayPolicyOf } from '../src/tools/policy.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir } from './fakes/test-env.js';

/**
 * OPT-08：新工具必须显式登记限额与恢复分类（src/tools/limits.ts 的注释要求）。
 * 这里不看源码清单，而是把**运行时真正装配出来的工具面**逐个核对，
 * 以后再挂新工具、忘了登记，这个测试就红。
 */

/** 当前工具面的快照：增删工具都要在这里同步（提醒改动者去登记/更新文档） */
const EXPECTED_TOOLS = [
  'AwaitShell',
  'CheckSubagent',
  'CreateAgent',
  'CreateChannel',
  'Edit',
  'ListFiles',
  'ListSections',
  'ManageRoomFlow',
  'MessageSubagent',
  'Read',
  'ReadToolOutput',
  'RecallMemory',
  'SearchFiles',
  'SendToAgent',
  'SendToUser',
  'Shell',
  'StopSubagent',
  'Task',
  'TodoWrite',
  'UpdateAgent',
  'UpdateChannel',
  'WebFetch',
  'WebSearch',
  'Write',
  'update_state',
];

describe('工具面登记（OPT-08）', () => {
  let env: { dir: string; cleanup: () => Promise<void> };
  let names: string[];

  before(async () => {
    env = await tempDataDir('tool-registration');
    const server = await createAgentServer({
      port: 0,
      dataDir: env.dir,
      rootDir: process.cwd(),
      createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('收到') }),
      allowMissingKey: true,
    });
    names = server.runtime.tools.map((tool) => tool.name);
    await server.close();
  });

  after(async () => {
    await env.cleanup();
  });

  it('运行时装配出的每个工具都在 TOOL_LIMITS 里登记（没有回退上限）', () => {
    const missing = names.filter((name) => !TOOL_LIMITS[name]);
    assert.deepEqual(missing, [], `未登记限额：${missing.join('、')}`);
  });

  it('没有重名工具，且工具面与快照一致', () => {
    assert.equal(new Set(names).size, names.length, '工具名重复：' + names.join('、'));
    assert.deepEqual(
      [...names].sort(),
      EXPECTED_TOOLS,
      '工具面变了：新增/删除工具后要同步限额、恢复分类与本快照',
    );
  });

  it('每个工具都有显式恢复分类（不许落到未登记回退）', () => {
    const unclassified = names.filter((name) => declaredReplayPolicyOf(name) === undefined);
    assert.deepEqual(unclassified, [], `未登记恢复分类：${unclassified.join('、')}`);
  });

  it('ManageRoomFlow 有独立限额且按控制面动作归到 manual', () => {
    assert.deepEqual(TOOL_LIMITS.ManageRoomFlow, { input: 8000, output: 4000 });
    assert.notDeepEqual(limitsFor('ManageRoomFlow'), limitsFor('未登记的工具'));
    assert.equal(declaredReplayPolicyOf('ManageRoomFlow'), 'manual');
    assert.equal(replayPolicyOf('ManageRoomFlow'), 'manual');
  });

  it('没登记的工具仍回退成 manual（不因新增校验而放行未知工具）', () => {
    assert.equal(declaredReplayPolicyOf('某个未来工具'), undefined);
    assert.equal(replayPolicyOf('某个未来工具'), 'manual');
    assert.deepEqual(limitsFor('某个未来工具'), { input: 16000, output: 8000 });
  });
});
