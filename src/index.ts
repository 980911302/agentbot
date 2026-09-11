import { resolve } from 'node:path';
import { AgentRuntime } from './server/runtime.js';
import { createAgentTools } from './server/tools.js';
import { resolveConfig } from './config.js';
import { OpenAIProvider } from './llm/openai-provider.js';
import { MemoryStore } from './memory/store.js';
import { InteractionBroker } from './interaction/broker.js';
import { SecretStore } from './secret/store.js';
import type { AgentEvent } from './agent/types.js';

export { AgentRuntime } from './server/runtime.js';
export { AgentLoop } from './agent/agent-loop.js';
export { AgentRegistry } from './agent/registry.js';
export { ContextBuilder } from './context/builder.js';
export { DEFAULT_BUDGET, estimateTokens } from './context/budget.js';
export { MemoryStore } from './memory/store.js';
export { MessageStore } from './store/messages.js';
export { retrieveMemories } from './memory/retrieve.js';
export { OpenAIProvider } from './llm/openai-provider.js';
export { ToolRegistry } from './tools/registry.js';
export { defineTool } from './tools/tool.js';
export {
  resolveConfig,
  loadEnvFile,
  MissingApiKeyError,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_OWNER_NAME,
} from './config.js';
export type { AppConfig, ModelOption } from './config.js';
export type {
  Agent,
  AgentEvent,
  AgentMemory,
  AgentRecord,
  CompactionState,
  ContextSectionStat,
  ContextStats,
  MemoryRef,
  Message,
  MessageContent,
  RunResult,
  ToolCall,
  WorkingFile,
} from './agent/types.js';
export type {
  MemoryBucket,
  MemoryEntry,
  MemoryEntryView,
  MemoryScope,
  MemorySnapshot,
  MemoryTier,
} from './memory/types.js';
export type { BuiltContext } from './context/builder.js';
export type { ContextBudget } from './context/budget.js';
export type { ChatOptions, LLMMessage, LLMProvider } from './llm/provider.js';
export type { Tool, ToolContext } from './tools/tool.js';

function printEvent(event: AgentEvent): void {
  if (event.type === 'context') {
    const rows = event.stats.sections
      .filter((section) => section.tokens > 0)
      .map((section) => `${section.label} ${section.tokens}t/${section.items}项`)
      .join(' · ');
    console.log(`\n[context] ${rows}\n[context] 合计 ${event.stats.totalTokens}t / 预算 ${event.stats.budgetTokens}t`);
    return;
  }
  if (event.type === 'message') {
    const content = event.message.content;
    if (content.type === 'text') {
      if (event.message.role === 'assistant') console.log(`\nagent> ${content.text}`);
      return;
    }
    if (content.type === 'tool_calls') {
      for (const call of content.calls) console.log(`  → ${call.name}(${call.arguments})`);
      return;
    }
    const flag = content.ok ? '←' : '✗';
    console.log(`  ${flag} ${content.name}: ${oneLine(content.result)} (${content.durationMs}ms)`);
    return;
  }
  if (event.type === 'compacted') {
    console.log(`[memory] 已压缩 ${event.messageCount} 条更早消息`);
    return;
  }
  if (event.type === 'memory') {
    for (const ref of event.added) {
      console.log(`[memory] + [${ref.scope}/${ref.entry.tier}] ${ref.entry.text}`);
    }
    if (event.merged > 0) console.log(`[memory] ${event.merged} 条已合并到已有记录`);
  }
}

function oneLine(text: string, maxLength = 160): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > maxLength ? `${single.slice(0, maxLength)}…` : single;
}

async function main(): Promise<void> {
  const rootDir = resolve(process.cwd());
  const config = resolveConfig({ env: process.env, rootDir });
  const memoryStore = new MemoryStore(config.dataDir);
  const broker = new InteractionBroker();
  const secrets = new SecretStore(config.dataDir);
  let runtime: AgentRuntime;

  runtime = new AgentRuntime({
    tools: createAgentTools({
      rootDir,
      memory: memoryStore,
      secrets,
      broker,
      // CLI 模式没有界面，卡片交互拿不到回答；让工具报错时说得清楚些
      agentName: async (agentId) => (await runtime?.registry.get(agentId))?.name ?? agentId,
      web: config.web,
    }),
    createProvider: (model) =>
      new OpenAIProvider({ apiKey: config.apiKey, model, baseURL: config.baseURL }),
    dataDir: config.dataDir,
    defaultModel: config.model,
    knownModels: ['deepseek-chat', 'deepseek-reasoner'],
    budget: config.budget,
    memoryExtraction: config.memoryExtraction,
    memoryStore,
    broker,
    secrets,
    ownerName: config.ownerName,
  });

  const agent = await runtime.ensureDefaultAgent();
  const prompt =
    process.argv.slice(2).join(' ').trim() || '读一下 package.json，用一句话总结这个项目';

  console.log(`agent> ${agent.name} · ${config.model}`);
  console.log(`user> ${prompt}`);

  const result = await runtime.send(agent.id, prompt, { onEvent: printEvent });
  console.log(`\n(${result.iterations} 轮 · ${result.stopReason})`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
