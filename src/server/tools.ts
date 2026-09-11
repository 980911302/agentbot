import { calculator } from '../tools/examples/calculator.js';
import { createDeliverTool } from '../tools/examples/deliver.js';
import { createListFilesTool, createReadFileTool, createWriteFileTool } from '../tools/examples/files.js';
import { createInteractionTools } from '../tools/examples/interaction.js';
import { createMemoryTools } from '../tools/examples/memory.js';
import { createWebTools } from '../tools/examples/web.js';
import type { InteractionBroker } from '../interaction/broker.js';
import type { MemoryStore } from '../memory/store.js';
import type { SecretStore } from '../secret/store.js';
import type { Tool } from '../tools/tool.js';

export interface AgentToolOptions {
  rootDir: string;
  memory: MemoryStore;
  secrets: SecretStore;
  broker: InteractionBroker;
  /** 工具需要知道同事叫什么（弹卡片时显示） */
  agentName: (agentId: string) => Promise<string>;
  /** 是否启用联网工具（默认启用） */
  web?: boolean;
}

/**
 * 内置工具清单。
 *
 * 分组对应《工具与能力.md》第 13 节：
 *   工作台那组在 runtime 里额外挂载（需要 registry / rooms）
 *   这里挂的是：文件、记忆、联网、投递、人机交互
 */
export function createAgentTools(options: AgentToolOptions): Tool<any>[] {
  const tools: Tool<any>[] = [
    calculator,
    createReadFileTool(options.rootDir),
    createWriteFileTool(options.rootDir),
    createListFilesTool(options.rootDir),
    createDeliverTool(options.rootDir),
    ...createMemoryTools(options.memory),
    ...createInteractionTools({
      broker: options.broker,
      secrets: options.secrets,
      agentName: options.agentName,
    }),
  ];

  if (options.web !== false) {
    tools.push(...createWebTools(options.secrets));
  }

  return tools;
}
