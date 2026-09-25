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

/**
 * 侧栏列表的相对时间：刚刚 / N 分钟前 / N 小时前（今天）/ 昨天 / M/D（今年）/ YYYY/M/D。
 * now 可注入，便于测试；时间在未来（时钟漂移）或缺失时按「刚刚」算。
 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  // 缺时间（新建条目还没回写 updatedAt）与 formatClock 一致按「刚刚」
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '刚刚';
  const diff = now - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const today = new Date(now);
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (timestamp >= todayStart) return `${Math.floor(diff / (60 * 60_000))} 小时前`;
  const yesterdayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();
  if (timestamp >= yesterdayStart) return '昨天';
  const date = new Date(timestamp);
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
