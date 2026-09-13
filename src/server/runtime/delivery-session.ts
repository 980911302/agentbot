import { AgentInbox, leaseOf, type InboxItem } from '../../agent/inbox.js';
import type { DeliveryFailureInput } from '../../storage/ports.js';

/** 一个领取批次的生命周期；续租与确认串行，避免确认和心跳互相误判。 */
export class DeliverySession {
  readonly controller = new AbortController();
  private readonly pending: Set<string>;
  private readonly lease;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private closed = false;
  constructor(private readonly inbox: AgentInbox, private readonly agentId: string, claimed: InboxItem[], private readonly leaseMs: number) {
    this.pending = new Set(claimed.map(item => item.id));
    this.lease = leaseOf(claimed[0]!);
    this.arm();
  }

  ack(ids: string[]): Promise<unknown> { return this.settle(ids, () => this.inbox.ack(this.agentId, ids, this.lease)); }
  release(ids: string[]): Promise<unknown> { return this.settle(ids, () => this.inbox.release(this.agentId, ids, this.lease)); }
  nack(ids: string[], error: string, input: DeliveryFailureInput): Promise<unknown> {
    return this.settle(ids, () => this.inbox.nack(this.agentId, ids, error, input, this.lease));
  }
  checkpoint(ids: string[], patch: { messageId: string }): Promise<unknown> {
    return this.serial(() => this.inbox.checkpoint(this.agentId, ids, patch, this.lease));
  }
  async close(): Promise<void> {
    this.closed = true; clearTimeout(this.timer);
    await this.queue.catch(() => undefined);
  }
  private arm(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      void this.serial(() => this.inbox.renew(this.agentId, [...this.pending], this.lease, this.leaseMs))
        .then(() => this.arm()).catch(error => this.controller.abort(error));
    }, Math.max(1, Math.floor(this.leaseMs / 3)));
    this.timer.unref();
  }
  private settle(ids: string[], work: () => Promise<unknown>): Promise<unknown> {
    return this.serial(async () => { const result = await work(); for (const id of ids) this.pending.delete(id); return result; });
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(work); this.queue = next; return next;
  }
}
