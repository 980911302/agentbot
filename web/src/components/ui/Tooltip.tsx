import { useState, type ReactNode } from 'react';

const TOOLTIP_DELAY_MS = 400;

export interface TooltipProps {
  /** 被悬停的元素（通常是 IconButton） */
  children: ReactNode;
  /** 提示文案 */
  label: string;
}

/**
 * Tooltip（UI 设计规范 5.12）：悬停 400ms 后出现，深底浅字。
 * 只包图标按钮与截断文本；颜色不是唯一信息载体的兜底。
 */
export function Tooltip({ children, label }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  return (
    <span
      className="ui-tooltip"
      onMouseEnter={() => window.setTimeout(() => setVisible(true), TOOLTIP_DELAY_MS)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible ? <span className="ui-tooltip-bubble">{label}</span> : null}
    </span>
  );
}
