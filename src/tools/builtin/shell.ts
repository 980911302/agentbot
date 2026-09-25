import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { defineTool } from '../tool.js';
import { ShellSessionManager } from '../services/shell-session-manager.js';
import { sensitivePaths, shellCommandSensitiveHit, shellRefusalMessage, type SensitivePaths } from '../sensitive-paths.js';
import type { ToolResult } from '../result.js';

/**
 * Shell / AwaitShell —— 对齐《内置工具清单.md》1.6 / H. AwaitShell。
 *
 * 没有云电脑：命令直接跑在本机（AgentBot 本来就装在用户机器上）。
 * 进程生命周期在 ShellSessionManager（services 层）；工具只做参数校验、
 * 同步等待与展示。停止令经任务树 registerJob 能杀掉同一个进程。
 */

const SYNC_WAIT_CAP_MS = 60_000;

export function createShellTools(rootDir = process.cwd(), paths: SensitivePaths = sensitivePaths(rootDir)) {
  const manager = new ShellSessionManager();

  const summarize = (shell: ReturnType<ShellSessionManager['start']>, offset?: number): ToolResult => {
    const status = shell.done ? `已结束：${shell.state}（exit ${shell.code ?? '?'}）` : `${shell.state}（等待进程退出/仍在后台运行）`;
    let record: ReturnType<ReturnType<ShellSessionManager['outputStore']>['get']> | undefined;
    try { record = manager.outputStore().get(shell.id, shell.ownerId ?? ''); }
    catch { /* 旧日志可按保留策略清理；不能因此把已执行的命令说成执行失败。 */ }
    const failed = shell.state !== 'running' && (shell.state !== 'exited' || shell.code !== 0);
    return { status: failed ? 'error' : shell.done ? 'ok' : 'running',
      execution: { id: shell.id, state: shell.state, exitCode: shell.code, ...(shell.signal ? { signal: shell.signal } : {}) },
      ...(failed ? { error: { code: shell.state === 'exited' ? 'SHELL_EXIT_NONZERO' : `SHELL_${shell.state.toUpperCase()}`, message: shell.logError ?? `命令 ${shell.state}，exit=${shell.code ?? 'unknown'}` } } : {}),
      output: { truncated: !record || record.totalBytes > 8000, ...(record ? { handle: shell.id, totalBytes: record.totalBytes, retainedBytes: record.retainedBytes } : {}), storageTruncated: !record || record.storageTruncated },
      content: `shell_id: ${shell.id}\n${record ? `output_id: ${shell.id}（ReadToolOutput 可分页/搜索原文；其 offset 为 UTF-8 字节）` : '[持久日志已清理或不可读；命令执行状态不变，勿因此重跑]'}\n${record?.storageTruncated ? '[存储配额已满，原文未完整保存]\n' : ''}${shell.logError ? shell.logError + '\n' : ''}命令摘要：${shell.command.slice(0, 240)}${shell.command.length > 240 ? '…[已省略完整命令]' : ''}\n状态：${status}\n输出：\n${
      manager.read(shell, offset)
    }${shell.done ? '' : '\n用 AwaitShell 继续等结果，后台运行不代表验证通过。'}` };
  };

  const shell = defineTool<{
    command: string;
    working_directory?: string;
    block_until_ms?: number;
    description?: string;
    timeout_ms?: number;
  }>({
    name: 'Shell',
    description: [
      '在本机终端跑一条命令（git / npm / docker 等），直接执行、真出真回。',
      '读写文件和定位代码优先用 Read / Write / Edit / ListFiles / SearchFiles。默认最长运行 10 分钟，硬上限 30 分钟。原始输出自动落盘，用 ReadToolOutput 分页/搜索；单日志最多 32MiB，总量 256MiB，默认保留 7 天，达到配额会明确标注。',
      '命令跑在用户的真实机器上：不要更新 git config，未经用户要求不要 commit / push，不要执行删除性、联网下载可执行文件这类高危操作。',
      '长命令把 block_until_ms 设 0（立刻转后台），用 AwaitShell 等结果。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的完整命令' },
        working_directory: { type: 'string', description: '工作目录（绝对路径），默认运行时根目录' },
        block_until_ms: { type: 'integer', minimum: 0, maximum: 60000, description: '同步等待，默认 30000；最多 60000；0 = 立刻转后台' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 1800000 },
        description: { type: 'string', description: '5~10 个字，说明这条命令干什么' },
      },
      required: ['command'],
    },
    async execute(args, context) {
      const command = args.command?.trim();
      if (!command) throw new Error('command 不能为空');
      const cwd = resolve(rootDir, args.working_directory?.trim() || '.');
      if (cwd && !existsSync(cwd)) throw new Error(`working_directory 不存在：${cwd}`);
      // 密钥文件：命令里出现这些路径就直接拒绝（OPT-07，保守字面检查）
      const hit = shellCommandSensitiveHit(command, paths);
      if (hit) throw new Error(shellRefusalMessage(command, hit));

      const started = manager.start(command, cwd, (abort, label) =>
        context.turnState?.registerJob?.(abort, label),
        { signal: context.signal, timeoutMs: args.timeout_ms, ownerId: context.agentId, outputs: context.outputs },
      );
      const requested = Math.max(0, args.block_until_ms ?? 30_000);
      const deadline = Date.now() + Math.min(requested, SYNC_WAIT_CAP_MS);
      while (!started.done && Date.now() < deadline) {
        await delay(100, undefined, { signal: context.signal });
      }
      return summarize(started);
    },
  });

  const awaitShell = defineTool<{
    shell_id?: string;
    block_until_ms?: number;
    pattern?: string;
    offset?: number;
    stop?: boolean;
  }>({
    name: 'AwaitShell',
    description: [
      '等后台 Shell 结束，或输出出现指定字面文本；只返回新增输出，避免反复塞入旧日志。可指定 offset 重读缓冲内内容。stop=true 终止进程组。',
      '不要用它干等 Task 工人——那有 CheckSubagent。',
      '不传 shell_id 就等最新启动、还没结束的那个。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        shell_id: { type: 'string', description: 'Shell 返回的 id' },
        block_until_ms: { type: 'integer', minimum: 0, maximum: 60000, description: '默认 30000，最多 60000' },
        pattern: { type: 'string', description: '字面文本，不是正则，出现即返回' },
        offset: { type: 'integer', minimum: 0 },
        stop: { type: 'boolean' },
      },
    },
    async execute(args, context) {
      const target = args.shell_id ? manager.get(args.shell_id, context.agentId, context.outputs) : manager.latestRunning(context.agentId);
      if (!target) {
        throw new Error('找不到这个 shell_id，请使用 Shell 返回的完整 id');
      }
      if (target.ownerId !== context.agentId) throw new Error('不能访问其他智能体的 Shell');
      if (args.stop) target.kill();
      const deadline = Date.now() + Math.min(Math.max(args.block_until_ms ?? 30_000, 0), SYNC_WAIT_CAP_MS);
      while (!target.done && Date.now() < deadline) {
        if (args.pattern && target.output.includes(args.pattern)) break;
        await delay(100, undefined, { signal: context.signal });
      }
      return summarize(target, args.offset);
    },
  });

  return [shell, awaitShell];
}
