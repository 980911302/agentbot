export type SettingsTab = 'general' | 'tools' | 'models';

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: '通用' },
  { id: 'tools', label: '工具' },
  { id: 'models', label: '模型' },
];

/** 设置左侧导航：三项，纯文字，选中用强调弱底。 */
export function SettingsNav({ tab, onTab }: { tab: SettingsTab; onTab: (next: SettingsTab) => void }) {
  return (
    <nav className="settings-nav" aria-label="设置分区">
      <div className="settings-nav-title">设置</div>
      {TABS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`settings-nav-item${tab === item.id ? ' active' : ''}`}
          aria-current={tab === item.id ? 'page' : undefined}
          onClick={() => onTab(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
