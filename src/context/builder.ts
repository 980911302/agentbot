import type {
  Agent,
  ContextSectionStat,
  ContextStats,
  MemoryRef,
  Message,
  WorkingFile,
} from '../agent/types.js';
import { messageText } from '../agent/types.js';
import { toLLMMessages } from '../llm/convert.js';
import type { LLMMessage } from '../llm/provider.js';
import { TIER_POLICY } from '../memory/policy.js';
import { rankMemories } from '../memory/retrieve.js';
import type { MemoryTier } from '../memory/types.js';
import type { MessageStore } from '../store/messages.js';
import { allocateSections, type SectionWants } from './allocate.js';
import { estimateTokens, truncateToTokens, type ContextBudget } from './budget.js';

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

const LABELS: Record<string, string> = {
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

/** 取某层的当前配额内条目；self 优先，其次 project，最后 user */
function pickTier(
  refs: MemoryRef[],
  tier: MemoryTier,
  filter: (ref: MemoryRef) => boolean,
): MemoryRef[] {
  const limit = TIER_POLICY[tier].inView;
  return refs
    .filter((ref) => ref.entry.tier === tier && filter(ref))
    .sort((left, right) => scopeRank(left) - scopeRank(right) || right.entry.updatedAt - left.entry.updatedAt)
    .slice(0, limit);
}

function scopeRank(ref: MemoryRef): number {
  if (ref.scope === 'self') return 0;
  if (ref.scope === 'project') return 1;
  return 2;
}

interface MessageGroup {
  messages: Message[];
  tokens: number;
}

/**
 * 把消息切成「原子组」：
 * 一条 tool_calls 消息 + 它对应的 tool 结果必须同进同出，
 * 否则会出现「只有 tool 消息、没有对应 tool_calls」的非法请求（DeepSeek 会直接 400）。
 * 孤立的 tool 结果直接丢弃。
 */
export function groupMessages(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const pending = new Map<string, MessageGroup>();

  for (const message of messages) {
    if (message.content.type === 'tool_calls') {
      const group: MessageGroup = { messages: [message], tokens: cost(message) };
      for (const call of message.content.calls) pending.set(call.id, group);
      groups.push(group);
      continue;
    }

    if (message.content.type === 'tool_result') {
      const group = pending.get(message.content.callId);
      if (!group) continue; // 找不到父亲，丢弃
      group.messages.push(message);
      group.tokens += cost(message);
      continue;
    }

    groups.push({ messages: [message], tokens: cost(message) });
  }

  // 补齐：有些 tool_calls 可能没等到结果（比如被中断），保留其调用记录即可
  return groups;
}

function trimRecentGroups(
  messages: Message[],
  maxTokens: number,
): { messages: Message[]; tokens: number; droppedGroups: number } {
  const groups = groupMessages(messages);
  const kept: MessageGroup[] = [];
  let tokens = 0;
  let droppedGroups = 0;

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (!group) continue;
    if (kept.length > 0 && tokens + group.tokens > maxTokens) break;
    kept.unshift(group);
    tokens += group.tokens;
  }
  droppedGroups = groups.length - kept.length;

  return { messages: kept.flatMap((group) => group.messages), tokens, droppedGroups };
}

function cost(message: Message): number {
  return estimateTokens(messageText(message)) + 8;
}

function collectWorkingFiles(messages: Message[]): WorkingFile[] {
  const seen = new Map<string, WorkingFile>();
  for (const message of messages) {
    if (message.content.type !== 'tool_calls') continue;
    for (const call of message.content.calls) {
      let path: unknown;
      try {
        path = (JSON.parse(call.arguments || '{}') as { path?: unknown }).path;
      } catch {
        continue;
      }
      if (typeof path !== 'string' || !path) continue;
      seen.set(path, { path, tool: call.name, at: message.createdAt });
    }
  }
  return [...seen.values()].slice(-12);
}

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

function composeSystem(parts: Record<string, string | undefined>): string {
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

function renderRefs(refs: MemoryRef[]): string {
  return refs
    .map((ref) => {
      const where = ref.scope === 'self' ? '' : ref.scope === 'user' ? '[共用] ' : '[项目] ';
      return `- ${where}${ref.entry.text}`;
    })
    .join('\n');
}

function renderFiles(files: WorkingFile[]): string {
  return files.map((file) => `- ${file.path}（${file.tool}）`).join('\n');
}

function renderMessages(messages: Message[]): string {
  return messages.map(renderMessage).join('\n');
}

/**
 * 私聊回合和它参加过的每个群回合，都在它自己的同一条对话里，
 * 用「这是哪个房间」标一下（文档第 2 节）。
 */
function renderMessage(message: Message): string {
  const text = messageText(message);
  if (!message.roomName) return text;
  const who = message.speaker ? `${message.speaker} 在「${message.roomName}」` : `「${message.roomName}」`;
  return `[${who}] ${text}`;
}

function clip(message: Message): string {
  return shorten(messageText(message));
}

function shorten(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > 60 ? `${single.slice(0, 60)}…` : single;
}

function section(
  key: string,
  tokens: number,
  limit: number,
  items: number,
  detail: string[],
): ContextSectionStat {
  return { key, label: LABELS[key] ?? key, tokens, limit, items, detail };
}
