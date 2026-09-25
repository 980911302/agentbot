import { isTerminalWork } from '../../work/item.js';
import { isAgentWaitForPeer, type WorkWait } from '../../work/wait.js';
import { isOpenDelegation } from '../../work/delegation.js';
import type { AgentRegistry } from '../../agent/registry.js';
import type { WorkService } from '../../work/service.js';
import type { WaitService } from '../../work/wait-service.js';
import type { DelegationService } from '../../work/delegation-service.js';

/**
 * 委派与同事回信的等待闭环（OPT-03 从 runtime.ts 搬出，E4.4）。
 *
 * 一封回信只满足「哪一次请求」——有线程键按线程精确命中，没有时只在唯一等待上认；
 * 收到派来的活则为它开一件专属工作并回填 childWorkId。等待本身的状态转换仍在
 * wait-coordinator，这里只借用它的 releaseWorkIfSettled。
 */
export function createDelegationWaitBridge(deps: {
  waits: WaitService;
  works: WorkService;
  delegations: DelegationService;
  registry: AgentRegistry;
  releaseWorkIfSettled: (workId: string | undefined) => Promise<void>;
}) {
  const { waits, works, delegations, registry, releaseWorkIfSettled } = deps;

  /**
   * 同事回信唤醒（E4.4）：先按**线程键**精确命中「哪一次请求」，一封回信只满足
   * 对应的那一次等待；信里没有线程键（旧数据/直接 enqueue）时才退回旧行为——
   * 等这位同事的等待**只有一条**才算数，多条就不猜。信被确认处理后 resolve 并唤醒工作。
   */
  async function resolveAgentWaitsForReply(
    agentId: string,
    peerAgentId: string,
    resultRef: string,
    threadId?: string,
  ): Promise<void> {
    for (const wait of await selectReplyWaits(agentId, peerAgentId, threadId)) {
      const outcome = await waits.resolve(wait.id, resultRef);
      if (outcome.ok) await releaseWorkIfSettled(wait.workId);
    }
    // 委派闭环：只有**反方向**（我派出去、对方回给我）的那条线程才算回信；
// 对方收下请求信的 ack 会带着同一个线程键回来，那不是回信，不能把委派提前闭环。
    // 这封信的发送方是 peer、收件方是我——问的是「peer 在回我派出去的活吗」。
    if (threadId) {
      const replyThread = await delegations.resolveReplyThread({
        callerId: peerAgentId,
        targetId: agentId,
        threadId,
      });
      if (replyThread) await delegations.markReplied(replyThread.id).catch(() => undefined);
    }
  }

  /** 一封同事回信该满足哪些等待：有线程键按线程精确匹配，没有时只在唯一等待上认 */
  async function selectReplyWaits(
    agentId: string,
    peerAgentId: string,
    threadId?: string,
  ): Promise<WorkWait[]> {
    const forPeer = (await waits.listPending({ agentId, kind: 'agent' })).filter((wait) =>
      isAgentWaitForPeer(wait.correlationId, peerAgentId),
    );
    if (threadId) return forPeer.filter((wait) => wait.threadId === threadId);
    return forPeer.length === 1 ? forPeer : [];
  }

  /**
   * 这封信是不是「等这位同事」这件事的唤醒事件（E4.3/E4.4）。
   * 是就把等待归属的工作写进本轮 brief：来信那一轮本身就是唤醒后的新 Run，
   * 只是它由收件箱驱动而没有 workLink——这里补上工作身份，模型才知道在接着做什么。
   */
  async function workBriefForPeerReply(
    agentId: string,
    peerAgentId: string,
    threadId?: string,
  ): Promise<string | undefined> {
    const pending = (await selectReplyWaits(agentId, peerAgentId, threadId)).filter(
      (wait) => wait.workId,
    );
    const workId = pending[0]?.workId;
    if (!workId) return undefined;
    const work = await works.get(workId);
    if (!work || isTerminalWork(work.status)) return undefined;
    const peerName = (await registry.get(peerAgentId))?.name ?? peerAgentId;
    return [
      `【当前工作】${work.title}（id=${work.id}，revision=${work.revision}）`,
      `目标：${work.objective}`,
      `你在等「${peerName}」的回信，这封信就是那个等待被满足的事件：这是**接着当前工作**的继续，不是一件新事。`,
      '收尾时如实说明交付了什么；不要只凭一句话就把工作说成完成。',
    ].join('\n');
  }

  /**
   * 收件方接下一条委派（E4.4）：为它开一件**专属工作**并把 childWorkId 回填到委派。
   * 专属：不走「接到已有工作」的判定，否则停止这条委派会连坐同事的独立工作。
   * 判为闲聊则不建工作（childWorkId 留空），委派照常收下。
   * 幂等：信被退回重投时复用已开的子工作，不为同一件委派开第二件；
   * 已取消/已回信的委派也不再开工作（停止令先到就到此为止）。
   */
  async function acceptDelegationLetter(
    agentId: string,
    letter: { id: string; fromAgentId: string; text: string; correlationId?: string },
  ): Promise<string | undefined> {
    if (!letter.correlationId) return undefined;
    const delegation = await delegations.get(letter.correlationId);
    if (!delegation || delegation.toAgentId !== agentId) return undefined;
    if (delegation.childWorkId) {
      const existing = await works.get(delegation.childWorkId);
      return existing ? delegationWorkBrief(existing) : undefined;
    }
    if (!isOpenDelegation(delegation)) return undefined;
    await delegations.markAccepted(delegation.id).catch(() => undefined);
    const work = await works.acceptDelegation({
      agentId,
      fromAgentId: delegation.fromAgentId,
      messageId: letter.id,
      text: letter.text,
    });
    if (!work) return undefined;
    await delegations.attachChildWork(delegation.id, work.id).catch((error) => {
      console.warn(`委派子工作未回填：${messageOf(error)}`);
    });
    return delegationWorkBrief(work);
  }

  /** 委派专属工作的身份，进本轮 brief：让模型知道只做这一件 */
  function delegationWorkBrief(work: { id: string; title: string; objective: string; revision: number }): string {
    return [
      `【当前工作】${work.title}（id=${work.id}，revision=${work.revision}）`,
      `目标：${work.objective}`,
      '这是同事派来的活，已记为一件独立工作；只做这一件，别把别的活也算进来。',
    ].join('\n');
  }

  return { resolveAgentWaitsForReply, workBriefForPeerReply, acceptDelegationLetter };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
