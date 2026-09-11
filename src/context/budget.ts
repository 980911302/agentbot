export interface SectionBudget {
  min: number;
  max: number;
}

export interface ContextBudget {
  total: number;
  recentLimit: number;
  compactionTrigger: number;
  reserveRecent: number;
  sections: {
    memory: SectionBudget;
    retrieval: SectionBudget;
    compacted: SectionBudget;
    recent: SectionBudget;
  };
}

export const DEFAULT_BUDGET: ContextBudget = {
  total: 60_000,
  recentLimit: 30,
  compactionTrigger: 12,
  reserveRecent: 30,
  sections: {
    memory: { min: 2_000, max: 5_000 },
    retrieval: { min: 5_000, max: 20_000 },
    compacted: { min: 5_000, max: 20_000 },
    recent: { min: 20_000, max: 50_000 },
  },
};

const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 0.9 + other / 3.6);
}

export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  const ratio = maxTokens / Math.max(estimateTokens(text), 1);
  const target = Math.max(1, Math.floor(text.length * ratio) - 1);
  return `${text.slice(0, target)}…`;
}
