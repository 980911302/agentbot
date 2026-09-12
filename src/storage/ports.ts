import type { Message } from '../shared/contracts/sse.js';

/**
 * Repository 接口边界（E3.1）。
 *
 * E3.1 只定义边界并让现有 JSON 存储实现之——运行时字段逐步切换到接口类型，
 * 为 E3.1 后续的 SQLite 实现替换做准备。接口按《工程化执行计划.md》§E3 分四块：
 *   元数据（registry）/ 消息（messages）/ 投递（inbox）/ Run 账本（turns/trees）。
 */

// ── 元数据：智能体注册表 ──────────────────────────────
export interface AgentMetadata {
  id: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  toolNames: string[];
  color: string;
  avatar?: string;
  section?: string;
  hidden?: boolean;
  projectIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AgentMetadataPatch {
  name?: string;
  title?: string;
  description?: string;
  instructions?: string;
  color?: string;
  avatar?: string;
  section?: string;
  hidden?: boolean;
  toolNames?: string[];
  projectIds?: string[];
}

export interface AgentRegistryPort {
  list(): Promise<AgentMetadata[]>;
  get(id: string): Promise<AgentMetadata | undefined>;
  create(input: { name: string; instructions?: string; color?: string }): Promise<AgentMetadata>;
  update(id: string, patch: AgentMetadataPatch): Promise<AgentMetadata | undefined>;
  remove(id: string): Promise<boolean>;
}

// ── 消息：按智能体的对话线 ────────────────────────────
export interface MessageRepositoryPort {
  append(message: Message): Promise<void>;
  list(agentId: string, limit?: number): Promise<Message[]>;
  recent(agentId: string, limit: number, excludeId?: string): Promise<Message[]>;
  count(agentId: string): Promise<number>;
  clear(agentId: string): Promise<void>;
}

// ── 投递：智能体间 1:1 收件箱（含停止令信） ──────────
export interface DeliveryItem {
  id: string;
  toAgentId: string;
  fromAgentId: string;
  fromName: string;
  text: string;
  priority: boolean;
  depth: number;
  /** stop = 停止令（排最前、不进模型）；stop-ack = 下级回报；缺省 = 普通信 */
  kind?: 'message' | 'stop' | 'stop-ack';
  treeId?: string;
  createdAt: number;
}

export interface DeliveryPort {
  enqueue(item: Omit<DeliveryItem, 'id' | 'createdAt'>): Promise<DeliveryItem>;
  drain(agentId: string): Promise<DeliveryItem[]>;
  peek(agentId: string): Promise<DeliveryItem[]>;
  take(agentId: string, predicate: (item: DeliveryItem) => boolean): Promise<DeliveryItem[]>;
  count(agentId: string): Promise<number>;
  clear(agentId: string): Promise<void>;
}

// ── Run 账本：回合/任务树记账（E3.1 先以内存实现作为唯一实现） ──
export interface RunTurnRecord {
  id: string;
  agentId: string;
  source: 'user' | 'agent' | 'room' | 'resume';
  kind: 'normal' | 'stop';
  text: string;
  treeId: string;
  status: 'running' | 'parked' | 'done' | 'cancelled';
  createdAt: number;
}

export interface RunTreeRecord {
  id: string;
  rootTurnId: string;
  agentId: string;
  children: Array<{ agentId: string; via: 'dm' | 'room'; roomId?: string }>;
  status: 'open' | 'cancelling' | 'cancelled';
  resumeCount: number;
  createdAt: number;
}

export interface RunLedgerPort {
  putTurn(turn: RunTurnRecord): void;
  getTurn(id: string): RunTurnRecord | undefined;
  putTree(tree: RunTreeRecord): void;
  getTree(id: string): RunTreeRecord | undefined;
  /** 当前占着执行位的回合 id；没有则 undefined */
  runningTurnOf(agentId: string): string | undefined;
  releaseRunning(agentId: string, turnId: string): void;
  acquireRunning(agentId: string, turnId: string): void;
}
