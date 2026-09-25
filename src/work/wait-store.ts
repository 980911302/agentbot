import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { isMissingFile, writeJsonAtomic } from '../storage/atomic-json.js';
import type { WorkWaitRepositoryPort } from '../storage/ports.js';
import type { WorkWait, WorkWaitStatus } from './wait.js';

/**
 * 等待的 JSON 持久化（E4.3）：`work/waits.json` 一次装下全部等待。
 *
 * 与工作账本（work/items.json）同一个目录、同一种写法：单文件 + 原子替换，
 * 重启读回内存索引。等待总量与工作同量级，单文件足够，也便于「重启后有没有
 * 还没等到的等待」一次读全。
 *
 * 密钥明文不进这里：kind=user 的 secret 卡只存变量名，值在 SecretStore。
 */

interface StoredDoc {
  version: number;
  waits: WorkWait[];
}

const VERSION = 1;

export class JsonWorkWaitRepository implements WorkWaitRepositoryPort {
  private waits = new Map<string, WorkWait>();
  private loaded = false;
  /** 并发调用只读一次盘 */
  private loading?: Promise<void>;

  constructor(private readonly dataDir: string) {}

  private get file(): string {
    return join(this.dataDir, 'work', 'waits.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) this.loading = this.doLoad();
    await this.loading;
  }

  private async doLoad(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const doc = JSON.parse(raw) as StoredDoc;
      if (doc.version !== VERSION || !Array.isArray(doc.waits)) throw new Error('等待账本格式无效');
      this.waits = new Map(doc.waits.map((wait) => [wait.id, wait]));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.waits = new Map();
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const doc: StoredDoc = { version: VERSION, waits: [...this.waits.values()] };
    await writeJsonAtomic(this.file, doc, { mode: 0o600 });
  }

  private async ready(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private copy(wait: WorkWait): WorkWait {
    return {
      ...wait,
      ...(wait.card ? { card: { ...wait.card, options: wait.card.options?.map((o) => ({ ...o })) } } : {}),
    };
  }

  async save(wait: WorkWait): Promise<void> {
    await this.ready();
    this.waits.set(wait.id, this.copy(wait));
    await this.persist();
  }

  async get(waitId: string): Promise<WorkWait | undefined> {
    await this.ready();
    const found = this.waits.get(waitId);
    return found ? this.copy(found) : undefined;
  }

  async listAll(): Promise<WorkWait[]> {
    await this.ready();
    return [...this.waits.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((wait) => this.copy(wait));
  }

  async listByAgent(agentId: string): Promise<WorkWait[]> {
    await this.ready();
    return [...this.waits.values()]
      .filter((wait) => wait.agentId === agentId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((wait) => this.copy(wait));
  }

  async findByCorrelation(correlationId: string, status?: WorkWaitStatus): Promise<WorkWait[]> {
    await this.ready();
    return [...this.waits.values()]
      .filter((wait) => wait.correlationId === correlationId && (!status || wait.status === status))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((wait) => this.copy(wait));
  }

  async update(wait: WorkWait, expectedStatus: WorkWaitStatus): Promise<boolean> {
    await this.ready();
    const current = this.waits.get(wait.id);
    // 不存在或状态已被别人推进（例如刚刚被作废/过期）：拒绝，调用方重新读一次再决定
    if (!current || current.status !== expectedStatus) return false;
    this.waits.set(wait.id, this.copy(wait));
    await this.persist();
    return true;
  }

  async clear(agentId: string): Promise<void> {
    await this.ready();
    for (const [id, wait] of this.waits) if (wait.agentId === agentId) this.waits.delete(id);
    await this.persist();
  }
}
