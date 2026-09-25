import { randomUUID } from 'node:crypto';
import { DeliverySession } from './delivery-session.js';
import type { Message } from '../../shared/contracts/sse.js';
import { buildAgentBrief } from '../../room/turn.js';
import type { AgentInbox, InboxItem } from '../../agent/inbox.js';
import type { AgentRegistry } from '../../agent/registry.js';
import type { StopCoordinator } from './stop-coordinator.js';
import { AgentBusyError } from './types.js';
import type { SendOptions, TurnResult } from './types.js';

/** 投递默认参数：InboxProcessor 与启动恢复（runtime.recover）共用同一份预算 */
export const DELIVERY_DEFAULTS = {
  /** 领取期限：到期未确认视为处理中断，可回收重做 */
  leaseMs: 300_000,
  /** 同一封信最多处理几次；到顶进 failed，等人工重试（重启不重置） */
  maxAttempts: 3,
  /** 失败退避基数：第 n 次失败等 base * 2^(n-1) */
  baseDelayMs: 1_000,
} as const;

/**
 * InboxProcessor（E2.2 拆出，E3.3 改为领取-确认）：
 * 同事来信的消费不再整批清空，而是
 *   领取一封（带执行权与期限）→ 停止令处理/确认或独立回合 →
 *   写下持久检查点 → 成功后确认，失败有限退避。
 *
 * 深度上限防两个智能体无限互发。回合执行经 runTurn 接缝注入（RunExecutor）。
 */
export class InboxProcessor {
  private readonly active = new Map<string, Promise<TurnResult | null>>();
  private readonly shutdown = new AbortController();
  isProcessing(agentId: string): boolean { return this.active.has(agentId); }
  async close(): Promise<void> { this.shutdown.abort(); await Promise.allSettled(this.active.values()); }
  constructor(
    private readonly deps: {
      inbox: AgentInbox;
      registry: AgentRegistry;
      maxAgentChainDepth: number;
      stopCoordinator: StopCoordinator;
      runTurn: (
        agentId: string,
        task: Message,
        turn: {
          brief?: string;
          toolContext?: {
            agentChainDepth: number;
            replyRoute?: import('../../shared/contracts/room-flow.js').RoomReplyRoute;
          };
          /** 这封信的委派线程键（E4.4）：回信要带回「哪一次请求」 */
          replyCorrelationId?: string;
        },
        options: SendOptions,
      ) => Promise<TurnResult>;
      /** 处理一条排队的群回合（E3.7）：忙碌成员空下来后把群消息补上 */
      deliverRoom: (item: InboxItem, options: SendOptions) => Promise<unknown>;
      canRetry?: (agentId: string, messageId: string) => Promise<boolean>;
      archiveLetter?: (item: InboxItem) => Promise<void>;
      admit?: (item: InboxItem) => Promise<import('../../shared/contracts/execution-control.js').ActivationDecision>;
      settleTicket?: (ticketId: string) => Promise<void>;
      /** 确认了一条 stop-ack：通知等待中的停止令（ack 只是计数，不进模型） */
      onStopAck?: (agentId: string, item: InboxItem) => void;
      /**
       * 一批普通信确认处理完（E4.3）：运行时据此解决「等这位同事回信」的持久等待。
       * 只在 ack 成功后调用——信被 nack 时等待不该被算作已满足。
       */
      onLettersHandled?: (agentId: string, letters: InboxItem[]) => Promise<void>;
      /**
       * 这批信里有没有「正在等这位同事」的持久等待（E4.3）：有就把等待归属的工作
       * 写进本轮 brief，让这一轮明确是「接着那件工作继续」，而不是一封陌生的信。
       * correlationId 是这封信的委派线程键（E4.4）：先按它精确命中，再退回旧行为。
       */
      workBriefForLetter?: (
        agentId: string,
        fromAgentId: string,
        correlationId?: string,
      ) => Promise<string | undefined>;
      /**
       * 这封信是一条委派（E4.4）：收件方为此开一件工作并回填 childWorkId，
       * 返回可以进本轮 brief 的工作身份。失败不能让信处理不下去。
       */
      acceptDelegation?: (
        agentId: string,
        letter: InboxItem,
      ) => Promise<string | undefined>;
      /** 领取期限（毫秒） */
      leaseMs?: number;
      /** 每封信的处理上限 */
      maxAttempts?: number;
      /** 失败退避基数（毫秒） */
      baseDelayMs?: number;
    },
  ) {}

  process(agentId: string, options: SendOptions = {}): Promise<TurnResult | null> {
    if (this.shutdown.signal.aborted) return Promise.resolve(null);
    const existing = this.active.get(agentId);
    if (existing) return existing;
    const pending = Promise.resolve().then(() => this.processBatch(agentId, options))
      .finally(() => { if (this.active.get(agentId) === pending) this.active.delete(agentId); });
    this.active.set(agentId, pending); return pending;
  }

  private async processBatch(agentId: string, options: SendOptions): Promise<TurnResult | null> {
    const claimed = await this.deps.inbox.claim(agentId, {
      owner: `inbox:${randomUUID()}`,
      leaseMs: this.deps.leaseMs ?? DELIVERY_DEFAULTS.leaseMs,
      maxAttempts: this.deps.maxAttempts ?? DELIVERY_DEFAULTS.maxAttempts,
      limit: 1,
    });
    if (claimed.length === 0) return null;
    const session = new DeliverySession(this.deps.inbox, agentId, claimed, this.deps.leaseMs ?? DELIVERY_DEFAULTS.leaseMs);
    options = { ...options, signal: AbortSignal.any([this.shutdown.signal, session.controller.signal, ...(options.signal ? [options.signal] : [])]) };
    try {
      // 停止令优先：逐条处理、逐条确认——后面普通信失败不牵连已经停完的令
      for (const stop of claimed.filter((item) => item.kind === 'stop')) {
        try {
          await this.deps.stopCoordinator.stopFromParent(
            agentId,
            {
              text: stop.text,
              createdAt: stop.createdAt,
              treeId: stop.treeId,
              correlationId: stop.correlationId,
              cancelId: stop.cancelId,
              childWorkId: stop.childWorkId,
            },
            {
              agentId: stop.fromAgentId,
              name: stop.fromName,
              treeId: stop.treeId,
              correlationId: stop.correlationId,
              cancelId: stop.cancelId,
              childWorkId: stop.childWorkId,
            },
          );
          await session.ack([stop.id]);
        } catch (error) {
          await session.nack([stop.id], messageOf(error), this.failureInput());
        }
      }

      // 回执件只是计数：领取即确认，不进模型
      const receipts = claimed.filter((item) => item.kind === 'stop-ack');
      if (receipts.length > 0) {
        for (const item of receipts) this.deps.onStopAck?.(agentId, item);
        try {
          await session.ack(
            receipts.map((item) => item.id),
          );
        } catch {
          // 租约丢失或信已被别处消费：ack 只是计数，等 ack 的停止令已经收到通知，
          // 不能让它把整批信炸飞（未释放的租约会卡住整个信箱）
        }
      }

      // 排队的群回合（E3.7）：逐条处理、各自一个回合（不和普通信合并）
      for (const item of claimed.filter((entry) => entry.kind === 'room')) {
        const messageId = randomUUID();
        try {
          if (item.checkpoint && !(await this.deps.canRetry?.(agentId, item.checkpoint.messageId) ?? true)) {
            await session.nack([item.id], '上次群任务可能已有副作用，请核对后重新派发', { ...this.failureInput(), maxAttempts: 1 });
            continue;
          }
          let roomAuth = options;
          if (this.deps.admit) {
            const decision = await this.deps.admit(item);
            if (decision.kind !== 'admitted') {
              if (decision.kind === 'busy') await session.release([item.id]);
              else {
                await session.release([item.id]);
                await this.deps.inbox.holdIds(agentId, [item.id], 'agent_paused').catch(() => 0);
              }
              continue;
            }
            roomAuth = { ...options, authorization: decision.ticket };
          }
          await session.checkpoint([item.id], { messageId });
          await this.deps.deliverRoom({ ...item, checkpoint: { messageId, at: Date.now() } }, roomAuth);
          await session.ack([item.id]);
          if (roomAuth.authorization?.ticketId) await this.deps.settleTicket?.(roomAuth.authorization.ticketId);
        } catch (error) {
          if (error instanceof AgentBusyError) {
            // 忙不是失败：归还领取，等它空下来再处理
            await session.release([item.id]);
          } else {
            const safe = await this.deps.canRetry?.(agentId, messageId) ?? true;
            await session.nack([item.id], messageOf(error) + (safe ? '' : '；可能已有副作用，请核对后重派'), { ...this.failureInput(), ...(!safe ? { maxAttempts: 1 } : {}) });
          }
        }
      }

      const letters = claimed.filter(
        (item) => item.kind !== 'stop' && item.kind !== 'stop-ack' && item.kind !== 'room',
      );
      if (letters.length === 0) return null;

      // 确认出队前归档；崩溃在 enqueue 与归档之间时由此/启动恢复补齐。
      for (const letter of letters) await this.deps.archiveLetter?.(letter);

      const record = await this.deps.registry.get(agentId);
      if (!record) {
        // 收件人没了：归还领取，不烧重试预算
        await session.release(
          letters.map((item) => item.id),
        );
        return null;
      }

      const letter = letters[0]!;
      const ids = letters.map((item) => item.id);
      let ticketId: string | undefined;
      let authorization: import('../../shared/contracts/execution-control.js').ActivationTicket | undefined;
      if (this.deps.admit) {
        const decision = await this.deps.admit(letter);
        if (decision.kind === 'held') {
          await session.release(ids);
          await this.deps.inbox.holdIds(agentId, ids, decision.reason === 'budget_exhausted' ? 'budget_exhausted' : 'agent_paused').catch(() => 0);
          return null;
        }
        if (decision.kind === 'busy' || decision.kind === 'cancelled') {
          await session.release(ids);
          return null;
        }
        ticketId = decision.ticket.ticketId;
        authorization = decision.ticket;
        if (letter.flowId) authorization.flowId = letter.flowId;
        if (letter.grantId) authorization.flowGrantId = letter.grantId;
        if (letter.replyRoute) authorization.replyRoute = letter.replyRoute;
      }
      const depth = letter.depth;
      const task: Message = {
        id: randomUUID(),
        agentId,
        role: 'user',
        content: { type: 'text', text: letter.text },
        ...(letter.images?.length ? { images: letter.images } : {}),
        createdAt: Date.now(),
        speaker: letter.fromName,
        source: 'agent',
        sender: letter.fromActor ?? { kind: 'agent', id: letter.fromAgentId, name: letter.fromName },
        ...(this.deps.archiveLetter ? { correspondenceIds: letters.map(item => item.id) } : {}),
      };

      // 持久检查点：先记下这批信已经变成哪条消息，再进模型。
      // 中途强退时租约过期回收，恢复执行能看出「这批输入已经有过一次处理」。
      // 不盲目重放已经可能产生副作用的旧尝试。
      const unsafe = await Promise.all(letters.filter(item => item.checkpoint).map(item => this.deps.canRetry?.(agentId, item.checkpoint!.messageId) ?? true));
      if (unsafe.includes(false)) {
        await session.nack(ids, '上次执行可能已有副作用，请核对产物后重新派发任务', { ...this.failureInput(), maxAttempts: 1 });
        return null;
      }
      await session.checkpoint(ids, { messageId: task.id });

      try {
        // 这封信是一条委派：收件方为它开一件工作并回填 childWorkId（E4.4）。
        // 失败不能拦住这封信：没有 childWorkId 只是停止时少一个精确靶点。
        const delegationBrief = await this.deps.acceptDelegation?.(agentId, letter).catch((error) => {
          console.warn(`委派未记账（不影响本轮）：${messageOf(error)}`);
          return undefined;
        });
        // 等这位同事回信的等待还在：这封信就是它的唤醒事件，把工作身份带进本轮。
        // 带线程键时按「哪一次请求」精确命中，避免一封回信解决掉等同一同事的别的等待。
        const workBrief = await this.deps.workBriefForLetter?.(
          agentId,
          letter.fromAgentId,
          letter.correlationId,
        );
        const result = await this.deps.runTurn(
          agentId,
          task,
          {
            brief: [
              buildAgentBrief({
                fromName: letter.fromName,
                fromId: letter.fromAgentId,
                depth,
                maxDepth: this.deps.maxAgentChainDepth,
              }),
              delegationBrief,
              workBrief,
            ]
              .filter(Boolean)
              .join('\n\n'),
            toolContext: {
              agentChainDepth: depth,
              replyRoute: letter.replyRoute,
            },
            // E4.4：回信时把这份线程键带回去，发起方才知道是「哪一次请求」的回音
            ...(letter.correlationId ? { replyCorrelationId: letter.correlationId } : {}),
          },
          { ...options, ...(authorization ? { authorization } : {}) },
        );
        if (result.stopReason === 'cancelled' || result.stopReason === 'parked') {
          await session.release(ids);
          await this.deps.inbox.holdIds(agentId, ids, 'cancelled').catch(() => 0);
          if (ticketId) await this.deps.settleTicket?.(ticketId);
          return result;
        }
        if (result.stopReason === 'max_iterations' || result.stopReason === 'tool_limit') {
          await session.release(ids);
          await this.deps.inbox.holdIds(agentId, ids, 'manual_review').catch(() => 0);
          if (ticketId) await this.deps.settleTicket?.(ticketId);
          return result;
        }
        await session.ack(ids);
        if (ticketId) await this.deps.settleTicket?.(ticketId);
        // 信已经处理并确认：现在才算「等这位同事回信」这件事满足了（E4.3）
        await this.deps.onLettersHandled?.(agentId, letters).catch(() => undefined);
        return result;
      } catch (error) {
        if (ticketId) await this.deps.settleTicket?.(ticketId);
        if (error instanceof AgentBusyError) {
          // 忙不是失败：归还领取，等它空下来再处理
          await session.release(ids);
        } else {
          const safe = await this.deps.canRetry?.(agentId, task.id) ?? true;
          await session.nack(ids, messageOf(error) + (safe ? '' : '；可能已有副作用，请核对后重派'), { ...this.failureInput(), ...(!safe ? { maxAttempts: 1 } : {}) });
        }
        throw error;
      }
    } finally { await session.close(); }
  }

  private failureInput() {
    return {
      maxAttempts: this.deps.maxAttempts ?? DELIVERY_DEFAULTS.maxAttempts,
      baseDelayMs: this.deps.baseDelayMs ?? DELIVERY_DEFAULTS.baseDelayMs,
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
