import { createReadTool } from '../tools/examples/files.js';
import { createSendToUserTool } from '../tools/examples/send-to-user.js';
import { createShellTools } from '../tools/examples/shell.js';
import { createUpdateStateTools } from '../tools/examples/update-state.js';
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
  /** 更新自己的资料 / 设置 / 头像 / 项目（update_state 用） */
  updateAgent: (
    agentId: string,
    patch: {
      name?: string;
      title?: string;
      instructions?: string;
      color?: string;
      avatar?: string;
      hidden?: boolean;
      projectIds?: string[];
    },
  ) => Promise<unknown>;
  /** 是否启用联网工具（默认启用） */
  web?: boolean;
}

/**
 * 常驻工具 —— 参见 docs/工具参考.md。
 *
 *   SendToUser / Read / Shell + AwaitShell / RecallMemory / update_state
 *   （Screenshot / GetDynamicTools / CallDynamicTool / ReactToMessage 不做，理由见对齐设计文档）
 *
 * 平台层（CreateAgent / SendToAgent / Task 族等）在 runtime 里挂载，
 * 因为它们需要 registry / rooms / provider 这些运行时依赖。
 */
export function createAgentTools(options: AgentToolOptions): Tool<any>[] {
  const tools: Tool<any>[] = [
    ...createShellTools(),
    createReadTool(),
    createSendToUserTool({
      rootDir: options.rootDir,
      broker: options.broker,
      secrets: options.secrets,
      agentName: options.agentName,
    }),
    ...createUpdateStateTools({
      memory: options.memory,
      updateAgent: options.updateAgent,
    }),
    ...createMemoryTools(options.memory),
  ];

  if (options.web !== false) {
    tools.push(...createWebTools(options.secrets));
  }

  return tools;
}
