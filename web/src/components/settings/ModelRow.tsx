import { useState } from 'react';
import { IconClose, IconPlus } from '../../icons';
import type { ProviderItemConfig, ProviderModelConfig } from '../../api';
import { SegmentedControl } from '../ui';
import { THINKING_CHOICES, thinkingChoiceOf } from './model-settings-shared.js';
import { TestConnection } from './TestConnection.js';
import type { ModelSettingsController } from './use-model-settings.js';

/** 一行一个模型：圆点切换当前模型、思考强度、测试、删除（最后一个模型不能删）。 */
export function ModelRow({
  provider,
  model,
  settings,
}: {
  provider: ProviderItemConfig;
  model: ProviderModelConfig;
  settings: ModelSettingsController;
}) {
  const active = settings.activeProviderId === provider.id && settings.activeModelId === model.id;
  return (
    <div className={`model-row${active ? ' active' : ''}`}>
      <button
        type="button"
        role="radio"
        aria-checked={active}
        className="model-pick"
        title={active ? '当前使用的模型' : '设为当前模型'}
        onClick={() => {
          if (!active) void settings.activateModel(provider, model);
        }}
      >
        <span className="model-pick-dot" aria-hidden="true" />
        <span className="model-pick-name">{model.model}</span>
      </button>
      <span className="model-row-label">思考</span>
      <SegmentedControl
        options={THINKING_CHOICES}
        value={thinkingChoiceOf(model)}
        onChange={(choice) => void settings.setThinking(provider, model, choice)}
        ariaLabel={`${model.model} 的思考强度`}
      />
      <TestConnection
        modelName={model.model}
        state={settings.testResults[model.id]}
        onTest={() => void settings.testModel(provider, model)}
      />
      {provider.models.length > 1 ? (
        <button
          type="button"
          className="model-remove"
          aria-label={`删除 ${model.model}`}
          title="删除模型"
          onClick={() => void settings.deleteModel(provider, model)}
        >
          <IconClose size={14} aria-hidden="true" />
        </button>
      ) : (
        <span className="model-remove placeholder" aria-hidden="true" />
      )}
    </div>
  );
}

/** 行内添加模型：输入模型名，回车添加；成功才清空，失败保留原文方便改 */
export function AddModelInput({
  provider,
  settings,
}: {
  provider: ProviderItemConfig;
  settings: ModelSettingsController;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="model-add"
      onSubmit={(event) => {
        event.preventDefault();
        const name = value.trim();
        if (!name || busy) return;
        setBusy(true);
        void settings
          .addModel(provider, name)
          .then((ok) => ok && setValue(''))
          .finally(() => setBusy(false));
      }}
    >
      <IconPlus size={14} aria-hidden="true" />
      <input
        className="model-add-input"
        value={value}
        placeholder="输入模型名，回车添加"
        aria-label={`给 ${provider.name} 添加模型`}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
      />
    </form>
  );
}
