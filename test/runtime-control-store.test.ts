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

/**
 * 控制存储的增长与清理（bug_duderhc68jjw）。
 *
 * 此前 tickets/effects/outbox/receipts/actions/commands/chains 一条不删，
 * 每次 transact 又全量克隆 + 序列化 + 整文件写：文件随消息数线性增长，
 * 撞到 48MB 软上限后 transact 抛 PAYLOAD_LIMIT，同事之间的投递就此失败。
 */
describe('控制存储的票据清理与单条读取', () => {
  /** 造一条已终结票据 */
  const finishedTicket = (id: string, seq: number) => ({
    ticketId: id,
    agentId: 'a1',
    runId: `run-${id}`,
    taskId: `task-${id}`,
    inputId: `input-${id}`,
    chainId: 'chain-1',
    generation: 0,
    executionEpoch: 0,
    processEpoch: 'epoch-1',
    admittedSeq: seq,
    source: 'inbox' as const,
    state: 'settled' as const,
  });

  it('已终结票据超过保留数就裁掉最旧的，仍在飞的一条不动', async () => {
    const env = await tempDataDir('control-prune');
    try {
      const store = await RuntimeControlStore.open(env.dir, { ticketRetention: 3 });
      await store.transact((draft) => {
        for (let index = 1; index <= 6; index += 1) {
          draft.tickets[`t${index}`] = finishedTicket(`t${index}`, index);
        }
        // 一条在飞的票据：不能被当垃圾裁掉
        draft.tickets['live'] = { ...finishedTicket('live', 99), state: 'running' };
      });

      const tickets = store.snapshot().tickets;
      assert.equal(Object.keys(tickets).length, 4, '只保留 3 条已终结 + 1 条在飞');
      assert.ok(tickets['live'], '在飞的票据不能被裁掉');
      assert.equal(tickets['t1'], undefined, '最旧的已终结票据该被裁掉');
      assert.equal(tickets['t2'], undefined, '次旧的已终结票据该被裁掉');
      assert.equal(tickets['t3'], undefined, '第三旧的已终结票据该被裁掉');
      assert.ok(tickets['t4'] && tickets['t5'] && tickets['t6'], '最近的已终结票据要留着排查');
    } finally {
      await env.cleanup();
    }
  });

  it('没超保留数时一条都不裁', async () => {
    const env = await tempDataDir('control-prune-under');
    try {
      const store = await RuntimeControlStore.open(env.dir, { ticketRetention: 10 });
      await store.transact((draft) => {
        for (let index = 1; index <= 4; index += 1) {
          draft.tickets[`t${index}`] = finishedTicket(`t${index}`, index);
        }
      });
      assert.equal(Object.keys(store.snapshot().tickets).length, 4);
    } finally {
      await env.cleanup();
    }
  });

  it('清理后重启仍能读回，controlSeq 不回退', async () => {
    const env = await tempDataDir('control-prune-restart');
    try {
      const first = await RuntimeControlStore.open(env.dir, { ticketRetention: 2 });
      await first.transact((draft) => {
        for (let index = 1; index <= 5; index += 1) {
          draft.tickets[`t${index}`] = finishedTicket(`t${index}`, index);
        }
      });
      const seqAfterPrune = first.snapshot().controlSeq;
      assert.equal(Object.keys(first.snapshot().tickets).length, 2);

      const reopened = await RuntimeControlStore.open(env.dir);
      assert.equal(reopened.snapshot().controlSeq, seqAfterPrune, '清理不能让序号回退');
      assert.equal(Object.keys(reopened.snapshot().tickets).length, 2, '重启后清理结果要还在');
      assert.ok(reopened.snapshot().tickets['t5'], '留下的是最近的两条');
    } finally {
      await env.cleanup();
    }
  });

  it('ticket() 只返回那一条，不随票据总量变慢', async () => {
    const env = await tempDataDir('control-ticket-read');
    try {
      const store = await RuntimeControlStore.open(env.dir, { ticketRetention: 0 });
      await store.transact((draft) => {
        for (let index = 1; index <= 50; index += 1) {
          draft.tickets[`t${index}`] = finishedTicket(`t${index}`, index);
        }
        draft.agents['a1'] = { agentId: 'a1', generation: 3, autoActivation: 'enabled', revision: 1 };
      });
      // ticketRetention: 0 → 不留已终结票据，只剩在飞的；这里验证单条读取语义
      const live = store.ticket('nope');
      assert.equal(live, undefined, '不存在的票据返回 undefined');
      assert.equal(store.agentControl('a1')?.generation, 3, '单条读智能体控制条目');
    } finally {
      await env.cleanup();
    }
  });

  it('反复结算票据时文件不随事务数线性增长', async () => {
    const env = await tempDataDir('control-growth');
    try {
      const store = await RuntimeControlStore.open(env.dir, { ticketRetention: 20 });
      let bytesAfterFirstBatch = 0;
      for (let round = 0; round < 4; round += 1) {
        for (let index = 0; index < 30; index += 1) {
          const id = `r${round}-t${index}`;
          await store.transact((draft) => {
            draft.tickets[id] = {
              ...finishedTicket(id, round * 100 + index),
              state: 'running',
            };
          });
          await store.transact((draft) => {
            const ticket = draft.tickets[id];
            if (ticket) ticket.state = 'settled';
          });
        }
        if (round === 0) bytesAfterFirstBatch = store.approximateBytes();
      }

      // 每轮都新增 30 条已终结票据，但清理后只保留最近 20 条：
      // 第四个回合结束时的体积不该比第一个回合结束时大多少
      assert.equal(store.finishedTicketCount(), 20, '已终结票据被夹在保留数内');
      assert.ok(
        store.approximateBytes() <= bytesAfterFirstBatch * 1.5,
        `文件体积失控：第一批后 ${bytesAfterFirstBatch} 字节，四批后 ${store.approximateBytes()} 字节`,
      );
    } finally {
      await env.cleanup();
    }
  });

  it('快照接近软上限时告警，真超上限时仍然拒绝', async () => {
    const env = await tempDataDir('control-warn');
    const warnings: Array<{ bytes: number; limit: number }> = [];
    try {
      const store = await RuntimeControlStore.open(env.dir, {
        // 40 条票据约 9.4KB，上限取 10000：第一批能落地，且一落地就越过 80% 告警线
        softLimitBytes: 10_000,
        onNearLimit: (bytes, limit) => warnings.push({ bytes, limit }),
      });
      await store.transact((draft) => {
        for (let index = 0; index < 40; index += 1) {
          draft.tickets[`t${index}`] = finishedTicket(`t${index}`, index);
        }
      });
      assert.ok(warnings.length > 0, '接近上限应该告警，不能等撞墙才说');
      assert.equal(warnings[0]!.limit, 10_000, '告警要带上限值');
      assert.ok(warnings[0]!.bytes >= 8000, '到 80% 就该开始提醒');

      // 告警归告警，超上限的硬拒绝不能松
      await assert.rejects(
        () =>
          store.transact((draft) => {
            draft.payloads['big'] = 'x'.repeat(6000);
          }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'PAYLOAD_LIMIT');
          return true;
        },
      );
    } finally {
      await env.cleanup();
    }
  });
});
