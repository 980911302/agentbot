import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createFileTools, createReadTool } from '../src/tools/builtin/files.js';
import { createAgentTools } from '../src/server/tools.js';
import { createWorkbenchTools } from '../src/tools/builtin/workbench.js';
import { createTaskTools } from '../src/tools/builtin/task.js';
import { createSendToAgentTool } from '../src/tools/builtin/room.js';
import { createUpdateStateTools } from '../src/tools/builtin/update-state.js';
import { createMemoryTools } from '../src/tools/builtin/memory.js';
import { createShellTools } from '../src/tools/builtin/shell.js';
import { createManageRoomFlowTool } from '../src/tools/builtin/manage-room-flow.js';
import { ShellSessionManager } from '../src/tools/services/shell-session-manager.js';
import { ArtifactService } from '../src/tools/services/artifact-service.js';
import { WorkerManager } from '../src/tools/services/worker-manager.js';
import { TOOL_LIMITS, validateToolArgs } from '../src/tools/limits.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { defineTool, type ToolContext } from '../src/tools/tool.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { assertPublicUrl, isPrivateAddress, readLimited, parseDuckDuckGo } from '../src/tools/builtin/web.js';

const context = (agentId = 'a1'): ToolContext => ({ agentId, projectIds: [], turnState: { workbench: { agentsCreated: 0, roomsCreated: 0 } } });
let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'agentbot-tool-limits-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

describe('所有内置工具都有独立的量限额', () => {
  it('25 个真实工具全部在预算表登记，schema 的字符串/数组都有上限', () => {
    const tools = [
      ...createAgentTools({ rootDir: dir, memory: {} as never, secrets: {} as never, broker: {} as never }).tools,
      ...createWorkbenchTools({} as never),
      ...createTaskTools({ provider: new FakeProvider(), messages: {} as never, workerTools: () => [] }),
      createSendToAgentTool({ maxDepth: 3, resolveTarget: async () => undefined, dispatch: async () => '' }),
      createManageRoomFlowTool({} as never),
    ];
    assert.equal(tools.length, 25);
    assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(TOOL_LIMITS).sort());
    const check = (schema: any): void => {
      if (schema.type === 'string') assert.ok(schema.maxLength > 0);
      if (schema.type === 'array') { assert.ok(schema.maxItems > 0); assert.ok(schema.items); check(schema.items); }
      if (schema.type === 'object') Object.values(schema.properties).forEach(check);
    };
    for (const tool of tools) {
      check(tool.parameters);
      assert.throws(() => validateToolArgs(tool.name, { excessive: 'x'.repeat(TOOL_LIMITS[tool.name]!.input + 1) }, tool.parameters), /参数超过/);
    }
  });
  for (const [name, limit] of Object.entries(TOOL_LIMITS)) {
    it(`${name}：不经 defineTool 的实现也不能绕过结果上限`, async () => {
      const registry = ToolRegistry.from([{ name, description: '', parameters: { type: 'object', properties: {} }, execute: () => 'x'.repeat(limit.output * 2) }]);
      const result = await registry.execute({ id: 'c', name, arguments: '{}' }, context());
      assert.ok(result.length <= limit.output);
      assert.match(result, /输出达到字符上限/);
    });
  }
  it('非法类型、数组元素、非整数、嵌套额外字段在副作用前被拒绝', async () => {
    let calls = 0;
    const tool = defineTool({ name: 'TodoWrite', description: '', parameters: { type: 'object', properties: {
      count: { type: 'integer', minimum: 1, maximum: 10 }, enabled: { type: 'boolean' },
      rows: { type: 'array', maxItems: 2, items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
    } }, execute: () => { calls++; return 'ok'; } });
    for (const args of [{ count: 0 }, { count: 1.2 }, { count: NaN }, { enabled: 'false' }, { rows: [{ title: [] }] }, { rows: [{ title: 't', hidden: true }] }, { rows: [{ title: '1' }, { title: '2' }, { title: '3' }] }]) {
      await assert.rejects(() => tool.execute(args, context()));
    }
    assert.equal(calls, 0);
  });
  it('本轮总量及取消信号会阻止新工具产生副作用', async () => {
    let calls = 0;
    const registry = ToolRegistry.from([{ name: 'Read', description: '', parameters: { type: 'object', properties: {} }, execute: () => { calls++; return 'ok'; } }]);
    const ctx = context(); ctx.turnState!.toolInputChars = 256001;
    assert.match(await registry.execute({ id: 'c', name: 'Read', arguments: '{}' }, ctx), /额度不足/);
    await assert.rejects(() => registry.execute({ id: 'c', name: 'Read', arguments: '{}' }, { ...context(), signal: AbortSignal.abort() }));
    assert.equal(calls, 0);
  });
});

describe('文件定位、分段读取和写入', () => {
  it('大于旧 256KiB 门槛的文件可以限行读取，有 next_offset，不回全文', async () => {
    const path = join(dir, 'large.txt');
    await writeFile(path, Array.from({ length: 600 }, (_, i) => `${i + 1}-${'a'.repeat(1000)}`).join('\n'));
    const tool = createReadTool(dir);
    const text = await tool.execute({ path: 'large.txt', offset: 250, limit: 2 }, context());
    assert.match(text, /250: 250-/); assert.match(text, /251: 251-/); assert.match(text, /next_offset=252/);
    assert.ok(!text.includes('252:'));
    assert.ok((await tool.execute({ path }, context())).length <= TOOL_LIMITS.Read!.output);
  });
  it('超长单行按列续读，负偏移及二进制/非法参数受限', async () => {
    const path = join(dir, 'long.txt');
    await writeFile(path, 'x'.repeat(300000) + '\ntail');
    const tool = createReadTool();
    const text = await tool.execute({ path, limit: 1, column: 2001 }, context());
    assert.ok(text.length < 2600); assert.match(text, /column=4001/);
    assert.match(await tool.execute({ path, offset: -1 }, context()), /2: tail/);
    for (const args of [{ path, limit: 501 }, { path, offset: 0 }, { path, limit: 0.5 }]) await assert.rejects(() => tool.execute(args, context()));
    const binary = join(dir, 'binary'); await writeFile(binary, Buffer.from([0, 1, 2]));
    await assert.rejects(() => tool.execute({ path: binary }, context()), /二进制/);
  });
  it('普通 HTML 按实际字符分页，1053 行不用虚扣每行 80 字符，续页无遗漏', async () => {
    const path = join(dir, 'pagination.html');
    const lines = Array.from({ length: 1053 }, (_, i) => `${i + 1}: <div class="card">中文内容 ${'x'.repeat(18)}</div>`);
    await writeFile(path, lines.join('\n'));
    const tool = createReadTool();
    let offset = 1, pages = 0;
    const seen: number[] = [];
    while (pages++ < 20) {
      const result = await tool.execute({ path, offset }, context());
      assert.ok(result.length <= TOOL_LIMITS.Read!.output);
      const rows = [...result.matchAll(/^(\d+): (.*)$/gm)];
      assert.ok(rows.map(row => row[0]).join('\n').length <= 12000);
      for (const row of rows) {
        const line = Number(row[1]); seen.push(line);
        assert.equal(row[2], lines[line - 1]);
      }
      const next = /next_offset=(\d+)/.exec(result);
      if (!next) break;
      assert.ok(Number(next[1]) > offset); offset = Number(next[1]);
    }
    assert.ok(pages <= 7, `正文约 65KB，应在 7 页内，实际 ${pages}`);
    assert.deepEqual(seen, Array.from({ length: 1053 }, (_, i) => i + 1));
    const tail = await tool.execute({ path, offset: -500, limit: 500 }, context());
    assert.ok([...tail.matchAll(/^\d+: .*$/gm)].map(row => row[0]).join('\n').length <= 12000);
    assert.match(tail, /^554: /m);
  });
  it('ListFiles/SearchFiles 跳过依赖与符号链接，分页并限制搜索摘要', async () => {
    const root = join(dir, 'search'); await mkdir(join(root, 'node_modules'), { recursive: true });
    for (let i = 0; i < 4; i++) await writeFile(join(root, `${i}.ts`), 'unique-needle\nunique-needle');
    await writeFile(join(root, 'node_modules', 'hidden.ts'), 'unique-needle');
    await symlink(join(dir, 'large.txt'), join(root, 'linked'));
    const tools = createFileTools(root), list = tools.find(tool => tool.name === 'ListFiles')!, search = tools.find(tool => tool.name === 'SearchFiles')!;
    const first = await list.execute({ limit: 2 } as never, context());
    assert.match(first, /next_offset=2/); assert.ok(!first.includes('hidden')); assert.ok(!first.includes('linked'));
    const matches = await search.execute({ query: 'unique-needle', limit: 2 } as never, context());
    assert.match(matches, /0.ts:1/); assert.match(matches, /next_offset=2/);
    const next = await search.execute({ query: 'unique-needle', limit: 2, offset: 2 } as never, context());
    assert.match(next, /1.ts:1/); assert.ok(!next.includes('0.ts'));
  });
  it('Write 分块 → Edit 唯一匹配 → Read 验证；默认不覆盖，超限不修改', async () => {
    const registry = ToolRegistry.from(createFileTools(dir));
    const run = (name: string, args: unknown) => registry.execute({ id: 'w', name, arguments: JSON.stringify(args) }, context());
    assert.match(await run('Write', { path: 'page.html', content: '<html><body>' }), /已写入/);
    assert.match(await run('Write', { path: 'page.html', content: 'hello</body></html>', append: true }), /已追加/);
    assert.match(await run('Edit', { path: 'page.html', old_text: 'hello', new_text: '你好' }), /已修改/);
    assert.equal(await readFile(join(dir, 'page.html'), 'utf8'), '<html><body>你好</body></html>');
    assert.match(await run('Write', { path: 'page.html', content: 'bad' }), /^Error:/);
    assert.match(await run('Write', { path: 'oversize', content: 'x'.repeat(32001) }), /^Error:/);
    await assert.rejects(() => stat(join(dir, 'oversize')));
    assert.match(await run('Edit', { path: 'page.html', old_text: 'body', new_text: 'x' }), /恰好命中一次/);
  });
});

describe('Shell 生命周期与增量日志', () => {
  it('输出缓存有界，游标不会重复返回旧日志', async () => {
    const manager = new ShellSessionManager();
    const shell = manager.start(`${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(400000))'`, dir);
    try {
      for (let i = 0; !shell.done && i < 100; i++) await delay(10);
      assert.ok(shell.done); assert.ok(shell.output.length <= 65536); assert.equal(shell.outputEnd, 400000);
      assert.match(manager.read(shell, 0), /旧输出已超出/);
      assert.match(manager.read(shell, shell.outputEnd), /无新增输出/);
    } finally { shell.kill(); }
  });
  it('默认 cwd 来自工作区，命令只回摘要，AwaitShell 不能访问别人进程', async () => {
    const registry = ToolRegistry.from(createShellTools(dir));
    const run = (name: string, args: unknown, ctx = context()) => registry.execute({ id: 'c', name, arguments: JSON.stringify(args) }, ctx);
    const first = await run('Shell', { command: 'pwd # ' + 'x'.repeat(15000), block_until_ms: 1000 });
    assert.ok(first.includes(dir)); assert.ok(first.length < 1500);
    const id = /shell_id: (\S+)/.exec(first)![1];
    assert.match(await run('AwaitShell', { shell_id: id, block_until_ms: 0 }), /无新增输出/);
    assert.match(await run('AwaitShell', { shell_id: id }, context('other')), /不能访问/);
  });
  it('取消信号停止 Shell，不必等同步等待超时', async () => {
    const registry = ToolRegistry.from(createShellTools(dir));
    const controller = new AbortController();
    const pending = registry.execute({ id: 'c', name: 'Shell', arguments: JSON.stringify({ command: 'sleep 30', block_until_ms: 30000 }) }, { ...context(), signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 50);
    try { await assert.rejects(pending); } finally { clearTimeout(timer); }
  });
});

describe('工人与记忆边界', () => {
  it('工人并发参数生效，不允许递归派工或重复 drive，纠偏队列有上限', async () => {
    const fake = new FakeProvider();
    const manager = new WorkerManager({ provider: fake, messages: { append: async () => undefined } as never, maxWorkers: 1, workerTools: () => [{ name: 'Task' }, { name: 'Read', description: '', parameters: { type: 'object', properties: {} } }] as never });
    const worker = manager.spawn('job', 'task');
    assert.throws(() => manager.spawn('other', 'task'), /工人在跑/);
    const running = manager.drive(worker);
    for (let i = 0; fake.calls.length === 0 && i < 20; i++) await delay(5);
    await manager.drive(worker);
    assert.equal(fake.calls.length, 1); assert.ok(!fake.calls[0]!.options?.tools?.some(tool => tool.name === 'Task'));
    for (let i = 0; i < 8; i++) manager.pushMessage(worker.id, 'fix');
    assert.throws(() => manager.pushMessage(worker.id, 'overflow'), /上限/);
    manager.kill(worker.id); fake.release(0, FakeProvider.text('late')); await running;
    assert.equal(worker.status, 'cancelled');
  });
  it('Task maxWorkers 接线正确且工人操作按创建者隔离', async () => {
    const fake = new FakeProvider();
    const tools = ToolRegistry.from(createTaskTools({ provider: fake, messages: { append: async () => undefined } as never, workerTools: () => [], maxWorkers: 1 }));
    const call = (name: string, args: unknown, ctx = context()) => tools.execute({ id: 't', name, arguments: JSON.stringify(args) }, ctx);
    const output = await call('Task', { description: 'test', prompt: 'test', subagent_type: 'executor', run_in_background: true });
    const id = /worker_id: (\S+)/.exec(output)![1];
    assert.match(await call('Task', { description: 'test', prompt: 'test', subagent_type: 'executor' }), /工人在跑/);
    assert.match(await call('StopSubagent', { subagent_id: id }, context('other')), /^Error:/);
    await call('StopSubagent', { subagent_id: id }); fake.release(0, FakeProvider.text('late')); await delay(10);
  });
  it('多项目必须指定归属，不能静默写错本子；project slug 不可穿越路径', async () => {
    let writes = 0;
    const registry = ToolRegistry.from(createUpdateStateTools({ memory: { write: async () => { writes++; return {}; } } as never, updateProfile: async () => undefined }));
    const call = (args: unknown) => registry.execute({ id: 'm', name: 'update_state', arguments: JSON.stringify(args) }, { ...context(), projectIds: ['a', 'b'] });
    assert.match(await call({ target: 'memory', action: 'write', scope: 'project', fact: '这条必须归项目' }), /^Error:/);
    assert.match(await call({ target: 'project', action: 'join', project: '../other' }), /slug/);
    assert.equal(writes, 0);
  });
  it('RecallMemory 默认预览、完整模式与分页均有界', async () => {
    const refs = Array.from({ length: 30 }, (_, i) => ({ scope: 'self', ownerId: 'a1', entry: { id: String(i), text: 'needle ' + '字'.repeat(1900), tier: 'log', confidence: 1, updatedAt: Date.now(), createdAt: Date.now(), salience: 1 } }));
    const [tool] = createMemoryTools({ visibleTo: async () => refs, touch: async () => undefined } as never);
    const output = await tool!.execute({ query: 'needle' }, context());
    assert.ok(output.length < 10000); assert.match(output, /full=true/);
    const full = await tool!.execute({ query: 'needle', full: true }, context());
    assert.ok(full.includes('字'.repeat(1900))); assert.ok(full.length < 10000);
  });
});

describe('网页与附件边界', () => {
  it('IPv6 映射、保留网段及 URL 内嵌凭据均不可绕过检查', async () => {
    for (const address of ['[::1]', '::ffff:7f00:1', '::ffff:a00:1', 'fe90::1', 'ff02::1', '224.0.0.1', '198.18.1.1']) assert.ok(isPrivateAddress(address), address);
    await assert.rejects(() => assertPublicUrl('http://user:password@example.com'), /用户名/);
    await assert.rejects(() => assertPublicUrl('http://[::ffff:7f00:1]'), /内网/);
  });
  it('网页体积超过 2MiB 明确失败，不把残缺内容当完整页面', async () => {
    await assert.rejects(() => readLimited(new Response('x'.repeat(2 * 1024 * 1024 + 1))), /2MiB/);
    assert.equal(await readLimited(new Response('hello')), 'hello');
  });
  it('搜索摘要与广告位对应正确且单条有上限', () => {
    const html = '<a class="result__a" href="https://duckduckgo.com/y.js">ad</a><a class="result__snippet">advert</a><a class="result__a" href="https://example.com">real</a><a class="result__snippet">' + 'r'.repeat(5000) + '</a>';
    const result = parseDuckDuckGo(html, 5);
    assert.equal(result.length, 1); assert.equal(result[0]!.snippet, 'r'.repeat(600));
  });
  it('已在交付目录的网页可直接交付，重名不覆盖，符号链接不能逃到白名单外', async () => {
    const workspace = join(dir, 'workspace'), deliver = join(dir, 'delivery'), external = join(dir, 'outside');
    await Promise.all([workspace, deliver, external].map(path => mkdir(path)));
    const service = new ArtifactService({ roots: [deliver] });
    await writeFile(join(deliver, 'page.html'), 'original');
    assert.equal((await service.deliverFromWorkspace(workspace, join(deliver, 'page.html'))).path, await realpath(join(deliver, 'page.html')));
    await writeFile(join(workspace, 'page.html'), 'new');
    const copied = await service.deliverFromWorkspace(workspace, 'page.html');
    assert.notEqual(copied.path, join(deliver, 'page.html')); assert.equal(await readFile(join(deliver, 'page.html'), 'utf8'), 'original');
    await writeFile(join(external, 'private'), 'secret'); await symlink(join(external, 'private'), join(workspace, 'linked'));
    await assert.rejects(() => service.deliverFromWorkspace(workspace, 'linked'), /超出/);
  });
});
