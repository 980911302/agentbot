/**
 * 真实重启夹具（E4.3）：子进程驱动持久等待，然后被父进程 SIGKILL。
 *
 * 用法：node --import tsx test/fixtures/wait-and-crash.ts <dataDir> <phase>
 *
 *   park-agent  甲把活派给乙（落一条 kind=agent 的 WorkWait），打印 PARKED 后挂住。
 *   reply       新进程重开同一份数据目录：证明等待还在 → 投一封乙的回信 → 打印 REPLIED。
 *   park-card   甲用 SendToUser(widget) 问用户一句（落一条 kind=user 的 WorkWait），
 *               打印 CARD 后挂住。
 *   answer      新进程重开同一份目录：证明待答卡被重建 → 用交互 id 作答 →
 *               打印 ANSWERED（等待已解决、工作回到 active、新回合已开）。
 *
 * 关键点：两个 phase 之间是**真 SIGKILL**（不是优雅退出、也不是「再 new 一个 service」），
 * 数据目录里的 work/waits.json 是唯一交接物。只写 <dataDir>（调用方给临时目录）；
 * 不联网、不碰真实模型。
 */
import { AgentRuntime } from '../../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../../src/context/budget.js';
import { createSendToUserTool } from '../../src/tools/builtin/send-to-user.js';
import { ArtifactService } from '../../src/tools/services/artifact-service.js';
import { FakeProvider } from '../fakes/fake-provider.js';
import { InteractionBroker } from '../../src/interaction/broker.js';
import { SecretStore } from '../../src/secret/store.js';

const [dir, phase] = process.argv.slice(2);
if (!dir || !phase) {
  console.error('用法：wait-and-crash.ts <dataDir> <park-agent|reply|park-card|answer>');
  process.exit(2);
}

const SEND_MARKER = '帮我查一下接口的实现情况';
const CARD_MARKER = '帮我把部署这件事做完';
const REPLY_MARKER = '接口在这里：src/api/routes.ts';

/**
 * 假模型：按标记决定动作，其余一律回普通文本。
 * 派活与提问都只做一次——每次调用都触发会让回合反复落等待。
 */
function fakeFor(peerId: string): FakeProvider {
  let dispatched = 0;
  let asked = 0;
  return new FakeProvider({
    auto: (messages) => {
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
      if (text.includes(SEND_MARKER) && dispatched++ === 0) {
        return FakeProvider.toolCalls([
          {
            id: 'c1',
            name: 'SendToAgent',
            arguments: JSON.stringify({ target_id: peerId, message: '请把接口实现核对一遍' }),
          },
        ]);
      }
      if (text.includes(CARD_MARKER) && asked++ === 0) {
        return FakeProvider.toolCalls([
          {
            id: 'c2',
            name: 'SendToUser',
            arguments: JSON.stringify({
              type: 'widget',
              widget: { prompt: '要不要继续部署？', options: [{ label: '要' }, { label: '不要' }] },
            }),
          },
        ]);
      }
      return { content: '好，我接着看。', toolCalls: [], finishReason: 'stop', usage: null };
    },
  });
}

async function open(
  dataDir: string,
  peerId: string,
): Promise<{ runtime: AgentRuntime; provider: FakeProvider }> {
  const broker = new InteractionBroker();
  const secrets = new SecretStore(dataDir);
  const provider = fakeFor(peerId);
  const tools = [
    createSendToUserTool({
      rootDir: dataDir,
      broker,
      secrets,
      agentName: async () => '甲',
      artifacts: new ArtifactService({ roots: [dataDir] }),
    }),
  ];
  const runtime = new AgentRuntime({
    dataDir,
    tools,
    broker,
    secrets,
    createProvider: () => provider,
    defaultModel: 'fake',
    knownModels: ['fake'],
    budget: DEFAULT_BUDGET,
    memoryExtraction: false,
  });
  return { runtime, provider };
}

async function untilNow(predicate: () => Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function ensureAgents(runtime: AgentRuntime): Promise<{ a: string; b: string }> {
  const existing = await runtime.registry.list();
  const a = existing.find((agent) => agent.name === '甲') ?? (await runtime.createAgent({ name: '甲' }));
  const b = existing.find((agent) => agent.name === '乙') ?? (await runtime.createAgent({ name: '乙' }));
  return { a: a.id, b: b.id };
}

/** 甲乙的 id 是跨进程交接的前提：先探一次，再装假模型 */
async function settleAgents(dataDir: string): Promise<{ a: string; b: string }> {
  const { runtime: probe } = await open(dataDir, 'pending');
  const ids = await ensureAgents(probe);
  await probe.close();
  return ids;
}

/** 挂住等父进程 SIGKILL：这是「真强退」，不是优雅退出 */
const hang = () => setInterval(() => undefined, 1000);

if (phase === 'park-agent') {
  const { a, b } = await settleAgents(dir);
  const { runtime } = await open(dir, b);
  await runtime.recover();
  const result = await runtime.send(a, SEND_MARKER);
  await untilNow(
    async () => (await runtime.waits.listPending({ agentId: a, kind: 'agent' })).length > 0,
    '甲的同事等待落盘',
  );
  const [wait] = await runtime.waits.listPending({ agentId: a, kind: 'agent' });
  console.log(
    `PARKED ${JSON.stringify({
      a,
      b,
      waitId: wait!.id,
      workId: wait!.workId,
      correlationId: wait!.correlationId,
      stopReason: result.stopReason,
    })}`,
  );
  hang();
} else if (phase === 'reply') {
  const { a, b } = await settleAgents(dir);
  const { runtime, provider } = await open(dir, b);
  await runtime.recover();
  const before = await runtime.waits.listPending({ agentId: a, kind: 'agent' });

  await runtime.inbox.enqueue({
    toAgentId: a,
    fromAgentId: b,
    fromName: '乙',
    text: REPLY_MARKER,
    priority: false,
    depth: 1,
    kind: 'message',
  });
  await runtime.drainInbox(a);
  await untilNow(
    async () => (await runtime.waits.listPending({ agentId: a, kind: 'agent' })).length === 0,
    '回信把等待接上',
  );
  await untilNow(
    async () => (await runtime.works.get(before[0]!.workId!))?.status === 'active',
    '工作回到 active',
  );

  const after = await runtime.waits.findByCorrelation(`agent:${b}`);
  const work = await runtime.works.get(before[0]!.workId!);
  const letters = await runtime.messages.list(a);
  console.log(
    `REPLIED ${JSON.stringify({
      pendingBefore: before.length,
      waitId: before[0]!.id,
      waitStatus: after.find((wait) => wait.id === before[0]!.id)?.status,
      resultRef: after.find((wait) => wait.id === before[0]!.id)?.resultRef,
      workStatus: work?.status,
      replied: letters.some(
        (message) => message.content.type === 'text' && message.content.text.includes(REPLY_MARKER),
      ),
      // 唤醒这一轮带着工作身份：来信不是一封陌生的信，而是「继续那件工作」
      workBriefSeen: provider.calls.some((call) => JSON.stringify(call).includes('【当前工作】')),
      stopReasons: runtime.chatRuns.list().map((run) => run.stopReason),
    })}`,
  );
  await runtime.close();
  process.exit(0);
} else if (phase === 'park-card') {
  const { a, b } = await settleAgents(dir);
  const { runtime } = await open(dir, b);
  await runtime.recover();
  const result = await runtime.send(a, `${CARD_MARKER}，先问我一句`);
  const cards = runtime.listInteractions(a);
  if (cards.length === 0) throw new Error('问题卡没有登记到交互列表');
  const [wait] = await runtime.waits.listPending({ agentId: a, kind: 'user' });
  console.log(
    `CARD ${JSON.stringify({
      a,
      b,
      cardId: cards[0]!.id,
      waitId: wait!.id,
      workId: wait!.workId,
      question: cards[0]!.question,
      stopReason: result.stopReason,
      pending: (await runtime.waits.listPending({ agentId: a, kind: 'user' })).length,
    })}`,
  );
  hang();
} else if (phase === 'answer') {
  const { a, b } = await settleAgents(dir);
  const { runtime } = await open(dir, b);
  await runtime.recover();
  // 重启后卡片从持久等待重建（不是序列化 Promise）
  const cards = runtime.listInteractions(a);
  const [wait] = await runtime.waits.listPending({ agentId: a, kind: 'user' });
  if (!wait) throw new Error('重启后待答等待不见了');
  const outcome = await runtime.answerInteraction(wait.correlationId, { value: '要' });
  await untilNow(
    async () => (await runtime.works.get(wait.workId!))?.status === 'active',
    '工作回到 active',
  );
  const work = await runtime.works.get(wait.workId!);
  const messages = await runtime.messages.list(a);
  console.log(
    `ANSWERED ${JSON.stringify({
      a,
      b,
      cardsAfterRestart: cards.length,
      cardQuestion: cards[0]?.question,
      waitStatusAfter: (await runtime.waits.findByCorrelation(wait.correlationId)).find(
        (item) => item.id === wait.id,
      )?.status,
      answerOk: outcome.ok,
      runId: outcome.ok ? outcome.runId : undefined,
      workStatus: work?.status,
      continued: messages.some(
        (message) => message.content.type === 'text' && message.content.text.includes('用户回答了问题卡'),
      ),
    })}`,
  );
  await runtime.close();
  process.exit(0);
} else {
  console.error(`未知 phase：${phase}`);
  process.exit(2);
}