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
        turn: { brief?: string; toolContext?: { agentChainDepth: number } },
        options: SendOptions,
      ) => Promise<TurnResult>;
      /** 处理一条排队的群回合（E3.7）：忙碌成员空下来后把群消息补上 */
      deliverRoom: (item: InboxItem, options: SendOptions) => Promise<unknown>;
      canRetry?: (agentId: string, messageId: string) => Promise<boolean>;
      archiveLetter?: (item: InboxItem) => Promise<void>;
      admit?: (item: InboxItem) => Promise<'run' | 'hold' | 'busy'>;
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
            { text: stop.text, createdAt: stop.createdAt, treeId: stop.treeId },
            { agentId: stop.fromAgentId, name: stop.fromName, treeId: stop.treeId },
          );
          await session.ack([stop.id]);
        } catch (error) {
          await session.nack([stop.id], messageOf(error), this.failureInput());
        }
      }

      // 回执件只是计数：领取即确认，不进模型
      const receipts = claimed.filter((item) => item.kind === 'stop-ack');
      if (receipts.length > 0) {
        await session.ack(
          receipts.map((item) => item.id),
        );
      }

      // 排队的群回合（E3.7）：逐条处理、各自一个回合（不和普通信合并）
      for (const item of claimed.filter((entry) => entry.kind === 'room')) {
        const messageId = randomUUID();
        try {
          if (item.checkpoint && !(await this.deps.canRetry?.(agentId, item.checkpoint.messageId) ?? true)) {
            await session.nack([item.id], '上次群任务可能已有副作用，请核对后重新派发', { ...this.failureInput(), maxAttempts: 1 });
            continue;
          }
          await session.checkpoint([item.id], { messageId });
          await this.deps.deliverRoom({ ...item, checkpoint: { messageId, at: Date.now() } }, options);
          await session.ack([item.id]);
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
      if (this.deps.admit) {
        const decision = await this.deps.admit(letter);
        if (decision === 'hold') {
          await session.release(ids);
          await this.deps.inbox.holdIds(agentId, ids, 'agent_paused').catch(() => 0);
          return null;
        }
        if (decision === 'busy') {
          await session.release(ids);
          return null;
        }
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
        const result = await this.deps.runTurn(
          agentId,
          task,
          {
            brief: buildAgentBrief({
              fromName: letter.fromName,
              fromId: letter.fromAgentId,
              depth,
              maxDepth: this.deps.maxAgentChainDepth,
            }),
            toolContext: { agentChainDepth: depth },
          },
          options,
        );
        await session.ack(ids);
        // 处理完这批，继续往下走（受深度上限约束）
        // 后续批次由到期调度器唤醒，避免递归领取和同一 agent 并发消费。
        return result;
      } catch (error) {
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
