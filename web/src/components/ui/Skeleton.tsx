import type { CSSProperties } from 'react';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
}

/**
 * 骨架条（UI 设计规范 5.13）：--bg-subtle 底 + 1.2s 闪光。
 * 只在等待 >300ms 时出现；调用方负责延迟判断，这里只负责样子。
 */
export function Skeleton({ width = '100%', height = 14, radius, className = '' }: SkeletonProps) {
  const style: CSSProperties = { width, height };
  if (radius !== undefined) style.borderRadius = radius;
  return <div className={`ui-skeleton ${className}`.trim()} style={style} aria-hidden="true" />;
}
