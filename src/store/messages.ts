import { join } from 'node:path';
import type { Message } from '../agent/types.js';
import type { MessageRepositoryPort } from '../storage/ports.js';
import { JsonlLog } from '../storage/jsonl-log.js';

export class MessageStore implements MessageRepositoryPort {
  private readonly log: JsonlLog<Message>;
  constructor(dataDir: string) { this.log = new JsonlLog(join(dataDir, 'messages')); }

  append(message: Message): Promise<void> { return this.log.append(message.agentId, message); }

  async appendIfAbsent(message: Message): Promise<boolean> {
    const existing = (await this.log.list(message.agentId)).find((item) => item.id === message.id);
    if (existing) {
      if (JSON.stringify(existing.content) !== JSON.stringify(message.content)) throw new Error('MESSAGE_ID_CONFLICT');
      return false;
    }
    await this.append(message);
    return true;
  }

  async list(agentId: string, limit?: number): Promise<Message[]> {
    const list = await this.log.list(agentId);
    return !limit || limit >= list.length ? list : list.slice(-limit);
  }

  async recent(agentId: string, limit: number, excludeId?: string): Promise<Message[]> {
    const list = await this.log.list(agentId);
    const filtered = excludeId ? list.filter(message => message.id !== excludeId) : list;
    return filtered.slice(Math.max(0, filtered.length - limit));
  }

  /** 自动续跑必须带回最近一次真实用户要求。 */
  async latestUser(agentId: string): Promise<Message | undefined> {
    return (await this.log.list(agentId)).findLast(message => message.role === 'user' && message.content.type === 'text' &&
      (!message.source || message.source === 'user'));
  }

  async olderThan(agentId: string, newestKeep: number, coveredUpTo: number): Promise<Message[]> {
    const list = await this.log.list(agentId);
    return list.slice(0, Math.max(0, list.length - newestKeep)).filter(message => message.createdAt > coveredUpTo);
  }

  async count(agentId: string): Promise<number> { return (await this.log.list(agentId)).length; }
  clear(agentId: string): Promise<void> { return this.log.clear(agentId); }
}
