import { useState } from 'react';
import { IconClose } from '../icons';
import type { ModelOption } from '../types';
import type { ThemePreference } from '../theme';
import { usePresence } from '../motion';

interface SettingsDialogProps {
  theme: ThemePreference;
  model: string;
  models: ModelOption[];
  endpoint: string;
  toolCount: number;
  ownerName: string;
  open: boolean;
  onTheme: (next: ThemePreference) => void;
  onModel: (next: string) => void;
  onOwnerName: (next: string) => void;
  onClose: () => void;
}

const THEME_OPTIONS: Array<{ id: ThemePreference; label: string }> = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
];

export function SettingsDialog({
  theme,
  model,
  models,
  endpoint,
  toolCount,
  ownerName,
  open,
  onTheme,
  onModel,
  onOwnerName,
  onClose,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<'general' | 'usage'>('general');
  const presence = usePresence(open);
  if (!presence.mounted) return null;

  return (
    <div className="scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="设置">
        <nav className="dialog-nav">
          <button
            type="button"
            className={`dialog-tab${tab === 'general' ? ' active' : ''}`}
            onClick={() => setTab('general')}
          >
            通用
          </button>
          <button
            type="button"
            className={`dialog-tab${tab === 'usage' ? ' active' : ''}`}
            onClick={() => setTab('usage')}
          >
            用量与运行
          </button>
        </nav>

        <div className="dialog-main">
          <header className="dialog-head">
            <h2>{tab === 'general' ? '通用' : '用量与运行'}</h2>
            <button type="button" className="dialog-close" aria-label="关闭" onClick={onClose}>
              <IconClose size={16} />
            </button>
          </header>

          <div className="dialog-body swap" key={tab}>
            {tab === 'general' ? (
              <>
                <section className="group">
                  <h3>外观</h3>
                  <div className="rows">
                    <div className="row">
                      <span className="row-label">颜色模式</span>
                      <div className="segmented">
                        {THEME_OPTIONS.map((option) => (
                          <button
                            type="button"
                            key={option.id}
                            className={option.id === theme ? 'selected' : ''}
                            onClick={() => onTheme(option.id)}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="row">
                      <span className="row-label">语言</span>
                      <span className="row-value">简体中文</span>
                    </div>
                  </div>
                </section>

                <section className="group">
                  <h3>主人</h3>
                  <div className="rows">
                    <div className="row">
                      <span className="row-label">显示名</span>
                      <input
                        className="row-input"
                        value={ownerName}
                        placeholder="主人"
                        onChange={(event) => onOwnerName(event.target.value)}
                      />
                    </div>
                  </div>
                </section>

                <section className="group">
                  <h3>模型</h3>
                  <div className="rows">
                    {models.map((option) => (
                      <button
                        type="button"
                        className="row clickable"
                        key={option.id}
                        onClick={() => onModel(option.id)}
                      >
                        <span className="row-label">{option.label}</span>
                        <span className="row-value">
                          {option.hint}
                          {option.id === model ? <em className="row-check">当前</em> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="group">
                  <h3>运行环境</h3>
                  <div className="rows">
                    <div className="row">
                      <span className="row-label">接口地址</span>
                      <span className="row-value mono">{endpoint}</span>
                    </div>
                    <div className="row">
                      <span className="row-label">已装载工具</span>
                      <span className="row-value">{toolCount} 个</span>
                    </div>
                  </div>
                </section>
              </>
            ) : (
              <section className="group">
                <h3>本次会话</h3>
                <div className="rows">
                  <div className="row">
                    <span className="row-label">对话在本地运行</span>
                    <span className="row-value">不经过第三方服务器</span>
                  </div>
                  <div className="row">
                    <span className="row-label">工具调用</span>
                    <span className="row-value">仅限你的项目目录</span>
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
