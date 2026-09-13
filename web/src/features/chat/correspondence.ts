import type { DisplayMessage } from '../../types';
import type { Correspondence, MessageActor } from '../../../../src/shared/contracts/message-identity';

export type ChatRow = { kind: 'message'; message: DisplayMessage } | { kind: 'correspondence'; id: string; transfers: Correspondence[] };

export function isChatRenderable(message: DisplayMessage): boolean {
  if (message.correspondence) return true;
  if (message.content.trim()) return true;
  return false;
}
/** 工具脚手架不显示；相邻的原始投递折成往来行，不能吞掉真正的用户输入。 */
export function chatRows(messages: DisplayMessage[]): ChatRow[] {
  const rows: ChatRow[] = []; const seen = new Set<string>();
  for (const message of messages) {
    if (message.correspondence) {
      const transfer = message.correspondence;
      if (seen.has(transfer.id)) continue;
      seen.add(transfer.id);
      const last = rows.at(-1);
      if (last?.kind === 'correspondence') last.transfers.push(transfer);
      else rows.push({ kind: 'correspondence', id: message.id, transfers: [transfer] });
    } else if (isChatRenderable(message)) rows.push({ kind: 'message', message });
  }
  return rows;
}
export function transferPeers(agentId: string, transfers: Correspondence[]): MessageActor[] {
  return [...new Map(transfers.map(item => { const peer = item.from.id === agentId ? item.to : item.from; return [peer.id, peer] as const; })).values()];
}
export function transferLabel(agentId: string, transfers: Correspondence[]): string {
  if (transfers.length === 1) return transfers[0]!.to.id === agentId ? '消息来自' : '已发消息给';
  if (transfers.every(item => item.from.id === agentId)) return `已发出 ${transfers.length} 条消息给`;
  if (transfers.every(item => item.to.id === agentId)) return `收到 ${transfers.length} 条消息，来自`;
  return `${transfers.length} 条消息往来`;
}
