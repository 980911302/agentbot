import { BotFace } from './BotFace';
import { IconArrows, IconClose, IconExpand } from '../icons';
import type { ArtifactView, BotSummary, DisplayMessage } from '../types';

interface BotScreenProps {
  bot: BotSummary | null;
  messages: DisplayMessage[];
  artifacts: ArtifactView[];
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onClose: () => void;
}

interface Activity {
  name: string;
  arguments: string;
  result?: string;
  durationMs?: number;
  status: 'running' | 'ok' | 'error';
}

function latestActivity(messages: DisplayMessage[]): Activity | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const calls = message.toolCalls;
    if (calls.length === 0) continue;
    const running = calls.find((call) => call.status === 'running');
    return running ?? calls[calls.length - 1] ?? null;
  }
  return null;
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function fileSizeLabel(path: string): string {
  const name = path.split('/').pop() ?? path;
  return name;
}

export function BotScreen({
  bot,
  messages,
  artifacts,
  fullscreen,
  onToggleFullscreen,
  onClose,
}: BotScreenProps) {
  const activity = latestActivity(messages);
  const busy = bot?.status === 'thinking' || bot?.status === 'working';

  return (
    <section className={`screen${fullscreen ? ' fullscreen' : ''}`}>
      <header className="screen-head">
        <span className="screen-dot" data-busy={busy} />
        <span className="screen-title">{bot?.name ?? 'Bot'} 的屏幕</span>
        <button
          type="button"
          className="screen-btn"
          aria-label={fullscreen ? '退出全屏' : '全屏'}
          onClick={onToggleFullscreen}
        >
          <IconExpand size={15} />
        </button>
        <button type="button" className="screen-btn" aria-label="关闭" onClick={onClose}>
          <IconClose size={15} />
        </button>
      </header>

      <div className="screen-body">
        <div className="screen-stage">
          <div className="stage-bar">
            <span className="stage-dot" />
            <span className="stage-dot" />
            <span className="stage-dot" />
            <span className="stage-url">
              {activity ? `tool://${activity.name}` : 'about:blank'}
            </span>
          </div>
          <div className="stage-view">
            {activity ? (
              <>
                <div className="stage-row">
                  <span className="stage-label">调用</span>
                  <code>{activity.name}</code>
                  <span className={`stage-state ${activity.status}`}>
                    {activity.status === 'running'
                      ? '执行中'
                      : `${activity.status === 'error' ? '失败' : '完成'}${
                          activity.durationMs !== undefined ? ` · ${activity.durationMs}ms` : ''
                        }`}
                  </span>
                </div>
                <pre className="stage-pre">{pretty(activity.arguments)}</pre>
                {activity.result !== undefined ? (
                  <>
                    <div className="stage-row">
                      <span className="stage-label">返回</span>
                    </div>
                    <pre className={`stage-pre out${activity.status === 'error' ? ' fail' : ''}`}>
                      {activity.result.length > 1400
                        ? `${activity.result.slice(0, 1400)}\n…`
                        : activity.result}
                    </pre>
                  </>
                ) : null}
              </>
            ) : (
              <div className="stage-empty">
                {bot ? (
                  <>
                    <BotFace color={bot.color} status={bot.status} size={64} />
                    <p>
                      {busy
                        ? '正在处理你的请求…'
                        : '空闲中。发一条消息，这里会实时显示它的动作。'}
                    </p>
                  </>
                ) : null}
              </div>
            )}
          </div>
        </div>

        <div className="screen-files">
          <div className="screen-files-head">
            <IconArrows size={14} />
            <span>产物</span>
            <span className="screen-count">{artifacts.length}</span>
          </div>
          {artifacts.length === 0 ? (
            <p className="screen-files-empty">这个对话还没有读写文件</p>
          ) : (
            <ul className="file-list">
              {artifacts.map((artifact) => (
                <li className="file-chip" key={`${artifact.tool}-${artifact.path}`}>
                  <span className="file-ext">{extensionOf(artifact.path)}</span>
                  <span className="file-name">{fileSizeLabel(artifact.path)}</span>
                  <span className="file-tool">{artifact.tool}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'file';
  return name.slice(dot + 1).toUpperCase();
}
