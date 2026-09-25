/**
 * 响应式断点的纯判定（UI 设计规范 §4.2 / §4.3 / UI-09）：
 *   ≥1280            wide    三栏（侧栏 + 聊天 + 资料）
 *   1024–1279        medium  两栏 + 右侧面板覆盖层
 *   768–1023          narrow  两栏 + 侧栏自动迷你 72px + 面板覆盖层
 *   <768              compact 单栏，侧栏为左侧抽屉（顶栏出菜单按钮）
 *
 * 断点值在这里是唯一出处；CSS 媒体查询不支持变量，各
 * `@media (max-width: …)` 只能用字面量，并注释指向本文件与
 * docs/主题与CSS.md 的记录（UI-09 范围第 3 项）。
 */

export const BREAKPOINT_TABLET = 1280;
export const BREAKPOINT_NARROW = 768;

export type LayoutTier = 'wide' | 'medium' | 'narrow' | 'compact';

export function layoutTier(viewportWidth: number): LayoutTier {
  if (viewportWidth >= BREAKPOINT_TABLET) return 'wide';
  if (viewportWidth >= 1024) return 'medium';
  if (viewportWidth >= BREAKPOINT_NARROW) return 'narrow';
  return 'compact';
}

/** 侧栏是否该自动收成 72px 迷你：只发生在 narrow 档 */
export function sidebarAutoMini(viewportWidth: number): boolean {
  return layoutTier(viewportWidth) === 'narrow';
}

/** 侧栏是否该画成左侧抽屉：compact 档 */
export function sidebarIsDrawer(viewportWidth: number): boolean {
  return layoutTier(viewportWidth) === 'compact';
}
