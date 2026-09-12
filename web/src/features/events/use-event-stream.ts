import { useEffect, useRef } from 'react';
import * as api from '../../api';

/**
 * 事件订阅（E3.4 第二步）。
 *
 * 断线只断订阅：回合在后端照跑，重连时带上最后一条 seq 补发；
 * 服务端说 resync（游标太旧/后端重启过）时先让上层重新取一次快照。
 * 订阅循环自己重试，App 不需要关心连接状态。
 */
export function useEventStream(input: {
  onEntry: (entry: api.JournalEntry) => void;
  onResync: () => void;
}): void {
  const cursorRef = useRef<number | undefined>(undefined);
  const entryRef = useRef(input.onEntry);
  const resyncRef = useRef(input.onResync);
  // 每次渲染同步最新回调：订阅循环长期存活，不能捕获旧闭包
  entryRef.current = input.onEntry;
  resyncRef.current = input.onResync;

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let attempt = 0;

    const loop = async (): Promise<void> => {
      while (!stopped) {
        try {
          await api.readEvents(
            {
              onReady: (info) => {
                attempt = 0;
                cursorRef.current = info.latestSeq;
                if (info.resync) resyncRef.current();
              },
              onEntry: (entry) => {
                cursorRef.current = entry.seq;
                entryRef.current(entry);
              },
            },
            { after: cursorRef.current, signal: controller.signal },
          );
        } catch {
          // 断开/后端重启：下面统一退避重连
        }
        if (stopped) return;
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, Math.min(500 * attempt, 5_000)));
      }
    };

    void loop();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, []);
}
