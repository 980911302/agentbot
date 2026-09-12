import type { AgentRecord, Message } from '../agent/types.js';

/**
 * Presenters（E2.1）：把领域对象折成 HTTP 响应的视图形状。
 *
 * 只做转换，不做 IO——状态与计数由路由从运行时取好后传入，
 * 因此这里不依赖 AgentRuntime，单测不需要起新的运行时。
 */

export interface BotViewSource {
  /** 该智能体当前是否在跑回合 */
  busy: boolean;
  /** 对话线上的消息条数 */
  conversationCount: number;
}

/** 智能体的界面视图：状态与计数一律来自真实数据源，不放假数 */
export function toBotView(record: AgentRecord, source: BotViewSource) {
  return {
    id: record.id,
    name: record.name,
    title: record.title,
    role: record.title || record.instructions.slice(0, 30),
    /** 完整职责文本，资料编辑要用；role 只是展示截断 */
    instructions: record.instructions,
    color: record.color,
    status: source.busy ? 'working' : 'idle',
    activity: '',
    conversationCount: source.conversationCount,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

export interface DisplayMessageView {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  senderName?: string;
  senderColor?: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
    result?: string;
    durationMs?: number;
    status: 'running' | 'ok' | 'error';
  }>;
  createdAt: string;
  error?: boolean;
}

/**
 * 把存下来的消息折成界面用的形状。
 * 一次工具调用 + 它的结果是两条消息，这里合并回一张卡片。
 */
export function toDisplayMessages(raw: Message[]): DisplayMessageView[] {
  const out: DisplayMessageView[] = [];

  for (const message of raw) {
    const content = message.content;

    if (content.type === 'text') {
      const text = content.text.trim();
      if (!text) continue;
      out.push({
        id: message.id,
        role: message.role === 'user' ? 'user' : 'assistant',
        content: text,
        senderName: message.speaker,
        toolCalls: [],
        createdAt: new Date(message.createdAt).toISOString(),
      });
      continue;
    }

    if (content.type === 'tool_calls') {
      out.push({
        id: message.id,
        role: 'assistant',
        content: '',
        toolCalls: content.calls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          status: 'running' as const,
        })),
        createdAt: new Date(message.createdAt).toISOString(),
      });
      continue;
    }

    // tool_result → 回填到对应卡片
    for (let index = out.length - 1; index >= 0; index -= 1) {
      const target = out[index];
      const call = target?.toolCalls.find((item) => item.id === content.callId);
      if (!call) continue;
      call.result = content.result;
      call.durationMs = content.durationMs;
      call.status = content.ok ? 'ok' : 'error';
      break;
    }
  }

  return out;
}

export interface ArtifactChip {
  path: string;
  tool: string;
  createdAt: string;
}

/** 从最近消息里抽出「产物」清单（文件读写类工具的 path 参数） */
export function collectArtifacts(raw: Message[]): ArtifactChip[] {
  const seen = new Map<string, ArtifactChip>();
  for (const message of raw) {
    const content = message.content;
    if (content.type !== 'tool_calls') continue;
    for (const call of content.calls) {
      let path: string | undefined;
      try {
        const parsed = JSON.parse(call.arguments || '{}') as { path?: unknown };
        if (typeof parsed.path === 'string' && parsed.path) path = parsed.path;
      } catch {
        // 参数还不是合法 JSON
      }
      if (!path) continue;
      if (!seen.has(path)) {
        seen.set(path, { path, tool: call.name, createdAt: new Date(message.createdAt).toISOString() });
      }
    }
  }
  return [...seen.values()];
}
