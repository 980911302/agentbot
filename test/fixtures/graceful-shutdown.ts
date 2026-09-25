/**
 * 故障测试夹具（E8.4）：真子进程里的服务端，起了后台 Shell 与后台工人后等 SIGTERM。
 *
 * 用法：node --import tsx test/fixtures/graceful-shutdown.ts <dataDir>
 * 输出一行：READY url=<监听地址> shell=<shellId> child=<shell 子进程 pid> worker=<workerId>
 * 收到 SIGTERM 走 installShutdownHandlers（与 src/server/main.ts 同一条停机路径）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentServer } from '../../src/server/http.js';
import { installShutdownHandlers } from '../../src/server/lifecycle.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import { waitFor } from '../fakes/test-env.js';

const [dir] = process.argv.slice(2);
if (!dir) {
  console.error('用法：graceful-shutdown.ts <dataDir>');
  process.exit(2);
}

// 永不返回的假模型：后台工人会一直停在 running，正好用来验证停机时被终止
const provider: LLMProvider = { name: 'hang', chat: () => new Promise(() => undefined) };

const handle = await createAgentServer({
  port: 0,
  dataDir: dir,
  rootDir: process.cwd(),
  allowMissingKey: true,
  createProvider: () => provider,
});

const context = {
  agentId: 'owner',
  projectIds: [],
  outputs: handle.runtime.toolOutputs,
  authority: { toolNames: [], projectIds: [] },
  turnState: { workbench: { agentsCreated: 0, roomsCreated: 0 } },
};

// 1) 后台 Shell：命令把自己的 pid 写进文件，父测试据此核对停机后进程被清理
const pidFile = join(dir, 'shell.pid');
const shellTool = handle.runtime.tools.find((tool) => tool.name === 'Shell');
if (!shellTool) throw new Error('夹具拿不到 Shell 工具');
const shellOutput = String(
  await shellTool.execute(
    { command: `echo $$ > ${JSON.stringify(pidFile)}; sleep 300`, block_until_ms: 0 },
    context,
  ),
);
const shellId = /shell_id: (\S+)/.exec(shellOutput)?.[1];
if (!shellId) throw new Error(`Shell 没返回 shell_id：${shellOutput}`);

await waitFor(() => {
  try {
    return readFileSync(pidFile, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}, '后台 Shell 写出自己的 pid');

// 2) 后台工人：假模型不返回，工人保持 running
const taskTool = handle.runtime.tools.find((tool) => tool.name === 'Task');
if (!taskTool) throw new Error('夹具拿不到 Task 工具');
const workerOutput = String(
  await taskTool.execute(
    {
      description: '停机夹具里的长工人',
      prompt: '永远不会返回的任务：用来验证停机时后台工人被终止',
      subagent_type: 'executor',
      run_in_background: true,
    },
    context,
  ),
);
const workerId = /worker_id: (\S+)/.exec(workerOutput)?.[1];
if (!workerId) throw new Error(`Task 没返回 worker_id：${workerOutput}`);

console.log(
  `READY url=${handle.url} shell=${shellId} child=${readFileSync(pidFile, 'utf8').trim()} worker=${workerId}`,
);

installShutdownHandlers(handle, {
  onReport: (report) => console.log(`REPORT ${JSON.stringify(report)}`),
});
