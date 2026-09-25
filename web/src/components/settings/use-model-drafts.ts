import { useState, type FormEvent } from 'react';
import {
  saveProviderConfig,
  saveModelToProvider,
  type ProviderItemConfig,
  type ProviderModelConfig,
} from '../../api';
import { lookupModelThinkingInfo, type ThinkingLevel } from '../../../../src/shared/contracts/model-catalog';
import { toast } from '../ui/Toast.js';
import {
  EMPTY_MODEL_DRAFT,
  EMPTY_PROVIDER_DRAFT,
  messageOf,
  providerDraftErrors,
  type ModelDraft,
  type ModelFormErrors,
  type ProviderDraft,
  type ProviderFormErrors,
} from './model-settings-shared.js';

/**
 * 两个子弹窗的草稿与提交（UI-08）：「添加服务商」与「添加/编辑模型」。
 * 与主 hook 分开只是为了让每个文件都在 300 行以内，状态仍由设置页统一持有。
 */
export function useModelDrafts(input: {
  selectedProvider: ProviderItemConfig | null;
  activeModelId: string;
  setProviders: (providers: ProviderItemConfig[]) => void;
  selectProvider: (id: string) => void;
  onModel: (model: string) => void;
}) {
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [newProvider, setNewProvider] = useState<ProviderDraft>(EMPTY_PROVIDER_DRAFT);
  const [newProviderErrors, setNewProviderErrors] = useState<ProviderFormErrors>({});

  const [modelFormOpen, setModelFormOpen] = useState(false);
  const [modelFormMode, setModelFormMode] = useState<'add' | 'edit'>('add');
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState<ModelDraft>(EMPTY_MODEL_DRAFT);
  const [modelFormErrors, setModelFormErrors] = useState<ModelFormErrors>({});

  const submitNewProvider = async (event: FormEvent) => {
    event.preventDefault();
    const errors = providerDraftErrors(newProvider);
    setNewProviderErrors(errors);
    if (Object.keys(errors).length > 0) return;
    try {
      const newId = 'p_' + Date.now().toString(36);
      const res = await saveProviderConfig({
        id: newId,
        name: newProvider.name.trim(),
        group: newProvider.group.trim() || '自定义供应商',
        baseURL: newProvider.baseURL.trim(),
        apiFormat: newProvider.apiFormat,
        apiKey: newProvider.apiKey.trim() || undefined,
        enabled: true,
        models: [],
      });
      if (res.ok) {
        input.setProviders(res.providers || []);
        input.selectProvider(newId);
        setAddProviderOpen(false);
        toast(`已添加服务商「${newProvider.name.trim()}」`, 'ok');
      }
    } catch (err) {
      const message = messageOf(err, '未知错误');
      setNewProviderErrors({ name: message });
      toast('添加服务商失败：' + message, 'error');
    }
  };

  const openAddModel = () => {
    setModelFormMode('add');
    setEditingModelId(null);
    setModelDraft(EMPTY_MODEL_DRAFT);
    setModelFormErrors({});
    setModelFormOpen(true);
  };

  const openEditModel = (mod: ProviderModelConfig) => {
    setModelFormMode('edit');
    setEditingModelId(mod.id);
    setModelDraft({
      model: mod.model,
      name: mod.name || '',
      contextWindow: mod.contextWindow || '128K',
      thinkingEnabled: mod.thinkingEnabled !== false,
      thinkingLevel: mod.thinkingLevel || 'medium',
      setActive: input.activeModelId === mod.id,
    });
    setModelFormErrors({});
    setModelFormOpen(true);
  };

  const submitModelForm = async (event: FormEvent) => {
    event.preventDefault();
    const provider = input.selectedProvider;
    if (!provider) return;
    if (!modelDraft.model.trim()) {
      setModelFormErrors({ model: '请填模型标识' });
      return;
    }
    setModelFormErrors({});
    const modelId = editingModelId || 'm_' + Date.now().toString(36);
    const trimmedModel = modelDraft.model.trim();
    // 显示名留空、或只是上次自动跟随的旧模型标识时，视为未定制，重新跟随后续模型标识
    const priorModel = editingModelId ? provider.models?.find((m) => m.id === editingModelId) : undefined;
    const nameNeverCustomized =
      !modelDraft.name.trim() || (priorModel ? modelDraft.name.trim() === (priorModel.model ?? '') : false);
    const displayName =
      modelDraft.name.trim() || (nameNeverCustomized ? trimmedModel : priorModel?.name) || undefined;
    try {
      const res = await saveModelToProvider(
        provider.id,
        {
          id: modelId,
          model: trimmedModel,
          name: displayName,
          contextWindow: modelDraft.contextWindow.trim() || undefined,
          thinkingEnabled: modelDraft.thinkingEnabled,
          thinkingLevel: modelDraft.thinkingLevel,
        },
        modelDraft.setActive,
      );
      if (res.ok) {
        input.setProviders(res.providers || []);
        if (modelDraft.setActive) input.onModel(trimmedModel);
        setModelFormOpen(false);
        toast(
          modelFormMode === 'edit' ? `已保存模型「${trimmedModel}」` : `已添加模型「${trimmedModel}」`,
          'ok',
        );
      }
    } catch (err) {
      const message = messageOf(err, '未知错误');
      setModelFormErrors({ model: message });
      toast('保存模型失败：' + message, 'error');
    }
  };

  /** 模型标识变化时按内置目录建议思考模式与等级 */
  const changeModelId = (value: string) => {
    setModelDraft((prev) => {
      const info = lookupModelThinkingInfo(value);
      return {
        ...prev,
        model: value,
        ...(info
          ? {
              thinkingEnabled: info.supportsThinking,
              ...(info.defaultLevel ? { thinkingLevel: info.defaultLevel as ThinkingLevel } : {}),
            }
          : {}),
      };
    });
  };

  return {
    addProviderOpen,
    setAddProviderOpen,
    newProvider,
    setNewProvider,
    newProviderErrors,
    submitNewProvider,
    modelFormOpen,
    setModelFormOpen,
    modelFormMode,
    modelDraft,
    setModelDraft,
    modelFormErrors,
    openAddModel,
    openEditModel,
    submitModelForm,
    changeModelId,
  };
}

export type ModelDraftsController = ReturnType<typeof useModelDrafts>;
