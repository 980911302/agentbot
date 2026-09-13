import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CONTROL_SCHEMA_VERSION,
  type AgentControl,
  type ActivationGrant,
  type ActivationTicket,
  type StopCommand,
  type StopOperation,
  type StopScope,
} from '../shared/contracts/execution-control.js';
import { isMissingFile, writeJsonAtomic } from './atomic-json.js';

export const DEFAULT_SOFT_LIMIT_BYTES = 48 * 1024 * 1024;

export class ControlError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

export interface ControlCommandRecord {
  commandId: string;
  kind: string;
  stopId?: string;
  scope?: StopScope;
  grantId?: string;
  chainId?: string;
}

export interface ControlSnapshot {
  schemaVersion: number;
  controlSeq: number;
  processEpoch: string;
  agents: Record<string, AgentControl>;
  grants: Record<string, ActivationGrant>;
  tickets: Record<string, ActivationTicket>;
  stops: Record<string, StopOperation>;
  commands: Record<string, ControlCommandRecord>;
  chains: Record<string, { chainId: string; rootCreatedSeq: number; pausedBudget?: boolean; deliveryActions?: number; recipientDeliveries?: number; automaticRuns?: number }>;
  payloads: Record<string, string>;
  outbox: Record<string, unknown>;
  receipts: Record<string, unknown>;
  actions: Record<string, unknown>;
}

const emptySnapshot = (processEpoch: string): ControlSnapshot => ({
  schemaVersion: CONTROL_SCHEMA_VERSION,
  controlSeq: 0,
  processEpoch,
  agents: {},
  grants: {},
  tickets: {},
  stops: {},
  commands: {},
  chains: {},
  payloads: {},
  outbox: {},
  receipts: {},
  actions: {},
});

export interface RuntimeControlStoreOptions {
  softLimitBytes?: number;
  processEpoch?: string;
}

export class RuntimeControlStore {
  readonly faulted: boolean;
  readonly currentProcessEpoch: string;
  private state: ControlSnapshot;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly softLimitBytes: number;

  private constructor(input: {
    file: string;
    state: ControlSnapshot;
    faulted: boolean;
    softLimitBytes: number;
    currentProcessEpoch: string;
  }) {
    this.file = input.file;
    this.state = input.state;
    this.faulted = input.faulted;
    this.softLimitBytes = input.softLimitBytes;
    this.currentProcessEpoch = input.currentProcessEpoch;
  }

  static openSync(dataDir: string, options: RuntimeControlStoreOptions = {}): RuntimeControlStore {
    const file = join(dataDir, 'control', 'state.json');
    const currentProcessEpoch = options.processEpoch ?? randomUUID();
    const softLimitBytes = options.softLimitBytes ?? DEFAULT_SOFT_LIMIT_BYTES;
    if (!existsSync(file)) {
      return new RuntimeControlStore({
        file,
        state: emptySnapshot(currentProcessEpoch),
        faulted: false,
        softLimitBytes,
        currentProcessEpoch,
      });
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as ControlSnapshot;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.controlSeq !== 'number') throw new Error('invalid snapshot');
      const state = { ...emptySnapshot(parsed.processEpoch || currentProcessEpoch), ...parsed };
      for (const ticket of Object.values(state.tickets)) {
        if (ticket.state === 'admitted' || ticket.state === 'running') ticket.state = 'revoked';
      }
      state.processEpoch = currentProcessEpoch;
      return new RuntimeControlStore({ file, state, faulted: false, softLimitBytes, currentProcessEpoch });
    } catch {
      return new RuntimeControlStore({
        file,
        state: emptySnapshot(currentProcessEpoch),
        faulted: true,
        softLimitBytes,
        currentProcessEpoch,
      });
    }
  }

  static async open(dataDir: string, options: RuntimeControlStoreOptions = {}): Promise<RuntimeControlStore> {
    const file = join(dataDir, 'control', 'state.json');
    const currentProcessEpoch = options.processEpoch ?? randomUUID();
    const softLimitBytes = options.softLimitBytes ?? DEFAULT_SOFT_LIMIT_BYTES;
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as ControlSnapshot;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.controlSeq !== 'number') {
        throw new Error('invalid snapshot');
      }
      const state = { ...emptySnapshot(parsed.processEpoch || currentProcessEpoch), ...parsed };
      for (const ticket of Object.values(state.tickets)) {
        if (ticket.state === 'admitted' || ticket.state === 'running') ticket.state = 'revoked';
      }
      state.processEpoch = currentProcessEpoch;
      return new RuntimeControlStore({ file, state, faulted: false, softLimitBytes, currentProcessEpoch });
    } catch (error) {
      if (isMissingFile(error)) {
        return new RuntimeControlStore({
          file,
          state: emptySnapshot(currentProcessEpoch),
          faulted: false,
          softLimitBytes,
          currentProcessEpoch,
        });
      }
      return new RuntimeControlStore({
        file,
        state: emptySnapshot(currentProcessEpoch),
        faulted: true,
        softLimitBytes,
        currentProcessEpoch,
      });
    }
  }

  snapshot(): ControlSnapshot {
    return structuredClone(this.state);
  }

  allowsAutomaticExecution(): boolean {
    return !this.faulted;
  }

  async transact(
    mutate: (draft: ControlSnapshot) => void | 'skip',
    opts: { allowOverLimit?: boolean } = {},
  ): Promise<number> {
    if (this.faulted) throw new ControlError('控制存储已损坏，禁止写入', 'CONTROL_FAULTED');
    const run = this.queue.catch(() => undefined).then(async () => {
      const draft = structuredClone(this.state);
      if (mutate(draft) === 'skip') return this.state.controlSeq;
      draft.controlSeq += 1;
      draft.schemaVersion = CONTROL_SCHEMA_VERSION;
      draft.processEpoch = this.currentProcessEpoch;
      const encoded = JSON.stringify(draft);
      if (!opts.allowOverLimit && Buffer.byteLength(encoded, 'utf8') > this.softLimitBytes) {
        throw new ControlError('控制快照已接近容量上限，拒绝新增 payload', 'PAYLOAD_LIMIT');
      }
      await writeJsonAtomic(this.file, draft, { mode: 0o600 });
      this.state = draft;
      return draft.controlSeq;
    });
    this.queue = run;
    return run;
  }

  async commitStop(command: StopCommand): Promise<StopOperation> {
    if (command.scope.kind !== 'agent') {
      throw new ControlError('尚未实现该停止范围', 'UNSUPPORTED_STOP_SCOPE');
    }
    const scope = command.scope;
    let result: StopOperation | undefined;
    await this.transact((draft) => {
      const existing = draft.commands[command.commandId];
      if (existing?.stopId) {
        const previous = draft.stops[existing.stopId];
        if (!previous) throw new ControlError('停止命令记录损坏', 'STOP_RECORD_MISSING');
        if (JSON.stringify(previous.scope) !== JSON.stringify(scope)) {
          throw new ControlError('同一停止命令不能更换范围', 'SCOPE_CONFLICT');
        }
        result = previous;
        return 'skip';
      }
      const agentId = scope.agentId;
      const agent: AgentControl = {
        agentId,
        generation: 0,
        autoActivation: 'enabled',
        revision: 0,
        ...draft.agents[agentId],
      };
      agent.generation += 1;
      agent.revision += 1;
      agent.autoActivation = 'paused';
      const committedSeq = draft.controlSeq + 1;
      agent.blockedAutoRootsThroughSeq = committedSeq;
      const stopId = randomUUID();
      agent.lastStopId = stopId;
      agent.lastStopSeq = committedSeq;
      draft.agents[agentId] = agent;
      for (const grant of Object.values(draft.grants)) {
        if (grant.agentId === agentId && grant.state === 'active') grant.state = 'revoked';
      }
      const targetTicketIds: string[] = [];
      for (const ticket of Object.values(draft.tickets)) {
        if (ticket.agentId === agentId && (ticket.state === 'admitted' || ticket.state === 'running')) {
          ticket.state = 'revoked';
          targetTicketIds.push(ticket.ticketId);
        }
      }
      const operation: StopOperation = {
        stopId,
        commandId: command.commandId,
        scope: command.scope,
        committedSeq,
        targetTicketIds,
        targetEffectIds: [],
        state: 'stopping',
        pendingEffects: [],
      };
      draft.stops[stopId] = operation;
      draft.commands[command.commandId] = {
        commandId: command.commandId,
        kind: 'stop',
        stopId,
        scope: command.scope,
      };
      result = operation;
    }, { allowOverLimit: true });
    if (!result) throw new ControlError('停止提交失败', 'STOP_COMMIT_FAILED');
    return result;
  }
}
