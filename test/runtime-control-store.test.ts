import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CONTROL_SCHEMA_VERSION } from '../src/shared/contracts/execution-control.js';
import { RuntimeControlStore } from '../src/storage/runtime-control-store.js';
import { tempDataDir } from './fakes/test-env.js';

describe('RuntimeControlStore', () => {
  it('事务提交后 controlSeq 递增，重启可读', async () => {
    const env = await tempDataDir('control-persist');
    try {
      const first = await RuntimeControlStore.open(env.dir);
      const seq = await first.transact((draft) => {
        draft.agents['a1'] = {
          agentId: 'a1',
          generation: 1,
          autoActivation: 'enabled',
          revision: 1,
        };
      });
      assert.equal(seq, 1);
      assert.equal(first.snapshot().controlSeq, 1);
      assert.equal(first.snapshot().schemaVersion, CONTROL_SCHEMA_VERSION);

      const second = await RuntimeControlStore.open(env.dir);
      assert.equal(second.snapshot().controlSeq, 1);
      assert.equal(second.snapshot().agents['a1']?.agentId, 'a1');
      assert.notEqual(second.currentProcessEpoch, first.currentProcessEpoch);
    } finally {
      await env.cleanup();
    }
  });

  it('并发事务串行提交，不丢更新', async () => {
    const env = await tempDataDir('control-serial');
    try {
      const store = await RuntimeControlStore.open(env.dir);
      await Promise.all([
        store.transact((draft) => {
          draft.commands['c1'] = { commandId: 'c1', kind: 'note' };
        }),
        store.transact((draft) => {
          draft.commands['c2'] = { commandId: 'c2', kind: 'note' };
        }),
      ]);
      const snap = store.snapshot();
      assert.equal(snap.controlSeq, 2);
      assert.ok(snap.commands['c1']);
      assert.ok(snap.commands['c2']);
    } finally {
      await env.cleanup();
    }
  });

  it('同 commandId 重复 stop 返回同一 stopId，generation 只递增一次', async () => {
    const env = await tempDataDir('control-idempotent-stop');
    try {
      const store = await RuntimeControlStore.open(env.dir);
      await store.transact((draft) => {
        draft.agents['a1'] = {
          agentId: 'a1',
          generation: 0,
          autoActivation: 'enabled',
          revision: 0,
        };
      });
      const first = await store.commitStop({
        commandId: 'stop-1',
        requestedBy: { kind: 'user', id: 'owner' },
        scope: { kind: 'agent', agentId: 'a1' },
      });
      const second = await store.commitStop({
        commandId: 'stop-1',
        requestedBy: { kind: 'user', id: 'owner' },
        scope: { kind: 'agent', agentId: 'a1' },
      });
      assert.equal(first.stopId, second.stopId);
      assert.equal(store.snapshot().agents['a1']?.generation, 1);
      assert.equal(store.snapshot().agents['a1']?.autoActivation, 'paused');
    } finally {
      await env.cleanup();
    }
  });

  it('同 commandId 不同 scope 拒绝', async () => {
    const env = await tempDataDir('control-stop-conflict');
    try {
      const store = await RuntimeControlStore.open(env.dir);
      await store.transact((draft) => {
        draft.agents['a1'] = {
          agentId: 'a1',
          generation: 0,
          autoActivation: 'enabled',
          revision: 0,
        };
        draft.agents['a2'] = {
          agentId: 'a2',
          generation: 0,
          autoActivation: 'enabled',
          revision: 0,
        };
      });
      await store.commitStop({
        commandId: 'stop-x',
        requestedBy: { kind: 'user', id: 'owner' },
        scope: { kind: 'agent', agentId: 'a1' },
      });
      await assert.rejects(
        () =>
          store.commitStop({
            commandId: 'stop-x',
            requestedBy: { kind: 'user', id: 'owner' },
            scope: { kind: 'agent', agentId: 'a2' },
          }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'SCOPE_CONFLICT');
          return true;
        },
      );
    } finally {
      await env.cleanup();
    }
  });

  it('快照接近软阈值时拒绝新增 payload，停止仍可提交', async () => {
    const env = await tempDataDir('control-cap');
    try {
      const store = await RuntimeControlStore.open(env.dir, { softLimitBytes: 800 });
      await store.transact((draft) => {
        draft.agents['a1'] = {
          agentId: 'a1',
          generation: 0,
          autoActivation: 'enabled',
          revision: 0,
        };
      });
      await assert.rejects(
        () =>
          store.transact((draft) => {
            draft.payloads['big'] = 'x'.repeat(2000);
          }),
        /PAYLOAD_LIMIT|容量/,
      );
      const stop = await store.commitStop({
        commandId: 'stop-cap',
        requestedBy: { kind: 'user', id: 'owner' },
        scope: { kind: 'agent', agentId: 'a1' },
      });
      assert.ok(stop.stopId);
      assert.equal(store.snapshot().agents['a1']?.autoActivation, 'paused');
    } finally {
      await env.cleanup();
    }
  });

  it('损坏控制快照标记 faulted，禁止自动执行', async () => {
    const env = await tempDataDir('control-corrupt');
    try {
      await mkdir(join(env.dir, 'control'), { recursive: true });
      await writeFile(join(env.dir, 'control', 'state.json'), '{not-json', 'utf8');
      const store = await RuntimeControlStore.open(env.dir);
      assert.equal(store.faulted, true);
      assert.equal(store.allowsAutomaticExecution(), false);
    } finally {
      await env.cleanup();
    }
  });

  it('未实现的 stop scope 返回 UNSUPPORTED_STOP_SCOPE', async () => {
    const env = await tempDataDir('control-unsupported');
    try {
      const store = await RuntimeControlStore.open(env.dir);
      await assert.rejects(
        () =>
          store.commitStop({
            commandId: 'stop-all',
            requestedBy: { kind: 'user', id: 'owner' },
            scope: { kind: 'all_agents' },
          }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'UNSUPPORTED_STOP_SCOPE');
          return true;
        },
      );
    } finally {
      await env.cleanup();
    }
  });

  it('落盘文件权限受限', async () => {
    const env = await tempDataDir('control-mode');
    try {
      const store = await RuntimeControlStore.open(env.dir);
      await store.transact((draft) => {
        draft.agents['a1'] = {
          agentId: 'a1',
          generation: 0,
          autoActivation: 'enabled',
          revision: 0,
        };
      });
      const { stat } = await import('node:fs/promises');
      const info = await stat(join(env.dir, 'control', 'state.json'));
      assert.equal(info.mode & 0o777, 0o600);
      const raw = await readFile(join(env.dir, 'control', 'state.json'), 'utf8');
      assert.ok(JSON.parse(raw).controlSeq >= 1);
    } finally {
      await env.cleanup();
    }
  });
});
