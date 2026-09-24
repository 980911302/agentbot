import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import {
  clearDialogs,
  initialFocusTarget,
  isTopmostDialog,
  nextFocusIndex,
  openDialogCount,
  popDialog,
  pushDialog,
} from '../web/src/a11y.js';

/**
 * 弹窗键盘可达性（bug_fiqtqgyntuq8）。
 *
 * Esc 只能关最上层弹窗、Tab 要在弹窗内循环——这两条是纯逻辑，
 * 不依赖 DOM 与 React，可以在这里直接覆盖。
 */

describe('Tab 在弹窗内循环', () => {
  it('到头绕回第一个，到尾绕回最后一个', () => {
    assert.equal(nextFocusIndex(0, 3, false), 1);
    assert.equal(nextFocusIndex(2, 3, false), 0, '最后一个再按 Tab 要绕回第一个');
    assert.equal(nextFocusIndex(2, 3, true), 1);
    assert.equal(nextFocusIndex(0, 3, true), 2, '第一个再按 Shift+Tab 要绕回最后一个');
  });

  it('只有一个可聚焦元素时始终停在它上面', () => {
    assert.equal(nextFocusIndex(0, 1, false), 0);
    assert.equal(nextFocusIndex(0, 1, true), 0);
  });

  it('没有可聚焦元素时返回 -1，调用方应把焦点放到容器本身', () => {
    assert.equal(nextFocusIndex(0, 0, false), -1);
    assert.equal(nextFocusIndex(0, 0, true), -1);
  });
});

describe('打开时的首焦点', () => {
  // DOM 桩：只实现 initialFocusTarget 用到的 matches/tagName
  const el = (selector: string): Element =>
    ({ matches: (s: string) => s.split(', ').includes(selector) }) as Element;

  it('有关表单控件时聚焦第一个输入，不让弹窗头部的关闭按钮抢走', () => {
    const items = [el('button'), el('input'), el('textarea')];
    assert.equal(initialFocusTarget(items), items[1]);
  });

  it('纯确认框没有输入框时退回第一个可聚焦元素', () => {
    const items = [el('button'), el('button')];
    assert.equal(initialFocusTarget(items), items[0]);
  });

  it('没有可聚焦元素时返回 undefined，调用方退到容器本身', () => {
    assert.equal(initialFocusTarget([]), undefined);
  });
});

describe('Esc 只关最上层弹窗', () => {
  // 栈是模块级状态：每个用例都从空栈开始，否则上一个用例的残留会让「最上层」失真
  beforeEach(() => clearDialogs());

  it('先开的在底下，后开的在上面', () => {
    pushDialog('a');
    assert.equal(isTopmostDialog('a'), true);
    pushDialog('b');
    assert.equal(isTopmostDialog('a'), false, '被盖住的弹窗不该响应 Esc');
    assert.equal(isTopmostDialog('b'), true);
  });

  it('关掉最上层后，下面那个重新成为最上层', () => {
    pushDialog('base');
    pushDialog('confirm');
    popDialog('confirm');
    assert.equal(isTopmostDialog('base'), true, '确认框关掉后 Esc 该回到主弹窗');
    popDialog('base');
    assert.equal(isTopmostDialog('base'), false, '弹窗全部关掉后没有最上层');
  });

  it('同一个弹窗重复打开只占一格，不会把自己盖住', () => {
    pushDialog('same');
    pushDialog('same');
    assert.equal(openDialogCount(), 1, '重复 push 不该叠加');
    assert.equal(isTopmostDialog('same'), true);
    popDialog('same');
    assert.equal(openDialogCount(), 0, '一次 pop 就该清掉');
  });

  it('关闭顺序不乱：从中间关也不影响其他', () => {
    pushDialog('one');
    pushDialog('two');
    pushDialog('three');
    popDialog('two');
    assert.equal(isTopmostDialog('three'), true, '关掉中间的，最上层不变');
    popDialog('three');
    assert.equal(isTopmostDialog('one'), true, '上面都关掉后，最底下的那个重新可关');
    popDialog('one');
    assert.equal(openDialogCount(), 0);
  });
});
