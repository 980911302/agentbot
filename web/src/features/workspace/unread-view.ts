/**
 * 侧栏未读的纯逻辑（UI 规范 §2 / §4「未读红点」）：群和私聊一视同仁。
 *
 * 做法：每个频道记一个「已读位置」= 看过时的消息条数（群用 messageCount，
 * 私聊用 conversationCount），未读 = 当前条数 − 已读位置，封顶 99。
 * 已读位置落 localStorage，重启不丢；某频道第一次出现（含首次加载没有任何记录）
 * 时把当前条数当作已读，避免一打开满屏红点。
 *
 * 不碰 React 与 DOM，供 use-workspace 与 node:test 共用。
 */

export const READ_MARKS_KEY = 'agentbot.readMarks';
/** 未读角标封顶：再多也只说「很多」 */
export const UNREAD_CAP = 99;

/** 频道 id → 已读到第几条 */
export type ReadMarks = Record<string, number>;

/** 只依赖两个方法的存储抽象，便于 node:test 与 localStorage 共用 */
export interface ReadMarksStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 读已读位置：没有 / 损坏 / 存储不可用都当空记录，绝不抛；非法条目丢掉 */
export function loadReadMarks(store: ReadMarksStore): ReadMarks {
  try {
    const raw = store.getItem(READ_MARKS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const marks: ReadMarks = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) marks[id] = Math.floor(value);
    }
    return marks;
  } catch {
    return {};
  }
}

/** 写已读位置：存不下就不存（隐私模式 / 配额），只在本次会话有效 */
export function saveReadMarks(store: ReadMarksStore, marks: ReadMarks): void {
  try {
    store.setItem(READ_MARKS_KEY, JSON.stringify(marks));
  } catch {
    // 界面偏好不值得打断用户
  }
}

export interface UnreadInput {
  /** 本轮拿到的各频道消息条数 */
  counts: Record<string, number>;
  /** 已有的已读位置 */
  marks: ReadMarks;
  /** 这些频道视为已读：当前正在看的，以及上次同步后刚离开的 */
  readThrough: Iterable<string>;
  /** counts 是否是全量（群与同事都拉到了）：是才清理已不存在频道的记录 */
  complete?: boolean;
}

export interface UnreadResult {
  /** 频道 id → 未读条数（0 不出现） */
  unread: Record<string, number>;
  /** 更新后的已读位置 */
  marks: ReadMarks;
  /** 已读位置是否变了（变了才需要落盘） */
  changed: boolean;
}

/**
 * 由条数与已读位置算未读：
 * - 没有记录的频道：当前条数即已读（首次加载 / 新出现的频道不闪红点）；
 * - 正在看 / 刚离开的频道：已读位置跟到当前条数；
 * - 条数变少（清空历史）：已读位置跟着降，不出负数；
 * - 其余：未读 = 条数 − 已读位置，封顶 99。
 */
export function reconcileUnread(input: UnreadInput): UnreadResult {
  const readThrough = new Set(input.readThrough);
  const marks: ReadMarks = { ...input.marks };
  const unread: Record<string, number> = {};
  let changed = false;
  for (const [id, count] of Object.entries(input.counts)) {
    const mark = marks[id];
    if (mark === undefined || readThrough.has(id) || count < mark) {
      if (mark !== count) {
        marks[id] = count;
        changed = true;
      }
      continue;
    }
    if (count > mark) unread[id] = Math.min(count - mark, UNREAD_CAP);
  }
  if (input.complete) {
    for (const id of Object.keys(marks)) {
      if (!(id in input.counts)) {
        delete marks[id];
        changed = true;
      }
    }
  }
  return { unread, marks, changed };
}

/** 两份未读表是否一样：一样就别触发重渲染 */
export function sameUnread(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}
