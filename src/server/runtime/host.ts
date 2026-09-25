import type { AgentRecord, Message } from '../../agent/types.js';
import type { InboxItem } from '../../agent/inbox.js';
import type { RoomStore } from '../../room/store.js';
import type { RunExecutor } from './run-executor.js';
import type { WorkWait } from '../../work/wait.js';
import type { AcceptedRun, SendOptions, SendResult, TurnResult } from './types.js';
import type { WaitRequest } from './send-to-agent-service.js';
import type { Worker } from '../../tools/services/worker-manager.js';

/**
 * 装配期登记的「回调门面」接缝（OPT-03）。
 *
 * 这些方法要读门面自己的字段（locks / runExecutions / inboxScheduler / 各服务），
 * 所以只能由 AgentRuntime 提供；装配时**只登记不调用**——门面字段要等装配结果
 * 返回后才赋值（所以像 watchInbox 这类晚绑定能力也走这里，而不是传对象引用）。
 */
export interface RuntimeHost {
  isBusy(agentId: string): boolean;
  /** 等待被满足后开一次新回合接着做（等待不占执行位，唤醒走正常收信入口） */
  acceptMessage(agentId: string, text: string, options?: SendOptions): Promise<AcceptedRun<SendResult>>;
  /** 叫醒到期调度；inboxScheduler 建得最晚，只能延迟到调用时再取 */
  watchInbox(agentId: string): void;
  drainInbox(agentId: string, options?: SendOptions): Promise<TurnResult | null>;
  runTurn(
    agentId: string,
    task: Message,
    turn: Parameters<RunExecutor['runTurn']>[2],
    options?: SendOptions,
  ): Promise<TurnResult>;
  membersOf(
    roomId: string,
  ): Promise<{ room: Awaited<ReturnType<RoomStore['get']>>; members: AgentRecord[] }>;
  ownerName(): string;
  enrollAgent(agentId: string): Promise<void>;
  archiveLetter(item: InboxItem): Promise<void>;
  beginWait(input: WaitRequest): Promise<WorkWait>;
  requestUserWaitCard(
    agentId: string,
    input: {
      kind: 'choice' | 'secret';
      question: string;
      detail?: string;
      options?: Array<{ id: string; label: string }>;
      name?: string;
    },
  ): Promise<{ id: string }>;
  resolveAgentWaitsForReply(
    agentId: string,
    peerAgentId: string,
    resultRef: string,
    threadId?: string,
  ): Promise<void>;
  workBriefForPeerReply(
    agentId: string,
    peerAgentId: string,
    threadId?: string,
  ): Promise<string | undefined>;
  acceptDelegationLetter(
    agentId: string,
    letter: { id: string; fromAgentId: string; text: string; correlationId?: string },
  ): Promise<string | undefined>;
  sweepDueWaits(now?: number): Promise<{ satisfied: number; expired: number }>;
  /** 工人收尾（E4.5）：结果作为一封信送回派工者（实现见 runtime/worker-result-service.ts） */
  deliverWorkerResult(worker: Worker): Promise<void>;
}
