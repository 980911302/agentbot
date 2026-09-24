import type { ReactNode } from 'react';

export interface ChipProps {
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
}

/** 标签 chip：高 24、全圆角、12 字；选中态 accent-weak 底 + accent-text 字 */
export function Chip({ selected = false, onClick, children }: ChipProps) {
  return (
    <button
      type="button"
      className={`ui-chip${selected ? ' selected' : ''}`}
      aria-pressed={selected}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
