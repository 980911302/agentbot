import { randomUUID } from 'node:crypto';
import type { WorkWaitRepositoryPort } from '../storage/ports.js';
import {
  canTransitionWait,
  dueActionOf,
  isWaitDue,
  type WorkWait,
  type WorkWaitCard,
  type WorkWaitKind,
} from './wait.js';

/**
 * 等待服务（E4.3）：WorkWait 的唯一状态转换入口。
 *
 * 职责边界（与 §4.3 对齐）：
 *   - 建等待时记全「等谁、哪次请求、满足什么条件」；
 *   - 只有 pending 能走到 resolved / cancelled / expired，终态不可回退；
 *   - 迟到的回答拿到的是明确状态（resolved/cancelled/expired/unknown），
 *     绝不误解成别的等待的答案，也绝不复活已作废的卡；
 *   - 到点扫描：time 到点算满足条件（错过要补上），user 到点只判过期（≠ 已回答）。
 * 不碰 HTTP、不认识运行时；存储经 WorkWaitRepositoryPort，唤醒由调用方做。
 */

export class WorkWaitError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'WorkWaitError';
  }
}

/** 回答/作废/过期的结果：要么成功，要么给一个明确的终结状态 */
export type WaitOutcome =
  | { ok: true; wait: WorkWait }
  | { ok: false; status: 'unknown' | 'resolved' | 'cancelled' | 'expired'; message: string; wait?: WorkWait };

export interface CreateWaitInput {
  agentId: string;
  /** 归属工作：WorkWait.workId 必填（唤醒时要有个东西可接着做） */
  workId?: string;
  kind: WorkWaitKind;
  correlationId: string;
  /** 「哪一次请求」的精确线程键（E4.4）：kind=agent 时是委派 id */
  threadId?: string;
  card?: WorkWaitCard;
  condition?: string;
  dueAt?: number;
  /** 注入时钟，便于测试过期/到点 */
  now?: number;
}

export interface WaitServiceDeps {
  repository: WorkWaitRepositoryPort;
}

/** 终态回答的统一说法：迟到回答拿到的是明确状态，不是被误解成别的等待的答案 */
export const WAIT_TERMINAL_MESSAGES: Record<'resolved' | 'cancelled' | 'expired', string> = {
  resolved: '这个等待已经有结果了，本次回答按迟到处理，不会重复唤醒',
  cancelled: '这张卡已被新的用户消息作废，回答不当作它的答案',
  expired: '这个等待已经过期，回答按迟到处理，不会被当成答案',
};

export class WaitService {
  constructor(private readonly deps: WaitServiceDeps) {}

  private now(input?: number): number {
    return input ?? Date.now();
  }

  /** 建一条等待（同一关联键可以有多条：一件工作能等多个结果） */
  async create(input: CreateWaitInput): Promise<WorkWait> {
    const at = this.now(input.now);
    const wait: WorkWait = {
      id: randomUUID(),
      workId: input.workId,
      kind: input.kind,
      correlationId: input.correlationId,
      status: 'pending',
      agentId: input.agentId,
      createdAt: at,
      updatedAt: at,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.card ? { card: input.card } : {}),
      ...(input.condition ? { condition: input.condition } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
    };
    await this.deps.repository.save(wait);
    return wait;
  }

  async get(waitId: string): Promise<WorkWait | undefined> {
    return this.deps.repository.get(waitId);
  }

  /** 所有没结束的等待；按工作 / 同事 / 种类 / 线程过滤（唤醒与界面都用它） */
  async listPending(filter?: {
    workId?: string;
    agentId?: string;
    kind?: WorkWaitKind;
    threadId?: string;
  }): Promise<WorkWait[]> {
    const all = await this.deps.repository.listAll();
    return all.filter(
      (wait) =>
        wait.status === 'pending' &&
        (!filter?.workId || wait.workId === filter.workId) &&
        (!filter?.agentId || wait.agentId === filter.agentId) &&
        (!filter?.kind || wait.kind === filter.kind) &&
        (!filter?.threadId || wait.threadId === filter.threadId),
    );
  }

  async pendingCountForWork(workId: string): Promise<number> {
    return (await this.listPending({ workId })).length;
  }

  /** 按关联键找（含已终结的：迟到回答要能说清「它已经是什么状态」） */
  async findByCorrelation(correlationId: string): Promise<WorkWait[]> {
    return this.deps.repository.findByCorrelation(correlationId);
  }

  /**
   * 按关联键给出答案：只解决 pending 的那条。
   * 已经终结/不存在时返回明确状态，调用方据此回 404/409 而不是再开一个回合。
   */
  async answerByCorrelation(correlationId: string, resultRef: string): Promise<WaitOutcome> {
    const found = await this.deps.repository.findByCorrelation(correlationId);
    const pending = found.find((wait) => wait.status === 'pending');
    if (!pending) {
      const last = found[0];
      if (!last) return { ok: false, status: 'unknown', message: '这个交互已经结束或不存在' };
      return {
        ok: false,
        status: last.status as 'resolved' | 'cancelled' | 'expired',
        message: WAIT_TERMINAL_MESSAGES[last.status as 'resolved' | 'cancelled' | 'expired'],
        wait: last,
      };
    }
    return this.resolve(pending.id, resultRef);
  }

  /** 满足条件：pending → resolved，记下结果引用 */
  async resolve(waitId: string, resultRef?: string): Promise<WaitOutcome> {
    return this.transition(waitId, 'resolved', resultRef);
  }

  /** 作废（用户新句作废旧卡、同事被删、工作被取消）：pending → cancelled */
  async cancel(waitId: string, reason?: string): Promise<WaitOutcome> {
    return this.transition(waitId, 'cancelled', undefined, reason);
  }

  /** 过期：pending → expired；**不当作已回答** */
  async expire(waitId: string, reason?: string): Promise<WaitOutcome> {
    return this.transition(waitId, 'expired', undefined, reason);
  }

  /** 作废某个关联键下所有未结束的等待；返回被作废的那些 */
  async cancelByCorrelation(correlationId: string, reason?: string): Promise<WorkWait[]> {
    const pending = await this.deps.repository.findByCorrelation(correlationId, 'pending');
    const cancelled: WorkWait[] = [];
    for (const wait of pending) {
      const outcome = await this.cancel(wait.id, reason);
      if (outcome.ok) cancelled.push(outcome.wait);
    }
    return cancelled;
  }

  /**
   * 作废某一次请求的等待（E4.4）：停止一条委派时，对应的「等它回信」不再有意义。
   * 只动这一条线程，不动这位同事别的等待。
   */
  async cancelByThread(threadId: string, reason?: string): Promise<WorkWait[]> {
    const pending = await this.listPending({ threadId });
    const cancelled: WorkWait[] = [];
    for (const wait of pending) {
      const outcome = await this.cancel(wait.id, reason);
      if (outcome.ok) cancelled.push(outcome.wait);
    }
    return cancelled;
  }

  /** 作废某同事全部未结束的等待（删同事时用） */
  async cancelAllOf(agentId: string, reason?: string): Promise<WorkWait[]> {
    const pending = await this.listPending({ agentId });
    const cancelled: WorkWait[] = [];
    for (const wait of pending) {
      const outcome = await this.cancel(wait.id, reason);
      if (outcome.ok) cancelled.push(outcome.wait);
    }
    return cancelled;
  }

  /**
   * 到点扫描（启动扫描 + 定时器共用；不引入调度框架）。
   * time 到点即满足条件 → resolved（进程不在时错过，重启补上）；
   * user 到点只判过期 → expired（超时不等于用户回答）。
   */
  async sweepDue(now?: number): Promise<{ satisfied: WorkWait[]; expired: WorkWait[] }> {
    const at = this.now(now);
    const satisfied: WorkWait[] = [];
    const expired: WorkWait[] = [];
    for (const wait of await this.listPending()) {
      if (!isWaitDue(wait, at)) continue;
      const action = dueActionOf(wait);
      if (action === 'wake') {
        const outcome = await this.resolve(wait.id, `time:${new Date(wait.dueAt!).toISOString()}`);
        if (outcome.ok) satisfied.push(outcome.wait);
      } else if (action === 'expire') {
        const outcome = await this.expire(wait.id, '到了答复期限，用户没有回答');
        if (outcome.ok) expired.push(outcome.wait);
      }
    }
    return { satisfied, expired };
  }

  /** 删同事时清掉它的等待（与消息/收件箱一起收敛） */
  async clear(agentId: string): Promise<void> {
    await this.deps.repository.clear(agentId);
  }

  private async transition(
    waitId: string,
    to: 'resolved' | 'cancelled' | 'expired',
    resultRef?: string,
    reason?: string,
  ): Promise<WaitOutcome> {
    const current = await this.deps.repository.get(waitId);
    if (!current) return { ok: false, status: 'unknown', message: '这个等待不存在' };
    if (!canTransitionWait(current.status, to)) {
      return {
        ok: false,
        status: current.status as 'resolved' | 'cancelled' | 'expired',
        message: WAIT_TERMINAL_MESSAGES[current.status as 'resolved' | 'cancelled' | 'expired'],
        wait: current,
      };
    }
    const updated: WorkWait = {
      ...current,
      status: to,
      updatedAt: this.now(),
      resolvedAt: this.now(),
      ...(resultRef ? { resultRef } : {}),
      ...(reason ? { condition: current.condition ? `${current.condition}（${reason}）` : reason } : {}),
      ...(to === 'resolved' && !resultRef ? { resultRef: 'event' } : {}),
    };
    const ok = await this.deps.repository.update(updated, 'pending');
    if (!ok) {
      const fresh = await this.deps.repository.get(waitId);
      if (!fresh) return { ok: false, status: 'unknown', message: '这个等待不存在' };
      return {
        ok: false,
        status: fresh.status as 'resolved' | 'cancelled' | 'expired',
        message: WAIT_TERMINAL_MESSAGES[fresh.status as 'resolved' | 'cancelled' | 'expired'],
        wait: fresh,
      };
    }
    return { ok: true, wait: updated };
  }
}

/** 关联键与「等谁」的约定集中在 wait.ts，这里 re-export 便于调用方一处导入 */
export { agentWaitKey, timeWaitKey } from './wait.js';
