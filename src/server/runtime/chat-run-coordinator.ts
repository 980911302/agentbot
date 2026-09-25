import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isActiveChatRun, type ChatRun, type ChatRunStatus } from '../../shared/contracts/chat-state.js';
import { writeJsonAtomic } from '../../storage/atomic-json.js';
import type { EventJournal } from '../events/journal.js';
import type { SendOptions } from './types.js';
import type { AgentEvent } from '../../shared/contracts/sse.js';

interface StoredRun extends ChatRun {
  commandHash?: string;
  /** 原始输入长度；input 被精简后仍能看出原来是多长 */
  inputLength?: number;
}
const OBSERVER = Symbol('chat.originalObservers');
type ScopedOptions = SendOptions & { [OBSERVER]?: SendOptions };
type NewRun = Pick<ChatRun, 'channelId' | 'kind' | 'source' | 'input'> &
  Partial<
    Pick<ChatRun, 'runId' | 'taskId' | 'parentRunId' | 'agentId' | 'roomId' | 'clientMessageId' | 'messageId'>
  >;

/** 已完成运行保留的条数（幂等记录跟随运行保留） */
const FINISHED_LIMIT = 1000;
/** 已结束运行的输入只留前这么多字：账本不该把整段对话抄一遍（重试文案从对话消息取） */
const INPUT_KEEP_CHARS = 500;

function clientKey(channelId: string, clientMessageId: string): string {
  return channelId + '\u0000' + clientMessageId;
}

/**
 * 精简已结束运行的输入：运行中/挂起的保留完整输入，其余终态一律只留前 500 字。
 * 精简后 inputLength 记原始长度、commandHash 留着做幂等比对；界面重试用的是对话里
 * 那条用户消息（chat-engine 的 retryText 优先从对话取），不依赖这里的正文。
 */
function trimmed(run: StoredRun): StoredRun {
  if (isActiveChatRun(run) || run.status === 'parked') return run;
  const inputLength = run.inputLength ?? run.input.length;
  const input = run.input.length > INPUT_KEEP_CHARS ? run.input.slice(0, INPUT_KEEP_CHARS) : run.input;
  return input === run.input && inputLength === run.inputLength ? run : { ...run, input, inputLength };
}

/**
 * 单实例聊天控制面：命令去重、运行身份、唯一收尾、事件出口。
 * 落盘走 `writeJsonAtomic`（异步、同文件串行），**发布前 await 写入完成**，
 * 保持「先持久再对外发布」；正在执行的 Promise 不落盘。重启只标中断，不重放副作用。
 * 调度/工具/模型仍属于 RunExecutor；本类不拥有 WebSocket/SSE/HTTP 连接。
 */
export class ChatRunCoordinator {
  private readonly file: string;
  private records = new Map<string, StoredRun>();
  /** channelId + clientMessageId → runId：prepare 去重不再全表扫描 */
  private readonly clientIndex = new Map<string, string>();
  private readonly executions = new Map<string, Promise<unknown>>();
  private readonly acceptances = new Map<string, Promise<unknown>>();

  async accept<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.acceptances.get(key);
    const pending = (previous ?? Promise.resolve()).catch(() => undefined).then(work);
    this.acceptances.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.acceptances.get(key) === pending) this.acceptances.delete(key);
    }
  }

  constructor(
    dataDir: string,
    private readonly events: EventJournal,
  ) {
    this.file = join(dataDir, 'chat', 'runs.json');
    if (existsSync(this.file)) {
      const doc = JSON.parse(readFileSync(this.file, 'utf8')) as { version: number; runs: StoredRun[] };
      if (doc.version !== 1 || !Array.isArray(doc.runs)) throw new Error('聊天运行账本格式无效');
      for (const saved of doc.runs) {
        const run = trimmed(
          isActiveChatRun(saved)
            ? {
                ...saved,
                status: 'interrupted' as const,
                error: '进程退出，本次执行已中断；请核对结果后继续任务。',
                updatedAt: Date.now(),
              }
            : saved,
        );
        this.records.set(run.runId, run);
        this.index(run);
      }
      // 旧文件补齐 inputLength / 精简历史输入；不阻塞启动，写序由 writeJsonAtomic 保证
      this.persistInBackground(this.persist(), '启动回写');
    }
  }

  get(id: string): ChatRun | undefined {
    const run = this.records.get(id);
    if (!run) return undefined;
    const { commandHash: _, ...view } = run;
    return { ...view };
  }

  list(): ChatRun[] {
    return [...this.records.keys()].map((id) => this.get(id)!);
  }

  async prepare(
    input: NewRun,
    commandOptions: unknown = null,
  ): Promise<{ run: ChatRun; duplicate: boolean }> {
    if (input.input.length > 200_000) throw new Error('消息过长，请拆分发送');
    if (input.clientMessageId && !/^[A-Za-z0-9_-]{1,128}$/.test(input.clientMessageId))
      throw new Error('无效的 clientMessageId');
    const hash = createHash('sha256')
      .update(JSON.stringify([input.input, commandOptions]))
      .digest('hex');
    if (input.clientMessageId) {
      const existingId = this.clientIndex.get(clientKey(input.channelId, input.clientMessageId));
      const existing = existingId ? this.records.get(existingId) : undefined;
      if (existing) {
        if (existing.commandHash !== hash) throw new Error('同一个 clientMessageId 不能用于不同请求');
        return { run: this.get(existing.runId)!, duplicate: true };
      }
    }
    const runId = input.runId ?? randomUUID();
    const parent = input.parentRunId ? this.get(input.parentRunId) : undefined;
    const run: StoredRun = {
      ...input,
      runId,
      taskId: input.taskId ?? parent?.taskId ?? runId,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      commandHash: hash,
    };
    await this.commit(run);
    this.publishState(run, 'queued');
    return { run: this.get(runId)!, duplicate: false };
  }

  /** 绑定的是外部观察者，嵌套群/子运行不重复调用父运行的日志包装器。 */
  bind(run: ChatRun, options: SendOptions = {}): SendOptions {
    const observer = (options as ScopedOptions)[OBSERVER] ?? options;
    const publish = (kind: 'agent' | 'room', payload: unknown): void => {
      if (!isActiveChatRun(this.get(run.runId) ?? run)) return;
      const event = kind === 'agent' ? (payload as AgentEvent) : undefined;
      // 群成员可以显式私发主人；持久消息目的地优先于执行所在房间。
      const privateMessage = run.roomId && event?.type === 'message' && !event.message.roomId;
      this.events.publish({
        kind,
        agentId: privateMessage ? event.message.agentId : run.agentId,
        roomId: privateMessage ? undefined : run.roomId,
        runId: run.runId,
        taskId: run.taskId,
        clientMessageId: run.clientMessageId,
        payload,
      });
    };
    const notify = (action: () => void): void => {
      try {
        action();
      } catch {
        /* 观察者不能打断执行 */
      }
    };
    const bound: ScopedOptions = {
      ...options,
      runId: run.runId,
      [OBSERVER]: observer,
      onEvent: (event) => {
        publish('agent', event);
        if (event.type === 'final') this.finalizing(run.runId);
        notify(() => observer.onEvent?.(event));
      },
      onDelta: (text) => {
        publish('agent', { type: 'delta', text });
        notify(() => observer.onDelta?.(text));
      },
      onRoomEvent: (event) => {
        publish('room', event);
        notify(() => observer.onRoomEvent?.(event));
      },
    };
    return bound;
  }

  execute<T>(
    runId: string,
    work: () => Promise<T>,
    done: (result: T) => { stopReason?: string },
  ): Promise<T> {
    const existing = this.executions.get(runId);
    if (existing) return existing as Promise<T>;
    const run = this.get(runId);
    if (!run || run.status !== 'queued') throw new Error('这次执行已结束；继续任务需要新建运行');
    // 先登记 Promise，再 await 落盘：同步重入拿到同一个执行，不会重复跑
    const execution = (async () => {
      await this.transition(runId, 'running', 'started');
      try {
        const result = await work();
        const reason = done(result).stopReason ?? 'final_answer';
        const status: ChatRunStatus =
          reason === 'parked' || reason === 'waiting'
            ? 'parked'
            : reason === 'cancelled' || reason === 'stopped'
              ? 'cancelled'
              : reason === 'max_iterations' || reason === 'tool_limit'
                ? 'incomplete'
                : 'succeeded';
        await this.transition(runId, status, 'done', { stopReason: reason });
        return result;
      } catch (error) {
        await this.transition(runId, 'failed', 'error', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    })().finally(() => this.executions.delete(runId));
    this.executions.set(runId, execution);
    return execution;
  }

  async fail(runId: string, error: unknown): Promise<void> {
    await this.transition(runId, 'failed', 'error', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private finalizing(runId: string): void {
    if (this.get(runId)?.status !== 'running') return;
    // 事件回调是同步的：写盘与发布在 transition 内部保持先后顺序，这里不等它
    this.persistInBackground(this.transition(runId, 'finalizing', 'finalizing'), 'finalizing');
  }

  /** 同步回调里没法 await 的落盘：写失败只记一笔，不能让观察者抛出去打断执行 */
  private persistInBackground(work: Promise<void>, what: string): void {
    void work.catch((error) => {
      console.error(`[chat-runs] ${what} 落盘失败：`, error);
    });
  }

  private async transition(
    runId: string,
    status: ChatRunStatus,
    phase: string,
    patch: Partial<ChatRun> = {},
  ): Promise<void> {
    const current = this.records.get(runId);
    if (!current || !isActiveChatRun(current)) return;
    const run = { ...current, ...patch, status, updatedAt: Date.now() };
    await this.commit(run);
    this.publishState(run, phase);
  }

  private publishState(run: ChatRun, phase: string): void {
    this.events.publish({
      kind: 'run',
      runId: run.runId,
      taskId: run.taskId,
      clientMessageId: run.clientMessageId,
      agentId: run.agentId,
      roomId: run.roomId,
      payload: { phase, stopReason: run.stopReason, message: run.error, run: this.get(run.runId) },
    });
  }

  /** 内存先改，再精简 + 裁剪 + 落盘；调用方 await 完成后再对外发布 */
  private async commit(run: StoredRun): Promise<void> {
    const next = new Map(this.records).set(run.runId, trimmed(run));
    // 幂等记录跟随运行保留；不裁正在运行/挂起的任务。
    const finished = [...next.values()]
      .filter((item) => !isActiveChatRun(item) && item.status !== 'parked')
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const old of finished.slice(FINISHED_LIMIT)) {
      next.delete(old.runId);
      this.deindex(old);
    }
    this.records = next;
    this.index(run);
    await this.persist();
  }

  private persist(): Promise<void> {
    return writeJsonAtomic(this.file, { version: 1, runs: [...this.records.values()] }, { mode: 0o600 });
  }

  private index(run: StoredRun): void {
    if (!run.clientMessageId) return;
    this.clientIndex.set(clientKey(run.channelId, run.clientMessageId), run.runId);
  }

  private deindex(run: StoredRun): void {
    if (!run.clientMessageId) return;
    const key = clientKey(run.channelId, run.clientMessageId);
    if (this.clientIndex.get(key) === run.runId) this.clientIndex.delete(key);
  }
}
