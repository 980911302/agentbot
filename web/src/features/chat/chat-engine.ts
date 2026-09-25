import { isActiveChatRun, type ChatRun, type ChatReceipt, type ChatSnapshot, type JournalEntry } from '../../../../src/shared/contracts/chat-state';
import type { AgentEvent, ArtifactView, DisplayMessage, RoomEvent, InteractionRequest } from '../../types';
import { applyEvent } from './message-reducer';

export type Snapshot = ChatSnapshot<DisplayMessage, ArtifactView>;
interface PendingSend { channelId: string; text: string; uncertain: boolean }

/** 无框架聊天状态引擎。只有这里拥有运行/消息状态；React 只是订阅与 UI 适配。 */
export class ChatEngine {
  histories: Record<string, DisplayMessage[]> = {};
  /** 哪些频道已经拉过快照——切频道时据此决定要不要显示骨架（bug_d2xiqthtxdmm） */
  loadedChannels: Record<string, true> = {};
  interactions: InteractionRequest[] = [];
  private interactionSeq = 0;
  readonly runs = new Map<string, ChatRun>();
  readonly pending = new Map<string, PendingSend>();
  private readonly live = new Map<string, string>();
  private readonly runSeq = new Map<string, number>();
  private readonly historySeq = new Map<string, number>();
  private epoch = '';
  private lastEventSeq = 0;
  private version = 0;
  private listeners = new Set<() => void>();
  private snapshotQueue: Promise<unknown> = Promise.resolve();
  load(read: () => Promise<Snapshot>): Promise<Snapshot> {
    const pending = this.snapshotQueue.catch(() => undefined).then(read).then(snapshot => {
      this.restore(snapshot);
      // 快照回来了就说明这些频道的历史已到手：可能有消息，也可能真空（空频道不该一直转骨架）
      for (const channelId of Object.keys(snapshot.channels)) this.loadedChannels[channelId] = true;
      this.changed();
      return snapshot;
    });
    this.snapshotQueue = pending;
    return pending;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;
  private changed() { this.version += 1; for (const listener of this.listeners) listener(); }
  setInteractions = (list: InteractionRequest[]) => { this.interactions = list; this.changed(); };

  setHistories = (update: Record<string, DisplayMessage[]> | ((prev: Record<string, DisplayMessage[]>) => Record<string, DisplayMessage[]>)) => {
    this.histories = typeof update === 'function' ? update(this.histories) : update;
    this.changed();
  };

  beginSend(channelId: string, key: string, text: string, senderName: string): void {
    this.pending.set(key, { channelId, text, uncertain: false });
    const list = (this.histories[channelId] ?? []).filter(message => message.id !== `send-error-${key}`);
    if (!list.some(message => message.clientMessageId === key || message.id === `pending-${key}`)) {
      list.push({ id: `pending-${key}`, clientMessageId: key, role: 'user', content: text,
        senderName, toolCalls: [], createdAt: new Date().toISOString() });
    }
    this.histories = { ...this.histories, [channelId]: list };
    this.changed();
  }

  acceptReceipt(receipt: ChatReceipt): void {
    // 回执不是消费游标；比它更晚的终态可能已经从 SSE 到达。
    if (receipt.run) this.applyRun(receipt.run, receipt.receiptSeq);
    this.changed();
  }

  sendFailed(key: string, reason: string): void {
    const pending = this.pending.get(key);
    if (!pending || [...this.runs.values()].some(run => run.clientMessageId === key && run.channelId === pending.channelId)) return;
    pending.uncertain = true;
    const error: DisplayMessage = { id: `send-error-${key}`, role: 'assistant', content: `⚠️ 未确认是否已受理：${reason}`,
      error: true, retryText: pending.text, retryClientMessageId: key, toolCalls: [], createdAt: new Date().toISOString() };
    this.histories = { ...this.histories, [pending.channelId]: [...(this.histories[pending.channelId] ?? []).filter(m => m.id !== error.id), error] };
    this.changed();
  }

  restore(snapshot: Snapshot): void {
    if (this.epoch && this.epoch !== snapshot.cursor.epoch) {
      this.runs.clear(); this.live.clear(); this.runSeq.clear(); this.historySeq.clear(); this.lastEventSeq = 0;
      this.interactions = []; this.interactionSeq = 0;
    }
    this.epoch = snapshot.cursor.epoch;
    if (snapshot.interactions && snapshot.cursor.seq >= this.interactionSeq) {
      this.interactions = snapshot.interactions; this.interactionSeq = snapshot.cursor.seq;
    }
    for (const [channelId, channel] of Object.entries(snapshot.channels)) {
      const current = this.histories[channelId] ?? [];
      const newer = snapshot.cursor.seq >= (this.historySeq.get(channelId) ?? 0);
      const incoming = new Map(channel.messages.map(message => [message.id, message]));
      const retained = newer ? current.filter(message => message.error || message.id.startsWith('pending-') ||
        (message.clientMessageId && [...this.runs.values()].some(run => run.clientMessageId === message.clientMessageId && isActiveChatRun(run)))) : current;
      const merged = new Map(retained.map(message => [message.id, message]));
      for (const [id, message] of incoming) {
        if (newer || !merged.has(id)) merged.set(id, message);
      }
      const confirmedKeys = new Set([...merged.values()].filter(m => !m.id.startsWith('pending-')).map(m => m.clientMessageId).filter(Boolean));
      this.histories = { ...this.histories, [channelId]: [...merged.values()]
        .filter(m => !(m.id.startsWith('pending-') && confirmedKeys.has(m.clientMessageId)))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)) };
      this.historySeq.set(channelId, Math.max(this.historySeq.get(channelId) ?? 0, snapshot.cursor.seq));
    }
    for (const run of snapshot.runs) this.applyRun(run, snapshot.cursor.seq);
    this.changed();
  }

  applyEntry(entry: JournalEntry): boolean {
    if (entry.epoch && this.epoch && entry.epoch !== this.epoch) return false;
    if (entry.seq <= this.lastEventSeq) return false;
    this.lastEventSeq = entry.seq;
    if (entry.epoch) this.epoch = entry.epoch;
    const channelId = entry.roomId ?? entry.agentId;
    if (!channelId) return false;
    if (entry.kind === 'agent' && entry.seq > this.interactionSeq) {
      const event = entry.payload as AgentEvent;
      if (event.type === 'interaction') {
        this.interactions = [...this.interactions.filter(item => item.id !== event.request.id), event.request];
        this.interactionSeq = entry.seq;
      } else if (event.type === 'interaction_closed') {
        this.interactions = this.interactions.filter(item => item.id !== event.id);
        this.interactionSeq = entry.seq;
      }
    }
    if (entry.kind === 'run') {
      const payload = entry.payload as { run?: ChatRun };
      if (payload.run) this.applyRun(payload.run, entry.seq);
    } else if (entry.seq > (this.historySeq.get(channelId) ?? 0)) {
      if (entry.kind === 'agent' && !entry.roomId) {
        const event = entry.payload as AgentEvent;
        // 旧版本曾把内部群经历作为 agent 事件广播。群消息只属于群频道，不能
        // 因缺少 JournalEntry.roomId 而落进成员私聊；服务端修正后这里仍做防御。
        if (event.type === 'message' && (event.message.roomId || event.message.source === 'room')) {
          this.historySeq.set(channelId, entry.seq);
          this.changed();
          return true;
        }
        if (event.type === 'delta' && entry.runId) this.live.set(entry.runId, (this.live.get(entry.runId) ?? '') + event.text);
        if (event.type === 'final' && entry.runId) this.live.delete(entry.runId);
        if (event.type === 'message' || event.type === 'correspondence') {
          this.histories = { ...this.histories, [channelId]: applyEvent(this.histories[channelId] ?? [], event) };
          if (event.type === 'message' && event.message.role === 'assistant' && event.message.content.type === 'text' && entry.runId) this.live.delete(entry.runId);
        }
      } else if (entry.kind === 'room') {
        const event = entry.payload as RoomEvent;
        if (event.type === 'room_message') {
          const m = event.message;
          const list = this.histories[channelId] ?? [];
          const message: DisplayMessage = { id: m.id, clientMessageId: m.clientMessageId,
            role: m.senderKind === 'user' ? 'user' : 'assistant', content: m.text,
            senderName: m.senderName, senderColor: m.senderColor, toolCalls: [], createdAt: new Date(m.createdAt).toISOString() };
          this.histories = { ...this.histories, [channelId]: [
            ...list.filter(item => item.id !== m.id && !(m.clientMessageId && item.id === `pending-${m.clientMessageId}`)), message,
          ] };
        }
      }
      this.historySeq.set(channelId, entry.seq);
    }
    this.changed();
    return true;
  }

  private applyRun(run: ChatRun, seq: number): void {
    const previous = this.runs.get(run.runId);
    if (seq < (this.runSeq.get(run.runId) ?? 0)) return;
    if (previous && !isActiveChatRun(previous) && isActiveChatRun(run)) return;
    this.runs.set(run.runId, run); this.runSeq.set(run.runId, seq);
    if (!isActiveChatRun(run) || run.status === 'finalizing') this.live.delete(run.runId);
    if (!isActiveChatRun(run)) {
      this.histories = { ...this.histories, [run.channelId]: (this.histories[run.channelId] ?? []).map(message =>
        message.runId === run.runId ? { ...message, toolCalls: message.toolCalls.map(call => call.status === 'running'
          ? { ...call, status: 'error' as const, result: '本次执行已结束，工具结果尚未确认；请核对后再继续。' } : call) } : message) };
    }
    // 重试要发的是用户原话：账本里的 input 会被精简，事实源是对话里那条消息
    const pendingEntry = run.clientMessageId ? this.pending.get(run.clientMessageId) : undefined;
    const pendingText = pendingEntry?.channelId === run.channelId ? pendingEntry.text : undefined;
    if (run.clientMessageId) {
      const key = run.clientMessageId;
      const pending = this.pending.get(key);
      if (pending?.channelId === run.channelId) this.pending.delete(key);
      const list = this.histories[run.channelId] ?? [];
      const confirmed = list.some(m => m.id === run.messageId);
      this.histories = { ...this.histories, [run.channelId]: list
        .filter(m => m.id !== `send-error-${key}` && !(confirmed && m.id === `pending-${key}`))
        .map(m => m.id === `pending-${key}` && run.messageId ? { ...m, id: run.messageId, runId: run.runId } : m) };
    }
    if (run.status === 'failed' || run.status === 'interrupted') {
      const id = `run-error-${run.runId}`;
      const list = this.histories[run.channelId] ?? [];
      if (!list.some(m => m.id === id)) {
        // 优先级：对话里那条持久消息（事实源）→ 未确认的乐观占位 → 账本 input（已精简，兜底）
        const origin = list.find(item => item.id === run.messageId && item.role === 'user')?.content;
        const retryText = run.source === 'user' ? (origin ?? pendingText ?? run.input) : undefined;
        this.histories = { ...this.histories, [run.channelId]: [...list, {
          id, runId: run.runId, role: 'assistant', content: `⚠️ ${run.error ?? '执行失败'}`,
          error: true, retryText, toolCalls: [], createdAt: new Date(run.updatedAt).toISOString(),
        }] };
      }
    }
    // 保留活动/挂起任务；终态 UI 缓存有界，历史消息仍在各频道。
    const finished = [...this.runs.values()].filter(item => !isActiveChatRun(item) && item.status !== 'parked');
    for (const old of finished.slice(0, Math.max(0, finished.length - 1000))) {
      this.runs.delete(old.runId); this.runSeq.delete(old.runId); this.live.delete(old.runId);
    }
  }

  get busy(): boolean { return [...this.runs.values()].some(isActiveChatRun) || [...this.pending.values()].some(p => !p.uncertain); }
  get respondingChannelIds(): string[] { return [...new Set([
    ...[...this.runs.values()].filter(run => run.status === 'queued' || run.status === 'running').map(run => run.channelId),
    ...[...this.pending.values()].filter(p => !p.uncertain).map(p => p.channelId),
  ])]; }
  liveFor(channelId: string): string {
    return [...this.runs.values()].filter(run => run.channelId === channelId && isActiveChatRun(run))
      .map(run => this.live.get(run.runId) ?? '').join('\n').trim();
  }
}
