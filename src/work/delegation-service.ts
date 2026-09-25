import type { DelegationRepositoryPort } from '../storage/ports.js';
import {
  canTransitionDelegation,
  isOpenDelegation,
  isReplyToDelegation,
  type Delegation,
  type DelegationStatus,
} from './delegation.js';

/**
 * 委派服务（E4.4）：Delegation 的唯一状态转换入口。
 *
 * 职责边界（与 §4.6 / §7.1 对齐）：
 *   - 派活时记下「谁派给谁、发起方哪件工作、哪封信」；线程键用投递 id（重试稳定）；
 *   - 收件方接下后回填 childWorkId；回信 / 取消把状态推到终态；
 *   - 终态不可回退：迟到的回信不能复活已取消的委派（与 WorkWait 同一条纪律）。
 * 不碰 HTTP、不认识运行时；存储经 DelegationRepositoryPort。
 */

export class DelegationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DelegationError';
  }
}

export interface RecordOutboundInput {
  /** 请求信的投递 id：既当委派 id 也当回复线程键 */
  id: string;
  fromAgentId: string;
  toAgentId: string;
  parentWorkId?: string;
  requestMessageId?: string;
  now?: number;
}

export interface DelegationServiceDeps {
  repository: DelegationRepositoryPort;
}

export class DelegationService {
  constructor(private readonly deps: DelegationServiceDeps) {}

  private now(input?: number): number {
    return input ?? Date.now();
  }

  /**
   * 记一条派出去的委派。**幂等**：同一封信重试/重复提交时返回原记录，
   * 不新建也不改状态（投递那边已经按指纹去重，这里跟它对齐）。
   */
  async recordOutbound(input: RecordOutboundInput): Promise<Delegation> {
    const existing = await this.deps.repository.get(input.id);
    if (existing) return existing;
    const at = this.now(input.now);
    const delegation: Delegation = {
      id: input.id,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      correlationId: input.id,
      status: 'sent',
      createdAt: at,
      updatedAt: at,
      ...(input.parentWorkId ? { parentWorkId: input.parentWorkId } : {}),
      ...(input.requestMessageId ? { requestMessageId: input.requestMessageId } : {}),
    };
    await this.deps.repository.save(delegation);
    return delegation;
  }

  async get(delegationId: string): Promise<Delegation | undefined> {
    return this.deps.repository.get(delegationId);
  }

  /** 某位同事发起的全部委派（最近更新在前） */
  async listFrom(agentId: string): Promise<Delegation[]> {
    return this.deps.repository.listFrom(agentId);
  }

  /** 某位同事还开着的委派：停止按它下发精确作用域 */
  async listOpenFrom(agentId: string): Promise<Delegation[]> {
    return (await this.deps.repository.listFrom(agentId)).filter(isOpenDelegation);
  }

  /**
   * 这封信是不是「同事在回我刚才派出去的那件事」：
   * 命中就返回那条委派，让调用方按它精确唤醒（而不是把等这位同事的等待全解决）。
   */
  async resolveReplyThread(input: {
    callerId: string;
    targetId: string;
    threadId?: string;
  }): Promise<Delegation | undefined> {
    if (!input.threadId) return undefined;
    const found = await this.deps.repository.get(input.threadId);
    if (!found || !isReplyToDelegation(found, input)) return undefined;
    return found;
  }

  /** 收件方接下了这件委派（开始为它干活） */
  async markAccepted(delegationId: string): Promise<Delegation | undefined> {
    return this.transition(delegationId, 'accepted');
  }

  /** 回填收件方为这件委派开的工作 */
  async attachChildWork(delegationId: string, childWorkId: string): Promise<Delegation | undefined> {
    const current = await this.deps.repository.get(delegationId);
    if (!current || !isOpenDelegation(current) || current.childWorkId === childWorkId) return current;
    const updated: Delegation = {
      ...current,
      childWorkId,
      updatedAt: this.now(),
    };
    const ok = await this.deps.repository.update(updated, current.status);
    return ok ? updated : this.deps.repository.get(delegationId);
  }

  /** 同事回了这封信：委派闭环（迟到回信拿不到二次推进） */
  async markReplied(delegationId: string): Promise<Delegation | undefined> {
    return this.transition(delegationId, 'replied');
  }

  /** 停止/收件人没了：显式取消，写清原因 */
  async cancel(delegationId: string, note?: string): Promise<Delegation | undefined> {
    return this.transition(delegationId, 'cancelled', note);
  }

  private async transition(
    delegationId: string,
    to: DelegationStatus,
    note?: string,
  ): Promise<Delegation | undefined> {
    const current = await this.deps.repository.get(delegationId);
    if (!current) return undefined;
    if (!canTransitionDelegation(current.status, to)) {
      if (current.status === to) return current;
      throw new DelegationError(`委派已经是 ${current.status}，不能回到 ${to}`, 'DELEGATION_ALREADY_CLOSED');
    }
    const at = this.now();
    const updated: Delegation = {
      ...current,
      status: to,
      updatedAt: at,
      ...(note ? { note } : {}),
      ...(to === 'cancelled' || to === 'replied' ? { endedAt: at } : {}),
    };
    const ok = await this.deps.repository.update(updated, current.status);
    if (!ok) return this.deps.repository.get(delegationId);
    return updated;
  }
}
