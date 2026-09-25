/**
 * 「工作」面板（E4.7）的纯展示逻辑：状态用词、排序、每一栏读哪个字段。
 *
 * 组件里不写状态映射的 if 链——后端给什么状态就显示什么（状态即事实），
 * 判定与取词都放这里，node:test 直接覆盖。
 * 只 `import type` 后端领域模型，不引入后端运行模块（跨层检查 R2）。
 */
import type { WorkItem, WorkStatus, WorkStep, WorkStepStatus } from '../../../../src/work/item.js';

/** 状态用词与后端枚举一一对应，不发明「差不多完成了」这类中间态 */
export const WORK_STATUS_LABEL: Record<WorkStatus, string> = {
  ready: '待开始',
  active: '进行中',
  waiting: '等待中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  failed: '已失败',
};

/** 列表排序优先级：手头在做的排最前，等待中紧随（要么等人要么等事），终态沉底 */
const STATUS_PRIORITY: Record<WorkStatus, number> = {
  active: 0,
  waiting: 1,
  ready: 2,
  paused: 3,
  failed: 4,
  cancelled: 5,
  completed: 6,
};

/** 还在进行中的状态（与后端 isOpenWork 同一套语义；前端不导入后端运行模块，这里重列一次） */
const OPEN_STATUSES: WorkStatus[] = ['ready', 'active', 'waiting', 'paused'];

export function isOpenWorkStatus(status: WorkStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

/** 面板排序：未完成的在前，各自按最近更新倒序；原数组不动 */
export function sortWorksForPanel(items: WorkItem[]): WorkItem[] {
  return [...items].sort((left, right) => {
    const byStatus = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
    if (byStatus !== 0) return byStatus;
    return right.updatedAt - left.updatedAt;
  });
}

/**
 * 「在等什么」。
 *
 * 后端没有「按工作读等待」的接口，但 E4.3 进 waiting 时会把 WorkWait.condition
 * 写进工作的 nextAction（runtime.markWorkWaiting），所以这一栏读 nextAction；
 * 老数据没写 condition 时退到 progressSummary——宁可显示得糙一点，也不编一个等待对象。
 */
export function waitingTargetOf(work: WorkItem): string | undefined {
  if (work.status !== 'waiting') return undefined;
  const next = work.nextAction?.trim();
  if (next) return next;
  const progress = work.progressSummary?.trim();
  return progress || undefined;
}

/** 「下一步」：只有非等待态才把它当下一步——等待中那句话已经被上面当成「在等什么」了 */
export function nextActionOf(work: WorkItem): string | undefined {
  if (work.status === 'waiting') return undefined;
  const next = work.nextAction?.trim();
  return next || undefined;
}

/** 「进展」：后端没写进展时如实说没有，不拿目标凑数 */
export function progressTextOf(work: WorkItem): string {
  const progress = work.progressSummary?.trim();
  return progress || '还没有进展记录';
}

/**
 * 「目标」：标题就是原话第一句，短消息里 objective 与 title 完全一样。
 * 一样就不再重复显示一行（卡片上那行标题就是目标）；只有多说了什么才单独列出来。
 */
export function objectiveOf(work: WorkItem): string | undefined {
  const objective = work.objective?.trim();
  if (!objective) return undefined;
  return objective === work.title.trim() ? undefined : objective;
}

/** 「交付物」：交付物引用（artifactIds）。后端目前由收尾兜底写入，空就是空 */
export function deliverableRefs(work: WorkItem): string[] {
  return work.artifactIds.filter((id) => id.trim().length > 0);
}

/** 交付物引用的短标签：完整 id 挂在 title 上，列表里只露前 8 位 */
export function deliverableRefLabel(ref: string): string {
  return ref.length > 8 ? ref.slice(0, 8) : ref;
}

export const STEP_STATUS_LABEL: Record<WorkStepStatus, string> = {
  pending: '未开始',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消',
};

/** 步骤进度：已完成 / 总数，另有几步在跑 */
export function stepProgressOf(steps: WorkStep[]): { total: number; completed: number; running: number } {
  return {
    total: steps.length,
    completed: steps.filter((step) => step.status === 'completed').length,
    running: steps.filter((step) => step.status === 'in_progress').length,
  };
}

export type WorkFilter = 'all' | 'active' | 'waiting' | 'finished';

/** 筛选 chip：与后端 ?status= 的语义分开——这里在已取回的列表上筛，切 chip 不再发请求 */
export const WORK_FILTERS: WorkFilter[] = ['all', 'active', 'waiting', 'finished'];

export function matchesWorkFilter(work: WorkItem, filter: WorkFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return work.status === 'active';
  if (filter === 'waiting') return work.status === 'waiting';
  return !isOpenWorkStatus(work.status);
}

export function filterWorks(items: WorkItem[], filter: WorkFilter): WorkItem[] {
  return items.filter((work) => matchesWorkFilter(work, filter));
}

/** 各筛选下的条数，chip 上直接显示 */
export function countWorks(items: WorkItem[]): Record<WorkFilter, number> {
  return {
    all: items.length,
    active: items.filter((work) => work.status === 'active').length,
    waiting: items.filter((work) => work.status === 'waiting').length,
    finished: items.filter((work) => !isOpenWorkStatus(work.status)).length,
  };
}

/**
 * 面板标题下的一句话：说清「手头几件在办」。
 * 没有工作时给空态文案（组件据此显示，不在组件里再拼一遍）。
 */
export function workSummaryLine(items: WorkItem[]): string {
  if (items.length === 0) return '还没有工作记录';
  const counts = countWorks(items);
  const idle = items.filter((work) => work.status === 'ready' || work.status === 'paused').length;
  const parts: string[] = [];
  if (counts.active > 0) parts.push(`${counts.active} 件进行中`);
  if (counts.waiting > 0) parts.push(`${counts.waiting} 件等待中`);
  if (idle > 0) parts.push(`${idle} 件未开工或已暂停`);
  if (counts.finished > 0) parts.push(`${counts.finished} 件已结束`);
  return parts.join(' · ');
}