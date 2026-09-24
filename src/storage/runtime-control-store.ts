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
  effects: Record<string, import('../shared/contracts/execution-control.js').EffectRecord>;
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
  effects: {},
});

export interface RuntimeControlStoreOptions {
  softLimitBytes?: number;
  processEpoch?: string;
  /** 已终结票据的保留条数；超过就裁掉最旧的（bug_duderhc68jjw）。0 表示不保留 */
  ticketRetention?: number;
  /** 快照接近软上限时的告警回调；不传则静默 */
  onNearLimit?: (bytes: number, limitBytes: number) => void;
}

/** 默认保留最近 2000 条已终结票据：够排查近期的执行，又不会让文件无限增长 */
const DEFAULT_TICKET_RETENTION = 2000;

/** 快照用到软上限的这个比例就开始告警（真撞上去时写入已被拒绝，来不及处理） */
const SOFT_LIMIT_WARN_RATIO = 0.8;

/**
 * 裁掉最旧的已终结票据。
 *
 * 只在 admitted/running 的票据占用执行位、需要被 tryActivate 与 assertCurrent
 * 查到；settled/revoked 的票据已经终结，除了事后排查没有读者。此前它们一条不删，
 * 每次 transact 又全量克隆 + 序列化 + 整文件写，文件随消息数线性增长，最终撞到
 * 48MB 软上限后 transact 直接抛 PAYLOAD_LIMIT，同事之间的投递就此失败。
 *
 * 只删「超出保留数量」的最旧终结票：仍在飞的票据、刚结束的票据都不动。
 */
function pruneFinishedTickets(snapshot: ControlSnapshot, retention: number): void {
  if (retention < 0) return;
  const finished: ActivationTicket[] = [];
  for (const ticket of Object.values(snapshot.tickets)) {
    if (ticket.state === 'settled' || ticket.state === 'revoked') finished.push(ticket);
  }
  if (finished.length <= retention) return;
  // 按受理序号排序，序号越小越旧；缺序号的老数据排在最前（最早该被裁）
  finished.sort((left, right) => (left.admittedSeq ?? 0) - (right.admittedSeq ?? 0));
  const drop = finished.length - retention;
  for (let index = 0; index < drop; index += 1) {
    delete snapshot.tickets[finished[index]!.ticketId];
  }
}

export class RuntimeControlStore {
  readonly faulted: boolean;
  readonly currentProcessEpoch: string;
  private state: ControlSnapshot;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly softLimitBytes: number;
  private readonly ticketRetention: number;
  private readonly onNearLimit?: (bytes: number, limitBytes: number) => void;

  private constructor(input: {
    file: string;
    state: ControlSnapshot;
    faulted: boolean;
    softLimitBytes: number;
    currentProcessEpoch: string;
    ticketRetention: number;
    onNearLimit?: (bytes: number, limitBytes: number) => void;
  }) {
    this.file = input.file;
    this.state = input.state;
    this.faulted = input.faulted;
    this.softLimitBytes = input.softLimitBytes;
    this.currentProcessEpoch = input.currentProcessEpoch;
    this.ticketRetention = input.ticketRetention;
    this.onNearLimit = input.onNearLimit;
  }

  static openSync(dataDir: string, options: RuntimeControlStoreOptions = {}): RuntimeControlStore {
    const file = join(dataDir, 'control', 'state.json');
    const currentProcessEpoch = options.processEpoch ?? randomUUID();
    const softLimitBytes = options.softLimitBytes ?? DEFAULT_SOFT_LIMIT_BYTES;
    const ticketRetention = options.ticketRetention ?? DEFAULT_TICKET_RETENTION;
    const onNearLimit = options.onNearLimit;
    if (!existsSync(file)) {
      return new RuntimeControlStore({
        file,
        state: emptySnapshot(currentProcessEpoch),
        faulted: false,
        softLimitBytes,
        currentProcessEpoch,
        ticketRetention,
        onNearLimit,
      });
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as ControlSnapshot;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.controlSeq !== 'number') throw new Error('invalid snapshot');
      const state = { ...emptySnapshot(parsed.processEpoch || currentProcessEpoch), ...parsed, effects: parsed.effects ?? {} };
      for (const ticket of Object.values(state.tickets)) {
        if (ticket.state === 'admitted' || ticket.state === 'running') ticket.state = 'revoked';
      }
      state.processEpoch = currentProcessEpoch;
      return new RuntimeControlStore({ file, state, faulted: false, softLimitBytes, currentProcessEpoch, ticketRetention, onNearLimit });
    } catch {
      return new RuntimeControlStore({
        file,
        state: emptySnapshot(currentProcessEpoch),
        faulted: true,
        softLimitBytes,
        currentProcessEpoch,
        ticketRetention,
        onNearLimit,
      });
    }
  }

  static async open(dataDir: string, options: RuntimeControlStoreOptions = {}): Promise<RuntimeControlStore> {
    const file = join(dataDir, 'control', 'state.json');
    const currentProcessEpoch = options.processEpoch ?? randomUUID();
    const softLimitBytes = options.softLimitBytes ?? DEFAULT_SOFT_LIMIT_BYTES;
    const ticketRetention = options.ticketRetention ?? DEFAULT_TICKET_RETENTION;
    const onNearLimit = options.onNearLimit;
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as ControlSnapshot;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.controlSeq !== 'number') {
        throw new Error('invalid snapshot');
      }
      const state = { ...emptySnapshot(parsed.processEpoch || currentProcessEpoch), ...parsed, effects: parsed.effects ?? {} };
      for (const ticket of Object.values(state.tickets)) {
        if (ticket.state === 'admitted' || ticket.state === 'running') ticket.state = 'revoked';
      }
      state.processEpoch = currentProcessEpoch;
      return new RuntimeControlStore({ file, state, faulted: false, softLimitBytes, currentProcessEpoch, ticketRetention, onNearLimit });
    } catch (error) {
      if (isMissingFile(error)) {
        return new RuntimeControlStore({
          file,
          state: emptySnapshot(currentProcessEpoch),
          faulted: false,
          softLimitBytes,
          currentProcessEpoch,
          ticketRetention,          onNearLimit
        });
      }
      return new RuntimeControlStore({
        file,
        state: emptySnapshot(currentProcessEpoch),
        faulted: true,
        softLimitBytes,
        currentProcessEpoch,
        ticketRetention,
        onNearLimit,
      });
    }
  }

  snapshot(): ControlSnapshot {
    return structuredClone(this.state);
  }

  /**
   * 按 id 读单条票据（bug_duderhc68jjw）。
   *
   * snapshot() 会全量 structuredClone，而 assertCurrent 这类校验在工具执行前
   * 每次都要跑；票据越多，一次开关副作用的成本越高。这里只克隆拿到的那一条。
   */
  ticket(ticketId: string): ActivationTicket | undefined {
    const found = this.state.tickets[ticketId];
    return found ? structuredClone(found) : undefined;
  }

  /** 按 id 读单个智能体的控制条目（同样是热路径单条读取） */
  agentControl(agentId: string): AgentControl | undefined {
    const found = this.state.agents[agentId];
    return found ? structuredClone(found) : undefined;
  }

  allowsAutomaticExecution(): boolean {
    return !this.faulted;
  }

  /** 当前快照的字节数（用于观测增长，不触发写入） */
  approximateBytes(): number {
    return Buffer.byteLength(JSON.stringify(this.state), 'utf8');
  }

  /** 已终结票据的当前条数 */
  finishedTicketCount(): number {
    let count = 0;
    for (const ticket of Object.values(this.state.tickets)) {
      if (ticket.state === 'settled' || ticket.state === 'revoked') count += 1;
    }
    return count;
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
      pruneFinishedTickets(draft, this.ticketRetention);
      const encoded = JSON.stringify(draft);
      const bytes = Buffer.byteLength(encoded, 'utf8');
      // 快到软上限前先告警：真撞上去时 transact 会直接拒绝，投递就失败了（bug_duderhc68jjw）
      if (bytes >= this.softLimitBytes * SOFT_LIMIT_WARN_RATIO) {
        this.onNearLimit?.(bytes, this.softLimitBytes);
      }
      if (!opts.allowOverLimit && bytes > this.softLimitBytes) {
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
    if (command.scope.kind === 'all_agents' || command.scope.kind === 'room_round') {
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
      const targetTicketIds: string[] = [];
      const stopId = randomUUID();
      const committedSeq = draft.controlSeq + 1;

      if (scope.kind === 'agent') {
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
        agent.blockedAutoRootsThroughSeq = committedSeq;
        agent.lastStopId = stopId;
        agent.lastStopSeq = committedSeq;
        draft.agents[agentId] = agent;
        for (const grant of Object.values(draft.grants)) {
          if (grant.agentId === agentId && grant.state === 'active') grant.state = 'revoked';
        }
        for (const ticket of Object.values(draft.tickets)) {
          if (ticket.agentId === agentId && (ticket.state === 'admitted' || ticket.state === 'running')) {
            ticket.state = 'revoked';
            targetTicketIds.push(ticket.ticketId);
          }
        }
      } else if (scope.kind === 'room_flow') {
        for (const ticket of Object.values(draft.tickets)) {
          if (ticket.flowId === scope.flowId && (ticket.state === 'admitted' || ticket.state === 'running')) {
            ticket.state = 'revoked';
            targetTicketIds.push(ticket.ticketId);
          }
        }
      } else {
        for (const ticket of Object.values(draft.tickets)) {
          if (ticket.state === 'admitted' || ticket.state === 'running') {
            ticket.state = 'revoked';
            targetTicketIds.push(ticket.ticketId);
          }
        }
      }
      const targetEffectIds: string[] = [];
      const pendingEffects: Array<{ id: string; reason: string }> = [];
      for (const effect of Object.values(draft.effects)) {
        if (!targetTicketIds.includes(effect.ticketId)) continue;
        targetEffectIds.push(effect.effectId);
        if (effect.state === 'reserved') effect.state = 'cancelled';
        if (effect.state === 'started') pendingEffects.push({ id: effect.effectId, reason: '副作用仍在收束' });
      }
      const operation: StopOperation = {
        stopId,
        commandId: command.commandId,
        scope: command.scope,
        committedSeq,
        targetTicketIds,
        targetEffectIds,
        state: 'stopping',
        pendingEffects,
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
