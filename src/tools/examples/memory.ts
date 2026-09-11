import { defineTool } from '../tool.js';
import { USER_OWNER } from '../../memory/policy.js';
import { retrieveMemories } from '../../memory/retrieve.js';
import type { MemoryStore } from '../../memory/store.js';
import type { MemoryScope, MemoryTier } from '../../memory/types.js';

/**
 * 解析项目作用域的归属。
 *
 * 不做「静默落到 projectIds[0]」——智能体参与多个项目时写错本子，
 * 比写入失败更糟：错误会一直留在记忆里，且没人知道。
 *
 * 规则：
 *   显式指定且合法        → 用它
 *   只参与一个项目        → 用它
 *   没参与任何项目        → 报错，让模型改用 self
 *   参与多个但没指定      → 报错，要求模型用 projectId 说明是哪个
 */
export function resolveProjectOwner(
  requested: unknown,
  available: string[],
): { ownerId: string } | { error: string } {
  const wanted = typeof requested === 'string' ? requested.trim() : '';

  if (wanted) {
    if (available.includes(wanted)) return { ownerId: wanted };
    return {
      error:
        available.length > 0
          ? `这个智能体没有参与项目「${wanted}」；可用的项目：${available.join('、')}`
          : '这个智能体没有参与任何项目，无法写项目笔记；请改用 scope=self',
    };
  }

  if (available.length === 1) return { ownerId: available[0] as string };
  if (available.length === 0) {
    return { error: '这个智能体没有参与任何项目，无法写项目笔记；请改用 scope=self' };
  }
  return {
    error: `它参与了多个项目（${available.join('、')}），请用 projectId 指定要写进哪一个`,
  };
}

export function createMemoryTools(memory: MemoryStore) {
  const remember = defineTool<{
    text: string;
    scope?: MemoryScope;
    tier?: MemoryTier;
    tags?: string[];
    projectId?: string;
  }>({
    name: 'remember',
    description: [
      'Save one durable fact to long-term memory.',
      'scope: "user" for facts true across every assistant (name, timezone, standing preference);',
      '"project" for facts bound to one codebase; "self" for your own working notes. Default "self".',
      'When scope is "project" and you belong to more than one project, you MUST pass projectId.',
      'tier: "portrait" for stable facts worth always carrying; "log" for things that happened (default);',
      '"scratch" for a short-lived note.',
      'Duplicates are merged automatically.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact, one sentence' },
        scope: { type: 'string', description: 'self | user | project' },
        tier: { type: 'string', description: 'portrait | log | scratch' },
        tags: { type: 'array', description: 'Optional lowercase tags' },
        projectId: {
          type: 'string',
          description: 'Required when scope=project and you belong to several projects',
        },
      },
      required: ['text'],
    },
    async execute({ text, scope, tier, tags, projectId }, context) {
      if (typeof text !== 'string' || text.trim().length < 4) {
        throw new Error('text must be a sentence worth remembering');
      }

      const resolvedScope = parseScope(scope);
      let ownerId = context.agentId;
      let where = '我的笔记';

      if (resolvedScope === 'user') {
        ownerId = USER_OWNER;
        where = '共用记忆';
      } else if (resolvedScope === 'project') {
        const resolved = resolveProjectOwner(projectId, context.projectIds);
        if ('error' in resolved) throw new Error(resolved.error);
        ownerId = resolved.ownerId;
        where = `项目笔记（${ownerId}）`;
      }

      const result = await memory.write({
        scope: resolvedScope,
        tier: parseTier(tier),
        ownerId,
        text,
        tags: Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string') : [],
        source: 'agent',
      });

      const verb =
        result.action === 'created'
          ? '已记下'
          : result.action === 'merged'
            ? '已合并到已有记录'
            : '已更新';
      return `${verb}（${where}/${result.entry.tier}）`;
    },
  });

  const recall = defineTool<{ query: string; scope?: MemoryScope }>({
    name: 'recall',
    description:
      'Search long-term memory for entries not currently in view: older logs, fading notes, and shared user facts. Use it before asking the user to repeat something.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for' },
        scope: { type: 'string', description: 'Optional: self | user | project' },
      },
      required: ['query'],
    },
    async execute({ query, scope }, context) {
      const refs = await memory.visibleTo(context.agentId, { projectIds: context.projectIds });
      const filtered = scope ? refs.filter((ref) => ref.scope === scope) : refs;
      const hits = retrieveMemories(filtered, query, 8);
      if (hits.length === 0) return '没有找到相关记忆';

      await memory.touch(
        'self',
        context.agentId,
        hits.filter((ref) => ref.scope === 'self').map((ref) => ref.entry.id),
      );

      return hits
        .map((ref) => {
          const where = ref.scope === 'self' ? '我的笔记' : ref.scope === 'user' ? '共用' : '项目';
          return `- [${where}/${ref.entry.tier}] ${ref.entry.text}`;
        })
        .join('\n');
    },
  });

  return [remember, recall];
}

function parseScope(value: unknown): MemoryScope {
  if (value === 'user' || value === 'project') return value;
  return 'self';
}

function parseTier(value: unknown): MemoryTier {
  if (value === 'portrait' || value === 'scratch') return value;
  return 'log';
}
