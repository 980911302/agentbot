import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { isMissingFile, writeJsonAtomic } from '../storage/atomic-json.js';
import type { DelegationRepositoryPort } from '../storage/ports.js';
import type { Delegation, DelegationStatus } from './delegation.js';

/**
 * 委派的 JSON 持久化（E4.4）：`work/delegations.json` 一次装下全部委派。
 *
 * 与工作/等待账本同一个目录、同一种写法：单文件 + 原子替换，重启读回内存索引。
 * 委派关系必须跨重启活着——停止令与回信线程都靠它，「我派过谁哪件事」丢了
 * 就只能退回按人粗放停止。
 */

interface StoredDoc {
  version: number;
  delegations: Delegation[];
}

const VERSION = 1;

export class JsonDelegationRepository implements DelegationRepositoryPort {
  private delegations = new Map<string, Delegation>();
  private loaded = false;
  /** 并发调用只读一次盘 */
  private loading?: Promise<void>;

  constructor(private readonly dataDir: string) {}

  private get file(): string {
    return join(this.dataDir, 'work', 'delegations.json');
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
      if (doc.version !== VERSION || !Array.isArray(doc.delegations)) throw new Error('委派账本格式无效');
      this.delegations = new Map(doc.delegations.map((delegation) => [delegation.id, delegation]));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.delegations = new Map();
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const doc: StoredDoc = { version: VERSION, delegations: [...this.delegations.values()] };
    await writeJsonAtomic(this.file, doc, { mode: 0o600 });
  }

  private async ready(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private copy(delegation: Delegation): Delegation {
    return { ...delegation };
  }

  async save(delegation: Delegation): Promise<void> {
    await this.ready();
    this.delegations.set(delegation.id, this.copy(delegation));
    await this.persist();
  }

  async get(delegationId: string): Promise<Delegation | undefined> {
    await this.ready();
    const found = this.delegations.get(delegationId);
    return found ? this.copy(found) : undefined;
  }

  async listFrom(agentId: string): Promise<Delegation[]> {
    await this.ready();
    return [...this.delegations.values()]
      .filter((delegation) => delegation.fromAgentId === agentId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((delegation) => this.copy(delegation));
  }

  async update(delegation: Delegation, expectedStatus: DelegationStatus): Promise<boolean> {
    await this.ready();
    const current = this.delegations.get(delegation.id);
    // 不存在或状态已被别人推进（例如刚被取消/已回信）：拒绝，调用方重新读一次再决定
    if (!current || current.status !== expectedStatus) return false;
    this.delegations.set(delegation.id, this.copy(delegation));
    await this.persist();
    return true;
  }
}
