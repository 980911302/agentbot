import type { AvatarState } from '../../components/LivingAvatar';

export const EVERYONE_MENTION_ID = '__everyone__';

export type TimelineLayoutKind = 'dm-user' | 'dm-agent' | 'group-stream';

export type MessageEnterKind = 'pop' | 'rise';

export interface MentionCandidate {
  id: string;
  name: string;
  color: string;
}

export interface CompositeMember {
  id: string;
  name: string;
  color: string;
  status?: string;
}

/** 运行状态 → 活头像脸。queued 算正在干活。 */
export function faceStateFromStatus(status?: string | null): AvatarState {
  if (status === 'thinking') return 'thinking';
  if (status === 'working' || status === 'queued') return 'working';
  if (status === 'waiting') return 'waiting';
  if (status === 'error' || status === 'blocked') return 'blocked';
  if (status === 'done') return 'done';
  // 暂停（UI-05）：闭眼、灰度 60%、无循环动画，与「忙碌」明确区分
  if (status === 'paused') return 'paused';
  return 'idle';
}

/** 1:1 两列；群是说话人流，不画私聊气泡墙。 */
export function timelineLayoutKind(input: {
  isGroup: boolean;
  role: 'user' | 'assistant';
}): TimelineLayoutKind {
  if (input.isGroup) return 'group-stream';
  return input.role === 'user' ? 'dm-user' : 'dm-agent';
}

/** 主人气泡 pop；对方/群成员短上浮。不按发言顺序做 delay 排队。 */
export function messageEnterKind(input: {
  isGroup: boolean;
  role: 'user' | 'assistant';
}): MessageEnterKind {
  return input.role === 'user' ? 'pop' : 'rise';
}

export type MentionPart = { text: string; mention?: boolean };

export type MentionedBlock = { type: 'paragraph'; parts: MentionPart[] };

/**
 * 群消息里的 @ 必须和前后文同属一个段落，不能每个碎片单独成块。
 * 空行分段；段内用 splitMentions 切出内联提及。
 */
export function mentionedRichModel(text: string, names: string[]): MentionedBlock[] {
  const chunks = text.length === 0 ? [''] : text.split(/\n{2,}/);
  return chunks.map((chunk) => ({
    type: 'paragraph',
    parts: splitMentions(chunk, names),
  }));
}

/** 把文本按 @名字 / @everyone 切段，命中成员的提及高亮 */
export function splitMentions(
  text: string,
  names: string[],
): Array<{ text: string; mention?: boolean }> {
  if (!text) return [{ text }];
  const labels = [...names, 'everyone'].filter(Boolean);
  if (labels.length === 0) return [{ text }];
  const escaped = labels
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const pattern = new RegExp(`@(${escaped})`, 'g');
  const parts: Array<{ text: string; mention?: boolean }> = [];
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push({ text: text.slice(lastIndex, index) });
    parts.push({ text: match[0], mention: true });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex) });
  return parts.length > 0 ? parts : [{ text }];
}

export function mentionCandidateList(
  members: MentionCandidate[],
  query = '',
): MentionCandidate[] {
  const everyone: MentionCandidate = {
    id: EVERYONE_MENTION_ID,
    name: 'everyone',
    color: '#8b93a7',
  };
  const list = [everyone, ...members];
  const needle = query.trim().toLowerCase();
  if (!needle) return list;
  return list.filter((item) => item.name.toLowerCase().includes(needle));
}

/** 群复合头像：叠 2–3 张成员脸，其余用余数。 */
export function groupCompositeFaces(members: CompositeMember[], maxFaces = 3): {
  faces: CompositeMember[];
  remainder: number;
} {
  const faces = members.slice(0, maxFaces);
  return { faces, remainder: Math.max(0, members.length - faces.length) };
}
