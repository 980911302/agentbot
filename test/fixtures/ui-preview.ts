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
 *  11. 手头工作-三件在办        2 件进行中 + 1 件等待中（E4.7「工作」标签的验收场景）
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAgentServer } from '../../src/server/http.js';
import { FakeProvider } from '../fakes/fake-provider.js';
import { tempDataDir } from '../fakes/test-env.js';
import { agentWaitKey } from '../../src/work/wait.js';
import { testPngDataUrl } from '../fakes/avatar-fixture.js';
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
        toolCalls: [
          {
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
          },
        ],
        finishReason: 'tool_calls',
        usage: null,
      };
    }
    return FakeProvider.text('收到，我先看一遍上下文再动手。');
  },
});

// 固定端口给 Playwright 的 webServer 探活用（缺省 0 = 随机端口）
const port = Number(process.env.AGENT_PREVIEW_PORT ?? 0);
// OPT-06：起服务前把控制存储写坏，用来看「控制数据损坏 → 修复」那条链路
const corruptControl = process.env.AGENT_PREVIEW_CORRUPT_CONTROL === '1';
if (corruptControl) {
  await mkdir(join(temp.dir, 'control'), { recursive: true });
  await writeFile(join(temp.dir, 'control', 'state.json'), '{"controlSeq": 5, 坏掉的控制数据');
}
const server = await createAgentServer({
  port,
  rootDir: temp.dir,
  dataDir: temp.dir,
  staticDir: resolve('web/dist'),
  allowMissingKey: true,
  createProvider: () => provider,
});
const runtime = server.runtime;

let at = Date.now() - 60_000;
const tick = () => at++;
const actor = (record: { id: string; name: string; color: string }): MessageActor => ({
  kind: 'agent',
  id: record.id,
  name: record.name,
  color: record.color,
});

const createAgent = (name: string, color: string, instructions: string) =>
  runtime.registry.create({ name, color, instructions });

const say = (
  agentId: string,
  role: 'user' | 'assistant',
  content: Parameters<typeof runtime.messages.append>[0]['content'],
  sender?: MessageActor,
) =>
  runtime.messages.append({
    id: randomUUID(),
    agentId,
    role,
    content,
    createdAt: tick(),
    source: role === 'user' ? 'user' : undefined,
    ...(sender ? { sender } : {}),
  });

// ── 1. 普通私聊：Markdown、代码块、思考块 ─────────────────────────────
const plain = await createAgent('普通私聊·图文代码思考', '#8b5cf6', '界面验收：展示 Markdown 与代码块');
await say(plain.id, 'user', { type: 'text', text: '把可靠投递的设计讲清楚，给个最小例子。' });
await say(
  plain.id,
  'assistant',
  {
    type: 'text',
    text: [
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
    ].join('\n'),
  },
  actor(plain),
);
await say(plain.id, 'assistant', {
  type: 'text',
  text: '这段推理只用于说明场景存在思考块数据：先对比三种投递语义，再决定用领取-确认模型，最后给出最小实现。',
});

// ── 2. 工具调用卡：成功、失败各一 ─────────────────────────────────────
const tools = await createAgent('工具卡·成功失败各一', '#38bdf8', '界面验收：展示工具卡两种结局');
await say(tools.id, 'user', { type: 'text', text: '读一下 README，再跑一条会被拒绝的命令。' });
await say(
  tools.id,
  'assistant',
  {
    type: 'tool_calls',
    calls: [
      { id: 'call-read', name: 'Read', arguments: '{"path":"README.md"}' },
      { id: 'call-shell', name: 'Shell', arguments: '{"command":"rm -rf ~/Documents"}' },
    ],
  },
  actor(tools),
);
await say(tools.id, 'tool', {
  type: 'tool_result',
  callId: 'call-read',
  name: 'Read',
  durationMs: 42,
  ok: true,
  result: '# AgentBot\n\n本地运行的多智能体协作工作台……（内容截断）',
});
await say(tools.id, 'tool', {
  type: 'tool_result',
  callId: 'call-shell',
  name: 'Shell',
  durationMs: 3,
  ok: false,
  result: '命令被安全策略拒绝：危险操作需用户在界面确认',
});

// ── 3. 同事往来：已发出 / 已收到 ──────────────────────────────────────
const liaison = await createAgent('同事往来·已发已收', '#f59e0b', '界面验收：展示往来条两侧');
const mate = await createAgent('同事-往来对方', '#a3a3a3', '界面验收：往来的另一端');
await say(liaison.id, 'user', { type: 'text', text: '让同事核对一下模块边界，把结果汇总给我。' });
await say(
  liaison.id,
  'assistant',
  { type: 'text', text: '已把核对请求交给「同事-往来对方」，收到实际回复后再汇总。' },
  actor(liaison),
);
await runtime.correspondence.record({
  id: randomUUID(),
  from: actor(liaison),
  to: actor(mate),
  text: '请核对 routes → services → core 的依赖方向。',
  createdAt: tick(),
});
await runtime.correspondence.record({
  id: randomUUID(),
  from: actor(mate),
  to: actor(liaison),
  text: '核对完成：依赖方向干净，只有记忆读取跨了两层。',
  createdAt: tick(),
});
await say(
  liaison.id,
  'assistant',
  { type: 'text', text: '对方已回信：依赖方向干净。点上方「消息往来」可核对双方原文。' },
  actor(liaison),
);

// ── 4. 群聊：3 名成员、@ 点名、多人发言 ──────────────────────────────
const lead = await createAgent('主持-群聊场景', '#22c55e', '界面验收：群聊主持');
const debater = await createAgent('同事甲-群聊场景', '#ef4444', '界面验收：群聊发言者');
const critic = await createAgent('同事乙-群聊场景', '#3b82f6', '界面验收：群聊发言者');
const group = await runtime.rooms.create({
  name: '群聊·点名与多人发言',
  memberIds: [lead.id, debater.id, critic.id],
});
const roomSay = (
  sender: { kind: 'user' | 'agent'; id: string; name: string; color?: string },
  text: string,
  mentions: string[] = [],
  everyone = false,
) =>
  runtime.rooms.append({
    id: randomUUID(),
    roomId: group.id,
    roundId: randomUUID(),
    senderKind: sender.kind === 'user' ? 'user' : 'agent',
    senderId: sender.id,
    senderName: sender.name,
    senderColor: sender.color,
    text,
    mentions,
    everyone,
    createdAt: tick(),
  });
await roomSay(
  { kind: 'user', id: 'owner', name: '主人' },
  '下周发版，先定投递方案。@同事甲-群聊场景 你这边什么意见？',
  [debater.id],
);
await roomSay(
  { kind: 'agent', id: lead.id, name: lead.name, color: lead.color },
  `@${debater.name} 我跟一条：先把边界说死，再谈排期。`,
  [debater.id],
);
await roomSay(
  { kind: 'agent', id: debater.id, name: debater.name, color: debater.color },
  '边界没分歧：领取-确认 + 账本核对。我建议这两周只做这两件。',
  [],
  false,
);
await roomSay(
  { kind: 'agent', id: critic.id, name: critic.name, color: critic.color },
  `同意。补一句：@${lead.name} 别把回放做成自动重放。`,
  [lead.id],
);
await roomSay({ kind: 'user', id: 'owner', name: '主人' }, '@所有人 就按这个方向，明天同步进度。', [], true);

// ── 5. 受控群流程：进行中（真流程，UI 流程条见 UI-11） ────────────────
const flowLead = await createAgent('主持-受控流程场景', '#14b8a6', '界面验收：受控流程主持');
const flowA = await createAgent('同事甲-受控流程场景', '#f97316', '界面验收：受控流程第一步');
const flowB = await createAgent('同事乙-受控流程场景', '#6366f1', '界面验收：受控流程第二步');
const flowRoom = await runtime.rooms.create({
  name: '受控群流程·进行中',
  memberIds: [flowLead.id, flowA.id, flowB.id],
});
const flowRoomSay = (
  sender: { kind: 'user' | 'agent'; id: string; name: string; color?: string },
  text: string,
  mentions: string[] = [],
) =>
  runtime.rooms.append({
    id: randomUUID(),
    roomId: flowRoom.id,
    roundId: randomUUID(),
    senderKind: sender.kind === 'user' ? 'user' : 'agent',
    senderId: sender.id,
    senderName: sender.name,
    senderColor: sender.color,
    text,
    mentions,
    everyone: false,
    createdAt: tick(),
  });
await flowRoomSay({ kind: 'user', id: 'owner', name: '主人' }, '按顺序过一遍发版检查清单，一个人说一项。', [
  flowA.id,
]);
await flowRoomSay(
  { kind: 'agent', id: flowA.id, name: flowA.name, color: flowA.color },
  '第一项：迁移备份已就位，核验报告生成正常。',
);
await flowRoomSay(
  { kind: 'agent', id: flowB.id, name: flowB.name, color: flowB.color },
  '第二项：桌面冒烟通过，锁释放在 SIGTERM 后 200ms 内。',
);
const activeFlow = await runtime.roomFlowService.startFlow({
  roomId: flowRoom.id,
  coordinatorId: flowLead.id,
  protocolId: 'sequential_turn',
  actors: [
    { kind: 'agent', id: flowA.id },
    { kind: 'agent', id: flowB.id },
  ],
  rootCommandId: flowLead.id,
  chainId: flowLead.id,
});

// ── 6. 已暂停：真实「停」产生 paused ─────────────────────────────────
const paused = await createAgent('已暂停·停止之后', '#ef4444', '界面验收：发送「停」后被暂停');
await say(paused.id, 'user', { type: 'text', text: '这批自动跟进先停下来，我要复核。' });
await say(
  paused.id,
  'assistant',
  { type: 'text', text: '好，我停下自动处理，等你复核后再继续。' },
  actor(paused),
);
// 损坏模式下控制存储不可写，「停」会抛；跳过这一步（那条链路由 test/control-repair.test.ts 覆盖）
if (!corruptControl) await runtime.send(paused.id, '停');

// ── 7. 模型报错：实时失败（不落库，需在界面里对这位同事发「触发模型错误」） ──
const failing = await createAgent('模型报错·失败演示', '#6b7280', '界面验收：模型报错时的错误行');
await say(failing.id, 'user', {
  type: 'text',
  text: '在界面里对这位同事发送「触发模型错误」，可看到报错行。',
});
await say(
  failing.id,
  'assistant',
  { type: 'text', text: '好，我待命。你发触发词我就演示一次模型报错。' },
  actor(failing),
);

// ── 8. 长对话：210 条跨 3 天 ────────────────────────────────────────
const long = await createAgent('长对话·跨天两百条', '#0ea5e9', '界面验收：长对话滚动与日期分隔');
const longStart = Date.now() - 3 * 24 * 60 * 60 * 1000;
for (let i = 0; i < 210; i += 1) {
  const isUser = i % 3 === 0;
  await runtime.messages.append({
    id: randomUUID(),
    agentId: long.id,
    role: isUser ? 'user' : 'assistant',
    content: {
      type: 'text',
      text: isUser
        ? `第 ${i + 1} 轮：把上一步的结论再细化一点。`
        : `第 ${i + 1} 轮回复：结论不变，补充了边界与例外。`,
    },
    createdAt: longStart + i * 20 * 60 * 1000,
    source: isUser ? 'user' : undefined,
    ...(isUser ? {} : { sender: actor(long) }),
  });
}

// ── 9. 交互卡：挂起一个待回答选项卡 ─────────────────────────────────
const interactive = await createAgent('交互卡·待回答', '#ec4899', '界面验收：选项卡等待用户回答');
await say(interactive.id, 'user', { type: 'text', text: '请主人定方向，再开工。' });
// 与 HTTP 路由同款：受理后不等待回合——这一回合会挂在等回答上，界面里才答得了
// 损坏模式下受理会被控制面拒绝（这正是保护模式该有的行为），跳过
if (!corruptControl) {
  const interactiveAccepted = await runtime.acceptMessage(interactive.id, '请主人定方向');
  void interactiveAccepted.execute().catch(() => undefined);
}

// ── 10. 忙碌态：对这位同事发含「慢回复演示」的话，回合被拖住（UI-07）──
const busy = await createAgent(
  '忙碌态·慢回复演示',
  '#64748b',
  '界面验收：发送含「慢回复演示」的话，占位文字变忙碌态',
);
await say(busy.id, 'user', { type: 'text', text: '等一下再回：先看别的。' });
await say(busy.id, 'assistant', { type: 'text', text: '好，我在。' }, actor(busy));

// ── 11. 手头工作：2 件进行中 + 1 件等待中（E4.7 验收场景 1）──────────
// 造数据走 WorkService 本身（acceptUserMessage / update / appendStep），不直接写存储，
// 这样状态机的校验也在预览里生效。等待那件同时落一条 pending WorkWait，
// 与运行时进 waiting 的行为一致（runtime 会把 WorkWait.condition 写进 work.nextAction）。
const worker = await createAgent('手头工作·三件在办', '#22c55e', '界面验收：工作标签列出目标/状态/进展/等待对象/下一步/交付物');
const peers = await createAgent('同事-手头工作的等待对象', '#a3a3a3', '界面验收：被等待的那位同事');

/** 发一条用户消息并返回它的 id（工作要记来源消息） */
const workSeed = async (agentId: string, text: string) => {
  const messageId = randomUUID();
  await runtime.messages.append({
    id: messageId,
    agentId,
    role: 'user',
    content: { type: 'text', text },
    createdAt: tick(),
    source: 'user',
  });
  return messageId;
};

const acceptWork = async (text: string) => {
  const accepted = await runtime.works.acceptUserMessage({
    agentId: worker.id,
    channel: { kind: 'dm', id: worker.id },
    messageId: await workSeed(worker.id, text),
    text,
  });
  if (!accepted || accepted.kind === 'clarify') throw new Error(`预览造工作失败：${text}`);
  return accepted.work;
};

// 进行中之一：有进展、有下一步、有交付物引用、有步骤与验收。
// 目标写两句，界面才会把「目标」与标题分开列（标题只取第一句）。
const uiWork = await acceptWork(
  '把 UI-06 保存条那条缺陷修掉，补上几何断言。断言要卡住条子底边与抽屉底边的关系，别只断元素存在。',
);
await runtime.works.update(uiWork.id, {
  status: 'active',
  progressSummary: '已定位到父级滚动容器，条子改回贴抽屉底边；正在补 6 张截图矩阵的几何断言。',
  nextAction: '补齐深色两档的截图断言',
  acceptance: ['保存条底边贴住抽屉底边，内容滚动不影响它', '浅/深 × 1280/1024/768 都有几何数值'],
  // artifactIds 是不透明引用：仓库里还没有「按 id 取产物」的接口，
  // 界面只能把引用本身显示出来（不编文件名）。
  artifactIds: ['9f2c1d7ab3e4', '5c8e0a41dff2'],
});
await runtime.works.appendStep({
  workId: uiWork.id,
  title: '读 UI-06 打回记录，复现「条子在视口外」',
  status: 'completed',
});
await runtime.works.appendStep({ workId: uiWork.id, title: '把滚动收进 profile-drawer-body', status: 'completed' });
await runtime.works.appendStep({
  workId: uiWork.id,
  title: '补 6 张截图矩阵的几何断言',
  status: 'in_progress',
  note: '还差深色两档',
});
await runtime.works.appendStep({ workId: uiWork.id, title: '请主人复核截图', status: 'pending' });

// 进行中之二：没有交付物（界面要如实说「还没有交付物」）。
// 第二、三件都带「另外」——E4.2 判定这是新工作的真实路径（同一同事上已经有一件在办，
// 不带这个标志词的消息会按「继续最近那件」接到第一件上）。
const displayNameWork = await acceptWork('另外把群消息显示名被请求体覆盖的缺陷修掉，补一条回归');
await runtime.works.update(displayNameWork.id, {
  status: 'active',
  progressSummary: '已确认显示名只该取后端设置；回归用例写完，正在跑全量。',
  nextAction: '跑完整 npm test，确认没有别的调用方依赖旧行为',
  acceptance: ['请求体里的名字不再覆盖后端设置'],
});
await runtime.works.appendStep({
  workId: displayNameWork.id,
  title: '复现：请求体覆盖后端名字',
  status: 'completed',
});
await runtime.works.appendStep({ workId: displayNameWork.id, title: '改成只读后端设置', status: 'in_progress' });

// 等待中：真实 pending WorkWait + 工作 status=waiting，nextAction 就是「在等谁」
const waitingWork = await acceptWork('另外跟进一下 159 的日志核对，拿到结论再收口');
await runtime.works.update(waitingWork.id, {
  status: 'waiting',
  progressSummary: '核对请求已经发出去，对方还没回；等结论回来再决定是否降级。',
  nextAction: `等「${peers.name}」给出 159 的日志结论`,
});
await runtime.works.appendStep({ workId: waitingWork.id, title: '整理 159 的异常时间线', status: 'completed' });
await runtime.works.appendStep({
  workId: waitingWork.id,
  title: `发核对请求给「${peers.name}」`,
  status: 'completed',
});
await runtime.works.appendStep({ workId: waitingWork.id, title: '等回信', status: 'pending' });
await runtime.waits.create({
  agentId: worker.id,
  workId: waitingWork.id,
  kind: 'agent',
  correlationId: agentWaitKey(peers.id),
  condition: `等「${peers.name}」给出 159 的日志结论`,
});

// ── 12. 同事资料与头像（E5.1）：四个字段分开 + 通过资源接口展示的头像 ──
// 头像走资料服务落盘到数据目录的 avatars/，界面预览读 GET /api/agents/:id/avatar
await runtime.profiles.updateById(plain.id, {
  title: '联调负责人',
  description: '负责接口联调与验收，先看契约再动手。',
  avatar: { dataUrl: testPngDataUrl() },
});

console.log(
  JSON.stringify(
    {
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
        '手头工作·三件在办': worker.id,
        '资料与头像（E5.1 走普通私聊）': plain.id,
      },
      activeFlowId: activeFlow.id,
      works: { active: [uiWork.id, displayNameWork.id], waiting: waitingWork.id },
      hint: '场景 7 在界面里对该同事发送「触发模型错误」可看到实时报错行（失败运行不落库，刷新后只剩用户消息）；场景 10 发送含「慢回复演示」的话会把回合拖住 8 秒，用来看忙碌态占位文字（UI-07）',
    },
    null,
    2,
  ),
);

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
