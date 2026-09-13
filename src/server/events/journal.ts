/**
 * EventJournal（E3.4 第一步）：界面事件的独立订阅与重放。
 *
 * 发送与订阅分离的基础设施（见 docs/架构设计.md §6.1 EventStream、§9.2）：
 *   - 每个事件在进程内取得单调递增 seq，客户端凭 seq 补发与去重；
 *   - 保留窗口有限，游标太旧（或服务端重启后 seq 回退）时明确要求重新取快照；
 *   - 订阅只负责推送，断线只断订阅，不牵动已经开始的执行。
 *
 * 当前为进程内实现：重连补发不跨重启；跨重启由客户端「先取快照再订阅」兜底。
 */
import { randomUUID } from 'node:crypto';
import type { JournalEntry, EventCursor } from '../../shared/contracts/chat-state.js';
export type { JournalEntry } from '../../shared/contracts/chat-state.js';

export interface JournalReplay {
  /** after 之后攒下的事件（按 seq 升序） */
  entries: JournalEntry[];
  /** true = 游标已经太旧（被保留窗口挤掉，或 seq 回退），客户端要先重新取快照 */
  resync: boolean;
  /** 当前最后一条 seq（客户端订阅成功后从这里继续） */
  latestSeq: number;
}

export class EventJournal {
  readonly epoch = randomUUID();
  private readonly entries: JournalEntry[] = [];
  private readonly sizes: number[] = [];
  private bytes = 0;
  private seq = 0;
  private readonly listeners = new Set<(entry: JournalEntry) => void>();

  constructor(private readonly limit = 2_000) {}

  get latestSeq(): number {
    return this.seq;
  }

  get cursor(): EventCursor { return { epoch: this.epoch, seq: this.seq }; }

  /** 读模型期间有事件提交就重取，失败绝不宣称恢复成功或推进客户端游标。 */
  async snapshot<T>(read: () => Promise<T>): Promise<T & { cursor: EventCursor }> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const seq = this.seq;
      const value = await read();
      if (seq === this.seq) return { ...value, cursor: this.cursor };
    }
    throw new Error('聊天状态正在变化，请重试快照');
  }

  publish(entry: Omit<JournalEntry, 'seq' | 'at'> & { at?: number }): JournalEntry {
    this.seq += 1;
    const full: JournalEntry = { ...entry, epoch: this.epoch, seq: this.seq, at: entry.at ?? Date.now() };
    this.entries.push(full);
    const size = Buffer.byteLength(JSON.stringify(full));
    this.sizes.push(size); this.bytes += size;
    while (this.entries.length > this.limit || this.bytes > 8 * 1024 * 1024) {
      this.entries.shift(); this.bytes -= this.sizes.shift() ?? 0;
    }
    for (const listener of this.listeners) {
      try { listener(full); } catch { /* 连接/观察者失败不能让已执行的工具变成运行失败 */ }
    }
    return full;
  }

  /** 从 after（不含）之后补发；游标太旧或超过当前 seq 都要求重新取快照 */
  since(after: number): JournalReplay {
    const oldest = this.entries[0]?.seq ?? this.seq + 1;
    if (after > this.seq || after < oldest - 1) {
      return { entries: [], resync: true, latestSeq: this.seq };
    }
    return {
      entries: this.entries.filter((entry) => entry.seq > after),
      resync: false,
      latestSeq: this.seq,
    };
  }

  /** 订阅新事件；返回退订函数 */
  subscribe(listener: (entry: JournalEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
