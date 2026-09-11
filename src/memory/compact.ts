import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CompactionState } from '../agent/types.js';
import { messageText } from '../agent/types.js';
import type { Agent, Message } from '../agent/types.js';
import type { LLMProvider } from '../llm/provider.js';
import type { MessageStore } from '../store/messages.js';
import { estimateTokens } from '../context/budget.js';

const SUMMARY_INSTRUCTIONS = [
  '你是上下文压缩器。把给定的历史消息压缩成一份事实摘要，供后续对话继续使用。',
  '要求：保留目标、已完成的动作、关键结论、未决问题、涉及的文件路径与标识符；',
  '删掉寒暄、重复内容和中间推理过程；用第三人称，条目式，控制在 600 字以内。',
  '只输出摘要正文，不要任何前言或解释。',
].join('\n');

/** 压缩状态按智能体存，和长期记忆分开 */
export class CompactionStore {
  private readonly cache = new Map<string, CompactionState | null>();
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'compaction');
  }

  async get(agentId: string): Promise<CompactionState | null> {
    if (this.cache.has(agentId)) return this.cache.get(agentId) ?? null;
    try {
      const raw = await readFile(join(this.dir, `${agentId}.json`), 'utf8');
      const state = JSON.parse(raw) as CompactionState;
      this.cache.set(agentId, state);
      return state;
    } catch {
      this.cache.set(agentId, null);
      return null;
    }
  }

  async set(agentId: string, state: CompactionState): Promise<void> {
    this.cache.set(agentId, state);
    const file = join(this.dir, `${agentId}.json`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state, null, 2), 'utf8');
  }

  async clear(agentId: string): Promise<void> {
    this.cache.set(agentId, null);
    await this.set(agentId, {
      summary: '',
      coversUpTo: 0,
      messageCount: 0,
      updatedAt: 0,
    });
  }
}

export class Compactor {
  constructor(
    private readonly messages: MessageStore,
    private readonly store: CompactionStore,
    private readonly trigger: number,
    private readonly reserveRecent: number,
  ) {}

  /**
   * 对话太长时，把更早的部分压成摘要。
   * 只压「日志层之外」的原始消息，保证眼前永远有最近原文。
   */
  async maybeCompact(
    agent: Agent,
    provider: LLMProvider,
  ): Promise<{ state: CompactionState; tokens: number } | null> {
    const current = agent.memory.compaction;
    const coveredUpTo = current?.coversUpTo ?? 0;
    const older = await this.messages.olderThan(agent.id, this.reserveRecent, coveredUpTo);
    if (older.length < this.trigger) return null;

    const transcript = older
      .map((message) => `${speaker(message)}: ${messageText(message)}`)
      .join('\n')
      .slice(0, 48_000);

    const previous = current?.summary;
    const prompt = previous
      ? `已有摘要：\n${previous}\n\n新增历史消息：\n${transcript}`
      : `历史消息：\n${transcript}`;

    const response = await provider.chat(
      [
        { role: 'system', content: SUMMARY_INSTRUCTIONS },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.2 },
    );

    const summary = (response.content ?? '').trim();
    if (!summary) return null;

    const last = older[older.length - 1];
    const state: CompactionState = {
      summary,
      coversUpTo: last ? last.createdAt : coveredUpTo,
      messageCount: (current?.messageCount ?? 0) + older.length,
      updatedAt: Date.now(),
    };

    await this.store.set(agent.id, state);
    return { state, tokens: estimateTokens(summary) };
  }
}

function speaker(message: Message): string {
  if (message.role === 'user') return '用户';
  if (message.role === 'assistant') return '助手';
  return '工具';
}
