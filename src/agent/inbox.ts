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
  /**
   * stop = 停止令（递归砍树，drain 时排最前、不进模型）；
   * stop-ack = 下级回报「已停」，只用于计数，也不进模型；
   * 缺省 = 普通信。
   */
  kind?: 'message' | 'stop' | 'stop-ack';
  /** 要作废的任务树；空 = 作废接收方当前全部 open 树 */
  treeId?: string;
  createdAt: number;
}

/** drain 的处理顺序：停止令最前，其余保持到达顺序（优先信在入队时已插队首） */
export function sortInboxForDrain(list: InboxItem[]): InboxItem[] {
  const rank = (item: InboxItem): number => (item.kind === 'stop' ? 0 : 1);
  return [...list].sort((left, right) => rank(left) - rank(right));
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

  /** 取出全部积压并清空——同一批在下一回合一起处理；停止令排最前 */
  async drain(agentId: string): Promise<InboxItem[]> {
    const list = await this.load(agentId);
    if (list.length === 0) return [];
    this.cache.set(agentId, []);
    await rm(this.file(agentId), { force: true });
    return sortInboxForDrain(list);
  }

  async peek(agentId: string): Promise<InboxItem[]> {
    return [...(await this.load(agentId))];
  }

  /** 取出满足条件的信（其余保留原序）——stop-ack 的消费入口 */
  async take(agentId: string, predicate: (item: InboxItem) => boolean): Promise<InboxItem[]> {
    const list = await this.load(agentId);
    const taken = list.filter(predicate);
    if (taken.length === 0) return [];
    const rest = list.filter((item) => !predicate(item));
    this.cache.set(agentId, rest);
    await this.save(agentId, rest);
    return taken;
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
