import type { RoomFlowStatus } from '../../../../src/shared/contracts/room-flow.js';

/**
 * 群聊视图的纯展示选择器（UI 设计规范 §4、§5.6、§5.7、§5.14）：
 * 顶栏成员叠放、暂停成员标记、受控流程条文案与配色语义。
 */

export interface StackMember {
  id: string;
  name: string;
  /** 身份色（群消息里也用它认人） */
  color?: string;
  status?: string;
}

export interface MemberStack {
  /** 露出的成员（最多 maxVisible 个） */
  visible: StackMember[];
  /** 剩下多少人不露出，折成 +N；0 就不显示 */
  more: number;
}

/** 群顶栏成员头像叠放：最多 4 个 + 数量（规范 5.6） */
export function headerMemberStack(members: StackMember[], maxVisible = 4): MemberStack {
  return { visible: members.slice(0, maxVisible), more: Math.max(0, members.length - maxVisible) };
}

/**
 * 暂停成员的标记：暂停中的成员在群里显示「暂停」，不当成沉默
 * （规范 4 + 设计文档 §13.2「暂停成员在群里显示暂停/待处理」）。
 * 没有暂停就返回 null——沉默是合法结果，别乱贴标签。
 */
export function memberPauseTag(member: StackMember): string | null {
  return member.status === 'paused' ? '暂停' : null;
}

export interface FlowActor {
  kind: 'user' | 'agent';
  id: string;
  /** 智能体的显示名；用户固定显示「用户」 */
  name: string;
}

export interface FlowPhaseLabel {
  text: string;
  /** 是否该用 warn 色（--warn-weak）——暂停态用 */
  warn: boolean;
}

const STATUS_TEXT: Record<RoomFlowStatus, string> = {
  active: '进行中',
  awaiting_user: '等待用户',
  paused: '已暂停',
  completed: '已完成',
  failed: '已失败',
  cancelled: '已取消',
};

/**
 * 受控流程条的状态与行动者文案（规范 5.14）。
 * 暂停时 warn=true，让调用方用 --warn-weak 底色。
 */
export function roomFlowPhaseLabel(input: {
  status: RoomFlowStatus;
  phase: string;
  actors: FlowActor[];
}): FlowPhaseLabel {
  const statusText = STATUS_TEXT[input.status];
  if (input.status === 'paused') return { text: `已暂停 · ${input.phase}`, warn: true };
  if (input.status === 'awaiting_user') return { text: '等待用户行动', warn: false };
  const names = input.actors.map((actor) => (actor.kind === 'user' ? '用户' : actor.name));
  if (names.length === 0) return { text: statusText, warn: false };
  return { text: `${statusText} · 行动方：${names.join('、')}`, warn: false };
}
