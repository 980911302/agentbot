import type { Agent, ContextSectionStat, ContextStats, MemoryRef, Message } from '../agent/types.js';
import { messageText } from '../agent/types.js';
import { toLLMMessages } from '../llm/convert.js';
import type { LLMMessage } from '../llm/provider.js';
import { rankMemories } from '../memory/retrieve.js';
import type { MessageStore } from '../store/messages.js';
import { allocateSections, type SectionWants } from './allocate.js';
import { estimateTokens, truncateToTokens, type ContextBudget } from './budget.js';
import { collectWorkingFiles, renderMessages, trimRecentGroups } from './history-selector.js';
import { pickTier, renderRefs } from './memory-selector.js';
import { clip, composeIdentity, composeSystem, renderFiles, section, shorten } from './prompt-renderer.js';

// 兼容导出：identity.test 等仍从 builder 取
export { composeIdentity } from './prompt-renderer.js';
export { groupMessages } from './history-selector.js';

export interface BuiltContext {
  agentId: string;
  system: string;
  messages: LLMMessage[];
  stats: ContextStats;
  /** 本次进过眼前的记忆，用于回写 lastSurfacedAt */
  surfaced: MemoryRef[];
  droppedRecent: number;
  droppedGroups: number;
}

export interface BuildOptions {
  /**
   * 这一轮额外要交代的规矩（例如群回合的发言纪律）。
   * 放在智能体指令之后、记忆之前。
   */
  turnBrief?: string;
}

/**
 * 组装这一轮真正送进模型的东西。
 *
 * 对应文档第 4 节的读取顺序：
 *   最近原文 → 更早摘要 → 画像事实（自己的 + 共用的）→ 日志近况
 * 更早、更碎的日志与随手笔记不在眼前，靠检索（第 7 节的「搜」）翻出来。
 */
export class ContextBuilder {
  constructor(
    private readonly messages: MessageStore,
    private readonly budget: ContextBudget,
  ) {}

  async build(agent: Agent, task: Message, options: BuildOptions = {}): Promise<BuiltContext> {
    const taskText = messageText(task);
    const recentCandidates = await this.messages.recent(agent.id, this.budget.recentLimit, task.id);

    const refs = agent.memory.refs;

    // ── 常在的那一层：画像（自己的 + 共用的「关于你」） ──
    const ownPortrait = pickTier(refs, 'portrait', (ref) => ref.scope === 'self');
    const sharedPortrait = pickTier(refs, 'portrait', (ref) => ref.scope === 'user');
    const projectPortrait = pickTier(refs, 'portrait', (ref) => ref.scope === 'project');

    // ── 日志近况：只带最近一小段，更早的要搜 ──
    const logRecent = pickTier(refs, 'log', () => true);

    // ── 随手笔记：淡得最快，只带新鲜的一小撮 ──
    const scratchRecent = pickTier(refs, 'scratch', () => true);

    // ── 检索：补上眼前没有、但与当前任务相关的 ──
    const inViewIds = new Set(
      [...ownPortrait, ...sharedPortrait, ...projectPortrait, ...logRecent, ...scratchRecent].map(
        (ref) => ref.entry.id,
      ),
    );
    const retrieval = rankMemories(
      refs.filter((ref) => !inViewIds.has(ref.entry.id)),
      taskText,
      { maxItems: 10, minScore: 0.06 },
    );

    const portraitText = renderRefs([...ownPortrait, ...projectPortrait]);
    const sharedText = renderRefs(sharedPortrait);
    const logText = renderRefs(logRecent);
    const scratchText = renderRefs(scratchRecent);
    const retrievalText = renderRefs(retrieval);

    const compaction = agent.memory.compaction;
    const files = collectWorkingFiles(recentCandidates);
    const compactedText = compaction
      ? `（已压缩 ${compaction.messageCount} 条更早的消息）\n${compaction.summary}`
      : '';
    const filesText = renderFiles(files);

    const recentTokens = estimateTokens(renderMessages(recentCandidates));

    const wants: SectionWants = {
      instructions:
        estimateTokens(composeIdentity(agent)) +
        estimateTokens(agent.instructions) +
        estimateTokens(options.turnBrief ?? ''),
      memory: estimateTokens(portraitText) + estimateTokens(sharedText),
      retrieval: estimateTokens(retrievalText),
      compacted: estimateTokens(compactedText),
      recent: recentTokens,
      files: estimateTokens(filesText),
      task: estimateTokens(taskText),
    };

    const { alloc } = allocateSections(this.budget, wants);
    const logBudget = Math.max(400, Math.round(alloc.memory * 0.6));
    const scratchBudget = Math.max(200, Math.round(alloc.memory * 0.3));

    const system = composeSystem({
      identity: composeIdentity(agent),
      instructions: agent.instructions,
      brief: options.turnBrief,
      portrait: truncateToTokens(portraitText, Math.max(600, alloc.memory)),
      shared: truncateToTokens(sharedText, Math.max(300, Math.round(alloc.memory * 0.4))),
      log: truncateToTokens(logText, logBudget),
      scratch: truncateToTokens(scratchText, scratchBudget),
      retrieval: truncateToTokens(retrievalText, alloc.retrieval),
      compacted: truncateToTokens(compactedText, alloc.compacted),
      files: truncateToTokens(filesText, Math.max(alloc.memory, 800)),
    });

    // 关键：按「原子组」裁剪，tool_calls 与它的结果不会被拆散
    const trimmed = trimRecentGroups(recentCandidates, alloc.recent);

    const messages: LLMMessage[] = [
      { role: 'system', content: system },
      ...toLLMMessages(trimmed.messages),
      ...toLLMMessages([task]),
    ];

    const sections: ContextSectionStat[] = [
      section(
        'instructions',
        wants.instructions,
        wants.instructions,
        1,
        [agent.name, ...(options.turnBrief ? ['+ 本轮规则'] : [])],
      ),
      section(
        'portrait',
        Math.min(wants.instructions + wants.memory, alloc.memory),
        alloc.memory,
        ownPortrait.length + projectPortrait.length,
        [...ownPortrait, ...projectPortrait].map((ref) => shorten(ref.entry.text)),
      ),
      section(
        'shared',
        estimateTokens(sharedText),
        Math.max(300, Math.round(alloc.memory * 0.4)),
        sharedPortrait.length,
        sharedPortrait.map((ref) => shorten(ref.entry.text)),
      ),
      section('log', estimateTokens(logText), logBudget, logRecent.length, logRecent.map((ref) => shorten(ref.entry.text))),
      section('scratch', estimateTokens(scratchText), scratchBudget, scratchRecent.length, scratchRecent.map((ref) => shorten(ref.entry.text))),
      section('retrieval', estimateTokens(retrievalText), alloc.retrieval, retrieval.length, retrieval.map((ref) => shorten(ref.entry.text))),
      section(
        'compacted',
        Math.min(wants.compacted, alloc.compacted),
        alloc.compacted,
        compaction ? 1 : 0,
        compaction ? [`覆盖 ${compaction.messageCount} 条`] : [],
      ),
      section('recent', trimmed.tokens, alloc.recent, trimmed.messages.length, trimmed.messages.map(clip)),
      section('files', estimateTokens(filesText), Math.max(alloc.memory, 800), files.length, files.map((file) => file.path)),
      section('task', wants.task, wants.task, 1, [clip(task)]),
    ];

    const totalTokens = sections.reduce((sum, item) => sum + item.tokens, 0);

    return {
      agentId: agent.id,
      system,
      messages,
      stats: {
        sections,
        totalTokens,
        budgetTokens: this.budget.total,
        generatedAt: Date.now(),
      },
      surfaced: [
        ...ownPortrait,
        ...sharedPortrait,
        ...projectPortrait,
        ...logRecent,
        ...scratchRecent,
        ...retrieval,
      ],
      droppedRecent: recentCandidates.length - trimmed.messages.length,
      droppedGroups: trimmed.droppedGroups,
    };
  }
}

