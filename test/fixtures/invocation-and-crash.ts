/**
 * 故障测试夹具（E3.5）：真实子进程「记了意图就强退」。
 *
 * 用法：node --import tsx test/fixtures/invocation-and-crash.ts <dataDir> <agentId>
 * 输出一行 JSON：{ id, status }
 */
import { JsonToolInvocationLedger } from '../../src/storage/tool-ledger.js';

const [dir, agentId] = process.argv.slice(2);
if (!dir || !agentId) {
  console.error('用法：invocation-and-crash.ts <dataDir> <agentId>');
  process.exit(2);
}

const ledger = new JsonToolInvocationLedger(dir);
const record = await ledger.start({
  agentId,
  runId: 'crash-run',
  treeId: 'crash-tree',
  tool: 'Shell',
  operationKey: 'crash-key',
  args: JSON.stringify({ command: 'echo 强退前的动作' }),
  replayPolicy: 'manual',
});

console.log(JSON.stringify({ id: record.id, status: record.status }));
process.exit(0);
