import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ToolInvocationPort,
  ToolInvocationRecord,
  ToolInvocationStart,
} from './ports.js';

/**
 * 工具执行账本（E3.5）：JSON 实现。
 *
 * 写入时机：执行前记「意图」（started），执行后回填结果（ok/error/unknown）。
 * 有意图没结果 = 中断，恢复前必须先核对；进程重启后记录仍在，所以它就是核对依据。
 * 保留上限只裁剪已完结的记录，未完结的一律留着。
 */
export class JsonToolInvocationLedger implements ToolInvocationPort {
  private readonly file: string;
  private readonly limit: number;
  private records: ToolInvocationRecord[] = [];
  private loaded = false;
  /** 顺序落盘：start/finish 可能并发，最后写入的胜出 */
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string, options: { limit?: number } = {}) {
    this.file = join(dataDir, 'tools', 'invocations.json');
    this.limit = options.limit ?? 500;
  }

  async start(input: ToolInvocationStart): Promise<ToolInvocationRecord> {
    await this.load();
    const record: ToolInvocationRecord = {
      id: randomUUID(),
      startedAt: Date.now(),
      status: 'started',
      ...input,
      ...(input.args ? { args: truncate(input.args, 400) } : {}),
    };
    this.records.push(record);
    this.prune();
    await this.save();
    return record;
  }

  async finish(
    id: string,
    result: { status: 'ok' | 'error' | 'unknown'; summary?: string; error?: string; durationMs?: number },
  ): Promise<ToolInvocationRecord | undefined> {
    await this.load();
    const record = this.records.find((item) => item.id === id);
    if (!record) return undefined;
    record.status = result.status;
    record.endedAt = Date.now();
    if (result.durationMs !== undefined) record.durationMs = result.durationMs;
    if (result.summary) record.resultSummary = truncate(result.summary, 500);
    if (result.error) record.error = truncate(result.error, 500);
    await this.save();
    return record;
  }

  async unfinished(): Promise<ToolInvocationRecord[]> {
    await this.load();
    return this.records.filter((item) => item.status === 'started');
  }

  async attemptsOf(operationKey: string): Promise<ToolInvocationRecord[]> {
    await this.load();
    return this.records.filter((item) => item.operationKey === operationKey);
  }

  async list(limit = 100): Promise<ToolInvocationRecord[]> {
    await this.load();
    return this.records.slice(-limit);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) this.records = parsed as ToolInvocationRecord[];
    } catch {
      // 还没有账本
    }
  }

  private prune(): void {
    if (this.records.length <= this.limit) return;
    const open = this.records.filter((item) => item.status === 'started');
    const closed = this.records.filter((item) => item.status !== 'started');
    const room = Math.max(0, this.limit - open.length);
    const kept = [...closed.slice(-room), ...open];
    kept.sort((left, right) => left.startedAt - right.startedAt);
    this.records = kept;
  }

  private async save(): Promise<void> {
    const payload = JSON.stringify(this.records, null, 2);
    this.writing = this.writing
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(this.file, payload, 'utf8');
      })
      .catch(() => undefined);
    await this.writing;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
