import type { JSONSchema } from '../agent/types.js';

export interface RoomTurnContext {
  roomId: string;
  roomName: string;
  /** 这一轮已经发出的正文 */
  posts: string[];
  /** 一轮最多说几句 */
  limit: number;
}

export interface TurnState {
  /** 工作台工具的本轮配额，防止一次对话里建一堆东西 */
  workbench: { agentsCreated: number; roomsCreated: number };
  /** 本回合的任务树 id（《停止与插话.md》§8：派活必须记账） */
  treeId?: string;
  /** 记一笔"派给谁"：停止令要沿这张表往下传 */
  registerChild?(child: { agentId: string; via: 'dm' | 'room'; roomId?: string }): void;
  /** 记一笔"起了什么进程/流"：停止令要能掐掉 */
  registerJob?(abort: AbortController, label: string): void;
}

export interface ToolContext {
  agentId: string;
  /** 这个智能体参与的项目，决定项目笔记写到哪 */
  projectIds: string[];
  signal?: AbortSignal;
  /** 群回合上下文；私聊时为 undefined */
  room?: RoomTurnContext;
  /** 智能体之间传话的链深度，防止无限互发 */
  agentChainDepth?: number;
  /** 本轮可变状态（配额等） */
  turnState?: TurnState;
  /** 把事件推给界面（例如弹出选项卡等用户回答） */
  emit?: (event: import('../agent/types.js').AgentEvent) => void;
}

export interface Tool<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JSONSchema;
  /**
   * 只服务于当前回合、不必写进对话历史的工具（例如群里的 say / stay_silent）。
   * 这类调用不会落成 assistant/tool 消息。
   */
  ephemeral?: boolean;
  execute(args: TArgs, context: ToolContext): Promise<string> | string;
}

export function defineTool<TArgs>(tool: Tool<TArgs>): Tool<TArgs> {
  return tool;
}
