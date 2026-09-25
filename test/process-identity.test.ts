import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { normalizeCommand, probeProcessIdentity } from '../src/storage/process-identity.js';

/**
 * 进程身份指纹（E8.4）：重启核对锁记录时靠它回答「这个 pid 现在还是不是原来那个进程」。
 * 只依赖系统自带的 ps（POSIX）/ PowerShell（Windows），不引入新依赖。
 */

const POSIX = process.platform !== 'win32';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('进程身份探测（E8.4）', () => {
  it('能读出自己进程的启动时刻与命令行', () => {
    const probe = probeProcessIdentity(process.pid);
    assert.equal(probe.supported, true);
    const fingerprint = probe.supported ? probe.fingerprint : undefined;
    assert.ok(fingerprint, '自己的进程身份必须读得到');

    const elapsed = Date.now() - (fingerprint.startedAt ?? 0);
    // lstart 是秒级精度（截断到秒，所以只会偏早），测试进程刚起来，误差应该在分钟级以内
    assert.ok(elapsed >= 0 && elapsed < 120_000, `启动时刻应该接近现在，实际差了 ${elapsed}ms`);

    const command = fingerprint.command ?? '';
    assert.ok(command.length > 0, '命令行特征不能为空');
    if (POSIX) assert.match(command, /node/, `命令行里应能认出 node：${command}`);
  });

  it('进程不存在时返回「没有身份」而不是探测失败', () => {
    // 起一个立刻退出的进程，拿它已经消失的 pid 当样本（比硬编码一个 pid 稳）
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const pid = dead.pid!;
    return new Promise<void>((done) => {
      dead.once('exit', () => {
        if (isAlive(pid)) {
          done(); // 极端情况下 pid 已被复用，这一轮跳过（不是被测逻辑的问题）
          return;
        }
        const probe = probeProcessIdentity(pid);
        assert.equal(probe.supported, true, '目标进程不存在不等于探测手段不可用');
        assert.equal(probe.supported && probe.fingerprint, undefined, '查不到就如实返回空，供调用方保守处理');
        done();
      });
    });
  });

  it('非法 pid 明确报「探测不可用」，让调用方保守处理', () => {
    const probe = probeProcessIdentity(-1);
    assert.equal(probe.supported, false);
    assert.match(probe.supported ? '' : probe.reason, /pid/);
  });

  it('命令行比对前折叠空白（ps 的列对齐会产生连续空格）', () => {
    assert.equal(
      normalizeCommand('  node   --import   tsx   src/index.ts '),
      'node --import tsx src/index.ts',
    );
    assert.notEqual(normalizeCommand('node a.ts'), normalizeCommand('node b.ts'));
  });
});
