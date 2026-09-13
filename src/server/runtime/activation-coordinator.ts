import { randomUUID } from 'node:crypto';
import {
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

export class ActivationCoordinator {
  constructor(
    private readonly store: RuntimeControlStore,
    private readonly opts: {
      processEpoch: string;
      exists: (agentId: string) => Promise<boolean>;
    },
  ) {}

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
      const ticket: ActivationTicket = {
        ticketId: randomUUID(),
        agentId: input.agentId,
        runId: input.runId,
        taskId: input.taskId,
        inputId: input.inputId,
        chainId: input.chainId,
        generation: agent.generation,
        executionEpoch: 0,
        processEpoch: this.opts.processEpoch,
        grantId: grant?.grantId,
        lease: input.lease,
        admittedSeq: draft.controlSeq + 1,
        source: input.source,
        state: 'admitted',
      };
      draft.tickets[ticket.ticketId] = ticket;
      draft.agents[input.agentId] = agent;
      decision = { kind: 'admitted', ticket };
    });
    return decision ?? { kind: 'cancelled', reason: 'ACTIVATE_FAILED' };
  }

  ticketOf(ticketId: string) {
    return this.store.snapshot().tickets[ticketId];
  }

  assertCurrent(ticket: ActivationTicket): void {
    if (ticket.processEpoch !== this.opts.processEpoch) {
      throw new ControlError('票据属于旧进程，不能继续执行', 'STALE_ACTIVATION');
    }
    const live = this.store.snapshot().tickets[ticket.ticketId];
    if (!live || (live.state !== 'admitted' && live.state !== 'running')) {
      throw new ControlError('票据已失效', 'STALE_ACTIVATION');
    }
    const agent = this.store.snapshot().agents[ticket.agentId];
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
    return {
      ticketId: ticket.ticketId,
      effectId: effect.effectId,
      admittedSeq: ticket.admittedSeq,
      resourceScope: effect.resourceScope,
      state: 'reserved',
    };
  }

  requestStop(command: StopCommand): Promise<StopOperation> {
    return this.store.commitStop(command);
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
