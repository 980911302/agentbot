import { defineTool } from '../tool.js';

/**
 * 群回合的出站工具。
 *
 * 文档第 5 节：开口 = 往房间发纯文本；闭嘴 = 什么都不发，也是一等公民的结果。
 * 所以这里只有两个动作，由智能体自己选。
 */

export function createSayTool() {
  return defineTool<{ text: string }>({
    name: 'say',
    ephemeral: true,
    description: [
      '向当前群发一条纯文本消息。',
      '只在你有别人还没说过的、且归你管的实质内容时调用。',
      '1~3 句，像人在群里打字；不要总结整楼；说完就停。',
      '同一轮最多调 3 次。没有要补充的就不要调用，直接结束回合。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的话，纯文本' },
      },
      required: ['text'],
    },
    execute({ text }, context) {
      const room = context.room;
      if (!room) throw new Error('say 只能在群回合里使用');
      if (room.posts.length >= room.limit) {
        throw new Error(`这一轮已经说了 ${room.limit} 条，请结束回合`);
      }
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed) throw new Error('内容不能为空');
      room.posts.push(trimmed);
      return `已发出（本轮第 ${room.posts.length} 条）`;
    },
  });
}

export function createSilentTool() {
  return defineTool<Record<string, never>>({
    name: 'stay_silent',
    ephemeral: true,
    description: [
      '这一轮不发言，直接结束回合。',
      '当你没有被点名、且没有别人还没说过的实质内容时调用它。',
      '沉默是正常结果，不是失败；不要为了“在场”而说话。',
    ].join(' '),
    parameters: { type: 'object', properties: {} },
    execute(_args, context) {
      if (!context.room) throw new Error('stay_silent 只能在群回合里使用');
      return context.room.posts.length > 0
        ? `这一轮已经发过 ${context.room.posts.length} 条，可以结束回合了`
        : '已保持沉默';
    },
  });
}

export function createAgentMessageTool(options: {
  onSend: (input: { toAgentId: string; text: string; priority: boolean }) => Promise<string>;
  depth: number;
  maxDepth: number;
}) {
  return defineTool<{ toAgentId: string; text: string; priority?: boolean }>({
    name: 'send_to_agent',
    description: [
      '按 id 私发给另一个智能体（1:1）。',
      '发出去这一步就结束，不要等对方回复——它的回复会作为之后的一个新回合回来。',
      '只在需要另一个同事接手上才用；不要在用户还没回答你之前“顺便”扇出去。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        toAgentId: { type: 'string', description: '对方智能体的 id' },
        text: { type: 'string', description: '要传的话，只转可执行的那一句' },
        priority: { type: 'boolean', description: '紧急/叫停，插入对方队列前面' },
      },
      required: ['toAgentId', 'text'],
    },
    async execute({ toAgentId, text, priority }, context) {
      if (options.depth >= options.maxDepth) {
        throw new Error('传话链已达上限，请直接把结论说给用户');
      }
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed) throw new Error('内容不能为空');
      if (toAgentId === context.agentId) throw new Error('不要发给自己');
      // 派活记账（《停止与插话.md》§8）：停止令要能沿这笔记往下传
      context.turnState?.registerChild?.({ agentId: toAgentId, via: 'dm' });
      return options.onSend({ toAgentId, text: trimmed, priority: priority === true });
    },
  });
}
