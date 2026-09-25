/**
 * 持久等待（E4.3，模型见 docs/架构设计.md §4.3 WorkWait、§7.2 等待用户）。
 *
 * 等待以前是内存里的 Promise：进程一退就丢，重启后没人记得「这件事还在等谁」。
 * 这里把等待落成一条记录：等谁、哪次请求、满足什么条件、到期时间。进入 waiting
 * 之后当前 Run 就结束（释放同事执行权），匹配的事件到达时再开一个新的 Run 接着做。
 *
 * 本文件只放类型与**纯判定**，不碰存储、不认识运行时。
 */

export type WorkWaitKind = 'user' | 'agent' | 'time' | 'external';

/** pending 是唯一非终态；其余三个都不可回退（迟到的回答只返回明确状态，不复活） */
export type WorkWaitStatus = 'pending' | 'resolved' | 'cancelled' | 'expired';

/**
 * 用户问题卡的展示数据（kind=user 才有）。
 * 只存「问什么、有哪些选项、密钥叫什么名字」；**密钥明文绝不在这里**——
 * 值在 SecretStore 里，等待只留引用（resultRef = secret:<name>）。
 */
export interface WorkWaitCard {
  question: string;
  detail?: string;
  /** 选项卡：id 可点，label 给人看 */
  options?: Array<{ id: string; label: string }>;
  /** 密钥框：写入 SecretStore 的变量名 */
  name?: string;
}

export interface WorkWait {
  id: string;
  /**
   * 归属工作。**可以没有**：用户问题卡允许在没有工作的闲聊回合里提问（旧行为），
   * 这时唤醒只开一个新回合、没有工作可写状态。
   */
  workId?: string;
  kind: WorkWaitKind;
  /**
   * 稳定关联键，说明「等谁 / 哪次请求」：
   *   user      → 交互卡 id（回答必须带这个 id 才算数）
   *   agent     → `agent:<同事 id>`（等这位同事的回信）
   *   time      → `time:<主题>`（到点唤醒）
   *   external  → 调用方给的业务键（外部事件按它匹配）
   */
  correlationId: string;
  /**
   * 「哪一次请求」的精确线程键（E4.4）：kind=agent 时就是那条委派的 id
   * （= 请求信的投递 id）。correlationId 只回答「等谁」，两位同事之间可能同时
   * 有多件事在等；threadId 让一封回信只满足对应的那一次。
   * 旧数据 / 没有线程的信缺省为空，唤醒时退回「唯一等待才认」。
   */
  threadId?: string;
  /** 业务到期时间：time 到点唤醒；user 卡到点明确过期（≠ 用户已回答） */
  dueAt?: number;
  status: WorkWaitStatus;
  /** 满足条件的引用：回答 id / 回信 id / secret:<name> / 外部回执；从不存密钥明文 */
  resultRef?: string;
  /** 归属同事：唤醒、按人列表、重启恢复都以它为准 */
  agentId: string;
  /** kind=user：重启后据此恢复待答卡 */
  card?: WorkWaitCard;
  /** 人看的一句话：在等什么 */
  condition?: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
}

export const TERMINAL_WAIT_STATUSES: WorkWaitStatus[] = ['resolved', 'cancelled', 'expired'];

export function isPendingWait(wait: WorkWait): boolean {
  return wait.status === 'pending';
}

export function isTerminalWait(wait: WorkWait): boolean {
  return TERMINAL_WAIT_STATUSES.includes(wait.status);
}

/**
 * 状态机：只有 pending 能走到某个终态，终态之间不可互转、不可回退。
 * 这就是「过期卡、已作废卡的迟到回答返回明确状态」的第一道闸。
 */
export function canTransitionWait(from: WorkWaitStatus, to: WorkWaitStatus): boolean {
  if (from !== 'pending') return false;
  return to === 'resolved' || to === 'cancelled' || to === 'expired';
}

/** 同事回信等待的关联键：等的是「这位同事」 */
export function agentWaitKey(peerAgentId: string): string {
  return `agent:${peerAgentId}`;
}

/**
 * 这条等待是不是在等这位同事（不看是哪一次请求）。
 * 精确唤醒先按 threadId 命中；没有线程键的旧信只有这一条时才算数。
 */
export function isAgentWaitForPeer(correlationId: string, peerAgentId: string): boolean {
  return correlationId === agentWaitKey(peerAgentId);
}

/** 定时等待的关联键 */
export function timeWaitKey(topic: string): string {
  return `time:${topic}`;
}

/** 到点了吗（time 的唤醒条件；user 卡的过期条件） */
export function isWaitDue(wait: WorkWait, now = Date.now()): boolean {
  return wait.dueAt !== undefined && wait.dueAt <= now;
}

/**
 * 该不该由「到点扫描」处理：
 *   time    → 到点即满足条件，正常唤醒（错过的重启后补上）
 *   user    → 到点只是明确过期，绝不当作已回答
 *   agent/external → 没有 business 期限，不由时间驱动
 */
export function dueActionOf(wait: WorkWait): 'wake' | 'expire' | 'none' {
  if (wait.kind === 'time') return 'wake';
  if (wait.kind === 'user') return 'expire';
  return 'none';
}

/** 用户回答的文本摘要（进对话，让模型接着做） */
export function answerSummary(wait: WorkWait, answer: { value?: string; secret?: string }): string {
  const question = wait.card?.question ?? wait.condition ?? '之前的问题';
  if (wait.card?.name) return `用户已提供密钥「${wait.card.name}」并保存（你看不到明文），接着做。`;
  const chosen = wait.card?.options?.find((option) => option.id === answer.value);
  return `用户回答了问题卡「${question}」：${chosen?.label ?? answer.value ?? '(空)'}。接着做。`;
}
