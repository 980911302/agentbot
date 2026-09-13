/**
 * 群聊模型 —— 参见 docs/架构设计.md「群与同事协作」
 *
 * 群不是记忆库，也不是会思考的机器人。它只有三样东西：
 *   1. 一个名字
 *   2. 一份成员表（智能体 id，不能嵌套群）
 *   3. 一条共享时间线
 * 思考发生在每个成员智能体各自的回合里。
 */

export const ROOM_MEMBER_LIMIT = 6;
export const ROOM_POST_LIMIT_PER_TURN = 3;
/**
 * 同一个成员在一轮 roundId 内最多被叫醒几次。
 * 成员 A 发言里 @ 了 B，B 会被再开一轮；若 B 又 @ 回 A，A 最多再跑一次。
 * 上限存在的意义是防止两个成员互相 @ 造成不死循环。
 */
export const ROOM_MAX_RUNS_PER_MEMBER = 2;

export interface Room {
  id: string;
  name: string;
  memberIds: string[];
  /** 新成员只接收加入后的群消息；旧数据缺省使用建群时间。 */
  memberJoinedAt?: Record<string, number>;
  createdAt: number;
  updatedAt: number;
}

export type RoomSenderKind = 'user' | 'agent' | 'system';

export interface RoomMessage {
  id: string;
  roomId: string;
  roundId: string;
  senderKind: RoomSenderKind;
  senderId: string;
  senderName: string;
  senderColor?: string;
  text: string;
  /** 解析出来的被点名成员 id */
  mentions: string[];
  everyone: boolean;
  createdAt: number;
  /** 幂等键（E3.2） */
  clientMessageId?: string;
}

/** 一个成员在这一轮里的结局：开口还是闭嘴 */
export type RoundStatus = 'spoke' | 'silent' | 'error';

export interface RoundOutcome {
  roundId: string;
  roomId: string;
  agentId: string;
  agentName: string;
  agentColor?: string;
  status: RoundStatus;
  posts: string[];
  /** 沉默/失败的原因，仅用于解释，不进房间时间线 */
  note?: string;
  durationMs: number;
  /** 被同事发言再次叫醒时 > 1 */
  runIndex?: number;
}

export interface RoomView extends Room {
  members: Array<{ id: string; name: string; color: string }>;
  messageCount: number;
  lastMessage?: { text: string; senderName: string; createdAt: number };
}

export type RoomEvent =
  | { type: 'room_message'; message: RoomMessage }
  | { type: 'round_start'; roundId: string; agentId: string; agentName: string }
  | { type: 'round_end'; outcome: RoundOutcome }
  | { type: 'fanout_done'; roundId: string; spoke: number; silent: number };

export type RoomEventHandler = (event: RoomEvent) => void;
