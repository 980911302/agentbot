import type { RoomMessage } from '../../room/types.js';
import type { RoomStore } from '../../room/store.js';
import type { RoomFlowService } from './room-flow-service.js';
import type { StopCoordinator } from './stop-coordinator.js';

export type RoomWakePolicy =
  | { kind: 'none' }
  | { kind: 'agents'; agentIds: string[] }
  | { kind: 'open_fanout' };

export interface RouteResult {
  managed: boolean;
  handled: boolean;
  wakePolicy: RoomWakePolicy;
  flowId?: string;
}

export class RoomFlowRouter {
  constructor(
    private readonly deps: {
      rooms: RoomStore;
      flowService: RoomFlowService;
      stopCoordinator?: StopCoordinator;
      isStopSentence?: (text: string) => boolean;
    },
  ) {}

  async route(message: RoomMessage): Promise<RouteResult> {
    const room = await this.deps.rooms.get(message.roomId);
    if (!room || room.mode !== 'managed') {
      return { managed: false, handled: false, wakePolicy: { kind: 'open_fanout' } };
    }

    const flow = await this.deps.flowService.getActiveFlowForRoom(message.roomId);
    if (!flow) {
      // 自愈：房间模式为 managed 但已无活动流程，自动将房间恢复为 open 避免消息黑洞
      await this.deps.rooms.setMode(message.roomId, 'open');
      return { managed: false, handled: false, wakePolicy: { kind: 'open_fanout' } };
    }

    // 如果是用户发言
    if (message.senderKind === 'user') {
      const isStop = this.deps.stopCoordinator
        ? this.deps.stopCoordinator.isStopSentence(message.text)
        : (this.deps.isStopSentence ? this.deps.isStopSentence(message.text) : false);

      if (isStop) {
        await this.deps.flowService.pauseFlow(flow.id, 'USER_STOP_COMMAND');
        if (this.deps.stopCoordinator) {
          await this.deps.stopCoordinator.stopRoomFlow(message.roomId, flow.id, message.text);
        }
        return {
          managed: true,
          handled: true,
          wakePolicy: { kind: 'none' },
          flowId: flow.id,
        };
      }

      if (flow.status === 'paused') {
        const trimmed = message.text.trim();
        if (trimmed === '继续' || trimmed === '恢复' || trimmed.toLowerCase() === 'resume') {
          await this.deps.flowService.resumeFlow(flow.id);
          return {
            managed: true,
            handled: true,
            wakePolicy: { kind: 'none' },
            flowId: flow.id,
          };
        }
        return {
          managed: true,
          handled: true,
          wakePolicy: { kind: 'none' },
          flowId: flow.id,
        };
      }

      if (flow.status === 'awaiting_user') {
        const result = await this.deps.flowService.submitProposal({
          flowId: flow.id,
          actor: { kind: 'user', id: message.senderId || 'owner' },
          clientActionId: message.clientMessageId ?? message.id,
          content: { text: message.text },
          publicText: message.text,
          expectedVersion: flow.version,
          skipPublishTimeline: true,
          sourceMessageId: message.id,
        });

        return {
          managed: true,
          handled: result.status === 'accepted',
          wakePolicy: { kind: 'none' },
          flowId: flow.id,
        };
      }

      // 用户发言但流程当前轮到其他参与者：视为普通讨论/旁路消息，不直接修改受控状态，不扇出全员
      return {
        managed: true,
        handled: true,
        wakePolicy: { kind: 'none' },
        flowId: flow.id,
      };
    }

    // 智能体或系统消息：受控模式下由流程服务显式调度，不触发 open_fanout
    return {
      managed: true,
      handled: true,
      wakePolicy: { kind: 'none' },
      flowId: flow.id,
    };
  }
}
