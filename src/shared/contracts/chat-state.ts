/** 聊天控制面契约。纯数据，不依赖 Node、React 或模型 SDK。 */
export interface EventCursor { epoch: string; seq: number }

export type ChatRunStatus = 'queued' | 'running' | 'finalizing' | 'succeeded' | 'incomplete' | 'parked' | 'cancelled' | 'failed' | 'interrupted';
export const isActiveChatRun = (run: { status: ChatRunStatus }): boolean =>
  run.status === 'queued' || run.status === 'running' || run.status === 'finalizing';

export interface ChatRun {
  runId: string;
  /** 一项任务可以有多次执行；续跑保留 taskId，另开 runId。 */
  taskId: string;
  parentRunId?: string;
  channelId: string;
  agentId?: string;
  roomId?: string;
  kind: 'agent' | 'room' | 'stop';
  source: 'user' | 'agent' | 'room' | 'resume';
  clientMessageId?: string;
  messageId?: string;
  input: string;
  status: ChatRunStatus;
  stopReason?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface JournalEntry {
  seq: number;
  at: number;
  epoch?: string;
  runId?: string;
  taskId?: string;
  clientMessageId?: string;
  agentId?: string;
  roomId?: string;
  kind: 'agent' | 'room' | 'run';
  payload: unknown;
}

export interface ChatReceipt {
  runId?: string;
  taskId?: string;
  run?: ChatRun;
  messageId?: string;
  agentId?: string;
  roomId?: string;
  receiptSeq: number;
  duplicate: boolean;
}

export interface ChatSnapshot<M = unknown, A = unknown> {
  cursor: EventCursor;
  channels: Record<string, { messages: M[]; artifacts: A[] }>;
  runs: ChatRun[];
  interactions?: import('./sse.js').InteractionRequest[];
  agentControls?: Record<string, { autoActivation: 'enabled' | 'paused'; generation: number; lastStopId?: string }>;
}
