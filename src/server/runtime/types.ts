import type { AgentEventHandler } from '../../agent/types.js';
import type { RunResult } from '../../shared/contracts/sse.js';
import type { BuiltContext } from '../../context/builder.js';
import type { ContextBudget } from '../../context/budget.js';
import type { InteractionBroker } from '../../interaction/broker.js';
import type { LLMProvider } from '../../llm/provider.js';
import type { MemoryStore } from '../../memory/store.js';
import type { RoomEventHandler, RoundOutcome, RoundStatus } from '../../room/types.js';
import type { ModelConfigStore } from '../../storage/model-config-store.js';
import type { SecretStore } from '../../secret/store.js';
import type { SettingsStore } from '../../settings/store.js';
import type { RunTreeRecord, RunTurnRecord, ToolInvocationRecord } from '../../storage/ports.js';
import type { RecoveryPlan } from '../../tools/policy.js';
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
  /** 主人在群里的显示名；不配则用「主人」。有 settings 时以 settings 为准（E5.7） */
  ownerName?: string;
  /** 主人级设置（主人名/时区/语言/通知偏好）持久存储；配了就以它为准 */
  settings?: SettingsStore;
  /** 交互代理（工具问用户 → 界面作答）；不传则自建 */
  broker?: InteractionBroker;
  /** 密钥存储；不传则自建 */
  secrets?: SecretStore;
  /** 模型配置存储；不传则自建。 routes 只经 runtime 访问，不直连 storage */
  modelConfigStore?: ModelConfigStore;
  /** 停止词表；不传用默认（见 docs/架构设计.md「插话、停止和等待」） */
  stopWords?: string[];
  /** 停止令等下级回报的上限（默认 30s；测试可调短） */
  stopAckTimeoutMs?: number;
  /** 投递领取期限（毫秒）：到期未确认视为中断，可回收（E3.3） */
  deliveryLeaseMs?: number;
  /** 同一封信最多处理几次，到顶进 failed（E3.3） */
  deliveryMaxAttempts?: number;
  /** 失败退避基数（毫秒），第 n 次等待 base * 2^(n-1)（E3.3） */
  deliveryBaseDelayMs?: number;
}

export interface SendOptions {
  /** 内部运行身份；不从 HTTP 请求直接接受。 */
  runId?: string;
  messageId?: string;
  /** 仅内部代群发言传入；HTTP 不接收此字段，发送者必须仍在群里。 */
  roomSenderId?: string;
  /** 显式续接已停止任务，不自动重放副作用。 */
  resumeTaskId?: string;
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
  /** 内部协作链深度，群转发不能把计数清零。 */
  agentChainDepth?: number;
  /** 幂等键（E3.2）：重复提交返回原消息 */
  clientMessageId?: string;
  authorization?: import('../../shared/contracts/execution-control.js').ActivationTicket & {
    commandId?: string;
    grantId?: string;
    chainId: string;
    inputId: string;
  };
  roomRecipientIds?: string[];
  roomRecipientDeliveryIds?: Record<string, string>;
  chainId?: string;
}

/**
 * 一次回合的记账（见 docs/架构设计.md「插话、停止和等待」）。
 * 结构就是 RunLedger 的回合记录：执行句柄（AbortController）不在这里。
 */
export type RuntimeTurn = RunTurnRecord;

/** 一轮派生出去的任务树（4.2）：停止令按这张表往下走；执行句柄在账本的内存支路 */
export type TaskTree = RunTreeRecord;

/**
 * 收信回执（E3.4 第二步）：HTTP 立刻 202 返回这个，回合在后台继续跑。
 * receiptSeq 是受理时的日志游标——客户端从这里往后订阅就不会漏事件。
 */
export type Receipt = import('../../shared/contracts/chat-state.js').ChatReceipt;

/** 已受理、待执行的回合：execute 由调用方决定何时跑（HTTP 后台；CLI/测试立刻） */
export interface AcceptedRun<T> {
  receipt: Receipt;
  execute: () => Promise<T>;
}

/** 启动扫描报告（E3.6）：只汇报与拉起，不自动重放中断的工具调用 */
export interface StartupReport {
  /** 上次进程留下、没有结果的工具调用：先核对再决定（planRecovery） */
  unresolvedInvocations: Array<{ record: ToolInvocationRecord; plan: RecoveryPlan }>;
  /** 重启后有待处理投递的同事（可领取/在飞/失败） */
  pendingDeliveries: Array<{
    agentId: string;
    agentName: string;
    claimable: number;
    claimed: number;
    failed: number;
  }>;
}

/** 撞上用户回合被挂起的停止令（运行时内部） */
export interface PendingStop {
  text: string;
  createdAt: number;
  options: SendOptions;
  /** true = 发起者是用户（要回「在停/停完了」）；false = 上级停止令（要回 stop-ack） */
  notifyUser: boolean;
  replyTo?: { agentId: string; name: string; treeId?: string };
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
  /** 因为正在跑别的回合而排队的成员名（E3.7：不再跳过丢信，改为排队） */
  queued: string[];
}

export class AgentBusyError extends Error {
  constructor() {
    super('This agent is already running a request');
    this.name = 'AgentBusyError';
  }
}
