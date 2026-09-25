/**
 * 侧栏宽度的读 / 写纯函数（OPT-04 从 App.tsx 抽出，与 features/chat/panel-view.ts 同款）。
 *
 * 与 panel-view 一样只依赖两个方法的存储抽象，node:test 可以直接喂假存储；
 * localStorage 不可用（隐私模式 / 配额）时静默回默认值，绝不让渲染挂掉。
 */

export const SIDEBAR_WIDTH_KEY = 'agentbot.sidebarWidth';
/** 折叠与拖拽的合法区间：小于 64 视为折叠，超过 500 没有意义 */
export const SIDEBAR_MIN_WIDTH = 64;
export const SIDEBAR_MAX_WIDTH = 500;
export const SIDEBAR_DEFAULT_WIDTH = 260;
/** 窄档自动迷你宽度（UI-09） */
export const SIDEBAR_MINI_WIDTH = 72;
/** 单栏档侧栏抽屉宽度（UI-09） */
export const SIDEBAR_DRAWER_WIDTH = 280;

/** 只依赖两个方法的存储抽象，便于 node:test 与 try/catch 包裹的 localStorage 共用 */
export interface SidebarWidthStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 读本地宽度：没有 / 损坏 / 越界 / 存储不可用都回默认值，绝不抛 */
export function loadSidebarWidth(store: SidebarWidthStore): number {
  try {
    const saved = store.getItem(SIDEBAR_WIDTH_KEY);
    if (saved) {
      const parsed = Number(saved);
      if (Number.isFinite(parsed) && parsed >= SIDEBAR_MIN_WIDTH && parsed <= SIDEBAR_MAX_WIDTH) {
        return parsed;
      }
    }
  } catch {
    // 读不到就当没存过
  }
  return SIDEBAR_DEFAULT_WIDTH;
}

/** 写本地宽度：存不下就不存，宽度只在本次会话有效 */
export function saveSidebarWidth(store: SidebarWidthStore, width: number): void {
  try {
    store.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // 同上：界面偏好不值得打断用户
  }
}