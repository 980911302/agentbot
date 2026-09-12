import type { Agent, AgentMemory, AgentRecord } from './types.js';
import type { Tool } from '../tools/tool.js';

export interface AssembleOptions {
  record: AgentRecord;
  memory: AgentMemory;
  tools: Tool<any>[];
}

export function assembleAgent(options: AssembleOptions): Agent {
  const { record, memory, tools } = options;
  const allowed = new Set(record.toolNames);
  return {
    id: record.id,
    name: record.name,
    title: record.title,
    description: record.description,
    instructions: record.instructions,
    // 工具按作用域共享，记忆按智能体各存一份（文档第 6 节）
    tools: tools.filter((tool) => allowed.has(tool.name)),
    memory,
    toolNames: record.toolNames,
    color: record.color,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
