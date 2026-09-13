import { randomUUID } from 'node:crypto';
import type { RunContinuation } from '../../agent/continuation.js';
import { isStopSentence } from '../../config.js';
import type { Message } from '../../shared/contracts/sse.js';
import type { AgentRecord } from '../../agent/types.js';
import type { RoomMemberLike } from '../../room/member.js';
import { resolveMentions, stripMentions, type MentionResult } from '../../room/mentions.js';
import { SummonQueue } from '../../room/summon.js';
import { buildRoomBrief, decideRoomPosts } from '../../room/turn.js';
import type { RoomMessage, RoundOutcome } from '../../room/types.js';
import type { RoomRoundSummary, SendOptions } from './types.js';
import { AgentBusyError } from './types.js';
import { ROOM_MAX_RUNS_PER_MEMBER, ROOM_POST_LIMIT_PER_TURN } from '../../room/types.js';
import type { AgentInbox, InboxItem } from '../../agent/inbox.js';

/**
 * RoomDispatcher（E2.2 拆出，E3.7 改可靠投递）：用户往群里发一条 → 扇出给全体成员。
 *
 * 点名按**发送时的完整成员快照**解析（忙不忙不影响谁被点名）；
 * 空闲成员按三波召唤跑回合，**忙碌成员改为排队**（写进收件箱、等它空下来处理），
 * 不再静默跳过丢信；离群或群解散后，排队的投递在领取时撤销。
 *
 * 三波（参见 docs/架构设计.md「群与同事协作」）：
 *   波次 1  被点名的人              串行 —— 后者要能看到前者发言
 *   波次 2  在场但未被点名的人       并行 —— 互相看不见
 *   波次 3  被同事发言再次 @ 的人    串行，受 ROOM_MAX_RUNS_PER_MEMBER 约束
 *
 * `@` 是强信号不是投递开关：没被点名的一样进这一轮，只是不强制开口。
 */
export class RoomDispatcher {
  constructor(
    private readonly deps: {
      registry: import('../../agent/registry.js').AgentRegistry;
      rooms: import('../../room/store.js').RoomStore;
      messages: import('../../store/messages.js').MessageStore;
      inbox: AgentInbox;
      /** 与 runtime 共享的忙闲锁（引用传入） */
      locks: Set<string>;
      membersOf: (roomId: string) => Promise<{
        room: import('../../room/types.js').Room | undefined;
        members: AgentRecord[];
      }>;
      ownerNameFallback: string;
      onExperience?: (message: Message) => void;
      stopWords: string[];
      runTurn: (
        agentId: string,
        task: Message,
        turn: {
          brief?: string;
          skipPersist?: boolean;
          persistAssistantText?: boolean;
          extraTools?: never[];
          toolContext?: {
            room?: import('../../tools/tool.js').RoomTurnContext;
            agentChainDepth?: number;
          };
          posts?: string[];
          model?: string;
          onEvent?: SendOptions['onEvent'];
          signal?: AbortSignal;
        },
        options: SendOptions,
      ) => Promise<{ content: string; usedTools?: string[] }>;
      /** 唤醒空闲成员去处理刚排队的投递（忙的人由它自己的回合收尾接手） */
      drainInbox?: (agentId: string, options: SendOptions) => void;
    },
  ) {}

  private async remember(message: Message): Promise<void> {
    await this.deps.messages.append(message);
    this.deps.onExperience?.(message);
  }

  /** 投递入口：只落时间线/成员经历/收件箱，绝不进入模型或三波等待。 */
  enqueueMessage(roomId: string, text: string, options: SendOptions = {}): Promise<RoomRoundSummary> {
    return this.postToRoom(roomId, text, options, true);
  }

  async postToRoom(
    roomId: string,
    text: string,
    options: SendOptions = {},
    queueOnly = false,
  ): Promise<RoomRoundSummary> {
    const { room, members } = await this.deps.membersOf(roomId);
    if (!room) throw new Error(`Unknown room: ${roomId}`);
    if (members.length === 0) throw new Error('房间没有成员');

    // 点名按完整成员快照解析（E3.7）：忙碌与否不影响谁被点到
    const snapshot: RoomMemberLike[] = members.map((record) => ({
      id: record.id,
      name: record.name,
      color: record.color,
    }));
    const mentions = resolveMentions(text, snapshot);
    const roundId = options.runId ?? randomUUID();
    const ownerName = options.ownerName ?? this.deps.ownerNameFallback;
    const postingAgent = options.roomSenderId ? members.find(member => member.id === options.roomSenderId) : undefined;
    if (options.roomSenderId && !postingAgent) throw new Error('代发智能体已不在群里');
    const actor = postingAgent
      ? { kind: 'agent' as const, id: postingAgent.id, name: postingAgent.name, color: postingAgent.color, avatar: postingAgent.avatar }
      : { kind: 'user' as const, id: 'owner', name: ownerName };
    // 群里的停止令：不能紧急下发，被点名者从简报里知道
    const stopRequested = isStopSentence(text, this.deps.stopWords);
    const stripped = stripMentions(text, snapshot);

    const inbound: RoomMessage = {
      id: options.messageId ?? randomUUID(),
      roomId,
      roundId,
      senderKind: actor.kind,
      senderId: actor.id,
      senderName: actor.name,
      senderColor: postingAgent?.color,
      text,
      ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
      mentions: mentions.ids,
      everyone: mentions.everyone,
      createdAt: Date.now(),
    };
    options.signal?.throwIfAborted();
    await this.deps.rooms.append(inbound);
    options.onRoomEvent?.({ type: 'room_message', message: inbound });
    if (postingAgent) await this.remember({ id: randomUUID(), agentId: postingAgent.id, role: 'assistant',
      runId: roundId, content: { type: 'text', text }, createdAt: inbound.createdAt,
      roomId, roomName: room.name, source: 'room', sender: actor });

    // 工作台代发时排除调用者自己；其余在场成员都记进各自对话线（忙的也记，等它空下来看）
    const exclude = new Set(options.excludeAgentIds ?? []);
    const roster = members.filter((record) => !exclude.has(record.id));
    await Promise.all(
      roster.map((member) =>
        this.remember({
          id: randomUUID(),
          agentId: member.id,
          role: 'user',
          runId: roundId,
          content: { type: 'text', text: stripped },
          createdAt: inbound.createdAt,
          roomId,
          roomName: room.name,
          speaker: actor.name,
          sender: actor,
          source: 'room',
        }),
      ),
    );

    // 忙的排队（E3.7：不丢信），空闲的进这一轮波次
    const queued: string[] = [];
    const active: AgentRecord[] = [];
    for (const record of roster) {
      if (!queueOnly && !this.deps.locks.has(record.id)) {
        active.push(record);
        continue;
      }
      queued.push(record.name);
      await this.deps.inbox.enqueueRoom({
        toAgentId: record.id,
        fromAgentId: actor.id,
        fromName: actor.name,
        fromActor: actor,
        text: stripped,
        priority: false,
        depth: options.agentChainDepth ?? 0,
        kind: 'room',
        room: {
          roomId,
          roomName: room.name,
          roundId,
          model: options.model,
          speaker: actor.name,
          summoned: mentions.everyone || mentions.ids.includes(record.id),
          everyone: mentions.everyone,
          stopRequested,
        },
        correlationId: roundId,
      }, ROOM_MAX_RUNS_PER_MEMBER);
    }

    if (queueOnly) return { roundId, roomId, roomName: room.name, outcomes: [], queued };

    const memberLike: RoomMemberLike[] = active.map((record) => ({
      id: record.id,
      name: record.name,
      color: record.color,
    }));
    const byId = new Map(active.map((record) => [record.id, record]));
    const outcomes: RoundOutcome[] = [];
    /** 本轮已公开的发言，喂给后开口的人，避免重复 */
    const roundPosts: Array<{ speaker: string; text: string }> = [];

    if (memberLike.length > 0) {
      const queue = new SummonQueue(
        memberLike.map((item) => item.id),
        mentions,
        ROOM_MAX_RUNS_PER_MEMBER,
      );

      const fanOut = async (agentId: string): Promise<void> => {
        const member = byId.get(agentId);
        if (!member) return;

        // 同步占名额：并行派发时同波次的人必须先登记，否则互相 @ 会漏掉
        const runIndex = queue.reserve(agentId);
        if (runIndex > ROOM_MAX_RUNS_PER_MEMBER) return;

        options.onRoomEvent?.({ type: 'round_start', roundId, agentId, agentName: member.name });

        const outcome = await this.runRoomTurn({
          roomId,
          roomName: room.name,
          roundId,
          member,
          members: memberLike,
          inbound,
          summoned: queue.isSummoned(agentId),
          everyone: queue.mentionsFor(agentId).everyone,
          recallCount: runIndex,
          roundPosts: [...roundPosts],
          stopRequested: stopRequested && queue.isSummoned(agentId),
          options,
        });
        outcomes.push(outcome);
        options.onRoomEvent?.({ type: 'round_end', outcome });

        if (outcome.posts.length > 0) {
          // 每条发言都重新解析点名：成员之间的 @ 也要能叫醒人
          const posted = await this.publishMemberPosts({
            roomId,
            roomName: room.name,
            roundId,
            member,
            color: member.color,
            posts: outcome.posts,
            members: memberLike,
            options,
          });
          for (const entry of posted) {
            roundPosts.push({ speaker: member.name, text: entry.text });
            queue.summonFrom(entry.mentions, member.id);
          }
        }
      };

      // 波次 1：被点名者，串行
      for (const agentId of queue.initiallySummoned()) await fanOut(agentId);

      // 波次 2：在场未点名者，并行（同波次互相看不见，但能看到波次 1 的发言）
      const bystanders = queue.bystanders();
      if (bystanders.length > 0) {
        await Promise.all(bystanders.map((agentId) => fanOut(agentId)));
      }

      // 波次 3：同事发言引发的新召唤，串行直到队列空或达每人上限
      while (queue.hasWaiting) {
        const agentId = queue.next();
        if (!agentId) break;
        await fanOut(agentId);
      }
    }

    const spoke = outcomes.filter((item) => item.status === 'spoke').length;
    options.onRoomEvent?.({
      type: 'fanout_done',
      roundId,
      spoke,
      silent: outcomes.length - spoke,
    });

    return { roundId, roomId, roomName: room.name, outcomes, queued };
  }

  /**
   * 延迟回合（E3.7）：忙碌成员空下来后处理排队的群消息。
   * 群没了或人已经不在群里 → 撤销这条投递（不跑模型，直接确认）。
   */
  async deliverQueued(item: InboxItem, options: SendOptions = {}): Promise<RoundOutcome> {
    const context = item.room;
    options = { ...options, model: context?.model ?? options.model, agentChainDepth: item.depth };
    const startedAt = Date.now();
    if (!context) throw new Error('room 投递缺少群上下文');

    const { room, members } = await this.deps.membersOf(context.roomId);
    const memberLike: RoomMemberLike[] = members.map((record) => ({
      id: record.id,
      name: record.name,
      color: record.color,
    }));
    const member = members.find((record) => record.id === item.toAgentId);
    if (!room || !member || item.createdAt < (room.memberJoinedAt?.[item.toAgentId] ?? room.createdAt)) {
      return {
        roundId: context.roundId,
        roomId: context.roomId,
        agentId: item.toAgentId,
        agentName: item.fromName,
        status: 'silent',
        posts: [],
        note: room ? '已经不在这个群里，撤销这条投递' : '群已经不存在，撤销这条投递',
        durationMs: Date.now() - startedAt,
      };
    }

    const inbound: RoomMessage = {
      id: randomUUID(),
      roomId: context.roomId,
      roundId: context.roundId,
      senderKind: item.fromActor?.kind ?? (item.fromAgentId === 'owner' ? 'user' : 'agent'),
      senderId: item.fromAgentId,
      senderName: context.speaker,
      senderColor: item.fromActor?.color,
      text: item.text,
      mentions: [],
      everyone: context.everyone ?? false,
      createdAt: item.createdAt,
    };
    // 同一轮里别人已经说过的话：从群时间线取（晚到的人也要接得上）
    const recent = await this.deps.rooms.messages(context.roomId, 20).catch(() => []);
    const roundPosts = recent
      .filter((message) => message.roundId === context.roundId && message.senderKind === 'agent'
        && message.createdAt >= (room.memberJoinedAt?.[member.id] ?? room.createdAt))
      .map((message) => ({ speaker: message.senderName, text: message.text }));

    options.onRoomEvent?.({
      type: 'round_start',
      roundId: context.roundId,
      agentId: member.id,
      agentName: member.name,
    });
    const outcome = await this.runRoomTurn({
      roomId: context.roomId,
      roomName: context.roomName,
      roundId: context.roundId,
      member,
      members: memberLike,
      inbound,
      summoned: context.summoned,
      everyone: context.everyone ?? false,
      recallCount: 1,
      roundPosts,
      stopRequested: context.stopRequested === true && context.summoned,
      livePosts: true,
      options,
    });
    options.onRoomEvent?.({ type: 'round_end', outcome });

    return outcome;
  }

  /** 把某个成员的公开发言落到群里：时间线 + 其他成员对话线 + 事件（发言者自己那条由 runRoomTurn 写） */
  async publishResumedPosts(agentId: string, continuation: RunContinuation, posts: string[], options: SendOptions): Promise<void> {
    if (!continuation.room) return;
    const { room, members } = await this.deps.membersOf(continuation.room.roomId);
    const member = members.find(item => item.id === agentId);
    if (!room || !member) throw new Error('任务所在群已解散或智能体已离群，未交付续跑结果');
    options.signal?.throwIfAborted();
    for (const text of posts) await this.remember({ id: randomUUID(), runId: options.runId,
      agentId, role: 'assistant', content: { type: 'text', text }, createdAt: Date.now(),
      source: 'room', roomId: room.id, roomName: room.name,
      sender: { kind: 'agent', id: member.id, name: member.name, color: member.color, avatar: member.avatar } });
    const entries = await this.publishMemberPosts({ roomId: room.id, roomName: room.name,
      roundId: continuation.room.roundId, member, color: member.color, posts, members, options });
    await this.queueRoundMentions({ roomId: room.id, roomName: room.name,
      roundId: continuation.room.roundId, speaker: member, entries, members, depth: continuation.agentChainDepth });
  }

  private async publishMemberPosts(input: {
    roomId: string;
    roomName: string;
    roundId: string;
    member: AgentRecord;
    color?: string;
    posts: string[];
    members: RoomMemberLike[];
    options: SendOptions;
  }): Promise<Array<{ mentions: MentionResult; messageId: string; text: string }>> {
    const published: Array<{ mentions: MentionResult; messageId: string; text: string }> = [];
    for (const post of input.posts) {
      const postMentions = resolveMentions(post, input.members);
      const message: RoomMessage = {
        id: randomUUID(),
        roomId: input.roomId,
        roundId: input.roundId,
        senderKind: 'agent',
        senderId: input.member.id,
        senderName: input.member.name,
        senderColor: input.color,
        text: post,
        mentions: postMentions.ids,
        everyone: postMentions.everyone,
        createdAt: Date.now(),
      };
      await this.deps.rooms.append(message);
      input.options.onRoomEvent?.({ type: 'room_message', message });
      published.push({ mentions: postMentions, messageId: message.id, text: post });

      await Promise.all(
        input.members
          .filter((other) => other.id !== input.member.id)
          .map((other) =>
            this.remember({
              id: randomUUID(),
              agentId: other.id,
              role: 'user',
              runId: input.roundId,
              content: { type: 'text', text: post },
              createdAt: message.createdAt,
              roomId: input.roomId,
              roomName: input.roomName,
              speaker: input.member.name,
              sender: { kind: 'agent', id: input.member.id, name: input.member.name, color: input.member.color, avatar: input.member.avatar },
              source: 'room',
            }),
          ),
      );
    }
    return published;
  }

  /**
   * 延迟回合里被点到的人：转成新的排队投递。
   * 配额看「本轮已经排在收件箱里的投递数」——持久在投递上，重投不会凭空重置。
   */
  private async queueRoundMentions(input: {
    roomId: string;
    roomName: string;
    roundId: string;
    speaker: AgentRecord;
    entries: Array<{ mentions: MentionResult; text: string }>;
    members: RoomMemberLike[];
    depth?: number;
  }): Promise<string[]> {
    const queued: string[] = [];
    for (const entry of input.entries) {
      const targets = entry.mentions.everyone
        ? input.members.map((member) => member.id)
        : entry.mentions.ids;
      for (const targetId of targets) {
        if (targetId === input.speaker.id) continue;
        if (!input.members.some((member) => member.id === targetId)) continue;
        const accepted = await this.deps.inbox.enqueueRoom({
          toAgentId: targetId,
          fromAgentId: input.speaker.id,
          fromName: input.speaker.name,
          fromActor: { kind: 'agent', id: input.speaker.id, name: input.speaker.name, color: input.speaker.color, avatar: input.speaker.avatar },
          text: stripMentions(entry.text, input.members),
          priority: false,
          depth: input.depth ?? 0,
          kind: 'room',
          room: {
            roomId: input.roomId,
            roomName: input.roomName,
            roundId: input.roundId,
            speaker: input.speaker.name,
            summoned: true,
            everyone: entry.mentions.everyone,
          },
          correlationId: input.roundId,
        }, ROOM_MAX_RUNS_PER_MEMBER);
        if (!accepted) continue;
        queued.push(targetId);
        // 空闲的人立刻叫醒；忙的人由它自己的回合收尾接手
        if (!this.deps.locks.has(targetId)) this.deps.drainInbox?.(targetId, {});
      }
    }
    return queued;
  }

  private async runRoomTurn(input: {
    roomId: string;
    roomName: string;
    roundId: string;
    member: AgentRecord;
    members: RoomMemberLike[];
    inbound: RoomMessage;
    summoned: boolean;
    everyone: boolean;
    recallCount: number;
    roundPosts: Array<{ speaker: string; text: string }>;
    stopRequested?: boolean;
    livePosts?: boolean;
    options: SendOptions;
  }): Promise<RoundOutcome> {
    const startedAt = Date.now();
    const { member, members, inbound, summoned, options } = input;
    const posts: string[] = [];

    const brief = buildRoomBrief({
      roomName: input.roomName,
      members,
      selfId: member.id,
      speaker: inbound.senderName,
      summoned,
      everyone: input.everyone,
      postLimit: ROOM_POST_LIMIT_PER_TURN,
      roundPosts: input.roundPosts,
      recallCount: input.recallCount,
      stopRequested: input.stopRequested,
    });

    const task: Message = {
      id: randomUUID(),
      agentId: member.id,
      role: 'user',
      content: { type: 'text', text: stripMentions(inbound.text, members) },
      createdAt: inbound.createdAt,
      roomId: input.roomId,
      roomName: input.roomName,
      speaker: inbound.senderName,
      source: 'room',
      sender: { kind: inbound.senderKind, id: inbound.senderId, name: inbound.senderName, color: inbound.senderColor },
    };

    try {
      const result = await this.deps.runTurn(member.id, task, {
        brief,
        skipPersist: true,
        persistAssistantText: false,
        // 被点名时必须开口：连沉默工具都不给，把「必须说」做成硬约束
        extraTools: [],
        toolContext: {
          room: {
            roomId: input.roomId,
            roomName: input.roomName,
            posts,
            roundId: input.roundId,
            limit: ROOM_POST_LIMIT_PER_TURN,
            ...(input.livePosts ? { live: true, publish: async (text: string) => {
              options.signal?.throwIfAborted();
              const current = await this.deps.rooms.get(input.roomId);
              if (!current?.memberIds.includes(member.id)) throw new Error('已经不在这个群里，未发送');
              await this.remember({ id: randomUUID(), runId: options.runId, agentId: member.id,
                role: 'assistant', content: { type: 'text', text }, createdAt: Date.now(), source: 'room',
                roomId: input.roomId, roomName: input.roomName,
                sender: { kind: 'agent', id: member.id, name: member.name, color: member.color, avatar: member.avatar } });
              const posted = await this.publishMemberPosts({ roomId: input.roomId, roomName: input.roomName,
                roundId: input.roundId, member, color: member.color, posts: [text], members, options });
              await this.queueRoundMentions({ roomId: input.roomId, roomName: input.roomName, roundId: input.roundId,
                speaker: member, entries: posted, members, depth: options.agentChainDepth });
            } } : {}),
          },
          agentChainDepth: options.agentChainDepth ?? 0,
        },
        posts,
        model: options.model,
        onEvent: options.onEvent,
        signal: options.signal,
      }, options);

      // 群里只有显式调用 SendToUser 才算发言；普通收尾文本始终是草稿。
      for (const post of decideRoomPosts({
        sent: posts,
      })) {
        if (!posts.includes(post)) posts.push(post);
      }

      if (posts.length > 0 && !input.livePosts) {
        // 自己的发言也要留在自己的对话里
        for (const post of posts) {
          await this.remember({
            id: randomUUID(),
            agentId: member.id,
            role: 'assistant',
            runId: options.runId ?? input.roundId,
            content: { type: 'text', text: post },
            createdAt: Date.now(),
            roomId: input.roomId,
            roomName: input.roomName,
            source: 'room',
            sender: { kind: 'agent', id: member.id, name: member.name, color: member.color, avatar: member.avatar },
          });
        }
      }

      return {
        roundId: input.roundId,
        roomId: input.roomId,
        agentId: member.id,
        agentName: member.name,
        agentColor: member.color,
        status: posts.length > 0 ? 'spoke' : 'silent',
        posts,
        note: posts.length > 0 ? undefined : silenceReason(result.usedTools ?? []),
        durationMs: Date.now() - startedAt,
        runIndex: input.recallCount,
      };
    } catch (error) {
      if (error instanceof AgentBusyError) throw error;
      return {
        roundId: input.roundId,
        roomId: input.roomId,
        agentId: member.id,
        agentName: member.name,
        agentColor: member.color,
        status: 'error',
        posts: [],
        note: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        runIndex: input.recallCount,
      };
    }
  }
}

function silenceReason(usedTools: string[]): string {
  void usedTools;
  return '这一轮没有开口';
}
