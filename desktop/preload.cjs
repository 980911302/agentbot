// 只暴露一个口子：页面主题变化时告诉主进程，让窗口底色和 Windows 标题栏跟着换色。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentbotDesktop', {
  setTheme: (theme) => {
    if (theme === 'light' || theme === 'dark') ipcRenderer.send('agentbot:theme', theme);
  },
});
