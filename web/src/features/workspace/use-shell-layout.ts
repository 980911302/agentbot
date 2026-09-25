import { useCallback, useEffect, useState } from 'react';
import {
  PANEL_DEFAULT_WIDTH,
  clampPanelWidth,
  loadPanelWidth,
  panelLayoutKind,
  savePanelWidth,
  type PanelWidthStore,
} from '../chat/panel-view';
import { sidebarAutoMini, sidebarIsDrawer } from '../chat/layout-view';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_DRAWER_WIDTH,
  SIDEBAR_MINI_WIDTH,
  loadSidebarWidth,
  saveSidebarWidth,
  type SidebarWidthStore,
} from './sidebar-width';

/**
 * 外壳布局状态（OPT-04 从 App.tsx 抽出）：视口宽度、右侧面板宽度、侧栏宽度与三档渲染宽度。
 *
 * 判定仍复用既有纯模块（panel-view / layout-view / sidebar-width）：拖拽区间、
 * 常驻还是覆盖层、迷你/抽屉档由它们说了算，这里只持有状态与落 localStorage。
 */
export function useShellLayout(input: { panelVisible: boolean; onLeaveCompact: () => void }) {
  /** 右侧面板宽度（UI-06）：320–480，可拖，记忆在 localStorage */
  const [panelWidth, setPanelWidth] = useState<number>(() =>
    typeof window === 'undefined'
      ? PANEL_DEFAULT_WIDTH
      : loadPanelWidth(window.localStorage as unknown as PanelWidthStore),
  );
  /** 侧边栏宽度与是否拖拽中（支持拖拽拉动并在 <160px 锁定折叠） */
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    typeof window === 'undefined'
      ? SIDEBAR_DEFAULT_WIDTH
      : loadSidebarWidth(window.localStorage as unknown as SidebarWidthStore),
  );
  const [isResizing, setIsResizing] = useState(false);
  /** 面板形态：<1280 时是覆盖层（带遮罩、Esc 关闭，规范 5.10）。
   *  跟随窗口宽度——拖窗口跨过 1280 时形态要跟着变。 */
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPanelResize = useCallback((width: number) => {
    const next = clampPanelWidth(width);
    setPanelWidth(next);
    if (typeof window !== 'undefined') {
      savePanelWidth(window.localStorage as unknown as PanelWidthStore, next);
    }
  }, []);

  // 响应式档位（UI-09）：窄档侧栏强制迷你 72px，单栏档侧栏变抽屉（宽 280，覆盖在聊天上）。
  // 迷你/抽屉都只改「渲染宽度」，用户拖出来的宽度仍留在 sidebarWidth 里，窗口变宽就还原。
  const drawerSidebar = sidebarIsDrawer(viewportWidth);
  const renderedSidebarWidth = drawerSidebar
    ? SIDEBAR_DRAWER_WIDTH
    : sidebarAutoMini(viewportWidth)
      ? SIDEBAR_MINI_WIDTH
      : sidebarWidth;
  /** 侧栏占的网格宽度：抽屉档它脱离网格（fixed 覆盖层），不留列 */
  const sidebarGridWidth = drawerSidebar ? 0 : renderedSidebarWidth;
  const { onLeaveCompact } = input;
  useEffect(() => {
    // 离开单栏档就收起侧栏抽屉：抽屉只属于 <768
    if (!drawerSidebar) onLeaveCompact();
  }, [drawerSidebar, onLeaveCompact]);

  const onSidebarResize = useCallback(
    (width: number) => {
      // 迷你档与抽屉档的宽度由档位决定，拖动不写持久态（否则窗口变宽会跳回拖出来的值）
      if (drawerSidebar || sidebarAutoMini(viewportWidth)) return;
      setSidebarWidth(width);
      saveSidebarWidth(window.localStorage as unknown as SidebarWidthStore, width);
    },
    [drawerSidebar, viewportWidth],
  );

  return {
    panelWidth,
    onPanelResize,
    panelLayout: panelLayoutKind(viewportWidth, input.panelVisible),
    viewportWidth,
    sidebarWidth,
    renderedSidebarWidth,
    sidebarGridWidth,
    drawerSidebar,
    isResizing,
    setIsResizing,
    onSidebarResize,
  };
}