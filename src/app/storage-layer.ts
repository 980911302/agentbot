import { ActivationCoordinator } from '../server/runtime/activation-coordinator.js';
import { DeliveryService } from '../server/runtime/delivery-service.js';
import { EffectRunner } from '../server/runtime/effect-runner.js';
import { OutboxProjector } from '../server/runtime/outbox-projector.js';
import { RuntimeControlStore } from '../storage/runtime-control-store.js';
import { RoomFlowStore } from '../storage/room-flow-store.js';
import { ProtocolRegistry, SequentialTurnProtocol } from '../server/runtime/room-flow-protocols.js';
import { AgentRegistry } from '../agent/registry.js';
import { AgentInbox } from '../agent/inbox.js';
import { CorrespondenceStore } from '../storage/correspondence-store.js';
import { CompactionStore } from '../memory/compact.js';
import { MemoryStore } from '../memory/store.js';
import { RoomStore } from '../room/store.js';
import { MessageStore } from '../store/messages.js';
import { WorkService } from '../work/service.js';
import { JsonWorkRepository } from '../work/store.js';
import { WaitService } from '../work/wait-service.js';
import { JsonWorkWaitRepository } from '../work/wait-store.js';
import { DelegationService } from '../work/delegation-service.js';
import { JsonDelegationRepository } from '../work/delegation-store.js';
import { JsonRunLedger, type RunLedger } from '../storage/run-ledger.js';
import { ReceivedStore } from '../storage/received-store.js';
import { JsonToolInvocationLedger } from '../storage/tool-ledger.js';
import { TaskProgressStore } from '../storage/task-progress.js';
import { ToolOutputStore } from '../tools/services/tool-output-store.js';
import { ChatRunCoordinator } from '../server/runtime/chat-run-coordinator.js';
import type { EventJournal } from '../server/events/journal.js';
import type { AgentRuntimeOptions } from '../server/runtime/types.js';

/**
 * 存储与账本层装配（OPT-03）：持久化对象与运行/控制账本的唯一 new 处。
 *
 * 这一层不依赖任何门面回调，也不依赖上层服务，所以可以从组合根里单独拎出来：
 * 上层（服务、工具面）拿它的结果做接线。构造顺序与原 AgentRuntime 构造函数一致。
 */
export function createRuntimeStorage(options: AgentRuntimeOptions, events: EventJournal) {
  const dataDir = options.dataDir;
  const chatRuns = new ChatRunCoordinator(options.dataDir, events);
  const ledger: RunLedger = new JsonRunLedger(options.dataDir);
  const registry = new AgentRegistry(options.dataDir, []);
  const control = RuntimeControlStore.openSync(options.dataDir, {
    // 接近软上限时告警：真撞上去 transact 会直接拒绝，同事之间的投递就失败了
    onNearLimit: (bytes, limit) => {
      console.warn(
        `控制存储已达 ${(bytes / 1024).toFixed(0)}KiB／上限 ${(limit / 1024).toFixed(0)}KiB：` +
          '已终结票据超量时会拒绝新写入，请减小 ticketRetention 或清理历史数据',
      );
    },
  });
  const activation = new ActivationCoordinator(control, {
    processEpoch: control.currentProcessEpoch,
    exists: async (agentId) => Boolean(await registry.get(agentId)),
  });
  const effects = new EffectRunner(activation);
  const deliveries = new DeliveryService(control);
  const messages = new MessageStore(options.dataDir);
  // 工作账本（E4.1）：同事手头负责的 WorkItem/WorkStep 持久化
  const workRepository = options.workRepository ?? new JsonWorkRepository(options.dataDir);
  const works = new WorkService({ repository: workRepository });
  // 等待账本（E4.3）：等谁/到点/等回答落成 WorkWait，重启后还能接上
  const waitRepository = options.waitRepository ?? new JsonWorkWaitRepository(options.dataDir);
  const waits = new WaitService({ repository: waitRepository });
  // 委派账本（E4.4）：谁把哪件事派给谁 + 线程键，精确停止/唤醒都读它
  const delegations = new DelegationService({ repository: new JsonDelegationRepository(options.dataDir) });
  const memory = options.memoryStore ?? new MemoryStore(options.dataDir);
  const compaction = new CompactionStore(options.dataDir);
  const rooms = new RoomStore(options.dataDir);
  const inbox = new AgentInbox(options.dataDir);
  const correspondence = new CorrespondenceStore(options.dataDir);
  const projector = new OutboxProjector({
    store: control,
    inbox,
    correspondence,
    rooms,
    messages,
  });
  const roomFlowStore = new RoomFlowStore(options.dataDir);
  const protocolRegistry = new ProtocolRegistry();
  const defaultSeqProtocol = new SequentialTurnProtocol();
  protocolRegistry.register('sequential-turn', defaultSeqProtocol);
  protocolRegistry.register('sequential_turn', defaultSeqProtocol);
  // 幂等接收日志、工具账本、任务进度与超量工具正文（E3.2/E3.5/E8.4）：纯存储，无服务依赖
  const receivedStore = new ReceivedStore(options.dataDir);
  const toolLedger = new JsonToolInvocationLedger(options.dataDir);
  const taskProgress = new TaskProgressStore(options.dataDir);
  const toolOutputs = new ToolOutputStore(options.dataDir);

  return {
    dataDir,
    chatRuns,
    ledger,
    registry,
    control,
    activation,
    effects,
    deliveries,
    messages,
    works,
    waits,
    delegations,
    memory,
    compaction,
    rooms,
    inbox,
    correspondence,
    projector,
    roomFlowStore,
    protocolRegistry,
    receivedStore,
    toolLedger,
    taskProgress,
    toolOutputs,
  };
}