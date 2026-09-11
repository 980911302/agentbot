import { defineTool } from '../tool.js';
import type { Workbench } from '../../workbench/service.js';

/** 每个回合最多新建几个同事，防止「偷偷建一堆没人要的」 */
export const MAX_AGENTS_PER_TURN = 2;

export function createWorkbenchTools(workbench: Workbench) {
  const listWorkspace = defineTool<Record<string, never>>({
    name: 'list_workspace',
    description: [
      '列出当前工作台的全貌：所有同事（id、名字、简介、颜色、分组）、所有群（id、群名、成员）。',
      '改动前先用它拿 id —— 群和同事都要按 id 操作，不要靠猜。',
      '也用它避免重名：建之前先看看是不是已经有了。',
    ].join(' '),
    parameters: { type: 'object', properties: {} },
    async execute() {
      const [agents, rooms, sections] = await Promise.all([
        workbench.listAgents(),
        workbench.listRooms(),
        workbench.listSections(),
      ]);

      const agentLines = agents
        .filter((agent) => !agent.hidden)
        .map((agent) => {
          const bits = [
            `id=${agent.id}`,
            agent.title ? `简介：${agent.title}` : null,
            agent.section ? `分组：${agent.section}` : null,
            `颜色 ${agent.color}`,
          ].filter(Boolean);
          return `- ${agent.name}（${bits.join('，')}）`;
        });

      const roomLines: string[] = [];
      for (const room of rooms) {
        const memberIds = room.memberIds;
        const names: string[] = [];
        for (const id of memberIds) {
          const found = agents.find((agent) => agent.id === id);
          if (found) names.push(found.name);
        }
        roomLines.push(`- ${room.name}（id=${room.id}，${memberIds.length} 人：${names.join('、') || '空'}）`);
      }

      return [
        `## 同事（${agentLines.length} 个）`,
        ...(agentLines.length > 0 ? agentLines : ['- （暂无）']),
        '',
        `## 群（${roomLines.length} 个）`,
        ...(roomLines.length > 0 ? roomLines : ['- （暂无）']),
        '',
        `## 分组`,
        sections.length > 0 ? sections.join('、') : '（未分组）',
      ].join('\n');
    },
  });

  const createAgent = defineTool<{
    name: string;
    title?: string;
    instructions?: string;
    color?: string;
    avatar?: string;
    section?: string;
  }>({
    name: 'create_agent',
    description: [
      '新建一个同事（智能体）。它会有自己的记忆和对话线，建完立刻出现在侧边栏。',
      'name 是显示名；title 是一行简介；instructions 是它的职责说明（写清负责什么）。',
      '只在用户明确要求「建一个…」时调用；用户没要求就不要建。一个回合最多建 2 个。',
      '如果只是想改现有同事，用 update_agent，不要重名再建。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '同事名字，例如「测试运维」' },
        title: { type: 'string', description: '一行简介，显示在侧边栏' },
        instructions: { type: 'string', description: '它的职责与工作方式' },
        color: { type: 'string', description: '头像底色，形如 #30d158' },
        avatar: { type: 'string', description: '头像上的短字符或 emoji' },
        section: { type: 'string', description: '放进哪个侧边栏分组' },
      },
      required: ['name'],
    },
    async execute(args, context) {
      const counters = context.turnState?.workbench;
      if (counters && counters.agentsCreated >= MAX_AGENTS_PER_TURN) {
        throw new Error(`这一轮已经建了 ${counters.agentsCreated} 个同事，先跟用户确认要不要继续`);
      }

      const record = await workbench.createAgent({
        name: args.name,
        title: args.title,
        description: args.title,
        instructions: args.instructions,
        color: args.color,
        avatar: args.avatar,
        section: args.section,
      });
      if (counters) counters.agentsCreated += 1;

      return `已建好同事「${record.name}」（id=${record.id}，颜色 ${record.color}）。它现在有自己的记忆和对话线。`;
    },
  });

  const updateAgent = defineTool<{
    agentId?: string;
    name?: string;
    title?: string;
    instructions?: string;
    color?: string;
    avatar?: string;
  }>({
    name: 'update_agent',
    description: [
      '修改某个同事的名字、简介、职责或头像。合并写入：只改你传的字段，其他保持不变。',
      '不传的字段不会被动；传空字符串等于没传（不会把资料抹空）。',
      '可以用 agentId 指定，也可以只给 name 让它按名字找。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '要改的同事 id' },
        name: { type: 'string', description: '新名字（也可以用它来定位同事）' },
        title: { type: 'string', description: '新的一行简介' },
        instructions: { type: 'string', description: '新的职责说明' },
        color: { type: 'string', description: '新的头像底色' },
        avatar: { type: 'string', description: '新的头像字符' },
      },
    },
    async execute(args) {
      const target = await resolveTarget(workbench, args.agentId, args.name);
      if (!target) throw new Error('没找到要修改的同事；给 agentId，或给一个已存在的名字');

      // 用名字定位时，不要把「名字」当成新名字重复写
      const patchName = args.agentId ? args.name : undefined;
      const updated = await workbench.updateAgent(target.id, {
        name: patchName,
        title: args.title,
        instructions: args.instructions,
        color: args.color,
        avatar: args.avatar,
      });

      const changed = [
        patchName ? `名字→${updated.name}` : null,
        args.title ? `简介→${updated.title}` : null,
        args.instructions ? '职责已更新' : null,
        args.color ? `颜色→${updated.color}` : null,
        args.avatar ? `头像→${updated.avatar}` : null,
      ].filter(Boolean);

      return changed.length > 0
        ? `已更新「${updated.name}」：${changed.join('，')}`
        : `「${updated.name}」没有需要改的字段`;
    },
  });

  const updateSelf = defineTool<{
    name?: string;
    title?: string;
    instructions?: string;
    color?: string;
    avatar?: string;
  }>({
    name: 'update_self',
    description:
      '修改你自己的名字、简介、职责或头像。合并写入，只改你传的字段；空字符串不会把资料抹空。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '你的新名字' },
        title: { type: 'string', description: '你的一行简介' },
        instructions: { type: 'string', description: '你的职责说明' },
        color: { type: 'string', description: '你的头像底色' },
        avatar: { type: 'string', description: '你的头像字符' },
      },
    },
    async execute(args, context) {
      const updated = await workbench.updateAgent(context.agentId, {
        name: args.name,
        title: args.title,
        instructions: args.instructions,
        color: args.color,
        avatar: args.avatar,
      });
      const changed = [
        args.name ? `名字→${updated.name}` : null,
        args.title ? `简介→${updated.title}` : null,
        args.instructions ? '职责已更新' : null,
        args.color ? `颜色→${updated.color}` : null,
        args.avatar ? `头像→${updated.avatar}` : null,
      ].filter(Boolean);
      return changed.length > 0 ? `已更新我自己：${changed.join('，')}` : '没有需要改的字段';
    },
  });

  const createRoom = defineTool<{ name: string; memberIds: string[] }>({
    name: 'create_room',
    description: [
      '新建一个群。群只是成员表 + 广播，本身不思考、不存记忆。',
      'memberIds 是成员的 agentId 列表（上限 6 个）。你要参加就把自己算进去。',
      '拿到 id 后如果发现少了谁，用 update_room 加人。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '群名，例如「支付联调」' },
        memberIds: { type: 'array', description: '成员 agentId 列表' },
      },
      required: ['name', 'memberIds'],
    },
    async execute(args, context) {
      const counters = context.turnState?.workbench;
      if (counters && counters.roomsCreated >= 1) {
        throw new Error('这一轮已经建过群了，先跟用户确认要不要再建');
      }

      const { room, callerIncluded } = await workbench.createRoom(context.agentId, {
        name: args.name,
        memberIds: Array.isArray(args.memberIds) ? args.memberIds : [],
      });
      if (counters) counters.roomsCreated += 1;

      const names = await workbench.memberNames(room.memberIds);
      const note = callerIncluded ? '' : '（注意：你自己不在这个群里，要参与请用 update_room 把自己加进去）';
      return `已建群「${room.name}」（id=${room.id}），成员：${names.join('、')}${note}`;
    },
  });

  const updateRoom = defineTool<{
    roomId?: string;
    name?: string;
    addMemberIds?: string[];
    removeMemberIds?: string[];
    memberIds?: string[];
  }>({
    name: 'update_room',
    description: [
      '改群名或成员表。只有你自己也在群里才能改。',
      '加人用 addMemberIds，减人用 removeMemberIds（也可以直接给完整的 memberIds 覆盖）。',
      '新成员从下一轮开始收消息，不回溯进群前的记录。不能把成员删空——解散群只有用户能做。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: '群 id' },
        name: { type: 'string', description: '新的群名' },
        addMemberIds: { type: 'array', description: '要拉进来的 agentId' },
        removeMemberIds: { type: 'array', description: '要移出的 agentId' },
        memberIds: { type: 'array', description: '完整的成员表（覆盖式）' },
      },
      required: ['roomId'],
    },
    async execute(args, context) {
      if (!args.roomId) throw new Error('需要 roomId');

      const current = await workbench.listRooms();
      const room = current.find((item) => item.id === args.roomId);
      if (!room) throw new Error(`找不到 id 为 ${args.roomId} 的群`);

      let memberIds = args.memberIds;
      if (!memberIds && (args.addMemberIds || args.removeMemberIds)) {
        const next = new Set(room.memberIds);
        for (const id of args.addMemberIds ?? []) next.add(id);
        for (const id of args.removeMemberIds ?? []) next.delete(id);
        memberIds = [...next];
      }

      const updated = await workbench.updateRoom(context.agentId, args.roomId, {
        name: args.name,
        memberIds,
      });
      const names = await workbench.memberNames(updated.memberIds);
      return `「${updated.name}」成员现在是：${names.join('、')}（共 ${updated.memberIds.length} 人）`;
    },
  });

  const postToRoom = defineTool<{ roomId?: string; roomName?: string; text: string }>({
    name: 'post_to_room',
    description: [
      '以你自己的身份往某个群里发一条，并把全体成员叫醒来处理——这会开新的一轮。',
      '和 say 不同：say 只在当前群回合里开口；post_to_room 会打扰群里每个人，请克制。',
      '不要在用户还没回答你的问题之前「顺便」扇出去；拿不准就先问用户。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: '群 id' },
        roomName: { type: 'string', description: '也可以用群名指定' },
        text: { type: 'string', description: '要发到群里的内容' },
      },
      required: ['text'],
    },
    async execute(args, context) {
      const rooms = await workbench.listRooms();
      const room = args.roomId
        ? rooms.find((item) => item.id === args.roomId)
        : rooms.find((item) => item.name === args.roomName?.trim());
      if (!room) throw new Error('找不到要发消息的群；给 roomId 或准确的 roomName');

      const result = await workbench.postToRoom(context.agentId, room.id, args.text);
      const skipped = result.skipped.length > 0 ? `（${result.skipped.join('、')} 正忙，跳过）` : '';
      return `已发到「${result.roomName}」，${result.called} 人进入回合：${result.spoke} 开口 / ${result.silent} 沉默${skipped}`;
    },
  });

  return [listWorkspace, createAgent, updateAgent, updateSelf, createRoom, updateRoom, postToRoom];
}

async function resolveTarget(
  workbench: Workbench,
  agentId: string | undefined,
  name: string | undefined,
): Promise<{ id: string; name: string } | undefined> {
  if (agentId) {
    const all = await workbench.listAgents();
    const found = all.find((agent) => agent.id === agentId);
    return found ? { id: found.id, name: found.name } : undefined;
  }
  const wanted = name?.trim();
  if (!wanted) return undefined;
  const all = await workbench.listAgents();
  const found = all.find((agent) => agent.name.toLowerCase() === wanted.toLowerCase());
  return found ? { id: found.id, name: found.name } : undefined;
}
