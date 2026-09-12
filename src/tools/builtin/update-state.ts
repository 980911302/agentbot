import { stat } from 'node:fs/promises';
import { defineTool } from '../tool.js';
import type { MemoryStore, WriteMemoryInput } from '../../memory/store.js';
import type { MemoryScope, MemoryTier } from '../../memory/types.js';

/**
 * update_state —— 参见 docs/工具参考.md 的子集。
 *
 * 已支持：memory（write/forget）、profile（set）、settings（hidden_from_sidebar）、
 *         avatar（set/clear）、project（join/leave，只管自己的 projectIds）。
 * 明确不支持并报错：routine / skill / channel（对应产品能力未上线）。
 *
 * Grok 的 tier 命名映射：profile→portrait、log→log、note→scratch。
 */

const SCOPE_MAP: Record<string, MemoryScope> = { agent: 'self', user: 'user', project: 'project' };
const TIER_MAP: Record<string, MemoryTier> = { profile: 'portrait', log: 'log', note: 'scratch' };

export function createUpdateStateTools(input: {
  memory: MemoryStore;
  updateAgent: (
    agentId: string,
    patch: {
      name?: string;
      title?: string;
      instructions?: string;
      color?: string;
      avatar?: string;
      hidden?: boolean;
      projectIds?: string[];
    },
  ) => Promise<unknown>;
}) {
  const memoryWrite = async (
    context: { agentId: string; projectIds: string[] },
    args: { fact?: string; tier?: string; scope?: string; project?: string },
  ): Promise<string> => {
    const fact = args.fact?.trim();
    if (!fact || fact.length < 4) throw new Error('fact 必须是一句值得记的话');
    const scope: MemoryScope = SCOPE_MAP[args.scope ?? 'agent'] ?? 'self';
    const tier: MemoryTier = TIER_MAP[args.tier ?? 'log'] ?? 'log';

    let ownerId = context.agentId;
    let where = '我的笔记';
    if (scope === 'user') {
      ownerId = 'user';
      where = '共用记忆';
    } else if (scope === 'project') {
      ownerId = args.project ?? context.projectIds[0] ?? context.agentId;
      if (!context.projectIds.includes(ownerId) && ownerId !== context.agentId) {
        ownerId = context.projectIds[0] ?? context.agentId;
      }
      where = `项目笔记（${ownerId}）`;
    }

    const write: WriteMemoryInput = {
      scope,
      tier,
      ownerId,
      text: fact,
      source: 'agent',
    };
    const result = await input.memory.write(write);
    const verb =
      result.action === 'created' ? '已记下' : result.action === 'merged' ? '已合并' : '已更新';
    return `${verb}（${where}/${result.entry.tier}）`;
  };

  const memoryForget = async (
    context: { agentId: string; projectIds: string[] },
    args: { fact?: string; scope?: string; project?: string },
  ): Promise<string> => {
    const fact = args.fact?.trim();
    if (!fact) throw new Error('forget 必须给完整原文（fact）');
    const scope: MemoryScope = SCOPE_MAP[args.scope ?? 'agent'] ?? 'self';
    let ownerId = context.agentId;
    if (scope === 'user') ownerId = 'user';
    else if (scope === 'project') {
      ownerId = args.project ?? context.projectIds[0] ?? context.agentId;
    }

    const snapshot = await input.memory.snapshot(context.agentId, {
      projectIds: context.projectIds,
    });
    const bucket = snapshot.buckets.find(
      (item) => item.scope === scope && item.ownerId === ownerId,
    );
    const matches = (bucket?.entries ?? []).filter((entry) => entry.text.trim() === fact);
    if (matches.length === 0) {
      throw new Error('没有找到原文完全一致的记录；forget 必须给原文（可先用 RecallMemory 核对）');
    }
    for (const entry of matches) {
      await input.memory.remove(scope, ownerId, entry.id);
    }
    return `已忘记 ${matches.length} 条`;
  };

  return [
    defineTool<{
      target: string;
      action: string;
      // memory
      fact?: string;
      tier?: string;
      scope?: string;
      project?: string;
      // profile
      name?: string;
      description?: string;
      title?: string;
      avatar_color?: string;
      // settings
      hidden_from_sidebar?: boolean;
      // avatar
      path?: string;
    }>({
      name: 'update_state',
      description: [
        '改你自己的持久状态：记忆、资料、设置、头像、项目归属。优先用它，不要直接改文件。',
        'target=memory：write（fact/tier=profile|log|note/scope=agent|user|project）或 forget（必须给原文）。',
        'target=profile：set（name / description=职责 / title=一句话简介 / avatar_color）。',
        'target=settings：set（hidden_from_sidebar）。',
        'target=avatar：set（path，已有图片的绝对路径）或 clear。',
        'target=project：join / leave（project=项目 slug）。',
        'routine / skill / channel 暂不支持，会明确报错。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'memory | profile | settings | avatar | project',
          },
          action: { type: 'string', description: 'write / forget / set / clear / join / leave' },
          fact: { type: 'string', description: 'memory：一句话事实；forget 时给原文' },
          tier: { type: 'string', description: 'memory：profile | log | note' },
          scope: { type: 'string', description: 'memory：agent | user | project' },
          project: { type: 'string', description: 'memory/project：项目 slug' },
          name: { type: 'string', description: 'profile：显示名' },
          description: { type: 'string', description: 'profile：职责描述' },
          title: { type: 'string', description: 'profile：一句话简介' },
          avatar_color: { type: 'string', description: 'profile：头像颜色 #rrggbb' },
          hidden_from_sidebar: { type: 'boolean', description: 'settings：是否从侧边栏隐藏' },
          path: { type: 'string', description: 'avatar：图片绝对路径（<5MB）' },
        },
        required: ['target', 'action'],
      },
      async execute(args, context) {
        const { target, action } = args;
        const self = { agentId: context.agentId, projectIds: context.projectIds };

        if (target === 'memory') {
          if (action === 'write') return memoryWrite(self, args);
          if (action === 'forget') return memoryForget(self, args);
          throw new Error(`memory 只支持 write / forget，收到：${action}`);
        }

        if (target === 'profile') {
          if (action !== 'set') throw new Error(`profile 只支持 set，收到：${action}`);
          const patch: {
            name?: string;
            title?: string;
            instructions?: string;
            color?: string;
          } = {};
          if (args.name) patch.name = args.name;
          if (args.title) patch.title = args.title;
          if (args.description) patch.instructions = args.description;
          if (args.avatar_color) patch.color = args.avatar_color;
          if (Object.keys(patch).length === 0) {
            throw new Error('profile set 至少给 name / description / title / avatar_color 之一');
          }
          await input.updateAgent(context.agentId, patch);
          return '资料已更新（改名即刻生效，下一轮对话就是新名字）。';
        }

        if (target === 'settings') {
          if (action !== 'set') throw new Error(`settings 只支持 set，收到：${action}`);
          if (typeof args.hidden_from_sidebar !== 'boolean') {
            throw new Error('settings set 目前只支持 hidden_from_sidebar（布尔）');
          }
          await input.updateAgent(context.agentId, { hidden: args.hidden_from_sidebar });
          return args.hidden_from_sidebar ? '已从侧边栏隐藏（仍能聊天、仍跑任务）' : '已重新显示在侧边栏';
        }

        if (target === 'avatar') {
          if (action === 'clear') {
            await input.updateAgent(context.agentId, { avatar: '' });
            return '已清除头像，回到生成的脸。';
          }
          if (action !== 'set') throw new Error(`avatar 只支持 set / clear，收到：${action}`);
          const path = args.path?.trim();
          if (!path) throw new Error('avatar set 需要 path');
          const info = await stat(path).catch(() => null);
          if (!info?.isFile()) throw new Error(`找不到图片：${path}`);
          if (info.size > 5 * 1024 * 1024) throw new Error('图片必须小于 5MB');
          await input.updateAgent(context.agentId, { avatar: path });
          return '头像已更新。';
        }

        if (target === 'project') {
          if (action !== 'join' && action !== 'leave') {
            throw new Error(`project 只支持 join / leave，收到：${action}（create 暂不支持）`);
          }
          const slug = args.project?.trim();
          if (!slug) throw new Error('project 必须给项目 slug');
          const current = context.projectIds;
          const next =
            action === 'join'
              ? [...new Set([...current, slug])]
              : current.filter((item) => item !== slug);
          await input.updateAgent(context.agentId, { projectIds: next });
          return action === 'join' ? `已加入项目 ${slug}` : `已离开项目 ${slug}`;
        }

        throw new Error(`update_state: target「${target}」暂不支持（memory / profile / settings / avatar / project）`);
      },
    }),
  ];
}
