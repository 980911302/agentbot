import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { isActiveChatRun } from '../src/shared/contracts/chat-state.js';
import { InteractionBroker } from '../src/interaction/broker.js';
import { SecretStore } from '../src/secret/store.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { createAgentServer } from '../src/server/http.js';
import { ArtifactService } from '../src/tools/services/artifact-service.js';
import { createSendToUserTool } from '../src/tools/builtin/send-to-user.js';
import { WaitService } from '../src/work/wait-service.js';
import { JsonWorkWaitRepository } from '../src/work/wait-store.js';
import {
  agentWaitKey,
  answerSummary,
  canTransitionWait,
  dueActionOf,
  isWaitDue,
  timeWaitKey,
  type WorkWait,
} from '../src/work/wait.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, until } from './fakes/test-env.js';

/**
 * E4.3 持久等待（WorkWait）：等待是一条记录，不是悬挂的 Promise。
 *
 * 覆盖设计 §4.3 / §7.2：状态机与迟到回答、重启读回、到点扫描（超时 ≠ 已回答）、
 * 用户问题卡（让位释放执行位 / 刷新不作废 / 新句作废）、密钥只留引用、
 * 同事回信唤醒，以及两条验收：真 SIGKILL 重启后仍能接上、等待期间同事能处理别的消息。
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/wait-and-crash.ts', import.meta.url));
const SEND_MARKER = '帮我查一下接口的实现情况';
const REPLY_MARKER = '接口在这里：src/api/routes.ts';

/** 内存里驱动一次真实运行时：SendToUser 工具与 broker/secrets 是同一份实例 */
function makeRuntime(
  dir: string,
  provider: FakeProvider,
): { runtime: AgentRuntime; broker: InteractionBroker; secrets: SecretStore } {
  const broker = new InteractionBroker();
  const secrets = new SecretStore(dir);
  const runtime = new AgentRuntime({
    dataDir: dir,
    tools: [
      createSendToUserTool({
        rootDir: dir,
        broker,
        secrets,
        agentName: async () => '甲',
        artifacts: new ArtifactService({ roots: [dir] }),
      }),
    ],
    broker,
    secrets,
    createProvider: () => provider,
    defaultModel: 'fake',
    knownModels: ['fake'],
    budget: DEFAULT_BUDGET,
    memoryExtraction: false,
  });
  return { runtime, broker, secrets };
}

/** 第一次调用就弹选项卡，之后回普通文本 */
function widgetProvider(): FakeProvider {
  let asked = 0;
  return new FakeProvider({
    auto: () =>
      asked++ === 0
        ? FakeProvider.toolCalls([
            {
              id: 'w1',
              name: 'SendToUser',
              arguments: JSON.stringify({
                type: 'widget',
                widget: { prompt: '要不要继续部署？', options: [{ label: '要' }, { label: '不要' }] },
              }),
            },
          ])
        : FakeProvider.text('好，我接着处理。'),
  });
}

/** 第一次调用弹密钥框 */
function secretProvider(): FakeProvider {
  let asked = 0;
  return new FakeProvider({
    auto: () =>
      asked++ === 0
        ? FakeProvider.toolCalls([
            {
              id: 's1',
              name: 'SendToUser',
              arguments: JSON.stringify({
                type: 'secret-request',
                secret: { name: 'deploy_token', label: '请提供部署令牌' },
              }),
            },
          ])
        : FakeProvider.text('好，我接着处理。'),
  });
}

/** 看到派活标记就把活发给乙（只发一次），其余回普通文本；乙的 id 在断言前才拿得到 */
function dispatchProvider(peerId: () => string): FakeProvider {
  let dispatched = 0;
  return new FakeProvider({
    auto: (messages) => {
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
      if (text.includes(SEND_MARKER) && dispatched++ === 0) {
        return FakeProvider.toolCalls([
          {
            id: 'c1',
            name: 'SendToAgent',
            arguments: JSON.stringify({ target_id: peerId(), message: '请把接口实现核对一遍' }),
          },
        ]);
      }
      return FakeProvider.text('好，我接着看。');
    },
  });
}

async function waitForPending(service: WaitService, what: string, filter?: { kind: WorkWait['kind'] }) {
  await until(async () => (await service.listPending(filter)).length > 0, what);
  return (await service.listPending(filter))[0]!;
}

/**
 * 唤醒回合是在后台跑的（唤醒不该阻塞作答的 HTTP 回执）。收尾前等它跑完，
 * 免得 close()/临时目录清理和它的原子写抢文件——这是测试卫生，不是产品行为。
 */
async function settleRuntime(runtime: AgentRuntime): Promise<void> {
  await until(
    () => Promise.resolve(runtime.chatRuns.list().every((run) => !isActiveChatRun(run))),
    '后台唤醒回合收尾',
  );
}

// ── §4.3 纯判定：状态机与到点语义 ──────────────────────────────

describe('WorkWait 状态机（E4.3）', () => {
  it('只有 pending 能走到终态，终态之间不可互转、不可回退', () => {
    assert.equal(canTransitionWait('pending', 'resolved'), true);
    assert.equal(canTransitionWait('pending', 'cancelled'), true);
    assert.equal(canTransitionWait('pending', 'expired'), true);
    assert.equal(canTransitionWait('pending', 'pending'), false);
    for (const from of ['resolved', 'cancelled', 'expired'] as const) {
      for (const to of ['pending', 'resolved', 'cancelled', 'expired'] as const) {
        assert.equal(canTransitionWait(from, to), false, `${from} → ${to} 不该被允许`);
      }
    }
  });

  it('到点扫描：time 到点算满足条件，user 到点只判过期（超时 ≠ 已回答）', () => {
    const base: WorkWait = {
      id: 'w',
      kind: 'time',
      correlationId: timeWaitKey('早报'),
      status: 'pending',
      agentId: 'a',
      createdAt: 0,
      updatedAt: 0,
      dueAt: 500,
    };
    assert.equal(isWaitDue(base, 499), false);
    assert.equal(isWaitDue(base, 500), true);
    assert.equal(dueActionOf(base), 'wake');
    assert.equal(dueActionOf({ ...base, kind: 'user' }), 'expire');
    // 同事回信 / 外部条件没有业务期限，不由时间驱动
    assert.equal(dueActionOf({ ...base, kind: 'agent' }), 'none');
    assert.equal(dueActionOf({ ...base, kind: 'external' }), 'none');
    assert.equal(isWaitDue({ ...base, dueAt: undefined }, 10 ** 12), false);
  });

  it('关联键说明「等谁」：agent:<同事 id>', () => {
    assert.equal(agentWaitKey('peer-1'), 'agent:peer-1');
    assert.equal(timeWaitKey('早报'), 'time:早报');
  });

  it('回答摘要进对话，密钥回答只说「已保存」不带明文', () => {
    const card: WorkWait = {
      id: 'w',
      kind: 'user',
      correlationId: 'c',
      status: 'pending',
      agentId: 'a',
      createdAt: 0,
      updatedAt: 0,
      card: { question: '部署到哪？', options: [{ id: 'prod', label: '生产' }] },
    };
    assert.match(answerSummary(card, { value: 'prod' }), /部署到哪？.*生产/);
    const secret: WorkWait = {
      ...card,
      card: { question: '请提供令牌', name: 'deploy_token' },
    };
    const summary = answerSummary(secret, { secret: '不会出现在摘要里' });
    assert.match(summary, /deploy_token/);
    assert.doesNotMatch(summary, /不会出现在摘要里/);
  });
});

// ── 等待服务 + 持久化：重启读回、迟到回答给明确状态 ──────────────

describe('WaitService 与 work/waits.json（E4.3）', () => {
  it('落盘后可重开读回；一件工作能等多个结果', async () => {
    const env = await tempDataDir('wait-store');
    try {
      const service = new WaitService({ repository: new JsonWorkWaitRepository(env.dir) });
      const first = await service.create({
        agentId: 'a1',
        workId: 'work-1',
        kind: 'agent',
        correlationId: agentWaitKey('peer-1'),
        condition: '等乙回信',
        now: 1000,
      });
      await service.create({
        agentId: 'a1',
        workId: 'work-1',
        kind: 'time',
        correlationId: timeWaitKey('复核'),
        dueAt: 5000,
        now: 1001,
      });

      const reopened = new WaitService({ repository: new JsonWorkWaitRepository(env.dir) });
      const pending = await reopened.listPending({ workId: 'work-1' });
      assert.equal(pending.length, 2, '同一件工作的两个等待都要读回来');
      assert.equal((await reopened.get(first.id))?.status, 'pending');
      assert.equal(await reopened.pendingCountForWork('work-1'), 2);
    } finally {
      await env.cleanup();
    }
  });

  it('resolve 记下结果引用；终态不可回退，迟到回答返回明确状态', async () => {
    const env = await tempDataDir('wait-terminal');
    try {
      const service = new WaitService({ repository: new JsonWorkWaitRepository(env.dir) });
      const wait = await service.create({
        agentId: 'a1',
        kind: 'user',
        correlationId: 'card-1',
        card: { question: '继续吗？', options: [{ id: 'y', label: '继续' }] },
      });

      const answered = await service.resolve(wait.id, 'choice:y');
      assert.equal(answered.ok, true);
      assert.equal(answered.ok ? answered.wait.resultRef : undefined, 'choice:y');

      const again = await service.resolve(wait.id, 'choice:n');
      assert.equal(again.ok, false);
      assert.equal(again.ok ? undefined : again.status, 'resolved', '重复回答不覆盖已有结果');

      const late = await service.answerByCorrelation('card-1', 'choice:n');
      assert.equal(late.ok, false);
      assert.equal(late.ok ? undefined : late.status, 'resolved');
      assert.match(late.ok ? '' : late.message, /迟到/);
    } finally {
      await env.cleanup();
    }
  });

  it('作废与过期都是终态；已作废卡的迟到回答不会被当成答案', async () => {
    const env = await tempDataDir('wait-cancel');
    try {
      const service = new WaitService({ repository: new JsonWorkWaitRepository(env.dir) });
      const cancelled = await service.create({ agentId: 'a1', kind: 'user', correlationId: 'card-c' });
      await service.cancel(cancelled.id, '用户发了新消息');
      const late = await service.answerByCorrelation('card-c', 'choice:y');
      assert.equal(late.ok, false);
      assert.equal(late.ok ? undefined : late.status, 'cancelled');
      assert.match(late.ok ? '' : late.message, /作废/);

      const unknown = await service.answerByCorrelation('never-existed', 'choice:y');
      assert.equal(unknown.ok ? undefined : unknown.status, 'unknown');

      // 过期：回答一律当作没答，不复活
      const expiring = await service.create({
        agentId: 'a1',
        kind: 'user',
        correlationId: 'card-e',
        dueAt: 100,
        now: 0,
      });
      const sweep = await service.sweepDue(101);
      assert.deepEqual(
        sweep.expired.map((item) => item.id),
        [expiring.id],
      );
      assert.equal((await service.get(expiring.id))?.status, 'expired');
      assert.equal((await service.get(expiring.id))?.resultRef, undefined, '过期不是回答，没有结果引用');
      assert.equal((await service.answerByCorrelation('card-e', 'choice:y')).ok, false);
    } finally {
      await env.cleanup();
    }
  });

  it('到点扫描补上进程不在时错过的定时等待', async () => {
    const env = await tempDataDir('wait-sweep');
    try {
      const service = new WaitService({ repository: new JsonWorkWaitRepository(env.dir) });
      const missed = await service.create({
        agentId: 'a1',
        workId: 'work-1',
        kind: 'time',
        correlationId: timeWaitKey('错过的那次'),
        dueAt: 1000,
        now: 0,
      });
      const future = await service.create({
        agentId: 'a1',
        kind: 'time',
        correlationId: timeWaitKey('还没到'),
        dueAt: 10_000,
        now: 0,
      });
      const sweep = await service.sweepDue(2000);
      assert.deepEqual(
        sweep.satisfied.map((item) => item.id),
        [missed.id],
        '错过的到点要补上',
      );
      assert.equal((await service.get(missed.id))?.status, 'resolved');
      assert.equal((await service.get(future.id))?.status, 'pending');
      assert.match((await service.get(missed.id))?.resultRef ?? '', /^time:/);
    } finally {
      await env.cleanup();
    }
  });

  it('密钥卡只在等待里留引用，明文不进 waits.json', async () => {
    const env = await tempDataDir('wait-secret');
    try {
      const { runtime } = makeRuntime(env.dir, secretProvider());
      const agent = await runtime.registry.create({ name: '甲' });
      const result = await runtime.send(agent.id, '帮我把部署这件事做完，先用密钥框问我要令牌');
      assert.equal(result.stopReason, 'waiting');
      const wait = await waitForPending(runtime.waits, '密钥等待落盘', { kind: 'user' });
      assert.equal(wait.card?.name, 'deploy_token');

      const answered = await runtime.answerInteraction(wait.correlationId, { secret: 'sk-绝密-不该落盘' });
      assert.equal(answered.ok, true);
      assert.equal((await runtime.waits.get(wait.id))?.resultRef, 'secret:deploy_token');
      assert.equal(await runtime.secrets.read('deploy_token'), 'sk-绝密-不该落盘');

      const raw = await readFile(join(env.dir, 'work', 'waits.json'), 'utf8');
      assert.doesNotMatch(raw, /sk-绝密-不该落盘/, '密钥明文绝不能进等待账本');
      assert.match(raw, /deploy_token/, '只保存变量名');
      await settleRuntime(runtime);
      await runtime.close();
    } finally {
      await env.cleanup();
    }
  });
});

// ── 用户问题卡：让位、刷新不作废、新句作废 ────────────────────────

describe('用户问题卡与执行位（E4.3 §7.2）', () => {
  it('提问即刻让位：本回合以 waiting 收尾，不再同步 await 用户回答', async () => {
    const env = await tempDataDir('wait-park');
    try {
      const provider = widgetProvider();
      const { runtime, broker } = makeRuntime(env.dir, provider);
      const agent = await runtime.registry.create({ name: '甲' });
      const work = await runtime.send(agent.id, '帮我把部署这件事做完，先问我一句');
      assert.equal(work.stopReason, 'waiting', '不是 final_answer：本回合主动让位');

      const cards = runtime.listInteractions(agent.id);
      assert.equal(cards.length, 1);
      assert.equal(cards[0]?.question, '要不要继续部署？');
      assert.equal(broker.cardCount, 1, '卡片是持久等待的展示副本');
      const wait = await waitForPending(runtime.waits, '问题卡等待落盘', { kind: 'user' });
      assert.ok(wait.workId, '问题卡关联到工作');
      assert.equal((await runtime.works.get(wait.workId!))?.status, 'waiting');
      assert.ok(wait.dueAt && wait.dueAt > Date.now(), '业务期限明确写在等待上');

      // 执行位已释放：等待期间还能处理一封来信（同一个同事不占着执行位）
      await runtime.inbox.enqueue({
        toAgentId: agent.id,
        fromAgentId: 'peer-x',
        fromName: '丙',
        text: '顺手把日志也看一眼',
        priority: false,
        depth: 0,
        kind: 'message',
      });
      await runtime.drainInbox(agent.id);
      assert.equal(
        (await runtime.waits.listPending({ agentId: agent.id, kind: 'user' })).length,
        1,
        '来信不该作废用户的卡',
      );
      await settleRuntime(runtime);
      await runtime.close();
    } finally {
      await env.cleanup();
    }
  });

  it('刷新（再读一次交互列表）不撤销卡片，等待仍是 pending', async () => {
    const env = await tempDataDir('wait-refresh');
    try {
      const { runtime } = makeRuntime(env.dir, widgetProvider());
      const agent = await runtime.registry.create({ name: '甲' });
      await runtime.send(agent.id, '帮我把部署这件事做完，先问我一句');
      const wait = await waitForPending(runtime.waits, '问题卡等待落盘', { kind: 'user' });

      for (let round = 0; round < 3; round += 1) {
        const cards = runtime.listInteractions(agent.id);
        assert.equal(cards.length, 1, `第 ${round + 1} 次刷新都还能看到卡片`);
        assert.equal(cards[0]?.id, wait.correlationId);
      }
      assert.equal((await runtime.waits.get(wait.id))?.status, 'pending', '刷新不作废等待');
      await settleRuntime(runtime);
      await runtime.close();
    } finally {
      await env.cleanup();
    }
  });

  it('用户新句作废旧卡但不当答案；工作本身继续存在', async () => {
    const env = await tempDataDir('wait-supersede');
    try {
      const { runtime } = makeRuntime(env.dir, widgetProvider());
      const agent = await runtime.registry.create({ name: '甲' });
      await runtime.send(agent.id, '帮我把部署这件事做完，先问我一句');
      const wait = await waitForPending(runtime.waits, '问题卡等待落盘', { kind: 'user' });
      const workId = wait.workId!;

      await runtime.send(agent.id, '换个事：帮我把日志翻一遍');
      assert.equal((await runtime.waits.get(wait.id))?.status, 'cancelled', '新句作废未回答的卡');
      assert.equal((await runtime.waits.get(wait.id))?.resultRef, undefined, '新句不是这张卡的答案');
      assert.equal(runtime.listInteractions(agent.id).length, 0, '卡片从界面撤下');
      assert.ok(await runtime.works.get(workId), '工作本身继续存在，不因作废卡而消失');

      const late = await runtime.answerInteraction(wait.correlationId, { value: '要' });
      assert.equal(late.ok, false);
      assert.equal(late.status, 'cancelled', '迟到回答拿到明确状态');
      await settleRuntime(runtime);
      await runtime.close();
    } finally {
      await env.cleanup();
    }
  });

  it('带交互 id 的明确答案才完成对应等待，并开新回合接着做', async () => {
    const env = await tempDataDir('wait-answer');
    try {
      const { runtime } = makeRuntime(env.dir, widgetProvider());
      const agent = await runtime.registry.create({ name: '甲' });
      await runtime.send(agent.id, '帮我把部署这件事做完，先问我一句');
      const wait = await waitForPending(runtime.waits, '问题卡等待落盘', { kind: 'user' });

      const answered = await runtime.answerInteraction(wait.correlationId, { value: '要' });
      assert.equal(answered.ok, true);
      assert.ok(answered.runId, '唤醒会新开一个 Run');
      assert.equal((await runtime.waits.get(wait.id))?.resultRef, 'choice:要');
      assert.equal(runtime.listInteractions(agent.id).length, 0, '回答后卡片撤下');
      await until(
        async () => (await runtime.works.get(wait.workId!))?.status === 'active',
        '等待都结束后工作回到 active',
      );
      const messages = await runtime.messages.list(agent.id);
      assert.ok(
        messages.some((m) => m.content.type === 'text' && m.content.text.includes('用户回答了问题卡')),
        '唤醒回合把答案带回对话',
      );

      // 再答一次：迟到回答给明确状态，不重复唤醒
      const again = await runtime.answerInteraction(wait.correlationId, { value: '不要' });
      assert.equal(again.ok, false);
      assert.equal(again.status, 'resolved');
      await settleRuntime(runtime);
      await runtime.close();
    } finally {
      await env.cleanup();
    }
  });

  it('HTTP：GET 刷新不作废、POST 作答、迟到回答 409', async () => {
    const env = await tempDataDir('wait-http');
    const server = await createAgentServer({
      port: 0,
      dataDir: env.dir,
      rootDir: process.cwd(),
      allowMissingKey: true,
      createProvider: () => widgetProvider(),
    });
    try {
      const agent = await server.runtime.registry.create({ name: '甲' });
      await server.runtime.send(agent.id, '帮我把部署这件事做完，先问我一句');
      const wait = await waitForPending(server.runtime.waits, '问题卡等待落盘', { kind: 'user' });

      const base = server.url.replace(/\/$/, '');
      const list = () =>
        fetch(`${base}/api/interactions?agentId=${agent.id}`).then(
          (res) => res.json() as Promise<{ interactions: Array<{ id: string; question: string }> }>,
        );
      const refreshed = await list();
      assert.equal(refreshed.interactions.length, 1);
      assert.equal(refreshed.interactions[0]?.question, '要不要继续部署？');
      assert.equal((await list()).interactions.length, 1, '再刷一次还在');
      assert.equal((await server.runtime.waits.get(wait.id))?.status, 'pending');

      const answered = await fetch(`${base}/api/interactions/${wait.correlationId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: '要' }),
      });
      assert.equal(answered.status, 200);
      assert.equal(((await answered.json()) as { ok?: boolean }).ok, true);

      const late = await fetch(`${base}/api/interactions/${wait.correlationId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: '不要' }),
      });
      assert.equal(late.status, 409, '迟到回答给明确状态，不当新答案');
      assert.equal(((await late.json()) as { status?: string }).status, 'resolved');

      const missing = await fetch(`${base}/api/interactions/never-existed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: '要' }),
      });
      assert.equal(missing.status, 404);
    } finally {
      await settleRuntime(server.runtime);
      await server.close();
      await env.cleanup();
    }
  });
});

// ── 验收 1：真 SIGKILL 重启后仍能接上 ───────────────────────────

/** 起一个真子进程跑 phase，等到它打印 marker 行后 SIGKILL —— 真强退，不是优雅退出 */
async function parkAndKill(
  dir: string,
  phase: string,
  marker: string,
): Promise<{ line: string; signal: NodeJS.Signals | null }> {
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, dir, phase], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await until(
    () => Promise.resolve(stdout.includes(`${marker} `) || child.exitCode !== null),
    `${phase} 打印 ${marker}`,
    15_000,
  );
  const line = stdout.split('\n').find((item) => item.startsWith(`${marker} `));
  if (!line) throw new Error(`${phase} 没有打印 ${marker}：${stdout}${stderr}`);

  const exited = new Promise<{ signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (_code, signal) => resolve({ signal }));
  });
  child.kill('SIGKILL');
  const { signal } = await exited;
  return { line, signal };
}

function runPhase(dir: string, phase: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, ['--import', 'tsx', FIXTURE, dir, phase], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  assert.equal(result.status, 0, `${phase} 应当正常退出：${result.stderr}`);
  const line = (result.stdout ?? '').split('\n').find((item) => /^[A-Z]+ /.test(item));
  assert.ok(line, `${phase} 应当打印一行结果：${result.stdout}`);
  return JSON.parse(line.slice(line.indexOf(' ') + 1)) as Record<string, unknown>;
}

describe('验收 1：真重启后等待仍在、回信能接上（E4.3）', () => {
  it('等同事回信：SIGKILL 后新进程读回 pending，收到回信后继续', async () => {
    const env = await tempDataDir('wait-restart-agent');
    try {
      const parked = await parkAndKill(env.dir, 'park-agent', 'PARKED');
      assert.equal(parked.signal, 'SIGKILL', '夹具必须是被强杀的，不是优雅退出');
      const info = JSON.parse(parked.line.slice('PARKED '.length)) as {
        a: string;
        b: string;
        waitId: string;
        workId: string;
      };

      // 进程内没有任何活着的 Promise：唯一的交接物是盘上的等待记录
      const doc = JSON.parse(await readFile(join(env.dir, 'work', 'waits.json'), 'utf8')) as {
        waits: Array<{ id: string; status: string; kind: string }>;
      };
      assert.equal(doc.waits.length, 1);
      assert.equal(doc.waits[0]?.id, info.waitId);
      assert.equal(doc.waits[0]?.status, 'pending');
      assert.equal(doc.waits[0]?.kind, 'agent');

      const replied = runPhase(env.dir, 'reply');
      assert.equal(replied.pendingBefore, 1, '重启后等待还在');
      assert.equal(replied.waitId, info.waitId, '接上的是同一条等待，不是新建的');
      assert.equal(replied.waitStatus, 'resolved');
      assert.match(String(replied.resultRef), /^letter:/, '结果引用指向那封回信');
      assert.equal(replied.workStatus, 'active', '等待结束，工作回到 active');
      assert.equal(replied.replied, true, '甲真的处理了乙的回信');
      assert.equal(replied.workBriefSeen, true, '唤醒那一轮带着工作身份，不是一封陌生的信');
    } finally {
      await env.cleanup();
    }
  });

  it('待答卡：SIGKILL 后新进程重建卡片，用交互 id 作答后工作继续', async () => {
    const env = await tempDataDir('wait-restart-card');
    try {
      const parked = await parkAndKill(env.dir, 'park-card', 'CARD');
      assert.equal(parked.signal, 'SIGKILL');
      const info = JSON.parse(parked.line.slice('CARD '.length)) as { cardId: string; waitId: string };
      assert.ok(info.cardId, '夹具给出了交互 id');
      assert.ok(info.waitId, '夹具给出了等待 id');

      const answered = runPhase(env.dir, 'answer');
      assert.equal(answered.cardsAfterRestart, 1, '重启后待答卡从持久等待重建（不是序列化 Promise）');
      assert.equal(answered.cardQuestion, '要不要继续部署？');
      assert.equal(answered.waitStatusAfter, 'resolved');
      assert.equal(answered.answerOk, true);
      assert.ok(answered.runId, '作答后开了新回合');
      assert.equal(answered.workStatus, 'active');
      assert.equal(answered.continued, true, '答案被带回对话，工作接着做');
    } finally {
      await env.cleanup();
    }
  });
});

// ── 验收 2：等待期间同事（与本人）都能处理别的消息 ────────────────

describe('验收 2：等待期间不占执行位（E4.3）', () => {
  it('甲等乙回信时，乙照常处理另一条消息，甲的等待不受影响', async () => {
    const env = await tempDataDir('wait-peer-free');
    try {
      let peerId = '';
      const provider = dispatchProvider(() => peerId);
      const { runtime } = makeRuntime(env.dir, provider);
      const a = await runtime.registry.create({ name: '甲' });
      const b = await runtime.registry.create({ name: '乙' });
      peerId = b.id;

      // 甲把活派给乙 → 甲落一条「等乙回信」的持久等待
      await runtime.send(a.id, SEND_MARKER);
      await runtime.inbox.enqueue({
        toAgentId: b.id,
        fromAgentId: a.id,
        fromName: '甲',
        text: '请把接口实现核对一遍',
        priority: false,
        depth: 1,
        kind: 'message',
      });
      const waiting = await waitForPending(runtime.waits, '甲的同事等待落盘', { kind: 'agent' });
      assert.equal(waiting.correlationId, agentWaitKey(b.id));
      assert.equal((await runtime.works.get(waiting.workId!))?.status, 'waiting');

      // 等待期间乙还能处理别的消息：乙的开回合、出结果，甲的等待不动
      const callsBefore = provider.calls.length;
      const bTurn = await runtime.send(b.id, '另外帮我把日志也翻一遍');
      assert.equal(bTurn.stopReason, 'final_answer');
      assert.ok(provider.calls.length > callsBefore, '乙真的进了模型并做完了一轮');
      const bWork = await runtime.works.openWorkOf(b.id);
      assert.ok(bWork, '乙自己的消息照常建工作');
      assert.equal((await runtime.waits.get(waiting.id))?.status, 'pending', '别人干活不会把甲的等待当答案');

      // 甲本人也不被等待卡住：还能处理一条消息
      await runtime.send(a.id, '顺便把 README 也看一眼');
      assert.equal((await runtime.waits.get(waiting.id))?.status, 'pending');

      // 乙真的回信：等待被满足，工作回到 active，甲接着做
      await runtime.inbox.enqueue({
        toAgentId: a.id,
        fromAgentId: b.id,
        fromName: '乙',
        text: REPLY_MARKER,
        priority: false,
        depth: 1,
        kind: 'message',
      });
      await runtime.drainInbox(a.id);
      await until(async () => (await runtime.waits.get(waiting.id))?.status === 'resolved', '回信解决等待');
      assert.match((await runtime.waits.get(waiting.id))?.resultRef ?? '', /^letter:/);
      await until(
        async () => (await runtime.works.get(waiting.workId!))?.status === 'active',
        '工作回到 active',
      );
      const letters = await runtime.messages.list(a.id);
      assert.ok(
        letters.some((m) => m.content.type === 'text' && m.content.text.includes(REPLY_MARKER)),
        '甲收到了这封回信',
      );
      assert.ok(
        provider.calls.some((call) => JSON.stringify(call).includes('【当前工作】')),
        '唤醒这一轮带着工作身份，明确是接着那件工作继续',
      );
      await settleRuntime(runtime);
      await runtime.close();
    } finally {
      await env.cleanup();
    }
  });

  it('定时等待到点唤醒工作；用户卡超时只判过期，绝不当作已回答', async () => {
    const env = await tempDataDir('wait-due');
    try {
      const { runtime } = makeRuntime(env.dir, widgetProvider());
      const agent = await runtime.registry.create({ name: '甲' });
      await runtime.send(agent.id, '帮我把部署这件事做完，先问我一句');
      const cardWait = await waitForPending(runtime.waits, '问题卡等待落盘', { kind: 'user' });

      // 定时等待：进程不在时错过，启动扫描补上并唤醒
      await runtime.waits.create({
        agentId: agent.id,
        workId: cardWait.workId,
        kind: 'time',
        correlationId: timeWaitKey('错过的到点'),
        dueAt: Date.now() - 1000,
      });
      const sweep = await runtime.sweepDueWaits();
      assert.equal(sweep.satisfied, 1, '到点的定时等待被补上');
      assert.equal((await runtime.waits.findByCorrelation(timeWaitKey('错过的到点')))[0]?.status, 'resolved');

      // 用户卡到点：只判过期；超时之后它仍然不是回答，迟到回答照样拿明确状态
      await runtime.waits.expire(cardWait.id, '到点，用户没回答');
      const late = await runtime.answerInteraction(cardWait.correlationId, { value: '要' });
      assert.equal(late.ok, false);
      assert.equal(late.status, 'expired', '超时 ≠ 已回答');
      await settleRuntime(runtime);
      await runtime.close();
    } finally {
      await env.cleanup();
    }
  });
});
