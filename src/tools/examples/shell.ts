import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { defineTool, type ToolContext } from '../tool.js';

/**
 * Shell / AwaitShell —— 对齐《内置工具清单.md》1.6 / H. AwaitShell。
 *
 * 没有云电脑：命令直接跑在本机（AgentBot 本来就装在用户机器上）。
 * 安全边界靠两点：description 里明示、任务树 registerJob 让停止令能杀进程。
 */

interface BackgroundShell {
  id: string;
  command: string;
  output: string;
  done: boolean;
  code: number | null;
  kill: () => void;
  startedAt: number;
}

const SYNC_WAIT_CAP_MS = 300_000;
const MAX_OUTPUT_CHARS = 8000;

export function createShellTools() {
  const shells = new Map<string, BackgroundShell>();

  const clip = (text: string): string =>
    text.length > MAX_OUTPUT_CHARS
      ? `${text.slice(0, MAX_OUTPUT_CHARS / 2)}\n…（中间截断）…\n${text.slice(-MAX_OUTPUT_CHARS / 2)}`
      : text;

  const start = (command: string, cwd: string | undefined, context: ToolContext): BackgroundShell => {
    const id = randomUUID();
    const child = exec(command, { cwd, maxBuffer: 16 * 1024 * 1024 }, () => undefined);
    const shell: BackgroundShell = {
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
    context.turnState?.registerJob?.(() => shell.kill(), `shell:${id.slice(0, 8)}`);
    shells.set(id, shell);
    return shell;
  };

  const summarize = (shell: BackgroundShell): string => {
    const status = shell.done ? `已结束（exit ${shell.code ?? '?'}）` : '仍在后台运行';
    return `shell_id: ${shell.id}\n命令：${shell.command}\n状态：${status}\n输出：\n${
      clip(shell.output) || '（暂无输出）'
    }`;
  };

  const shell = defineTool<{
    command: string;
    working_directory?: string;
    block_until_ms?: number;
    description?: string;
  }>({
    name: 'Shell',
    description: [
      '在本机终端跑一条命令（git / npm / docker 等），直接执行、真出真回。',
      '不要用它读文件、列目录或 sleep——那些有专用工具或不值得。',
      '命令跑在用户的真实机器上：不要更新 git config，未经用户要求不要 commit / push，不要执行删除性、联网下载可执行文件这类高危操作。',
      '长命令把 block_until_ms 设 0（立刻转后台），用 AwaitShell 等结果。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的完整命令' },
        working_directory: { type: 'string', description: '工作目录（绝对路径），默认运行时根目录' },
        block_until_ms: { type: 'number', description: '同步等待的毫秒数，默认 30000；0 = 立刻转后台' },
        description: { type: 'string', description: '5~10 个字，说明这条命令干什么' },
      },
      required: ['command'],
    },
    async execute(args, context) {
      const command = args.command?.trim();
      if (!command) throw new Error('command 不能为空');
      const cwd = args.working_directory?.trim() || undefined;
      if (cwd && !existsSync(cwd)) throw new Error(`working_directory 不存在：${cwd}`);

      const started = start(command, cwd, context);
      const requested = Math.max(0, args.block_until_ms ?? 30_000);
      const deadline = Date.now() + Math.min(requested, SYNC_WAIT_CAP_MS);
      while (!started.done && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (started.done) return summarize(started);
      return `命令仍在后台运行。\n${summarize(started)}\n用 AwaitShell（shell_id: ${started.id}）继续等它。`;
    },
  });

  const awaitShell = defineTool<{
    shell_id?: string;
    block_until_ms?: number;
    pattern?: string;
  }>({
    name: 'AwaitShell',
    description: [
      '等一个后台 Shell 结束（或等到输出里出现某个正则），再拿到全部输出。',
      '不要用它干等 Task 工人——那有 CheckSubagent。',
      '不传 shell_id 就等最早启动的那个还没结束的。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        shell_id: { type: 'string', description: 'Shell 返回的 id' },
        block_until_ms: { type: 'number', description: '最多等多久，默认 30000' },
        pattern: { type: 'string', description: 'RE2 正则：输出里一出现就提前返回' },
      },
    },
    async execute(args) {
      const list = [...shells.values()].sort((left, right) => right.startedAt - left.startedAt);
      const target = args.shell_id
        ? shells.get(args.shell_id)
        : list.find((item) => !item.done);
      if (!target) {
        const known = list.slice(0, 5).map((item) => item.id.slice(0, 8)).join('、') || '（无）';
        throw new Error(`找不到这个 shell_id；最近的 shell：${known}`);
      }
      const pattern = args.pattern ? new RegExp(args.pattern) : null;
      const deadline = Date.now() + Math.min(Math.max(args.block_until_ms ?? 30_000, 0), SYNC_WAIT_CAP_MS);
      while (!target.done && Date.now() < deadline) {
        if (pattern && pattern.test(target.output)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return summarize(target);
    },
  });

  return [shell, awaitShell];
}
