import type { ActivationCoordinator } from './activation-coordinator.js';
import type { RuntimeControlStore } from '../../storage/runtime-control-store.js';
import type { AgentRegistry } from '../../agent/registry.js';
import type { AgentInbox } from '../../agent/inbox.js';
import type { RunLedger } from '../../storage/run-ledger.js';
import type { EffectRunner } from './effect-runner.js';
import type { DeliveryReceipt } from '../../shared/contracts/execution-control.js';

/**
 * 控制面视图与停止/恢复命令（OPT-03 从 runtime.ts 搬出）。
 *
 * 控制存储的快照读取（状态条、票据、停止操作、投递回执）与用户发起的
 * 单个同事停止/恢复、损坏控制数据的修复入口。状态转换本体在
 * RuntimeControlStore / ActivationCoordinator，这里只编排与投影。
 */
export function createControlViews(deps: {
  control: RuntimeControlStore;
  activation: ActivationCoordinator;
  registry: AgentRegistry;
  inbox: AgentInbox;
  ledger: RunLedger;
  effects: EffectRunner;
}) {
  const { control, activation, registry, inbox, ledger, effects } = deps;

  /**
   * 修复控制存储（OPT-06）：损坏文件改名备份后以空状态重建，已知同事全部置 paused
   * ——需要用户逐个核对恢复，而不是默认放行。
   */
  async function repairControlStore(): Promise<{
    ok: boolean;
    corruptBackup?: string;
    pausedAgents: number;
    faulted: boolean;
  }> {
    const known = await registry.list();
    const result = await control.repair(known.map((agent) => agent.id));
    return { ok: true, ...result, faulted: control.faulted };
  }

  function controlView(agentId: string) {
    const snap = control.snapshot();
    const agent = snap.agents[agentId];
    return {
      agentId,
      autoActivation: agent?.autoActivation ?? 'enabled',
      generation: agent?.generation ?? 0,
      lastStopId: agent?.lastStopId,
      held: Object.values(snap.tickets).filter(
        (ticket) => ticket.agentId === agentId && ticket.state === 'revoked',
      ).length,
      faulted: control.faulted,
    };
  }

  function stopOperation(stopId: string) {
    return control.snapshot().stops[stopId];
  }

  function activationSnapshot() {
    return control.snapshot();
  }

  async function requestAgentStop(agentId: string, commandId: string) {
    const operation = await activation.requestStop({
      commandId,
      requestedBy: { kind: 'user', id: 'owner' },
      scope: { kind: 'agent', agentId },
    });
    await inbox.hold(agentId, 'agent_paused').catch(() => 0);
    const runningId = ledger.runningTurnOf(agentId);
    if (runningId) {
      const treeId = ledger.getTurn(runningId)?.treeId;
      if (treeId) for (const job of ledger.jobsOf(treeId)) job.abort();
    }
    const pending = await effects.waitFor(operation.targetEffectIds, 5_000);
    await activation.settleStop(operation.stopId, pending.length > 0 ? 'needs_attention' : 'settled');
    return (
      activationSnapshot().stops[operation.stopId] ?? {
        ...operation,
        state: pending.length > 0 ? ('needs_attention' as const) : ('settled' as const),
      }
    );
  }

  function resumeAgent(command: Parameters<ActivationCoordinator['resumeSelected']>[0]) {
    return activation.resumeSelected(command);
  }

  function deliveryReceipt(receiptId: string): DeliveryReceipt | undefined {
    const value = control.snapshot().receipts[receiptId];
    if (!value || typeof value !== 'object' || !('receiptId' in value)) return undefined;
    return value as DeliveryReceipt;
  }

  return {
    repairControlStore,
    controlView,
    stopOperation,
    activationSnapshot,
    requestAgentStop,
    resumeAgent,
    deliveryReceipt,
  };
}
