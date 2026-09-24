import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface ToastItem {
  id: string;
  message: string;
  kind?: 'ok' | 'error' | 'info';
  /** 错误类不自动消失 */
  autoDismissMs?: number;
}

export interface ToastProviderProps {
  children: ReactNode;
}

/** 全局 Toast 栈：右下角，最多同时 3 条，4 秒自动消失（错误类不消失） */
const MAX_TOASTS = 3;
const DEFAULT_DISMISS_MS = 4000;

let pushToast: ((toast: Omit<ToastItem, 'id'>) => void) | null = null;

export function toast(message: string, kind: ToastItem['kind'] = 'info'): void {
  pushToast?.({ message, kind });
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    pushToast = (toast) => {
      const id = Math.random().toString(36).slice(2);
      setItems((prev) => [...prev, { ...toast, id }].slice(-MAX_TOASTS));
      if (toast.kind !== 'error') {
        const timer = window.setTimeout(() => {
          setItems((prev) => prev.filter((item) => item.id !== id));
        }, toast.autoDismissMs ?? DEFAULT_DISMISS_MS);
        timers.current.push(timer);
      }
    };
    return () => {
      pushToast = null;
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current = [];
    };
  }, []);

  return (
    <>
      {children}
      <div className="ui-toast-stack" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`ui-toast ${item.kind ?? 'info'}`}>
            <span className="ui-toast-icon" aria-hidden="true">
              {item.kind === 'ok' ? '✓' : item.kind === 'error' ? '⚠' : 'ℹ'}
            </span>
            <span className="ui-toast-message">{item.message}</span>
          </div>
        ))}
      </div>
    </>
  );
}
