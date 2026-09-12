/**
 * 故障测试夹具（E3.3）：真实子进程「领取后强退」。
 *
 * 用法：node --import tsx test/fixtures/claim-and-crash.ts <dataDir> <agentId> <leaseMs> [ack]
 *   - 默认：投递一封信、领取、不确认直接退出（模拟处理中被杀）
 *   - 传 ack：领取后确认再退出（模拟处理已提交）
 * 输出一行 JSON：{ claimed: string[] }
 */
import { AgentInbox } from '../../src/agent/inbox.js';

const [dir, agentId, leaseMsRaw, mode] = process.argv.slice(2);
if (!dir || !agentId) {
  console.error('用法：claim-and-crash.ts <dataDir> <agentId> <leaseMs> [ack]');
  process.exit(2);
}

const inbox = new AgentInbox(dir);
const sent = await inbox.enqueue({
  toAgentId: agentId,
  fromAgentId: 'crash-boss',
  fromName: '上级同事',
  text: '这条信要在强退后被找回来',
  priority: false,
  depth: 0,
  kind: 'message',
});

const claimed = await inbox.claim(agentId, {
  owner: 'crash-run',
  leaseMs: Number(leaseMsRaw ?? 60_000),
  maxAttempts: 3,
});
if (mode === 'ack') await inbox.ack(agentId, claimed.map((item) => item.id));

console.log(JSON.stringify({ sent: sent.id, claimed: claimed.map((item) => item.id) }));
process.exit(0);
