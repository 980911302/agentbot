/**
 * 执行控制契约（v2）：许可、停止、恢复与自动准入谓词。
 * 语义见 docs/执行控制与可靠投递修复设计.md §6–§7、§11.3。
 */

export const CONTROL_SCHEMA_VERSION = 1;

export const CHAIN_BUDGET_DEFAULTS = {
  maxAutomaticRunsPerChain: 24,
  maxDeliveryActionsPerChain: 24,
  maxRecipientDeliveriesPerChain: 48,
  maxRepeatedNoProgress: 3,
} as const;

export type AutoActivation = 'enabled' | 'paused';

export interface AgentControl {
  agentId: string;
  /** 该智能体的停止边界；持久递增 */
  generation: number;
  autoActivation: AutoActivation;
  /** 状态更新版本，不等于 generation */
  revision: number;
  lastStopId?: string;
  lastStopSeq?: number;
  /** 此序号及以前建立的链默认禁止再自动准入 */
  blockedAutoRootsThroughSeq?: number;
}

export type GrantScope =
  | { kind: 'input'; inputId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'chain'; chainId: string };

export interface ActivationGrant {
  grantId: string;
  agentId: string;
  generation: number;
  issuedByCommandId: string;
  issuedSeq: number;
  scope: GrantScope;
  state: 'active' | 'revoked' | 'closed';
}

export type ActivationSource = 'user' | 'inbox' | 'room' | 'resume' | 'recovery';

export interface ActivationTicket {
  ticketId: string;
  agentId: string;
  runId: string;
  taskId: string;
  inputId: string;
  chainId: string;
  generation: number;
  /** 现有执行位 fencing，用于抢占/换手 */
  executionEpoch: number;
  /** 旧进程票据不能跨进程复用 */
  processEpoch: string;
  grantId?: string;
  lease?: { deliveryId: string; ownerId: string; epoch: number };
  admittedSeq: number;
  source: ActivationSource;
  state: 'admitted' | 'running' | 'revoked' | 'settled';
}

export type StopScope =
  | { kind: 'agent'; agentId: string }
  | { kind: 'room_round'; roomId: string; roundId: string }
  | { kind: 'all_agents' };

export interface StopCommand {
  commandId: string;
  requestedBy: { kind: 'user'; id: string };
  scope: StopScope;
}

export interface StopOperation {
  stopId: string;
  commandId: string;
  scope: StopScope;
  committedSeq: number;
  targetTicketIds: string[];
  targetEffectIds: string[];
  state: 'stopping' | 'settled' | 'needs_attention';
  pendingEffects: Array<{ id: string; reason: string }>;
}

export type ResumeSelection =
  | { kind: 'input'; inputId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'chain'; chainId: string }
  | { kind: 'enable_future' };

export interface ResumeCommand {
  commandId: string;
  requestedBy: { kind: 'user'; id: string };
  agentId: string;
  selection: ResumeSelection;
}

export type HoldReason =
  | 'agent_paused'
  | 'chain_paused'
  | 'budget_exhausted'
  | 'manual_review'
  | 'legacy_unscoped'
  | 'stale_activation'
  | 'cancelled';

export type DeliveryDisposition = 'eligible' | 'held' | 'cancelled';

export interface ActivationRequest {
  agentId: string;
  runId: string;
  taskId: string;
  inputId: string;
  chainId: string;
  source: ActivationSource;
  rootCreatedSeq?: number;
  disposition?: DeliveryDisposition;
  grantId?: string;
  lease?: { deliveryId: string; ownerId: string; epoch: number };
}

export type ActivationDecision =
  | { kind: 'admitted'; ticket: ActivationTicket }
  | { kind: 'held'; reason: HoldReason }
  | { kind: 'busy' }
  | { kind: 'cancelled'; reason: string };

export interface EffectIntent {
  effectId: string;
  kind: string;
  resourceScope?: string;
}

export interface EffectPermit {
  ticketId: string;
  effectId: string;
  admittedSeq: number;
  resourceScope?: string;
  state: 'reserved' | 'started' | 'settled' | 'unknown' | 'cancelled';
}

export interface DeliveryReceipt {
  receiptId: string;
  actionId: string;
  inputId: string;
  chainId: string;
  actorId: string;
  target: { kind: 'agent' | 'room'; id: string; nameAtSend: string };
  payloadHash: string;
  outcome: 'accepted';
  committedSeq: number;
  acceptedAt: number;
  deliveryId?: string;
  timelineMessageId?: string;
  recipientDeliveryIds?: string[];
}

export type DeliverySubmitResult =
  | { kind: 'accepted'; receipt: DeliveryReceipt; projectionStatus: 'pending' | 'visible' | 'failed' }
  | { kind: 'rejected'; attemptId: string; actionId?: string; code: string }
  | { kind: 'unknown'; actionId: string; code: 'DELIVERY_COMMIT_UNKNOWN' };

export interface MayAutoActivateInput {
  control: AgentControl;
  rootCreatedSeq?: number;
  chainId?: string;
  inputId?: string;
  taskId?: string;
  grant?: ActivationGrant;
  disposition?: DeliveryDisposition;
}

/**
 * 自动准入谓词（设计 §6.2）：
 * 当前代次等其它检查由协调器另行完成。此处只判断：
 * ① 存在覆盖该主体及本项输入的有效 grant；或
 * ② 主体 enabled、根链序号晚于停止边界且本项未 held/cancelled。
 * 仅 enabled 不够；缺少可信根序号也不够。
 */
export function mayAutoActivate(input: MayAutoActivateInput): boolean {
  if (input.disposition === 'held' || input.disposition === 'cancelled') return false;
  if (grantCovers(input)) return true;
  if (input.control.autoActivation !== 'enabled') return false;
  const blockedThrough = input.control.blockedAutoRootsThroughSeq ?? 0;
  if (blockedThrough === 0) return true;
  if (input.rootCreatedSeq === undefined) return false;
  return input.rootCreatedSeq > blockedThrough;
}

function grantCovers(input: MayAutoActivateInput): boolean {
  const grant = input.grant;
  if (!grant || grant.state !== 'active') return false;
  if (grant.agentId !== input.control.agentId) return false;
  if (grant.generation !== input.control.generation) return false;
  switch (grant.scope.kind) {
    case 'chain':
      return grant.scope.chainId === input.chainId;
    case 'input':
      return grant.scope.inputId === input.inputId;
    case 'task':
      return grant.scope.taskId === input.taskId;
  }
}
