/**
 * 控制状态条的纯展示选择器（UI 设计规范 5.8 / §6，
 * 设计文档 docs/执行控制与可靠投递修复设计.md §13.2）。
 *
 * 智能体被停止后进入 paused，前端要能看见、能恢复；来信失败要能重试。
 * 状态条与顶栏文字共用同一套判定，避免两处说法不一致。
 */

export interface ControlNoticeInput {
  /** 许可状态：enabled = 正常自动处理；paused = 已暂停 */
  autoActivation: 'enabled' | 'paused';
  /** 因暂停被扣住的来信数（控制面 held） */
  held: number;
  /** 控制存储是否损坏 */
  faulted: boolean;
  /** 未处理来信（pending + claimed） */
  pendingMail: number;
  /** 处理失败的来信 */
  failedMail: number;
  /** 是否有一笔停止正在生效（chat state 里 kind=stop 的活动 run） */
  stopInFlight: boolean;
}

export type ControlNoticeKind = 'faulted' | 'stopping' | 'paused' | 'failed' | 'pending';
export type ControlAction = 'resume' | 'retry' | 'repair';

export interface ControlNoticeState {
  kind: ControlNoticeKind;
  /** 一句话说明现在是什么状态 */
  detail: string;
  /** 可点的操作；空数组 = 只告知不打扰 */
  actions: ControlAction[];
}

/**
 * 状态条判定。优先级从高到低：
 *   存储损坏 > 停止中 > 已暂停 > 有失败来信 > 有来信积压。
 * 存储损坏时只给「修复控制数据」这一个出口（OPT-06）：损坏文件会先被改名备份，
 * 再以空状态重建，所有同事置为已暂停，需要逐个核对。
 */
export function controlNoticeState(input: ControlNoticeInput): ControlNoticeState | null {
  const waiting = Math.max(input.held, input.pendingMail);
  if (input.faulted) {
    return {
      kind: 'faulted',
      detail: '控制数据损坏，已进入保护模式：修好之前不写、不自动执行。',
      actions: ['repair'],
    };
  }
  if (input.stopInFlight) {
    return {
      kind: 'stopping',
      detail: '正在停止：已暂停后续自动处理，手上的操作还在结束中。',
      actions: [],
    };
  }
  if (input.autoActivation === 'paused') {
    const actions: ControlAction[] = ['resume'];
    if (input.failedMail > 0) actions.push('retry');
    const waitingText = waiting > 0 ? `，${waiting} 封来信待处理` : '';
    return {
      kind: 'paused',
      detail: `已暂停自动处理${waitingText}。`,
      actions,
    };
  }
  if (input.failedMail > 0) {
    return {
      kind: 'failed',
      detail: `有 ${input.failedMail} 封来信处理失败，需要重试。`,
      actions: ['retry'],
    };
  }
  if (input.pendingMail > 0) {
    return {
      kind: 'pending',
      detail: `${input.pendingMail} 封来信待处理。`,
      actions: [],
    };
  }
  return null;
}

export interface ControlStatusText {
  text: string;
  kind: ControlNoticeKind;
}

/** 顶栏状态文字：与状态条同一优先级，不各说各话 */
export function controlStatusText(input: ControlNoticeInput): ControlStatusText | null {
  const state = controlNoticeState(input);
  if (!state) return null;
  const text = {
    faulted: '控制存储损坏',
    stopping: '正在停止',
    paused: '已暂停',
    failed: '有来信失败',
    pending: '有来信待处理',
  }[state.kind];
  return { text, kind: state.kind };
}

/** 修复控制数据的结果反馈（Toast）：说清「修好了」和「接下来要核对什么」 */
export function repairOutcomeMessage(ok: boolean, pausedAgents = 0): string {
  return ok
    ? `控制数据已修复，${pausedAgents} 位同事已置为「已暂停」：核对无误后再逐个恢复自动处理`
    : '修复失败：控制数据仍不可用。请先备份数据目录再重试';
}

/** 恢复自动处理的结果反馈（Toast） */
export function resumeOutcomeMessage(ok: boolean): string {
  return ok ? '已恢复自动处理' : '恢复没成功，请稍后再试';
}

/** 重试失败来信的结果反馈（Toast）；成功时带上实际重试的条数 */
export function retryOutcomeMessage(ok: boolean, retried: number): string {
  if (!ok) return '重试没成功，请稍后再试';
  if (retried <= 0) return '没有需要重试的来信';
  return `已重新投递 ${retried} 封来信`;
}
