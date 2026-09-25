/**
 * 委派关系（E4.4，模型见 docs/架构设计.md §4.6 Delegation、§7.1）。
 *
 * 「我把哪件事派给了谁」以前只散落在任务树的 children 与投递里：停止时只能按
 * 「这个同事的全部未完工作」粗放地下发，回信也只能按「等这位同事」匹配。
 * 这里把委派落成一条记录：发起方的那件工作（parentWorkId）、收件方为它开的那件
 * 工作（childWorkId）、以及**线程键** correlationId。
 *
 * 线程键是停止与唤醒**共用**的精确关联键：
 *   - 唤醒：发起方等待同事回信时按它区分「哪一次请求」，一封回信只满足对应的那一次；
 *   - 停止：停止令按它下发，接收者只取消对应那件委派，不连坐别的独立工作。
 *
 * 本文件只放类型与**纯判定**，不碰存储、不认识运行时。
 */

export type DelegationStatus = 'sent' | 'accepted' | 'replied' | 'cancelled';

export interface Delegation {
  /** 就是请求信的投递 id：投递天然唯一、重试稳定，直接当线程键用（不另造随机 id） */
  id: string;
  fromAgentId: string;
  toAgentId: string;
  /** 派活时发起方手头那件工作 */
  parentWorkId?: string;
  /** 收件方为这件委派开的工作；接受前为空 */
  childWorkId?: string;
  /** 承载这次委派的请求信投递 id */
  requestMessageId?: string;
  /** 回复线程键（= id）：停止与唤醒共用同一套关联键 */
  correlationId: string;
  status: DelegationStatus;
  /** 取消/终结的原因（审计用；不进模型） */
  note?: string;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
}

const TERMINAL_STATUSES: DelegationStatus[] = ['replied', 'cancelled'];

export function isOpenDelegation(delegation: Delegation): boolean {
  return !TERMINAL_STATUSES.includes(delegation.status);
}

export function isTerminalDelegation(delegation: Delegation): boolean {
  return TERMINAL_STATUSES.includes(delegation.status);
}

/**
 * 状态机：sent → accepted → replied；未终结的随时可 cancelled。
 * 终态不可回退——迟到的回信不能把已取消的委派复活（与 WorkWait 同一条纪律）。
 */
export function canTransitionDelegation(from: DelegationStatus, to: DelegationStatus): boolean {
  if (TERMINAL_STATUSES.includes(from)) return false;
  switch (to) {
    case 'accepted':
      return from === 'sent';
    case 'replied':
      return from === 'sent' || from === 'accepted';
    case 'cancelled':
      return from === 'sent' || from === 'accepted';
    default:
      return false;
  }
}

/** 线程键（= 委派 id）：停止下发与回信唤醒都按它对齐 */
export function delegationThreadOf(delegation: Pick<Delegation, 'id'>): string {
  return delegation.id;
}

/**
 * 收到一封带线程键的信：它是不是这位同事对我某次委派的回信。
 * 只有「收件方就是我委派过的对象」才认，避免同 id 串到别的方向。
 */
export function isReplyToDelegation(
  delegation: Delegation,
  input: { callerId: string; targetId: string; threadId?: string },
): boolean {
  if (!input.threadId || input.threadId !== delegation.id) return false;
  return delegation.toAgentId === input.callerId && delegation.fromAgentId === input.targetId;
}
