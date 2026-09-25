import { isAvatarRef } from '../../../../src/shared/contracts/agent-profile.js';

/**
 * 头像展示地址（E5.1）。
 *
 * 记录里的 avatar 是数据目录头像目录的资源引用（`avatars/<文件名>`）；
 * 服务端会顺带给出 avatarUrl（已带 updatedAt 做缓存失效）。两者都没有时返回 null，
 * 界面回退到生成的脸——历史数据里的 emoji / 绝对路径不当作图片渲染。
 *
 * 这条兜底路径存在的原因：App 的 currentBotSummary 是重新拼的对象（E4.7 在改它），
 * 不一定带上 avatarUrl，所以前端要能从原始引用自己算出同一个地址。
 */
export function agentAvatarUrl(bot: {
  id: string;
  avatar?: string;
  avatarUrl?: string | null;
  updatedAt?: string;
}): string | null {
  if (bot.avatarUrl) return bot.avatarUrl;
  if (!isAvatarRef(bot.avatar)) return null;
  const version = bot.updatedAt ? `?v=${encodeURIComponent(bot.updatedAt)}` : '';
  return `/api/agents/${bot.id}/avatar${version}`;
}