import { IconEdit, IconPlus, IconTrash } from '../../icons';
import { TestConnection } from './TestConnection.js';
import type { ModelSettingsController } from './use-model-settings.js';

/** 服务商的模型列表（UI-08）：启用后才展开；每行是徽标 + 测试 + 编辑 + 删除。 */
export function ModelList({ settings }: { settings: ModelSettingsController }) {
  const provider = settings.selectedProvider;
  if (!provider) return null;

  const models = provider.models ?? [];

  return (
    <div className="provider-models-section">
      <div className="provider-models-title-row">
        <span className="provider-models-title">模型列表</span>
      </div>

      <div className="provider-models-list-box">
        {!settings.formEnabled ? (
          <div className="provider-models-empty">启用此服务商后显示其模型</div>
        ) : models.length === 0 ? (
          <div className="provider-models-empty">暂无模型，请点击下方「+ 添加模型」</div>
        ) : (
          models.map((mod) => {
            const isActive = settings.activeProviderId === provider.id && settings.activeModelId === mod.id;
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
                    <span className="provider-model-badge active-indicator">● 已激活</span>
                  ) : (
                    <button
                      type="button"
                      className="provider-model-badge set-active-btn"
                      title="将此模型设为当前对话模型"
                      onClick={() => void settings.activateModel(mod)}
                    >
                      设为当前
                    </button>
                  )}

                  <TestConnection
                    modelName={mod.model}
                    state={settings.testResults[mod.id]}
                    onTest={() => void settings.testModel(mod)}
                  />

                  <button
                    type="button"
                    className="model-action-icon-btn"
                    title="编辑模型"
                    aria-label={`编辑 ${mod.model}`}
                    onClick={() => settings.openEditModel(mod)}
                  >
                    <IconEdit />
                  </button>

                  <button
                    type="button"
                    className="model-action-icon-btn danger"
                    title="删除模型"
                    aria-label={`删除 ${mod.model}`}
                    onClick={() => void settings.deleteModel(mod)}
                  >
                    <IconTrash />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {settings.formEnabled ? (
        <button type="button" className="provider-add-model-btn" onClick={settings.openAddModel}>
          <IconPlus />
          <span>添加模型</span>
        </button>
      ) : null}
    </div>
  );
}
