import { randomUUID } from 'node:crypto';
import {
  InteractionCancelledError,
  InteractionTimeoutError,
  type InteractionAnswer,
  type InteractionRequest,
} from './types.js';

/** 默认等用户 5 分钟；超时按「没答」处理，不无限挂着 */
export const DEFAULT_INTERACTION_TIMEOUT_MS = 5 * 60 * 1000;

interface Pending {
  request: InteractionRequest;
  settle: (answer: InteractionAnswer) => void;
  fail: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** 清理：移除监听 */
  cleanup: () => void;
}

export interface RequestInteractionInput {
  kind: InteractionRequest['kind'];
  question: string;
  detail?: string;
  options?: InteractionRequest['options'];
  name?: string;
  agentId: string;
  agentName: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 挂起工具的执行，等界面把用户的回答送回来。
 *
 * 刻意不做成持久队列：一次交互只活在一个回合里，
 * 回合结束（取消/超时）就应该释放，不留悬挂状态。
 */
export class InteractionBroker {
  private readonly pending = new Map<string, Pending>();

  /** 挂在某处等用户回答；返回时要么有答案，要么抛超时/取消 */
  request(input: RequestInteractionInput): Promise<InteractionAnswer> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
    const now = Date.now();
    const request: InteractionRequest = {
      id: randomUUID(),
      kind: input.kind,
      question: input.question,
      detail: input.detail,
      options: input.options,
      name: input.name,
      agentId: input.agentId,
      agentName: input.agentName,
      createdAt: now,
      expiresAt: now + timeoutMs,
    };

    return new Promise<InteractionAnswer>((resolve, reject) => {
      const settle = (answer: InteractionAnswer) => {
        const entry = this.pending.get(request.id);
        if (!entry) return;
        this.pending.delete(request.id);
        entry.cleanup();
        clearTimeout(entry.timer);
        resolve(answer);
      };

      const fail = (error: Error) => {
        const entry = this.pending.get(request.id);
        if (!entry) return;
        this.pending.delete(request.id);
        entry.cleanup();
        clearTimeout(entry.timer);
        reject(error);
      };

      const timer = setTimeout(() => fail(new InteractionTimeoutError(request.question)), timeoutMs);

      const onAbort = () => fail(new InteractionCancelledError());
      const cleanup = () => input.signal?.removeEventListener('abort', onAbort);
      if (input.signal) {
        if (input.signal.aborted) {
          clearTimeout(timer);
          reject(new InteractionCancelledError());
          return;
        }
        input.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(request.id, { request, settle, fail, timer, cleanup });
    });
  }

  /** 界面把答案送回来 */
  resolve(id: string, answer: { value?: string; secret?: string }): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.settle({ id, value: answer.value, secret: answer.secret, answeredAt: Date.now() });
    return true;
  }

  /** 界面明确说「用户放弃了」 */
  cancel(id: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.fail(new InteractionCancelledError());
    return true;
  }

  /** 正在等回答的交互（界面刷新后可恢复展示） */
  list(filter?: { agentId?: string }): InteractionRequest[] {
    return [...this.pending.values()]
      .map((entry) => entry.request)
      .filter((request) => !filter?.agentId || request.agentId === filter.agentId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  get size(): number {
    return this.pending.size;
  }
}
