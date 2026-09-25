/**
 * 交互卡片的纯展示逻辑：倒计时文案、提交后的回显。
 * 不碰 React 与 DOM，供 InteractionCard 与 node:test 共用。
 */

/** 剩余秒数 → 「m:ss」（超过 1 小时为「h:mm:ss」）；以前直接显示「587s」 */
export function formatCountdown(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const ss = String(secs).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

export interface InteractionAnswer {
  value?: string;
  secret?: string;
  cancelled?: boolean;
}

/**
 * 提交后卡片上回显「你选了什么」：选项显示它的标签，自填显示原文，
 * 密钥只说「已提交」不回显值，跳过显示「已跳过」。
 */
export function answeredLabel(answer: InteractionAnswer, options: Array<{ id: string; label: string }> = []): string {
  if (answer.cancelled) return '已跳过';
  if (answer.secret !== undefined) return '已提交密钥';
  const value = answer.value ?? '';
  const option = options.find((item) => item.id === value);
  if (option) return `已选：${option.label}`;
  return `已选：${value.replace(/^自定义：/, '')}`;
}
