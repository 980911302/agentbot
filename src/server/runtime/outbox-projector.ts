import type { AgentInbox } from '../../agent/inbox.js';
import { ROOM_MAX_RUNS_PER_MEMBER, type RoomMessage } from '../../room/types.js';
import type { RoomStore } from '../../room/store.js';
import type { MessageStore } from '../../store/messages.js';
import type { CorrespondenceStore } from '../../storage/correspondence-store.js';
import type { RuntimeControlStore } from '../../storage/runtime-control-store.js';
import type { DeliveryReceipt } from '../../shared/contracts/execution-control.js';
import type { MessageActor } from '../../shared/contracts/message-identity.js';

export interface OutboxRecord {
  receipt: DeliveryReceipt;
  payload: string;
  images?: import('../../shared/contracts/input-image.js').InputImage[];
  priority?: boolean;
  depth?: number;
  chainId?: string;
  recipientAgentIds?: string[];
  recipientDeliveryIds?: string[];
  sender?: MessageActor;
  roomRecipients?: Array<{ id: string; name: string; color?: string; avatar?: string; summoned: boolean; everyone?: boolean }>;
  /** 群投递所属广播窗口；由发起投递时所在回合带入，缺省回退到 actionId */
  roundId?: string;
  /** 委派线程键（E4.4）：回信显式带；派活信缺省用投递 id */
  correlationId?: string;
  projectionState?: 'pending' | 'visible' | 'failed';
  projected?: boolean;
}

export class OutboxProjector {
  constructor(
    private readonly deps: {
      store: RuntimeControlStore;
      inbox: AgentInbox;
      correspondence: CorrespondenceStore;
      rooms?: RoomStore;
      messages?: MessageStore;
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
      ...(record.images?.length ? { images: record.images } : {}),
      priority: record.priority === true,
      depth: record.depth ?? 0,
      kind: 'message',
      ...(record.chainId ? { chainId: record.chainId } : {}),
      // E4.4：1:1 信带上委派线程键。派活信没有显式线程时就是它自己的投递 id——
      // 收件方回信时把它带回来，发起方就能只唤醒「那一次请求」。
      correlationId: record.correlationId ?? deliveryId,
    });
    await this.deps.correspondence.record({
      id: deliveryId,
      from: actors.from,
      to: actors.to,
      text: record.payload,
      ...(record.images?.length ? { images: record.images } : {}),
      createdAt: record.receipt.acceptedAt,
    });
    await this.deps.store.transact((draft) => {
      const current = draft.outbox[actionId] as OutboxRecord | undefined;
      if (!current) return 'skip';
      current.projected = true;
      draft.outbox[actionId] = current;
    });
  }

  async projectRoom(actionId: string): Promise<void> {
    const record = this.recordOf(actionId);
    const rooms = this.deps.rooms;
    if (!record || !rooms || record.receipt.target.kind !== 'room' || !record.sender) return;
    const roomId = record.receipt.target.id;
    const timelineId = record.receipt.timelineMessageId ?? record.receipt.actionId;
    // 与用户消息共用同一套窗口身份：member 配额（${roomId}:${roundId}）和
    // “本轮别人说了什么”复盘都按 roundId 分组，两条链路不能各发各的
    const roundId = record.roundId ?? record.receipt.actionId;
    const message: RoomMessage = {
      id: timelineId,
      roomId,
      roundId,
      senderKind: 'agent',
      senderId: record.sender.id,
      senderName: record.sender.name,
      senderColor: record.sender.color,
      text: record.payload,
      mentions: [],
      everyone: false,
      createdAt: record.receipt.acceptedAt,
    };
    await rooms.appendIfAbsent(message);
    const recipients = record.roomRecipients ?? [];
    for (const [index, recipient] of recipients.entries()) {
      const deliveryId = record.recipientDeliveryIds?.[index];
      if (!deliveryId) continue;
      await this.deps.inbox.enqueueRoom({
        id: deliveryId,
        toAgentId: recipient.id,
        fromAgentId: record.sender.id,
        fromName: record.sender.name,
        fromActor: record.sender,
        toActor: { kind: 'agent', id: recipient.id, name: recipient.name, color: recipient.color, avatar: recipient.avatar },
        text: record.payload,
        priority: false,
        depth: record.depth ?? 0,
        kind: 'room',
        room: {
          roomId,
          roomName: record.receipt.target.nameAtSend,
          roundId,
          speaker: record.sender.name,
          summoned: recipient.summoned,
          everyone: recipient.everyone,
        },
        ...(record.chainId ? { chainId: record.chainId } : {}),
      }, ROOM_MAX_RUNS_PER_MEMBER);
      await this.deps.messages?.appendIfAbsent({
        id: `room-experience:${deliveryId}`,
        agentId: recipient.id,
        role: 'user',
        content: { type: 'text', text: record.payload },
        createdAt: record.receipt.acceptedAt,
        roomId,
        roomName: record.receipt.target.nameAtSend,
        speaker: record.sender.name,
        source: 'room',
        sender: record.sender,
      });
    }
    await this.deps.store.transact((draft) => {
      const current = draft.outbox[actionId] as OutboxRecord | undefined;
      if (!current) return 'skip';
      current.projected = true;
      current.projectionState = 'visible';
      draft.outbox[actionId] = current;
    });
  }

  async recover(actors?: { from: MessageActor; to: MessageActor }): Promise<number> {
    const snap = this.deps.store.snapshot();
    let count = 0;
    for (const [actionId, raw] of Object.entries(snap.outbox)) {
      const record = raw as OutboxRecord;
      if (!record?.receipt || record.projected) continue;
      if (record.receipt.target.kind === 'room') {
        await this.projectRoom(actionId);
        count += 1;
        continue;
      }
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
