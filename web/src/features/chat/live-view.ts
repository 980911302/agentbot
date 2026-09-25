/**
 * 聊天区「在场状态」的纯判定（OPT-04 从 App.tsx 抽出）。
 *
 * 运行记录（ChatRun）是唯一事实源：谁在跑、是否正在停止、群回合轮到谁，都从这里推。
 * 这里只做纯计算，React 状态与订阅留在 use-live-view.ts；分开是为了能直接 node:test。
 */

import type { ChatRun } from '../../../../src/shared/contracts/chat-state.js';
import type { ChannelItem } from '../../components/Sidebar';
import type { BotSummary, DisplayMessage } from '../../types';
import type { AgentControlFlags } from '../workspace/use-workspace';
import type { ControlNoticeInput } from './control-view';

/** 频道历史骨架的等待阈值（bug_d2xiqthtxdmm）：太快到位的数据不该闪骨架 */
export const CHANNEL_SKELETON_DELAY_MS = 300;

/** 是否有一笔停止正在这个频道生效（UI-05：kind=stop 的活动 run） */
export function stopInFlightFor(runs: Iterable<ChatRun>, channelId: string): boolean {
  for (const run of runs) {
    if (
      run.agentId === channelId &&
      run.kind === 'stop' &&
      (run.status === 'queued' || run.status === 'running' || run.status === 'finalizing')
    ) {
      return true;
    }
  }
  return false;
}

/** 群成员进行中也由运行记录推导；丢 round_end 时仍可由快照收口 */
export function latestRoomRun(runs: Iterable<ChatRun>, channelId: string): ChatRun | undefined {
  return [...runs]
    .reverse()
    .find(
      (run) =>
        run.roomId === channelId &&
        run.kind === 'agent' &&
        (run.status === 'queued' || run.status === 'running'),
    );
}

/** 正在跑（排队 / 执行中）的智能体 id 集合：侧栏状态点用 */
export function workingAgentIds(runs: Iterable<ChatRun>): Set<string> {
  const ids = new Set<string>();
  for (const run of runs) {
    if (run.agentId && (run.status === 'queued' || run.status === 'running')) ids.add(run.agentId);
  }
  return ids;
}

/** 把「正在跑」合进侧栏条目：频道与群成员各自的状态点 */
export function withWorkingStatus(
  channels: ChannelItem[],
  working: ReadonlySet<string>,
): ChannelItem[] {
  return channels.map((channel) => ({
    ...channel,
    status: working.has(channel.id) ? 'working' : channel.status,
    members: channel.members?.map((member) => ({
      ...member,
      status: working.has(member.id) ? 'working' : member.status,
    })),
  }));
}

/** 当前频道的成员（群才有；私聊为空数组） */
export function liveMembersOf(
  channels: ChannelItem[],
  activeChannelId: string,
): NonNullable<ChannelItem['members']> {
  return (
    (activeChannelId ? channels.find((item) => item.id === activeChannelId)?.members : undefined) ??
    []
  );
}

/**
 * 控制状态条输入（UI-05）：当前 1:1 智能体的许可态 + 来信积压 + 停止中。
 * 群没有单智能体许可态，不显示。
 */
export function controlInputFor(
  agentFlags: Record<string, AgentControlFlags>,
  activeChannelId: string,
  activeKind: ChannelItem['kind'],
  stopInFlight: boolean,
): ControlNoticeInput | null {
  const flags = agentFlags[activeChannelId];
  const isAgentChannel = Boolean(activeChannelId) && activeKind !== 'room';
  if (!flags || !isAgentChannel) return null;
  return {
    autoActivation: flags.paused ? 'paused' : 'enabled',
    held: flags.held,
    faulted: flags.faulted,
    pendingMail: flags.pendingMail,
    failedMail: flags.failedMail,
    stopInFlight,
  };
}

/** 消息流里最后一个仍在跑的工具名（顶栏活动文字用）；没有就是 null */
export function runningToolName(messages: DisplayMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const call = messages[index]?.toolCalls.find((item) => item.status === 'running');
    if (call) return call.name;
  }
  return null;
}

/**
 * 当前频道的 BotSummary：真实记录优先，状态 / 活动取自本机流与本轮工具调用，不编造。
 * 回复中统一说「working」，有流式增量才说「thinking」。
 */
export function botSummaryFor(input: {
  channel: ChannelItem;
  record: BotSummary | null;
  messages: DisplayMessage[];
  responding: boolean;
  liveText: string;
}): BotSummary {
  const { channel, record, messages, responding, liveText } = input;
  return {
    id: channel.id,
    name: record?.name ?? channel.name,
    title: record?.title,
    description: record?.description,
    instructions: record?.instructions,
    avatar: record?.avatar,
    section: record?.section,
    hidden: record?.hidden,
    role: record?.role ?? channel.role ?? '',
    color: record?.color ?? channel.color ?? '#b89b6a',
    status: responding ? (liveText ? 'thinking' : 'working') : (record?.status ?? 'idle'),
    activity: runningToolName(messages) ?? '',
    conversationCount: record?.conversationCount ?? 0,
    createdAt: record?.createdAt ?? '',
    updatedAt: record?.updatedAt ?? '',
  };
}

/** 频道历史加载态：没拉过快照、等过了阈值、且一条消息都没有，才显示骨架 */
export function channelSkeletonVisible(
  loaded: boolean,
  waitingTooLong: boolean,
  messageCount: number,
): boolean {
  return !loaded && waitingTooLong && messageCount === 0;
}