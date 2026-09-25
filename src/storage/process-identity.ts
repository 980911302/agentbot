import { spawnSync } from 'node:child_process';

/**
 * 进程身份指纹（E8.4）。
 *
 * 单实例锁只认 pid，会在 PID 复用时误判：操作系统把同一个 pid 发给另一个进程后，
 * 「pid 还活着」就不再等于「原来那个调度器还活着」。这里取进程的启动时刻与命令行特征，
 * 让重启时能回答「这个 pid 现在还是不是原来那个进程」。
 *
 * 为什么不用啥都靠 `kill(pid, 0)`：它只回答「这个 pid 有没有人」，
 * 回答不了「是不是同一个进程」；旧 pid 也不能据此去杀。
 *
 * 跨平台：
 *   - POSIX（macOS/Linux）：`ps -ww -o lstart= -o command= -p <pid>`；
 *   - Windows：`powershell Get-CimInstance Win32_Process`（wmic 已被移除，不能依赖）；
 *   - 探测手段本身不可用（没有 ps / 没有 PowerShell）→ 返回 supported:false，
 *     调用方据此「保守当占用」，绝不因为查不到就放开单实例。
 *
 * 为什么强制 LC_ALL=C：ps 的 lstart 是本地化输出（中文环境会给出「五  9/25 19:32:10 2026」），
 * 固定成 C locale 才能稳定解析，也才能保证「写入锁时」和「重启核对时」两次探测的输出可比。
 */

export interface ProcessFingerprint {
  /** 进程启动时刻（epoch ms）；来自 ps 的 lstart，秒级精度 */
  startedAt?: number;
  /** 完整命令行特征 */
  command?: string;
}

export type ProcessIdentityProbe =
  { supported: true; fingerprint?: ProcessFingerprint } | { supported: false; reason: string };

const PROBE_TIMEOUT_MS = 2000;

/** 探测某个 pid 当前的身份；不抛异常，探测不到就如实返回 */
export function probeProcessIdentity(pid: number): ProcessIdentityProbe {
  if (!Number.isInteger(pid) || pid <= 0) return { supported: false, reason: `非法 pid：${pid}` };
  return process.platform === 'win32' ? probeWindows(pid) : probePosix(pid);
}

/** 把命令行压成可比形式：空白折叠（ps 列对齐会产生连续空格） */
export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

function probePosix(pid: number): ProcessIdentityProbe {
  const result = spawnSync('ps', ['-ww', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  const failure = describeFailure(result.error, result.status, result.stderr);
  if (failure) return { supported: false, reason: failure };
  // ps 正常退出但没有输出：这个 pid 已经不存在了
  const line = firstLine(result.stdout);
  if (!line) return { supported: true };
  return { supported: true, ...fingerprintOf(line) };
}

function probeWindows(pid: number): ProcessIdentityProbe {
  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
    `if ($p) { '{0}|{1}' -f $p.CreationDate.ToUniversalTime().ToString('o'), $p.CommandLine }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  const failure = describeFailure(result.error, result.status, result.stderr);
  if (failure) return { supported: false, reason: failure };
  const line = firstLine(result.stdout);
  if (!line) return { supported: true };
  const separator = line.indexOf('|');
  if (separator < 0) return { supported: true };
  const startedAt = Date.parse(line.slice(0, separator).trim());
  const command = line.slice(separator + 1).trim();
  return {
    supported: true,
    fingerprint: {
      ...(Number.isFinite(startedAt) ? { startedAt } : {}),
      ...(command ? { command } : {}),
    },
  };
}

/** C locale 下 lstart 固定 24 列（`Wed Jun 25 19:26:00 2025`），其后就是 command */
function fingerprintOf(line: string): { fingerprint?: ProcessFingerprint } {
  const startedAt = Date.parse(line.slice(0, 24));
  const command = line.slice(24).trim();
  const fingerprint: ProcessFingerprint = {
    ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    ...(command ? { command } : {}),
  };
  return fingerprint.startedAt === undefined && !fingerprint.command ? {} : { fingerprint };
}

function firstLine(stdout: string | null): string {
  return (
    (stdout ?? '')
      .split('\n')
      .map((line) => line.trimEnd())
      .find((line) => line.trim().length > 0) ?? ''
  );
}

/**
 * 探测工具本身出了问题（二进制不存在、超时被杀、参数被拒）→ supported:false。
 * 目标进程不存在只是 ps 的非零退出，不算工具故障，交给调用方按「查不到」处理。
 */
function describeFailure(
  error: Error | undefined,
  status: number | null,
  stderr: string | null,
): string | undefined {
  if (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return process.platform === 'win32' ? '本机没有 PowerShell' : '本机没有 ps';
    return `进程身份探测失败：${code ?? error.message}`;
  }
  if (status !== 0 && (stderr ?? '').trim()) return `进程身份探测被拒绝（exit ${status}）：${stderr!.trim()}`;
  return undefined;
}
