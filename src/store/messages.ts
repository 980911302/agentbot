import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Message } from '../agent/types.js';

export class MessageStore {
  private readonly cache = new Map<string, Message[]>();
  private readonly messageDir: string;

  constructor(private readonly dataDir: string) {
    this.messageDir = join(dataDir, 'messages');
  }

  private file(agentId: string): string {
    return join(this.messageDir, `${agentId}.jsonl`);
  }

  async append(message: Message): Promise<void> {
    const list = await this.load(message.agentId);
    list.push(message);
    const file = this.file(message.agentId);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(message)}\n`, { flag: 'a' });
  }

  async list(agentId: string, limit?: number): Promise<Message[]> {
    const list = await this.load(agentId);
    if (!limit || limit >= list.length) return [...list];
    return list.slice(list.length - limit);
  }

  async recent(agentId: string, limit: number, excludeId?: string): Promise<Message[]> {
    const list = await this.load(agentId);
    const filtered = excludeId ? list.filter((message) => message.id !== excludeId) : list;
    return filtered.slice(Math.max(0, filtered.length - limit));
  }

  async olderThan(agentId: string, newestKeep: number, coveredUpTo: number): Promise<Message[]> {
    const list = await this.load(agentId);
    const cutoffIndex = Math.max(0, list.length - newestKeep);
    return list
      .slice(0, cutoffIndex)
      .filter((message) => message.createdAt > coveredUpTo);
  }

  async count(agentId: string): Promise<number> {
    return (await this.load(agentId)).length;
  }

  async clear(agentId: string): Promise<void> {
    this.cache.set(agentId, []);
    await rm(this.file(agentId), { force: true });
  }

  private async load(agentId: string): Promise<Message[]> {
    const cached = this.cache.get(agentId);
    if (cached) return cached;

    let raw = '';
    try {
      raw = await readFile(this.file(agentId), 'utf8');
    } catch {
      this.cache.set(agentId, []);
      return this.cache.get(agentId) as Message[];
    }

    const list: Message[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        list.push(JSON.parse(trimmed) as Message);
      } catch {
        // skip corrupted line
      }
    }
    this.cache.set(agentId, list);
    return list;
  }
}
