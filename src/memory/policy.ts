import type { MemoryTier } from './types.js';

export const USER_OWNER = 'user';

export interface TierPolicy {
  /** 每次都带进眼前的条数上限 */
  inView: number;
  /** 该层保留的总条数上限，超出后按策略降级或淘汰 */
  keep: number;
  /** 生存时间；null 表示不因时间淘汰 */
  ttlMs: number | null;
  /** 超容量时的动作 */
  overflow: 'demote' | 'evict';
}

/**
 * 三层策略，对应文档第 5、8 节：
 * - 画像：很少、很稳，每次都带着；装不下就降级成日志，而不是丢掉
 * - 日志：按时间堆，旧的从眼前挪走（仍可搜），总量超了才淘汰最旧的
 * - 随手笔记：淡得最快，到期直接消失
 */
export const TIER_POLICY: Record<MemoryTier, TierPolicy> = {
  portrait: { inView: 12, keep: 40, ttlMs: null, overflow: 'demote' },
  log: { inView: 8, keep: 600, ttlMs: null, overflow: 'evict' },
  scratch: { inView: 6, keep: 80, ttlMs: 24 * 60 * 60 * 1000, overflow: 'evict' },
};

export const DEMOTE_TARGET: MemoryTier = 'log';

/** 用户明确说「记住」时给画像层的容量兜底 */
export const PORTRAIT_SOFT_LIMIT = TIER_POLICY.portrait.inView;

export function isExpired(entry: { tier: MemoryTier; updatedAt: number }, now = Date.now()): boolean {
  const ttl = TIER_POLICY[entry.tier].ttlMs;
  if (ttl === null) return false;
  return now - entry.updatedAt > ttl;
}
