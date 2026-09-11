import type { RoomMemberLike } from './member.js';

export interface MentionResult {
  /** 被点名（或 @everyone）的成员 id */
  ids: string[];
  everyone: boolean;
}

const EVERYONE_ALIASES = ['everyone', 'all', '所有人', '全体', '全员', '大家'];

/**
 * 把 `@显示名` 解析成成员 id。
 * 解析失败就当普通文本（文档第 7 节第 6 条）。
 *
 * 长名优先，并且匹配过的片段会被「吃掉」——
 * 否则 `@知识库服务·备份` 会同时命中「知识库服务·备份」和「知识库服务」。
 */
export function resolveMentions(text: string, members: RoomMemberLike[]): MentionResult {
  const everyone = EVERYONE_ALIASES.some((alias) => text.includes(`@${alias}`));
  const sorted = [...members].sort((left, right) => right.name.length - left.name.length);

  let working = text;
  const ids: string[] = [];
  for (const member of sorted) {
    if (!member.name) continue;
    const token = `@${member.name}`;
    if (!working.includes(token)) continue;
    ids.push(member.id);
    working = working.split(token).join('');
  }

  return { ids, everyone };
}

/** 这一轮是否轮到它必须开口 */
export function isSummoned(agentId: string, mentions: MentionResult): boolean {
  return mentions.everyone || mentions.ids.includes(agentId);
}

/** 把 @ 从正文里摘掉，避免模型把别人名字当成要回复的对象 */
export function stripMentions(text: string, members: RoomMemberLike[]): string {
  let out = text;
  const sorted = [...members].sort((left, right) => right.name.length - left.name.length);
  for (const member of sorted) {
    out = out.split(`@${member.name}`).join(member.name);
  }
  return out;
}
