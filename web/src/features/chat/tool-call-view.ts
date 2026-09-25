/**
 * 工具调用卡片的纯展示逻辑：耗时格式化。
 * 不碰 React 与 DOM，供 ToolCallCard 与 node:test 共用。
 */

/**
 * 耗时（毫秒）→ 人能读的文字：不到 1 秒写毫秒，1 分钟内写秒（保留 1 位小数），
 * 再长写「N 分 M 秒」。负数、非有限值返回空串（不显示）。
 */
export function formatToolDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  if (ms < 60_000) {
    const seconds = Math.round(ms / 100) / 10;
    if (seconds < 60) return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`;
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
}
