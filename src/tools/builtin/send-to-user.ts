import { resolve } from 'node:path';
import { defineTool, type ToolContext } from '../tool.js';
import type { InteractionBroker } from '../../interaction/broker.js';
import type { SecretStore } from '../../secret/store.js';
import { ArtifactService } from '../services/artifact-service.js';
import { ControlError } from '../../storage/runtime-control-store.js';
import type { FinalizeResult } from '../../server/runtime/reply-finalizer.js';

/**
 * SendToUser —— 参见 docs/工具参考.md。
 *
 * 文本 / 附件 / 选项卡（widget）/ 密钥框（secret-request）统一出口。
 * 私聊和群聊共用同一个出口；群回合默认进群，to="dm" 时私发给主人。
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
    content: string;
    deliveryRefs?: string[];
    source?: 'user' | 'inbox' | 'room';
  }) => Promise<FinalizeResult>;
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
    to?: 'dm';
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
      '群回合里默认发到群（像人在群里打字，1~3 句）；to:"dm" 才走私聊给主人。',
      'type=widget：弹可点的选项卡，拿到用户的选择再继续；选项卡必须是本回合最后一条。',
      'type=secret-request：弹遮罩框收密钥，值不进对话不进记忆，你只拿到名字。',
      'type=attachment：交付工作区文件或已在允许交付目录中的文件（≤50MiB），并告知位置；重名不覆盖。',
      'end_turn=true 表示这是最终一条，说完就结束回合。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['text', 'attachment', 'widget', 'secret-request'] },
        content: { type: 'string', maxLength: 20000, description: 'type=text 时的正文，用真实换行；最多 20000 字符' },
        url: { type: 'string', description: 'type=attachment：工作区或允许交付目录中的文件路径（file:// 前缀可省）' },
        to: { type: 'string', enum: ['dm'], description: '群回合里传 "dm" 表示私发给主人而不是发进群' },
        end_turn: { type: 'boolean', description: '最终一条设 true' },
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
              minItems: 2, maxItems: 6,
              description: '2~6 个选项，label 必填',
              items: { type: 'object', required: ['label'], properties: {
                label: { type: 'string' },
                value: { type: 'string' },
                style: { type: 'string', description: 'default | primary | danger' },
              } },
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
      const finish = (visibleText?: string) => {
        if (!context.turnState) return;
        if (visibleText) context.turnState.lastVisibleText = visibleText;
        if (args.end_turn) context.turnState.endTurnRequested = true;
      };

      if (type === 'text') {
        const text = args.content?.trim();
        if (!text) throw new Error('content 不能为空');
        let outgoing = text;
        if (input.finalizeReply) {
          const verdict = await input.finalizeReply({
            actorId: context.agentId,
            content: text,
            deliveryRefs: args.delivery_refs,
            source: context.room ? 'room' : 'user',
          });
          if (verdict.kind === 'invalid') {
            throw new ControlError(verdict.message, verdict.code);
          }
          if (verdict.kind === 'contradicted') {
            throw new ControlError('回执目标与发送声明不一致，未发布错误的成功确认', verdict.code);
          }
          if (verdict.kind === 'ok' && verdict.statusLines.length > 0) {
            const lines = verdict.statusLines.map((line) => `已受理：${line.targetName}`).join('\n');
            outgoing = `${text}\n\n${lines}`;
          }
        }
        const inGroup = Boolean(context.room);
        if (inGroup && args.to !== 'dm') {
          const room = context.room!;
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
        if (context.room && args.to !== 'dm') {
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
        if (context.room && args.to !== 'dm') {
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
        if (new Set(options.map(option => option.id)).size !== options.length) throw new Error('widget 选项的 value/label 不得重复');

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
          finish();
          return chosen ? `用户选了：${chosen.label}` : `用户回答：${answer.value ?? '(空)'}`;
        } catch (error) {
          if (pending) context.emit?.({ type: 'interaction_closed', id: pending.id, answered: false });
          throw error;
        }
      }

      if (type === 'secret-request') {
        if (context.room && args.to !== 'dm') {
          throw new Error('群里不能发送密钥框；请使用 to="dm" 私发给主人');
        }
        const secret = args.secret;
        const name = secret?.name?.trim();
        if (!secret || !name) throw new Error('secret.name 不能为空');
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
          finish();
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
