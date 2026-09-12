import { existsSync, readFileSync, writeFile } from 'node:fs';
import { dirname, join } from 'node:path';

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

  constructor(dataDir: string) {
    this.file = join(dataDir, 'received', 'index.json');
    this.cache = new Map();
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, ReceivedRecord>;
        for (const [key, value] of Object.entries(parsed)) this.cache.set(key, value);
      }
    } catch {
      // 损坏文件视为空日志
    }
  }

  /** 只读查询：该幂等键是否已接收过 */
  find(clientMessageId: string): ReceivedRecord | undefined {
    return this.cache.get(clientMessageId);
  }

  /** 登记幂等键 → 原消息映射 */
  record(clientMessageId: string, record: ReceivedRecord): void {
    this.cache.set(clientMessageId, record);
    this.flush();
  }

  private flush(): void {
    try {
      const obj: Record<string, ReceivedRecord> = {};
      for (const [key, value] of this.cache) obj[key] = value;
      const dir = dirname(this.file);
      import('node:fs').then((fs) => {
        fs.mkdirSync(dir, { recursive: true });
        writeFile(this.file, JSON.stringify(obj, null, 2), () => undefined);
      });
    } catch {
      // 落盘失败不阻塞回合（下次 flush 会重试）
    }
  }
}
