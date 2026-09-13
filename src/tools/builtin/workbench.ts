import { defineTool } from '../tool.js';
import type { Workbench } from '../../workbench/service.js';
import { ControlError } from '../../storage/runtime-control-store.js';

/** 每个用户请求默认最多新建几个同事；不再用 2 卡住明确的三人创建。 */
export const MAX_AGENTS_PER_TURN = 6;

/**
 * 工作台工具 —— 参见 docs/工具参考.md「协作与后台任务」。
 *
 * CreateAgent / UpdateAgent / CreateChannel / UpdateChannel / ListSections。
 * 与 Grok 一致：没有删除工具（用户在侧边栏右键删）；UpdateAgent 只改传入字段、不能清空。
 * 同事/群的定位支持 id 或名字（名字回退解析在 SendToAgent / 工具内部完成）。
 */
export function createWorkbenchTools(workbench: Workbench) {
  const listSections = defineTool<{ offset?: number; limit?: number }>({
    name: 'ListSections',
    description: [
      '分页列出侧边栏分组名称（名称就是当前 section_id），默认 20、最多 50 条。',
      'CreateAgent 可以用返回的 id 把新同事放进某个分组。当前还没有分组功能时返回空表。',
    ].join(' '),
    parameters: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } } },
    async execute({ offset = 0, limit = 20 }) {
      const sections = await workbench.listSections();
      if (sections.length === 0) return '（还没有任何分组）';
      return sections.slice(offset, offset + limit).map(section => section.slice(0, 150)).join('\n') + (offset + limit < sections.length ? `\nnext_offset=${offset + limit}` : '');
    },
  });

  const createAgent = defineTool<{ name: string; description?: string; section_id?: string }>({
    name: 'CreateAgent',
    description: [
      '给用户新建一个同事（智能体）。它会有自己的记忆和对话线，建完立刻出现在侧边栏。',
      '返回 id，随即可用 SendToAgent 私发。',
      '没有删除工具——用户会在侧边栏右键删。只在用户明确要求「建一个…」时调用；同一用户请求最多建 6 个。',
      '如果只是想改现有同事，用 UpdateAgent，不要重名再建。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '同事名字，例如「测试运维」' },
        description: { type: 'string', description: '它的职责与人设（写清负责什么）' },
        section_id: { type: 'string', description: '放进哪个侧边栏分组（ListSections 查）' },
      },
      required: ['name'],
    },
    async execute(args, context) {
      if (context.authorization?.source === 'inbox') {
        throw new ControlError('普通同事来信不能签发工作台创建授权', 'UNAUTHORIZED_ACTION');
      }
      const counters = context.turnState?.workbench;
      if (counters && counters.agentsCreated >= MAX_AGENTS_PER_TURN) {
        throw new Error(`这一轮已经建了 ${counters.agentsCreated} 个同事，先跟用户确认要不要继续`);
      }

      const record = await workbench.createAgent({
        name: args.name,
        instructions: args.description,
        section: args.section_id,
      });
      if (counters) counters.agentsCreated += 1;

      return `已建好同事「${record.name}」（id=${record.id}）。它现在有自己的记忆和对话线，可用 SendToAgent 私发。`;
    },
  });

  const updateAgent = defineTool<{ agent_id: string; name?: string; description?: string }>({
    name: 'UpdateAgent',
    description: [
      '修改已有同事的名字和/或职责。只改传入的字段，不能清空、不能删除。',
      'agent_id 用 id 定位；也可以给一个已存在的名字让它按名字找。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: '要改的同事 id（或已存在的名字）' },
        name: { type: 'string', description: '新名字' },
        description: { type: 'string', description: '新的职责与人设' },
      },
      required: ['agent_id'],
    },
    async execute(args) {
      const record = await workbench.updateAgent(args.agent_id, {
        name: args.name,
        instructions: args.description,
      });
      const changed = [
        args.name ? `名字→${record.name}` : null,
        args.description ? '职责已更新' : null,
      ].filter(Boolean);
      return changed.length > 0
        ? `已更新「${record.name}」：${changed.join('，')}`
        : `「${record.name}」没有需要改的字段`;
    },
  });

  const createChannel = defineTool<{ name: string; member_ids: string[] }>({
    name: 'CreateChannel',
    description: [
      '建一个群（成员 ≤6），返回 id。群只是成员表 + 广播，本身不思考、不存记忆。',
      '自己要参加就把自己 id 放进 member_ids。拿到 id 后发现少了谁，用 UpdateChannel 加。',
      '不能删群——解散群只有用户能做。扇出多人前要先征得用户同意。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '群名' },
        member_ids: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', maxLength: 100 }, description: '成员 id 数组，1–6 个' },
      },
      required: ['name', 'member_ids'],
    },
    async execute(args, context) {
      const counters = context.turnState?.workbench;
      if (counters && counters.roomsCreated >= 1) {
        throw new Error('这一轮已经建过群了，先跟用户确认要不要再建');
      }
      const memberIds = Array.isArray(args.member_ids)
        ? args.member_ids
        : safeParseIds(args.member_ids);
      if (!Array.isArray(memberIds) || memberIds.length === 0) {
        throw new Error('member_ids 至少给 1 个成员 id');
      }

      const { room, callerIncluded } = await workbench.createRoom(context.agentId, {
        name: args.name,
        memberIds,
      });
      if (counters) counters.roomsCreated += 1;

      const names = await workbench.memberNames(room.memberIds);
      const note = callerIncluded ? '' : '（注意：你自己不在这个群里，要参与请用 UpdateChannel 把自己加进去）';
      return `已建群「${room.name}」（id=${room.id}），成员：${names.join('、')}${note}`;
    },
  });

  const updateChannel = defineTool<{
    channel_id: string;
    add_member_ids?: string[];
    remove_member_ids?: string[];
  }>({
    name: 'UpdateChannel',
    description: [
      '按 id 加减群成员。最多 6，至少留 1；只有自己也在群里才能改。',
      '新成员从下一轮开始收消息，不回溯进群前的记录。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: '群 id' },
        add_member_ids: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 100 } },
        remove_member_ids: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 100 } },
      },
      required: ['channel_id'],
    },
    async execute(args, context) {
      const current = await workbench.listRooms();
      const room = current.find((item) => item.id === args.channel_id);
      if (!room) throw new Error(`找不到 id 为 ${args.channel_id} 的群`);

      const next = new Set(room.memberIds);
      const add = Array.isArray(args.add_member_ids) ? args.add_member_ids : safeParseIds(args.add_member_ids);
      const remove = Array.isArray(args.remove_member_ids)
        ? args.remove_member_ids
        : safeParseIds(args.remove_member_ids);
      for (const id of add ?? []) next.add(id);
      for (const id of remove ?? []) next.delete(id);

      const updated = await workbench.updateRoom(context.agentId, args.channel_id, {
        memberIds: [...next],
      });
      const names = await workbench.memberNames(updated.memberIds);
      return `「${updated.name}」成员现在是：${names.join('、')}（共 ${updated.memberIds.length} 人）`;
    },
  });

  return [listSections, createAgent, updateAgent, createChannel, updateChannel];
}

/** 成员列表参数容错：模型可能把 JSON 数组写成字符串 */
function safeParseIds(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return raw
      .split(/[,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
}
