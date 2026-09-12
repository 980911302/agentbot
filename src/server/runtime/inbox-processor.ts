import { randomUUID } from 'node:crypto';
import type { Message } from '../../shared/contracts/sse.js';
import { buildAgentBrief } from '../../room/turn.js';
import type { AgentInbox } from '../../agent/inbox.js';
import type { AgentRegistry } from '../../agent/registry.js';
import type { StopCoordinator } from './stop-coordinator.js';
import type { SendOptions, TurnResult } from './types.js';

/**
 * InboxProcessor（E2.2 拆出）：同事来信的消费。
 *
 * 同批先处理停止令（递归砍树 + 回执），再合并普通信为一个回合；
 * 深度上限防两个智能体无限互发。回合执行经 runTurn 接缝注入
 * （RunExecutor 在后续批次落地，届时接缝指向独立执行器）。
 */
export class InboxProcessor {
  constructor(
    private readonly deps: {
      inbox: AgentInbox;
      registry: AgentRegistry;
      maxAgentChainDepth: number;
      stopCoordinator: StopCoordinator;
      runTurn: (
        agentId: string,
        task: Message,
        turn: { brief?: string; toolContext?: { agentChainDepth: number } },
        options: SendOptions,
      ) => Promise<TurnResult>;
    },
  ) {}

  async drain(
    agentId: string,
    options: SendOptions & { depth?: number } = {},
  ): Promise<TurnResult | null> {
    const items = await this.deps.inbox.drain(agentId);
    if (items.length === 0) return null;

    const record = await this.deps.registry.get(agentId);
    if (!record) return null;

    // 停止令优先处理：先砍自己这棵再回报；普通信照旧
    const stops = items.filter((item) => item.kind === 'stop');
    for (const stop of stops) {
      await this.deps.stopCoordinator.stopFromParent(
        agentId,
        { text: stop.text, createdAt: stop.createdAt },
        { agentId: stop.fromAgentId, name: stop.fromName },
      );
    }

    const letters = items.filter((item) => item.kind !== 'stop' && item.kind !== 'stop-ack');
    if (letters.length === 0) return null;

    const depth = Math.max(...letters.map((item) => item.depth));
    const fromName = letters[0]?.fromName ?? '同事';
    const text = letters.map((item) => item.text).join('\n\n');

    const task: Message = {
      id: randomUUID(),
      agentId,
      role: 'user',
      content: { type: 'text', text },
      createdAt: Date.now(),
      speaker: fromName,
      source: 'agent',
    };

    const result = await this.deps.runTurn(
      agentId,
      task,
      {
        brief: buildAgentBrief({
          fromName,
          depth,
          maxDepth: this.deps.maxAgentChainDepth,
        }),
        toolContext: { agentChainDepth: depth },
      },
      options,
    );

    // 处理完这批，继续往下走（受深度上限约束）
    const deeper = await this.drain(agentId, { ...options, depth: depth + 1 });
    void deeper;

    return result;
  }
}
