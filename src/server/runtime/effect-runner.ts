import type { ActivationCoordinator } from './activation-coordinator.js';
import type { ActivationTicket, EffectIntent, EffectPermit } from '../../shared/contracts/execution-control.js';
import { ControlError } from '../../storage/runtime-control-store.js';

export class EffectRunner {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly activation: ActivationCoordinator) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  reserve(ticket: ActivationTicket, effect: EffectIntent): Promise<EffectPermit> {
    return this.activation.admitEffect(ticket, effect);
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
    await this.activation.markEffect(permit.effectId, 'started');
    permit.state = 'started';
    const running = Promise.resolve().then(work);
    this.pending.set(permit.effectId, running);
    try {
      const result = await running;
      permit.state = 'settled';
      await this.activation.markEffect(permit.effectId, 'settled');
      return result;
    } catch (error) {
      permit.state = 'unknown';
      await this.activation.markEffect(permit.effectId, 'unknown', error instanceof Error ? error.name : 'EFFECT_UNKNOWN');
      throw error;
    } finally {
      this.pending.delete(permit.effectId);
    }
  }

  async waitFor(effectIds: string[], timeoutMs = 5000): Promise<string[]> {
    const pending = effectIds
      .map((id) => [id, this.pending.get(id)] as const)
      .filter((entry): entry is readonly [string, Promise<unknown>] => Boolean(entry[1]));
    if (pending.length === 0) return [];
    await Promise.race([
      Promise.allSettled(pending.map((entry) => entry[1])),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    return pending.map(([id]) => id).filter((id) => this.pending.has(id));
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
