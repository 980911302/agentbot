import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DeliveryService } from '../src/server/runtime/delivery-service.js';
import { CHAIN_BUDGET_DEFAULTS } from '../src/shared/contracts/execution-control.js';
import { RuntimeControlStore } from '../src/storage/runtime-control-store.js';
import { tempDataDir } from './fakes/test-env.js';

describe('因果链预算', () => {
  it('新 accepted 投递占用额度，重复回执不加', async () => {
    const env = await tempDataDir('chain-budget-dup');
    try {
      const store = await RuntimeControlStore.open(env.dir);
      const service = new DeliveryService(store, { maxDeliveryActionsPerChain: 2 });
      const base = {
        actorId: 'a1',
        inputId: 'in-1',
        chainId: 'ch-1',
        target: { kind: 'agent' as const, id: 'b1', nameAtSend: '乙' },
        payload: '你好',
      };
      const first = await service.submit(base);
      const again = await service.submit(base);
      assert.equal(first.kind, 'accepted');
      assert.equal(again.kind, 'accepted');
      assert.equal(store.snapshot().chains['ch-1']?.deliveryActions, 1);
    } finally {
      await env.cleanup();
    }
  });

  it('到预算后拒绝新动作并标记 paused_budget，重启不归零', async () => {
    const env = await tempDataDir('chain-budget-cap');
    try {
      const store = await RuntimeControlStore.open(env.dir);
      const service = new DeliveryService(store, { maxDeliveryActionsPerChain: 1 });
      const first = await service.submit({
        actorId: 'a1',
        inputId: 'in-1',
        chainId: 'ch-1',
        target: { kind: 'agent', id: 'b1', nameAtSend: '乙' },
        payload: '一',
      });
      assert.equal(first.kind, 'accepted');
      const second = await service.submit({
        actorId: 'a1',
        inputId: 'in-1',
        chainId: 'ch-1',
        target: { kind: 'agent', id: 'b1', nameAtSend: '乙' },
        payload: '二',
      });
      assert.equal(second.kind, 'rejected');
      if (second.kind === 'rejected') assert.equal(second.code, 'CHAIN_BUDGET_EXHAUSTED');
      assert.equal(store.snapshot().chains['ch-1']?.pausedBudget, true);

      const reopened = await RuntimeControlStore.open(env.dir);
      assert.equal(reopened.snapshot().chains['ch-1']?.deliveryActions, 1);
      assert.equal(reopened.snapshot().chains['ch-1']?.pausedBudget, true);
    } finally {
      await env.cleanup();
    }
  });

  it('默认额度可配置且暴露产品默认值', () => {
    assert.equal(CHAIN_BUDGET_DEFAULTS.maxDeliveryActionsPerChain, 24);
    assert.equal(CHAIN_BUDGET_DEFAULTS.maxRecipientDeliveriesPerChain, 48);
  });
});
