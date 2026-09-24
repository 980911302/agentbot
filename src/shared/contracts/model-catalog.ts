/**
 * 主流 AI 模型的思考能力与思考等级（Reasoning Effort / Thinking Level）知识库与配置契约
 */

export type ThinkingLevel = 'low' | 'medium' | 'high';

export interface ThinkingLevelOption {
  id: ThinkingLevel;
  label: string;
  nameZh: string;
  description: string;
  tokenBudgetHint?: string;
}

export interface ModelThinkingInfo {
  id: string;
  name: string;
  provider: string;
  supportsThinking: boolean;
  defaultThinking: boolean;
  defaultLevel: ThinkingLevel;
  levels: ThinkingLevelOption[];
  parameterFormat: 'reasoning_effort' | 'thinking_budget' | 'native_cot' | 'hybrid';
  budgetMap?: Record<ThinkingLevel, number>;
  notes: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  baseURL: string;
  defaultModel: string;
  recommendedModels: string[];
  docsUrl?: string;
}

/** 通用三档思考等级定义（基于 OpenAI 标准与业界实践） */
export const STANDARD_THINKING_LEVELS: ThinkingLevelOption[] = [
  {
    id: 'low',
    label: 'Low',
    nameZh: '轻度思考',
    description: '快速生成，思维链简短，消耗更少思考 Token，适合简单问答与日常操作。',
    tokenBudgetHint: '~1,024 - 2,048 tokens',
  },
  {
    id: 'medium',
    label: 'Medium',
    nameZh: '平衡思考（推荐）',
    description: '标准推理深度，兼顾思考质量与响应时间，适合大多数日常编程与逻辑分析。',
    tokenBudgetHint: '~4,096 - 8,192 tokens',
  },
  {
    id: 'high',
    label: 'High',
    nameZh: '深度推理',
    description: '最大限度展开思维推演，多步反思验证，适合复杂算法、架构设计与高难数学题。',
    tokenBudgetHint: '~16,384 - 32,768+ tokens',
  },
];

/** 主流模型思考等级支持清单 */
export const MODEL_CATALOG: ModelThinkingInfo[] = [
  {
    id: 'o3-mini',
    name: 'OpenAI o3-mini',
    provider: 'OpenAI',
    supportsThinking: true,
    defaultThinking: true,
    defaultLevel: 'medium',
    levels: STANDARD_THINKING_LEVELS,
    parameterFormat: 'reasoning_effort',
    notes: 'OpenAI 官方最新轻量级推理模型，原生支持 low / medium / high 三档 reasoning_effort。',
  },
  {
    id: 'o1',
    name: 'OpenAI o1',
    provider: 'OpenAI',
    supportsThinking: true,
    defaultThinking: true,
    defaultLevel: 'medium',
    levels: STANDARD_THINKING_LEVELS,
    parameterFormat: 'reasoning_effort',
    notes: 'OpenAI 旗舰推理模型，支持 low / medium / high 三档深度推演。',
  },
  {
    id: 'o3',
    name: 'OpenAI o3',
    provider: 'OpenAI',
    supportsThinking: true,
    defaultThinking: true,
    defaultLevel: 'medium',
    levels: STANDARD_THINKING_LEVELS,
    parameterFormat: 'reasoning_effort',
    notes: 'OpenAI 顶级推理模型，全能力推理。',
  },
  {
    id: 'claude-3-7-sonnet',
    name: 'Claude 3.7 Sonnet',
    provider: 'Anthropic',
    supportsThinking: true,
    defaultThinking: true,
    defaultLevel: 'medium',
    levels: [
      {
        id: 'low',
        label: 'Low',
        nameZh: '轻度思考 (2K)',
        description: '分配约 2,048 tokens 思考预算，快速给出经过初步思考的清晰解答。',
        tokenBudgetHint: '2,048 tokens',
      },
      {
        id: 'medium',
        label: 'Medium',
        nameZh: '深度思考 (8K)',
        description: '分配约 8,192 tokens 思考预算，充分推敲逻辑、校验边缘用例与编码细节。',
        tokenBudgetHint: '8,192 tokens',
      },
      {
        id: 'high',
        label: 'High',
        nameZh: '极限推理 (24K)',
        description: '分配约 24,576 tokens 思考预算，进行极其详尽的技术方案论证与架构推导。',
        tokenBudgetHint: '24,576 tokens',
      },
    ],
    parameterFormat: 'hybrid',
    budgetMap: {
      low: 2048,
      medium: 8192,
      high: 24576,
    },
    notes: '首创混合推理架构，通过 thinking.budget_tokens 精确控制思考深度与 token 预算。',
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek-R1 (官方 reasoner)',
    provider: 'DeepSeek',
    supportsThinking: true,
    defaultThinking: true,
    defaultLevel: 'medium',
    levels: STANDARD_THINKING_LEVELS,
    parameterFormat: 'native_cot',
    notes: 'DeepSeek 官方推理模型，原生输出 reasoning_content / <think> 思维链；在网关层通过 reasoning_effort 或 max_thinking_tokens 调节。',
  },
  {
    id: 'deepseek-ai/DeepSeek-R1',
    name: 'DeepSeek-R1 (兼容托管版)',
    provider: 'SiliconFlow / OpenRouter',
    supportsThinking: true,
    defaultThinking: true,
    defaultLevel: 'medium',
    levels: STANDARD_THINKING_LEVELS,
    parameterFormat: 'native_cot',
    notes: 'SiliconFlow / OpenRouter 等托管的 DeepSeek-R1 满血版。',
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek-V3 (chat)',
    provider: 'DeepSeek',
    supportsThinking: false,
    defaultThinking: false,
    defaultLevel: 'medium',
    levels: [],
    parameterFormat: 'reasoning_effort',
    notes: '通用高性价比大模型，专注极速响应与通用任务，无内置思维链推理。',
  },
  {
    id: 'gemini-2.0-flash-thinking-exp',
    name: 'Gemini 2.0 Flash Thinking',
    provider: 'Google',
    supportsThinking: true,
    defaultThinking: true,
    defaultLevel: 'medium',
    levels: [
      {
        id: 'low',
        label: 'Low',
        nameZh: '轻度 (1K)',
        description: '思考预算 1,024 tokens。',
        tokenBudgetHint: '1,024 tokens',
      },
      {
        id: 'medium',
        label: 'Medium',
        nameZh: '中度 (8K)',
        description: '思考预算 8,192 tokens。',
        tokenBudgetHint: '8,192 tokens',
      },
      {
        id: 'high',
        label: 'High',
        nameZh: '深度 (24K)',
        description: '思考预算 24,576 tokens。',
        tokenBudgetHint: '24,576 tokens',
      },
    ],
    parameterFormat: 'thinking_budget',
    budgetMap: {
      low: 1024,
      medium: 8192,
      high: 24576,
    },
    notes: 'Google 闪电实验性思考模型，具备极快生成速度和多步逻辑推理。',
  },
  {
    id: 'qwq-32b',
    name: 'Qwen QwQ-32B',
    provider: 'Alibaba',
    supportsThinking: true,
    defaultThinking: true,
    defaultLevel: 'medium',
    levels: STANDARD_THINKING_LEVELS,
    parameterFormat: 'reasoning_effort',
    notes: '通义千问开源最强推理模型，在数学、代码与长逻辑上表现优异。',
  },
  {
    id: 'gpt-4o',
    name: 'OpenAI GPT-4o',
    provider: 'OpenAI',
    supportsThinking: false,
    defaultThinking: false,
    defaultLevel: 'medium',
    levels: [],
    parameterFormat: 'reasoning_effort',
    notes: 'OpenAI 通用多模态主力模型，不带长思考思维链。',
  },
  {
    id: 'gpt-4o-mini',
    name: 'OpenAI GPT-4o-mini',
    provider: 'OpenAI',
    supportsThinking: false,
    defaultThinking: false,
    defaultLevel: 'medium',
    levels: [],
    parameterFormat: 'reasoning_effort',
    notes: 'OpenAI 超轻量快速通用模型。',
  },
];

/** 服务商快捷预设列表 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek (官方)',
    baseURL: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-reasoner',
    recommendedModels: ['deepseek-reasoner', 'deepseek-chat'],
    docsUrl: 'https://platform.deepseek.com',
  },
  {
    id: 'openai',
    name: 'OpenAI (官方)',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'o3-mini',
    recommendedModels: ['o3-mini', 'o1', 'o3', 'gpt-4o', 'gpt-4o-mini'],
    docsUrl: 'https://platform.openai.com',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (聚合网关)',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/o3-mini',
    recommendedModels: [
      'openai/o3-mini',
      'deepseek/deepseek-r1',
      'anthropic/claude-3.7-sonnet:thinking',
      'google/gemini-2.0-flash-thinking-exp:free',
      'qwen/qwq-32b',
    ],
    docsUrl: 'https://openrouter.ai',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow (硅基流动)',
    baseURL: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-R1',
    recommendedModels: [
      'deepseek-ai/DeepSeek-R1',
      'deepseek-ai/DeepSeek-V3',
      'Qwen/QwQ-32B-Preview',
    ],
    docsUrl: 'https://siliconflow.cn',
  },
  {
    id: 'dashscope',
    name: '阿里百炼 (DashScope)',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwq-32b',
    recommendedModels: ['qwq-32b', 'deepseek-r1', 'qwen-max', 'qwen-plus'],
    docsUrl: 'https://bailian.console.aliyun.com',
  },
  {
    id: 'custom',
    name: '自定义 OpenAI 兼容接口',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'o3-mini',
    recommendedModels: ['o3-mini', 'o1', 'deepseek-reasoner', 'claude-3-7-sonnet', 'qwq-32b'],
  },
];

/** 根据模型 ID 或名称模糊查找模型思考配置 */
export function lookupModelThinkingInfo(modelId: string): ModelThinkingInfo {
  const normalized = modelId.trim().toLowerCase();
  
  // 精确匹配
  const exact = MODEL_CATALOG.find((m) => m.id.toLowerCase() === normalized);
  if (exact) return exact;

  // 模糊匹配常见关键词
  if (normalized.includes('o3-mini')) return MODEL_CATALOG.find((m) => m.id === 'o3-mini')!;
  if (normalized.includes('o1')) return MODEL_CATALOG.find((m) => m.id === 'o1')!;
  if (normalized.includes('o3')) return MODEL_CATALOG.find((m) => m.id === 'o3')!;
  if (normalized.includes('claude-3-7') || normalized.includes('claude-3.7')) {
    return MODEL_CATALOG.find((m) => m.id === 'claude-3-7-sonnet')!;
  }
  if (normalized.includes('reasoner') || normalized.includes('r1')) {
    return MODEL_CATALOG.find((m) => m.id === 'deepseek-reasoner')!;
  }
  if (normalized.includes('thinking') || normalized.includes('gemini')) {
    return MODEL_CATALOG.find((m) => m.id === 'gemini-2.0-flash-thinking-exp')!;
  }
  if (normalized.includes('qwq')) {
    return MODEL_CATALOG.find((m) => m.id === 'qwq-32b')!;
  }

  // 兜底：作为通用 OpenAI 兼容模型，默认开放思考能力
  return {
    id: modelId,
    name: modelId,
    provider: 'OpenAI-Compatible',
    supportsThinking: true,
    defaultThinking: true,
    defaultLevel: 'medium',
    levels: STANDARD_THINKING_LEVELS,
    parameterFormat: 'reasoning_effort',
    notes: '通用 OpenAI 兼容模型：系统默认开启思考模式，将传递标准 reasoning_effort 参数。',
  };
}

export interface ModelThinkingLevels {
  modelId: string;
  supportsThinking: boolean;
  levels: ThinkingLevelOption[];
  defaultLevel: ThinkingLevel;
}

/** 输入条思考档：完全跟随当前模型，而不是 Chat / Reasoner 产品分类 */
export function thinkingLevelsForModel(modelId: string): ModelThinkingLevels {
  const info = lookupModelThinkingInfo(modelId);
  return {
    modelId: info.id,
    supportsThinking: info.supportsThinking,
    levels: info.supportsThinking ? info.levels : [],
    defaultLevel: info.defaultLevel,
  };
}

export interface PickerProviderInput {
  id: string;
  name: string;
  enabled?: boolean;
  models: Array<{
    id: string;
    model: string;
    name?: string;
    thinkingEnabled?: boolean;
    thinkingLevel?: ThinkingLevel;
  }>;
}

export interface PickerModelOption {
  id: string;
  label: string;
  hint: string;
  providerId: string;
  modelConfigId: string;
  thinkingEnabled: boolean;
  thinkingLevel: ThinkingLevel;
}

/** 已启用供应商下的模型 → 输入条 / health 的选择列表，不注入 Chat/Reasoner 目录 */
export function pickerOptionsFromProviders(providers: PickerProviderInput[]): PickerModelOption[] {
  const options: PickerModelOption[] = [];
  for (const provider of providers) {
    if (provider.enabled === false) continue;
    for (const model of provider.models ?? []) {
      const id = (model.model || model.name || '').trim();
      if (!id) continue;
      options.push({
        id,
        label: (model.name || model.model || id).trim(),
        hint: provider.name,
        providerId: provider.id,
        modelConfigId: model.id,
        thinkingEnabled: model.thinkingEnabled !== false,
        thinkingLevel: model.thinkingLevel || 'medium',
      });
    }
  }
  return options;
}

/* ── 模型配置契约（E1.4 从 storage/model-config-store.ts 迁入）──────────
   类型与纯函数放契约层：routes 与前端都只用这里的类型/脱敏函数，
   存储模块反向依赖本文件（契约不依赖任何运行模块，check-imports 强制）。 */

export interface ProviderModelConfig {
  id: string;
  model: string;
  name?: string;
  contextWindow?: string;
  thinkingEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
  temperature?: number;
}

export interface ProviderItemConfig {
  id: string;
  name: string;
  group: string;
  enabled: boolean;
  baseURL: string;
  apiFormat: 'openai' | 'responses';
  apiKey: string;
  models: ProviderModelConfig[];
  createdAt?: number;
  updatedAt?: number;
}

export interface ConfiguredModelItem {
  id: string;
  name: string;
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
  thinkingEnabled: boolean;
  thinkingLevel: ThinkingLevel;
  temperature?: number;
  createdAt: number;
  updatedAt: number;
}

export interface StoredModelConfig {
  activeProviderId: string;
  activeModelId: string;
  providers: ProviderItemConfig[];
  models: ConfiguredModelItem[];
  // 顶层保持与 activeModelId 对应的模型与供应商同步，保持现有代码与测试向下兼容
  baseURL: string;
  apiKey: string;
  model: string;
  thinkingEnabled: boolean;
  thinkingLevel: ThinkingLevel;
  temperature?: number;
  updatedAt: number;
}

export function maskApiKey(key: string): string {
  if (!key) return '';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

export function detectProvider(baseURL: string): string {
  const url = baseURL.toLowerCase();
  if (url.includes('deepseek.com')) return 'deepseek';
  if (url.includes('openai.com')) return 'openai';
  if (url.includes('openrouter.ai')) return 'openrouter';
  if (url.includes('siliconflow')) return 'siliconflow';
  if (url.includes('dashscope.aliyuncs.com') || url.includes('bailian')) return 'dashscope';
  if (url.includes('bigmodel.cn')) return 'zhipu';
  if (url.includes('modelscope.cn')) return 'modelscope';
  return 'custom';
}

export function maskModelItem(item: ConfiguredModelItem, activeId?: string) {
  return {
    ...item,
    apiKey: maskApiKey(item.apiKey),
    hasKey: Boolean(item.apiKey),
    isDefault: item.id === activeId,
  };
}

export function maskProviderItem(provider: ProviderItemConfig, activeModelId?: string) {
  return {
    ...provider,
    apiKey: maskApiKey(provider.apiKey),
    hasKey: Boolean(provider.apiKey),
    models: provider.models.map((m) => ({
      ...m,
      isActive: m.id === activeModelId || m.model === activeModelId,
    })),
  };
}
