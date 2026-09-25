/**
 * 手动 UI 验收（VibeHub UI-00）：隔离临时数据 + 假模型，一次造出 9 类界面场景。
 * 与 correspondence-preview.ts 并存（那个只管私聊往来）；本脚本面向全部 UI 任务截图验收。
 * 不读 `.agentbot`、不调用真实模型；Ctrl-C / SIGTERM 时关闭服务并清理临时目录。
 *
 * 场景与触发方式：
 *   1. 普通私聊-图文代码思考   预置消息，打开即见
 *   2. 工具卡-成功失败各一     预置消息，打开即见
 *   3. 同事往来-已发已收       预置往来记录
 *   4. 群聊-点名与多人发言     真房间 + 时间线消息
 *   5. 受控群流程-进行中       真房间 + 真流程（API 可查 /flow）
 *   6. 已暂停-停止之后         发送「停」产生真实 paused
 *   7. 模型报错-失败演示       发送「触发模型错误」实时报错（失败运行不落库，刷新后只剩用户消息）
 *   8. 长对话-跨天两百条       210 条消息跨 3 天
 *   9. 交互卡-待回答           发送「请主人定方向」挂起选项卡
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createAgentServer } from '../../src/server/http.js';
import { FakeProvider } from '../fakes/fake-provider.js';
import { tempDataDir } from '../fakes/test-env.js';
import type { LLMMessage } from '../../src/llm/provider.js';
import type { MessageActor } from '../../src/shared/contracts/message-identity.js';

const temp = await tempDataDir('agentbot-ui-preview');

/** 假模型：按触发词走三条剧本——模型报错 / 选项卡提问 / 慢回复（UI-07 忙碌态）；默认短答 */
const provider = new FakeProvider({
  auto: async (messages: LLMMessage[]) => {
    const last = messages[messages.length - 1];
    const text = typeof last?.content === 'string' ? last.content : '';
    if (text.includes('触发模型错误')) {
      throw new Error('模型服务暂不可用：502 Bad Gateway（预览场景，非真实故障）');
    }
    if (text.includes('慢回复演示')) {
      // UI-07：把这一回合拖住，界面才有稳定的忙碌态可看（占位文字与插话按钮）
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }
    if (text.includes('请主人定方向')) {
      return {
        content: '',
        toolCalls: [{
          id: randomUUID(),
          name: 'SendToUser',
          arguments: JSON.stringify({
            type: 'widget',
            content: '有两件事都能做，想先定个方向。',
            widget: {
              prompt: '这个任务先做哪一个？',
              options: [
                { label: '先修可靠投递缺陷', value: 'fix-delivery' },
                { label: '先做界面打磨', value: 'polish-ui' },
              ],
            },
          }),
        }],
        finishReason: 'tool_calls',
        usage: null,
      };
    }
    return FakeProvider.text('收到，我先看一遍上下文再动手。');
  },
});

const server = await createAgentServer({
  port: 0,
  rootDir: temp.dir,
  dataDir: temp.dir,
  staticDir: resolve('web/dist'),
  allowMissingKey: true,
  createProvider: () => provider,
});
const runtime = server.runtime;

let at = Date.now() - 60_000;
const tick = () => at++;
const actor = (record: { id: string; name: string; color: string }): MessageActor => ({ kind: 'agent', id: record.id, name: record.name, color: record.color });

const createAgent = (name: string, color: string, instructions: string) =>
  runtime.registry.create({ name, color, instructions });

const say = (agentId: string, role: 'user' | 'assistant', content: Parameters<typeof runtime.messages.append>[0]['content'], sender?: MessageActor) =>
  runtime.messages.append({ id: randomUUID(), agentId, role, content, createdAt: tick(), source: role === 'user' ? 'user' : undefined, ...(sender ? { sender } : {}) });

// ── 1. 普通私聊：Markdown、代码块、思考块 ─────────────────────────────
const plain = await createAgent('普通私聊·图文代码思考', '#8b5cf6', '界面验收：展示 Markdown 与代码块');
await say(plain.id, 'user', { type: 'text', text: '把可靠投递的设计讲清楚，给个最小例子。' });
await say(plain.id, 'assistant', { type: 'text', text: [
  '## 可靠投递三件事',
  '',
  '1. **先落库再接单**：受理即持久化，崩溃不丢',
  '2. 领取-确认：同一时刻只有一个执行位',
  '3. 副作用带账本：重启后能核对，不自动重放',
  '',
  '最小例子见下，`inbox` 表是唯一事实源：',
  '',
  '```ts',
  'const item = await inbox.claim(agentId);',
  'try {',
  '  await run(item);',
  '  await inbox.ack(item.id);',
  '} catch {',
  '  await inbox.release(item.id); // 归还，等它空下来',
  '}',
  '```',
].join('\n') }, actor(plain));
await say(plain.id, 'assistant', { type: 'text', text: '这段推理只用于说明场景存在思考块数据：先对比三种投递语义，再决定用领取-确认模型，最后给出最小实现。' });

// ── 2. 工具调用卡：成功、失败各一 ─────────────────────────────────────
const tools = await createAgent('工具卡·成功失败各一', '#38bdf8', '界面验收：展示工具卡两种结局');
await say(tools.id, 'user', { type: 'text', text: '读一下 README，再跑一条会被拒绝的命令。' });
await say(tools.id, 'assistant', { type: 'tool_calls', calls: [
  { id: 'call-read', name: 'Read', arguments: '{"path":"README.md"}' },
  { id: 'call-shell', name: 'Shell', arguments: '{"command":"rm -rf ~/Documents"}' },
] }, actor(tools));
await say(tools.id, 'tool', { type: 'tool_result', callId: 'call-read', name: 'Read', durationMs: 42, ok: true, result: '# AgentBot\n\n本地运行的多智能体协作工作台……（内容截断）' });
await say(tools.id, 'tool', { type: 'tool_result', callId: 'call-shell', name: 'Shell', durationMs: 3, ok: false, result: '命令被安全策略拒绝：危险操作需用户在界面确认' });

// ── 3. 同事往来：已发出 / 已收到 ──────────────────────────────────────
const liaison = await createAgent('同事往来·已发已收', '#f59e0b', '界面验收：展示往来条两侧');
const mate = await createAgent('同事-往来对方', '#a3a3a3', '界面验收：往来的另一端');
await say(liaison.id, 'user', { type: 'text', text: '让同事核对一下模块边界，把结果汇总给我。' });
await say(liaison.id, 'assistant', { type: 'text', text: '已把核对请求交给「同事-往来对方」，收到实际回复后再汇总。' }, actor(liaison));
await runtime.correspondence.record({ id: randomUUID(), from: actor(liaison), to: actor(mate), text: '请核对 routes → services → core 的依赖方向。', createdAt: tick() });
await runtime.correspondence.record({ id: randomUUID(), from: actor(mate), to: actor(liaison), text: '核对完成：依赖方向干净，只有记忆读取跨了两层。', createdAt: tick() });
await say(liaison.id, 'assistant', { type: 'text', text: '对方已回信：依赖方向干净。点上方「消息往来」可核对双方原文。' }, actor(liaison));

// ── 4. 群聊：3 名成员、@ 点名、多人发言 ──────────────────────────────
const lead = await createAgent('主持-群聊场景', '#22c55e', '界面验收：群聊主持');
const debater = await createAgent('同事甲-群聊场景', '#ef4444', '界面验收：群聊发言者');
const critic = await createAgent('同事乙-群聊场景', '#3b82f6', '界面验收：群聊发言者');
const group = await runtime.rooms.create({ name: '群聊·点名与多人发言', memberIds: [lead.id, debater.id, critic.id] });
const roomSay = (sender: { kind: 'user' | 'agent'; id: string; name: string; color?: string }, text: string, mentions: string[] = [], everyone = false) =>
  runtime.rooms.append({
    id: randomUUID(), roomId: group.id, roundId: randomUUID(),
    senderKind: sender.kind === 'user' ? 'user' : 'agent', senderId: sender.id, senderName: sender.name, senderColor: sender.color,
    text, mentions, everyone, createdAt: tick(),
  });
await roomSay({ kind: 'user', id: 'owner', name: '主人' }, '下周发版，先定投递方案。@同事甲-群聊场景 你这边什么意见？', [debater.id]);
await roomSay({ kind: 'agent', id: lead.id, name: lead.name, color: lead.color }, `@${debater.name} 我跟一条：先把边界说死，再谈排期。`, [debater.id]);
await roomSay({ kind: 'agent', id: debater.id, name: debater.name, color: debater.color }, '边界没分歧：领取-确认 + 账本核对。我建议这两周只做这两件。', [], false);
await roomSay({ kind: 'agent', id: critic.id, name: critic.name, color: critic.color }, `同意。补一句：@${lead.name} 别把回放做成自动重放。`, [lead.id]);
await roomSay({ kind: 'user', id: 'owner', name: '主人' }, '@所有人 就按这个方向，明天同步进度。', [], true);

// ── 5. 受控群流程：进行中（真流程，UI 流程条见 UI-11） ────────────────
const flowLead = await createAgent('主持-受控流程场景', '#14b8a6', '界面验收：受控流程主持');
const flowA = await createAgent('同事甲-受控流程场景', '#f97316', '界面验收：受控流程第一步');
const flowB = await createAgent('同事乙-受控流程场景', '#6366f1', '界面验收：受控流程第二步');
const flowRoom = await runtime.rooms.create({ name: '受控群流程·进行中', memberIds: [flowLead.id, flowA.id, flowB.id] });
const flowRoomSay = (sender: { kind: 'user' | 'agent'; id: string; name: string; color?: string }, text: string, mentions: string[] = []) =>
  runtime.rooms.append({
    id: randomUUID(), roomId: flowRoom.id, roundId: randomUUID(),
    senderKind: sender.kind === 'user' ? 'user' : 'agent', senderId: sender.id, senderName: sender.name, senderColor: sender.color,
    text, mentions, everyone: false, createdAt: tick(),
  });
await flowRoomSay({ kind: 'user', id: 'owner', name: '主人' }, '按顺序过一遍发版检查清单，一个人说一项。', [flowA.id]);
await flowRoomSay({ kind: 'agent', id: flowA.id, name: flowA.name, color: flowA.color }, '第一项：迁移备份已就位，核验报告生成正常。');
await flowRoomSay({ kind: 'agent', id: flowB.id, name: flowB.name, color: flowB.color }, '第二项：桌面冒烟通过，锁释放在 SIGTERM 后 200ms 内。');
const activeFlow = await runtime.roomFlowService.startFlow({
  roomId: flowRoom.id,
  coordinatorId: flowLead.id,
  protocolId: 'sequential_turn',
  actors: [{ kind: 'agent', id: flowA.id }, { kind: 'agent', id: flowB.id }],
  rootCommandId: flowLead.id,
  chainId: flowLead.id,
});

// ── 6. 已暂停：真实「停」产生 paused ─────────────────────────────────
const paused = await createAgent('已暂停·停止之后', '#ef4444', '界面验收：发送「停」后被暂停');
await say(paused.id, 'user', { type: 'text', text: '这批自动跟进先停下来，我要复核。' });
await say(paused.id, 'assistant', { type: 'text', text: '好，我停下自动处理，等你复核后再继续。' }, actor(paused));
await runtime.send(paused.id, '停');

// ── 7. 模型报错：实时失败（不落库，需在界面里对这位同事发「触发模型错误」） ──
const failing = await createAgent('模型报错·失败演示', '#6b7280', '界面验收：模型报错时的错误行');
await say(failing.id, 'user', { type: 'text', text: '在界面里对这位同事发送「触发模型错误」，可看到报错行。' });
await say(failing.id, 'assistant', { type: 'text', text: '好，我待命。你发触发词我就演示一次模型报错。' }, actor(failing));

// ── 8. 长对话：210 条跨 3 天 ────────────────────────────────────────
const long = await createAgent('长对话·跨天两百条', '#0ea5e9', '界面验收：长对话滚动与日期分隔');
const longStart = Date.now() - 3 * 24 * 60 * 60 * 1000;
for (let i = 0; i < 210; i += 1) {
  const isUser = i % 3 === 0;
  await runtime.messages.append({
    id: randomUUID(),
    agentId: long.id,
    role: isUser ? 'user' : 'assistant',
    content: { type: 'text', text: isUser ? `第 ${i + 1} 轮：把上一步的结论再细化一点。` : `第 ${i + 1} 轮回复：结论不变，补充了边界与例外。` },
    createdAt: longStart + i * 20 * 60 * 1000,
    source: isUser ? 'user' : undefined,
    ...(isUser ? {} : { sender: actor(long) }),
  });
}

// ── 9. 交互卡：挂起一个待回答选项卡 ─────────────────────────────────
const interactive = await createAgent('交互卡·待回答', '#ec4899', '界面验收：选项卡等待用户回答');
await say(interactive.id, 'user', { type: 'text', text: '请主人定方向，再开工。' });
// 与 HTTP 路由同款：受理后不等待回合——这一回合会挂在等回答上，界面里才答得了
const interactiveAccepted = await runtime.acceptMessage(interactive.id, '请主人定方向');
void interactiveAccepted.execute().catch(() => undefined);

// ── 10. 忙碌态：对这位同事发含「慢回复演示」的话，回合被拖住（UI-07）──
const busy = await createAgent('忙碌态·慢回复演示', '#64748b', '界面验收：发送含「慢回复演示」的话，占位文字变忙碌态');
await say(busy.id, 'user', { type: 'text', text: '等一下再回：先看别的。' });
await say(busy.id, 'assistant', { type: 'text', text: '好，我在。' }, actor(busy));

console.log(JSON.stringify({
  url: server.url,
  dataDir: temp.dir,
  scenes: {
    '普通私聊·图文代码思考': plain.id,
    '工具卡·成功失败各一': tools.id,
    '同事往来·已发已收': liaison.id,
    '群聊·点名与多人发言': group.id,
    '受控群流程·进行中': flowRoom.id,
    '已暂停·停止之后': paused.id,
    '模型报错·失败演示': failing.id,
    '长对话·跨天两百条': long.id,
    '交互卡·待回答': interactive.id,
    '忙碌态·慢回复演示': busy.id,
  },
  activeFlowId: activeFlow.id,
  hint: '场景 7 在界面里对该同事发送「触发模型错误」可看到实时报错行（失败运行不落库，刷新后只剩用户消息）；场景 10 发送含「慢回复演示」的话会把回合拖住 8 秒，用来看忙碌态占位文字（UI-07）',
}, null, 2));

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  await temp.cleanup();
  process.exit(0);
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
