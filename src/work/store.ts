import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { isMissingFile, writeJsonAtomic } from '../storage/atomic-json.js';
import type { WorkRepositoryPort } from '../storage/ports.js';
import type { WorkItem, WorkStep } from './item.js';

/**
 * 工作的 JSON 持久化（E4.1）：`work/items.json` 一次装下全部工作与步骤。
 *
 * 为什么是单文件而不是每个同事一个：工作总量远小于消息（一件工作一行），
 * 单文件可以用一次原子写保证「工作与步骤」一致；按同事分片反而要多处写。
 * 写入走 writeJsonAtomic（同文件串行 + rename），重启后 load 读回。
 *
 * 只在内存里维护索引、不缓存写；读操作都从内存返回，避免每次查询都解析文件。
 */

interface StoredDoc {
  version: number;
  items: WorkItem[];
  steps: WorkStep[];
}

const VERSION = 1;

export class JsonWorkRepository implements WorkRepositoryPort {
  private items = new Map<string, WorkItem>();
  private steps = new Map<string, WorkStep[]>();
  private loaded = false;
  /** 并发调用只读一次盘 */
  private loading?: Promise<void>;

  constructor(private readonly dataDir: string) {}

  private get file(): string {
    return join(this.dataDir, 'work', 'items.json');
  }

  /** 首次使用前读回（懒加载，避免依赖启动顺序）；文件损坏时明确失败 */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) this.loading = this.doLoad();
    await this.loading;
  }

  private async doLoad(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const doc = JSON.parse(raw) as StoredDoc;
      if (doc.version !== VERSION || !Array.isArray(doc.items) || !Array.isArray(doc.steps)) {
        throw new Error('工作账本格式无效');
      }
      this.items = new Map(doc.items.map((item) => [item.id, item]));
      this.steps = new Map();
      for (const step of doc.steps) {
        const list = this.steps.get(step.workId) ?? [];
        list.push(step);
        this.steps.set(step.workId, list);
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.items = new Map();
      this.steps = new Map();
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const doc: StoredDoc = {
      version: VERSION,
      items: [...this.items.values()],
      steps: [...this.steps.values()].flat(),
    };
    await writeJsonAtomic(this.file, doc, { mode: 0o600 });
  }

  private async ready(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  async save(work: WorkItem): Promise<void> {
    await this.ready();
    this.items.set(work.id, { ...work });
    await this.persist();
  }

  async get(workId: string): Promise<WorkItem | undefined> {
    await this.ready();
    const found = this.items.get(workId);
    return found
      ? { ...found, artifactIds: [...found.artifactIds], acceptance: [...found.acceptance] }
      : undefined;
  }

  async listByAgent(agentId: string): Promise<WorkItem[]> {
    await this.ready();
    return [...this.items.values()]
      .filter((item) => item.ownerAgentId === agentId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((item) => ({ ...item, artifactIds: [...item.artifactIds], acceptance: [...item.acceptance] }));
  }

  async update(work: WorkItem, expectedRevision: number): Promise<boolean> {
    await this.ready();
    const current = this.items.get(work.id);
    // 不存在或版本已被别人推进：拒绝，让调用方重新读一次再改
    if (!current || current.revision !== expectedRevision) return false;
    this.items.set(work.id, { ...work });
    await this.persist();
    return true;
  }

  async appendStep(step: WorkStep): Promise<void> {
    await this.ready();
    const list = this.steps.get(step.workId) ?? [];
    const index = list.findIndex((item) => item.id === step.id);
    if (index >= 0) list[index] = { ...step };
    else list.push({ ...step });
    this.steps.set(step.workId, list);
    await this.persist();
  }

  async listSteps(workId: string): Promise<WorkStep[]> {
    await this.ready();
    return (this.steps.get(workId) ?? []).map((step) => ({ ...step }));
  }

  async clear(agentId: string): Promise<void> {
    await this.ready();
    for (const [id, item] of this.items) {
      if (item.ownerAgentId === agentId) {
        this.items.delete(id);
        this.steps.delete(id);
      }
    }
    await this.persist();
  }
}
