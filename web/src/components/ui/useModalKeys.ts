import { useEffect, useRef, useState } from 'react';
import { initialFocusTarget, isTabbable, isTopmostDialog, nextFocusIndex, popDialog, pushDialog } from '../../a11y.js';

export interface UseModalKeysOptions {
  /** 弹窗是否打开 */
  open: boolean;
  /** 关闭回调（Esc、点遮罩都由调用方决定语义） */
  onClose: () => void;
  /** 同一时刻可能叠加多个弹窗，用来判断 Esc 该不该由自己响应 */
  id: string;
  /** 是否启用焦点陷阱；只展示信息的弹窗可以关掉 */
  trapFocus?: boolean;
}

/**
 * 弹窗的键盘与焦点行为（bug_fiqtqgyntuq8，UI 设计规范 5.11 / 第 8 节）。
 *
 * 打开时：
 *   - 把自己压进弹窗栈，Esc 只关最上层那个；
 *   - 焦点移进弹窗（首个输入，尊重内容自己的 autoFocus），原来的焦点位置记下来；
 *   - Tab / Shift+Tab 在弹窗内循环，不会跑到背后的页面；
 * 关闭时：
 *   - 还原打开前的焦点，让键盘用户回到触发按钮。
 *
 * 触发焦点必须在渲染阶段记：带 autoFocus 的弹窗在 React 提交阶段就把焦点
 * 抢进了弹窗，等 effect 再记，记到的已经是弹窗里的节点——关闭时它已卸载，
 * 还原被跳过，焦点反而掉到 body。渲染阶段旧的 DOM 还在，那时记才是触发按钮。
 *
 * 节点用 state 存而不用 ref：弹窗常带入场动画，内容比 effect 晚一帧挂载，
 * ref 在 effect 运行时还是 null，取不到可聚焦元素。
 */
export function useModalKeys({ open, onClose, id, trapFocus = true }: UseModalKeysOptions) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  // onClose 每次渲染都是新函数；用 ref 拿最新的，避免反复绑定监听
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  if (open && !wasOpenRef.current) {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpenRef.current = open;

  useEffect(() => {
    if (!open || !container) return undefined;
    pushDialog(id);

    const tabbable = () => Array.from(container.querySelectorAll('*')).filter(isTabbable);

    // 打开即聚焦（规范 5.11「打开聚焦首个输入」）。优先级：
    //   1. 内容自己已经聚焦的（autoFocus）——尊重弹窗作者的显式安排；
    //   2. 首个表单控件——弹窗头部的关闭按钮按 DOM 顺序抢在输入框前面，
    //      照顺序聚焦会把首焦点落在关闭按钮上；
    //   3. 第一个可聚焦元素（纯确认框）；4. 容器本身。
    const active = document.activeElement;
    const target =
      active instanceof HTMLElement && container.contains(active)
        ? active
        : (initialFocusTarget(tabbable()) ?? container);
    if (target instanceof HTMLElement) target.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostDialog(id)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !trapFocus) return;
      const items = tabbable();
      const active = document.activeElement;
      const current = active instanceof HTMLElement ? items.indexOf(active) : -1;
      if (items.length === 0 || current < 0) {
        // 没有可聚焦控件，或焦点还在背后的页面上：收回弹窗里的第一个
        event.preventDefault();
        (tabbable()[0] ?? container).focus?.();
        return;
      }
      event.preventDefault();
      items[nextFocusIndex(current, items.length, event.shiftKey)]?.focus();
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      popDialog(id);
      // 关闭后把焦点还给触发它的那个按钮。还在弹窗里的节点不还原：
      // 它随弹窗一起卸载，硬聚焦只会让焦点掉到 body。
      const restore = restoreFocusRef.current;
      if (restore && restore.isConnected && !container.contains(restore)) restore.focus();
      restoreFocusRef.current = null;
    };
  }, [open, id, trapFocus, container]);

  return setContainer;
}
