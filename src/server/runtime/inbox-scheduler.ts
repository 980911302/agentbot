import type { AgentInbox } from '../../agent/inbox.js';

/** 单实例到期调度器：持久队列是事实源，定时器只是可重建的唤醒句柄。 */
export class InboxScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly revisions = new Map<string, number>();
  private readonly watched = new Set<string>();
  private readonly unsubscribe: () => void;
  private started = false;
  private closed = false;
  constructor(private readonly deps: {
    inbox: AgentInbox;
    busy: (agentId: string) => boolean;
    exists: (agentId: string) => Promise<boolean>;
    process: (agentId: string) => Promise<unknown>;
    canProcess?: (agentId: string) => boolean;
  }) {
    this.unsubscribe = deps.inbox.subscribe(id => { if (this.started || this.watched.has(id)) this.watch(id); });
  }
  start(agentIds: string[]): void { this.started = true; for (const id of agentIds) this.watch(id); }
  watch(agentId: string): void {
    if (this.closed) return;
    this.watched.add(agentId);
    const revision = (this.revisions.get(agentId) ?? 0) + 1;
    this.revisions.set(agentId, revision);
    clearTimeout(this.timers.get(agentId)); this.timers.delete(agentId);
    void this.schedule(agentId, revision).catch(() => {
      // 存储暂时不可读也不热循环；下次重新读取持久状态。
      if (!this.closed && this.revisions.get(agentId) === revision) this.arm(agentId, revision, 1000);
    });
  }
  close(): void {
    this.closed = true; this.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  private async schedule(agentId: string, revision: number): Promise<void> {
    const exists = await this.deps.exists(agentId);
    if (this.deps.canProcess && !this.deps.canProcess(agentId)) return;
    const due = exists ? await this.deps.inbox.nextWakeAt(agentId) : null;
    if (this.closed || this.revisions.get(agentId) !== revision || due === null) return;
    const wait = Math.min(2_147_483_647, Math.max(this.deps.busy(agentId) ? 100 : 1, due - Date.now()));
    this.arm(agentId, revision, wait);
  }
  private arm(agentId: string, revision: number, wait: number): void {
    const timer = setTimeout(() => {
      if (this.closed || this.revisions.get(agentId) !== revision) return;
      this.timers.delete(agentId);
      if (this.deps.busy(agentId)) { this.watch(agentId); return; }
      void this.deps.process(agentId).catch(() => undefined).finally(() => this.watch(agentId));
    }, wait);
    timer.unref(); this.timers.set(agentId, timer);
  }
}
