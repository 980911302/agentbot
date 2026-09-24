import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isMissingFile, writeJsonAtomic } from './atomic-json.js';
import { JsonlLog } from './jsonl-log.js';
import type {
  RoomFlow,
  RoomActionGrant,
  RoomActionProposal,
  RoomFlowEvent,
} from '../shared/contracts/room-flow.js';

export class FlowConflictError extends Error {
  constructor(message: string, public readonly code: string = 'FLOW_VERSION_CONFLICT') {
    super(message);
    this.name = 'FlowConflictError';
  }
}

export type FlowOutboxItem =
  | {
      id: string;
      flowId: string;
      kind: 'timeline_message';
      payload: {
        roomId: string;
        messageId: string;
        roundId: string;
        senderKind: 'user' | 'agent' | 'system';
        senderId: string;
        senderName: string;
        text: string;
      };
      createdAt: string;
    }
  | {
      id: string;
      flowId: string;
      kind: 'grant_ready';
      payload: {
        grant: RoomActionGrant;
      };
      createdAt: string;
    }
  | {
      id: string;
      flowId: string;
      kind: 'flow_updated';
      payload: {
        flow: RoomFlow;
      };
      createdAt: string;
    };

export interface FlowTransactionContext<State = any> {
  flow: RoomFlow;
  state: State;
  grants: Record<string, RoomActionGrant>;
  appendEvent(event: Omit<RoomFlowEvent, 'seq' | 'createdAt'>): RoomFlowEvent;
  issueGrant(grant: Omit<RoomActionGrant, 'id'> & { id?: string }): RoomActionGrant;
  consumeGrant(grantId: string): void;
  revokeAllGrants(reason?: string): void;
  enqueueOutbox(item: Omit<FlowOutboxItem, 'id' | 'createdAt'>): FlowOutboxItem;
}

export interface RoomFlowIndexDoc {
  activeByRoom: Record<string, string>; // roomId -> flowId
  flows: Record<string, { id: string; roomId: string; status: RoomFlow['status']; protocol: string; updatedAt: string }>;
}

export class RoomFlowStore {
  private readonly baseDir: string;
  private readonly eventLogs: JsonlLog<RoomFlowEvent>;
  private readonly proposalLogs: JsonlLog<RoomActionProposal>;
  private readonly outboxLogs: JsonlLog<FlowOutboxItem>;
  private readonly dispatchedLogs: JsonlLog<{ id: string; dispatchedAt: string }>;
  private readonly flowLocks = new Map<string, Promise<unknown>>();
  private indexCache?: RoomFlowIndexDoc;

  constructor(dataDir: string) {
    this.baseDir = join(dataDir, 'room-flows');
    this.eventLogs = new JsonlLog<RoomFlowEvent>(this.baseDir);
    this.proposalLogs = new JsonlLog<RoomActionProposal>(this.baseDir);
    this.outboxLogs = new JsonlLog<FlowOutboxItem>(this.baseDir);
    this.dispatchedLogs = new JsonlLog<{ id: string; dispatchedAt: string }>(this.baseDir);
  }

  private flowDir(flowId: string): string {
    return join(this.baseDir, flowId);
  }

  private flowMetaFile(flowId: string): string {
    return join(this.flowDir(flowId), 'flow.json');
  }

  private flowStateFile(flowId: string): string {
    return join(this.flowDir(flowId), 'state.json');
  }

  private flowGrantsFile(flowId: string): string {
    return join(this.flowDir(flowId), 'grants.json');
  }

  private get indexFile(): string {
    return join(this.baseDir, 'index.json');
  }

  private async lock<T>(flowId: string, action: () => Promise<T>): Promise<T> {
    const prev = this.flowLocks.get(flowId) ?? Promise.resolve();
    const curr = prev.then(action, action);
    this.flowLocks.set(flowId, curr);
    try {
      return await curr;
    } finally {
      if (this.flowLocks.get(flowId) === curr) this.flowLocks.delete(flowId);
    }
  }

  async loadIndex(): Promise<RoomFlowIndexDoc> {
    if (this.indexCache) return this.indexCache;
    try {
      const raw = await readFile(this.indexFile, 'utf8');
      this.indexCache = JSON.parse(raw) as RoomFlowIndexDoc;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.indexCache = { activeByRoom: {}, flows: {} };
    }
    return this.indexCache;
  }

  private async saveIndex(): Promise<void> {
    if (!this.indexCache) return;
    await writeJsonAtomic(this.indexFile, this.indexCache);
  }

  async getFlow(flowId: string): Promise<RoomFlow | undefined> {
    try {
      const raw = await readFile(this.flowMetaFile(flowId), 'utf8');
      return JSON.parse(raw) as RoomFlow;
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async getState<T = unknown>(flowId: string): Promise<T | undefined> {
    try {
      const raw = await readFile(this.flowStateFile(flowId), 'utf8');
      return JSON.parse(raw) as T;
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async getGrants(flowId: string): Promise<Record<string, RoomActionGrant>> {
    try {
      const raw = await readFile(this.flowGrantsFile(flowId), 'utf8');
      return JSON.parse(raw) as Record<string, RoomActionGrant>;
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw error;
    }
  }

  async getGrant(flowId: string, grantId: string): Promise<RoomActionGrant | undefined> {
    const grants = await this.getGrants(flowId);
    return grants[grantId];
  }

  async loadFlow(flowId: string): Promise<RoomFlow | undefined> {
    return this.getFlow(flowId);
  }

  async listGrants(flowId: string): Promise<RoomActionGrant[]> {
    const grants = await this.getGrants(flowId);
    return Object.values(grants);
  }

  async listEvents(flowId: string): Promise<RoomFlowEvent[]> {
    return this.eventLogs.list(join(flowId, 'events'));
  }

  async readEvents(flowId: string): Promise<RoomFlowEvent[]> {
    return this.listEvents(flowId);
  }

  async listProposals(flowId: string): Promise<RoomActionProposal[]> {
    return this.proposalLogs.list(join(flowId, 'proposals'));
  }

  async appendProposal(flowId: string, proposal: RoomActionProposal): Promise<void> {
    await this.proposalLogs.append(join(flowId, 'proposals'), proposal);
  }

  async getActiveFlowForRoom(roomId: string): Promise<RoomFlow | undefined> {
    const index = await this.loadIndex();
    const flowId = index.activeByRoom[roomId];
    if (!flowId) return undefined;
    const flow = await this.getFlow(flowId);
    if (!flow || flow.status === 'completed' || flow.status === 'failed' || flow.status === 'cancelled') {
      delete index.activeByRoom[roomId];
      await this.saveIndex();
      return undefined;
    }
    return flow;
  }

  async listFlows(roomId?: string): Promise<RoomFlow[]> {
    const index = await this.loadIndex();
    const flows: RoomFlow[] = [];
    for (const [id, meta] of Object.entries(index.flows)) {
      if (roomId && meta.roomId !== roomId) continue;
      const flow = await this.getFlow(id);
      if (flow) flows.push(flow);
    }
    return flows.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  getOrCreateSigningSecretSync(): string {
    const secretFile = join(this.baseDir, 'secret.key');
    try {
      if (existsSync(secretFile)) {
        const raw = readFileSync(secretFile, 'utf8').trim();
        if (raw) return raw;
      }
    } catch {}
    mkdirSync(this.baseDir, { recursive: true });
    const secret = randomBytes(32).toString('hex');
    writeFileSync(secretFile, secret, { encoding: 'utf8', mode: 0o600 });
    return secret;
  }

  async getOrCreateSigningSecret(): Promise<string> {
    const secretFile = join(this.baseDir, 'secret.key');
    try {
      const raw = (await readFile(secretFile, 'utf8')).trim();
      if (raw) return raw;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    await mkdir(this.baseDir, { recursive: true });
    const secret = randomBytes(32).toString('hex');
    await writeFile(secretFile, secret, { encoding: 'utf8', mode: 0o600 });
    return secret;
  }

  async createFlow<State = unknown>(
    flow: RoomFlow,
    initialState: State,
    initialGrants: Record<string, RoomActionGrant> = {},
    initialOutbox: Array<Omit<FlowOutboxItem, 'id' | 'createdAt'>> = [],
  ): Promise<void> {
    return this.lock(flow.id, async () => {
      await mkdir(this.flowDir(flow.id), { recursive: true });
      await writeJsonAtomic(this.flowMetaFile(flow.id), flow);
      await writeJsonAtomic(this.flowStateFile(flow.id), initialState);
      await writeJsonAtomic(this.flowGrantsFile(flow.id), initialGrants);

      const startEvent: RoomFlowEvent = {
        eventId: randomUUID(),
        flowId: flow.id,
        seq: 1,
        type: 'flow_started',
        actor: { kind: 'system', id: 'system' },
        versionBefore: 0,
        versionAfter: flow.version,
        payload: { protocol: flow.protocol, coordinatorId: flow.coordinatorId, roomId: flow.roomId },
        visibility: 'room',
        createdAt: flow.createdAt,
      };
      await this.eventLogs.append(join(flow.id, 'events'), startEvent);

      for (const item of initialOutbox) {
        await this.outboxLogs.append(join(flow.id, 'outbox'), {
          ...item,
          id: randomUUID(),
          createdAt: flow.createdAt,
        } as FlowOutboxItem);
      }

      const index = await this.loadIndex();
      index.flows[flow.id] = {
        id: flow.id,
        roomId: flow.roomId,
        status: flow.status,
        protocol: flow.protocol,
        updatedAt: flow.updatedAt,
      };
      if (flow.status === 'active' || flow.status === 'awaiting_user') {
        index.activeByRoom[flow.roomId] = flow.id;
      }
      await this.saveIndex();
    });
  }

  async transact<R, State = any>(
    flowId: string,
    mutator: (context: FlowTransactionContext<State>) => Promise<R> | R,
  ): Promise<R> {
    return this.lock(flowId, async () => {
      const flow = await this.getFlow(flowId);
      if (!flow) throw new FlowConflictError(`流程不存在：${flowId}`, 'FLOW_NOT_FOUND');
      const state = (await this.getState<State>(flowId)) ?? ({} as State);
      const grants = await this.getGrants(flowId);
      const existingEvents = await this.listEvents(flowId);

      const newEvents: RoomFlowEvent[] = [];
      const newOutboxItems: FlowOutboxItem[] = [];
      let nextSeq = existingEvents.length > 0
        ? Math.max(...existingEvents.map((e) => e.seq)) + 1
        : 1;

      const context: FlowTransactionContext<State> = {
        flow: structuredClone(flow),
        state: structuredClone(state),
        grants: structuredClone(grants),
        appendEvent(eventInput) {
          const evt: RoomFlowEvent = {
            ...eventInput,
            seq: nextSeq++,
            createdAt: new Date().toISOString(),
          };
          newEvents.push(evt);
          return evt;
        },
        issueGrant(grantInput) {
          const grantId = grantInput.id ?? randomUUID();
          const grant: RoomActionGrant = {
            ...grantInput,
            id: grantId,
          };
          this.grants[grantId] = grant;
          if (!this.flow.activeGrantIds.includes(grantId)) {
            this.flow.activeGrantIds.push(grantId);
          }
          this.appendEvent({
            eventId: randomUUID(),
            flowId: this.flow.id,
            type: 'grant_issued',
            actor: grant.actor,
            versionBefore: this.flow.version,
            versionAfter: this.flow.version,
            payload: { grantId, actor: grant.actor, purpose: grant.purpose },
            visibility: 'internal',
          });
          return grant;
        },
        consumeGrant(grantId) {
          const grant = this.grants[grantId];
          if (grant) {
            grant.state = 'consumed';
            this.flow.activeGrantIds = this.flow.activeGrantIds.filter((id) => id !== grantId);
          }
        },
        revokeAllGrants(reason) {
          for (const grant of Object.values(this.grants)) {
            if (grant.state === 'active') {
              grant.state = 'revoked';
            }
          }
          this.flow.activeGrantIds = [];
        },
        enqueueOutbox(itemInput) {
          const item: FlowOutboxItem = {
            ...itemInput,
            id: randomUUID(),
            createdAt: new Date().toISOString(),
          } as FlowOutboxItem;
          newOutboxItems.push(item);
          return item;
        },
      };

      const result = await mutator(context);

      context.flow.updatedAt = new Date().toISOString();

      await writeJsonAtomic(this.flowMetaFile(flowId), context.flow);
      await writeJsonAtomic(this.flowStateFile(flowId), context.state);
      await writeJsonAtomic(this.flowGrantsFile(flowId), context.grants);

      for (const evt of newEvents) {
        await this.eventLogs.append(join(flowId, 'events'), evt);
      }

      for (const item of newOutboxItems) {
        await this.outboxLogs.append(join(flowId, 'outbox'), item);
      }

      const index = await this.loadIndex();
      index.flows[flowId] = {
        id: flowId,
        roomId: context.flow.roomId,
        status: context.flow.status,
        protocol: context.flow.protocol,
        updatedAt: context.flow.updatedAt,
      };
      if (context.flow.status === 'completed' || context.flow.status === 'cancelled' || context.flow.status === 'failed') {
        if (index.activeByRoom[context.flow.roomId] === flowId) {
          delete index.activeByRoom[context.flow.roomId];
        }
      } else {
        index.activeByRoom[context.flow.roomId] = flowId;
      }
      await this.saveIndex();

      return result;
    });
  }

  async listPendingOutbox(flowId: string): Promise<FlowOutboxItem[]> {
    const all = await this.outboxLogs.list(join(flowId, 'outbox'));
    const dispatched = await this.dispatchedLogs.list(join(flowId, 'dispatched'));
    const dispatchedIds = new Set(dispatched.map((d) => d.id));
    return all.filter((item) => !dispatchedIds.has(item.id));
  }

  async markOutboxDispatched(flowId: string, itemId: string): Promise<void> {
    await this.dispatchedLogs.append(join(flowId, 'dispatched'), {
      id: itemId,
      dispatchedAt: new Date().toISOString(),
    });
  }

  async listAllPendingOutbox(): Promise<Array<{ flowId: string; item: FlowOutboxItem }>> {
    const index = await this.loadIndex();
    const result: Array<{ flowId: string; item: FlowOutboxItem }> = [];
    for (const flowId of Object.keys(index.flows)) {
      const pending = await this.listPendingOutbox(flowId);
      for (const item of pending) {
        result.push({ flowId, item });
      }
    }
    return result;
  }
}
