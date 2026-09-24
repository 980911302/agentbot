import type { ActorRef, RoomActionGrant } from '../../shared/contracts/room-flow.js';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  normalizedAction?: unknown;
}

export type NextStep =
  | { kind: 'continue'; actors: ActorRef[]; purpose?: RoomActionGrant['purpose']; phase?: string; prompt?: string }
  | { kind: 'await_user'; prompt: string; phase?: string }
  | { kind: 'completed'; summary?: string }
  | { kind: 'failed'; reason: string };

export interface RoomFlowProtocol<State = any, Action = any> {
  id: string;
  name: string;
  initialState(input: { actors: ActorRef[]; options?: Record<string, unknown> }): State;
  validate(input: {
    state: State;
    action: Action;
    actor: ActorRef;
    grant: RoomActionGrant;
  }): ValidationResult;
  reduce(state: State, action: Action, actor: ActorRef): State;
  next(state: State): NextStep;
  publicView(state: State): unknown;
  actorView(state: State, actor: ActorRef): unknown;
}

/**
 * 确定性顺序轮转协议（SequentialTurnProtocol）
 * 适用于多智能体顺序接力、轮流发言、评审和人机交替流程。
 */
export interface SequentialTurnState {
  actors: ActorRef[];
  turnIndex: number;
  maxRounds: number;
  currentRound: number;
  phase: string;
  history: Array<{ actor: ActorRef; text: string; round: number }>;
  privateNotes?: Record<string, string>;
  completed?: boolean;
}

export interface SequentialTurnAction {
  type: 'action' | 'pass' | 'finish';
  text: string;
}

export class SequentialTurnProtocol implements RoomFlowProtocol<SequentialTurnState, SequentialTurnAction> {
  readonly id = 'sequential_turn';
  readonly name = '顺序轮转协作协议';

  initialState(input: { actors: ActorRef[]; options?: Record<string, unknown> }): SequentialTurnState {
    if (!input.actors || input.actors.length === 0) {
      throw new Error('顺序轮转协议至少需要 1 个参与者');
    }
    const maxRounds = typeof input.options?.maxRounds === 'number' ? input.options.maxRounds : 5;
    return {
      actors: [...input.actors],
      turnIndex: 0,
      maxRounds,
      currentRound: 1,
      phase: 'in_progress',
      history: [],
      privateNotes: (input.options?.privateNotes as Record<string, string>) ?? {},
      completed: false,
    };
  }

  validate(input: {
    state: SequentialTurnState;
    action: SequentialTurnAction;
    actor: ActorRef;
    grant: RoomActionGrant;
  }): ValidationResult {
    if (input.state.completed) {
      return { valid: false, reason: '流程已完成，不再接受行动' };
    }
    const currentExpectedActor = input.state.actors[input.state.turnIndex % input.state.actors.length];
    if (!currentExpectedActor) return { valid: false, reason: '流程参与者为空' };
    if (!currentExpectedActor) {
      return { valid: false, reason: '未找到当前行动主体' };
    }
    const kindMatch = currentExpectedActor.kind === input.actor.kind;
    const idMatch = currentExpectedActor.id === input.actor.id ||
      (currentExpectedActor.kind === 'user' && input.actor.kind === 'user');
    if (!kindMatch || !idMatch) {
      return {
        valid: false,
        reason: `未轮到该参与者行动（当前期望：${currentExpectedActor.kind}:${currentExpectedActor.id}）`,
      };
    }
    if (!input.action || typeof input.action.text !== 'string') {
      return { valid: false, reason: '行动内容必须包含 text 字段' };
    }
    if (input.action.text.trim().length === 0) {
      return { valid: false, reason: '行动内容不能为空' };
    }
    return { valid: true };
  }

  reduce(state: SequentialTurnState, action: SequentialTurnAction, actor: ActorRef): SequentialTurnState {
    const nextState: SequentialTurnState = structuredClone(state);
    nextState.history.push({
      actor,
      text: action.text.trim(),
      round: nextState.currentRound,
    });

    if (action.type === 'finish') {
      nextState.completed = true;
      nextState.phase = 'completed';
      return nextState;
    }

    const nextIndex = nextState.turnIndex + 1;
    nextState.turnIndex = nextIndex;
    if (nextIndex % nextState.actors.length === 0) {
      nextState.currentRound += 1;
    }
    if (nextState.currentRound > nextState.maxRounds) {
      nextState.completed = true;
      nextState.phase = 'completed';
    }
    return nextState;
  }

  next(state: SequentialTurnState): NextStep {
    if (state.completed || state.currentRound > state.maxRounds) {
      return { kind: 'completed', summary: `流程已结束，共执行 ${state.history.length} 次行动` };
    }
    const nextActor = state.actors[state.turnIndex % state.actors.length];
    if (!nextActor) {
      return { kind: 'failed', reason: '未找到下一行动主体' };
    }
    if (nextActor.kind === 'user') {
      return {
        kind: 'await_user',
        prompt: `请主人输入第 ${state.currentRound} 轮的行动内容`,
        phase: `round_${state.currentRound}`,
      };
    }
    return {
      kind: 'continue',
      actors: [nextActor],
      purpose: 'act',
      phase: `round_${state.currentRound}`,
      prompt: `轮到行动，当前第 ${state.currentRound} 轮`,
    };
  }

  publicView(state: SequentialTurnState): unknown {
    return {
      currentRound: state.currentRound,
      maxRounds: state.maxRounds,
      turnIndex: state.turnIndex,
      currentActor: state.actors[state.turnIndex % state.actors.length],
      phase: state.phase,
      completed: state.completed,
      recentHistory: state.history.slice(-5).map((h) => ({
        actor: h.actor,
        text: h.text,
        round: h.round,
      })),
    };
  }

  actorView(state: SequentialTurnState, actor: ActorRef): unknown {
    const actorKey = `${actor.kind}:${actor.id}`;
    const privateNote = state.privateNotes?.[actorKey];
    return {
      currentRound: state.currentRound,
      maxRounds: state.maxRounds,
      phase: state.phase,
      isMyTurn:
        state.actors[state.turnIndex % state.actors.length]?.kind === actor.kind &&
        state.actors[state.turnIndex % state.actors.length]?.id === actor.id,
      privateNote,
      lastAction: state.history[state.history.length - 1],
    };
  }
}

export class ProtocolRegistry {
  private readonly protocols = new Map<string, RoomFlowProtocol>();

  constructor() {
    this.register(new SequentialTurnProtocol());
  }

  register(protocolOrId: string | RoomFlowProtocol, maybeProtocol?: RoomFlowProtocol): void {
    if (typeof protocolOrId === 'string' && maybeProtocol) {
      this.protocols.set(protocolOrId, maybeProtocol);
      this.protocols.set(maybeProtocol.id, maybeProtocol);
    } else if (typeof protocolOrId !== 'string') {
      this.protocols.set(protocolOrId.id, protocolOrId);
    }
  }

  get(id: string): RoomFlowProtocol | undefined {
    if (!id) return undefined;
    const direct = this.protocols.get(id);
    if (direct) return direct;
    const normalized = id.replace(/-/g, '_');
    const normDirect = this.protocols.get(normalized);
    if (normDirect) return normDirect;
    const hyphenated = id.replace(/_/g, '-');
    return this.protocols.get(hyphenated);
  }

  list(): RoomFlowProtocol[] {
    return Array.from(new Set(this.protocols.values()));
  }
}
