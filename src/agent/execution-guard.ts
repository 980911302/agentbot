/** 异步工作提交前必须重新核对执行权；AbortSignal 本身不保证第三方 Promise 会退出。 */
export interface ExecutionGuard { signal?: AbortSignal; isCurrent?: () => boolean }
export function assertExecution(guard: ExecutionGuard): void {
  guard.signal?.throwIfAborted();
  if (guard.isCurrent && !guard.isCurrent()) throw new DOMException('执行权已失效', 'AbortError');
}
export async function guarded<T>(work: Promise<T>, guard: ExecutionGuard): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(guard.signal?.reason ?? new DOMException('执行已取消', 'AbortError'));
      guard.signal?.addEventListener('abort', abort, { once: true });
      if (guard.signal?.aborted) abort();
    });
    const result = await Promise.race([work, cancelled]);
    assertExecution(guard);
    return result;
  } finally { if (abort) guard.signal?.removeEventListener('abort', abort); }
}
