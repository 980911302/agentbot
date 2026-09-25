import { randomUUID } from 'node:crypto';
import { isActiveChatRun } from '../../shared/contracts/chat-state.js';
import type { RoomFlow } from '../../shared/contracts/room-flow.js';
import type { RoomFlowService } from './room-flow-service.js';
import type { RoomFlowStore } from '../../storage/room-flow-store.js';
import type { ChatRunCoordinator } from './chat-run-coordinator.js';
import type { RoomDispatcher } from './room-dispatcher.js';
import type { StopCoordinator } from './stop-coordinator.js';
import type { ActivationCoordinator } from './activation-coordinator.js';
import type { RoomStore } from '../../room/store.js';
import type { EventJournal } from '../events/journal.js';
import type { RuntimeHost } from './host.js';
import type { RoomRoundSummary, SendOptions } from './types.js';
import type { AcceptedRun } from './types.js';

/**
 * 群收发与群流程门面（OPT-03 从 runtime.ts 搬出）。
 *
 * 用户往群里发言的持久受理（先写时间线与收件箱再回 202）与受控群流程的
 * 查询/暂停/恢复/取消入口。扇出本体在 RoomDispatcher，流程状态机在 RoomFlowService，
 * 这里只做受理编排与门面转发。
 */
export function createRoomGateway(
  host: RuntimeHost,
  deps: {
    chatRuns: ChatRunCoordinator;
    rooms: RoomStore;
    roomFlowService: RoomFlowService;
    roomFlowStore: RoomFlowStore;
    roomDispatcher: RoomDispatcher;
    stopCoordinator: StopCoordinator;
    activation: ActivationCoordinator;
    events: EventJournal;
  },
) {
  const { chatRuns, rooms, roomFlowService, roomFlowStore, roomDispatcher, stopCoordinator, activation, events } = deps;
  const membersOf = (roomId: string) => host.membersOf(roomId);
  const watchInbox = (agentId: string) => host.watchInbox(agentId);

  // ── 群回合：扇出叫醒（搬至 RoomDispatcher，此处保持兼容入口）──

  /**
   * 用户往房间发一条 → 扇出给全体成员（三波次见 RoomDispatcher）。
   * `@` 是强信号不是投递开关：没被点名的一样进这一轮，只是不强制开口。
   */
  async function postToRoom(roomId: string, text: string, options: SendOptions = {}): Promise<RoomRoundSummary> {
    // 进程内兼容接口仍可等待三波结果；HTTP 与模型工具不使用这条等待路径。
    const accepted = await acceptRoomMessage(roomId, text, options, true);
    return accepted.execute();
  }

  /**
   * HTTP 收信：先持久写时间线和收件箱，再回 202；execute 仅通知调度器。
   * 群消息的 messageId 由 room_message 事件带回来（客户端按内容/幂等键校正占位）。
   */
  async function acceptRoomMessage(
    roomId: string,
    text: string,
    options: SendOptions = {},
    waitForRounds = false,
  ): Promise<AcceptedRun<RoomRoundSummary>> {
    return chatRuns.accept(`room:${roomId}:${options.clientMessageId ?? randomUUID()}`, async () => {
      const { room, members } = await membersOf(roomId);
      if (!room || members.length === 0) throw new Error('房间不存在或没有成员');
      if (stopCoordinator.isStopSentence(text)) {
        const activeFlow = await roomFlowService.getActiveFlowForRoom(roomId);
        if (activeFlow) {
          await stopCoordinator.stopRoomFlow(roomId, activeFlow.id, text);
          await roomFlowService.pauseFlow(activeFlow.id, 'USER_STOP_COMMAND');
        }
      }
      const { run, duplicate } = await chatRuns.prepare(
        {
          channelId: roomId,
          roomId,
          kind: 'room',
          source: options.roomSenderId ? 'agent' : 'user',
          input: text,
          clientMessageId: options.clientMessageId,
          messageId: randomUUID(),
        },
        [
          options.model ?? '',
          options.ownerName ?? host.ownerName(),
          options.excludeAgentIds ?? [],
          options.roomSenderId ?? '',
        ],
      );

      // §6.2：用户新的群发言为受众签发新链许可。没有它，停止后的成员在这一轮
      // 全部判定 held，于是「私聊说一次停 → 群里再也不响应」。
      // 工作台代发（roomSenderId）不是用户命令，不签发；停止词更不签发。
      let chainId: string | undefined;
      if (!options.roomSenderId && !duplicate && !stopCoordinator.isStopSentence(text)) {
        const excluded = new Set(options.excludeAgentIds ?? []);
        const audience = members.map((member) => member.id).filter((id) => !excluded.has(id));
        if (audience.length > 0) {
          chainId = (
            await activation.acceptRoomInput({
              commandId: options.clientMessageId ?? run.runId,
              agentIds: audience,
            })
          ).chainId;
        }
      }

      const opts = chatRuns.bind(run, {
        ...options,
        messageId: run.messageId,
        ...(chainId ? { chainId } : {}),
      });
      const queued =
        !waitForRounds && !duplicate
          ? await chatRuns.execute(
              run.runId,
              () => roomDispatcher.enqueueMessage(roomId, text, opts),
              () => ({}),
            )
          : { roundId: run.runId, roomId, roomName: room.name, outcomes: [], queued: [] };
      return {
        receipt: {
          roomId,
          runId: run.runId,
          taskId: run.taskId,
          run: chatRuns.get(run.runId)!,
          messageId: run.messageId,
          receiptSeq: events.latestSeq,
          duplicate,
        },
        execute: () => {
          if (!waitForRounds) {
            for (const member of members) watchInbox(member.id);
            return Promise.resolve(queued);
          }
          return !isActiveChatRun(chatRuns.get(run.runId)!)
            ? Promise.resolve({ roundId: run.runId, roomId, roomName: room.name, outcomes: [], queued: [] })
            : chatRuns.execute(
                run.runId,
                () => roomDispatcher.postToRoom(roomId, text, opts),
                () => ({}),
              );
        },
      };
    });
  }

  function getActiveRoomFlow(roomId: string): Promise<RoomFlow | undefined> {
    return roomFlowService.getActiveFlowForRoom(roomId);
  }

  function getRoomFlow(flowId: string): Promise<RoomFlow | undefined> {
    return roomFlowService.getFlow(flowId);
  }

  async function pauseRoomFlow(flowId: string, reason?: string): Promise<RoomFlow> {
    const flow = await roomFlowService.pauseFlow(flowId, reason);
    await stopCoordinator.stopRoomFlow(flow.roomId, flowId, reason ?? 'pause');
    return flow;
  }

  function resumeRoomFlow(flowId: string): Promise<RoomFlow> {
    return roomFlowService.resumeFlow(flowId);
  }

  async function cancelRoomFlow(flowId: string, reason?: string): Promise<RoomFlow> {
    const flow = await roomFlowService.cancelFlow(flowId, reason);
    await stopCoordinator.stopRoomFlow(flow.roomId, flowId, reason ?? 'cancel');
    return flow;
  }

  function listRoomFlows(roomId?: string): Promise<RoomFlow[]> {
    return roomFlowStore.listFlows(roomId);
  }

  return {
    postToRoom,
    acceptRoomMessage,
    getActiveRoomFlow,
    getRoomFlow,
    pauseRoomFlow,
    resumeRoomFlow,
    cancelRoomFlow,
    listRoomFlows,
  };
}
