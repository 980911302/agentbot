import { randomUUID } from 'node:crypto';
import { DEFAULT_OWNER_NAME, DEFAULT_STOP_WORDS, isStopSentence } from '../../config.js';
import type { Message } from '../../shared/contracts/sse.js';
import type { AgentRecord } from '../../agent/types.js';
import type { RoomMemberLike } from '../../room/member.js';
import { resolveMentions, stripMentions } from '../../room/mentions.js';
import { SummonQueue } from '../../room/summon.js';
import { buildRoomBrief, decideRoomPosts } from '../../room/turn.js';
import type { RoomMessage, RoundOutcome } from '../../room/types.js';
import type { RoomRoundSummary, SendOptions } from './types.js';
import { ROOM_MAX_RUNS_PER_MEMBER, ROOM_POST_LIMIT_PER_TURN } from '../../room/types.js';

/**
 * RoomDispatcher（E2.2 拆出）：用户往群里发一条 → 扇出给全体成员。
 *
 * 分三波（参见 docs/架构设计.md「群与同事协作」）：
 *   波次 1  被点名的人              串行 —— 后者要能看到前者发言
 *   波次 2  在场但未被点名的人       并行 —— 互相看不见
 *   波次 3  被同事发言再次 @ 的人    串行，受 ROOM_MAX_RUNS_PER_MEMBER 约束
 *
 * `@` 是强信号不是投递开关：没被点名的一样进这一轮，只是不强制开口。
 * 回合执行经 runTurn 接缝注入（RunExecutor 在 E2.2e 落地）。
 */
export class RoomDispatcher {
  constructor(
    private readonly deps: {
      registry: import('../../agent/registry.js').AgentRegistry;
      rooms: import('../../room/store.js').RoomStore;
      messages: import('../../store/messages.js').MessageStore;
      /** 与 runtime 共享的忙闲锁（引用传入） */
      locks: Set<string>;
      membersOf: (roomId: string) => Promise<{
        room: import('../../room/types.js').Room | undefined;
        members: AgentRecord[];
      }>;
      ownerNameFallback: string;
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
            room?: { roomId: string; roomName: string; posts: string[]; limit: number };
            agentChainDepth?: number;
          };
          posts?: string[];
          model?: string;
          onEvent?: SendOptions['onEvent'];
          signal?: AbortSignal;
        },
        options: SendOptions,
      ) => Promise<{ content: string; usedTools?: string[] }>;
    },
  ) {}

  async postToRoom(
    roomId: string,
    text: string,
    options: SendOptions = {},
  ): Promise<RoomRoundSummary> {
    const { room, members } = await this.deps.membersOf(roomId);
    if (!room) throw new Error(`Unknown room: ${roomId}`);
    if (members.length === 0) throw new Error('房间没有成员');

    // 正在进行别的回合的成员不能被打断；工作台代发时还要排除调用者自己
    const exclude = new Set(options.excludeAgentIds ?? []);
    const skipped: string[] = [];
    const active = members.filter((record) => {
      if (exclude.has(record.id)) return false;
      if (this.deps.locks.has(record.id)) {
        skipped.push(record.name);
        return false;
      }
      return true;
    });
    if (active.length === 0) throw new Error('房间里没有可叫醒的成员（其他人正忙）');

    const memberLike: RoomMemberLike[] = active.map((record) => ({
      id: record.id,
      name: record.name,
      color: record.color,
    }));
    const byId = new Map(active.map((record) => [record.id, record]));

    const mentions = resolveMentions(text, memberLike);
    const roundId = randomUUID();
    const ownerName = options.ownerName ?? this.deps.ownerNameFallback;
    // 群里的停止令：不能紧急下发，被点名者下一轮从简报里知道
    const stopRequested = isStopSentence(text, this.deps.stopWords);

    const inbound: RoomMessage = {
      id: randomUUID(),
      roomId,
      roundId,
      senderKind: 'user',
      senderId: 'owner',
      senderName: ownerName,
      text,
      ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
      mentions: mentions.ids,
      everyone: mentions.everyone,
      createdAt: Date.now(),
    };
    await this.deps.rooms.append(inbound);
    options.onRoomEvent?.({ type: 'room_message', message: inbound });

    // 入站消息写进每个成员自己的对话线（私聊与群聊是同一条线）
    const stripped = stripMentions(text, memberLike);
    await Promise.all(
      active.map((member) =>
        this.deps.messages.append({
          id: randomUUID(),
          agentId: member.id,
          role: 'user',
          content: { type: 'text', text: stripped },
          createdAt: inbound.createdAt,
          roomId,
          roomName: room.name,
          speaker: ownerName,
          source: 'room',
        }),
      ),
    );

    const queue = new SummonQueue(
      memberLike.map((item) => item.id),
      mentions,
      ROOM_MAX_RUNS_PER_MEMBER,
    );
    const outcomes: RoundOutcome[] = [];
    /** 本轮已公开的发言，喂给后开口的人，避免重复 */
    const roundPosts: Array<{ speaker: string; text: string }> = [];

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

      for (const post of outcome.posts) {
        // 每条发言都重新解析点名：成员之间的 @ 也要能叫醒人
        const postMentions = resolveMentions(post, memberLike);
        const posted: RoomMessage = {
          id: randomUUID(),
          roomId,
          roundId,
          senderKind: 'agent',
          senderId: member.id,
          senderName: member.name,
          senderColor: member.color,
          text: post,
          mentions: postMentions.ids,
          everyone: postMentions.everyone,
          createdAt: Date.now(),
        };
        await this.deps.rooms.append(posted);
        options.onRoomEvent?.({ type: 'room_message', message: posted });
        roundPosts.push({ speaker: member.name, text: post });

        await Promise.all(
          active
            .filter((other) => other.id !== member.id)
            .map((other) =>
              this.deps.messages.append({
                id: randomUUID(),
                agentId: other.id,
                role: 'user',
                content: { type: 'text', text: post },
                createdAt: posted.createdAt,
                roomId,
                roomName: room.name,
                speaker: member.name,
                source: 'room',
              }),
            ),
        );

        // 被同事点名的人排进队列，稍后单独跑一轮
        queue.summonFrom(postMentions, member.id);
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

    const spoke = outcomes.filter((item) => item.status === 'spoke').length;
    options.onRoomEvent?.({
      type: 'fanout_done',
      roundId,
      spoke,
      silent: outcomes.length - spoke,
    });

    return { roundId, roomId, roomName: room.name, outcomes, skipped };
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
            limit: ROOM_POST_LIMIT_PER_TURN,
          },
          agentChainDepth: 0,
        },
        posts,
        model: options.model,
        onEvent: options.onEvent,
        signal: options.signal,
      }, options);

      // 被点名的人「必须开口」：模型直接输出正文也算开口，不要求它一定走 SendToUser。
      // 没被点名的人默认闭嘴，只有显式调用 SendToUser 才算真的往房间发了字。
      for (const post of decideRoomPosts({
        said: posts,
        summoned,
        finalText: result.content,
      })) {
        if (!posts.includes(post)) posts.push(post);
      }

      if (posts.length > 0) {
        // 自己的发言也要留在自己的对话里
        for (const post of posts) {
          await this.deps.messages.append({
            id: randomUUID(),
            agentId: member.id,
            role: 'assistant',
            content: { type: 'text', text: post },
            createdAt: Date.now(),
            roomId: input.roomId,
            roomName: input.roomName,
            source: 'room',
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
  if (usedTools.includes('stay_silent')) return '这一轮没有要补充的';
  return '这一轮没有开口';
}
