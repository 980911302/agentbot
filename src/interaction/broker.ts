import { randomUUID } from 'node:crypto';
import type { InteractionRequest } from '../shared/contracts/sse.js';
import {
  InteractionCancelledError,
  InteractionTimeoutError,
  type InteractionAnswer,
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
 * 同回合内的等待仍然是一段内存 Promise（回合结束就释放）；**跨回合/跨重启的等待
 * 不在这里**——那由 WorkWait 落盘（E4.3），broker 只保存一份可重建的展示副本
 * （cards），重启后由 WaitService 读回来，绝不序列化 Promise。
 */
export class InteractionBroker {
  private readonly pending = new Map<string, Pending>();
  /** 持久等待的展示副本（id → 线上形状）：没有 Promise，只有卡片数据 */
  private readonly cards = new Map<string, InteractionRequest>();

  /** 挂在某处等用户回答；返回时要么有答案，要么抛超时/取消 */
  request(input: RequestInteractionInput): Promise<InteractionAnswer> {
    if (this.pending.size >= 32 || this.list({ agentId: input.agentId }).length >= 1) return Promise.reject(new Error('已有待回答交互，请先等待它完成'));
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
    if ((answer.value?.length ?? 0) > 12000 || (answer.secret?.length ?? 0) > 16000) return false;
    entry.settle({ id, value: answer.value, secret: answer.secret, answeredAt: Date.now() });
    return true;
  }

  /** 界面明确说「用户放弃了」 */
  cancel(id: string): boolean {
    const entry = this.pending.get(id);
    if (entry) {
      entry.fail(new InteractionCancelledError());
      return true;
    }
    // 持久卡片：撤下展示；等待本身的状态由 WaitService 记（这里不认识它）
    return this.cards.delete(id);
  }

  // ── 持久等待的展示副本（E4.3）────────────────────────
  // 这些卡片来自 work/waits.json 里的 pending 等待：重启后由运行时重新灌进来。
  // 保存卡片的**数据**而不是 Promise，所以再开一个进程也能把卡片画回界面上。

  /** 用持久等待重建整份卡片（重启恢复时调用；替换而不是追加，避免留下已消失的卡） */
  hydrate(requests: InteractionRequest[]): void {
    this.cards.clear();
    for (const request of requests) this.cards.set(request.id, request);
  }

  /** 登记一张持久等待卡片（问题已落盘后才调） */
  expose(request: InteractionRequest): void {
    this.cards.set(request.id, request);
  }

  /** 撤下一张持久卡片（已回答 / 已作废 / 已过期） */
  retire(id: string): boolean {
    return this.cards.delete(id);
  }

  /** 这是不是一张持久等待卡片（回答要交给 WaitService，而不是内存 Promise） */
  hasCard(id: string): boolean {
    return this.cards.has(id);
  }

  /** 正在等回答的交互（含持久卡片）；界面刷新/重启后据此恢复展示 */
  list(filter?: { agentId?: string }): InteractionRequest[] {
    const live = [...this.pending.values()].map((entry) => entry.request);
    const saved = [...this.cards.values()].filter((request) => !this.pending.has(request.id));
    return [...live, ...saved]
      .filter((request) => !filter?.agentId || request.agentId === filter.agentId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  /** 只在内存里等着的交互（同回合内）；作废旧卡时按这个判定谁需要 reject */
  pendingList(filter?: { agentId?: string }): InteractionRequest[] {
    return [...this.pending.values()]
      .map((entry) => entry.request)
      .filter((request) => !filter?.agentId || request.agentId === filter.agentId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  get size(): number {
    return this.pending.size;
  }

  /** 持久卡片的张数（健康检查/测试用） */
  get cardCount(): number {
    return this.cards.size;
  }
}
