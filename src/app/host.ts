import type { EventJournal } from '../server/events/journal.js';
import type { PendingStop, SendResult } from '../server/runtime/types.js';

export type { RuntimeHost } from '../server/runtime/host.js';

/** 门面自有的可变生命周期状态：装配只借用，不接管（停机与幂等由门面负责） */
export interface RuntimeSharedState {
  events: EventJournal;
  locks: Set<string>;
  pendingStops: Map<string, PendingStop[]>;
  /** 在飞回合（门面持有）：受理服务与门面共用同一实例，重复受理复用同一次执行 */
  runExecutions: Map<string, Promise<SendResult>>;
}