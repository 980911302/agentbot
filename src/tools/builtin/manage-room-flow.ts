import type { Tool, ToolContext } from '../tool.js';
import { ControlError } from '../../storage/runtime-control-store.js';
import type { RoomFlowService } from '../../server/runtime/room-flow-service.js';
import type { ActorRef } from '../../shared/contracts/room-flow.js';

export function createManageRoomFlowTool(flowService: RoomFlowService): Tool {
  return {
    name: 'ManageRoomFlow',
    description: [
      '受控群流程协调与控制工具。',
      '仅群流程协调者可用：创建流程、暂停、恢复、结束、分配行动等。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'pause', 'resume', 'cancel', 'status'],
          description: '流程控制动作',
        },
        room_id: { type: 'string', description: '群 ID' },
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
          description: '参与者列表',
        },
        reason: { type: 'string', description: '暂停或取消的原因' },
      },
      required: ['action'],
    },
    async execute(args, context: ToolContext) {
      const action = String(args.action);
      const agentId = context.agentId;

      if (action === 'start') {
        let roomId = String(args.room_id || context.room?.roomId || '').trim();
        if (context.room && (!roomId || roomId === context.room.roomName || roomId === 'current' || roomId === '本群')) {
          roomId = context.room.roomId;
        }
        if (!roomId) throw new ControlError('缺少 room_id', 'INVALID_ARGUMENT');
        const protocol = String(args.protocol || 'sequential_turn');
        const actors = (args.actors as ActorRef[]) || [];
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
        const updated = await flowService.pauseFlow(flowId, args.reason as string);
        return `流程 ${updated.id} 已暂停`;
      }

      if (action === 'resume') {
        const updated = await flowService.resumeFlow(flowId);
        return `流程 ${updated.id} 已恢复运行（当前版本：v${updated.version}）`;
      }

      if (action === 'cancel') {
        const updated = await flowService.cancelFlow(flowId, args.reason as string);
        return `流程 ${updated.id} 已取消，房间恢复开放模式`;
      }

      if (action === 'status') {
        return JSON.stringify({
          id: flow.id,
          roomId: flow.roomId,
          status: flow.status,
          phase: flow.phase,
          version: flow.version,
          currentActors: flow.currentActors,
        }, null, 2);
      }

      throw new ControlError(`不支持的动作：${action}`, 'INVALID_ACTION');
    },
  };
}
