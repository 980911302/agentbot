import type { DisplayMessage } from '../../types.js';
import type { Correspondence } from '../../../../src/shared/contracts/message-identity.js';

/**
 * 聊天时间线的纯展示选择器（UI 设计规范 5.6 / 5.7 / 4.3）：
 * 同一发言者 3 分钟内连续消息合并（只首条显头像、名字、时间）、
 * 跨天插日期分隔、「回到最新」的显隐阈值。
 *
 * 不碰 DOM 与 React，供 ChatView 渲染与 node:test 单测共用。
 */

/** 同一发言者合并窗口：3 分钟（含端点） */
export const MERGE_WINDOW_MS = 3 * 60_000;
/** 离底部超过这个距离才显示「回到最新」浮钮：200px */
export const JUMP_TO_BOTTOM_THRESHOLD_PX = 200;

export type TimelineEntry =
  | { kind: 'group'; key: string; messages: DisplayMessage[]; showSender: boolean; senderName: string }
  | { kind: 'divider'; key: string; label: string };

/** 展示用消息：有正文、或有往来/工具可看；空正文的 scaffolding 不占位 */
function isRenderable(message: DisplayMessage): boolean {
  if (message.correspondence) return true;
  if (message.toolCalls.length > 0) return true;
  return message.content.trim().length > 0;
}

/** 消息的发言人标识：群里按 sender，1:1 里按 role（我 / 它） */
function speakerKey(message: DisplayMessage, isGroup: boolean): string {
  if (isGroup) return message.sender?.id ?? message.senderName ?? message.role;
  return message.role === 'user' ? 'me' : 'it';
}

export function speakerName(message: DisplayMessage): string {
  if (message.role === 'user') return message.senderName || message.sender?.name || '我';
  return message.senderName || message.sender?.name || '助手';
}

/** 带工具调用的消息自己占一行，不并进相邻的气泡组 */
function isMergeable(message: DisplayMessage): boolean {
  return !message.correspondence;
}

/**
 * 同一发言者 3 分钟内的连续消息合成一组。
 * 换人、跨过 3 分钟、或中间夹了同事往来条都断开。
 * 带工具调用的消息也参与合并：工具卡仍各自渲染，只是不再每条都重复头像、名字和时间
 * （以前一次干活会刷出三四个完整的头部）。
 */
export function mergeRun(
  messages: DisplayMessage[],
  isGroup: boolean,
): DisplayMessage[][] {
  const runs: DisplayMessage[][] = [];
  for (const message of messages) {
    const previous = runs.at(-1);
    const previousMessage = previous?.at(-1);
    const canMerge = isMergeable(message) && (previousMessage ? isMergeable(previousMessage) : false);
    const sameSpeaker = canMerge && previousMessage
      ? speakerKey(previousMessage, isGroup) === speakerKey(message, isGroup)
      : false;
    const nearInTime = sameSpeaker && previousMessage
      ? Date.parse(message.createdAt) - Date.parse(previousMessage.createdAt) <= MERGE_WINDOW_MS
      : false;
    if (previous && sameSpeaker && nearInTime) previous.push(message);
    else runs.push([message]);
  }
  return runs;
}

/**
 * 某一天该怎么显示：今天 / 昨天 / M/D。
 * 「要不要插」由调用方按 previous 决定，这里只管标签本身。
 */
export function dateDividerLabel(createdAt: number, options: { now?: number } = {}): string {
  const now = options.now ?? Date.now();
  if (sameDay(now, createdAt)) return '今天';
  if (sameDay(now - 24 * 60 * 60_000, createdAt)) return '昨天';
  const date = new Date(createdAt);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** 与上一条之间要不要插日期分隔：同一天不插；没有上一条（第一条）时插 */
export function needsDateDivider(createdAt: number, previous: number | null): boolean {
  if (previous === null) return true;
  return !sameDay(previous, createdAt);
}

function sameDay(a: number, b: number): boolean {
  const left = new Date(a);
  const right = new Date(b);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/**
 * 把消息流变成时间线行：合并组 + 跨天日期分隔。
 * 过滤器与历史一致（空正文不渲染），往来条由 ChatView 另行处理。
 * `previousAt`：这一段之前最后一条消息的时间（被往来条切开的上一段）；
 * 不传或 null 表示这是时间线的起点，首条要插日期分隔。
 */
export function groupTimelineMessages(
  messages: DisplayMessage[],
  options: { isGroup: boolean; now?: number; previousAt?: number | null },
): TimelineEntry[] {
  const now = options.now ?? Date.now();
  const renderable = messages.filter(isRenderable);
  const entries: TimelineEntry[] = [];
  let previousAt: number | null = options.previousAt ?? null;
  for (const run of mergeRun(renderable, options.isGroup)) {
    const firstAt = Date.parse(run[0]!.createdAt);
    if (needsDateDivider(firstAt, previousAt)) {
      entries.push({ kind: 'divider', key: `divider-${run[0]!.id}`, label: dateDividerLabel(firstAt, { now }) });
    }
    entries.push({
      kind: 'group',
      key: `group-${run[0]!.id}`,
      messages: run,
      showSender: true,
      senderName: speakerName(run[0]!),
    });
    previousAt = Date.parse(run.at(-1)!.createdAt);
  }
  return entries;
}

/** 「回到最新」浮钮：离底部超过 200px 才显示；容器没布局出来时不显示 */
export function jumpToBottomVisible(metrics: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  if (metrics.clientHeight <= 0) return false;
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight > JUMP_TO_BOTTOM_THRESHOLD_PX;
}

/** 一条待渲染的时间线单元：日期分隔、合并消息组、或一段往来记录 */
export type TimelineBlock =
  | { kind: 'divider'; key: string; label: string }
  | { kind: 'group'; key: string; messages: DisplayMessage[] }
  | { kind: 'correspondence'; key: string; transfers: Correspondence[] };

/**
 * 把已分好类的聊天行（chatRows 的输出）整理成渲染块：
 * 往来条保持独立成块；连续的消息段按同一发言者 3 分钟合并，
 * 跨天插日期分隔。往来条会打断合并—— transfer 前后各自成组。
 */
export function timelineBlocks(
  rows: Array<
    | { kind: 'message'; message: DisplayMessage }
    | { kind: 'correspondence'; id: string; transfers: Correspondence[] }
  >,
  options: { isGroup: boolean; now?: number },
): TimelineBlock[] {
  const now = options.now ?? Date.now();
  const blocks: TimelineBlock[] = [];
  let run: DisplayMessage[] = [];
  /** 上一段最后一条已渲染消息的时间：往来条切开的下一段接着它比，不重复插「今天」 */
  let previousAt: number | null = null;

  const flushRun = () => {
    for (const group of groupTimelineMessages(run, { isGroup: options.isGroup, now, previousAt })) {
      if (group.kind === 'divider') {
        blocks.push({ kind: 'divider', key: group.key, label: group.label });
      } else {
        blocks.push({ kind: 'group', key: group.key, messages: group.messages });
        previousAt = Date.parse(group.messages.at(-1)!.createdAt);
      }
    }
    run = [];
  };

  for (const row of rows) {
    if (row.kind === 'correspondence') {
      flushRun();
      blocks.push({ kind: 'correspondence', key: row.id, transfers: row.transfers });
      continue;
    }
    run.push(row.message);
  }
  flushRun();
  return blocks;
}
