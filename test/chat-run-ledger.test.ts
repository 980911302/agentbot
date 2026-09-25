import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatRunCoordinator } from '../src/server/runtime/chat-run-coordinator.js';
import { EventJournal } from '../src/server/events/journal.js';
import { tempDataDir } from './fakes/test-env.js';

/** OPT-01：账本异步落盘、已结束运行精简输入、幂等索引、旧格式兼容 */
const LONG = '长输入'.repeat(500); // 1500 字，超过保留上限 500

const userRun = (input: string, clientMessageId: string) => ({
  channelId: 'a',
  agentId: 'a',
  kind: 'agent' as const,
  source: 'user' as const,
  input,
  clientMessageId,
});

describe('聊天运行账本（OPT-01）', () => {
  it('重复 clientMessageId 走索引：同键同请求复用运行，同键不同请求报错，重启后仍认得', async () => {
    const env = await tempDataDir('chat-ledger-dup');
    try {
      const first = new ChatRunCoordinator(env.dir, new EventJournal());
      const accepted = await first.prepare(userRun('任务', 'k1'));
      const duplicate = await first.prepare(userRun('任务', 'k1'));
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.run.runId, accepted.run.runId);
      assert.equal(first.list().length, 1, '重复请求不该产生第二条记录');
      await assert.rejects(() => first.prepare(userRun('换个说法', 'k1')), /同一个 clientMessageId/);

      // 索引在重启后从文件重建
      const second = new ChatRunCoordinator(env.dir, new EventJournal());
      const again = await second.prepare(userRun('任务', 'k1'));
      assert.equal(again.duplicate, true);
      assert.equal(again.run.runId, accepted.run.runId);
      // 不同频道的同一个键互不影响
      const other = await second.prepare({ ...userRun('任务', 'k1'), channelId: 'b', agentId: 'b' });
      assert.equal(other.duplicate, false);
    } finally {
      await env.cleanup();
    }
  });

  it('旧格式账本能读：活动运行标中断、历史与中断记录当场精简', async () => {
    const env = await tempDataDir('chat-ledger-old');
    try {
      await mkdir(join(env.dir, 'chat'), { recursive: true });
      await writeFile(
        join(env.dir, 'chat', 'runs.json'),
        JSON.stringify({
          version: 1,
          runs: [
            {
              runId: 'old-active',
              taskId: 'old-active',
              channelId: 'a',
              agentId: 'a',
              kind: 'agent',
              source: 'user',
              input: LONG,
              status: 'running',
              createdAt: 1,
              updatedAt: 2,
            },
            {
              runId: 'old-done',
              taskId: 'old-done',
              channelId: 'a',
              agentId: 'a',
              kind: 'agent',
              source: 'user',
              input: LONG,
              status: 'succeeded',
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        }),
      );
      const coordinator = new ChatRunCoordinator(env.dir, new EventJournal());
      const active = coordinator.get('old-active')!;
      assert.equal(active.status, 'interrupted');
      assert.match(active.error ?? '', /已中断/);
      assert.equal(active.input.length, 500, '启动时就中断的运行也按终态精简');
      assert.equal(active.inputLength, LONG.length);
      const done = coordinator.get('old-done')!;
      assert.equal(done.input.length, 500);
      assert.equal(done.inputLength, LONG.length);
      // 回写也精简了（旧文件里的长正文不会一直躺着）
      await coordinator.prepare(userRun('写一次触发落盘', 'k-old'));
      const saved = JSON.parse(readFileSync(join(env.dir, 'chat', 'runs.json'), 'utf8')) as {
        runs: Array<{ runId: string; input: string; inputLength?: number }>;
      };
      const persisted = saved.runs.find((run) => run.runId === 'old-done')!;
      assert.equal(persisted.input.length, 500);
      assert.equal(persisted.inputLength, LONG.length);
    } finally {
      await env.cleanup();
    }
  });

  it('运行结束后只留前 500 字 + 原始长度，落盘与读取都正常', async () => {
    const env = await tempDataDir('chat-ledger-trim');
    try {
      const coordinator = new ChatRunCoordinator(env.dir, new EventJournal());
      const { run } = await coordinator.prepare(userRun(LONG, 'k2'));
      assert.equal(coordinator.get(run.runId)!.input, LONG, '运行中保留完整输入');

      await coordinator.execute(
        run.runId,
        async () => ({ ok: true }),
        () => ({}),
      );
      const done = coordinator.get(run.runId)!;
      assert.equal(done.status, 'succeeded');
      assert.equal(done.input.length, 500);
      assert.equal(done.inputLength, LONG.length);

      const file = JSON.parse(await readFile(join(env.dir, 'chat', 'runs.json'), 'utf8')) as {
        runs: Array<{ runId: string; input: string; inputLength?: number }>;
      };
      const saved = file.runs.find((item) => item.runId === run.runId)!;
      assert.equal(saved.input.length, 500);
      assert.equal(saved.inputLength, LONG.length);
      assert.equal(coordinator.list().length, 1);
    } finally {
      await env.cleanup();
    }
  });

  it('失败与中断同样只留前 500 字（重试文案从对话消息取，不靠账本）', async () => {
    const env = await tempDataDir('chat-ledger-retry');
    try {
      const coordinator = new ChatRunCoordinator(env.dir, new EventJournal());
      const { run } = await coordinator.prepare(userRun(LONG, 'k4'));
      await coordinator.fail(run.runId, new Error('模型不可用'));
      const failed = coordinator.get(run.runId)!;
      assert.equal(failed.status, 'failed');
      assert.equal(failed.input.length, 500);
      assert.equal(failed.inputLength, LONG.length);
      // 中断（进程退出）同理：重启后也只留摘要
      const restarted = new ChatRunCoordinator(env.dir, new EventJournal());
      const { run: pending } = await restarted.prepare(userRun(LONG, 'k5'));
      const afterRestart = new ChatRunCoordinator(env.dir, new EventJournal());
      assert.equal(afterRestart.get(pending.runId)?.status, 'interrupted');
      assert.equal(afterRestart.get(pending.runId)?.input.length, 500);
      assert.equal(afterRestart.get(pending.runId)?.inputLength, LONG.length);
      // 幂等指纹仍然完整：同键不同请求照样报错
      await assert.rejects(() => afterRestart.prepare(userRun('换个说法', 'k5')), /同一个 clientMessageId/);
    } finally {
      await env.cleanup();
    }
  });

  it('挂起的运行保留完整输入（要继续跑，不能只留摘要）', async () => {
    const env = await tempDataDir('chat-ledger-parked');
    try {
      const coordinator = new ChatRunCoordinator(env.dir, new EventJournal());
      const { run } = await coordinator.prepare(userRun(LONG, 'k6'));
      await coordinator.execute(
        run.runId,
        async () => ({}),
        () => ({ stopReason: 'parked' }),
      );
      const parked = coordinator.get(run.runId)!;
      assert.equal(parked.status, 'parked');
      assert.equal(parked.input, LONG);
      assert.equal(parked.inputLength, undefined);
    } finally {
      await env.cleanup();
    }
  });

  it('发布前已落盘：queued 事件发出时账本里已经有这条运行', async () => {
    const env = await tempDataDir('chat-ledger-order');
    try {
      const journal = new EventJournal();
      const coordinator = new ChatRunCoordinator(env.dir, journal);
      let persistedAtPublish: boolean | null = null;
      journal.subscribe(() => {
        const doc = JSON.parse(readFileSync(join(env.dir, 'chat', 'runs.json'), 'utf8')) as {
          runs: Array<{ status: string }>;
        };
        persistedAtPublish = doc.runs.some((item) => item.status === 'queued');
      });
      await coordinator.prepare(userRun('任务', 'k3'));
      assert.equal(persistedAtPublish, true, 'queued 事件发布时运行必须已经落盘');
    } finally {
      await env.cleanup();
    }
  });
});
