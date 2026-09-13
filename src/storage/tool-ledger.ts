import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ToolInvocationPort,
  ToolInvocationRecord,
  ToolInvocationStart,
} from './ports.js';
import { isMissingFile, writeJsonAtomic } from './atomic-json.js';

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
  private loading?: Promise<void>;

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
    result: { status: 'ok' | 'error' | 'unknown'; summary?: string; error?: string; durationMs?: number; outcome?: ToolInvocationRecord['outcome'] },
  ): Promise<ToolInvocationRecord | undefined> {
    await this.load();
    const record = this.records.find((item) => item.id === id);
    if (!record) return undefined;
    record.status = result.status;
    record.endedAt = Date.now();
    if (result.durationMs !== undefined) record.durationMs = result.durationMs;
    if (result.summary) record.resultSummary = truncate(result.summary, 500);
    if (result.error) record.error = truncate(result.error, 500);
    if (result.outcome) record.outcome = result.outcome;
    await this.save();
    return record;
  }

  /** 没有结果的调用（started=本进程在飞；unknown=上次进程退出留下的） */
  async unfinished(): Promise<ToolInvocationRecord[]> {
    await this.load();
    return this.records.filter((item) => item.status === 'started' || item.status === 'unknown');
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
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const raw = await readFile(this.file, 'utf8');
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) this.records = parsed as ToolInvocationRecord[];
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
        this.loaded = true;
      })();
    }
    try {
      await this.loading;
    } finally {
      if (this.loaded) this.loading = undefined;
    }
  }

  private prune(): void {
    if (this.records.length <= this.limit) return;
    const open = this.records.filter((item) => item.status === 'started' || item.status === 'unknown');
    const closed = this.records.filter((item) => item.status !== 'started' && item.status !== 'unknown');
    const room = Math.max(0, this.limit - open.length);
    const kept = [...(room > 0 ? closed.slice(-room) : []), ...open];
    kept.sort((left, right) => left.startedAt - right.startedAt);
    this.records = kept;
  }

  private async save(): Promise<void> {
    await writeJsonAtomic(this.file, this.records);
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
