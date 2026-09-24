import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Tooltip } from './Tooltip.js';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 必填：图标按钮必须有无障碍名（UI 设计规范第 8 节） */
  label: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'primary' | 'danger';
  children: ReactNode;
}

/**
 * 图标按钮：悬停出 Tooltip，必填 aria-label。
 * 图标本身用 aria-hidden 装饰，名字来自 label。
 */
export function IconButton({
  label,
  size = 'md',
  variant = 'ghost',
  className = '',
  children,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const classes = ['btn', variant, size === 'sm' ? 'sm' : 'md', 'icon-btn', className]
    .filter(Boolean)
    .join(' ');
  return (
    <Tooltip label={label}>
      <button type={type} className={classes} aria-label={label} {...rest}>
        <span aria-hidden="true" style={{ display: 'inline-flex' }}>
          {children}
        </span>
      </button>
    </Tooltip>
  );
}
