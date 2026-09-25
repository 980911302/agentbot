import { useEffect, useState } from 'react';
import type { ThemePreference } from '../../theme';
import { SegmentedControl } from '../ui';

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

/** 通用偏好（UI-08）：主题分段控件、主人显示名、本地服务与工具数。 */
export function GeneralSection({
  theme,
  ownerName,
  endpoint,
  toolCount,
  onTheme,
  onOwnerName,
}: {
  theme: ThemePreference;
  ownerName: string;
  endpoint: string;
  toolCount: number;
  onTheme: (next: ThemePreference) => void;
  onOwnerName: (next: string) => void;
}) {
  const [ownerNameInput, setOwnerNameInput] = useState(ownerName);

  useEffect(() => {
    setOwnerNameInput(ownerName);
  }, [ownerName]);

  const commitOwnerName = () => {
    if (ownerNameInput.trim()) onOwnerName(ownerNameInput.trim());
  };

  return (
    <div className="provider-detail-scroll">
      <div className="provider-header-row">
        <div className="provider-header-left">
          <h2 className="provider-title-text">通用偏好</h2>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">界面外观</div>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-label">
              <span className="settings-row-name">主题模式</span>
              <span className="settings-row-desc">选择契合当前光照与视觉习惯的显示风格</span>
            </div>
            <SegmentedControl options={THEME_OPTIONS} value={theme} onChange={onTheme} ariaLabel="主题模式" />
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">用户身份</div>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-label">
              <span className="settings-row-name">主人显示名</span>
              <span className="settings-row-desc">智能体在私聊与群聊对话中称呼你的名字</span>
            </div>
            <div className="settings-row-control">
              <input
                id="settings-owner-name"
                type="text"
                className="provider-text-input"
                aria-label="主人显示名"
                value={ownerNameInput}
                placeholder="linlin zhang"
                onChange={(e) => setOwnerNameInput(e.target.value)}
                onBlur={commitOwnerName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitOwnerName();
                }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">运行环境</div>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-label">
              <span className="settings-row-name">本地服务地址</span>
              <span className="settings-row-desc">智能体协同主进程在本机运行，对话数据不出域</span>
            </div>
            <div className="settings-row-inline">
              <span className="live-dot pulse" />
              <span className="settings-mono-value">{endpoint || 'http://127.0.0.1:8787'}</span>
            </div>
          </div>
          <div className="settings-row divided">
            <div className="settings-row-label">
              <span className="settings-row-name">已挂载原生工具</span>
              <span className="settings-row-desc">Shell 命令行、工作区文件读写、多智能体协同路由</span>
            </div>
            <span className="settings-accent-value">{toolCount} 项工具能力</span>
          </div>
        </div>
      </div>
    </div>
  );
}
