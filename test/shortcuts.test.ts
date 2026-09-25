import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  isGlobalShortcut,
  shortcutAction,
  type ShortcutEvent,
} from '../web/src/features/chat/shortcuts.js';

const key = (over: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  key: 'k',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  targetIsEditable: false,
  ...over,
});

describe('shortcutAction：全局快捷键', () => {
  it('⌘K / Ctrl+K 聚焦搜索', () => {
    assert.equal(shortcutAction(key({ key: 'k', metaKey: true })), 'focus-search');
    assert.equal(shortcutAction(key({ key: 'k', ctrlKey: true })), 'focus-search');
    assert.equal(shortcutAction(key({ key: 'K', metaKey: true })), 'focus-search');
  });

  it('⌘, / Ctrl+, 打开设置', () => {
    assert.equal(shortcutAction(key({ key: ',', metaKey: true })), 'open-settings');
    assert.equal(shortcutAction(key({ key: ',', ctrlKey: true })), 'open-settings');
  });

  it('⌘\\ / Ctrl+\\ 开关右侧面板', () => {
    assert.equal(shortcutAction(key({ key: '\\', metaKey: true })), 'toggle-panel');
    assert.equal(shortcutAction(key({ key: '\\', ctrlKey: true })), 'toggle-panel');
  });

  it('Esc 关闭最上层浮层', () => {
    assert.equal(shortcutAction(key({ key: 'Escape' })), 'dismiss-top');
  });

  it('⌘⇧I 开关资料页（既有行为，收进同一 hook）', () => {
    assert.equal(shortcutAction(key({ key: 'i', metaKey: true, shiftKey: true })), 'toggle-profile');
  });

  it('输入框内不抢 Enter：可编辑目标上的非修饰键一律不拦', () => {
    assert.equal(shortcutAction(key({ key: 'Escape', targetIsEditable: true })), 'dismiss-top');
    assert.equal(shortcutAction(key({ key: 'k', metaKey: true, targetIsEditable: true })), 'focus-search');
    assert.equal(
      shortcutAction(key({ key: 'j', ctrlKey: true, targetIsEditable: true })),
      null,
      '输入框里的普通按键不该被当成全局快捷键',
    );
  });

  it('带 Alt 的组合不认，避免和系统/输入法冲突', () => {
    assert.equal(shortcutAction(key({ key: 'k', metaKey: true, altKey: true })), null);
  });

  it('没有修饰键的字母不认', () => {
    assert.equal(shortcutAction(key({ key: 'k' })), null);
    assert.equal(shortcutAction(key({ key: 'j', ctrlKey: true })), null);
  });

  it('isGlobalShortcut 与 shortcutAction 一致', () => {
    assert.equal(isGlobalShortcut(key({ key: 'k', metaKey: true })), true);
    assert.equal(isGlobalShortcut(key({ key: 'q' })), false);
  });
});
