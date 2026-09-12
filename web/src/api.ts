import type {
  AgentEvent,
  ArtifactView,
  BotSummary,
  DisplayMessage,
  HealthInfo,
  InteractionRequest,
  MemoryScope,
  MemorySnapshot,
  MemoryTier,
  RoomEvent,
  RoomMessage,
  RoomView,
  RunResult,
  SessionSummary,
} from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as T;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // fall through to the status line
  }
  return `${response.status} ${response.statusText}`;
}

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

export interface RoomHandlers {
  onMessage?: (message: RoomMessage) => void;
  onRoundStart?: (event: { agentId: string; agentName: string }) => void;
  onRoundEnd?: (outcome: import('./types').RoundOutcome) => void;
  onFanoutDone?: (event: { spoke: number; silent: number }) => void;
  onError?: (message: string) => void;
}

/** 往群里发一句 → 后端扇出给全体成员（SSE 实时回报谁开口、谁沉默） */
export async function streamRoom(
  roomId: string,
  text: string,
  handlers: RoomHandlers,
  signal?: AbortSignal,
  model?: string,
): Promise<void> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, model }),
    signal,
  });

  if (!response.ok) {
    handlers.onError?.(await errorMessage(response));
    return;
  }
  if (!response.body) {
    handlers.onError?.('当前环境不支持流式响应');
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      dispatchRoomChunk(chunk, handlers);
      boundary = buffer.indexOf('\n\n');
    }
  }
}

function dispatchRoomChunk(raw: string, handlers: RoomHandlers): void {
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

  if (event === 'room') {
    const roomEvent = data as RoomEvent;
    switch (roomEvent.type) {
      case 'room_message':
        handlers.onMessage?.(roomEvent.message);
        break;
      case 'round_start':
        handlers.onRoundStart?.({ agentId: roomEvent.agentId, agentName: roomEvent.agentName });
        break;
      case 'round_end':
        handlers.onRoundEnd?.(roomEvent.outcome);
        break;
      case 'fanout_done':
        handlers.onFanoutDone?.({ spoke: roomEvent.spoke, silent: roomEvent.silent });
        break;
    }
    return;
  }

  if (event === 'error') {
    handlers.onError?.((data as { message?: string }).message ?? '未知错误');
  }
}

export interface ChatHandlers {
  onSession?: (sessionId: string) => void;
  onEvent?: (event: AgentEvent) => void;
  onDone?: (result: RunResult) => void;
  onError?: (message: string) => void;
}

export async function streamChat(
  body: { sessionId?: string; botId?: string; message: string; model?: string },
  handlers: ChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    handlers.onError?.(await errorMessage(response));
    return;
  }
  if (!response.body) {
    handlers.onError?.('当前环境不支持流式响应');
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      dispatchChunk(chunk, handlers);
      boundary = buffer.indexOf('\n\n');
    }
  }
}

function dispatchChunk(raw: string, handlers: ChatHandlers): void {
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

  switch (event) {
    case 'session':
      handlers.onSession?.((data as { sessionId: string }).sessionId);
      break;
    case 'event':
      handlers.onEvent?.(data as AgentEvent);
      break;
    case 'done':
      handlers.onDone?.(data as RunResult);
      break;
    case 'error':
      handlers.onError?.((data as { message?: string }).message ?? '未知错误');
      break;
  }
}
