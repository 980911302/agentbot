import { existsSync, realpathSync } from 'node:fs';

import { pathToFileURL } from 'node:url';
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



import { runCli } from './cli/agent-cli.js';

// 只有作为 CLI 入口直接执行时才启动；被 import 只拿公共导出（E1 验收：导入不隐式启动）
const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry || !existsSync(entry)) return false;
  return import.meta.url === pathToFileURL(realpathSync(entry)).href;
})();

if (invokedAsScript) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  });
}
