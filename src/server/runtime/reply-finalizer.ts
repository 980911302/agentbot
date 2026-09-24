import type { DeliveryReceipt } from '../../shared/contracts/execution-control.js';

export interface FinalizeInput {
  actorId: string;
  inputId: string;
  content: string;
  deliveryRefs?: string[];
  allowedReceiptIds?: string[];
  claimedTargetId?: string;
  source?: 'user' | 'inbox' | 'room';
}

export type FinalizeResult =
  | { kind: 'ok'; verifiedWholeText: false; statusLines: Array<{ receiptId: string; targetId: string; targetName: string }> }
  | { kind: 'contradicted'; code: 'TARGET_MISMATCH' }
  | { kind: 'invalid'; code: 'INVALID_DELIVERY_REFERENCE'; message: string }
  | { kind: 'silent' }
  | { kind: 'incomplete'; reason: string };

export function looksLikeUnverifiedRoomDeliveryClaim(text: string): boolean {
  return /(已(?:经)?发|发到了|sent to|posted to)/iu.test(text) && /群|room|channel/iu.test(text);
}

/**
 * 明确指向更早回合/过去时态的群投递复盘（"群里刚才那条已经发过了"）。
 * 本轮回执为空是这种复盘的正常形态，不应按"本轮未证实声明"处理。
 */
export function isPastDeliveryRecap(text: string): boolean {
  return /(刚才|之前|此前|上一轮|上一回|早些|早前| earlier |earlier\b|previously)/iu.test(text);
}

export class ReplyFinalizer {
  constructor(
    private readonly deps: {
      lookup: (receiptId: string) => Promise<DeliveryReceipt | undefined>;
      canView: (actorId: string, receipt: DeliveryReceipt) => boolean;
    },
  ) {}

  async finalize(input: FinalizeInput): Promise<FinalizeResult> {
    const refs = (input.deliveryRefs ?? []).slice(0, 8);
    const allowed = input.allowedReceiptIds ? new Set(input.allowedReceiptIds) : undefined;
    if (refs.length === 0) {
      if (!input.content.trim()) {
        if (input.source === 'user') return { kind: 'incomplete', reason: '直接用户请求需要可见结果' };
        return { kind: 'silent' };
      }
      if (input.source !== 'room' && looksLikeUnverifiedRoomDeliveryClaim(input.content) && !isPastDeliveryRecap(input.content)) {
        return { kind: 'incomplete', reason: '没有本轮投递回执，不能确认已发送' };
      }
      return { kind: 'ok', verifiedWholeText: false, statusLines: [] };
    }

    const statusLines: Array<{ receiptId: string; targetId: string; targetName: string }> = [];
    for (const id of refs) {
      if (allowed && !allowed.has(id)) {
        return { kind: 'invalid', code: 'INVALID_DELIVERY_REFERENCE', message: '回执不属于本轮已接受动作' };
      }
      const found = await this.deps.lookup(id);
      if (!found || found.outcome !== 'accepted') {
        return { kind: 'invalid', code: 'INVALID_DELIVERY_REFERENCE', message: '回执不存在或尚未受理' };
      }
      if (!this.deps.canView(input.actorId, found) || found.actorId !== input.actorId) {
        return { kind: 'invalid', code: 'INVALID_DELIVERY_REFERENCE', message: '无权引用该回执' };
      }
      if (found.inputId !== input.inputId) {
        return { kind: 'invalid', code: 'INVALID_DELIVERY_REFERENCE', message: '回执不属于本次动作' };
      }
      if (input.claimedTargetId && input.claimedTargetId !== found.target.id) {
        return { kind: 'contradicted', code: 'TARGET_MISMATCH' };
      }
      statusLines.push({ receiptId: found.receiptId, targetId: found.target.id, targetName: found.target.nameAtSend });
    }
    return { kind: 'ok', verifiedWholeText: false, statusLines };
  }
}
