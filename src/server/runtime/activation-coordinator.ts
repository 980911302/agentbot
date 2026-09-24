import { randomUUID } from 'node:crypto';
import {
  CHAIN_BUDGET_DEFAULTS,
  mayAutoActivate,
  type ActivationDecision,
  type ActivationGrant,
  type ActivationRequest,
  type ActivationTicket,
  type EffectIntent,
  type EffectPermit,
  type ResumeCommand,
  type StopCommand,
  type StopOperation,
} from '../../shared/contracts/execution-control.js';
import { ControlError, type RuntimeControlStore } from '../../storage/runtime-control-store.js';

export interface AcceptedCommand {
  commandId: string;
  agentId: string;
  inputId: string;
  chainId: string;
  grantId: string;
}

export interface UserCommand {
  commandId: string;
  agentId: string;
  inputId: string;
  text: string;
}

/** 用户新的群发言（§6.2）：一条命令、多个受众，共用同一条新链 */
export interface RoomCommand {
  commandId: string;
  agentIds: string[];
}

export interface AcceptedRoomCommand {
  chainId: string;
  grantIds: string[];
}

export class ActivationCoordinator {
  readonly processEpoch: string;
  constructor(
    private readonly store: RuntimeControlStore,
    private readonly opts: {
      processEpoch: string;
      exists: (agentId: string) => Promise<boolean>;
    },
  ) {
    this.processEpoch = opts.processEpoch;
  }

  async acceptUserInput(input: UserCommand): Promise<AcceptedCommand> {
    let accepted: AcceptedCommand | undefined;
    await this.store.transact((draft) => {
      const existing = draft.commands[input.commandId];
      if (existing?.kind === 'user' && existing.grantId && existing.chainId) {
        accepted = {
          commandId: input.commandId,
          agentId: input.agentId,
          inputId: input.inputId,
          chainId: existing.chainId,
          grantId: existing.grantId,
        };
        return 'skip';
      }
      const agent = draft.agents[input.agentId] ?? {
        agentId: input.agentId,
        generation: 0,
        autoActivation: 'enabled' as const,
        revision: 0,
      };
      draft.agents[input.agentId] = agent;
      const committedSeq = draft.controlSeq + 1;
      const chainId = randomUUID();
      const grantId = randomUUID();
      draft.chains[chainId] = { chainId, rootCreatedSeq: committedSeq };
      const grant: ActivationGrant = {
        grantId,
        agentId: input.agentId,
        generation: agent.generation,
        issuedByCommandId: input.commandId,
        issuedSeq: committedSeq,
        scope: { kind: 'chain', chainId },
        state: 'active',
      };
      draft.grants[grantId] = grant;
      draft.commands[input.commandId] = {
        commandId: input.commandId,
        kind: 'user',
        grantId,
        chainId,
      };
      accepted = {
        commandId: input.commandId,
        agentId: input.agentId,
        inputId: input.inputId,
        chainId,
        grantId,
      };
    });
    if (!accepted) throw new ControlError('受理用户命令失败', 'ACCEPT_FAILED');
    return accepted;
  }

  /**
   * 用户新的群发言（docs/执行控制与可靠投递修复设计.md §6.2）。
   *
   * 群发言是一条命令、多个受众：建一条新链，给每个受众各签发一个覆盖该链的
   * 命令范围许可。被停止过的成员凭这个许可参与本轮，而停止前积压的旧链来信
   * 仍然 held——许可只认 chainId，不会把旧链洗成新任务。
   *
   * 许可必须逐成员签发：grantCovers 要求 grant.agentId 与主体一致，
   * 甲链条上的许可不会顺带激活乙。
   */
  async acceptRoomInput(input: RoomCommand): Promise<AcceptedRoomCommand> {
    if (input.agentIds.length === 0) throw new ControlError('群命令没有受众', 'EMPTY_AUDIENCE');
    let accepted: AcceptedRoomCommand | undefined;
    await this.store.transact((draft) => {
      const existing = draft.commands[input.commandId];
      if (existing?.kind === 'user' && existing.chainId) {
        accepted = { chainId: existing.chainId, grantIds: [existing.grantId ?? ''] };
        return 'skip';
      }
      const committedSeq = draft.controlSeq + 1;
      const chainId = randomUUID();
      draft.chains[chainId] = { chainId, rootCreatedSeq: committedSeq };
      const grantIds: string[] = [];
      for (const agentId of input.agentIds) {
        const agent = draft.agents[agentId] ?? {
          agentId,
          generation: 0,
          autoActivation: 'enabled' as const,
          revision: 0,
        };
        draft.agents[agentId] = agent;
        const grantId = randomUUID();
        draft.grants[grantId] = {
          grantId,
          agentId,
          // 停止会抬 generation：用受理时的代次签发，旧代次的许可自然失效
          generation: agent.generation,
          issuedByCommandId: input.commandId,
          issuedSeq: committedSeq,
          scope: { kind: 'chain', chainId },
          state: 'active',
        };
        grantIds.push(grantId);
      }
      // 命令表里记一条：群命令不是单智能体命令，链与许可的关系由 grants 表按 chainId 关联
      draft.commands[input.commandId] = {
        commandId: input.commandId,
        kind: 'user',
        grantId: grantIds[0] ?? '',
        chainId,
      };
      accepted = { chainId, grantIds };
    });
    if (!accepted) throw new ControlError('受理群命令失败', 'ACCEPT_FAILED');
    return accepted;
  }

  /**
   * 删除智能体时清掉它的控制痕迹（bug_x3wyowcuabut）。
   *
   * 同事没了以后，控制条目、票据和许可都不该留着：留着会让 agents[id] 长期
   * 滞留，还会让迁移与准入看到不存在的同事。命令记录只按 grantId 反查清理
   * （记录本身没有 agentId 字段）；链、outbox 与回执是审计信息，按设计保留。
   */
  async forgetAgent(agentId: string): Promise<void> {
    await this.store.transact((draft) => {
      const before =
        Object.keys(draft.agents).length +
        Object.keys(draft.tickets).length +
        Object.keys(draft.grants).length;
      delete draft.agents[agentId];
      for (const [ticketId, ticket] of Object.entries(draft.tickets)) {
        if (ticket.agentId === agentId) delete draft.tickets[ticketId];
      }
      const droppedGrants = new Set<string>();
      for (const [grantId, grant] of Object.entries(draft.grants)) {
        if (grant.agentId === agentId) {
          delete draft.grants[grantId];
          droppedGrants.add(grantId);
        }
      }
      for (const [commandId, command] of Object.entries(draft.commands)) {
        if (command.grantId !== undefined && droppedGrants.has(command.grantId)) delete draft.commands[commandId];
      }
      const after =
        Object.keys(draft.agents).length +
        Object.keys(draft.tickets).length +
        Object.keys(draft.grants).length;
      if (after === before) return 'skip';
    }).catch(() => undefined);
  }

  async tryActivate(input: ActivationRequest): Promise<ActivationDecision> {
    if (this.store.faulted || !this.store.allowsAutomaticExecution()) {
      return { kind: 'held', reason: 'manual_review' };
    }
    if (!(await this.opts.exists(input.agentId))) {
      return { kind: 'cancelled', reason: 'UNKNOWN_AGENT' };
    }
    let decision: ActivationDecision | undefined;
    await this.store.transact((draft) => {
      const agent = draft.agents[input.agentId] ?? {
        agentId: input.agentId,
        generation: 0,
        autoActivation: 'enabled' as const,
        revision: 0,
      };
      const grant = resolveGrant(draft.grants, input, agent.generation);
      const chain = draft.chains[input.chainId];
      const rootCreatedSeq = input.rootCreatedSeq ?? chain?.rootCreatedSeq;
      if (hasRunningTicket(draft.tickets, input.agentId) && input.source !== 'user') {
        decision = { kind: 'busy' };
        return 'skip';
      }
      if (!mayAutoActivate({
        control: agent,
        rootCreatedSeq,
        chainId: input.chainId,
        inputId: input.inputId,
        taskId: input.taskId,
        grant,
        disposition: input.disposition,
      })) {
        decision = {
          kind: 'held',
          reason: agent.autoActivation === 'paused' ? 'agent_paused' : 'legacy_unscoped',
        };
        return 'skip';
      }
      if (input.source !== 'user') {
        const chainState = draft.chains[input.chainId] ?? { chainId: input.chainId, rootCreatedSeq: rootCreatedSeq ?? draft.controlSeq + 1 };
        const used = chainState.automaticRuns ?? 0;
        const alreadyCounted = Object.values(draft.tickets).some(
          (ticket) => ticket.inputId === input.inputId && ticket.chainId === input.chainId,
        );
        if (!alreadyCounted) {
          if (used >= CHAIN_BUDGET_DEFAULTS.maxAutomaticRunsPerChain) {
            chainState.pausedBudget = true;
            draft.chains[input.chainId] = chainState;
            decision = { kind: 'held', reason: 'budget_exhausted' };
            return 'skip';
          }
          chainState.automaticRuns = used + 1;
          draft.chains[input.chainId] = chainState;
        }
      }
      const ticket: ActivationTicket = {
        ticketId: randomUUID(),
        agentId: input.agentId,
        runId: input.runId,
        taskId: input.taskId,
        inputId: input.inputId,
        chainId: input.chainId,
        generation: agent.generation,
        executionEpoch: 0,
        processEpoch: this.processEpoch,
        grantId: grant?.grantId,
        lease: input.lease,
        admittedSeq: draft.controlSeq + 1,
        source: input.source,
        state: 'admitted',
        ...(input.flowId ? { flowId: input.flowId } : {}),
        ...(input.flowGrantId ? { flowGrantId: input.flowGrantId } : {}),
        ...(input.replyRoute ? { replyRoute: input.replyRoute } : {}),
      };
      draft.tickets[ticket.ticketId] = ticket;
      draft.agents[input.agentId] = agent;
      decision = { kind: 'admitted', ticket };
    });
    return decision ?? { kind: 'cancelled', reason: 'ACTIVATE_FAILED' };
  }

  ticketOf(ticketId: string) {
    return this.store.ticket(ticketId);
  }

  assertCurrent(ticket: ActivationTicket): void {
    if (ticket.processEpoch !== this.processEpoch) {
      throw new ControlError('票据属于旧进程，不能继续执行', 'STALE_ACTIVATION');
    }
    // 只读单条：这个方法在每次副作用执行前都会跑，不能每次都全量克隆状态
    const live = this.store.ticket(ticket.ticketId);
    if (!live || (live.state !== 'admitted' && live.state !== 'running')) {
      throw new ControlError('票据已失效', 'STALE_ACTIVATION');
    }
    const agent = this.store.agentControl(ticket.agentId);
    if (agent && agent.generation !== ticket.generation) {
      throw new ControlError('停止代次已更新', 'STALE_ACTIVATION');
    }
  }

  async markRunning(ticket: ActivationTicket): Promise<void> {
    this.assertCurrent(ticket);
    await this.store.transact((draft) => {
      const current = draft.tickets[ticket.ticketId];
      if (current && (current.state === 'admitted' || current.state === 'running')) {
        current.state = 'running';
      } else {
        return 'skip';
      }
    });
  }

  async admitEffect(ticket: ActivationTicket, effect: EffectIntent): Promise<EffectPermit> {
    this.assertCurrent(ticket);
    await this.store.transact((draft) => {
      if (draft.effects[effect.effectId]) return 'skip';
      draft.effects[effect.effectId] = {
        effectId: effect.effectId,
        ticketId: ticket.ticketId,
        agentId: ticket.agentId,
        inputId: ticket.inputId,
        chainId: ticket.chainId,
        kind: effect.kind,
        resourceScope: effect.resourceScope,
        admittedSeq: ticket.admittedSeq,
        state: 'reserved',
      };
    });
    return {
      ticketId: ticket.ticketId,
      effectId: effect.effectId,
      admittedSeq: ticket.admittedSeq,
      resourceScope: effect.resourceScope,
      state: 'reserved',
    };
  }

  async markEffect(effectId: string, state: import('../../shared/contracts/execution-control.js').EffectRecord['state'], errorCode?: string): Promise<void> {
    await this.store.transact((draft) => {
      const effect = draft.effects[effectId];
      if (!effect || effect.state === 'cancelled') return 'skip';
      effect.state = state;
      if (state === 'started') effect.startedSeq = draft.controlSeq + 1;
      if (state === 'settled' || state === 'unknown') effect.settledSeq = draft.controlSeq + 1;
      if (errorCode) effect.errorCode = errorCode;
    });
  }

  requestStop(command: StopCommand): Promise<StopOperation> {
    return this.store.commitStop(command);
  }

  async settleTicket(ticketId: string, state: 'settled' | 'revoked' = 'settled'): Promise<void> {
    await this.store.transact((draft) => {
      const ticket = draft.tickets[ticketId];
      if (!ticket || ticket.state === 'settled' || ticket.state === 'revoked') return 'skip';
      ticket.state = state;
    });
  }

  async settleStop(stopId: string, state: StopOperation['state'] = 'settled'): Promise<void> {
    await this.store.transact((draft) => {
      const stop = draft.stops[stopId];
      if (!stop) return 'skip';
      stop.state = state;
      if (state === 'settled') stop.pendingEffects = [];
    });
  }

  async resumeSelected(command: ResumeCommand): Promise<{ commandId: string; grantId?: string }> {
    let grantId: string | undefined;
    await this.store.transact((draft) => {
      const existing = draft.commands[command.commandId];
      if (existing?.kind === 'resume') {
        grantId = existing.grantId;
        return 'skip';
      }
      const agent = draft.agents[command.agentId] ?? {
        agentId: command.agentId,
        generation: 0,
        autoActivation: 'paused' as const,
        revision: 0,
      };
      const committedSeq = draft.controlSeq + 1;
      if (command.selection.kind === 'enable_future') {
        agent.autoActivation = 'enabled';
        agent.revision += 1;
        draft.agents[command.agentId] = agent;
        draft.commands[command.commandId] = { commandId: command.commandId, kind: 'resume' };
        return;
      }
      grantId = randomUUID();
      const scope =
        command.selection.kind === 'input'
          ? { kind: 'input' as const, inputId: command.selection.inputId }
          : command.selection.kind === 'task'
            ? { kind: 'task' as const, taskId: command.selection.taskId }
            : { kind: 'chain' as const, chainId: command.selection.chainId };
      draft.grants[grantId] = {
        grantId,
        agentId: command.agentId,
        generation: agent.generation,
        issuedByCommandId: command.commandId,
        issuedSeq: committedSeq,
        scope,
        state: 'active',
      };
      draft.agents[command.agentId] = agent;
      draft.commands[command.commandId] = {
        commandId: command.commandId,
        kind: 'resume',
        grantId,
      };
    });
    return { commandId: command.commandId, grantId };
  }

  getTicket(ticketId: string): ActivationTicket | undefined {
    return this.store.snapshot().tickets[ticketId];
  }
}

function resolveGrant(
  grants: Record<string, ActivationGrant>,
  input: ActivationRequest,
  generation: number,
): ActivationGrant | undefined {
  if (input.grantId) {
    const named = grants[input.grantId];
    if (named?.agentId === input.agentId && named.generation === generation && named.state === 'active') return named;
  }
  return Object.values(grants).find((grant) => {
    if (grant.agentId !== input.agentId || grant.generation !== generation || grant.state !== 'active') return false;
    if (grant.scope.kind === 'chain') return grant.scope.chainId === input.chainId;
    if (grant.scope.kind === 'input') return grant.scope.inputId === input.inputId;
    return grant.scope.taskId === input.taskId;
  });
}

function hasRunningTicket(tickets: Record<string, ActivationTicket>, agentId: string): boolean {
  return Object.values(tickets).some((ticket) => ticket.agentId === agentId && ticket.state === 'running');
}
