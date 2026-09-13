import type { ExecutionAuthority } from '../tools/tool.js';

/** 持久的任务语义，不保存工具函数、Promise、信号或可变的发言缓冲。 */
export interface RunContinuation {
  version: 1;
  source: 'user' | 'agent' | 'room';
  model: string;
  brief?: string;
  speaker?: string;
  sender?: import('../shared/contracts/message-identity.js').MessageActor;
  images?: import('../shared/contracts/input-image.js').InputImage[];
  agentChainDepth: number;
  persistAssistantText: boolean;
  authority: ExecutionAuthority;
  room?: { roomId: string; roomName: string; roundId: string; limit: number; live?: boolean };
}
