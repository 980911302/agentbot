import type { IncomingMessage, ServerResponse } from 'node:http';
import { PING_INTERVAL_MS, sse } from '../transport/index.js';
import type { RouteContext } from './context.js';

/**
 * GET /api/events?after=<seq>：界面事件的独立订阅（E3.4 第一步）。
 *
 * 协议：
 *   - `ready` 帧先到：{ latestSeq, resync }；resync=true 表示游标太旧
 *     （被保留窗口挤掉，或服务端重启后 seq 回退），客户端要先重新取快照；
 *   - 之后 `entry` 帧按 seq 升序补发积压，再接新事件；
 *   - 不带 after：只订阅新事件，不补发；
 *   - 心跳是 SSE 注释行，断线只断订阅，不牵动已经开始的执行。
 */
export function handleEventsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): void {
  const raw = new URL(request.url ?? '/', 'http://localhost').searchParams.get('after');
  const parsed = raw === null || raw === '' ? Number.NaN : Number.parseInt(raw, 10);
  const after = Number.isFinite(parsed) ? parsed : context.runtime.events.latestSeq;

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const replay = context.runtime.events.since(after);
  sse(response, 'ready', { latestSeq: replay.latestSeq, resync: replay.resync });
  for (const entry of replay.entries) sse(response, 'entry', entry);

  const unsubscribe = context.runtime.events.subscribe((entry) => sse(response, 'entry', entry));
  const ping = setInterval(() => {
    if (!response.writableEnded && !response.destroyed) response.write(': ping\n\n');
  }, PING_INTERVAL_MS);

  const close = (): void => {
    unsubscribe();
    clearInterval(ping);
  };
  response.on('close', close);
  response.on('error', close);
}
