import type { ActivationCoordinator } from './activation-coordinator.js';
import type { EffectPermit } from '../../shared/contracts/execution-control.js';
import { ControlError } from '../../storage/runtime-control-store.js';

export class EffectRunner {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly activation: ActivationCoordinator) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  async start<T>(permit: EffectPermit, work: () => Promise<T>): Promise<T> {
    if (permit.state === 'cancelled' || permit.state === 'settled') {
      throw new ControlError('副作用许可已失效', 'CANCELLED');
    }
    const ticket = this.activation.ticketOf(permit.ticketId);
    if (!ticket || ticket.state === 'revoked' || ticket.state === 'settled') {
      throw new ControlError('副作用许可已撤销，不得启动', 'CANCELLED');
    }
    this.activation.assertCurrent(ticket);
    permit.state = 'started';
    const running = Promise.resolve().then(work);
    this.pending.set(permit.effectId, running);
    try {
      const result = await running;
      permit.state = 'settled';
      return result;
    } catch (error) {
      permit.state = 'unknown';
      throw error;
    } finally {
      this.pending.delete(permit.effectId);
    }
  }

  async wait(timeoutMs = 5000): Promise<void> {
    const pending = [...this.pending.values()];
    if (pending.length === 0) return;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}
