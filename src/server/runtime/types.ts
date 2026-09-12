import type { AgentEventHandler } from '../../agent/types.js';
import type { RunResult } from '../../shared/contracts/sse.js';
import type { BuiltContext } from '../../context/builder.js';
import type { ContextBudget } from '../../context/budget.js';
import type { InteractionBroker } from '../../interaction/broker.js';
import type { LLMProvider } from '../../llm/provider.js';
import type { MemoryStore } from '../../memory/store.js';
import type { RoomEventHandler, RoundOutcome, RoundStatus } from '../../room/types.js';
import type { SecretStore } from '../../secret/store.js';
import type { Tool } from '../../tools/tool.js';

/** 种子智能体（首次启动时落进注册表） */
export interface SeedAgent {
  name: string;
  color: string;
  instructions: string;
  projectIds?: string[];
}

export interface SeedRoom {
  name: string;
  memberNames: string[];
}

export interface AgentRuntimeOptions {
  tools: Tool<any>[];
  createProvider: (model: string) => LLMProvider;
  dataDir: string;
  defaultModel: string;
  knownModels: string[];
  budget: ContextBudget;
  memoryExtraction: boolean;
  memoryStore?: MemoryStore;
  maxIterations?: number;
  seed?: SeedAgent[];
  seedRooms?: SeedRoom[];
  /** 智能体互传的链深度上限，防止无限互发 */
  maxAgentChainDepth?: number;
  /** 主人在群里的显示名；不配则用「主人」 */
  ownerName?: string;
  /** 交互代理（工具问用户 → 界面作答）；不传则自建 */
  broker?: InteractionBroker;
  /** 密钥存储；不传则自建 */
  secrets?: SecretStore;
  /** 停止词表；不传用默认（见 docs/架构设计.md「插话、停止和等待」） */
  stopWords?: string[];
  /** 停止令等下级回报的上限（默认 30s；测试可调短） */
  stopAckTimeoutMs?: number;
}

export interface SendOptions {
  model?: string;
  onEvent?: AgentEventHandler;
  onRoomEvent?: RoomEventHandler;
  /** 私聊流式：增量文本回调（群回合不透传，避免露出不进历史的收尾推理） */
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  /** 覆盖主人显示名（一般不用传，从 runtime 配置读） */
  ownerName?: string;
  /** 这些成员跳过这一轮（工作台代发时排除调用者自己） */
  excludeAgentIds?: string[];
  /** 幂等键（E3.2）：重复提交返回原消息 */
  clientMessageId?: string;
}

/** 一次回合的记账（见 docs/架构设计.md「插话、停止和等待」） */
export interface RuntimeTurn {
  id: string;
  agentId: string;
  source: 'user' | 'agent' | 'room' | 'resume';
  kind: 'normal' | 'stop';
  text: string;
  treeId: string;
  status: 'running' | 'parked' | 'done' | 'cancelled';
  createdAt: number;
}

/** 一轮派生出去的任务树（4.2）：停止令按这张表往下走 */
export interface TaskTree {
  id: string;
  rootTurnId: string;
  agentId: string;
  jobs: Array<{ abort: () => void; label: string }>;
  children: Array<{ agentId: string; via: 'dm' | 'room'; roomId?: string }>;
  status: 'open' | 'cancelling' | 'cancelled';
  /** 自动续跑次数上限 3，防止打断-续跑打乒乓 */
  resumeCount: number;
  createdAt: number;
}

/** 撞上用户回合被挂起的停止令（运行时内部） */
export interface PendingStop {
  text: string;
  createdAt: number;
  options: SendOptions;
  /** true = 发起者是用户（要回「在停/停完了」）；false = 上级停止令（要回 stop-ack） */
  notifyUser: boolean;
  replyTo?: { agentId: string; name: string };
  resolve?: (result: SendResult) => void;
}

export interface TurnResult extends RunResult {
  agentId: string;
  agentName: string;
  context: BuiltContext;
  /** 群回合真正发到房间的正文；空数组 = 沉默 */
  posts: string[];
  status: RoundStatus;
}

export interface SendResult extends TurnResult {}

export interface RoomRoundSummary {
  roundId: string;
  roomId: string;
  roomName: string;
  outcomes: RoundOutcome[];
  /** 因为正在跑别的回合而跳过的成员名 */
  skipped: string[];
}

export class AgentBusyError extends Error {
  constructor() {
    super('This agent is already running a request');
    this.name = 'AgentBusyError';
  }
}
