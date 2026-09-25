import { join } from 'node:path';
import type { Message } from '../agent/types.js';
import type { MessageRepositoryPort } from '../storage/ports.js';
import { JsonlLog, type JsonlLogOptions } from '../storage/jsonl-log.js';

export class MessageStore implements MessageRepositoryPort {
  private readonly log: JsonlLog<Message>;
  constructor(dataDir: string, options: JsonlLogOptions = {}) { this.log = new JsonlLog(join(dataDir, 'messages'), options); }

  append(message: Message): Promise<void> { return this.log.append(message.agentId, message); }

  async appendIfAbsent(message: Message): Promise<boolean> {
    // 只读视图：不做整条线拷贝
    const existing = (await this.log.view(message.agentId)).find((item) => item.id === message.id);
    if (existing) {
      if (JSON.stringify(existing.content) !== JSON.stringify(message.content)) throw new Error('MESSAGE_ID_CONFLICT');
      return false;
    }
    await this.append(message);
    return true;
  }

  async list(agentId: string, limit?: number): Promise<Message[]> {
    if (!limit || limit <= 0) return this.log.list(agentId);
    return this.log.tail(agentId, limit);
  }

  /** 尾部读取：先按 limit(+1) 取尾，再排除自己，避免整条线拷贝 */
  async recent(agentId: string, limit: number, excludeId?: string): Promise<Message[]> {
    const tail = await this.log.tail(agentId, limit + (excludeId ? 1 : 0));
    const filtered = excludeId ? tail.filter(message => message.id !== excludeId) : tail;
    return filtered.slice(Math.max(0, filtered.length - limit));
  }

  /** 某个回合（runId）产生的消息：回答「这一轮到底写了什么」不用全量扫 */
  byRun(agentId: string, runId: string): Promise<Message[]> {
    return this.log.filter(agentId, message => message.runId === runId);
  }

  /** 自动续跑必须带回最近一次真实用户要求。 */
  async latestUser(agentId: string): Promise<Message | undefined> {
    return (await this.log.view(agentId)).findLast(message => message.role === 'user' && message.content.type === 'text' &&
      (!message.source || message.source === 'user'));
  }

  async olderThan(agentId: string, newestKeep: number, coveredUpTo: number): Promise<Message[]> {
    const list = await this.log.view(agentId);
    return list.slice(0, Math.max(0, list.length - newestKeep)).filter(message => message.createdAt > coveredUpTo);
  }

  async count(agentId: string): Promise<number> { return (await this.log.view(agentId)).length; }
  clear(agentId: string): Promise<void> { return this.log.clear(agentId); }
}
