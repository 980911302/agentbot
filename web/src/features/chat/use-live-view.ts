import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChannelItem } from '../../components/Sidebar';
import type { ArtifactView, BotSummary, DisplayMessage } from '../../types';
import type { AgentControlFlags } from '../workspace/use-workspace';
import type { ChatEngine, Snapshot } from './chat-engine';
import {
  CHANNEL_SKELETON_DELAY_MS,
  botSummaryFor,
  channelSkeletonVisible,
  controlInputFor,
  latestRoomRun,
  liveMembersOf,
  stopInFlightFor,
  withWorkingStatus,
  workingAgentIds,
} from './live-view';

/** 回复刚结束的绿勾停留时长 */
const DONE_FLASH_MS = 2500;

/**
 * 当前频道的视图状态（OPT-04 从 App.tsx 抽出）：
 * 消息 / 是否在回复 / 流式增量 / 谁在工作 / 群回合轮到谁 / BotSummary / 骨架与绿勾，
 * 外加「切频道时拉一次快照补 artifacts」这个副作用。
 *
 * 纯判定都在 live-view.ts，这里只订阅引擎版本号、拿时机、调 useState。
 */
export function useLiveView(input: {
  engine: ChatEngine;
  /** runs 是引擎内部原地增删的 Map，引用终生不变；版本号变化才是真的变了 */
  engineVersion: number;
  activeChannelId: string;
  activeChannel: ChannelItem;
  backendAgents: BotSummary[];
  sidebarChannels: ChannelItem[];
  agentFlags: Record<string, AgentControlFlags>;
  busy: boolean;
  reloadChannel: (channelId: string) => Promise<Snapshot | undefined>;
  /** 传稳定的 setter（setArtifacts），否则下面的 effect 会每次渲染重跑 */
  onArtifacts: (artifacts: ArtifactView[]) => void;
  onChannelChange: (kind: ChannelItem['kind']) => void;
}) {
  const { engine, engineVersion, activeChannelId, activeChannel } = input;

  const messages: DisplayMessage[] = engine.histories[activeChannelId] ?? [];
  const channelLoaded = activeChannelId ? engine.loadedChannels[activeChannelId] === true : true;
  /** 当前频道是否还在等一条可见回复；后台记忆收尾不算 */
  const responding = engine.respondingChannelIds.includes(activeChannelId);
  const liveText = engine.liveFor(activeChannelId);

  const stopInFlight = useMemo(
    () => stopInFlightFor(engine.runs.values(), activeChannelId),
    [engine.runs, engineVersion, activeChannelId],
  );

  // 群成员进行中也由运行记录推导；丢 round_end 时仍可由快照收口（每次渲染重算）
  const roomRun = latestRoomRun(engine.runs.values(), activeChannelId);
  const roomAgent = roomRun ? input.backendAgents.find((agent) => agent.id === roomRun.agentId) : undefined;
  const roundActive = roomAgent
    ? { id: roomAgent.id, name: roomAgent.name, color: roomAgent.color }
    : null;

  const working = useMemo(() => workingAgentIds(engine.runs.values()), [engine.runs, engineVersion]);
  const liveSidebarChannels = useMemo(
    () => withWorkingStatus(input.sidebarChannels, working),
    [input.sidebarChannels, working],
  );
  const liveMembers = useMemo(
    () => liveMembersOf(liveSidebarChannels, activeChannelId),
    [liveSidebarChannels, activeChannelId],
  );

  const controlInput = useMemo(
    () => controlInputFor(input.agentFlags, activeChannelId, activeChannel.kind, stopInFlight),
    [input.agentFlags, activeChannelId, activeChannel.kind, stopInFlight],
  );

  const botSummary = useMemo(
    () =>
      botSummaryFor({
        channel: activeChannel,
        record: input.backendAgents.find((bot) => bot.id === activeChannel.id) ?? null,
        messages,
        responding,
        liveText,
      }),
    [activeChannel, input.backendAgents, liveText, messages, responding],
  );

  /**
   * 频道历史加载态（bug_d2xiqthtxdmm）：切频道时消息是异步 load 的，期间聊天区会白一片。
   * 对还没拉到过快照的频道显示骨架，且只在等过 300ms 之后——数据快到位时不闪那一下。
   * 用 state 而不是只在 effect 里翻 ref：ref 会留着上一个频道的值，切过去那一刻把
   * 上一频道的「加载中」带到新频道，骨架闪一下就没了。
   */
  const [waitingTooLong, setWaitingTooLong] = useState(false);
  useEffect(() => {
    if (!activeChannelId) return undefined;
    if (channelLoaded) {
      setWaitingTooLong(false);
      return undefined;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      if (live) setWaitingTooLong(true);
    }, CHANNEL_SKELETON_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
      setWaitingTooLong(false);
    };
  }, [activeChannelId, channelLoaded]);
  const loading = channelSkeletonVisible(channelLoaded, waitingTooLong, messages.length);

  /** 回合/回复刚结束的短暂绿勾（done 的在场感） */
  const [doneFlash, setDoneFlash] = useState(false);
  const prevBusyRef = useRef(false);
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = input.busy;
    if (wasBusy && !input.busy) {
      setDoneFlash(true);
      const timer = window.setTimeout(() => setDoneFlash(false), DONE_FLASH_MS);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [input.busy]);

  const { reloadChannel, onArtifacts, onChannelChange } = input;
  /** 切频道：补时间线里的产出文件（artifacts），并让抽屉页签跟着频道类型走 */
  useEffect(() => {
    if (!activeChannelId) return undefined;
    let cancelled = false;
    // 成员页只对群有意义，切到私聊时回到默认页
    onChannelChange(activeChannel.kind);
    void (async () => {
      try {
        const snapshot = await reloadChannel(activeChannelId);
        if (cancelled) return;
        onArtifacts(snapshot?.channels[activeChannelId]?.artifacts ?? []);
      } catch {
        // 保持现有内容
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeChannel.kind, activeChannelId, onArtifacts, onChannelChange, reloadChannel]);

  return {
    messages,
    responding,
    liveText,
    stopInFlight,
    roundActive,
    liveSidebarChannels,
    liveMembers,
    controlInput,
    botSummary,
    loading,
    doneFlash,
  };
}