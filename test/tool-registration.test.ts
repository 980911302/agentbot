import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  let tools: Array<{ name: string; parameters: unknown }> = [];

  before(async () => {
    env = await tempDataDir('tool-registration');
    const server = await createAgentServer({
      port: 0,
      dataDir: env.dir,
      rootDir: process.cwd(),
      createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('收到') }),
      allowMissingKey: true,
    });
    tools = server.runtime.tools.map((tool) => ({ name: tool.name, parameters: tool.parameters }));
    names = tools.map((tool) => tool.name);
    await server.close();
  });

  const serverTools = () => tools;

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

  it('每个工具都在两份文档里有条目（工具参考 + 边界审计限额表）', () => {
    // E5.8：工具的 schema / 描述 / 行为 / 文档必须一起走；新工具不能只写代码不写文档
    const reference = readFileSync(join(process.cwd(), 'docs/工具参考.md'), 'utf8');
    const audit = readFileSync(join(process.cwd(), 'docs/工具边界审计.md'), 'utf8');
    const missingReference = names.filter((name) => !new RegExp(`\\b${name}\\b`).test(reference));
    const missingAudit = names.filter((name) => !new RegExp(`^\\| ${name} `, 'm').test(audit));
    assert.deepEqual(missingReference, [], `docs/工具参考.md 缺少：${missingReference.join('、')}`);
    assert.deepEqual(missingAudit, [], `docs/工具边界审计.md 限额表缺少：${missingAudit.join('、')}`);
  });

  it('每个工具的 schema 自洽：required 都在 properties 里、enum 非空、object 关掉额外字段', () => {
    // E5.8：schema 是模型看到的契约，写错等于描述与行为不一致
    const problems: string[] = [];
    const walk = (schema: unknown, path: string): void => {
      if (!schema || typeof schema !== 'object') return;
      const node = schema as {
        type?: string;
        required?: string[];
        properties?: Record<string, unknown>;
        enum?: unknown[];
        items?: unknown;
        additionalProperties?: boolean;
      };
      if (node.type === 'object') {
        const properties = node.properties ?? {};
        for (const key of node.required ?? []) {
          if (!Object.hasOwn(properties, key)) problems.push(`${path}.required 里的 ${key} 不在 properties`);
        }
        if (node.additionalProperties !== false) problems.push(`${path} 未关闭 additionalProperties`);
        for (const [key, child] of Object.entries(properties)) walk(child, `${path}.${key}`);
      }
      if (node.type === 'array') walk(node.items, `${path}[]`);
      if (node.enum && node.enum.length === 0) problems.push(`${path} 的 enum 为空`);
    };
    for (const tool of serverTools()) {
      walk(tool.parameters, tool.name);
      const required = (tool.parameters as { required?: string[] }).required;
      if (required && required.length === 0) problems.push(`${tool.name}.required 是空数组（应省略）`);
    }
    assert.deepEqual(problems, [], problems.join('；'));
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
