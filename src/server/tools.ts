import { createFileTools } from '../tools/builtin/files.js';
import { createSendToUserTool } from '../tools/builtin/send-to-user.js';
import { createShellTools } from '../tools/builtin/shell.js';
import { createReadToolOutputTool } from '../tools/builtin/tool-output.js';
import { createUpdateStateTools } from '../tools/builtin/update-state.js';
import { createMemoryTools } from '../tools/builtin/memory.js';
import { createWebTools } from '../tools/builtin/web.js';
import { ArtifactService } from '../tools/services/artifact-service.js';
import type { InteractionBroker } from '../interaction/broker.js';
import type { MemoryStore } from '../memory/store.js';
import type { SecretStore } from '../secret/store.js';
import type { Tool } from '../tools/tool.js';
import type { FinalizeResult } from './runtime/reply-finalizer.js';

export interface AgentToolAccess {
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
  finalizeReply?: (input: {
    actorId: string;
    content: string;
    deliveryRefs?: string[];
    source?: 'user' | 'inbox' | 'room';
  }) => Promise<FinalizeResult>;
}

export interface AgentToolOptions {
  rootDir: string;
  memory: MemoryStore;
  secrets: SecretStore;
  broker: InteractionBroker;
  /** 是否启用联网工具（默认启用） */
  web?: boolean;
}

/**
 * 常驻工具 —— 对齐《内置工具清单.md》常驻层。
 *
 *   SendToUser / Read / Shell + AwaitShell / RecallMemory / update_state
 *   （Screenshot / GetDynamicTools / CallDynamicTool / ReactToMessage 不做，理由见对齐设计文档）
 *
 * 平台层（CreateAgent / SendToAgent / Task 族等）在 runtime 里挂载，
 * 因为它们需要 registry / rooms / provider 这些运行时依赖。
 *
 * DI：需要运行时的两个回调（agentName / updateAgent）通过 bind 注入，
 * 不再有模块级 runtimeRef 全局可变状态。
 */
export function createAgentTools(options: AgentToolOptions): {
  tools: Tool<any>[];
  bind: (access: AgentToolAccess) => void;
} {
  const access: { current: AgentToolAccess | undefined } = { current: undefined };
  const requireAccess = (): AgentToolAccess => {
    if (!access.current) throw new Error('工具尚未绑定运行时（bind 未调用）');
    return access.current;
  };

  const tools: Tool<any>[] = [
    createReadToolOutputTool(),
    ...createShellTools(options.rootDir),
    ...createFileTools(options.rootDir),
    createSendToUserTool({
      rootDir: options.rootDir,
      broker: options.broker,
      secrets: options.secrets,
      agentName: (agentId) => requireAccess().agentName(agentId),
      artifacts: new ArtifactService(),
      finalizeReply: (input) => {
        const finalize = requireAccess().finalizeReply;
        if (!finalize) {
          return Promise.resolve({ kind: 'ok', verifiedWholeText: false, statusLines: [] });
        }
        return finalize(input);
      },
    }),
    ...createUpdateStateTools({
      memory: options.memory,
      updateAgent: (agentId, patch) => requireAccess().updateAgent(agentId, patch),
    }),
    ...createMemoryTools(options.memory),
  ];

  if (options.web !== false) {
    tools.push(...createWebTools(options.secrets));
  }

  return {
    tools,
    bind: (bound) => {
      access.current = bound;
    },
  };
}
