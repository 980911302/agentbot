import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ActivationCoordinator } from '../src/server/runtime/activation-coordinator.js';
import { EffectRunner } from '../src/server/runtime/effect-runner.js';
import { RuntimeControlStore } from '../src/storage/runtime-control-store.js';
import { tempDataDir, until } from './fakes/test-env.js';

describe('EffectRunner', () => {
  it('reserved 后未启动即 stop：工具不得执行', async () => {
    const env = await tempDataDir('effect-reserved');
    try {
      const store = await RuntimeControlStore.open(env.dir, { processEpoch: 'p1' });
      const coordinator = new ActivationCoordinator(store, { processEpoch: 'p1', exists: async () => true });
      const accepted = await coordinator.acceptUserInput({
        commandId: 'cmd', agentId: 'a1', inputId: 'in-1', text: '写文件',
      });
      const decision = await coordinator.tryActivate({
        agentId: 'a1', runId: 'run-1', taskId: 't1', inputId: 'in-1',
        chainId: accepted.chainId, source: 'user', grantId: accepted.grantId,
      });
      assert.equal(decision.kind, 'admitted');
      if (decision.kind !== 'admitted') return;
      const runner = new EffectRunner(coordinator);
      const permit = await coordinator.admitEffect(decision.ticket, { effectId: 'e1', kind: 'write' });
      assert.equal(permit.state, 'reserved');
      assert.equal(store.snapshot().effects['e1']?.state, 'reserved');
      await coordinator.requestStop({
        commandId: 'stop-1',
        requestedBy: { kind: 'user', id: 'owner' },
        scope: { kind: 'agent', agentId: 'a1' },
      });
      assert.equal(store.snapshot().effects['e1']?.state, 'cancelled');
      let started = 0;
      await assert.rejects(
        () => runner.start(permit, async () => { started += 1; return 'wrote'; }),
        /CANCELLED|STALE|撤销/,
      );
      assert.equal(started, 0);
    } finally {
      await env.cleanup();
    }
  });

  it('started 句柄可追踪并等待收束', async () => {
    const env = await tempDataDir('effect-started');
    try {
      const store = await RuntimeControlStore.open(env.dir, { processEpoch: 'p1' });
      const coordinator = new ActivationCoordinator(store, { processEpoch: 'p1', exists: async () => true });
      const accepted = await coordinator.acceptUserInput({
        commandId: 'cmd', agentId: 'a1', inputId: 'in-1', text: '跑',
      });
      const decision = await coordinator.tryActivate({
        agentId: 'a1', runId: 'run-1', taskId: 't1', inputId: 'in-1',
        chainId: accepted.chainId, source: 'user', grantId: accepted.grantId,
      });
      assert.equal(decision.kind, 'admitted');
      if (decision.kind !== 'admitted') return;
      const runner = new EffectRunner(coordinator);
      const permit = await coordinator.admitEffect(decision.ticket, { effectId: 'e2', kind: 'shell' });
      let resolveWork!: () => void;
      const work = new Promise<string>((resolve) => { resolveWork = () => resolve('done'); });
      const started = runner.start(permit, () => work);
      await until(async () => store.snapshot().effects['e2']?.state === 'started', 'effect started');
      assert.equal(store.snapshot().effects['e2']?.state, 'started');
      assert.equal(runner.pendingCount, 1);
      resolveWork();
      assert.equal(await started, 'done');
      assert.equal(store.snapshot().effects['e2']?.state, 'settled');
      await runner.wait(50);
      assert.equal(runner.pendingCount, 0);
    } finally {
      await env.cleanup();
    }
  });
});
