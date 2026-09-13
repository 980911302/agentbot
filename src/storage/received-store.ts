import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-json.js';

/**
 * ReceivedStore（E3.2）：接收幂等日志。
 * clientMessageId → 原消息定位；重复提交不再开新回合，而是返回原消息。
 * 内存缓存 + 整文件落盘（单用户本地场景；E3.1 的 SQLite 迁移落地后并入同事务）。
 */
export interface ReceivedRecord {
  messageId: string;
  agentId: string;
}

export class ReceivedStore {
  private readonly file: string;
  private readonly cache: Map<string, ReceivedRecord>;
  private mutation: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = join(dataDir, 'received', 'index.json');
    this.cache = new Map();
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, ReceivedRecord>;
        for (const [key, value] of Object.entries(parsed)) this.cache.set(key, value);
      }
    } catch (error) {
      throw new Error(`接收幂等日志损坏：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 只读查询：该幂等键是否已接收过 */
  find(clientMessageId: string): ReceivedRecord | undefined {
    return this.cache.get(clientMessageId);
  }

  /** 登记幂等键 → 原消息映射 */
  async record(clientMessageId: string, record: ReceivedRecord): Promise<void> {
    const operation = this.mutation.catch(() => undefined).then(async () => {
      const previous = this.cache.get(clientMessageId);
      this.cache.set(clientMessageId, record);
      try {
        await this.flush();
      } catch (error) {
        if (previous) this.cache.set(clientMessageId, previous);
        else this.cache.delete(clientMessageId);
        throw error;
      }
    });
    this.mutation = operation;
    await operation;
  }

  private async flush(): Promise<void> {
    const obj: Record<string, ReceivedRecord> = {};
    for (const [key, value] of this.cache) obj[key] = value;
    await writeJsonAtomic(this.file, obj);
  }
}
