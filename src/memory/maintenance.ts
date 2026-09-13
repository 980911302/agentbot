import type { Agent, Message, MemoryRef } from '../agent/types.js';
import type { LLMProvider } from '../llm/provider.js';
import type { MemoryExtractor } from './extract.js';

/** 最佳努力的后处理，不占聊天执行位；新回合/停止/关闭使旧提交失效。 */
export class MemoryMaintenance {
  private readonly jobs = new Map<string, AbortController>();
  constructor(private readonly extractor: MemoryExtractor) {}

  cancel(agentId: string): void { this.jobs.get(agentId)?.abort(); this.jobs.delete(agentId); }
  close(): void { for (const id of this.jobs.keys()) this.cancel(id); }

  start(agent: Agent, provider: LLMProvider, exchange: Message[], isCurrent: () => boolean,
    notify: (result: { refs: MemoryRef[]; merged: number }) => void): void {
    this.cancel(agent.id);
    const controller = new AbortController();
    this.jobs.set(agent.id, controller);
    const timer = setTimeout(() => controller.abort(), 30_000); timer.unref();
    void this.extractor.extract(agent, provider, exchange, { signal: controller.signal, isCurrent })
      .then(result => { if (!controller.signal.aborted && isCurrent() && (result.refs.length || result.merged)) notify(result); })
      .catch(() => undefined)
      .finally(() => { clearTimeout(timer); if (this.jobs.get(agent.id) === controller) this.jobs.delete(agent.id); });
  }
}
