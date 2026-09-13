import type { AgentInbox } from '../../agent/inbox.js';
import type { CorrespondenceStore } from '../../storage/correspondence-store.js';
import type { RuntimeControlStore } from '../../storage/runtime-control-store.js';
import type { DeliveryReceipt } from '../../shared/contracts/execution-control.js';
import type { MessageActor } from '../../shared/contracts/message-identity.js';

export interface OutboxRecord {
  receipt: DeliveryReceipt;
  payload: string;
  projected?: boolean;
}

export class OutboxProjector {
  constructor(
    private readonly deps: {
      store: RuntimeControlStore;
      inbox: AgentInbox;
      correspondence: CorrespondenceStore;
    },
  ) {}

  async project(actionId: string, actors: { from: MessageActor; to: MessageActor }): Promise<void> {
    const record = this.recordOf(actionId);
    if (!record) return;
    const deliveryId = record.receipt.deliveryId;
    if (!deliveryId) return;
    await this.deps.inbox.enqueue({
      id: deliveryId,
      toAgentId: record.receipt.target.id,
      fromAgentId: record.receipt.actorId,
      fromName: actors.from.name,
      fromActor: actors.from,
      toActor: actors.to,
      text: record.payload,
      priority: false,
      depth: 0,
      kind: 'message',
    });
    await this.deps.correspondence.record({
      id: deliveryId,
      from: actors.from,
      to: actors.to,
      text: record.payload,
      createdAt: record.receipt.acceptedAt,
    });
    await this.deps.store.transact((draft) => {
      const current = draft.outbox[actionId] as OutboxRecord | undefined;
      if (!current) return 'skip';
      current.projected = true;
      draft.outbox[actionId] = current;
    });
  }

  async recover(actors?: { from: MessageActor; to: MessageActor }): Promise<number> {
    const snap = this.deps.store.snapshot();
    let count = 0;
    for (const [actionId, raw] of Object.entries(snap.outbox)) {
      const record = raw as OutboxRecord;
      if (!record?.receipt || record.projected) continue;
      if (record.receipt.target.kind !== 'agent') continue;
      const pair = actors ?? {
        from: { kind: 'agent' as const, id: record.receipt.actorId, name: record.receipt.actorId },
        to: { kind: 'agent' as const, id: record.receipt.target.id, name: record.receipt.target.nameAtSend },
      };
      await this.project(actionId, pair);
      count += 1;
    }
    return count;
  }

  private recordOf(actionId: string): OutboxRecord | undefined {
    const raw = this.deps.store.snapshot().outbox[actionId];
    if (!raw || typeof raw !== 'object' || !('receipt' in raw)) return undefined;
    return raw as OutboxRecord;
  }
}
