import { randomUUID } from 'node:crypto';
import type { Message } from '../../shared/contracts/sse.js';
import type { RoomMessage } from '../../room/types.js';
import type { AgentEventHandler } from '../../agent/types.js';
import type { InteractionBroker } from '../../interaction/broker.js';
import type { AgentInbox } from '../../agent/inbox.js';
import type { RoomStore } from '../../room/store.js';
import type { MessageStore } from '../../store/messages.js';
import type { RunLedger } from '../../storage/run-ledger.js';
import { isStopSentence, DEFAULT_STOP_WORDS } from '../../config.js';
import type { AgentRegistry } from '../../agent/registry.js';
import type { Delegation } from '../../work/delegation.js';
import type { DelegationService } from '../../work/delegation-service.js';
import type { PendingStop, SendOptions, SendResult } from './types.js';
import type { ActivationCoordinator } from './activation-coordinator.js';
import type { EffectRunner } from './effect-runner.js';

/** 一次停止令要求回执的对象：精确到「哪个下级、哪件子工作、哪次委派」 */
interface AckTarget {
  toAgentId: string;
  childWorkId?: string;
  /** 委派 id（线程键）：停止与唤醒共用 */
  threadId: string;
}

/** 一次停止令的收尾结果：本地停了，但可能有下级没确认 */
interface StopOutcome {
  result: SendResult;
  /** 未确认的委派（childWorkId ?? 委派 id）：如实展示，不说「全部停了」 */
  unconfirmed: string[];
}

/**
 * StopCoordinator（E2.2 拆出）：停止令的认词、排队与执行。
 *
 * 契约见 docs/架构设计.md「插话、停止和等待」与 §7.1：
 *   - 停的是任务树，不是按钮；递归往下传（dm 走紧急信，room 只能下一轮看见）
 *   - 用户回合优先：撞上正在跑的用户回合就排队，回合结束立刻处理
 *   - 只砍「早于本令」的树，用户新开的事不受牵连
 *
 * E4.4 起停止有**精确范围**：委派记了 parentWorkId/childWorkId/correlationId，
 * 停止令按 `cancelId + childWorkId` 下发，接收者只取消对应那件委派——停 A 派出去的
 * 活不会连坐 B 的独立工作；回执按唯一的 `(cancelId, childWorkId)` 去重，不按收到
 * 几封信计数；部分下级超时未回时状态是 needs_attention 并列出未确认对象。
 *
 * 回合/任务树状态经 RunLedger 读（E3.3 接线）；pendingStops 与 runtime 共享引用（Map 传引用）。
 */
export class StopCoordinator {
  private readonly pendingStops: Map<string, PendingStop[]>;

  constructor(
    private readonly deps: {
      registry: AgentRegistry;
      messages: MessageStore;
      inbox: AgentInbox;
      rooms: RoomStore;
      broker: InteractionBroker;
      ledger: RunLedger;
      pendingStops: Map<string, PendingStop[]>;
      stopWords: string[];
      stopAckTimeoutMs: number;
      activation?: ActivationCoordinator;
      effects?: EffectRunner;
      /** 委派账本（E4.4）：精确停止与精确唤醒共用同一套关联键 */
      delegations?: DelegationService;
      /** 子工作随委派一起停：收件方那件工作由停止令关掉 */
      cancelWork?: (workId: string, reason: string) => Promise<void>;
      /** 委派被停：对应的「等它回信」作废（不动同事别的等待） */
      onDelegationCancelled?: (delegation: Delegation) => Promise<void>;
      /** 迟到的回执把停止状态更新掉（设计 §7.1「后续回执更新状态」） */
      onStopAcksSettled?: (
        stopId: string | undefined,
        remaining: string[],
        confirmed?: string,
      ) => void | Promise<void>;
    },
  ) {
    this.pendingStops = deps.pendingStops;
  }

  /** 用户发来停止词：控制事务先生效，再取消句柄；不等待正在执行的用户回合。 */
  async stopFromUser(agentId: string, text: string, options: SendOptions): Promise<SendResult> {
    const commandId = options.clientMessageId ?? options.messageId ?? options.runId ?? `${agentId}:stop:${text}`;
    const operation = this.deps.activation
      ? await this.deps.activation.requestStop({
          commandId,
          requestedBy: { kind: 'user', id: 'owner' },
          scope: { kind: 'agent', agentId },
        })
      : undefined;
    if (this.deps.activation) {
      await this.deps.inbox.hold(agentId, 'agent_paused').catch(() => 0);
    }
    const runningId = this.deps.ledger.runningTurnOf(agentId);
    if (runningId) {
      const treeId = this.deps.ledger.getTurn(runningId)?.treeId;
      if (treeId) for (const job of this.deps.ledger.jobsOf(treeId)) job.abort();
    }
    const { result, unconfirmed } = await this.executeStop(
      agentId,
      { text, createdAt: Date.now() },
      { notifyUser: true, options, ...(operation ? { stopId: operation.stopId } : {}) },
    );
    if (operation && this.deps.activation) {
      const pending = (await this.deps.effects?.waitFor(operation.targetEffectIds, 5_000)) ?? [];
      await this.deps.activation
        .settleStop(
          operation.stopId,
          pending.length > 0 || unconfirmed.length > 0 ? 'needs_attention' : 'settled',
          unconfirmed,
        )
        .catch(() => undefined);
    }
    return result;
  }

  /**
   * 上级停止令（dm 的 kind=stop）：同样保护用户回合；处理完回 stop-ack。
   * 带 cancelId / childWorkId / correlationId 时是**精确作用域**停止：
   * 只掐这封信指向的那件委派，绝不按「全部未完工作」连坐。
   */
  async stopFromParent(
    agentId: string,
    stop: {
      text: string;
      createdAt: number;
      treeId?: string;
      correlationId?: string;
      cancelId?: string;
      childWorkId?: string;
    },
    replyTo: {
      agentId: string;
      name: string;
      treeId?: string;
      correlationId?: string;
      cancelId?: string;
      childWorkId?: string;
    },
  ): Promise<void> {
    const runningId = this.deps.ledger.runningTurnOf(agentId);
    const running = runningId ? this.deps.ledger.getTurn(runningId) : undefined;
    if (running && running.source === 'user' && running.status === 'running') {
      const queue = this.pendingStops.get(agentId) ?? [];
      queue.push({
        text: stop.text,
        createdAt: stop.createdAt,
        options: {},
        notifyUser: false,
        replyTo,
      });
      this.pendingStops.set(agentId, queue);
      return;
    }
    if (stop.cancelId || stop.correlationId || stop.childWorkId) {
      await this.executeScopedStop(agentId, stop, replyTo).catch(() => undefined);
      return;
    }
    await this.executeStop(agentId, stop, { notifyUser: false, options: {}, replyTo }).catch(
      () => undefined,
    );
  }

  async stopRoomFlow(roomId: string, flowId: string, text: string): Promise<void> {
    if (this.deps.activation) {
      // commandId 由范围决定：同一个流程重复停只留一个 StopOperation，
      // 随机 id 会让「用户一句停 → 路由+编排各调一次」叠加出多个停止操作
      const operation = await this.deps.activation.requestStop({
        commandId: `room_flow:${roomId}:${flowId}`,
        requestedBy: { kind: 'user', id: 'owner' },
        scope: { kind: 'room_flow', roomId, flowId },
      });
      for (const ticketId of operation.targetTicketIds) {
        const ticket = this.deps.activation.getTicket(ticketId);
        if (ticket) {
          const runningId = this.deps.ledger.runningTurnOf(ticket.agentId);
          const turn = (runningId ? this.deps.ledger.getTurn(runningId) : undefined) ?? this.deps.ledger.getTurn(ticket.runId);
          if (turn?.treeId) {
            const tree = this.deps.ledger.getTree(turn.treeId);
            if (tree) {
              tree.status = 'cancelling';
              this.deps.ledger.putTree(tree);
            }
            for (const job of this.deps.ledger.jobsOf(turn.treeId)) {
              job.abort();
            }
          }
        }
      }
      // 停完必须结算：不结算的 StopOperation 永远停在 stopping，
      // 轮询停止状态的界面会看到一个永不结束的指示器
      const pending = (await this.deps.effects?.waitFor(operation.targetEffectIds, 5_000)) ?? [];
      await this.deps.activation
        .settleStop(operation.stopId, pending.length > 0 ? 'needs_attention' : 'settled')
        .catch(() => undefined);
    }
  }

  /** 回合结束时清空排队的停止令（在欠账续跑之前执行） */
  async processPendingStops(agentId: string): Promise<void> {
    const queue = this.pendingStops.get(agentId);
    if (!queue || queue.length === 0) return;
    this.pendingStops.set(agentId, []);
    for (const stop of queue) {
      const { result } = await this.executeStop(
        agentId,
        { text: stop.text, createdAt: stop.createdAt },
        { notifyUser: stop.notifyUser, options: stop.options, replyTo: stop.replyTo },
      ).catch(() => ({ result: undefined, unconfirmed: [] as string[] }));
      stop.resolve?.(
        result ?? {
          content: '停完了。',
          iterations: 0,
          stopReason: 'stopped',
          agentId,
          agentName: agentId,
          context: {
            agentId,
            system: '',
            messages: [],
            stats: { sections: [], totalTokens: 0, budgetTokens: 0, generatedAt: Date.now() },
            surfaced: [],
            droppedRecent: 0,
            droppedGroups: 0,
          },
          posts: [],
          status: 'spoke',
        },
      );
    }
  }

  /** 用户新句作废未答选项卡：不当答案，也不留悬挂卡片（持久卡的作废在 runtime，那里才认识 WorkWait） */
  voidPendingInteractions(agentId: string, emit?: AgentEventHandler): void {
    const pending = this.deps.broker.pendingList({ agentId });
    for (const request of pending) {
      this.deps.broker.cancel(request.id);
      emit?.({ type: 'interaction_closed', id: request.id, answered: false });
    }
  }

  /**
   * 执行停止令（机械步骤，不经模型）：
   * 在停 → 砍早于本令的树 → 精确停掉自己派出去的委派 → dm 下发紧急件 / room 普通文本
   * → 等 stop-ack 或超时 → 如实收尾。
   * 上级的令（notifyUser=false）走同一套，只是不写自己的对话线、最后回 stop-ack。
   */
  private async executeStop(
    agentId: string,
    stop: { text: string; createdAt: number },
    opts: {
      notifyUser: boolean;
      options: SendOptions;
      replyTo?: {
        agentId: string;
        name: string;
        treeId?: string;
        cancelId?: string;
        childWorkId?: string;
      };
      stopId?: string;
    },
  ): Promise<StopOutcome> {
    const record = await this.deps.registry.get(agentId);
    const name = record?.name ?? '智能体';
    const emit = opts.options.onEvent;

    const persist = async (line: string): Promise<void> => {
      if (!opts.notifyUser) return;
      const message: Message = {
        id: randomUUID(),
        runId: opts.options.runId,
        agentId,
        role: 'assistant',
        content: { type: 'text', text: line },
        createdAt: Date.now(),
        source: 'user',
      };
      await this.deps.messages.append(message);
      emit?.({ type: 'message', message });
    };

    await persist('好的，在停。');

    // 只砍「早于本令」的 open 树：停止令之后用户新开的事不受牵连
    const targets = this.deps.ledger
      .listTrees()
      .filter(
        (tree) => tree.agentId === agentId && (tree.status === 'open' || tree.status === 'incomplete') && tree.createdAt < stop.createdAt,
      );
    const dmChildren: Array<{ agentId: string; treeId: string }> = [];
    const roomChildren: Array<{ roomId?: string }> = [];
    for (const tree of targets) {
      tree.status = 'cancelling';
      this.deps.ledger.putTree(tree);
      for (const job of this.deps.ledger.jobsOf(tree.id)) job.abort();
      for (const child of tree.children) {
        if (child.via === 'dm') dmChildren.push({ agentId: child.agentId, treeId: tree.id });
        else roomChildren.push({ roomId: child.roomId });
      }
    }

    // E4.4：把自己在此之前派出去、还没结束的委派按精确作用域停掉
    const cancelId = opts.stopId ? `stop:${opts.stopId}` : `stop:${agentId}:${stop.createdAt}`;
    const delegationTargets = await this.stopOwnDelegations(agentId, stop.createdAt, cancelId);

    for (const child of dmChildren) {
      await this.deps.inbox.enqueue({
        toAgentId: child.agentId,
        fromAgentId: agentId,
        fromName: name,
        text: '停止令：把手上正在做的活停掉。',
        priority: true,
        depth: 0,
        kind: 'stop',
        treeId: child.treeId,
      });
    }
    for (const child of roomChildren) {
      if (!child.roomId) continue;
      const message: RoomMessage = {
        id: randomUUID(),
        roomId: child.roomId,
        roundId: randomUUID(),
        senderKind: 'agent',
        senderId: agentId,
        senderName: name,
        text: '先停，别继续了。',
        mentions: [],
        everyone: false,
        createdAt: Date.now(),
      };
      await this.deps.rooms.append(message);
      opts.options.onRoomEvent?.({ type: 'room_message', message });
    }

    // 回执按唯一的 (cancelId, childWorkId) 去重：不能只按收到几封信计数
    const expected = new Map<string, string>();
    const labels = new Map<string, string>();
    for (const child of dmChildren) {
      expected.set(`${child.agentId}:${child.treeId}`, child.agentId);
      labels.set(`${child.agentId}:${child.treeId}`, child.agentId);
    }
    for (const target of delegationTargets) {
      const key = this.scopedAckKey(cancelId, target);
      const label = target.childWorkId ?? target.threadId;
      expected.set(key, label);
      labels.set(key, label);
    }
    const unconfirmed =
      expected.size > 0
        ? await this.awaitExpectations(agentId, expected, this.deps.stopAckTimeoutMs, {
            cancelId,
            ...(opts.stopId ? { stopId: opts.stopId } : {}),
            labels,
          })
        : [];

    for (const tree of targets) {
      tree.status = 'cancelled';
      this.deps.ledger.putTree(tree);
    }

    if (unconfirmed.length > 0) {
      const names = await this.namesOfUnconfirmed(unconfirmed, delegationTargets);
      await persist(`本地已停止，仍有 ${unconfirmed.length} 项未确认：${names.join('、')}。`);
    } else {
      await persist('停完了。');
    }

    if (opts.replyTo) {
      await this.deps.inbox.enqueue({
        toAgentId: opts.replyTo.agentId,
        fromAgentId: agentId,
        fromName: name,
        text: '已停。',
        priority: true,
        depth: 0,
        kind: 'stop-ack',
        ...(opts.replyTo.treeId ? { treeId: opts.replyTo.treeId } : {}),
        ...(opts.replyTo.cancelId ? { cancelId: opts.replyTo.cancelId } : {}),
        ...(opts.replyTo.childWorkId ? { childWorkId: opts.replyTo.childWorkId } : {}),
      });
    }

    return {
      result: {
        content: unconfirmed.length > 0 ? `本地已停止，仍有 ${unconfirmed.length} 项未确认。` : '停完了。',
        iterations: 0,
        stopReason: 'stopped',
        agentId,
        agentName: name,
        context: {
          agentId,
          system: '',
          messages: [],
          stats: { sections: [], totalTokens: 0, budgetTokens: 0, generatedAt: Date.now() },
          surfaced: [],
          droppedRecent: 0,
          droppedGroups: 0,
        },
        posts: [],
        status: 'spoke',
      },
      unconfirmed,
    };
  }

  /**
   * 精确作用域停止（E4.4）：下级收到带 cancelId/childWorkId/correlationId 的停止令。
   * 只取消这封信指向的那棵「被派的树」、那件子工作，以及本同事为它再派出去的下级；
   * **不动**本同事的独立工作与自动准入状态。
   */
  private async executeScopedStop(
    agentId: string,
    stop: {
      text: string;
      createdAt: number;
      treeId?: string;
      correlationId?: string;
      cancelId?: string;
      childWorkId?: string;
    },
    replyTo: {
      agentId: string;
      name: string;
      treeId?: string;
      correlationId?: string;
      cancelId?: string;
      childWorkId?: string;
    },
  ): Promise<void> {
    const record = await this.deps.registry.get(agentId);
    const name = record?.name ?? '智能体';
    const threadId = stop.correlationId;
    const cancelId = stop.cancelId ?? `stop:${threadId ?? stop.createdAt}`;

    // 1) 只掐这棵被委派信触发的树：同一同事的独立工作不在这条线程上
    if (threadId) this.cancelTreesOfThread(agentId, threadId);

    // 2) 收件方为这件委派开的工作随令关掉
    if (stop.childWorkId) {
      await this.deps.cancelWork?.(stop.childWorkId, '收到上级停止令').catch(() => undefined);
    }

    // 3) 本同事为这件委派再派出去的下级：同样的精确作用域往下传（有界、防环）
    await this.propagateDelegations(agentId, name, cancelId, stop.childWorkId, new Set());

    // 4) 回执：带回同一对 (cancelId, childWorkId)，让发起方按唯一键去重
    await this.deps.inbox.enqueue({
      toAgentId: replyTo.agentId,
      fromAgentId: agentId,
      fromName: name,
      text: '已停。',
      priority: true,
      depth: 0,
      kind: 'stop-ack',
      ...(replyTo.treeId ? { treeId: replyTo.treeId } : {}),
      ...(threadId ? { correlationId: threadId } : {}),
      ...(cancelId ? { cancelId } : {}),
      ...(stop.childWorkId ? { childWorkId: stop.childWorkId } : {}),
    });
  }

  /** 只取消与这条委派线程对应的树（被派的那棵），其它树原样保留 */
  private cancelTreesOfThread(agentId: string, threadId: string): void {
    for (const tree of this.deps.ledger.listTrees()) {
      if (tree.agentId !== agentId) continue;
      if (tree.status !== 'open' && tree.status !== 'incomplete' && tree.status !== 'cancelling') continue;
      const root = this.deps.ledger.getTurn(tree.rootTurnId);
      if (!root || root.correlationId !== threadId) continue;
      tree.status = 'cancelling';
      this.deps.ledger.putTree(tree);
      for (const job of this.deps.ledger.jobsOf(tree.id)) job.abort();
      tree.status = 'cancelled';
      this.deps.ledger.putTree(tree);
    }
  }

  /**
   * 本同事派出去的、属于这件子工作的下级委派：逐条精确取消并下发停止令。
   * 带 visited 与深度上限，避免互相委派时打转。
   */
  private async propagateDelegations(
    agentId: string,
    agentName: string,
    cancelId: string,
    parentWorkId: string | undefined,
    visited: Set<string>,
    depth = 0,
  ): Promise<void> {
    if (!parentWorkId || !this.deps.delegations || depth >= 8) return;
    const children = (await this.deps.delegations.listOpenFrom(agentId)).filter(
      (delegation) => delegation.parentWorkId === parentWorkId && !visited.has(delegation.id),
    );
    for (const child of children) {
      visited.add(child.id);
      await this.cancelDelegationLocally(child, '收到上级停止令');
      await this.deps.inbox.enqueue({
        toAgentId: child.toAgentId,
        fromAgentId: agentId,
        fromName: agentName,
        text: '停止令：把手上正在做的活停掉。',
        priority: true,
        depth: 0,
        kind: 'stop',
        correlationId: child.id,
        cancelId,
        ...(child.childWorkId ? { childWorkId: child.childWorkId } : {}),
      });
      await this.propagateDelegations(agentId, agentName, cancelId, child.childWorkId, visited, depth + 1);
    }
  }

  /** 本同事在此之前派出去、还没结束的委派：本地精确取消 + 下发精确停止令 */
  private async stopOwnDelegations(
    agentId: string,
    before: number,
    cancelId: string,
  ): Promise<AckTarget[]> {
    if (!this.deps.delegations) return [];
    const open = (await this.deps.delegations.listOpenFrom(agentId)).filter(
      (delegation) => delegation.createdAt < before,
    );
    const record = await this.deps.registry.get(agentId);
    const name = record?.name ?? '智能体';
    const targets: AckTarget[] = [];
    for (const delegation of open) {
      await this.cancelDelegationLocally(delegation, '用户停止令');
      targets.push({
        toAgentId: delegation.toAgentId,
        threadId: delegation.id,
        ...(delegation.childWorkId ? { childWorkId: delegation.childWorkId } : {}),
      });
      await this.deps.inbox.enqueue({
        toAgentId: delegation.toAgentId,
        fromAgentId: agentId,
        fromName: name,
        text: '停止令：把手上正在做的活停掉。',
        priority: true,
        depth: 0,
        kind: 'stop',
        correlationId: delegation.id,
        cancelId,
        ...(delegation.childWorkId ? { childWorkId: delegation.childWorkId } : {}),
      });
    }
    return targets;
  }

  /** 本地把一条委派收成终态：状态 → cancelled，对应等待作废，子工作关掉 */
  private async cancelDelegationLocally(delegation: Delegation, note: string): Promise<void> {
    await this.deps.delegations?.cancel(delegation.id, note).catch(() => undefined);
    await this.deps.onDelegationCancelled?.(delegation).catch(() => undefined);
    if (delegation.childWorkId) {
      await this.deps.cancelWork?.(delegation.childWorkId, note).catch(() => undefined);
    }
  }

  /**
   * 正在等待下级回执的停止令：agentId → 期望的回执键集合。
   * 回执由收件方的 inbox 处理器确认时经 noteStopAck 登记，等待方只读这张表——
   * 不再用 inbox.take 去抢信（那会绕过租约，把处理器正在领的批次拽掉，
   * 轻则 ack 抛租约丢失、整批信卡 5 分钟，重则双方都消费不到）。
   */
  private readonly awaitingAcks = new Map<
    string,
    { cancelId?: string; expected: Map<string, string> }
  >();

  /**
   * 超时后仍在等回执的停止令：`agentId|cancelId` → 还没确认的对象。
   * 迟到的回执按同一对键匹配上，把 StopOperation 从 needs_attention 更新掉。
   */
  private readonly lateAcks = new Map<
    string,
    {
      stopId?: string;
      cancelId: string;
      expected: Map<string, string>;
      labelOf: (key: string) => string;
    }
  >();

  /** 收件方确认了一条 stop-ack：通知可能在等待它的停止令 */
  noteStopAck(
    agentId: string,
    fromAgentId: string,
    treeId?: string,
    extra?: { cancelId?: string; childWorkId?: string; correlationId?: string },
  ): void {
    const key = extra?.cancelId
      ? this.scopedAckKey(extra.cancelId, {
          toAgentId: fromAgentId,
          threadId: extra.correlationId ?? '',
          ...(extra.childWorkId ? { childWorkId: extra.childWorkId } : {}),
        })
      : `${fromAgentId}:${treeId ?? ''}`;
    const waiting = this.awaitingAcks.get(agentId);
    // 带 cancelId 的回执只认本次停止令：上一次（已超时）的回执不能顶掉这一次的期望
    const sameStop = !extra?.cancelId || !waiting?.cancelId || waiting.cancelId === extra.cancelId;
    if (waiting && sameStop && waiting.expected.delete(key)) {
      if (waiting.expected.size === 0) this.awaitingAcks.delete(agentId);
      return;
    }
    // 已经超时收尾的停止令：迟到回执只用来更新状态，不复活等待
    if (extra?.cancelId) this.noteLateAck(agentId, extra.cancelId, key);
  }

  private noteLateAck(agentId: string, cancelId: string, key: string): void {
    const late = this.lateAcks.get(`${agentId}|${cancelId}`);
    if (!late) return;
    const confirmed = late.labelOf(key);
    const acknowledged = late.expected.delete(key);
    if (!acknowledged) return;
    const remaining = [...late.expected.values()];
    if (remaining.length === 0) this.lateAcks.delete(`${agentId}|${cancelId}`);
    void this.deps.onStopAcksSettled?.(late.stopId, remaining, confirmed);
  }

  /**
   * 等下级的 stop-ack 的**旧形状**（只按「谁 + 哪棵树」，没有 cancelId/childWorkId）。
   * 生产路径已统一走 awaitExpectations 的 (cancelId, childWorkId) 键；这里保留旧形状，
   * 让 test/stop-ack-registry.test.ts 继续钉住「登记即返回 / 超时清干净 / 乱到的 ack 不堆积」。
   */
  private async awaitStopAcks(
    agentId: string,
    expectedChildren: Array<{ agentId: string; treeId: string }>,
    timeoutMs: number,
  ): Promise<string[]> {
    const expected = new Map<string, string>();
    for (const child of expectedChildren) expected.set(`${child.agentId}:${child.treeId}`, child.agentId);
    if (expected.size === 0) return [];
    return this.awaitExpectations(agentId, expected, timeoutMs);
  }

  /** 按期望集合等回执；超时后把剩余对象登记成「迟到回执也能更新状态」 */
  private async awaitExpectations(
    agentId: string,
    expected: Map<string, string>,
    timeoutMs: number,
    meta?: { cancelId?: string; stopId?: string; labels?: Map<string, string> },
  ): Promise<string[]> {
    this.awaitingAcks.set(agentId, { ...(meta?.cancelId ? { cancelId: meta.cancelId } : {}), expected });
    const deadline = Date.now() + timeoutMs;
    try {
      while (expected.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    } finally {
      if (this.awaitingAcks.get(agentId)?.expected === expected) this.awaitingAcks.delete(agentId);
    }
    const labels = meta?.labels;
    const unconfirmed = [...expected.values()];
    if (unconfirmed.length > 0 && meta?.cancelId) {
      this.lateAcks.set(`${agentId}|${meta.cancelId}`, {
        ...(meta.stopId ? { stopId: meta.stopId } : {}),
        cancelId: meta.cancelId,
        expected,
        labelOf: (key: string) => labels?.get(key) ?? expected.get(key) ?? key,
      });
    }
    return unconfirmed;
  }

  private scopedAckKey(cancelId: string, target: AckTarget): string {
    return `${cancelId}|${target.childWorkId ?? target.threadId}`;
  }

  /** 未确认对象换成同事名 + 子工作/委派标识，给用户一句实话 */
  private async namesOfUnconfirmed(
    unconfirmed: string[],
    targets: AckTarget[],
  ): Promise<string[]> {
    const names: string[] = [];
    for (const item of unconfirmed) {
      const target = targets.find(
        (candidate) => (candidate.childWorkId ?? candidate.threadId) === item,
      );
      const record = target ? await this.deps.registry.get(target.toAgentId) : undefined;
      names.push(record ? `${record.name}（${item.slice(0, 8)}）` : item);
    }
    return names;
  }

  /** 停止词判定（配置词表 + 整句匹配） */
  isStopSentence(text: string): boolean {
    return isStopSentence(text, this.deps.stopWords.length > 0 ? this.deps.stopWords : DEFAULT_STOP_WORDS);
  }
}
