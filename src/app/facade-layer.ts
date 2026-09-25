import { createWaitCoordinator } from '../server/runtime/wait-coordinator.js';
import { createDelegationWaitBridge } from '../server/runtime/delegation-wait-bridge.js';
import { createRoomGateway } from '../server/runtime/room-gateway-service.js';
import { createControlViews } from '../server/runtime/control-view-service.js';
import { createMessageAcceptance } from '../server/runtime/message-acceptance-service.js';
import type { createRuntimeStorage } from './storage-layer.js';
import type { createRuntimeServices } from './service-layer.js';
import type { createExecutionLayer } from './execution-layer.js';
import type { RuntimeHost, RuntimeSharedState } from './host.js';
import type { AgentRuntimeOptions } from '../server/runtime/types.js';
import type { AgentEventHandler } from '../agent/types.js';

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
  execution: ReturnType<typeof createExecutionLayer>,
) {
  const { waits, works, delegations, registry, control, inbox, ledger, roomFlowStore, chatRuns, rooms, activation, effects, receivedStore, messages, taskProgress } = store;
  const { broker, secrets, roomDispatcher, stopCoordinator, roomFlowService } = services;
  const { executor } = execution;

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

  const roomGateway = createRoomGateway(host, {
    chatRuns,
    rooms,
    roomFlowService,
    roomFlowStore,
    roomDispatcher,
    stopCoordinator,
    activation,
    events: shared.events,
  });
  const controlViews = createControlViews({ control, activation, registry, inbox, ledger, effects });
  const acceptance = createMessageAcceptance(options, host, {
    chatRuns,
    receivedStore,
    messages,
    registry,
    taskProgress,
    stopCoordinator,
    control,
    activation,
    works,
    executor,
    events: shared.events,
    // 与门面共用同一个 Map 实例：重复受理时复用同一次在飞执行
    runExecutions: shared.runExecutions,
    voidPendingUserWaits: (agentId, emit) => waitLifecycle.voidPendingUserWaits(agentId, emit as AgentEventHandler | undefined),
  });

  return { waitLifecycle, delegationWaits, roomGateway, controlViews, acceptance };
}
