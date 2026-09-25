import { IconEdit, IconEye, IconEyeOff, IconTrash } from '../../icons';
import { Field } from './Field.js';
import { ModelList } from './ModelList.js';
import type { ModelSettingsController } from './use-model-settings.js';

/** 服务商详情（UI-08）：标题栏 + 基本字段 + 模型列表 + 吸底保存条。 */
export function ProviderForm({ settings }: { settings: ModelSettingsController }) {
  const provider = settings.selectedProvider;
  if (!provider) return null;

  /** Key 来源（范围第 4 项）：设置页存了就用设置页的，没存则用环境变量兜底 */
  const keyHint = provider.hasKey
    ? <>已配置：<code className="provider-key-mask">{provider.apiKey || '••••••••'}</code> · 来源：设置页</>
    : settings.modelSettings?.config.hasKey
      ? <>未在本页保存 Key · 来源：环境变量（设置页留空时用环境值兜底）</>
      : <>未配置：填一个 Key，或设置环境变量 AGENT_API_KEY</>;

  return (
    <div className="provider-detail-scroll">
      <div className="provider-header-row">
        <div className="provider-header-left">
          <div className="provider-title-box">
            {settings.isEditingName ? (
              <input
                type="text"
                className="provider-title-input"
                value={settings.formName}
                autoFocus
                aria-label="服务商名称"
                onChange={(e) => settings.setFormName(e.target.value)}
                onBlur={() => {
                  settings.setIsEditingName(false);
                  void settings.saveCurrentProvider();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    settings.setIsEditingName(false);
                    void settings.saveCurrentProvider();
                  }
                }}
              />
            ) : (
              <>
                <h2 className="provider-title-text">{settings.formName || provider.name}</h2>
                <button
                  type="button"
                  className="provider-edit-name-btn"
                  title="修改服务商名称"
                  aria-label="修改服务商名称"
                  onClick={() => settings.setIsEditingName(true)}
                >
                  <IconEdit />
                </button>
              </>
            )}
          </div>

          {/* 启用/禁用：与保存走同一条接口，切换即生效 */}
          <div className="segmented-pill-control" role="radiogroup" aria-label="服务商启用状态">
            <button
              type="button"
              role="radio"
              aria-checked={settings.formEnabled}
              className={`segmented-pill-btn ${settings.formEnabled ? 'active enabled' : ''}`}
              onClick={() => void settings.toggleProviderEnabled(true)}
            >
              已启用
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!settings.formEnabled}
              className={`segmented-pill-btn ${!settings.formEnabled ? 'active disabled' : ''}`}
              onClick={() => void settings.toggleProviderEnabled(false)}
            >
              禁用
            </button>
          </div>
        </div>

        <button
          type="button"
          className="provider-delete-btn"
          title="删除此供应商"
          aria-label="删除此供应商"
          onClick={() => void settings.deleteCurrentProvider()}
        >
          <IconTrash />
        </button>
      </div>

      <Field label="Base URL" htmlFor="provider-base-url" required error={settings.formErrors.baseURL}>
        <input
          id="provider-base-url"
          type="text"
          className="provider-text-input"
          placeholder="https://api.openai.com/v1"
          value={settings.formBaseURL}
          onChange={(e) => settings.setFormBaseURL(e.target.value)}
          onBlur={() => void settings.saveCurrentProvider()}
        />
      </Field>

      <Field label="API 格式" htmlFor="provider-api-format" hint="按服务商文档选：Responses 走 /responses，OpenAI 兼容走 /chat/completions">
        <select
          id="provider-api-format"
          className="provider-select"
          value={settings.formApiFormat}
          onChange={(e) => {
            settings.setFormApiFormat(e.target.value as 'openai' | 'responses');
            setTimeout(() => void settings.saveCurrentProvider(), 50);
          }}
        >
          <option value="responses">Responses (/responses)</option>
          <option value="openai">OpenAI 兼容 (/chat/completions)</option>
        </select>
      </Field>

      <Field label="API Key" htmlFor="provider-api-key" hint={keyHint}>
        <div className="provider-api-key-box">
          <input
            id="provider-api-key"
            type={settings.showApiKey ? 'text' : 'password'}
            className="provider-text-input"
            placeholder={provider.hasKey ? '••••••••••••••••••••••••••••••••••••••••' : 'sk-...'}
            value={settings.formApiKey}
            autoComplete="off"
            onChange={(e) => settings.setFormApiKey(e.target.value)}
            onBlur={() => {
              if (settings.formApiKey.trim()) void settings.saveCurrentProvider();
            }}
          />
          <button
            type="button"
            className="provider-eye-btn"
            title={settings.showApiKey ? '隐藏密钥' : '显示密钥'}
            aria-label={settings.showApiKey ? '隐藏密钥' : '显示密钥'}
            onClick={() => settings.setShowApiKey((v) => !v)}
          >
            {settings.showApiKey ? <IconEyeOff /> : <IconEye />}
          </button>
        </div>
      </Field>

      <ModelList settings={settings} />

      <div className="provider-footer-save-bar">
        <span className="provider-save-hint">配置改动即时同步至 AgentBot，也可点右侧手动保存</span>
        <button
          type="button"
          className="provider-save-btn"
          disabled={settings.isSaving}
          onClick={() => void settings.saveCurrentProvider()}
        >
          {settings.isSaving ? '保存中...' : '保存更改'}
        </button>
      </div>
    </div>
  );
}
