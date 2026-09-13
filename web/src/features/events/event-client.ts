import type { EventCursor, JournalEntry } from '../../../../src/shared/contracts/chat-state';

export interface Ready { epoch: string; latestSeq: number; resync: boolean }
export interface EventTransport {
  read(handlers: { onReady: (info: Ready) => void; onEntry: (entry: JournalEntry) => void },
    options: { after: number; epoch: string; signal: AbortSignal }): Promise<void>;
}

/** 连接只负责顺序投递。ready.latestSeq 永远不能作为已消费进度。 */
export class EventClient {
  cursor: EventCursor | null = null;
  constructor(private readonly deps: {
    transport: EventTransport;
    restore: () => Promise<EventCursor>;
    apply: (entry: JournalEntry) => void;
  }) {}

  async connect(signal: AbortSignal): Promise<void> {
    if (!this.cursor) this.cursor = await this.deps.restore();
    if (signal.aborted) return;
    await this.deps.transport.read({
      onReady: ready => {
        if (ready.resync || ready.epoch !== this.cursor?.epoch) {
          this.cursor = null;
          throw new Error('需要恢复聊天快照');
        }
      },
      onEntry: entry => {
        if (signal.aborted || !this.cursor) return;
        if (entry.epoch && entry.epoch !== this.cursor.epoch) { this.cursor = null; throw new Error('事件代际已变化'); }
        if (entry.seq <= this.cursor.seq) return;
        if (entry.seq !== this.cursor.seq + 1) { this.cursor = null; throw new Error('事件序号缺口'); }
        this.deps.apply(entry);
        this.cursor = { ...this.cursor, seq: entry.seq };
      },
    }, { after: this.cursor.seq, epoch: this.cursor.epoch, signal });
  }
}
