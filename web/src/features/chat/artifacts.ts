import type { AgentEvent, ArtifactView } from '../../types';

const DELIVERED_FILE_PREFIX = '📎 已交付文件：';

/**
 * 只识别 SendToUser 真正交付给用户的文件。
 * Read 的 path 是输入文件，不是产物，不能出现在附件栏。
 */
export function deliveredFilePath(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(DELIVERED_FILE_PREFIX)) continue;
    const path = trimmed.slice(DELIVERED_FILE_PREFIX.length).trim();
    if (path) return path;
  }
  return undefined;
}

export function artifactFromEvent(event: AgentEvent): ArtifactView | undefined {
  if (
    event.type !== 'message' ||
    event.message.role !== 'assistant' ||
    event.message.content.type !== 'text'
  ) {
    return undefined;
  }
  const path = deliveredFilePath(event.message.content.text);
  if (!path) return undefined;
  return {
    path,
    tool: '文件',
    createdAt: new Date(event.message.createdAt).toISOString(),
  };
}
