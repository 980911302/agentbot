/**
 * 弹窗键盘行为（bug_fiqtqgyntuq8）。
 *
 * 这里只放与 DOM 无关的纯逻辑，方便用 node:test 覆盖；
 * 真正监听事件的 hook 在 components/ui/useModalKeys.ts。
 */

/** Tab / Shift+Tab 在弹窗内的循环下标：到头绕回第一个，到尾绕回最后一个 */
export function nextFocusIndex(current: number, count: number, backward: boolean): number {
  if (count <= 0) return -1;
  if (count === 1) return 0;
  if (backward) return current <= 0 ? count - 1 : current - 1;
  return current >= count - 1 ? 0 : current + 1;
}

/** 判断元素能不能被 Tab 聚焦：禁用、隐藏、tabindex=-1 的都不要 */
export function isTabbable(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.hasAttribute('disabled')) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;
  const tabIndex = element.tabIndex;
  if (tabIndex < 0) return false;
  // 只在看不见时排除：display:none / visibility:hidden / details 未展开
  if (element.hidden) return false;
  return true;
}

/**
 * 弹窗打开时的首焦点（UI 设计规范 5.11「打开聚焦首个输入」）：
 * 优先表单控件——弹窗头部通常有个关闭按钮，按 DOM 顺序它会抢在输入框
 * 前面，照顺序聚焦就把首焦点落在了关闭按钮上。没有表单控件时退回第一个
 * 可聚焦元素（如纯确认框的确定按钮）。
 */
export function initialFocusTarget<T extends Element>(items: T[]): T | undefined {
  return items.find(item => item.matches('input, textarea, select')) ?? items[0];
}

/**
 * 打开中的弹窗栈。
 *
 * Esc 应该只关最上层那个：侧栏菜单、弹窗、二级确认可能同时存在，
 * 每个都监听 keydown 的话一按 Esc 会全部消失。
 */
const openDialogs: string[] = [];

export function pushDialog(id: string): void {
  const at = openDialogs.indexOf(id);
  if (at >= 0) openDialogs.splice(at, 1);
  openDialogs.push(id);
}

export function popDialog(id: string): void {
  const at = openDialogs.indexOf(id);
  if (at < 0) return;
  openDialogs.splice(at, 1);
}

export function isTopmostDialog(id: string): boolean {
  return openDialogs.length > 0 && openDialogs[openDialogs.length - 1] === id;
}

/** 当前打开中的弹窗数量（测试与调试用） */
export function openDialogCount(): number {
  return openDialogs.length;
}

/**
 * 清空弹窗栈。
 *
 * 栈是模块级状态，测试之间需要隔离：否则上一个用例压进来的弹窗会
 * 让下一个用例的「最上层」判断失真。
 */
export function clearDialogs(): void {
  openDialogs.length = 0;
}
