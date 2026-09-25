import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULT_THEME_PREFERENCE, parseThemePreference, resolveTheme } from '../web/src/theme.js';

describe('parseThemePreference：读存下来的主题偏好', () => {
  it('三种合法值原样返回，system 也认', () => {
    assert.equal(parseThemePreference('light'), 'light');
    assert.equal(parseThemePreference('dark'), 'dark');
    assert.equal(parseThemePreference('system'), 'system');
  });

  it('没有键 / 不认识的值回默认浅色（与 docs/主题与CSS.md 一致）', () => {
    assert.equal(DEFAULT_THEME_PREFERENCE, 'light');
    assert.equal(parseThemePreference(null), 'light');
    assert.equal(parseThemePreference(undefined), 'light');
    assert.equal(parseThemePreference(''), 'light');
    assert.equal(parseThemePreference('sepia'), 'light');
  });
});

describe('resolveTheme：偏好 → 实际主题', () => {
  it('system 跟随 prefers-color-scheme', () => {
    assert.equal(resolveTheme('system', true), 'dark');
    assert.equal(resolveTheme('system', false), 'light');
  });

  it('明确选了深浅就不看系统', () => {
    assert.equal(resolveTheme('dark', false), 'dark');
    assert.equal(resolveTheme('light', true), 'light');
  });
});
