import { workerResultLetter, type Worker } from '../../tools/services/worker-manager.js';
import type { AgentRegistry } from '../../agent/registry.js';
import type { MessageStore } from '../../store/messages.js';
import type { MessageActor } from '../../shared/contracts/message-identity.js';
import type { DeliveryService } from './delivery-service.js';
import type { OutboxProjector } from './outbox-projector.js';

/**
 * 工人收尾投递（E4.5，OPT-03 从 runtime.ts 搬出）。
 *
 * 结果作为一封信回到派工者，而不是只能靠 CheckSubagent 轮询：不为工人另造一套投递，
 * 走 SendToAgent 用的同一条可靠链路——DeliveryService.submit 落 outbox →
 * OutboxProjector.project 写进收件箱 → 调度器唤醒派工者新回合。
 * 投递按 (actorId, inputId, …) 指纹幂等，所以重启补送不会重复送到。
 */
export function createWorkerResultDelivery(deps: {
  registry: AgentRegistry;
  messages: MessageStore;
  deliveries: DeliveryService;
  projector: OutboxProjector;
  watchInbox: (agentId: string) => void;
}) {
  const { registry, messages, deliveries, projector, watchInbox } = deps;

  async function deliverWorkerResult(worker: Worker): Promise<void> {
    const owner = worker.ownerId ? await registry.get(worker.ownerId) : undefined;
    if (!owner) throw new Error(`派工者 ${worker.ownerId ?? '(未知)'} 已不存在，工人结果无处投递`);
    const text = workerResultLetter(worker);
    const from: MessageActor = { kind: 'agent', id: worker.id, name: `工人：${worker.description}` };
    const to: MessageActor = {
      kind: 'agent',
      id: owner.id,
      name: owner.name,
      color: owner.color,
      avatar: owner.avatar,
    };
    // 工人自己的经历线留一条收尾：审计「它交了什么」不依赖收件箱是否已被消费
    await messages.appendIfAbsent({
      id: `worker-result:${worker.id}`,
      agentId: worker.id,
      role: 'assistant',
      content: { type: 'text', text },
      createdAt: worker.endedAt ?? Date.now(),
      source: 'agent',
    });
    const submitted = await deliveries.submit({
      actorId: worker.id,
      inputId: `worker:${worker.id}`,
      // 结果信记在派工者那一轮的同一条协作链上：链预算仍然算得住，不另开一条绕过上限
      chainId: worker.chainId ?? `worker:${worker.id}`,
      target: { kind: 'agent', id: owner.id, nameAtSend: owner.name },
      payload: text,
      depth: (worker.chainDepth ?? 0) + 1,
    });
    if (submitted.kind !== 'accepted') {
      // 链预算用尽时不假装送到：结果留在工人记录里，重启扫描会再试，界面上仍能查证
      throw new Error(`工人结果投递被拒（${submitted.code}），未送达派工者`);
    }
    await projector.project(submitted.receipt.actionId, { from, to });
    watchInbox(owner.id);
  }

  return { deliverWorkerResult };
}
