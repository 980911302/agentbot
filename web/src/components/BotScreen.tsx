import { BotFace } from './BotFace';
import { IconArrows, IconClose, IconExpand } from '../icons';
import { ToolCallCard } from './ToolCallCard';
import type { ArtifactView, BotSummary, DisplayMessage, ToolCallView } from '../types';

interface BotScreenProps {
  bot: BotSummary | null;
  messages: DisplayMessage[];
  artifacts: ArtifactView[];
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onClose: () => void;
}

/**
 * 「屏幕」抽屉 = 这只智能体的执行记录。
 *
 * 对话流里只保留最终回复；全部工具调用按时间线陈列在这里：
 * 正在跑的置顶，其余从新到旧，每条可展开看入参 / 输出。
 */
export function BotScreen({
  bot,
  messages,
  artifacts,
  fullscreen,
  onToggleFullscreen,
  onClose,
}: BotScreenProps) {
  // 旧 → 新拉平；展示时倒过来（新的在上）
  const timeline: ToolCallView[] = messages.flatMap((message) => message.toolCalls);
  const running = timeline.filter((call) => call.status === 'running');
  const history = timeline.filter((call) => call.status !== 'running').reverse();
  const busy = bot?.status === 'thinking' || bot?.status === 'working';
  const hasActivity = running.length > 0 || history.length > 0;

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
          {running.length > 0 ? (
            <div className="tool-timeline">
              {running.map((call) => (
                <ToolCallCard key={call.id} call={call} />
              ))}
            </div>
          ) : null}

          {history.length > 0 ? (
            <>
              <div className="timeline-label">执行时间线 · {history.length} 次调用</div>
              <div className="tool-timeline">
                {history.map((call) => (
                  <ToolCallCard key={call.id} call={call} />
                ))}
              </div>
            </>
          ) : null}

          {!hasActivity ? (
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
          ) : null}
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
                  <span className="file-name">{fileName(artifact.path)}</span>
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

function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

function extensionOf(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'file';
  return name.slice(dot + 1).toUpperCase();
}
