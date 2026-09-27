import { useEffect, useState } from 'react';
import { IconTrash } from '../../icons';
import type { ProviderItemConfig } from '../../api';
import { baseURLError } from './model-settings-shared.js';
import { AddModelInput, ModelRow } from './ModelRow.js';
import type { ModelSettingsController } from './use-model-settings.js';

/**
 * 一个服务商一张卡：名称（点一下改名）、启用开关、删除；地址与 Key 失焦即存；下面是模型行。
 * 停用的服务商只留一行标题，重新打开再展开。
 */
export function ProviderCard({
  provider,
  settings,
}: {
  provider: ProviderItemConfig;
  settings: ModelSettingsController;
}) {
  const [name, setName] = useState(provider.name);
  const [editingName, setEditingName] = useState(false);
  const [baseURL, setBaseURL] = useState(provider.baseURL);
  const [urlError, setUrlError] = useState<string>();
  const [apiKey, setApiKey] = useState('');

  useEffect(() => setName(provider.name), [provider.name]);
  useEffect(() => setBaseURL(provider.baseURL), [provider.baseURL]);

  const enabled = provider.enabled !== false;
  const keyPlaceholder = provider.hasKey
    ? '已保存，留空不改'
    : settings.envHasKey
      ? '留空则用环境变量 AGENT_API_KEY'
      : 'sk-...';

  const commitName = () => {
    setEditingName(false);
    const next = name.trim();
    if (!next || next === provider.name) {
      setName(provider.name);
      return;
    }
    void settings.saveProvider(provider.id, { name: next });
  };

  const commitURL = () => {
    const next = baseURL.trim().replace(/\/+$/, '');
    const error = baseURLError(next);
    setUrlError(error);
    if (error || next === provider.baseURL) return;
    void settings.saveProvider(provider.id, { baseURL: next });
  };

  const commitKey = () => {
    const next = apiKey.trim();
    if (!next) return;
    void settings.saveProvider(provider.id, { apiKey: next }).then((ok) => ok && setApiKey(''));
  };

  const urlId = `provider-url-${provider.id}`;
  const keyId = `provider-key-${provider.id}`;

  return (
    <section className={`provider-card${enabled ? '' : ' off'}`} aria-label={provider.name}>
      <div className="provider-card-head">
        {editingName ? (
          <input
            className="provider-name-input"
            value={name}
            autoFocus
            aria-label="服务商名称"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitName();
            }}
          />
        ) : (
          <button
            type="button"
            className="provider-name"
            title="点击改名"
            onClick={() => setEditingName(true)}
          >
            {provider.name}
          </button>
        )}
        <span className="provider-card-spacer" />
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`启用 ${provider.name}`}
          title={enabled ? '已启用' : '已停用'}
          className={`provider-switch${enabled ? ' on' : ''}`}
          onClick={() => void settings.saveProvider(provider.id, { enabled: !enabled })}
        >
          <span className="provider-switch-thumb" />
        </button>
        <button
          type="button"
          className="provider-card-delete"
          aria-label={`删除 ${provider.name}`}
          title="删除服务商"
          onClick={() => void settings.deleteProvider(provider)}
        >
          <IconTrash size={15} aria-hidden="true" />
        </button>
      </div>

      {enabled ? (
        <>
          <div className="provider-card-fields">
            <label className="provider-card-label" htmlFor={urlId}>
              地址
            </label>
            <div>
              <input
                id={urlId}
                className="provider-text-input"
                value={baseURL}
                placeholder="https://api.example.com/v1"
                aria-invalid={urlError ? true : undefined}
                onChange={(event) => setBaseURL(event.target.value)}
                onBlur={commitURL}
              />
              {urlError ? (
                <div className="provider-field-error" role="alert">
                  {urlError}
                </div>
              ) : null}
            </div>
            <label className="provider-card-label" htmlFor={keyId}>
              Key
            </label>
            <input
              id={keyId}
              type="password"
              className="provider-text-input"
              value={apiKey}
              placeholder={keyPlaceholder}
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
              onBlur={commitKey}
            />
          </div>

          <div className="model-rows">
            <div role="radiogroup" aria-label={`${provider.name} 的模型`}>
              {provider.models.map((model) => (
                <ModelRow key={model.id} provider={provider} model={model} settings={settings} />
              ))}
            </div>
            <AddModelInput provider={provider} settings={settings} />
          </div>
        </>
      ) : null}
    </section>
  );
}
