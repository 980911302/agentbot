/**
 * 系统通知雏形：只在窗口藏在后台时打扰用户——前台时卡片就在眼前。
 * Electron 渲染层直接支持 Web Notification（转系统通知），浏览器走标准授权流程。
 */

export async function ensureNotifyPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

export function notifyIfHidden(title: string, body: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!document.hidden) return;
  try {
    const notification = new Notification(title, { body, silent: true });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // 个别环境抛错时不打扰主流程
  }
}
