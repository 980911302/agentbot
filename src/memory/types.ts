/**
 * 记忆模型 —— 参见 docs/架构设计.md「身份、消息与记忆」
 *
 * 记账单位是「智能体」：每个智能体一本自己的笔记。
 * 另有两条独立作用域：跨智能体共用的「关于你」，以及绑定项目的笔记。
 * 群聊不产生记忆，只广播给在场成员。
 */

export type MemoryScope = 'self' | 'user' | 'project';

export type MemoryTier = 'portrait' | 'log' | 'scratch';

export type MemorySource = 'user' | 'agent' | 'extracted';

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  tier: MemoryTier;
  /** self → agentId；user → USER_OWNER；project → projectId */
  ownerId: string;
  text: string;
  /** 归一化指纹，用于去重 */
  key: string;
  tags: string[];
  source: MemorySource;
  createdAt: number;
  updatedAt: number;
  /** 最近一次被带进上下文的时间 */
  lastSurfacedAt: number | null;
  /** 被搜到/引用的次数 */
  hits: number;
  sourceMessageId?: string;
}

export interface MemoryEntryView extends MemoryEntry {
  /** 是否正处在「眼前」（会进上下文） */
  inView: boolean;
  /** 对当前智能体而言的可读性说明 */
  reason?: string;
}

export interface MemoryBucket {
  scope: MemoryScope;
  ownerId: string;
  label: string;
  entries: MemoryEntryView[];
}

export interface MemorySnapshot {
  agentId: string;
  buckets: MemoryBucket[];
  counts: {
    portrait: number;
    log: number;
    scratch: number;
    searchable: number;
  };
  updatedAt: number;
}

export interface CompactionState {
  summary: string;
  coversUpTo: number;
  messageCount: number;
  updatedAt: number;
}
