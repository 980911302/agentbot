import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * 数据目录单实例锁（E3.6）：同一份数据只允许一个后端/调度器。
 *
 * 锁文件记 pid 与取得时间：持有者活着就拒绝第二份（明确报错，不静默并跑）；
 * 崩溃留下的锁在进程消失后被接管，不会永久卡住启动。
 * 同一进程重复取得视为同一持有者（测试/多次装配不互锁）。
 */
export interface InstanceLockInfo {
  pid: number;
  startedAt: number;
  dataDir: string;
}

export class InstanceLockError extends Error {
  constructor(readonly holder: InstanceLockInfo) {
    super(
      `数据目录正被另一个 AgentBot 进程使用（pid ${holder.pid}，取得于 ${new Date(holder.startedAt).toISOString()}）。` +
        '同一份数据只能跑一个调度器；确认那个进程已经退出后重试。',
    );
    this.name = 'InstanceLockError';
  }
}

/** 同一进程内的持有计数（多次装配同一份数据不互锁，最后一个释放才解锁） */
const holds = new Map<string, number>();

export class DataDirLock {
  private readonly file: string;
  private held = false;

  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, 'agentbot.lock');
  }

  async acquire(): Promise<InstanceLockInfo> {
    const existing = this.read();
    if (existing && existing.pid !== process.pid && this.alive(existing.pid)) {
      throw new InstanceLockError(existing);
    }
    if (existing && existing.pid === process.pid) {
      // 同一进程里的第二次装配：锁是这个进程的，记账后直接复用
      holds.set(this.file, (holds.get(this.file) ?? 0) + 1);
      this.held = true;
      return existing;
    }

    const info: InstanceLockInfo = { pid: process.pid, startedAt: Date.now(), dataDir: this.dataDir };
    const payload = JSON.stringify(info, null, 2);
    await mkdir(dirname(this.file), { recursive: true });
    try {
      await writeFile(this.file, payload, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // 竞态：读完之后、写之前被别人抢先
      const holder = this.read();
      if (holder && holder.pid !== process.pid && this.alive(holder.pid)) {
        throw new InstanceLockError(holder);
      }
      await writeFile(this.file, payload, 'utf8');
    }
    holds.set(this.file, 1);
    this.held = true;
    return info;
  }

  /** 只释放自己持有的份额；同进程最后一个持有者才真正解锁 */
  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    const remaining = Math.max(0, (holds.get(this.file) ?? 1) - 1);
    if (remaining > 0) {
      holds.set(this.file, remaining);
      return;
    }
    holds.delete(this.file);
    if (this.read()?.pid === process.pid) {
      await rm(this.file, { force: true }).catch(() => undefined);
    }
  }

  /** 当前锁记录（可能属于已经死掉的进程） */
  peek(): InstanceLockInfo | undefined {
    return this.read();
  }

  private read(): InstanceLockInfo | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as InstanceLockInfo;
      return typeof parsed?.pid === 'number' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM：进程存在但没有信号权限，同样算活着
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}
