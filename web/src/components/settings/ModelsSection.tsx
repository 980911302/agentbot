import { useState } from 'react';
import { IconPlus } from '../../icons';
import { Button } from '../ui';
import { AddProviderDialog } from './AddProviderDialog.js';
import { ProviderCard } from './ProviderCard.js';
import type { ModelSettingsController } from './use-model-settings.js';

/** 模型页：所有服务商在一页里，改动即时保存；圆点标出当前模型。 */
export function ModelsSection({ settings }: { settings: ModelSettingsController }) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="provider-detail-scroll">
      <div className="provider-header-row">
        <h2 className="provider-title-text">模型</h2>
        <Button size="sm" onClick={() => setAdding(true)}>
          <IconPlus size={14} aria-hidden="true" />
          添加服务商
        </Button>
      </div>

      {settings.loading ? (
        <p className="models-note">正在读取…</p>
      ) : settings.providers.length === 0 ? (
        <p className="models-note">还没有服务商，先添加一个。</p>
      ) : (
        settings.providers.map((provider) => (
          <ProviderCard key={provider.id} provider={provider} settings={settings} />
        ))
      )}

      <p className="models-note">
        改动即时保存；点圆点切换当前模型。上下文按 1M 计，模型实际上限更小时会自动识别。
      </p>

      <AddProviderDialog open={adding} onClose={() => setAdding(false)} onSubmit={settings.addProvider} />
    </div>
  );
}
