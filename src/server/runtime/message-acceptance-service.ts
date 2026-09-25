import { randomUUID } from 'node:crypto';
import type { AgentRegistry } from '../../agent/registry.js';
import type { MessageStore } from '../../store/messages.js';
import type { ReceivedStore } from '../../storage/received-store.js';
import type { TaskProgressStore } from '../../storage/task-progress.js';
import type { WorkService, AcceptResult, ClarifyResult } from '../../work/service.js';
import type { RunLedger } from '../../storage/run-ledger.js';
import type { RuntimeControlStore } from '../../storage/runtime-control-store.js';
import type { StopCoordinator } from './stop-coordinator.js';
import type { ActivationCoordinator } from './activation-coordinator.js';
import type { ChatRunCoordinator } from './chat-run-coordinator.js';
import type { RunExecutor } from './run-executor.js';
import type { EventJournal } from '../events/journal.js';
import type { RuntimeHost } from './host.js';
import type { AcceptedRun, SendOptions, SendResult, TurnResult } from './types.js';
import { isActiveChatRun } from '../../shared/contracts/chat-state.js';
import { isTerminalWork } from '../../work/item.js';
import type { AgentEventHandler, Message } from '../../agent/types.js';

/** 受理一条消息后拿到的工作关联结果（E4.1/E4.2）；闲聊为 null */
type WorkLinkOutcome = AcceptResult | ClarifyResult;

/**
 * 消息受理与回合派发（OPT-03 从 runtime.ts 搬出，E3.2/E3.4/E4.1/E4.2/E4.6）。
 *
 * 先持久接收再执行：去重 → 落消息、写事件日志 → 回执；execute 由调用方决定何时跑
 * （HTTP 立刻回 202，回合在后台继续）。含工作关联（进 brief 与收尾写回）与重复提交重放。
 *
 * 注意：这里**逐字**保留原实现，包括 E4.6「先关联工作再 append」的顺序——工作关联
 * 要随消息一起落盘，模型以后在历史里才知道这句话属于哪件工作。
 */
export function createMessageAcceptance(
  options: { waitUserTimeoutMs?: number },
  host: RuntimeHost,
  deps: {
    chatRuns: ChatRunCoordinator;
    receivedStore: ReceivedStore;
    messages: MessageStore;
    registry: AgentRegistry;
    taskProgress: TaskProgressStore;
    stopCoordinator: StopCoordinator;
    control: RuntimeControlStore;
    activation: ActivationCoordinator;
    works: WorkService;
    executor: RunExecutor;
    events: EventJournal;
    /** 在飞回合：与门面共用同一个 Map 实例，重复受理时复用同一次执行 */
    runExecutions: Map<string, Promise<SendResult>>;
    /** 作废未回答的持久问题卡（实现留在 wait-coordinator） */
    voidPendingUserWaits: (agentId: string, emit?: (event: { type: 'interaction_closed'; id: string; answered: boolean }) => void) => Promise<void>;
  },
) {
  const OWNER_ID = 'owner';
  const { chatRuns, receivedStore, messages, registry, taskProgress, stopCoordinator, control, activation, works, executor, events, runExecutions, voidPendingUserWaits } = deps;

  /**
   * 先持久接收：去重 → 落消息、写事件日志 → 回执。
   * 返回的 execute 由调用方决定何时执行：HTTP 立刻回 202，回合在后台继续跑，
   * 事件全部走 EventJournal（断线只断订阅）。
   */
  async function acceptMessage(
    agentId: string,
    text: string,
    options: SendOptions = {},
  ): Promise<AcceptedRun<SendResult>> {
    return chatRuns.accept(`dm:${agentId}:${options.clientMessageId ?? randomUUID()}`, () =>
      acceptMessageInner(agentId, text, options),
    );
  }

  async function acceptMessageInner(
    agentId: string,
    text: string,
    options: SendOptions,
  ): Promise<AcceptedRun<SendResult>> {
    const clientMessageId = options.clientMessageId;

    if (clientMessageId) {
      const existing = receivedStore.find(clientMessageId);
      if (existing && existing.agentId === agentId) {
        const original = (await messages.list(agentId)).find(
          (message) => message.id === existing.messageId,
        );
        if (original) {
          // E3.2：重复提交返回原消息，不开新回合
          return {
            receipt: {
              messageId: original.id,
              agentId,
              receiptSeq: events.latestSeq,
              duplicate: true,
            },
            execute: () => duplicateRun(agentId, original, options),
          };
        }
      }
    }

    if (!(await registry.get(agentId))) throw new Error(`Unknown agent: ${agentId}`);

    // 用户新句作废还没回答的选项卡——不当答案（§2）
    let resumeTaskId = options.resumeTaskId;
    if (
      !resumeTaskId &&
      /^(继续|继续上个任务|继续刚才的任务|接着做|恢复上个任务)[。！!]?$/u.test(text.trim())
    ) {
      const latest = taskProgress.list(agentId)[0];
      if (latest && ['incomplete', 'failed', 'interrupted', 'cancelled', 'parked'].includes(latest.status))
        resumeTaskId = latest.id;
    }
    const previous = clientMessageId
      ? chatRuns
          .list()
          .find((run) => run.channelId === agentId && run.clientMessageId === clientMessageId)
      : undefined;
    if (resumeTaskId && !previous) {
      const checkpoint = taskProgress.get(resumeTaskId, agentId);
      if (!checkpoint || checkpoint.scope !== 'dm' || checkpoint.status === 'running')
        throw new Error('找不到当前智能体已停止的任务进度');
    }
    const stop = stopCoordinator.isStopSentence(text);
    if (control.faulted && !stop) {
      throw Object.assign(new Error('控制数据损坏，已进入保护模式：去设置 → 高级 → 修复控制数据'), {
        code: 'CONTROL_FAULTED',
      });
    }
    const commandId = clientMessageId ?? randomUUID();
    let authorization: Awaited<ReturnType<ActivationCoordinator['acceptUserInput']>> | undefined;
    if (!stop) {
      authorization = await activation.acceptUserInput({
        commandId,
        agentId,
        inputId: commandId,
        text,
      });
    }
    const { run, duplicate } = await chatRuns.prepare(
      {
        channelId: agentId,
        agentId,
        kind: stop ? 'stop' : 'agent',
        source: 'user',
        input: text,
        clientMessageId,
        messageId: randomUUID(),
        parentRunId: resumeTaskId,
      },
      [options.model ?? '', options.resumeTaskId ?? ''],
    );
    const opts = chatRuns.bind(run, options);

    /** 这条消息与工作的关联（E4.1/E4.2）：进 brief，并作为收尾写回进度的依据 */
    let workLink: WorkLinkOutcome | null = null;
    const task: Message = {
      id: run.messageId!,
      runId: run.runId,
      agentId,
      role: 'user',
      content: { type: 'text', text },
      createdAt: Date.now(),
      source: 'user',
      sender: { kind: 'user', id: OWNER_ID, name: host.ownerName() },
      ...(clientMessageId ? { clientMessageId } : {}),
    };
    // 先落盘再回执：客户端拿到 messageId 时消息已经在库里（E3.2/E3.4）
    if (!duplicate) {
      try {
        // E4.1/E4.2：把这条消息关联到工作（新建 / 接着 / 修订；闲聊返回 null；
        // 含糊返回候选，交给回合短问）。旁路记录，不改发送/执行/停止语义；
        // 失败也不能让这条消息发不出去。
        // 带 workId 的唤醒（E4.3）走显式关联：不用再判定这句话接哪件工作。
        //
        // E4.6：判定必须在 append 之前——消息是不可变内容，来源标注要随它一起落盘，
        // 这样它以后作为历史出现在上下文里时，模型才知道这句话属于哪件工作。
        if (!stop && options.workId) {
          const linked = await works.get(options.workId);
          workLink =
            linked && !isTerminalWork(linked.status)
              ? { work: linked, kind: 'continued', relation: 'continue' }
              : null;
        } else if (!stop) {
          try {
            workLink = await works.acceptUserMessage({
              agentId,
              channel: { kind: 'dm', id: agentId },
              messageId: task.id,
              text,
            });
          } catch (error) {
            console.warn(
              `工作记录失败（不影响本次回合）：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (workLink && workLink.kind !== 'clarify') task.workId = workLink.work.id;

        await messages.append(task);
        opts.onEvent?.({ type: 'message', message: task });
        stopCoordinator.voidPendingInteractions(agentId, opts.onEvent);
        // E4.3 §7.2：用户新句作废未回答的持久问题卡（不当答案），工作本身继续存在。
        // 等待被满足后的唤醒回合不是「新句」，不能顺手作废别的卡。
        if (!options.waitAnswer) await voidPendingUserWaits(agentId, opts.onEvent);
      } catch (error) {
        await chatRuns.fail(run.runId, error);
        throw error;
      }
    }

    // 工作关联进 brief：让模型知道「这句是接着哪件工作」，含糊时明确要求先短问
    const workBrief = workLinkBrief(workLink);
    const executeOnce = async (): Promise<SendResult> => {
      if (!isActiveChatRun(chatRuns.get(run.runId)!)) return duplicateRun(agentId, task, options);
      executor.cancelMaintenance(agentId);
      if (stop) {
        return chatRuns.execute(
          run.runId,
          () => stopCoordinator.stopFromUser(agentId, text, opts),
          (result) => result,
        );
      }
      if (authorization) {
        const decision = await activation.tryActivate({
          agentId,
          runId: run.runId,
          taskId: run.taskId,
          inputId: authorization.inputId,
          chainId: authorization.chainId,
          source: 'user',
          grantId: authorization.grantId,
        });
        if (decision.kind !== 'admitted') {
          throw Object.assign(new Error(decision.kind === 'held' ? decision.reason : decision.kind), {
            code: 'STALE_ACTIVATION',
          });
        }
        await activation.markRunning(decision.ticket);
        return host.runTurn(
          agentId,
          task,
          { skipPersist: true, resumeTaskId, ...(workBrief ? { brief: workBrief } : {}) },
          { ...opts, authorization: decision.ticket },
        ).then(async (result) => {
          await recordWorkProgress(workLink, result);
          return result;
        });
      }
      return host.runTurn(
        agentId,
        task,
        { skipPersist: true, resumeTaskId, ...(workBrief ? { brief: workBrief } : {}) },
        opts,
      ).then(async (result) => {
        await recordWorkProgress(workLink, result);
        return result;
      });
    };
    let inflight = runExecutions.get(run.runId);
    if (!inflight) {
      inflight = executeOnce().finally(() => {
        if (runExecutions.get(run.runId) === inflight) runExecutions.delete(run.runId);
      });
      runExecutions.set(run.runId, inflight);
    }
    return {
      receipt: {
        runId: run.runId,
        taskId: run.taskId,
        run: chatRuns.get(run.runId),
        messageId: task.id,
        agentId,
        receiptSeq: events.latestSeq,
        duplicate,
      },
      execute: () => inflight,
    };
  }

  /** 兼容入口：接了就执行（CLI、测试与内部调用都用它） */
  async function send(agentId: string, text: string, options: SendOptions = {}): Promise<SendResult> {
    const accepted = await acceptMessage(agentId, text, options);
    return accepted.execute();
  }

  /** 重复提交的重放：原消息再报一次（客户端按 id 去重），不再开回合 */
  async function duplicateRun(agentId: string, original: Message, options: SendOptions): Promise<SendResult> {
    options.onEvent?.({ type: 'message', message: original });
    const record = await registry.get(agentId);
    return {
      content: original.content.type === 'text' ? original.content.text : '',
      iterations: 0,
      stopReason: 'duplicate',
      agentId,
      agentName: record?.name ?? agentId,
      context: {
        agentId,
        system: '',
        messages: [],
        stats: { sections: [], totalTokens: 0, budgetTokens: 0, generatedAt: Date.now() },
        surfaced: [],
        droppedRecent: 0,
        droppedGroups: 0,
      },
      posts: [],
      status: 'silent',
    };
  }

  /**
   * 回合结束后把进展写回工作（E4.2）。
   *
   * 关键约束（设计 §5「修订」段）：**旧 Run 的状态提交必须检查 revision**——
   * 这里用受理时记下的 revision 做条件更新；如果回合跑的过程中用户又改了范围
   * （revision 已推进），这次写回会被拒绝，直接让出、绝不覆盖新目标。
   * 写回失败只记日志：账目问题不能让回合结果失败。
   */
  async function recordWorkProgress(link: WorkLinkOutcome | null, result: TurnResult): Promise<void> {
    if (!link || link.kind === 'clarify' || !link.work) return;
    const summary = (result.content ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!summary) return;
    try {
      const current = await works.get(link.work.id);
      // 等待中（E4.3）：状态由等待驱动，本回合的进展快照会让位——不然会把 waiting 覆盖掉
      if (!current || current.status === 'waiting' || current.status === 'paused') return;
      await works.update(
        link.work.id,
        { progressSummary: summary },
        { expectedRevision: link.work.revision },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 版本冲突是预期内的（用户中途改了范围，本次执行让出）
      console.warn(`工作进度未写回（${link.work.id}）：${message}`);
    }
  }

  /**
   * 工作关联写进回合 brief（E4.1/E4.2）：告诉模型这句在接着哪件工作；
   * 含糊时明确要求先用 SendToUser widget 短问，不瞎猜（设计 §5 第 5 条）。
   * 没有关联（闲聊）时不加任何文字，上下文与以前完全一样。
   */
  function workLinkBrief(link: WorkLinkOutcome | null): string {
    if (!link) return '';
    if (link.kind === 'clarify') {
      return `【工作关联】${link.question}`;
    }
    if (!link.work) return '';
    const relation =
      link.relation === 'revise'
        ? `这是对当前工作的**修订**：目标已改写为「${link.work.objective}」，按新目标做，旧目标的执行不再有效`
        : link.relation === 'new_work'
          ? '这是**新开的一件工作**'
          : '这是**接着当前工作**的补充';
    return [
      `【当前工作】${link.work.title}（id=${link.work.id}，revision=${link.work.revision}，状态=${link.work.status}）`,
      `目标：${link.work.objective}`,
      link.work.progressSummary ? `最近进展：${link.work.progressSummary}` : '',
      relation,
      // E4.6：工作事实只认 WorkItem。更早的摘要/日志/记忆可能停在旧状态上，不能反过来改工作。
      '这件工作的状态以本行为准；更早的摘要、日志和长期记忆只是历史背景，不能据此说它已完成或取消。',
      '收尾时如实说明交付了什么；不要只凭一句话就把工作说成完成。',
    ].filter(Boolean).join('\n');
  }

  return { acceptMessage, send, recordWorkProgress, workLinkBrief };
}
