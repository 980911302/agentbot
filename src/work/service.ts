import { randomUUID } from 'node:crypto';
import type { WorkRepositoryPort } from '../storage/ports.js';
import {
  clarificationQuestion,
  classifyUserMessage,
  isOpenWork,
  isTerminalWork,
  linkUserMessage,
  pickOpenWork,
  titleFrom,
  type WorkCandidate,
  type WorkItem,
  type WorkOriginChannel,
  type WorkRelation,
  type WorkStep,
  type WorkStatus,
} from './item.js';

/**
 * 工作服务（E4.1）：唯一的状态转换入口。
 *
 * 职责边界（与 §4.2 对齐）：
 *   - 判定「这条消息是不是托付一件事」（闲聊只建 Run，不建工作）；
 *   - 是的话**优先接到该同事已有的未完成工作**——这就是「隔天继续同一工作能接上目标与进度」；
 *   - 状态由服务层校验：完成必须有交付说明或产物引用，且没有未解决的等待。
 * 不碰 HTTP、不认识运行时；存储经 WorkRepositoryPort。
 */

export class WorkError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'WorkError';
  }
}

export interface AcceptInput {
  agentId: string;
  channel: WorkOriginChannel;
  messageId: string;
  text: string;
  /** 注入时钟，便于测试「隔天继续」 */
  now?: number;
}

export interface AcceptResult {
  work: WorkItem;
  /** new = 新建；continued = 接到已有工作（含修订） */
  kind: 'new' | 'continued';
  /** 这一句与工作的关系（E4.2）：continue / revise / new_work */
  relation: WorkRelation;
  /** 修订时被改掉的原目标（写进日志便于复盘） */
  revisedFrom?: string;
}

/** 含糊：不猜，也不改动任何工作；由调用方在回合里短问用户（E4.2） */
export interface ClarifyResult {
  kind: 'clarify';
  relation: 'ambiguous';
  candidates: WorkCandidate[];
  /** 给模型的建议问句（进 brief） */
  question: string;
}

export interface WorkServiceDeps {
  repository: WorkRepositoryPort;
}

export class WorkService {
  constructor(private readonly deps: WorkServiceDeps) {}

  private now(input?: number): number {
    return input ?? Date.now();
  }

  /**
   * 受理一条用户消息：是工作就建或续，是闲聊就返回 null。
   * 绝不抛「不是工作」的错——闲聊是正常情况。
   */
  async acceptUserMessage(input: AcceptInput): Promise<AcceptResult | ClarifyResult | null> {
    const at = this.now(input.now);
    const title = titleFrom(input.text);
    const openWorks = (await this.deps.repository.listByAgent(input.agentId)).filter((item) =>
      isOpenWork(item.status),
    );
    const decision = linkUserMessage(input.text, openWorks);

    if (decision.relation === 'chat') return null;
    if (decision.relation === 'ambiguous') {
      // 不瞎猜：不改动任何工作，把候选交给调用方在回合里短问（设计 §5 第 5 条）
      return {
        kind: 'clarify',
        relation: 'ambiguous',
        candidates: decision.candidates ?? [],
        question: clarificationQuestion(decision.candidates ?? [], input.text),
      };
    }

    if (decision.relation === 'new_work') {
      const work: WorkItem = {
        id: randomUUID(),
        ownerAgentId: input.agentId,
        originMessageId: input.messageId,
        originChannel: input.channel,
        title,
        objective: input.text.trim(),
        acceptance: [],
        status: 'active',
        progressSummary: '刚接下，尚未开工',
        revision: 1,
        artifactIds: [],
        createdAt: at,
        updatedAt: at,
      };
      await this.deps.repository.save(work);
      return { work, kind: 'new', relation: 'new_work' };
    }

    // continue / revise 都要有一件明确的工作可接
    const target = decision.workId
      ? openWorks.find((item) => item.id === decision.workId)
      : pickOpenWork(openWorks);
    if (!target) throw new WorkError('找不到要接的工作（可能刚被收尾）', 'WORK_NOT_FOUND');

    if (decision.relation === 'revise') {
      // 修订：目标被改写、版本 +1，原目标留在 revisedFrom 便于复盘（设计 §5「修订」段）
      const revised: WorkItem = {
        ...target,
        status: target.status === 'ready' ? 'active' : target.status,
        objective: input.text.trim(),
        progressSummary: `范围改为：${title}`,
        nextAction: title,
        revision: target.revision + 1,
        updatedAt: at,
      };
      const ok = await this.deps.repository.update(revised, target.revision);
      if (!ok) throw new WorkError('工作已被其他执行改动，请重新读取后再更新', 'WORK_REVISION_CONFLICT');
      await this.appendStep({
        workId: target.id,
        title,
        status: 'in_progress',
        note: `修订目标（原：${target.objective}）`,
        now: at,
      });
      return { work: revised, kind: 'continued', relation: 'revise', revisedFrom: target.objective };
    }

    // continue：目标不变，把这次的要求作为新的下一步与进展（E4.1 行为）
    const updated: WorkItem = {
      ...target,
      status: target.status === 'ready' ? 'active' : target.status,
      progressSummary: title,
      nextAction: title,
      revision: target.revision + 1,
      updatedAt: at,
    };
    const ok = await this.deps.repository.update(updated, target.revision);
    if (!ok) throw new WorkError('工作已被其他执行改动，请重新读取后再更新', 'WORK_REVISION_CONFLICT');
    await this.appendStep({
      workId: target.id,
      title,
      status: 'in_progress',
      note: '用户补充了新要求',
      now: at,
    });
    return { work: updated, kind: 'continued', relation: 'continue' };
  }

  /** 该同事当前「手头那件」未完成的工作（最近更新的优先） */
  async openWorkOf(agentId: string): Promise<WorkItem | undefined> {
    return pickOpenWork(await this.deps.repository.listByAgent(agentId));
  }

  /**
   * 收件方为一条**委派**开的工作（E4.4）：委派自带明确范围，所以不走
   * 「接到已有工作」的判定——那会把同事的独立工作接过来，停止委派时就会连坐。
   * 判为闲聊（纯问候/短应答）则不建工作，childWorkId 留空。
   */
  async acceptDelegation(input: {
    agentId: string;
    fromAgentId: string;
    messageId: string;
    text: string;
    now?: number;
  }): Promise<WorkItem | null> {
    if (classifyUserMessage(input.text) !== 'work') return null;
    const at = this.now(input.now);
    const work: WorkItem = {
      id: randomUUID(),
      ownerAgentId: input.agentId,
      originMessageId: input.messageId,
      originChannel: { kind: 'dm', id: input.fromAgentId },
      title: titleFrom(input.text),
      objective: input.text.trim(),
      acceptance: [],
      status: 'active',
      progressSummary: '接下了同事派来的活，尚未开工',
      revision: 1,
      artifactIds: [],
      createdAt: at,
      updatedAt: at,
    };
    await this.deps.repository.save(work);
    return work;
  }

  async get(workId: string): Promise<WorkItem | undefined> {
    return this.deps.repository.get(workId);
  }

  async list(agentId: string, status?: WorkStatus): Promise<WorkItem[]> {
    const items = await this.deps.repository.listByAgent(agentId);
    return status ? items.filter((item) => item.status === status) : items;
  }

  async listSteps(workId: string): Promise<WorkStep[]> {
    return this.deps.repository.listSteps(workId);
  }

  /** 追加/更新一步（TodoWrite 接入这里） */
  async appendStep(input: {
    workId: string;
    id?: string;
    title: string;
    status: WorkStep['status'];
    note?: string;
    runId?: string;
    now?: number;
  }): Promise<WorkStep> {
    const work = await this.deps.repository.get(input.workId);
    if (!work) throw new WorkError(`找不到工作 ${input.workId}`, 'WORK_NOT_FOUND');
    const at = this.now(input.now);
    const step: WorkStep = {
      id: input.id ?? randomUUID(),
      workId: input.workId,
      title: input.title,
      status: input.status,
      ...(input.note ? { note: input.note } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      createdAt: at,
      updatedAt: at,
    };
    await this.deps.repository.appendStep(step);
    return step;
  }

  /**
   * 改工作本身。只改传入字段；进度/下一步/状态都能改，但**终态不允许回退**
   * （要重开就显式改状态并说明，走同一个入口）。
   */
  async update(
    workId: string,
    patch: Partial<
      Pick<WorkItem, 'status' | 'progressSummary' | 'nextAction' | 'acceptance' | 'artifactIds'>
    >,
    options: { expectedRevision?: number; now?: number } = {},
  ): Promise<WorkItem> {
    const current = await this.deps.repository.get(workId);
    if (!current) throw new WorkError(`找不到工作 ${workId}`, 'WORK_NOT_FOUND');
    if (isTerminalWork(current.status) && patch.status && isOpenWork(patch.status)) {
      throw new WorkError(
        `工作已经是 ${current.status}，要重开请显式说明原因（这是状态即事实，不静默复活）`,
        'WORK_ALREADY_CLOSED',
      );
    }
    const updated: WorkItem = {
      ...current,
      ...patch,
      revision: current.revision + 1,
      updatedAt: this.now(options.now),
    };
    const ok = await this.deps.repository.update(updated, options.expectedRevision ?? current.revision);
    if (!ok) throw new WorkError('工作已被其他执行改动，请重新读取后再更新', 'WORK_REVISION_CONFLICT');
    return updated;
  }

  /**
   * 收尾。架构「完成要求」：有交付说明或结果引用，且没有尚未解决的必要等待。
   * waiting / paused 状态下不允许直接完成——先把等待处理掉。
   */
  async complete(
    workId: string,
    input: { summary: string; artifactIds?: string[]; now?: number },
  ): Promise<WorkItem> {
    const current = await this.deps.repository.get(workId);
    if (!current) throw new WorkError(`找不到工作 ${workId}`, 'WORK_NOT_FOUND');
    if (isTerminalWork(current.status)) {
      throw new WorkError(`工作已经结束（${current.status}），不能重复完成`, 'WORK_ALREADY_CLOSED');
    }
    if (current.status === 'waiting' || current.status === 'paused') {
      throw new WorkError(`工作处于 ${current.status}：先把等待/暂停处理掉再收尾`, 'WORK_HAS_OPEN_WAIT');
    }
    const summary = input.summary.trim();
    const artifactIds = input.artifactIds ?? [];
    if (!summary && artifactIds.length === 0) {
      throw new WorkError(
        '收尾需要交付说明，或至少一个产物引用（不能只凭模型一句话算完成）',
        'WORK_EVIDENCE_REQUIRED',
      );
    }
    const at = this.now(input.now);
    const updated: WorkItem = {
      ...current,
      status: 'completed',
      progressSummary: summary || current.progressSummary,
      artifactIds: [...new Set([...current.artifactIds, ...artifactIds])],
      revision: current.revision + 1,
      updatedAt: at,
      completedAt: at,
    };
    const ok = await this.deps.repository.update(updated, current.revision);
    if (!ok) throw new WorkError('工作已被其他执行改动，请重新读取后再更新', 'WORK_REVISION_CONFLICT');
    return updated;
  }

  /** 取消/失败：也要说明原因（写进 progressSummary，界面直接展示） */
  async close(
    workId: string,
    status: 'cancelled' | 'failed',
    reason: string,
    now?: number,
  ): Promise<WorkItem> {
    const current = await this.deps.repository.get(workId);
    if (!current) throw new WorkError(`找不到工作 ${workId}`, 'WORK_NOT_FOUND');
    if (isTerminalWork(current.status)) {
      throw new WorkError(`工作已经结束（${current.status}）`, 'WORK_ALREADY_CLOSED');
    }
    const updated: WorkItem = {
      ...current,
      status,
      progressSummary: reason.trim() || current.progressSummary,
      revision: current.revision + 1,
      updatedAt: this.now(now),
      completedAt: this.now(now),
    };
    const ok = await this.deps.repository.update(updated, current.revision);
    if (!ok) throw new WorkError('工作已被其他执行改动，请重新读取后再更新', 'WORK_REVISION_CONFLICT');
    return updated;
  }
}
