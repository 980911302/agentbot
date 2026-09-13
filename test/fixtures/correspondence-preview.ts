/** 手动 UI 验收：隔离临时数据、假模型，不读取真实聊天或调用模型服务。Ctrl-C 清理。 */
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgentServer } from '../../src/server/http.js';
import { FakeProvider } from '../fakes/fake-provider.js';
import { tempDataDir } from '../fakes/test-env.js';
import type { MessageActor } from '../../src/shared/contracts/message-identity.js';

const temp = await tempDataDir('agentbot-correspondence-preview');
const server = await createAgentServer({ port: 0, rootDir: temp.dir, dataDir: temp.dir,
  staticDir: resolve('web/dist'), allowMissingKey: true, createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('[]') }) });
const runtime = server.runtime;
const main = await runtime.registry.create({ name: '幕僚-界面验收', color: '#8b5cf6' });
const architect = await runtime.registry.create({ name: '架构师-界面验收', color: '#38bdf8' });
const tester = await runtime.registry.create({ name: '测试工程师-界面验收', color: '#f59e0b' });
const actor = (record: typeof main): MessageActor => ({ kind: 'agent', id: record.id, name: record.name, color: record.color });
let at = Date.now() - 10000;
const say = (role: 'user' | 'assistant', text: string) => runtime.messages.append({ id: randomUUID(), agentId: main.id, role,
  content: { type: 'text', text }, createdAt: at++, source: 'user', ...(role === 'assistant' ? { sender: actor(main) } : {}) });
const send = (from: typeof main, to: typeof main, text: string) => runtime.correspondence.record({ id: randomUUID(), from: actor(from), to: actor(to), text, createdAt: at++ });
await say('user', '请让架构师和测试工程师分别检查，然后汇总。');
await say('assistant', '已分别派发两项检查任务，收到实际回复后汇总。');
await send(main, architect, '请核对模块依赖边界。');
await send(main, tester, '请运行测试，并把实际结果回给我。');
await say('assistant', '两封任务消息已投递，投递状态不代表检查已完成。');
await send(architect, main, '架构检查完成：消息身份应与模型 role 分离。');
await send(tester, main, '测试完成：来源映射、分页与重放去重已覆盖。');
await say('assistant', '两位同事都已回信。点击上方「消息往来」可核对双方原文。');
await runtime.messages.append({ id: randomUUID(), agentId: main.id, role: 'user', source: 'room', roomId: 'example-room',
  roomName: '开发群', speaker: architect.name, sender: actor(architect), content: { type: 'text', text: '这是架构师在群里的发言，不是用户在私聊里说的话。' }, createdAt: at++ });
await runtime.messages.append({ id: randomUUID(), agentId: main.id, role: 'user', source: 'agent', speaker: '旧记录里的同事',
  content: { type: 'text', text: '旧消息保留已有来源，不猜测缺失的往来链路。' }, createdAt: at++ });
console.log(JSON.stringify({ url: server.url, dataDir: temp.dir, agentId: main.id }));
let closing = false;
const close = async () => { if (closing) return; closing = true; await server.close(); await temp.cleanup(); process.exit(0); };
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
