import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DataDirLock, InstanceLockError, type InstanceLockInfo } from '../src/storage/instance-lock.js';
import { probeProcessIdentity } from '../src/storage/process-identity.js';
import { tempDataDir } from './fakes/test-env.js';

/**
 * 单实例锁的进程身份核对（E8.4）。
 *
 * 只认 pid 会在 PID 复用时误判：系统把旧 pid 发给另一个进程后，「pid 还活着」不再
 * 等于「旧调度器还活着」。这里覆盖四种判定：身份相符（占用）、身份不符（陈旧可接管）、
 * 没有身份字段（保守占用）、核对手段不可用（保守占用）。
 * 真子进程保证「pid 确实活着」是事实而不是假设。
 */

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withDecoy<T>(run: (decoy: ChildProcess, pid: number) => Promise<T>): Promise<T> {
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    return await run(decoy, decoy.pid!);
  } finally {
    decoy.kill('SIGKILL');
  }
}

/** 写一份「声称持有者是某个 pid」的锁文件，身份字段按用例伪造 */
async function writeLock(dir: string, info: Partial<InstanceLockInfo> & { pid: number }): Promise<void> {
  const payload: InstanceLockInfo = {
    pid: info.pid,
    startedAt: info.startedAt ?? Date.now() - 60_000,
    dataDir: dir,
    ...(info.processStartedAt !== undefined ? { processStartedAt: info.processStartedAt } : {}),
    ...(info.command !== undefined ? { command: info.command } : {}),
  };
  await writeFile(join(dir, 'agentbot.lock'), JSON.stringify(payload, null, 2), 'utf8');
}

describe('单实例锁的进程身份核对（E8.4，PID 复用不误判）', () => {
  it('伪造 PID 复用：锁里的 pid 活着但身份不符 → 不认为锁被占用，接管且不动那个进程', async () => {
    await withDecoy(async (_decoy, pid) => {
      const env = await tempDataDir('lock-pid-reuse');
      try {
        // 伪造现场：pid 写成一个**真实存在**的进程，但启动时刻与命令行都是「另一个程序」的——
        // 这正是 PID 复用后的样子（旧调度器的 pid 被系统发给了别人）
        await writeLock(env.dir, {
          pid,
          processStartedAt: Date.now() - 3 * 60 * 60 * 1000,
          command: 'node --import tsx src/server/main.ts --old-scheduler',
        });

        // 真实探测这个 pid：拿到的是 decoy 的身份，必然与伪造的记录不符
        const real = probeProcessIdentity(pid);
        assert.equal(real.supported, true);
        assert.ok(real.supported && real.fingerprint, 'decoy 的身份应读得到');
        assert.equal(isAlive(pid), true, '前提：这个 pid 确实是活的');

        const lock = new DataDirLock(env.dir);
        const info = await lock.acquire();
        assert.equal(info.pid, process.pid, 'PID 复用场景必须能接管，而不是误判锁被占用');
        assert.equal(lock.peek()?.pid, process.pid);
        assert.equal(lock.peek()?.command !== undefined, true, '接管后写的锁带自己的进程身份');
        assert.equal(isAlive(pid), true, '接管陈旧锁不能顺手去杀那个复用了 pid 的进程');

        await lock.release();
        assert.equal(lock.peek(), undefined);
      } finally {
        await env.cleanup();
      }
    });
  });

  it('同一 pid 但身份相符 → 仍然拒绝第二个调度器（单实例语义没被放松）', async () => {
    await withDecoy(async (_decoy, pid) => {
      const env = await tempDataDir('lock-identity-match');
      try {
        const real = probeProcessIdentity(pid);
        assert.ok(real.supported && real.fingerprint, 'decoy 的身份应读得到');
        const fingerprint = real.supported ? real.fingerprint! : {};
        // 身份字段与真实探测完全一致 = 这就是原来那个进程
        await writeLock(env.dir, {
          pid,
          processStartedAt: fingerprint.startedAt,
          command: fingerprint.command,
        });

        const lock = new DataDirLock(env.dir);
        await assert.rejects(
          lock.acquire(),
          (error: unknown) => {
            assert.ok(error instanceof InstanceLockError);
            assert.equal(error.holder.pid, pid);
            return true;
          },
          '身份核对通过就必须照旧拒绝',
        );

        // 身份相符的判定也要经得起「探测注入」这条路径：同样的记录交给会返回相符指纹的假探测
        const injected = new DataDirLock(env.dir, {
          probe: () => ({
            supported: true,
            fingerprint: { startedAt: fingerprint.startedAt, command: fingerprint.command },
          }),
        });
        await assert.rejects(injected.acquire(), (error: unknown) => error instanceof InstanceLockError);
      } finally {
        await env.cleanup();
      }
    });
  });

  it('旧格式锁（没有身份字段）遇到活 pid：保守拒绝，不因为「比不了」就放行', async () => {
    await withDecoy(async (_decoy, pid) => {
      const env = await tempDataDir('lock-legacy');
      try {
        await writeLock(env.dir, { pid }); // E8.4 之前的锁：只有 pid + startedAt
        const lock = new DataDirLock(env.dir);
        await assert.rejects(lock.acquire(), (error: unknown) => {
          assert.ok(error instanceof InstanceLockError);
          // 保守拒绝也要能操作：报错里给出判定依据和下一步（用户不必猜要杀谁）
          assert.match(error.reason ?? '', /没有进程身份字段/);
          assert.match(error.message, /ps -p/);
          assert.match(error.message, /agentbot\.lock/);
          return true;
        });
      } finally {
        await env.cleanup();
      }
    });
  });

  it('本机核对手段不可用（没有 ps/PowerShell）时保守拒绝，绝不放开双跑', async () => {
    await withDecoy(async (_decoy, pid) => {
      const env = await tempDataDir('lock-no-probe');
      try {
        await writeLock(env.dir, {
          pid,
          processStartedAt: Date.now() - 1000,
          command: 'node --import tsx src/server/main.ts',
        });
        const lock = new DataDirLock(env.dir, {
          probe: () => ({ supported: false, reason: '本机没有 ps' }),
        });
        await assert.rejects(lock.acquire(), (error: unknown) => error instanceof InstanceLockError);
      } finally {
        await env.cleanup();
      }
    });
  });

  it('核对手段可用但读不到该 pid 的身份：按陈旧锁接管（进程换了、权限也读不到）', async () => {
    await withDecoy(async (_decoy, pid) => {
      const env = await tempDataDir('lock-unreadable');
      try {
        await writeLock(env.dir, {
          pid,
          processStartedAt: Date.now() - 1000,
          command: 'node --import tsx src/server/main.ts',
        });
        // pid 活着（kill(pid,0) 通过），但探测返回 supported:true + 无指纹：
        // 原来那个进程能写进身份，说明现在这个 pid 上的东西不是它
        const lock = new DataDirLock(env.dir, { probe: () => ({ supported: true }) });
        const info = await lock.acquire();
        assert.equal(info.pid, process.pid);
        assert.equal(isAlive(pid), true, '接管时不能去动这个 pid');
      } finally {
        await env.cleanup();
      }
    });
  });
});
