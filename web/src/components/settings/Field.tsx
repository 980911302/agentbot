import type { ReactNode } from 'react';

/**
 * 表单字段（UI 设计规范 §5.2 / UI-08）：标签在上、说明在下、
 * 必填写「必填」而不是星号、错误态红边 + 下方文案。
 */
export interface FieldProps {
  label: string;
  /** 关联到控件 id（读屏与点标签都要靠它） */
  htmlFor?: string;
  required?: boolean;
  /** 说明写在控件下方；有错误时让位给错误文案 */
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}

export function Field({ label, htmlFor, required, hint, error, children }: FieldProps) {
  return (
    <div className={`provider-field-group${error ? ' has-error' : ''}`} data-field={htmlFor}>
      <label className="provider-field-label" htmlFor={htmlFor}>
        {label}
        {required ? <span className="provider-field-required">必填</span> : null}
      </label>
      {children}
      {error ? (
        <div className="provider-field-error" role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className="provider-field-hint">{hint}</div>
      ) : null}
    </div>
  );
}
