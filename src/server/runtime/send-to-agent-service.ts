import { isTerminalWork, titleFrom } from '../../work/item.js';
import { agentWaitKey, type WorkWait } from '../../work/wait.js';
import { resolveMentions } from '../../room/mentions.js';
import { createSendToAgentTool } from '../../tools/builtin/room.js';
import type { AgentRecord } from '../../agent/types.js';
import type { AgentInbox, InboxItem } from '../../agent/inbox.js';
import type { AgentRegistry } from '../../agent/registry.js';
import type { DelegationService } from '../../work/delegation-service.js';
import type { DeliveryService } from './delivery-service.js';
import type { OutboxProjector } from './outbox-projector.js';
import type { WorkService } from '../../work/service.js';
import type { Workbench } from '../../workbench/service.js';

/** 落一条持久等待的入参（E4.3/E4.4）；与 WorkWait 的创建形状一致 */
export interface WaitRequest {
  agentId: string;
  workId?: string;
  kind: WorkWait['kind'];
  correlationId: string;
  /** 「哪一次请求」的线程键（E4.4）：kind=agent 时是委派 id */
  threadId?: string;
  card?: WorkWait['card'];
  condition?: string;
  dueAt?: number;
}

/**
 * SendToAgent 的装配依赖（OPT-03 从 runtime.ts 搬出）。
 *
 * 只做投递编排：解析收件方 → 落投递 → 记委派/等待 → 投影成信并叫醒收件方。
 * 不认识 AgentRuntime 门面，运行时需要的能力一律经这里注入（同 createAgentTools 的 bind 风格）。
 */
export interface SendToAgentServiceDeps {
  /** 智能体互传的链深度上限（工具自己判超限，这里只透传） */
  maxAgentChainDepth: number;
  registry: AgentRegistry;
  workbench: Workbench;
  delegations: DelegationService;
  deliveries: DeliveryService;
  works: WorkService;
  projector: OutboxProjector;
  inbox: AgentInbox;
  /** 叫醒收件方的到期调度；调度器晚于工具建好，所以用回调而不是对象引用 */
  watchInbox: (agentId: string) => void;
  beginWait: (input: WaitRequest) => Promise<WorkWait>;
  archiveLetter: (item: InboxItem) => Promise<void>;
}

/**
 * SendToAgent：target 支持 id / 名字（同事），群 id / 群名（必须是自己所在的群）。
 * agent / room 两支 dispatch 都在这里，见 docs/工具参考.md「协作与后台任务」。
 */
export function createSendToAgentDispatcher(deps: SendToAgentServiceDeps) {
  const {
    registry,
    workbench,
    delegations,
    deliveries,
    works,
    projector,
    inbox,
    watchInbox,
    beginWait,
    archiveLetter,
  } = deps;

  return createSendToAgentTool({
    maxDepth: deps.maxAgentChainDepth,
    resolveTarget: async (wanted, callerId) => {
      const agents = await registry.list();
      const agent = agents.find((item) => item.id === wanted);
      if (agent) return { kind: 'agent' as const, id: agent.id, name: agent.name };
      const rooms = await workbench.listRooms();
      const room = rooms.find((item) => item.id === wanted);
      if (room) {
        if (!room.memberIds.includes(callerId)) throw new Error('你不在这个群');
        return { kind: 'room' as const, id: room.id, name: room.name };
      }
      const matches = [
        ...agents
          .filter((item) => item.name === wanted)
          .map((item) => ({ kind: 'agent' as const, id: item.id, name: item.name })),
        ...rooms
          .filter((item) => item.memberIds.includes(callerId) && item.name === wanted)
          .map((item) => ({ kind: 'room' as const, id: item.id, name: item.name })),
      ];
      if (matches.length > 1)
        throw new Error(
          `收件方名称有歧义，请使用 id：${matches.map((item) => `${item.kind === 'agent' ? '同事' : '群'}「${item.name}」id=${item.id}`).join('；')}`,
        );
      return matches[0];
    },
    dispatch: async ({
      targetId,
      kind,
      text,
      images,
      priority,
      callerId,
      correlationId,
      chainId,
      depth,
      signal,
      roundId,
    }) => {
      if (kind === 'agent') {
        const sender = await registry.get(callerId);
        const target = await registry.get(targetId);
        signal?.throwIfAborted();
        if (!sender || !target) throw new Error('发信方或收件方不存在');
        // E4.4：这次投递是「回某次委派」还是「新派一件事」？
        // 回信复用原委派线程键，让发起方能只唤醒「那一次请求」；
        // 新派则由这封信自己的投递 id 当线程键（投影时落定）。
        const replyThread = await delegations.resolveReplyThread({
          callerId,
          targetId,
          ...(correlationId ? { threadId: correlationId } : {}),
        });
        const submitted = await deliveries.submit({
          actorId: callerId,
          inputId: correlationId ?? `${callerId}:${targetId}`,
          chainId: chainId ?? correlationId ?? callerId,
          target: { kind: 'agent', id: targetId, nameAtSend: target.name },
          payload: text,
          ...(images?.length ? { images } : {}),
          priority,
          depth: depth ?? 1,
          ...(replyThread ? { correlationId: replyThread.id } : {}),
        });
        if (submitted.kind !== 'accepted') throw new Error(submitted.code);
        // E4.4：先记委派、再让信可见——收件方认领这封信时要能查到「这是哪条委派」，
        // 否则它就成了没主的一次投递，childWorkId 也就永远回填不上。
        // 线程键 = 请求信投递 id；重试/重复提交时幂等复用原记录。
        const threadId = submitted.receipt.deliveryId;
        const waitingWork = await works.openWorkOf(callerId);
        if (threadId) {
          await delegations
            .recordOutbound({
              id: threadId,
              fromAgentId: callerId,
              toAgentId: targetId,
              ...(waitingWork && !isTerminalWork(waitingWork.status)
                ? { parentWorkId: waitingWork.id }
                : {}),
              requestMessageId: threadId,
            })
            .catch((error) => console.warn(`委派未记账：${messageOf(error)}`));
        }
        if (replyThread) {
          await delegations
            .markReplied(replyThread.id)
            .catch((error) => console.warn(`委派回信状态未写回：${messageOf(error)}`));
        }
        await projector.project(submitted.receipt.actionId, {
          from: {
            kind: 'agent',
            id: sender.id,
            name: sender.name,
            color: sender.color,
            avatar: sender.avatar,
          },
          to: {
            kind: 'agent',
            id: target.id,
            name: target.name,
            color: target.color,
            avatar: target.avatar,
          },
        });
        const projected = await inbox.peek(targetId);
        const letter = projected.find((item) => item.id === submitted.receipt.deliveryId);
        if (letter) await archiveLetter(letter);
        watchInbox(targetId);
        // E4.3：记一条「在等这位同事回信」的持久等待——重启后仍然知道在等谁；
        // 对方回信被确认处理时按线程键精确 resolve 并唤醒工作（见 resolveAgentWaitsForReply）。
        // 没有关联的工作时不记（没有可唤醒的对象，投递本身照常）。
        if (waitingWork && !isTerminalWork(waitingWork.status)) {
          await beginWait({
            agentId: callerId,
            workId: waitingWork.id,
            kind: 'agent',
            correlationId: agentWaitKey(targetId),
            ...(threadId ? { threadId } : {}),
            condition: `等「${target.name}」回复「${titleFrom(text)}」`,
          }).catch((error) => console.warn(`同事等待未记录：${messageOf(error)}`));
        }
        return {
          status: 'ok' as const,
          content: `已投递给「${target.name}」；发出去就结束，回复是之后的新回合。`,
          output: {
            truncated: false,
            handle: submitted.receipt.receiptId,
          },
        };
      }
      const sender = await registry.get(callerId);
      const rooms = await workbench.listRooms();
      const room = rooms.find((item) => item.id === targetId);
      if (!sender || !room) throw new Error('发信方或不在该群');
      const members = (await Promise.all(room.memberIds.map((id) => registry.get(id)))).filter(
        (member): member is AgentRecord => Boolean(member),
      );
      const mentioned = resolveMentions(
        text,
        members.map((member) => ({ id: member.id, name: member.name, color: member.color })),
      );
      const recipientMembers = members.filter((member) => member.id !== callerId);
      const submitted = await deliveries.submit({
        actorId: callerId,
        inputId: correlationId ?? `${callerId}:${targetId}`,
        chainId: chainId ?? correlationId ?? callerId,
        target: { kind: 'room', id: targetId, nameAtSend: room.name },
        payload: text,
        depth: depth ?? 0,
        sender: {
          kind: 'agent',
          id: sender.id,
          name: sender.name,
          color: sender.color,
          avatar: sender.avatar,
        },
        roomRecipients: recipientMembers.map((member) => ({
          id: member.id,
          name: member.name,
          color: member.color,
          avatar: member.avatar,
          summoned: mentioned.everyone || mentioned.ids.includes(member.id),
          everyone: mentioned.everyone,
        })),
        recipientAgentIds: recipientMembers.map((member) => member.id),
        recipientCount: recipientMembers.length,
        ...(roundId ? { roundId } : {}),
      });
      if (submitted.kind !== 'accepted') throw new Error(submitted.code);
      await projector.projectRoom(submitted.receipt.actionId);
      for (const member of recipientMembers) watchInbox(member.id);
      return {
        status: 'ok' as const,
        content: `已发到「${room.name}」。`,
        output: { truncated: false, handle: submitted.receipt.receiptId },
      };
    },
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}