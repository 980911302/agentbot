import { defineTool, type Tool } from '../tool.js';
import { ControlError } from '../../storage/runtime-control-store.js';
import type { RoomFlowService } from '../../server/runtime/room-flow-service.js';
import type { ActorRef } from '../../shared/contracts/room-flow.js';

export interface ManageRoomFlowArgs {
  action: 'start' | 'pause' | 'resume' | 'cancel' | 'status';
  room_id?: string;
  flow_id?: string;
  protocol?: string;
  actors?: ActorRef[];
  reason?: string;
}

/**
 * OPT-08：和其它工具一样走 defineTool —— schema 过 boundedSchema（字符串/数组上限、
 * additionalProperties:false）、参数在执行前校验、结果按 limitsFor 收敛。
 * 恢复分类见 src/tools/policy.ts（控制面动作，结果未知时不自动重做）。
 */
export function createManageRoomFlowTool(flowService: RoomFlowService): Tool<ManageRoomFlowArgs> {
  return defineTool<ManageRoomFlowArgs>({
    name: 'ManageRoomFlow',
    description: [
      '受控群流程协调与控制工具：创建（start）、暂停（pause）、恢复（resume）、结束（cancel）、查状态（status）。',
      'start 需要群内成员身份（创建者即该流程的协调者）；pause/resume/cancel/status 仅该流程的协调者可用。',
      '没有「分配行动 / 提交候选行动」这类动作——行动权由流程协议自己推进。',
      'room_id 只在 start 时用来指定群；其余动作按当前群或 flow_id 定位。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'pause', 'resume', 'cancel', 'status'],
          description: '流程控制动作',
        },
        room_id: { type: 'string', description: '群 ID（仅 action=start 使用）' },
        flow_id: { type: 'string', description: '流程 ID（pause/resume/cancel/status 时使用）' },
        protocol: { type: 'string', description: 'action=start 时的协议名称，如 sequential_turn' },
        actors: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['user', 'agent'] },
              id: { type: 'string' },
            },
            required: ['kind', 'id'],
          },
          description: '参与者列表（仅 action=start 使用）',
        },
        reason: { type: 'string', description: '暂停或取消的原因' },
      },
      required: ['action'],
    },
    async execute(args, context) {
      const action = String(args.action);
      const agentId = context.agentId;

      if (action === 'start') {
        let roomId = String(args.room_id || context.room?.roomId || '').trim();
        if (
          context.room &&
          (!roomId || roomId === context.room.roomName || roomId === 'current' || roomId === '本群')
        ) {
          roomId = context.room.roomId;
        }
        if (!roomId) throw new ControlError('缺少 room_id', 'INVALID_ARGUMENT');
        const protocol = String(args.protocol || 'sequential_turn');
        const actors = args.actors ?? [];
        if (actors.length === 0) {
          throw new ControlError('启动流程必须指定至少 1 个参与者', 'INVALID_ARGUMENT');
        }

        const flow = await flowService.startFlow({
          roomId,
          coordinatorId: agentId,
          protocolId: protocol,
          actors,
          rootCommandId: context.authorization?.inputId ?? agentId,
          chainId: context.authorization?.chainId ?? agentId,
        });

        return `受控群流程已创建：${flow.id}（协议：${flow.protocol}，状态：${flow.status}）`;
      }

      let flowId = String(args.flow_id || '').trim();
      if (!flowId && context.room?.roomId) {
        const active = await flowService.getActiveFlowForRoom(context.room.roomId);
        if (active) flowId = active.id;
      }
      if (!flowId) throw new ControlError('此操作需要提供 flow_id', 'INVALID_ARGUMENT');

      const flow = await flowService.getFlow(flowId);
      if (!flow) throw new ControlError(`流程未找到：${flowId}`, 'NOT_FOUND');

      if (flow.coordinatorId !== agentId) {
        throw new ControlError('只有该流程的协调者才拥有控制权限', 'PERMISSION_DENIED');
      }

      if (action === 'pause') {
        if (flow.status !== 'active') return `流程 ${flow.id} 当前是 ${flow.status}，无需暂停。`;
        const updated = await flowService.pauseFlow(flowId, args.reason);
        return updated.status === 'paused'
          ? `流程 ${updated.id} 已暂停`
          : `流程 ${updated.id} 当前是 ${updated.status}，无需暂停。`;
      }

      if (action === 'resume') {
        if (flow.status !== 'paused') return `流程 ${flow.id} 当前是 ${flow.status}，无需恢复。`;
        const updated = await flowService.resumeFlow(flowId);
        return updated.status === 'active'
          ? `流程 ${updated.id} 已恢复运行（当前版本：v${updated.version}）`
          : `流程 ${updated.id} 当前是 ${updated.status}，没能恢复。`;
      }

      if (action === 'cancel') {
        const updated = await flowService.cancelFlow(flowId, args.reason);
        return `流程 ${updated.id} 已取消，房间恢复开放模式`;
      }

      if (action === 'status') {
        return JSON.stringify(
          {
            id: flow.id,
            roomId: flow.roomId,
            status: flow.status,
            phase: flow.phase,
            version: flow.version,
            currentActors: flow.currentActors,
          },
          null,
          2,
        );
      }

      throw new ControlError(`不支持的动作：${action}`, 'INVALID_ACTION');
    },
  });
}
