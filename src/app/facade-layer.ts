import { createWaitCoordinator } from '../server/runtime/wait-coordinator.js';
import { createDelegationWaitBridge } from '../server/runtime/delegation-wait-bridge.js';
import type { createRuntimeStorage } from './storage-layer.js';
import type { createRuntimeServices } from './service-layer.js';
import type { RuntimeHost, RuntimeSharedState } from './host.js';
import type { AgentRuntimeOptions } from '../server/runtime/types.js';

/**
 * 门面服务层装配（OPT-03）：从门面里搬出来的运行时服务在这里 new。
 *
 * 它们只依赖存储账本与门面回调（RuntimeHost），互相之间不直接引用；
 * 门面只保留转发与自身状态（停机、执行位）。
 */
export function createFacadeServices(
  options: AgentRuntimeOptions,
  host: RuntimeHost,
  shared: RuntimeSharedState,
  store: ReturnType<typeof createRuntimeStorage>,
  services: ReturnType<typeof createRuntimeServices>,
) {
  const { waits, works, delegations, registry } = store;
  const { broker, secrets } = services;

  const waitLifecycle = createWaitCoordinator(options, host, {
    waits,
    works,
    broker,
    secrets,
    registry,
    events: shared.events,
  });
  const delegationWaits = createDelegationWaitBridge({
    waits,
    works,
    delegations,
    registry,
    releaseWorkIfSettled: (workId) => waitLifecycle.releaseWorkIfSettled(workId),
  });

  return { waitLifecycle, delegationWaits };
}
