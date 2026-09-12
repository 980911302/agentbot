import { randomUUID } from 'node:crypto';
import type { Message } from '../../shared/contracts/sse.js';
import { buildAgentBrief } from '../../room/turn.js';
import type { AgentInbox, InboxItem } from '../../agent/inbox.js';
import type { AgentRegistry } from '../../agent/registry.js';
import type { StopCoordinator } from './stop-coordinator.js';
import { AgentBusyError } from './types.js';
import type { SendOptions, TurnResult } from './types.js';

/** 领取期限：到期未确认视为处理中断，可回收重做 */
const DEFAULT_LEASE_MS = 300_000;
/** 同一封信最多处理几次；到顶进 failed，等人工重试 */
const DEFAULT_MAX_ATTEMPTS = 3;
/** 失败退避基数：第 n 次失败等 base * 2^(n-1) */
const DEFAULT_BASE_DELAY_MS = 1_000;

/**
 * InboxProcessor（E2.2 拆出，E3.3 改为领取-确认）：
 * 同事来信的消费不再整批清空，而是
 *   领取（带执行权与期限）→ 停止令逐条处理/确认 → 普通信合并为回合 →
 *   写下持久检查点 → 成功后确认，失败有限退避。
 *
 * 深度上限防两个智能体无限互发。回合执行经 runTurn 接缝注入（RunExecutor）。
 */
export class InboxProcessor {
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
      /** 领取期限（毫秒） */
      leaseMs?: number;
      /** 每封信的处理上限 */
      maxAttempts?: number;
      /** 失败退避基数（毫秒） */
      baseDelayMs?: number;
    },
  ) {}

  async process(agentId: string, options: SendOptions = {}): Promise<TurnResult | null> {
    const claimed = await this.deps.inbox.claim(agentId, {
      owner: `inbox:${randomUUID()}`,
      leaseMs: this.deps.leaseMs ?? DEFAULT_LEASE_MS,
      maxAttempts: this.deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    });
    if (claimed.length === 0) return null;

    // 停止令优先：逐条处理、逐条确认——后面普通信失败不牵连已经停完的令
    for (const stop of claimed.filter((item) => item.kind === 'stop')) {
      try {
        await this.deps.stopCoordinator.stopFromParent(
          agentId,
          { text: stop.text, createdAt: stop.createdAt },
          { agentId: stop.fromAgentId, name: stop.fromName },
        );
        await this.deps.inbox.ack(agentId, [stop.id]);
      } catch (error) {
        await this.deps.inbox.nack(agentId, [stop.id], messageOf(error), this.failureInput());
      }
    }

    // 回执件只是计数：领取即确认，不进模型
    const receipts = claimed.filter((item) => item.kind === 'stop-ack');
    if (receipts.length > 0) {
      await this.deps.inbox.ack(
        agentId,
        receipts.map((item) => item.id),
      );
    }

    const letters = claimed.filter((item) => item.kind !== 'stop' && item.kind !== 'stop-ack');
    if (letters.length === 0) return null;

    const record = await this.deps.registry.get(agentId);
    if (!record) {
      // 收件人没了：归还领取，不烧重试预算
      await this.deps.inbox.release(
        agentId,
        letters.map((item) => item.id),
      );
      return null;
    }

    const batch = composeLetters(letters);
    const depth = Math.max(...letters.map((item) => item.depth));
    const ids = letters.map((item) => item.id);
    const task: Message = {
      id: randomUUID(),
      agentId,
      role: 'user',
      content: { type: 'text', text: batch.text },
      createdAt: Date.now(),
      speaker: batch.speaker,
      source: 'agent',
    };

    // 持久检查点：先记下这批信已经变成哪条消息，再进模型。
    // 中途强退时租约过期回收，恢复执行能看出「这批输入已经有过一次处理」。
    await this.deps.inbox.checkpoint(agentId, ids, { messageId: task.id });

    try {
      const result = await this.deps.runTurn(
        agentId,
        task,
        {
          brief: buildAgentBrief({
            fromName: batch.speaker,
            depth,
            maxDepth: this.deps.maxAgentChainDepth,
          }),
          toolContext: { agentChainDepth: depth },
        },
        options,
      );
      await this.deps.inbox.ack(agentId, ids);
      // 处理完这批，继续往下走（受深度上限约束）
      const deeper = await this.process(agentId, options);
      void deeper;
      return result;
    } catch (error) {
      if (error instanceof AgentBusyError) {
        // 忙不是失败：归还领取，等它空下来再处理
        await this.deps.inbox.release(agentId, ids);
      } else {
        await this.deps.inbox.nack(agentId, ids, messageOf(error), this.failureInput());
      }
      throw error;
    }
  }

  private failureInput() {
    return {
      maxAttempts: this.deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      baseDelayMs: this.deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    };
  }
}

/**
 * 一批来信折成一条消息，但保留每封信的作者：
 * 单封保持原文；多封逐封署名，不再压成一个无来源段落。
 */
function composeLetters(letters: InboxItem[]): { text: string; speaker: string } {
  if (letters.length === 1) {
    const only = letters[0]!;
    return { text: only.text, speaker: only.fromName };
  }
  const authors = [...new Set(letters.map((item) => item.fromName))];
  return {
    text: letters.map((item) => `「${item.fromName}」说：${item.text}`).join('\n\n'),
    speaker: authors.join('、'),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
