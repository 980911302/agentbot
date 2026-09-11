import { calculator } from '../tools/examples/calculator.js';
import { createListFilesTool, createReadFileTool, createWriteFileTool } from '../tools/examples/files.js';
import { createMemoryTools } from '../tools/examples/memory.js';
import type { MemoryStore } from '../memory/store.js';
import type { Tool } from '../tools/tool.js';

export interface AgentToolOptions {
  rootDir: string;
  memory: MemoryStore;
}

export function createAgentTools(options: AgentToolOptions): Tool<any>[] {
  return [
    calculator,
    createReadFileTool(options.rootDir),
    createWriteFileTool(options.rootDir),
    createListFilesTool(options.rootDir),
    ...createMemoryTools(options.memory),
  ];
}
