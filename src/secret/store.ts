import { readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissingFile, writeJsonAtomic } from '../storage/atomic-json.js';

interface SecretRecord {
  name: string;
  value: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 密钥存储。
 *
 * 参见 docs/工具参考.md「密钥框」：
 * 值不进对话原文、不进记忆明文，智能体也看不到明文——
 * 它只拿到一个名字，之后用名字引用。
 *
 * 落盘位置：<dataDir>/secrets.json（文件权限 0600）。
 * 诚实说明：这是本机明文存储，不是保险箱；文档里已标注。
 */
export class SecretStore {
  private cache: SecretRecord[] | null = null;
  private loading?: Promise<SecretRecord[]>;
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'secrets.json');
  }

  async put(name: string, value: string): Promise<SecretRecord> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('密钥需要一个名字，之后用它引用');
    if (!value) throw new Error('密钥内容为空');

    const list = await this.load();
    const now = Date.now();
    const existing = list.find((item) => item.name === trimmed);
    if (existing) {
      existing.value = value;
      existing.updatedAt = now;
      await this.save(list);
      return { ...existing, value: '' };
    }

    list.push({ name: trimmed, value, createdAt: now, updatedAt: now });
    await this.save(list);
    return { name: trimmed, value: '', createdAt: now, updatedAt: now };
  }

  /** 供工具内部取用；不要把它交给模型 */
  async read(name: string): Promise<string | undefined> {
    const list = await this.load();
    return list.find((item) => item.name === name)?.value;
  }

  /** 列出名字（不含值），让智能体知道有哪些可用 */
  async names(): Promise<string[]> {
    return (await this.load()).map((item) => item.name);
  }

  async remove(name: string): Promise<boolean> {
    const list = await this.load();
    const before = list.length;
    const next = list.filter((item) => item.name !== name);
    if (next.length === before) return false;
    await this.save(next);
    return true;
  }

  private async load(): Promise<SecretRecord[]> {
    if (this.cache) return this.cache;
    if (!this.loading) {
      this.loading = (async () => {
        let list: SecretRecord[] = [];
        try {
          const raw = await readFile(this.file, 'utf8');
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) list = parsed as SecretRecord[];
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
        this.cache = list;
        return list;
      })();
    }
    try {
      return await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  private async save(list: SecretRecord[]): Promise<void> {
    this.cache = list;
    await writeJsonAtomic(this.file, list, { mode: 0o600 });
    await chmod(this.file, 0o600).catch(() => undefined);
  }
}
