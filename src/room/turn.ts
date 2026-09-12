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
  /** 这一轮是同事私发进来的，而不是群里广播 */
  viaAgent?: { name: string };
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
export function buildRoomBrief(input: RoomBriefInput): string {
  const others = input.members
    .filter((member) => member.id !== input.selfId)
    .map((member) => member.name);
  const roster = others.length > 0 ? others.join('、') : '（暂时只有你）';

  const lines: string[] = [
    '## 你现在在一个群里',
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
    lines.push('**主人发了停止令：先停下手上的活。**');
    lines.push('被点名的人回一句确认停了即可，不要继续执行任何旧任务。');
  }

  if (input.viaAgent) {
    lines.push(`这条是同事「${input.viaAgent.name}」私发给你的一对一消息，不是群里广播。`);
    lines.push('如果你需要让用户知道的新结果，要单独说给用户，不要只在心里记下。');
  }

  // 本轮已经公开的发言：让后说话的人接得上，不至于重复别人说过的
  if (input.roundPosts && input.roundPosts.length > 0) {
    lines.push('');
    lines.push('### 这一轮已经有人说过');
    for (const post of input.roundPosts.slice(-8)) {
      const single = post.text.replace(/\s+/g, ' ').trim();
      lines.push(`- ${post.speaker}：${single.length > 140 ? `${single.slice(0, 140)}…` : single}`);
    }
    lines.push('不要复述上面的内容；只在你有新信息时开口。');
  }

  lines.push('');
  lines.push('### 发言纪律');
  if (input.summoned) {
    // 被点名时不提供沉默选项，所以这里不写「可以闭嘴」
    lines.push('- 你被点名了，必须开口，直接说出你要说的话即可。');
    lines.push('- 就算只是确认现状、说清「我这边没有」，也要开口答复，不要闷着。');
    lines.push('- 可以用 SendToUser 分几条说，但无论哪种方式都要开口。');
  } else {
    lines.push('- 只有当你手上有**别人还没说过的、且归你管的实质内容**时才开口。');
    lines.push('- 开口必须用 SendToUser 工具（type=text）：你最后输出的文字**不会**进群。');
    lines.push('- 没有要补充的就闭嘴 = 不调用 say，直接结束回合。沉默是正常结果，不是失败。');
  }
  lines.push(`- 像人在群里打字，通常 1~3 句；同一轮最多 ${input.postLimit} 条。`);
  lines.push('- 不要复述别人的话，不要只回「同意 / 收到 / 好的」，不要把整楼再总结一遍。');
  lines.push('- 想请某个同事接话，在正文里写 @名字；整个房间都看得见。');
  lines.push('- 只代表你自己，不要冒充用户或同事，也不要做旁白解说。');
  lines.push('');
  lines.push('### 群里的能力与限制');
  lines.push('- 能力不降级：工具和私聊一样可用，先把活干完再把结果发到群。');
  lines.push('- 但群里只能发纯文本：卡片、附件、选项按钮进不了群，要改口问，或私发给主人。');
  lines.push('- 你可以用自己私聊里已经知道的事和自己的长期记忆；');
  lines.push('  但不要假装知道同事的私聊或同事的记忆。');
  lines.push('- 群里说的话不等于要写进记忆；要不要记，由你自己在回完之后判断。');

  return lines.join('\n');
}

/** 同事私发（1:1）进来的回合 */
export function buildAgentBrief(input: {
  fromName: string;
  depth: number;
  maxDepth: number;
}): string {
  return [
    '## 同事来信',
    `智能体「${input.fromName}」私发给你一条消息。`,
    '这是 1:1，用户通常也能在界面里看到这次传话。',
    '',
    '### 处理纪律',
    '- 有实质内容才回同事；纯「收到」不要来回碰。',
    '- 回同事用 send_to_agent（按 id）；不要在同一回合里空等对方回复。',
    '- 需要让用户知道的新结果，再单独说给用户，不要只在内部转一圈。',
    '- 传话时不要把用户的原话原样转出去，只转可执行的那一句。',
    `- 当前传话链深度 ${input.depth}/${input.maxDepth}，到顶就直接把结论说给用户。`,
  ].join('\n');
}

/**
 * 决定这一轮到底往房间发了什么。沉默是一等公民。
 *
 * 被点名的人「必须开口」：它直接把话写在收尾文本里也算发言
 * —— 模型没走 say 工具不该被惩罚成沉默。
 *
 * 没被点名的人默认闭嘴：只有显式调用 say 才算真的发了字，
 * 否则模型的收尾文本会变成刷屏（它总会写点什么）。
 */
export function decideRoomPosts(input: {
  /** 通过 say 工具明确发出的内容 */
  said: string[];
  summoned: boolean;
  /** 模型这一轮的收尾文本 */
  finalText: string;
}): string[] {
  if (input.said.length > 0) return input.said;
  if (!input.summoned) return [];
  const fallback = input.finalText.trim();
  return fallback ? [fallback] : [];
}
