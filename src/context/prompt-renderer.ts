import type { ContextSectionStat } from '../agent/types.js';
import type { Message, WorkingFile } from '../agent/types.js';
import { messageText } from '../agent/types.js';

/**
 * prompt-renderer（E2.4）：系统提示词与统计明细的渲染。
 */

export const LABELS: Record<string, string> = {
  instructions: 'Agent 角色',
  portrait: '画像',
  shared: '共用的「关于你」',
  log: '日志近况',
  scratch: '随手笔记',
  retrieval: '相关检索',
  compacted: '更早摘要',
  recent: '最近原文',
  files: '工作文件',
  task: '当前任务',
};

/**
 * 身份块。
 *
 * 模型必须知道「我是谁」——否则问它叫什么，它只能把职责复述一遍。
 * 名字同时是群聊里 @ 人的依据，认不出自己就没法正确判断「有没有人点我」。
 */
export function composeIdentity(agent: {
  id: string;
  name: string;
  title?: string;
  description?: string;
}): string {
  const lines = [`你是「${agent.name}」（id: ${agent.id}）。`];

  const title = agent.title?.trim();
  const description = agent.description?.trim();
  if (title) lines.push(`一句话简介：${title}`);
  if (description && description !== title) lines.push(`职责描述：${description}`);

  return lines.join('\n');
}

export function composeSystem(parts: Record<string, string | undefined>): string {
  const blocks: string[] = [parts.identity?.trim() ?? ''];
  const instructions = parts.instructions?.trim();
  if (instructions) {
    blocks.push(blocks[0] ? `## 你的职责\n${instructions}` : instructions);
  }

  const push = (title: string, body?: string, raw = false) => {
    if (!body || !body.trim()) return;
    blocks.push(raw ? body : `## ${title}\n${body}`);
  };

  push('', parts.brief, true);
  push('画像', parts.portrait);
  push('关于你（所有智能体共用）', parts.shared);
  push('日志近况', parts.log);
  push('随手笔记', parts.scratch);
  push('相关检索', parts.retrieval);
  push('更早的对话摘要', parts.compacted);
  push('工作文件', parts.files);

  return blocks.filter(Boolean).join('\n\n');
}

export function renderFiles(files: WorkingFile[]): string {
  return files.map((file) => `- ${file.path}（${file.tool}）`).join('\n');
}

export function clip(message: Message): string {
  return shorten(messageText(message));
}

export function shorten(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > 60 ? `${single.slice(0, 60)}…` : single;
}

export function section(
  key: string,
  tokens: number,
  limit: number,
  items: number,
  detail: string[],
): ContextSectionStat {
  return { key, label: LABELS[key] ?? key, tokens, limit, items, detail };
}
