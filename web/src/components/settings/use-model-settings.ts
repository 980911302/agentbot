import { useEffect, useState } from 'react';
import {
  fetchModelSettings,
  saveProviderConfig,
  deleteProviderConfig,
  saveModelToProvider,
  deleteModelFromProvider,
  setActiveProviderModel,
  testModelSettings,
  type ModelSettingsData,
  type ProviderItemConfig,
  type ProviderModelConfig,
} from '../../api';
import { toast } from '../ui/Toast.js';
import {
  messageOf,
  newModelRecord,
  thinkingPatch,
  type ProviderDraft,
  type TestState,
  type ThinkingChoice,
} from './model-settings-shared.js';

type SavedSettings = Pick<ModelSettingsData, 'config' | 'providers'> & { ok?: boolean };

/**
 * 模型设置页的数据与动作：所有服务商在一页里编辑，改动即时保存。
 * 每个写操作都拿服务端返回的整份配置刷新，界面不自己拼状态。
 */
export function useModelSettings(input: { open: boolean; onModel: (model: string) => void }) {
  const [providers, setProviders] = useState<ProviderItemConfig[]>([]);
  const [activeProviderId, setActiveProviderId] = useState('');
  const [activeModelId, setActiveModelId] = useState('');
  /** 设置页没存 Key 时，后端会用环境变量 AGENT_API_KEY 兜底 */
  const [envHasKey, setEnvHasKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testResults, setTestResults] = useState<Record<string, TestState>>({});

  const apply = (data: SavedSettings) => {
    setProviders(data.providers ?? []);
    setActiveProviderId(data.config?.activeProviderId ?? '');
    setActiveModelId(data.config?.activeModelId ?? '');
  };

  useEffect(() => {
    if (!input.open) return;
    let cancelled = false;
    setLoading(true);
    void fetchModelSettings()
      .then((data) => {
        if (cancelled) return;
        apply(data);
        setEnvHasKey(Boolean(data.config?.hasKey));
      })
      .catch((err) => toast(messageOf(err, '读取模型设置失败'), 'error'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [input.open]);

  /** 写操作的统一外壳：成功刷新整份配置，失败给出原因；返回是否成功 */
  const run = async (work: () => Promise<SavedSettings>, failure: string, success?: string) => {
    try {
      const saved = await work();
      if (saved.ok === false) throw new Error('服务端没有保存');
      apply(saved);
      if (success) toast(success, 'ok');
      return true;
    } catch (err) {
      toast(`${failure}：${messageOf(err, '未知错误')}`, 'error');
      return false;
    }
  };

  const saveProvider = (
    id: string,
    patch: Partial<Pick<ProviderItemConfig, 'name' | 'baseURL' | 'apiKey' | 'enabled'>>,
  ) => run(() => saveProviderConfig({ id, ...patch }), '保存失败', '已保存');

  const addProvider = (draft: ProviderDraft) =>
    run(
      () =>
        saveProviderConfig({
          id: 'p_' + Date.now().toString(36),
          name: draft.name.trim(),
          baseURL: draft.baseURL.trim(),
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
          enabled: true,
          models: [newModelRecord(draft.model)],
        }),
      '添加失败',
      `已添加「${draft.name.trim()}」`,
    );

  const deleteProvider = (provider: ProviderItemConfig) => {
    if (!window.confirm(`删除服务商「${provider.name}」和它的全部模型？`)) return Promise.resolve(false);
    return run(() => deleteProviderConfig(provider.id), '删除失败', `已删除「${provider.name}」`);
  };

  const addModel = (provider: ProviderItemConfig, model: string) => {
    const name = model.trim();
    if (provider.models.some((item) => item.model === name)) {
      toast(`${name} 已经在列表里了`, 'error');
      return Promise.resolve(false);
    }
    return run(() => saveModelToProvider(provider.id, newModelRecord(name)), '添加模型失败');
  };

  const deleteModel = (provider: ProviderItemConfig, model: ProviderModelConfig) => {
    if (!window.confirm(`删除模型 ${model.model}？`)) return Promise.resolve(false);
    return run(() => deleteModelFromProvider(provider.id, model.id), '删除模型失败');
  };

  const setThinking = (provider: ProviderItemConfig, model: ProviderModelConfig, choice: ThinkingChoice) =>
    run(() => saveModelToProvider(provider.id, { id: model.id, ...thinkingPatch(choice) }), '保存失败');

  const activateModel = async (provider: ProviderItemConfig, model: ProviderModelConfig) => {
    const ok = await run(() => setActiveProviderModel(provider.id, model.id), '切换失败');
    if (ok) input.onModel(model.model);
    return ok;
  };

  const testModel = async (provider: ProviderItemConfig, model: ProviderModelConfig) => {
    setTestResults((prev) => ({ ...prev, [model.id]: { testing: true } }));
    try {
      const res = await testModelSettings({
        providerId: provider.id,
        modelId: model.id,
        model: model.model,
        thinkingEnabled: model.thinkingEnabled,
        thinkingLevel: model.thinkingLevel,
      });
      setTestResults((prev) => ({
        ...prev,
        [model.id]: { testing: false, ok: res.ok, latencyMs: res.latencyMs, error: res.error },
      }));
      if (!res.ok) toast(`${model.model} 连不上：${res.error || '未知错误'}`, 'error');
    } catch (err) {
      const message = messageOf(err, '请求失败');
      setTestResults((prev) => ({ ...prev, [model.id]: { testing: false, ok: false, error: message } }));
      toast(`${model.model} 连不上：${message}`, 'error');
    }
  };

  return {
    providers,
    activeProviderId,
    activeModelId,
    envHasKey,
    loading,
    testResults,
    saveProvider,
    addProvider,
    deleteProvider,
    addModel,
    deleteModel,
    setThinking,
    activateModel,
    testModel,
  };
}

export type ModelSettingsController = ReturnType<typeof useModelSettings>;
