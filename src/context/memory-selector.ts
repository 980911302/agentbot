import type { MemoryRef } from '../agent/types.js';
import type { MemoryTier } from '../memory/types.js';
import { TIER_POLICY } from '../memory/policy.js';

/**
 * memory-selector（E2.4）：分层挑选进眼前的记忆。
 * 层内排序：self 优先，其次 project，最后 user；同层按 updatedAt 倒序。
 */

export function pickTier(
  refs: MemoryRef[],
  tier: MemoryTier,
  filter: (ref: MemoryRef) => boolean,
): MemoryRef[] {
  const limit = TIER_POLICY[tier].inView;
  return refs
    .filter((ref) => ref.entry.tier === tier && filter(ref))
    .sort((left, right) => scopeRank(left) - scopeRank(right) || right.entry.updatedAt - left.entry.updatedAt)
    .slice(0, limit);
}

function scopeRank(ref: MemoryRef): number {
  if (ref.scope === 'self') return 0;
  if (ref.scope === 'project') return 1;
  return 2;
}

export function renderRefs(refs: MemoryRef[]): string {
  return refs
    .map((ref) => {
      const where = ref.scope === 'self' ? '' : ref.scope === 'user' ? '[共用] ' : '[项目] ';
      return `- ${where}${ref.entry.text}`;
    })
    .join('\n');
}
