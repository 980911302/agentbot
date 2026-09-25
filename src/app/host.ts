import type { EventJournal } from '../server/events/journal.js';
import type { PendingStop } from '../server/runtime/types.js';

export type { RuntimeHost } from '../server/runtime/host.js';

/** 门面自有的可变生命周期状态：装配只借用，不接管（停机与幂等由门面负责） */
export interface RuntimeSharedState {
  events: EventJournal;
  locks: Set<string>;
  pendingStops: Map<string, PendingStop[]>;
}