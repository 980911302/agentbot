import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * 折叠容器。
 *
 * 用 grid-template-rows 的 0fr → 1fr 做高度动画：
 * 不需要 JS 测量高度，也不需要写死 max-height，
 * 内容多高都能正确过渡。
 */
export function Collapsible({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`collapsible${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <div className="collapsible-inner">{children}</div>
    </div>
  );
}

const EXIT_MS = 320;

/**
 * 让元素在卸载前先播完退出动画。
 *
 *    const { mounted, state } = usePresence(open);
 *    if (!mounted) return null;
 *    return <div className={`sheet ${state}`}>…</div>
 *
 * state 为 'enter' | 'enter-active' | 'exit' | 'exit-active'
 */
export function usePresence(open: boolean, durationMs = EXIT_MS) {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<'enter' | 'enter-active' | 'exit' | 'exit-active'>(
    open ? 'enter-active' : 'exit',
  );
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }

    if (open) {
      setMounted(true);
      setState('enter');
      // 下一帧切到 enter-active，让浏览器有机会应用初始状态
      const raf = requestAnimationFrame(() => setState('enter-active'));
      return () => cancelAnimationFrame(raf);
    }

    if (!mounted) return undefined;
    setState('exit');
    const raf = requestAnimationFrame(() => setState('exit-active'));
    timer.current = window.setTimeout(() => {
      setMounted(false);
      timer.current = null;
    }, durationMs);
    return () => {
      cancelAnimationFrame(raf);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [open, mounted, durationMs]);

  return { mounted, state };
}

/** 数值滚动到目标值，用于计数类展示 */
export function useCountUp(target: number, durationMs = 420) {
  const [value, setValue] = useState(target);
  const current = useRef(target);

  useEffect(() => {
    const start = current.current;
    if (start === target) return undefined;

    const startedAt = performance.now();
    let raf = 0;

    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const eased = 1 - (1 - progress) ** 3; // easeOutCubic
      const next = Math.round(start + (target - start) * eased);
      current.current = next;
      setValue(next);
      if (progress < 1) raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return value;
}
