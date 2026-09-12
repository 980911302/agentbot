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
/** 投递生命周期（E3.3）：pending → claimed → handled；失败按策略回 pending 或进 failed */
export type DeliveryStatus = 'pending' | 'claimed' | 'handled' | 'failed';

/** 处理形成的持久检查点：这批输入已经变成了哪条消息 / 哪个回合 */
export interface DeliveryCheckpoint {
  at: number;
  messageId: string;
  turnId?: string;
  note?: string;
}

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
  /** 原消息 / 关联引用：每封信保留作者与关联（E3.3） */
  messageId?: string;
  correlationId?: string;
  /** 缺省视为 pending（兼容没有生命周期字段的旧数据） */
  status?: DeliveryStatus;
  /** 处理失败次数；领取超时回收与 nack 共用同一份持久计数，重启不重置 */
  attempts?: number;
  /** 退避：早于这个时刻不领取 */
  availableAt?: number;
  /** 执行权：被谁领走 */
  leaseOwner?: string;
  /** 每次领取递增的 epoch（E3.6 用它拒绝迟到写入） */
  leaseEpoch?: number;
  /** 领取期限：过期视为处理中断，可被回收 */
  leaseUntil?: number;
  lastError?: string;
  checkpoint?: DeliveryCheckpoint;
}

export interface DeliveryClaimInput {
  /** 领取者标识（回合 / 执行实例） */
  owner: string;
  /** 领取期限（毫秒）：到期未确认视为中断 */
  leaseMs: number;
  /** 回收过期租约时，尝试次数达到此值进 failed */
  maxAttempts: number;
  now?: number;
}

export interface DeliveryFailureInput {
  maxAttempts: number;
  /** 退避基数：第 n 次失败等待 base * 2^(n-1)，封顶 maxDelayMs */
  baseDelayMs: number;
  maxDelayMs?: number;
  now?: number;
}

export interface DeliveryPort {
  enqueue(item: Omit<DeliveryItem, 'id' | 'createdAt'>): Promise<DeliveryItem>;
  /**
   * 原子领取：带执行权（owner）与期限（leaseMs），并取得递增 epoch。
   * 领取不删除内容；同一 agent 同一时刻只应有一个有效领取（活的租约会挡住后来的领取）。
   */
  claim(agentId: string, input: DeliveryClaimInput): Promise<DeliveryItem[]>;
  /** 处理形成持久检查点后确认；确认即出队（JSON 阶段不留在队列里） */
  ack(agentId: string, ids: string[]): Promise<number>;
  /** 失败退回：有限退避；到达上限进 failed，不再自动重试 */
  nack(
    agentId: string,
    ids: string[],
    error: string,
    input: DeliveryFailureInput,
  ): Promise<{ failed: string[]; pending: string[] }>;
  /** 归还领取（忙等非失败原因）：不计次，立即回到可领取 */
  release(agentId: string, ids: string[]): Promise<void>;
  /** 记录持久检查点：这批信已被折成哪条消息 */
  checkpoint(
    agentId: string,
    ids: string[],
    patch: { messageId: string; turnId?: string; note?: string; at?: number },
  ): Promise<void>;
  /** 人工重试 failed：重置尝试预算 */
  retryFailed(agentId: string): Promise<number>;
  /** 未处理的投递（pending + claimed，不含 failed） */
  peek(agentId: string): Promise<DeliveryItem[]>;
  take(agentId: string, predicate: (item: DeliveryItem) => boolean): Promise<DeliveryItem[]>;
  /** 未处理数（pending + claimed） */
  count(agentId: string): Promise<number>;
  /** 现在可领取数（要不要再拉一次的判断依据） */
  claimableCount(agentId: string, now?: number): Promise<number>;
  failedCount(agentId: string): Promise<number>;
  clear(agentId: string): Promise<void>;
}

// ── 工具执行账本：先记意图，再执行，再记结果（E3.5） ──
/**
 * 中断后的恢复分类（见 docs/架构设计.md §7.3）：
 *   rerun     纯读取/搜索：可以重读，只需注明时间变化
 *   idempotent 支持业务幂等键：用同一 operationKey 重试
 *   verify    文件/资料写入：先核对产物，再决定是否重做
 *   manual    任意 shell、无幂等支持的外发：先查产物与外部状态，无法判断就问用户
 */
export type ReplayPolicy = 'rerun' | 'idempotent' | 'verify' | 'manual';

/** started = 有意图没结果（中断），恢复前必须先核对 */
export type ToolInvocationStatus = 'started' | 'ok' | 'error' | 'unknown';

export interface ToolInvocationRecord {
  id: string;
  agentId: string;
  /** 哪次回合（Run）：恢复扫描与「谁欠的」都靠它 */
  runId?: string;
  treeId?: string;
  tool: string;
  /** 稳定业务键：同一请求跨重试不变（不含 runId/时间戳），可回填给外部幂等接口 */
  operationKey: string;
  /** 参数摘要（截断落盘；完整参数本来就在消息历史里） */
  args?: string;
  status: ToolInvocationStatus;
  replayPolicy: ReplayPolicy;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  resultSummary?: string;
  error?: string;
}

export interface ToolInvocationStart {
  agentId: string;
  runId?: string;
  treeId?: string;
  tool: string;
  operationKey: string;
  args?: string;
  replayPolicy: ReplayPolicy;
}

export interface ToolInvocationPort {
  /** 执行前先落一条意图；返回的 id 用于执行后回填结果 */
  start(input: ToolInvocationStart): Promise<ToolInvocationRecord>;
  finish(
    id: string,
    result: { status: 'ok' | 'error' | 'unknown'; summary?: string; error?: string; durationMs?: number },
  ): Promise<ToolInvocationRecord | undefined>;
  /** 有意图、没结果的调用：恢复前必须先核对（E3.6 启动扫描的输入） */
  unfinished(): Promise<ToolInvocationRecord[]>;
  /** 同一业务键的历史尝试：判断「这件事是不是已经做过」 */
  attemptsOf(operationKey: string): Promise<ToolInvocationRecord[]>;
  list(limit?: number): Promise<ToolInvocationRecord[]>;
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
  /** 自动续跑次数上限 3，防止打断-续跑打乒乓 */
  resumeCount: number;
  createdAt: number;
}

export interface RunLedgerPort {
  putTurn(turn: RunTurnRecord): void;
  getTurn(id: string): RunTurnRecord | undefined;
  putTree(tree: RunTreeRecord): void;
  getTree(id: string): RunTreeRecord | undefined;
  /** 全部任务树（停止按树遍历、续跑按树筛选） */
  listTrees(): RunTreeRecord[];
  /** 当前占着执行位的回合 id；没有则 undefined */
  runningTurnOf(agentId: string): string | undefined;
  releaseRunning(agentId: string, turnId: string): void;
  acquireRunning(agentId: string, turnId: string): void;
}
