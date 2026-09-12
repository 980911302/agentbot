import type { ServerResponse } from 'node:http';

/** SSE 心跳间隔：注释行保活，防止代理/客户端超时断开 */
export const PING_INTERVAL_MS = 15_000;

/** 写一帧 SSE：event + data；连接已结束则静默丢弃 */
export function sse(response: ServerResponse, event: string, data: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
