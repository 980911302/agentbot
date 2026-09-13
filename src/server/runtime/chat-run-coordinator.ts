import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isActiveChatRun, type ChatRun, type ChatRunStatus } from '../../shared/contracts/chat-state.js';
import type { EventJournal } from '../events/journal.js';
import type { SendOptions } from './types.js';
import type { AgentEvent } from '../../shared/contracts/sse.js';

interface StoredRun extends ChatRun { commandHash?: string }
const OBSERVER = Symbol('chat.originalObservers');
type ScopedOptions = SendOptions & { [OBSERVER]?: SendOptions };
type NewRun = Pick<ChatRun, 'channelId' | 'kind' | 'source' | 'input'> & Partial<Pick<ChatRun,
  'runId' | 'taskId' | 'parentRunId' | 'agentId' | 'roomId' | 'clientMessageId' | 'messageId'>>;

/**
 * 单实例聊天控制面：命令去重、运行身份、唯一收尾、事件出口。
 * JSON 原子替换先于对外发布；正在执行的 Promise 不落盘。重启只标中断，不重放副作用。
 * 调度/工具/模型仍属于 RunExecutor；本类不拥有 WebSocket/SSE/HTTP 连接。
 */
export class ChatRunCoordinator {
  private readonly file: string;
  private records = new Map<string, StoredRun>();
  private readonly executions = new Map<string, Promise<unknown>>();
  private readonly acceptances = new Map<string, Promise<unknown>>();

  async accept<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.acceptances.get(key);
    const pending = (previous ?? Promise.resolve()).catch(() => undefined).then(work);
    this.acceptances.set(key, pending);
    try { return await pending; }
    finally { if (this.acceptances.get(key) === pending) this.acceptances.delete(key); }
  }

  constructor(dataDir: string, private readonly events: EventJournal) {
    this.file = join(dataDir, 'chat', 'runs.json');
    if (existsSync(this.file)) {
      const doc = JSON.parse(readFileSync(this.file, 'utf8')) as { version: number; runs: StoredRun[] };
      if (doc.version !== 1 || !Array.isArray(doc.runs)) throw new Error('聊天运行账本格式无效');
      for (const saved of doc.runs) {
        const run = isActiveChatRun(saved)
          ? { ...saved, status: 'interrupted' as const, error: '进程退出，本次执行已中断；请核对结果后继续任务。', updatedAt: Date.now() }
          : saved;
        this.records.set(run.runId, run);
      }
      this.persist(this.records);
    }
  }

  get(id: string): ChatRun | undefined {
    const run = this.records.get(id);
    if (!run) return undefined;
    const { commandHash: _, ...view } = run;
    return { ...view };
  }

  list(): ChatRun[] { return [...this.records.keys()].map(id => this.get(id)!); }

  prepare(input: NewRun, commandOptions: unknown = null): { run: ChatRun; duplicate: boolean } {
    if (input.input.length > 200_000) throw new Error('消息过长，请拆分发送');
    if (input.clientMessageId && !/^[A-Za-z0-9_-]{1,128}$/.test(input.clientMessageId)) throw new Error('无效的 clientMessageId');
    const hash = createHash('sha256').update(JSON.stringify([input.input, commandOptions])).digest('hex');
    if (input.clientMessageId) {
      const existing = [...this.records.values()].find(run => run.channelId === input.channelId &&
        run.clientMessageId === input.clientMessageId && run.source === 'user');
      if (existing) {
        if (existing.commandHash !== hash) throw new Error('同一个 clientMessageId 不能用于不同请求');
        return { run: this.get(existing.runId)!, duplicate: true };
      }
    }
    const runId = input.runId ?? randomUUID();
    const parent = input.parentRunId ? this.get(input.parentRunId) : undefined;
    const run: StoredRun = {
      ...input, runId, taskId: input.taskId ?? parent?.taskId ?? runId,
      status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), commandHash: hash,
    };
    this.commit(run);
    this.publishState(run, 'queued');
    return { run: this.get(runId)!, duplicate: false };
  }

  /** 绑定的是外部观察者，嵌套群/子运行不重复调用父运行的日志包装器。 */
  bind(run: ChatRun, options: SendOptions = {}): SendOptions {
    const observer = (options as ScopedOptions)[OBSERVER] ?? options;
    const publish = (kind: 'agent' | 'room', payload: unknown): void => {
      if (!isActiveChatRun(this.get(run.runId) ?? run)) return;
      const event = kind === 'agent' ? payload as AgentEvent : undefined;
      // 群成员可以显式私发主人；持久消息目的地优先于执行所在房间。
      const privateMessage = run.roomId && event?.type === 'message' && !event.message.roomId;
      this.events.publish({ kind, agentId: privateMessage ? event.message.agentId : run.agentId, roomId: privateMessage ? undefined : run.roomId,
        runId: run.runId, taskId: run.taskId, clientMessageId: run.clientMessageId, payload });
    };
    const notify = (action: () => void): void => { try { action(); } catch { /* 观察者不能打断执行 */ } };
    const bound: ScopedOptions = {
      ...options, runId: run.runId,
      [OBSERVER]: observer,
      onEvent: event => {
        publish('agent', event);
        if (event.type === 'final') this.finalizing(run.runId);
        notify(() => observer.onEvent?.(event));
      },
      onDelta: text => { publish('agent', { type: 'delta', text }); notify(() => observer.onDelta?.(text)); },
      onRoomEvent: event => { publish('room', event); notify(() => observer.onRoomEvent?.(event)); },
    };
    return bound;
  }

  async execute<T>(runId: string, work: () => Promise<T>, done: (result: T) => { stopReason?: string }): Promise<T> {
    const existing = this.executions.get(runId);
    if (existing) return existing as Promise<T>;
    const run = this.get(runId);
    if (!run || run.status !== 'queued') throw new Error('这次执行已结束；继续任务需要新建运行');
    this.transition(runId, 'running', 'started');
    // 先登记 Promise，再调用工作函数，防止同步重入产生第二次执行。
    const execution = Promise.resolve().then(work).then(result => {
      const reason = done(result).stopReason ?? 'final_answer';
      const status: ChatRunStatus = reason === 'parked' ? 'parked' : reason === 'cancelled' || reason === 'stopped' ? 'cancelled'
        : reason === 'max_iterations' || reason === 'tool_limit' ? 'incomplete' : 'succeeded';
      this.transition(runId, status, 'done', { stopReason: reason });
      return result;
    }).catch(error => {
      this.transition(runId, 'failed', 'error', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }).finally(() => this.executions.delete(runId));
    this.executions.set(runId, execution);
    return execution;
  }

  fail(runId: string, error: unknown): void {
    this.transition(runId, 'failed', 'error', { error: error instanceof Error ? error.message : String(error) });
  }
  private finalizing(runId: string): void {
    if (this.get(runId)?.status === 'running') this.transition(runId, 'finalizing', 'finalizing');
  }
  private transition(runId: string, status: ChatRunStatus, phase: string, patch: Partial<ChatRun> = {}): void {
    const current = this.records.get(runId);
    if (!current || !isActiveChatRun(current)) return;
    const run = { ...current, ...patch, status, updatedAt: Date.now() };
    this.commit(run);
    this.publishState(run, phase);
  }
  private publishState(run: ChatRun, phase: string): void {
    this.events.publish({ kind: 'run', runId: run.runId, taskId: run.taskId,
      clientMessageId: run.clientMessageId, agentId: run.agentId, roomId: run.roomId,
      payload: { phase, stopReason: run.stopReason, message: run.error, run: this.get(run.runId) } });
  }
  private commit(run: StoredRun): void {
    const next = new Map(this.records).set(run.runId, run);
    // 幂等记录跟随运行保留；不裁正在运行/挂起的任务。
    const finished = [...next.values()].filter(item => !isActiveChatRun(item) && item.status !== 'parked')
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const old of finished.slice(1000)) next.delete(old.runId);
    this.persist(next);
    this.records = next;
  }
  private persist(records: Map<string, StoredRun>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, runs: [...records.values()] }), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
