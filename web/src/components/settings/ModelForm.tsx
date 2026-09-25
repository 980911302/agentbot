import { STANDARD_THINKING_LEVELS, type ThinkingLevel } from '../../../../src/shared/contracts/model-catalog';
import { Field } from './Field.js';
import type { ModelSettingsController } from './use-model-settings.js';

/** 添加 / 编辑模型（UI-08）：字段按规范排布，必填与错误态都走 Field。 */
export function ModelForm({ settings }: { settings: ModelSettingsController }) {
  if (!settings.modelFormOpen) return null;
  const { modelDraft, setModelDraft, modelFormErrors } = settings;

  return (
    <div className="submodal-overlay" onClick={() => settings.setModelFormOpen(false)}>
      <div
        className="submodal-box"
        role="dialog"
        aria-modal="true"
        aria-label={settings.modelFormMode === 'edit' ? '编辑模型' : '添加模型'}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="submodal-title">{settings.modelFormMode === 'edit' ? '编辑模型' : '添加模型'}</h3>
        <form onSubmit={(e) => void settings.submitModelForm(e)}>
          <Field label="模型标识 (Model ID)" htmlFor="model-form-id" required error={modelFormErrors.model}>
            <input
              id="model-form-id"
              type="text"
              className="provider-text-input"
              placeholder="例如：deepseek-reasoner、glm-5.2"
              value={modelDraft.model}
              onChange={(e) => settings.changeModelId(e.target.value)}
            />
          </Field>

          <Field label="显示名称" htmlFor="model-form-name" hint="留空跟随模型标识">
            <input
              id="model-form-name"
              type="text"
              className="provider-text-input"
              placeholder="输入条里显示的名字，默认与模型标识一致"
              value={modelDraft.name}
              onChange={(e) => setModelDraft({ ...modelDraft, name: e.target.value })}
            />
          </Field>

          <Field label="上下文窗口 (Context Window)" htmlFor="model-form-context" hint="例如 128K、200K、64K">
            <input
              id="model-form-context"
              type="text"
              className="provider-text-input"
              placeholder="例如：128K、200K、64K"
              value={modelDraft.contextWindow}
              onChange={(e) => setModelDraft({ ...modelDraft, contextWindow: e.target.value })}
            />
          </Field>

          <div className="provider-field-group">
            <label className="provider-check-row" htmlFor="model-form-thinking">
              <input
                id="model-form-thinking"
                type="checkbox"
                checked={modelDraft.thinkingEnabled}
                onChange={(e) => setModelDraft({ ...modelDraft, thinkingEnabled: e.target.checked })}
              />
              <span>开启深度思考 / 推理模式 (Thinking Mode)</span>
            </label>
          </div>

          {modelDraft.thinkingEnabled ? (
            <Field label="思考等级 (Reasoning Effort)" htmlFor="model-form-thinking-level">
              <select
                id="model-form-thinking-level"
                className="provider-select"
                value={modelDraft.thinkingLevel}
                onChange={(e) =>
                  setModelDraft({ ...modelDraft, thinkingLevel: e.target.value as ThinkingLevel })
                }
              >
                {STANDARD_THINKING_LEVELS.map((level) => (
                  <option key={level.id} value={level.id}>
                    {level.nameZh} ({level.label}) - {level.tokenBudgetHint || ''}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          <div className="provider-field-group">
            <label className="provider-check-row" htmlFor="model-form-active">
              <input
                id="model-form-active"
                type="checkbox"
                checked={modelDraft.setActive}
                onChange={(e) => setModelDraft({ ...modelDraft, setActive: e.target.checked })}
              />
              <span className="muted">设为当前使用的模型</span>
            </label>
          </div>

          <div className="submodal-actions">
            <button
              type="button"
              className="provider-add-model-btn"
              onClick={() => settings.setModelFormOpen(false)}
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
  );
}
