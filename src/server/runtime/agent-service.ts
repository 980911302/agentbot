import { assembleAgent } from '../../agent/assemble.js';
import type { Agent, AgentRecord } from '../../agent/types.js';
import { budgetForWindow, type ContextBudget } from '../../context/budget.js';
import type { LLMProvider } from '../../llm/provider.js';
import type { CompactionStore } from '../../memory/compact.js';
import type { MemoryStore } from '../../memory/store.js';
import { AgentRegistry } from '../../agent/registry.js';
import type { Tool } from '../../tools/tool.js';

/**
 * AgentService（E2.2 第一步）：身份装配与模型解析。
 *
 * 从 AgentRuntime 拆出的第一块职责：
 *   - buildAgent：把注册表记录装配成带记忆与工具的 Agent
 *   - providerFor / resolveModel：模型实例缓存与别名解析
 *
 * 不做调度、不做停止、不做收件箱——那些在后续批次拆出。
 */
export class AgentService {
  private readonly providers = new Map<string, LLMProvider>();
  private defaultModel: string;
  private knownModels: string[];
  /** 模型报超长时读出的实际上限（tokens）：只收小不收大，换模型配置后清空重新探测 */
  private readonly learnedLimits = new Map<string, number>();
  private readonly tools: () => Tool<any>[];

  constructor(
    private readonly deps: {
      registry: AgentRegistry;
      memory: MemoryStore;
      compaction: CompactionStore;
      createProvider: (model: string) => LLMProvider;
      defaultModel: string;
      knownModels: string[];
      budget: ContextBudget;
      /** 运行时装配完工具后注入；装配是惰性的，所以给取值函数 */
      tools: () => Tool<any>[];
      /** 上下文预算上限（tokens）；不传用 DEFAULT_CONTEXT_CEILING（1M） */
      contextCeiling?: number;
    },
  ) {
    this.defaultModel = deps.defaultModel;
    this.knownModels = deps.knownModels;
    this.tools = deps.tools;
  }

  /** 这个模型一回合能用的上下文预算：默认按上限（1M），模型报过更小的上限就按它 */
  contextBudgetFor(model: string): ContextBudget {
    return budgetForWindow(this.deps.budget, this.learnedLimits.get(model), this.deps.contextCeiling);
  }

  /** 记下模型报出的实际上限（AgentLoop 收到超长报错并压缩重试时回报） */
  learnContextLimit(model: string, tokens: number): void {
    const known = this.learnedLimits.get(model);
    if (known === undefined || tokens < known) this.learnedLimits.set(model, tokens);
  }

  /** 把注册表记录装配成带记忆与工具的 Agent */
  async buildAgent(record: AgentRecord): Promise<Agent> {
    const refs = await this.deps.memory.visibleTo(record.id, { projectIds: record.projectIds });
    const compaction = await this.deps.compaction.get(record.id);
    return assembleAgent({
      record,
      memory: { refs, compaction, projectIds: record.projectIds },
      tools: this.tools(),
    });
  }

  /** 模型实例缓存：同一模型复用同一 Provider */
  providerFor(model: string): LLMProvider {
    let provider = this.providers.get(model);
    if (!provider) {
      provider = this.deps.createProvider(model);
      this.providers.set(model, provider);
    }
    return provider;
  }

  /** 模型别名解析：不在已知列表里的一律回落默认模型 */
  resolveModel(model: string | undefined): string {
    if (model && this.knownModels.includes(model)) return model;
    return this.defaultModel;
  }

  /** 热更新模型提供者与配置（清空旧 provider 缓存） */
  updateModelConfig(options: {
    model: string;
    createProvider?: (model: string) => LLMProvider;
    knownModels?: string[];
  }): void {
    if (options.createProvider) {
      this.deps.createProvider = options.createProvider;
    }
    // 供应商或地址可能换了：同名模型背后未必是同一个窗口，重新探测
    this.learnedLimits.clear();
    this.defaultModel = options.model;
    if (options.knownModels) {
      this.knownModels = options.knownModels;
    } else if (!this.knownModels.includes(options.model)) {
      this.knownModels.push(options.model);
    }
    this.providers.clear();
  }
}

// AgentRegistry 仅作为 deps 的类型引用
export type { AgentRegistry };
