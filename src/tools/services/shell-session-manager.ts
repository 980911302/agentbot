import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolOutputStore } from './tool-output-store.js';
import type { ToolResult } from '../../shared/contracts/tool-result.js';

/**
 * ShellSessionManager（E2.3）：后台 shell 进程的机械管理。
 *
 * 工具（Shell/AwaitShell）只做参数校验与展示；进程生命周期、输出捕获、
 * 停止令能杀掉的 job 登记回调都在这里。
 */

export interface ShellProcess {
  id: string;
  command: string;
  output: string;
  done: boolean;
  code: number | null;
  kill: (reason?: 'cancelled' | 'timed_out' | 'failed') => void;
  startedAt: number;
  outputStart: number;
  outputEnd: number;
  cursor: number;
  ownerId?: string;
  state: NonNullable<ToolResult['execution']>['state'];
  signal?: string;
  logError?: string;
}

export class ShellSessionManager {
  private readonly shells = new Map<string, ShellProcess>();
  private readonly maxOutputChars: number;
  private outputs?: ToolOutputStore;

  constructor(options: { maxOutputChars?: number } = {}) {
    this.maxOutputChars = options.maxOutputChars ?? 8000;
  }

  start(
    command: string,
    cwd: string | undefined,
    onJob?: (abort: () => void, label: string) => void,
    options: { signal?: AbortSignal; timeoutMs?: number; ownerId?: string; outputs?: ToolOutputStore } = {},
  ): ShellProcess {
    options.signal?.throwIfAborted();
    if ([...this.shells.values()].filter(item => !item.done).length >= 8) throw new Error('后台 Shell 已达 8 个，请先结束已有进程');
    for (const [key, item] of this.shells) {
      if (this.shells.size < 64) break;
      if (item.done) this.shells.delete(key);
    }
    const id = randomUUID();
    const outputs = this.outputStore(options.outputs);
    outputs.create(options.ownerId ?? '', { id, command });
    const child = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const shell: ShellProcess = {
      id,
      command,
      output: '',
      done: false,
      code: null,
      state: 'running',
      outputStart: 0, outputEnd: 0, cursor: 0, ownerId: options.ownerId,
      kill: (reason = 'cancelled') => {
        if (shell.done) return; // 旧 job 不能误杀后来复用相同 pid 的进程组
        if (shell.state === 'running') shell.state = reason;
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          // 已经退出
        }
      },
      startedAt: Date.now(),
    };
    const append = (chunk: string) => {
      shell.outputEnd += chunk.length;
      shell.output = (shell.output + chunk).slice(-65536);
      shell.outputStart = shell.outputEnd - shell.output.length;
      if (!shell.logError) {
        try { outputs.append(id, chunk); }
        catch (error) { shell.logError = `完整日志写入失败：${error instanceof Error ? error.message : String(error)}`; shell.kill('failed'); }
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', error => { shell.state = 'failed'; append(`\nError: ${error.message}`); });
    const abort = () => shell.kill();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { append('\n[运行时限已到，已终止进程组]'); shell.kill('timed_out'); }, Math.min(Math.max(options.timeoutMs ?? 600000, 1000), 1800000));
    timer.unref();
    child.on('close', (code, signal) => {
      shell.done = true;
      shell.code = code;
      if (shell.state === 'running') shell.state = 'exited';
      if (signal) shell.signal = signal;
      try { outputs.finish(id, { id, state: shell.state, exitCode: code, ...(signal ? { signal } : {}) }); }
      catch (error) { shell.logError = `完整日志收尾失败：${error instanceof Error ? error.message : String(error)}`; shell.state = 'failed'; }
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    });
    onJob?.(() => shell.kill(), `shell:${id.slice(0, 8)}`);
    this.shells.set(id, shell);
    if (options.signal?.aborted) shell.kill();
    return shell;
  }

  get(id: string, ownerId?: string, outputs?: ToolOutputStore): ShellProcess | undefined {
    const current = this.shells.get(id);
    if (current) return current;
    if (ownerId === undefined) return undefined;
    try {
      const record = this.outputStore(outputs).get(id, ownerId);
      if (!record.execution) return undefined;
      // 重启后只恢复记录，不持有或操作旧 pid，也不重跑命令。
      const restored: ShellProcess = { id, command: record.command ?? '', output: '', done: true, code: record.execution.exitCode,
        state: record.execution.state, signal: record.execution.signal, ownerId,
        kill: () => {}, startedAt: record.createdAt, outputStart: 0, outputEnd: 0, cursor: 0 };
      this.shells.set(id, restored);
      return restored;
    } catch { return undefined; }
  }

  outputStore(outputs?: ToolOutputStore): ToolOutputStore {
    this.outputs ??= outputs ?? new ToolOutputStore(mkdtempSync(join(tmpdir(), 'agentbot-shell-output-')));
    return this.outputs;
  }

  /** 最新启动、还没结束的 shell（AwaitShell 不带 id 时用） */
  latestRunning(ownerId?: string): ShellProcess | undefined {
    return [...this.shells.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .find((item) => !item.done && (!ownerId || item.ownerId === ownerId));
  }

  /** 最近启动的若干个（错误提示里列出可选 id） */
  recentIds(count = 5): string[] {
    return [...this.shells.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, count)
      .map((item) => item.id);
  }

  read(shell: ShellProcess, offset = shell.cursor): string {
    if (offset > shell.outputEnd) throw new Error('offset 超过当前输出长度');
    const start = Math.max(offset, shell.outputStart);
    const end = Math.min(shell.outputEnd, start + this.maxOutputChars);
    const text = shell.output.slice(start - shell.outputStart, end - shell.outputStart);
    shell.cursor = end;
    return `${offset < shell.outputStart ? `[旧输出已超出 64Ki 字符缓冲；请用 ReadToolOutput(output_id=${shell.id}) 读取已落盘原文]\n` : ''}${text || '（无新增输出）'}\nnext_offset: ${end}（AwaitShell 字符游标）${end < shell.outputEnd ? '（仍有未读输出）' : ''}`;
  }

  clip(text: string): string {
    const half = Math.floor(this.maxOutputChars / 2);
    return text.length > this.maxOutputChars
      ? `${text.slice(0, half)}\n…（中间截断）…\n${text.slice(-half)}`
      : text;
  }
}
