import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { ToolRegistry } from '../src/tools/registry.js';
import { defineTool } from '../src/tools/tool.js';
import { toolError } from '../src/tools/result.js';
import { ToolOutputStore } from '../src/tools/services/tool-output-store.js';
import { createReadToolOutputTool } from '../src/tools/builtin/tool-output.js';
import { createShellTools } from '../src/tools/builtin/shell.js';
import { AgentLoop } from '../src/agent/agent-loop.js';
import { MessageStore } from '../src/store/messages.js';
import { JsonToolInvocationLedger } from '../src/storage/tool-ledger.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir } from './fakes/test-env.js';

const call = (name: string, args: unknown = {}) => ({
  id: randomUUID(),
  name,
  arguments: JSON.stringify(args),
});
const ctx = (outputs?: ToolOutputStore) => ({ agentId: 'owner', projectIds: [], outputs });

it('正文 Error: 不再决定成功与否；显式失败保留错误码，兼容文本接口', async () => {
  const registry = ToolRegistry.from([
    defineTool({
      name: 'Read',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: () => 'Error: 这是文件里的普通文本',
    }),
    defineTool({
      name: 'Broken',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: () => toolError('CONFLICT', '版本不一致'),
    }),
  ]);
  assert.equal((await registry.executeResult(call('Read'), ctx())).status, 'ok');
  assert.match(await registry.execute(call('Read'), ctx()), /^Error:/);
  assert.equal((await registry.executeResult(call('Broken'), ctx())).error?.code, 'CONFLICT');
  assert.equal((await registry.executeResult(call('Missing'), ctx())).error?.code, 'UNKNOWN_TOOL');
  assert.equal(
    (await registry.executeResult({ id: 'x', name: 'Read', arguments: '{' }, ctx())).error?.code,
    'INVALID_ARGUMENTS',
  );
});

it('执行循环、消息和账本全部使用结构化结果，不误判含 Error: 的原文', async () => {
  const env = await tempDataDir('structured-tool');
  try {
    const messages = new MessageStore(env.dir),
      ledger = new JsonToolInvocationLedger(env.dir);
    let n = 0;
    const tool = defineTool({
      name: 'Read',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: () => 'Error: fixture source',
    });
    await new AgentLoop({
      provider: new FakeProvider({
        auto: () => (++n === 1 ? FakeProvider.toolCalls([call('Read')]) : FakeProvider.text('已读取')),
      }),
      messages,
      invocations: ledger,
    }).run({ id: 'owner', tools: [tool], memory: { projectIds: [] } } as never, { messages: [] } as never);
    const result = (await messages.list('owner')).find((row) => row.content.type === 'tool_result')!.content;
    assert.equal(result.type === 'tool_result' && result.ok, true);
    assert.equal(result.type === 'tool_result' && result.outcome?.status, 'ok');
    assert.equal((await ledger.list())[0]?.outcome?.status, 'ok');
  } finally {
    await env.cleanup();
  }
});

it('超量工具正文只落盘一次，可通过新工具完整分页读取，其他智能体无权访问', async () => {
  const env = await tempDataDir('output-spill');
  try {
    const outputs = new ToolOutputStore(env.dir),
      content = 'Error: 第一行\n' + '中文😀abc\n'.repeat(10000);
    const registry = ToolRegistry.from([
      defineTool({
        name: 'Big',
        description: '',
        parameters: { type: 'object', properties: {} },
        execute: () => content,
      }),
      createReadToolOutputTool(),
    ]);
    const result = await registry.executeResult(call('Big'), ctx(outputs));
    assert.equal(result.status, 'ok');
    assert.ok(result.content.length <= 8000);
    assert.ok(result.output?.truncated);
    assert.ok(result.output?.handle);
    let nextOffset = 0,
      restored = '';
    while (nextOffset < Buffer.byteLength(content)) {
      const page = outputs.read(result.output!.handle!, 'owner', nextOffset, 101);
      assert.ok(page.nextOffset > nextOffset);
      restored += page.text;
      nextOffset = page.nextOffset;
    }
    assert.equal(restored, content, 'UTF-8 分页不能丢字符或产生替换字符');
    const read = await registry.executeResult(
      call('ReadToolOutput', { output_id: result.output!.handle!, limit: 100 }),
      ctx(outputs),
    );
    assert.equal(read.status, 'ok');
    assert.match(read.content, /第一行/);
    assert.throws(() => outputs.read(result.output!.handle!, 'another'), /其他智能体/);
    assert.throws(() => outputs.read('../secret', 'owner'), /无效/);
    const reopened = new ToolOutputStore(env.dir);
    assert.equal(
      reopened.read(result.output!.handle!, 'owner').text,
      outputs.read(result.output!.handle!, 'owner').text,
    );
  } finally {
    await env.cleanup();
  }
});

it('按字面文本搜索跨扫描边界的日志；命中位置可直接读取', async () => {
  const env = await tempDataDir('output-search');
  try {
    const store = new ToolOutputStore(env.dir),
      record = store.create('a');
    store.append(record.id, 'x'.repeat(256 * 1024 - 2) + '目标字符串' + 'y'.repeat(100));
    store.finish(record.id);
    const page = store.search(record.id, 'a', '目标字符串');
    assert.deepEqual(page.matches, [256 * 1024 - 2]);
    assert.match(store.read(record.id, 'a', page.matches[0]!).text, /^目标字符串/);
    assert.deepEqual(store.search(record.id, 'a', '目标字符串', page.nextOffset).matches, []);
  } finally {
    await env.cleanup();
  }
});

it('单日志/总磁盘配额明确标注缺失，活跃日志不被清理，旧关闭日志按期限清理', async () => {
  const env = await tempDataDir('output-quota');
  try {
    const store = new ToolOutputStore(env.dir, { maxFileBytes: 12, maxTotalBytes: 18 });
    const first = store.create('a');
    store.append(first.id, '中文'.repeat(4));
    assert.equal(first.retainedBytes, 12);
    assert.equal(first.totalBytes, 24);
    assert.equal(first.storageTruncated, true);
    const second = store.create('a');
    store.append(second.id, '123456789');
    assert.equal(second.retainedBytes, 6);
    assert.equal(second.storageTruncated, true);
    assert.equal(store.get(first.id, 'a').retainedBytes, 12);
    store.finish(first.id);
    store.finish(second.id);
    const third = store.create('a');
    store.append(third.id, '123456789012');
    assert.equal(third.retainedBytes, 12);
    assert.throws(() => store.get(first.id, 'a'), /已按保留策略清理/);
    store.finish(third.id);
    const expired = new ToolOutputStore(env.dir, { retentionMs: 0 });
    // 零保留策略下毫秒边界由时间推进后触发。
    await new Promise((resolve) => setTimeout(resolve, 2));
    assert.throws(() => expired.get(third.id, 'a'), /已按保留策略清理/);
  } finally {
    await env.cleanup();
  }
});

it('日志存储失败不会把已完成的副作用伪装成未执行', async () => {
  let executed = 0;
  const registry = ToolRegistry.from([
    defineTool({
      name: 'CustomWrite',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: () => {
        executed++;
        return 'x'.repeat(10000);
      },
    }),
  ]);
  const result = await registry.executeResult(
    call('CustomWrite'),
    ctx({
      create: () => {
        throw new Error('disk full');
      },
    } as never),
  );
  assert.equal(executed, 1);
  assert.equal(result.status, 'ok');
  assert.match(result.content, /日志写入失败/);
});

it('真实 Shell 大输出保留开头；非零退出码、取消、超时与后台运行分别返回', async () => {
  const env = await tempDataDir('shell-results');
  try {
    const outputs = new ToolOutputStore(env.dir),
      registry = ToolRegistry.from(createShellTools(env.dir));
    const big = await registry.executeResult(
      call('Shell', {
        command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write("START\\n" + "x".repeat(90000) + "\\nEND")'`,
        block_until_ms: 10000,
      }),
      ctx(outputs),
    );
    assert.equal(big.status, 'ok');
    assert.equal(big.execution?.exitCode, 0);
    assert.match(outputs.read(big.output!.handle!, 'owner').text, /^START/);
    assert.equal(big.output?.totalBytes, 90010);
    const failed = await registry.executeResult(
      call('Shell', { command: 'exit 7', block_until_ms: 10000 }),
      ctx(outputs),
    );
    assert.equal(failed.status, 'error');
    assert.equal(failed.error?.code, 'SHELL_EXIT_NONZERO');
    assert.equal(failed.execution?.exitCode, 7);
    const pending = await registry.executeResult(
      call('Shell', { command: 'sleep 30', block_until_ms: 0 }),
      ctx(outputs),
    );
    assert.equal(pending.status, 'running');
    const cancelled = await registry.executeResult(
      call('AwaitShell', { shell_id: pending.execution!.id, stop: true, block_until_ms: 10000 }),
      ctx(outputs),
    );
    assert.equal(cancelled.status, 'error');
    assert.equal(cancelled.execution?.state, 'cancelled');
    const timedOut = await registry.executeResult(
      call('Shell', { command: 'sleep 30', block_until_ms: 10000, timeout_ms: 1000 }),
      ctx(outputs),
    );
    assert.equal(timedOut.status, 'error');
    assert.equal(timedOut.execution?.state, 'timed_out');
  } finally {
    await env.cleanup();
  }
});

it('重启后可以查看 Shell 原文和中断状态，不重新启动旧命令', async () => {
  const env = await tempDataDir('shell-recover');
  try {
    const store = new ToolOutputStore(env.dir),
      record = store.create('owner', { command: 'must-not-run' });
    store.append(record.id, '已落盘的中间输出');
    const reopened = new ToolOutputStore(env.dir);
    assert.equal(reopened.get(record.id, 'owner').execution?.state, 'interrupted');
    const registry = ToolRegistry.from(createShellTools(env.dir));
    const result = await registry.executeResult(
      call('AwaitShell', { shell_id: record.id, block_until_ms: 0 }),
      ctx(reopened),
    );
    assert.equal(result.execution?.state, 'interrupted');
    assert.equal(result.status, 'error');
    assert.equal(reopened.read(record.id, 'owner').text, '已落盘的中间输出');
  } finally {
    await env.cleanup();
  }
});

it('日志已清理不改变真实命令结果；不诱发重复执行', async () => {
  const env = await tempDataDir('shell-expired-log');
  try {
    const outputs = new ToolOutputStore(env.dir, { maxRecords: 1 });
    const registry = ToolRegistry.from(createShellTools(env.dir));
    const result = await registry.executeResult(
      call('Shell', { command: 'echo done', block_until_ms: 1000 }),
      ctx(outputs),
    );
    const replacement = outputs.create('owner');
    outputs.finish(replacement.id);
    const restored = await registry.executeResult(
      call('AwaitShell', { shell_id: result.execution!.id, block_until_ms: 0 }),
      ctx(outputs),
    );
    assert.equal(restored.status, 'ok');
    assert.equal(restored.execution?.exitCode, 0);
    assert.match(restored.content, /持久日志已清理或不可读/);
  } finally {
    await env.cleanup();
  }
});

it('工具意图无法落盘时不执行副作用', async () => {
  let executed = 0;
  const tool = defineTool({
    name: 'Write',
    description: '',
    parameters: { type: 'object', properties: {} },
    execute: () => {
      executed++;
      return 'written';
    },
  });
  const loop = new AgentLoop({
    provider: new FakeProvider({ auto: () => FakeProvider.toolCalls([call('Write')]) }),
    messages: { append: async () => undefined } as never,
    invocations: {
      start: async () => {
        throw new Error('disk full');
      },
    } as never,
  });
  await assert.rejects(
    () =>
      loop.run({ id: 'a', tools: [tool], memory: { projectIds: [] } } as never, { messages: [] } as never),
    /该调用未执行/,
  );
  assert.equal(executed, 0);
});

it('ReadToolOutput 搜索模式下 limit 真的生效（E5.8：不许接受参数却忽略）', async () => {
  const env = await tempDataDir('output-search-limit');
  try {
    const outputs = new ToolOutputStore(env.dir);
    const record = outputs.create('owner', { id: randomUUID(), command: 'fixture' });
    outputs.append(record.id, Array.from({ length: 20 }, (_, i) => `第 ${i} 行命中 NEEDLE`).join('\n'));
    const tool = createReadToolOutputTool();

    // 缺省：沿用扫描预算的 30 上限，这里 20 个命中全回来
    const all = await tool.execute({ output_id: record.id, query: 'NEEDLE' }, ctx(outputs));
    assert.match(String(all), /命中字节 offset/);
    assert.equal((String(all).match(/命中字节 offset/g) ?? []).length, 20);

    // 显式给 limit：命中数被真的截断（修复前这个参数在搜索模式下被完全忽略）
    const few = await tool.execute({ output_id: record.id, query: 'NEEDLE', limit: 5 }, ctx(outputs));
    assert.equal((String(few).match(/命中字节 offset/g) ?? []).length, 5);

    // 下限：搜索模式要 1 个命中必须能过校验（E5.8 打回点——描述写「1–30」时 schema 还是 minimum:4）
    const two = await tool.execute({ output_id: record.id, query: 'NEEDLE', limit: 2 }, ctx(outputs));
    assert.equal((String(two).match(/命中字节 offset/g) ?? []).length, 2, 'limit=2 要真的只回 2 个命中');
    const one = await tool.execute({ output_id: record.id, query: 'NEEDLE', limit: 1 }, ctx(outputs));
    assert.equal((String(one).match(/命中字节 offset/g) ?? []).length, 1, '下限 1 可用');
    assert.match(String(few), /next_offset: \d+（仍有未读\/未扫描内容）/);

    // 超过 30 的上限按 30 处理（扫描预算不变）
    const capped = await tool.execute({ output_id: record.id, query: 'NEEDLE', limit: 12000 }, ctx(outputs));
    assert.equal((String(capped).match(/命中字节 offset/g) ?? []).length, 20, '不足 30 就全给');

    // query 上限按字节：1000 字节以内通过，超过明确报错（描述已写明单位）
    await assert.rejects(
      () => tool.execute({ output_id: record.id, query: 'x'.repeat(1001) }, ctx(outputs)),
      /长度超限|字节/,
    );
    const multibyte = '中'.repeat(400); // 1200 字节 > 1000
    await assert.rejects(
      () => tool.execute({ output_id: record.id, query: multibyte }, ctx(outputs)),
      /字节/,
    );
  } finally {
    await env.cleanup();
  }
});

it('UpdateAgent 按名字也能找到目标；没有要改的字段时不落盘（E5.8）', async () => {
  const env = await tempDataDir('update-agent-name');
  try {
    const { Workbench } = await import('../src/workbench/service.js');
    const { AgentRegistry } = await import('../src/agent/registry.js');
    const { AgentProfileService } = await import('../src/agent/profile-service.js');
    const { MessageStore } = await import('../src/store/messages.js');
    const { RoomStore } = await import('../src/room/store.js');
    const { tinyPngDataUrl } = await import('./fakes/avatar-fixture.js');
    const registry = new AgentRegistry(env.dir);
    const workbench = new Workbench({
      registry,
      profiles: new AgentProfileService(registry, env.dir),
      rooms: new RoomStore(env.dir),
      messages: new MessageStore(env.dir),
      enrollAgent: async () => undefined,
      postToRoom: async () => ({ roomName: 'x', roundId: 'r' }),
    } as never);

    const created = await registry.create({ name: '按名字找我', instructions: '原职责' });

    // 1) 只给名字也能改（工具描述承诺过）
    const renamed = await workbench.updateAgent('按名字找我', { instructions: '新职责' });
    assert.equal(renamed.id, created.id);
    assert.equal(renamed.instructions, '新职责');

    // 2) 一个字段都不给：不落盘、不改 updatedAt（否则列表按 updatedAt 倒序会静默换位）
    const before = await registry.get(created.id);
    const same = await workbench.updateAgent(created.id, {});
    assert.equal(same.updatedAt, before!.updatedAt, '空调用不该刷新 updatedAt');
    assert.equal((await registry.get(created.id))!.updatedAt, before!.updatedAt);

    // 3) 非 name/instructions 的字段（avatar/color）也算「有要改的」，不能被空判据吞掉
    const withAvatar = await workbench.updateAgent(created.id, { avatar: { dataUrl: tinyPngDataUrl() } });
    assert.match(withAvatar.avatar ?? '', /^avatars\//);
    const withColor = await workbench.updateAgent(created.id, { color: '#123456' });
    assert.equal(withColor.color, '#123456');

    // 4) 找不到时给出同时提到 id 与名字的错误
    await assert.rejects(
      () => workbench.updateAgent('不存在的同事', { instructions: 'x' }),
      /找不到 id 或名字/,
    );
  } finally {
    await env.cleanup();
  }
});
