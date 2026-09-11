import { defineTool } from '../tool.js';
import type { InteractionBroker } from '../../interaction/broker.js';
import type { InteractionOption } from '../../interaction/types.js';
import type { SecretStore } from '../../secret/store.js';

/**
 * 问用户 / 收密钥。
 *
 * 对应《智能体可操作能力.md》第 8 节：
 *   创建同事、拉群、扇出多人，都属于「智能体先问一句再动手」的场景，用选项卡片。
 *   密钥走遮罩框，值不进对话原文、不进记忆明文。
 */

export function createInteractionTools(input: {
  broker: InteractionBroker;
  secrets: SecretStore;
  agentName: (agentId: string) => Promise<string>;
}) {
  const askUser = defineTool<{
    question: string;
    options?: Array<string | { id?: string; label: string; description?: string }>;
    detail?: string;
    allowOther?: boolean;
  }>({
    name: 'ask_user',
    description: [
      '弹一张可点的卡片让用户选，而不是让他打字。',
      '建同事、拉群、扇出多人、拿不准要不要动手时，都先用它问一句。',
      'options 给 2~4 个互斥选项；用户还可以自己输入（allowOther 默认允许）。',
      '问完拿到用户的答案再继续；用户没答（超时）会告诉你，不要假装知道答案。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问的一句话' },
        options: {
          type: 'array',
          description: '选项列表，2~4 个',
        },
        detail: { type: 'string', description: '补充背景，帮用户判断' },
        allowOther: { type: 'boolean', description: '是否允许用户自己输入（默认允许）' },
      },
      required: ['question', 'options'],
    },
    async execute(args, context) {
      const question = args.question?.trim();
      if (!question) throw new Error('问题不能为空');

      const options = normalizeOptions(args.options);
      if (options.length < 2) throw new Error('至少给 2 个选项，否则不如直接问');

      const agentName = await input.agentName(context.agentId);
      const labelPrefix = '自定义：';

      const promise = input.broker.request({
        kind: 'choice',
        question,
        detail: args.detail,
        options,
        agentId: context.agentId,
        agentName,
        signal: context.signal,
      });

      // 先让卡片出现在界面上，再开始等
      const pending = input.broker.list({ agentId: context.agentId }).at(-1);
      if (pending) context.emit?.({ type: 'interaction', request: pending });

      try {
        const answer = await promise;
        context.emit?.({ type: 'interaction_closed', id: answer.id, answered: true });

        if (answer.value?.startsWith(labelPrefix)) {
          return `用户回答：${answer.value.slice(labelPrefix.length)}`;
        }
        const chosen = options.find((option) => option.id === answer.value);
        return chosen ? `用户选了：${chosen.label}` : `用户回答：${answer.value ?? '(空)'}`;
      } catch (error) {
        const id = pending?.id;
        if (id) context.emit?.({ type: 'interaction_closed', id, answered: false });
        throw error;
      }
    },
  });

  const requestSecret = defineTool<{ name: string; question?: string; detail?: string }>({
    name: 'request_secret',
    description: [
      '让用户在一个遮罩框里填密钥 / token。',
      '值不会进入对话，也不会写进记忆——你只会拿到一个名字，之后用这个名字引用。',
      '绝不要让用户把密钥直接打在聊天里。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '给这个密钥起的名字，例如 github_token' },
        question: { type: 'string', description: '要问用户的话' },
        detail: { type: 'string', description: '补充说明，例如在哪里申请' },
      },
      required: ['name'],
    },
    async execute(args, context) {
      const name = args.name?.trim();
      if (!name) throw new Error('密钥需要一个名字');

      const agentName = await input.agentName(context.agentId);
      const promise = input.broker.request({
        kind: 'secret',
        question: args.question?.trim() || `请提供「${name}」`,
        detail: args.detail,
        name,
        agentId: context.agentId,
        agentName,
        signal: context.signal,
      });

      const pending = input.broker.list({ agentId: context.agentId }).at(-1);
      if (pending) context.emit?.({ type: 'interaction', request: pending });

      try {
        const answer = await promise;
        const secret = answer.secret;
        if (!secret) throw new Error('没有收到内容');

        await input.secrets.put(name, secret);
        context.emit?.({ type: 'interaction_closed', id: answer.id, answered: true });
        return `用户已提供「${name}」并保存（我看不到明文）。之后引用这个名字即可，不要要求用户再发一遍。`;
      } catch (error) {
        const id = pending?.id;
        if (id) context.emit?.({ type: 'interaction_closed', id, answered: false });
        throw error;
      }
    },
  });

  const listSecrets = defineTool<Record<string, never>>({
    name: 'list_secrets',
    description: '列出已经保存的密钥名字（只有名字，没有值）。需要密钥前先看这里，避免重复问用户要。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const names = await input.secrets.names();
      return names.length > 0 ? `已保存的密钥：${names.join('、')}` : '还没有保存任何密钥';
    },
  });

  return [askUser, requestSecret, listSecrets];
}

function normalizeOptions(raw: unknown): InteractionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index) => {
      if (typeof item === 'string') {
        return { id: `opt${index + 1}`, label: item };
      }
      if (item && typeof item === 'object') {
        const record = item as { id?: unknown; label?: unknown; description?: unknown };
        const label = typeof record.label === 'string' ? record.label : undefined;
        if (!label) return null;
        return {
          id: typeof record.id === 'string' && record.id ? record.id : `opt${index + 1}`,
          label,
          description: typeof record.description === 'string' ? record.description : undefined,
        };
      }
      return null;
    })
    .filter((item): item is InteractionOption => item !== null)
    .slice(0, 4);
}
