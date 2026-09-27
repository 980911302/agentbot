import { useEffect, useState } from 'react';
import { IconClose } from '../../icons';
import type { ThemePreference } from '../../theme';
import { usePresence } from '../../motion';
import { useModalKeys } from '../ui/useModalKeys.js';
import { AgentToolsSection } from './AgentToolsSection.js';
import { GeneralSection } from './GeneralSection.js';
import { ModelsSection } from './ModelsSection.js';
import { SettingsNav, type SettingsTab } from './SettingsNav.js';
import { useModelSettings } from './use-model-settings.js';

/**
 * 设置弹窗：壳 + 左侧三项导航（通用 / 工具 / 模型）+ 右侧内容。
 * 模型页的数据与动作在 use-model-settings，各分区在 settings/ 目录下的独立文件里。
 */
export interface SettingsDialogProps {
  theme: ThemePreference;
  endpoint: string;
  /** 后端是否连得上：决定服务地址旁的状态点颜色 */
  online?: boolean;
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
  online = true,
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
  const [tab, setTab] = useState<SettingsTab>(openSection);
  const models = useModelSettings({ open, onModel });

  // 每次打开都落到调用方指定的分区（输入条「管理模型」直达模型页）
  useEffect(() => {
    if (open) setTab(openSection);
  }, [open, openSection]);

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

        <SettingsNav tab={tab} onTab={setTab} />

        <div className="provider-content-area">
          {tab === 'general' ? (
            <GeneralSection
              theme={theme}
              ownerName={ownerName}
              endpoint={endpoint}
              online={online}
              toolCount={toolCount}
              onTheme={onTheme}
              onOwnerName={onOwnerName}
            />
          ) : tab === 'tools' ? (
            <AgentToolsSection />
          ) : (
            <ModelsSection settings={models} />
          )}
        </div>
      </div>
    </div>
  );
}
