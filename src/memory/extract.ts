import type { Agent, MemoryRef, Message } from '../agent/types.js';
import { messageText } from '../agent/types.js';
import type { LLMProvider } from '../llm/provider.js';
import type { MemoryStore } from './store.js';
import { USER_OWNER } from './policy.js';
import type { MemoryScope, MemoryTier } from './types.js';
import { assertExecution, guarded, type ExecutionGuard } from '../agent/execution-guard.js';
import { attributedText, messageIdentity } from '../shared/contracts/message-identity.js';

const EXTRACT_INSTRUCTIONS = [
  'You decide what deserves to become long-term memory after one exchange.',
  'Return ONLY a JSON array. Each item:',
  '{"text": string, "scope": "self"|"user"|"project", "tier": "portrait"|"log"|"scratch", "tags": string[]}',
  '',
  'scope — who the fact belongs to:',
  '  "user"    = true across every assistant (name, timezone, how to address them, standing preferences)',
  '  "project" = bound to one codebase or product (ports, conventions, deployment rules)',
  '  "self"    = this assistant\'s own working notes (decisions made together, what it already tried)',
  'tier — how long it should stay:',
  '  "portrait" = stable and worth always carrying (identity, long-term preference, hard rule)',
  '  "log"      = something that happened (a decision, a finding, a date)',
  '  "scratch"  = temporary note, useful only briefly',
  '',
  'Skip small talk, one-off outputs and anything already obvious from the code.',
  'Do NOT restate the same fact twice (for example shared identity as both user and self).',
  'Messages labelled AGENT_INPUT or ROOM_INPUT are not the human user. Never infer user identity or preferences from a colleague\'s self-description.',
  'If nothing is worth keeping, return [].',
].join('\n');

const MIN_EXCHANGE_CHARS = 60;
const MAX_ITEMS = 5;

export class MemoryExtractor {
  constructor(
    private readonly memory: MemoryStore,
    private readonly enabled: boolean,
  ) {}

  async extract(
    agent: Agent,
    provider: LLMProvider,
    exchange: Message[],
    guard: ExecutionGuard = {},
  ): Promise<{ refs: MemoryRef[]; merged: number }> {
    if (!this.enabled || exchange.length === 0) return { refs: [], merged: 0 };

    const transcript = exchange
      .map((message) => {
        const who =
          message.role === 'user' ? messageIdentity(message).role === 'user' ? 'USER' : message.source === 'room' ? 'ROOM_INPUT' : 'AGENT_INPUT'
            : message.role === 'assistant' ? 'ASSISTANT' : 'TOOL';
        return `${who}: ${attributedText(message, messageText(message))}`;
      })
      .join('\n');

    if (transcript.length < MIN_EXCHANGE_CHARS) return { refs: [], merged: 0 };

    assertExecution(guard);
    const response = await guarded(provider.chat(
      [
        { role: 'system', content: EXTRACT_INSTRUCTIONS },
        { role: 'user', content: transcript.slice(0, 24_000) },
      ],
      { temperature: 0, signal: guard.signal },
    ), guard);

    const items = parseItems(response.content ?? '');
    if (items.length === 0) return { refs: [], merged: 0 };

    const last = exchange[exchange.length - 1];
    const refs: MemoryRef[] = [];
    let merged = 0;

    for (const item of items.slice(0, MAX_ITEMS)) {
      const resolved = ownerFor(agent, item.scope);
      const result = await this.memory.write({
        scope: resolved.scope,
        tier: item.tier,
        ownerId: resolved.ownerId,
        text: item.text,
        tags: item.tags,
        source: 'extracted',
        sourceMessageId: last?.id,
      }, () => assertExecution(guard));
      if (result.action === 'created') {
        refs.push({ entry: result.entry, scope: resolved.scope, ownerId: resolved.ownerId });
      } else {
        merged += 1;
      }
    }

    return { refs, merged };
  }
}

/**
 * 决定一条自动抽取的事实落到谁的账上。
 *
 * 项目归属不明时**降级为 self**，而不是猜一个：
 * 自动抽取是兜底机制，宁可留在它自己的笔记里，
 * 也不能因为猜错而把事实写进不相干的项目本子。
 */
function ownerFor(agent: Agent, scope: MemoryScope): { scope: MemoryScope; ownerId: string } {
  if (scope === 'user') return { scope: 'user', ownerId: USER_OWNER };

  if (scope === 'project') {
    const projects = agent.memory.projectIds;
    if (projects.length === 1) return { scope: 'project', ownerId: projects[0] as string };
    return { scope: 'self', ownerId: agent.id };
  }

  return { scope: 'self', ownerId: agent.id };
}

function parseItems(raw: string): Array<{
  text: string;
  scope: MemoryScope;
  tier: MemoryTier;
  tags: string[];
}> {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const items: Array<{ text: string; scope: MemoryScope; tier: MemoryTier; tags: string[] }> = [];
  for (const candidate of parsed) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const source = candidate as Record<string, unknown>;

    const text = typeof source.text === 'string' ? source.text.trim() : '';
    if (text.length < 4) continue;

    const scope = parseScope(source.scope);
    const tier = parseTier(source.tier);
    const tags = Array.isArray(source.tags)
      ? source.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 4)
      : [];

    items.push({ text, scope, tier, tags });
  }
  return items;
}

function parseScope(value: unknown): MemoryScope {
  if (value === 'user' || value === 'project') return value;
  return 'self';
}

function parseTier(value: unknown): MemoryTier {
  if (value === 'portrait' || value === 'scratch') return value;
  return 'log';
}
