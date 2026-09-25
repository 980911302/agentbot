import { mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isMissingFile } from './atomic-json.js';

export interface JsonlLogOptions {
  /** 缓存里最多留几个 key（按最近使用淘汰，防长跑进程被历史对话占满） */
  cacheMaxKeys?: number;
}

/** 单实例追加日志：读取、尾部修复、追加和清空共用同一把锁。 */
export class JsonlLog<T> {
  private readonly cache = new Map<string, T[]>();
  /** key → 访问序号，用于 LRU 淘汰 */
  private readonly touched = new Map<string, number>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly cacheMaxKeys: number;
  private clock = 0;

  constructor(
    private readonly dir: string,
    options: JsonlLogOptions = {},
  ) {
    this.cacheMaxKeys = Math.max(1, Math.floor(options.cacheMaxKeys ?? 64));
  }

  list(key: string): Promise<T[]> {
    return this.serial(key, async () => [...(await this.load(key))]);
  }

  /**
   * 只读视图：不拷贝，直接给缓存里的那份数组。
   * 约定：调用方只读，不要改；后续 append 会让它变长（需要快照就用 list）。
   */
  view(key: string): Promise<readonly T[]> {
    return this.serial(key, async () => this.load(key));
  }

  /** 最近 limit 条：只复制尾部，不整条线拷贝 */
  async tail(key: string, limit: number): Promise<T[]> {
    const all = await this.serial(key, async () => this.load(key));
    const size = Math.floor(limit);
    if (!Number.isFinite(size) || size <= 0) return [];
    return all.slice(Math.max(0, all.length - size));
  }

  /** 按谓词过滤（谓词拿到的是缓存里的对象，同样只读） */
  filter(key: string, predicate: (entry: T) => boolean): Promise<T[]> {
    return this.serial(key, async () => (await this.load(key)).filter(predicate));
  }

  /** 当前缓存着哪些 key（排查与测试用） */
  cachedKeys(): string[] {
    return [...this.cache.keys()];
  }

  /** 主动丢弃某个 key 的缓存，下次读取重新加载 */
  drop(key: string): void {
    this.cache.delete(key);
    this.touched.delete(key);
  }

  append(key: string, value: T): Promise<void> {
    return this.serial(key, async () => {
      const entries = await this.load(key);
      await mkdir(this.dir, { recursive: true });
      try {
        await writeFile(this.file(key), `${JSON.stringify(value)}\n`, { flag: 'a', mode: 0o600 });
        entries.push(value);
      } catch (error) {
        // 写失败可能留下半行；下次操作必须重新核对磁盘。
        this.cache.delete(key);
        throw error;
      }
    });
  }

  clear(key: string): Promise<void> {
    return this.serial(key, async () => {
      await rm(this.file(key), { force: true });
      this.cache.set(key, []);
      this.touch(key);
    });
  }

  /**
   * 停机用（E8.4）：等在飞的写入落盘，然后丢掉缓存。
   * 这里刻意**不**在关闭后拒绝写入：停机窗口里宁可多写一份，也不能把数据吞掉。
   * 它保证的是「close() 返回时，此前的写入都已经落到磁盘」——放锁前的最后一道落盘。
   */
  async close(): Promise<void> {
    await Promise.allSettled([...this.mutations.values()]);
    this.cache.clear();
    this.touched.clear();
  }

  private file(key: string): string {
    return join(this.dir, `${key}.jsonl`);
  }

  private async load(key: string): Promise<T[]> {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const file = this.file(key);
    let raw: Buffer;
    try {
      raw = await readFile(file);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const empty: T[] = [];
      this.cache.set(key, empty);
      this.touch(key);
      return empty;
    }
    const entries: T[] = [];
    for (let start = 0; start < raw.length;) {
      const newline = raw.indexOf(10, start);
      const end = newline < 0 ? raw.length : newline;
      const line = raw.subarray(start, end).toString('utf8').trim();
      if (line) {
        try {
          entries.push(JSON.parse(line) as T);
        } catch (error) {
          // 只修复最后一条非空记录；中间损坏绝不静默删除。
          if (raw.subarray(end).toString('utf8').trim()) throw error;
          // 先保存原始字节再截断；备份失败则拒绝追加，保留现场。
          await writeFile(`${file}.corrupt-${randomUUID()}`, raw.subarray(start), {
            flag: 'wx',
            mode: 0o600,
          });
          await truncate(file, start);
          raw = raw.subarray(0, start);
          break;
        }
      }
      start = newline < 0 ? raw.length : newline + 1;
    }
    // 完整 JSON 但没换行时补分隔符，避免下一条粘连。
    if (raw.length && raw[raw.length - 1] !== 10) await writeFile(file, '\n', { flag: 'a' });
    this.cache.set(key, entries);
    this.touch(key);
    return entries;
  }

  /** 记一次访问；超出上限就按最久未访问淘汰 */
  private touch(key: string): void {
    this.touched.set(key, ++this.clock);
    if (this.cache.size <= this.cacheMaxKeys) return;
    const victims = [...this.touched.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, this.cache.size - this.cacheMaxKeys);
    for (const [stale] of victims) this.drop(stale);
  }

  private async serial<R>(key: string, operation: () => Promise<R>): Promise<R> {
    const previous = this.mutations.get(key)?.catch(() => undefined) ?? Promise.resolve();
    const pending = previous.then(operation);
    this.mutations.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.mutations.get(key) === pending) this.mutations.delete(key);
    }
  }
}
