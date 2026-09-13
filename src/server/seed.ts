import type { SeedAgent, SeedRoom } from './runtime.js';

/** 智能体常驻成员；已清空硬编码预设，支持用户完全自由创建 */
export const SEED_AGENTS: SeedAgent[] = [];

/** 预置房间；已清空硬编码预设 */
export const SEED_ROOMS: SeedRoom[] = [];
