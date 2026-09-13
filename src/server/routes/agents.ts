import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
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

  const correspondenceMatch = /^\/correspondence\/([\w-]{1,128})$/.exec(rest);
  if (correspondenceMatch && method === 'GET') {
    const params = new URL(request.url ?? '/', 'http://x').searchParams;
    const limit = Number(params.get('limit') ?? 30);
    const before = params.get('before') ?? undefined;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (before && !/^[\w-]{1,128}$/.test(before))) {
      json(response, 400, { error: '无效的往来分页参数' }); return;
    }
    try { json(response, 200, await runtime.correspondence.page(agentId, correspondenceMatch[1]!, before, limit)); }
    catch (error) { json(response, 400, { error: messageOf(error) }); }
    return;
  }

  if (rest === '/tasks' && method === 'GET') {
    const params = new URL(request.url ?? '/', 'http://x').searchParams;
    const offset = Number(params.get('offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) { json(response, 400, { error: 'offset 必须是非负整数' }); return; }
    const tasks = runtime.taskProgress.list(agentId);
    // 列表只给摘要；完整检查点按 id 单独查询，避免把全部工具记录塞进响应。
    json(response, 200, { tasks: tasks.slice(offset, offset + 20).map(task => ({ id: task.id, status: task.status, stopReason: task.stopReason, goal: task.goal.slice(0, 300), updatedAt: task.updatedAt })), nextOffset: offset + 20 < tasks.length ? offset + 20 : null });
    return;
  }
  const taskMatch = /^\/tasks\/([0-9a-f-]{36})$/.exec(rest);
  if (taskMatch && method === 'GET') {
    const progress = runtime.taskProgress.get(taskMatch[1]!, agentId);
    json(response, progress ? 200 : 404, progress ? { task: progress } : { error: 'task not found' });
    return;
  }

  // 同事私发进来的积压消息（1:1 队列）：未处理的 + 处理失败的
  if (rest === '/inbox' && method === 'GET') {
    json(response, 200, {
      items: await runtime.inbox.peek(agentId),
      failed: await runtime.failedMail(agentId),
    });
    return;
  }

  if (rest === '/inbox' && method === 'POST') {
    const control = runtime.controlView(agentId);
    if (control.autoActivation === 'paused') {
      json(response, 202, { ok: false, held: true, reason: 'agent_paused' });
      return;
    }
    await runtime.drainInbox(agentId);
    json(response, 202, { ok: true });
    return;
  }

  if (rest === '/stop' && method === 'POST') {
    const body = await readJson(request);
    const commandId = readString(body.commandId) ?? randomUUID();
    const stop = await runtime.requestAgentStop(agentId, commandId);
    json(response, 202, { stopId: stop.stopId, state: stop.state, committedSeq: stop.committedSeq });
    return;
  }

  if (rest === '/resume' && method === 'POST') {
    const body = await readJson(request);
    const commandId = readString(body.commandId) ?? randomUUID();
    const selection = body.selection && typeof body.selection === 'object' ? body.selection as { kind?: string; inputId?: string; taskId?: string; chainId?: string } : undefined;
    const kind = selection?.kind;
    if (kind !== 'input' && kind !== 'task' && kind !== 'chain' && kind !== 'enable_future') {
      json(response, 400, { error: 'selection 必须是 input/task/chain/enable_future' });
      return;
    }
    const chosen = selection ?? {};
    const resume = await runtime.resumeAgent({
      commandId,
      requestedBy: { kind: 'user', id: 'owner' },
      agentId,
      selection: kind === 'input'
        ? { kind, inputId: chosen.inputId ?? '' }
        : kind === 'task'
          ? { kind, taskId: chosen.taskId ?? '' }
          : kind === 'chain'
            ? { kind, chainId: chosen.chainId ?? '' }
            : { kind: 'enable_future' },
    });
    json(response, 202, resume);
    return;
  }

  if (rest === '/control' && method === 'GET') {
    json(response, 200, runtime.controlView(agentId));
    return;
  }

  // 人工重试失败的来信（重置尝试预算）
  if (rest === '/inbox/retry' && method === 'POST') {
    json(response, 200, { retried: await runtime.retryFailedMail(agentId) });
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
