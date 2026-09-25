import { randomUUID } from 'node:crypto';
import { WAIT_TERMINAL_MESSAGES, type WaitService } from '../../work/wait-service.js';
import { answerSummary, type WorkWait } from '../../work/wait.js';
import { isTerminalWork } from '../../work/item.js';
import type { InteractionRequest } from '../../shared/contracts/sse.js';
import type { AgentEventHandler } from '../../agent/types.js';
import type { InteractionBroker } from '../../interaction/broker.js';
import type { SecretStore } from '../../secret/store.js';
import type { AgentRegistry } from '../../agent/registry.js';
import type { WorkService } from '../../work/service.js';
import type { EventJournal } from '../events/journal.js';
import type { AgentRuntimeOptions } from './types.js';
import type { RuntimeHost } from './host.js';
import type { WaitRequest } from './send-to-agent-service.js';

/** 用户问题卡的默认答复期限：持久等待不该被 5 分钟掐掉；到点只判过期，不当已回答 */
const DEFAULT_USER_WAIT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 持久等待（WorkWait）生命周期（OPT-03 从 runtime.ts 搬出，E4.3）。
 *
 * 等待是一条记录，不是一段悬挂的 Promise：建 → 让位 → 唤醒（用户答题 / 到点）→
 * 重启读回。这里负责落盘、卡片映射、答题与到点扫描，并联动工作状态；唤醒新回合
 * 走 host.acceptMessage（等待不占执行位）。同事回信/委派那一支见 delegation-wait-bridge。
 */
export function createWaitCoordinator(
  options: AgentRuntimeOptions,
  host: RuntimeHost,
  deps: {
    waits: WaitService;
    works: WorkService;
    broker: InteractionBroker;
    secrets: SecretStore;
    registry: AgentRegistry;
    events: EventJournal;
  },
) {
  const { waits, works, broker, secrets, registry, events } = deps;

  // ── 持久等待：WorkWait（E4.3，设计 §4.3 / §7.2）────────────
  //
  // 等待是一条记录，不是一段悬挂的 Promise：
  //   建        —— 落盘 WorkWait + 工作置 waiting + 用户卡登记到界面；
  //   结束当前执行 —— 提问类工具让位（stopReason=waiting），执行位立刻释放；
  //   唤醒      —— 用户答题 / 同事回信 / 到点，各开一次新的 Run 接着做；
  //   重启      —— 读回 pending、重建待答卡、补上错过的到点，绝不序列化 Promise。

  /** 界面/快照用的卡片列表（含重启后重建的持久卡） */
  function listInteractions(agentId?: string): InteractionRequest[] {
    return broker.list(agentId ? { agentId } : undefined);
  }

  /**
   * 落一条等待并把工作置为 waiting。
   * dueAt 缺省时：用户卡给一个明确的答复期限（到点只判过期）；其余等待不设期限。
   */
  async function beginWait(input: WaitRequest): Promise<WorkWait> {
    if (input.kind === 'user') {
      const existing = await waits.listPending({ agentId: input.agentId, kind: 'user' });
      if (existing.length > 0) throw new Error('这个同事已经有一张等回答的卡了，先回答或作废它再问');
    }
    const ttl = options.waitUserTimeoutMs ?? DEFAULT_USER_WAIT_TTL_MS;
    const wait = await waits.create({
      ...input,
      ...(input.kind === 'user' && input.dueAt === undefined ? { dueAt: Date.now() + ttl } : {}),
    });
    await markWorkWaiting(wait.workId, wait.condition);
    if (wait.kind === 'user' && wait.card) {
      const agent = await registry.get(wait.agentId);
      const card = toInteractionCard(wait, agent?.name ?? wait.agentId);
      if (card) {
        broker.expose(card);
        events.publish({
          kind: 'agent',
          agentId: wait.agentId,
          payload: { type: 'interaction', request: card },
        });
      }
    }
    return wait;
  }

  /** 提问类工具（widget / secret-request）的持久等待通道：进 ToolContext，工具不认识存储 */
  async function requestUserWaitCard(
    agentId: string,
    input: {
      kind: 'choice' | 'secret';
      question: string;
      detail?: string;
      options?: Array<{ id: string; label: string }>;
      name?: string;
    },
  ): Promise<{ id: string }> {
    const work = await works.openWorkOf(agentId);
    // 交互 id 与存储 id 分开：答案必须带这个 id 才能完成对应等待
    const correlationId = randomUUID();
    await beginWait({
      agentId,
      ...(work ? { workId: work.id } : {}),
      kind: 'user',
      correlationId,
      card: {
        question: input.question,
        ...(input.detail ? { detail: input.detail } : {}),
        ...(input.options ? { options: input.options } : {}),
        ...(input.name ? { name: input.name } : {}),
      },
      condition: `等用户回答「${input.question}」`,
    });
    return { id: correlationId };
  }

  /** 持久等待 → 线上卡片形状（重启恢复与实时推送共用同一份映射） */
  function toInteractionCard(wait: WorkWait, agentName: string): InteractionRequest | undefined {
    if (!wait.card) return undefined;
    const card = wait.card;
    return {
      id: wait.correlationId,
      kind: card.name ? 'secret' : 'choice',
      question: card.question,
      ...(card.detail ? { detail: card.detail } : {}),
      ...(card.options ? { options: card.options.map((option) => ({ ...option })) } : {}),
      ...(card.name ? { name: card.name } : {}),
      agentId: wait.agentId,
      agentName,
      createdAt: wait.createdAt,
      // 卡片不设隐性 5 分钟超时：有业务期限就用 dueAt，否则给一个明确的远界
      expiresAt: wait.dueAt ?? wait.createdAt + (options.waitUserTimeoutMs ?? DEFAULT_USER_WAIT_TTL_MS),
    };
  }

  /** 重启恢复：从持久等待重建待答卡（不序列化 Promise），返回重建张数 */
  async function refreshWaitCards(): Promise<number> {
    const pending = await waits.listPending({ kind: 'user' });
    const cards: InteractionRequest[] = [];
    for (const wait of pending) {
      const agent = await registry.get(wait.agentId);
      const card = toInteractionCard(wait, agent?.name ?? wait.agentId);
      if (card) cards.push(card);
    }
    broker.hydrate(cards);
    return cards.length;
  }

  /**
   * 到点扫描（启动扫描 + 兜底定时器共用，不引入调度框架）：
   *   time 到点 → 满足条件并唤醒（进程不在时错过，重启补上）；
   *   user 到点 → 明确过期（超时被当作没答，不是回答）。
   */
  async function sweepDueWaits(now?: number): Promise<{ satisfied: number; expired: number }> {
    const { satisfied, expired } = await waits.sweepDue(now);
    for (const wait of expired) {
      broker.retire(wait.correlationId);
      events.publish({
        kind: 'agent',
        agentId: wait.agentId,
        payload: { type: 'interaction_closed', id: wait.correlationId, answered: false },
      });
      await releaseWorkIfSettled(wait.workId);
    }
    for (const wait of satisfied) {
      await releaseWorkIfSettled(wait.workId);
      await wakeWait(wait, `定时等待到点：${wait.condition ?? wait.correlationId}。接着做。`).catch(
        (error) => console.warn(`定时等待唤醒失败：${messageOf(error)}`),
      );
    }
    return { satisfied: satisfied.length, expired: expired.length };
  }

  /** 用户答题：带交互 id 的明确答案才能完成对应等待；迟到回答返回明确状态 */
  async function answerInteraction(
    id: string,
    answer: { value?: string; secret?: string },
  ): Promise<{ ok: boolean; status: string; message?: string; runId?: string }> {
    const found = await waits.findByCorrelation(id);
    const wait = found.find((item) => item.status === 'pending' && item.kind === 'user');
    if (!wait) {
      // 同回合内的同步等待（工具未接持久通道时的兼容路径）
      if (id && broker.resolve(id, answer)) return { ok: true, status: 'resolved' };
      const last = found[0];
      if (!last || last.status === 'pending') return { ok: false, status: 'unknown', message: '这个交互已经结束或不存在' };
      return { ok: false, status: last.status, message: WAIT_TERMINAL_MESSAGES[last.status] };
    }
    let resultRef: string;
    if (wait.card?.name) {
      const secret = answer.secret?.trim();
      if (!secret) return { ok: false, status: 'pending', message: `需要 secret（${wait.card.name}）` };
      // 明文只进 SecretStore；等待里只留引用
      await secrets.put(wait.card.name, secret);
      resultRef = `secret:${wait.card.name}`;
    } else {
      if (answer.value === undefined) return { ok: false, status: 'pending', message: '需要 value（选项）或 secret（密钥）' };
      resultRef = `choice:${answer.value}`;
    }
    const outcome = await waits.resolve(wait.id, resultRef);
    if (!outcome.ok) return { ok: false, status: outcome.status, message: outcome.message };
    broker.retire(id);
    events.publish({
      kind: 'agent',
      agentId: wait.agentId,
      payload: { type: 'interaction_closed', id, answered: true },
    });
    await releaseWorkIfSettled(wait.workId);
    const runId = await wakeWait(wait, answerSummary(wait, answer));
    return { ok: true, status: 'resolved', ...(runId ? { runId } : {}) };
  }

  /** 用户明确「跳过/放弃」这张卡：等待作废，不当作答案 */
  async function cancelInteraction(id: string): Promise<{ ok: boolean; status: string }> {
    const found = await waits.findByCorrelation(id);
    const wait = found.find((item) => item.status === 'pending' && item.kind === 'user');
    if (!wait) {
      const ok = broker.cancel(id);
      return { ok, status: ok ? 'cancelled' : 'unknown' };
    }
    const outcome = await waits.cancel(wait.id, '用户放弃了这张卡');
    broker.retire(id);
    events.publish({
      kind: 'agent',
      agentId: wait.agentId,
      payload: { type: 'interaction_closed', id, answered: false },
    });
    await releaseWorkIfSettled(wait.workId);
    return { ok: outcome.ok, status: 'cancelled' };
  }

  /**
   * 「用户新句作废未回答选项卡」（§7.2）：作废该卡并写入状态，再分析新句；
   * 工作本身继续存在，是否还需要等待由新一轮判断。刷新/断线不走这里，所以不作废。
   */
  async function voidPendingUserWaits(agentId: string, emit?: AgentEventHandler): Promise<void> {
    const pending = await waits.listPending({ agentId, kind: 'user' });
    for (const wait of pending) {
      await waits.cancel(wait.id, '用户发了新消息，这张卡作废');
      broker.retire(wait.correlationId);
      emit?.({ type: 'interaction_closed', id: wait.correlationId, answered: false });
      await releaseWorkIfSettled(wait.workId);
    }
  }

  /** 事件到达后新开一次执行（不占着旧执行位；执行在后台跑） */
  async function wakeWait(wait: WorkWait, text: string): Promise<string | undefined> {
    if (!(await registry.get(wait.agentId))) return undefined;
    const work = wait.workId ? await works.get(wait.workId) : undefined;
    if (work && isTerminalWork(work.status)) return undefined;
    const accepted = await host.acceptMessage(wait.agentId, text, {
      ...(wait.workId ? { workId: wait.workId } : {}),
      waitAnswer: true,
    });
    void accepted.execute().catch((error) => {
      console.warn(`等待唤醒的回合失败（${wait.workId ?? wait.agentId}）：${messageOf(error)}`);
    });
    return accepted.receipt.runId;
  }

  /** 进入 waiting：工作状态是事实，不是只写在等待记录里 */
  async function markWorkWaiting(workId: string | undefined, condition?: string): Promise<void> {
    if (!workId) return;
    try {
      const work = await works.get(workId);
      if (!work || isTerminalWork(work.status) || work.status === 'waiting') return;
      await works.update(workId, {
        status: 'waiting',
        ...(condition ? { nextAction: condition } : {}),
      });
    } catch (error) {
      console.warn(`工作等待状态未写回（${workId}）：${messageOf(error)}`);
    }
  }

  /** 等待都结束了就把工作放回 active——否则工作会永远卡在 waiting，无法收尾 */
  async function releaseWorkIfSettled(workId: string | undefined): Promise<void> {
    if (!workId) return;
    try {
      if ((await waits.pendingCountForWork(workId)) > 0) return;
      const work = await works.get(workId);
      if (!work || work.status !== 'waiting') return;
      // nextAction 已被 markWorkWaiting 改写成「等谁/等什么」；条件满足了它就过期了，
      // 留着会让模型以为还要继续等。清空后由接下来那一轮重新写下一步。
      await works.update(workId, { status: 'active', nextAction: undefined });
    } catch (error) {
      console.warn(`工作等待结束状态未写回（${workId}）：${messageOf(error)}`);
    }
  }

  return {
    listInteractions,
    beginWait,
    requestUserWaitCard,
    refreshWaitCards,
    sweepDueWaits,
    answerInteraction,
    cancelInteraction,
    voidPendingUserWaits,
    wakeWait,
    markWorkWaiting,
    releaseWorkIfSettled,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
