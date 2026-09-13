import type { MemoryRef } from '../agent/types.js';
import type { MemoryTier } from './types.js';

const LATIN = /[a-z0-9_]+/g;
const CJK = /[\u3400-\u9fff]/;

/** 层权重：画像最稳，日志次之，随手笔记最先淡 */
const TIER_WEIGHT: Record<MemoryTier, number> = {
  portrait: 1.2,
  log: 1,
  scratch: 0.85,
};

const SCOPE_WEIGHT: Record<MemoryRef['scope'], number> = {
  self: 1.1,
  project: 0.95,
  user: 1,
};

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  for (const match of lower.matchAll(LATIN)) {
    if (match[0].length >= 2) tokens.push(match[0]);
  }

  const run: string[] = [];
  const flush = () => {
    if (run.length === 1) tokens.push(run[0] as string);
    for (let index = 0; index + 1 < run.length; index += 1) {
      tokens.push(`${run[index]}${run[index + 1]}`);
    }
    run.length = 0;
  };
  for (const char of [...lower]) {
    if (CJK.test(char)) run.push(char);
    else flush();
  }
  flush();

  return tokens;
}

export function lexicalScore(query: string, text: string): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;

  const entryTokens = tokenize(text);
  if (entryTokens.length === 0) return 0;

  let hits = 0;
  const seen = new Set<string>();
  for (const token of entryTokens) {
    if (!queryTokens.has(token) || seen.has(token)) continue;
    seen.add(token);
    hits += 1;
  }
  if (hits === 0) return 0;

  return hits / Math.sqrt(entryTokens.length);
}

export interface RankOptions {
  maxItems?: number;
  minScore?: number;
}

/** 记忆检索：词面命中 × 层级权重 × 作用域权重 × 新鲜度 */
export function rankMemories(
  refs: MemoryRef[],
  query: string,
  options: RankOptions = {},
): MemoryRef[] {
  const maxItems = options.maxItems ?? 10;
  const minScore = options.minScore ?? 0.06;
  if (!query.trim()) return [];

  const now = Date.now();
  const scored: { ref: MemoryRef; score: number }[] = [];

  for (const ref of refs) {
    const base = lexicalScore(query, ref.entry.text);
    if (base <= 0) continue;

    const ageDays = (now - ref.entry.updatedAt) / 86_400_000;
    const recency = 1 / (1 + ageDays / 21);
    const score =
      base *
      TIER_WEIGHT[ref.entry.tier] *
      SCOPE_WEIGHT[ref.scope] *
      (0.7 + 0.3 * recency);

    if (score < minScore) continue;
    scored.push({ ref, score });
  }

  return scored
    .sort((left, right) => right.score - left.score)
    .slice(0, maxItems)
    .map((item) => item.ref);
}

export function retrieveMemories(refs: MemoryRef[], query: string, maxItems = 8): MemoryRef[] {
  const ranked = rankMemories(refs, query, { maxItems, minScore: 0.04 });
  if (ranked.length >= maxItems || !query.trim()) return ranked;
  const seen = new Set(ranked.map(ref => `${ref.scope}:${ref.ownerId}:${ref.entry.id}`));
  const literal = refs.filter(ref => !seen.has(`${ref.scope}:${ref.ownerId}:${ref.entry.id}`) && ref.entry.text.toLowerCase().includes(query.trim().toLowerCase()));
  return [...ranked, ...literal.sort((a, b) => b.entry.updatedAt - a.entry.updatedAt)].slice(0, maxItems);
}
