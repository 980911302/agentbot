import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { judgeDuplicate, memoryKey } from './dedup.js';
import { DEMOTE_TARGET, TIER_POLICY, USER_OWNER, isExpired } from './policy.js';
import type {
  MemoryBucket,
  MemoryEntry,
  MemoryEntryView,
  MemoryScope,
  MemorySnapshot,
  MemorySource,
  MemoryTier,
} from './types.js';

export interface WriteMemoryInput {
  scope: MemoryScope;
  tier: MemoryTier;
  ownerId: string;
  text: string;
  tags?: string[];
  source?: MemorySource;
  sourceMessageId?: string;
  /** 用户明确要求记住时，覆盖自动判定的层级 */
  force?: boolean;
}

export interface WriteMemoryResult {
  entry: MemoryEntry;
  action: 'created' | 'merged' | 'updated';
  replaced?: MemoryEntry;
}

interface ScopeDoc {
  entries: MemoryEntry[];
}

const EMPTY: ScopeDoc = { entries: [] };

/**
 * 长期记忆存储。
 *
 * 文件布局（对应文档第 6 节的作用域）：
 *   memory/user.json             共用的「关于你」
 *   memory/agents/<agentId>.json 某个智能体自己的笔记
 *   memory/projects/<id>.json    某个项目的笔记
 *
 * 群没有作用域：群话若被记住，是某个智能体写进自己的笔记。
 */
export class MemoryStore {
  private readonly cache = new Map<string, ScopeDoc>();
  private readonly baseDir: string;

  constructor(dataDir: string) {
    this.baseDir = join(dataDir, 'memory');
  }

  private pathFor(scope: MemoryScope, ownerId: string): string {
    if (scope === 'user') return join(this.baseDir, 'user.json');
    if (scope === 'project') return join(this.baseDir, 'projects', `${ownerId}.json`);
    return join(this.baseDir, 'agents', `${ownerId}.json`);
  }

  // ── 读 ──────────────────────────────────────────────

  /** 某作用域下的全部条目（含已过期清理） */
  async list(scope: MemoryScope, ownerId: string): Promise<MemoryEntry[]> {
    const doc = await this.load(scope, ownerId);
    const cleaned = this.sweep(doc);
    if (cleaned.changed) await this.save(scope, ownerId, doc);
    return [...doc.entries];
  }

  /**
   * 某个智能体当前能看到的全部记忆：
   * 只有它自己的 + 所有智能体共用的「关于你」(+ 参与项目的笔记)。
   * 看不到别的智能体的私聊与笔记。
   */
  async visibleTo(
    agentId: string,
    options: { projectIds?: string[] } = {},
  ): Promise<{ entry: MemoryEntry; scope: MemoryScope; ownerId: string }[]> {
    const out: { entry: MemoryEntry; scope: MemoryScope; ownerId: string }[] = [];

    for (const entry of await this.list('self', agentId)) {
      out.push({ entry, scope: 'self', ownerId: agentId });
    }
    for (const entry of await this.list('user', USER_OWNER)) {
      out.push({ entry, scope: 'user', ownerId: USER_OWNER });
    }
    for (const projectId of options.projectIds ?? []) {
      for (const entry of await this.list('project', projectId)) {
        out.push({ entry, scope: 'project', ownerId: projectId });
      }
    }
    return out;
  }

  // ── 写 ──────────────────────────────────────────────

  async write(input: WriteMemoryInput): Promise<WriteMemoryResult> {
    const doc = await this.load(input.scope, input.ownerId);
    this.sweep(doc);

    const text = input.text.trim().slice(0, 2000);
    const key = memoryKey(text);
    const now = Date.now();

    const existing = this.findDuplicateEntry(doc, text, key);

    if (existing) {
      const tighter = rank(input.tier) < rank(existing.tier) ? input.tier : existing.tier;
      // 共用事实冲突时，更新的覆盖旧的（文档第 6 节）
      const overwrite = input.scope === 'user' || input.force === true;
      if (overwrite) {
        existing.text = text;
        existing.key = key;
      }
      existing.tier = tighter;
      existing.updatedAt = now;
      existing.hits += 1;
      existing.source = input.source ?? existing.source;
      if (input.tags?.length) {
        existing.tags = [...new Set([...existing.tags, ...input.tags])];
      }
      await this.save(input.scope, input.ownerId, doc);
      return { entry: existing, action: overwrite ? 'updated' : 'merged' };
    }

    const entry: MemoryEntry = {
      id: randomUUID(),
      scope: input.scope,
      tier: input.tier,
      ownerId: input.ownerId,
      text,
      key,
      tags: input.tags?.filter(Boolean).slice(0, 6) ?? [],
      source: input.source ?? 'agent',
      createdAt: now,
      updatedAt: now,
      lastSurfacedAt: null,
      hits: 0,
      sourceMessageId: input.sourceMessageId,
    };

    doc.entries.push(entry);
    const demoted = await this.enforce(doc, input.scope, input.ownerId);
    await this.save(input.scope, input.ownerId, doc);

    return { entry, action: 'created', replaced: demoted };
  }

  async update(
    scope: MemoryScope,
    ownerId: string,
    entryId: string,
    patch: { tier?: MemoryTier; text?: string; tags?: string[] },
  ): Promise<MemoryEntry | undefined> {
    const doc = await this.load(scope, ownerId);
    const entry = doc.entries.find((item) => item.id === entryId);
    if (!entry) return undefined;
    if (patch.text !== undefined) {
      entry.text = patch.text.trim();
      entry.key = memoryKey(entry.text);
    }
    if (patch.tags) entry.tags = patch.tags;
    if (patch.tier) entry.tier = patch.tier;
    entry.updatedAt = Date.now();
    await this.enforce(doc, scope, ownerId);
    await this.save(scope, ownerId, doc);
    return entry;
  }

  async remove(scope: MemoryScope, ownerId: string, entryId: string): Promise<boolean> {
    const doc = await this.load(scope, ownerId);
    const before = doc.entries.length;
    doc.entries = doc.entries.filter((item) => item.id !== entryId);
    if (doc.entries.length === before) return false;
    await this.save(scope, ownerId, doc);
    return true;
  }

  /** 把条目标成「刚被用到」，用于老化统计 */
  async touch(scope: MemoryScope, ownerId: string, entryIds: string[]): Promise<void> {
    if (entryIds.length === 0) return;
    const doc = await this.load(scope, ownerId);
    const now = Date.now();
    let changed = false;
    for (const entry of doc.entries) {
      if (!entryIds.includes(entry.id)) continue;
      entry.lastSurfacedAt = now;
      entry.hits += 1;
      changed = true;
    }
    if (changed) await this.save(scope, ownerId, doc);
  }

  async clear(scope: MemoryScope, ownerId: string): Promise<void> {
    this.cache.set(this.cacheKey(scope, ownerId), { entries: [] });
    await rm(this.pathFor(scope, ownerId), { force: true });
  }

  // ── 快照（给 UI） ────────────────────────────────────

  async snapshot(
    agentId: string,
    options: { projectIds?: string[] } = {},
  ): Promise<MemorySnapshot> {
    const buckets: MemoryBucket[] = [];

    const self = await this.list('self', agentId);
    buckets.push(this.bucket('self', agentId, '它的笔记', self));

    const shared = await this.list('user', USER_OWNER);
    buckets.push(this.bucket('user', USER_OWNER, '共用的「关于你」', shared));

    for (const projectId of options.projectIds ?? []) {
      const entries = await this.list('project', projectId);
      buckets.push(this.bucket('project', projectId, `项目 ${projectId}`, entries));
    }

    const all = buckets.flatMap((bucket) => bucket.entries);
    return {
      agentId,
      buckets,
      counts: {
        portrait: all.filter((entry) => entry.tier === 'portrait').length,
        log: all.filter((entry) => entry.tier === 'log').length,
        scratch: all.filter((entry) => entry.tier === 'scratch').length,
        searchable: all.filter((entry) => !entry.inView).length,
      },
      updatedAt: Date.now(),
    };
  }

  private bucket(
    scope: MemoryScope,
    ownerId: string,
    label: string,
    entries: MemoryEntry[],
  ): MemoryBucket {
    const views: MemoryEntryView[] = [];
    const counters: Record<MemoryTier, number> = { portrait: 0, log: 0, scratch: 0 };

    const ordered = [...entries].sort((left, right) => right.updatedAt - left.updatedAt);
    for (const entry of ordered) {
      const policy = TIER_POLICY[entry.tier];
      counters[entry.tier] += 1;
      const inView = counters[entry.tier] <= policy.inView;
      views.push({
        ...entry,
        inView,
        reason: inView ? `${policy.inView} 条之内` : '超出眼前配额，需要搜才会出来',
      });
    }

    return {
      scope,
      ownerId,
      label,
      entries: views.sort(
        (left, right) =>
          rank(left.tier) - rank(right.tier) || right.updatedAt - left.updatedAt,
      ),
    };
  }

  // ── 内部 ────────────────────────────────────────────

  /**
   * 找一个已经存在的同类事实，用于去重。
   * 数字不同 → 直接判为两件事；否则按完全相同 / 词面重合 / 实词重合递进判断。
   */
  private findDuplicateEntry(doc: ScopeDoc, text: string, key: string): MemoryEntry | undefined {
    const exact = doc.entries.find((entry) => entry.key === key);
    if (exact) return exact;

    let best: { entry: MemoryEntry; score: number } | undefined;
    for (const entry of doc.entries) {
      const verdict = judgeDuplicate(text, entry.text);
      if (verdict.duplicate) return entry;
      if (!best || verdict.score > best.score) best = { entry, score: verdict.score };
    }
    return undefined;
  }

  /** 容量与老化：画像降级、日志淘汰、随手过期 */
  private async enforce(doc: ScopeDoc, scope: MemoryScope, ownerId: string): Promise<MemoryEntry | undefined> {
    let demoted: MemoryEntry | undefined;

    for (const tier of ['portrait', 'log', 'scratch'] as MemoryTier[]) {
      const policy = TIER_POLICY[tier];
      const bucket = doc.entries
        .filter((entry) => entry.tier === tier)
        .sort((left, right) => left.updatedAt - right.updatedAt);
      const overflow = bucket.length - policy.keep;
      if (overflow <= 0) continue;

      const victims = bucket.slice(0, overflow);
      if (policy.overflow === 'demote') {
        for (const victim of victims) {
          victim.tier = DEMOTE_TARGET;
          victim.updatedAt = Date.now();
          demoted = victim;
        }
      } else {
        const ids = new Set(victims.map((victim) => victim.id));
        doc.entries = doc.entries.filter((entry) => !ids.has(entry.id));
      }
    }

    const now = Date.now();
    doc.entries = doc.entries.filter((entry) => !isExpired(entry, now));
    void scope;
    void ownerId;
    return demoted;
  }

  /** 清理过期随手笔记 */
  private sweep(doc: ScopeDoc): { changed: boolean } {
    const now = Date.now();
    const before = doc.entries.length;
    doc.entries = doc.entries.filter((entry) => !isExpired(entry, now));
    return { changed: doc.entries.length !== before };
  }

  private cacheKey(scope: MemoryScope, ownerId: string): string {
    return `${scope}:${ownerId}`;
  }

  private async load(scope: MemoryScope, ownerId: string): Promise<ScopeDoc> {
    const key = this.cacheKey(scope, ownerId);
    const cached = this.cache.get(key);
    if (cached) return cached;

    let doc: ScopeDoc = { entries: [] };
    try {
      const raw = await readFile(this.pathFor(scope, ownerId), 'utf8');
      const parsed = JSON.parse(raw) as Partial<ScopeDoc>;
      if (Array.isArray(parsed.entries)) doc = { entries: parsed.entries };
    } catch {
      // 首次使用
    }
    this.cache.set(key, doc);
    return doc;
  }

  private async save(scope: MemoryScope, ownerId: string, doc: ScopeDoc): Promise<void> {
    const file = this.pathFor(scope, ownerId);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(doc, null, 2), 'utf8');
  }
}

function rank(tier: MemoryTier): number {
  if (tier === 'portrait') return 0;
  if (tier === 'log') return 1;
  return 2;
}
