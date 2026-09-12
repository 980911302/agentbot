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
export interface JournalEntry {
  /** 进程内单调递增：客户端补发、去重都用它 */
  seq: number;
  at: number;
  /** 事件归属：dm 频道是 agentId，群频道是 roomId（前端据此路由） */
  agentId?: string;
  roomId?: string;
  /** agent=回合内事件；room=群事件；run=回合生命周期 */
  kind: 'agent' | 'room' | 'run';
  payload: unknown;
}

export interface JournalReplay {
  /** after 之后攒下的事件（按 seq 升序） */
  entries: JournalEntry[];
  /** true = 游标已经太旧（被保留窗口挤掉，或 seq 回退），客户端要先重新取快照 */
  resync: boolean;
  /** 当前最后一条 seq（客户端订阅成功后从这里继续） */
  latestSeq: number;
}

export class EventJournal {
  private readonly entries: JournalEntry[] = [];
  private seq = 0;
  private readonly listeners = new Set<(entry: JournalEntry) => void>();

  constructor(private readonly limit = 2_000) {}

  get latestSeq(): number {
    return this.seq;
  }

  publish(entry: Omit<JournalEntry, 'seq' | 'at'> & { at?: number }): JournalEntry {
    this.seq += 1;
    const full: JournalEntry = { ...entry, seq: this.seq, at: entry.at ?? Date.now() };
    this.entries.push(full);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    for (const listener of this.listeners) listener(full);
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
