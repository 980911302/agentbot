import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chrome = require('../desktop/window-chrome.cjs') as {
  chromeColors: (theme: unknown) => { background: string; symbol: string };
  isExternalHttpUrl: (url: string, appUrl?: string) => boolean;
};

describe('桌面窗口外壳：按主题取色', () => {
  it('深色主题用深底浅字，浅色用浅底深字', () => {
    assert.deepEqual(chrome.chromeColors('dark'), { background: '#0c0e12', symbol: '#f4f6fb' });
    assert.deepEqual(chrome.chromeColors('light'), { background: '#f7f3ec', symbol: '#1a1a1a' });
  });

  it('不认识的值按浅色（与 web 端默认一致）', () => {
    assert.deepEqual(chrome.chromeColors(undefined), chrome.chromeColors('light'));
    assert.deepEqual(chrome.chromeColors('system'), chrome.chromeColors('light'));
  });
});

describe('桌面窗口外壳：外链判断', () => {
  const app = 'http://127.0.0.1:3927/';

  it('别的站点的 http/https 链接交给系统浏览器', () => {
    assert.equal(chrome.isExternalHttpUrl('https://example.com/a', app), true);
    assert.equal(chrome.isExternalHttpUrl('http://localhost:5173/', app), true);
  });

  it('应用自己的源不算外链', () => {
    assert.equal(chrome.isExternalHttpUrl('http://127.0.0.1:3927/#/x', app), false);
  });

  it('其它协议和解析不了的地址一律不打开', () => {
    assert.equal(chrome.isExternalHttpUrl('file:///etc/passwd', app), false);
    assert.equal(chrome.isExternalHttpUrl('javascript:alert(1)', app), false);
    assert.equal(chrome.isExternalHttpUrl('not a url', app), false);
  });
});
