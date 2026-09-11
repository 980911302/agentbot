/**
 * 人机交互（human-in-the-loop）。
 *
 * 对应《智能体可操作能力.md》第 8 节与《工具与能力.md》第 1 节：
 * 智能体不该让用户「打字回答」，而应弹出可点的卡片；
 * 密钥类输入走遮罩框，值不进对话原文、不进记忆。
 *
 * 时序：
 *   工具 ask_user → broker.request() 挂起
 *     → emit('interaction') 走 SSE 到界面
 *     → 用户点一下 → POST /api/interactions/:id
 *     → broker.resolve() → 工具拿到答案 → 回合继续
 */

export type InteractionKind = 'choice' | 'secret';

export interface InteractionOption {
  id: string;
  label: string;
  description?: string;
}

export interface InteractionRequest {
  id: string;
  kind: InteractionKind;
  /** 问题本身 */
  question: string;
  /** 补充说明 */
  detail?: string;
  /** choice 专用 */
  options?: InteractionOption[];
  /** secret 专用：存起来之后用什么名字引用 */
  name?: string;
  agentId: string;
  agentName: string;
  createdAt: number;
  /** 过期时间；到点自动按「用户没答」处理 */
  expiresAt: number;
}

export interface InteractionAnswer {
  id: string;
  /** choice 选中的选项 id */
  value?: string;
  /** secret 的明文（只在内存里传递，不落盘、不进对话） */
  secret?: string;
  answeredAt: number;
}

export class InteractionTimeoutError extends Error {
  constructor(question: string) {
    super(`用户没有在时限内回答「${question}」，请先用文字说明你要问什么，或者换个方式继续`);
    this.name = 'InteractionTimeoutError';
  }
}

export class InteractionCancelledError extends Error {
  constructor() {
    super('这一轮被取消了，用户没有回答');
    this.name = 'InteractionCancelledError';
  }
}
