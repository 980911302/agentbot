import { useEffect, useState, useMemo } from 'react';
import {
  IconClose,
  IconPlus,
  IconTrash,
  IconPlug,
  IconEye,
  IconEyeOff,
  IconEdit,
  IconSparkles,
  IconCube,
} from '../icons';
import type { ModelOption } from '../types';
import type { ThemePreference } from '../theme';
import { usePresence } from '../motion';
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
} from '../api';
import {
  lookupModelThinkingInfo,
  STANDARD_THINKING_LEVELS,
  type ThinkingLevel,
} from '../../../src/shared/contracts/model-catalog';

interface SettingsDialogProps {
  theme: ThemePreference;
  model: string;
  models: ModelOption[];
  endpoint: string;
  toolCount: number;
  ownerName: string;
  open: boolean;
  openSection?: 'general' | 'models';
  onTheme: (next: ThemePreference) => void;
  onModel: (next: string) => void;
  onOwnerName: (next: string) => void;
  onClose: () => void;
}

const THEME_OPTIONS: Array<{ id: ThemePreference; label: string }> = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
];

export function SettingsDialog({
  theme,
  model,
  models,
  endpoint,
  toolCount,
  ownerName,
  open,
  openSection = 'general',
  onTheme,
  onModel,
  onOwnerName,
  onClose,
}: SettingsDialogProps) {
  const presence = usePresence(open);

  // 核心数据
  const [modelSettings, setModelSettings] = useState<ModelSettingsData | null>(null);
  const [providers, setProviders] = useState<ProviderItemConfig[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');
  const [activeProviderId, setActiveProviderId] = useState<string>('');
  const [activeModelId, setActiveModelId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'general' | string>('general');
  const [ownerNameInput, setOwnerNameInput] = useState(ownerName);

  useEffect(() => {
    setOwnerNameInput(ownerName);
  }, [ownerName]);

  // 选中的服务商编辑表单状态
  const [formName, setFormName] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [formBaseURL, setFormBaseURL] = useState('');
  const [formApiFormat, setFormApiFormat] = useState<'openai' | 'responses'>('openai');
  const [formApiKey, setFormApiKey] = useState('');
  const [formEnabled, setFormEnabled] = useState(true);
  const [showApiKey, setShowApiKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveTip, setSaveTip] = useState<string | null>(null);

  // 测速状态：key 为 modelId
  const [testResults, setTestResults] = useState<
    Record<string, { testing?: boolean; latencyMs?: number; error?: string; ok?: boolean }>
  >({});

  // 添加服务商子弹窗
  const [showAddProviderModal, setShowAddProviderModal] = useState(false);
  const [newProvName, setNewProvName] = useState('');
  const [newProvGroup, setNewProvGroup] = useState('自定义供应商');
  const [newProvBaseURL, setNewProvBaseURL] = useState('https://api.openai.com/v1');
  const [newProvApiFormat, setNewProvApiFormat] = useState<'openai' | 'responses'>('openai');
  const [newProvApiKey, setNewProvApiKey] = useState('');

  // 添加/编辑模型子弹窗
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [modelModalMode, setModelModalMode] = useState<'add' | 'edit'>('add');
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [modelInputModel, setModelInputModel] = useState('');
  const [modelInputName, setModelInputName] = useState('');
  const [modelInputContext, setModelInputContext] = useState('');
  const [modelInputThinking, setModelInputThinking] = useState(true);
  const [modelInputThinkingLevel, setModelInputThinkingLevel] = useState<ThinkingLevel>('medium');
  const [modelInputSetActive, setModelInputSetActive] = useState(false);

  // 加载服务端配置
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

      if (openSection === 'models') {
        setActiveTab(actProv || fallbackProvider);
        setSelectedProviderId(actProv || fallbackProvider);
      } else {
        setActiveTab('general');
        setSelectedProviderId((prev) => {
          if (prev && provList.some((p) => p.id === prev)) return prev;
          return fallbackProvider;
        });
      }
    } catch (err) {
      console.error('Failed to load model settings:', err);
    }
  };

  useEffect(() => {
    if (!open) return;
    void loadSettings();
  }, [open, openSection]);

  // 当前选中的服务商对象
  const selectedProvider = useMemo(() => {
    const targetId = activeTab === 'general' ? selectedProviderId : activeTab;
    return providers.find((p) => p.id === targetId) || providers[0] || null;
  }, [providers, activeTab, selectedProviderId]);

  // 当选中的服务商切换时，回填右侧表单
  useEffect(() => {
    if (!selectedProvider) return;
    setFormName(selectedProvider.name || '');
    setFormBaseURL(selectedProvider.baseURL || '');
    setFormApiFormat(selectedProvider.apiFormat || 'openai');
    setFormApiKey('');
    setFormEnabled(selectedProvider.enabled !== false);
    setIsEditingName(false);
    setShowApiKey(false);
    setSaveTip(null);
  }, [selectedProvider?.id]);

  // 按 group 分组服务商列表
  const groupedProviders = useMemo(() => {
    const groups: Record<string, ProviderItemConfig[]> = {};
    for (const p of providers) {
      const g = p.group || '自定义供应商';
      if (!groups[g]) groups[g] = [];
      groups[g].push(p);
    }
    return groups;
  }, [providers]);

  // 保存当前服务商基本设置
  const handleSaveCurrentProvider = async (overrideEnabled?: boolean) => {
    if (!selectedProvider) return;
    setIsSaving(true);
    setSaveTip(null);
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
        setSaveTip('设置已保存');
        setTimeout(() => setSaveTip(null), 2500);
      }
    } catch (err: any) {
      setSaveTip('保存失败: ' + (err.message || '网络错误'));
    } finally {
      setIsSaving(false);
    }
  };

  // 快速切换启用/禁用
  const handleToggleEnabled = async (enabled: boolean) => {
    setFormEnabled(enabled);
    await handleSaveCurrentProvider(enabled);
  };

  // 删除当前服务商
  const handleDeleteCurrentProvider = async () => {
    if (!selectedProvider) return;
    if (!window.confirm(`确定要删除服务商 "${selectedProvider.name}" 及其所有模型配置吗？`)) {
      return;
    }
    try {
      const res = await deleteProviderConfig(selectedProvider.id);
      if (res.ok) {
        setProviders(res.providers || []);
        if (res.providers && res.providers.length > 0 && res.providers[0]) {
          setSelectedProviderId(res.providers[0].id);
        }
      }
    } catch (err: any) {
      alert('删除失败: ' + (err.message || '未知错误'));
    }
  };

  // 添加服务商提交
  const handleAddProviderSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProvName.trim()) return;
    try {
      const newId = 'p_' + Date.now().toString(36);
      const res = await saveProviderConfig({
        id: newId,
        name: newProvName.trim(),
        group: newProvGroup.trim() || '自定义供应商',
        baseURL: newProvBaseURL.trim(),
        apiFormat: newProvApiFormat,
        apiKey: newProvApiKey.trim() || undefined,
        enabled: true,
        models: [],
      });
      if (res.ok) {
        setProviders(res.providers || []);
        setSelectedProviderId(newId);
        setShowAddProviderModal(false);
        setNewProvName('');
        setNewProvApiKey('');
      }
    } catch (err: any) {
      alert('添加服务商失败: ' + (err.message || '未知错误'));
    }
  };

  // 设为当前激活模型
  const handleSetActive = async (mod: ProviderModelConfig) => {
    if (!selectedProvider) return;
    try {
      const res = await setActiveProviderModel(selectedProvider.id, mod.id);
      if (res.ok) {
        setActiveProviderId(selectedProvider.id);
        setActiveModelId(mod.id);
        onModel(mod.model);
        setSaveTip(`已激活 ${mod.model}`);
        setTimeout(() => setSaveTip(null), 2500);
      }
    } catch (err: any) {
      alert('激活模型失败: ' + (err.message || '未知错误'));
    }
  };

  // 测试模型连通性与延迟
  const handleTestModel = async (mod: ProviderModelConfig) => {
    if (!selectedProvider) return;
    setTestResults((prev) => ({
      ...prev,
      [mod.id]: { testing: true },
    }));

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
        [mod.id]: {
          testing: false,
          ok: res.ok,
          latencyMs: res.latencyMs || 420,
          error: res.error,
        },
      }));
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [mod.id]: {
          testing: false,
          ok: false,
          error: err.message || '请求失败',
        },
      }));
    }
  };

  // 打开添加模型弹窗
  const handleOpenAddModel = () => {
    setModelModalMode('add');
    setEditingModelId(null);
    setModelInputModel('');
    setModelInputName('');
    setModelInputContext('200K');
    setModelInputThinking(true);
    setModelInputThinkingLevel('medium');
    setModelInputSetActive(false);
    setModelModalOpen(true);
  };

  // 打开编辑模型弹窗
  const handleOpenEditModel = (mod: ProviderModelConfig) => {
    setModelModalMode('edit');
    setEditingModelId(mod.id);
    setModelInputModel(mod.model);
    setModelInputName(mod.name || '');
    setModelInputContext(mod.contextWindow || '128K');
    setModelInputThinking(mod.thinkingEnabled !== false);
    setModelInputThinkingLevel(mod.thinkingLevel || 'medium');
    setModelInputSetActive(activeModelId === mod.id);
    setModelModalOpen(true);
  };

  // 删除模型
  const handleDeleteModel = async (mod: ProviderModelConfig) => {
    if (!selectedProvider) return;
    if (!window.confirm(`确定要删除模型 "${mod.model}" 吗？`)) return;
    try {
      const res = await deleteModelFromProvider(selectedProvider.id, mod.id);
      if (res.ok) {
        setProviders(res.providers || []);
      }
    } catch (err: any) {
      alert('删除模型失败: ' + (err.message || '未知错误'));
    }
  };

  // 提交模型添加/编辑
  const handleSaveModelSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProvider || !modelInputModel.trim()) return;
    const modelId = editingModelId || 'm_' + Date.now().toString(36);
    const trimmedModel = modelInputModel.trim();
    // 显示名留空、或只是上次自动跟随的旧模型标识时，视为未定制，重新跟随后续模型标识
    const priorModel = editingModelId
      ? selectedProvider.models?.find((m) => m.id === editingModelId)
      : undefined;
    const nameNeverCustomized =
      !modelInputName.trim() ||
      (priorModel ? modelInputName.trim() === (priorModel.model ?? '') : false);
    const displayName = modelInputName.trim() || (nameNeverCustomized ? trimmedModel : priorModel?.name) || undefined;
    try {
      const res = await saveModelToProvider(
        selectedProvider.id,
        {
          id: modelId,
          model: trimmedModel,
          name: displayName,
          contextWindow: modelInputContext.trim() || undefined,
          thinkingEnabled: modelInputThinking,
          thinkingLevel: modelInputThinkingLevel,
        },
        modelInputSetActive,
      );
      if (res.ok) {
        setProviders(res.providers || []);
        if (modelInputSetActive) {
          setActiveProviderId(selectedProvider.id);
          setActiveModelId(modelId);
          onModel(trimmedModel);
        }
        setModelModalOpen(false);
      }
    } catch (err: any) {
      alert('保存模型失败: ' + (err.message || '未知错误'));
    }
  };

  // 监听模型名称输入，智能自动建议思考模式与等级
  const handleModelInputChange = (val: string) => {
    setModelInputModel(val);
    const info = lookupModelThinkingInfo(val);
    if (info) {
      setModelInputThinking(info.supportsThinking);
      if (info.defaultLevel) {
        setModelInputThinkingLevel(info.defaultLevel);
      }
    }
  };

  if (!presence.mounted) return null;

  return (
    <div
      className={`provider-settings-scrim ${presence.state}`}
      role="dialog"
      aria-modal="true"
      aria-label="模型服务商管理"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="provider-settings-window">
        {/* 关闭按钮 */}
        <button
          type="button"
          className="provider-window-close"
          onClick={onClose}
          aria-label="关闭"
        >
          <IconClose />
        </button>

        {/* 左侧服务商侧边栏 */}
        <div className="provider-sidebar">
          <div className="provider-sidebar-header">
            <span className="provider-sidebar-title">偏好设置</span>
          </div>

          <div className="provider-sidebar-scroll">
            <div className="provider-group">
              <div className="provider-group-title">基础配置</div>
              <button
                type="button"
                className={`provider-item-row ${activeTab === 'general' ? 'selected' : ''}`}
                onClick={() => setActiveTab('general')}
              >
                <span className="provider-item-left">
                  <span className="provider-item-icon">
                    <IconCube style={{ width: 16, height: 16 }} />
                  </span>
                  <span className="provider-item-name">通用偏好</span>
                </span>
              </button>
            </div>

            <div className="provider-group-divider" />

            <div className="provider-group">
              <div className="provider-group-title">模型设置</div>
              {Object.entries(groupedProviders).map(([groupName, provs]) => (
                <div key={groupName} className="provider-subgroup">
                  <div className="provider-subgroup-title">{groupName}</div>
                  {provs.map((prov) => {
                    const isSelected = activeTab === prov.id;
                    const isEnabled = prov.enabled !== false;
                    const isZhipu = prov.group === '智谱' || prov.name.toLowerCase().includes('bigmodel');
                    return (
                      <button
                        key={prov.id}
                        type="button"
                        className={`provider-item-row ${isSelected ? 'selected' : ''}`}
                        onClick={() => {
                          setActiveTab(prov.id);
                          setSelectedProviderId(prov.id);
                        }}
                      >
                        <span className="provider-item-left">
                          <span className="provider-item-icon">
                            {isZhipu ? (
                              <IconSparkles style={{ width: 15, height: 15, color: 'var(--accent)' }} />
                            ) : (
                              <IconPlug style={{ width: 15, height: 15 }} />
                            )}
                          </span>
                          <span className="provider-item-name">{prov.name}</span>
                        </span>
                        <span
                          className={`provider-status-dot ${isEnabled ? 'enabled' : ''}`}
                          title={isEnabled ? '服务商已启用' : '服务商已禁用'}
                        />
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* 侧边栏底部：添加供应商 */}
          <div className="provider-sidebar-footer">
            <button
              type="button"
              className="provider-add-btn"
              onClick={() => {
                setNewProvName('');
                setNewProvGroup('自定义供应商');
                setNewProvBaseURL('https://api.openai.com/v1');
                setNewProvApiFormat('openai');
                setNewProvApiKey('');
                setShowAddProviderModal(true);
              }}
            >
              <IconPlus size={15} />
              <span>添加服务商</span>
            </button>
          </div>
        </div>

        {/* 右侧主配置面板 */}
        <div className="provider-content-area">
          {activeTab === 'general' ? (
            <div className="provider-detail-scroll">
              <div className="provider-header-row">
                <div className="provider-header-left">
                  <h2 className="provider-title-text">通用偏好</h2>
                </div>
              </div>

              {/* 界面外观 */}
              <div className="settings-section">
                <div className="settings-section-title">界面外观</div>
                <div className="settings-card">
                  <div className="settings-row">
                    <div className="settings-row-label">
                      <span className="settings-row-name">主题模式</span>
                      <span className="settings-row-desc">选择契合当前光照与视觉习惯的显示风格</span>
                    </div>
                    <div className="theme-segmented-grid">
                      {THEME_OPTIONS.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`theme-segmented-btn${theme === opt.id ? ' active' : ''}`}
                          onClick={() => onTheme(opt.id)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* 用户身份 */}
              <div className="settings-section">
                <div className="settings-section-title">用户身份</div>
                <div className="settings-card">
                  <div className="settings-row">
                    <div className="settings-row-label">
                      <span className="settings-row-name">主人显示名</span>
                      <span className="settings-row-desc">智能体在私聊与群聊对话中称呼你的名字</span>
                    </div>
                    <input
                      type="text"
                      className="provider-text-input"
                      style={{ width: '220px' }}
                      value={ownerNameInput}
                      placeholder="linlin zhang"
                      onChange={(e) => setOwnerNameInput(e.target.value)}
                      onBlur={() => {
                        if (ownerNameInput.trim()) onOwnerName(ownerNameInput.trim());
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && ownerNameInput.trim()) {
                          onOwnerName(ownerNameInput.trim());
                        }
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* 运行环境与安全性 */}
              <div className="settings-section">
                <div className="settings-section-title">运行环境</div>
                <div className="settings-card">
                  <div className="settings-row">
                    <div className="settings-row-label">
                      <span className="settings-row-name">本地服务地址</span>
                      <span className="settings-row-desc">智能体协同主进程在本机运行，对话数据不出域</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="live-dot pulse" />
                      <span style={{ fontFamily: 'var(--mono)', fontSize: '13px', color: 'var(--text)' }}>
                        {endpoint || 'http://127.0.0.1:8787'}
                      </span>
                    </div>
                  </div>
                  <div className="settings-row" style={{ borderTop: '1px solid var(--divider)', paddingTop: '12px' }}>
                    <div className="settings-row-label">
                      <span className="settings-row-name">已挂载原生工具</span>
                      <span className="settings-row-desc">Shell 命令行、工作区文件读写、多智能体协同路由</span>
                    </div>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--accent)' }}>
                      {toolCount} 项工具能力
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ) : selectedProvider ? (
            <div className="provider-detail-scroll">
              {/* 顶部标题栏：服务商名称、修改按钮、已启用/禁用分段控件、删除按钮 */}
              <div className="provider-header-row">
                <div className="provider-header-left">
                  <div className="provider-title-box">
                    {isEditingName ? (
                      <input
                        type="text"
                        className="provider-title-input"
                        value={formName}
                        autoFocus
                        onChange={(e) => setFormName(e.target.value)}
                        onBlur={() => {
                          setIsEditingName(false);
                          void handleSaveCurrentProvider();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            setIsEditingName(false);
                            void handleSaveCurrentProvider();
                          }
                        }}
                      />
                    ) : (
                      <>
                        <h2 className="provider-title-text">{formName || selectedProvider.name}</h2>
                        <button
                          type="button"
                          className="provider-edit-name-btn"
                          title="修改服务商名称"
                          onClick={() => setIsEditingName(true)}
                        >
                          <IconEdit />
                        </button>
                      </>
                    )}
                  </div>

                  {/* 分段按钮控件：[ 已启用 ] [ 禁用 ] */}
                  <div className="segmented-pill-control">
                    <button
                      type="button"
                      className={`segmented-pill-btn ${formEnabled ? 'active enabled' : ''}`}
                      onClick={() => handleToggleEnabled(true)}
                    >
                      已启用
                    </button>
                    <button
                      type="button"
                      className={`segmented-pill-btn ${!formEnabled ? 'active disabled' : ''}`}
                      onClick={() => handleToggleEnabled(false)}
                    >
                      禁用
                    </button>
                  </div>
                </div>

                {/* 删除供应商按钮 */}
                <button
                  type="button"
                  className="provider-delete-btn"
                  title="删除此供应商"
                  onClick={handleDeleteCurrentProvider}
                >
                  <IconTrash />
                </button>
              </div>

              {/* 表单字段 1：Base URL */}
              <div className="provider-field-group">
                <label className="provider-field-label">Base URL</label>
                <input
                  type="text"
                  className="provider-text-input"
                  placeholder="https://api.openai.com/v1"
                  value={formBaseURL}
                  onChange={(e) => setFormBaseURL(e.target.value)}
                  onBlur={() => void handleSaveCurrentProvider()}
                />
              </div>

              {/* 表单字段 2：API 格式 */}
              <div className="provider-field-group">
                <label className="provider-field-label">API 格式</label>
                <select
                  className="provider-select"
                  value={formApiFormat}
                  onChange={(e) => {
                    const fmt = e.target.value as 'openai' | 'responses';
                    setFormApiFormat(fmt);
                    setTimeout(() => void handleSaveCurrentProvider(), 50);
                  }}
                >
                  <option value="responses">Responses (/responses)</option>
                  <option value="openai">OpenAI 兼容 (/chat/completions)</option>
                </select>
              </div>

              {/* 表单字段 3：API Key */}
              <div className="provider-field-group">
                <label className="provider-field-label">API Key</label>
                <div className="provider-api-key-box">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    className="provider-text-input"
                    placeholder={
                      selectedProvider.hasKey
                        ? '••••••••••••••••••••••••••••••••••••••••'
                        : 'sk-...'
                    }
                    value={formApiKey}
                    onChange={(e) => setFormApiKey(e.target.value)}
                    onBlur={() => {
                      if (formApiKey.trim()) void handleSaveCurrentProvider();
                    }}
                  />
                  <button
                    type="button"
                    className="provider-eye-btn"
                    title={showApiKey ? '隐藏密钥' : '显示密钥'}
                    onClick={() => setShowApiKey((v) => !v)}
                  >
                    {showApiKey ? <IconEyeOff /> : <IconEye />}
                  </button>
                </div>
              </div>

              {/* 启用后才展开该供应商的模型列表 */}
              {formEnabled ? (
              <div className="provider-models-section">
                <div className="provider-models-title-row">
                  <span className="provider-models-title">模型列表</span>
                </div>

                <div className="provider-models-list-box">
                  {(!selectedProvider.models || selectedProvider.models.length === 0) ? (
                    <div style={{ padding: '16px', color: 'var(--fg-faint)', fontSize: '13px', textAlign: 'center' }}>
                      暂无模型，请点击下方 "+ 添加模型"
                    </div>
                  ) : (
                    selectedProvider.models.map((mod) => {
                      const isActive =
                        activeProviderId === selectedProvider.id && activeModelId === mod.id;
                      const testState = testResults[mod.id];

                      return (
                        <div key={mod.id} className="provider-model-row">
                          <div className="provider-model-left">
                            <span className="provider-model-name-text">{mod.model}</span>
                          </div>

                          <div className="provider-model-actions">
                            {mod.contextWindow ? (
                              <span className="provider-model-badge">{mod.contextWindow}</span>
                            ) : null}
                            {mod.thinkingEnabled ? (
                              <span className="provider-model-badge" title="已开启思考/推理模式">
                                思考: {mod.thinkingLevel === 'high' ? '高' : mod.thinkingLevel === 'low' ? '低' : '中'}
                              </span>
                            ) : null}
                            {isActive ? (
                              <span className="provider-model-badge active-indicator">
                                ● 已激活
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="provider-model-badge set-active-btn"
                                title="将此模型设为当前对话模型"
                                onClick={() => handleSetActive(mod)}
                              >
                                设为当前
                              </button>
                            )}

                            {/* 测速结果 */}
                            {testState?.testing ? (
                              <span className="model-latency-pill">测试中...</span>
                            ) : testState?.ok ? (
                              <span className="model-latency-pill">{testState.latencyMs}ms</span>
                            ) : testState?.error ? (
                              <span
                                className="model-latency-pill error"
                                title={testState.error}
                              >
                                失败
                              </span>
                            ) : null}

                            {/* 测试连接按钮 */}
                            <button
                              type="button"
                              className="model-action-icon-btn"
                              title="测试连接延迟"
                              onClick={() => handleTestModel(mod)}
                            >
                              <IconPlug />
                            </button>

                            {/* 编辑模型按钮 */}
                            <button
                              type="button"
                              className="model-action-icon-btn"
                              title="编辑模型"
                              onClick={() => handleOpenEditModel(mod)}
                            >
                              <IconEdit />
                            </button>

                            {/* 删除模型按钮 */}
                            <button
                              type="button"
                              className="model-action-icon-btn danger"
                              title="删除模型"
                              onClick={() => handleDeleteModel(mod)}
                            >
                              <IconTrash />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* + 添加模型 按钮 */}
                <button
                  type="button"
                  className="provider-add-model-btn"
                  onClick={handleOpenAddModel}
                >
                  <IconPlus />
                  <span>添加模型</span>
                </button>
              </div>
              ) : (
                <div className="provider-models-section">
                  <div className="provider-models-title-row">
                    <span className="provider-models-title">模型列表</span>
                  </div>
                  <div className="provider-models-list-box">
                    <div style={{ padding: '16px', color: 'var(--fg-faint)', fontSize: '13px', textAlign: 'center' }}>
                      启用此服务商后显示其模型
                    </div>
                  </div>
                </div>
              )}

              {/* 底部保存与提示条 */}
              <div className="provider-footer-save-bar">
                <span style={{ fontSize: '12px', color: saveTip ? 'var(--ok)' : 'var(--fg-faint)' }}>
                  {saveTip || '配置已自动保存并实时同步至 AgentBot'}
                </span>
                <button
                  type="button"
                  className="provider-save-btn"
                  disabled={isSaving}
                  onClick={() => handleSaveCurrentProvider()}
                >
                  {isSaving ? '保存中...' : '保存更改'}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--fg-faint)' }}>
              请在左侧选择或添加一个服务商
            </div>
          )}
        </div>
      </div>

      {/* 弹窗：添加供应商 */}
      {showAddProviderModal && (
        <div className="submodal-overlay" onClick={() => setShowAddProviderModal(false)}>
          <div className="submodal-box" onClick={(e) => e.stopPropagation()}>
            <h3 className="submodal-title">添加供应商</h3>
            <form onSubmit={handleAddProviderSubmit}>
              <div className="provider-field-group">
                <label className="provider-field-label">供应商名称</label>
                <input
                  type="text"
                  className="provider-text-input"
                  placeholder="例如：Moonshot、本地 Ollama"
                  required
                  value={newProvName}
                  onChange={(e) => setNewProvName(e.target.value)}
                />
              </div>

              <div className="provider-field-group">
                <label className="provider-field-label">分组类别</label>
                <input
                  type="text"
                  className="provider-text-input"
                  placeholder="自定义供应商"
                  value={newProvGroup}
                  onChange={(e) => setNewProvGroup(e.target.value)}
                />
              </div>

              <div className="provider-field-group">
                <label className="provider-field-label">Base URL</label>
                <input
                  type="text"
                  className="provider-text-input"
                  placeholder="https://api.openai.com/v1"
                  required
                  value={newProvBaseURL}
                  onChange={(e) => setNewProvBaseURL(e.target.value)}
                />
              </div>

              <div className="provider-field-group">
                <label className="provider-field-label">API 格式</label>
                <select
                  className="provider-select"
                  value={newProvApiFormat}
                  onChange={(e) => setNewProvApiFormat(e.target.value as 'openai' | 'responses')}
                >
                  <option value="responses">Responses (/responses)</option>
                  <option value="openai">OpenAI 兼容 (/chat/completions)</option>
                </select>
              </div>

              <div className="provider-field-group">
                <label className="provider-field-label">API Key（可选）</label>
                <input
                  type="password"
                  className="provider-text-input"
                  placeholder="sk-..."
                  value={newProvApiKey}
                  onChange={(e) => setNewProvApiKey(e.target.value)}
                />
              </div>

              <div className="submodal-actions">
                <button
                  type="button"
                  className="provider-add-model-btn"
                  onClick={() => setShowAddProviderModal(false)}
                >
                  取消
                </button>
                <button type="submit" className="provider-save-btn">
                  确定添加
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 弹窗：添加 / 编辑模型 */}
      {modelModalOpen && (
        <div className="submodal-overlay" onClick={() => setModelModalOpen(false)}>
          <div className="submodal-box" onClick={(e) => e.stopPropagation()}>
            <h3 className="submodal-title">
              {modelModalMode === 'edit' ? '编辑模型' : '添加模型'}
            </h3>
            <form onSubmit={handleSaveModelSubmit}>
              <div className="provider-field-group">
                <label className="provider-field-label">模型标识 (Model ID)</label>
                <input
                  type="text"
                  className="provider-text-input"
                  placeholder="例如：deepseek-reasoner、glm-5.2"
                  required
                  value={modelInputModel}
                  onChange={(e) => handleModelInputChange(e.target.value)}
                />
              </div>

              <div className="provider-field-group">
                <label className="provider-field-label">显示名称（留空跟随模型标识）</label>
                <input
                  type="text"
                  className="provider-text-input"
                  placeholder="输入条里显示的名字，默认与模型标识一致"
                  value={modelInputName}
                  onChange={(e) => setModelInputName(e.target.value)}
                />
              </div>

              <div className="provider-field-group">
                <label className="provider-field-label">上下文窗口 (Context Window)</label>
                <input
                  type="text"
                  className="provider-text-input"
                  placeholder="例如：128K、200K、64K"
                  value={modelInputContext}
                  onChange={(e) => setModelInputContext(e.target.value)}
                />
              </div>

              {/* 思考模式与思考等级 */}
              <div className="provider-field-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={modelInputThinking}
                    onChange={(e) => setModelInputThinking(e.target.checked)}
                  />
                  <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--fg)' }}>
                    开启深度思考 / 推理模式 (Thinking Mode)
                  </span>
                </label>
              </div>

              {modelInputThinking && (
                <div className="provider-field-group" style={{ paddingLeft: '22px' }}>
                  <label className="provider-field-label">思考等级 (Reasoning Effort)</label>
                  <select
                    className="provider-select"
                    value={modelInputThinkingLevel}
                    onChange={(e) => setModelInputThinkingLevel(e.target.value as ThinkingLevel)}
                  >
                    {STANDARD_THINKING_LEVELS.map((lvl) => (
                      <option key={lvl.id} value={lvl.id}>
                        {lvl.nameZh} ({lvl.label}) - {lvl.tokenBudgetHint || ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* 设为当前激活模型 */}
              <div className="provider-field-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={modelInputSetActive}
                    onChange={(e) => setModelInputSetActive(e.target.checked)}
                  />
                  <span style={{ fontSize: '13px', color: 'var(--fg-muted)' }}>
                    设为当前使用的模型
                  </span>
                </label>
              </div>

              <div className="submodal-actions">
                <button
                  type="button"
                  className="provider-add-model-btn"
                  onClick={() => setModelModalOpen(false)}
                >
                  取消
                </button>
                <button type="submit" className="provider-save-btn">
                  保存模型
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
