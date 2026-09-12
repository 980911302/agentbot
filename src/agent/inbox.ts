import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type {
  DeliveryClaimInput,
  DeliveryFailureInput,
  DeliveryItem,
  DeliveryPort,
} from '../storage/ports.js';

/**
 * 智能体之间 1:1 的收件箱。
 *
 * 文档第 4.2 节：发出去就结束，不等对方回完；
 * 对方忙就排队，轮到它时同一批积压的消息一起到；
 * 它的回复是之后一个新回合，不是函数返回值。
 *
 * E3.3 起消费改为「领取 → 处理 → 确认」：
 *   - claim 带执行权（owner）与期限（leaseUntil），领取不删除内容；
 *   - 处理形成持久检查点（checkpoint）后再 ack 出队；
 *   - nack 有限退避，超限进 failed（可用 retryFailed 人工重试）；
 *   - 租约过期视为处理中断，下次领取按一次失败回收。
 * 落盘仍是 JSON（整文件覆盖），但同一 agent 的有效领取只有一个。
 */
export type InboxItem = DeliveryItem;
export type {
  DeliveryClaimInput,
  DeliveryFailureInput,
  DeliveryItem,
} from '../storage/ports.js';

/** 默认退避封顶：失败越多次等越久，但不无限涨 */
export const DELIVERY_MAX_BACKOFF_MS = 60_000;

/** drain 的处理顺序：停止令最前，其余保持到达顺序（优先信在入队时已插队首） */
export function sortInboxForDrain<T extends InboxItem>(list: T[]): T[] {
  const rank = (item: InboxItem): number => (item.kind === 'stop' ? 0 : 1);
  return [...list].sort((left, right) => rank(left) - rank(right));
}

interface InboxState {
  /** 每次领取递增；重启也不回退（E3.6 防迟到写入用） */
  epoch: number;
  items: InboxItem[];
}

export class AgentInbox implements DeliveryPort {
  private readonly cache = new Map<string, InboxState>();
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'inbox');
  }

  private file(agentId: string): string {
    return join(this.dir, `${agentId}.json`);
  }

  async enqueue(item: Omit<InboxItem, 'id' | 'createdAt'>): Promise<InboxItem> {
    const state = await this.load(item.toAgentId);
    const full: InboxItem = {
      ...item,
      id: randomUUID(),
      createdAt: Date.now(),
      status: 'pending',
      attempts: 0,
      availableAt: Date.now(),
    };
    // 标优先的插到队首，其余按到达顺序
    if (full.priority) state.items.unshift(full);
    else state.items.push(full);
    await this.save(full.toAgentId, state);
    return full;
  }

  /**
   * 原子领取：带执行权与期限，取递增 epoch。
   * 同一 agent 已有活的租约时返回空（执行权不在我手里）；
   * 过期租约按一次失败尝试回收，超限直接进 failed。
   */
  async claim(agentId: string, input: DeliveryClaimInput): Promise<InboxItem[]> {
    const state = await this.load(agentId);
    const now = input.now ?? Date.now();

    const held = state.items.some(
      (item) =>
        item.status === 'claimed' &&
        (item.leaseUntil ?? 0) > now &&
        item.leaseOwner !== undefined &&
        item.leaseOwner !== input.owner,
    );
    if (held) return [];

    let mutated = false;
    for (const item of state.items) {
      if (item.status !== 'claimed' || (item.leaseUntil ?? 0) > now) continue;
      mutated = true;
      item.status = 'pending';
      item.lastError = '领取超时未确认（进程中断或超时）';
      item.attempts = (item.attempts ?? 0) + 1;
      item.availableAt = now;
      delete item.leaseOwner;
      delete item.leaseUntil;
      if ((item.attempts ?? 0) >= input.maxAttempts) item.status = 'failed';
    }

    const eligible = state.items.filter(
      (item) => item.status === 'pending' && (item.availableAt ?? item.createdAt) <= now,
    );
    const claimed = sortInboxForDrain(eligible);
    if (claimed.length === 0) {
      if (mutated) await this.save(agentId, state);
      return [];
    }

    state.epoch += 1;
    for (const item of claimed) {
      item.status = 'claimed';
      item.leaseOwner = input.owner;
      item.leaseEpoch = state.epoch;
      item.leaseUntil = now + input.leaseMs;
    }
    await this.save(agentId, state);
    return claimed;
  }

  /** 确认：处理已形成持久检查点，出队 */
  async ack(agentId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const state = await this.load(agentId);
    const wanted = new Set(ids);
    const before = state.items.length;
    state.items = state.items.filter((item) => !wanted.has(item.id));
    const removed = before - state.items.length;
    if (removed > 0) await this.save(agentId, state);
    return removed;
  }

  /** 失败：有限退避退回 pending；达到上限进 failed，不再自动重试 */
  async nack(
    agentId: string,
    ids: string[],
    error: string,
    input: DeliveryFailureInput,
  ): Promise<{ failed: string[]; pending: string[] }> {
    const state = await this.load(agentId);
    const now = input.now ?? Date.now();
    const maxDelay = input.maxDelayMs ?? DELIVERY_MAX_BACKOFF_MS;
    const wanted = new Set(ids);
    const failed: string[] = [];
    const pending: string[] = [];

    for (const item of state.items) {
      if (!wanted.has(item.id)) continue;
      const attempts = (item.attempts ?? 0) + 1;
      item.attempts = attempts;
      item.lastError = error.slice(0, 500);
      delete item.leaseOwner;
      delete item.leaseUntil;
      if (attempts >= input.maxAttempts) {
        item.status = 'failed';
        failed.push(item.id);
      } else {
        item.status = 'pending';
        item.availableAt = now + Math.min(input.baseDelayMs * 2 ** (attempts - 1), maxDelay);
        pending.push(item.id);
      }
    }
    await this.save(agentId, state);
    return { failed, pending };
  }

  /** 归还领取：不算失败、不烧重试预算（AgentBusy 等「现在处理不了」） */
  async release(agentId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const state = await this.load(agentId);
    const wanted = new Set(ids);
    let mutated = false;
    for (const item of state.items) {
      if (!wanted.has(item.id) || item.status !== 'claimed') continue;
      mutated = true;
      item.status = 'pending';
      item.availableAt = Date.now();
      delete item.leaseOwner;
      delete item.leaseUntil;
    }
    if (mutated) await this.save(agentId, state);
  }

  /** 持久检查点：这批信已经折成了哪条消息（进模型前写下） */
  async checkpoint(
    agentId: string,
    ids: string[],
    patch: { messageId: string; turnId?: string; note?: string; at?: number },
  ): Promise<void> {
    if (ids.length === 0) return;
    const state = await this.load(agentId);
    const wanted = new Set(ids);
    let mutated = false;
    for (const item of state.items) {
      if (!wanted.has(item.id)) continue;
      mutated = true;
      item.checkpoint = {
        at: patch.at ?? Date.now(),
        messageId: patch.messageId,
        ...(patch.turnId ? { turnId: patch.turnId } : {}),
        ...(patch.note ? { note: patch.note } : {}),
      };
    }
    if (mutated) await this.save(agentId, state);
  }

  /** 人工重试 failed：清掉失败计数与错误，回到可领取 */
  async retryFailed(agentId: string): Promise<number> {
    const state = await this.load(agentId);
    let retried = 0;
    for (const item of state.items) {
      if (item.status !== 'failed') continue;
      retried += 1;
      item.status = 'pending';
      item.attempts = 0;
      item.availableAt = Date.now();
      delete item.lastError;
    }
    if (retried > 0) await this.save(agentId, state);
    return retried;
  }

  /** 取出（含领取中）未处理的信；failed 单独用 failedCount 读，不在这里混着展示 */
  async peek(agentId: string): Promise<InboxItem[]> {
    const state = await this.load(agentId);
    return state.items.filter((item) => item.status !== 'failed');
  }

  /** 取出满足条件的信（其余保留原序、状态不变）——stop-ack 的消费入口 */
  async take(agentId: string, predicate: (item: InboxItem) => boolean): Promise<InboxItem[]> {
    const state = await this.load(agentId);
    const taken = state.items.filter(predicate);
    if (taken.length === 0) return [];
    state.items = state.items.filter((item) => !predicate(item));
    await this.save(agentId, state);
    return taken;
  }

  async count(agentId: string): Promise<number> {
    const state = await this.load(agentId);
    return state.items.filter((item) => item.status !== 'failed').length;
  }

  async claimableCount(agentId: string, now = Date.now()): Promise<number> {
    const state = await this.load(agentId);
    return state.items.filter(
      (item) => item.status === 'pending' && (item.availableAt ?? item.createdAt) <= now,
    ).length;
  }

  async failedCount(agentId: string): Promise<number> {
    const state = await this.load(agentId);
    return state.items.filter((item) => item.status === 'failed').length;
  }

  async clear(agentId: string): Promise<void> {
    await this.save(agentId, { epoch: (await this.load(agentId)).epoch, items: [] });
  }

  private async load(agentId: string): Promise<InboxState> {
    const cached = this.cache.get(agentId);
    if (cached) return cached;

    let state: InboxState = { epoch: 0, items: [] };
    try {
      const raw = await readFile(this.file(agentId), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        // E3.3 之前的文件是纯数组：补 epoch 与生命周期字段
        state = { epoch: 0, items: parsed as InboxItem[] };
      } else if (parsed && typeof parsed === 'object') {
        const data = parsed as Partial<InboxState>;
        state = {
          epoch: typeof data.epoch === 'number' ? data.epoch : 0,
          items: Array.isArray(data.items) ? (data.items as InboxItem[]) : [],
        };
      }
    } catch {
      // 空箱
    }
    for (const item of state.items) {
      if (!item.status) item.status = 'pending';
      if (typeof item.attempts !== 'number') item.attempts = 0;
      if (typeof item.availableAt !== 'number') item.availableAt = item.createdAt;
    }
    this.cache.set(agentId, state);
    return state;
  }

  private async save(agentId: string, state: InboxState): Promise<void> {
    const file = this.file(agentId);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state, null, 2), 'utf8');
  }
}
