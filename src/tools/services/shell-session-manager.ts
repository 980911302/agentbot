import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';

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
  kill: () => void;
  startedAt: number;
}

export class ShellSessionManager {
  private readonly shells = new Map<string, ShellProcess>();
  private readonly maxOutputChars: number;

  constructor(options: { maxOutputChars?: number } = {}) {
    this.maxOutputChars = options.maxOutputChars ?? 8000;
  }

  start(
    command: string,
    cwd: string | undefined,
    onJob?: (abort: () => void, label: string) => void,
  ): ShellProcess {
    const id = randomUUID();
    const child = exec(command, { cwd, maxBuffer: 16 * 1024 * 1024 }, () => undefined);
    const shell: ShellProcess = {
      id,
      command,
      output: '',
      done: false,
      code: null,
      kill: () => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 已经退出
        }
      },
      startedAt: Date.now(),
    };
    child.stdout?.on('data', (chunk) => {
      shell.output += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      shell.output += String(chunk);
    });
    child.on('close', (code) => {
      shell.done = true;
      shell.code = code;
    });
    onJob?.(() => shell.kill(), `shell:${id.slice(0, 8)}`);
    this.shells.set(id, shell);
    return shell;
  }

  get(id: string): ShellProcess | undefined {
    return this.shells.get(id);
  }

  /** 最新启动、还没结束的 shell（AwaitShell 不带 id 时用） */
  latestRunning(): ShellProcess | undefined {
    return [...this.shells.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .find((item) => !item.done);
  }

  /** 最近启动的若干个（错误提示里列出可选 id） */
  recentIds(count = 5): string[] {
    return [...this.shells.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, count)
      .map((item) => item.id.slice(0, 8));
  }

  clip(text: string): string {
    const half = Math.floor(this.maxOutputChars / 2);
    return text.length > this.maxOutputChars
      ? `${text.slice(0, half)}\n…（中间截断）…\n${text.slice(-half)}`
      : text;
  }
}
