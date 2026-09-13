/**
 * 自然语言不再制造硬投递义务。结构化发送入口才绑定真实 target/payload。
 * 保留函数签名以免旧调用立即崩，始终返回 undefined。
 */
export function requiredDeliveryFrom(_text: string): { kind: 'room'; requestedBy: 'message' } | undefined {
  return undefined;
}

/** 平台来源说明只能来自消息元数据，模型正文不能自行制造。 */
export function hasReservedOriginPrefix(text: string): boolean {
  return /^\s*\[(?:发言于|消息来自|系统通知)(?:[^\]\r\n]*)\]/u.test(text);
}

/** 失败后允许如实说明，但不能把失败说成已经投递。 */
export function claimsSuccessfulRoomDelivery(text: string): boolean {
  const value = text.replace(/\s+/gu, ' ').trim();
  if (!value) return false;
  const room = /(?:群(?:里|聊|组)?|聊天室|房间|频道|group|room|channel)/iu.test(value);
  const success = /(?:已(?:经)?|成功|刚刚?|确实|补发|重发|发出去了|投递成功|sent|posted|delivered)/iu.test(value);
  const negative = /(?:尚未|还没|没有发|未发送|未投递|失败|无法|不能|not sent|failed|unable)/iu.test(value);
  return room && success && !negative;
}
