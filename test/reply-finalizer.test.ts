import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ReplyFinalizer } from '../src/server/runtime/reply-finalizer.js';
import type { DeliveryReceipt } from '../src/shared/contracts/execution-control.js';

function receipt(partial: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
  return {
    receiptId: 'r1',
    actionId: 'a1',
    inputId: 'in-1',
    chainId: 'ch-1',
    actorId: 'agent-a',
    target: { kind: 'room', id: 'room-a', nameAtSend: '甲群' },
    payloadHash: 'hash',
    outcome: 'accepted',
    committedSeq: 1,
    acceptedAt: 1,
    ...partial,
  };
}

describe('ReplyFinalizer', () => {
  it('有效回执生成状态条，不把全文标为 verified', async () => {
    const finalizer = new ReplyFinalizer({
      lookup: async (id) => (id === 'r1' ? receipt() : undefined),
      canView: (actorId, found) => actorId === found.actorId,
    });
    const result = await finalizer.finalize({
      actorId: 'agent-a',
      inputId: 'in-1',
      content: '已经发到甲群了。',
      deliveryRefs: ['r1'],
    });
    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') {
      assert.equal(result.verifiedWholeText, false);
      assert.equal(result.statusLines[0]?.targetId, 'room-a');
    }
  });

  it('甲群回执不能证明乙群发送成功', async () => {
    const finalizer = new ReplyFinalizer({
      lookup: async () => receipt(),
      canView: () => true,
    });
    const result = await finalizer.finalize({
      actorId: 'agent-a',
      inputId: 'in-1',
      content: '已经发到乙群了。',
      deliveryRefs: ['r1'],
      claimedTargetId: 'room-b',
    });
    assert.equal(result.kind, 'contradicted');
  });

  it('历史回执不在本轮 accepted 集合时不能证明本轮发送', async () => {
    const finalizer = new ReplyFinalizer({
      lookup: async () => receipt(),
      canView: () => true,
    });
    const result = await finalizer.finalize({
      actorId: 'agent-a',
      inputId: 'in-1',
      content: '已经发到甲群了。',
      deliveryRefs: ['r1'],
      allowedReceiptIds: [],
    });
    assert.equal(result.kind, 'invalid');
  });

  it('引用他人不可见私信回执被拒且不泄露原文', async () => {
    const finalizer = new ReplyFinalizer({
      lookup: async () => receipt({ actorId: 'other', payloadHash: 'secret-payload' }),
      canView: () => false,
    });
    const result = await finalizer.finalize({
      actorId: 'agent-a',
      inputId: 'in-1',
      content: '已发。',
      deliveryRefs: ['r1'],
    });
    assert.equal(result.kind, 'invalid');
    if (result.kind === 'invalid') {
      assert.equal(result.code, 'INVALID_DELIVERY_REFERENCE');
      assert.equal(result.message.includes('secret-payload'), false);
    }
  });

  it('同事回合无出口允许 silent', async () => {
    const finalizer = new ReplyFinalizer({
      lookup: async () => undefined,
      canView: () => false,
    });
    const result = await finalizer.finalize({
      actorId: 'agent-a',
      inputId: 'in-1',
      content: '',
      source: 'inbox',
    });
    assert.equal(result.kind, 'silent');
  });

  it('直接用户请求不能用 silent 当成功', async () => {
    const finalizer = new ReplyFinalizer({
      lookup: async () => undefined,
      canView: () => false,
    });
    const result = await finalizer.finalize({
      actorId: 'agent-a',
      inputId: 'in-1',
      content: '',
      source: 'user',
    });
    assert.equal(result.kind, 'incomplete');
  });

  it('群内发言包含群投递字样不需要私聊外发回执', async () => {
    const finalizer = new ReplyFinalizer({
      lookup: async () => undefined,
      canView: () => false,
    });
    const result = await finalizer.finalize({
      actorId: 'agent-a',
      inputId: 'in-1',
      content: '规则已在群内说明，已经发到群里了。',
      source: 'room',
    });
    assert.equal(result.kind, 'ok');
  });
});

describe('过往回合复盘', () => {
  it('复盘更早回合的群投递不再按本轮未证实声明处理', async () => {
    const finalizer = new ReplyFinalizer({
      lookup: async () => undefined,
      canView: () => true,
    });
    const result = await finalizer.finalize({
      actorId: 'agent-a',
      inputId: 'in-1',
      content: '甲群里刚才那条规则已经发过了，大家直接看就行。',
    });
    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') assert.deepEqual(result.statusLines, []);
  });

  it('仍然拦截断言本轮已发送的自由正文', async () => {
    const finalizer = new ReplyFinalizer({
      lookup: async () => undefined,
      canView: () => true,
    });
    const result = await finalizer.finalize({
      actorId: 'agent-a',
      inputId: 'in-1',
      content: '我已经发到甲群了。',
    });
    assert.equal(result.kind, 'incomplete');
  });
});
