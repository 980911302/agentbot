import { createRuntimeStorage } from './storage-layer.js';
import { createRuntimeServices } from './service-layer.js';
import { createExecutionLayer } from './execution-layer.js';
import { createFacadeServices } from './facade-layer.js';
import type { RuntimeSharedState } from './host.js';
import type { RuntimeHost } from '../server/runtime/host.js';
import type { AgentRuntimeOptions } from '../server/runtime/types.js';

export type { RuntimeHost, RuntimeSharedState };

/**
 * 组合根装配（OPT-03）：存储、协调器、服务、工具的唯一 new 处。
 *
 * 原来这些都堆在 AgentRuntime 构造函数里（约 370 行、30 多个协作对象）。搬出来
 * 只换位置，不改顺序、不改接线，保证行为一模一样；服务之间需要门面能力的地方
 * 按既有 bind 风格注入（见 RuntimeHost）。
 *
 * 三层依次装配，层层只依赖上一层的结果：
 *   storage   存储与账本（含可选择落盘实现，不认识服务）
 *   services  群流程 / 停止许可 / 工作台 / 群扇出 / 来信消费
 *   execution AgentService / RunExecutor / 工具面 / 到期调度
 */
export function createRuntimeAssembly(
  options: AgentRuntimeOptions,
  host: RuntimeHost,
  shared: RuntimeSharedState,
) {
  const store = createRuntimeStorage(options, shared.events);
  const services = createRuntimeServices(options, host, shared, store);
  const execution = createExecutionLayer(options, host, shared, store, services);
  const facade = createFacadeServices(options, host, shared, store, services, execution);

  return { ...store, ...services, ...execution, ...facade };
}
