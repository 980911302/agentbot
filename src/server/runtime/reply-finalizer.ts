import type { DeliveryReceipt } from '../../shared/contracts/execution-control.js';

export interface FinalizeInput {
  actorId: string;
  inputId: string;
  content: string;
  deliveryRefs?: string[];
  claimedTargetId?: string;
  source?: 'user' | 'inbox' | 'room';
}

export type FinalizeResult =
  | { kind: 'ok'; verifiedWholeText: false; statusLines: Array<{ receiptId: string; targetId: string; targetName: string }> }
  | { kind: 'contradicted'; code: 'TARGET_MISMATCH' }
  | { kind: 'invalid'; code: 'INVALID_DELIVERY_REFERENCE'; message: string }
  | { kind: 'silent' }
  | { kind: 'incomplete'; reason: string };

export class ReplyFinalizer {
  constructor(
    private readonly deps: {
      lookup: (receiptId: string) => Promise<DeliveryReceipt | undefined>;
      canView: (actorId: string, receipt: DeliveryReceipt) => boolean;
    },
  ) {}

  async finalize(input: FinalizeInput): Promise<FinalizeResult> {
    const refs = (input.deliveryRefs ?? []).slice(0, 8);
    if (refs.length === 0) {
      if (!input.content.trim()) {
        if (input.source === 'user') return { kind: 'incomplete', reason: '直接用户请求需要可见结果' };
        return { kind: 'silent' };
      }
      if (/\b(已发|已经发|发到了|sent to|posted to)\b/u.test(input.content) && /群|room|channel/u.test(input.content)) {
        return { kind: 'incomplete', reason: '没有本轮投递回执，不能确认已发送' };
      }
      return { kind: 'ok', verifiedWholeText: false, statusLines: [] };
    }

    const statusLines: Array<{ receiptId: string; targetId: string; targetName: string }> = [];
    for (const id of refs) {
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
