import { useEffect, useRef } from 'react';
import * as api from '../../api';
import { EventClient } from './event-client';
import type { EventCursor } from '../../../../src/shared/contracts/chat-state';

/** React 只负责连接生命周期；顺序/恢复契约由可独立测试的 EventClient 拥有。 */
export function useEventStream(input: {
  onEntry: (entry: api.JournalEntry) => void;
  onResync: () => Promise<EventCursor>;
}): void {
  const ref = useRef(input);
  ref.current = input;
  useEffect(() => {
    const controller = new AbortController();
    const client = new EventClient({ transport: { read: api.readEvents },
      restore: () => ref.current.onResync(), apply: entry => ref.current.onEntry(entry) });
    void (async () => {
      let attempt = 0;
      while (!controller.signal.aborted) {
        try { await client.connect(controller.signal); attempt = 0; } catch { attempt += 1; }
        if (controller.signal.aborted) break;
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, Math.min(500 * Math.max(1, attempt), 5000));
          controller.signal.addEventListener('abort', finish, { once: true });
        });
      }
    })();
    return () => controller.abort();
  }, []);
}
