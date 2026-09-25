/**
 * 桌面窗口外壳的纯逻辑：窗口底色 / Windows 标题栏按主题取色，外链判断。
 * 颜色取自 web/src/styles/01-tokens.css 的 --bg / --text（主进程读不到 CSS 变量，改令牌时同步这里）。
 */

const CHROME = {
  light: { background: '#f7f3ec', symbol: '#1a1a1a' },
  dark: { background: '#0c0e12', symbol: '#f4f6fb' },
};

/** 主题 → 窗口底色与标题栏按钮色；不认识的值按浅色（与 web 端默认一致） */
function chromeColors(theme) {
  return theme === 'dark' ? CHROME.dark : CHROME.light;
}

/**
 * 是否该交给系统浏览器打开：只放行 http/https，且不是应用自己的源。
 * 其它协议（file:、javascript:、自定义协议）一律不打开。
 */
function isExternalHttpUrl(url, appUrl) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  if (appUrl) {
    try {
      if (new URL(appUrl).origin === target.origin) return false;
    } catch {
      // 应用地址解析不了就只按协议判断
    }
  }
  return true;
}

module.exports = { chromeColors, isExternalHttpUrl };
