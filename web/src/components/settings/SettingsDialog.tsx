import { IconClose } from '../../icons';
import type { ThemePreference } from '../../theme';
import { usePresence } from '../../motion';
import { useModalKeys } from '../ui/useModalKeys.js';
import { AgentToolsSection } from './AgentToolsSection.js';
import { GeneralSection } from './GeneralSection.js';
import { ModelForm } from './ModelForm.js';
import { ProviderForm } from './ProviderForm.js';
import { ProviderList } from './ProviderList.js';
import { useModelSettings } from './use-model-settings.js';

/**
 * 设置弹窗（UI-08）：壳 + 左导航 + 右内容。
 * 数据与动作在 use-model-settings，各分区在 settings/ 目录下的独立文件里。
 */
export interface SettingsDialogProps {
  theme: ThemePreference;
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

export function SettingsDialog({
  theme,
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
  const windowRef = useModalKeys({ open, onClose, id: 'settings-dialog' });
  const settings = useModelSettings({ open, openSection, onModel });

  if (!presence.mounted) return null;

  return (
    <div
      className={`provider-settings-scrim ${presence.state}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* 窗口本体才是 dialog，遮罩只是 presentation */}
      <div
        ref={windowRef}
        className="provider-settings-window"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
      >
        <button type="button" className="provider-window-close" onClick={onClose} aria-label="关闭">
          <IconClose />
        </button>

        <ProviderList settings={settings} />

        <div className="provider-content-area">
          {settings.activeTab === 'general' ? (
            <GeneralSection
              theme={theme}
              ownerName={ownerName}
              endpoint={endpoint}
              toolCount={toolCount}
              onTheme={onTheme}
              onOwnerName={onOwnerName}
            />
          ) : settings.activeTab === 'agent-tools' ? (
            <AgentToolsSection />
          ) : settings.selectedProvider ? (
            <ProviderForm settings={settings} />
          ) : (
            <div className="provider-empty-tip">请在左侧选择或添加一个服务商</div>
          )}
        </div>
      </div>

      <ModelForm settings={settings} />
    </div>
  );
}
