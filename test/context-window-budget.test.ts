import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseContextWindow } from '../src/shared/contracts/model-catalog.js';
import {
  budgetForWindow,
  DEFAULT_BUDGET,
  DEFAULT_CONTEXT_CEILING,
  estimateTokens,
  MIN_CONTEXT_BUDGET,
} from '../src/context/budget.js';
import { resolveConfig } from '../src/config.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { AgentService } from '../src/server/runtime/agent-service.js';
import { AgentLoop } from '../src/agent/agent-loop.js';
import { defineTool } from '../src/tools/tool.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir } from './fakes/test-env.js';

describe('上下文预算：默认 1M，模型实际上限更小时自动收缩', () => {
  it('解析上限写法：K 按 1000、M 按百万，纯数字按 token；解析不了返回 undefined', () => {
    assert.equal(parseContextWindow('128K'), 128_000);
    assert.equal(parseContextWindow(' 200k '), 200_000);
    assert.equal(parseContextWindow('1M'), 1_000_000);
    assert.equal(parseContextWindow('1000K'), 1_000_000);
    assert.equal(parseContextWindow('1.5m'), 1_500_000);
    assert.equal(parseContextWindow('131072'), 131_072);
    assert.equal(parseContextWindow('64K tokens'), 64_000);
    for (const bad of [undefined, '', 'abc', '2K', '-128K', '128KB', 'K', '1e9']) {
      assert.equal(parseContextWindow(bad), undefined, String(bad));
    }
  });

  it('预算默认取上限（1M）；已知的模型上限更小时按它来；各段上限不放大', () => {
    assert.equal(DEFAULT_CONTEXT_CEILING, 1_000_000);
    assert.equal(budgetForWindow(DEFAULT_BUDGET, undefined).total, 1_000_000);
    assert.equal(budgetForWindow(DEFAULT_BUDGET, 128_000).total, 128_000);
    assert.equal(budgetForWindow(DEFAULT_BUDGET, 2_000_000).total, 1_000_000, '不超过上限');
    assert.equal(budgetForWindow(DEFAULT_BUDGET, 8_000).total, MIN_CONTEXT_BUDGET);
    assert.equal(budgetForWindow(DEFAULT_BUDGET, undefined, 300_000).total, 300_000);
    assert.deepEqual(budgetForWindow(DEFAULT_BUDGET, 128_000).sections, DEFAULT_BUDGET.sections);
  });

  it('环境变量：上下文上限与每轮额度可配，非法值回落默认并夹在安全范围内', () => {
    const base = resolveConfig({ env: {}, allowMissingKey: true, loadEnvFile: false });
    assert.equal(base.contextCeiling, 1_000_000);
    assert.deepEqual(base.turn, { maxIterations: 64, maxToolCalls: 256, maxToolChars: 1_000_000 });
    const custom = resolveConfig({
      env: {
        AGENT_MAX_CONTEXT_TOKENS: '400K',
        AGENT_MAX_ITERATIONS: '100',
        AGENT_MAX_TOOL_CALLS: 'abc',
        AGENT_MAX_TOOL_CHARS: '99999999',
      },
      allowMissingKey: true,
      loadEnvFile: false,
    });
    assert.equal(custom.contextCeiling, 400_000);
    assert.equal(custom.turn.maxIterations, 100);
    assert.equal(custom.turn.maxToolCalls, 256, '非法值回落默认');
    assert.equal(custom.turn.maxToolChars, 4_000_000, '超出安全范围时夹到上限');
  });

  it('记住模型报过的上限：之后按它定预算；只收小不收大；换模型配置后重新探测', () => {
    const service = new AgentService({
      registry: {} as never,
      memory: {} as never,
      compaction: {} as never,
      createProvider: () => new FakeProvider(),
      defaultModel: 'm',
      knownModels: ['m', 'other'],
      budget: DEFAULT_BUDGET,
      tools: () => [],
      contextCeiling: 300_000,
    });
    assert.equal(service.contextBudgetFor('m').total, 300_000);
    service.learnContextLimit('m', 128_000);
    service.learnContextLimit('m', 200_000);
    assert.equal(service.contextBudgetFor('m').total, 128_000);
    assert.equal(service.contextBudgetFor('other').total, 300_000, '别的模型不受影响');
    service.updateModelConfig({ model: 'm' });
    assert.equal(service.contextBudgetFor('m').total, 300_000);
  });

  it('运行时：首回合按 1M 发，模型报超长后按它的上限压缩重试，下一回合直接用学到的上限', async () => {
    const env = await tempDataDir('context-overflow-runtime');
    try {
      let reads = 0,
        overflows = 0;
      const read = defineTool({
        name: 'Read',
        description: '',
        parameters: { type: 'object', properties: {} },
        execute: () => {
          reads++;
          return 'x'.repeat(14_000);
        },
      });
      const provider = new FakeProvider({
        auto: (messages) => {
          if (estimateTokens(JSON.stringify(messages)) > 20_000) {
            overflows++;
            throw new Error(
              "LLM request failed with 400 Bad Request: This model's maximum context length is 20000 tokens. However, you requested 26000 tokens.",
            );
          }
          return reads < 8
            ? FakeProvider.toolCalls([{ id: `r${reads}`, name: 'Read', arguments: '{}' }])
            : FakeProvider.text('读完了');
        },
      });
      const runtime = new AgentRuntime({
        tools: [read],
        dataDir: env.dir,
        defaultModel: 'small',
        knownModels: ['small'],
        budget: DEFAULT_BUDGET,
        memoryExtraction: false,
        createProvider: () => provider,
      });
      await runtime.ensureDefaultAgent();
      const agent = (await runtime.registry.list())[0]!;
      const budgets: number[] = [];
      const onEvent = (event: { type: string; stats?: { budgetTokens: number } }) => {
        if (event.type === 'context' && event.stats) budgets.push(event.stats.budgetTokens);
      };
      const result = await runtime.send(agent.id, '把这些文件都读一遍', { onEvent: onEvent as never });
      assert.equal(result.stopReason, 'final_answer');
      assert.equal(reads, 8);
      assert.equal(overflows, 1, '只超长一次：之后按学到的上限压缩');
      assert.equal(budgets[0], 1_000_000);
      await runtime.send(agent.id, '再来一句', { onEvent: onEvent as never });
      assert.equal(budgets[1], 20_000, '下一回合直接用学到的上限');
    } finally {
      await env.cleanup();
    }
  });
});

describe('每轮工具额度可配置', () => {
  const loopWith = (turnLimits?: { maxCalls: number; maxChars: number }) => {
    let executed = 0;
    const read = defineTool({
      name: 'Read',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: () => {
        executed++;
        return 'ok';
      },
    });
    const provider = new FakeProvider({
      auto: (messages) =>
        messages.at(-1)?.content?.includes('只总结、不执行工具')
          ? FakeProvider.text('阶段交接')
          : FakeProvider.toolCalls([{ id: `c${Math.random()}`, name: 'Read', arguments: '{}' }]),
    });
    const loop = new AgentLoop({
      provider,
      maxIterations: 50,
      messages: { append: async () => undefined } as never,
      ...(turnLimits ? { turnLimits } : {}),
    });
    return {
      run: () =>
        loop.run({ id: 'a', tools: [read], memory: { projectIds: [] } } as never, { messages: [] } as never),
      executed: () => executed,
    };
  };

  it('按注入的调用次数上限收尾，提示里写实际上限', async () => {
    const probe = loopWith({ maxCalls: 5, maxChars: 1_000_000 });
    const result = await probe.run();
    assert.equal(probe.executed(), 5);
    assert.equal(result.stopReason, 'tool_limit');
    assert.match(result.content, /5 次工具调用上限/);
  });

  it('不注入时保持库默认值（128 次 / 256000 字符）', async () => {
    const probe = loopWith();
    const result = await probe.run();
    assert.equal(result.stopReason, 'max_iterations', '50 轮先到，未触发调用上限');
    assert.equal(probe.executed(), 50);
  });

  it('运行时把配置的每轮额度交给回合（调用数到顶即只总结）', async () => {
    const env = await tempDataDir('turn-limits-runtime');
    try {
      let executed = 0;
      const read = defineTool({
        name: 'Read',
        description: '',
        parameters: { type: 'object', properties: {} },
        execute: () => {
          executed++;
          return 'ok';
        },
      });
      const runtime = new AgentRuntime({
        tools: [read],
        dataDir: env.dir,
        defaultModel: 'fake',
        knownModels: ['fake'],
        budget: DEFAULT_BUDGET,
        memoryExtraction: false,
        maxIterations: 40,
        turnLimits: { maxCalls: 3, maxChars: 1_000_000 },
        createProvider: () =>
          new FakeProvider({
            auto: (messages) =>
              messages.at(-1)?.content?.includes('只总结、不执行工具')
                ? FakeProvider.text('阶段交接')
                : FakeProvider.toolCalls([{ id: `c${Math.random()}`, name: 'Read', arguments: '{}' }]),
          }),
      });
      await runtime.ensureDefaultAgent();
      const agent = (await runtime.registry.list())[0]!;
      const result = await runtime.send(agent.id, '一直读');
      assert.equal(executed, 3);
      assert.equal(result.stopReason, 'tool_limit');
    } finally {
      await env.cleanup();
    }
  });
});
