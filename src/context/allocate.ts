import type { ContextBudget, SectionBudget } from './budget.js';

export type ContextSectionKey = 'instructions' | 'memory' | 'retrieval' | 'compacted' | 'recent' | 'files' | 'task';

export interface SectionWants {
  instructions: number;
  memory: number;
  retrieval: number;
  compacted: number;
  recent: number;
  files: number;
  task: number;
}

export interface SectionAllocation {
  memory: number;
  retrieval: number;
  compacted: number;
  recent: number;
}

const PRIORITY: Array<keyof SectionAllocation> = ['recent', 'memory', 'retrieval', 'compacted'];

export function allocateSections(
  budget: ContextBudget,
  wants: SectionWants,
): { alloc: SectionAllocation; available: number } {
  const fixed = wants.instructions + wants.task + wants.files;
  const available = Math.max(0, budget.total - fixed);

  const keys: Array<keyof SectionAllocation> = ['memory', 'retrieval', 'compacted', 'recent'];
  const minTotal = keys.reduce((sum, key) => sum + budget.sections[key].min, 0);

  const alloc = {} as SectionAllocation;
  for (const key of keys) {
    const section: SectionBudget = budget.sections[key];
    alloc[key] =
      minTotal <= available
        ? section.min
        : Math.floor((available * section.min) / Math.max(minTotal, 1));
  }

  let remaining = available - keys.reduce((sum, key) => sum + alloc[key], 0);
  for (const key of PRIORITY) {
    if (remaining <= 0) break;
    const section = budget.sections[key];
    const headroom = Math.max(0, section.max - alloc[key]);
    const add = Math.max(0, Math.min(headroom, remaining, wants[key] - alloc[key]));
    alloc[key] += add;
    remaining -= add;
  }

  for (const key of keys) {
    alloc[key] = Math.max(0, Math.min(alloc[key], wants[key]));
  }

  return { alloc, available };
}
