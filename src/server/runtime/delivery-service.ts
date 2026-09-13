import { createHash, randomUUID } from 'node:crypto';
import {
  CHAIN_BUDGET_DEFAULTS,
  type DeliveryReceipt,
  type DeliverySubmitResult,
} from '../../shared/contracts/execution-control.js';
import { ControlError, type RuntimeControlStore } from '../../storage/runtime-control-store.js';

export interface DeliverySubmitInput {
  actorId: string;
  inputId: string;
  chainId: string;
  target: { kind: 'agent' | 'room'; id: string; nameAtSend: string };
  payload: string;
  images?: import('../../shared/contracts/input-image.js').InputImage[];
  recipientCount?: number;
}

export interface DeliveryServiceOptions {
  maxDeliveryActionsPerChain?: number;
  maxRecipientDeliveriesPerChain?: number;
}

function fingerprint(input: DeliverySubmitInput): string {
  return createHash('sha256')
    .update([input.actorId, input.inputId, input.target.kind, input.target.id, input.payload].join('\0'))
    .digest('hex');
}

export class DeliveryService {
  private readonly maxDeliveryActions: number;
  private readonly maxRecipients: number;

  constructor(
    private readonly store: RuntimeControlStore,
    options: DeliveryServiceOptions = {},
  ) {
    this.maxDeliveryActions = options.maxDeliveryActionsPerChain ?? CHAIN_BUDGET_DEFAULTS.maxDeliveryActionsPerChain;
    this.maxRecipients = options.maxRecipientDeliveriesPerChain ?? CHAIN_BUDGET_DEFAULTS.maxRecipientDeliveriesPerChain;
  }

  async submit(input: DeliverySubmitInput): Promise<DeliverySubmitResult> {
    const key = fingerprint(input);
    const recipients = input.recipientCount ?? 1;
    let result: DeliverySubmitResult | undefined;
    await this.store.transact((draft) => {
      const existing = draft.actions[key] as { receipt: DeliveryReceipt } | undefined;
      if (existing?.receipt) {
        result = { kind: 'accepted', receipt: existing.receipt, projectionStatus: 'pending' };
        return 'skip';
      }
      const chain = draft.chains[input.chainId] ?? { chainId: input.chainId, rootCreatedSeq: draft.controlSeq + 1 };
      const usedActions = chain.deliveryActions ?? 0;
      const usedRecipients = chain.recipientDeliveries ?? 0;
      if (chain.pausedBudget || usedActions >= this.maxDeliveryActions || usedRecipients + recipients > this.maxRecipients) {
        chain.pausedBudget = true;
        draft.chains[input.chainId] = chain;
        result = { kind: 'rejected', attemptId: randomUUID(), code: 'CHAIN_BUDGET_EXHAUSTED' };
        return;
      }
      const receipt: DeliveryReceipt = {
        receiptId: randomUUID(),
        actionId: randomUUID(),
        inputId: input.inputId,
        chainId: input.chainId,
        actorId: input.actorId,
        target: input.target,
        payloadHash: createHash('sha256').update(input.payload).digest('hex'),
        outcome: 'accepted',
        committedSeq: draft.controlSeq + 1,
        acceptedAt: Date.now(),
        deliveryId: randomUUID(),
      };
      chain.deliveryActions = usedActions + 1;
      chain.recipientDeliveries = usedRecipients + recipients;
      draft.chains[input.chainId] = chain;
      draft.actions[key] = { receipt };
      draft.receipts[receipt.receiptId] = receipt;
      draft.outbox[receipt.actionId] = { receipt, payload: input.payload, images: input.images };
      result = { kind: 'accepted', receipt, projectionStatus: 'pending' };
    });
    if (!result) throw new ControlError('投递提交失败', 'DELIVERY_COMMIT_UNKNOWN');
    return result;
  }
}
