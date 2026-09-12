import { defineTool } from '../tool.js';
import { retrieveMemories } from '../../memory/retrieve.js';
import type { MemoryStore } from '../../memory/store.js';
import type { MemoryScope } from '../../memory/types.js';

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

/**
 * RecallMemory —— 对齐《内置工具清单.md》1.4。
 *
 * 只读搜长期记忆；写入和忘记走 update_state(target=memory)。
 * Grok 的 scope：agent | user | all（默认 all）。
 */
export function createMemoryTools(memory: MemoryStore) {
  return [
    defineTool<{ query: string; scope?: 'agent' | 'user' | 'all'; limit?: number }>({
      name: 'RecallMemory',
      description: [
        '搜长期记忆：不在当前提示词里的旧日志、淡掉的笔记、以及所有助手写下的共用用户事实。',
        '只读——要改记忆用 update_state(target=memory)。',
        'query 对得上的优先，否则子串匹配；先于“让用户重复一遍”使用。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词' },
          scope: { type: 'string', description: 'agent | user | all，默认 all' },
          limit: { type: 'number', description: '最多返回几条，1~50，默认 20' },
        },
        required: ['query'],
      },
      async execute({ query, scope, limit }, context) {
        const keyword = query?.trim();
        if (!keyword) throw new Error('query 不能为空');
        const capped = Math.min(Math.max(limit ?? 20, 1), 50);

        const refs = await memory.visibleTo(context.agentId, { projectIds: context.projectIds });
        const filtered =
          scope && scope !== 'all' ? refs.filter((ref) => ref.scope === (scope === 'agent' ? 'self' : scope)) : refs;
        const hits = retrieveMemories(filtered, keyword, capped);
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
    }),
  ];
}
