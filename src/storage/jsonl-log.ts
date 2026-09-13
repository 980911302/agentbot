import { mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isMissingFile } from './atomic-json.js';

/** 单实例追加日志：读取、尾部修复、追加和清空共用同一把锁。 */
export class JsonlLog<T> {
  private readonly cache = new Map<string, T[]>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  constructor(private readonly dir: string) {}

  list(key: string): Promise<T[]> {
    return this.serial(key, async () => [...await this.load(key)]);
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
    });
  }

  private file(key: string): string { return join(this.dir, `${key}.jsonl`); }

  private async load(key: string): Promise<T[]> {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const file = this.file(key);
    let raw: Buffer;
    try { raw = await readFile(file); }
    catch (error) {
      if (!isMissingFile(error)) throw error;
      const empty: T[] = []; this.cache.set(key, empty); return empty;
    }
    const entries: T[] = [];
    for (let start = 0; start < raw.length;) {
      const newline = raw.indexOf(10, start);
      const end = newline < 0 ? raw.length : newline;
      const line = raw.subarray(start, end).toString('utf8').trim();
      if (line) {
        try { entries.push(JSON.parse(line) as T); }
        catch (error) {
          // 只修复最后一条非空记录；中间损坏绝不静默删除。
          if (raw.subarray(end).toString('utf8').trim()) throw error;
          // 先保存原始字节再截断；备份失败则拒绝追加，保留现场。
          await writeFile(`${file}.corrupt-${randomUUID()}`, raw.subarray(start), { flag: 'wx', mode: 0o600 });
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
    return entries;
  }

  private async serial<R>(key: string, operation: () => Promise<R>): Promise<R> {
    const previous = this.mutations.get(key)?.catch(() => undefined) ?? Promise.resolve();
    const pending = previous.then(operation);
    this.mutations.set(key, pending);
    try { return await pending; }
    finally { if (this.mutations.get(key) === pending) this.mutations.delete(key); }
  }
}
