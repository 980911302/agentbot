import { RoomFlowService } from '../server/runtime/room-flow-service.js';
import { RoomFlowScheduler } from '../server/runtime/room-flow-scheduler.js';
import { RoomFlowRouter } from '../server/runtime/room-flow-router.js';
import { toRoomFlowView } from '../server/presenters.js';
import { Workbench } from '../workbench/service.js';
import { InteractionBroker } from '../interaction/broker.js';
import { SecretStore } from '../secret/store.js';
import { ModelConfigStore } from '../storage/model-config-store.js';
import { DEFAULT_STOP_WORDS, isStopSentence } from '../config.js';
import { ContextBuilder } from '../context/builder.js';
import { CompactionStore, Compactor } from '../memory/compact.js';
import { MemoryExtractor } from '../memory/extract.js';
import { StopCoordinator } from '../server/runtime/stop-coordinator.js';
import { InboxProcessor } from '../server/runtime/inbox-processor.js';
import { RoomDispatcher } from '../server/runtime/room-dispatcher.js';
import type { AgentRuntimeOptions } from '../server/runtime/types.js';
import type { createRuntimeStorage } from './storage-layer.js';
import type { RuntimeHost, RuntimeSharedState } from './host.js';

/** 智能体互传的链深度上限：工具自己判超限，装配这里只给默认值 */
export const DEFAULT_MAX_AGENT_DEPTH = 3;

/**
 * 协作服务层装配（OPT-03）：群流程、停止/许可、工作台、群扇出与来信消费的唯一 new 处。
 *
 * 依赖上一层的存储账本与门面回调（RuntimeHost）；工具面与回合执行在下一层。
 * `inboxScheduler` 要等执行层建好，所以这里对它的引用一律走 host.watchInbox。
 */
export function createRuntimeServices(
  options: AgentRuntimeOptions,
  host: RuntimeHost,
  shared: RuntimeSharedState,
  store: ReturnType<typeof createRuntimeStorage>,
) {
  const { events, locks, pendingStops } = shared;
  const {
    registry,
    control,
    activation,
    effects,
    messages,
    works,
    waits,
    delegations,
    memory,
    compaction,
    rooms,
    inbox,
    ledger,
    chatRuns,
    taskProgress,
    roomFlowStore,
    protocolRegistry,
  } = store;

  const roomFlowService = new RoomFlowService({
    store: roomFlowStore,
    rooms,
    protocols: protocolRegistry,
    resolveAgentName: async (agentId) => (await registry.get(agentId))?.name,
    publishTimelineMessage: async (msg) => {
      await rooms.appendIfAbsent(msg);
      events.publish({
        kind: 'room',
        roomId: msg.roomId,
        payload: { type: 'room_message', message: msg },
      });
    },
    onGrantReady: async (flow, grant) => {
      await roomFlowScheduler.scheduleGrant(flow, grant);
    },
    onFlowUpdated: (flow) => {
      events.publish({
        kind: 'room',
        roomId: flow.roomId,
        payload: { type: 'flow_updated', flow: toRoomFlowView(flow) },
      });
    },
  });
  const roomFlowScheduler = new RoomFlowScheduler({
    inbox,
    flowService: roomFlowService,
    drainInbox: (agentId) => host.watchInbox(agentId),
  });
  const broker = options.broker ?? new InteractionBroker();
  const secrets = options.secrets ?? new SecretStore(options.dataDir);
  const modelConfigStore = options.modelConfigStore ?? new ModelConfigStore(options.dataDir);
  const stopCoordinator = new StopCoordinator({
    registry,
    messages,
    inbox,
    rooms,
    broker,
    ledger,
    pendingStops,
    stopWords: options.stopWords ?? DEFAULT_STOP_WORDS,
    stopAckTimeoutMs: options.stopAckTimeoutMs ?? 30_000,
    activation,
    effects,
    // E4.4：精确停止读委派账本；子工作随委派停、等待随委派作废
    delegations,
    cancelWork: async (workId, reason) => {
      await works.close(workId, 'cancelled', reason).catch((error) => {
        // 已经收尾的工作不重复关（幂等）；其它错误记一笔即可，不拦停止
        if (!String(messageOf(error)).includes('已经结束')) {
          console.warn(`停止时关工作失败（${workId}）：${messageOf(error)}`);
        }
      });
    },
    onDelegationCancelled: async (delegation) => {
      await waits.cancelByThread(delegation.id, '这条委派已被停止');
    },
    // 迟到的 stop-ack 把 needs_attention 更新掉（设计 §7.1）
    onStopAcksSettled: async (stopId, remaining) => {
      if (!stopId) return;
      await activation
        .settleStop(stopId, remaining.length > 0 ? 'needs_attention' : 'settled', remaining)
        .catch(() => undefined);
    },
  });

  const roomFlowRouter = new RoomFlowRouter({
    rooms,
    flowService: roomFlowService,
    stopCoordinator,
    isStopSentence: (text) => isStopSentence(text, options.stopWords ?? DEFAULT_STOP_WORDS),
  });
  const builder = new ContextBuilder(messages, options.budget);
  const compactor = new Compactor(
    messages,
    compaction,
    options.budget.compactionTrigger,
    options.budget.reserveRecent,
  );
  const extractor = new MemoryExtractor(memory, options.memoryExtraction);

  // 工作台：智能体在对话里替用户改工作台（建同事、建群、拉人、代群发言）
  const workbench = new Workbench({
    registry,
    rooms,
    messages,
    // 新建同事务必登记 enabled，否则重启后会被迁移逻辑当成旧智能体暂停
    enrollAgent: (agentId) => host.enrollAgent(agentId),
    postToRoom: async (roomId, text, excludeAgentIds, agentChainDepth, signal, callerId) => {
      if (!callerId) throw new Error('代群发言缺少真实发送者');
      const summary = await roomDispatcher.enqueueMessage(roomId, text, {
        excludeAgentIds,
        agentChainDepth,
        signal,
        roomSenderId: callerId,
        onRoomEvent: (payload) => events.publish({ kind: 'room', roomId, payload }),
      });
      for (const member of (await rooms.get(roomId))?.memberIds ?? [])
        if (member !== callerId) host.watchInbox(member);
      return { roomName: summary.roomName, roundId: summary.roundId };
    },
  });

  const roomDispatcher = new RoomDispatcher({
    registry,
    rooms,
    messages,
    inbox,
    locks,
    membersOf: (roomId) => host.membersOf(roomId),
    ownerNameFallback: () => host.ownerName(),
    stopWords: options.stopWords ?? DEFAULT_STOP_WORDS,
    runTurn: (agentId, task, turn, turnOptions) => host.runTurn(agentId, task, turn, turnOptions),
    // 只通知调度器，绝不沿发送方的栈递归执行收件人。
    drainInbox: (agentId) => host.watchInbox(agentId),
    router: roomFlowRouter,
  });

  const inboxProcessor = new InboxProcessor({
    inbox,
    registry,
    maxAgentChainDepth: options.maxAgentChainDepth ?? DEFAULT_MAX_AGENT_DEPTH,
    stopCoordinator,
    // stop-ack 由这里确认并登记给等待中的停止令，不再靠 take 去信箱里抢
    onStopAck: (agentId, item) =>
      stopCoordinator.noteStopAck(agentId, item.fromAgentId, item.treeId, {
        ...(item.cancelId ? { cancelId: item.cancelId } : {}),
        ...(item.childWorkId ? { childWorkId: item.childWorkId } : {}),
        ...(item.correlationId ? { correlationId: item.correlationId } : {}),
      }),
    // 同事回信已确认处理：按线程键精确解决「等这位同事回信」的等待（E4.3/E4.4）
    onLettersHandled: async (agentId, letters) => {
      for (const letter of letters) {
        await host.resolveAgentWaitsForReply(
          agentId,
          letter.fromAgentId,
          `letter:${letter.id}`,
          letter.correlationId,
        );
      }
    },
    // 这封信是不是某个等待的唤醒事件：是就把那份工作写进本轮 brief
    workBriefForLetter: (agentId, fromAgentId, correlationId) =>
      host.workBriefForPeerReply(agentId, fromAgentId, correlationId),
    // 这封信是一条委派：收件方为它开一件工作并回填 childWorkId（E4.4）
    acceptDelegation: (agentId, letter) => host.acceptDelegationLetter(agentId, letter),
    runTurn: (agentId, task, turn, turnOptions) =>
      host.runTurn(agentId, task, { extraTools: [], ...turn }, turnOptions),
    // 排队的群回合：事件按 roomId 归属（前端据此路由到群频道）
    deliverRoom: async (item, turnOptions) => {
      const roomId = item.room?.roomId ?? '';
      const { run } = await chatRuns.prepare({
        channelId: roomId,
        roomId,
        kind: 'room',
        source: 'room',
        input: item.text,
        messageId: item.checkpoint?.messageId,
      });
      const scoped = chatRuns.bind(run, turnOptions);
      return chatRuns.execute(
        run.runId,
        () => roomDispatcher.deliverQueued(item, scoped),
        (result) => {
          if (result.status === 'error') throw new Error(result.note ?? '延迟群回合执行失败');
          return {};
        },
      );
    },
    archiveLetter: (item) => host.archiveLetter(item),
    admit: async (item) => {
      const decision = await activation.tryActivate({
        agentId: item.toAgentId,
        runId: item.id,
        taskId: item.id,
        inputId: item.id,
        chainId: item.chainId ?? item.correlationId ?? item.id,
        source: item.kind === 'room' ? 'room' : 'inbox',
        disposition: item.disposition,
        lease:
          item.leaseOwner && item.leaseEpoch !== undefined
            ? { deliveryId: item.id, ownerId: item.leaseOwner, epoch: item.leaseEpoch }
            : undefined,
        flowId: item.flowId,
        flowGrantId: item.grantId,
        replyRoute: item.replyRoute,
      });
      if (decision.kind === 'admitted') {
        await activation.markRunning(decision.ticket);
      }
      return decision;
    },
    settleTicket: (ticketId) => activation.settleTicket(ticketId),
    canRetry: async (agentId, messageId) => {
      const all = chatRuns.list();
      const ids = new Set(
        all
          .filter((run) => run.messageId === messageId && (!run.agentId || run.agentId === agentId))
          .map((run) => run.runId),
      );
      for (let size = -1; size !== ids.size;) {
        size = ids.size;
        for (const run of all) if (run.parentRunId && ids.has(run.parentRunId)) ids.add(run.runId);
      }
      const runs = all.filter((run) => ids.has(run.runId) && run.agentId === agentId);
      // 只有"查得到运行、而且其中真有人动过手"才判不可重试。
      // 查不到记录（运行账本按 1000 条上限裁掉、任务进度按 500 条裁掉、或换了进程）
      // 时无法证明有副作用，不能据此把信判死——那会让长期实例在清理后永久丢信。
      if (runs.length === 0) return true;
      return runs.every((run) => {
        const progress = taskProgress.get(run.runId, agentId);
        return progress === undefined || progress.mayHaveSideEffects === false;
      });
    },
    leaseMs: options.deliveryLeaseMs,
    maxAttempts: options.deliveryMaxAttempts,
    baseDelayMs: options.deliveryBaseDelayMs,
  });


  return {
    roomFlowService,
    roomFlowScheduler,
    stopCoordinator,
    broker,
    secrets,
    modelConfigStore,
    builder,
    compactor,
    extractor,
    roomFlowRouter,
    workbench,
    roomDispatcher,
    inboxProcessor,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
