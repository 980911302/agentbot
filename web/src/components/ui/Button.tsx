import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children?: ReactNode;
}

/**
 * 统一按钮（UI 设计规范 5.1）。外观沿用 05-chat.css 的 .btn 变体类，
 * 这里只补尺寸刻度（S 28 / M 32 / L 40）与 loading 态。
 * loading 时禁用点击，左侧转圈指示，文字保持不变。
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled = false,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = ['btn', variant, size, loading ? 'loading' : '', className].filter(Boolean).join(' ');
  return (
    <button type={type} className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <span className="btn-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
