import { defineTool } from '../tool.js';

/**
 * SendToAgent —— 参见 docs/工具参考.md「协作与后台任务」。
 *
 * 私发另一个智能体，或发到自己所在的群。发出去立刻返回，不等回复；
 * 回复是之后的一个新回合（见 docs/架构设计.md「插话、停止和等待」：投递即结束）。
 *
 * 与 Grok 的差异记录：images 参数接受但忽略（消息面还没有附件气泡）；
 * priority=true 只表达紧急/叫停，插队用；真正的停止传播由运行时按任务树下发。
 * target_id 支持同事 id / 名字、群 id / 群名（群里被 @ 时简报里带 id）。
 */

export function createSendToAgentTool(options: {
  maxDepth: number;
  resolveTarget: (targetId: string) => Promise<
    | { kind: 'agent'; id: string; name: string }
    | { kind: 'room'; id: string; name: string }
    | undefined
  >;
  dispatch: (input: {
    targetId: string;
    kind: 'agent' | 'room';
    text: string;
    priority: boolean;
    callerId: string;
  }) => Promise<string>;
}) {
  return defineTool<{
    target_id: string;
    message: string;
    images?: Array<{ url: string; alt?: string }>;
    priority?: boolean;
  }>({
    name: 'SendToAgent',
    description: [
      '私发另一个智能体，或发到自己所在的群。发出去立刻返回，不等回复——对方的回复是之后的新回合。',
      '1:1 可以 priority=true（紧急/叫停，插到对方队列前面；不会打断它正在跟用户的对话）。',
      '群发是纯文本、忽略 priority；扇出多人前要征得用户明确同意。',
      '拿不准要不要转发给同事时，先问用户。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        target_id: { type: 'string', description: '同事的 id 或名字；群则给群 id 或群名（必须是你所在的群）' },
        message: { type: 'string', description: '要传的话，只转可执行的那一句' },
        images: {
          type: 'array',
          description: '暂不支持附件，传了会被忽略',
          properties: {
            url: { type: 'string' },
            alt: { type: 'string' },
          },
        },
        priority: { type: 'boolean', description: '紧急/叫停时插队' },
      },
      required: ['target_id', 'message'],
    },
    async execute({ target_id, message, images, priority }, context) {
      if ((context.agentChainDepth ?? 0) >= options.maxDepth) {
        throw new Error('传话链已达上限，请直接把结论说给用户');
      }
      const text = typeof message === 'string' ? message.trim() : '';
      if (!text) throw new Error('message 不能为空');
      const wanted = target_id?.trim();
      if (!wanted) throw new Error('target_id 不能为空');

      const target = await options.resolveTarget(wanted);
      if (!target) {
        throw new Error(`找不到收件方「${wanted}」：既不是同事（id 或名字），也不是你所在的群`);
      }
      if (target.kind === 'agent' && target.id === context.agentId) {
        throw new Error('不要发给自己');
      }

      // 派活记账（见 docs/架构设计.md「插话、停止和等待」）：停止令沿这笔记往下传
      context.turnState?.registerChild?.({
        agentId: target.id,
        via: target.kind === 'agent' ? 'dm' : 'room',
        roomId: target.kind === 'room' ? target.id : undefined,
      });

      const reply = await options.dispatch({
        targetId: target.id,
        kind: target.kind,
        text,
        priority: priority === true,
        callerId: context.agentId,
      });
      const note = Array.isArray(images) && images.length > 0 ? '（附件暂不支持，已忽略）' : '';
      return `${reply}${note}`;
    },
  });
}
