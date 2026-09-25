import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  normalizeCommand,
  probeProcessIdentity,
  type ProcessFingerprint,
  type ProcessIdentityProbe,
} from './process-identity.js';

/**
 * 数据目录单实例锁（E3.6，E8.4 加进程身份）。
 *
 * 锁文件记 pid、取得时间与**进程身份**（启动时刻 + 命令行特征）：持有者活着就拒绝第二份
 * （明确报错，不静默并跑）；崩溃留下的锁在进程消失后被接管，不会永久卡住启动。
 * 同一进程重复取得视为同一持有者（测试/多次装配不互锁）。
 *
 * E8.4：只认 pid 会在 PID 复用时误判——旧 pid 被系统发给别的进程后，「pid 活着」不再等于
 * 「旧调度器还活着」。现在重启核对身份：身份不符（PID 复用）按陈旧锁接管，并且**不拿旧 pid
 * 去动任何进程**。核对不到的分寸见 judge()。
 */
export interface InstanceLockInfo {
  pid: number;
  /** 取得锁的时刻（不是进程启动时刻，沿用 E3.6 语义：报错文案与人工核对用） */
  startedAt: number;
  dataDir: string;
  /** E8.4：持有者进程的启动时刻（epoch ms），核对进程身份用 */
  processStartedAt?: number;
  /** E8.4：持有者进程的命令行特征，核对进程身份用 */
  command?: string;
}

export class InstanceLockError extends Error {
  constructor(
    readonly holder: InstanceLockInfo,
    /** 判定依据（E8.4）：为什么认为这个 pid 还是原来那个调度器 */
    readonly reason?: string,
  ) {
    const identity = holder.command
      ? `，进程启动于 ${holder.processStartedAt ? new Date(holder.processStartedAt).toISOString() : '未知时间'}，命令 ${holder.command}`
      : '';
    // 核对不到（没有 ps、旧格式锁）时不能只报「被占用」：用户需要知道该去看什么
    super(
      `数据目录正被另一个 AgentBot 进程使用（pid ${holder.pid}，取得于 ${new Date(holder.startedAt).toISOString()}${identity}）。` +
        (reason ? `判定依据：${reason}。` : '') +
        '同一份数据只能跑一个调度器；先确认那个 pid 是不是 AgentBot（例如 ps -p ' +
        `${holder.pid} -o command=），确认它已经退出后重试；` +
        `若确认它不是 AgentBot，删掉 ${join(holder.dataDir, 'agentbot.lock')} 再启动。`,
    );
    this.name = 'InstanceLockError';
  }
}

/** 同一进程内的持有计数（多次装配同一份数据不互锁，最后一个释放才解锁） */
const holds = new Map<string, number>();

/** ps 的 lstart 只有秒级精度；进程可能在秒级窗口内被复用，所以还要比命令行 */
const START_TOLERANCE_MS = 2000;

export interface DataDirLockOptions {
  /** 测试注入：默认用 ps / PowerShell 探测真实进程身份 */
  probe?: (pid: number) => ProcessIdentityProbe;
}

/** 对锁记录的判定：我的 / 确实被别人占着 / 陈旧可接管 */
type LockVerdict = 'mine' | 'occupied' | 'stale';

export class DataDirLock {
  private readonly file: string;
  private readonly probe: (pid: number) => ProcessIdentityProbe;
  private held = false;
  /** 自己的身份探测结果（判定与写锁共用一次探测） */
  private selfProbe?: ProcessIdentityProbe;
  /** 上一次判定的依据（陈旧锁写进日志避免「悄悄双跑」；占用则写进报错让用户可查） */
  private lastReason?: string;

  constructor(
    private readonly dataDir: string,
    options: DataDirLockOptions = {},
  ) {
    this.file = join(dataDir, 'agentbot.lock');
    this.probe = options.probe ?? probeProcessIdentity;
  }

  async acquire(): Promise<InstanceLockInfo> {
    const existing = this.read();
    // 一次 acquire 里同一份陈旧记录只提示一次（EEXIST 竞态分支会再判一次）
    let warnedStale = false;
    const warnOnce = (info: InstanceLockInfo): void => {
      if (warnedStale) return;
      warnedStale = true;
      warnStale(info, this.lastReason);
    };
    if (existing) {
      const verdict = this.judge(existing);
      if (verdict === 'mine') {
        // 同一进程里的第二次装配：锁是这个进程的，记账后直接复用
        holds.set(this.file, (holds.get(this.file) ?? 0) + 1);
        this.held = true;
        return existing;
      }
      if (verdict === 'occupied') throw new InstanceLockError(existing, this.lastReason);
      warnOnce(existing);
    }

    const info = this.mine();
    const payload = JSON.stringify(info, null, 2);
    await mkdir(dirname(this.file), { recursive: true });
    try {
      await writeFile(this.file, payload, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // 竞态：读完之后、写之前被别人抢先
      const holder = this.read();
      if (holder) {
        const verdict = this.judge(holder);
        if (verdict === 'occupied') throw new InstanceLockError(holder, this.lastReason);
        if (verdict === 'stale') warnOnce(holder);
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

  /** 本进程要写进锁文件的记录：pid + 取得时间 + 自己的进程身份 */
  private mine(): InstanceLockInfo {
    const identity = this.probeSelf();
    const fingerprint: ProcessFingerprint = identity.supported ? (identity.fingerprint ?? {}) : {};
    return {
      pid: process.pid,
      startedAt: Date.now(),
      dataDir: this.dataDir,
      ...(fingerprint.startedAt !== undefined ? { processStartedAt: fingerprint.startedAt } : {}),
      ...(fingerprint.command ? { command: fingerprint.command } : {}),
    };
  }

  private probeSelf(): ProcessIdentityProbe {
    this.selfProbe ??= this.probe(process.pid);
    return this.selfProbe;
  }

  /**
   * 判定现有锁记录。分寸（E8.4 的核心）：
   *   - pid 不是自己的、进程也没了 → 陈旧（崩溃留下的，照 E3.6 接管）；
   *   - 有身份字段但**核不上**（启动时刻或命令行不符，或活着却查不到身份）→ 陈旧（PID 复用）；
   *   - 没有身份字段（升级前的旧锁格式）→ 占用。缺依据时保守，宁可让用户看到报错，
   *     也不能因为「比不了」就放两个调度器进同一份数据；
   *   - 本机没有可用的核对手段（没有 ps / 没有 PowerShell）→ 占用，理由同上。
   */
  private judge(info: InstanceLockInfo): LockVerdict {
    this.lastReason = undefined;
    const hasIdentity = typeof info.processStartedAt === 'number' || Boolean(info.command);
    if (info.pid === process.pid) return this.judgeSelf(info, hasIdentity);
    if (!this.alive(info.pid)) {
      this.lastReason = '持有者进程已经退出';
      return 'stale';
    }
    if (!hasIdentity) {
      this.lastReason = '锁记录没有进程身份字段（升级前的旧格式），只能按 pid 存活判断';
      return 'occupied';
    }
    const probe = this.probe(info.pid);
    if (!probe.supported) {
      this.lastReason = probe.reason;
      return 'occupied';
    }
    if (!probe.fingerprint) {
      // 进程还在，但连身份都读不到：原来那个进程是能读到的，所以这不是它
      this.lastReason = 'pid 还活着但读不到进程身份（权限或 PID 复用）';
      return 'stale';
    }
    if (sameProcess(info, probe.fingerprint)) {
      this.lastReason = '进程身份与锁记录一致';
      return 'occupied';
    }
    this.lastReason = 'pid 相同但进程身份不符（PID 被复用）';
    return 'stale';
  }

  /**
   * 锁记录的 pid 就是自己：多数情况是同一进程的第二次装配（复用，不互锁）。
   * 但「pid 相同」也可能来自「上一个进程已死、系统把它的 pid 发给了我」——
   * 这时记录里的身份是死者的，必须核对后覆盖，否则别的进程会拿着我们的 pid
   * 核出身份不符、把锁判成陈旧，于是两份调度器同时跑。
   */
  private judgeSelf(info: InstanceLockInfo, hasIdentity: boolean): LockVerdict {
    if (!hasIdentity) return 'mine';
    const probe = this.probeSelf();
    if (!probe.supported || !probe.fingerprint) return 'mine';
    if (sameProcess(info, probe.fingerprint)) return 'mine';
    this.lastReason = '锁记录的 pid 与本人相同但身份不符（PID 从已退出的进程复用过来）';
    return 'stale';
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

/** 启动时刻在容差内才算同一个进程；命令行对不上也一律不算 */
function sameProcess(recorded: InstanceLockInfo, probed: ProcessFingerprint): boolean {
  const recordedStart = recorded.processStartedAt;
  const probedStart = probed.startedAt;
  if (typeof recordedStart === 'number' && typeof probedStart === 'number') {
    if (Math.abs(recordedStart - probedStart) > START_TOLERANCE_MS) return false;
    if (typeof recorded.command === 'string' && typeof probed.command === 'string') {
      return normalizeCommand(recorded.command) === normalizeCommand(probed.command);
    }
    return true;
  }
  if (typeof recorded.command === 'string' && typeof probed.command === 'string') {
    return normalizeCommand(recorded.command) === normalizeCommand(probed.command);
  }
  // 有身份字段却一项都比不了：按「核对不到」处理（不接管就没有依据）
  return false;
}

/** 接管陈旧锁时说清楚依据：否则「同一份数据跑了两份」会无从追溯 */
function warnStale(info: InstanceLockInfo, reason?: string): void {
  console.warn(
    `单实例锁：接管陈旧锁记录（pid ${info.pid}，取得于 ${new Date(info.startedAt).toISOString()}）——${reason ?? '持有者已消失'}`,
  );
}
