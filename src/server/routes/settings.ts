import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../transport/json.js';
import { readString, type RouteContext } from './context.js';
import {
  MODEL_CATALOG,
  PROVIDER_PRESETS,
  STANDARD_THINKING_LEVELS,
  pickerOptionsFromProviders,
  type ThinkingLevel,
} from '../../shared/contracts/model-catalog.js';
import {
  ModelConfigStore,
  maskApiKey,
  maskModelItem,
  maskProviderItem,
  type ProviderModelConfig,
} from '../../storage/model-config-store.js';
import { OpenAIProvider } from '../../llm/openai-provider.js';

export async function handleModelSettingsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://localhost');
  const store = new ModelConfigStore(context.runtime.dataDir);

  if (method === 'GET' && url.pathname === '/api/settings/model') {
    const stored = await store.load({
      baseURL: (context.runtime as any).deps?.baseURL,
      apiKey: (context.runtime as any).deps?.apiKey,
      model: context.model,
      thinkingEnabled: true,
      thinkingLevel: 'medium',
    });

    json(response, 200, {
      config: {
        activeProviderId: stored.activeProviderId,
        activeModelId: stored.activeModelId,
        baseURL: stored.baseURL,
        apiKey: maskApiKey(stored.apiKey),
        hasKey: Boolean(stored.apiKey),
        model: stored.model,
        thinkingEnabled: stored.thinkingEnabled,
        thinkingLevel: stored.thinkingLevel,
        temperature: stored.temperature,
      },
      providers: stored.providers.map((p) => maskProviderItem(p, stored.activeModelId)),
      models: stored.models.map((m) => maskModelItem(m, stored.activeModelId)),
      catalog: MODEL_CATALOG,
      presets: PROVIDER_PRESETS,
      standardLevels: STANDARD_THINKING_LEVELS,
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/settings/model') {
    const body = (await readJson(request)) as Record<string, any>;
    const action = readString(body.action) || 'save';

    let saved;
    try {
      if (action === 'save_provider') {
        const p = body.provider as Record<string, any> | undefined;
        if (!p || !p.id) {
          json(response, 400, { ok: false, error: '缺少供应商信息' });
          return;
        }
        saved = await store.saveProvider({
          id: readString(p.id)!,
          name: readString(p.name),
          group: readString(p.group),
          enabled: typeof p.enabled === 'boolean' ? p.enabled : true,
          baseURL: readString(p.baseURL),
          apiFormat: p.apiFormat,
          apiKey: readString(p.apiKey),
          models: Array.isArray(p.models) ? p.models : undefined,
        });
      } else if (action === 'delete_provider') {
        const id = readString(body.id) || readString(body.providerId);
        if (!id) {
          json(response, 400, { ok: false, error: '缺少供应商 ID' });
          return;
        }
        saved = await store.deleteProvider(id);
      } else if (action === 'save_model') {
        const providerId = readString(body.providerId);
        const model = body.model as (Partial<ProviderModelConfig> & { id: string }) | undefined;
        if (!providerId || !model || !model.id) {
          json(response, 400, { ok: false, error: '缺少供应商 ID 或模型信息' });
          return;
        }
        saved = await store.saveModelToProvider(providerId, model, Boolean(body.setAsActive));
      } else if (action === 'delete_model') {
        const providerId = readString(body.providerId);
        const modelId = readString(body.modelId) || readString(body.id);
        if (!providerId || !modelId) {
          json(response, 400, { ok: false, error: '缺少供应商 ID 或模型 ID' });
          return;
        }
        saved = await store.deleteModelFromProvider(providerId, modelId);
      } else if (action === 'set_active') {
        const providerId = readString(body.providerId);
        const modelId = readString(body.modelId) || readString(body.id);
        if (providerId && modelId) {
          saved = await store.setActiveProviderAndModel(providerId, modelId);
        } else if (modelId) {
          saved = await store.setActiveModel(modelId);
        } else {
          json(response, 400, { ok: false, error: '缺少模型 ID' });
          return;
        }
      } else if (action === 'add') {
        saved = await store.addModel(
          {
            name: readString(body.name) || readString(body.model) || '',
            provider: readString(body.provider) || 'custom',
            baseURL: readString(body.baseURL) || 'https://api.openai.com/v1',
            apiKey: readString(body.apiKey) || '',
            model: readString(body.model) || 'o3-mini',
            thinkingEnabled: typeof body.thinkingEnabled === 'boolean' ? body.thinkingEnabled : true,
            thinkingLevel: (body.thinkingLevel as ThinkingLevel) || 'medium',
            temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
          },
          body.setAsDefault !== false,
        );
      } else if (action === 'update') {
        const id = readString(body.id);
        if (!id) {
          json(response, 400, { ok: false, error: '缺少模型 ID' });
          return;
        }
        saved = await store.updateModel(
          id,
          {
            ...(readString(body.name) !== undefined ? { name: readString(body.name) } : {}),
            ...(readString(body.provider) !== undefined ? { provider: readString(body.provider) } : {}),
            ...(readString(body.baseURL) !== undefined ? { baseURL: readString(body.baseURL) } : {}),
            ...(readString(body.apiKey) !== undefined ? { apiKey: readString(body.apiKey) } : {}),
            ...(readString(body.model) !== undefined ? { model: readString(body.model) } : {}),
            ...(typeof body.thinkingEnabled === 'boolean' ? { thinkingEnabled: body.thinkingEnabled } : {}),
            ...(body.thinkingLevel ? { thinkingLevel: body.thinkingLevel as ThinkingLevel } : {}),
            ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
          },
          typeof body.setAsDefault === 'boolean' ? body.setAsDefault : undefined,
        );
      } else if (action === 'delete') {
        const id = readString(body.id);
        if (!id) {
          json(response, 400, { ok: false, error: '缺少模型 ID' });
          return;
        }
        saved = await store.deleteModel(id);
      } else {
        const baseURL = readString(body.baseURL)?.trim();
        const apiKey = readString(body.apiKey)?.trim();
        const model = readString(body.model)?.trim();
        const thinkingEnabled = typeof body.thinkingEnabled === 'boolean' ? body.thinkingEnabled : true;
        const thinkingLevel = (body.thinkingLevel as ThinkingLevel) || 'medium';
        const temperature = typeof body.temperature === 'number' ? body.temperature : undefined;

        saved = await store.save(
          {
            ...(baseURL ? { baseURL } : {}),
            ...(apiKey ? { apiKey } : {}),
            ...(model ? { model } : {}),
            thinkingEnabled,
            thinkingLevel,
            temperature,
          },
          {
            baseURL: (context.runtime as any).deps?.baseURL,
            apiKey: (context.runtime as any).deps?.apiKey,
            model: context.model,
            thinkingEnabled: true,
            thinkingLevel: 'medium',
          },
        );
      }
    } catch (err) {
      json(response, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    // 运行时热更新：切换默认模型与提供者构造器
    const picker = pickerOptionsFromProviders(saved.providers);
    context.model = saved.model;
    context.models = picker;
    context.runtime.updateModelConfig?.({
      model: saved.model,
      baseURL: saved.baseURL,
      apiKey: saved.apiKey,
      thinkingEnabled: saved.thinkingEnabled,
      thinkingLevel: saved.thinkingLevel,
      temperature: saved.temperature,
      knownModels: picker.map((item) => item.id),
    });

    json(response, 200, {
      ok: true,
      config: {
        activeProviderId: saved.activeProviderId,
        activeModelId: saved.activeModelId,
        baseURL: saved.baseURL,
        apiKey: maskApiKey(saved.apiKey),
        hasKey: Boolean(saved.apiKey),
        model: saved.model,
        thinkingEnabled: saved.thinkingEnabled,
        thinkingLevel: saved.thinkingLevel,
        temperature: saved.temperature,
      },
      providers: saved.providers.map((p) => maskProviderItem(p, saved.activeModelId)),
      models: saved.models.map((m) => maskModelItem(m, saved.activeModelId)),
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/settings/model/test') {
    const body = (await readJson(request)) as Record<string, any>;
    const stored = await store.load();

    const providerId = readString(body.providerId);
    const modelId = readString(body.modelId) || readString(body.id);

    const targetProvider = providerId
      ? stored.providers.find((p) => p.id === providerId)
      : stored.providers.find((p) => p.models.some((m) => m.id === modelId));

    const targetModel = (modelId
      ? targetProvider?.models.find((m) => m.id === modelId) || stored.models.find((m) => m.id === modelId)
      : targetProvider?.models[0]) as any;

    const rawKey = readString(body.apiKey)?.trim();
    // 界面回填的是打码值，不代表用户提供了新 Key
    const hasNewKey = rawKey !== undefined && rawKey.length > 0 && !rawKey.includes('••••');
    const storedKey = targetProvider?.apiKey || targetModel?.apiKey || stored.apiKey;
    const storedBaseURL = (
      targetProvider?.baseURL ||
      targetModel?.baseURL ||
      stored.baseURL ||
      'https://api.openai.com/v1'
    ).replace(/\/+$/, '');
    const requestedBaseURL = readString(body.baseURL)?.trim().replace(/\/+$/, '');

    // 已保存的 Key 只属于它自己的地址：请求体换了地址，就必须同时给新 Key，
    // 否则 { providerId, baseURL: 任意地址 } 就能把 Key 骗到对端去
    if (requestedBaseURL && requestedBaseURL !== storedBaseURL && !hasNewKey) {
      json(response, 400, {
        ok: false,
        error: '修改接口地址时必须同时提供新的 API Key：已保存的 Key 只会发往它所属的地址',
      });
      return;
    }

    const apiKey = hasNewKey ? rawKey : storedKey;
    const baseURL = requestedBaseURL || storedBaseURL;

    const model = readString(body.model)?.trim() || targetModel?.model || stored.model || 'o3-mini';
    const thinkingEnabled =
      typeof body.thinkingEnabled === 'boolean'
        ? body.thinkingEnabled
        : targetModel?.thinkingEnabled !== undefined
        ? targetModel.thinkingEnabled
        : true;
    const thinkingLevel =
      (body.thinkingLevel as ThinkingLevel) || targetModel?.thinkingLevel || stored.thinkingLevel || 'medium';

    // 本地地址无需强制要求 API Key
    const finalApiKey = apiKey || (baseURL.includes('127.0.0.1') || baseURL.includes('localhost') || baseURL.includes('192.168.') ? 'sk-local' : '');
    if (!finalApiKey) {
      json(response, 400, { ok: false, error: '未提供 API Key' });
      return;
    }

    const startTime = Date.now();
    try {
      const provider = new OpenAIProvider({
        apiKey: finalApiKey,
        baseURL,
        model,
        thinkingEnabled,
        thinkingLevel,
        timeoutMs: 15_000,
      });

      const res = await provider.chat([{ role: 'user', content: 'Ping' }]);
      const latencyMs = Date.now() - startTime;
      json(response, 200, {
        ok: true,
        message: `连接成功！耗时 ${latencyMs}ms，模型已就绪`,
        latencyMs,
        preview: res.content?.slice(0, 100) ?? '',
      });
    } catch (error) {
      json(response, 200, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  json(response, 404, { error: 'Not found' });
}
