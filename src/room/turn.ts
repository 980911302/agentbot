import type { RoomMemberLike } from './member.js';

export interface RoomBriefInput {
  roomName: string;
  members: RoomMemberLike[];
  selfId: string;
  /** 这一轮说了什么的人 */
  speaker: string;
  /** 是否被点名（@名字 或 @everyone） */
  summoned: boolean;
  everyone: boolean;
  postLimit: number;
  /**
   * 本轮房间里已经公开的发言。
   * 并行扇出时，同波次的人互相看不见，但都应该看到更早波次说过的话；
   * 串行时这就是「前面的人刚说了什么」。
   */
  roundPosts?: Array<{ speaker: string; text: string }>;
  /** 这一轮被叫醒的第几次（>1 表示是被同事发言再次 @ 起来的） */
  recallCount?: number;
  /** 触发文本是停止词：群里不能紧急下发，被点名的人从简报里知道要停 */
  stopRequested?: boolean;
}

/**
 * 群回合的发言纪律。
 * 参见 docs/架构设计.md「群与同事协作」的发言规则。
 */
export const ROOM_SKILL = [
  '## 群回合',
  '- 只处理当前消息。历史与记忆仅用于回答当前话题，不得据此主动续接无关工作。',
  '- 只有 `SendToUser` 算开口；每条消息都要明确目标：`to:"room"` 公开发到当前群，`to:"dm"` 私发主人。普通助手文本是草稿，零次出口就是沉默。不要用 `SendToAgent` 向当前群发送。',
  '- `@` 决定谁必须开口。面向全群的社交交流由每位在场成员各回应一次；其他未被点名者仅在有职责内、未被说过的实质内容时开口。',
  '- 社交回应限一条短消息并立即结束；不得提出方案、分派工作、点名同事、汇报旧进展或发起后续议程。',
  '- 只有明确的工作请求才执行工作。发言每轮最多 3 条，每条通常 1～3 句，最终一条设置 `end_turn=true`。',
  '- 可以使用自己私聊和记忆中的结论，但不得粘贴私聊原文、泄露主人标为私密的内容，或提及其他同事的私聊。',
  '- 只代表自己，不冒充他人，不做群聊旁白或整楼总结。附件、卡片和选项只能私发。',
].join('\n');

export function buildRoomBrief(input: RoomBriefInput): string {
  const others = input.members
    .filter((member) => member.id !== input.selfId)
    .map((member) => `${member.name}（id: ${member.id}）`);
  const roster = others.length > 0 ? others.join('、') : '（暂时只有你）';

  const lines: string[] = [
    ROOM_SKILL,
    '',
    '### 本轮房间上下文',
    `房间：${input.roomName}`,
    `在场同事：${roster}`,
    `这一轮由「${input.speaker}」触发。`,
  ];

  if (input.everyone) {
    lines.push('**有人 @everyone，你被点名了，必须开口。**');
  } else if (input.summoned) {
    lines.push(
      input.recallCount && input.recallCount > 1
        ? '**有同事在发言里点名了你，你必须开口回应。**'
        : '**有人点名了你，你必须开口。**',
    );
  } else {
    lines.push('没有人点名你。');
  }

  if (input.stopRequested) {
    lines.push(`**群消息中有停止令（来自「${input.speaker}」）：先停下手上的活。**`);
    lines.push('被点名的人回一句确认停了即可，不要继续执行任何旧任务。');
  }

  // 本轮已经公开的发言：让后说话的人接得上，不至于重复别人说过的
  if (input.roundPosts && input.roundPosts.length > 0) {
    lines.push('');
    lines.push('### 这一轮已经有人说过');
    for (const post of input.roundPosts.slice(-8)) {
      const single = post.text.replace(/\s+/g, ' ').trim();
      lines.push(`- ${post.speaker}：${single.length > 140 ? `${single.slice(0, 140)}…` : single}`);
    }
    lines.push('面向全群的社交交流仍可各自简短回应；其他内容不要复述。');
  }

  lines.push('');
  lines.push('### 本轮动作');
  if (input.summoned) {
    lines.push('- 你被点名了，必须按当前消息的意图调用 `SendToUser` 回应，并明确选择公开发群或私发主人。');
  } else {
    lines.push('- 当前未点名：面向全群的社交交流须回应一条短消息；其他内容仅在实质、未被说过且属于你的职责时开口。');
  }

  return lines.join('\n');
}

/** 同事私发（1:1）进来的回合 */
export function buildAgentBrief(input: {
  fromName: string;
  fromId?: string;
  depth: number;
  maxDepth: number;
}): string {
  return [
    '## [agent] 同事来信',
    `智能体「${input.fromName}」私发给你一条消息。`,
    ...(input.fromId ? [`同事 id：${input.fromId}`] : []),
    '这是 1:1，用户通常也能在界面里看到这次传话。',
    '',
    '### 处理纪律',
    '- 这不是主人直接打开的回合：先理解来信本身，不要先发占位回应。',
    '- 对方是问候、闲聊或简短确认时，就自然简短回一句；已经互相确认过就停，不要从一句招呼引出任务、计划或汇报。',
    '- 对方是在提问或分享信息时，直接回答或只补充必要问题；只有明确请求你做事时才开始执行。',
    '- 回同事用 `SendToAgent`（按 id）；不要在同一回合里空等对方回复。',
    '- 只有主人明确在等、结果会影响主人，或得到了主人需要知道的新结论时，才用 `SendToUser` 单独告知主人；不要把每条同事聊天都转述给主人。',
    '- 转达时忠实保留原意和指定措辞；不要给问候、问题或信息擅自加上任务含义。',
    `- 当前传话链深度 ${input.depth}/${input.maxDepth}。到顶后不再转发；只有主人需要知道的实质结论才单独告诉主人。`,
  ].join('\n');
}

/**
 * 决定这一轮到底往房间发了什么。沉默是一等公民。
 *
 * 群里只有显式出口内容才算发言；普通收尾文本始终是草稿。
 */
export function decideRoomPosts(input: {
  /** 通过 SendToUser 明确发出的内容 */
  sent: string[];
}): string[] {
  return input.sent;
}
