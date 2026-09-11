import type { MentionResult } from './mentions.js';

/**
 * 一轮群回合里的「召唤队列」。
 *
 * 对应《群聊与智能体交互.md》第 4.1 节：
 * 群里 `@名字` 是把话题甩给同事的公开交互 —— 不只是用户能 @，
 * 成员在自己发言里 @ 别人，也应该把那个人叫起来。
 *
 * 同时负责防环：
 *   - 同一个成员在一轮 roundId 内最多跑 maxRunsPerMember 次
 *   - 已经在队列里等待的不重复入队
 */
export class SummonQueue {
  /** agentId → 已跑次数 */
  private readonly runs = new Map<string, number>();
  /** agentId → 累积的召唤信号（决定它是否「必须开口」） */
  private readonly summons = new Map<string, MentionResult>();
  /** 等待再跑一轮的成员，保持入队顺序 */
  private readonly waiting: string[] = [];
  private readonly enqueued = new Set<string>();

  constructor(
    private readonly memberIds: string[],
    initial: MentionResult,
    private readonly maxRunsPerMember: number,
  ) {
    for (const id of memberIds) {
      if (initial.everyone || initial.ids.includes(id)) {
        this.summons.set(id, { ids: initial.ids, everyone: initial.everyone });
      }
    }
  }

  /** 第一波：被用户点名的人（串行跑，后者能看到前者发言） */
  initiallySummoned(): string[] {
    return this.memberIds.filter((id) => this.summons.has(id));
  }

  /**
   * 第二波：在场但没被点名的成员（可并行，互相看不见）。
   *
   * 排除三类人：
   *   summons 里有名字的 —— 他们被点名了，要留在串行波次里保证顺序语义
   *   runs 里有记录的   —— 已经跑过
   *   enqueued 里的     —— 已经排队等着跑
   */
  bystanders(): string[] {
    return this.memberIds.filter(
      (id) => !this.summons.has(id) && !this.runs.has(id) && !this.enqueued.has(id),
    );
  }

  /** 该成员此刻的召唤状态；没被召唤过则是空信号 */
  mentionsFor(agentId: string): MentionResult {
    return this.summons.get(agentId) ?? { ids: [], everyone: false };
  }

  /** 它是否必须开口 */
  isSummoned(agentId: string): boolean {
    const mention = this.summons.get(agentId);
    if (!mention) return false;
    return mention.everyone || mention.ids.includes(agentId);
  }

  canRun(agentId: string): boolean {
    return (this.runs.get(agentId) ?? 0) < this.maxRunsPerMember;
  }

  runCount(agentId: string): number {
    return this.runs.get(agentId) ?? 0;
  }

  /**
   * 占用一次运行名额，返回这是第几次（从 1 开始）。
   *
   * 必须在回合真正开始前**同步**调用：并行派发时，
   * 所有同波次成员都要先被登记，否则同波次的人互相 @ 会漏掉二次叫醒。
   */
  reserve(agentId: string): number {
    const next = (this.runs.get(agentId) ?? 0) + 1;
    this.runs.set(agentId, next);
    this.enqueued.delete(agentId);
    return next;
  }

  /**
   * 某人的发言里 @ 了人 —— 把被点到且还能跑的叫起来。
   * 返回真正入队的成员 id，便于日志与测试。
   */
  summonFrom(mentions: MentionResult, speakerId?: string): string[] {
    // 发言者不需要被自己叫醒（`@everyone` 是叫别人看，不含自己）
    const targets = (mentions.everyone ? this.memberIds : mentions.ids).filter(
      (id) => id !== speakerId,
    );
    const queued: string[] = [];

    for (const id of targets) {
      if (!this.memberIds.includes(id)) continue;
      if (!this.canRun(id)) continue;

      // 记下召唤信号（并集），它下次跑时就是「必须开口」
      const previous = this.summons.get(id);
      this.summons.set(id, {
        ids: [...new Set([...(previous?.ids ?? []), ...mentions.ids])],
        everyone: mentions.everyone || (previous?.everyone ?? false),
      });

      // 已经跑过的人照样能再入队（那正是「同事发言二次叫醒」），只防重复入队
      if (this.enqueued.has(id)) continue;
      this.waiting.push(id);
      this.enqueued.add(id);
      queued.push(id);
    }

    return queued;
  }

  /** 取出下一个待跑的成员（第三波及以后） */
  next(): string | undefined {
    const id = this.waiting.shift();
    if (id) this.enqueued.delete(id);
    return id;
  }

  get hasWaiting(): boolean {
    return this.waiting.length > 0;
  }

  /** 已跑过的成员 id（用于统计与结束事件） */
  get ranIds(): string[] {
    return [...this.runs.keys()];
  }
}
