import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { StopCoordinator } from '../src/server/runtime/stop-coordinator.js';
import { tempDataDir } from './fakes/test-env.js';

function makeCoordinator() {
  return new StopCoordinator({
    registry: null as never,
    messages: null as never,
    inbox: null as never,
    rooms: null as never,
    broker: null as never,
    ledger: null as never,
    pendingStops: new Map(),
    stopWords: ['停'],
    stopAckTimeoutMs: 60_000,
  });
}

describe('stop-ack 登记表', () => {
  it('收件方确认 ack 后等待方立即返回，不等满超时', async () => {
    const coordinator = makeCoordinator();
    const started = Date.now();
    const waiting = (coordinator as unknown as {
      awaitStopAcks: (agentId: string, children: Array<{ agentId: string; treeId: string }>, timeoutMs: number) => Promise<void>;
    }).awaitStopAcks('parent', [{ agentId: 'kid', treeId: 't1' }], 60_000);
    // 模拟收件方的 inbox 处理器确认了一条 stop-ack
    coordinator.noteStopAck('parent', 'kid', 't1');
    await waiting;
    assert.ok(Date.now() - started < 5_000, '应按登记立即返回，而不是等满 60s 超时');
  });

  it('没有等到 ack 时按超时收尾，且不留下等待态', async () => {
    const coordinator = makeCoordinator();
    const started = Date.now();
    await (coordinator as unknown as {
      awaitStopAcks: (agentId: string, children: Array<{ agentId: string; treeId: string }>, timeoutMs: number) => Promise<void>;
    }).awaitStopAcks('parent', [{ agentId: 'kid', treeId: 't1' }], 120);
    assert.ok(Date.now() - started >= 100, '应按超时等待');
    const map = (coordinator as unknown as { awaitingAcks: Map<string, Set<string>> }).awaitingAcks;
    assert.equal(map.size, 0, '等待态必须清理，否则内存泄漏');
  });

  it('乱到的 ack（没有人在等）被忽略，不会堆积', () => {
    const coordinator = makeCoordinator();
    coordinator.noteStopAck('parent', 'ghost', 't9');
    const map = (coordinator as unknown as { awaitingAcks: Map<string, Set<string>> }).awaitingAcks;
    assert.equal(map.size, 0);
  });
});
