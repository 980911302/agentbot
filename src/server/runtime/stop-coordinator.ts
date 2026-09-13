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
import type { PendingStop, SendOptions, SendResult } from './types.js';
import type { ActivationCoordinator } from './activation-coordinator.js';

/**
 * StopCoordinator（E2.2 拆出）：停止令的认词、排队与执行。
 *
 * 契约见 docs/架构设计.md「插话、停止和等待」：
 *   - 停的是任务树，不是按钮；递归往下传（dm 走紧急信，room 只能下一轮看见）
 *   - 用户回合优先：撞上正在跑的用户回合就排队，回合结束立刻处理
 *   - 只砍「早于本令」的树，用户新开的事不受牵连
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
    },
  ) {
    this.pendingStops = deps.pendingStops;
  }

  /** 用户发来停止词：控制事务先生效，再取消句柄；不等待正在执行的用户回合。 */
  async stopFromUser(agentId: string, text: string, options: SendOptions): Promise<SendResult> {
    const commandId = options.clientMessageId ?? options.messageId ?? options.runId ?? `${agentId}:stop:${text}`;
    if (this.deps.activation) {
      await this.deps.activation.requestStop({
        commandId,
        requestedBy: { kind: 'user', id: 'owner' },
        scope: { kind: 'agent', agentId },
      });
      await this.deps.inbox.hold(agentId, 'agent_paused').catch(() => 0);
    }
    const runningId = this.deps.ledger.runningTurnOf(agentId);
    if (runningId) {
      const treeId = this.deps.ledger.getTurn(runningId)?.treeId;
      if (treeId) for (const job of this.deps.ledger.jobsOf(treeId)) job.abort();
    }
    return this.executeStop(agentId, { text, createdAt: Date.now() }, { notifyUser: true, options });
  }

  /** 上级停止令（dm 的 kind=stop）：同样保护用户回合；处理完回 stop-ack */
  async stopFromParent(
    agentId: string,
    stop: { text: string; createdAt: number; treeId?: string },
    replyTo: { agentId: string; name: string; treeId?: string },
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
    await this.executeStop(agentId, stop, { notifyUser: false, options: {}, replyTo }).catch(
      () => undefined,
    );
  }

  /** 回合结束时清空排队的停止令（在欠账续跑之前执行） */
  async processPendingStops(agentId: string): Promise<void> {
    const queue = this.pendingStops.get(agentId);
    if (!queue || queue.length === 0) return;
    this.pendingStops.set(agentId, []);
    for (const stop of queue) {
      const result = await this.executeStop(
        agentId,
        { text: stop.text, createdAt: stop.createdAt },
        { notifyUser: stop.notifyUser, options: stop.options, replyTo: stop.replyTo },
      ).catch(() => undefined);
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

  /** 用户新句作废未答选项卡：不当答案，也不留悬挂卡片 */
  voidPendingInteractions(agentId: string, emit?: AgentEventHandler): void {
    const pending = this.deps.broker.list({ agentId });
    for (const request of pending) {
      this.deps.broker.cancel(request.id);
      emit?.({ type: 'interaction_closed', id: request.id, answered: false });
    }
  }

  /**
   * 执行停止令（机械步骤，不经模型）：
   * 在停 → 砍早于本令的树 → dm 下发紧急件 / room 普通文本 → 等 stop-ack 或超时 → 停完了。
   * 上级的令（notifyUser=false）走同一套，只是不写自己的对话线、最后回 stop-ack。
   */
  private async executeStop(
    agentId: string,
    stop: { text: string; createdAt: number },
    opts: {
      notifyUser: boolean;
      options: SendOptions;
      replyTo?: { agentId: string; name: string; treeId?: string };
    },
  ): Promise<SendResult> {
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

    if (dmChildren.length > 0) {
      await this.awaitStopAcks(agentId, dmChildren, this.deps.stopAckTimeoutMs);
    }

    for (const tree of targets) {
      tree.status = 'cancelled';
      this.deps.ledger.putTree(tree);
    }
    await persist('停完了。');

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
      });
    }

    return {
      content: '停完了。',
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
    };
  }

  /** 等下级的 stop-ack；信箱里的 ack 由这里消费，不会进模型 */
  private async awaitStopAcks(
    agentId: string,
    expectedChildren: Array<{ agentId: string; treeId: string }>,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const expected = new Set(expectedChildren.map((child) => `${child.agentId}:${child.treeId}`));
    while (expected.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const taken = await this.deps.inbox
        .take(
          agentId,
          (item) => item.kind === 'stop-ack' && expected.has(`${item.fromAgentId}:${item.treeId ?? ''}`),
        )
        .catch(() => []);
      for (const item of taken) expected.delete(`${item.fromAgentId}:${item.treeId ?? ''}`);
    }
  }

  /** 停止词判定（配置词表 + 整句匹配） */
  isStopSentence(text: string): boolean {
    return isStopSentence(text, this.deps.stopWords.length > 0 ? this.deps.stopWords : DEFAULT_STOP_WORDS);
  }
}
