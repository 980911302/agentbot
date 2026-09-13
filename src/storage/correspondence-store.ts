import { join } from 'node:path';
import { JsonlLog } from './jsonl-log.js';
import type { Correspondence } from '../shared/contracts/message-identity.js';

/** 已受理来信的只读往来档案，不作为第二个执行队列，不含双方其他私聊。 */
export class CorrespondenceStore {
  private readonly log: JsonlLog<Correspondence>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string) { this.log = new JsonlLog(join(dataDir, 'correspondence')); }
  record(transfer: Correspondence): Promise<boolean> {
    const work = this.queue.catch(() => undefined).then(async () => {
      const existing = (await this.log.list('accepted')).find(item => item.id === transfer.id);
      if (existing) {
        if (existing.text !== transfer.text || existing.from.id !== transfer.from.id || existing.to.id !== transfer.to.id) {
          throw new Error('CORRESPONDENCE_ID_CONFLICT');
        }
        return false;
      }
      await this.log.append('accepted', structuredClone(transfer)); return true;
    });
    this.queue = work; return work;
  }
  async list(agentId: string, peerId?: string): Promise<Correspondence[]> {
    await this.queue.catch(() => undefined);
    return (await this.log.list('accepted')).filter(item =>
      (item.from.id === agentId && (!peerId || item.to.id === peerId)) ||
      (item.to.id === agentId && (!peerId || item.from.id === peerId)));
  }
  async page(agentId: string, peerId: string, before?: string, limit = 30) {
    const all = await this.list(agentId, peerId);
    const end = before ? all.findIndex(item => item.id === before) : all.length;
    if (end < 0) throw new Error('无效的往来记录游标');
    const start = Math.max(0, end - Math.min(50, Math.max(1, limit)));
    return { messages: all.slice(start, end), nextBefore: start > 0 ? all[start]!.id : null };
  }
}
