import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentRuntime } from '../src/server/runtime.js';
import { AgentInbox, leaseOf } from '../src/agent/inbox.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { fitContextWindow } from '../src/context/window.js';
import { validateInputImages } from '../src/shared/contracts/input-image.js';
import { OpenAIProvider } from '../src/llm/openai-provider.js';
import { toLLMMessages } from '../src/llm/convert.js';
import { createSendToUserTool } from '../src/tools/builtin/send-to-user.js';
import { InteractionBroker } from '../src/interaction/broker.js';
import { SecretStore } from '../src/secret/store.js';
import { ArtifactService } from '../src/tools/services/artifact-service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, until, waitFor } from './fakes/test-env.js';

async function fixture() {
  const tmp = await tempDataDir('collaboration-delivery');
  const fake = new FakeProvider();
  const sendToUser = createSendToUserTool({ rootDir: tmp.dir, broker: new InteractionBroker(), secrets: new SecretStore(tmp.dir),
    agentName: async () => '测试', artifacts: new ArtifactService({ roots: [tmp.dir] }) });
  const runtime = new AgentRuntime({ dataDir: tmp.dir, tools: [sendToUser], createProvider: () => fake,
    defaultModel: 'fake', knownModels: ['fake'], budget: DEFAULT_BUDGET, memoryExtraction: false });
  const a = await runtime.registry.create({ name: '甲' });
  const b = await runtime.registry.create({ name: '乙' });
  const c = await runtime.registry.create({ name: '丙' });
  const room = await runtime.rooms.create({ name: '开发群', memberIds: [a.id, b.id, c.id] });
  const send = runtime.tools.find(tool => tool.name === 'SendToAgent')!;
  const context = (agentId = a.id) => ({ agentId, memory: runtime.memory, projectIds: [] });
  return { tmp, fake, runtime, a, b, c, room, send, context, close: async () => { await runtime.close(); await tmp.cleanup(); } };
}

describe('协作投递：发送与执行分离', () => {
  it('1:1 在收件模型开始前返回，双向归档；取消发送者信号不撤回已投递信', async () => {
    const f = await fixture();
    try {
      const controller = new AbortController(); let registered = 0, completed = 0;
      const result = await f.send.execute({ target_id: f.b.id, message: '检查构建' }, { ...f.context(), signal: controller.signal,
        turnState: { workbench: { agentsCreated: 0, roomsCreated: 0 }, treeId: 'sender-tree',
          registerChild: () => { registered++; }, completeChild: () => { completed++; } } });
      assert.equal(result, '已投递给「乙」；发出去就结束，回复是之后的新回合。');
      assert.equal(f.fake.calls.length, 0, '工具返回不等待/调用收件模型');
      controller.abort();
      assert.equal(registered, 0); assert.equal(completed, 0);
      assert.equal((await f.runtime.inbox.peek(f.b.id)).length, 1);
      assert.equal((await f.runtime.correspondence.list(f.a.id))[0]?.to.id, f.b.id);
      await waitFor(() => f.fake.calls.length === 1, '收件方独立被唤醒');
      assert.match(f.fake.lastCallText(), /\[agent\].*同事来信/);
      f.fake.releaseText(0, '检查完成');
      await until(async () => await f.runtime.pendingMail(f.b.id) === 0, '处理确认');
      assert.equal(f.runtime.chatRuns.list().find(run => run.agentId === f.b.id)?.parentRunId, undefined);
    } finally { await f.close(); }
  });

  it('发群只落发送者一条时间线，其余成员各一封 room；返回不含执行人数', async () => {
    const f = await fixture();
    try {
      const controller = new AbortController();
      const result = await f.send.execute({ target_id: f.room.id, message: '@乙 检查接口', priority: true }, { ...f.context(), signal: controller.signal });
      assert.equal(result, '已发到「开发群」。'); assert.equal(f.fake.calls.length, 0);
      controller.abort();
      const timeline = await f.runtime.rooms.messages(f.room.id);
      assert.equal(timeline.length, 1); assert.equal(timeline[0]!.senderId, f.a.id); assert.equal(timeline[0]!.senderKind, 'agent');
      for (const member of [f.b, f.c]) {
        const [item] = await f.runtime.inbox.peek(member.id);
        assert.equal(item?.kind, 'room'); assert.equal(item?.priority, false);
        assert.equal(item?.room?.roundId, timeline[0]!.roundId);
        assert.equal(item?.fromActor?.id, f.a.id);
        assert.ok((await f.runtime.messages.list(member.id)).some(message => message.roomId === f.room.id && message.sender?.id === f.a.id));
      }
      assert.equal((await f.runtime.inbox.peek(f.a.id)).length, 0);
    } finally { await f.close(); }
  });

  it('无点名群消息给所有成员独立回合，不附加临时负责人身份', async () => {
    const f = await fixture();
    try {
      await f.send.execute({ target_id: f.room.id, message: '向全体成员致意' }, f.context());
      const deliveries = [
        ...(await f.runtime.inbox.peek(f.b.id)),
        ...(await f.runtime.inbox.peek(f.c.id)),
      ].filter(item => item.kind === 'room');
      assert.equal(deliveries.length, 2);
      assert.ok(deliveries.every(item => item.room?.summoned === false));
      assert.ok(deliveries.every(item => !('naturalResponder' in (item.room ?? {}))));
    } finally { await f.close(); }
  });

  it('当前群重发被拒，非成员不能发群，拒绝时没有落盘副作用', async () => {
    const f = await fixture();
    try {
      await assert.rejects(f.send.execute({ target_id: f.room.id, message: '重复唤醒' }, { ...f.context(), room: {
        roomId: f.room.id, roomName: f.room.name, posts: [], limit: 3 } }), /SendToUser/);
      const outsider = await f.runtime.registry.create({ name: '外部' });
      await assert.rejects(f.send.execute({ target_id: f.room.id, message: '越界' }, f.context(outsider.id)), /不在这个群/);
      await assert.rejects(f.send.execute({ target_id: f.room.name, message: '越界' }, f.context(outsider.id)), /找不到收件方/);
      assert.equal(await f.runtime.rooms.count(f.room.id), 0);
    } finally { await f.close(); }
  });

  it('同名同事/所在群报歧义并列 id；精确 id 不被同事名字抢走', async () => {
    const f = await fixture();
    try {
      const same = await f.runtime.registry.create({ name: f.room.name });
      await assert.rejects(f.send.execute({ target_id: f.room.name, message: '核对' }, f.context()), error => {
        assert.match(String(error), /歧义/); assert.ok(String(error).includes(same.id)); assert.ok(String(error).includes(f.room.id)); return true;
      });
      assert.equal(await f.runtime.rooms.count(f.room.id), 0);
      await f.runtime.registry.create({ name: f.room.id });
      assert.equal(await f.send.execute({ target_id: f.room.id, message: '按 id 发群' }, f.context()), '已发到「开发群」。');
    } finally { await f.close(); }
  });

  it('深度上限和不发给自己仍生效', async () => {
    const f = await fixture();
    try {
      await assert.rejects(f.send.execute({ target_id: f.a.id, message: '自发' }, f.context()), /不要发给自己/);
      const registry = new ToolRegistry();
      registry.register(f.send);
      const depth = await registry.executeResult(
        { id: 'c1', name: 'SendToAgent', arguments: JSON.stringify({ target_id: f.b.id, message: '继续' }) },
        { ...f.context(), agentChainDepth: 3 },
      );
      assert.equal(depth.status, 'error');
      assert.equal(depth.error?.code, 'CHAIN_DEPTH_EXCEEDED');
    } finally { await f.close(); }
  });

  it('群 SendToUser 在本轮下一次模型调用尚未完成时已经公开，不重复全员扇出', async () => {
    const f = await fixture();
    try {
      // 仅乙是收件成员，避免假模型的调用顺序受多成员影响。
      await f.runtime.rooms.setMembers(f.room.id, [f.a.id, f.b.id]);
      await f.send.execute({ target_id: f.room.id, message: '检查' }, f.context());
      await waitFor(() => f.fake.calls.length === 1, '乙开始');
      f.fake.release(0, FakeProvider.toolCalls([{ id: 'out', name: 'SendToUser', arguments: JSON.stringify({ type: 'text', content: '阶段结果' }) }]));
      await waitFor(() => f.fake.calls.length === 2, '乙继续工作中');
      assert.equal((await f.runtime.rooms.messages(f.room.id)).filter(message => message.text === '阶段结果').length, 1);
      assert.equal(await f.runtime.pendingMail(f.a.id), 0, '无 @ 不重复唤醒甲');
      assert.equal(f.runtime.isBusy(f.b.id), true);
      f.fake.releaseText(1, '');
      await until(async () => await f.runtime.pendingMail(f.b.id) === 0, '乙结束');
      assert.equal((await f.runtime.rooms.messages(f.room.id)).filter(message => message.text === '阶段结果').length, 1);
    } finally { await f.close(); }
  });

  it('群 @ 配额含已确认投递，重启不会清零，并发入队不越界', async () => {
    const tmp = await tempDataDir('collaboration-quota');
    try {
      const inbox = new AgentInbox(tmp.dir);
      const letter = { toAgentId: 'b', fromAgentId: 'a', fromName: '甲', text: '核对', priority: false, depth: 1,
        kind: 'room' as const, room: { roomId: 'r', roomName: '群', roundId: 'round', speaker: '甲', summoned: true } };
      const attempts = await Promise.all(Array.from({ length: 8 }, () => inbox.enqueueRoom(letter, 2)));
      assert.equal(attempts.filter(Boolean).length, 2);
      const claimed = await inbox.claim('b', { owner: 'test', leaseMs: 10000, maxAttempts: 3 });
      await inbox.ack('b', claimed.map(item => item.id), leaseOf(claimed[0]!));
      assert.equal(await new AgentInbox(tmp.dir).enqueueRoom(letter, 2), undefined);
    } finally { await tmp.cleanup(); }
  });

  it('新入群成员不会消费入群前的旧投递', async () => {
    const f = await fixture();
    try {
      await f.runtime.inbox.enqueue({ toAgentId: f.b.id, fromAgentId: f.a.id, fromName: '甲', text: '旧消息', depth: 1,
        priority: false, kind: 'room', room: { roomId: f.room.id, roomName: f.room.name, roundId: 'old', speaker: '甲', summoned: true } });
      await f.runtime.rooms.setMembers(f.room.id, [f.a.id]);
      await new Promise(resolve => setTimeout(resolve, 5));
      await f.runtime.rooms.setMembers(f.room.id, [f.a.id, f.b.id]);
      await f.runtime.drainInbox(f.b.id);
      assert.equal(f.fake.calls.length, 0); assert.equal(await f.runtime.pendingMail(f.b.id), 0);
    } finally { await f.close(); }
  });
});

describe('1:1 图片贯通与控制量', () => {
  const images = [{ url: 'https://example.com/screenshot.png', alt: '界面截图' }];
  it('图像进收件箱、归档、收件人当前模型输入，群图明确拒绝', async () => {
    const f = await fixture();
    try {
      await assert.rejects(f.send.execute({ target_id: f.room.id, message: '看图', images }, f.context()), /群里只有纯文本/);
      await f.send.execute({ target_id: f.b.id, message: '看这张图', images }, f.context());
      assert.deepEqual((await f.runtime.inbox.peek(f.b.id))[0]?.images, images);
      assert.deepEqual((await f.runtime.correspondence.list(f.a.id))[0]?.images, images);
      await waitFor(() => f.fake.calls.length === 1, '收件人读取图片');
      assert.deepEqual(f.fake.calls[0]!.at(-1)?.images, images);
      f.fake.releaseText(0, '已查看');
      await until(async () => await f.runtime.pendingMail(f.b.id) === 0, '确认');
    } finally { await f.close(); }
  });
  it('非法协议、过量图片、过长说明在投递前拒绝；窗口为图片预留预算', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://user:password@example.com/a.png']) {
      assert.throws(() => validateInputImages([{ url }]));
    }
    assert.throws(() => validateInputImages(Array(5).fill(images[0])));
    assert.throws(() => validateInputImages([{ ...images[0], alt: 'x'.repeat(301) }]));
    assert.throws(() => fitContextWindow([{ role: 'user', content: '看图', images: Array(4).fill(images[0]) }], [], 20000), /超过上下文预算/);
  });
  for (const stream of [false, true]) it(`${stream ? '流式' : '非流式'}兼容 API 真正收到 image_url 内容块`, async () => {
    let requestBody: any;
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      requestBody = JSON.parse(body);
      response.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
      response.end(stream ? 'data: {"choices":[{"delta":{"content":"看到了"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        : JSON.stringify({ choices: [{ message: { content: '看到了' }, finish_reason: 'stop' }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const provider = new OpenAIProvider({ apiKey: 'local-test-only', model: 'fake-vision', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
      const messages = toLLMMessages([{ id: 'm', agentId: 'b', role: 'user', content: { type: 'text', text: '看图' }, images, createdAt: 1, source: 'agent', speaker: '甲' }]);
      await provider.chat(messages, stream ? { onDelta: () => undefined } : {});
      assert.deepEqual(requestBody.messages[0].content.find((part: any) => part.type === 'image_url'), { type: 'image_url', image_url: { url: images[0]!.url } });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
