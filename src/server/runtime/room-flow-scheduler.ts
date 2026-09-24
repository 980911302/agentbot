import type { AgentInbox } from '../../agent/inbox.js';
import type { FlowBriefContext, RoomActionGrant, RoomFlow } from '../../shared/contracts/room-flow.js';
import { renderFlowBrief } from '../../context/flow-brief.js';
import type { RoomFlowService } from './room-flow-service.js';

export interface RoomFlowSchedulerDeps {
  inbox: AgentInbox;
  flowService: RoomFlowService;
  drainInbox: (agentId: string) => void;
}

export class RoomFlowScheduler {
  constructor(private readonly deps: RoomFlowSchedulerDeps) {}

  async scheduleGrant(flow: RoomFlow, grant: RoomActionGrant): Promise<void> {
    if (grant.actor.kind !== 'agent') return;

    const briefContext: FlowBriefContext | undefined = await this.deps.flowService.getBriefForActor(
      flow.id,
      grant.actor,
    );

    const briefText = briefContext ? renderFlowBrief(briefContext) : '请在受控群流程中提交你的候选行动。';
    const taskText = `${briefText}\n\n当前轮到你行动。请组织回复并通过 SendToUser(to:"room", content:"...") 提交候选行动。`;

    await this.deps.inbox.enqueue({
      toAgentId: grant.actor.id,
      fromAgentId: flow.coordinatorId,
      fromName: '流程协调者',
      text: taskText,
      priority: true,
      depth: 0,
      chainId: flow.chainId,
      flowId: flow.id,
      grantId: grant.id,
      replyRoute: grant.replyRoute,
      kind: 'message',
    });

    // 异步通知调度器消费，不阻塞当前调用者
    this.deps.drainInbox(grant.actor.id);
  }
}
