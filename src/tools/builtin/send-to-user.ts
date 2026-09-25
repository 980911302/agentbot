import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { defineTool, type ToolContext } from '../tool.js';
import type { InteractionBroker } from '../../interaction/broker.js';
import type { SecretStore } from '../../secret/store.js';
import { ArtifactService } from '../services/artifact-service.js';
import { ControlError } from '../../storage/runtime-control-store.js';
import { ReplyFinalizer, type FinalizeResult } from '../../server/runtime/reply-finalizer.js';

/**
 * SendToUser —— 参见 docs/工具参考.md。
 *
 * 文本 / 附件 / 选项卡（widget）/ 密钥框（secret-request）统一出口。
 * 私聊和群聊共用同一个出口；群回合必须明确选择公开发群或私发给主人。
 */

export function createSendToUserTool(input: {
  rootDir: string;
  broker: InteractionBroker;
  secrets: SecretStore;
  agentName: (agentId: string) => Promise<string>;
  /** 产物交付（E2.3 services 层） */
  artifacts: ArtifactService;
  finalizeReply?: (input: {
    actorId: string;
    inputId?: string;
    content: string;
    deliveryRefs?: string[];
    allowedReceiptIds?: string[];
    source?: 'user' | 'inbox' | 'room';
  }) => Promise<FinalizeResult>;
  flowService?: import('../../server/runtime/room-flow-service.js').RoomFlowService;
}) {
  const root = resolve(input.rootDir);

  const deliverAttachment = async (rawPath: string): Promise<string> => {
    const stripped = rawPath.replace(/^file:\/\//, '');
    const result = await input.artifacts.deliverFromWorkspace(root, stripped);
    return result.path;
  };

  return defineTool<{
    type: 'text' | 'attachment' | 'widget' | 'secret-request';
    content?: string;
    url?: string;
    to?: 'room' | 'dm';
    end_turn?: boolean;
    delivery_refs?: string[];
    widget?: {
      prompt: string;
      options: Array<{ label: string; value?: string; style?: string }>;
      helpText?: string;
      multiSelect?: boolean;
      allowCustom?: boolean;
    };
    secret?: { label: string; name: string; description?: string };
  }>({
    name: 'SendToUser',
    ephemeral: true,
    description: [
      '对用户说话：进度、结果、附件、选项卡、密钥框都走它。',
      '群回合必须显式指定目标：to:"room" 公开发到当前群；to:"dm" 私发给主人。',
      'type=widget：弹可点的选项卡，拿到用户的选择再继续；选项卡必须是本回合最后一条。',
      'type=secret-request：弹遮罩框收密钥，值不进对话不进记忆，你只拿到名字。',
      'type=attachment：交付工作区文件或已在允许交付目录中的文件（≤50MiB），并告知位置；重名不覆盖。',
      'end_turn=true 表示这是最终一条，说完就结束回合。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['text', 'attachment', 'widget', 'secret-request'] },
        content: {
          type: 'string',
          maxLength: 20000,
          description: 'type=text 时的正文，用真实换行；最多 20000 字符',
        },
        url: {
          type: 'string',
          description: 'type=attachment：工作区或允许交付目录中的文件路径（file:// 前缀可省）',
        },
        to: {
          type: 'string',
          enum: ['room', 'dm'],
          description: '群回合必填："room" 公开发到当前群，"dm" 私发给主人；私聊回合可省略',
        },
        end_turn: {
          type: 'boolean',
          description: '最终一条设 true；提问类（widget / secret-request）会忽略它——回答要回到模型继续处理',
        },
        delivery_refs: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string' },
          description: '可选：最多 8 个已受理投递回执 id，用于核对发送声明',
        },
        widget: {
          type: 'object',
          description: 'type=widget 时必填',
          properties: {
            prompt: { type: 'string', description: '要问的一句话' },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 6,
              description: '2~6 个选项，label 必填',
              // 原先声明过 style（default|primary|danger）但从未实现、也没贯通到交互卡，
              // 属「接受了却静默丢弃」——按 E5.8 的原则从 schema 移除（要配色就先做贯通）。
              items: {
                type: 'object',
                required: ['label'],
                properties: {
                  label: { type: 'string' },
                  value: { type: 'string' },
                },
              },
            },
            helpText: { type: 'string', description: '补充说明' },
            multiSelect: { type: 'boolean', description: '暂不支持多选，传 true 会报错' },
            allowCustom: { type: 'boolean', description: '默认允许自由输入；当前不支持 false，会明确报错' },
          },
        },
        secret: {
          type: 'object',
          description: 'type=secret-request 时必填',
          properties: {
            label: { type: 'string', description: '卡片标题' },
            name: { type: 'string', description: '写入的环境变量名，例如 github_token' },
            description: { type: 'string', description: '在哪里申请、怎么填' },
          },
        },
      },
      required: ['type'],
    },
    async execute(args, context: ToolContext) {
      const type = args.type;
      const inGroup = Boolean(context.room);
      const replyRoute = context.replyRoute ?? context.authorization?.replyRoute;
      const flowService = context.flowService ?? input.flowService;

      if (inGroup && !args.to) {
        throw new ControlError(
          '群回合必须显式指定 to:"room" 或 to:"dm"；私发给主人使用 to:"dm"',
          'DESTINATION_REQUIRED',
        );
      }
      if (!inGroup && args.to === 'room' && !replyRoute) {
        throw new ControlError('当前不在群回合且无受信群流程路由，不能发到群', 'INVALID_DESTINATION');
      }
      const destination = inGroup || replyRoute ? (args.to ?? 'dm') : 'dm';
      /**
       * 收尾。endTurn 默认跟 args.end_turn，但**提问类输入（widget / secret-request）必须传 false**：
       * 这两类的返回值就是用户的回答，agent-loop 见到 endTurnRequested 会立刻返回、不再问模型
       * （agent-loop.ts 的 tool 结果入队后即返回），等于把刚拿到的回答丢掉（bug_zdrxbvtxbh4o）。
       */
      const finish = (visibleText?: string, opts: { endTurn?: boolean } = {}) => {
        if (!context.turnState) return;
        if (visibleText) context.turnState.lastVisibleText = visibleText;
        if (opts.endTurn ?? args.end_turn) context.turnState.endTurnRequested = true;
      };

      if (type === 'text') {
        const text = args.content?.trim();
        if (!text) throw new Error('content 不能为空');
        let outgoing = text;
        const finalize =
          input.finalizeReply ??
          ((payload) =>
            new ReplyFinalizer({
              lookup: async () => undefined,
              canView: () => false,
            }).finalize({
              actorId: payload.actorId,
              inputId: payload.inputId ?? payload.actorId,
              content: payload.content,
              deliveryRefs: payload.deliveryRefs,
              allowedReceiptIds: payload.allowedReceiptIds,
              source: payload.source,
            }));
        if (finalize) {
          const verdict = await finalize({
            actorId: context.agentId,
            inputId: context.authorization?.inputId,
            content: text,
            deliveryRefs: args.delivery_refs,
            allowedReceiptIds: context.turnState?.acceptedDeliveryRefs,
            source: context.room ? 'room' : 'user',
          });
          if (verdict.kind === 'invalid') {
            throw new ControlError(verdict.message, verdict.code);
          }
          if (verdict.kind === 'contradicted') {
            throw new ControlError('回执目标与发送声明不一致，未发布错误的成功确认', verdict.code);
          }
          if (verdict.kind === 'incomplete') {
            throw new ControlError(verdict.reason, 'INCOMPLETE_DELIVERY_CLAIM');
          }
          if (verdict.kind === 'ok' && verdict.statusLines.length > 0) {
            const lines = verdict.statusLines.map((line) => `已受理：${line.targetName}`).join('\n');
            outgoing = `${text}\n\n${lines}`;
          }
        }
        if (destination === 'room') {
          if (replyRoute && flowService) {
            if (!flowService.verifyReplyRoute(replyRoute)) {
              throw new ControlError('群流程回复路由签名无效或已被篡改', 'INVALID_REPLY_ROUTE');
            }
            const expectedVersion = context.flowContext?.version ?? 0;
            const proposalResult = await flowService.submitProposal({
              flowId: replyRoute.flowId,
              grantId: replyRoute.grantId,
              actor: { kind: 'agent', id: context.agentId },
              clientActionId: context.authorization?.ticketId ?? randomUUID(),
              content: { text: outgoing },
              publicText: outgoing,
              expectedVersion,
            });
            if (proposalResult.status === 'rejected') {
              throw new ControlError(proposalResult.reason ?? '候选行动被协议拒绝', 'PROPOSAL_REJECTED');
            }
            if (proposalResult.status === 'stale') {
              throw new ControlError(
                proposalResult.reason ?? '流程状态已演进，旧版本行动已作废',
                'PROPOSAL_STALE',
              );
            }
            finish(outgoing);
            return `已向受控流程提交候选行动（flow: ${replyRoute.flowId}，grant: ${replyRoute.grantId}）${args.end_turn ? '，回合结束' : ''}`;
          }

          const room = context.room;
          if (!room) {
            throw new ControlError('当前不在群回合且无受信群流程路由，不能发到群', 'INVALID_DESTINATION');
          }
          if (room.posts.length >= room.limit) {
            throw new Error(`这一轮已经说了 ${room.limit} 条，请结束回合`);
          }
          context.signal?.throwIfAborted();
          await room.publish?.(outgoing);
          room.posts.push(outgoing);
          finish(outgoing);
          return `已发到群（本轮第 ${room.posts.length} 条）${args.end_turn ? '，回合结束' : ''}`;
        }
        // 私聊 / 群里私发主人：落到自己的对话线
        if (!context.turnState?.persistOutgoing) throw new Error('用户消息出口未绑定，未发送');
        await context.turnState.persistOutgoing(outgoing);
        finish(outgoing);
        return args.end_turn ? '已发给主人，回合结束' : '已发给主人';
      }

      if (type === 'attachment') {
        if (destination === 'room') {
          throw new Error('群里只能发纯文本；附件请使用 to="dm" 私发给主人');
        }
        if (!args.url) throw new Error('attachment 需要 url（工作区内的文件路径）');
        if (!context.turnState?.persistOutgoing) throw new Error('用户消息出口未绑定，未交付');
        const target = await deliverAttachment(args.url);
        const delivered = `📎 已交付文件：${target}`;
        await context.turnState?.persistOutgoing?.(delivered);
        finish(delivered);
        return `已交付到 ${target}，用户可以直接打开。`;
      }

      if (type === 'widget') {
        if (destination === 'room') {
          throw new Error('群里不能发送选项卡；请使用 to="dm" 私发给主人');
        }
        const widget = args.widget;
        if (!widget?.prompt?.trim()) throw new Error('widget.prompt 不能为空');
        if (widget.multiSelect) throw new Error('暂不支持多选（multiSelect）');
        if (widget.allowCustom === false) throw new Error('暂不支持禁止自由输入（allowCustom=false）');
        const options = (widget.options ?? [])
          .map((option) => ({ id: option.value ?? option.label, label: option.label }))
          .filter((option) => option.label);
        if (options.length < 2) throw new Error('widget 至少要 2 个选项');
        if (new Set(options.map((option) => option.id)).size !== options.length)
          throw new Error('widget 选项的 value/label 不得重复');

        // E4.3：有持久等待通道就把「问什么」落成 WorkWait 并让位（释放执行位），
        // 用户回答后由运行时新开一个回合接着做；没有通道时退回同回合同步等待（工具单测/旧接线）。
        const park = context.turnState?.requestUserWait;
        if (park) {
          const card = await park({
            kind: 'choice',
            question: widget.prompt.trim(),
            detail: widget.helpText,
            options,
          });
          if (context.turnState) context.turnState.parkRequested = true;
          return `已把问题卡交给用户（交互 ${card.id}）。本回合到此结束，用户回答后会接着做；不要重复提问。`;
        }

        const agentName = await input.agentName(context.agentId);
        const promise = input.broker.request({
          kind: 'choice',
          question: widget.prompt.trim(),
          detail: widget.helpText,
          options,
          agentId: context.agentId,
          agentName,
          signal: context.signal,
        });
        const pending = input.broker.list({ agentId: context.agentId }).at(-1);
        if (pending) context.emit?.({ type: 'interaction', request: pending });
        try {
          const answer = await promise;
          context.emit?.({ type: 'interaction_closed', id: answer.id, answered: true });
          const chosen = options.find((option) => option.id === answer.value);
          finish(undefined, { endTurn: false });
          return chosen ? `用户选了：${chosen.label}` : `用户回答：${answer.value ?? '(空)'}`;
        } catch (error) {
          if (pending) context.emit?.({ type: 'interaction_closed', id: pending.id, answered: false });
          throw error;
        }
      }

      if (type === 'secret-request') {
        if (destination === 'room') {
          throw new Error('群里不能发送密钥框；请使用 to="dm" 私发给主人');
        }
        const secret = args.secret;
        const name = secret?.name?.trim();
        if (!secret || !name) throw new Error('secret.name 不能为空');

        // E4.3：密钥卡的答案只进 SecretStore；等待里只留变量名，绝不存明文。
        const park = context.turnState?.requestUserWait;
        if (park) {
          const card = await park({
            kind: 'secret',
            question: secret.label?.trim() || `请提供「${name}」`,
            detail: secret.description,
            name,
          });
          if (context.turnState) context.turnState.parkRequested = true;
          return `已把密钥框交给用户（交互 ${card.id}）。本回合到此结束，用户提交后会接着做；不要重复索要。`;
        }

        const agentName = await input.agentName(context.agentId);
        const promise = input.broker.request({
          kind: 'secret',
          question: secret.label?.trim() || `请提供「${name}」`,
          detail: secret.description,
          name,
          agentId: context.agentId,
          agentName,
          signal: context.signal,
        });
        const pending = input.broker.list({ agentId: context.agentId }).at(-1);
        if (pending) context.emit?.({ type: 'interaction', request: pending });
        try {
          const answer = await promise;
          if (!answer.secret) throw new Error('没有收到内容');
          await input.secrets.put(name, answer.secret);
          context.emit?.({ type: 'interaction_closed', id: answer.id, answered: true });
          finish(undefined, { endTurn: false });
          return `用户已提供「${name}」并保存（我看不到明文）。之后引用这个名字即可，不要要求用户再发一遍。`;
        } catch (error) {
          if (pending) context.emit?.({ type: 'interaction_closed', id: pending.id, answered: false });
          throw error;
        }
      }

      throw new Error(`不支持的 type：${String(type)}（text / attachment / widget / secret-request）`);
    },
  });
}
