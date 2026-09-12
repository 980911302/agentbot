import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MemoryScope, MemoryTier } from '../../memory/types.js';
import { json, readJson } from '../transport/index.js';
import { messageOf, readString, type RouteContext } from './context.js';
import { handleSend } from './messages.js';

function parseScope(value: unknown): MemoryScope {
  if (value === 'user' || value === 'project') return value;
  return 'self';
}

function parseTier(value: unknown): MemoryTier {
  if (value === 'portrait' || value === 'scratch') return value;
  return 'log';
}

/** /api/agents/:id（:id 后可带 /memory、/messages、/inbox、/context 等子路径） */
export async function handleAgentRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  agentId: string,
  rest: string,
): Promise<void> {
  const method = request.method ?? 'GET';
  const { runtime } = context;
  const record = await runtime.registry.get(agentId);
  if (!record) {
    json(response, 404, { error: 'unknown agent' });
    return;
  }

  if (rest === '/' && method === 'GET') {
    const memory = await runtime.snapshotMemory(agentId);
    json(response, 200, {
      agent: record,
      memory,
      messageCount: await runtime.messages.count(agentId),
      busy: runtime.isBusy(agentId),
    });
    return;
  }

  if (rest === '/' && method === 'PATCH') {
    const body = await readJson(request);
    const updated = await runtime.registry.update(agentId, {
      name: readString(body.name),
      instructions: readString(body.instructions),
      toolNames: Array.isArray(body.toolNames)
        ? body.toolNames.filter((item): item is string => typeof item === 'string')
        : undefined,
      projectIds: Array.isArray(body.projectIds)
        ? body.projectIds.filter((item): item is string => typeof item === 'string')
        : undefined,
    });
    json(response, 200, { agent: updated });
    return;
  }

  if (rest === '/' && method === 'DELETE') {
    await runtime.messages.clear(agentId);
    await runtime.memory.clear('self', agentId);
    await runtime.compaction.clear(agentId);
    json(response, 200, { ok: await runtime.registry.remove(agentId) });
    return;
  }

  if (rest === '/messages' && method === 'GET') {
    const limit = Number.parseInt(new URL(request.url ?? '/', 'http://x').searchParams.get('limit') ?? '', 10);
    json(response, 200, {
      messages: await runtime.messages.list(agentId, Number.isFinite(limit) ? limit : undefined),
    });
    return;
  }

  // 同事私发进来的积压消息（1:1 队列）
  if (rest === '/inbox' && method === 'GET') {
    json(response, 200, { items: await runtime.inbox.peek(agentId) });
    return;
  }

  if (rest === '/inbox' && method === 'POST') {
    await runtime.drainInbox(agentId);
    json(response, 200, { ok: true });
    return;
  }

  if (rest === '/messages' && method === 'POST') {
    await handleSend(request, response, context, agentId);
    return;
  }

  // 记忆快照：三层 × 三作用域，直接喂给 UI
  if (rest === '/memory' && method === 'GET') {
    const snapshot = await runtime.snapshotMemory(agentId);
    if (!snapshot) {
      json(response, 404, { error: 'unknown agent' });
      return;
    }
    json(response, 200, snapshot);
    return;
  }

  if (rest === '/memory' && method === 'POST') {
    const body = await readJson(request);
    const text = readString(body.text)?.trim();
    if (!text) {
      json(response, 400, { error: 'text is required' });
      return;
    }
    try {
      const ref = await runtime.remember(agentId, {
        text,
        scope: parseScope(body.scope),
        tier: parseTier(body.tier),
        projectId: readString(body.projectId),
        tags: Array.isArray(body.tags)
          ? body.tags.filter((item): item is string => typeof item === 'string')
          : [],
      });
      json(response, 201, { ref });
    } catch (error) {
      json(response, 400, { error: messageOf(error) });
    }
    return;
  }

  const memoryMatch = /^\/memory\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(rest);
  if (memoryMatch) {
    const scope = parseScope(decodeURIComponent(memoryMatch[1] ?? ''));
    const ownerId = decodeURIComponent(memoryMatch[2] ?? '');
    const entryId = decodeURIComponent(memoryMatch[3] ?? '');
    if (method === 'DELETE') {
      json(response, 200, { ok: await runtime.memory.remove(scope, ownerId, entryId) });
      return;
    }
    if (method === 'PATCH') {
      const body = await readJson(request);
      const updated = await runtime.memory.update(scope, ownerId, entryId, {
        tier: parseTier(body.tier),
        text: readString(body.text),
        tags: Array.isArray(body.tags)
          ? body.tags.filter((item): item is string => typeof item === 'string')
          : undefined,
      });
      json(response, updated ? 200 : 404, updated ? { entry: updated } : { error: 'not found' });
      return;
    }
  }

  if (rest === '/context' && method === 'GET') {
    const built = await runtime.previewContext(agentId);
    if (!built) {
      json(response, 404, { error: 'unknown agent' });
      return;
    }
    json(response, 200, {
      stats: built.stats,
      system: built.system,
      droppedRecent: built.droppedRecent,
      droppedGroups: built.droppedGroups,
      surfaced: built.surfaced.map((ref) => ({
        id: ref.entry.id,
        scope: ref.scope,
        tier: ref.entry.tier,
        text: ref.entry.text,
      })),
    });
    return;
  }

  json(response, 404, { error: `no route for ${method} /api/agents/:id${rest}` });
}

