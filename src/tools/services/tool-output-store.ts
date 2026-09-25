import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ToolResult } from '../../shared/contracts/tool-result.js';

export interface OutputRecord {
  id: string;
  ownerId: string;
  createdAt: number;
  closed: boolean;
  totalBytes: number;
  retainedBytes: number;
  storageTruncated: boolean;
  execution?: ToolResult['execution'];
  command?: string;
}

/** 有界持久原文。游标统一使用 UTF-8 字节；不接受模型提供的磁盘路径。 */
export class ToolOutputStore {
  private readonly records = new Map<string, OutputRecord>();
  private readonly active = new Set<string>();
  private readonly dir: string;
  private bytes = 0;
  private readonly perFile: number;
  private readonly total: number;
  private readonly ttl: number;
  private readonly maxRecords: number;

  constructor(
    dataDir: string,
    options: {
      maxFileBytes?: number;
      maxTotalBytes?: number;
      retentionMs?: number;
      maxRecords?: number;
    } = {},
  ) {
    this.dir = join(dataDir, 'tools', 'outputs');
    this.perFile = options.maxFileBytes ?? 32 * 1024 * 1024;
    this.total = options.maxTotalBytes ?? 256 * 1024 * 1024;
    this.ttl = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    this.maxRecords = options.maxRecords ?? 1000;
    if (
      ![this.perFile, this.total, this.maxRecords].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) ||
      !Number.isSafeInteger(this.ttl) ||
      this.ttl < 0
    )
      throw new Error('日志配额必须是正整数，保留期限必须是非负整数');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.dir)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const record = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as OutputRecord;
      if (name !== `${record.id}.json` || !existsSync(this.path(record.id))) continue;
      record.retainedBytes = statSync(this.path(record.id)).size;
      record.totalBytes = Math.max(record.totalBytes, record.retainedBytes);
      if (!record.closed) {
        record.closed = true;
        if (record.execution?.state === 'running')
          record.execution = { ...record.execution, state: 'interrupted', exitCode: null };
        this.save(record);
      }
      this.records.set(record.id, record);
      this.bytes += record.retainedBytes;
    }
    this.prune();
  }

  create(ownerId: string, shell?: { id?: string; command: string }): OutputRecord {
    this.prune();
    while (this.records.size >= this.maxRecords && this.evictOldest()) {
      /* 只清理已结束日志 */
    }
    if (this.records.size >= this.maxRecords) throw new Error('日志记录额度已满，请先结束已有任务');
    const id = shell?.id ?? randomUUID();
    this.assertId(id);
    if (this.records.has(id)) throw new Error('日志 id 重复');
    const record: OutputRecord = {
      id,
      ownerId,
      createdAt: Date.now(),
      closed: false,
      totalBytes: 0,
      retainedBytes: 0,
      storageTruncated: false,
      ...(shell
        ? { command: shell.command, execution: { id, state: 'running' as const, exitCode: null } }
        : {}),
    };
    writeFileSync(this.path(id), '', { flag: 'wx', mode: 0o600 });
    this.save(record);
    this.records.set(id, record);
    this.active.add(id);
    return record;
  }

  append(id: string, text: string): void {
    const record = this.require(id);
    if (record.closed) throw new Error('日志已关闭');
    const buffer = Buffer.from(text);
    record.totalBytes += buffer.length;
    if (!record.storageTruncated) {
      while (
        this.bytes + Math.min(buffer.length, this.perFile - record.retainedBytes) > this.total &&
        this.evictOldest()
      ) {
        /* 不删除活跃日志 */
      }
      let keep = Math.max(
        0,
        Math.min(buffer.length, this.perFile - record.retainedBytes, this.total - this.bytes),
      );
      while (keep > 0 && keep < buffer.length && (buffer[keep]! & 0xc0) === 0x80) keep--;
      if (keep) appendFileSync(this.path(id), buffer.subarray(0, keep));
      record.retainedBytes += keep;
      this.bytes += keep;
      record.storageTruncated = keep < buffer.length;
    }
    this.save(record);
  }

  finish(id: string, execution?: ToolResult['execution']): void {
    const record = this.require(id);
    record.closed = true;
    if (execution) record.execution = execution;
    this.save(record);
    this.active.delete(id);
  }

  get(id: string, ownerId: string): OutputRecord {
    this.prune();
    const record = this.require(id);
    if (record.ownerId !== ownerId) throw new Error('不能访问其他智能体的日志');
    return { ...record, execution: record.execution ? { ...record.execution } : undefined };
  }

  read(
    id: string,
    ownerId: string,
    offset = 0,
    limit = 8000,
  ): { text: string; nextOffset: number; record: OutputRecord } {
    const record = this.get(id, ownerId);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.retainedBytes)
      throw new Error('offset 超出已保存日志范围');
    if (!Number.isSafeInteger(limit) || limit < 4 || limit > 12000)
      throw new Error('limit 必须在 4–12000 字节之间');
    const fd = openSync(this.path(id), 'r');
    try {
      const buffer = Buffer.alloc(Math.min(limit + 4, record.retainedBytes - offset));
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      // 任意 offset 落在 UTF-8 字符中间时拒绝，不静默漏字。
      if (read && (buffer[0]! & 0xc0) === 0x80)
        throw new Error('offset 位于 UTF-8 字符中间，请使用返回的 next_offset');
      let end = Math.min(read, limit);
      while (end > 0 && end < read && (buffer[end]! & 0xc0) === 0x80) end--;
      return { text: buffer.subarray(0, end).toString('utf8'), nextOffset: offset + end, record };
    } finally {
      closeSync(fd);
    }
  }

  /** 每次最多扫描 256 KiB；命中用字节位置返回，后续 Read 可取上下文。 */
  /** 搜索模式下 limit 的含义是「最多返回几个命中」，上限沿用扫描预算里的 30 */
  search(
    id: string,
    ownerId: string,
    query: string,
    offset = 0,
    limit = 30,
  ): { matches: number[]; nextOffset: number; record: OutputRecord } {
    if (!query || Buffer.byteLength(query) > 1000) throw new Error('query 不能为空或超过 1000 字节');
    const record = this.get(id, ownerId);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.retainedBytes)
      throw new Error('offset 超出已保存日志范围');
    const needle = Buffer.from(query);
    const end = Math.min(offset + 256 * 1024, record.retainedBytes);
    const fd = openSync(this.path(id), 'r');
    try {
      const buffer = Buffer.alloc(Math.min(end - offset + needle.length - 1, record.retainedBytes - offset));
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      const matches: number[] = [];
      const max = Math.max(1, Math.min(30, Math.floor(Number.isFinite(limit) ? limit : 30)));
      let nextOffset = end;
      for (let at = 0; at < count;) {
        const found = buffer.subarray(0, count).indexOf(needle, at);
        if (found < 0 || offset + found >= end) break;
        matches.push(offset + found);
        at = found + needle.length;
        if (matches.length >= max) {
          nextOffset = offset + at;
          break;
        }
      }
      // next_offset 也可用于普通读取，避免落在多字节字符内部。
      while (
        nextOffset < record.retainedBytes &&
        nextOffset - offset < count &&
        (buffer[nextOffset - offset]! & 0xc0) === 0x80
      )
        nextOffset++;
      return { matches, nextOffset, record };
    } finally {
      closeSync(fd);
    }
  }

  private assertId(id: string): void {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('无效的 output_id');
  }
  private path(id: string): string {
    this.assertId(id);
    return join(this.dir, `${id}.log`);
  }
  private require(id: string): OutputRecord {
    this.assertId(id);
    const record = this.records.get(id);
    if (!record) throw new Error('日志不存在或已按保留策略清理');
    return record;
  }
  private save(record: OutputRecord): void {
    const path = join(this.dir, `${record.id}.json`),
      temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    renameSync(temp, path);
  }
  private remove(record: OutputRecord): void {
    rmSync(this.path(record.id), { force: true });
    rmSync(join(this.dir, `${record.id}.json`), { force: true });
    this.records.delete(record.id);
    this.bytes -= record.retainedBytes;
  }
  private evictOldest(): boolean {
    const oldest = [...this.records.values()]
      .filter((record) => !this.active.has(record.id) && record.closed)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) return false;
    this.remove(oldest);
    return true;
  }
  private prune(): void {
    for (const record of this.records.values())
      if (record.closed && !this.active.has(record.id) && Date.now() - record.createdAt > this.ttl)
        this.remove(record);
    while ((this.bytes > this.total || this.records.size > this.maxRecords) && this.evictOldest()) {
      /* 有界启动恢复 */
    }
  }
}
