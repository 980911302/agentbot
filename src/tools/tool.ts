import type { JSONSchema } from '../agent/types.js';
import { boundedSchema, limitsFor, validateToolArgs } from './limits.js';
import { boundResult, normalizeResult, type ToolResult } from './result.js';
import type { ToolOutputStore } from './services/tool-output-store.js';

export interface RoomTurnContext {
  roomId: string;
  roundId?: string;
  roomName: string;
  /** 这一轮已经发出的正文 */
  posts: string[];
  /** 一轮最多说几句 */
  limit: number;
  /** 持久出口：仅写时间线和 @ 投递，不执行收件人。 */
  publish?: (text: string) => Promise<void>;
  live?: boolean;
}

export interface DeliveryAttempt {
  target: string;
  targetId?: string;
  targetName?: string;
  kind?: 'agent' | 'room';
  status: 'pending' | 'ok' | 'error';
}

export interface TurnState {
  /** 工作台工具的本轮配额，防止一次对话里建一堆东西 */
  workbench: { agentsCreated: number; roomsCreated: number };
  /** 本回合的任务树 id（见 docs/架构设计.md「插话、停止和等待」：派活必须记账） */
  treeId?: string;
  /** 记一笔"派给谁"：停止令要沿这张表往下传 */
  registerChild?(child: { agentId: string; via: 'dm' | 'room'; roomId?: string }): void;
  /** 标记真正的子任务已收尾；协作投递不使用。 */
  completeChild?(child: { agentId: string; via: 'dm' | 'room'; roomId?: string }): void;
  /** 记一笔"起了什么进程/流"：停止令要能掐掉 */
  registerJob?(abort: () => void, label: string): void;
  /** 以当前智能体的身份把一条文本落到它的对话线并推给界面（SendToUser 私聊/群内 dm 用） */
  persistOutgoing?(text: string): Promise<void>;
  /** SendToUser 的最终出口已发出，模型-工具循环应立即收尾。 */
  endTurnRequested?: boolean;
  /** 最后一条已经交付的可见文本，供回合结果摘要使用。 */
  lastVisibleText?: string;
  /** 本轮由用户/同事明确要求的平台投递；是否完成只看 deliveryAttempts 的成功回执。 */
  requiredDelivery?: { kind: 'agent' | 'room'; requestedBy: 'message' };
  /** SendToAgent 的结构化尝试与回执；不能从模型最后一句话反推。 */
  deliveryAttempts?: DeliveryAttempt[];
  toolCalls?: number;
  toolInputChars?: number;
  toolOutputChars?: number;
  /** 触及硬配额后只允许运行时交接，不继续反复请求被拒绝的工具。 */
  toolLimitReason?: string;
}

export function deliveryRequirementSatisfied(state: TurnState | undefined): boolean {
  const required = state?.requiredDelivery;
  if (!required) return true;
  return state?.deliveryAttempts?.some(attempt => attempt.status === 'ok' && attempt.kind === required.kind) === true;
}

export function hasFailedDeliveryAttempt(state: TurnState | undefined): boolean {
  return state?.deliveryAttempts?.some(attempt => attempt.status === 'error') === true;
}

export interface ToolContext {
  agentId: string;
  /** 由执行器装配，不能来自模型参数；子任务只能缩小这份授权。 */
  authority?: ExecutionAuthority;
  /** 这个智能体参与的项目，决定项目笔记写到哪 */
  projectIds: string[];
  signal?: AbortSignal;
  outputs?: ToolOutputStore;
  /** 群回合上下文；私聊时为 undefined */
  room?: RoomTurnContext;
  /** 智能体之间传话的链深度，防止无限互发 */
  agentChainDepth?: number;
  /** 本轮可变状态（配额等） */
  turnState?: TurnState;
  /** 把事件推给界面（例如弹出选项卡等用户回答） */
  emit?: (event: import('../agent/types.js').AgentEvent) => void;
}

export interface ExecutionAuthority {
  toolNames: string[];
  projectIds: string[];
  model?: string;
}

export interface Tool<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JSONSchema;
  /**
   * 只服务于当前回合、不必把调用过程写进对话历史的工具（例如 SendToUser）。
   * 这类调用不会落成 assistant/tool 消息。
   */
  ephemeral?: boolean;
  execute(args: TArgs, context: ToolContext): Promise<string> | string;
  /** 执行器优先使用此接口；execute 保留给旧插件/直接调用方。 */
  executeResult?(args: TArgs, context: ToolContext): Promise<ToolResult> | ToolResult;
}

export function defineTool<TArgs>(tool: Omit<Tool<TArgs>, 'execute' | 'executeResult'> & {
  execute(args: TArgs, context: ToolContext): Promise<string | ToolResult> | string | ToolResult;
}): Tool<TArgs> {
  const parameters = boundedSchema(tool.parameters, tool.name);
  const executeResult = async (args: TArgs, context: ToolContext): Promise<ToolResult> => {
    context.signal?.throwIfAborted();
    validateToolArgs(tool.name, args, parameters);
    return boundResult(normalizeResult(await tool.execute(args, context)), limitsFor(tool.name).output, context.agentId, context.outputs);
  };
  return {
    ...tool,
    parameters,
    executeResult,
    async execute(args, context) { return (await executeResult(args, context)).content; },
  };
}
