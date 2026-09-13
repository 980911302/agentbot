import { createHash } from 'node:crypto';
import type { MemoryRef } from '../agent/types.js';

export const MEMORY_PARTS = ['portrait', 'shared', 'log', 'scratch'] as const;
export type MemoryPart = typeof MEMORY_PARTS[number];
export type MemoryParts = Record<MemoryPart, string>;
export const MAX_SYSTEM_SNAPSHOT_BYTES = 256 * 1024;

/** 仅用于本地恢复校验，不是供应商的缓存键或命中证明。 */
export interface SystemSnapshot {
  version: 1;
  agentId: string;
  scope: string;
  key: string;
  rules: string;
  memory: MemoryParts;
  sources: Array<{ key: string; fingerprint: string; part: MemoryPart }>;
  digest: string;
}

export function promptHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function memoryRefKey(ref: MemoryRef): string {
  return JSON.stringify([ref.scope, ref.ownerId, ref.entry.id]);
}

export function memoryFingerprint(ref: MemoryRef): string {
  // lastSurfacedAt / hits 等读取统计不影响提示词；编辑、删除、过期则使旧快照失效。
  return promptHash([memoryRefKey(ref), ref.entry.tier, ref.entry.text]);
}

export function sealSnapshot(value: Omit<SystemSnapshot, 'digest'>): SystemSnapshot {
  return { ...value, digest: promptHash(value) };
}

export function isSystemSnapshot(value: unknown): value is SystemSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as SystemSnapshot;
  if (s.version !== 1 || typeof s.agentId !== 'string' || typeof s.scope !== 'string' ||
      typeof s.key !== 'string' || typeof s.rules !== 'string' || typeof s.digest !== 'string' ||
      !s.memory || !MEMORY_PARTS.every(part => typeof s.memory[part] === 'string') ||
      !Array.isArray(s.sources) || s.sources.length > 100 || !s.sources.every(source => source &&
        typeof source.key === 'string' && typeof source.fingerprint === 'string' && MEMORY_PARTS.includes(source.part))) return false;
  const { digest, ...body } = s;
  return Buffer.byteLength(JSON.stringify(s)) <= MAX_SYSTEM_SNAPSHOT_BYTES && digest === promptHash(body);
}
