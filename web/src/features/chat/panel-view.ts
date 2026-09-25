/**
 * 右侧面板的纯展示选择器（UI 设计规范 §5.10 / UI-06）：
 * 宽度限制与持久化、常驻/覆盖层判定。
 *
 * 断点：≥1280 三栏常驻；<1280 面板让位变覆盖层（带遮罩、Esc 关闭）。
 * 断点值写成注释约定——CSS 变量不能用于 media query，改动需同步
 * docs/主题与CSS.md（UI-09 统一断点任务）。
 */

export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 480;
export const PANEL_DEFAULT_WIDTH = 340;
export const PANEL_OVERLAY_BREAKPOINT = 1280;
export const PANEL_WIDTH_KEY = 'agentbot.panelWidth';

/** 只依赖两个方法的存储抽象，便于 node:test 与 try/catch 包裹的 localStorage 共用 */
export interface PanelWidthStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_DEFAULT_WIDTH;
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(width)));
}

/** 读本地宽度：没有/损坏/存储不可用都回默认值，绝不抛 */
export function loadPanelWidth(store: PanelWidthStore): number {
  try {
    const raw = store.getItem(PANEL_WIDTH_KEY);
    if (raw === null) return PANEL_DEFAULT_WIDTH;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || raw.trim() === '') return PANEL_DEFAULT_WIDTH;
    return clampPanelWidth(parsed);
  } catch {
    return PANEL_DEFAULT_WIDTH;
  }
}

/** 写本地宽度：存进去的永远是夹紧后的合法值；存储不可用时静默失败 */
export function savePanelWidth(store: PanelWidthStore, width: number): void {
  try {
    store.setItem(PANEL_WIDTH_KEY, String(clampPanelWidth(width)));
  } catch {
    // 存不下就不存，宽度只在本次会话有效
  }
}

export type PanelLayoutKind = 'dock' | 'overlay';

/** 面板形态：默认常驻；显式声明进入窄档（hasPanel=true 时）才按覆盖层处理 */
export function panelLayoutKind(viewportWidth: number, hasPanel = false): PanelLayoutKind {
  return hasPanel && viewportWidth < PANEL_OVERLAY_BREAKPOINT ? 'overlay' : 'dock';
}
