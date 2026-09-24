import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { isMissingFile, writeJsonAtomic } from './atomic-json.js';
import {
  detectProvider,
  maskApiKey,
  maskModelItem,
  maskProviderItem,
  type ConfiguredModelItem,
  type ProviderItemConfig,
  type ProviderModelConfig,
  type StoredModelConfig,
} from '../shared/contracts/model-catalog.js';

/** 删除激活供应商后挑选回退目标：优先启用、有模型、有密钥的那个 */
function pickFallbackProvider(providers: ProviderItemConfig[]): ProviderItemConfig {
  const usable = providers.filter((p) => (p.models?.length ?? 0) > 0);
  return (
    usable.find((p) => p.enabled !== false && Boolean(p.apiKey)) ??
    usable.find((p) => p.enabled !== false) ??
    usable[0] ??
    providers[0]!
  );
}

function createDefaultProviders(
  fallbackKey?: string,
  fallbackBaseURL?: string,
  fallbackModel?: string,
): ProviderItemConfig[] {
  const realKey = fallbackKey || '';
  const now = Date.now();
  return [
    {
      id: 'provider-bigmodel',
      name: 'BigModel',
      group: '智谱',
      enabled: false,
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      apiFormat: 'openai',
      apiKey: '',
      models: [
        {
          id: 'model-glm-4-plus',
          model: 'glm-4-plus',
          name: 'glm-4-plus',
          contextWindow: '128K',
          thinkingEnabled: false,
          thinkingLevel: 'medium',
        },
        {
          id: 'model-glm-4-flash',
          model: 'glm-4-flash',
          name: 'glm-4-flash',
          contextWindow: '128K',
          thinkingEnabled: false,
          thinkingLevel: 'medium',
        },
      ],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'provider-local',
      name: '本地',
      group: '自定义供应商',
      enabled: true,
      baseURL: 'http://192.168.0.102:8317/v1',
      apiFormat: 'responses',
      apiKey: '',
      models: [
        {
          id: 'model-glm-5-2',
          model: 'glm-5.2',
          name: 'glm-5.2',
          contextWindow: '200K',
          thinkingEnabled: true,
          thinkingLevel: 'medium',
        },
        {
          id: 'model-deepseek-v4-flash',
          model: 'deepseek-v4-flash',
          name: 'deepseek-v4-flash',
          contextWindow: '400K',
          thinkingEnabled: true,
          thinkingLevel: 'medium',
        },
      ],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'provider-modelscope',
      name: '魔搭',
      group: '自定义供应商',
      enabled: true,
      baseURL: 'https://api-inference.modelscope.cn/v1',
      apiFormat: 'openai',
      apiKey: '',
      models: [
        {
          id: 'model-qwen-2-5-72b',
          model: 'Qwen/Qwen2.5-72B-Instruct',
          name: 'Qwen/Qwen2.5-72B-Instruct',
          contextWindow: '128K',
          thinkingEnabled: false,
          thinkingLevel: 'medium',
        },
      ],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'provider-gopackage',
      name: 'go套餐',
      group: '自定义供应商',
      enabled: true,
      baseURL: fallbackBaseURL || 'https://api.deepseek.com/v1',
      apiFormat: 'openai',
      apiKey: realKey,
      models: [
        {
          id: 'model-deepseek-reasoner',
          model: fallbackModel || 'deepseek-reasoner',
          name: 'deepseek-reasoner',
          contextWindow: '64K',
          thinkingEnabled: true,
          thinkingLevel: 'medium',
        },
        {
          id: 'model-deepseek-chat',
          model: 'deepseek-chat',
          name: 'deepseek-chat',
          contextWindow: '64K',
          thinkingEnabled: false,
          thinkingLevel: 'medium',
        },
      ],
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export class ModelConfigStore {
  private readonly filePath: string;
  private cached: StoredModelConfig | null = null;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'model-config.json');
  }

  async load(fallback?: Partial<StoredModelConfig>): Promise<StoredModelConfig> {
    if (this.cached) return JSON.parse(JSON.stringify(this.cached));

    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredModelConfig>;
      this.cached = this.normalizeLoaded(parsed, fallback);
      return JSON.parse(JSON.stringify(this.cached));
    } catch (error) {
      if (isMissingFile(error)) {
        this.cached = this.normalizeLoaded({}, fallback);
        return JSON.parse(JSON.stringify(this.cached));
      }
      throw error;
    }
  }

  private normalizeLoaded(parsed: Partial<StoredModelConfig>, fallback?: Partial<StoredModelConfig>): StoredModelConfig {
    const rawProviders = Array.isArray(parsed.providers) ? parsed.providers : [];
    let providers: ProviderItemConfig[];

    if (rawProviders.length > 0) {
      providers = rawProviders.map((p, idx) => ({
        id: p.id || `provider-${idx + 1}`,
        name: p.name || '未命名供应商',
        group: p.group || '自定义供应商',
        enabled: p.enabled !== false,
        baseURL: p.baseURL || 'https://api.openai.com/v1',
        apiFormat: (p.apiFormat as any) === 'responses' ? 'responses' : 'openai',
        apiKey: p.apiKey || '',
        models: (Array.isArray(p.models) ? p.models : []).map((m, mIdx) => ({
          id: m.id || `model-${idx}-${mIdx}`,
          model: m.model || 'o3-mini',
          name: m.name || m.model || '未命名模型',
          contextWindow: m.contextWindow || '128K',
          thinkingEnabled: m.thinkingEnabled !== false,
          thinkingLevel: m.thinkingLevel || 'medium',
          temperature: m.temperature,
        })),
        createdAt: p.createdAt || Date.now(),
        updatedAt: p.updatedAt || Date.now(),
      }));
    } else if (Array.isArray(parsed.models) && parsed.models.length > 0) {
      const providerMap = new Map<string, ProviderItemConfig>();
      for (const m of parsed.models) {
        const pName = m.provider || detectProvider(m.baseURL);
        const pId = `provider-${pName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        if (!providerMap.has(pId)) {
          providerMap.set(pId, {
            id: pId,
            name: m.provider || pName,
            group: '自定义供应商',
            enabled: true,
            baseURL: m.baseURL || 'https://api.openai.com/v1',
            apiFormat: 'openai',
            apiKey: m.apiKey || '',
            models: [],
            createdAt: m.createdAt || Date.now(),
            updatedAt: m.updatedAt || Date.now(),
          });
        }
        const p = providerMap.get(pId)!;
        p.models.push({
          id: m.id,
          model: m.model,
          name: m.name || m.model,
          contextWindow: '128K',
          thinkingEnabled: m.thinkingEnabled !== false,
          thinkingLevel: m.thinkingLevel || 'medium',
          temperature: m.temperature,
        });
      }
      providers = Array.from(providerMap.values());
    } else {
      const defaultBaseURL = parsed.baseURL ?? fallback?.baseURL ?? 'https://api.deepseek.com/v1';
      const defaultModel = parsed.model ?? fallback?.model ?? 'deepseek-reasoner';
      const defaultApiKey = parsed.apiKey ?? fallback?.apiKey ?? '';
      const defaultThinking = parsed.thinkingEnabled !== undefined ? parsed.thinkingEnabled : true;
      const defaultLevel = parsed.thinkingLevel ?? fallback?.thinkingLevel ?? 'medium';

      providers = [
        {
          id: 'provider-default',
          name: detectProvider(defaultBaseURL),
          group: '自定义供应商',
          enabled: true,
          baseURL: defaultBaseURL,
          apiFormat: 'openai',
          apiKey: defaultApiKey,
          models: [
            {
              id: 'default-model',
              model: defaultModel,
              name: defaultModel,
              contextWindow: '64K',
              thinkingEnabled: defaultThinking,
              thinkingLevel: defaultLevel,
              temperature: parsed.temperature,
            },
          ],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];
    }

    // 确保每个 provider 至少有模型
    for (const provider of providers) {
      if (provider.models.length === 0) {
        provider.models.push({
          id: `model-${provider.id}-default`,
          model: 'deepseek-chat',
          name: 'deepseek-chat',
          contextWindow: '64K',
          thinkingEnabled: false,
          thinkingLevel: 'medium',
        });
      }
    }

    // 生成平铺的 models 视图，确保向前兼容
    const flatModels: ConfiguredModelItem[] = [];
    for (const provider of providers) {
      for (const m of provider.models) {
        flatModels.push({
          id: m.id,
          name: m.name || m.model,
          provider: provider.name,
          baseURL: provider.baseURL,
          apiKey: provider.apiKey,
          model: m.model,
          thinkingEnabled: m.thinkingEnabled !== false,
          thinkingLevel: m.thinkingLevel || 'medium',
          temperature: m.temperature,
          createdAt: provider.createdAt || Date.now(),
          updatedAt: provider.updatedAt || Date.now(),
        });
      }
    }

    // 决定 activeProviderId 和 activeModelId
    let activeModelId = parsed.activeModelId;
    let activeProviderId = parsed.activeProviderId;

    let activeModelConfig = flatModels.find((m) => m.id === activeModelId);
    if (!activeModelConfig && flatModels.length > 0) {
      // activeModelId 失效时按模型名找回：先在当前激活供应商的模型里找，再全局找，
      // 避免多个供应商暴露同名模型时挑到用户没选的那个
      const activeProvider = providers.find((p) => p.id === activeProviderId);
      const withinActive = activeProvider
        ? flatModels.filter((m) => activeProvider.models.some((pm) => pm.id === m.id))
        : [];
      activeModelConfig =
        withinActive.find((m) => m.model === parsed.model) ??
        withinActive[0] ??
        flatModels.find((m) => m.model === parsed.model) ??
        flatModels[0]!;
      activeModelId = activeModelConfig.id;
    }

    if (activeModelConfig) {
      const matchedProvider = providers.find((p) => p.models.some((m) => m.id === activeModelId));
      activeProviderId = matchedProvider?.id || providers[0]!.id;
    } else {
      activeProviderId = providers[0]!.id;
      activeModelId = providers[0]!.models[0]!.id;
    }

    const activeProvider = providers.find((p) => p.id === activeProviderId) || providers[0]!;
    const activeModel = activeProvider.models.find((m) => m.id === activeModelId) || activeProvider.models[0]!;

    return {
      activeProviderId: activeProvider.id,
      activeModelId: activeModel.id,
      providers,
      models: flatModels,
      baseURL: activeProvider.baseURL,
      apiKey: activeProvider.apiKey,
      model: activeModel.model,
      thinkingEnabled: activeModel.thinkingEnabled !== false,
      thinkingLevel: activeModel.thinkingLevel || 'medium',
      temperature: activeModel.temperature,
      updatedAt: parsed.updatedAt ?? Date.now(),
    };
  }

  /** 保存顶层配置（热同步到 activeProvider 与 activeModel） */
  async save(patch: Partial<StoredModelConfig>, fallback?: Partial<StoredModelConfig>): Promise<StoredModelConfig> {
    const current = await this.load(fallback);

    const provider = current.providers.find((p) => p.id === current.activeProviderId) || current.providers[0]!;
    const model = provider.models.find((m) => m.id === current.activeModelId) || provider.models[0]!;

    if (patch.baseURL !== undefined) provider.baseURL = patch.baseURL.replace(/\/+$/, '');
    if (patch.apiKey !== undefined && !patch.apiKey.includes('••••')) provider.apiKey = patch.apiKey;
    if (patch.model !== undefined) model.model = patch.model.trim();
    if (patch.thinkingEnabled !== undefined) model.thinkingEnabled = patch.thinkingEnabled;
    if (patch.thinkingLevel !== undefined) model.thinkingLevel = patch.thinkingLevel;
    if (patch.temperature !== undefined) model.temperature = patch.temperature;

    provider.updatedAt = Date.now();
    current.updatedAt = Date.now();

    const normalized = this.normalizeLoaded(current, fallback);
    await writeJsonAtomic(this.filePath, normalized);
    this.cached = normalized;
    return JSON.parse(JSON.stringify(normalized));
  }

  // ── 供应商管理操作 ──────────────────────────────────────

  async saveProvider(provider: Partial<ProviderItemConfig> & { id: string }): Promise<StoredModelConfig> {
    const current = await this.load();
    const existing = current.providers.find((p) => p.id === provider.id);

    if (existing) {
      if (provider.name !== undefined) existing.name = provider.name.trim();
      if (provider.group !== undefined) existing.group = provider.group.trim();
      if (provider.enabled !== undefined) existing.enabled = provider.enabled;
      if (provider.baseURL !== undefined) existing.baseURL = provider.baseURL.replace(/\/+$/, '');
      if (provider.apiFormat !== undefined) existing.apiFormat = provider.apiFormat;
      if (provider.apiKey !== undefined && !provider.apiKey.includes('••••')) existing.apiKey = provider.apiKey;
      existing.updatedAt = Date.now();
    } else {
      current.providers.push({
        id: provider.id,
        name: provider.name?.trim() || '自定义供应商',
        group: provider.group?.trim() || '自定义供应商',
        enabled: provider.enabled !== false,
        baseURL: (provider.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
        apiFormat: provider.apiFormat || 'openai',
        apiKey: provider.apiKey || '',
        models: provider.models || [
          {
            id: `model-${Date.now().toString(36)}`,
            model: 'gpt-4o',
            name: 'gpt-4o',
            contextWindow: '128K',
            thinkingEnabled: false,
            thinkingLevel: 'medium',
          },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    current.updatedAt = Date.now();
    const normalized = this.normalizeLoaded(current);
    await writeJsonAtomic(this.filePath, normalized);
    this.cached = normalized;
    return JSON.parse(JSON.stringify(normalized));
  }

  async addProvider(provider: Omit<ProviderItemConfig, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<StoredModelConfig> {
    const id = provider.id || `provider-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    return this.saveProvider({ ...provider, id });
  }

  async deleteProvider(providerId: string): Promise<StoredModelConfig> {
    const current = await this.load();
    if (current.providers.length <= 1) {
      throw new Error('至少需要保留一个供应商');
    }

    current.providers = current.providers.filter((p) => p.id !== providerId);

    if (current.activeProviderId === providerId) {
      // 回退要挑还能用的：启用、有模型、有密钥，而不是无条件落到 providers[0]
      // （那可能是禁用且无密钥的种子供应商，之后所有请求都会 401）
      const fallback = pickFallbackProvider(current.providers);
      current.activeProviderId = fallback.id;
      current.activeModelId = fallback.models[0]?.id || '';
    }

    current.updatedAt = Date.now();
    const normalized = this.normalizeLoaded(current);
    await writeJsonAtomic(this.filePath, normalized);
    this.cached = normalized;
    return JSON.parse(JSON.stringify(normalized));
  }

  // ── 模型管理操作 ────────────────────────────────────────

  async saveModelToProvider(
    providerId: string,
    model: Partial<ProviderModelConfig> & { id: string },
    setAsActive = false,
  ): Promise<StoredModelConfig> {
    const current = await this.load();
    const provider = current.providers.find((p) => p.id === providerId);
    if (!provider) {
      throw new Error(`找不到 ID 为 ${providerId} 的供应商`);
    }

    const existingModel = provider.models.find((m) => m.id === model.id);
    if (existingModel) {
      if (model.model !== undefined) existingModel.model = model.model.trim();
      if (model.name !== undefined) existingModel.name = model.name.trim();
      if (model.contextWindow !== undefined) existingModel.contextWindow = model.contextWindow;
      if (model.thinkingEnabled !== undefined) existingModel.thinkingEnabled = model.thinkingEnabled;
      if (model.thinkingLevel !== undefined) existingModel.thinkingLevel = model.thinkingLevel;
      if (model.temperature !== undefined) existingModel.temperature = model.temperature;
    } else {
      provider.models.push({
        id: model.id,
        model: (model.model || 'custom-model').trim(),
        name: (model.name || model.model || 'custom-model').trim(),
        contextWindow: model.contextWindow || '128K',
        thinkingEnabled: model.thinkingEnabled !== false,
        thinkingLevel: model.thinkingLevel || 'medium',
        temperature: model.temperature,
      });
    }

    if (setAsActive) {
      current.activeProviderId = provider.id;
      current.activeModelId = model.id;
    }

    provider.updatedAt = Date.now();
    current.updatedAt = Date.now();

    const normalized = this.normalizeLoaded(current);
    await writeJsonAtomic(this.filePath, normalized);
    this.cached = normalized;
    return JSON.parse(JSON.stringify(normalized));
  }

  async deleteModelFromProvider(providerId: string, modelId: string): Promise<StoredModelConfig> {
    const current = await this.load();
    const provider = current.providers.find((p) => p.id === providerId);
    if (!provider) {
      throw new Error(`找不到 ID 为 ${providerId} 的供应商`);
    }

    if (provider.models.length <= 1) {
      throw new Error('供应商下至少需要保留一个模型');
    }

    provider.models = provider.models.filter((m) => m.id !== modelId);

    if (current.activeModelId === modelId) {
      current.activeModelId = provider.models[0]!.id;
    }

    provider.updatedAt = Date.now();
    current.updatedAt = Date.now();

    const normalized = this.normalizeLoaded(current);
    await writeJsonAtomic(this.filePath, normalized);
    this.cached = normalized;
    return JSON.parse(JSON.stringify(normalized));
  }

  async setActiveProviderAndModel(providerId: string, modelId: string): Promise<StoredModelConfig> {
    const current = await this.load();
    const provider = current.providers.find((p) => p.id === providerId);
    if (!provider) {
      throw new Error(`找不到 ID 为 ${providerId} 的供应商`);
    }

    const model = provider.models.find((m) => m.id === modelId);
    if (!model) {
      throw new Error(`在供应商 ${provider.name} 下未找到模型 ID ${modelId}`);
    }

    current.activeProviderId = provider.id;
    current.activeModelId = model.id;
    current.updatedAt = Date.now();

    const normalized = this.normalizeLoaded(current);
    await writeJsonAtomic(this.filePath, normalized);
    this.cached = normalized;
    return JSON.parse(JSON.stringify(normalized));
  }

  // ── 兼容旧接口操作 ──────────────────────────────────────

  async addModel(
    item: Omit<ConfiguredModelItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
    setAsActive = true,
  ): Promise<StoredModelConfig> {
    const current = await this.load();
    const modelId = item.id || `model-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const providerName = item.provider || detectProvider(item.baseURL);

    let provider = current.providers.find((p) => p.name.toLowerCase() === providerName.toLowerCase() || p.baseURL === item.baseURL);
    if (!provider) {
      provider = {
        id: `provider-${Date.now().toString(36)}`,
        name: item.name ? item.name.split(/[\s(]/)[0]! : providerName,
        group: '自定义供应商',
        enabled: true,
        baseURL: item.baseURL.replace(/\/+$/, ''),
        apiFormat: 'openai',
        apiKey: item.apiKey || '',
        models: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      current.providers.push(provider);
    }

    provider.models.push({
      id: modelId,
      model: item.model.trim(),
      name: item.name || item.model,
      contextWindow: '128K',
      thinkingEnabled: item.thinkingEnabled !== false,
      thinkingLevel: item.thinkingLevel || 'medium',
      temperature: item.temperature,
    });

    if (setAsActive) {
      current.activeProviderId = provider.id;
      current.activeModelId = modelId;
    }

    const normalized = this.normalizeLoaded(current);
    await writeJsonAtomic(this.filePath, normalized);
    this.cached = normalized;
    return JSON.parse(JSON.stringify(normalized));
  }

  async updateModel(id: string, patch: Partial<ConfiguredModelItem>, setAsActive?: boolean): Promise<StoredModelConfig> {
    const current = await this.load();
    let found = false;

    for (const provider of current.providers) {
      const model = provider.models.find((m) => m.id === id);
      if (model) {
        found = true;
        if (patch.name !== undefined) model.name = patch.name.trim();
        if (patch.model !== undefined) model.model = patch.model.trim();
        if (patch.thinkingEnabled !== undefined) model.thinkingEnabled = patch.thinkingEnabled;
        if (patch.thinkingLevel !== undefined) model.thinkingLevel = patch.thinkingLevel;
        if (patch.temperature !== undefined) model.temperature = patch.temperature;
        if (patch.baseURL !== undefined) provider.baseURL = patch.baseURL.replace(/\/+$/, '');
        if (patch.apiKey !== undefined && !patch.apiKey.includes('••••')) provider.apiKey = patch.apiKey;

        if (setAsActive || (setAsActive === undefined && current.activeModelId === id)) {
          current.activeProviderId = provider.id;
          current.activeModelId = model.id;
        }
        break;
      }
    }

    if (!found) {
      throw new Error(`找不到 ID 为 ${id} 的模型配置`);
    }

    const normalized = this.normalizeLoaded(current);
    await writeJsonAtomic(this.filePath, normalized);
    this.cached = normalized;
    return JSON.parse(JSON.stringify(normalized));
  }

  async deleteModel(id: string): Promise<StoredModelConfig> {
    const current = await this.load();
    if (current.models.length <= 1) {
      throw new Error('至少需要保留一个模型配置');
    }

    for (const provider of current.providers) {
      const idx = provider.models.findIndex((m) => m.id === id);
      if (idx !== -1) {
        provider.models.splice(idx, 1);
        break;
      }
    }

    // 清理空 provider
    current.providers = current.providers.filter((p) => p.models.length > 0);

    const normalized = this.normalizeLoaded(current);
    await writeJsonAtomic(this.filePath, normalized);
    this.cached = normalized;
    return JSON.parse(JSON.stringify(normalized));
  }

  async setActiveModel(id: string): Promise<StoredModelConfig> {
    const current = await this.load();
    for (const provider of current.providers) {
      const model = provider.models.find((m) => m.id === id);
      if (model) {
        return this.setActiveProviderAndModel(provider.id, model.id);
      }
    }
    throw new Error(`找不到 ID 为 ${id} 的模型配置`);
  }
}
