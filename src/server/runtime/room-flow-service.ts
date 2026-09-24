import { randomUUID } from 'node:crypto';
import type { RoomStore } from '../../room/store.js';
import type { RoomMessage } from '../../room/types.js';
import type {
  ActorRef,
  FlowBriefContext,
  RoomActionGrant,
  RoomActionProposal,
  RoomFlow,
  RoomFlowBudget,
  RoomReplyRoute,
} from '../../shared/contracts/room-flow.js';
import {
  DEFAULT_ROOM_FLOW_BUDGET,
  createSignedReplyRoute,
  verifyReplyRouteSignature,
} from '../../shared/contracts/room-flow.js';
import { FlowConflictError, type RoomFlowStore } from '../../storage/room-flow-store.js';
import type { ProtocolRegistry } from './room-flow-protocols.js';

export interface RoomFlowServiceDeps {
  store: RoomFlowStore;
  rooms: RoomStore;
  protocols: ProtocolRegistry;
  signingSecret?: string;
  publishTimelineMessage?: (message: RoomMessage) => Promise<void>;
  onGrantReady?: (flow: RoomFlow, grant: RoomActionGrant) => Promise<void> | void;
  resolveAgentName?: (agentId: string) => Promise<string | undefined> | string | undefined;
  onFlowUpdated?: (flow: RoomFlow) => Promise<void> | void;
}

export class RoomFlowService {
  private readonly secret: string;

  constructor(private readonly deps: RoomFlowServiceDeps) {
    this.secret = deps.signingSecret ?? deps.store.getOrCreateSigningSecretSync();
  }

  async flushOutbox(flowId: string): Promise<void> {
    const pending = await this.deps.store.listPendingOutbox(flowId);
    for (const item of pending) {
      try {
        if (item.kind === 'timeline_message') {
          if (this.deps.publishTimelineMessage) {
            await this.deps.publishTimelineMessage({
              id: item.payload.messageId,
              roomId: item.payload.roomId,
              roundId: item.payload.roundId,
              senderKind: item.payload.senderKind,
              senderId: item.payload.senderId,
              senderName: item.payload.senderName,
              text: item.payload.text,
              mentions: [],
              everyone: false,
              createdAt: Date.parse(item.createdAt) || Date.now(),
            });
          }
        } else if (item.kind === 'grant_ready') {
          const flow = await this.getFlow(item.flowId);
          if (flow) {
            await this.deps.onGrantReady?.(flow, item.payload.grant);
          }
        } else if (item.kind === 'flow_updated') {
          await this.deps.onFlowUpdated?.(item.payload.flow);
        }
        await this.deps.store.markOutboxDispatched(flowId, item.id);
      } catch (err) {
        console.error(`[RoomFlowService] Failed to dispatch outbox item ${item.id}:`, err);
        break;
      }
    }
  }

  async recoverOutbox(): Promise<void> {
    const allPending = await this.deps.store.listAllPendingOutbox();
    const flowIds = [...new Set(allPending.map((p) => p.flowId))];
    for (const flowId of flowIds) {
      await this.flushOutbox(flowId);
    }
  }

  private async resolveSenderName(actor: ActorRef): Promise<string> {
    if (actor.kind === 'user') return '主人';
    const name = await this.deps.resolveAgentName?.(actor.id);
    return name ?? actor.id;
  }

  verifyReplyRoute(route: RoomReplyRoute): boolean {
    return verifyReplyRouteSignature(this.secret, route);
  }

  async getFlow(flowId: string): Promise<RoomFlow | undefined> {
    return this.deps.store.getFlow(flowId);
  }

  async getActiveFlowForRoom(roomId: string): Promise<RoomFlow | undefined> {
    const direct = await this.deps.store.getActiveFlowForRoom(roomId);
    if (direct) return direct;
    const allRooms = await this.deps.rooms.list().catch(() => []);
    const matched = allRooms.find((r) => r.name === roomId);
    if (matched) {
      return this.deps.store.getActiveFlowForRoom(matched.id);
    }
    return undefined;
  }

  async startFlow(input: {
    roomId: string;
    coordinatorId: string;
    protocolId?: string;
    protocol?: string;
    actors?: ActorRef[];
    participants?: ActorRef[];
    rootCommandId?: string;
    chainId?: string;
    maxTransitions?: number;
    budget?: Partial<RoomFlowBudget>;
    options?: Record<string, unknown>;
  }): Promise<RoomFlow> {
    let room = await this.deps.rooms.get(input.roomId);
    if (!room) {
      const allRooms = await this.deps.rooms.list().catch(() => []);
      room = allRooms.find((r) => r.name === input.roomId || r.id === input.roomId);
    }
    if (!room) {
      throw new FlowConflictError(`房间不存在：${input.roomId}`, 'ROOM_NOT_FOUND');
    }
    const roomId = room.id;

    const existing = await this.deps.store.getActiveFlowForRoom(roomId);
    if (existing) {
      throw new FlowConflictError(`房间 ${input.roomId} 已存在活动流程 ${existing.id}`, 'ROOM_ALREADY_MANAGED');
    }

    const protoId = input.protocolId ?? input.protocol ?? '';
    const protocol = this.deps.protocols.get(protoId);
    if (!protocol) {
      throw new FlowConflictError(`未找到协议：${protoId}`, 'PROTOCOL_NOT_FOUND');
    }

    if (!room.memberIds.includes(input.coordinatorId)) {
      throw new FlowConflictError(`协调者 ${input.coordinatorId} 不是房间 ${input.roomId} 的成员`, 'COORDINATOR_NOT_IN_ROOM');
    }

    const actorsList = input.actors ?? input.participants ?? [];
    const resolvedActors: ActorRef[] = [];
    for (const actor of actorsList) {
      if (actor.kind === 'agent') {
        if (room.memberIds.includes(actor.id)) {
          resolvedActors.push(actor);
        } else {
          let foundId: string | undefined;
          for (const memberId of room.memberIds) {
            const name = await this.deps.resolveAgentName?.(memberId);
            if (name && (name === actor.id || name.toLowerCase() === actor.id.toLowerCase())) {
              foundId = memberId;
              break;
            }
          }
          if (foundId) {
            resolvedActors.push({ kind: 'agent', id: foundId });
          } else {
            throw new FlowConflictError(`智能体参与者 ${actor.id} 不是房间 ${input.roomId} 的成员`, 'ACTOR_NOT_IN_ROOM');
          }
        }
      } else if (actor.kind === 'user') {
        resolvedActors.push({ kind: 'user', id: 'owner' });
      } else {
        resolvedActors.push(actor);
      }
    }

    const flowId = randomUUID();
    const now = new Date().toISOString();
    const budget: RoomFlowBudget = {
      ...DEFAULT_ROOM_FLOW_BUDGET,
      ...(input.budget ?? {}),
      ...(input.maxTransitions ? { maxTransitions: input.maxTransitions } : {}),
    };

    const rootCmdId = input.rootCommandId ?? randomUUID();
    const cId = input.chainId ?? randomUUID();

    const initialState = protocol.initialState({
      actors: resolvedActors,
      options: input.options,
    });

    const next = protocol.next(initialState);
    const initialStatus = next.kind === 'await_user' ? 'awaiting_user' : 'active';
    const initialActors = next.kind === 'continue' ? next.actors : next.kind === 'await_user' ? [{ kind: 'user', id: 'owner' } as ActorRef] : [];

    const flow: RoomFlow = {
      id: flowId,
      roomId,
      coordinatorId: input.coordinatorId,
      protocol: protoId,
      status: initialStatus,
      phase: next.kind === 'continue' || next.kind === 'await_user' ? next.phase ?? 'init' : 'init',
      version: 1,
      currentActors: initialActors,
      stateRef: `room-flows/${flowId}/state.json`,
      rootCommandId: rootCmdId,
      chainId: cId,
      transitionCount: 0,
      maxTransitions: budget.maxTransitions,
      budget,
      activeGrantIds: [],
      createdAt: now,
      updatedAt: now,
      metadata: input.options,
    };

    const initialGrants: Record<string, RoomActionGrant> = {};
    const initialOutbox: Array<import('../../storage/room-flow-store.js').FlowOutboxItem extends infer T ? (T extends any ? Omit<T, 'id' | 'createdAt'> : never) : never> = [];

    if (next.kind === 'continue') {
      for (const actor of next.actors) {
        const grantId = randomUUID();
        const route = createSignedReplyRoute(this.secret, {
          kind: 'room_flow',
          roomId: input.roomId,
          flowId,
          grantId,
          mode: 'proposal',
        });
        const grant: RoomActionGrant = {
          id: grantId,
          flowId,
          roomId: input.roomId,
          actor,
          issuedBy: input.coordinatorId,
          expectedVersion: flow.version,
          purpose: next.purpose ?? 'act',
          replyRoute: route,
          publishPolicy: 'proposal',
          state: 'active',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        };
        initialGrants[grantId] = grant;
        flow.activeGrantIds.push(grantId);
        if (actor.kind === 'agent') {
          initialOutbox.push({
            flowId,
            kind: 'grant_ready',
            payload: { grant },
          });
        }
      }
    }

    initialOutbox.push({
      flowId,
      kind: 'flow_updated',
      payload: { flow },
    });

    await this.deps.store.createFlow(flow, initialState, initialGrants, initialOutbox as any);
    await this.deps.rooms.setMode(input.roomId, 'managed', flowId);

    // 事务落盘后调度 Outbox
    await this.flushOutbox(flowId);

    return flow;
  }

  async submitProposal(input: {
    flowId: string;
    grantId?: string;
    actor: ActorRef;
    clientActionId: string;
    content: unknown;
    publicText?: string;
    expectedVersion: number;
    skipPublishTimeline?: boolean;
    sourceMessageId?: string;
  }): Promise<{
    status: 'accepted' | 'rejected' | 'stale';
    reason?: string;
    flow: RoomFlow;
    committedMessageId?: string;
    duplicated?: boolean;
  }> {
    // 幂等校验：相同的 clientActionId 且已 accepted 直接返回
    const proposals = await this.deps.store.listProposals(input.flowId);
    const existingAccepted = proposals.find(
      (p) => p.clientActionId === input.clientActionId && p.status === 'accepted',
    );
    if (existingAccepted) {
      const currentFlow = (await this.getFlow(input.flowId))!;
      return {
        status: 'accepted',
        flow: currentFlow,
        committedMessageId: existingAccepted.committedMessageId,
        duplicated: true,
      };
    }

    let shouldResetRoomMode = false;
    let targetRoomId = '';

    const res = await this.deps.store.transact(input.flowId, async (context) => {
      const { flow, state, grants } = context;
      targetRoomId = flow.roomId;

      if (flow.status !== 'active' && flow.status !== 'awaiting_user') {
        const proposal: RoomActionProposal = {
          id: randomUUID(),
          flowId: flow.id,
          grantId: input.grantId ?? '',
          actor: input.actor,
          expectedVersion: input.expectedVersion,
          clientActionId: input.clientActionId,
          content: input.content,
          publicText: input.publicText,
          status: 'rejected',
          rejectionReason: `流程当前状态为 ${flow.status}，已停止接受行动`,
          createdAt: new Date().toISOString(),
        };
        await this.deps.store.appendProposal(flow.id, proposal);
        return { status: 'rejected' as const, reason: proposal.rejectionReason, flow };
      }

      // 授权校验：不变量 2
      let grant: RoomActionGrant | undefined;
      if (input.grantId) {
        grant = grants[input.grantId];
        if (!grant) {
          return { status: 'rejected' as const, reason: `未找到授权票据：${input.grantId}`, flow };
        }
        if (grant.state !== 'active') {
          return { status: 'rejected' as const, reason: `授权票据已失效：${grant.state}`, flow };
        }
        if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) {
          grant.state = 'expired';
          const proposal: RoomActionProposal = {
            id: randomUUID(),
            flowId: flow.id,
            grantId: input.grantId,
            actor: input.actor,
            expectedVersion: input.expectedVersion,
            clientActionId: input.clientActionId,
            content: input.content,
            publicText: input.publicText,
            status: 'rejected',
            rejectionReason: `授权票据已过期 (${grant.expiresAt})`,
            createdAt: new Date().toISOString(),
          };
          await this.deps.store.appendProposal(flow.id, proposal);
          return { status: 'rejected' as const, reason: proposal.rejectionReason, flow };
        }
        if (grant.actor.kind !== input.actor.kind || grant.actor.id !== input.actor.id) {
          return { status: 'rejected' as const, reason: '授权主体不匹配', flow };
        }
      } else {
        // 用户行动允许在 awaiting_user 状态下无 grantId 提交
        if (flow.status === 'awaiting_user' && input.actor.kind === 'user') {
          // OK
        } else {
          return { status: 'rejected' as const, reason: '非等待用户状态下必须提供有效行动授权', flow };
        }
      }

      const expectedVer = (input.expectedVersion && input.expectedVersion > 0)
        ? input.expectedVersion
        : (grant ? grant.expectedVersion : flow.version);

      // 版本校验：不变量 3
      if (expectedVer !== flow.version) {
        const proposal: RoomActionProposal = {
          id: randomUUID(),
          flowId: flow.id,
          grantId: input.grantId ?? '',
          actor: input.actor,
          expectedVersion: expectedVer,
          clientActionId: input.clientActionId,
          content: input.content,
          publicText: input.publicText,
          status: 'stale',
          rejectionReason: `版本不匹配：声明版本 v${expectedVer}，当前最新版本 v${flow.version}`,
          createdAt: new Date().toISOString(),
        };
        await this.deps.store.appendProposal(flow.id, proposal);
        return { status: 'stale' as const, reason: proposal.rejectionReason, flow };
      }

      const protocol = this.deps.protocols.get(flow.protocol);
      if (!protocol) {
        throw new FlowConflictError(`未找到协议：${flow.protocol}`, 'PROTOCOL_NOT_FOUND');
      }

      // 协议验证行动：不变量 1
      const validation = protocol.validate({
        state,
        action: input.content,
        actor: input.actor,
        grant: grant ?? ({
          id: 'user-implicit',
          flowId: flow.id,
          roomId: flow.roomId,
          actor: input.actor,
          issuedBy: flow.coordinatorId,
          expectedVersion: flow.version,
          purpose: 'act',
          replyRoute: { kind: 'room_flow', roomId: flow.roomId, flowId: flow.id, grantId: '', mode: 'proposal', signature: '' },
          publishPolicy: 'proposal',
          state: 'active',
          expiresAt: new Date().toISOString(),
        } as RoomActionGrant),
      });

      if (!validation.valid) {
        const proposal: RoomActionProposal = {
          id: randomUUID(),
          flowId: flow.id,
          grantId: input.grantId ?? '',
          actor: input.actor,
          expectedVersion: input.expectedVersion,
          clientActionId: input.clientActionId,
          content: input.content,
          publicText: input.publicText,
          status: 'rejected',
          rejectionReason: validation.reason ?? '协议校验未通过',
          createdAt: new Date().toISOString(),
        };
        await this.deps.store.appendProposal(flow.id, proposal);
        context.appendEvent({
          eventId: randomUUID(),
          flowId: flow.id,
          type: 'proposal_rejected',
          actor: input.actor,
          versionBefore: flow.version,
          versionAfter: flow.version,
          payload: { reason: proposal.rejectionReason, clientActionId: input.clientActionId },
          visibility: 'internal',
        });
        return { status: 'rejected' as const, reason: proposal.rejectionReason, flow };
      }

      // 验证通过，开始状态转换（不变量 5）
      const versionBefore = flow.version;
      const versionAfter = versionBefore + 1;
      const normalizedAction = validation.normalizedAction ?? input.content;

      // 消费当前授权
      if (grant) {
        context.consumeGrant(grant.id);
      }

      // 执行状态归约
      const newState = protocol.reduce(state, normalizedAction, input.actor);
      Object.assign(context.state, newState);

      flow.version = versionAfter;
      flow.transitionCount += 1;

      const committedMessageId = input.sourceMessageId ?? randomUUID();
      const publicText = input.publicText ?? (typeof input.content === 'object' && input.content && 'text' in input.content ? String((input.content as any).text) : JSON.stringify(input.content));

      context.appendEvent({
        eventId: randomUUID(),
        flowId: flow.id,
        type: 'action_committed',
        actor: input.actor,
        versionBefore,
        versionAfter,
        payload: { action: normalizedAction, committedMessageId, publicText },
        visibility: 'room',
      });

      // 预算检测（6 项预算）
      const budget = flow.budget ?? DEFAULT_ROOM_FLOW_BUDGET;
      const stateBytes = Buffer.byteLength(JSON.stringify(newState));
      const wallTimeMs = Date.now() - Date.parse(flow.createdAt);
      const isBudgetExceeded =
        flow.transitionCount >= (budget.maxTransitions ?? flow.maxTransitions) ||
        wallTimeMs >= budget.maxWallTimeMs ||
        stateBytes >= budget.maxStateBytes;

      let isTerminal = false;

      if (isBudgetExceeded) {
        flow.status = 'completed';
        flow.phase = 'completed_budget_limit';
        context.revokeAllGrants('BUDGET_REACHED');
        isTerminal = true;
      } else {
        // 计算下一步
        const next = protocol.next(context.state);

        if (next.kind === 'completed') {
          flow.status = 'completed';
          flow.phase = 'completed';
          context.revokeAllGrants('COMPLETED');
          context.appendEvent({
            eventId: randomUUID(),
            flowId: flow.id,
            type: 'flow_completed',
            actor: { kind: 'system', id: 'system' },
            versionBefore: versionAfter,
            versionAfter,
            payload: { summary: next.summary },
            visibility: 'room',
          });
          isTerminal = true;
        } else if (next.kind === 'failed') {
          flow.status = 'failed';
          flow.phase = 'failed';
          context.revokeAllGrants('FAILED');
          context.appendEvent({
            eventId: randomUUID(),
            flowId: flow.id,
            type: 'flow_failed',
            actor: { kind: 'system', id: 'system' },
            versionBefore: versionAfter,
            versionAfter,
            payload: { reason: next.reason },
            visibility: 'room',
          });
          isTerminal = true;
        } else if (next.kind === 'await_user') {
          flow.status = 'awaiting_user';
          flow.phase = next.phase ?? flow.phase;
          flow.currentActors = [{ kind: 'user', id: 'owner' }];
          context.appendEvent({
            eventId: randomUUID(),
            flowId: flow.id,
            type: 'user_input_requested',
            actor: { kind: 'system', id: 'system' },
            versionBefore: versionAfter,
            versionAfter,
            payload: { prompt: next.prompt },
            visibility: 'room',
          });
        } else if (next.kind === 'continue') {
          flow.status = 'active';
          flow.phase = next.phase ?? flow.phase;
          flow.currentActors = next.actors;
          for (const actor of next.actors) {
            const grantId = randomUUID();
            const route = createSignedReplyRoute(this.secret, {
              kind: 'room_flow',
              roomId: flow.roomId,
              flowId: flow.id,
              grantId,
              mode: 'proposal',
            });
            const newGrant = context.issueGrant({
              id: grantId,
              flowId: flow.id,
              roomId: flow.roomId,
              actor,
              issuedBy: flow.coordinatorId,
              expectedVersion: versionAfter,
              purpose: next.purpose ?? 'act',
              replyRoute: route,
              publishPolicy: 'proposal',
              state: 'active',
              expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            });
            if (actor.kind === 'agent') {
              context.enqueueOutbox({
                flowId: flow.id,
                kind: 'grant_ready',
                payload: { grant: newGrant },
              });
            }
          }
        }
      }

      if (isTerminal) {
        shouldResetRoomMode = true;
      }

      // 落盘权威群消息到 Outbox（若未显式要求跳过）
      if (!input.skipPublishTimeline) {
        const senderName = await this.resolveSenderName(input.actor);
        context.enqueueOutbox({
          flowId: flow.id,
          kind: 'timeline_message',
          payload: {
            roomId: flow.roomId,
            messageId: committedMessageId,
            roundId: `flow:${flow.id}:${versionAfter}`,
            senderKind: input.actor.kind === 'user' ? 'user' : 'agent',
            senderId: input.actor.id,
            senderName,
            text: publicText,
          },
        });
      }

      // 记录接受的 proposal 供幂等和审计
      const acceptedProposal: RoomActionProposal = {
        id: randomUUID(),
        flowId: flow.id,
        grantId: input.grantId ?? '',
        actor: input.actor,
        expectedVersion: expectedVer,
        clientActionId: input.clientActionId,
        content: input.content,
        publicText,
        status: 'accepted',
        committedMessageId,
        createdAt: new Date().toISOString(),
      };
      await this.deps.store.appendProposal(flow.id, acceptedProposal);

      // 状态演进通知
      context.enqueueOutbox({
        flowId: flow.id,
        kind: 'flow_updated',
        payload: { flow: structuredClone(flow) },
      });

      return { status: 'accepted' as const, flow, committedMessageId };
    });

    if (shouldResetRoomMode && targetRoomId) {
      await this.deps.rooms.setMode(targetRoomId, 'open');
    }

    if (res.status === 'accepted') {
      await this.flushOutbox(input.flowId);
    }

    return res;
  }

  async pauseFlow(flowId: string, reason?: string): Promise<RoomFlow> {
    const flow = await this.deps.store.transact(flowId, async (context) => {
      const { flow } = context;
      if (flow.status === 'paused' || flow.status === 'completed' || flow.status === 'cancelled') {
        return flow;
      }
      flow.status = 'paused';
      context.revokeAllGrants(reason ?? 'USER_PAUSED');
      context.appendEvent({
        eventId: randomUUID(),
        flowId: flow.id,
        type: 'flow_paused',
        actor: { kind: 'system', id: 'system' },
        versionBefore: flow.version,
        versionAfter: flow.version,
        payload: { reason },
        visibility: 'room',
      });
      context.enqueueOutbox({
        flowId: flow.id,
        kind: 'flow_updated',
        payload: { flow: structuredClone(flow) },
      });
      return flow;
    });
    await this.flushOutbox(flowId);
    return flow;
  }

  async resumeFlow(flowId: string): Promise<RoomFlow> {
    const flow = await this.deps.store.transact(flowId, async (context) => {
      const { flow, state } = context;
      if (flow.status !== 'paused') return flow;

      const protocol = this.deps.protocols.get(flow.protocol);
      if (!protocol) throw new FlowConflictError(`未找到协议：${flow.protocol}`, 'PROTOCOL_NOT_FOUND');

      const next = protocol.next(state);
      flow.version += 1;

      if (next.kind === 'await_user') {
        flow.status = 'awaiting_user';
        flow.currentActors = [{ kind: 'user', id: 'owner' }];
      } else if (next.kind === 'continue') {
        flow.status = 'active';
        flow.currentActors = next.actors;
        for (const actor of next.actors) {
          const grantId = randomUUID();
          const route = createSignedReplyRoute(this.secret, {
            kind: 'room_flow',
            roomId: flow.roomId,
            flowId: flow.id,
            grantId,
            mode: 'proposal',
          });
          const grant = context.issueGrant({
            id: grantId,
            flowId: flow.id,
            roomId: flow.roomId,
            actor,
            issuedBy: flow.coordinatorId,
            expectedVersion: flow.version,
            purpose: next.purpose ?? 'act',
            replyRoute: route,
            publishPolicy: 'proposal',
            state: 'active',
            expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          });
          if (actor.kind === 'agent') {
            context.enqueueOutbox({
              flowId: flow.id,
              kind: 'grant_ready',
              payload: { grant },
            });
          }
        }
      }

      context.appendEvent({
        eventId: randomUUID(),
        flowId: flow.id,
        type: 'flow_resumed',
        actor: { kind: 'system', id: 'system' },
        versionBefore: flow.version - 1,
        versionAfter: flow.version,
        payload: {},
        visibility: 'room',
      });

      context.enqueueOutbox({
        flowId: flow.id,
        kind: 'flow_updated',
        payload: { flow: structuredClone(flow) },
      });

      return flow;
    });
    await this.flushOutbox(flowId);
    return flow;
  }

  async cancelFlow(flowId: string, reason?: string): Promise<RoomFlow> {
    const flow = await this.deps.store.transact(flowId, async (context) => {
      const { flow } = context;
      flow.status = 'cancelled';
      context.revokeAllGrants(reason ?? 'USER_CANCELLED');
      context.appendEvent({
        eventId: randomUUID(),
        flowId: flow.id,
        type: 'flow_cancelled',
        actor: { kind: 'system', id: 'system' },
        versionBefore: flow.version,
        versionAfter: flow.version,
        payload: { reason },
        visibility: 'room',
      });
      context.enqueueOutbox({
        flowId: flow.id,
        kind: 'flow_updated',
        payload: { flow: structuredClone(flow) },
      });
      await this.deps.rooms.setMode(flow.roomId, 'open');
      return flow;
    });
    await this.flushOutbox(flowId);
    return flow;
  }

  async getBriefForActor(flowId: string, actor: ActorRef): Promise<FlowBriefContext | undefined> {
    const flow = await this.getFlow(flowId);
    if (!flow) return undefined;
    const state = await this.deps.store.getState(flowId);
    const protocol = this.deps.protocols.get(flow.protocol);
    if (!protocol) return undefined;

    const grants = await this.deps.store.getGrants(flowId);
    const activeGrant = Object.values(grants).find(
      (g) => g.state === 'active' && g.actor.kind === actor.kind && g.actor.id === actor.id,
    );

    const actorView = protocol.actorView(state, actor);
    return {
      flowId: flow.id,
      protocol: protocol.name,
      phase: flow.phase,
      version: flow.version,
      actor,
      purpose: activeGrant?.purpose ?? 'act',
      visibleStateSummary: typeof actorView === 'string' ? actorView : JSON.stringify(actorView),
      allowedOutput: '使用 SendToUser(to:"room", content:"...") 提交候选行动',
      constraints: [
        '不要宣布行动已经被接受',
        '不要指定下一行动者',
        '不要自行修改流程状态',
      ],
    };
  }
}
