
export type RoomMode = 'open' | 'managed';

export type RoomFlowStatus =
  | 'active'
  | 'awaiting_user'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ActorRef =
  | { kind: 'user'; id: string }
  | { kind: 'agent'; id: string };

export interface RoomReplyRoute {
  kind: 'room_flow';
  roomId: string;
  flowId: string;
  grantId: string;
  mode: 'proposal' | 'public';
  signature: string;
}

export interface RoomActionGrant {
  id: string;
  flowId: string;
  roomId: string;
  actor: ActorRef;
  issuedBy: string;
  expectedVersion: number;
  purpose: 'act' | 'review' | 'coordinate';
  replyRoute: RoomReplyRoute;
  publishPolicy: 'proposal' | 'direct';
  state: 'active' | 'consumed' | 'revoked' | 'expired';
  expiresAt: string;
}

export interface RoomActionProposal {
  id: string;
  flowId: string;
  grantId: string;
  actor: ActorRef;
  expectedVersion: number;
  clientActionId: string;
  content: unknown;
  publicText?: string;
  status: 'pending' | 'accepted' | 'rejected' | 'stale';
  committedMessageId?: string;
  createdAt: string;
  rejectionReason?: string;
}

export type RoomFlowEventType =
  | 'flow_started'
  | 'grant_issued'
  | 'proposal_received'
  | 'proposal_rejected'
  | 'action_committed'
  | 'user_input_requested'
  | 'flow_paused'
  | 'flow_resumed'
  | 'flow_completed'
  | 'flow_failed'
  | 'flow_cancelled';

export interface RoomFlowEvent {
  eventId: string;
  flowId: string;
  seq: number;
  type: RoomFlowEventType;
  actor: ActorRef | { kind: 'system'; id: string };
  versionBefore: number;
  versionAfter: number;
  payload: unknown;
  visibility: 'internal' | 'room' | 'dm';
  createdAt: string;
}

export interface RoomFlowBudget {
  maxTransitions: number;
  maxAgentRuns: number;
  maxToolCalls: number;
  maxWallTimeMs: number;
  maxStateBytes: number;
  maxEventBytes: number;
}

export const DEFAULT_ROOM_FLOW_BUDGET: RoomFlowBudget = {
  maxTransitions: 50,
  maxAgentRuns: 100,
  maxToolCalls: 200,
  maxWallTimeMs: 30 * 60 * 1000, // 30 minutes
  maxStateBytes: 512 * 1024,     // 512 KiB
  maxEventBytes: 10 * 1024 * 1024, // 10 MiB
};

export interface RoomFlow {
  id: string;
  roomId: string;
  coordinatorId: string;
  protocol: string;
  status: RoomFlowStatus;
  phase: string;
  version: number;
  currentActors: ActorRef[];
  stateRef: string;
  rootCommandId: string;
  chainId: string;
  transitionCount: number;
  maxTransitions: number;
  budget?: RoomFlowBudget;
  activeGrantIds: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface FlowBriefContext {
  flowId: string;
  protocol: string;
  phase: string;
  version: number;
  actor: ActorRef;
  purpose: RoomActionGrant['purpose'];
  visibleStateSummary: string;
  allowedOutput: string;
  constraints: string[];
}

export interface RoomFlowView {
  id: string;
  roomId: string;
  coordinatorId: string;
  protocol: string;
  status: RoomFlowStatus;
  phase: string;
  version: number;
  currentActors: ActorRef[];
  transitionCount: number;
  maxTransitions: number;
  createdAt: string;
  updatedAt: string;
}
