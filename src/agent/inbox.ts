import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/**
 * 智能体之间 1:1 的收件箱。
 *
 * 文档第 4.2 节：发出去就结束，不等对方回完；
 * 对方忙就排队，轮到它时同一批积压的消息一起到；
 * 它的回复是之后一个新回合，不是函数返回值。
 */
export interface InboxItem {
  id: string;
  toAgentId: string;
  fromAgentId: string;
  fromName: string;
  text: string;
  priority: boolean;
  /** 传话链深度，防止两个智能体无限互发 */
  depth: number;
  createdAt: number;
}

export class AgentInbox {
  private readonly cache = new Map<string, InboxItem[]>();
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'inbox');
  }

  private file(agentId: string): string {
    return join(this.dir, `${agentId}.json`);
  }

  async enqueue(item: Omit<InboxItem, 'id' | 'createdAt'>): Promise<InboxItem> {
    const list = await this.load(item.toAgentId);
    const full: InboxItem = { ...item, id: randomUUID(), createdAt: Date.now() };
    // 标优先的插到队首，其余按到达顺序
    if (full.priority) list.unshift(full);
    else list.push(full);
    await this.save(item.toAgentId, list);
    return full;
  }

  /** 取出全部积压并清空——同一批在下一回合一起处理 */
  async drain(agentId: string): Promise<InboxItem[]> {
    const list = await this.load(agentId);
    if (list.length === 0) return [];
    this.cache.set(agentId, []);
    await rm(this.file(agentId), { force: true });
    return list;
  }

  async peek(agentId: string): Promise<InboxItem[]> {
    return [...(await this.load(agentId))];
  }

  async count(agentId: string): Promise<number> {
    return (await this.load(agentId)).length;
  }

  async clear(agentId: string): Promise<void> {
    this.cache.set(agentId, []);
    await rm(this.file(agentId), { force: true });
  }

  private async load(agentId: string): Promise<InboxItem[]> {
    const cached = this.cache.get(agentId);
    if (cached) return cached;

    let list: InboxItem[] = [];
    try {
      const raw = await readFile(this.file(agentId), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) list = parsed as InboxItem[];
    } catch {
      // 空箱
    }
    this.cache.set(agentId, list);
    return list;
  }

  private async save(agentId: string, list: InboxItem[]): Promise<void> {
    const file = this.file(agentId);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(list, null, 2), 'utf8');
  }
}
