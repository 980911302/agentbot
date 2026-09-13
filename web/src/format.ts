export function formatClock(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '刚刚';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return '刚刚';

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;

  if (timestamp >= todayStart) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  if (timestamp >= yesterdayStart) {
    return '昨天';
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** 消息气泡里的时间戳：今天只看时分，跨天带日期 */
export function formatMessageTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  const sameDay = new Date().toDateString() === date.toDateString();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
