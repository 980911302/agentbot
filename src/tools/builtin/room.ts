import { defineTool } from '../tool.js';
import type { DeliveryAttempt } from '../tool.js';
import { validateInputImages, type InputImage } from '../../shared/contracts/input-image.js';
import { ControlError } from '../../storage/runtime-control-store.js';

/**
 * SendToAgent —— 参见 docs/工具参考.md「协作与后台任务」。
 *
 * 私发另一个智能体，或发到自己所在的群。发出去立刻返回，不等回复；
 * 回复是之后的一个新回合（见 docs/架构设计.md「插话、停止和等待」：投递即结束）。
 *
 * 1:1 支持图片 URL；priority 只插队，不打断正在执行的回合。
 * 投递不是派工，不进入发送方停止树。
 * target_id 支持同事 id / 名字、群 id / 群名（群里被 @ 时简报里带 id）。
 */

export function createSendToAgentTool(options: {
  maxDepth: number;
  resolveTarget: (targetId: string, callerId: string) => Promise<
    | { kind: 'agent'; id: string; name: string }
    | { kind: 'room'; id: string; name: string }
    | undefined
  >;
  dispatch: (input: {
    targetId: string;
    kind: 'agent' | 'room';
    text: string;
    images?: InputImage[];
    priority: boolean;
    callerId: string;
    /** 仅可观测关联，不是停止树所有权。 */
    correlationId?: string;
    depth?: number;
    signal?: AbortSignal;
  }) => Promise<string | import('../result.js').ToolResult>;
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
        message: { type: 'string', description: '要发送的正文：可以是问候、问题、信息或明确请求。用户指定原话时按原意和措辞发送，不要擅自补成任务' },
        images: {
          type: 'array',
          maxItems: 4,
          description: '仅 1:1 支持，最多 4 张 HTTP(S) 图片 URL，收件模型须支持视觉；不支持本地路径/base64',
          items: { type: 'object', required: ['url'], properties: {
            url: { type: 'string', maxLength: 2048 },
            alt: { type: 'string', maxLength: 300 },
          } },
        },
        priority: { type: 'boolean', description: '紧急/叫停时插队' },
      },
      required: ['target_id', 'message'],
    },
    async execute({ target_id, message, images, priority }, context) {
      const attachments = validateInputImages(images);
      if ((context.agentChainDepth ?? 0) >= options.maxDepth) {
        throw new ControlError('传话链已达上限，请停止继续转发；只有主人需要知道的实质结论才单独告知', 'CHAIN_DEPTH_EXCEEDED');
      }
      const text = typeof message === 'string' ? message.trim() : '';
      if (!text) throw new ControlError('message 不能为空', 'INVALID_ARGUMENTS');
      const wanted = target_id?.trim();
      if (!wanted) throw new ControlError('target_id 不能为空', 'INVALID_ARGUMENTS');
      const attempt: DeliveryAttempt = { target: wanted, status: 'pending' };
      context.turnState?.deliveryAttempts?.push(attempt);
      if (context.turnState && !context.turnState.deliveryAttempts) context.turnState.deliveryAttempts = [attempt];

      try {
        const target = await options.resolveTarget(wanted, context.agentId);
        if (!target) {
          throw new ControlError(`找不到收件方「${wanted}」：既不是同事（id 或名字），也不是你所在的群`, 'TARGET_NOT_FOUND');
        }
        attempt.kind = target.kind;
        attempt.targetId = target.id;
        attempt.targetName = target.name;
        if (target.kind === 'agent' && target.id === context.agentId) {
          throw new ControlError('不要发给自己', 'UNAUTHORIZED_ACTION');
        }
        if (target.kind === 'room' && target.id === context.room?.roomId) {
          throw new ControlError('当前群请用 SendToUser 发言，不要重新群发唤醒整组', 'UNAUTHORIZED_ACTION');
        }
        if (target.kind === 'room' && attachments.length) {
          throw new ControlError('群里只有纯文本；图片请 1:1 发给同事', 'INVALID_IMAGE');
        }
        context.signal?.throwIfAborted();
        const result = await options.dispatch({
          targetId: target.id,
          kind: target.kind,
          text,
          ...(attachments.length ? { images: attachments } : {}),
          priority: target.kind === 'agent' && priority === true,
          callerId: context.agentId,
          correlationId: context.authorization?.chainId ?? context.turnState?.treeId,
          depth: (context.agentChainDepth ?? 0) + 1,
          signal: context.signal,
        });
        attempt.status = 'ok';
        if (typeof result === 'object' && result && 'content' in result) {
          const receiptId = result.output?.handle;
          if (receiptId) context.turnState?.acceptedDeliveryRefs?.push(receiptId);
          return result;
        }
        return result;
      } catch (error) {
        attempt.status = 'error';
        throw error;
      }
    },
  });
}
