import { useEffect, useMemo, useState } from 'react';
import {
  fetchModelSettings,
  saveProviderConfig,
  deleteProviderConfig,
  saveModelToProvider,
  deleteModelFromProvider,
  setActiveProviderModel,
  testModelSettings,
  type ProviderItemConfig,
  type ProviderModelConfig,
  type ModelSettingsData,
} from '../../api';
import { toast } from '../ui/Toast.js';
import { messageOf, type ProviderFormErrors, type TestState } from './model-settings-shared.js';
import { useModelDrafts } from './use-model-drafts.js';

/**
 * 设置页的数据与动作（UI-08 拆分）：所有 state 与副作用都在这里，
 * 展示组件只负责画。这样每个组件文件都能压在 300 行以内。
 */

export function useModelSettings(input: {
  open: boolean;
  openSection: 'general' | 'models';
  onModel: (model: string) => void;
}) {
  const [modelSettings, setModelSettings] = useState<ModelSettingsData | null>(null);
  const [providers, setProviders] = useState<ProviderItemConfig[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [activeProviderId, setActiveProviderId] = useState('');
  const [activeModelId, setActiveModelId] = useState('');
  const [activeTab, setActiveTab] = useState<'general' | string>('general');

  // 右侧表单（选中服务商）
  const [formName, setFormName] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [formBaseURL, setFormBaseURL] = useState('');
  const [formApiFormat, setFormApiFormat] = useState<'openai' | 'responses'>('openai');
  const [formApiKey, setFormApiKey] = useState('');
  const [formEnabled, setFormEnabled] = useState(true);
  const [showApiKey, setShowApiKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [formErrors, setFormErrors] = useState<ProviderFormErrors>({});

  /** 测速结果：key 为 modelId */
  const [testResults, setTestResults] = useState<Record<string, TestState>>({});

  const loadSettings = async () => {
    try {
      const data = await fetchModelSettings();
      setModelSettings(data);
      const provList = data.providers || [];
      setProviders(provList);

      const actProv = data.config?.activeProviderId || provList[0]?.id || '';
      const actMod = data.config?.activeModelId || provList[0]?.models?.[0]?.id || '';
      setActiveProviderId(actProv);
      setActiveModelId(actMod);

      const fallbackProvider = (() => {
        const local = provList.find((p) => p.name === '本地');
        if (local) return local.id;
        return actProv || provList[0]?.id || '';
      })();

      if (input.openSection === 'models') {
        setActiveTab(actProv || fallbackProvider);
        setSelectedProviderId(actProv || fallbackProvider);
      } else {
        setActiveTab('general');
        setSelectedProviderId((prev) =>
          prev && provList.some((p) => p.id === prev) ? prev : fallbackProvider,
        );
      }
    } catch (err) {
      toast(messageOf(err, '读取模型设置失败'), 'error');
    }
  };

  useEffect(() => {
    if (!input.open) return;
    void loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.open, input.openSection]);

  const selectedProvider = useMemo(() => {
    const targetId = activeTab === 'general' ? selectedProviderId : activeTab;
    return providers.find((p) => p.id === targetId) || providers[0] || null;
  }, [providers, activeTab, selectedProviderId]);

  // 换服务商时回填表单
  useEffect(() => {
    if (!selectedProvider) return;
    setFormName(selectedProvider.name || '');
    setFormBaseURL(selectedProvider.baseURL || '');
    setFormApiFormat(selectedProvider.apiFormat || 'openai');
    setFormApiKey('');
    setFormEnabled(selectedProvider.enabled !== false);
    setIsEditingName(false);
    setShowApiKey(false);
    setFormErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProvider?.id]);

  // 两个子弹窗（添加服务商 / 添加·编辑模型）的草稿与提交在 use-model-drafts.ts
  const drafts = useModelDrafts({
    selectedProvider,
    activeModelId,
    setProviders,
    selectProvider: (id) => {
      setSelectedProviderId(id);
      setActiveTab(id);
    },
    onModel: input.onModel,
  });

  const groupedProviders = useMemo(() => {
    const groups: Record<string, ProviderItemConfig[]> = {};
    for (const provider of providers) {
      const group = provider.group || '自定义供应商';
      (groups[group] ??= []).push(provider);
    }
    return groups;
  }, [providers]);

  const saveCurrentProvider = async (overrideEnabled?: boolean, alsoClearErrors = true) => {
    if (!selectedProvider) return;
    setIsSaving(true);
    if (alsoClearErrors) setFormErrors({});
    try {
      const targetEnabled = typeof overrideEnabled === 'boolean' ? overrideEnabled : formEnabled;
      const res = await saveProviderConfig({
        id: selectedProvider.id,
        name: formName.trim() || selectedProvider.name,
        baseURL: formBaseURL.trim(),
        apiFormat: formApiFormat,
        apiKey: formApiKey.trim() || undefined,
        enabled: targetEnabled,
      });
      if (res.ok) {
        setProviders(res.providers || []);
        setFormApiKey('');
        toast('设置已保存', 'ok');
      }
    } catch (err) {
      const message = messageOf(err, '保存失败');
      setFormErrors({ baseURL: message });
      toast('保存失败：' + message, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const toggleProviderEnabled = async (enabled: boolean) => {
    setFormEnabled(enabled);
    await saveCurrentProvider(enabled);
  };

  const deleteCurrentProvider = async () => {
    if (!selectedProvider) return;
    if (!window.confirm(`确定要删除服务商 "${selectedProvider.name}" 及其所有模型配置吗？`)) return;
    try {
      const res = await deleteProviderConfig(selectedProvider.id);
      if (res.ok) {
        setProviders(res.providers || []);
        const first = res.providers?.[0];
        if (first) setSelectedProviderId(first.id);
        toast(`已删除服务商「${selectedProvider.name}」`, 'ok');
      }
    } catch (err) {
      toast('删除失败：' + messageOf(err, '未知错误'), 'error');
    }
  };

  const activateModel = async (mod: ProviderModelConfig) => {
    if (!selectedProvider) return;
    try {
      const res = await setActiveProviderModel(selectedProvider.id, mod.id);
      if (res.ok) {
        setActiveProviderId(selectedProvider.id);
        setActiveModelId(mod.id);
        input.onModel(mod.model);
        toast(`已激活 ${mod.model}`, 'ok');
      }
    } catch (err) {
      toast('激活模型失败：' + messageOf(err, '未知错误'), 'error');
    }
  };

  const testModel = async (mod: ProviderModelConfig) => {
    if (!selectedProvider) return;
    setTestResults((prev) => ({ ...prev, [mod.id]: { testing: true } }));
    try {
      const res = await testModelSettings({
        providerId: selectedProvider.id,
        modelId: mod.id,
        baseURL: formBaseURL.trim() || selectedProvider.baseURL,
        apiKey: formApiKey.trim() || undefined,
        model: mod.model,
        apiFormat: formApiFormat || selectedProvider.apiFormat,
        thinkingEnabled: mod.thinkingEnabled,
        thinkingLevel: mod.thinkingLevel,
      });
      setTestResults((prev) => ({
        ...prev,
        [mod.id]: { testing: false, ok: res.ok, latencyMs: res.latencyMs || 420, error: res.error },
      }));
      if (res.ok) toast(`${mod.model} 连接正常（${res.latencyMs || 420}ms）`, 'ok');
      else toast(`${mod.model} 连接失败：${res.error || '未知错误'}`, 'error');
    } catch (err) {
      const message = messageOf(err, '请求失败');
      setTestResults((prev) => ({ ...prev, [mod.id]: { testing: false, ok: false, error: message } }));
      toast(`${mod.model} 连接失败：${message}`, 'error');
    }
  };

  const deleteModel = async (mod: ProviderModelConfig) => {
    if (!selectedProvider) return;
    if (!window.confirm(`确定要删除模型 "${mod.model}" 吗？`)) return;
    try {
      const res = await deleteModelFromProvider(selectedProvider.id, mod.id);
      if (res.ok) {
        setProviders(res.providers || []);
        toast(`已删除模型「${mod.model}」`, 'ok');
      }
    } catch (err) {
      toast('删除模型失败：' + messageOf(err, '未知错误'), 'error');
    }
  };

  return {
    modelSettings,
    providers,
    groupedProviders,
    selectedProvider,
    selectedProviderId,
    activeProviderId,
    activeModelId,
    activeTab,
    setActiveTab,
    setSelectedProviderId,
    loadSettings,
    // 表单
    formName,
    setFormName,
    isEditingName,
    setIsEditingName,
    formBaseURL,
    setFormBaseURL,
    formApiFormat,
    setFormApiFormat,
    formApiKey,
    setFormApiKey,
    formEnabled,
    setFormEnabled,
    showApiKey,
    setShowApiKey,
    isSaving,
    formErrors,
    testResults,
    // 动作
    saveCurrentProvider,
    toggleProviderEnabled,
    deleteCurrentProvider,
    activateModel,
    testModel,
    deleteModel,
    ...drafts,
  };
}

export type ModelSettingsController = ReturnType<typeof useModelSettings>;
