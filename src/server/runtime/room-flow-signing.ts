import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RoomReplyRoute } from '../../shared/contracts/room-flow.js';

/**
 * 群流程回复路由的签名（E3.7 收尾）。
 *
 * 签名逻辑放在 runtime 而不是 shared/contracts：契约层严禁引用 Node
 * （scripts/check-imports.mjs 强制），而 HMAC 必须用 node:crypto。
 * 密钥由 RoomFlowStore 生成于数据目录，本模块只做计算与比对。
 */

export function buildReplyRouteSignature(secret: string, route: Omit<RoomReplyRoute, 'signature'>): string {
  const content = [route.kind, route.roomId, route.flowId, route.grantId, route.mode].join(':');
  return createHmac('sha256', secret).update(content).digest('hex');
}

export function createSignedReplyRoute(
  secret: string,
  route: Omit<RoomReplyRoute, 'signature'>,
): RoomReplyRoute {
  const signature = buildReplyRouteSignature(secret, route);
  return { ...route, signature };
}

export function verifyReplyRouteSignature(secret: string, route: RoomReplyRoute): boolean {
  if (!route || route.kind !== 'room_flow' || !route.signature) return false;
  const expected = buildReplyRouteSignature(secret, {
    kind: route.kind,
    roomId: route.roomId,
    flowId: route.flowId,
    grantId: route.grantId,
    mode: route.mode,
  });
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(route.signature, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
