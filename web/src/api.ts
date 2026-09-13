import type {
  ArtifactView,
  BotSummary,
  DisplayMessage,
  HealthInfo,
  InteractionRequest,
  MemoryScope,
  MemorySnapshot,
  MemoryTier,
  RoomMessage,
  RoomView,
  SessionSummary,
} from './types';

import { errorMessage, readSseFrames, request } from './shared/transport';
import type { ChatReceipt, JournalEntry, ChatSnapshot } from '../../src/shared/contracts/chat-state';
import type { Ready } from './features/events/event-client';
export type { JournalEntry } from '../../src/shared/contracts/chat-state';

export function fetchHealth(): Promise<HealthInfo> {
  return request('/api/health');
}

export async function fetchBots(): Promise<BotSummary[]> {
  const data = await request<{ bots: BotSummary[] }>('/api/bots');
  return data.bots;
}

export async function createBot(input: { name: string; role: string }): Promise<BotSummary> {
  const data = await request<{ bot: BotSummary }>('/api/bots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return data.bot;
}

export async function deleteBot(id: string): Promise<void> {
  await request(`/api/bots/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 编辑智能体资料：名字 / 职责（instructions）/ 配色 */
export async function updateBot(
  id: string,
  input: {
    name?: string;
    instructions?: string;
    description?: string;
    section?: string;
    color?: string;
    hidden?: boolean;
  },
): Promise<BotSummary> {
  const data = await request<{ bot: BotSummary }>(`/api/bots/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return data.bot;
}

export async function fetchSessions(botId: string): Promise<SessionSummary[]> {
  const data = await request<{ sessions: SessionSummary[] }>(
    `/api/sessions?botId=${encodeURIComponent(botId)}`,
  );
  return data.sessions;
}

export async function createSession(botId: string, model?: string): Promise<SessionSummary> {
  const data = await request<{ session: SessionSummary }>('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ botId, model }),
  });
  return data.session;
}

export function fetchSession(
  id: string,
): Promise<{ session: SessionSummary; messages: DisplayMessage[]; artifacts: ArtifactView[] }> {
  return request(`/api/sessions/${encodeURIComponent(id)}`);
}

export function fetchCorrespondence(agentId: string, peerId: string, before?: string, signal?: AbortSignal) {
  return request<{ messages: import('../../src/shared/contracts/message-identity').Correspondence[]; nextBefore: string | null }>(
    `/api/agents/${encodeURIComponent(agentId)}/correspondence/${encodeURIComponent(peerId)}${before ? `?before=${encodeURIComponent(before)}` : ''}`, { signal });
}

export async function deleteSession(id: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function fetchMemory(agentId: string): Promise<MemorySnapshot> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/memory`);
}

export async function writeMemory(
  agentId: string,
  input: { text: string; scope?: MemoryScope; tier?: MemoryTier; tags?: string[] },
): Promise<void> {
  await request(`/api/agents/${encodeURIComponent(agentId)}/memory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function deleteMemory(
  agentId: string,
  scope: MemoryScope,
  ownerId: string,
  entryId: string,
): Promise<void> {
  await request(
    `/api/agents/${encodeURIComponent(agentId)}/memory/${scope}/${encodeURIComponent(ownerId)}/${entryId}`,
    { method: 'DELETE' },
  );
}

export async function promoteMemory(
  agentId: string,
  scope: MemoryScope,
  ownerId: string,
  entryId: string,
  tier: MemoryTier,
): Promise<void> {
  await request(
    `/api/agents/${encodeURIComponent(agentId)}/memory/${scope}/${encodeURIComponent(ownerId)}/${entryId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier }),
    },
  );
}

// ── 交互卡片 ───────────────────────────────────────────

export async function fetchInteractions(agentId?: string): Promise<InteractionRequest[]> {
  const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
  const data = await request<{ interactions: InteractionRequest[] }>(`/api/interactions${query}`);
  return data.interactions;
}

/** 回答问题：choice 传 value，secret 传 secret（值不落对话、不进记忆） */
export async function answerInteraction(
  id: string,
  answer: { value?: string; secret?: string; cancelled?: boolean },
): Promise<void> {
  await request(`/api/interactions/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(answer),
  });
}

export async function fetchSecretNames(): Promise<string[]> {
  const data = await request<{ names: string[] }>('/api/secrets');
  return data.names;
}

// ── 房间（群） ─────────────────────────────────────────

export async function fetchRooms(): Promise<{ rooms: RoomView[]; memberLimit: number }> {
  return request('/api/rooms');
}

export async function createRoom(input: { name: string; memberIds: string[] }): Promise<RoomView> {
  const data = await request<{ room: RoomView }>('/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return data.room;
}

export async function fetchRoomMessages(roomId: string): Promise<RoomMessage[]> {
  const data = await request<{ messages: RoomMessage[] }>(
    `/api/rooms/${encodeURIComponent(roomId)}/messages`,
  );
  return data.messages;
}

export async function updateRoomMembers(roomId: string, memberIds: string[]): Promise<RoomView | null> {
  const data = await request<{ room: RoomView | null }>(`/api/rooms/${encodeURIComponent(roomId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberIds }),
  });
  return data.room;
}

export async function deleteRoom(roomId: string): Promise<void> {
  await request(`/api/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' });
}

export async function renameRoom(roomId: string, name: string): Promise<void> {
  await request(`/api/rooms/${encodeURIComponent(roomId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

// ── 发送与订阅（E3.4 第二步：发送只回执，事件走订阅）──

/** 收信回执：受理成功就返回，回合在后台跑，结果从事件订阅看 */
export type Receipt = ChatReceipt;

/** 一条界面事件（GET /api/events 的 entry 帧） */
export function fetchChatSnapshot(channels: string[]): Promise<ChatSnapshot<DisplayMessage, ArtifactView>> {
  return request(`/api/chat/state?channels=${encodeURIComponent(channels.join(','))}`);
}

/** 私聊发送：202 回执（messageId 已落盘）；回合照跑，事件走订阅 */
export async function sendChat(body: {
  botId: string;
  message: string;
  model?: string;
  clientMessageId?: string;
}): Promise<Receipt> {
  return request<Receipt>('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 群发送：202 受理回执；扇出在后台，谁开口走事件订阅 */
export async function sendRoomMessage(
  roomId: string,
  body: { text: string; model?: string; ownerName?: string; clientMessageId?: string },
): Promise<Receipt> {
  return request<Receipt>(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * 独立订阅界面事件（E3.4 第二步）。
 * ready 帧带当前游标与 resync 信号；之后按 seq 升序收 entry。
 * 断开由调用方负责重连（带上最后一条 seq 补发）。
 */
export async function readEvents(
  handlers: {
    onReady?: (info: Ready) => void;
    onEntry: (entry: JournalEntry) => void;
  },
  options: { after?: number; epoch?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const suffix = options.after === undefined ? '' : `?after=${options.after}&epoch=${encodeURIComponent(options.epoch ?? '')}`;
  const response = await fetch(`/api/events${suffix}`, { signal: options.signal });
  if (!response.ok) throw new Error(await errorMessage(response));
  if (!response.body) throw new Error('当前环境不支持流式响应');

  await readSseFrames(response, (raw) => {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    if (event === 'ready') {
      handlers.onReady?.(data as Ready);
      return;
    }
    if (event === 'entry') handlers.onEntry(data as JournalEntry);
  });
}
