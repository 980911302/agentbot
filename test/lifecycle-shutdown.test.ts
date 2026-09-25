import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runShutdownSequence, type ShutdownStep } from '../src/server/lifecycle.js';
import { MessageStore } from '../src/store/messages.js';
import { BackgroundProcesses } from '../src/tools/services/background-processes.js';
import type { Message } from '../src/agent/types.js';
import { sleep, tempDataDir, waitFor } from './fakes/test-env.js';

/**
 * 优雅停机的顺序（E8.4）：停新工作 → 检查点 → 终止后台进程 → 关存储 → 放锁。
 *
 * 顺序不是文档承诺，而是可断言的事实：
 *   - 检查点里必须还有「终止之前」的后台进程（先杀后写就只剩一份猜）；
 *   - 检查点里 `acceptingNewWork` 必须已经是 false（证明停新工作在写检查点之前真的发生了）；
 *   - close_storage 之前的写入必须已经落盘，且 release_lock 是最后一步。
 * 背景进程用真子进程，终止是不是真发生由内核回答（kill(pid,0)）。
 */

const STEPS = ['stop_accepting', 'checkpoint', 'terminate_background', 'close_storage', 'release_lock'];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readSteps(dataDir: string): ShutdownStep[] {
  return readFileSync(join(dataDir, 'lifecycle', 'shutdown-steps.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ShutdownStep);
}

function message(id: string, text: string): Message {
  return {
    id,
    agentId: 'owner',
    role: 'user',
    content: { type: 'text', text },
    createdAt: Date.now(),
    source: 'user',
  } as Message;
}

describe('停机顺序（E8.4）', () => {
  it('五步按序执行：检查点在终止之前，放锁在最后；后台进程真的被终止、写入真的落盘', async () => {
    const env = await tempDataDir('shutdown-order');
    // 真子进程当后台 Shell：终止是不是真发生，由内核回答
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const childPid = child.pid!;
    try {
      const background = new BackgroundProcesses();
      background.track({
        kind: 'shell',
        id: 'shell-1',
        label: 'sleep 300',
        kill: () => child.kill('SIGKILL'),
      });

      const messages = new MessageStore(env.dir);
      await messages.append(message('m-1', '停机之前写的一条消息'));

      let accepting = true;
      const releases: string[] = [];
      const report = await runShutdownSequence({
        reason: 'test',
        dataDir: env.dir,
        background,
        acceptingNewWork: () => accepting,
        stopAcceptingNewWork: () => {
          accepting = false;
        },
        closeStorage: () => messages.close(),
        releaseLock: () => {
          releases.push('release_lock');
        },
        lockSnapshot: () => ({ pid: process.pid, startedAt: Date.now(), dataDir: env.dir }),
        log: () => undefined,
      });

      // ① 顺序：台账与返回值都是这五步，一步不跳、一步不换位
      assert.deepEqual(
        report.steps.map((step) => step.step),
        STEPS,
      );
      assert.deepEqual(
        readSteps(env.dir).map((step) => step.step),
        STEPS,
        '停机台账写在磁盘上，事后可查',
      );
      assert.deepEqual(
        report.steps.filter((step) => step.error),
        [],
        '测试场景里不该有失败步骤',
      );
      assert.deepEqual(releases, ['release_lock'], '放锁必须发生，且是最后一步');

      // ② 检查点是在终止之前写的：清单里还有那个后台进程（日志里也不会出现「清单为空」的错）
      const checkpoint = JSON.parse(readFileSync(join(env.dir, 'lifecycle', 'shutdown.json'), 'utf8')) as {
        acceptingNewWork: boolean;
        background: Array<{ kind: string; id: string }>;
        lock?: { pid: number };
      };
      assert.equal(checkpoint.acceptingNewWork, false, '写检查点时已经不再接新工作');
      assert.deepEqual(
        checkpoint.background.map((entry) => `${entry.kind}:${entry.id}`),
        ['shell:shell-1'],
        '检查点记的是终止之前真实在跑的后台进程',
      );
      assert.equal(checkpoint.lock?.pid, process.pid, '检查点带上锁记录，重启可核对');

      // ③ 后台进程真的被终止（先发信号，进程真正退出是随后的事）
      assert.equal(report.background.failures.length, 0);
      assert.deepEqual(
        report.background.terminated.map((entry) => entry.id),
        ['shell-1'],
      );
      await waitFor(() => !isAlive(childPid), '后台进程被终止');
      assert.equal(background.runningCount(), 0, '停机后登记簿里不该还留着后台进程');

      // ④ 关存储之前的写入已经落盘（放锁前保证数据持久）
      const lines = readFileSync(join(env.dir, 'messages', 'owner.jsonl'), 'utf8')
        .trim()
        .split('\n');
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /停机之前写的一条消息/);
    } finally {
      if (isAlive(childPid)) child.kill('SIGKILL');
      await env.cleanup();
    }
  });

  it('某一步失败不阻断后面的步骤：放锁照走，失败如实留痕', async () => {
    const env = await tempDataDir('shutdown-step-failure');
    try {
      const background = new BackgroundProcesses();
      let released = false;
      const report = await runShutdownSequence({
        reason: 'test',
        dataDir: env.dir,
        background,
        acceptingNewWork: () => false,
        stopAcceptingNewWork: () => undefined,
        closeStorage: () => {
          throw new Error('存储收尾失败（测试构造）');
        },
        releaseLock: () => {
          released = true;
        },
        log: () => undefined,
      });

      assert.deepEqual(
        report.steps.map((step) => step.step),
        STEPS,
        '失败也要留下后续步骤的痕迹',
      );
      assert.match(report.steps.find((step) => step.step === 'close_storage')?.error ?? '', /存储收尾失败/);
      assert.equal(released, true, '存储收尾失败也必须把锁放掉，否则下次启动要等进程被判死');
      assert.equal(report.steps.find((step) => step.step === 'release_lock')?.error, undefined);
    } finally {
      await env.cleanup();
    }
  });

  it('停机收尾期间新起的后台进程也会被清掉（收尾之后再补一次清场）', async () => {
    const env = await tempDataDir('shutdown-late-background');
    const late = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const latePid = late.pid!;
    try {
      const background = new BackgroundProcesses();
      await runShutdownSequence({
        reason: 'test',
        dataDir: env.dir,
        background,
        acceptingNewWork: () => false,
        stopAcceptingNewWork: () => undefined,
        closeStorage: async () => {
          // 收尾在飞回合时才冒出来的后台进程：不能在停机后留下孤儿
          background.track({
            kind: 'worker',
            id: 'late-1',
            label: '收尾期间新起的工人',
            kill: () => late.kill('SIGKILL'),
          });
          await sleep(10);
        },
        releaseLock: () => undefined,
        log: () => undefined,
      });
      await waitFor(() => !isAlive(latePid), '收尾期间新起的后台进程也被清掉');
      assert.equal(background.runningCount(), 0);
    } finally {
      if (isAlive(latePid)) late.kill('SIGKILL');
      await env.cleanup();
    }
  });
});
