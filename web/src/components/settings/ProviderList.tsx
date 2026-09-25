import { IconCube, IconPlug, IconPlus, IconSparkles, IconTool } from '../../icons';
import { Field } from './Field.js';
import type { ModelSettingsController } from './use-model-settings.js';

/**
 * 左侧分区导航（UI-08）：基础配置 + 按分组列出的服务商 + 底部「添加服务商」，
 * 添加弹窗也放在这里（按钮与弹窗同处一地）。
 */
export function ProviderList({ settings }: { settings: ModelSettingsController }) {
  const { newProvider, setNewProvider, newProviderErrors } = settings;

  const openAdd = () => {
    setNewProvider({
      name: '',
      group: '自定义供应商',
      baseURL: 'https://api.openai.com/v1',
      apiFormat: 'openai',
      apiKey: '',
    });
    settings.setAddProviderOpen(true);
  };

  const patch = (next: Partial<typeof newProvider>) => setNewProvider({ ...newProvider, ...next });

  return (
    <>
      <div className="provider-sidebar">
        <div className="provider-sidebar-header">
          <span className="provider-sidebar-title">偏好设置</span>
        </div>

        <div className="provider-sidebar-scroll">
          <div className="provider-group">
            <div className="provider-group-title">基础配置</div>
            <button
              type="button"
              className={`provider-item-row ${settings.activeTab === 'general' ? 'selected' : ''}`}
              aria-current={settings.activeTab === 'general'}
              onClick={() => settings.setActiveTab('general')}
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
            <div className="provider-group-title">能力与工具</div>
            <button
              type="button"
              className={`provider-item-row ${settings.activeTab === 'agent-tools' ? 'selected' : ''}`}
              aria-current={settings.activeTab === 'agent-tools'}
              onClick={() => settings.setActiveTab('agent-tools')}
            >
              <span className="provider-item-left">
                <span className="provider-item-icon">
                  <IconTool style={{ width: 16, height: 16 }} />
                </span>
                <span className="provider-item-name">工具装卸</span>
              </span>
            </button>
          </div>

          <div className="provider-group-divider" />

          <div className="provider-group">
            <div className="provider-group-title">模型设置</div>
            {Object.entries(settings.groupedProviders).map(([groupName, provs]) => (
              <div key={groupName} className="provider-subgroup">
                <div className="provider-subgroup-title">{groupName}</div>
                {provs.map((prov) => {
                  const isSelected = settings.activeTab === prov.id;
                  const isEnabled = prov.enabled !== false;
                  const isZhipu = prov.group === '智谱' || prov.name.toLowerCase().includes('bigmodel');
                  return (
                    <button
                      key={prov.id}
                      type="button"
                      className={`provider-item-row ${isSelected ? 'selected' : ''}`}
                      aria-current={isSelected}
                      onClick={() => {
                        settings.setActiveTab(prov.id);
                        settings.setSelectedProviderId(prov.id);
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

        <div className="provider-sidebar-footer">
          <button type="button" className="provider-add-btn" onClick={openAdd}>
            <IconPlus size={15} />
            <span>添加服务商</span>
          </button>
        </div>
      </div>

      {settings.addProviderOpen ? (
        <div className="submodal-overlay" onClick={() => settings.setAddProviderOpen(false)}>
          <div
            className="submodal-box"
            role="dialog"
            aria-modal="true"
            aria-label="添加供应商"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="submodal-title">添加供应商</h3>
            <form onSubmit={(e) => void settings.submitNewProvider(e)}>
              <Field label="供应商名称" htmlFor="new-provider-name" required error={newProviderErrors.name}>
                <input
                  id="new-provider-name"
                  type="text"
                  className="provider-text-input"
                  placeholder="例如：Moonshot、本地 Ollama"
                  value={newProvider.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Field>

              <Field label="分组类别" htmlFor="new-provider-group" hint="同一个分组会并排显示在左侧导航里">
                <input
                  id="new-provider-group"
                  type="text"
                  className="provider-text-input"
                  placeholder="自定义供应商"
                  value={newProvider.group}
                  onChange={(e) => patch({ group: e.target.value })}
                />
              </Field>

              <Field
                label="Base URL"
                htmlFor="new-provider-base-url"
                required
                error={newProviderErrors.baseURL}
              >
                <input
                  id="new-provider-base-url"
                  type="text"
                  className="provider-text-input"
                  placeholder="https://api.openai.com/v1"
                  value={newProvider.baseURL}
                  onChange={(e) => patch({ baseURL: e.target.value })}
                />
              </Field>

              <Field label="API 格式" htmlFor="new-provider-format">
                <select
                  id="new-provider-format"
                  className="provider-select"
                  value={newProvider.apiFormat}
                  onChange={(e) => patch({ apiFormat: e.target.value as 'openai' | 'responses' })}
                >
                  <option value="responses">Responses (/responses)</option>
                  <option value="openai">OpenAI 兼容 (/chat/completions)</option>
                </select>
              </Field>

              <Field label="API Key" htmlFor="new-provider-key" hint="可以先留空，之后再填或走环境变量">
                <input
                  id="new-provider-key"
                  type="password"
                  className="provider-text-input"
                  placeholder="sk-..."
                  autoComplete="off"
                  value={newProvider.apiKey}
                  onChange={(e) => patch({ apiKey: e.target.value })}
                />
              </Field>

              <div className="submodal-actions">
                <button
                  type="button"
                  className="provider-add-model-btn"
                  onClick={() => settings.setAddProviderOpen(false)}
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
      ) : null}
    </>
  );
}
