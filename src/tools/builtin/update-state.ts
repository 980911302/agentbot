import { stat } from 'node:fs/promises';
import { resolveProjectOwner } from './memory.js';
import { defineTool } from '../tool.js';
import type { AgentProfilePatch } from '../../shared/contracts/agent-profile.js';
import type { MemoryStore, WriteMemoryInput } from '../../memory/store.js';
import type { MemoryScope, MemoryTier } from '../../memory/types.js';

/**
 * update_state —— 参见 docs/工具参考.md 的子集。
 *
 * 已支持：memory（write/forget）、profile（set）、settings（hidden_from_sidebar）、
 *         avatar（set/clear）、project（join/leave，只管自己的 projectIds）。
 * 明确不支持并报错：routine / skill / channel（对应产品能力未上线）。
 *
 * 资料与头像一律经 `updateProfile`（唯一资料服务，E5.1）：
 * name / title / description / instructions 四个字段分开写，clear 有明确的清空语义。
 *
 * Grok 的 tier 命名映射：profile→portrait、log→log、note→scratch。
 */

const SCOPE_MAP: Record<string, MemoryScope> = { agent: 'self', user: 'user', project: 'project' };
const TIER_MAP: Record<string, MemoryTier> = { profile: 'portrait', log: 'log', note: 'scratch' };

export function createUpdateStateTools(input: {
  memory: MemoryStore;
  updateProfile: (agentId: string, patch: AgentProfilePatch) => Promise<unknown>;
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
      const project = resolveProjectOwner(args.project, context.projectIds);
      if ('error' in project) throw new Error(project.error);
      ownerId = project.ownerId;
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
      const project = resolveProjectOwner(args.project, context.projectIds);
      if ('error' in project) throw new Error(project.error);
      ownerId = project.ownerId;
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
      instructions?: string;
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
        'target=profile：set（name=显示名 / title=一句话头衔 / description=职责描述 / instructions=进系统提示词的长职责 / avatar_color）。',
        'target=settings：set（hidden_from_sidebar）。',
        'target=avatar：set（path，已有图片的绝对路径，会复制进数据目录的头像目录）或 clear（删掉文件并清空字段）。',
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
          tier: { type: 'string', enum: ['profile', 'log', 'note'] },
          scope: { type: 'string', enum: ['agent', 'user', 'project'] },
          project: { type: 'string', description: 'memory/project：项目 slug' },
          name: { type: 'string', description: 'profile：显示名' },
          title: { type: 'string', description: 'profile：一句话头衔' },
          description: { type: 'string', description: 'profile：职责描述（会写进你的身份说明）' },
          instructions: { type: 'string', description: 'profile：进「你的职责」段的长职责文本' },
          avatar_color: { type: 'string', description: 'profile：头像颜色 #rrggbb' },
          hidden_from_sidebar: { type: 'boolean', description: 'settings：是否从侧边栏隐藏' },
          path: { type: 'string', description: 'avatar：图片绝对路径（<5MB），会复制到头像目录' },
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
          // 四个字段各写各的：description 是身份说明里的「职责描述」，
          // instructions 是「你的职责」段，不再互相顶替（E5.1）。
          const patch: AgentProfilePatch = {};
          if (args.name) patch.name = args.name;
          if (args.title) patch.title = args.title;
          if (args.description) patch.description = args.description;
          if (args.instructions) patch.instructions = args.instructions;
          if (args.avatar_color) {
            if (!/^#[0-9a-f]{6}$/i.test(args.avatar_color)) throw new Error('avatar_color 必须是 #rrggbb');
            patch.color = args.avatar_color;
          }
          if (Object.keys(patch).length === 0) {
            throw new Error('profile set 至少给 name / title / description / instructions / avatar_color 之一');
          }
          await input.updateProfile(context.agentId, patch);
          return '资料已更新（改名即刻生效，下一轮对话就是新名字）。';
        }

        if (target === 'settings') {
          if (action !== 'set') throw new Error(`settings 只支持 set，收到：${action}`);
          if (typeof args.hidden_from_sidebar !== 'boolean') {
            throw new Error('settings set 目前只支持 hidden_from_sidebar（布尔）');
          }
          await input.updateProfile(context.agentId, { hidden: args.hidden_from_sidebar });
          return args.hidden_from_sidebar ? '已从侧边栏隐藏（仍能聊天、仍跑任务）' : '已重新显示在侧边栏';
        }

        if (target === 'avatar') {
          // clear 的语义明确：删掉头像文件 + 字段置空；set 把图片复制进数据目录的头像目录。
          if (action === 'clear') {
            await input.updateProfile(context.agentId, { avatar: null });
            return '已清除头像（文件已删除），回到生成的脸。';
          }
          if (action !== 'set') throw new Error(`avatar 只支持 set / clear，收到：${action}`);
          const path = args.path?.trim();
          if (!path) throw new Error('avatar set 需要 path');
          const info = await stat(path).catch(() => null);
          if (!info?.isFile()) throw new Error(`找不到图片：${path}`);
          await input.updateProfile(context.agentId, { avatar: { path } });
          return '头像已更新（图片已复制进数据目录的头像目录）。';
        }

        if (target === 'project') {
          if (action !== 'join' && action !== 'leave') {
            throw new Error(`project 只支持 join / leave，收到：${action}（create 暂不支持）`);
          }
          const slug = args.project?.trim();
          if (!slug) throw new Error('project 必须给项目 slug');
          if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(slug)) throw new Error('project slug 只能包含字母、数字、下划线、短横线，最多 80 字符');
          const current = context.projectIds;
          const next =
            action === 'join'
              ? [...new Set([...current, slug])]
              : current.filter((item) => item !== slug);
          if (next.length > 20) throw new Error('最多参与 20 个项目');
          await input.updateProfile(context.agentId, { projectIds: next });
          context.projectIds.splice(0, context.projectIds.length, ...next);
          return action === 'join' ? `已加入项目 ${slug}` : `已离开项目 ${slug}`;
        }

        throw new Error(`update_state: target「${target}」暂不支持（memory / profile / settings / avatar / project）`);
      },
    }),
  ];
}
