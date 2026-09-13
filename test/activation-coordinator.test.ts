import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ActivationCoordinator } from '../src/server/runtime/activation-coordinator.js';
import { RuntimeControlStore } from '../src/storage/runtime-control-store.js';
import { tempDataDir } from './fakes/test-env.js';

async function openCoordinator(dir: string, processEpoch = 'proc-1') {
  const store = await RuntimeControlStore.open(dir, { processEpoch });
  return { store, coordinator: new ActivationCoordinator(store, { processEpoch, exists: async () => true }) };
}

describe('ActivationCoordinator', () => {
  it('用户新命令签发新链许可，不把 autoActivation 改回 enabled', async () => {
    const env = await tempDataDir('activate-user');
    try {
      const { store, coordinator } = await openCoordinator(env.dir);
      await store.commitStop({
        commandId: 'stop-1',
        requestedBy: { kind: 'user', id: 'owner' },
        scope: { kind: 'agent', agentId: 'a1' },
      });
      const accepted = await coordinator.acceptUserInput({
        commandId: 'cmd-new',
        agentId: 'a1',
        inputId: 'msg-new',
        text: '新任务',
      });
      assert.ok(accepted.chainId);
      assert.equal(store.snapshot().agents['a1']?.autoActivation, 'paused');
      const decision = await coordinator.tryActivate({
        agentId: 'a1',
        runId: 'run-new',
        taskId: 'task-new',
        inputId: 'msg-new',
        chainId: accepted.chainId,
        source: 'user',
        grantId: accepted.grantId,
      });
      assert.equal(decision.kind, 'admitted');
    } finally {
      await env.cleanup();
    }
  });

  it('停止后旧链来信 held，不签发 ticket', async () => {
    const env = await tempDataDir('activate-old-mail');
    try {
      const { store, coordinator } = await openCoordinator(env.dir);
      const accepted = await coordinator.acceptUserInput({
        commandId: 'cmd-old',
        agentId: 'a1',
        inputId: 'msg-old',
        text: '旧任务',
      });
      await store.commitStop({
        commandId: 'stop-old',
        requestedBy: { kind: 'user', id: 'owner' },
        scope: { kind: 'agent', agentId: 'a1' },
      });
      const decision = await coordinator.tryActivate({
        agentId: 'a1',
        runId: 'run-old',
        taskId: 'task-old',
        inputId: 'letter-1',
        chainId: accepted.chainId,
        source: 'inbox',
        rootCreatedSeq: store.snapshot().chains[accepted.chainId]?.rootCreatedSeq,
      });
      assert.equal(decision.kind, 'held');
      if (decision.kind === 'held') assert.equal(decision.reason, 'agent_paused');
    } finally {
      await env.cleanup();
    }
  });

  it('甲的新链不能给已暂停的乙签发许可', async () => {
    const env = await tempDataDir('activate-no-inherit');
    try {
      const { store, coordinator } = await openCoordinator(env.dir);
      await store.commitStop({
        commandId: 'stop-b',
        requestedBy: { kind: 'user', id: 'owner' },
        scope: { kind: 'agent', agentId: 'b1' },
      });
      const accepted = await coordinator.acceptUserInput({
        commandId: 'cmd-a',
        agentId: 'a1',
        inputId: 'msg-a',
        text: '联系乙',
      });
      const forB = await coordinator.tryActivate({
        agentId: 'b1',
        runId: 'run-b',
        taskId: 'task-b',
        inputId: 'letter-ab',
        chainId: accepted.chainId,
        source: 'inbox',
        grantId: accepted.grantId,
        rootCreatedSeq: store.snapshot().chains[accepted.chainId]?.rootCreatedSeq,
      });
      assert.equal(forB.kind, 'held');
    } finally {
      await env.cleanup();
    }
  });

  it('开启未来自动处理不释放旧 held 项，迟到旧链仍拒绝', async () => {
    const env = await tempDataDir('activate-future');
    try {
      const { store, coordinator } = await openCoordinator(env.dir);
      const old = await coordinator.acceptUserInput({
        commandId: 'cmd-old',
        agentId: 'a1',
        inputId: 'msg-old',
        text: '旧',
      });
      await store.commitStop({
        commandId: 'stop-1',
        requestedBy: { kind: 'user', id: 'owner' },
        scope: { kind: 'agent', agentId: 'a1' },
      });
      await coordinator.resumeSelected({
        commandId: 'resume-future',
        requestedBy: { kind: 'user', id: 'owner' },
        agentId: 'a1',
        selection: { kind: 'enable_future' },
      });
      assert.equal(store.snapshot().agents['a1']?.autoActivation, 'enabled');
      const late = await coordinator.tryActivate({
        agentId: 'a1',
        runId: 'run-late',
        taskId: 'task-late',
        inputId: 'letter-late',
        chainId: old.chainId,
        source: 'inbox',
        rootCreatedSeq: store.snapshot().chains[old.chainId]?.rootCreatedSeq,
      });
      assert.equal(late.kind, 'held');
    } finally {
      await env.cleanup();
    }
  });

  it('只恢复一封旧信：同链其它输入仍 held', async () => {
    const env = await tempDataDir('activate-one-input');
    try {
      const { store, coordinator } = await openCoordinator(env.dir);
      const old = await coordinator.acceptUserInput({
        commandId: 'cmd-old',
        agentId: 'a1',
        inputId: 'msg-old',
        text: '旧',
      });
      await store.commitStop({
        commandId: 'stop-1',
        requestedBy: { kind: 'user', id: 'owner' },
        scope: { kind: 'agent', agentId: 'a1' },
      });
      await coordinator.resumeSelected({
        commandId: 'resume-one',
        requestedBy: { kind: 'user', id: 'owner' },
        agentId: 'a1',
        selection: { kind: 'input', inputId: 'letter-keep' },
      });
      const kept = await coordinator.tryActivate({
        agentId: 'a1',
        runId: 'run-keep',
        taskId: 'task-keep',
        inputId: 'letter-keep',
        chainId: old.chainId,
        source: 'inbox',
        rootCreatedSeq: store.snapshot().chains[old.chainId]?.rootCreatedSeq,
      });
      const other = await coordinator.tryActivate({
        agentId: 'a1',
        runId: 'run-other',
        taskId: 'task-other',
        inputId: 'letter-other',
        chainId: old.chainId,
        source: 'inbox',
        rootCreatedSeq: store.snapshot().chains[old.chainId]?.rootCreatedSeq,
      });
      assert.equal(kept.kind, 'admitted');
      assert.equal(other.kind, 'held');
    } finally {
      await env.cleanup();
    }
  });

  it('旧 processEpoch 的 ticket 不能 assertCurrent', async () => {
    const env = await tempDataDir('activate-epoch');
    try {
      const { coordinator } = await openCoordinator(env.dir, 'proc-new');
      const accepted = await coordinator.acceptUserInput({
        commandId: 'cmd',
        agentId: 'a1',
        inputId: 'msg',
        text: 'hi',
      });
      const decision = await coordinator.tryActivate({
        agentId: 'a1',
        runId: 'run-1',
        taskId: 'task-1',
        inputId: 'msg',
        chainId: accepted.chainId,
        source: 'user',
        grantId: accepted.grantId,
      });
      assert.equal(decision.kind, 'admitted');
      if (decision.kind !== 'admitted') return;
      const stale = { ...decision.ticket, processEpoch: 'proc-old' };
      assert.throws(() => coordinator.assertCurrent(stale), /STALE_ACTIVATION|代次|进程/);
    } finally {
      await env.cleanup();
    }
  });

  it('同一主体已有 running ticket 时返回 busy', async () => {
    const env = await tempDataDir('activate-busy');
    try {
      const { coordinator } = await openCoordinator(env.dir);
      const accepted = await coordinator.acceptUserInput({
        commandId: 'cmd',
        agentId: 'a1',
        inputId: 'msg',
        text: 'hi',
      });
      const first = await coordinator.tryActivate({
        agentId: 'a1',
        runId: 'run-1',
        taskId: 'task-1',
        inputId: 'msg',
        chainId: accepted.chainId,
        source: 'user',
        grantId: accepted.grantId,
      });
      assert.equal(first.kind, 'admitted');
      if (first.kind === 'admitted') await coordinator.markRunning(first.ticket);
      const second = await coordinator.tryActivate({
        agentId: 'a1',
        runId: 'run-2',
        taskId: 'task-2',
        inputId: 'msg-2',
        chainId: accepted.chainId,
        source: 'inbox',
        grantId: accepted.grantId,
      });
      assert.equal(second.kind, 'busy');
    } finally {
      await env.cleanup();
    }
  });
});
