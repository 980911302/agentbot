import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DeliveryService } from '../src/server/runtime/delivery-service.js';
import { RuntimeControlStore } from '../src/storage/runtime-control-store.js';
import { tempDataDir } from './fakes/test-env.js';

describe('DeliveryService 动作幂等', () => {
  it('同输入同目标同内容串行重复三次只产生一份回执', async () => {
    const env = await tempDataDir('delivery-idempotent');
    try {
      const store = await RuntimeControlStore.open(env.dir);
      const service = new DeliveryService(store);
      const input = {
        actorId: 'a1',
        inputId: 'in-1',
        chainId: 'ch-1',
        target: { kind: 'agent' as const, id: 'b1', nameAtSend: '乙' },
        payload: '你好',
      };
      const first = await service.submit(input);
      const second = await service.submit(input);
      const third = await service.submit({ ...input, payload: '你好' });
      assert.equal(first.kind, 'accepted');
      assert.equal(second.kind, 'accepted');
      assert.equal(third.kind, 'accepted');
      if (first.kind === 'accepted' && second.kind === 'accepted' && third.kind === 'accepted') {
        assert.equal(first.receipt.actionId, second.receipt.actionId);
        assert.equal(second.receipt.receiptId, third.receipt.receiptId);
      }
    } finally {
      await env.cleanup();
    }
  });

  it('新用户命令发送相同内容产生新动作', async () => {
    const env = await tempDataDir('delivery-new-input');
    try {
      const store = await RuntimeControlStore.open(env.dir);
      const service = new DeliveryService(store);
      const base = {
        actorId: 'a1',
        chainId: 'ch-1',
        target: { kind: 'agent' as const, id: 'b1', nameAtSend: '乙' },
        payload: '你好',
      };
      const first = await service.submit({ ...base, inputId: 'in-1' });
      const second = await service.submit({ ...base, inputId: 'in-2' });
      assert.equal(first.kind, 'accepted');
      assert.equal(second.kind, 'accepted');
      if (first.kind === 'accepted' && second.kind === 'accepted') {
        assert.notEqual(first.receipt.actionId, second.receipt.actionId);
      }
    } finally {
      await env.cleanup();
    }
  });
});
